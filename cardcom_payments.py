"""Cardcom Low Profile redirect checkout for ILS credit bundles.

Simulation (SIMULATION_MODE=true): internal /cardcom/sim-checkout page — no Cardcom API or webhook.
Production/sandbox: POST LowProfile/Create → redirect → WebHook → GetLpResult → credit wallet.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from datetime import datetime
from typing import Any, Callable, Dict, Optional
from urllib.parse import quote

import requests
from flask import Flask, jsonify, redirect, request

logger = logging.getLogger(__name__)

CARDCOM_API_BASE = (
    os.environ.get('CARDCOM_API_BASE') or 'https://secure.cardcom.solutions/api/v11'
).rstrip('/')
# Cardcom documents terminal 1000 + test card 4580… for API sandbox (same v11 host as live).
CARDCOM_SANDBOX_TERMINAL = 1000

# In-memory store for internal simulation or when Supabase table not migrated yet.
_cardcom_memory_store: Dict[str, dict] = {}
_cardcom_db_available: Optional[bool] = None


def _env_flag(name: str, default: Optional[bool] = None) -> Optional[bool]:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == '':
        return default
    return str(raw).strip().lower() in ('1', 'true', 'yes', 'on')


def _simulation_mode() -> bool:
    """QuickScribe internal green checkout page — not Cardcom's hosted sandbox."""
    if _env_flag('CARDCOM_FORCE_LIVE'):
        return False
    forced = _env_flag('CARDCOM_SIMULATION')
    if forced is True:
        return True
    if forced is False:
        return False
    return _env_flag('SIMULATION_MODE', True) is True


def _cardcom_sandbox_mode() -> bool:
    """Cardcom merchant sandbox (test terminal / test cards) on the real hosted page."""
    if _simulation_mode():
        return False
    if _env_flag('CARDCOM_SANDBOX') is True:
        return True
    if _env_flag('CARDCOM_SANDBOX') is False:
        return False
    # Default: terminal 1000 is Cardcom's documented test terminal.
    terminal = _cardcom_terminal_number()
    return terminal == CARDCOM_SANDBOX_TERMINAL


def _cardcom_invoices_enabled() -> bool:
    """Issue TaxInvoiceAndReceipt via LowProfile/Create Document block."""
    if _simulation_mode():
        return False
    flag = _env_flag('CARDCOM_INVOICES')
    if flag is False:
        return False
    if flag is True:
        return True
    # Default on in Cardcom sandbox so merchants can test before live.
    return _cardcom_sandbox_mode()


def _cardcom_invoice_document_type() -> str:
    return (
        str(os.environ.get('CARDCOM_INVOICE_TYPE') or 'TaxInvoiceAndReceipt').strip()
        or 'TaxInvoiceAndReceipt'
    )


def cardcom_runtime_status() -> dict:
    """Summary for logs / ops (no secrets)."""
    internal_sim = _simulation_mode()
    api_enabled = _cardcom_enabled() and not internal_sim
    return {
        'enabled': _cardcom_enabled(),
        'internal_simulation': internal_sim,
        'api_mode': (
            'internal_sim'
            if internal_sim
            else ('sandbox' if _cardcom_sandbox_mode() else ('live' if api_enabled else 'off'))
        ),
        'sandbox': _cardcom_sandbox_mode(),
        'invoices_enabled': _cardcom_invoices_enabled(),
        'invoice_document_type': _cardcom_invoice_document_type(),
        'terminal_configured': _cardcom_terminal_number() is not None,
        'api_base': CARDCOM_API_BASE,
    }


def _log_cardcom_startup() -> None:
    status = cardcom_runtime_status()
    logger.info(
        'Cardcom payments: mode=%s enabled=%s terminal=%s',
        status['api_mode'],
        status['enabled'],
        _cardcom_terminal_number(),
    )
    if status['api_mode'] == 'sandbox':
        logger.info(
            'Cardcom sandbox: use test card 4580000000000000 (expiry/CVV per Cardcom docs)'
        )
    elif status['api_mode'] == 'live':
        logger.warning('Cardcom LIVE payments enabled — real charges')
    if status.get('invoices_enabled'):
        logger.info(
            'Cardcom invoices: enabled document_type=%s',
            status.get('invoice_document_type'),
        )
    terminal = _cardcom_terminal_number()
    if _cardcom_sandbox_mode() and terminal and terminal != CARDCOM_SANDBOX_TERMINAL:
        logger.warning(
            'CARDCOM_SANDBOX=true but terminal %s is not the default test terminal %s',
            terminal,
            CARDCOM_SANDBOX_TERMINAL,
        )


def _cardcom_enabled() -> bool:
    if str(os.environ.get('CARDCOM_ENABLED') or 'true').lower() in ('0', 'false', 'no'):
        return False
    if _simulation_mode():
        return True
    return bool(_cardcom_terminal_number() and _cardcom_api_name())


def _cardcom_terminal_number():
    raw = os.environ.get('CARDCOM_TERMINAL_NUMBER') or ''
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return None


