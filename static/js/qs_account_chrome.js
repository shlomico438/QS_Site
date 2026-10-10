/**
 * Inject signed-in account chrome only after auth is confirmed.
 * Guest SSR must not contain balance / logout / profile / referral / erase strings
 * (search crawlers read the initial HTML).
 */
(function (global) {
    'use strict';

    function T(key, fallback) {
        try {
            if (typeof global.t === 'function') {
                const v = global.t(key);
                if (v && v !== key) return v;
            }
        } catch (_) {}
        return fallback || key;
    }

    function isMedicalEntryPage() {
        try {
            if (global.__QS_MEDICAL_URL_ENTRY) return true;
            if (document.documentElement.classList.contains('qs-medical-entry')) return true;
            const p = String((global.location && global.location.pathname) || '').replace(/\/+$/, '') || '/';
            return p === '/medical' || p === '/en/medical' || p.startsWith('/medical/') || p.startsWith('/en/medical/');
        } catch (_) {
            return false;
        }
    }

    function el(html) {
        const wrap = document.createElement('div');
        wrap.innerHTML = String(html || '').trim();
        return wrap.firstElementChild;
    }

    function ensureHost(id, tag) {
        let node = document.getElementById(id);
        if (node) return node;
        node = document.createElement(tag || 'div');
        node.id = id;
        return node;
    }

    function buildUserMenu(includeMedical) {
        const medicalBlock = includeMedical
            ? `
            <div class="user-menu-profile-medical" style="margin-bottom:10px;">
                <label for="user-menu-medical-mode" style="display:flex; align-items:center; gap:8px; font-weight:600;">
                    <input type="checkbox" id="user-menu-medical-mode">
                    <span data-i18n="medical_mode_label">${T('medical_mode_label', 'Medical mode (HIPAA)')}</span>
                </label>
                <button type="button" id="user-menu-medical-billing" class="user-menu-medical-billing-btn" hidden data-i18n="medical_plan_billing">
                    ${T('medical_plan_billing', 'Plan & billing')}
                </button>
            </div>
            <div class="user-menu-profile-medical-training" style="display:none; margin-bottom:12px; padding:10px; border:1px solid #d1fae5; border-radius:10px; background:#f0fdfa;">
                <div style="font-weight:600; color:#0f766e; margin-bottom:6px;" data-i18n="medical_training_style_title">${T('medical_training_style_title', 'Summary style adaptation')}</div>
                <div style="font-size:0.85rem; color:#115e59; line-height:1.45; margin-bottom:8px;" data-i18n="medical_training_style_hint">${T('medical_training_style_hint', '')}</div>
                <button type="button" id="user-menu-medical-training-reset" style="width:100%; padding:8px; border:1px solid #99f6e4; background:#ffffff; color:#0f766e; border-radius:8px; cursor:pointer; font-weight:600;" data-i18n="medical_training_reset_btn">${T('medical_training_reset_btn', 'Reset summary training')}</button>
                <div id="user-menu-medical-training-status" style="margin-top:6px; font-size:0.8rem; color:#0f766e;"></div>
            </div>
            <div id="user-menu-medical-specialty-wrap" class="user-menu-medical-specialty-wrap" hidden>
                <label class="user-menu-profile-label" for="user-menu-medical-specialty" data-i18n="profile_specialty_label">${T('profile_specialty_label', 'Professional field')}</label>
                <select id="user-menu-medical-specialty" class="user-menu-profile-input">
                    <option value="" data-i18n="medical_specialty_placeholder">${T('medical_specialty_placeholder', 'Choose your professional field')}</option>
                    <option value="physician" data-i18n="medical_specialty_physician">${T('medical_specialty_physician', 'Family medicine')}</option>
                    <option value="neurology" data-i18n="medical_specialty_neurology">${T('medical_specialty_neurology', 'Neurology')}</option>
                    <option value="orthopedics" data-i18n="medical_specialty_orthopedics">${T('medical_specialty_orthopedics', 'Orthopedics')}</option>
                    <option value="psychologist" data-i18n="medical_specialty_psychologist">${T('medical_specialty_psychologist', 'Psychology')}</option>
                    <option value="occupational_therapist" data-i18n="medical_specialty_occupational_therapist">${T('medical_specialty_occupational_therapist', 'Occupational therapy')}</option>
                    <option value="physiotherapist" data-i18n="medical_specialty_physiotherapist">${T('medical_specialty_physiotherapist', 'Physiotherapy')}</option>
                    <option value="speech_therapist" data-i18n="medical_specialty_speech_therapist">${T('medical_specialty_speech_therapist', 'Speech therapy')}</option>
                    <option value="nurse" data-i18n="medical_specialty_nurse">${T('medical_specialty_nurse', 'Nursing')}</option>
                    <option value="social_worker" data-i18n="medical_specialty_social_worker">${T('medical_specialty_social_worker', 'Medical social work')}</option>
                    <option value="other" data-i18n="medical_specialty_other">${T('medical_specialty_other', 'Other healthcare profession')}</option>
                </select>
                <p class="user-menu-profile-note" data-i18n="profile_specialty_note">${T('profile_specialty_note', '')}</p>
            </div>`
            : '';

        return el(`
        <div id="user-menu-panel" class="user-menu-panel" aria-hidden="true">
            <div class="user-menu-header">
                <span class="user-menu-title" data-i18n="profile">${T('profile', 'Profile')}</span>
                <button type="button" id="user-menu-close" class="user-menu-close-btn" aria-label="${T('close', 'Close')}">×</button>
            </div>
            <div id="user-menu-profile" class="user-menu-profile">
                <div id="user-menu-credits" class="user-menu-credits" style="display: none;" aria-live="polite">
                    <span data-i18n="nav_credits">${T('nav_credits', 'Minutes balance')}</span>:
                    <strong id="user-menu-credit-minutes">0</strong>
                    <p id="user-menu-renewal-note" class="user-menu-renewal-note" hidden></p>
                    <button type="button" id="user-menu-cancel-renewal" class="user-menu-cancel-renewal" hidden data-i18n="billing_cancel_renewal">${T('billing_cancel_renewal', 'Cancel auto-renewal')}</button>
                </div>
                <div id="user-menu-referral" class="user-menu-referral" hidden>
                    <div class="user-menu-referral-title" data-i18n="referral_title">${T('referral_title', 'Invite a friend')}</div>
                    <p class="user-menu-referral-hint" data-i18n="referral_hint">${T('referral_hint', '')}</p>
                    <label class="user-menu-profile-label" for="user-menu-referral-link" data-i18n="referral_link_label">${T('referral_link_label', 'Your referral link')}</label>
                    <input type="text" id="user-menu-referral-link" class="user-menu-profile-input" readonly lang="en" dir="ltr">
                    <div class="user-menu-referral-actions">
                        <button type="button" id="user-menu-referral-copy-link" class="user-menu-referral-btn" data-i18n="referral_copy_link">${T('referral_copy_link', 'Copy link')}</button>
                        <button type="button" id="user-menu-referral-copy-email" class="user-menu-referral-btn" data-i18n="referral_copy_email">${T('referral_copy_email', 'Copy email')}</button>
                    </div>
                    <p id="user-menu-referral-stats" class="user-menu-referral-stats"></p>
                </div>
                ${medicalBlock}
                <label class="user-menu-profile-label" for="user-menu-name" data-i18n="display_name">${T('display_name', 'Display name')}</label>
                <input type="text" id="user-menu-name" class="user-menu-profile-input" placeholder="" autocomplete="name">
                <label class="user-menu-profile-label" for="user-menu-email" data-i18n="email">${T('email', 'Email')}</label>
                <input type="email" id="user-menu-email" class="user-menu-profile-input" placeholder="" autocomplete="email">
                <p class="user-menu-profile-note" data-i18n="email_change_note">${T('email_change_note', '')}</p>
                <p id="user-menu-profile-message" class="user-menu-profile-message" style="display: none;"></p>
                <div class="user-menu-profile-actions">
                    <button type="button" id="user-menu-cancel" class="user-menu-cancel-btn" data-i18n="cancel">${T('cancel', 'Cancel')}</button>
                    <button type="button" id="user-menu-save" class="user-menu-save-btn" data-i18n="save">${T('save', 'Save')}</button>
                </div>
                <div class="user-menu-profile-erase">
                    <button type="button" id="user-menu-erase-account" class="user-menu-erase-btn" data-i18n="erase_account">${T('erase_account', 'Erase account')}</button>
                </div>
            </div>
        </div>`);
    }

    function qsEnsureSignedInAccountChrome() {
        const medical = isMedicalEntryPage();
        const TnavBalance = T('nav_minutes_balance', 'Minutes balance');
        const Tlogout = T('nav_logout', 'Log Out');
        const Taccount = T('account', 'Account');

        const creditHost = document.getElementById('nav-credit-balance-host');
        if (creditHost && !document.getElementById('nav-credit-balance')) {
            creditHost.appendChild(el(`
                <span id="nav-credit-balance" class="nav-credit-balance" style="display: none;" aria-live="polite">
                    <span class="nav-credit-label" data-i18n="nav_minutes_balance">${TnavBalance}</span>:
                    <strong id="nav-credit-minutes">0</strong>
                </span>`));
        }

        const sessionHost = document.getElementById('nav-utility-signed-in-host');
        if (sessionHost && !document.getElementById('nav-utility-signed-in')) {
            sessionHost.appendChild(el(`
                <div id="nav-utility-signed-in" class="nav-utility-signed-in" style="display: none;">
                    <button type="button" class="nav-utility-user-name" id="nav-user-name-trigger" aria-haspopup="dialog">${Taccount}</button>
                    <button type="button" class="nav-utility-link nav-utility-logout" id="nav-logout-btn" data-i18n="nav_logout">${Tlogout}</button>
                </div>`));
        }

        const mobileHost = document.getElementById('nav-mobile-signed-in-host');
        if (mobileHost && !document.getElementById('nav-mobile-signed-in')) {
            if (!document.getElementById('nav-credit-balance-mobile')) {
                mobileHost.appendChild(el(`
                    <span id="nav-credit-balance-mobile" class="nav-credit-balance nav-credit-balance--mobile" style="display: none;" aria-live="polite">
                        <span data-i18n="nav_minutes_balance">${TnavBalance}</span>:
                        <strong id="nav-credit-minutes-mobile">0</strong>
                    </span>`));
            }
            mobileHost.appendChild(el(`
                <div id="nav-mobile-signed-in" class="nav-mobile-signed-in qs-nav-auth-hidden" hidden>
                    <button type="button" class="nav-item nav-mobile-user-name" id="nav-user-name-trigger-mobile" aria-haspopup="dialog">${Taccount}</button>
                    <button type="button" class="nav-item nav-mobile-logout" id="nav-logout-btn-mobile" data-i18n="nav_logout">${Tlogout}</button>
                </div>`));
        }

        if (!document.getElementById('user-menu-panel')) {
            const panel = buildUserMenu(medical);
            const header = document.getElementById('site-header');
            if (header && header.parentNode) {
                header.parentNode.insertBefore(panel, header.nextSibling);
            } else {
                document.body.appendChild(panel);
            }
        }

        const guestLine = document.getElementById('nav-guest-free-tier');
        if (guestLine) guestLine.hidden = true;
        const guestLineMobile = document.getElementById('nav-guest-free-tier-mobile');
        if (guestLineMobile) guestLineMobile.hidden = true;

        try {
            if (typeof global.applyTranslations === 'function') global.applyTranslations();
        } catch (_) {}
        return true;
    }

    function qsShowGuestAccountChrome() {
        const guestLine = document.getElementById('nav-guest-free-tier');
        if (guestLine) guestLine.hidden = false;
        const guestLineMobile = document.getElementById('nav-guest-free-tier-mobile');
        if (guestLineMobile) guestLineMobile.hidden = false;
        const signedIn = document.getElementById('nav-utility-signed-in');
        if (signedIn) signedIn.style.display = 'none';
        const credits = document.getElementById('nav-credit-balance');
        if (credits) credits.style.display = 'none';
        const mobileSigned = document.getElementById('nav-mobile-signed-in');
        if (mobileSigned) {
            mobileSigned.hidden = true;
            mobileSigned.style.display = 'none';
        }
    }

    global.qsEnsureSignedInAccountChrome = qsEnsureSignedInAccountChrome;
    global.qsShowGuestAccountChrome = qsShowGuestAccountChrome;
})(typeof window !== 'undefined' ? window : globalThis);
