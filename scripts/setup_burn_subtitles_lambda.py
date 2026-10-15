#!/usr/bin/env python3
"""LEGACY: Create/update the QuickScribe movie burn Lambda.

Prefer ECS Fargate instead:
  python scripts/setup_burn_subtitles_ecs.py --apply
  See docs/burn-subtitles-ecs.md

Default is dry-run. Apply with:
  set AWS_PROFILE=quickscribeAdmin
  python scripts/setup_burn_subtitles_lambda.py --apply --role-arn arn:aws:iam::760351563015:role/service-role/cardcom-renewal-role-yqaf5p6g
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


def _ensure_role(iam, account: str, role_arn_override: str = "") -> str:
    if role_arn_override:
        log(f"Using existing IAM role: {role_arn_override}")
        return role_arn_override
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
        try:
            iam.create_role(
                RoleName=ROLE_NAME,
                AssumeRolePolicyDocument=json.dumps(trust),
                Description="QuickScribe subtitle burn Lambda",
            )
        except Exception as exc:
            raise SystemExit(
                "Cannot create IAM role with this AWS profile (none of the local "
                "CLI profiles have iam:CreateRole).\n"
                "Skip IAM by reusing the existing Cardcom Lambda role:\n"
                "  set AWS_PROFILE=quickscribeAdmin\n"
                "  python scripts/setup_burn_subtitles_lambda.py --apply "
                "--role-arn arn:aws:iam::760351563015:role/service-role/cardcom-renewal-role-yqaf5p6g\n"
                f"Detail: {exc}"
            ) from exc
        time.sleep(8)
    except Exception as exc:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
        if code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation") or "AccessDenied" in str(exc):
            raise SystemExit(
                "This AWS profile cannot call iam:GetRole/CreateRole.\n"
                "Note: profile 'quickscribeAdmin' is QuickScribe_Koyeb_Uploader "
                "(ECR/Lambda OK, no IAM). Reuse the Cardcom role instead:\n"
                "  set AWS_PROFILE=quickscribeAdmin\n"
                "  python scripts/setup_burn_subtitles_lambda.py --apply "
                "--role-arn arn:aws:iam::760351563015:role/service-role/cardcom-renewal-role-yqaf5p6g\n"
                f"Detail: {exc}"
            ) from exc
        raise
    try:
        iam.attach_role_policy(
            RoleName=ROLE_NAME,
            PolicyArn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        )
    except Exception as exc:
        log(f"Note: could not attach basic execution policy ({exc})")
    return role_arn


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
                "Use AWS_PROFILE=quickscribeAdmin, or create the repo in the console first, then re-run.\n"
                f"Detail: {exc}"
            ) from exc
    except Exception as exc:
        if "AccessDenied" in str(exc):
            raise SystemExit(
                f"Cannot access ECR repo '{repo}' with this AWS profile.\n"
                "Use: set AWS_PROFILE=quickscribeAdmin\n"
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


def _lambda_access_denied_exit(name: str, role_arn: str, image_uri: str, exc: Exception) -> None:
    raise SystemExit(
        "This AWS profile cannot create/update Lambda "
        f"(QuickScribe_Koyeb_Uploader / quickscribe-ecs lack lambda:CreateFunction).\n"
        "Image is already in ECR. Create the function once in the AWS Console "
        f"(eu-north-1), then re-run this script to update code:\n"
        f"  Name:          {name}\n"
        f"  Package type:  Container image\n"
        f"  Image URI:     {image_uri}\n"
        f"  Role:          {role_arn}\n"
        f"  Timeout:       {TIMEOUT_SEC}s\n"
        f"  Memory:        {MEMORY_MB} MB\n"
        f"  Ephemeral:     {EPHEMERAL_MB} MB\n"
        "  Architecture:  x86_64\n"
        "  Env: FFMPEG_PATH=/opt/bin/ffmpeg\n"
        "       BURN_FONTS_DIR=/opt/fonts\n"
        "       BURN_FFMPEG_TIMEOUT_SEC=840\n"
        "Console: https://eu-north-1.console.aws.amazon.com/lambda/home"
        f"?region=eu-north-1#/create/function\n"
        f"Detail: {exc}"
    )


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
    except lam.exceptions.ResourceNotFoundException:
        current = None
    except Exception as exc:
        if "AccessDenied" in str(exc):
            # Try create anyway; some keys can create but not GetFunction.
            current = None
        else:
            raise

    if current is not None:
        log(f"Updating Lambda code/config: {name}")
        try:
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
        except Exception as exc:
            if "AccessDenied" in str(exc):
                _lambda_access_denied_exit(name, role_arn, image_uri, exc)
            raise

    log(f"Creating Lambda {name}")
    try:
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
    except Exception as exc:
        if "AccessDenied" in str(exc):
            _lambda_access_denied_exit(name, role_arn, image_uri, exc)
        raise


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
    parser.add_argument(
        "--role-arn",
        default=(os.environ.get("BURN_LAMBDA_ROLE_ARN") or "").strip(),
        help="Existing Lambda execution role ARN (skips iam:GetRole/CreateRole)",
    )
    args = parser.parse_args()

    if not args.apply:
        log("Dry-run only. Re-run with --apply to build/push/create.")
        log(f"Dockerfile: {DOCKERFILE}")
        log(f"Function: {args.function_name}")
        log(f"ECR repo: {args.repo_name}")
        log("Tip: quickscribe-ecs cannot manage IAM/ECR create — use AWS_PROFILE=quickscribeAdmin")
        return

    session = _session(args.region)
    sts = session.client("sts")
    iam = session.client("iam")
    ecr = session.client("ecr")
    lam = session.client("lambda")

    account = _account_id(sts)
    log(f"AWS account={account} region={args.region}")
    role_arn = _ensure_role(iam, account, role_arn_override=args.role_arn)
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