def _cardcom_api_name():
    return str(os.environ.get('CARDCOM_API_NAME') or '').strip()


def _cardcom_api_password():
    return str(os.environ.get('CARDCOM_API_PASSWORD') or '').strip()


def _cardcom_auth_fields() -> dict:
    """TerminalNumber + ApiName (+ ApiPassword when configured)."""
    fields: Dict[str, Any] = {
        'TerminalNumber': _cardcom_terminal_number(),
        'ApiName': _cardcom_api_name(),
    }
    pwd = _cardcom_api_password()
    if pwd:
        fields['ApiPassword'] = pwd
    return fields


def _cardcom_auth_error_message(exc: Exception) -> Optional[str]:
    msg = str(exc or '').strip()
    if not msg:
        return None
    needles = (
        'שם משתמש',
        'סיסמה',
        'username',
        'password',
        'unauthorized',
        'authentication',
    )
    lower = msg.lower()
    if any(n in msg or n in lower for n in needles):
        return (
            'Cardcom rejected the API credentials. In Koyeb, verify CARDCOM_TERMINAL_NUMBER, '
            'CARDCOM_API_NAME, and CARDCOM_API_PASSWORD match the API user Cardcom issued '
            'for that terminal (merchant portal → API / interfaces).'
        )
    return None


def checkout_provider_for_locale(locale: str) -> str:
    """Cardcom for Hebrew/ILS; Stripe for English/USD."""
    if not _cardcom_enabled():
        return 'stripe'
    loc = str(locale or '').strip().lower()
    if loc.startswith('en'):
        return 'stripe'
    return 'cardcom'


def _new_order_id() -> str:
    return f"qs_cc_{uuid.uuid4().hex}"


def _new_low_profile_id() -> str:
    return str(uuid.uuid4())


def _utc_now_iso() -> str:
    return datetime.utcnow().isoformat() + 'Z'


def _use_memory_store() -> bool:
    if _simulation_mode():
        return True
    global _cardcom_db_available
    if _cardcom_db_available is False:
        return True
    return False


def _mark_db_unavailable() -> None:
    global _cardcom_db_available
    _cardcom_db_available = False
    logger.warning(
        'cardcom_credit_purchases table unavailable — using in-memory store for this process'
    )


def _supabase_deps():
    import siteapp as sa
    return sa._supabase_rest_config()


def _cardcom_purchase_get(order_id: str) -> Optional[dict]:
    order_id = str(order_id or '').strip()
    if not order_id:
        return None
    if order_id in _cardcom_memory_store:
        return dict(_cardcom_memory_store[order_id])
    if _use_memory_store():
        return None
    try:
        supabase_url, _service_key, headers = _supabase_deps()
        oid = quote(order_id, safe='')
        r = requests.get(
            f"{supabase_url}/rest/v1/cardcom_credit_purchases?order_id=eq.{oid}&select=*&limit=1",
            headers=headers,
            timeout=12,
        )
        if r.status_code == 404 or (
            r.status_code == 400 and 'cardcom_credit_purchases' in (r.text or '')
        ):
            _mark_db_unavailable()
            return _cardcom_memory_store.get(order_id)
        if r.status_code != 200:
            raise RuntimeError(r.text or f"Supabase cardcom lookup HTTP {r.status_code}")
        rows = r.json() if r.text else []
        global _cardcom_db_available
        _cardcom_db_available = True
        return rows[0] if rows else None
    except Exception as e:
        logger.warning('cardcom purchase get failed, trying memory: %s', e)
        return _cardcom_memory_store.get(order_id)


def _cardcom_purchase_get_by_low_profile(low_profile_id: str) -> Optional[dict]:
    low_profile_id = str(low_profile_id or '').strip()
    if not low_profile_id:
        return None
    for row in _cardcom_memory_store.values():
        if str(row.get('low_profile_id') or '') == low_profile_id:
            return dict(row)
    if _use_memory_store():
        return None
    try:
        supabase_url, _service_key, headers = _supabase_deps()
        lid = quote(low_profile_id, safe='')
        r = requests.get(
            f"{supabase_url}/rest/v1/cardcom_credit_purchases"
            f"?low_profile_id=eq.{lid}&select=*&limit=1",
            headers=headers,
            timeout=12,
        )
        if r.status_code != 200:
            if r.status_code in (400, 404):
                _mark_db_unavailable()
                return None
            raise RuntimeError(r.text or f"Supabase cardcom lookup HTTP {r.status_code}")
        rows = r.json() if r.text else []
        return rows[0] if rows else None
    except Exception as e:
        logger.warning('cardcom purchase get by low_profile failed: %s', e)
        return None


