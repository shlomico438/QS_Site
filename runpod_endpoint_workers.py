"""
RunPod Serverless: adjust endpoint workersMin via GraphQL (management API).

Uses RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID from the environment (e.g. Koyeb).
Optional: RUNPOD_WORKERS_MAX (default 2) passed to saveEndpoint so other settings stay intact.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

_GET_ENDPOINTS_QUERY = """
query {
  myself {
    endpoints {
      id
      name
      gpuIds
      idleTimeout
      networkVolumeId
      templateId
      locations
    }
  }
}
"""

_SAVE_ENDPOINT_MUTATION = """
mutation saveEndpoint($input: EndpointInput!) {
  saveEndpoint(input: $input) {
    id
    workersMin
    workersMax
  }
}
"""


def set_runpod_endpoint_min_workers(
    min_workers: int,
    *,
    api_key: Optional[str] = None,
    endpoint_id: Optional[str] = None,
    workers_max: Optional[int] = None,
    timeout_sec: float = 15.0,
) -> bool:
    """
    Set workersMin for the configured endpoint; preserves gpuIds, volume, locations, etc.

    Returns True if the mutation returned without GraphQL errors.
    """
    key = (api_key or os.environ.get("RUNPOD_API_KEY") or "").strip()
    eid = (endpoint_id or os.environ.get("RUNPOD_ENDPOINT_ID") or "").strip()
    if not key or not eid:
        logger.warning("set_runpod_endpoint_min_workers: missing RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID")
        return False
    wmax = workers_max
    if wmax is None:
        try:
            wmax = int(os.environ.get("RUNPOD_WORKERS_MAX", "2") or 2)
        except ValueError:
            wmax = 2
    wmin = int(min_workers)

    url = f"https://api.runpod.io/graphql?api_key={key}"
    try:
        resp = requests.post(url, json={"query": _GET_ENDPOINTS_QUERY}, timeout=timeout_sec)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.warning("set_runpod_endpoint_min_workers: fetch endpoints failed: %s", e)
        return False

    endpoints = (data.get("data") or {}).get("myself", {}).get("endpoints") or []
    current = next((e for e in endpoints if isinstance(e, dict) and e.get("id") == eid), None)
    if not current:
        logger.warning("set_runpod_endpoint_min_workers: endpoint id %s not found", eid)
        return False

    input_data: dict[str, Any] = {
        "id": current["id"],
        "name": current.get("name") or "endpoint",
        "gpuIds": current.get("gpuIds") or [],
        "workersMin": wmin,
        "workersMax": wmax,
        "idleTimeout": current.get("idleTimeout", 5),
        "templateId": current.get("templateId"),
    }
    if current.get("networkVolumeId"):
        input_data["networkVolumeId"] = current["networkVolumeId"]
    if current.get("locations"):
        input_data["locations"] = current["locations"]

    try:
        resp2 = requests.post(
            url,
            json={"query": _SAVE_ENDPOINT_MUTATION, "variables": {"input": input_data}},
            timeout=timeout_sec,
        )
        resp2.raise_for_status()
        res_data = resp2.json()
    except Exception as e:
        logger.warning("set_runpod_endpoint_min_workers: saveEndpoint failed: %s", e)
        return False

    if res_data.get("errors"):
        logger.warning(
            "set_runpod_endpoint_min_workers: GraphQL error: %s",
            (res_data["errors"][0] or {}).get("message", res_data["errors"]),
        )
        return False

    updated = (res_data.get("data") or {}).get("saveEndpoint") or {}
    logger.info(
        "RunPod endpoint %s: workersMin=%s workersMax=%s",
        eid,
        updated.get("workersMin"),
        updated.get("workersMax"),
    )
    return True
