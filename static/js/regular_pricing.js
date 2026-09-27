/**
 * Regular (non-medical) pricing: free month, unlimited, and pay-per-use checkout.
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

        const checkoutSuccessMessage = (data) => {
            const isHe = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
            const plan = String((data && data.plan) || '');
            if (plan === 'unlimited_monthly' || plan === 'unlimited_annual') {
                return isHe ? 'המסלול ללא הגבלה הופעל.' : 'Unlimited plan is active.';
            }
            if (plan === 'pay_per_use') {
                const hours = Number(data.hours || 1);
                return isHe
                    ? (hours === 1 ? 'שולם עבור קובץ של עד שעה.' : `שולם עבור קובץ של עד ${hours} שעות.`)
                    : (hours === 1 ? 'Paid for a file of up to 1 hour.' : `Paid for a file of up to ${hours} hours.`);
            }
            const added = Number(data && data.added_minutes || 0);
            if (added > 0) {
                return isHe ? `נוספו ${added} דקות לארנק שלך.` : `${added} minutes added to your wallet.`;
            }
            return isHe ? 'התשלום כבר עודכן בארנק שלך.' : 'Payment already credited to your wallet.';
        };

        let payUseHours = 1;
        const syncPayUseHours = (hours) => {
            const next = Math.max(1, Math.min(24, Number(hours) || 1));
            payUseHours = next;
            const valueEl = document.getElementById('seo-pay-hours-value');
            const priceEl = document.getElementById('seo-pay-use-price');
            if (valueEl) {
                valueEl.textContent = String(next);
                valueEl.dataset.hours = String(next);
            }
            if (priceEl) {
                const isEn = String(document.documentElement.lang || '').toLowerCase().startsWith('en');
                const amount = isEn ? (3 * next) : (9 * next);
                const symbol = isEn ? '$' : '₪';
                const unit = isEn ? '/ hour' : 'לשעה';
                priceEl.innerHTML = `${symbol}${amount} <small>${next === 1 ? unit : (isEn ? `for ${next} hours` : `עבור ${next} שעות`)}</small>`;
            }
            const btn = document.getElementById('seo-buy-payg-btn');
            if (btn) btn.dataset.hours = String(next);
            const noteEl = document.getElementById('seo-pay-hours-note');
            if (noteEl) {
                const isEn = String(document.documentElement.lang || '').toLowerCase().startsWith('en');
                noteEl.textContent = isEn
                    ? (next === 1 ? 'Up to 1 hour file' : `Up to ${next} hours`)
                    : (next === 1 ? 'קובץ של עד שעה' : `קובץ של עד ${next} שעות`);
            }
        };
        window.qsSetPayPerUseHours = (hours) => {
            syncPayUseHours(hours);
            const section = document.getElementById('pricing-section');
            if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        syncPayUseHours(1);

        const startCreditCheckout = async (planId, sourceBtn, hours) => {
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
                        bundle: planId || 'unlimited_monthly',
                        plan: planId || 'unlimited_monthly',
                        hours: planId === 'pay_per_use' ? (Number(hours) || payUseHours || 1) : 1,
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
                    showStatus(checkoutSuccessMessage(data), false, { duration: 6000 });
                }
                try {
                    if (typeof window.qsTrackGa4Purchase === 'function') {
                        window.qsTrackGa4Purchase({
                            transaction_id: sessionId,
                            value: data.amount ?? data.amount_ils,
                            currency: data.currency || 'ILS',
                            items: data.bundle_id
                                ? [{ item_id: String(data.bundle_id), item_name: 'QuickScribe credits' }]
                                : undefined,
                        });
                    }
                } catch (_) {}
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
                    showStatus(checkoutSuccessMessage(data), false, { duration: 6000 });
                }
                try {
                    if (typeof window.qsTrackGa4Purchase === 'function') {
                        window.qsTrackGa4Purchase({
                            transaction_id: orderId,
                            value: data.amount ?? data.amount_ils,
                            currency: data.currency || 'ILS',
                            items: data.bundle_id
                                ? [{ item_id: String(data.bundle_id), item_name: 'QuickScribe credits' }]
                                : undefined,
                        });
                    }
                } catch (_) {}
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

        const minusBtn = document.getElementById('seo-pay-hours-minus');
        const plusBtn = document.getElementById('seo-pay-hours-plus');
        if (minusBtn) minusBtn.addEventListener('click', (e) => { e.stopPropagation(); syncPayUseHours(payUseHours - 1); });
        if (plusBtn) plusBtn.addEventListener('click', (e) => { e.stopPropagation(); syncPayUseHours(payUseHours + 1); });

        document.querySelectorAll('.seo-bridge-action').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const plan = el.dataset ? el.dataset.plan : '';
                if (plan === 'unlimited_annual' || plan === 'unlimited_monthly' || plan === 'pay_per_use') {
                    if (plan === 'pay_per_use') {
                        const fileSec = Number(window.__QS_UPLOAD_MEDIA_DURATION_SEC) || 0;
                        if (fileSec > 3600) {
                            syncPayUseHours(Math.max(payUseHours, Math.ceil(fileSec / 3600)));
                        }
                    }
                    const hours = plan === 'pay_per_use' ? payUseHours : 1;
                    void startCreditCheckout(plan, el, hours);
                    return;
                }
                smoothTo('main-btn');
            });
        });

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