def _cardcom_purchase_insert(row: dict) -> Optional[dict]:
    order_id = str(row.get('order_id') or '').strip()
    if order_id:
        _cardcom_memory_store[order_id] = dict(row)
    if _use_memory_store():
        return _cardcom_memory_store.get(order_id)
    try:
        supabase_url, _service_key, headers = _supabase_deps()
        r = requests.post(
            f"{supabase_url}/rest/v1/cardcom_credit_purchases",
            headers={**headers, 'Prefer': 'return=representation'},
            json=row,
            timeout=15,
        )
        if r.status_code == 409:
            return _cardcom_purchase_get(order_id)
        if r.status_code in (400, 404) and 'cardcom_credit_purchases' in (r.text or ''):
            _mark_db_unavailable()
            return _cardcom_memory_store.get(order_id)
        if r.status_code not in (200, 201):
            raise RuntimeError(r.text or f"Supabase cardcom insert HTTP {r.status_code}")
        global _cardcom_db_available
        _cardcom_db_available = True
        rows = r.json() if r.text else []
        out = rows[0] if rows else row
        if order_id:
            _cardcom_memory_store[order_id] = dict(out)
        return out
    except Exception as e:
        logger.warning('cardcom purchase insert failed, using memory: %s', e)
        _mark_db_unavailable()
        return _cardcom_memory_store.get(order_id)


def _cardcom_purchase_update(order_id: str, patch: dict) -> None:
    order_id = str(order_id or '').strip()
    if not order_id:
        return
    if order_id in _cardcom_memory_store:
        _cardcom_memory_store[order_id].update(patch)
    if _use_memory_store():
        return
    try:
        supabase_url, _service_key, headers = _supabase_deps()
        oid = quote(order_id, safe='')
        r = requests.patch(
            f"{supabase_url}/rest/v1/cardcom_credit_purchases?order_id=eq.{oid}",
            headers={**headers, 'Prefer': 'return=representation'},
            json=patch,
            timeout=15,
        )
        if r.status_code in (400, 404) and 'cardcom_credit_purchases' in (r.text or ''):
            _mark_db_unavailable()
            return
        if r.status_code not in (200, 204):
            raise RuntimeError(r.text or f"Supabase cardcom patch HTTP {r.status_code}")
        if order_id in _cardcom_memory_store:
            _cardcom_memory_store[order_id].update(patch)
    except Exception as e:
        logger.warning('cardcom purchase update failed: %s', e)
        _mark_db_unavailable()


def _cardcom_api_post(path: str, payload: dict) -> dict:
    url = f"{CARDCOM_API_BASE}/{path.lstrip('/')}"
    r = requests.post(url, json=payload, timeout=30)
    try:
        data = r.json() if r.text else {}
    except ValueError:
        data = {}
    if r.status_code >= 400:
        raise RuntimeError(data.get('Description') or r.text or f"Cardcom HTTP {r.status_code}")
    if isinstance(data, dict) and data.get('ResponseCode') not in (None, 0, '0'):
        raise RuntimeError(str(data.get('Description') or f"Cardcom error {data.get('ResponseCode')}"))
    return data if isinstance(data, dict) else {}


def _public_base(req) -> str:
    import siteapp as sa
    return str(sa._public_base_url(req) or '').rstrip('/')


def _cardcom_bearer_token(req) -> str:
    auth_header = req.headers.get('Authorization') or ''
    if auth_header.startswith('Bearer '):
        return auth_header.replace('Bearer ', '', 1).strip()
    try:
        body = req.get_json(silent=True) or {}
        return str(body.get('access_token') or '').strip()
    except Exception:
        return ''


def _cardcom_parse_supabase_user(user_data: dict) -> Optional[dict]:
    if not isinstance(user_data, dict):
        return None
    user_id = str(user_data.get('id') or user_data.get('user', {}).get('id') or '').strip()
    if not user_id:
        return None
    email = str(user_data.get('email') or '').strip()
    meta = user_data.get('user_metadata') or {}
    if not isinstance(meta, dict):
        meta = {}
    name = str(
        meta.get('full_name')
        or meta.get('name')
        or user_data.get('name')
        or ''
    ).strip()
    if not name and email and '@' in email:
        name = email.split('@', 1)[0]
    return {'user_id': user_id, 'email': email, 'name': name}


def _cardcom_authenticated_user(req) -> Optional[dict]:
    """Single Supabase auth round-trip: user id + invoice contact fields."""
    token = _cardcom_bearer_token(req)
    if not token:
        return None
    try:
        supabase_url, service_key, _headers = _supabase_deps()
    except RuntimeError:
        return None
    if not supabase_url or not service_key:
        return None
    try:
        r_user = requests.get(
            f"{supabase_url.rstrip('/')}/auth/v1/user",
            headers={'Authorization': f'Bearer {token}', 'apikey': service_key},
            timeout=8,
        )
        if r_user.status_code != 200:
            return None
        return _cardcom_parse_supabase_user(r_user.json() if r_user.text else {})
    except Exception as e:
        logger.warning('cardcom auth lookup failed: %s', e)
        return None


def _cardcom_user_contact_from_request(req) -> dict:
    user = _cardcom_authenticated_user(req) or {}
    return {
        'email': user.get('email') or '',
        'name': user.get('name') or '',
    }


