#!/usr/bin/env python3
"""Build/push the burn worker image and register an ECS Fargate task definition.

Typical two-profile flow (Koyeb uploader cannot call ECS APIs):

  set AWS_PROFILE=quickscribeAdmin
  python scripts/setup_burn_subtitles_ecs.py --apply
  :: if register fails AccessDenied, re-run with ecs profile + printed --image-uri:

  set AWS_PROFILE=quickscribe-ecs
  python scripts/setup_burn_subtitles_ecs.py --apply --skip-build --image-uri IMAGE

quickscribeAdmin = QuickScribe_Koyeb_Uploader (ECR push).
quickscribe-ecs = describe Site + register_task_definition.

Then set on the Site ECS task:
  BURN_ECS_CLUSTER=default
  BURN_ECS_TASK_DEFINITION=quickscribe-burn-subtitles
  BURN_ECS_SUBNETS=subnet-...,subnet-...
  BURN_ECS_SECURITY_GROUPS=sg-...
  BURN_ECS_ASSIGN_PUBLIC_IP=ENABLED
  ENABLE_AUDIO_PREPROCESSING=false

The Site task role needs ecs:RunTask, ecs:DescribeTasks, and iam:PassRole on the
burn execution/task roles.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

DEFAULT_REGION = "eu-north-1"
DEFAULT_ACCOUNT = "760351563015"
REPO_NAME = "quickscribe-burn-subtitles"
TASK_FAMILY = "quickscribe-burn-subtitles"
CONTAINER_NAME = "burn"
SITE_CLUSTER = "default"
SITE_SERVICE = "quickscribe-site"
# 2 vCPU / 4 GB — enough for ffmpeg burn without starving the Site service.
TASK_CPU = "2048"
TASK_MEMORY = "4096"
LOG_GROUP = "/ecs/quickscribe-burn-subtitles"

# Known Site network/roles (eu-north-1) when DescribeServices is denied (Koyeb profile).
DEFAULT_SUBNETS = (
    "subnet-079cbe219ad9275ff",
    "subnet-0695dfe6c7a094b0f",
)
DEFAULT_SECURITY_GROUPS = ("sg-082be38f72b1e65dc",)
DEFAULT_ASSIGN_PUBLIC_IP = "ENABLED"
DEFAULT_EXECUTION_ROLE_ARN = "arn:aws:iam::760351563015:role/ecsTaskExecutionRole"
DEFAULT_TASK_ROLE_ARN = "arn:aws:iam::760351563015:role/quickscribe_s3fullaccess"

AWS_DIR = Path(__file__).resolve().parent / "aws"
DOCKERFILE = AWS_DIR / "Dockerfile.burn"


def log(msg: str) -> None:
    print(msg, flush=True)


def _session(region: str):
    import boto3

    profile = os.environ.get("AWS_PROFILE") or os.environ.get("AWS_DEFAULT_PROFILE")
    if profile:
        return boto3.Session(profile_name=profile, region_name=region)
    return boto3.Session(region_name=region)


def _account_id(sts) -> str:
    return str(sts.get_caller_identity()["Account"])


def _ensure_repo(ecr, repo: str) -> str:
    try:
        ecr.describe_repositories(repositoryNames=[repo])
        log(f"ECR repo exists: {repo}")
    except ecr.exceptions.RepositoryNotFoundException:
        log(f"Creating ECR repo {repo}")
        try:
            ecr.create_repository(repositoryName=repo, imageScanningConfiguration={"scanOnPush": True})
        except Exception as exc:
            raise SystemExit(
                f"Cannot create ECR repo '{repo}' with this AWS profile.\n"
                "Use AWS_PROFILE=quickscribeAdmin, or create the repo in the console first.\n"
                f"Detail: {exc}"
            ) from exc
    except Exception as exc:
        if "AccessDenied" in str(exc):
            raise SystemExit(
                f"Cannot access ECR repo '{repo}'. Use: set AWS_PROFILE=quickscribeAdmin\n"
                f"Detail: {exc}"
            ) from exc
        raise
    return ecr.describe_repositories(repositoryNames=[repo])["repositories"][0]["repositoryUri"]


def _docker_login(ecr, region: str, repo_uri: str) -> None:
    auth = ecr.get_authorization_token()["authorizationData"][0]
    import base64

    user, password = base64.b64decode(auth["authorizationToken"]).decode("utf-8").split(":", 1)
    registry = repo_uri.split("/")[0]
    subprocess.run(
        ["docker", "login", "--username", user, "--password-stdin", registry],
        input=password.encode("utf-8"),
        check=True,
    )


def _build_and_push(repo_uri: str, tag: str) -> str:
    image = f"{repo_uri}:{tag}"
    if not DOCKERFILE.is_file():
        raise SystemExit(f"Missing Dockerfile: {DOCKERFILE}")
    log(f"Building {image}")
    subprocess.run(
        [
            "docker",
            "build",
            "--platform",
            "linux/amd64",
            "-f",
            str(DOCKERFILE),
            "-t",
            image,
            str(AWS_DIR),
        ],
        check=True,
    )
    log(f"Pushing {image}")
    subprocess.run(["docker", "push", image], check=True)
    return image


def _csv_env(name: str) -> list[str]:
    raw = (os.environ.get(name) or "").strip()
    return [p.strip() for p in raw.split(",") if p.strip()]


def _defaults_network_and_roles() -> dict:
    return {
        "subnets": list(DEFAULT_SUBNETS),
        "securityGroups": list(DEFAULT_SECURITY_GROUPS),
        "assignPublicIp": DEFAULT_ASSIGN_PUBLIC_IP,
        "executionRoleArn": DEFAULT_EXECUTION_ROLE_ARN,
        "taskRoleArn": DEFAULT_TASK_ROLE_ARN,
        "siteTaskDefinition": "",
        "source": "defaults",
    }


def _site_network_and_roles(ecs, cluster: str, service: str) -> dict:
    """Discover Site awsvpc + roles; fall back to env/defaults if profile lacks ECS read."""
    try:
        services = ecs.describe_services(cluster=cluster, services=[service]).get("services") or []
    except Exception as exc:
        if "AccessDenied" in str(exc) or "Unauthorized" in str(exc):
            log(
                "Note: this AWS profile cannot ecs:DescribeServices "
                "(quickscribeAdmin / Koyeb). Using env args or known Site defaults."
            )
            return _defaults_network_and_roles()
        raise
    if not services or not services[0].get("status") or services[0].get("status") == "INACTIVE":
        # describe_services returns empty list when missing, or stub with missing fields
        if not services:
            log(f"Note: ECS service {service} not visible; using defaults")
            return _defaults_network_and_roles()
    svc = services[0]
    awsvpc = ((svc.get("networkConfiguration") or {}).get("awsvpcConfiguration") or {})
    subnets = list(awsvpc.get("subnets") or [])
    sgs = list(awsvpc.get("securityGroups") or [])
    assign_ip = awsvpc.get("assignPublicIp") or "ENABLED"
    if not subnets:
        log(f"Note: service {service} has no awsvpc subnets; using defaults")
        return _defaults_network_and_roles()

    td_arn = (svc.get("taskDefinition") or "").strip()
    execution_role = ""
    task_role = ""
    if td_arn:
        try:
            td = ecs.describe_task_definition(taskDefinition=td_arn)["taskDefinition"]
            execution_role = td.get("executionRoleArn") or ""
            task_role = td.get("taskRoleArn") or ""
        except Exception as exc:
            log(f"Note: could not describe task definition ({exc}); using default roles")
            execution_role = DEFAULT_EXECUTION_ROLE_ARN
            task_role = DEFAULT_TASK_ROLE_ARN
    return {
        "subnets": subnets,
        "securityGroups": sgs,
        "assignPublicIp": assign_ip,
        "executionRoleArn": execution_role or DEFAULT_EXECUTION_ROLE_ARN,
        "taskRoleArn": task_role or DEFAULT_TASK_ROLE_ARN,
        "siteTaskDefinition": td_arn,
        "source": "live",
    }


def _ensure_log_group(logs, name: str) -> None:
    try:
        logs.create_log_group(logGroupName=name)
        log(f"Created log group {name}")
    except logs.exceptions.ResourceAlreadyExistsException:
        log(f"Log group exists: {name}")
    except Exception as exc:
        if "AccessDenied" in str(exc) or "Unauthorized" in str(exc):
            log(f"Note: could not create log group {name} ({exc}); create in console if missing")
        else:
            raise


def _register_task_definition(
    ecs,
    *,
    family: str,
    image_uri: str,
    execution_role_arn: str,
    task_role_arn: str,
    region: str,
) -> str:
    if not execution_role_arn:
        raise SystemExit(
            "No executionRoleArn available from Site task definition.\n"
            "Pass --execution-role-arn or create an ECS task execution role in the console."
        )
    container = {
        "name": CONTAINER_NAME,
        "image": image_uri,
        "essential": True,
        "environment": [
            {"name": "FFMPEG_PATH", "value": "/opt/bin/ffmpeg"},
            {"name": "BURN_FONTS_DIR", "value": "/opt/fonts"},
            {"name": "BURN_FFMPEG_TIMEOUT_SEC", "value": "1680"},
            {"name": "BURN_ENGINE", "value": "ecs"},
        ],
        "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
                "awslogs-group": LOG_GROUP,
                "awslogs-region": region,
                "awslogs-stream-prefix": "burn",
            },
        },
    }
    payload = {
        "family": family,
        "requiresCompatibilities": ["FARGATE"],
        "networkMode": "awsvpc",
        "cpu": TASK_CPU,
        "memory": TASK_MEMORY,
        "executionRoleArn": execution_role_arn,
        "containerDefinitions": [container],
        "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
    }
    if task_role_arn:
        payload["taskRoleArn"] = task_role_arn
    try:
        registered = ecs.register_task_definition(**payload)["taskDefinition"]
    except Exception as exc:
        raise SystemExit(
            "Cannot register ECS task definition with this AWS profile "
            "(quickscribeAdmin / Koyeb cannot ecs:RegisterTaskDefinition).\n"
            "Image is already in ECR. Finish with the ecs profile:\n"
            "  set AWS_PROFILE=quickscribe-ecs\n"
            f"  python scripts/setup_burn_subtitles_ecs.py --apply --skip-build "
            f"--image-uri {image_uri}\n"
            "Or register in the console: family "
            f"'{family}' (Fargate, {TASK_CPU} CPU / {TASK_MEMORY} MiB), "
            f"container '{CONTAINER_NAME}', image {image_uri}.\n"
            f"Detail: {exc}"
        ) from exc
    arn = registered.get("taskDefinitionArn") or ""
    if not arn:
        raise SystemExit("register_task_definition returned no ARN")
    log(f"Registered task definition: {arn}")
    return arn


def _print_site_env(
    *,
    cluster: str,
    family: str,
    task_def_arn: str,
    subnets: list[str],
    security_groups: list[str],
    assign_public_ip: str,
    execution_role_arn: str,
    task_role_arn: str,
) -> None:
    log("")
    log("=== Site ECS env (set these, then redeploy Site) ===")
    log(f"BURN_ECS_CLUSTER={cluster}")
    log(f"BURN_ECS_TASK_DEFINITION={family}")
    log(f"BURN_ECS_SUBNETS={','.join(subnets)}")
    if security_groups:
        log(f"BURN_ECS_SECURITY_GROUPS={','.join(security_groups)}")
    log(f"BURN_ECS_ASSIGN_PUBLIC_IP={assign_public_ip}")
    log("BURN_ECS_CONTAINER_NAME=burn")
    log("ENABLE_AUDIO_PREPROCESSING=false")
    log("# Optional: remove RunPod CPU once burn works on ECS")
    log("# RUNPOD_CPU_ENDPOINT_ID=")
    log("# RUNPOD_MOVIE_ENDPOINT_ID=")
    log("# RUNPOD_BURN_ENDPOINT_ID=")
    log("")
    log(f"Task definition ARN: {task_def_arn}")
    log("Grant Site task role:")
    resources = [r for r in (execution_role_arn, task_role_arn) if r]
    log(
        json.dumps(
            [
                {
                    "Effect": "Allow",
                    "Action": ["ecs:RunTask", "ecs:DescribeTasks", "ecs:TagResource"],
                    "Resource": "*",
                },
                {
                    "Effect": "Allow",
                    "Action": ["iam:PassRole"],
                    "Resource": resources or ["arn:aws:iam::ACCOUNT:role/YOUR_BURN_ROLES"],
                },
            ],
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Setup QuickScribe burn-subtitles ECS Fargate worker")
    parser.add_argument("--apply", action="store_true", help="Build/push/register")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION") or DEFAULT_REGION)
    parser.add_argument("--repo-name", default=REPO_NAME)
    parser.add_argument("--family", default=TASK_FAMILY)
    parser.add_argument("--cluster", default=os.environ.get("BURN_ECS_CLUSTER") or SITE_CLUSTER)
    parser.add_argument("--site-service", default=SITE_SERVICE)
    parser.add_argument("--tag", default=None, help="Image tag (default: timestamp)")
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip docker build/push (use with --image-uri and AWS_PROFILE=quickscribe-ecs)",
    )
    parser.add_argument(
        "--image-uri",
        default=(os.environ.get("BURN_ECS_IMAGE_URI") or "").strip(),
        help="Existing ECR image URI (required with --skip-build)",
    )
    parser.add_argument(
        "--subnets",
        default=",".join(_csv_env("BURN_ECS_SUBNETS")) or "",
        help="Comma-separated subnet IDs (defaults to Site / known values)",
    )
    parser.add_argument(
        "--security-groups",
        default=",".join(_csv_env("BURN_ECS_SECURITY_GROUPS")) or "",
        help="Comma-separated security group IDs",
    )
    parser.add_argument(
        "--assign-public-ip",
        default=(os.environ.get("BURN_ECS_ASSIGN_PUBLIC_IP") or "").strip(),
        help="ENABLED or DISABLED",
    )
    parser.add_argument(
        "--execution-role-arn",
        default=(os.environ.get("BURN_ECS_EXECUTION_ROLE_ARN") or "").strip(),
        help="ECS task execution role (defaults to Site service role)",
    )
    parser.add_argument(
        "--task-role-arn",
        default=(os.environ.get("BURN_ECS_TASK_ROLE_ARN") or "").strip(),
        help="ECS task role (defaults to Site task role; optional for presigned-only burn)",
    )
    args = parser.parse_args()

    if not args.apply:
        log("Dry-run only. Re-run with --apply to build/push/register.")
        log(f"Dockerfile: {DOCKERFILE}")
        log(f"Task family: {args.family}")
        log(f"ECR repo: {args.repo_name}")
        log("Tip: AWS_PROFILE=quickscribeAdmin for ECR push;")
        log("     AWS_PROFILE=quickscribe-ecs for --skip-build --image-uri … register")
        return

    if args.skip_build and not args.image_uri:
        raise SystemExit("--skip-build requires --image-uri")

    session = _session(args.region)
    sts = session.client("sts")
    ecr = session.client("ecr")
    ecs = session.client("ecs")
    logs = session.client("logs")

    account = _account_id(sts)
    caller = ""
    try:
        caller = str(sts.get_caller_identity().get("Arn") or "")
    except Exception:
        pass
    log(f"AWS account={account} region={args.region}")
    if caller:
        log(f"Caller: {caller}")

    # ECR first so Koyeb profile can push before any ECS register failure.
    if args.skip_build:
        image_uri = args.image_uri
        log(f"Skipping build; using {image_uri}")
    else:
        repo_uri = _ensure_repo(ecr, args.repo_name)
        _docker_login(ecr, args.region, repo_uri)
        tag = (args.tag or time.strftime("%Y%m%d-%H%M%S")).strip()
        image_uri = _build_and_push(repo_uri, tag)

    site = _site_network_and_roles(ecs, args.cluster, args.site_service)
    subnets = [p.strip() for p in (args.subnets or "").split(",") if p.strip()] or site["subnets"]
    security_groups = [
        p.strip() for p in (args.security_groups or "").split(",") if p.strip()
    ] or site["securityGroups"]
    assign_public_ip = (args.assign_public_ip or site["assignPublicIp"] or "ENABLED").upper()
    if assign_public_ip not in ("ENABLED", "DISABLED"):
        assign_public_ip = "ENABLED"
    execution_role = args.execution_role_arn or site["executionRoleArn"]
    task_role = args.task_role_arn or site["taskRoleArn"]
    log(f"Network source={site.get('source')} subnets={subnets} sgs={security_groups} ip={assign_public_ip}")
    log(f"Using execution role: {execution_role or '(none)'}")
    log(f"Using task role: {task_role or '(none)'}")

    _ensure_log_group(logs, LOG_GROUP)
    task_def_arn = _register_task_definition(
        ecs,
        family=args.family,
        image_uri=image_uri,
        execution_role_arn=execution_role,
        task_role_arn=task_role,
        region=args.region,
    )
    _print_site_env(
        cluster=args.cluster,
        family=args.family,
        task_def_arn=task_def_arn,
        subnets=subnets,
        security_groups=security_groups,
        assign_public_ip=assign_public_ip,
        execution_role_arn=execution_role,
        task_role_arn=task_role,
    )

if __name__ == "__main__":
    main()
