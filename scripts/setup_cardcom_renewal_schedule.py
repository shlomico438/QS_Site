#!/usr/bin/env python3
"""Daily EventBridge schedule for QuickScribe Unlimited Cardcom renewals.

Reads MEDICAL_BILLING_CRON_SECRET from the ECS task definition and stores a
copy in SSM only when the task still has it as plain text. The value is
never printed.

Default is dry-run. Apply with:
  set AWS_PROFILE=quickscribe-ecs
  python scripts/setup_cardcom_renewal_schedule.py --apply
"""
from __future__ import annotations

import argparse
import io
import json
import os
import zipfile
from pathlib import Path

DEFAULT_REGION = "eu-north-1"
DEFAULT_CLUSTER = "default"
DEFAULT_SERVICE = "quickscribe-site"
KOYEB_UPLOAD_USER = "QuickScribe_Koyeb_Uploader"
SECRET_ENV = "MEDICAL_BILLING_CRON_SECRET"
SSM_NAME = "/quickscribe/medical-billing-cron-secret"
FUNCTION_NAME = "quickscribe-cardcom-renewal"
SCHEDULE_NAME = "quickscribe-cardcom-renewal"
ROLE_NAME = "quickscribe-cardcom-renewal"
SCHEDULER_ROLE_NAME = "quickscribe-cardcom-renewal-scheduler"
RENEWAL_URL = "https://www.getquickscribe.com/api/cardcom/run-renewals"
# 06:15 Asia/Jerusalem. One attempt; a retry could charge a period twice.
SCHEDULE_EXPRESSION = "cron(15 6 * * ? *)"
SCHEDULE_TIMEZONE = "Asia/Jerusalem"

LAMBDA_SOURCE = Path(__file__).resolve().parent / "aws" / "cardcom_renewal_lambda.py"


def log(msg: str) -> None:
    print(msg, flush=True)


def _session(region: str):
    import boto3

    profile = os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE")
    if profile:
        return boto3.Session(profile_name=profile, region_name=region)
    return boto3.Session(region_name=region)


def _find_secret(container: dict):
    for item in container.get("secrets") or []:
        if item.get("name") == SECRET_ENV and str(item.get("valueFrom") or "").strip():
            return "ref", str(item["valueFrom"]).strip()
    for item in container.get("environment") or []:
        if item.get("name") == SECRET_ENV and str(item.get("value") or "").strip():
            return "plain", str(item["value"])
    return None, None


def _task_secret(ecs, cluster: str, service: str):
    services = ecs.describe_services(cluster=cluster, services=[service]).get("services") or []
    if not services or services[0].get("status") not in ("ACTIVE", "DRAINING"):
        raise SystemExit(f"ECS service {service} not found in cluster {cluster}")
    task_def = str(services[0].get("taskDefinition") or "")
    if not task_def:
        raise SystemExit(f"ECS service {service} has no task definition")
    described = ecs.describe_task_definition(taskDefinition=task_def)["taskDefinition"]
    for container in described.get("containerDefinitions") or []:
        kind, value = _find_secret(container)
        if kind:
            return task_def, str(container.get("name") or ""), kind, value, described
    return task_def, "", None, None, described


TASK_KEEP = (
    "family",
    "taskRoleArn",
    "executionRoleArn",
    "networkMode",
    "containerDefinitions",
    "volumes",
    "placementConstraints",
    "requiresCompatibilities",
    "cpu",
    "memory",
    "runtimePlatform",
    "ephemeralStorage",
    "pidMode",
    "ipcMode",
    "proxyConfiguration",
    "inferenceAccelerators",
)


def _environment_secret_arn(described: dict) -> str:
    for container in described.get("containerDefinitions") or []:
        for item in container.get("secrets") or []:
            ref = str(item.get("valueFrom") or "")
            if ":secretsmanager:" in ref and "quickscribe-environment" in ref:
                return _secrets_manager_id(ref)
    raise SystemExit("Could not find the quickscribe-environment secret on the ECS task")


