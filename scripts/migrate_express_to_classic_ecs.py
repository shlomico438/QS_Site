#!/usr/bin/env python3
"""Move QuickScribe off ECS Express Mode canary onto a classic rolling service.

Default is dry-run (no AWS writes). Pass --apply to mutate.

Keeps the Express-managed ALB: deleting the Express Gateway service would
destroy that ALB. This script creates one sticky target group + a classic ECS
service, points this app's listener rule at that TG, then scales Express to 0.

Production DNS (getquickscribe.com) can stay on Koyeb. Simulation stays on the
existing *.on.aws hostname as long as Express is scaled to 0, not deleted.

  python scripts/migrate_express_to_classic_ecs.py
  python scripts/migrate_express_to_classic_ecs.py --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sys

KOYEB_UPLOAD_USER = 'QuickScribe_Koyeb_Uploader'
DEFAULT_REGION = 'eu-north-1'
DEFAULT_CLUSTER = 'default'
DEFAULT_EXPRESS_SERVICE = 'quickscribe-site-c259'
DEFAULT_CLASSIC_SERVICE = 'quickscribe-site'
DEFAULT_TG_NAME = 'qs-site-classic'
STICKINESS_SECONDS = 3600
DEREGISTRATION_DELAY = 60
HEALTH_GRACE = 120
# Must stay <= Fargate max (120) and >= ALB drain + gunicorn graceful_timeout.
# Applied on each deploy by scripts/register_ecs_image.py.


def log(msg: str) -> None:
    print(msg, flush=True)


def _json(obj) -> str:
    return json.dumps(obj, indent=2, default=str)


def refuse_koyeb_user(session, sts, allow: bool) -> str:
    ident = sts.get_caller_identity()
    arn = str(ident.get('Arn') or '')
    profile = session.profile_name or os.environ.get('AWS_PROFILE') or 'default'
    creds = session.get_credentials()
    key_tail = (creds.access_key or '')[-4:] if creds else '?'
    log(f'AWS identity: {arn}')
    log(f'AWS profile: {profile} (access key ends with {key_tail})')
    if KOYEB_UPLOAD_USER in arn and not allow:
        raise SystemExit(
            f'Refusing to run as {KOYEB_UPLOAD_USER}.\n'
            f'Profile [{profile}] is using that user\'s access keys '
            f'(~/.aws/credentials). aws configure --profile {profile} '
            'with keys from a *different* IAM user that can manage ECS/ALB. '
            'Do not reuse the Koyeb uploader keys.'
        )
    return arn


def describe_express(ecs, service_arn: str) -> dict:
    try:
        resp = ecs.describe_express_gateway_service(serviceArn=service_arn)
    except Exception as exc:
        raise SystemExit(f'describe_express_gateway_service failed: {exc}') from exc
    return resp.get('service') or resp


def describe_ecs_service(ecs, cluster: str, name: str) -> dict | None:
    resp = ecs.describe_services(cluster=cluster, services=[name])
    services = resp.get('services') or []
    failures = resp.get('failures') or []
    if failures:
        log(f'  describe_services failures: {_json(failures)}')
    for svc in services:
        if svc.get('status') in ('ACTIVE', 'DRAINING'):
            return svc
    return None


def express_configs(express: dict) -> list[dict]:
    return list(express.get('activeConfigurations') or [])


def resolve_task_def(ecs, cluster: str, express_name: str, express: dict, ecs_svc: dict | None) -> str:
    td = str((ecs_svc or {}).get('taskDefinition') or '').strip()
    if td:
        return td
    for cfg in express_configs(express):
        td = str(cfg.get('taskDefinitionArn') or '').strip()
        if td:
            return td
    listed = ecs.list_tasks(cluster=cluster, serviceName=express_name)
    arns = listed.get('taskArns') or []
    if arns:
        tasks = ecs.describe_tasks(cluster=cluster, tasks=arns[:2]).get('tasks') or []
        for task in tasks:
            td = str(task.get('taskDefinitionArn') or '').strip()
            if td:
                log(f'  task definition from running task {task.get("taskArn")}')
                return td
    raise SystemExit(
        'No task definition on the Express service and no running tasks to copy from.'
    )


def resolve_network(express: dict, ecs_svc: dict | None) -> dict:
    awsvpc = ((ecs_svc or {}).get('networkConfiguration') or {}).get('awsvpcConfiguration') or {}
    if awsvpc.get('subnets'):
        return awsvpc
    for cfg in express_configs(express):
        net = cfg.get('networkConfiguration') or {}
        if net.get('subnets'):
            return {
                'subnets': net.get('subnets') or [],
                'securityGroups': net.get('securityGroups') or [],
                'assignPublicIp': 'ENABLED',
            }
    raise SystemExit('No subnets on the Express service or ECS service.')


def find_alb_by_host(elbv2, host: str) -> tuple[dict, dict, str, list[str]]:
    """Locate the ALB listener rule for this Express hostname."""
    host = (host or '').lower()
    if not host:
        raise SystemExit('Express endpoint host is empty; cannot find the ALB by hostname.')
    paginator = elbv2.get_paginator('describe_load_balancers')
    for page in paginator.paginate():
        for alb in page.get('LoadBalancers') or []:
            if str(alb.get('Type') or '').lower() not in ('application', ''):
                continue
            try:
                listeners = elbv2.describe_listeners(LoadBalancerArn=alb['LoadBalancerArn']).get('Listeners') or []
            except Exception:
                continue
            for listener in listeners:
                rules = paginate_rules(elbv2, listener['ListenerArn'])
                for rule in rules + [{'IsDefault': True, 'Conditions': [], 'Actions': listener.get('DefaultActions') or []}]:
                    hosts = rule_hosts(rule)
                    host_ok = host in hosts or any(h.startswith('*.') and host.endswith(h[1:]) for h in hosts)
                    if not host_ok and not (rule.get('IsDefault') and not hosts):
                        continue
                    if not host_ok:
                        continue
                    tgs: list[str] = []
                    for action in rule.get('Actions') or []:
                        tgs.extend(forward_tgs(action))
                    if tgs:
                        return alb, listener, tgs[0], tgs
    raise SystemExit(f'No ALB host-header rule found for {host}')


def task_def_container(ecs, task_def_arn: str) -> tuple[str, int]:
    td = ecs.describe_task_definition(taskDefinition=task_def_arn)['taskDefinition']
    containers = td.get('containerDefinitions') or []
    if not containers:
        raise SystemExit(f'No containers in task definition {task_def_arn}')
    # Prefer the essential container Express names "Main".
    essential = [c for c in containers if c.get('essential') is not False]
    c = essential[0] if essential else containers[0]
    name = c['name']
    port = 8000
    mappings = c.get('portMappings') or []
    if mappings:
        port = int(mappings[0].get('containerPort') or mappings[0].get('hostPort') or port)
    return name, port


def subnet_vpc(ec2, subnet_id: str) -> str:
    resp = ec2.describe_subnets(SubnetIds=[subnet_id])
    return resp['Subnets'][0]['VpcId']


def find_alb_for_target_group(elbv2, tg_arn: str) -> tuple[dict, dict]:
    tg = elbv2.describe_target_groups(TargetGroupArns=[tg_arn])['TargetGroups'][0]
    lb_arns = tg.get('LoadBalancerArns') or []
    if not lb_arns:
        raise SystemExit(f'Target group {tg_arn} is not attached to a load balancer')
    alb = elbv2.describe_load_balancers(LoadBalancerArns=[lb_arns[0]])['LoadBalancers'][0]
    return alb, tg


def https_listener(elbv2, alb_arn: str) -> dict:
    listeners = elbv2.describe_listeners(LoadBalancerArn=alb_arn).get('Listeners') or []
    https = [x for x in listeners if int(x.get('Port') or 0) == 443 or str(x.get('Protocol') or '').upper() == 'HTTPS']
    if https:
        return https[0]
    if listeners:
        return listeners[0]
    raise SystemExit(f'No listeners on {alb_arn}')


def paginate_rules(elbv2, listener_arn: str) -> list[dict]:
    rules = []
    paginator = elbv2.get_paginator('describe_rules')
    for page in paginator.paginate(ListenerArn=listener_arn):
        rules.extend(page.get('Rules') or [])
    return rules


def rule_hosts(rule: dict) -> list[str]:
    hosts = []
    for cond in rule.get('Conditions') or []:
        field = str(cond.get('Field') or '')
        if field == 'host-header':
            cfg = cond.get('HostHeaderConfig') or {}
            hosts.extend(cfg.get('Values') or cond.get('Values') or [])
    return [str(h).lower() for h in hosts]


def forward_tgs(action: dict) -> list[str]:
    if str(action.get('Type') or '').lower() != 'forward':
        return []
    cfg = action.get('ForwardConfig') or {}
    tgs = cfg.get('TargetGroups') or []
    if tgs:
        return [t['TargetGroupArn'] for t in tgs if t.get('TargetGroupArn')]
    arn = (action.get('TargetGroupArn') or '').strip()
    return [arn] if arn else []


def endpoint_host(express: dict) -> str:
    configs = express.get('activeConfigurations') or []
    for cfg in configs:
        for path in cfg.get('ingressPaths') or []:
            endpoint = str(path.get('endpoint') or '').strip()
            if not endpoint:
                continue
            host = endpoint.replace('https://', '').replace('http://', '').split('/')[0]
            if host:
                return host.lower()
    return ''


def pick_express_target_groups(elbv2, listener: dict, ecs_svc: dict, host: str) -> list[str]:
    found = []
    for lb in ecs_svc.get('loadBalancers') or []:
        arn = lb.get('targetGroupArn')
        if arn:
            found.append(arn)
    rules = paginate_rules(elbv2, listener['ListenerArn'])
    default_actions = listener.get('DefaultActions') or []
    candidates = list(rules) + [{'Conditions': [], 'Actions': default_actions, 'IsDefault': True}]
    host = (host or '').lower()
    for rule in candidates:
        hosts = rule_hosts(rule)
        matches_host = (not hosts and rule.get('IsDefault')) or (host and any(
            h == host or h.startswith('*.') and host.endswith(h[1:]) for h in hosts
        ))
        if host and hosts and not matches_host:
            continue
        if host and not hosts and not rule.get('IsDefault'):
            continue
        for action in rule.get('Actions') or []:
            found.extend(forward_tgs(action))
    # unique, preserve order
    out = []
    for arn in found:
        if arn not in out:
            out.append(arn)
    return out


def tg_exists(elbv2, name: str, vpc_id: str) -> dict | None:
    from botocore.exceptions import ClientError

    try:
        tgs = elbv2.describe_target_groups(Names=[name]).get('TargetGroups') or []
    except ClientError as exc:
        code = str((exc.response or {}).get('Error', {}).get('Code') or '')
        if code in ('TargetGroupNotFound', 'TargetGroupNotFoundException'):
            return None
        raise
    for tg in tgs:
        if tg.get('VpcId') == vpc_id:
            return tg
    return tgs[0] if tgs else None


def ensure_tg_drain_attributes(elbv2, *, apply: bool, tg_arn: str) -> None:
    if str(tg_arn).startswith('arn:dry-run:'):
        return
    log(f'  modify_target_group_attributes stickiness={STICKINESS_SECONDS}s drain={DEREGISTRATION_DELAY}s')
    if not apply:
        return
    elbv2.modify_target_group_attributes(
        TargetGroupArn=tg_arn,
        Attributes=[
            {'Key': 'stickiness.enabled', 'Value': 'true'},
            {'Key': 'stickiness.type', 'Value': 'lb_cookie'},
            {'Key': 'stickiness.lb_cookie.duration_seconds', 'Value': str(STICKINESS_SECONDS)},
            {'Key': 'deregistration_delay.timeout_seconds', 'Value': str(DEREGISTRATION_DELAY)},
        ],
    )


def create_or_get_target_group(elbv2, *, apply: bool, name: str, vpc_id: str, port: int, health_path: str) -> dict:
    existing = tg_exists(elbv2, name, vpc_id)
    if existing:
        log(f'  target group exists: {existing["TargetGroupArn"]}')
        return existing
    params = dict(
        Name=name,
        Protocol='HTTP',
        Port=port,
        VpcId=vpc_id,
        TargetType='ip',
        HealthCheckEnabled=True,
        HealthCheckProtocol='HTTP',
        HealthCheckPath=health_path,
        HealthCheckIntervalSeconds=15,
        HealthCheckTimeoutSeconds=5,
        HealthyThresholdCount=2,
        UnhealthyThresholdCount=3,
        Matcher={'HttpCode': '200'},
    )
    log(f'  create_target_group {name} port={port} health={health_path} vpc={vpc_id}')
    if not apply:
        return {'TargetGroupArn': f'arn:dry-run:targetgroup/{name}', **params}
    tg = elbv2.create_target_group(**params)['TargetGroups'][0]
    log(f'  created {tg["TargetGroupArn"]}')
    return tg


def ensure_classic_service(
    ecs,
    *,
    apply: bool,
    cluster: str,
    name: str,
    task_def: str,
    net: dict,
    tg_arn: str,
    container_name: str,
    container_port: int,
    desired: int,
    existing_svc: dict | None,
) -> dict | None:
    already = describe_ecs_service(ecs, cluster, name)
    if already and already.get('serviceName') == name:
        log(f'  classic service exists: {already.get("serviceArn")} status={already.get("status")} desired={already.get("desiredCount")}')
        return already
    awsvpc = (existing_svc or {}).get('networkConfiguration', {}).get('awsvpcConfiguration') or net
    capacity = (existing_svc or {}).get('capacityProviderStrategy') or [
        {'capacityProvider': 'FARGATE', 'weight': 1, 'base': 1},
    ]
    params = dict(
        cluster=cluster,
        serviceName=name,
        taskDefinition=task_def,
        desiredCount=desired,
        capacityProviderStrategy=capacity,
        platformVersion='LATEST',
        schedulingStrategy='REPLICA',
        healthCheckGracePeriodSeconds=HEALTH_GRACE,
        deploymentConfiguration={
            'maximumPercent': 200,
            'minimumHealthyPercent': 100,
            'deploymentCircuitBreaker': {'enable': True, 'rollback': True},
        },
        networkConfiguration={'awsvpcConfiguration': {
            'subnets': awsvpc.get('subnets') or [],
            'securityGroups': awsvpc.get('securityGroups') or [],
            'assignPublicIp': awsvpc.get('assignPublicIp') or 'ENABLED',
        }},
        loadBalancers=[{
            'targetGroupArn': tg_arn,
            'containerName': container_name,
            'containerPort': container_port,
        }],
        enableExecuteCommand=bool((existing_svc or {}).get('enableExecuteCommand')),
        propagateTags='SERVICE',
    )
    log('  create_service classic rolling minHealthy=100 maxPercent=200')
    log(f'    name={name} desired={desired} container={container_name}:{container_port}')
    if not apply:
        return None
    resp = ecs.create_service(**params)
    svc = resp['service']
    log(f'  created {svc.get("serviceArn")}')
    log('  waiting for services_stable (up to 15 minutes)...')
    waiter = ecs.get_waiter('services_stable')
    waiter.wait(
        cluster=cluster,
        services=[name],
        WaiterConfig={'Delay': 15, 'MaxAttempts': 60},
    )
    log('  classic service is stable')
    return describe_ecs_service(ecs, cluster, name)


def find_host_rules(elbv2, listener: dict, host: str) -> list[dict]:
    host = (host or '').lower()
    matched = []
    for rule in paginate_rules(elbv2, listener['ListenerArn']):
        if rule.get('IsDefault'):
            continue
        hosts = rule_hosts(rule)
        if host and (host in hosts or any(h.startswith('*.') and host.endswith(h[1:]) for h in hosts)):
            matched.append(rule)
    return matched


def associate_tg_with_listener(elbv2, *, apply: bool, listener: dict, host: str, new_tg_arn: str) -> None:
    """ECS CreateService requires the TG to already be on a listener rule."""
    if str(new_tg_arn).startswith('arn:dry-run:'):
        log('  (dry-run) would attach classic TG to the hostname listener rule at weight 0')
        return
    rules = find_host_rules(elbv2, listener, host)
    if not rules:
        raise SystemExit(f'No listener rule for host {host}; cannot attach the classic target group')
    for rule in rules:
        groups = []
        for action in rule.get('Actions') or []:
            cfg = action.get('ForwardConfig') or {}
            for g in cfg.get('TargetGroups') or []:
                groups.append({
                    'TargetGroupArn': g['TargetGroupArn'],
                    'Weight': int(g.get('Weight') or 1),
                })
            if not groups:
                for arn in forward_tgs(action):
                    groups.append({'TargetGroupArn': arn, 'Weight': 1})
        if any(g['TargetGroupArn'] == new_tg_arn for g in groups):
            log(f'  classic TG already on rule {rule.get("RuleArn")}')
            continue
        groups.append({'TargetGroupArn': new_tg_arn, 'Weight': 0})
        log(f'  attach classic TG (weight 0) to {rule.get("RuleArn")} so ECS can use it')
        if apply:
            elbv2.modify_rule(
                RuleArn=rule['RuleArn'],
                Actions=[{
                    'Type': 'forward',
                    'ForwardConfig': {
                        'TargetGroups': groups,
                        'TargetGroupStickinessConfig': {
                            'Enabled': True,
                            'DurationSeconds': STICKINESS_SECONDS,
                        },
                    },
                }],
            )


def retarget_listener(elbv2, *, apply: bool, listener: dict, host: str, express_tgs: set[str], new_tg_arn: str) -> None:
    forward = {
        'Type': 'forward',
        'ForwardConfig': {
            'TargetGroups': [{'TargetGroupArn': new_tg_arn, 'Weight': 100}],
        },
    }
    rules = paginate_rules(elbv2, listener['ListenerArn'])
    host = (host or '').lower()

    def uses_express(actions: list) -> bool:
        for action in actions or []:
            for arn in forward_tgs(action):
                if arn in express_tgs or arn == new_tg_arn:
                    return True
        return False

    default_actions = listener.get('DefaultActions') or []
    if uses_express(default_actions):
        log('  set listener default action -> classic TG (100%)')
        if apply:
            elbv2.modify_listener(ListenerArn=listener['ListenerArn'], DefaultActions=[forward])

    for rule in rules:
        if rule.get('IsDefault'):
            continue
        hosts = rule_hosts(rule)
        host_ok = (not host) or (not hosts) or any(
            h == host or (h.startswith('*.') and host.endswith(h[1:])) for h in hosts
        )
        if not host_ok:
            continue
        if not uses_express(rule.get('Actions') or []) and host and hosts:
            if host not in hosts:
                continue
        elif not uses_express(rule.get('Actions') or []):
            continue
        log(f'  modify_rule {rule.get("RuleArn")} hosts={hosts or ["(any)"]} -> classic TG only')
        if apply:
            elbv2.modify_rule(RuleArn=rule['RuleArn'], Actions=[forward])


def scale_express_to_zero(
    ecs,
    autoscaling,
    *,
    apply: bool,
    cluster: str,
    express_name: str,
    express_arn: str,
) -> None:
    resource_id = f'service/{cluster}/{express_name}'
    log(f'  scale Express to 0 tasks (keep the Express resource so the ALB is not deleted)')
    try:
        log('  update_express_gateway_service scalingTarget min=0 max=1')
        if apply:
            ecs.update_express_gateway_service(
                serviceArn=express_arn,
                scalingTarget={'minTaskCount': 0, 'maxTaskCount': 1},
            )
    except Exception as exc:
        log(f'  update_express_gateway_service skipped: {exc}')

    try:
        if apply:
            autoscaling.register_scalable_target(
                ServiceNamespace='ecs',
                ResourceId=resource_id,
                ScalableDimension='ecs:service:DesiredCount',
                MinCapacity=0,
                MaxCapacity=1,
            )
            log('  application-autoscaling min=0 max=1')
    except Exception as exc:
        log(f'  register_scalable_target skipped: {exc}')

    log(f'  ecs update_service {express_name} desiredCount=0')
    if apply:
        ecs.update_service(cluster=cluster, service=express_name, desiredCount=0)


def delete_express(ecs, *, apply: bool, confirm: bool, classic_uses_alb: bool, express_arn: str) -> None:
    if not confirm:
        raise SystemExit('--delete-express requires --i-understand-alb-will-be-deleted')
    if classic_uses_alb:
        raise SystemExit(
            'Refusing to delete Express: the classic service still uses the Express ALB. '
            'Move DNS to an ALB you own first.'
        )
    log(f'  delete_express_gateway_service {express_arn}')
    if apply:
        ecs.delete_express_gateway_service(serviceArn=express_arn)


def main() -> int:
    parser = argparse.ArgumentParser(description='Migrate Express Mode → classic ECS rolling (one ALB, one TG).')
    parser.add_argument('--apply', action='store_true', help='Make AWS changes (default is dry-run).')
    parser.add_argument('--dry-run', action='store_true', help='Print plan only (default).')
    parser.add_argument('--region', default=DEFAULT_REGION)
    parser.add_argument('--cluster', default=DEFAULT_CLUSTER)
    parser.add_argument('--express-service', default=DEFAULT_EXPRESS_SERVICE)
    parser.add_argument('--classic-service', default=DEFAULT_CLASSIC_SERVICE)
    parser.add_argument('--target-group-name', default=DEFAULT_TG_NAME)
    parser.add_argument('--desired-count', type=int, default=2)
    parser.add_argument('--health-path', default='/health')
    parser.add_argument('--allow-koyeb-user', action='store_true')
    parser.add_argument('--delete-express', action='store_true', help='Destroy Express AND its ALB.')
    parser.add_argument('--i-understand-alb-will-be-deleted', action='store_true')
    args = parser.parse_args()
    apply = bool(args.apply) and not args.dry_run
    mode = 'APPLY' if apply else 'DRY-RUN'
    log(f'[{mode}] region={args.region} cluster={args.cluster}')

    import boto3

    profile = os.environ.get('AWS_PROFILE') or os.environ.get('AWS_DEFAULT_PROFILE')
    session = boto3.Session(profile_name=profile, region_name=args.region) if profile else boto3.Session(region_name=args.region)
    sts = session.client('sts')
    ecs = session.client('ecs')
    elbv2 = session.client('elbv2')
    ec2 = session.client('ec2')
    autoscaling = session.client('application-autoscaling')
    account = sts.get_caller_identity()['Account']
    refuse_koyeb_user(session, sts, args.allow_koyeb_user)

    express_arn = (
        f'arn:aws:ecs:{args.region}:{account}:service/{args.cluster}/{args.express_service}'
    )
    log(f'Express ARN: {express_arn}')
    express = describe_express(ecs, express_arn)
    log(f'Express status: {(express.get("status") or {}).get("statusCode")}')
    host = endpoint_host(express)
    if host:
        log(f'Express endpoint host: {host}')

    ecs_svc = describe_ecs_service(ecs, args.cluster, args.express_service)
    if not ecs_svc:
        log(f'Note: describe_services did not return {args.express_service}; using Express configuration only.')
        ecs_svc = {}

    task_def = resolve_task_def(ecs, args.cluster, args.express_service, express, ecs_svc)
    log(f'Task definition: {task_def}')
    container_name, container_port = task_def_container(ecs, task_def)
    log(f'Container: {container_name}:{container_port}')

    awsvpc = resolve_network(express, ecs_svc)
    subnets = awsvpc.get('subnets') or []
    vpc_id = subnet_vpc(ec2, subnets[0])
    log(f'VPC {vpc_id} subnets={subnets} sgs={awsvpc.get("securityGroups")}')

    lbs = (ecs_svc or {}).get('loadBalancers') or []
    if lbs:
        current_tg_arn = lbs[0]['targetGroupArn']
        alb, current_tg = find_alb_for_target_group(elbv2, current_tg_arn)
        listener = https_listener(elbv2, alb['LoadBalancerArn'])
        express_tgs = set(pick_express_target_groups(elbv2, listener, ecs_svc, host))
    else:
        log('No loadBalancers on the ECS service; locating ALB by Express hostname.')
        alb, listener, current_tg_arn, host_tgs = find_alb_by_host(elbv2, host)
        current_tg = elbv2.describe_target_groups(TargetGroupArns=[current_tg_arn])['TargetGroups'][0]
        express_tgs = set(host_tgs)

    alb_arn = alb['LoadBalancerArn']
    log(f'ALB: {alb.get("LoadBalancerName")}  {alb.get("DNSName")}')
    log(f'Current TG: {current_tg.get("TargetGroupName")}  {current_tg_arn}')
    log(f'Listener: {listener.get("Protocol")}:{listener.get("Port")} {listener.get("ListenerArn")}')
    if apply:
        elbv2.modify_load_balancer_attributes(
            LoadBalancerArn=alb_arn,
            Attributes=[{'Key': 'idle_timeout.timeout_seconds', 'Value': '300'}],
        )
        log('ALB idle timeout set to 300s (Socket.IO polling)')
    else:
        log('ALB idle timeout would be set to 300s (Socket.IO polling)')
    log(f'Express-related TGs ({len(express_tgs)}):')
    for arn in express_tgs:
        log(f'  {arn}')

    log('')
    log('Plan:')
    log(f'  1. Target group {args.target_group_name} (stickiness {STICKINESS_SECONDS}s, /health)')
    log(f'  2. Classic service {args.classic_service} desired={args.desired_count} rolling 100/200')
    log('  3. Point this app listener rule at that TG only')
    log(f'  4. Scale {args.express_service} to 0 (do not delete Express / ALB)')
    if args.delete_express:
        log('  5. DELETE Express Gateway (destroys ALB) — extra flags required')
    log('')

    new_tg = create_or_get_target_group(
        elbv2,
        apply=apply,
        name=args.target_group_name,
        vpc_id=vpc_id,
        port=container_port,
        health_path=args.health_path,
    )
    new_tg_arn = new_tg['TargetGroupArn']
    ensure_tg_drain_attributes(elbv2, apply=apply, tg_arn=new_tg_arn)
    associate_tg_with_listener(elbv2, apply=apply, listener=listener, host=host, new_tg_arn=new_tg_arn)

    classic = ensure_classic_service(
        ecs,
        apply=apply,
        cluster=args.cluster,
        name=args.classic_service,
        task_def=task_def,
        net=awsvpc,
        tg_arn=new_tg_arn,
        container_name=container_name,
        container_port=container_port,
        desired=args.desired_count,
        existing_svc=ecs_svc,
    )

    retarget_listener(
        elbv2,
        apply=apply,
        listener=listener,
        host=host,
        express_tgs=express_tgs,
        new_tg_arn=new_tg_arn,
    )

    scale_express_to_zero(
        ecs,
        autoscaling,
        apply=apply,
        cluster=args.cluster,
        express_name=args.express_service,
        express_arn=express_arn,
    )

    classic_uses_alb = True
    if args.delete_express:
        delete_express(
            ecs,
            apply=apply,
            confirm=args.i_understand_alb_will_be_deleted,
            classic_uses_alb=classic_uses_alb,
            express_arn=express_arn,
        )

    log('')
    if apply:
        log('Done. Simulation hostname still uses this ALB.')
        log('Deploy with: deploy.bat default quickscribe-site')
        log('Do not use update-express-gateway-service or the Express console Deploy button.')
        if classic:
            log(f'Classic service: {classic.get("serviceArn")}')
        log(f'Target group: {new_tg_arn}')
    else:
        log('Dry-run only. Re-run with --apply to make changes.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
