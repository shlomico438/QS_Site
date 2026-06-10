"""Cardcom Low Profile redirect checkout for ILS credit bundles.

Simulation (SIMULATION_MODE=true): internal /cardcom/sim-checkout page — no Cardcom API or webhook.
Production/sandbox: POST LowProfile/Create → redirect → WebHook → GetLpResult → credit wallet.
"""
from __future__ import annotations

import logging
import os
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


def _bundle_for_id(bundle_id: str) -> Optional[dict]:
    import siteapp as sa
    return sa.STRIPE_CREDIT_BUNDLES.get(str(bundle_id or '').strip().lower())


def _cardcom_create_low_profile(user_id: str, bundle_id: str, locale: str, req) -> dict:
    bundle = _bundle_for_id(bundle_id)
    if not bundle:
        raise ValueError('Unknown credit bundle')
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
    _cardcom_purchase_insert(row)

    if _simulation_mode():
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
        'TerminalNumber': _cardcom_terminal_number(),
        'ApiName': _cardcom_api_name(),
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
    resp = _cardcom_api_post('LowProfile/Create', payload)
    api_low = str(resp.get('LowProfileId') or low_profile_id).strip()
    pay_url = str(resp.get('Url') or '').strip()
    if not pay_url:
        raise RuntimeError('Cardcom did not return payment URL')
    _cardcom_purchase_update(order_id, {'low_profile_id': api_low})
    return {
        'url': pay_url,
        'order_id': order_id,
        'low_profile_id': api_low,
        'simulation': False,
        'sandbox': _cardcom_sandbox_mode(),
    }


def _cardcom_get_lp_result(low_profile_id: str) -> dict:
    return _cardcom_api_post('LowProfile/GetLpResult', {
        'TerminalNumber': _cardcom_terminal_number(),
        'ApiName': _cardcom_api_name(),
        'LowProfileId': low_profile_id,
    })


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

    if purchase.get('credited_at'):
        row = sa._user_credits_get(purchase['user_id'])
        return {
            'ok': True,
            'already_credited': True,
            'order_id': order_id,
            'credit_minutes': int((row or {}).get('credit_minutes') or 0),
        }

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

    result = _cardcom_get_lp_result(lp_id)
    if int(result.get('ResponseCode') or -1) != 0:
        _cardcom_purchase_update(order_id, {'status': 'failed'})
        raise ValueError(str(result.get('Description') or 'Cardcom payment not successful'))

    return_value = str(result.get('ReturnValue') or '').strip()
    if return_value and return_value != order_id:
        raise ValueError('ReturnValue mismatch')

    tranz_info = result.get('TranzactionInfo') or {}
    if isinstance(tranz_info, dict) and int(tranz_info.get('ResponseCode') or 0) != 0:
        _cardcom_purchase_update(order_id, {'status': 'failed'})
        raise ValueError(str(tranz_info.get('Description') or 'Transaction failed'))

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
        import siteapp as sa
        try:
            if not _cardcom_enabled():
                return jsonify({'error': 'Cardcom payments are not configured'}), 503
            user_id = sa._supabase_user_id_from_request()
            if not user_id:
                return jsonify({'error': 'Authorization required'}), 401
            data = request.get_json(silent=True) or {}
            bundle_id = str(data.get('bundle') or data.get('bundle_id') or 'standard').strip().lower()
            locale = str(data.get('locale') or '').strip().lower()
            out = _cardcom_create_low_profile(user_id, bundle_id, locale, request)
            return jsonify(out), 200
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
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
            low_profile_id = str(
                data.get('LowProfileId') or data.get('low_profile_id') or ''
            ).strip()
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
            result = _cardcom_verify_and_credit(
                order_id,
                str(purchase.get('low_profile_id') or '').strip() or None,
            )
            return jsonify(result), 200
        except ValueError as e:
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
