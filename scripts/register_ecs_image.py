#!/usr/bin/env python3
"""Clone the current ECS service task definition with a new container image.

Prints the new task definition ARN on stdout. Used by deploy.bat (avoids
PowerShell UTF-8 BOM breaking `aws ... --cli-input-json`).
"""
from __future__ import annotations

import argparse
import os
import sys

KEEP = (
    'family',
    'taskRoleArn',
    'executionRoleArn',
    'networkMode',
    'containerDefinitions',
    'volumes',
    'placementConstraints',
    'requiresCompatibilities',
    'cpu',
    'memory',
    'runtimePlatform',
    'ephemeralStorage',
    'pidMode',
    'ipcMode',
    'proxyConfiguration',
    'inferenceAccelerators',
)

# Fargate default stopTimeout is 30s. ALB deregistration_delay is 60s and
# gunicorn graceful_timeout is 60s, so ECS would SIGKILL the task mid-drain
# and drop in-memory Socket.IO sessions. 120s is the Fargate maximum.
FARGATE_STOP_TIMEOUT_SEC = 120


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--cluster', required=True)
    parser.add_argument('--service', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--region', default=os.environ.get('AWS_REGION', 'eu-north-1'))
    args = parser.parse_args()

    import boto3

    profile = os.environ.get('AWS_PROFILE') or os.environ.get('AWS_DEFAULT_PROFILE')
    session = boto3.Session(profile_name=profile, region_name=args.region) if profile else boto3.Session(region_name=args.region)
    ecs = session.client('ecs')

    services = ecs.describe_services(cluster=args.cluster, services=[args.service]).get('services') or []
    if not services:
        raise SystemExit(f'ECS service {args.service} not found in cluster {args.cluster}')
    current = (services[0].get('taskDefinition') or '').strip()
    if not current:
        raise SystemExit(f'ECS service {args.service} has no task definition')

    td = ecs.describe_task_definition(taskDefinition=current)['taskDefinition']
    payload = {k: td[k] for k in KEEP if k in td and td[k] not in (None, [], {})}
    for container in payload.get('containerDefinitions') or []:
        container['image'] = args.image
        container['stopTimeout'] = max(
            int(container.get('stopTimeout') or 0),
            FARGATE_STOP_TIMEOUT_SEC,
        )

    registered = ecs.register_task_definition(**payload)['taskDefinition']
    arn = registered.get('taskDefinitionArn') or ''
    if not arn:
        raise SystemExit('register_task_definition returned no ARN')
    print(arn)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