def _register_task_with_secret(ecs, described: dict, value_from: str) -> str:
    payload = {key: described[key] for key in TASK_KEEP if key in described and described[key] not in (None, [], {})}
    containers = payload.get("containerDefinitions") or []
    if not containers:
        raise SystemExit("ECS task has no containers")
    secret_list = [item for item in (containers[0].get("secrets") or []) if item.get("name") != SECRET_ENV]
    secret_list.append({"name": SECRET_ENV, "valueFrom": value_from})
    containers[0]["secrets"] = secret_list
    registered = ecs.register_task_definition(**payload)
    return registered["taskDefinition"]["taskDefinitionArn"]


def _attach_billing_secret(ecs, secrets, cluster: str, service: str, described: dict, apply: bool):
    """Add the cron secret to the shared environment secret and roll the site task."""
    secret_arn = _environment_secret_arn(described)
    log(f"shared secret {secret_arn}")
    try:
        current = secrets.get_secret_value(SecretId=secret_arn)
    except secrets.exceptions.ClientError as exc:
        code = str((exc.response.get("Error") or {}).get("Code") or "")
        if code in ("AccessDeniedException", "AccessDenied"):
            raise SystemExit(
                "This AWS user cannot read quickscribe-environment. "
                "Re-run with a user that can manage Secrets Manager, IAM, Lambda, and EventBridge Scheduler."
            ) from exc
        raise
    try:
        payload = json.loads(current.get("SecretString") or "")
    except json.JSONDecodeError as exc:
        raise SystemExit("quickscribe-environment secret is not JSON") from exc
    if not isinstance(payload, dict):
        raise SystemExit("quickscribe-environment secret is not a JSON object")
    if not str(payload.get(SECRET_ENV) or "").strip():
        import secrets as pysecrets

        payload[SECRET_ENV] = pysecrets.token_urlsafe(32)
        log(f"generate {SECRET_ENV} (value not printed)")
        if apply:
            secrets.put_secret_value(SecretId=secret_arn, SecretString=json.dumps(payload))
    else:
        log(f"{SECRET_ENV} is already in the shared secret")
    value_from = f"{secret_arn}:{SECRET_ENV}::"
    if not apply:
        log("would register a task revision that maps the secret, then update the service")
        return "ref", value_from, str(described.get("taskDefinitionArn") or "")
    new_arn = _register_task_with_secret(ecs, described, value_from)
    ecs.update_service(cluster=cluster, service=service, taskDefinition=new_arn)
    log(f"service deploying {new_arn}")
    return "ref", value_from, new_arn


def _zip_lambda() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(LAMBDA_SOURCE, "lambda_function.py")
    return buffer.getvalue()


def _ensure_role(iam, name: str, trust: dict, policy_name: str, policy: dict, apply: bool) -> str:
    path_arn = ""
    try:
        path_arn = iam.get_role(RoleName=name)["Role"]["Arn"]
        log(f"role exists {name}")
    except iam.exceptions.NoSuchEntityException:
        log(f"create role {name}")
        if apply:
            path_arn = iam.create_role(
                RoleName=name,
                AssumeRolePolicyDocument=json.dumps(trust),
                Description="QuickScribe Cardcom Unlimited renewal",
            )["Role"]["Arn"]
        else:
            path_arn = f"(would create {name})"
    if apply and path_arn and not path_arn.startswith("("):
        iam.put_role_policy(
            RoleName=name,
            PolicyName=policy_name,
            PolicyDocument=json.dumps(policy),
        )
    return path_arn


def _secrets_manager_id(ref: str) -> str:
    """ECS valueFrom may append :json-key::. GetSecretValue wants the secret ARN."""
    parts = ref.split(":")
    if len(parts) > 7:
        return ":".join(parts[:7])
    return ref