def _cardcom_invoice_line_description(bundle: dict, is_he: bool) -> str:
    minutes = int(bundle.get('credit_minutes') or 0)
    if is_he:
        return f'חבילת קרדיט QuickScribe — {minutes} דקות תמלול'
    return f'QuickScribe credit bundle — {minutes} transcription minutes'


def _cardcom_normalize_tax_id(raw: str) -> str:
    return ''.join(ch for ch in str(raw or '') if ch.isdigit())[:9]


def _cardcom_resolve_invoice_billing(user_id: str, billing: Optional[dict]) -> dict:
    """Request body first, then saved user profile in Supabase."""
    billing = billing if isinstance(billing, dict) else {}
    tax_id = _cardcom_normalize_tax_id(billing.get('tax_id') or billing.get('invoice_tax_id'))
    city = str(billing.get('city') or billing.get('invoice_city') or '').strip()
    if tax_id and city:
        return {'tax_id': tax_id, 'city': city}
    import siteapp as sa
    stored = sa._user_invoice_billing_get(user_id)
    if stored:
        return {
            'tax_id': _cardcom_normalize_tax_id(stored.get('invoice_tax_id')),
            'city': str(stored.get('invoice_city') or '').strip(),
        }
    return {'tax_id': tax_id, 'city': city}


def _cardcom_persist_invoice_billing(user_id: str, billing: Optional[dict]) -> None:
    import siteapp as sa
    resolved = _cardcom_resolve_invoice_billing(user_id, billing)
    tax_id = resolved.get('tax_id') or ''
    city = resolved.get('city') or ''
    if not tax_id or not city:
        return
    try:
        sa._user_invoice_billing_save(user_id, tax_id, city)
    except Exception as e:
        logger.warning('cardcom invoice billing save failed user=%s: %s', user_id, e)


def _cardcom_validate_invoice_billing(billing: Optional[dict]) -> dict:
    """Cardcom invoice terminals require TaxId (ת.ז./ח.פ.) and City (ישוב)."""
    billing = billing if isinstance(billing, dict) else {}
    tax_id = _cardcom_normalize_tax_id(billing.get('tax_id') or billing.get('invoice_tax_id'))
    city = str(billing.get('city') or billing.get('invoice_city') or '').strip()
    if not tax_id:
        raise ValueError('ת.ז. / ח.פ. נדרשים להפקת חשבונית.')
    if len(tax_id) < 5:
        raise ValueError('מספר ת.ז. / ח.פ. לא תקין.')
    if not city:
        raise ValueError('ישוב (עיר) נדרש להפקת חשבונית.')
    return {'tax_id': tax_id, 'city': city[:100]}


def _cardcom_build_checkout_document(
    bundle: dict,
    bundle_id: str,
    amount_ils: float,
    contact: dict,
    is_he: bool,
    billing: Optional[dict] = None,
) -> dict:
    """Document block for LowProfile/Create (invoice at charge time)."""
    doc: Dict[str, Any] = {
        'DocumentTypeToCreate': _cardcom_invoice_document_type(),
        'Products': [{
            'ProductID': f'qs-{bundle_id}',
            'Description': _cardcom_invoice_line_description(bundle, is_he),
            'Quantity': 1,
            'UnitCost': float(amount_ils),
        }],
    }
    name = str((contact or {}).get('name') or '').strip()
    email = str((contact or {}).get('email') or '').strip()
    if name:
        doc['Name'] = name[:100]
    if email:
        doc['Email'] = email
        if _env_flag('CARDCOM_INVOICE_EMAIL', True) is not False:
            doc['IsSendByEmail'] = True
    ext_id = str((contact or {}).get('external_id') or '').strip()
    if ext_id:
        doc['ExternalId'] = ext_id[:64]
    normalized_billing = _cardcom_validate_invoice_billing(billing)
    doc['TaxId'] = normalized_billing['tax_id']
    doc['City'] = normalized_billing['city']
    if _env_flag('CARDCOM_INVOICE_ALLOW_EDIT', True) is not False:
        doc['IsAllowEditDocument'] = True
    return doc


def _cardcom_extract_document_info(lp_result: dict) -> dict:
    doc = lp_result.get('DocumentInfo') if isinstance(lp_result, dict) else {}
    if not isinstance(doc, dict):
        doc = {}
    tranz = lp_result.get('TranzactionInfo') if isinstance(lp_result, dict) else {}
    if not isinstance(tranz, dict):
        tranz = {}
    invoice_number = doc.get('DocumentNumber')
    if invoice_number is None:
        invoice_number = tranz.get('DocumentNumber')
    invoice_type = doc.get('DocumentType') or tranz.get('DocumentType') or ''
    invoice_url = doc.get('DocumentUrl') or tranz.get('DocumentUrl') or ''
    doc_rc = doc.get('ResponseCode')
    out = {
        'invoice_number': str(invoice_number).strip() if invoice_number is not None else '',
        'invoice_type': str(invoice_type or '').strip(),
        'invoice_url': str(invoice_url or '').strip(),
    }
    if doc_rc is not None and str(doc_rc) not in ('', '0'):
        out['invoice_error'] = str(doc.get('Description') or f'Document ResponseCode {doc_rc}')
    return out


