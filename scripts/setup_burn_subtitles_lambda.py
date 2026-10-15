#!/usr/bin/env python3
"""Create/update the QuickScribe movie burn Lambda (container image + ffmpeg).

Default is dry-run. Apply with:
  set AWS_PROFILE=quickscribe-ecs
  python scripts/setup_burn_subtitles_lambda.py --apply

Then set on the Site ECS task:
  BURN_LAMBDA_FUNCTION_NAME=quickscribe-burn-subtitles
  ENABLE_AUDIO_PREPROCESSING=false

You can then remove RUNPOD_CPU_ENDPOINT_ID / RUNPOD_MOVIE_ENDPOINT_ID if unused.
The ECS task role needs lambda:InvokeFunction on this function.
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
FUNCTION_NAME = "quickscribe-burn-subtitles"
REPO_NAME = "quickscribe-burn-subtitles"
ROLE_NAME = "quickscribe-burn-subtitles-lambda"
SITE_ROLE_HINT = "ECS task role for quickscribe-site"
MEMORY_MB = 3008
TIMEOUT_SEC = 900
EPHEMERAL_MB = 4096

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


def _ensure_role(iam, account: str) -> str:
    role_arn = f"arn:aws:iam::{account}:role/{ROLE_NAME}"
    trust = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }
    try:
        iam.get_role(RoleName=ROLE_NAME)
        log(f"IAM role exists: {ROLE_NAME}")
    except iam.exceptions.NoSuchEntityException:
        log(f"Creating IAM role {ROLE_NAME}")
        iam.create_role(
            RoleName=ROLE_NAME,
            AssumeRolePolicyDocument=json.dumps(trust),
            Description="QuickScribe subtitle burn Lambda",
        )
        time.sleep(8)
    iam.attach_role_policy(
        RoleName=ROLE_NAME,
        PolicyArn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    )
    return role_arn


def _ensure_repo(ecr, repo: str) -> str:
    try:
        ecr.describe_repositories(repositoryNames=[repo])
        log(f"ECR repo exists: {repo}")
    except ecr.exceptions.RepositoryNotFoundException:
        log(f"Creating ECR repo {repo}")
        ecr.create_repository(repositoryName=repo, imageScanningConfiguration={"scanOnPush": True})
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


def _ensure_function(lam, *, name: str, role_arn: str, image_uri: str) -> str:
    env = {
        "Variables": {
            "FFMPEG_PATH": "/opt/bin/ffmpeg",
            "BURN_FONTS_DIR": "/opt/fonts",
            "BURN_FFMPEG_TIMEOUT_SEC": "840",
        }
    }
    try:
        current = lam.get_function(FunctionName=name)
        log(f"Updating Lambda code/config: {name}")
        lam.update_function_code(FunctionName=name, ImageUri=image_uri, Publish=True)
        waiter = lam.get_waiter("function_updated_v2")
        waiter.wait(FunctionName=name)
        lam.update_function_configuration(
            FunctionName=name,
            Role=role_arn,
            Timeout=TIMEOUT_SEC,
            MemorySize=MEMORY_MB,
            EphemeralStorage={"Size": EPHEMERAL_MB},
            Environment=env,
        )
        waiter.wait(FunctionName=name)
        return current["Configuration"]["FunctionArn"]
    except lam.exceptions.ResourceNotFoundException:
        log(f"Creating Lambda {name}")
        created = lam.create_function(
            FunctionName=name,
            PackageType="Image",
            Code={"ImageUri": image_uri},
            Role=role_arn,
            Timeout=TIMEOUT_SEC,
            MemorySize=MEMORY_MB,
            EphemeralStorage={"Size": EPHEMERAL_MB},
            Environment=env,
            Architectures=["x86_64"],
        )
        waiter = lam.get_waiter("function_active_v2")
        waiter.wait(FunctionName=name)
        return created["FunctionArn"]


def _print_site_env(function_name: str, function_arn: str) -> None:
    log("")
    log("=== Site ECS env (set these, then redeploy Site) ===")
    log(f"BURN_LAMBDA_FUNCTION_NAME={function_name}")
    log("ENABLE_AUDIO_PREPROCESSING=false")
    log("# Optional: remove RunPod CPU once burn works on Lambda")
    log("# RUNPOD_CPU_ENDPOINT_ID=")
    log("# RUNPOD_MOVIE_ENDPOINT_ID=")
    log("# RUNPOD_BURN_ENDPOINT_ID=")
    log("")
    log(f"Grant {SITE_ROLE_HINT} permission:")
    log(
        json.dumps(
            {
                "Effect": "Allow",
                "Action": ["lambda:InvokeFunction"],
                "Resource": function_arn,
            },
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Setup QuickScribe burn-subtitles Lambda")
    parser.add_argument("--apply", action="store_true", help="Create/update AWS resources")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION") or DEFAULT_REGION)
    parser.add_argument("--function-name", default=FUNCTION_NAME)
    parser.add_argument("--repo-name", default=REPO_NAME)
    parser.add_argument("--tag", default=None, help="Image tag (default: timestamp)")
    args = parser.parse_args()

    if not args.apply:
        log("Dry-run only. Re-run with --apply to build/push/create.")
        log(f"Dockerfile: {DOCKERFILE}")
        log(f"Function: {args.function_name}")
        log(f"ECR repo: {args.repo_name}")
        return

    session = _session(args.region)
    sts = session.client("sts")
    iam = session.client("iam")
    ecr = session.client("ecr")
    lam = session.client("lambda")

    account = _account_id(sts)
    log(f"AWS account={account} region={args.region}")
    role_arn = _ensure_role(iam, account)
    repo_uri = _ensure_repo(ecr, args.repo_name)
    _docker_login(ecr, args.region, repo_uri)
    tag = (args.tag or time.strftime("%Y%m%d-%H%M%S")).strip()
    image_uri = _build_and_push(repo_uri, tag)
    function_arn = _ensure_function(
        lam,
        name=args.function_name,
        role_arn=role_arn,
        image_uri=image_uri,
    )
    log(f"Lambda ready: {function_arn}")
    _print_site_env(args.function_name, function_arn)


if __name__ == "__main__":
    main()
