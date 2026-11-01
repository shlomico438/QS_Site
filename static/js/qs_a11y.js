/**
 * Lightweight dialog / focus helpers for IS 5568 / WCAG 2.1 AA.
 * Prefer native HTML; this fills gaps for existing custom modals.
 */
(function () {
    'use strict';

    const FOCUSABLE =
        'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function qsIsVisible(el) {
        if (!el || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
    }

    function qsFocusableIn(root) {
        if (!root) return [];
        return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
            if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
            if (el.tabIndex < 0 && el.getAttribute('tabindex') !== '0') {
                // tabindex="-1" is intentionally skipped by FOCUSABLE selector except explicit 0
            }
            return qsIsVisible(el);
        });
    }

    function qsDialogPanel(backdrop) {
        if (!backdrop) return null;
        return (
            backdrop.querySelector('[role="dialog"]')
            || backdrop.querySelector('.auth-modal-card')
            || backdrop.querySelector('.seo-sales-modal')
            || backdrop.querySelector('.medical-confirm-modal')
            || backdrop.querySelector('.post-export-feedback-card')
            || backdrop.querySelector('.translation-modal')
            || backdrop
        );
    }

    const openStack = [];

    function qsTrapKeydown(event) {
        if (event.key !== 'Tab' || !openStack.length) return;
        const current = openStack[openStack.length - 1];
        const panel = qsDialogPanel(current.backdrop);
        const nodes = qsFocusableIn(panel);
        if (!nodes.length) {
            event.preventDefault();
            if (panel) panel.focus();
            return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function qsEscapeKeydown(event) {
        if (event.key !== 'Escape' || !openStack.length) return;
        const current = openStack[openStack.length - 1];
        if (typeof current.onEscape === 'function') {
            event.preventDefault();
            current.onEscape();
        }
    }

    function qsEnsureListeners() {
        if (window.__QS_A11Y_KEYS) return;
        window.__QS_A11Y_KEYS = true;
        document.addEventListener('keydown', qsTrapKeydown, true);
        document.addEventListener('keydown', qsEscapeKeydown, true);
    }

    /**
     * Open a dialog backdrop for AT + keyboard.
     * @param {HTMLElement} backdrop
     * @param {{ returnFocus?: HTMLElement|null, focusSelector?: string, onEscape?: Function, display?: string }} opts
     */
    window.qsA11yOpenDialog = function (backdrop, opts) {
        const options = opts || {};
        if (!backdrop) return;
        qsEnsureListeners();
        const returnFocus = options.returnFocus || document.activeElement;
        const panel = qsDialogPanel(backdrop);
        if (panel) {
            if (!panel.hasAttribute('role')) panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        }
        backdrop.hidden = false;
        backdrop.removeAttribute('hidden');
        backdrop.style.display = options.display || 'flex';
        backdrop.setAttribute('aria-hidden', 'false');
        if ('inert' in backdrop) {
            try { backdrop.inert = false; } catch (_) {}
        }
        openStack.push({
            backdrop,
            returnFocus: returnFocus && returnFocus.focus ? returnFocus : null,
            onEscape: options.onEscape || null,
        });
        window.setTimeout(() => {
            const focusRoot = panel || backdrop;
            let target = null;
            if (options.focusSelector) {
                target = focusRoot.querySelector(options.focusSelector);
            }
            if (!target) {
                const nodes = qsFocusableIn(focusRoot);
                target = nodes[0] || focusRoot;
            }
            try { target.focus(); } catch (_) {}
        }, 0);
    };

    window.qsA11yCloseDialog = function (backdrop) {
        if (!backdrop) return;
        let entry = null;
        for (let i = openStack.length - 1; i >= 0; i--) {
            if (openStack[i].backdrop === backdrop) {
                entry = openStack.splice(i, 1)[0];
                break;
            }
        }
        backdrop.setAttribute('aria-hidden', 'true');
        backdrop.style.display = 'none';
        backdrop.hidden = true;
        if ('inert' in backdrop) {
            try { backdrop.inert = true; } catch (_) {}
        }
        const ret = entry && entry.returnFocus;
        if (ret && typeof ret.focus === 'function' && document.contains(ret)) {
            window.setTimeout(() => {
                try { ret.focus(); } catch (_) {}
            }, 0);
        }
    };

    /** Ensure closed backdrops stay inert / hidden from AT. */
    window.qsA11yMarkDialogClosed = function (backdrop) {
        if (!backdrop) return;
        backdrop.setAttribute('aria-hidden', 'true');
        if (backdrop.style.display !== 'none') backdrop.style.display = 'none';
        backdrop.hidden = true;
        if ('inert' in backdrop) {
            try { backdrop.inert = true; } catch (_) {}
        }
    };

    function qsWireRovingTablist(tablist) {
        if (!tablist || tablist.dataset.qsA11yTabs === '1') return;
        tablist.dataset.qsA11yTabs = '1';
        tablist.addEventListener('keydown', (event) => {
            const tabs = Array.from(tablist.querySelectorAll('[role="tab"]')).filter((t) => qsIsVisible(t));
            if (!tabs.length) return;
            const current = document.activeElement;
            const idx = tabs.indexOf(current);
            if (idx < 0) return;
            const rtl = String(document.documentElement.dir || '').toLowerCase() === 'rtl'
                || String(document.documentElement.lang || '').toLowerCase().startsWith('he');
            let next = idx;
            if (event.key === 'ArrowRight') next = rtl ? idx - 1 : idx + 1;
            else if (event.key === 'ArrowLeft') next = rtl ? idx + 1 : idx - 1;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabs.length - 1;
            else return;
            event.preventDefault();
            next = (next + tabs.length) % tabs.length;
            tabs[next].focus();
            tabs[next].click();
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        [
            'auth-modal',
            'post-export-feedback-modal',
            'invoice-billing-modal',
            'sales-contact-modal',
            'medical-pricing-modal',
            'medical-delete-confirm-modal',
            'medical-wake-choice-modal',
            'medical-guest-try-modal',
            'medical-training-modal',
            'medical-mic-test-modal',
            'translation-language-modal',
        ].forEach((id) => {
            const el = document.getElementById(id);
            if (el && (el.style.display === 'none' || el.hidden || el.getAttribute('aria-hidden') === 'true')) {
                window.qsA11yMarkDialogClosed(el);
            }
        });
        document.querySelectorAll('[role="tablist"]').forEach(qsWireRovingTablist);
        const authClose = document.getElementById('auth-modal-close');
        if (authClose) {
            authClose.addEventListener('click', () => {
                if (typeof window.toggleModal === 'function') window.toggleModal(false);
            });
        }
    });
})();
