"""Protect a live ECS task from autoscaling scale-in.

Socket.IO sessions are in-memory. If ECS picks the busy task when desired
count drops 2→1, the doctor's stream dies. Fail open if metadata/IAM is missing.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)

PROTECTION_EXPIRES_MINUTES = 120
_METADATA_TIMEOUT_SEC = 2.0

_cached_task_arn: Optional[str] = None
_cached_cluster: Optional[str] = None
_last_enabled: Optional[bool] = None


def reset_ecs_task_protection_cache() -> None:
    global _cached_task_arn, _cached_cluster, _last_enabled
    _cached_task_arn = None
    _cached_cluster = None
    _last_enabled = None


def _metadata_task_url() -> str:
    base = (os.environ.get('ECS_CONTAINER_METADATA_URI_V4') or os.environ.get('ECS_CONTAINER_METADATA_URI') or '').rstrip('/')
    if not base:
        return ''
    return base + '/task'


def fetch_ecs_task_identity(url: Optional[str] = None) -> tuple[str, str]:
    """Return (cluster, task_arn) from the ECS metadata endpoint."""
    global _cached_task_arn, _cached_cluster
    if _cached_task_arn and _cached_cluster:
        return _cached_cluster, _cached_task_arn
    meta_url = url if url is not None else _metadata_task_url()
    if not meta_url:
        return '', ''
    try:
        with urllib.request.urlopen(meta_url, timeout=_METADATA_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode('utf-8') or '{}')
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError) as exc:
        logger.info('ECS task metadata unavailable: %s', exc)
        return '', ''
    cluster = str(payload.get('Cluster') or payload.get('ClusterARN') or '').strip()
    task_arn = str(payload.get('TaskARN') or '').strip()
    if cluster and task_arn:
        _cached_cluster = cluster
        _cached_task_arn = task_arn
    return cluster, task_arn


def set_ecs_scale_in_protection(
    enabled: bool,
    *,
    cluster: str = '',
    task_arn: str = '',
    ecs_client=None,
    expires_in_minutes: int = PROTECTION_EXPIRES_MINUTES,
) -> bool:
    """Enable or disable scale-in protection on this task. Returns True on success."""
    global _last_enabled, _cached_cluster, _cached_task_arn
    if cluster and task_arn:
        _cached_cluster = cluster
        _cached_task_arn = task_arn
    else:
        cluster = cluster or fetch_ecs_task_identity()[0]
        task_arn = task_arn or fetch_ecs_task_identity()[1]
    if not cluster or not task_arn:
        return False
    if ecs_client is None:
        try:
            import boto3
            region = os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or 'eu-north-1'
            ecs_client = boto3.client('ecs', region_name=region)
        except Exception as exc:
            logger.info('ECS scale-in protection skipped (no client): %s', exc)
            return False
    kwargs = {
        'cluster': cluster,
        'tasks': [task_arn],
        'protectionEnabled': bool(enabled),
    }
    if enabled:
        kwargs['expiresInMinutes'] = max(1, min(int(expires_in_minutes), 2880))
    try:
        ecs_client.update_task_protection(**kwargs)
    except Exception as exc:
        logger.info('ECS scale-in protection update failed enabled=%s: %s', enabled, exc)
        return False
    _last_enabled = bool(enabled)
    logger.info(
        'ECS scale-in protection %s task=%s',
        'enabled' if enabled else 'disabled',
        task_arn.rsplit('/', 1)[-1],
    )
    return True


def sync_ecs_scale_in_protection(active_sessions: int, *, ecs_client=None) -> None:
    """Protect this task while any live transcribe session is open."""
    want = int(active_sessions or 0) > 0
    if _last_enabled is False and not want:
        return
    if _last_enabled is True and want:
        # Refresh expiry on long visits (rollover marks active again).
        set_ecs_scale_in_protection(True, ecs_client=ecs_client)
        return
    set_ecs_scale_in_protection(want, ecs_client=ecs_client)