def _secret_config(kind: str, value: str, ssm, apply: bool):
    if kind == "ref":
        ref = value
        if ":secretsmanager:" in ref:
            return "secretsmanager", _secrets_manager_id(ref)
        if ref.startswith("arn:aws:ssm:"):
            name = ref.split(":parameter", 1)[-1]
            if not name.startswith("/"):
                name = "/" + name.lstrip("/")
            return "ssm", name
        return "ssm", ref
    log(f"copy {SECRET_ENV} into SSM {SSM_NAME} (value not printed)")
    if apply:
        ssm.put_parameter(
            Name=SSM_NAME,
            Value=value,
            Type="SecureString",
            Overwrite=True,
            Description="Cardcom renewal cron secret copied from the ECS task. Do not log.",
        )
    return "ssm", SSM_NAME


def _upsert_lambda(lam, role_arn: str, source: str, secret_id: str, apply: bool, json_key: str = "") -> str:
    variables = {
        "RENEWAL_URL": RENEWAL_URL,
        "SECRET_SOURCE": source,
        "SECRET_ID": secret_id,
    }
    if json_key:
        variables["SECRET_JSON_KEY"] = json_key
    env = {"Variables": variables}
    code = _zip_lambda()
    try:
        current = lam.get_function(FunctionName=FUNCTION_NAME)
        arn = current["Configuration"]["FunctionArn"]
        log(f"update lambda {FUNCTION_NAME}")
        if apply:
            lam.update_function_code(FunctionName=FUNCTION_NAME, ZipFile=code)
            waiter = lam.get_waiter("function_updated")
            waiter.wait(FunctionName=FUNCTION_NAME)
            lam.update_function_configuration(
                FunctionName=FUNCTION_NAME,
                Role=role_arn,
                Timeout=180,
                MemorySize=128,
                Environment=env,
            )
        return arn
    except lam.exceptions.ResourceNotFoundException:
        log(f"create lambda {FUNCTION_NAME}")
        if not apply:
            return f"(would create {FUNCTION_NAME})"
        last_error = None
        for _ in range(6):
            try:
                created = lam.create_function(
                    FunctionName=FUNCTION_NAME,
                    Runtime="python3.12",
                    Role=role_arn,
                    Handler="lambda_function.handler",
                    Code={"ZipFile": code},
                    Timeout=180,
                    MemorySize=128,
                    Environment=env,
                    Description="Daily Cardcom token charge for QuickScribe Unlimited.",
                )
                return created["FunctionArn"]
            except lam.exceptions.InvalidParameterValueException as exc:
                last_error = exc
                if "cannot be assumed" not in str(exc).lower() and "role" not in str(exc).lower():
                    raise
                import time
                time.sleep(5)
        raise last_error


