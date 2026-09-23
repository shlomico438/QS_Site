#!/usr/bin/env python3
"""Min 1 / max 2 Fargate tasks for quickscribe-site, scaled on Maximum CPU.

Idle stays at 1×1 vCPU. A live visit pegs one task near 100% (Maximum), so
scale-out adds a spare for the next doctor. Scale-in uses Maximum too, so a
busy+idle pair (avg ~50%, max ~100%) is not mistaken for idle.

Default is dry-run. Apply with:
  set AWS_PROFILE=quickscribe-ecs
  python scripts/setup_ecs_site_autoscaling.py --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_REGION = 'eu-north-1'
DEFAULT_CLUSTER = 'default'
DEFAULT_SERVICE = 'quickscribe-site'
KOYEB_UPLOAD_USER = 'QuickScribe_Koyeb_Uploader'

SCALE_OUT_POLICY = 'quickscribe-site-cpu-scale-out'
SCALE_IN_POLICY = 'quickscribe-site-cpu-scale-in'
ALARM_HIGH = 'quickscribe-site-cpu-high'
ALARM_LOW = 'quickscribe-site-cpu-low'

MIN_CAPACITY = 1
MAX_CAPACITY = 2
SCALE_OUT_CPU = 70.0
SCALE_IN_CPU = 20.0
SCALE_OUT_PERIODS = 2  # 2×60s
SCALE_IN_PERIODS = 10  # 10×60s of all tasks idle
SCALE_OUT_COOLDOWN = 90
SCALE_IN_COOLDOWN = 300


def log(msg: str) -> None:
    print(msg, flush=True)


def _json(obj) -> str:
    return json.dumps(obj, indent=2, default=str)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--cluster', default=DEFAULT_CLUSTER)
    parser.add_argument('--service', default=DEFAULT_SERVICE)
    parser.add_argument('--region', default=os.environ.get('AWS_REGION', DEFAULT_REGION))
    parser.add_argument('--min-capacity', type=int, default=MIN_CAPACITY)
    parser.add_argument('--max-capacity', type=int, default=MAX_CAPACITY)
    args = parser.parse_args()
    apply = bool(args.apply)
    mode = 'APPLY' if apply else 'DRY-RUN'

    import boto3

    profile = os.environ.get('AWS_PROFILE') or os.environ.get('AWS_DEFAULT_PROFILE')
    session = boto3.Session(profile_name=profile, region_name=args.region) if profile else boto3.Session(region_name=args.region)
    sts = session.client('sts')
    ident = sts.get_caller_identity()
    arn = str(ident.get('Arn') or '')
    log(f'[{mode}] identity={arn}')
    if KOYEB_UPLOAD_USER in arn:
        raise SystemExit(f'Refusing to run as {KOYEB_UPLOAD_USER}')

    ecs = session.client('ecs')
    autoscaling = session.client('application-autoscaling')
    cloudwatch = session.client('cloudwatch')

    services = ecs.describe_services(cluster=args.cluster, services=[args.service]).get('services') or []
    if not services or services[0].get('status') not in ('ACTIVE', 'DRAINING'):
        raise SystemExit(f'ECS service {args.service} not found in cluster {args.cluster}')
    svc = services[0]
    desired = int(svc.get('desiredCount') or 0)
    running = int(svc.get('runningCount') or 0)
    task_def = str(svc.get('taskDefinition') or '')
    resource_id = f'service/{args.cluster}/{args.service}'
    log(f'[{mode}] service={args.cluster}/{args.service} desired={desired} running={running}')
    log(f'[{mode}] taskDef={task_def}')
    log(
        f'[{mode}] min={args.min_capacity} max={args.max_capacity} '
        f'scale-out Maximum CPU>={SCALE_OUT_CPU}% for {SCALE_OUT_PERIODS}m; '
        f'scale-in Maximum CPU<{SCALE_IN_CPU}% for {SCALE_IN_PERIODS}m'
    )

    if apply:
        autoscaling.register_scalable_target(
            ServiceNamespace='ecs',
            ResourceId=resource_id,
            ScalableDimension='ecs:service:DesiredCount',
            MinCapacity=int(args.min_capacity),
            MaxCapacity=int(args.max_capacity),
        )
    log(f'[{mode}] registered scalable target {resource_id}')

    out_policy = {
        'AdjustmentType': 'ChangeInCapacity',
        'Cooldown': SCALE_OUT_COOLDOWN,
        'MetricAggregationType': 'Maximum',
        'StepAdjustments': [
            {'MetricIntervalLowerBound': 0.0, 'ScalingAdjustment': 1},
        ],
    }
    in_policy = {
        'AdjustmentType': 'ChangeInCapacity',
        'Cooldown': SCALE_IN_COOLDOWN,
        'MetricAggregationType': 'Maximum',
        'StepAdjustments': [
            {'MetricIntervalUpperBound': 0.0, 'ScalingAdjustment': -1},
        ],
    }

    out_arn = ''
    in_arn = ''
    if apply:
        out_arn = autoscaling.put_scaling_policy(
            PolicyName=SCALE_OUT_POLICY,
            ServiceNamespace='ecs',
            ResourceId=resource_id,
            ScalableDimension='ecs:service:DesiredCount',
            PolicyType='StepScaling',
            StepScalingPolicyConfiguration=out_policy,
        )['PolicyARN']
        in_arn = autoscaling.put_scaling_policy(
            PolicyName=SCALE_IN_POLICY,
            ServiceNamespace='ecs',
            ResourceId=resource_id,
            ScalableDimension='ecs:service:DesiredCount',
            PolicyType='StepScaling',
            StepScalingPolicyConfiguration=in_policy,
        )['PolicyARN']
        log(f'[{mode}] scale-out policy {out_arn}')
        log(f'[{mode}] scale-in policy {in_arn}')
    else:
        log(f'[{mode}] would put step policies {SCALE_OUT_POLICY} / {SCALE_IN_POLICY}')

    dims = [
        {'Name': 'ClusterName', 'Value': args.cluster},
        {'Name': 'ServiceName', 'Value': args.service},
    ]
    metric = {
        'Namespace': 'AWS/ECS',
        'MetricName': 'CPUUtilization',
        'Dimensions': dims,
        'Statistic': 'Maximum',
        'Period': 60,
    }

    if apply:
        cloudwatch.put_metric_alarm(
            AlarmName=ALARM_HIGH,
            AlarmDescription='Scale out quickscribe-site when any task CPU is high (live transcribe).',
            Namespace=metric['Namespace'],
            MetricName=metric['MetricName'],
            Dimensions=dims,
            Statistic='Maximum',
            Period=60,
            EvaluationPeriods=SCALE_OUT_PERIODS,
            Threshold=SCALE_OUT_CPU,
            ComparisonOperator='GreaterThanOrEqualToThreshold',
            TreatMissingData='notBreaching',
            AlarmActions=[out_arn],
        )
        cloudwatch.put_metric_alarm(
            AlarmName=ALARM_LOW,
            AlarmDescription='Scale in quickscribe-site when every task CPU is idle.',
            Namespace=metric['Namespace'],
            MetricName=metric['MetricName'],
            Dimensions=dims,
            Statistic='Maximum',
            Period=60,
            EvaluationPeriods=SCALE_IN_PERIODS,
            DatapointsToAlarm=SCALE_IN_PERIODS,
            Threshold=SCALE_IN_CPU,
            ComparisonOperator='LessThanThreshold',
            TreatMissingData='notBreaching',
            AlarmActions=[in_arn],
        )
        log(f'[{mode}] alarms {ALARM_HIGH} / {ALARM_LOW}')
    else:
        log(f'[{mode}] would put alarms {ALARM_HIGH} / {ALARM_LOW}')

    if desired != args.min_capacity:
        log(f'[{mode}] update_service desiredCount {desired} -> {args.min_capacity}')
        if apply:
            ecs.update_service(
                cluster=args.cluster,
                service=args.service,
                desiredCount=int(args.min_capacity),
            )
    else:
        log(f'[{mode}] desiredCount already {desired}')

    if not apply:
        log('Dry-run only. Re-run with --apply to change AWS.')
    else:
        log('Applied. Idle bill is one 1 vCPU task; a live visit can add a second.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
