/**
 * Regular (non-medical) pricing section: prepaid bundle tabs + Cardcom/Stripe checkout.
 * Used on /pricing and anywhere #pricing-section exists without index inline wiring.
 */
(function () {
    'use strict';

    function qsHomeUrl() {
        const isEn = String(window.currentLocale || document.documentElement.lang || 'he')
            .toLowerCase()
            .startsWith('en');
        return isEn ? '/en' : '/';
    }

    function qsMedicalPricingUrl() {
        const isEn = String(window.currentLocale || document.documentElement.lang || 'he')
            .toLowerCase()
            .startsWith('en');
        return isEn ? '/en/medical/pricing' : '/medical/pricing';
    }

    async function getAuthedJsonHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        try {
            if (window.supabase && window.supabase.auth) {
                const { data: { session } } = await window.supabase.auth.getSession();
                if (session && session.access_token) {
                    headers.Authorization = 'Bearer ' + session.access_token;
                }
            }
        } catch (_) {}
        return headers.Authorization ? headers : null;
    }

    function creditCheckoutUsesStripe() {
        const loc = String(window.currentLocale || document.documentElement.lang || 'he').toLowerCase();
        return loc.startsWith('en');
    }

    window.qsInitRegularPricingPage = function qsInitRegularPricingPage(options) {
        if (window.__QS_REGULAR_PRICING_WIRED) return;
        if (!document.getElementById('pricing-section')) return;
        window.__QS_REGULAR_PRICING_WIRED = true;

        const opts = options || {};
        const standalone = opts.standalone === true || !document.getElementById('main-btn');

        const smoothTo = (id) => {
            const target = document.getElementById(id);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            if (id === 'main-btn' && standalone) {
                window.location.href = qsHomeUrl();
            }
        };

        const invoiceBillingStorageKeys = { taxId: 'qs_invoice_tax_id', city: 'qs_invoice_city' };
        const cacheInvoiceBillingLocal = (taxId, city) => {
            try {
                if (taxId) localStorage.setItem(invoiceBillingStorageKeys.taxId, taxId);
                if (city) localStorage.setItem(invoiceBillingStorageKeys.city, city);
            } catch (_) {}
        };

        const fetchServerInvoiceBilling = async (headers) => {
            try {
                const res = await fetch('/api/user/invoice-billing', { headers });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) return null;
                const taxId = String(data.invoice_tax_id || '').replace(/\D/g, '').trim();
                const city = String(data.invoice_city || '').trim();
                if (!taxId || !city) return null;
                return { invoice_tax_id: taxId, invoice_city: city };
            } catch (_) {
                return null;
            }
        };

        const saveServerInvoiceBilling = async (headers, taxId, city) => {
            try {
                await fetch('/api/user/invoice-billing', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        invoice_tax_id: taxId,
                        invoice_city: city,
                    }),
                });
            } catch (_) {}
        };

        let cardcomInvoicesEnabledCache = null;
        const cardcomCheckoutNeedsBilling = async () => {
            if (creditCheckoutUsesStripe()) return false;
            if (cardcomInvoicesEnabledCache !== null) return cardcomInvoicesEnabledCache;
            try {
                const res = await fetch('/api/cardcom/status');
                const data = await res.json().catch(() => ({}));
                cardcomInvoicesEnabledCache = !!data.invoices_enabled;
            } catch (_) {
                cardcomInvoicesEnabledCache = true;
            }
            return cardcomInvoicesEnabledCache;
        };

        const invoiceBillingModal = document.getElementById('invoice-billing-modal');
        const invoiceTaxIdInput = document.getElementById('invoice-tax-id-input');
        const invoiceCityInput = document.getElementById('invoice-city-input');
        const invoiceBillingContinueBtn = document.getElementById('invoice-billing-continue-btn');
        const invoiceBillingCancelBtn = document.getElementById('invoice-billing-cancel-btn');
        const invoiceBillingCloseBtn = document.getElementById('invoice-billing-close');

        const closeInvoiceBillingModal = () => {
            if (!invoiceBillingModal) return;
            invoiceBillingModal.style.display = 'none';
            invoiceBillingModal.setAttribute('aria-hidden', 'true');
        };

        const promptInvoiceBillingIfNeeded = (headers) => new Promise((resolve) => {
            void (async () => {
                if (!(await cardcomCheckoutNeedsBilling())) {
                    resolve({});
                    return;
                }
                const serverBilling = headers ? await fetchServerInvoiceBilling(headers) : null;
                if (serverBilling) {
                    cacheInvoiceBillingLocal(serverBilling.invoice_tax_id, serverBilling.invoice_city);
                    resolve(serverBilling);
                    return;
                }
                let taxId = '';
                let city = '';
                try {
                    taxId = String(localStorage.getItem(invoiceBillingStorageKeys.taxId) || '').replace(/\D/g, '').trim();
                    city = String(localStorage.getItem(invoiceBillingStorageKeys.city) || '').trim();
                } catch (_) {}
                if (taxId && city) {
                    if (headers) await saveServerInvoiceBilling(headers, taxId, city);
                    resolve({ invoice_tax_id: taxId, invoice_city: city });
                    return;
                }
                if (!invoiceBillingModal || !invoiceTaxIdInput || !invoiceCityInput) {
                    resolve({});
                    return;
                }
                invoiceTaxIdInput.value = taxId;
                invoiceCityInput.value = city;
                const cleanup = () => {
                    invoiceBillingContinueBtn && invoiceBillingContinueBtn.removeEventListener('click', onContinue);
                    invoiceBillingCancelBtn && invoiceBillingCancelBtn.removeEventListener('click', onCancel);
                    invoiceBillingCloseBtn && invoiceBillingCloseBtn.removeEventListener('click', onCancel);
                    invoiceBillingModal.removeEventListener('click', onBackdrop);
                };
                const onCancel = () => {
                    cleanup();
                    closeInvoiceBillingModal();
                    resolve(null);
                };
                const onBackdrop = (e) => {
                    if (e.target === invoiceBillingModal) onCancel();
                };
                const onContinue = () => {
                    void (async () => {
                        const T = typeof window.t === 'function' ? window.t : (k) => k;
                        const nextTaxId = String(invoiceTaxIdInput.value || '').replace(/\D/g, '').trim();
                        const nextCity = String(invoiceCityInput.value || '').trim();
                        if (!nextTaxId || nextTaxId.length < 5) {
                            if (typeof showStatus === 'function') {
                                showStatus(T('invoice_billing_tax_invalid') || 'Enter a valid ID / company number.', true, { duration: 4000 });
                            }
                            return;
                        }
                        if (!nextCity) {
                            if (typeof showStatus === 'function') {
                                showStatus(T('invoice_billing_city_required') || 'Enter a city.', true, { duration: 4000 });
                            }
                            return;
                        }
                        cacheInvoiceBillingLocal(nextTaxId, nextCity);
                        if (headers) await saveServerInvoiceBilling(headers, nextTaxId, nextCity);
                        cleanup();
                        closeInvoiceBillingModal();
                        resolve({ invoice_tax_id: nextTaxId, invoice_city: nextCity });
                    })();
                };
                invoiceBillingContinueBtn && invoiceBillingContinueBtn.addEventListener('click', onContinue);
                invoiceBillingCancelBtn && invoiceBillingCancelBtn.addEventListener('click', onCancel);
                invoiceBillingCloseBtn && invoiceBillingCloseBtn.addEventListener('click', onCancel);
                invoiceBillingModal.addEventListener('click', onBackdrop);
                invoiceBillingModal.style.display = 'flex';
                invoiceBillingModal.setAttribute('aria-hidden', 'false');
                setTimeout(() => { try { invoiceTaxIdInput.focus(); } catch (_) {} }, 50);
            })();
        });

        const startCreditCheckout = async (bundleId, sourceBtn) => {
            const T = typeof window.t === 'function' ? window.t : function (k) { return k; };
            const isHe = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
            const checkoutWaitMsg = isHe ? 'מעביר לדף התשלום…' : 'Opening secure checkout…';
            const headers = await getAuthedJsonHeaders();
            if (!headers) {
                if (typeof showStatus === 'function') {
                    showStatus(T('sign_in_to_save') || 'Sign in to continue.', true, { duration: 4500 });
                }
                try { if (typeof window.toggleModal === 'function') window.toggleModal(true); } catch (_) {}
                return;
            }
            const billing = await promptInvoiceBillingIfNeeded(headers);
            if (billing === null) return;
            const locale = (window.currentLocale || document.documentElement.lang || 'he');
            const useStripe = creditCheckoutUsesStripe();
            const endpoint = useStripe
                ? '/api/stripe/create-checkout-session'
                : '/api/cardcom/create-payment';
            const btnLabel = sourceBtn ? sourceBtn.textContent : '';
            if (sourceBtn) {
                sourceBtn.disabled = true;
                sourceBtn.setAttribute('aria-busy', 'true');
                sourceBtn.textContent = checkoutWaitMsg;
            }
            if (typeof showStatus === 'function') {
                showStatus(checkoutWaitMsg, false, { duration: 120000 });
            }
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        bundle: bundleId || 'standard',
                        locale: locale,
                        ...(billing || {}),
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.url) throw new Error(data.error || 'checkout failed');
                window.location.assign(data.url);
            } catch (err) {
                if (typeof showStatus === 'function') {
                    showStatus((err && err.message) || 'Could not start checkout.', true, { duration: 6000 });
                }
                if (sourceBtn) {
                    sourceBtn.disabled = false;
                    sourceBtn.removeAttribute('aria-busy');
                    if (btnLabel) sourceBtn.textContent = btnLabel;
                }
            }
        };
        window.qsStartCreditCheckout = startCreditCheckout;

        const confirmReturnedStripeCheckout = async () => {
            const params = new URLSearchParams(window.location.search || '');
            const sessionId = params.get('session_id');
            if (!sessionId || params.get('stripe_success') !== '1') return;
            const headers = await getAuthedJsonHeaders();
            if (!headers) return;
            try {
                const res = await fetch('/api/stripe/confirm-checkout-session', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ session_id: sessionId }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'checkout confirmation failed');
                try {
                    if (typeof window.qsRefreshUserCredits === 'function') await window.qsRefreshUserCredits();
                } catch (_) {}
                if (typeof showStatus === 'function') {
                    const isHe = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
                    const added = Number(data.added_minutes || 0);
                    const msg = added > 0
                        ? (isHe ? `נוספו ${added} דקות לארנק שלך.` : `${added} minutes added to your wallet.`)
                        : (isHe ? 'התשלום כבר עודכן בארנק שלך.' : 'Payment already credited to your wallet.');
                    showStatus(msg, false, { duration: 6000 });
                }
                params.delete('stripe_success');
                params.delete('session_id');
                const cleanQuery = params.toString();
                history.replaceState(null, '', window.location.pathname + (cleanQuery ? '?' + cleanQuery : '') + window.location.hash);
            } catch (err) {
                if (typeof showStatus === 'function') {
                    showStatus((err && err.message) || 'Could not confirm checkout.', true, { duration: 8000 });
                }
            }
        };

        const cardcomReturnQueryKeys = [
            'cardcom_success', 'cardcom_cancelled', 'order_id', 'terminalnumber',
            'lowprofilecode', 'LowProfileCode', 'ResponeCode', 'ResponseCode',
            'Operation', 'Status', 'internalDealNumber', 'IssuerAuthCodeDescription', 'traceid',
        ];
        const cleanCardcomReturnQuery = (params) => {
            cardcomReturnQueryKeys.forEach((key) => params.delete(key));
            return params.toString();
        };

        const confirmReturnedCardcomCheckout = async () => {
            const params = new URLSearchParams(window.location.search || '');
            const orderId = params.get('order_id');
            if (!orderId || params.get('cardcom_success') !== '1') return;
            const headers = await getAuthedJsonHeaders();
            if (!headers) return;
            const lowProfileId = (
                params.get('lowprofilecode')
                || params.get('LowProfileCode')
                || params.get('low_profile_id')
                || ''
            ).trim();
            try {
                const res = await fetch('/api/cardcom/confirm-payment', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        order_id: orderId,
                        low_profile_id: lowProfileId || undefined,
                        lowprofilecode: lowProfileId || undefined,
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'checkout confirmation failed');
                try {
                    if (typeof window.qsRefreshUserCredits === 'function') await window.qsRefreshUserCredits();
                } catch (_) {}
                if (typeof showStatus === 'function') {
                    const isHe = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
                    const added = Number(data.added_minutes || 0);
                    const msg = added > 0
                        ? (isHe ? `נוספו ${added} דקות לארנק שלך.` : `${added} minutes added to your wallet.`)
                        : (isHe ? 'התשלום כבר עודכן בארנק שלך.' : 'Payment already credited to your wallet.');
                    showStatus(msg, false, { duration: 6000 });
                }
                const cleanQuery = cleanCardcomReturnQuery(params);
                history.replaceState(null, '', window.location.pathname + (cleanQuery ? '?' + cleanQuery : '') + window.location.hash);
            } catch (err) {
                if (typeof showStatus === 'function') {
                    showStatus((err && err.message) || 'Could not confirm checkout.', true, { duration: 8000 });
                }
            }
        };

        void confirmReturnedStripeCheckout();
        void confirmReturnedCardcomCheckout();

        const creditBundleIds = ['light', 'standard', 'plus'];
        const creditBundleStorageKey = 'qs_selected_credit_bundle';
        const creditBundlePriceMeta = {
            light: { he: '₪19', en: '$7', noteHe: ' / 90 דקות', noteEn: ' / 90 min' },
            standard: { he: '₪39', en: '$13', noteHe: ' / 300 דקות', noteEn: ' / 300 min' },
            plus: { he: '₪79', en: '$27', noteHe: ' / 720 דקות', noteEn: ' / 720 min' },
        };
        const buyCreditsBtn = document.getElementById('seo-buy-credits-btn');
        const creditBundlePriceEl = document.getElementById('seo-credit-bundle-price');
        const creditBundleDetailEl = document.getElementById('seo-credit-bundle-detail');
        const creditBundleItems = Array.from(
            document.querySelectorAll('#seo-pricing-pro .seo-credit-bundle-item[data-bundle]')
        );
        const creditBundlePanes = creditBundleDetailEl
            ? Array.from(creditBundleDetailEl.querySelectorAll('.seo-credit-bundle-pane[data-bundle-pane]'))
            : [];

        const planStorageKey = 'qs_selected_plan';
        const legacyStarterKey = 'qs_starter_plan_selected';
        const planIds = ['starter', 'pro', 'enterprise'];
        const planCards = {
            starter: document.getElementById('seo-pricing-starter'),
            pro: document.getElementById('seo-pricing-pro'),
            enterprise: document.getElementById('seo-pricing-enterprise'),
        };

        const getSelectedPlan = () => {
            if (typeof window.qsGetSelectedPlan === 'function') {
                return window.qsGetSelectedPlan();
            }
            try {
                const current = String(localStorage.getItem(planStorageKey) || '').trim();
                if (planIds.includes(current)) return current;
                if (localStorage.getItem(legacyStarterKey) === '1') return 'starter';
            } catch (_) {}
            return 'starter';
        };

        const syncPlanCardsUi = () => {
            const selected = getSelectedPlan();
            planIds.forEach((id) => {
                const card = planCards[id];
                if (!card) return;
                const on = selected === id;
                card.classList.toggle('is-selected', on);
                card.setAttribute('aria-pressed', on ? 'true' : 'false');
                card.classList.toggle('is-plan-muted', selected !== id);
            });
            if (typeof window.qsSyncStarterPlanUploadGate === 'function') {
                window.qsSyncStarterPlanUploadGate();
            }
        };

        const setSelectedPlan = (planId) => {
            if (!planIds.includes(planId)) return;
            try {
                localStorage.setItem(planStorageKey, planId);
                localStorage.removeItem(legacyStarterKey);
            } catch (_) {}
            syncPlanCardsUi();
            if (planId === 'starter') smoothTo('main-btn');
        };

        window.syncPlanCardsUi = syncPlanCardsUi;

        const syncCreditBundleDisplay = (bundleId) => {
            const meta = creditBundlePriceMeta[bundleId] || creditBundlePriceMeta.standard;
            const isEn = String(document.documentElement.lang || '').toLowerCase().startsWith('en');
            if (creditBundlePriceEl) {
                const priceEl = creditBundlePriceEl.querySelector('[data-bundle-price]');
                const noteEl = creditBundlePriceEl.querySelector('[data-bundle-price-note]');
                if (priceEl) priceEl.textContent = isEn ? meta.en : meta.he;
                if (noteEl) noteEl.textContent = isEn ? meta.noteEn : meta.noteHe;
            }
            creditBundlePanes.forEach((pane) => {
                const on = pane.dataset.bundlePane === bundleId;
                pane.hidden = !on;
                pane.classList.toggle('is-active', on);
            });
            if (creditBundleDetailEl) {
                creditBundleDetailEl.setAttribute('aria-labelledby', 'seo-credit-tab-' + bundleId);
            }
        };

        const getSelectedCreditBundle = () => {
            try {
                const stored = String(localStorage.getItem(creditBundleStorageKey) || '').trim();
                if (creditBundleIds.includes(stored)) return stored;
            } catch (_) {}
            const selected = document.querySelector('#seo-pricing-pro .seo-credit-bundle-item.is-selected');
            const fromDom = selected && selected.dataset ? String(selected.dataset.bundle || '').trim() : '';
            return creditBundleIds.includes(fromDom) ? fromDom : 'standard';
        };

        const setSelectedCreditBundle = (bundleId) => {
            if (!creditBundleIds.includes(bundleId)) return;
            try { localStorage.setItem(creditBundleStorageKey, bundleId); } catch (_) {}
            creditBundleItems.forEach((item) => {
                const on = item.dataset.bundle === bundleId;
                item.classList.toggle('is-selected', on);
                item.setAttribute('aria-selected', on ? 'true' : 'false');
                item.setAttribute('aria-pressed', on ? 'true' : 'false');
                item.tabIndex = on ? 0 : -1;
            });
            if (buyCreditsBtn) buyCreditsBtn.dataset.bundle = bundleId;
            syncCreditBundleDisplay(bundleId);
        };

        setSelectedCreditBundle(getSelectedCreditBundle());
        creditBundleItems.forEach((item) => {
            const pickBundle = (e) => {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                setSelectedCreditBundle(item.dataset.bundle);
                setSelectedPlan('pro');
            };
            item.addEventListener('click', pickBundle);
            item.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                pickBundle(e);
            });
        });

        document.querySelectorAll('.seo-bridge-action').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (el.closest('#seo-pricing-pro')) {
                    setSelectedPlan('pro');
                    if (el.id === 'seo-buy-credits-btn') {
                        void startCreditCheckout(getSelectedCreditBundle(), el);
                        return;
                    }
                }
                smoothTo('main-btn');
            });
        });

        const wirePlanCard = (planId) => {
            const card = planCards[planId];
            if (!card) return;
            const activate = (e) => {
                if (e && e.target && e.target.closest('.seo-bridge-action, .seo-credit-bundle-item, #seo-go-medical-btn')) return;
                if (planId === 'enterprise') {
                    window.location.href = qsMedicalPricingUrl();
                    return;
                }
                setSelectedPlan(planId);
            };
            card.addEventListener('click', activate);
            card.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target.closest('.seo-bridge-action, .seo-credit-bundle-item, #seo-go-medical-btn')) return;
                e.preventDefault();
                if (planId === 'enterprise') {
                    window.location.href = qsMedicalPricingUrl();
                    return;
                }
                setSelectedPlan(planId);
            });
        };

        planIds.forEach(wirePlanCard);
        if (typeof window.qsEnsureDefaultStarterPlan === 'function') window.qsEnsureDefaultStarterPlan();
        syncPlanCardsUi();
        if (typeof window.qsRefreshUserCredits === 'function') {
            void window.qsRefreshUserCredits({ ensureWelcome: true }).then(() => {
                if (typeof window.qsSyncStarterPlanUploadGate === 'function') {
                    window.qsSyncStarterPlanUploadGate();
                }
            });
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        if (document.getElementById('main-btn')) return;
        if (typeof window.qsInitRegularPricingPage === 'function') {
            window.qsInitRegularPricingPage({ standalone: true });
        }
    });
})();