def _cardcom_invoice_fields_for_client(purchase: Optional[dict]) -> dict:
    if not purchase:
        return {}
    out = {}
    for key in ('invoice_number', 'invoice_type', 'invoice_url'):
        val = str(purchase.get(key) or '').strip()
        if val:
            out[key] = val
    return out


def _bundle_for_id(bundle_id: str) -> Optional[dict]:
    import siteapp as sa
    return sa.STRIPE_CREDIT_BUNDLES.get(str(bundle_id or '').strip().lower())


def _cardcom_create_low_profile(
    user: dict,
    bundle_id: str,
    locale: str,
    req,
    invoice_billing: Optional[dict] = None,
) -> dict:
    user_id = str((user or {}).get('user_id') or '').strip()
    if not user_id:
        raise ValueError('Authorization required')
    bundle = _bundle_for_id(bundle_id)
    if not bundle:
        raise ValueError('Unknown credit bundle')
    t0 = time.monotonic()
    order_id = _new_order_id()
    low_profile_id = _new_low_profile_id()
    amount_ils = float(bundle['amount_ils'])
    base = _public_base(req)
    is_he = not str(locale or '').lower().startswith('en')
    success_path = '/' if is_he else '/en'
    sim_token = uuid.uuid4().hex if _simulation_mode() else None
    row = {
        'order_id': order_id,
        'low_profile_id': low_profile_id,
        'user_id': user_id,
        'bundle_id': bundle_id,
        'credit_minutes': int(bundle['credit_minutes']),
        'amount_ils': amount_ils,
        'status': 'pending',
        'created_at': _utc_now_iso(),
    }
    if sim_token:
        row['sim_token'] = sim_token

    if _simulation_mode():
        _cardcom_purchase_insert(row)
        sim_q = f"order_id={quote(order_id, safe='')}&sim_token={quote(sim_token or '', safe='')}"
        sim_url = f"{base}/cardcom/sim-checkout?{sim_q}"
        logger.info('cardcom simulation checkout order=%s bundle=%s', order_id, bundle_id)
        return {
            'url': sim_url,
            'order_id': order_id,
            'low_profile_id': low_profile_id,
            'simulation': True,
        }

    payload = {
        **_cardcom_auth_fields(),
        'Operation': 'ChargeOnly',
        'ReturnValue': order_id,
        'Amount': amount_ils,
        'ISOCoinId': 1,
        'Language': 'he' if is_he else 'en',
        'ProductName': str(bundle['name'])[:50],
        'WebHookUrl': f"{base}/api/cardcom/webhook",
        'SuccessRedirectUrl': f"{base}{success_path}?cardcom_success=1&order_id={quote(order_id, safe='')}",
        'FailedRedirectUrl': f"{base}{success_path}?cardcom_cancelled=1",
    }
    if _cardcom_invoices_enabled():
        resolved_billing = _cardcom_resolve_invoice_billing(user_id, invoice_billing)
        _cardcom_persist_invoice_billing(user_id, resolved_billing)
        contact = {
            'email': user.get('email') or '',
            'name': user.get('name') or '',
            'external_id': order_id,
        }
        payload['Document'] = _cardcom_build_checkout_document(
            bundle, bundle_id, amount_ils, contact, is_he, resolved_billing,
        )
        logger.info('cardcom invoice document order=%s type=%s', order_id, _cardcom_invoice_document_type())
    t_cardcom = time.monotonic()
    resp = _cardcom_api_post('LowProfile/Create', payload)
    cardcom_ms = int((time.monotonic() - t_cardcom) * 1000)
    api_low = str(resp.get('LowProfileId') or low_profile_id).strip()
    pay_url = str(resp.get('Url') or '').strip()
    if not pay_url:
        raise RuntimeError('Cardcom did not return payment URL')
    row['low_profile_id'] = api_low
    t_db = time.monotonic()
    _cardcom_purchase_insert(row)
    db_ms = int((time.monotonic() - t_db) * 1000)
    total_ms = int((time.monotonic() - t0) * 1000)
    logger.info(
        'cardcom checkout ready order=%s cardcom_ms=%s db_ms=%s total_ms=%s invoices=%s',
        order_id, cardcom_ms, db_ms, total_ms, _cardcom_invoices_enabled(),
    )
    return {
        'url': pay_url,
        'order_id': order_id,
        'low_profile_id': api_low,
        'simulation': False,
        'sandbox': _cardcom_sandbox_mode(),
    }


def _cardcom_get_lp_result(low_profile_id: str) -> dict:
    return _cardcom_api_post('LowProfile/GetLpResult', {
        **_cardcom_auth_fields(),
        'LowProfileId': low_profile_id,
    })


