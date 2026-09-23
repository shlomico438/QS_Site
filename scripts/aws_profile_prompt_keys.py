#!/usr/bin/env python3
"""Save IAM keys to a named AWS CLI profile (used by deploy.bat)."""
from __future__ import annotations

import getpass
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print('Usage: aws_profile_prompt_keys.py PROFILE REGION', file=sys.stderr)
        return 2
    profile = sys.argv[1].strip()
    region = sys.argv[2].strip()
    print(f'Enter IAM keys for profile [{profile}] (user quickscribe-ecs, not Koyeb uploader).')
    try:
        key = input('AWS Access Key ID: ').strip()
        secret = getpass.getpass('AWS Secret Access Key: ').strip()
    except EOFError:
        print('No keys entered.', file=sys.stderr)
        return 1
    if not key or not secret:
        print('Both Access Key ID and Secret Access Key are required.', file=sys.stderr)
        return 1
    cmds = [
        ['aws', 'configure', 'set', 'aws_access_key_id', key, '--profile', profile],
        ['aws', 'configure', 'set', 'aws_secret_access_key', secret, '--profile', profile],
        ['aws', 'configure', 'set', 'region', region, '--profile', profile],
    ]
    for cmd in cmds:
        subprocess.check_call(cmd)
    print(f'Saved keys to AWS profile [{profile}].')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
