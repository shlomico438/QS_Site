/**
 * Lightweight auth shell: open the sign-in/register modal before app_logic.js finishes.
 * Full Google / magic-link handlers still come from app_logic; this only paints the UI early.
 */
(function () {
    'use strict';

    if (window.__QS_AUTH_SHELL) return;
    window.__QS_AUTH_SHELL = true;
    window.__QS_APP_LOGIC_READY = false;

    function qsAuthModalEl() {
        return document.getElementById('auth-modal');
    }

    /** Minimal open/close — replaced by app_logic's richer toggleModal when it loads. */
    window.toggleModal = function (show) {
        const modal = qsAuthModalEl();
        if (!modal) return;
        if (show) {
            // Medical: ignore auto-open until the user explicitly opens auth.
            if (
                (window.__QS_SKIP_INITIAL_REG_PROMPT === true || window.__QS_MEDICAL_URL_ENTRY === true)
                && window.__QS_AUTH_MODAL_USER_OPENED !== true
            ) {
                return;
            }
            try { document.body.appendChild(modal); } catch (_) {}
            modal.style.zIndex = '14000';
            modal.style.display = 'flex';
            modal.setAttribute('aria-hidden', 'false');
        } else {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
    };

    function qsWireEarlySignInButtons() {
        ['nav-auth-btn', 'nav-auth-btn-mobile'].forEach(function (id) {
            const btn = document.getElementById(id);
            if (!btn) return;
            // onclick so setupNavbarAuth can replace it later without double-firing.
            btn.onclick = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                window.__QS_AUTH_MODAL_USER_OPENED = true;
                if (typeof window.toggleModal === 'function') window.toggleModal(true);
            };
        });
    }

    function qsWhenAppLogicReady(fn) {
        if (window.__QS_APP_LOGIC_READY) {
            try { fn(); } catch (_) {}
            return;
        }
        window.addEventListener('qs-app-logic-ready', function onReady() {
            try { fn(); } catch (_) {}
        }, { once: true });
    }

    /** If guest taps Google / magic-link before app_logic is ready, wait then retry. */
    function qsGateAuthActionsUntilAppReady() {
        document.addEventListener('click', function (e) {
            if (window.__QS_APP_LOGIC_READY) return;
            const target = e.target && e.target.closest
                ? e.target.closest('#google-login, #auth-submit-btn')
                : null;
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();
            if (target._qsAuthWait) return;
            target._qsAuthWait = true;
            const prev = target.getAttribute('data-i18n')
                ? target.textContent
                : target.textContent;
            const busy = (document.documentElement.lang || '').toLowerCase().startsWith('he')
                ? 'טוען…'
                : 'Loading…';
            target.setAttribute('aria-busy', 'true');
            target.dataset.qsPrevLabel = prev;
            target.textContent = busy;
            qsWhenAppLogicReady(function () {
                target._qsAuthWait = false;
                target.removeAttribute('aria-busy');
                if (target.dataset.qsPrevLabel) {
                    target.textContent = target.dataset.qsPrevLabel;
                    delete target.dataset.qsPrevLabel;
                }
                try { target.click(); } catch (_) {}
            });
        }, true);
    }

    function qsRefreshOpenModalAfterAppReady() {
        qsWhenAppLogicReady(function () {
            const modal = qsAuthModalEl();
            if (!modal) return;
            const open = String(modal.style.display || '').toLowerCase() === 'flex'
                || modal.classList.contains('is-open');
            if (open && window.__QS_AUTH_MODAL_USER_OPENED && typeof window.toggleModal === 'function') {
                // Re-run full open path (medical fields, i18n mode, snapshot).
                window.toggleModal(true);
            } else if (open && !window.__QS_AUTH_MODAL_USER_OPENED && window.__QS_SKIP_INITIAL_REG_PROMPT) {
                window.toggleModal(false);
            }
        });
    }

    function boot() {
        qsWireEarlySignInButtons();
        qsGateAuthActionsUntilAppReady();
        qsRefreshOpenModalAfterAppReady();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
