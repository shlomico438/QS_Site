"""EventBridge target: charge due Cardcom tokens (Unlimited + Medical).

The billing secret is read at runtime from SSM or Secrets Manager.
It is never logged.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

# Regular Unlimited renewals (existing).
DEFAULT_RENEWAL_URL = "https://www.getquickscribe.com/api/cardcom/run-renewals"
# Medical plan + overage renewals (same cron secret).
DEFAULT_MEDICAL_RENEWAL_URL = (
    "https://www.getquickscribe.com/api/medical/cardcom/run-renewals"
)


def _secret() -> str:
    source = (os.environ.get("SECRET_SOURCE") or "ssm").strip().lower()
    secret_id = (os.environ.get("SECRET_ID") or "").strip()
    if not secret_id:
        raise RuntimeError("SECRET_ID is not set")
    if source == "secretsmanager":
        import boto3

        client = boto3.client("secretsmanager")
        value = client.get_secret_value(SecretId=secret_id).get("SecretString") or ""
    else:
        import boto3

        client = boto3.client("ssm")
        value = client.get_parameter(Name=secret_id, WithDecryption=True)["Parameter"]["Value"]
    value = str(value or "").strip()
    json_key = (os.environ.get("SECRET_JSON_KEY") or "").strip()
    if json_key:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Billing secret is not JSON") from exc
        if not isinstance(parsed, dict) or not str(parsed.get(json_key) or "").strip():
            raise RuntimeError("Billing secret JSON is missing the expected key")
        value = str(parsed[json_key]).strip()
    if not value:
        raise RuntimeError("Billing secret is empty")
    return value


def _post_renewals(url: str, secret: str, limit: int) -> dict:
    payload = json.dumps({"limit": limit}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            # Regular endpoint accepts either header; medical expects Medical.
            "X-Billing-Secret": secret,
            "X-Medical-Billing-Secret": secret,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=170) as response:
            body = response.read().decode("utf-8", errors="replace")[:2000]
            status = int(response.status)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"renewal HTTP {exc.code} url={url}: {detail}") from exc
    if status != 200:
        raise RuntimeError(f"renewal HTTP {status} url={url}: {body[:500]}")
    print(f"cardcom renewal ok status={status} url={url} bytes={len(body)}")
    return {"ok": True, "status": status, "url": url, "bytes": len(body)}


def handler(event, context):
    regular_url = (os.environ.get("RENEWAL_URL") or DEFAULT_RENEWAL_URL).strip()
    medical_url = (
        os.environ.get("MEDICAL_RENEWAL_URL") or DEFAULT_MEDICAL_RENEWAL_URL
    ).strip()
    if not regular_url:
        raise RuntimeError("RENEWAL_URL is not set")
    try:
        limit = int((event or {}).get("limit") or 50)
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(200, limit))
    secret = _secret()
    results = []
    errors = []
    for url in (regular_url, medical_url):
        if not url:
            continue
        try:
            results.append(_post_renewals(url, secret, limit))
        except Exception as exc:
            print(f"cardcom renewal failed url={url}: {exc}")
            errors.append({"url": url, "error": str(exc)})
    if errors and not results:
        raise RuntimeError(errors[0]["error"])
    if errors:
        # One path failed after the other succeeded — surface for CloudWatch alarms.
        raise RuntimeError(
            "partial renewal failure: "
            + "; ".join(f"{row['url']}: {row['error']}" for row in errors)
        )
    return {"ok": True, "results": results}