def _upsert_schedule(scheduler, lambda_arn: str, role_arn: str, apply: bool) -> None:
    target = {
        "Arn": lambda_arn,
        "RoleArn": role_arn,
        "Input": json.dumps({"limit": 50}),
        "RetryPolicy": {
            "MaximumRetryAttempts": 0,
            "MaximumEventAgeInSeconds": 3600,
        },
    }
    common = {
        "ScheduleExpression": SCHEDULE_EXPRESSION,
        "ScheduleExpressionTimezone": SCHEDULE_TIMEZONE,
        "FlexibleTimeWindow": {"Mode": "OFF"},
        "Target": target,
        "State": "ENABLED",
        "Description": "Daily QuickScribe Unlimited Cardcom token renewal.",
    }
    try:
        scheduler.get_schedule(Name=SCHEDULE_NAME)
        log(f"update schedule {SCHEDULE_NAME} {SCHEDULE_EXPRESSION} {SCHEDULE_TIMEZONE}")
        if apply:
            scheduler.update_schedule(Name=SCHEDULE_NAME, **common)
    except scheduler.exceptions.ResourceNotFoundException:
        log(f"create schedule {SCHEDULE_NAME} {SCHEDULE_EXPRESSION} {SCHEDULE_TIMEZONE}")
        if apply:
            scheduler.create_schedule(Name=SCHEDULE_NAME, **common)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--cluster", default=DEFAULT_CLUSTER)
    parser.add_argument("--service", default=DEFAULT_SERVICE)
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", DEFAULT_REGION))
    args = parser.parse_args()
    apply = bool(args.apply)
    mode = "APPLY" if apply else "DRY-RUN"
    if not LAMBDA_SOURCE.is_file():
        raise SystemExit(f"Missing lambda source {LAMBDA_SOURCE}")

    session = _session(args.region)
    ident = session.client("sts").get_caller_identity()
    arn = str(ident.get("Arn") or "")
    account = str(ident.get("Account") or "")
    log(f"[{mode}] identity={arn}")
    if KOYEB_UPLOAD_USER in arn:
        raise SystemExit(f"Refusing to run as {KOYEB_UPLOAD_USER}")

    ecs = session.client("ecs")
    secrets = session.client("secretsmanager")
    task_def, container, kind, secret_value, described = _task_secret(ecs, args.cluster, args.service)
    log(f"[{mode}] taskDef={task_def} container={container or '(none)'} secret={kind or 'missing'}")
    if not kind:
        kind, secret_value, task_def = _attach_billing_secret(
            ecs, secrets, args.cluster, args.service, described, apply
        )
        log(f"[{mode}] attached secret kind={kind}")

    ssm = session.client("ssm")
    source, secret_id = _secret_config(kind, secret_value, ssm, apply)
    log(f"[{mode}] secret source={source} id={secret_id}")

    iam = session.client("iam")
    lambda_trust = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "lambda.amazonaws.com"},
                "Action": "sts:AssumeRole",
            }
        ],
    }
    if source == "secretsmanager":
        secret_resource = secret_id if secret_id.startswith("arn:") else f"arn:aws:secretsmanager:{args.region}:{account}:secret:{secret_id}*"
        secret_policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": ["secretsmanager:GetSecretValue"],
                    "Resource": secret_resource,
                },
                {
                    "Effect": "Allow",
                    "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                    "Resource": f"arn:aws:logs:{args.region}:{account}:*",
                },
            ],
        }
    else:
        param_name = secret_id[1:] if secret_id.startswith("/") else secret_id
        secret_policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": ["ssm:GetParameter"],
                    "Resource": f"arn:aws:ssm:{args.region}:{account}:parameter/{param_name}",
                },
                {
                    "Effect": "Allow",
                    "Action": ["kms:Decrypt"],
                    "Resource": "*",
                    "Condition": {"StringEquals": {"kms:ViaService": f"ssm.{args.region}.amazonaws.com"}},
                },
                {
                    "Effect": "Allow",
                    "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                    "Resource": f"arn:aws:logs:{args.region}:{account}:*",
                },
            ],
        }
    role_arn = _ensure_role(iam, ROLE_NAME, lambda_trust, "renewal", secret_policy, apply)

    scheduler_trust = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "scheduler.amazonaws.com"},
                "Action": "sts:AssumeRole",
            }
        ],
    }
    invoke_policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": ["lambda:InvokeFunction"],
                "Resource": f"arn:aws:lambda:{args.region}:{account}:function:{FUNCTION_NAME}",
            }
        ],
    }
    scheduler_role = _ensure_role(
        iam, SCHEDULER_ROLE_NAME, scheduler_trust, "invoke", invoke_policy, apply
    )

    lam = session.client("lambda")
    if apply and role_arn.startswith("arn:"):
        # A brand-new role cannot be assumed for a few seconds.
        import time

        time.sleep(10)
    json_key = SECRET_ENV if source == "secretsmanager" else ""
    function_arn = _upsert_lambda(lam, role_arn, source, secret_id, apply, json_key)
    log(f"[{mode}] lambda={function_arn}")
    if apply and scheduler_role.startswith("arn:") and function_arn.startswith("arn:"):
        _upsert_schedule(session.client("scheduler"), function_arn, scheduler_role, apply)
    elif not apply:
        log(f"[{mode}] would schedule {SCHEDULE_NAME} at {SCHEDULE_EXPRESSION} {SCHEDULE_TIMEZONE}")

    if not apply:
        log("Dry-run only. Re-run with --apply to change AWS.")
    else:
        log(
            f"Applied. EventBridge runs {SCHEDULE_NAME} daily at 06:15 {SCHEDULE_TIMEZONE} "
            f"and posts {RENEWAL_URL}."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