def _cardcom_low_profile_from_mapping(data: Optional[dict]) -> str:
    if not isinstance(data, dict):
        return ''
    for key in (
        'LowProfileId',
        'LowProfileCode',
        'lowprofilecode',
        'low_profile_id',
        'lowProfileCode',
    ):
        val = str(data.get(key) or '').strip()
        if val:
            return val
    return ''


def _cardcom_purchase_already_settled(purchase: Optional[dict]) -> bool:
    if not purchase:
        return False
    if purchase.get('credited_at'):
        return True
    return str(purchase.get('status') or '').strip().lower() == 'paid'


def _cardcom_already_credited_result(order_id: str, purchase: dict) -> dict:
    import siteapp as sa
    row = sa._user_credits_get(purchase['user_id'])
    return {
        'ok': True,
        'already_credited': True,
        'added_minutes': 0,
        'order_id': order_id,
        'credit_minutes': int((row or {}).get('credit_minutes') or 0),
        **_cardcom_invoice_fields_for_client(purchase),
    }


def _cardcom_verify_and_credit(order_id: str, low_profile_id: Optional[str] = None) -> dict:
    import siteapp as sa

    order_id = str(order_id or '').strip()
    purchase = _cardcom_purchase_get(order_id)
    if not purchase and low_profile_id:
        purchase = _cardcom_purchase_get_by_low_profile(low_profile_id)
        if purchase:
            order_id = str(purchase.get('order_id') or order_id)
    if not purchase:
        raise ValueError('Unknown order')

    if _cardcom_purchase_already_settled(purchase):
        return _cardcom_already_credited_result(order_id, purchase)

    lp_id = str(low_profile_id or purchase.get('low_profile_id') or '').strip()
    user_id = str(purchase.get('user_id') or '').strip()
    bundle_id = str(purchase.get('bundle_id') or '').strip().lower()
    bundle = _bundle_for_id(bundle_id)
    minutes = int(purchase.get('credit_minutes') or (bundle or {}).get('credit_minutes') or 0)

    if _simulation_mode():
        tranz_id = purchase.get('tranzaction_id') or int(uuid.uuid4().int % 10_000_000_000)
        _cardcom_purchase_update(order_id, {
            'status': 'paid',
            'tranzaction_id': tranz_id,
            'credited_at': _utc_now_iso(),
        })
        row = sa._user_credits_add_minutes(user_id, minutes)
        return {
            'ok': True,
            'already_credited': False,
            'added_minutes': minutes,
            'order_id': order_id,
            'credit_minutes': int((row or {}).get('credit_minutes') or 0),
            'simulation': True,
        }

    if not lp_id:
        raise ValueError('Missing LowProfileId')

    try:
        result = _cardcom_get_lp_result(lp_id)
    except (RuntimeError, ValueError) as e:
        purchase_retry = _cardcom_purchase_get(order_id)
        if _cardcom_purchase_already_settled(purchase_retry):
            return _cardcom_already_credited_result(order_id, purchase_retry)
        raise ValueError(str(e)) from e

    top_rc = int(result.get('ResponseCode') if result.get('ResponseCode') is not None else -1)
    if top_rc != 0:
        purchase_retry = _cardcom_purchase_get(order_id)
        if _cardcom_purchase_already_settled(purchase_retry):
            return _cardcom_already_credited_result(order_id, purchase_retry)
        _cardcom_purchase_update(order_id, {'status': 'failed'})
        raise ValueError(str(result.get('Description') or 'Cardcom payment not successful'))

    return_value = str(result.get('ReturnValue') or '').strip()
    if return_value and return_value != order_id:
        raise ValueError('ReturnValue mismatch')

    tranz_info = result.get('TranzactionInfo') or {}
    nested_rc = (
        int(tranz_info.get('ResponseCode') or 0)
        if isinstance(tranz_info, dict) else 0
    )
    # Top-level ResponseCode=0 is authoritative; nested J2/J5 codes can differ in sandbox.
    if nested_rc != 0 and top_rc != 0:
        _cardcom_purchase_update(order_id, {'status': 'failed'})
        raise ValueError(str(tranz_info.get('Description') or 'Transaction failed'))
    if nested_rc != 0 and top_rc == 0:
        logger.info(
            'cardcom nested TranzactionInfo ResponseCode=%s with top-level ok order=%s',
            nested_rc, order_id,
        )

    try:
        paid_amount = float(tranz_info.get('Amount') if isinstance(tranz_info, dict) else 0)
    except (TypeError, ValueError):
        paid_amount = 0.0
    expected = float(purchase.get('amount_ils') or 0)
    if expected > 0 and paid_amount > 0 and abs(paid_amount - expected) > 0.02:
        logger.warning(
            'cardcom amount mismatch order=%s expected=%s paid=%s',
            order_id, expected, paid_amount,
        )

    tranz_id = result.get('TranzactionId')
    if isinstance(tranz_info, dict) and tranz_info.get('TranzactionId'):
        tranz_id = tranz_info.get('TranzactionId')

    invoice_patch = _cardcom_extract_document_info(result)
    if invoice_patch.get('invoice_error'):
        logger.warning(
            'cardcom invoice not issued order=%s: %s',
            order_id,
            invoice_patch.pop('invoice_error'),
        )
    _cardcom_purchase_update(order_id, {
        'status': 'paid',
        'tranzaction_id': tranz_id,
        'credited_at': _utc_now_iso(),
        **{k: v for k, v in invoice_patch.items() if v},
    })
    row = sa._user_credits_add_minutes(user_id, minutes)
    purchase_after = _cardcom_purchase_get(order_id) or purchase
    return {
        'ok': True,
        'already_credited': False,
        'added_minutes': minutes,
        'order_id': order_id,
        'credit_minutes': int((row or {}).get('credit_minutes') or 0),
        **_cardcom_invoice_fields_for_client(purchase_after),
    }


def register_cardcom_routes(app: Flask) -> None:
    """Register Cardcom payment routes on the Flask app."""
    _log_cardcom_startup()

    @app.route('/api/cardcom/status', methods=['GET'])
    def api_cardcom_status():
        """Public-safe Cardcom mode (internal sim vs sandbox vs live)."""
        return jsonify(cardcom_runtime_status()), 200

    @app.route('/api/cardcom/create-payment', methods=['POST'])
    def api_cardcom_create_payment():
        try:
            if not _cardcom_enabled():
                return jsonify({'error': 'Cardcom payments are not configured'}), 503
            user = _cardcom_authenticated_user(request)
            if not user:
                return jsonify({'error': 'Authorization required'}), 401
            data = request.get_json(silent=True) or {}
            bundle_id = str(data.get('bundle') or data.get('bundle_id') or 'standard').strip().lower()
            locale = str(data.get('locale') or '').strip().lower()
            invoice_billing = {
                'tax_id': data.get('invoice_tax_id') or data.get('tax_id'),
                'city': data.get('invoice_city') or data.get('city'),
            }
            out = _cardcom_create_low_profile(
                user, bundle_id, locale, request, invoice_billing=invoice_billing,
            )
            return jsonify(out), 200
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        except RuntimeError as e:
            auth_msg = _cardcom_auth_error_message(e)
            if auth_msg:
                logger.error('api_cardcom_create_payment auth failed: %s', e)
                return jsonify({'error': auth_msg, 'cardcom': str(e)}), 401
            logger.exception('api_cardcom_create_payment cardcom error')
            return jsonify({'error': str(e)}), 502
        except Exception as e:
            logger.exception('api_cardcom_create_payment failed')
            return jsonify({'error': str(e)}), 500

    @app.route('/api/cardcom/webhook', methods=['POST'])
    def api_cardcom_webhook():
        """Cardcom server-to-server callback — always verify via GetLpResult."""
        try:
            data = request.get_json(silent=True) or {}
            if not data and request.form:
                data = request.form.to_dict()
            low_profile_id = _cardcom_low_profile_from_mapping(data)
            order_id = str(data.get('ReturnValue') or data.get('return_value') or '').strip()
            if not order_id and low_profile_id:
                purchase = _cardcom_purchase_get_by_low_profile(low_profile_id)
                if purchase:
                    order_id = str(purchase.get('order_id') or '')
            if not order_id:
                logger.warning('cardcom webhook missing order id: %s', list(data.keys())[:8])
                return jsonify({'ok': True, 'ignored': True}), 200
            _cardcom_verify_and_credit(order_id, low_profile_id or None)
            return jsonify({'ok': True}), 200
        except ValueError as e:
            logger.info('cardcom webhook not credited: %s', e)
            return jsonify({'ok': True, 'credited': False, 'reason': str(e)}), 200
        except Exception as e:
            logger.exception('api_cardcom_webhook failed')
            return jsonify({'error': str(e)}), 500

    @app.route('/api/cardcom/confirm-payment', methods=['POST'])
    def api_cardcom_confirm_payment():
        """After SuccessRedirectUrl — idempotent wallet credit (webhook may have run first)."""
        import siteapp as sa
        try:
            user_id = sa._supabase_user_id_from_request()
            if not user_id:
                return jsonify({'error': 'Authorization required'}), 401
            data = request.get_json(silent=True) or {}
            order_id = str(data.get('order_id') or data.get('orderId') or '').strip()
            if not order_id:
                return jsonify({'error': 'order_id required'}), 400
            purchase = _cardcom_purchase_get(order_id)
            if not purchase:
                return jsonify({'error': 'Unknown order'}), 404
            if str(purchase.get('user_id') or '') != user_id:
                return jsonify({'error': 'Order does not belong to this user'}), 403
            lp_id = _cardcom_low_profile_from_mapping(data) or str(
                purchase.get('low_profile_id') or ''
            ).strip()
            if lp_id and lp_id != str(purchase.get('low_profile_id') or '').strip():
                _cardcom_purchase_update(order_id, {'low_profile_id': lp_id})
            if _cardcom_purchase_already_settled(purchase):
                return jsonify(_cardcom_already_credited_result(order_id, purchase)), 200
            result = _cardcom_verify_and_credit(order_id, lp_id or None)
            return jsonify(result), 200
        except ValueError as e:
            purchase = _cardcom_purchase_get(
                str((request.get_json(silent=True) or {}).get('order_id') or '').strip()
            )
            if purchase and _cardcom_purchase_already_settled(purchase):
                return jsonify(_cardcom_already_credited_result(
                    str(purchase.get('order_id') or ''), purchase
                )), 200
            return jsonify({'error': str(e)}), 400
        except Exception as e:
            logger.exception('api_cardcom_confirm_payment failed')
            return jsonify({'error': str(e)}), 500

    @app.route('/api/cardcom/sim-complete', methods=['POST'])
    def api_cardcom_sim_complete():
        """Simulation only: complete payment without Cardcom."""
        import siteapp as sa
        if not _simulation_mode():
            return jsonify({'error': 'Simulation endpoint disabled'}), 404
        try:
            data = request.get_json(silent=True) or {}
            order_id = str(data.get('order_id') or '').strip()
            sim_token = str(data.get('sim_token') or '').strip()
            if not order_id:
                return jsonify({'error': 'order_id required'}), 400
            purchase = _cardcom_purchase_get(order_id)
            if not purchase:
                return jsonify({'error': 'Unknown order'}), 404
            expected_token = str(purchase.get('sim_token') or '').strip()
            if not expected_token or sim_token != expected_token:
                user_id = sa._supabase_user_id_from_request()
                if not user_id or str(purchase.get('user_id') or '') != user_id:
                    return jsonify({'error': 'Invalid simulation token or authorization'}), 403
            result = _cardcom_verify_and_credit(order_id)
            return jsonify(result), 200
        except Exception as e:
            logger.exception('api_cardcom_sim_complete failed')
            return jsonify({'error': str(e)}), 500

    @app.route('/cardcom/sim-checkout')
    def cardcom_sim_checkout_page():
        """Simulation checkout UI (SIMULATION_MODE)."""
        if not _simulation_mode():
            return 'Cardcom simulation checkout is only available in simulation mode.', 404
        order_id = str(request.args.get('order_id') or '').strip()
        sim_token = str(request.args.get('sim_token') or '').strip()
        purchase = _cardcom_purchase_get(order_id) if order_id else None
        if not purchase:
            return (
                '<!DOCTYPE html><html lang="he" dir="rtl"><body>'
                '<p>הזמנה לא נמצאה. חזור לאתר ונסה שוב.</p>'
                '<p><a href="/">חזרה ל-QuickScribe</a></p></body></html>',
                404,
                {'Content-Type': 'text/html; charset=utf-8'},
            )
        bundle = _bundle_for_id(str(purchase.get('bundle_id') or ''))
        amount = purchase.get('amount_ils')
        minutes = purchase.get('credit_minutes')
        name = (bundle or {}).get('name', 'Credit bundle')
        if sim_token and str(purchase.get('sim_token') or '') != sim_token:
            return 'Invalid simulation token.', 403
        html = f"""<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>סימולציית תשלום Cardcom</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 420px; margin: 48px auto; padding: 0 16px; line-height: 1.5; }}
    h1 {{ font-size: 1.25rem; color: #0f766e; }}
    .box {{ border: 1px solid #99f6e4; border-radius: 12px; padding: 16px; background: #f0fdfa; }}
    button {{ margin-top: 12px; padding: 10px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 1rem; }}
    .pay {{ background: #0f766e; color: #fff; width: 100%; }}
    .cancel {{ background: #e2e8f0; color: #334155; width: 100%; }}
    .note {{ color: #64748b; font-size: 0.9rem; margin-top: 16px; }}
  </style>
</head>
<body>
  <h1>סימולציית תשלום (Cardcom)</h1>
  <div class="box">
    <p><strong>{name}</strong></p>
    <p>{minutes} דקות תמלול · ₪{amount}</p>
    <p class="note">מצב סימולציה — ללא חיוב אמיתי. לחץ «שלם» כדי לזכות את הארנק.</p>
    <button type="button" class="pay" id="pay-btn">שלם (סימולציה)</button>
    <button type="button" class="cancel" id="cancel-btn">ביטול</button>
  </div>
  <script>
    const orderId = {order_id!r};
    const simToken = {sim_token!r};
    document.getElementById('pay-btn').onclick = async () => {{
      const res = await fetch('/api/cardcom/sim-complete', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ order_id: orderId, sim_token: simToken }}),
        credentials: 'same-origin'
      }});
      const data = await res.json().catch(() => ({{}}));
      if (!res.ok) {{ alert(data.error || 'שגיאה'); return; }}
      window.location.href = '/?cardcom_success=1&order_id=' + encodeURIComponent(orderId);
    }};
    document.getElementById('cancel-btn').onclick = () => {{
      window.location.href = '/?cardcom_cancelled=1';
    }};
  </script>
</body>
</html>"""
        return html, 200, {'Content-Type': 'text/html; charset=utf-8'}
