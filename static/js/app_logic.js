// Supabase client (inlined — avoids extra same-origin fetch). Use jsDelivr +esm (reliable named export); esm.sh ?bundle broke createClient in some browsers.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm'

const supabaseUrl = 'https://vojesnnvehecenjymrko.supabase.co'
const supabaseAnonKey = 'sb_publishable_BhoKDe-_iL04tOVYCbbX0w_3TjKWaGG'
const QS_SUPABASE_PROJECT_REF = (() => {
    try { return new URL(supabaseUrl).hostname.split('.')[0] || 'vojesnnvehecenjymrko'; } catch (_) { return 'vojesnnvehecenjymrko'; }
})();
const QS_SUPABASE_AUTH_STORAGE_KEY = `sb-${QS_SUPABASE_PROJECT_REF}-auth-token`;
const QS_SUPABASE_AUTH_COOKIE_PREFIX = 'qs_sb_auth_';
const QS_SUPABASE_AUTH_COOKIE_CHUNK_SIZE = 2500;

function qsAuthCookieName(key, suffix) {
    return QS_SUPABASE_AUTH_COOKIE_PREFIX + encodeURIComponent(String(key || '')) + (suffix || '');
}

function qsReadCookie(name) {
    if (typeof document === 'undefined') return null;
    const prefix = String(name || '') + '=';
    const parts = String(document.cookie || '').split(';');
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) {
            try { return decodeURIComponent(trimmed.slice(prefix.length)); } catch (_) { return trimmed.slice(prefix.length); }
        }
    }
    return null;
}

function qsWriteCookie(name, value, maxAgeSeconds) {
    if (typeof document === 'undefined') return;
    const secure = (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(String(value || ''))}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax${secure}`;
}

function qsClearAuthCookieChunks(key) {
    const metaName = qsAuthCookieName(key, '.chunks');
    const count = Number(qsReadCookie(metaName) || 0);
    const max = Number.isFinite(count) && count > 0 ? Math.min(count, 30) : 30;
    for (let i = 0; i < max; i++) qsWriteCookie(qsAuthCookieName(key, `.${i}`), '', 0);
    qsWriteCookie(metaName, '', 0);
}

function qsReadAuthCookieChunks(key) {
    const count = Number(qsReadCookie(qsAuthCookieName(key, '.chunks')) || 0);
    if (!Number.isFinite(count) || count <= 0 || count > 30) return null;
    let value = '';
    for (let i = 0; i < count; i++) {
        const chunk = qsReadCookie(qsAuthCookieName(key, `.${i}`));
        if (chunk == null) return null;
        value += chunk;
    }
    return value || null;
}

function qsWriteAuthCookieChunks(key, value) {
    const raw = String(value || '');
    qsClearAuthCookieChunks(key);
    if (!raw) return;
    const count = Math.ceil(raw.length / QS_SUPABASE_AUTH_COOKIE_CHUNK_SIZE);
    if (count > 30) return;
    const maxAge = 60 * 60 * 24 * 365;
    for (let i = 0; i < count; i++) {
        qsWriteCookie(qsAuthCookieName(key, `.${i}`), raw.slice(i * QS_SUPABASE_AUTH_COOKIE_CHUNK_SIZE, (i + 1) * QS_SUPABASE_AUTH_COOKIE_CHUNK_SIZE), maxAge);
    }
    qsWriteCookie(qsAuthCookieName(key, '.chunks'), String(count), maxAge);
}

const qsSupabaseAuthStorage = {
    getItem(key) {
        try {
            const value = localStorage.getItem(key);
            if (value != null) return value;
        } catch (_) {}
        try { return qsReadAuthCookieChunks(key); } catch (_) { return null; }
    },
    setItem(key, value) {
        try { localStorage.setItem(key, value); } catch (_) {}
        try { qsWriteAuthCookieChunks(key, value); } catch (_) {}
    },
    removeItem(key) {
        try { localStorage.removeItem(key); } catch (_) {}
        try { qsClearAuthCookieChunks(key); } catch (_) {}
    }
};
// Semicolon required: next line starts with `(` — without it, ASI parses `createClient(...)(() => { ... })`.
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: qsSupabaseAuthStorage
    }
});
try { window.supabase = supabase; } catch (_) {}

// Console gate + timestamp prefix on every line:
// - Default ON for localhost (dev), OFF for non-local hosts (production-like).
// - Override via localStorage key `qs_console`:
//     '1' => force enable, '0' => force disable.
(() => {
    let enabled = false;
    try {
        const forced = String(localStorage.getItem('qs_console') || '').trim();
        if (forced === '1') enabled = true;
        else if (forced === '0') enabled = false;
        else {
            const host = String(window.location && window.location.hostname || '').toLowerCase();
            enabled = (host === 'localhost' || host === '127.0.0.1');
        }
    } catch (_) {
        enabled = false;
    }
    window.__QS_CONSOLE_ENABLED = enabled;
    const c = window.console;
    if (!c) return;
    const qsConsoleTs = () => new Date().toISOString();
    const qsWrapConsole = (method) => {
        const orig = typeof c[method] === 'function' ? c[method].bind(c) : c.log.bind(c);
        return function (...args) {
            return orig(`[${qsConsoleTs()}]`, ...args);
        };
    };
    const wrapped = {
        log: qsWrapConsole('log'),
        info: qsWrapConsole('info'),
        debug: qsWrapConsole('debug'),
        warn: qsWrapConsole('warn'),
        error: qsWrapConsole('error'),
    };
    if (!enabled) {
        c.log = () => {};
        c.info = () => {};
        c.debug = () => {};
        c.warn = () => {};
    } else {
        c.log = wrapped.log;
        c.info = wrapped.info;
        c.debug = wrapped.debug;
        c.warn = wrapped.warn;
    }
    // console.error always active on prod — upload/audio-profile diagnostics; still timestamped.
    c.error = wrapped.error;
})();

// --- GLOBAL STATE ---
window.isTriggering = false;
window.aiDiarizationRan = false;
window.fakeProgressInterval = null;
window.currentSegments = [];
/** Video jobs play `main-video`; audio jobs play `main-audio`. Subtitles and `currentTime` must follow the active element. */
window._getPrimaryMediaElement = function() {
    const v = document.getElementById('main-video');
    const a = document.getElementById('main-audio');
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return a || v;
    if (window.uploadWasVideo === true) return v || a;
    return a || v;
};
window.currentFormattedDoc = null;
// When true, doc view/export should prefer current edited segments over stale GPT clean_transcript.
window._qsDocPreferSegmentsAfterEdit = false;
// Per-caption layout + highlight (merged with global defaults). Timeline/keywords UI removed.
window.globalCaptionLayoutStyle = window.globalCaptionLayoutStyle || null;
window.currentWords = null;
window.currentCaptions = null;
window.originalFileName = '';
window.hasMultipleSpeakers = false;
let isSignUpMode = true;
const QS_MEDICAL_MODE_KEY = 'qs_medical_mode';
/** Set when user has opened /medical (so OAuth can land on /#$ and we still restore HIPAA UI after sign-out). */
const QS_MEDICAL_LANDING_KEY = 'qs_medical_landing';
const QS_IOS_SAFARI_HINT_TS_KEY = 'qs_ios_safari_hint_ts';

function _qsReadMedicalLanding() {
    try {
        return String(localStorage.getItem(QS_MEDICAL_LANDING_KEY) || '').trim() === '1';
    } catch (_) {
        return false;
    }
}
function _qsSetMedicalLanding() {
    try { localStorage.setItem(QS_MEDICAL_LANDING_KEY, '1'); } catch (_) {}
}
function _qsClearMedicalLanding() {
    try { localStorage.removeItem(QS_MEDICAL_LANDING_KEY); } catch (_) {}
}

/** UI locale resolver for dictionary-based translations (same keys, he/en values). */
function qsResolveAppLocale() {
    try {
        const params = new URLSearchParams(window.location.search || '');
        const q = String(params.get('lang') || '').toLowerCase().split('-')[0];
        if (q === 'en' || q === 'he') return q;
    } catch (_) {}
    try {
        const path = String(window.location.pathname || '/').replace(/\/+$/, '') || '/';
        if (path === '/en') return 'en';
        if (path === '/') return 'he';
    } catch (_) {}
    const win = String(window.currentLocale || '').toLowerCase().split('-')[0];
    const dom = String((document.documentElement && document.documentElement.lang) || '').toLowerCase().split('-')[0];
    if (win === 'en' || win === 'he') return win;
    try {
        const stored = String(localStorage.getItem('locale') || '').toLowerCase().split('-')[0];
        if (stored === 'en' || stored === 'he') return stored;
    } catch (_) {}
    if (dom === 'en' || dom === 'he') return dom;
    return 'he';
}
window.qsResolveAppLocale = qsResolveAppLocale;
/** True if this browser should return to the medical (HIPAA) product surface after sign-out. */
function _qsWantsPostLogoutMedical() {
    try {
        const p = (window.location && window.location.pathname)
            ? String(window.location.pathname).replace(/\/+$/, '') || '/'
            : '/';
        if (p === '/medical') return true;
    } catch (_) {}
    try {
        if (window.__QS_MEDICAL_URL_ENTRY) return true;
    } catch (_) {}
    return _qsReadMedicalLanding();
}
async function _qsSignOutThenMedicalOrReload() {
    const wantMedical = typeof _qsWantsPostLogoutMedical === 'function' && _qsWantsPostLogoutMedical();
    try {
        if (wantMedical) {
            if (typeof _qsSetMedicalReassertOnNextPageLoad === 'function') {
                _qsSetMedicalReassertOnNextPageLoad();
            }
            try { localStorage.setItem(QS_MEDICAL_MODE_KEY, '1'); } catch (_) {}
            if (typeof _qsSetMedicalLanding === 'function') {
                _qsSetMedicalLanding();
            }
        }
    } catch (_) {}
    await supabase.auth.signOut();
    if (wantMedical) {
        try {
            window.location.assign('/medical');
        } catch (_) {
            try { window.location.href = '/medical'; } catch (__) { window.location.reload(); }
        }
        return;
    }
    window.location.reload();
}

/** Keys that may be written while medical lockdown is on (HIPAA: block job/transcript cache, not auth). */
function _qsStorageKeyAllowedDuringMedicalLockdown(key) {
    const k = String(key || '');
    if (k === QS_MEDICAL_MODE_KEY || k === QS_MEDICAL_LANDING_KEY || k === 'locale' || k === 'qs_console') return true;
    // Supabase Auth persists session under sb-<project-ref>-… (e.g. auth-token, PKCE). Blocking these breaks Google OAuth / refresh.
    if (k.startsWith('sb-')) return true;
    if (k === 'supabase.auth.token') return true;
    // One-shot in-memory → survive sign-in round-trip; feedback session flags (Storage patch applies to sessionStorage too).
    if (k === 'qs_medical_auth_snapshot') return true;
    if (k === 'qs_medical_sign_in_for_copy' || k === 'qs_medical_show_feedback_on_next_copy') return true;
    if (k === 'qs_pefb_copy' || k === 'qs_pefb_export' || k.startsWith('qs_pefb_')) return true;
    if (k === 'qs_reg_prompt_dismissed') return true;
    // Prompt-training UI flag only (no transcript/PHI); must persist in medical mode or enable from summary CTA is a no-op.
    if (k === 'qs_medical_training_mode') return true;
    // Session GPU warmup markers (no PHI) — must persist or every auth tick re-POSTs /api/medical_session_warmup.
    if (k === QS_MEDICAL_SESSION_WARMUP_SUBMITTED_KEY || k === QS_MEDICAL_ENDPOINT_WARMUP_SUBMITTED_KEY) return true;
    // Current job pointers only (not cached transcript text): required so jobs row + result_s3_key updates work; Personal list reads jobs table.
    if (k === 'lastJobDbId' || k === 'lastS3Key' || k === 'lastJobId' || k === 'activeJobId' || k === 'pendingS3Key' || k === 'pendingJobId') return true;
    return false;
}

const QS_MEDICAL_AUTH_SNAPSHOT_KEY = 'qs_medical_auth_snapshot';

/** True if medical UI has transcript/summary data worth persisting across sign-in (incl. clinical-only fields). */
function medicalSnapshotSourceHasContent() {
    if (Array.isArray(window.currentSegments) && window.currentSegments.length > 0) return true;
    if (Array.isArray(window.currentWords) && window.currentWords.length > 0) return true;
    const doc = window.currentFormattedDoc;
    if (doc && typeof doc === 'object') {
        if (String(doc.clean_transcript || '').trim() || String(doc.overview || '').trim()) return true;
        if (Array.isArray(doc.key_points) && doc.key_points.length > 0) return true;
        if (
            String(doc.medical_chief_complaint || '').trim() ||
            String(doc.medical_examination_transcript || '').trim() ||
            String(doc.medical_patient_recommendations || '').trim()
        ) {
            return true;
        }
    }
    if (window._medicalHasResult === true) return true;
    return false;
}

/** Serialize transcript UI so a Supabase sign-in (OAuth / magic link) can reload without losing the session. */
function saveMedicalAuthSnapshotForPendingSignIn() {
    if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) return;
    if (!medicalSnapshotSourceHasContent()) return;
    const doc = window.currentFormattedDoc;
    const snap = {
        v: 2,
        segments: window.currentSegments || [],
        words: window.currentWords || null,
        captions: window.currentCaptions || null,
        currentFormattedDoc: doc && typeof doc === 'object' ? doc : null,
        medicalActiveTab: String(window.medicalActiveTab || 'transcript'),
        _medicalHasResult: window._medicalHasResult === true,
        _qsInputS3KeyForGpt: String(typeof window._qsInputS3KeyForGpt === 'string' ? window._qsInputS3KeyForGpt : (window._qsInputS3KeyForGpt || '') || '').trim() || null
    };
    try {
        const ljid = (typeof localStorage !== 'undefined' && localStorage.getItem('lastJobDbId')) || '';
        const ls = (typeof localStorage !== 'undefined' && localStorage.getItem('lastS3Key')) || '';
        const ljidRun = (typeof localStorage !== 'undefined' && localStorage.getItem('lastJobId')) || '';
        const act = (typeof localStorage !== 'undefined' && localStorage.getItem('activeJobId')) || '';
        if (ljid || ls || ljidRun || act) {
            snap.jobPointers = { lastJobDbId: ljid, lastS3Key: ls, lastJobId: ljidRun, activeJobId: act };
        }
    } catch (_) {}
    try {
        const s = JSON.stringify(snap);
        if (s.length > 4_500_000) return;
        try {
            localStorage.setItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY, s);
        } catch (e) {
            try { sessionStorage.setItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY, s); } catch (_) {}
        }
    } catch (e) {
        console.warn('[medical] auth snapshot', e);
    }
}

function clearMedicalAuthSnapshot() {
    try { localStorage.removeItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY); } catch (_) {}
    try { sessionStorage.removeItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY); } catch (_) {}
}

function restoreMedicalAuthSnapshotAfterSignIn() {
    if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) return;
    let raw = '';
    try {
        raw = localStorage.getItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY) || sessionStorage.getItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY) || '';
    } catch (_) {
        return;
    }
    if (!raw) return;
    let snap;
    try {
        snap = JSON.parse(raw);
    } catch (_) {
        clearMedicalAuthSnapshot();
        return;
    }
    if (!snap || (snap.v !== 1 && snap.v !== 2)) {
        clearMedicalAuthSnapshot();
        return;
    }
    try {
        const jp = snap.jobPointers;
        if (jp && typeof jp === 'object') {
            if (jp.lastJobDbId) {
                try { localStorage.setItem('lastJobDbId', String(jp.lastJobDbId)); } catch (_) {}
            }
            if (jp.lastS3Key) {
                try { localStorage.setItem('lastS3Key', String(jp.lastS3Key)); } catch (_) {}
            }
            if (jp.lastJobId) {
                try { localStorage.setItem('lastJobId', String(jp.lastJobId)); } catch (_) {}
            }
            if (jp.activeJobId) {
                try {
                    if (typeof window.qsSetActiveJob === 'function') window.qsSetActiveJob(String(jp.activeJobId));
                    else localStorage.setItem('activeJobId', String(jp.activeJobId));
                } catch (_) {}
            }
        }
    } catch (_) {}
    window.currentSegments = Array.isArray(snap.segments) ? snap.segments : [];
    window.currentWords = snap.words || null;
    window.currentCaptions = snap.captions || null;
    window.currentFormattedDoc = snap.currentFormattedDoc || null;
    window.medicalActiveTab = (snap.medicalActiveTab === 'summary' ? 'summary' : 'transcript');
    window._medicalHasResult = snap._medicalHasResult === true;
    if (snap._qsInputS3KeyForGpt) {
        try { window._qsInputS3KeyForGpt = String(snap._qsInputS3KeyForGpt); } catch (_) {}
    }
    clearMedicalAuthSnapshot();
    try {
        if (String(window.medicalActiveTab) === 'summary') {
            if (typeof renderTranscriptFromCues === 'function') {
                renderTranscriptFromCues(window.currentSegments || []);
            }
        } else if (typeof renderMedicalTranscriptMainView === 'function') {
            renderMedicalTranscriptMainView();
        } else if (typeof renderTranscriptFromCues === 'function') {
            renderTranscriptFromCues(window.currentSegments || []);
        }
    } catch (e) {
        console.warn('[medical] restore render', e);
    }
    try { if (typeof updateMedicalTabUi === 'function') updateMedicalTabUi(); } catch (_) {}
    try { if (typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs(); } catch (_) {}
}

function isMedicalModeEnabled() {
    return window.isMedicalMode === true;
}

/** Set after first /api/medical_session_warmup this browser session (global endpoint, not per doctor). */
const QS_MEDICAL_ENDPOINT_WARMUP_SUBMITTED_KEY = 'qs_medical_endpoint_warmup_submitted';
/** @deprecated alias */
const QS_MEDICAL_SESSION_WARMUP_SUBMITTED_KEY = QS_MEDICAL_ENDPOINT_WARMUP_SUBMITTED_KEY;
const QS_MEDICAL_WARMUP_SESSION_MS = 12 * 60 * 60 * 1000;
/** While banner shows ready, re-check server every 5 min (TTL / endpoint down). */
const QS_MEDICAL_ENDPOINT_EVENTS_ROOM = 'medical_endpoint_events';
/** AWS still cap=0 after this — treat ghost 'starting' as cold (must match server MEDICAL_WARMUP_STARTING_GRACE_SEC). */
const QS_MEDICAL_WARMUP_STARTING_GRACE_SEC = 300;
const QS_MEDICAL_WARMUP_PREPARING_MSG = 'המערכת מתכוננת ליום העבודה... (משוער: כ-10 דקות)';
const QS_MEDICAL_WARMUP_PREPARING_SUBMSG = 'ניתן להתחיל להקליט, אך הסיכום הראשון עשוי לקחת מספר דקות';
const QS_MEDICAL_WARMUP_COLD_TITLE = 'סשן קליני חדש';
const QS_MEDICAL_WARMUP_COLD_MSG = 'מערכת התמלול במצב שינה כדי לחסוך באנרגיה.';
const QS_MEDICAL_WARMUP_COLD_SUBMSG = 'לחץ על המיקרופון כדי להעיר את המערכת ולהתחיל את יום העבודה.';
const QS_MEDICAL_WARMUP_READY_MSG = 'המערכת מוכנה! יום עבודה מוצלח.';
/** Warmup bar fill: elapsed / 12 minutes since session warmup started. */
const QS_MEDICAL_WARMUP_DURATION_MS = 12 * 60 * 1000;

function qsMedicalWarmupStartedAtMs() {
    if (window.__QS_MEDICAL_WARMUP_STARTED_AT) return Number(window.__QS_MEDICAL_WARMUP_STARTED_AT);
    try {
        const raw = sessionStorage.getItem(QS_MEDICAL_SESSION_WARMUP_SUBMITTED_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            if (p && p.at) return Number(p.at);
        }
    } catch (_) {}
    return Date.now();
}

function qsWarmupPhasePct() {
    const elapsed = Date.now() - qsMedicalWarmupStartedAtMs();
    return Math.min(100, Math.round((elapsed / QS_MEDICAL_WARMUP_DURATION_MS) * 100));
}

function qsMedicalWarmupRemainingMinutesAfterRecording(recordingMs) {
    const remainingMs = Math.max(0, QS_MEDICAL_WARMUP_DURATION_MS - Math.max(0, Number(recordingMs) || 0));
    return Math.max(1, Math.ceil(remainingMs / 60000));
}

function qsShowMedicalFirstWakeupWaitNotice(recordingMs) {
    if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') return;
    if (window.__QS_MEDICAL_WAKEUP_NOTICE_ACTIVE) return;
    window.__QS_MEDICAL_WAKEUP_NOTICE_ACTIVE = true;
    const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
    const minutes = qsMedicalWarmupRemainingMinutesAfterRecording(recordingMs);
    const msg = isHebrewUi
        ? `המערכת עדיין מתחממת להפעלה הראשונה.\nזמן משוער לסיום: כ-${minutes} דקות.\n\nזה קורה רק בהפעלה הראשונה אחרי שהמערכת הייתה כבויה. בדרך כלל כל התהליך (העלאה ועיבוד) אורך כדקה ומתחיל מיד לאחר סיום ההקלטה.`
        : `The medical system is still warming up for the first wakeup.\nEstimated time remaining: about ${minutes} minutes.\n\nThis only happens on the first wakeup after the system was off. Normally the whole process (upload and processing) takes about one minute and starts right after you finish recording.`;
    if (typeof showGlobalAlert === 'function') {
        void showGlobalAlert(msg, { confirmText: isHebrewUi ? 'הבנתי' : 'OK' }).finally(() => {
            window.__QS_MEDICAL_WAKEUP_NOTICE_ACTIVE = false;
        });
    } else if (typeof showStatus === 'function') {
        showStatus(msg, false);
        window.__QS_MEDICAL_WAKEUP_NOTICE_ACTIVE = false;
    } else {
        window.__QS_MEDICAL_WAKEUP_NOTICE_ACTIVE = false;
    }
}

function qsHideMedicalWarmupBanner() {
    const banner = document.getElementById('medical-warmup-banner');
    if (!banner) return;
    banner.style.display = 'none';
    banner.classList.remove('is-visible', 'is-preparing', 'is-ready');
}

function qsEnsureMedicalProgressPanel(hideBanner) {
    if (hideBanner !== false) qsHideMedicalWarmupBanner();
    const panel = document.getElementById('processing-state-panel');
    const controlsRow = document.querySelector('.upload-zone .upload-controls-row');
    const introEl = document.getElementById('processing-state-intro');
    if (panel) panel.style.display = 'flex';
    qsSetProcessingOverlayActive(true);
    if (controlsRow) controlsRow.style.display = 'none';
    if (introEl) introEl.style.display = '';
    if (typeof qsShowPipelineBarChrome === 'function') qsShowPipelineBarChrome();
}

/** Warmup progress bar over transcript (after save while GPU warms; not during live recording waveform). */
function qsShowMedicalWarmupProgressDuringRecording() {
    if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') return;
    window.__QS_MEDICAL_RECORDING_WARMUP_BAR = true;
    const panel = document.getElementById('processing-state-panel');
    const introEl = document.getElementById('processing-state-intro');
    const spinnerWrap = document.getElementById('processing-state-spinner-wrap');
    if (introEl) introEl.style.display = 'none';
    if (spinnerWrap) spinnerWrap.style.display = 'none';
    if (panel) panel.style.display = 'flex';
    qsSetProcessingOverlayActive(true);
    if (typeof qsShowPipelineBarChrome === 'function') qsShowPipelineBarChrome();
    if (typeof qsSetUnifiedProgressPhase === 'function') qsSetUnifiedProgressPhase('warmup', qsWarmupPhasePct());
    qsStartMedicalWarmupPhaseTick({ forRecording: true });
    const wrap = document.getElementById('qs-pipeline-phase-wrap');
    if (wrap) setTimeout(() => { wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
}

function qsHideMedicalRecordingWarmupProgress() {
    if (!window.__QS_MEDICAL_RECORDING_WARMUP_BAR) return;
    window.__QS_MEDICAL_RECORDING_WARMUP_BAR = false;
    qsStopMedicalWarmupPhaseTick();
    if (window.isTriggering) return;
    const panel = document.getElementById('processing-state-panel');
    const introEl = document.getElementById('processing-state-intro');
    if (panel) panel.style.display = 'none';
    qsSetProcessingOverlayActive(false);
    if (introEl) introEl.style.display = '';
    if (typeof qsHideUnifiedProgressChrome === 'function') qsHideUnifiedProgressChrome();
}

function qsClearMedicalWarmupWaitTimer() {
    if (window.__QS_MEDICAL_WARMUP_WAIT_TIMER) {
        clearInterval(window.__QS_MEDICAL_WARMUP_WAIT_TIMER);
        window.__QS_MEDICAL_WARMUP_WAIT_TIMER = null;
    }
}

function qsStopMedicalWarmupPhaseTick() {
    if (window.__QS_MEDICAL_WARMUP_PHASE_TICK) {
        clearInterval(window.__QS_MEDICAL_WARMUP_PHASE_TICK);
        window.__QS_MEDICAL_WARMUP_PHASE_TICK = null;
    }
}

function qsStartMedicalWarmupPhaseTick(options) {
    const forRecording = !!(options && options.forRecording);
    qsStopMedicalWarmupPhaseTick();
    if (!forRecording) qsEnsureMedicalProgressPanel();
    if (typeof qsSetUnifiedProgressPhase === 'function') {
        qsSetUnifiedProgressPhase('warmup', qsWarmupPhasePct());
    }
    window.__QS_MEDICAL_WARMUP_PHASE_TICK = setInterval(() => {
        if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') {
            qsStopMedicalWarmupPhaseTick();
            if (typeof qsSetUnifiedProgressPhase === 'function') qsSetUnifiedProgressPhase('warmup', 100);
            if (window.__QS_MEDICAL_RECORDING_WARMUP_BAR && !window.isTriggering) {
                setTimeout(() => { qsHideMedicalRecordingWarmupProgress(); }, 1200);
            }
            return;
        }
        const phase = window.__QS_UNIFIED_PROGRESS_PHASE;
        if (phase === 'upload' || phase === 'transcribe' || phase === 'summary') return;
        if (phase === 'warmup' || window.__QS_MEDICAL_RECORDING_WARMUP_BAR || !window.isTriggering) {
            if (typeof qsSetUnifiedProgressPhase === 'function') qsSetUnifiedProgressPhase('warmup', qsWarmupPhasePct());
        }
    }, 1000);
}

function qsResolveMedicalWarmupWaiters() {
    const waiters = window.__QS_MEDICAL_WARMUP_WAITERS;
    if (!Array.isArray(waiters) || !waiters.length) return;
    window.__QS_MEDICAL_WARMUP_WAITERS = [];
    waiters.forEach((fn) => { try { fn(); } catch (_) {} });
}

async function qsAwaitMedicalWarmupReady(userId) {
    const uid = String(userId || window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
    if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') {
        if (typeof qsSetUnifiedProgressPhase === 'function') qsSetUnifiedProgressPhase('warmup', 100);
        return;
    }
    qsShowMedicalWarmupProgressDuringRecording();
    if (uid) {
        if (typeof qsJoinMedicalWarmupSocket === 'function') qsJoinMedicalWarmupSocket(uid);
        if (typeof qsStartMedicalWarmupPoll === 'function') qsStartMedicalWarmupPoll(uid, window.__QS_MEDICAL_WARMUP_JOB_ID);
    }
    qsClearMedicalWarmupWaitTimer();
    return new Promise((resolve) => {
        const done = () => {
            qsClearMedicalWarmupWaitTimer();
            qsStopMedicalWarmupPhaseTick();
            if (typeof qsSetUnifiedProgressPhase === 'function') qsSetUnifiedProgressPhase('warmup', 100);
            resolve();
        };
        if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') {
            done();
            return;
        }
        if (!Array.isArray(window.__QS_MEDICAL_WARMUP_WAITERS)) window.__QS_MEDICAL_WARMUP_WAITERS = [];
        window.__QS_MEDICAL_WARMUP_WAITERS.push(done);
        const tick = async () => {
            if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') {
                qsResolveMedicalWarmupWaiters();
                return;
            }
            if (typeof qsSetUnifiedProgressPhase === 'function') qsSetUnifiedProgressPhase('warmup', qsWarmupPhasePct());
            if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') qsResolveMedicalWarmupWaiters();
        };
        void tick();
        window.__QS_MEDICAL_WARMUP_WAIT_TIMER = setInterval(() => { void tick(); }, 1000);
    });
}

window.qsMedicalWarmupUserRoom = function qsMedicalWarmupUserRoom(userId) {
    const id = String(userId || '').trim();
    return id ? `medical_warmup_${id}` : '';
};

/** Idle / login: yellow warmup notification. Progress bar while upload/processing (see upload paths). */
window.qsSetMedicalWarmupBanner = function qsSetMedicalWarmupBanner(state) {
    const banner = document.getElementById('medical-warmup-banner');
    const icon = document.getElementById('medical-warmup-banner-icon');
    const text = document.getElementById('medical-warmup-banner-text');
    const subtext = document.getElementById('medical-warmup-banner-subtext');
    if (!banner || !text) return;
    const on = typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled();
    const st = String(state || '').trim().toLowerCase();
    if (!on || st === 'hidden' || st === 'idle') {
        banner.style.display = 'none';
        banner.classList.remove('is-visible', 'is-preparing', 'is-ready');
        if (subtext) subtext.textContent = '';
        return;
    }
    banner.style.display = '';
    banner.classList.add('is-visible');
    banner.classList.remove('is-preparing', 'is-ready', 'is-scaled-out');
    if (st === 'ready') {
        banner.classList.add('is-ready');
        if (icon) icon.textContent = '✅';
        const T = typeof window.t === 'function' ? window.t : function(k) { return k; };
        text.textContent = T('medical_warmup_ready_msg') || QS_MEDICAL_WARMUP_READY_MSG;
        if (subtext) subtext.textContent = '';
    } else if (st === 'scaled_out' || st === 'off') {
        qsHideMedicalWarmupBanner();
    } else {
        qsHideMedicalWarmupBanner();
    }
};

function qsMedicalEndpointReadyFromData(data) {
    if (!data) return false;
    const st = String(data.warmup_status || data.status || '').toLowerCase();
    const flaggedReady = data.endpoint_ready === true || st === 'ready';
    if (!flaggedReady) return false;
    const current = Number(data.current_instance_count);
    if (Number.isFinite(current)) return current > 0;
    return data.endpoint_ready === true;
}

/** Apply global /api/medical_endpoint_status (AWS-only: off | starting | ready). */
window.qsApplyMedicalWarmupStatusFromServer = function qsApplyMedicalWarmupStatusFromServer(data, opts) {
    opts = opts || {};
    if (!data || typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) return;
    const uid = String(window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
    const cap = data.endpoint_desired_capacity;
    let st = String(data.warmup_status || data.status || '').toLowerCase();
    const jid = String(data.warmup_job_id || data.job_id || data.jobId || '').trim();
    if (jid) window.__QS_MEDICAL_WARMUP_JOB_ID = jid;

    const localWarmupPending =
        typeof qsMedicalSessionWarmupSubmittedForUser === 'function'
        && qsMedicalSessionWarmupSubmittedForUser()
        && st !== 'ready'
        && !qsMedicalEndpointReadyFromData(data);
    if (localWarmupPending && (st === 'starting' || st === 'preparing')) {
        st = 'starting';
    }

    if (qsMedicalEndpointReadyFromData(data)) {
        qsMedicalWarmupOnReady(
            { userId: uid, jobId: jid, status: 'ready', endpoint_ready: true },
            { playChime: opts.playChime !== false }
        );
        return;
    }

    if (st === 'off' || st === 'scaled_out' || data.endpoint_scaled_down) {
        window.__QS_MEDICAL_WARMUP_STATE = 'off';
        window.__QS_MEDICAL_WARMUP_READY_LOGGED = false;
        qsSetMedicalWarmupBanner('off');
        qsStartMedicalWarmupPoll(uid, jid);
        if (typeof qsClearMedicalSessionWarmupSubmitted === 'function') {
            qsClearMedicalSessionWarmupSubmitted();
        }
        if (!window.__QS_MEDICAL_SCALED_OUT_LOGGED) {
            window.__QS_MEDICAL_SCALED_OUT_LOGGED = true;
            console.info('[medical] endpoint off (AWS)', { capacity: cap, status: st });
        }
        const waitersActive = Array.isArray(window.__QS_MEDICAL_WARMUP_WAITERS)
            && window.__QS_MEDICAL_WARMUP_WAITERS.length > 0;
        if (
            uid
            && (waitersActive || window.isTriggering)
            && !window.__QS_MEDICAL_OFF_REWARM_IN_FLIGHT
        ) {
            window.__QS_MEDICAL_OFF_REWARM_IN_FLIGHT = true;
            void qsForceMedicalSessionWarmup(uid).finally(() => {
                window.__QS_MEDICAL_OFF_REWARM_IN_FLIGHT = false;
            });
        }
        return;
    }

    window.__QS_MEDICAL_SCALED_OUT_LOGGED = false;
    if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') {
        qsMedicalWarmupOnNotReady({ userId: uid, jobId: jid }, { restartSessionWarmup: false });
    }
    window.__QS_MEDICAL_WARMUP_STATE = 'preparing';
    qsSetMedicalWarmupBanner('preparing');
    if (!window.__QS_MEDICAL_WARMUP_POLL_TIMER) qsStartMedicalWarmupPoll(uid);
};

window.qsPlayMedicalWarmupChime = function qsPlayMedicalWarmupChime() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.42);
        osc.onended = () => { try { ctx.close(); } catch (_) {} };
    } catch (_) {}
};

window.qsStopMedicalWarmupPoll = function qsStopMedicalWarmupPoll() {
    if (window.__QS_MEDICAL_WARMUP_POLL_TIMER) {
        clearInterval(window.__QS_MEDICAL_WARMUP_POLL_TIMER);
        window.__QS_MEDICAL_WARMUP_POLL_TIMER = null;
    }
    window.__QS_MEDICAL_WARMUP_POLL_KEY = '';
};

window.qsMedicalWarmupOnNotReady = function qsMedicalWarmupOnNotReady(data, opts) {
    opts = opts || {};
    const st = String((data && (data.status || data.warmup_status)) || '').toLowerCase();
    if (st === 'off' || st === 'scaled_out' || (data && data.endpoint_scaled_down)) {
        window.__QS_MEDICAL_WARMUP_STATE = 'off';
        qsSetMedicalWarmupBanner('off');
    } else {
        window.__QS_MEDICAL_WARMUP_STATE = 'preparing';
        qsSetMedicalWarmupBanner('preparing');
    }
    const uid = String(
        (data && (data.userId || data.user_id)) || window.__QS_MEDICAL_WARMUP_USER_ID || ''
    ).trim();
    const jid = String((data && (data.job_id || data.jobId)) || window.__QS_MEDICAL_WARMUP_JOB_ID || '').trim();
    if (jid) window.__QS_MEDICAL_WARMUP_JOB_ID = jid;
    if (!opts.silentLog && !window.__QS_MEDICAL_WARMUP_NOT_READY_LOGGED) {
        window.__QS_MEDICAL_WARMUP_NOT_READY_LOGGED = true;
        console.info('[medical] warmup no longer ready', data && data.invalidate_reason ? data.invalidate_reason : '');
    }
    if (typeof qsJoinMedicalEndpointScaleEvents === 'function') qsJoinMedicalEndpointScaleEvents();
    if (uid) qsStartMedicalWarmupPoll(uid, jid || window.__QS_MEDICAL_WARMUP_JOB_ID);
};

window.qsMedicalEndpointIsCold = function qsMedicalEndpointIsCold() {
    if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) return false;
    const st = String(window.__QS_MEDICAL_WARMUP_STATE || '').toLowerCase();
    return st === 'off' || st === 'scaled_out' || !st;
};

function qsShowMedicalWakeChoiceModal() {
    return new Promise((resolve) => {
        const modal = document.getElementById('medical-wake-choice-modal');
        const waitBtn = document.getElementById('medical-wake-choice-wait');
        const recordBtn = document.getElementById('medical-wake-choice-record');
        const cancelBtn = document.getElementById('medical-wake-choice-cancel');
        if (!modal || !waitBtn || !recordBtn) {
            resolve('record');
            return;
        }
        const cleanup = (choice) => {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
            waitBtn.removeEventListener('click', onWait);
            recordBtn.removeEventListener('click', onRecord);
            if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onEsc);
            resolve(choice);
        };
        const onWait = () => cleanup('wait');
        const onRecord = () => cleanup('record');
        const onCancel = () => cleanup(null);
        const onBackdrop = (e) => { if (e.target === modal) cleanup(null); };
        const onEsc = (e) => { if (e.key === 'Escape') cleanup(null); };
        waitBtn.addEventListener('click', onWait);
        recordBtn.addEventListener('click', onRecord);
        if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onEsc);
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        try { waitBtn.focus(); } catch (_) {}
    });
}

window.qsMedicalWarmupOnReady = function qsMedicalWarmupOnReady(data, opts) {
    opts = opts || {};
    const userId = String((data && (data.userId || data.user_id)) || window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
    const evtJob = String((data && (data.jobId || data.job_id)) || '').trim();
    const activeJob = String(window.__QS_MEDICAL_WARMUP_JOB_ID || '').trim();
    if (activeJob && evtJob && evtJob !== activeJob) return;
    if (data && data.endpoint_ready === false) return;
    if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') {
        qsSetMedicalWarmupBanner('ready');
        if (!window.__QS_MEDICAL_WARMUP_POLL_TIMER && userId) {
            qsStartMedicalWarmupPoll(userId, activeJob || evtJob, { intervalMs: 60000, immediate: false });
        }
        return;
    }
    window.__QS_MEDICAL_WARMUP_STATE = 'ready';
    window.__QS_MEDICAL_WARMUP_NOT_READY_LOGGED = false;
    window.__QS_MEDICAL_SCALED_OUT_LOGGED = false;
    qsClearMedicalWarmupWaitTimer();
    qsSetMedicalWarmupBanner('ready');
    if (userId) {
        qsStartMedicalWarmupPoll(userId, activeJob || evtJob, { intervalMs: 60000, immediate: false });
    }
    if (typeof qsJoinMedicalEndpointScaleEvents === 'function') qsJoinMedicalEndpointScaleEvents();
    if (window.__QS_MEDICAL_RECORDING_WARMUP_BAR && !window.isTriggering) {
        if (typeof qsSetUnifiedProgressPhase === 'function') qsSetUnifiedProgressPhase('warmup', 100);
        setTimeout(() => { qsHideMedicalRecordingWarmupProgress(); }, 1200);
    }
    qsResolveMedicalWarmupWaiters();
    if (opts.playChime !== false) qsPlayMedicalWarmupChime();
    if (!window.__QS_MEDICAL_WARMUP_READY_LOGGED) {
        window.__QS_MEDICAL_WARMUP_READY_LOGGED = true;
        console.info('[medical] GPU warmup ready', evtJob || activeJob || '');
    }
};

window.qsJoinMedicalEndpointScaleEvents = function qsJoinMedicalEndpointScaleEvents() {
    if (typeof socket === 'undefined') return;
    const room = QS_MEDICAL_ENDPOINT_EVENTS_ROOM;
    if (window.__QS_MEDICAL_ENDPOINT_EVENTS_JOINED === room) return;
    window.__QS_MEDICAL_ENDPOINT_EVENTS_JOINED = room;
    try {
        socket.emit('join', { room });
    } catch (e) {
        console.warn('[medical] endpoint scale socket join failed', e);
    }
};

window.qsJoinMedicalWarmupSocket = function qsJoinMedicalWarmupSocket(_userId) {
    if (typeof qsJoinMedicalEndpointScaleEvents === 'function') qsJoinMedicalEndpointScaleEvents();
};

window.qsForceMedicalSessionWarmup = async function qsForceMedicalSessionWarmup(userId) {
    const uid = String(userId || window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
    if (!uid) return null;
    window.__QS_MEDICAL_SESSION_WARMUP_ATTEMPTED = false;
    window.__QS_MEDICAL_WARMUP_STALE_RETRY = false;
    qsLogMedicalSessionWarmup('POST /api/medical_session_warmup (force)', { userId: uid });
    try {
        const res = await fetch('/api/medical_session_warmup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: uid, force: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && (data.status === 'ok' || data.reason === 'started' || data.reason === 'skipped_recent')) {
            const jobId = data.warmup_job_id || data.warmupJobId || null;
            qsMarkMedicalSessionWarmupSubmitted(uid, jobId, Date.now());
            if (
                (data.reason === 'already_ready' || qsMedicalEndpointReadyFromData(data))
            ) {
                qsMedicalWarmupOnReady({ userId: uid, jobId, status: 'ready' }, { playChime: false });
            } else if (window.__QS_MEDICAL_WARMUP_STATE !== 'ready') {
                window.__QS_MEDICAL_WARMUP_STATE = 'preparing';
                qsSetMedicalWarmupBanner('preparing');
                qsStartMedicalWarmupPoll(uid, jobId);
            }
        }
        return data;
    } catch (e) {
        console.warn('[medical] force session warmup failed', e);
        return null;
    }
};

window.qsPollMedicalWarmupStatus = async function qsPollMedicalWarmupStatus(userId, jobId) {
    const uid = String(userId || window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
    if (window.__QS_MEDICAL_WARMUP_STATUS_IN_FLIGHT) {
        try {
            return await window.__QS_MEDICAL_WARMUP_STATUS_IN_FLIGHT;
        } catch (_) {
            return null;
        }
    }
    const params = new URLSearchParams();
    if (uid) params.set('userId', uid);
    window.__QS_MEDICAL_WARMUP_STATUS_IN_FLIGHT = (async () => {
        try {
            const qs = params.toString();
            let abortTimer = null;
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            if (controller) {
                abortTimer = setTimeout(() => {
                    try { controller.abort(); } catch (_) {}
                }, 18000);
            }
            const res = await fetch(`/api/medical_endpoint_status${qs ? `?${qs}` : ''}`, {
                signal: controller ? controller.signal : undefined,
            });
            if (abortTimer) clearTimeout(abortTimer);
            const data = await res.json().catch(() => ({}));
            const st = String(data.warmup_status || data.status || '').toLowerCase();
            if (!res.ok) {
                window.__QS_MEDICAL_WARMUP_STATUS_FAILS = Number(window.__QS_MEDICAL_WARMUP_STATUS_FAILS || 0) + 1;
                if (
                    window.__QS_MEDICAL_WARMUP_STATUS_FAILS === 1 ||
                    window.__QS_MEDICAL_WARMUP_STATUS_FAILS % 10 === 0
                ) {
                    console.warn('[medical] warmup status unavailable', res.status);
                }
                return { status: 'unavailable', http_status: res.status, error: data.error || data.message || '' };
            }
            window.__QS_MEDICAL_WARMUP_STATUS_FAILS = 0;
            const elapsed = Number(data.elapsed_sec || 0);
            const awsCold = (data.endpoint_desired_capacity === 0 || data.endpoint_desired_capacity == null)
                && Number(data.current_instance_count || 0) <= 0
                && !data.in_service;
            const staleWarmup = res.ok && (
                (data.stale && (st === 'starting' || st === 'preparing'))
                || (st === 'off' && awsCold && elapsed > QS_MEDICAL_WARMUP_STARTING_GRACE_SEC)
            );
            if (staleWarmup && !window.__QS_MEDICAL_WARMUP_STALE_RETRY) {
                window.__QS_MEDICAL_WARMUP_STALE_RETRY = true;
                qsLogMedicalSessionWarmup('stale/off — forcing new SageMaker warmup', {
                    jobId: data.warmup_job_id || data.job_id || jobId,
                    elapsed_sec: data.elapsed_sec,
                    status: st,
                });
                if (uid) await qsForceMedicalSessionWarmup(uid);
                return data;
            }
            if (res.ok && typeof qsApplyMedicalWarmupStatusFromServer === 'function') {
                const playChime = st === 'ready' && window.__QS_MEDICAL_WARMUP_STATE !== 'ready';
                qsApplyMedicalWarmupStatusFromServer(data, { playChime });
            }
            return data;
        } catch (e) {
            window.__QS_MEDICAL_WARMUP_STATUS_FAILS = Number(window.__QS_MEDICAL_WARMUP_STATUS_FAILS || 0) + 1;
            if (
                window.__QS_MEDICAL_WARMUP_STATUS_FAILS === 1 ||
                window.__QS_MEDICAL_WARMUP_STATUS_FAILS % 10 === 0
            ) {
                console.warn('[medical] warmup status poll failed', e);
            }
            return null;
        }
    })();
    try {
        return await window.__QS_MEDICAL_WARMUP_STATUS_IN_FLIGHT;
    } finally {
        window.__QS_MEDICAL_WARMUP_STATUS_IN_FLIGHT = null;
    }
};

window.qsStartMedicalWarmupPoll = function qsStartMedicalWarmupPoll(userId, jobId, options) {
    const uid = String(userId || '').trim();
    const jid = String(jobId || '').trim();
    if (!uid) return;
    const intervalMs = (options && options.intervalMs) || 15000;
    const pollKey = `${uid}|${jid}|${intervalMs}`;
    if (window.__QS_MEDICAL_WARMUP_POLL_TIMER && window.__QS_MEDICAL_WARMUP_POLL_KEY === pollKey) {
        return;
    }
    qsStopMedicalWarmupPoll();
    window.__QS_MEDICAL_WARMUP_POLL_KEY = pollKey;
    const poll = () => { void qsPollMedicalWarmupStatus(uid, jid); };
    if (!options || options.immediate !== false) poll();
    window.__QS_MEDICAL_WARMUP_POLL_TIMER = setInterval(poll, intervalMs);
};

window.qsInitMedicalWarmupUi = async function qsInitMedicalWarmupUi(user, opts) {
    opts = opts || {};
    if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) return;
    if (!user || !user.id) return;
    window.__QS_MEDICAL_WARMUP_USER_ID = user.id;
    if (typeof qsJoinMedicalEndpointScaleEvents === 'function') qsJoinMedicalEndpointScaleEvents();
    window.__QS_MEDICAL_WARMUP_UI_INIT_USER = user.id;
    qsJoinMedicalWarmupSocket(user.id);
    if (!opts.skipInitialPoll && window.__QS_MEDICAL_WARMUP_STATE !== 'ready') {
        if (!window.__QS_MEDICAL_WARMUP_STATE) {
            window.__QS_MEDICAL_WARMUP_STATE = 'off';
            qsSetMedicalWarmupBanner('off');
        }
    }
};

function qsMedicalSessionWarmupSubmittedForUser(_userId) {
    if (window.__QS_MEDICAL_SESSION_WARMUP_ATTEMPTED) return true;
    try {
        const raw = sessionStorage.getItem(QS_MEDICAL_ENDPOINT_WARMUP_SUBMITTED_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return !!(parsed && parsed.at && (Date.now() - Number(parsed.at)) < QS_MEDICAL_WARMUP_SESSION_MS);
    } catch (_) {
        return false;
    }
}

function qsMarkMedicalSessionWarmupSubmitted(_userId, jobId, atMs) {
    const at = Number(atMs) || Date.now();
    window.__QS_MEDICAL_SESSION_WARMUP_ATTEMPTED = true;
    window.__QS_MEDICAL_WARMUP_STARTED_AT = at;
    if (jobId) window.__QS_MEDICAL_WARMUP_JOB_ID = jobId;
    try {
        sessionStorage.setItem(QS_MEDICAL_ENDPOINT_WARMUP_SUBMITTED_KEY, JSON.stringify({
            at,
            jobId: jobId || null,
        }));
    } catch (_) {}
}

function qsClearMedicalSessionWarmupSubmitted() {
    window.__QS_MEDICAL_SESSION_WARMUP_ATTEMPTED = false;
    window.__QS_MEDICAL_WARMUP_RESUME_LOGGED = false;
    window.__QS_MEDICAL_WARMUP_STARTED_LOGGED = false;
    try {
        sessionStorage.removeItem(QS_MEDICAL_ENDPOINT_WARMUP_SUBMITTED_KEY);
    } catch (_) {}
}

function qsMedicalServerNeedsSessionWarmup(data) {
    if (!data) return true;
    if (qsMedicalEndpointReadyFromData(data)) return false;
    const st = String(data.warmup_status || data.status || '').toLowerCase();
    if (st === 'off' || st === 'scaled_out' || data.endpoint_scaled_down) return true;
    if (data.stale === true) return true;
    if (st === 'starting' || st === 'preparing') return false;
    return true;
}

/** Server says scale-up is in progress (not stale/off) — safe to poll without re-POST. */
function qsMedicalWarmupConfidentlyInFlight(statusData) {
    if (!statusData || qsMedicalEndpointReadyFromData(statusData)) return false;
    if (statusData.stale === true) return false;
    const st = String(statusData.warmup_status || statusData.status || '').toLowerCase();
    if (st === 'off' || st === 'scaled_out' || statusData.endpoint_scaled_down) return false;
    if (st !== 'starting' && st !== 'preparing') return false;
    if (!statusData.warmup_job_id) return false;
    const cap = statusData.endpoint_desired_capacity;
    const current = Number(statusData.current_instance_count || 0);
    const awsCold = (cap === 0 || cap === null) && current <= 0 && !statusData.in_service;
    if (awsCold) {
        const elapsed = Number(statusData.elapsed_sec || 0);
        if (elapsed > QS_MEDICAL_WARMUP_STARTING_GRACE_SEC) return false;
    }
    return true;
}

function qsMedicalResetSessionWarmupForNewSession() {
    qsClearMedicalSessionWarmupSubmitted();
    window.__QS_MEDICAL_WARMUP_STALE_RETRY = false;
    window.__QS_MEDICAL_WARMUP_STATE = 'off';
    window.__QS_MEDICAL_WARMUP_READY_LOGGED = false;
    window.__QS_MEDICAL_SCALED_OUT_LOGGED = false;
    qsSetMedicalWarmupBanner('off');
}

/** Full fresh medical entry — same as clicking the logo (reload /medical, all in-memory state cleared). */
function qsMedicalHardResetToEntry() {
    qsStopMedicalWarmupPoll();
    qsClearMedicalWarmupWaitTimer();
    qsStopMedicalWarmupPhaseTick();
    window.__QS_MEDICAL_RECORDING_WARMUP_BAR = false;
    window.__QS_MEDICAL_SESSION_WARMUP_PROMISE = null;
    window.__QS_MEDICAL_STATUS_REFRESH_PROMISE = null;
    window._medicalWarmupSession = null;
    window._medicalWarmupPromise = null;
    window._medicalWarmupToken = Number(window._medicalWarmupToken || 0) + 1;
    if (typeof window.qsDismissActiveJob === 'function') {
        window.qsDismissActiveJob();
    }
    try { sessionStorage.removeItem(QS_MEDICAL_ENDPOINT_WARMUP_SUBMITTED_KEY); } catch (_) {}
    try { localStorage.setItem(QS_MEDICAL_MODE_KEY, '1'); } catch (_) {}
    window.location.assign('/medical');
}

function qsLogMedicalSessionWarmup(msg, detail) {
    try {
        const extra = detail && typeof detail === 'object' ? detail : (detail != null ? { detail } : {});
        console.info('[medical] session warmup:', msg, Object.assign({ ts: new Date().toISOString() }, extra));
    } catch (_) {
        console.info('[medical] session warmup:', msg);
    }
}

/** Single in-flight warmup POST (mic press only — not on page load). */
async function qsMaybeMedicalSessionWarmupOnce() {
    let user = null;
    try {
        const { data: { user: u } } = await supabase.auth.getUser();
        user = u;
    } catch (e) {
        if (!window.__QS_MEDICAL_WARMUP_SKIP_LOGGED) {
            window.__QS_MEDICAL_WARMUP_SKIP_LOGGED = true;
            qsLogMedicalSessionWarmup('skipped — auth error', { err: String((e && e.message) || e) });
        }
        return;
    }
    if (!user || !user.id) {
        if (!window.__QS_MEDICAL_WARMUP_SKIP_LOGGED) {
            window.__QS_MEDICAL_WARMUP_SKIP_LOGGED = true;
            qsLogMedicalSessionWarmup('skipped — not signed in');
        }
        return;
    }

    await qsInitMedicalWarmupUi(user, { skipInitialPoll: true });

    let statusData = null;
    try {
        statusData = await qsPollMedicalWarmupStatus(user.id, window.__QS_MEDICAL_WARMUP_JOB_ID);
        if (statusData && typeof qsApplyMedicalWarmupStatusFromServer === 'function') {
            statusData.userId = user.id;
            qsApplyMedicalWarmupStatusFromServer(statusData, { playChime: false });
        }
    } catch (_) {}

    if (window.__QS_MEDICAL_WARMUP_STATE === 'ready' || qsMedicalEndpointReadyFromData(statusData)) {
        return;
    }

    const warmupInFlight = qsMedicalWarmupConfidentlyInFlight(statusData);
    const locallySubmitted = qsMedicalSessionWarmupSubmittedForUser(user.id);

    if (warmupInFlight) {
        try {
            const subRaw = sessionStorage.getItem(QS_MEDICAL_SESSION_WARMUP_SUBMITTED_KEY);
            if (subRaw) {
                const parsed = JSON.parse(subRaw);
                if (parsed && parsed.at) window.__QS_MEDICAL_WARMUP_STARTED_AT = Number(parsed.at);
                if (parsed && parsed.jobId) window.__QS_MEDICAL_WARMUP_JOB_ID = parsed.jobId;
            }
        } catch (_) {}
        if (statusData && statusData.warmup_job_id) {
            window.__QS_MEDICAL_WARMUP_JOB_ID = statusData.warmup_job_id;
        }
        window.__QS_MEDICAL_WARMUP_STATE = 'preparing';
        qsSetMedicalWarmupBanner('preparing');
        qsStartMedicalWarmupPoll(user.id, window.__QS_MEDICAL_WARMUP_JOB_ID, { intervalMs: 15000 });
        qsLogMedicalSessionWarmup('poll only — warmup in flight', {
            status: statusData && statusData.status,
            warmupJobId: statusData && statusData.warmup_job_id,
        });
        return;
    }

    if (locallySubmitted) {
        qsClearMedicalSessionWarmupSubmitted();
        qsLogMedicalSessionWarmup('re-warm — local marker without server in-flight', {
            status: statusData && statusData.status,
            capacity: statusData && statusData.endpoint_desired_capacity,
        });
    }

    window.__QS_MEDICAL_WARMUP_STATE = 'preparing';
    qsSetMedicalWarmupBanner('preparing');
    qsLogMedicalSessionWarmup('POST /api/medical_session_warmup', { userId: user.id });
    try {
        const stPre = statusData
            ? String(statusData.warmup_status || statusData.status || '').toLowerCase()
            : '';
        const serverNeedsWarmup = qsMedicalServerNeedsSessionWarmup(statusData);
        const forceWarmup = serverNeedsWarmup && (
            stPre === 'off' || stPre === 'scaled_out' || !!(statusData && statusData.endpoint_scaled_down)
        );
        const res = await fetch('/api/medical_session_warmup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id, force: forceWarmup || undefined }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && (data.status === 'ok' || data.reason === 'skipped_recent' || data.reason === 'already_ready')) {
            const jobId = data.warmup_job_id || data.warmupJobId || null;
            qsMarkMedicalSessionWarmupSubmitted(user.id, jobId, Date.now());
            if (data.reason === 'already_ready' || qsMedicalEndpointReadyFromData(data)) {
                qsMedicalWarmupOnReady(
                    {
                        userId: user.id,
                        jobId,
                        status: 'ready',
                        endpoint_ready: true,
                        current_instance_count: data.current_instance_count,
                    },
                    { playChime: false }
                );
                qsLogMedicalSessionWarmup('ready', { reason: data.reason, jobId });
            } else if (data.reason === 'started' || data.reason === 'skipped_recent') {
                window.__QS_MEDICAL_WARMUP_STATE = 'preparing';
                qsSetMedicalWarmupBanner('preparing');
                qsStartMedicalWarmupPoll(user.id, jobId);
                if (!window.__QS_MEDICAL_WARMUP_STARTED_LOGGED) {
                    window.__QS_MEDICAL_WARMUP_STARTED_LOGGED = true;
                    qsLogMedicalSessionWarmup('active', {
                        reason: data.reason,
                        endpoint: data.endpoint || '',
                        jobId: jobId || '',
                        engine: data.engine || '',
                    });
                }
            }
        } else if (data.reason === 'sagemaker_not_configured' || data.reason === 'simulation_without_sagemaker') {
            qsSetMedicalWarmupBanner('hidden');
            qsLogMedicalSessionWarmup('unavailable on server', { reason: data.reason, http: res.status });
        } else {
            qsLogMedicalSessionWarmup('API declined', { http: res.status, reason: data.reason, message: data.message });
        }
    } catch (e) {
        console.warn('[medical] session warmup failed', e);
    }
}

/** Poll AWS endpoint status on load — no warmup POST until user presses mic. */
async function qsRefreshMedicalEndpointStatusOnce() {
    let user = null;
    try {
        const { data: { user: u } } = await supabase.auth.getUser();
        user = u;
    } catch (_) {
        return;
    }
    if (!user || !user.id) return;

    await qsInitMedicalWarmupUi(user, { skipInitialPoll: true });

    let statusData = null;
    try {
        statusData = await qsPollMedicalWarmupStatus(user.id, window.__QS_MEDICAL_WARMUP_JOB_ID);
        if (statusData && typeof qsApplyMedicalWarmupStatusFromServer === 'function') {
            statusData.userId = user.id;
            qsApplyMedicalWarmupStatusFromServer(statusData, { playChime: false });
        }
    } catch (_) {}

    const st = statusData
        ? String(statusData.warmup_status || statusData.status || '').toLowerCase()
        : String(window.__QS_MEDICAL_WARMUP_STATE || '').toLowerCase();
    const warmupInFlight =
        typeof qsMedicalSessionWarmupSubmittedForUser === 'function'
        && qsMedicalSessionWarmupSubmittedForUser(user.id)
        && (st === 'starting' || st === 'preparing' || window.__QS_MEDICAL_WARMUP_STATE === 'preparing');

    if (warmupInFlight) {
        try {
            const subRaw = sessionStorage.getItem(QS_MEDICAL_SESSION_WARMUP_SUBMITTED_KEY);
            if (subRaw) {
                const parsed = JSON.parse(subRaw);
                if (parsed && parsed.at) window.__QS_MEDICAL_WARMUP_STARTED_AT = Number(parsed.at);
                if (parsed && parsed.jobId) window.__QS_MEDICAL_WARMUP_JOB_ID = parsed.jobId;
            }
        } catch (_) {}
        window.__QS_MEDICAL_WARMUP_STATE = 'preparing';
        qsSetMedicalWarmupBanner('preparing');
    }

    if (!window.__QS_MEDICAL_WARMUP_POLL_TIMER) {
        qsStartMedicalWarmupPoll(
            user.id,
            window.__QS_MEDICAL_WARMUP_JOB_ID,
            { intervalMs: window.__QS_MEDICAL_WARMUP_STATE === 'ready' ? 60000 : 30000 }
        );
    }
}

/** Wake SageMaker when user presses mic (not on page load). */
window.qsMaybeMedicalSessionWarmup = function qsMaybeMedicalSessionWarmup() {
    if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) {
        return Promise.resolve();
    }
    if (window.__QS_MEDICAL_SESSION_WARMUP_PROMISE) {
        return window.__QS_MEDICAL_SESSION_WARMUP_PROMISE;
    }
    window.__QS_MEDICAL_SESSION_WARMUP_PROMISE = qsMaybeMedicalSessionWarmupOnce().finally(() => {
        window.__QS_MEDICAL_SESSION_WARMUP_PROMISE = null;
    });
    return window.__QS_MEDICAL_SESSION_WARMUP_PROMISE;
};

window.qsRefreshMedicalEndpointStatus = function qsRefreshMedicalEndpointStatus() {
    if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) {
        return Promise.resolve();
    }
    if (window.__QS_MEDICAL_STATUS_REFRESH_PROMISE) {
        return window.__QS_MEDICAL_STATUS_REFRESH_PROMISE;
    }
    window.__QS_MEDICAL_STATUS_REFRESH_PROMISE = qsRefreshMedicalEndpointStatusOnce().finally(() => {
        window.__QS_MEDICAL_STATUS_REFRESH_PROMISE = null;
    });
    return window.__QS_MEDICAL_STATUS_REFRESH_PROMISE;
};

function _isLikelyIOSDevice() {
    const ua = String(navigator.userAgent || navigator.vendor || '').toLowerCase();
    return /iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

function _isLikelyIOSSafariBrowser() {
    if (!_isLikelyIOSDevice()) return false;
    const ua = String(navigator.userAgent || navigator.vendor || '').toLowerCase();
    const isKnownIOSBrowser = /safari/.test(ua) && !/crios|fxios|edgios|opios|opr\//.test(ua);
    const isKnownInApp = /fban|fbav|instagram|line\/|micromessenger|gsa\//.test(ua);
    return isKnownIOSBrowser && !isKnownInApp;
}

function _isLikelyIOSInAppBrowser() {
    if (!_isLikelyIOSDevice()) return false;
    const ua = String(navigator.userAgent || navigator.vendor || '').toLowerCase();
    const isKnownIOSBrowser = /safari/.test(ua) && !/crios|fxios|edgios|opr\//.test(ua);
    const isKnownInApp = /fban|fbav|instagram|line\/|micromessenger|gsa\//.test(ua);
    return isKnownInApp || !isKnownIOSBrowser;
}

/** iOS Safari private browsing — session/cookies can be slower but still work in-tab. */
function qsIsIOSPrivateSafari() {
    if (!_isLikelyIOSSafariBrowser()) return Promise.resolve(false);
    if (typeof window.webkitRequestFileSystem === 'function') {
        return new Promise((resolve) => {
            try {
                window.webkitRequestFileSystem(
                    window.TEMPORARY,
                    1,
                    () => resolve(false),
                    () => resolve(true)
                );
            } catch (_) {
                resolve(false);
            }
        });
    }
    try {
        localStorage.setItem('__qs_private_probe__', '1');
        localStorage.removeItem('__qs_private_probe__');
        return Promise.resolve(false);
    } catch (_) {
        return Promise.resolve(true);
    }
}

function qsOAuthCodeFromCurrentUrl() {
    try {
        const search = new URLSearchParams(window.location.search || '');
        const code = String(search.get('code') || '').trim();
        if (code) return code;
    } catch (_) {}
    try {
        const hash = String(window.location.hash || '').replace(/^#/, '');
        if (!hash) return '';
        const params = new URLSearchParams(hash);
        return String(params.get('code') || '').trim();
    } catch (_) {}
    return '';
}

/** PKCE exchange can lag behind detectSessionInUrl on iOS private — exchange explicitly when ?code= is present. */
async function qsTryExchangeOAuthCodeFromUrl() {
    const code = qsOAuthCodeFromCurrentUrl();
    if (!code) return false;
    try {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (error || !data || !data.session || !data.session.user) return false;
        try { window.__QS_OAUTH_CALLBACK_RESOLVED = true; } catch (_) {}
        return true;
    } catch (_) {
        return false;
    }
}

async function qsPollForOAuthSession(maxMs, intervalMs) {
    const limit = Math.max(0, Number(maxMs) || 0);
    const step = Math.max(150, Number(intervalMs) || 400);
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session && session.user) return true;
        } catch (_) {}
        if (window.__QS_OAUTH_CALLBACK_RESOLVED) return true;
        await new Promise((resolve) => setTimeout(resolve, step));
    }
    return false;
}

function qsOAuthRedirectTo() {
    try {
        const loc = window.location;
        const origin = String(loc.origin || '').trim();
        let path = String(loc.pathname || '/');
        if (!path.startsWith('/')) path = '/' + path;
        return origin ? (origin + path) : path;
    } catch (_) {
        return String(window.location.origin || '/');
    }
}

function qsCleanOAuthUrlFromHistory() {
    try {
        const u = new URL(window.location.href);
        ['code', 'error', 'error_description', 'state'].forEach((k) => u.searchParams.delete(k));
        const q = u.searchParams.toString();
        const clean = u.pathname + (q ? '?' + q : '');
        window.history.replaceState({}, document.title, clean || '/');
    } catch (_) {
        try {
            if (window.location.hash && /(?:access_token|refresh_token|error)/.test(window.location.hash)) {
                window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
            }
        } catch (__) {}
    }
}

function qsShowOAuthMessage(message, isError) {
    if (typeof showStatus === 'function') {
        showStatus(message, !!isError, { duration: isError ? 10000 : 6000, toastPosition: 'center' });
    }
}

function qsShowOAuthCallbackFailedMessage(isIosPrivate) {
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    const msg = isIosPrivate
        ? T('auth_oauth_callback_failed_private')
        : T('auth_oauth_callback_failed');
    qsShowOAuthMessage(msg || (isIosPrivate
        ? 'Sign-in failed in iPhone private browsing. Use a normal Safari tab.'
        : 'Sign-in could not be completed. Please try again.'), true);
}

/** @returns {Promise<boolean>} always true — private Safari works but may be slower */
async function qsMaybeWarnIOSPrivateBeforeOAuth() {
    const isPrivate = await qsIsIOSPrivateSafari();
    if (!isPrivate) return true;
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    qsShowOAuthMessage(
        T('auth_ios_private_sign_in') || 'Private browsing can be slower to sign in. After Google, wait on this page until the modal closes.',
        false
    );
    return true;
}

/** Wait for Supabase to finish PKCE / detectSessionInUrl (iOS private can be slow). */
async function qsWaitForOAuthSessionAfterRedirect(timeoutMs) {
    const limit = Math.max(3000, Number(timeoutMs) || 8000);
    return new Promise((resolve) => {
        let settled = false;
        let sub = null;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            try { sub?.unsubscribe(); } catch (_) {}
            clearTimeout(timer);
            resolve(!!ok);
        };
        const timer = setTimeout(async () => {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                finish(!!(session && session.user));
            } catch (_) {
                finish(false);
            }
        }, limit);
        try {
            const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
                if (!session || !session.user) return;
                if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
                    finish(true);
                }
            });
            sub = subscription;
        } catch (_) {}
        void supabase.auth.getSession().then(({ data: { session } }) => {
            if (session && session.user) finish(true);
        }).catch(() => {});
    });
}

/** If OAuth already completed (e.g. slow callback), finish UI without another redirect. */
async function qsCompleteAuthIfAlreadySignedIn() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session || !session.user) return false;
        try { window.__QS_OAUTH_CALLBACK_RESOLVED = true; } catch (_) {}
        if (typeof setupNavbarAuth === 'function') await setupNavbarAuth(session.user);
        if (typeof window.toggleModal === 'function') window.toggleModal(false);
        qsCleanOAuthUrlFromHistory();
        return true;
    } catch (_) {
        return false;
    }
}

async function qsHandleOAuthReturnIfNeeded() {
    if (!qsCurrentUrlLooksLikeAuthCallback()) return;
    let oauthErr = '';
    try {
        const search = new URLSearchParams(window.location.search || '');
        oauthErr = String(search.get('error_description') || search.get('error') || '').trim();
    } catch (_) {}
    if (oauthErr) {
        const T = typeof window.t === 'function' ? window.t : (k) => k;
        qsShowOAuthMessage(
            (T('auth_oauth_error') || 'Sign-in error') + ': ' + oauthErr,
            true
        );
        qsCleanOAuthUrlFromHistory();
        return;
    }

    const isPrivate = await qsIsIOSPrivateSafari();
    const isIos = _isLikelyIOSDevice();
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    if (isIos || isPrivate) {
        qsShowOAuthMessage(
            T('auth_oauth_completing') || 'Completing sign-in…',
            false
        );
    }

    const finishOAuthSuccess = async () => {
        qsCleanOAuthUrlFromHistory();
        if (typeof setupNavbarAuth === 'function') {
            try { await setupNavbarAuth(); } catch (_) {}
        }
    };

    if (await qsTryExchangeOAuthCodeFromUrl()) {
        await finishOAuthSuccess();
        return;
    }

    const waitMs = isPrivate ? 32000 : (isIos ? 20000 : 9000);
    let ok = await qsWaitForOAuthSessionAfterRedirect(waitMs);
    if (ok || window.__QS_OAUTH_CALLBACK_RESOLVED) {
        await finishOAuthSuccess();
        return;
    }

    if (await qsTryExchangeOAuthCodeFromUrl()) {
        await finishOAuthSuccess();
        return;
    }

    if (isIos || isPrivate) {
        ok = await qsPollForOAuthSession(isPrivate ? 18000 : 12000, 400);
        if (ok || window.__QS_OAUTH_CALLBACK_RESOLVED) {
            await finishOAuthSuccess();
            return;
        }
    }

    if (await qsCompleteAuthIfAlreadySignedIn()) return;

    if (!qsCurrentUrlLooksLikeAuthCallback()) return;
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session && session.user) {
            qsCleanOAuthUrlFromHistory();
            return;
        }
    } catch (_) {}

    qsShowOAuthCallbackFailedMessage(isPrivate);
    qsCleanOAuthUrlFromHistory();
}

async function maybeShowIOSOpenInSafariHintAfterSignIn() {
    if (!_isLikelyIOSInAppBrowser()) return;
    const now = Date.now();
    try {
        const last = Number(localStorage.getItem(QS_IOS_SAFARI_HINT_TS_KEY) || 0);
        // Show at most once every 12h per browser.
        if (Number.isFinite(last) && last > 0 && (now - last) < (12 * 60 * 60 * 1000)) return;
    } catch (_) {}
    const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
    const msg = isHebrewUi
        ? 'כדי שההתחברות תישמר גם אחרי סגירת הדפדפן באייפון, מומלץ לפתוח את QuickScribe ב-Safari (ולא בדפדפן פנימי של האפליקציה).'
        : 'To keep sign-in after closing the browser on iPhone, open QuickScribe in Safari (not an in-app browser).';
    const openSafariText = isHebrewUi ? 'פתח ב-Safari' : 'Open in Safari';
    const stayText = isHebrewUi ? 'הישאר כאן' : 'Stay here';
    let openSafari = false;
    try {
        openSafari = await showGlobalConfirm(msg, { confirmText: openSafariText, cancelText: stayText });
    } catch (_) {
        return;
    } finally {
        try { localStorage.setItem(QS_IOS_SAFARI_HINT_TS_KEY, String(now)); } catch (_) {}
    }
    if (!openSafari) return;
    const target = String(window.location.href || '').split('#')[0];
    try {
        const schemeUrl = target.replace(/^https:\/\//i, 'x-safari-https://').replace(/^http:\/\//i, 'x-safari-http://');
        window.location.href = schemeUrl;
    } catch (_) {
        try { window.open(target, '_blank'); } catch (__) {}
    }
}

/** Medical / HIPAA pipeline stores recordings under raw-audio (e.g. audio-only WebM from MediaRecorder). */
function isMedicalLayoutRawAudioKey(s3Key) {
    return String(s3Key || '').includes('/raw-audio/');
}

const QS_AUDIO_FILE_EXTENSIONS = /\.(m4a|mp3|wav|aac|ogg|flac|weba|caf)$/i;
const QS_VIDEO_FILE_EXTENSIONS = /\.(mp4|mov|webm|m4v|mkv|avi|mpeg|mpg|wmv|flv)$/i;

function qsUploadFileName(fileOrName) {
    return String(typeof fileOrName === 'string' ? fileOrName : (fileOrName && fileOrName.name) || '');
}

function qsUploadFileMime(fileOrName) {
    return String(typeof fileOrName === 'string' ? '' : (fileOrName && fileOrName.type) || '').toLowerCase();
}

/** True for common audio uploads; extension wins over mislabeled video/mp4 (common for .m4a). */
function qsIsAudioMediaFile(fileOrName, mimeOptional) {
    const name = qsUploadFileName(fileOrName);
    const mime = String(mimeOptional != null ? mimeOptional : qsUploadFileMime(fileOrName)).toLowerCase();
    if (QS_AUDIO_FILE_EXTENSIONS.test(name)) return true;
    if (mime.startsWith('audio/')) return true;
    return false;
}

function qsIsVideoMediaFile(fileOrName, mimeOptional) {
    if (qsIsAudioMediaFile(fileOrName, mimeOptional)) return false;
    const name = qsUploadFileName(fileOrName);
    const mime = String(mimeOptional != null ? mimeOptional : qsUploadFileMime(fileOrName)).toLowerCase();
    return mime.startsWith('video/') || QS_VIDEO_FILE_EXTENSIONS.test(name);
}

function qsGuessUploadMimeType(fileOrName, fallback) {
    const name = qsUploadFileName(fileOrName);
    const mime = qsUploadFileMime(fileOrName);
    if (/\.m4a$/i.test(name)) return (mime && mime.startsWith('audio/')) ? mime : 'audio/mp4';
    if (/\.mp3$/i.test(name)) return mime || 'audio/mpeg';
    if (/\.wav$/i.test(name)) return mime || 'audio/wav';
    if (/\.aac$/i.test(name)) return mime || 'audio/aac';
    if (/\.ogg$/i.test(name)) return mime || 'audio/ogg';
    if (/\.flac$/i.test(name)) return mime || 'audio/flac';
    if (/\.webm$/i.test(name) && qsIsAudioMediaFile(fileOrName)) return mime || 'audio/webm';
    if (/\.mp4$/i.test(name) && qsIsAudioMediaFile(fileOrName)) return mime || 'audio/mp4';
    return mime || fallback || 'application/octet-stream';
}

function qsMimeForAudioElement(fileOrName, mimeOptional) {
    const name = qsUploadFileName(fileOrName);
    const mime = String(mimeOptional != null ? mimeOptional : qsUploadFileMime(fileOrName)).toLowerCase();
    if (/\.m4a$/i.test(name) || mime.includes('m4a')) return 'audio/mp4';
    if (/\.mp3$/i.test(name) || mime.includes('mpeg')) return 'audio/mpeg';
    if (/\.wav$/i.test(name)) return 'audio/wav';
    if (/\.ogg$/i.test(name)) return 'audio/ogg';
    if (/\.webm$/i.test(name)) return 'audio/webm';
    if (/\.aac$/i.test(name)) return 'audio/aac';
    if (/\.flac$/i.test(name)) return 'audio/flac';
    if (mime.startsWith('audio/')) return mime;
    return 'audio/mp4';
}

/** Canonical transcript JSON S3 key from input media key (matches siteapp `_derive_output_key_base` + `.json`). */
function deriveTranscriptJsonKeyFromInputS3Key(inputKey) {
    const s = String(inputKey || '').trim();
    if (!s) return '';
    if (s.includes('/input/')) {
        return s.replace('/input/', '/output/', 1).replace(/\.[^/.]+$/i, '.json');
    }
    if (s.includes('/raw-audio/')) {
        return s.replace('/raw-audio/', '/summaries/', 1).replace(/\.[^/.]+$/i, '.json');
    }
    return s.replace(/\.[^/.]+$/i, '.json');
}

function _s3KeyBasenameStem(key) {
    const part = String(key || '').trim().split('/').pop() || '';
    return part.replace(/\.[^.]+$/i, '');
}

/** True when `resultKey` is the JSON that corresponds to `inputKey` (full key or same filename stem). */
function transcriptResultKeyMatchesInput(inputKey, resultKey) {
    const exp = deriveTranscriptJsonKeyFromInputS3Key(inputKey);
    const r = String(resultKey || '').trim();
    if (!exp || !r) return false;
    if (r === exp) return true;
    try {
        if (decodeURIComponent(r) === decodeURIComponent(exp)) return true;
    } catch (_) {}
    return _s3KeyBasenameStem(r) === _s3KeyBasenameStem(exp);
}

/** Load transcript JSON from S3 via presigned URL (same path as Personal / ?open=). */
async function qsFetchTranscriptJsonFromS3Key(resultS3Key) {
    const key = String(resultS3Key || '').trim();
    if (!key || typeof supabase === 'undefined' || !supabase.auth) return null;
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || !user.id) return null;
        const urlRes = await fetch('/api/get_presigned_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                s3Key: key,
                userId: user.id,
                isMedical: typeof isMedicalModeEnabled === 'function' ? isMedicalModeEnabled() : false,
            }),
        });
        const urlJson = await urlRes.json().catch(() => ({}));
        if (!urlJson.url) return null;
        return await fetch(urlJson.url).then((r) => r.json()).catch(() => null);
    } catch (_) {
        return null;
    }
}

/** Apply words/captions/segments from a transcript JSON object; returns segment list used for render. */
function qsApplyTranscriptPayloadFromJson(tr) {
    if (!tr || typeof tr !== 'object') return [];
    const trFmt = typeof pickFormattedFromObject === 'function' ? pickFormattedFromObject(tr) : null;
    if (trFmt) {
        window.currentFormattedDoc = trFmt;
        window._qsDocPreferSegmentsAfterEdit = false;
    }
    if (Array.isArray(tr.words) && Array.isArray(tr.captions) && tr.words.length > 0 && tr.captions.length > 0) {
        window.currentWords = tr.words;
        window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, tr.captions, 54);
        window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        return window.currentSegments;
    }
    let segments = Array.isArray(tr.segments) ? tr.segments : [];
    if (segments.length) {
        const model = _tryBuildWordModelFromSegmentsAndFlat(segments, tr.word_segments);
        if (model) {
            window.currentWords = model.words;
            window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, model.captions, 54);
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            return window.currentSegments;
        }
        window.currentWords = null;
        window.currentCaptions = null;
        window.currentSegments = splitLongSegments(segments, 40);
        return window.currentSegments;
    }
    return [];
}

/** Jobs row canonical result_s3_key (set after gpu_callback background persist). */
async function qsFetchJobResultS3KeyFromDb(runpodJobId) {
    const jid = String(runpodJobId || '').trim();
    if (!jid || typeof supabase === 'undefined' || !supabase.auth) return '';
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || !user.id) return '';
        const { data: row, error } = await supabase
            .from('jobs')
            .select('result_s3_key, metadata')
            .eq('runpod_job_id', jid)
            .eq('user_id', user.id)
            .maybeSingle();
        if (error || !row) return '';
        const direct = String(row.result_s3_key || '').trim();
        if (direct) return direct;
        const md = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
        return String(md.result_s3_key || md.resultS3Key || '').trim();
    } catch (_) {
        return '';
    }
}

/** Ordered S3 keys for transcript JSON (canonical output/ first; deprioritize worker input/ paths). */
function qsCollectTranscriptHydrateKeys(rawResult, inputS3Key, dbResultKey) {
    const raw = rawResult || {};
    const nested = raw.result || raw.output || {};
    const derived = deriveTranscriptJsonKeyFromInputS3Key(inputS3Key);
    const keys = [];
    const push = (k) => {
        const s = String(k || '').trim();
        if (!s || keys.includes(s)) return;
        keys.push(s);
    };
    push(dbResultKey);
    push(derived);
    push(nested.result_s3_key);
    push(raw.result_s3_key);
    for (const k of [raw.outputKey, nested.outputKey]) {
        const s = String(k || '').trim();
        if (!s) continue;
        if (derived && s.includes('/input/') && s !== derived) continue;
        push(s);
    }
    return keys;
}

/** When socket/check_status omits segments, load transcript JSON from S3 (with retries for post-persist race). */
async function qsHydrateSegmentsForCompletedJob(rawResult, inputS3Key, opts) {
    const jobId = rawResult && (rawResult.jobId || (rawResult.result && rawResult.result.jobId));
    const dbKey = (opts && opts.dbResultKey) || await qsFetchJobResultS3KeyFromDb(jobId);
    const keys = qsCollectTranscriptHydrateKeys(rawResult, inputS3Key, dbKey);
    for (let i = 0; i < keys.length; i++) {
        const tr = await qsFetchTranscriptJsonFromS3Key(keys[i]);
        if (!tr) {
            console.info('[qs] hydrate miss (no JSON)', { resultKey: keys[i] });
            continue;
        }
        const segs = qsApplyTranscriptPayloadFromJson(tr);
        if (segs && segs.length) {
            console.info('[qs] hydrated transcript from S3', { resultKey: keys[i], segments: segs.length });
            return segs;
        }
        const segLen = Array.isArray(tr.segments) ? tr.segments.length : 0;
        const wordLen = Array.isArray(tr.words) ? tr.words.length : 0;
        console.info('[qs] hydrate JSON empty', { resultKey: keys[i], segments: segLen, words: wordLen });
    }
    return [];
}

/** Site persists transcript to S3 in a background thread after the first socket — retry hydrate. */
async function qsHydrateSegmentsWithRetry(rawResult, inputS3Key) {
    const delays = [0, 2500, 6000, 12000, 20000];
    let dbResultKey = '';
    for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt] > 0) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
        }
        if (!dbResultKey) {
            dbResultKey = await qsFetchJobResultS3KeyFromDb(
                rawResult && (rawResult.jobId || (rawResult.result && rawResult.result.jobId))
            );
        }
        const segs = await qsHydrateSegmentsForCompletedJob(rawResult, inputS3Key, { dbResultKey });
        if (segs && segs.length) {
            if (attempt > 0) {
                console.info('[qs] hydrated transcript after retry', { attempt: attempt + 1, segments: segs.length });
            }
            return segs;
        }
    }
    return [];
}

function qsTranslateOr(key, fallback) {
    if (typeof window.t !== 'function') return fallback;
    const v = window.t(key);
    return v && v !== key ? v : fallback;
}

/** True only after a completed job returned no segments (not on fresh / pre-upload UI). */
function qsShouldShowEmptyTranscriptNotice() {
    return !!window._qsShowEmptyTranscriptNotice;
}

function qsClearTranscriptWindowIdle() {
    const transcriptWindow = document.getElementById('transcript-window');
    if (!transcriptWindow) return;
    transcriptWindow.innerHTML = '';
    transcriptWindow.contentEditable = 'false';
}

/** Reset edit/timing chrome so a new session or re-render does not leave stale partial edit UI (text edit without handles). */
function qsClearTranscriptEditState(win) {
    const el = win || document.getElementById('transcript-window');
    if (!el) return;
    el.contentEditable = 'false';
    el.classList.remove('transcript-editing', 'transcript-sync-mode');
    el.style.border = '';
    el.style.backgroundColor = '';
    window._qsTimingMode = false;
    window._qsTimingModeBackup = null;
    window._qsForceLegacyEditMode = false;
    try { _qsSetSyncModeButtonActive(false); } catch (_) {}
    const editActions = document.getElementById('edit-actions');
    if (editActions) editActions.style.display = 'none';
}

function qsActivateSubtitleFormatTabOnly() {
    const subtitleBtn = document.getElementById('format-mode-subtitle');
    const docBtn = document.getElementById('format-mode-doc');
    const summaryBtn = document.getElementById('format-mode-summary');
    if (subtitleBtn) subtitleBtn.classList.add('is-active');
    if (docBtn) docBtn.classList.remove('is-active');
    if (summaryBtn) summaryBtn.classList.remove('is-active');
    window.qsFormatViewMode = 'subtitle';
}

function qsRenderEmptyTranscriptMessage(reason) {
    const transcriptWindow = document.getElementById('transcript-window');
    if (!transcriptWindow) return;
    const isHe = String(window.currentLocale || document.documentElement.lang || 'he').toLowerCase().startsWith('he');
    const fallback = isHe
        ? 'לא התקבל טקסט תמלול לקובץ זה. נסה להעלות שוב או בדוק את לוגי השרת לעבודה זו.'
        : 'No transcript text was returned for this file. Try uploading again or check the server logs for this job.';
    const msg = reason || qsTranslateOr('transcript_empty_message', fallback);
    transcriptWindow.innerHTML = `<p class="qs-transcript-empty-notice" style="color:#64748b;text-align:center;margin:2rem 1rem;line-height:1.55;white-space:pre-wrap;">${String(msg).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    transcriptWindow.contentEditable = 'false';
}

/** In-memory when HIPAA blocks persisting lastS3Key; also fallback after reading storage. */
function currentJobInputS3KeyHint() {
    try {
        const m = String(typeof window !== 'undefined' ? (window._qsInputS3KeyForGpt || '') : '').trim();
        if (m) return m;
    } catch (_) {}
    try {
        return String(localStorage.getItem('lastS3Key') || '').trim();
    } catch (_) {
        return '';
    }
}

/** Use clinical GPT prompts when medical mode is on or the job media key is a HIPAA/medical layout path. */
function effectiveIsMedicalForFormatting() {
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return true;
    const k = currentJobInputS3KeyHint();
    if (!k) return false;
    if (typeof isMedicalLayoutRawAudioKey === 'function' && isMedicalLayoutRawAudioKey(k)) return true;
    if (k.includes('/summaries/')) return true;
    if (k.startsWith('medical/')) return true;
    return false;
}

function _qsRevokeLocalPreviewAudio() {
    const u = window._qsLocalPreviewAudioUrl;
    if (u && String(u).startsWith('blob:')) {
        try { URL.revokeObjectURL(u); } catch (_) {}
    }
    window._qsLocalPreviewAudioUrl = null;
    window._qsLocalPreviewAudioMime = null;
}

/** Blob preview URL for playback after transcribe. In medical mode localStorage is blocked — keep in memory only. */
function setLocalPreviewAudio(objectUrl, mime) {
    _qsRevokeLocalPreviewAudio();
    window._qsLocalPreviewAudioUrl = objectUrl || null;
    window._qsLocalPreviewAudioMime = mime ? String(mime) : '';
    if (!isMedicalModeEnabled()) {
        try {
            if (objectUrl) localStorage.setItem('currentAudioUrl', objectUrl);
            else localStorage.removeItem('currentAudioUrl');
            localStorage.setItem('currentAudioMime', window._qsLocalPreviewAudioMime);
        } catch (_) {}
    }
}

function getLocalPreviewAudioUrl() {
    if (window._qsLocalPreviewAudioUrl) return window._qsLocalPreviewAudioUrl;
    try { return localStorage.getItem('currentAudioUrl'); } catch (_) { return null; }
}

function getLocalPreviewAudioMime() {
    if (window._qsLocalPreviewAudioMime) return window._qsLocalPreviewAudioMime;
    try { return localStorage.getItem('currentAudioMime') || ''; } catch (_) { return ''; }
}

/** Show audio/video player immediately after the user picks a file (before credit checks). */
function qsShowLocalUploadMediaPreview(file) {
    if (!file) return null;
    let isAudio = typeof qsIsAudioMediaFile === 'function' && qsIsAudioMediaFile(file);
    let isVideo = !isAudio && typeof qsIsVideoMediaFile === 'function' && qsIsVideoMediaFile(file);
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
        isAudio = true;
        isVideo = false;
    }
    window.uploadWasVideo = !!isVideo;
    window.originalFileName = file.name.replace(/\.[^.]+$/, '') || 'media';
    const skipLocalBlobPreview = typeof qsIsLargeUploadFile === 'function' && qsIsLargeUploadFile(file);
    let objectUrl = null;
    if (!skipLocalBlobPreview) {
        objectUrl = URL.createObjectURL(file);
    }
    const mimeForMov = (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled())
        ? (typeof qsGuessUploadMimeType === 'function' ? qsGuessUploadMimeType(file, 'audio/webm') : 'audio/webm')
        : ((/\.mov$/i.test(file.name) || String(file.type || '').toLowerCase().includes('quicktime')) ? 'video/mp4' : (file.type || ''));

    const videoWrapper = document.getElementById('video-wrapper');
    const videoPlayer = document.getElementById('video-player-container');
    const playerContainer = document.getElementById('audio-player-container');
    const videoSrc = document.getElementById('video-source');
    const video = document.getElementById('main-video');
    const audioSource = document.getElementById('audio-source');
    const mainAudio = document.getElementById('main-audio');

    try {
        if (isVideo) {
            if (playerContainer) playerContainer.style.display = 'none';
            if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
            if (video) video.style.display = '';
            if (videoPlayer) videoPlayer.style.display = 'block';
            if (objectUrl && videoSrc) {
                const isMov = /\.mov$/i.test(file.name) || (file.type || '').toLowerCase().includes('quicktime');
                videoSrc.src = objectUrl;
                videoSrc.type = isMov ? 'video/mp4' : (file.type || 'video/mp4');
            }
            if (video && objectUrl) {
                video.style.position = 'relative';
                video.style.zIndex = '1002';
                video.controls = true;
                video.load();
                video.pause();
                try { video.focus(); } catch (_) {}
            }
        } else if (objectUrl) {
            if (videoWrapper) {
                videoWrapper.style.display = 'none';
                videoWrapper.classList.remove('visible');
            }
            try { document.body.classList.remove('mobile-video-session'); } catch (_) {}
            if (video) video.style.display = 'none';
            if (playerContainer && videoWrapper && videoPlayer && playerContainer.parentNode === videoPlayer) {
                videoWrapper.parentNode.insertBefore(playerContainer, videoWrapper);
            }
            if (playerContainer) playerContainer.style.display = 'block';
            if (audioSource && mainAudio) {
                audioSource.src = objectUrl;
                audioSource.type = typeof qsMimeForAudioElement === 'function' ? qsMimeForAudioElement(file) : (file.type || 'audio/mp4');
                mainAudio.load();
            }
            if (videoPlayer) videoPlayer.style.display = 'block';
        }
    } catch (e) {
        console.warn('qsShowLocalUploadMediaPreview failed', e);
    }

    if (objectUrl) setLocalPreviewAudio(objectUrl, mimeForMov);
    if (typeof syncMobileVideoSessionState === 'function') syncMobileVideoSessionState();
    window.__QS_UPLOAD_PREVIEW_READY = true;
    return { objectUrl, isAudio, isVideo, skipLocalBlobPreview, mimeForMov };
}

function clearSensitiveStorageForMedicalMode() {
    _qsRevokeLocalPreviewAudio();
    const keysToWipe = [
        'activeJobId', 'lastJobId', 'lastJobDbId', 'lastS3Key', 'pendingS3Key', 'pendingJobId',
        'pendingExportType', 'pendingOpenGenerateMenu', 'currentAudioUrl', 'currentAudioMime'
    ];
    for (const key of keysToWipe) {
        try { localStorage.removeItem(key); } catch (_) {}
        try { sessionStorage.removeItem(key); } catch (_) {}
    }
}

try {
    window.__QS_UX_USER_SIGNED_IN = false;
} catch (_) {}
try {
    const p = (window.location && window.location.pathname)
        ? String(window.location.pathname).replace(/\/+$/, '') || '/'
        : '/';
    if (p === '/medical') {
        window.__QS_MEDICAL_URL_ENTRY = true;
        _qsSetMedicalLanding();
    } else {
        // Prevent sticky medical landing from forcing non-medical URLs into HIPAA mode.
        window.__QS_MEDICAL_URL_ENTRY = false;
        _qsClearMedicalLanding();
        // Also clear persisted medical mode on regular routes so trigger_processing stays non-medical.
        try { localStorage.setItem(QS_MEDICAL_MODE_KEY, '0'); } catch (_) {}
        window.isMedicalMode = false;
    }
} catch (_) {}

const QS_MEDICAL_REASSERT_AFTER_LOGOUT = 'qs_reassert_medical_after_logout';

function _qsSetMedicalReassertOnNextPageLoad() {
    try { sessionStorage.setItem(QS_MEDICAL_REASSERT_AFTER_LOGOUT, '1'); } catch (_) {}
}

function setMedicalMode(enabled, opts) {
    opts = opts || {};
    const bypassUrlLock = opts.bypassMedicalUrlLock === true;
    if (!enabled && (window.__QS_MEDICAL_URL_ENTRY || (typeof _qsReadMedicalLanding === 'function' && _qsReadMedicalLanding())) && !bypassUrlLock && !window.__QS_UX_USER_SIGNED_IN) {
        try { localStorage.setItem(QS_MEDICAL_MODE_KEY, '1'); } catch (_) {}
        window.isMedicalMode = true;
        try {
            const navToggle = document.getElementById('nav-medical-mode-toggle');
            if (navToggle) navToggle.checked = true;
        } catch (_) {}
        if (typeof window.applyMedicalModeUi === 'function') {
            try { window.applyMedicalModeUi(); } catch (_) {}
        }
        try { qsSyncNavLogoHref(); } catch (_) {}
        return;
    }
    const on = !!enabled;
    window.isMedicalMode = on;
    try { localStorage.setItem(QS_MEDICAL_MODE_KEY, on ? '1' : '0'); } catch (_) {}
    try { qsSyncNavLogoHref(); } catch (_) {}
    if (on) clearSensitiveStorageForMedicalMode();
    try {
        const navToggle = document.getElementById('nav-medical-mode-toggle');
        if (navToggle) navToggle.checked = on;
    } catch (_) {}
    try {
        if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi();
    } catch (_) {}
    if (on) {
        try { void window.qsRefreshMedicalEndpointStatus(); } catch (_) {}
    }
}

function qsNavLogoTargetPath() {
    try {
        if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return '/medical';
    } catch (_) {}
    try {
        if (window.__QS_MEDICAL_URL_ENTRY === true) return '/medical';
    } catch (_) {}
    try {
        if (String(localStorage.getItem(QS_MEDICAL_MODE_KEY) || '').trim() === '1') return '/medical';
    } catch (_) {}
    const locale = String(
        window.currentLocale ||
        (typeof localStorage !== 'undefined' && localStorage.getItem('locale')) ||
        'he'
    ).toLowerCase().split('-')[0];
    return locale === 'en' ? '/en' : '/';
}

function qsSyncNavLogoHref() {
    const logoLink = document.getElementById('nav-logo-link');
    if (!logoLink) return;
    logoLink.setAttribute('href', qsNavLogoTargetPath());
}
window.qsSyncNavLogoHref = qsSyncNavLogoHref;

function qsWireNavLogoMedicalRouting() {
    const logoLink = document.getElementById('nav-logo-link');
    if (!logoLink || logoLink.dataset.qsMedicalRouting === '1') return;
    logoLink.dataset.qsMedicalRouting = '1';
    qsSyncNavLogoHref();
    logoLink.addEventListener('click', (event) => {
        const target = qsNavLogoTargetPath();
        logoLink.setAttribute('href', target);
        if (window.location && window.location.pathname !== target) {
            event.preventDefault();
            window.location.assign(target);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', qsWireNavLogoMedicalRouting, { once: true });
} else {
    qsWireNavLogoMedicalRouting();
}

(() => {
    try {
        if (String(sessionStorage.getItem(QS_MEDICAL_REASSERT_AFTER_LOGOUT) || '').trim() === '1') {
            try { sessionStorage.removeItem(QS_MEDICAL_REASSERT_AFTER_LOGOUT); } catch (_) {}
            try { localStorage.setItem(QS_MEDICAL_MODE_KEY, '1'); } catch (_) {}
            try { _qsSetMedicalLanding(); } catch (_) {}
            try { window.__QS_MEDICAL_URL_ENTRY = true; } catch (_) {}
            window.isMedicalMode = true;
        } else {
            const raw = localStorage.getItem(QS_MEDICAL_MODE_KEY);
            window.isMedicalMode = String(raw || '').trim() === '1';
        }
    } catch (_) {
        window.isMedicalMode = false;
    }
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
        const k = String(key || '');
        if (window.isMedicalMode === true && !_qsStorageKeyAllowedDuringMedicalLockdown(k)) return;
        return originalSetItem.call(this, key, value);
    };
})();

try {
    if (typeof window !== 'undefined' && window.__QS_BOOTSTRAP_MEDICAL_FROM_PATH) {
        if (typeof _qsSetMedicalLanding === 'function') {
            _qsSetMedicalLanding();
        }
        setMedicalMode(true);
        try { delete window.__QS_BOOTSTRAP_MEDICAL_FROM_PATH; } catch (_) { window.__QS_BOOTSTRAP_MEDICAL_FROM_PATH = false; }
    }
} catch (_) {}

/** HTTP statuses where hammering the server is pointless; stop polling after a short streak. */
function qsIsSevereServerPollError(status) {
    return status === 502 || status === 503 || status === 504 || status === 429;
}

/** One-shot /api/check_status; returns true if job completion was handed to handleJobUpdate. */
async function qsPollCheckStatusOnce(jobId) {
    const jid = String(jobId || '').trim();
    if (!jid || typeof window.handleJobUpdate !== 'function') return false;
    if (window._lastProcessedJobId === jid) return true;
    try {
        const res = await fetch(`/api/check_status/${encodeURIComponent(jid)}`);
        if (!res.ok) return false;
        const data = await res.json();
        const done = data.status === 'completed' || data.status === 'failed'
            || (Array.isArray(data.segments) && data.segments.length > 0);
        if (!done) return false;
        if (window._checkStatusPollInterval) {
            clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
        }
        qsInvokeHandleJobUpdate(data);
        return true;
    } catch (_) {
        return false;
    }
}

/** Start polling check_status and trigger_status for a job (used after trigger and on retry). */
window.startJobStatusPolling = function(jobId) {
    if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
    window._pollingJobId = jobId;
    // Slower cadence + server-side row cache keeps Supabase load and CPU down (was ~4s + frequent trigger_status).
    const pollMs = 9000;
    const triggerStatusEveryNPolls = 3;
    let polls = 0;
    let consecutiveSeverePollFailures = 0;
    // Only check_status (and network errors) count — trigger_status can 503 during proxy blips while check_status still works.
    const maxSevereBeforeStop = 24;

    void qsPollCheckStatusOnce(jobId);
    setTimeout(() => { void qsPollCheckStatusOnce(jobId); }, 2500);
    setTimeout(() => { void qsPollCheckStatusOnce(jobId); }, 6000);

    const stopPollingServerDown = (isHe) => {
        if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
        window._checkStatusPollInterval = null;
        window.isTriggering = false;
        if (typeof stopProcessingStateUI === 'function') stopProcessingStateUI('poll_server_severe_errors');
        qsStopFakeProgress('poll_server_severe_errors');
        const mb = document.getElementById('main-btn');
        if (mb) mb.disabled = false;
        const msg = isHe
            ? 'השרת אינו זמין זמנית. רענן את הדף או נסה שוב בעוד רגע.'
            : 'The server is temporarily unavailable. Refresh the page or try again in a moment.';
        if (typeof showStatus === 'function') showStatus(msg, true);
    };

    window._checkStatusPollInterval = setInterval(async () => {
        polls++;
        if (window._pollingJobId !== jobId) {
            if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
            return;
        }
        const activeNow = String(localStorage.getItem('activeJobId') || '').trim();
        if (activeNow && activeNow !== jobId) {
            if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
            return;
        }
        const isHe = typeof document.documentElement.lang !== 'undefined' && String(document.documentElement.lang).toLowerCase().startsWith('he');
        try {
            if (polls % triggerStatusEveryNPolls === 0) {
                const tsRes = await fetch(`/api/trigger_status?job_id=${encodeURIComponent(jobId)}`);
                if (tsRes.ok) {
                    const ts = await tsRes.json();
                    if (ts.status === 'failed') {
                        if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
                        window._checkStatusPollInterval = null;
                        window.isTriggering = false;
                        const msg = isHe ? 'הפעלת העיבוד נכשלה.' : 'GPU trigger failed.';
                        showTriggerErrorDialog(msg, {
                            onClose: () => {
                                localStorage.removeItem('activeJobId');
                                const mb = document.getElementById('main-btn');
                                if (mb) mb.disabled = false;
                            }
                        });
                        return;
                    }
                    const stale = ts.status === 'stale_queued' || (ts.status === 'queued' && (ts.queued_since_sec || 0) > 120);
                    if (stale && (!window._triggerRetriedForJobId || window._triggerRetriedForJobId !== jobId)) {
                        window._triggerRetriedForJobId = jobId;
                        const retryRes = await fetch('/api/retry_trigger', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jobId })
                        });
                        if (retryRes.ok) {
                            console.log('[trigger] Retrying trigger for job', jobId);
                        }
                    }
                }
            }
            const res = await fetch(`/api/check_status/${encodeURIComponent(jobId)}`);
            if (!res.ok) {
                if (qsIsSevereServerPollError(res.status)) {
                    consecutiveSeverePollFailures++;
                    if (consecutiveSeverePollFailures >= maxSevereBeforeStop) {
                        stopPollingServerDown(isHe);
                        return;
                    }
                } else {
                    consecutiveSeverePollFailures = 0;
                }
                return;
            }
            consecutiveSeverePollFailures = 0;
            const data = await res.json();
            if (data.status === 'completed' || data.status === 'failed' || (data.segments && data.segments.length > 0)) {
                if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
                window._checkStatusPollInterval = null;
                if (data.status === 'failed') {
                    console.warn('[check_status] job failed', jobId, data.error || data);
                }
                qsInvokeHandleJobUpdate(data);
            }
        } catch (_) {
            consecutiveSeverePollFailures++;
            if (consecutiveSeverePollFailures >= maxSevereBeforeStop) {
                stopPollingServerDown(isHe);
            }
        }
    }, pollMs);
};

/** Call after "GPU trigger failed" to re-send trigger for the active job (no re-upload). */
window.retryTriggerForActiveJob = async function() {
    const jobId = localStorage.getItem('activeJobId');
    if (!jobId) return;
    try {
        const r = await fetch('/api/retry_trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId })
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            if (typeof showStatus === 'function') showStatus(body.message || 'Retry failed', true);
            return;
        }
        window.isTriggering = true;
        window._triggerRetriedForJobId = null;
        if (typeof startFakeProgress === 'function') startFakeProgress();
        if (typeof window.startJobStatusPolling === 'function') window.startJobStatusPolling(jobId);
    } catch (e) {
        if (typeof showStatus === 'function') showStatus('Retry failed', true);
    }
};

// --- AUTH STATE: after email confirmation (magic link) Supabase creates the session; close modal and refresh ---
supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
        try { window.__QS_USER_CREDIT_MINUTES = null; } catch (_) {}
        try { qsSyncUserCreditsUi(); } catch (_) {}
        try {
            const p = (window.location && window.location.pathname)
                ? String(window.location.pathname).replace(/\/+$/, '') || '/'
                : '/';
            if (p === '/medical') window.__QS_MEDICAL_URL_ENTRY = true;
            if (typeof _qsReadMedicalLanding === 'function' && _qsReadMedicalLanding()) {
                window.__QS_MEDICAL_URL_ENTRY = true;
            }
        } catch (_) {}
        try {
            window.__QS_UX_USER_SIGNED_IN = false;
        } catch (_) {}
        try { document.body.classList.remove('qs-user-signed-in'); } catch (_) {}
        try {
            if (window.__QS_MEDICAL_URL_ENTRY) {
                setMedicalMode(true);
            } else {
                setMedicalMode(false);
            }
        } catch (_) {}
        if (typeof window.applyMedicalModeUi === 'function') {
            try { window.applyMedicalModeUi(); } catch (_) {}
        }
    }
    if (event === 'SIGNED_IN' && session) {
        try { window.__QS_OAUTH_CALLBACK_RESOLVED = true; } catch (_) {}
        window.toggleModal(false);
        if (typeof setupNavbarAuth === 'function') setupNavbarAuth();
        try { void qsRefreshUserCredits({ ensureWelcome: true }); } catch (_) {}
        // Warmup is started from setupNavbarAuth / setMedicalMode (avoid duplicate POST on delayed SIGNED_IN).
        try { void maybeShowIOSOpenInSafariHintAfterSignIn(); } catch (_) {}
        try { qsCleanOAuthUrlFromHistory(); } catch (_) {}
        try { restoreMedicalAuthSnapshotAfterSignIn(); } catch (_) {}
        try {
            const signForCopy = String(sessionStorage.getItem('qs_medical_sign_in_for_copy') || '').trim() === '1';
            if (signForCopy) {
                try { sessionStorage.removeItem('qs_medical_sign_in_for_copy'); } catch (_) {}
                try { sessionStorage.setItem('qs_medical_show_feedback_on_next_copy', '1'); } catch (_) {}
            }
        } catch (_) {}
        // Session was not ready on the first DOMContentLoaded tick (email magic link, PKCE) — run ?open= now.
        if (typeof runOpenQueryIfPresent === 'function') {
            void runOpenQueryIfPresent();
        }
    }
});

/** Global confirm dialog (same look as personal). Returns Promise<boolean>. */
function ensureGlobalConfirmDialog() {
    let overlay = document.getElementById('global-confirm-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'global-confirm-overlay';
        overlay.className = 'personal-dialog-overlay';
        overlay.innerHTML = `
            <div class="personal-dialog" role="dialog" aria-modal="true">
                <p class="personal-dialog-message"></p>
                <div class="personal-dialog-actions">
                    <button type="button" class="personal-dialog-btn cancel"></button>
                    <button type="button" class="personal-dialog-btn primary"></button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
    }
    return overlay;
}
function showGlobalConfirm(message, options = {}) {
    const overlay = ensureGlobalConfirmDialog();
    const msgEl = overlay.querySelector('.personal-dialog-message');
    const cancelBtn = overlay.querySelector('.personal-dialog-btn.cancel');
    const okBtn = overlay.querySelector('.personal-dialog-btn.primary');
    if (!msgEl || !cancelBtn || !okBtn) return Promise.resolve(false);
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    msgEl.textContent = message || '';
    cancelBtn.textContent = options.cancelText || T('cancel') || 'Cancel';
    okBtn.textContent = options.confirmText || T('confirm') || 'Confirm';
    okBtn.classList.toggle('danger', !!options.danger);
    overlay.classList.add('is-open');
    return new Promise((resolve) => {
        const cleanup = (val) => {
            overlay.classList.remove('is-open');
            cancelBtn.onclick = null;
            okBtn.onclick = null;
            overlay.onclick = null;
            window.removeEventListener('keydown', onKey);
            resolve(val);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') cleanup(false);
        };
        window.addEventListener('keydown', onKey);
        cancelBtn.onclick = (e) => {
            try { e && e.stopPropagation && e.stopPropagation(); } catch (_) {}
            cleanup(false);
        };
        okBtn.onclick = (e) => {
            try { e && e.stopPropagation && e.stopPropagation(); } catch (_) {}
            cleanup(true);
        };
        overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    });
}

/** Standard popup for trigger/GPU errors. Offers Retry and Close. Do not clear activeJobId before calling. */
function showTriggerErrorDialog(message, options = {}) {
    let overlay = document.getElementById('trigger-error-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'trigger-error-overlay';
        overlay.className = 'personal-dialog-overlay';
        overlay.innerHTML = `
            <div class="personal-dialog" role="dialog" aria-modal="true">
                <p class="personal-dialog-message"></p>
                <div class="personal-dialog-actions">
                    <button type="button" class="personal-dialog-btn cancel"></button>
                    <button type="button" class="personal-dialog-btn primary"></button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
    }
    const msgEl = overlay.querySelector('.personal-dialog-message');
    const closeBtn = overlay.querySelector('.personal-dialog-btn.cancel');
    const retryBtn = overlay.querySelector('.personal-dialog-btn.primary');
    if (!msgEl || !closeBtn || !retryBtn) return;
    const isHebrew = typeof document.documentElement.lang !== 'undefined' && String(document.documentElement.lang).toLowerCase().startsWith('he');
    msgEl.textContent = message || '';
    closeBtn.textContent = options.closeText || (isHebrew ? 'סגור' : 'Close');
    retryBtn.textContent = options.retryText || (isHebrew ? 'נסה שוב' : 'Try again');
    overlay.classList.add('is-open');
    const cleanup = () => {
        overlay.classList.remove('is-open');
        closeBtn.onclick = null;
        retryBtn.onclick = null;
        overlay.onclick = null;
        window.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
        if (e.key === 'Escape') {
            cleanup();
            if (options.onClose) options.onClose();
        }
    };
    window.addEventListener('keydown', onKey);
    closeBtn.onclick = () => {
        cleanup();
        if (options.onClose) options.onClose();
    };
    retryBtn.onclick = () => {
        cleanup();
        if (typeof window.retryTriggerForActiveJob === 'function') window.retryTriggerForActiveJob();
    };
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            cleanup();
            if (options.onClose) options.onClose();
        }
    };
}

function showGlobalAlert(message, options = {}) {
    const overlay = ensureGlobalConfirmDialog();
    const msgEl = overlay.querySelector('.personal-dialog-message');
    const cancelBtn = overlay.querySelector('.personal-dialog-btn.cancel');
    const okBtn = overlay.querySelector('.personal-dialog-btn.primary');
    if (!msgEl || !cancelBtn || !okBtn) return Promise.resolve();
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    msgEl.textContent = message || '';
    cancelBtn.style.display = 'none';
    okBtn.textContent = options.confirmText || T('confirm') || 'אישור';
    okBtn.classList.remove('danger');
    overlay.classList.add('is-open');
    return new Promise((resolve) => {
        const cleanup = () => {
            overlay.classList.remove('is-open');
            cancelBtn.style.display = '';
            cancelBtn.onclick = null;
            okBtn.onclick = null;
            overlay.onclick = null;
            window.removeEventListener('keydown', onKey);
            resolve();
        };
        const onKey = (e) => {
            if (e.key === 'Escape' || e.key === 'Enter') cleanup();
        };
        window.addEventListener('keydown', onKey);
        okBtn.onclick = cleanup;
        overlay.onclick = (e) => { if (e.target === overlay) cleanup(); };
    });
}

// --- Upload pipeline (S3 PUT + trigger_processing): logging, wake lock, trigger retries ---
function qsUploadTrace(phase, detail) {
    try {
        console.log('[qs-upload]', Object.assign({ phase, ts: new Date().toISOString() }, detail || {}));
    } catch (_) {}
}

/** Same as qsUploadTrace but uses console.error — survives __QS_CONSOLE_ENABLED gate (log/info/debug/warn are no-oped on prod hosts). */
function qsUploadTraceErr(phase, detail) {
    try {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error('[qs-upload]', Object.assign({ phase, ts: new Date().toISOString() }, detail || {}));
        }
    } catch (_) {}
}

/** User choice from upload confirm modal (<5 min files) or default speech for longer clips. */
function qsSetUserAudioProfileChoice(treatAsMusic) {
    window.__QS_USER_TREAT_AS_MUSIC = !!treatAsMusic;
}

function qsUserTreatAsMusicForUpload() {
    return !!window.__QS_USER_TREAT_AS_MUSIC;
}

/** Align with server RUNPOD_DEFER_WARMUP_FILE_BYTES — avoid loading whole File in the browser. */
const QS_LARGE_UPLOAD_BYTES = 200 * 1024 * 1024;
/** S3 multipart minimum part size (all parts except the last). Must match siteapp.py. */
const QS_S3_MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
/** Music-mode confirm popup only for short clips (long/large files skip — probe + modal are slow). */
const QS_UPLOAD_MUSIC_CONFIRM_MAX_SEC = 300;

function qsShouldShowUploadMusicConfirm(durationSec) {
    const d = Number(durationSec);
    return Number.isFinite(d) && d > 0 && d < QS_UPLOAD_MUSIC_CONFIRM_MAX_SEC;
}

function qsIsLargeUploadFile(fileOrBytes) {
    const n = typeof fileOrBytes === 'number' ? fileOrBytes : (fileOrBytes && fileOrBytes.size);
    return Number.isFinite(n) && n >= QS_LARGE_UPLOAD_BYTES;
}


function qsFormatUploadFileSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    const units = [
        { u: 'GB', v: 1024 ** 3 },
        { u: 'MB', v: 1024 ** 2 },
        { u: 'KB', v: 1024 },
    ];
    for (let i = 0; i < units.length; i++) {
        if (n >= units[i].v || i === units.length - 1) {
            const val = n / units[i].v;
            const rounded = val >= 100 ? Math.round(val) : Math.round(val * 10) / 10;
            return `${rounded} ${units[i].u}`;
        }
    }
    return `${n} B`;
}

/** mm:ss or h:mm:ss from media element metadata (Explorer-style length). */
function qsFormatMediaDurationForConfirm(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return '';
    const total = Math.round(s);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad2 = (n) => String(n).padStart(2, '0');
    if (hrs > 0) return `${hrs}:${pad2(mins)}:${pad2(secs)}`;
    return `${mins}:${pad2(secs)}`;
}

/** Read duration from file metadata before upload confirm (hidden audio/video element). */
function qsProbeFileMediaDurationSec(file, timeoutMs) {
    const fromPlayer = typeof qsClientMediaDurationSecForCredits === 'function'
        ? qsClientMediaDurationSecForCredits()
        : 0;
    if (Number.isFinite(fromPlayer) && fromPlayer > 0) {
        return Promise.resolve(fromPlayer);
    }
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : 8000;
    return new Promise((resolve) => {
        if (!file) {
            resolve(0);
            return;
        }
        let settled = false;
        const url = URL.createObjectURL(file);
        const isVideo = typeof qsIsVideoMediaFile === 'function' && qsIsVideoMediaFile(file)
            && !(typeof qsIsAudioMediaFile === 'function' && qsIsAudioMediaFile(file));
        const el = document.createElement(isVideo ? 'video' : 'audio');
        el.muted = true;
        el.preload = 'metadata';
        el.playsInline = true;
        const finish = (sec) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { el.pause(); } catch (_) {}
            try { el.removeAttribute('src'); } catch (_) {}
            URL.revokeObjectURL(url);
            const d = Number(sec);
            resolve(Number.isFinite(d) && d > 0 ? d : 0);
        };
        const timer = setTimeout(() => finish(0), limit);
        el.addEventListener('loadedmetadata', () => finish(el.duration), { once: true });
        el.addEventListener('error', () => finish(0), { once: true });
        el.src = url;
    });
}

function qsMountMusicModeContainerInto(slotEl) {
    if (!slotEl) return null;
    slotEl.innerHTML = '';
    const tpl = document.getElementById('qs-music-mode-container-template');
    if (!tpl || !tpl.content) return null;
    const frag = tpl.content.cloneNode(true);
    slotEl.appendChild(frag);
    return slotEl.querySelector('.qs-music-mode-container');
}

function qsEnsureUploadConfirmModalInBody() {
    const backdrop = document.getElementById('upload-confirm-modal');
    if (backdrop && backdrop.parentNode !== document.body) {
        document.body.appendChild(backdrop);
    }
    return backdrop;
}

/**
 * Minimal upload confirmation overlay. Resolves { treatAsMusic } or null (cancel).
 * @param {File} file
 * @param {{ durationSec?: number }} [opts]
 */
function qsShowUploadConfirmModal(file, opts) {
    const durationSec = Number((opts && opts.durationSec) || 0);
    return new Promise((resolve) => {
        const backdrop = qsEnsureUploadConfirmModalInBody();
        const nameEl = document.getElementById('upload-confirm-filename');
        const sizeElReal = document.getElementById('upload-confirm-filesize');
        const musicSlot = document.getElementById('upload-confirm-music-slot');
        const cancelBtn = document.getElementById('upload-confirm-cancel');
        const submitBtn = document.getElementById('upload-confirm-submit');
        if (!backdrop || !nameEl || !sizeElReal || !cancelBtn || !submitBtn) {
            resolve({ treatAsMusic: false });
            return;
        }
        const T = typeof window.t === 'function' ? window.t : (k) => k;
        const titleEl = document.getElementById('upload-confirm-title');
        if (titleEl) titleEl.textContent = T('upload_confirm_title') || titleEl.textContent || 'Confirm File Upload';
        submitBtn.textContent = T('upload_confirm_submit') || submitBtn.textContent || 'Confirm & Transcribe';
        cancelBtn.textContent = T('cancel') || cancelBtn.textContent || 'Cancel';
        nameEl.textContent = file && file.name ? file.name : T('upload_confirm_unknown_file') || 'Selected file';
        const durLabel = T('upload_confirm_duration') || 'Upload time';
        const durText = qsFormatMediaDurationForConfirm(durationSec);
        sizeElReal.textContent = durText
            ? `${durLabel}: ${durText}`
            : `${durLabel}: ${T('upload_confirm_duration_unknown') || 'Unknown'}`;
        qsMountMusicModeContainerInto(musicSlot);
        const musicCb = document.getElementById('qs-music-mode-checkbox');
        if (musicCb) musicCb.checked = false;
        const musicTitle = musicSlot && musicSlot.querySelector('.qs-music-mode-title');
        const musicDesc = musicSlot && musicSlot.querySelector('.qs-music-mode-desc');
        if (musicTitle) musicTitle.textContent = T('upload_music_mode_title') || musicTitle.textContent;
        if (musicDesc) musicDesc.textContent = T('upload_music_mode_desc') || musicDesc.textContent;

        let settled = false;
        const finish = (choice) => {
            if (settled) return;
            settled = true;
            backdrop.classList.remove('is-open');
            backdrop.style.display = 'none';
            backdrop.setAttribute('hidden', '');
            backdrop.setAttribute('aria-hidden', 'true');
            cancelBtn.onclick = null;
            submitBtn.onclick = null;
            backdrop.onclick = null;
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = '';
            document.body.classList.remove('qs-upload-confirm-open');
            resolve(choice);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') finish(null);
        };

        cancelBtn.onclick = () => finish(null);
        submitBtn.onclick = () => {
            finish({ treatAsMusic: !!(musicCb && musicCb.checked) });
        };
        backdrop.onclick = (e) => {
            if (e.target === backdrop) finish(null);
        };
        window.addEventListener('keydown', onKey);
        backdrop.classList.add('is-open');
        backdrop.removeAttribute('hidden');
        backdrop.style.display = 'flex';
        backdrop.setAttribute('aria-hidden', 'false');
        document.body.classList.add('qs-upload-confirm-open');
        document.body.style.overflow = 'hidden';
        try { submitBtn.focus(); } catch (_) {}
    });
}

/** Restore landing chrome after user cancels upload confirm or credit check fails. */
function qsRestoreUiAfterUploadConfirmCancel(opts) {
    opts = opts || {};
    if (!opts.keepMediaPreview) {
        try {
            setSeoHomeContentVisibility(true);
        } catch (_) {}
        const ph = document.getElementById('placeholder');
        if (ph && typeof initOpenAppHasLoadedTranscriptPayload === 'function' && !initOpenAppHasLoadedTranscriptPayload()) {
            ph.style.display = '';
        }
    }
    try {
        document.body.classList.remove('qs-app-busy');
        if (typeof qsSyncAppChromeBodyClasses === 'function') qsSyncAppChromeBodyClasses();
    } catch (_) {}
}

/** Ensure media src is absolute (CDN env without https:// must not become a site-relative path). */
function qsNormalizeAbsoluteMediaUrl(url) {
    const u = String(url || '').trim();
    if (!u) return u;
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(u)) return 'https://' + u.replace(/^\/+/, '');
    return u;
}

/** Attach uploaded media from S3 (presigned URL) instead of holding a blob: URL for the whole File. */
async function qsAttachS3MediaPreview(s3Key, userId, opts) {
    opts = opts || {};
    if (!s3Key || !userId) return false;
    const isMedical = opts.isMedical != null
        ? opts.isMedical
        : (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled());
    const res = await fetch('/api/get_presigned_url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3Key, userId, isMedical }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.url) return false;

    let url = qsNormalizeAbsoluteMediaUrl(json.url);
    if (json.via === 'cdn' && url) {
        const videoProbe = document.createElement('video');
        videoProbe.muted = true;
        videoProbe.preload = 'metadata';
        const cdnOk = await new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { videoProbe.removeAttribute('src'); } catch (_) {}
                resolve(ok);
            };
            const timer = setTimeout(() => finish(false), 4000);
            videoProbe.addEventListener('loadedmetadata', () => finish(true), { once: true });
            videoProbe.addEventListener('error', () => finish(false), { once: true });
            videoProbe.src = url;
        });
        if (!cdnOk) {
            const retry = await fetch('/api/get_presigned_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ s3Key, userId, isMedical, forcePresigned: true }),
            });
            const retryJson = await retry.json().catch(() => ({}));
            if (retryJson.url) url = qsNormalizeAbsoluteMediaUrl(retryJson.url);
        }
    }

    const filename = opts.filename || decodeURIComponent(String(s3Key).split('/').pop() || 'file');
    let isAudio = opts.isAudio;
    let isVideo = opts.isVideo;
    if (isAudio == null) isAudio = qsIsAudioMediaFile(filename);
    if (isVideo == null) isVideo = !isAudio && qsIsVideoMediaFile(filename);
    if (isMedical) {
        isAudio = true;
        isVideo = false;
    }
    const videoWrapper = document.getElementById('video-wrapper');
    const videoPlayer = document.getElementById('video-player-container');
    const playerContainer = document.getElementById('audio-player-container');
    const videoSrc = document.getElementById('video-source');
    const video = document.getElementById('main-video');
    const audioSource = document.getElementById('audio-source');
    const mainAudio = document.getElementById('main-audio');

    if (isVideo) {
        if (playerContainer && videoWrapper && playerContainer.parentNode === videoPlayer) {
            videoWrapper.parentNode.insertBefore(playerContainer, videoWrapper);
        }
        if (playerContainer) playerContainer.style.display = 'none';
        if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
        if (video) video.style.display = '';
        if (videoSrc) {
            videoSrc.src = url;
            const mimeMap = { '.mp4': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska' };
            const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
            videoSrc.type = opts.mime || mimeMap[ext] || 'video/mp4';
        }
        if (video) {
            video.controls = true;
            video.load();
            video.pause();
        }
        if (videoPlayer) videoPlayer.style.display = 'block';
        setLocalPreviewAudio(url, opts.mime || videoSrc?.type || 'video/mp4');
    } else {
        if (videoWrapper) {
            videoWrapper.style.display = 'none';
            videoWrapper.classList.remove('visible');
        }
        try { document.body.classList.remove('mobile-video-session'); } catch (_) {}
        if (video) video.style.display = 'none';
        if (playerContainer && videoWrapper && videoPlayer && playerContainer.parentNode === videoPlayer) {
            videoWrapper.parentNode.insertBefore(playerContainer, videoWrapper);
        }
        if (playerContainer) playerContainer.style.display = 'block';
        if (audioSource && mainAudio) {
            audioSource.src = url;
            audioSource.type = opts.mime || qsMimeForAudioElement({ name: filename, type: opts.mime || '' });
            mainAudio.load();
        }
        if (videoPlayer) videoPlayer.style.display = 'block';
        setLocalPreviewAudio(url, opts.mime || audioSource?.type || 'audio/mp4');
    }
    if (typeof syncMobileVideoSessionState === 'function') syncMobileVideoSessionState();
    return true;
}

/** Duration in seconds from the in-browser preview player (same metadata Windows Explorer shows). */
function qsClientMediaDurationSecForCredits() {
    const stored = Number(window.__QS_UPLOAD_MEDIA_DURATION_SEC);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const pick = (el) => {
        if (!el) return 0;
        const d = Number(el.duration);
        return (Number.isFinite(d) && d > 0) ? d : 0;
    };
    if (window.uploadWasVideo === true) {
        const video = document.getElementById('main-video');
        const fromVideo = pick(video);
        if (fromVideo > 0) return fromVideo;
    }
    const audio = document.getElementById('main-audio');
    return pick(audio);
}

/** User-facing message for /api/trigger_processing credit errors. */
function qsCreditsTriggerErrorMessage(triggerData) {
    const td = triggerData || {};
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    if (td.error === 'insufficient_credits') {
        const req = td.required_minutes;
        const bal = td.credit_minutes;
        const tpl = T('insufficient_credits_msg');
        if (tpl && String(tpl).includes('{required}')) {
            return String(tpl)
                .replace('{required}', String(req != null ? req : '?'))
                .replace('{balance}', String(bal != null ? bal : '0'));
        }
        return td.message || tpl || 'Not enough minutes for this file.';
    }
    if (td.error === 'duration_unknown') {
        return td.message || T('credits_duration_unknown') || 'Could not determine file length.';
    }
    return td.message || '';
}

function qsApplyTriggerCreditFields(triggerData) {
    const td = triggerData || {};
    const used = Number(td.credit_minutes_used);
    if (Number.isFinite(used) && used > 0) {
        const minutes = Number(td.credit_minutes);
        if (!Number.isFinite(minutes)) return;
        try { window.__QS_USER_CREDIT_MINUTES = minutes; } catch (_) {}
        if (typeof qsSyncUserCreditsUi === 'function') qsSyncUserCreditsUi();
        return;
    }
    // Reserve/verify responses include balance only — do not refresh nav credits mid-job.
}

/** Deduct wallet minutes in the background after transcript + GPT summary are on screen. */
function qsDeferJobCreditsAfterDelivery(jobId, inputS3Key) {
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return;
    const jid = String(jobId || localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || '').trim();
    if (!jid) return;
    if (window._qsCreditsDeferredForJobId === jid) return;
    window._qsCreditsDeferredForJobId = jid;
    const run = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user || !jid) return;
            const s3Key = String(inputS3Key || localStorage.getItem('lastS3Key') || '').trim();
            const res = await fetch('/api/charge_job_credits', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: user.id,
                    jobId: jid,
                    input_s3_key: s3Key,
                    segments: window.currentSegments || [],
                    isMedical: false,
                })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                qsApplyTriggerCreditFields(data);
                const used = Number(data.credit_minutes_used);
                if (Number.isFinite(used) && used > 0) {
                    console.info('[qs-credits] deferred charge applied', {
                        jobId: jid,
                        credit_minutes_used: used,
                        credit_minutes: data.credit_minutes
                    });
                }
            } else {
                console.warn('[qs-credits] deferred charge failed', res.status, data);
            }
        } catch (e) {
            console.warn('[qs-credits] deferred charge error', e);
        }
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => { void run(); }, { timeout: 8000 });
    } else {
        setTimeout(() => { void run(); }, 50);
    }
}
window.qsDeferJobCreditsAfterDelivery = qsDeferJobCreditsAfterDelivery;

async function qsSupabaseAccessToken() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        return session && session.access_token ? session.access_token : '';
    } catch (_) {
        return '';
    }
}

/** Block upload when signed-in user lacks minutes for file length (check before S3 upload). */
async function qsEnsureCreditsForUpload(durationSec, opts) {
    opts = opts || {};
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
        return true;
    }
    let user = null;
    try {
        const { data: { user: u } } = await supabase.auth.getUser();
        user = u;
    } catch (_) {}
    if (!user || !user.id) return true;

    const d = Number(durationSec);
    if (!Number.isFinite(d) || d <= 0) {
        const T = typeof window.t === 'function' ? window.t : (k) => k;
        if (typeof showStatus === 'function') {
            showStatus(
                T('credits_duration_unknown') || 'Could not determine the file length. Try again or upload a different file.',
                true,
                { duration: 10000, toastPosition: 'above', toastAnchorId: 'main-btn' }
            );
        }
        return false;
    }

    try {
        const token = await qsSupabaseAccessToken();
        if (!token) {
            const T = typeof window.t === 'function' ? window.t : (k) => k;
            if (typeof showStatus === 'function') {
                showStatus(
                    T('sign_in_to_save') || 'Sign in to save your transcription history.',
                    true,
                    { duration: 10000, toastPosition: 'above', toastAnchorId: 'main-btn' }
                );
            }
            return false;
        }
        if (!opts.skipRefresh && typeof qsRefreshUserCredits === 'function') {
            await qsRefreshUserCredits();
        }
        const res = await fetch('/api/user/credits/check-upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ mediaDurationSec: d, isMedical: false }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status !== 'error') return true;
        if (res.status === 401) {
            const T = typeof window.t === 'function' ? window.t : (k) => k;
            if (typeof showStatus === 'function') {
                showStatus(
                    T('sign_in_to_save') || 'Please sign in again to continue.',
                    true,
                    { duration: 10000, toastPosition: 'above', toastAnchorId: 'main-btn' }
                );
            }
            return false;
        }
        const msg = qsCreditsTriggerErrorMessage(data) || data.message
            || (typeof window.t === 'function' ? window.t('insufficient_credits_msg') : 'Not enough minutes for this file.');
        if (typeof showStatus === 'function') {
            showStatus(msg, true, { duration: 12000, toastPosition: 'above', toastAnchorId: 'main-btn' });
        }
        if (data && (data.error === 'insufficient_credits' || Number.isFinite(Number(data.credit_minutes)))) {
            qsApplyTriggerCreditFields(data);
        }
        return false;
    } catch (err) {
        console.warn('qsEnsureCreditsForUpload failed:', err);
        if (typeof showStatus === 'function') {
            showStatus(
                typeof window.t === 'function' ? window.t('error_starting_upload') : 'Error starting upload.',
                true
            );
        }
        return false;
    }
}

function qsUploadMediaDurationForApi() {
    const stored = Number(window.__QS_UPLOAD_MEDIA_DURATION_SEC);
    if (Number.isFinite(stored) && stored > 0) return stored;
    return qsClientMediaDurationSecForCredits();
}

/** Server sends audio_profile + transcription_options on /api/trigger_processing — log clearly (browser has no server logging). */
function qsLogAudioProfileFromTrigger(jobId, triggerData) {
    try {
        const td = triggerData || {};
        if (td.audio_profile_skipped_reason === 'medical_mode') return;
        const ap = td.audio_profile;
        const profileSource = td.audio_profile_source || null;
        const reason = td.audio_profile_reason;
        const varEv = td.audio_profile_energy_variance;
        const postIntroVar = td.audio_profile_post_intro_energy_variance;
        const tailVar = td.audio_profile_tail_energy_variance;
        const threshold = td.audio_profile_threshold;
        const basis = td.audio_profile_classification_basis;
        const topts = td.transcription_options && typeof td.transcription_options === 'object' ? td.transcription_options : {};
        const ffStderr = td.audio_profile_ffmpeg_stderr_tail || null;
        let headline = '[audio-profile] ';
        if (ap === 'music') headline += 'Music detected';
        else if (ap === 'speech') headline += 'Speech detected';
        else headline += `Classification: ${ap != null ? String(ap) : 'missing'}`;
        if (reason) headline += ` (${reason})`;
        // console.log is silenced on non-localhost (__QS_CONSOLE_ENABLED gate); console.error is not patched — stays visible.
        const payload = {
            jobId,
            audio_profile_source: profileSource,
            transcription_options: topts,
            use_vad: topts.use_vad,
            vad_options_source: topts.vad_options_source || null,
            vad_force_enable_env_active: topts.vad_force_enable_env_active === true,
            audio_profile_reason: reason || null,
            energy_variance: varEv != null ? varEv : null,
            post_intro_energy_variance: postIntroVar != null ? postIntroVar : null,
            tail_energy_variance: tailVar != null ? tailVar : null,
            threshold: threshold != null ? threshold : null,
            classification_basis: basis || null,
            ffmpeg_stderr_tail: ffStderr,
        };
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
            console.error(headline, '| job:', jobId, '|', payload);
        }
        qsUploadTraceErr('audio_profile', {
            jobId,
            audio_profile_source: profileSource,
            audio_profile: ap != null ? ap : 'missing',
            audio_profile_reason: reason || null,
            audio_profile_energy_variance: varEv != null ? varEv : null,
            audio_profile_post_intro_energy_variance: postIntroVar != null ? postIntroVar : null,
            audio_profile_tail_energy_variance: tailVar != null ? tailVar : null,
            audio_profile_threshold: threshold != null ? threshold : null,
            audio_profile_classification_basis: basis || null,
            audio_profile_ffmpeg_stderr_tail: ffStderr,
            transcription_options: topts,
        });
    } catch (_) {}
}

async function qsAcquireUploadWakeLock() {
    try {
        if (typeof navigator !== 'undefined' && navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
            const wl = await navigator.wakeLock.request('screen');
            qsUploadTrace('wake_lock_acquired', {});
            return wl;
        }
    } catch (e) {
        qsUploadTrace('wake_lock_denied', { err: String((e && e.message) || e) });
    }
    return null;
}

function qsReleaseUploadWakeLock(wl) {
    if (!wl) return;
    try {
        if (typeof wl.release === 'function') wl.release();
        qsUploadTrace('wake_lock_released', {});
    } catch (_) {}
}

async function qsPostTriggerProcessingWithRetry(body, jobId) {
    const max = 4;
    let lastRes = null;
    let lastData = {};
    for (let attempt = 1; attempt <= max; attempt++) {
        qsUploadTrace('trigger_processing_attempt', { jobId, attempt });
        try {
            lastRes = await fetch('/api/trigger_processing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            lastData = await lastRes.json().catch(() => ({}));
            if (lastRes.ok) {
                qsUploadTrace('trigger_processing_ok', {
                    jobId,
                    attempt,
                    httpStatus: lastRes.status,
                    engine: lastData.engine,
                    endpoint: lastData.endpoint,
                    audio_profile: lastData.audio_profile,
                    transcription_options: lastData.transcription_options,
                });
                if (lastData.engine) {
                    console.info('[trigger] trigger_processing engine:', lastData.engine, lastData.endpoint || '');
                }
                qsLogAudioProfileFromTrigger(jobId, lastData);
                return { triggerRes: lastRes, triggerData: lastData };
            }
            const retryable = lastRes.status === 502 || lastRes.status === 503 || lastRes.status === 504 || lastRes.status === 429;
            qsUploadTrace('trigger_processing_http_nack', { jobId, attempt, httpStatus: lastRes.status, retryable });
            if (!retryable || attempt === max) {
                return { triggerRes: lastRes, triggerData: lastData };
            }
        } catch (e) {
            qsUploadTrace('trigger_processing_fetch_error', { jobId, attempt, err: String((e && e.message) || e) });
            if (attempt === max) throw e;
        }
        await new Promise((r) => setTimeout(r, 600 * attempt));
    }
    return { triggerRes: lastRes, triggerData: lastData };
}

async function qsS3MultipartAbortQuiet(payload) {
    try {
        await fetch('/api/sign-s3-multipart-abort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch (_) {}
}

/**
 * S3 multipart upload (presigned PUT per part + server-side complete).
 * Ensure the S3 bucket CORS rule exposes ETag for PUT (ExposeHeader: ETag).
 */
async function qsS3MultipartUploadFile(opts) {
    const {
        currentFile,
        userId,
        uploadId,
        s3Key,
        bucket,
        partSizeBytes,
        partCount,
        uploadLabel,
        mainBtn,
        isMedical,
    } = opts;

    const fileSize = currentFile.size;
    const rawPartBytes = Number(partSizeBytes);
    const effectivePartBytes = (
        Number.isFinite(rawPartBytes) && rawPartBytes >= QS_S3_MULTIPART_MIN_PART_BYTES
    ) ? rawPartBytes : QS_S3_MULTIPART_MIN_PART_BYTES;
    const computedPartCount = Math.max(1, Math.ceil(fileSize / effectivePartBytes));
    const rawPartCount = Number(partCount);
    let effectivePartCount = (
        Number.isFinite(rawPartCount) && rawPartCount >= 1
    ) ? rawPartCount : computedPartCount;
    if (Math.abs(effectivePartCount - computedPartCount) > 1) {
        effectivePartCount = computedPartCount;
    }
    qsUploadTraceErr('s3_multipart_plan', {
        fileSize,
        partSizeBytes: effectivePartBytes,
        partCount: effectivePartCount,
        serverPartSizeBytes: partSizeBytes,
        serverPartCount: partCount,
    });

    let uploadedSoFar = 0;

    const updateProgress = () => {
        let pct;
        if (fileSize > 0) {
            pct = Math.min(100, Math.round((uploadedSoFar / fileSize) * 100));
        } else {
            pct = 100;
        }
        qsSetProgressBarPct(pct);
        if (mainBtn) qsSetMainBtnDynamicLabel(uploadLabel);
    };

    const partMeta = [];
    const BATCH = 24;
    let PARALLEL = 6;
    if (fileSize >= QS_LARGE_UPLOAD_BYTES) PARALLEL = 4;
    else if (fileSize >= 100 * 1024 * 1024) PARALLEL = 5;

    for (let startPn = 1; startPn <= effectivePartCount; startPn += BATCH) {
        const batch = [];
        for (let p = startPn; p < startPn + BATCH && p <= effectivePartCount; p++) batch.push(p);

        const urlRes = await fetch('/api/sign-s3-multipart-part-urls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId,
                isMedical,
                bucket,
                s3Key,
                uploadId,
                partNumbers: batch,
            }),
        });
        const urlJson = await urlRes.json().catch(() => ({}));
        if (!urlRes.ok || !urlJson.data || !Array.isArray(urlJson.data.parts)) {
            throw new Error(urlJson.message || urlJson.error || 'Failed to presign upload parts');
        }
        const urlByPart = {};
        urlJson.data.parts.forEach((row) => {
            urlByPart[row.partNumber] = row.url;
        });

        const uploadOne = async (pn) => {
            const start = (pn - 1) * effectivePartBytes;
            const end = Math.min(fileSize, pn * effectivePartBytes);
            const blob = currentFile.slice(start, end);
            if (pn === 1 || pn === effectivePartCount) {
                qsUploadTraceErr('s3_multipart_part_bytes', {
                    partNumber: pn,
                    blobBytes: blob.size,
                    rangeStart: start,
                    rangeEnd: end,
                });
            }
            if (blob.size <= 0 && fileSize > 0) {
                throw new Error('Part ' + pn + ' is empty (partSizeBytes=' + effectivePartBytes + ')');
            }
            const url = urlByPart[pn];
            if (!url) throw new Error('Missing presigned URL for part ' + pn);
            const putRes = await fetch(url, { method: 'PUT', body: blob });
            if (!putRes.ok) {
                throw new Error('Part ' + pn + ' upload failed: HTTP ' + putRes.status);
            }
            const etag = putRes.headers.get('ETag') || putRes.headers.get('etag');
            if (!etag) {
                throw new Error(
                    'Missing ETag for part ' + pn + '. Configure S3 CORS ExposeHeader: ETag for PUT.'
                );
            }
            uploadedSoFar += blob.size;
            updateProgress();
            partMeta.push({ partNumber: pn, eTag: etag });
        };

        for (let i = 0; i < batch.length; i += PARALLEL) {
            const sub = batch.slice(i, i + PARALLEL);
            await Promise.all(sub.map((pn) => uploadOne(pn)));
        }
    }

    uploadedSoFar = fileSize;
    updateProgress();

    partMeta.sort((a, b) => a.partNumber - b.partNumber);

    const completeRes = await fetch('/api/sign-s3-multipart-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId,
            isMedical,
            bucket,
            s3Key,
            uploadId,
            parts: partMeta,
        }),
    });
    const completeJson = await completeRes.json().catch(() => ({}));
    if (!completeRes.ok || completeJson.status === 'error') {
        throw new Error(completeJson.message || completeJson.error || 'Multipart complete failed');
    }
}

const QS_ACTIVE_JOB_STARTED_KEY = 'activeJobStartedAt';
/** Match server CHECK_STATUS_MAX_AFTER_QUEUED_SEC (~90m); do not resume stale jobs on refresh. */
const QS_ACTIVE_JOB_RESUME_MAX_MS = 90 * 60 * 1000;

window.qsSetActiveJob = function (jobId) {
    const id = String(jobId || '').trim();
    if (!id) return;
    try {
        localStorage.setItem('activeJobId', id);
        localStorage.setItem(QS_ACTIVE_JOB_STARTED_KEY, String(Date.now()));
    } catch (_) {}
};

window.qsClearActiveJob = function () {
    ['activeJobId', 'pendingJobId', 'pendingS3Key', QS_ACTIVE_JOB_STARTED_KEY].forEach((k) => {
        try { localStorage.removeItem(k); } catch (_) {}
    });
};

/** Active job worth resuming after refresh (recent + not dismissed). */
window.qsGetActiveJobForResume = function () {
    const jobId = String(localStorage.getItem('activeJobId') || '').trim();
    if (!jobId) return '';
    let started = parseInt(localStorage.getItem(QS_ACTIVE_JOB_STARTED_KEY) || '0', 10);
    if (!started) {
        // Jobs parked before qsSetActiveJob stored a timestamp — do not clear on socket reconnect.
        started = Date.now();
        try { localStorage.setItem(QS_ACTIVE_JOB_STARTED_KEY, String(started)); } catch (_) {}
    }
    if ((Date.now() - started) > QS_ACTIVE_JOB_RESUME_MAX_MS) {
        window.qsClearActiveJob();
        return '';
    }
    return jobId;
};

// --- 1. GLOBAL SOCKET INITIALIZATION ---
if (typeof socket !== 'undefined') {
    socket.on('connect', () => {
        const savedJobId = typeof window.qsGetActiveJobForResume === 'function'
            ? window.qsGetActiveJobForResume()
            : String(localStorage.getItem('activeJobId') || '').trim();
        if (savedJobId) {
            console.log('🔄 Re-joining room:', savedJobId);
            socket.emit('join', { room: savedJobId });
        }
        const warmUid = String(window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
        if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
            if (typeof qsJoinMedicalEndpointScaleEvents === 'function') qsJoinMedicalEndpointScaleEvents();
        }
    });

    socket.on('disconnect', () => {
        window.__QS_MEDICAL_WARMUP_SOCKET_ROOM = null;
    });

    const qsPollMedicalEndpointFromAws = () => {
        if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) return;
        const uid = String(window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
        if (!uid || typeof qsPollMedicalWarmupStatus !== 'function') return;
        void qsPollMedicalWarmupStatus(uid, window.__QS_MEDICAL_WARMUP_JOB_ID).then((pollData) => {
            if (pollData && typeof qsApplyMedicalWarmupStatusFromServer === 'function') {
                qsApplyMedicalWarmupStatusFromServer(pollData, { playChime: false });
            }
        }).catch(() => {});
    };
    socket.on('medical_endpoint_ready', qsPollMedicalEndpointFromAws);
    socket.on('medical_warmup_ready', qsPollMedicalEndpointFromAws);
    socket.on('medical_endpoint_scaled_down', () => {
        if (typeof qsClearMedicalSessionWarmupSubmitted === 'function') qsClearMedicalSessionWarmupSubmitted();
        qsPollMedicalEndpointFromAws();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (typeof isMedicalModeEnabled !== 'function' || !isMedicalModeEnabled()) return;
        if (typeof qsPollMedicalWarmupStatus === 'function') {
            void qsPollMedicalWarmupStatus(
                window.__QS_MEDICAL_WARMUP_USER_ID,
                window.__QS_MEDICAL_WARMUP_JOB_ID
            ).catch(() => {});
        }
    });

    socket.on('job_status_update', (data) => {
        console.log("📩 AI Results Received via Socket:", data);
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        console.info('[qs-processing-ui] socket job_status_update received; scheduling handleJobUpdate', {
            ts: new Date().toISOString(),
            jobId: data && (data.jobId || (data.result && data.result.jobId))
        });
        // Yield so the browser can paint (phase overlay / button) before heavy translate + render work.
        setTimeout(() => {
            const dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
            console.info('[qs-processing-ui] handleJobUpdate starting', { delay_ms: Math.round(dt) });
            if (typeof window.handleJobUpdate === 'function') {
                qsInvokeHandleJobUpdate(data);
            }
        }, 0);
    });
}



// --- 2. AUTH HELPERS ---

const formatTime = (s) => {
    // Show mm:ss.xx (2 decimals) to match WhisperX word timestamps.
    const sec = Number(s);
    if (!Number.isFinite(sec)) return "00:00.00";
    const cs = Math.max(0, Math.round(sec * 100)); // centiseconds
    const mm = Math.floor(cs / 6000);
    const ss = Math.floor((cs % 6000) / 100);
    const frac = cs % 100;
    const m2 = String(mm).padStart(2, '0');
    const s2 = String(ss).padStart(2, '0');
    const f2 = String(frac).padStart(2, '0');
    return `${m2}:${s2}.${f2}`;
};

/** Parse displayed time (e.g. "00:12" or "1:30:00") to seconds. Returns NaN if invalid. */
function parseTimeDisplay(str) {
    if (!str || typeof str !== 'string') return NaN;
    const parts = str.trim().split(':').map(p => parseFloat(p.replace(/,/g, '.')));
    if (parts.some(n => isNaN(n))) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts.length === 1 ? parts[0] : NaN;
}

// Get character offset of the caret within an element (for contenteditable). Returns offset in [0, textLength].
function getCaretCharacterOffsetWithin(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;

    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.endContainer, range.endOffset);

    return preRange.toString().length;
}

const getSpeakerColor = (id) => {
    const colors = ['#5d5dff', '#9333ea', '#059669', '#d97706'];
    const num = id ? parseInt(id.match(/\d+/)) : 0;
    return colors[num % colors.length];
};

const formatSpeaker = (raw) => {
    if (!raw) return "דובר לא ידוע";
    const match = raw.match(/SPEAKER_(\d+)/);
    return match ? `דובר ${parseInt(match[1]) + 1}` : raw;
};


window.qsCloseMobileNav = function qsCloseMobileNav() {
    if (typeof toggleMenu === 'function') {
        toggleMenu(false);
        return;
    }
    const navMenu = document.getElementById('nav-menu');
    const hamburger = document.getElementById('hamburger-menu') || document.querySelector('.hamburger-menu');
    if (navMenu) {
        navMenu.classList.remove('active');
        navMenu.hidden = true;
    }
    if (hamburger) {
        hamburger.classList.remove('open');
        try { hamburger.setAttribute('aria-expanded', 'false'); } catch (_) {}
    }
};

window.toggleModal = function(show) {
    if (show) {
        try { window.qsCloseMobileNav(); } catch (_) {}
        // Save the key before the user starts logging in
        const currentKey = localStorage.getItem('lastS3Key');
        if (currentKey) localStorage.setItem('pendingS3Key', currentKey);
        try {
            if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
                saveMedicalAuthSnapshotForPendingSignIn();
            }
        } catch (_) {}
    }
    const modal = document.getElementById('auth-modal');
    if (modal) modal.style.display = show ? 'flex' : 'none';
};

function applyAuthModalMode() {
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    const titleEl = document.getElementById('modal-title');
    const signupFieldsEl = document.getElementById('signup-fields');
    const authSubmitBtnEl = document.getElementById('auth-submit-btn');
    const authSwitchTextEl = document.getElementById('auth-switch-text');
    const toggleAuthModeEl = document.getElementById('toggle-auth-mode');
    const skipBtn = document.getElementById('auth-skip-for-now');
    if (titleEl) titleEl.textContent = isSignUpMode ? T('get_started') : T('welcome_back');
    if (signupFieldsEl) signupFieldsEl.style.display = isSignUpMode ? 'block' : 'none';
    if (authSubmitBtnEl) authSubmitBtnEl.textContent = T('send_magic_link');
    if (authSwitchTextEl) authSwitchTextEl.textContent = isSignUpMode ? T('already_have') : T('need_account');
    if (toggleAuthModeEl) toggleAuthModeEl.textContent = isSignUpMode ? T('log_in') : T('sign_up');
    if (skipBtn) skipBtn.style.display = '';
}

async function requireUserForCopyOrDownload() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) return true;
    try {
        if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
            saveMedicalAuthSnapshotForPendingSignIn();
            try { sessionStorage.setItem('qs_medical_sign_in_for_copy', '1'); } catch (_) {}
        }
    } catch (_) {}
    isSignUpMode = true;
    applyAuthModalMode();
    if (typeof window.toggleModal === 'function') window.toggleModal(true);
    const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
    if (typeof showStatus === 'function') {
        showStatus(
            isHebrewUi ? 'התחברו כדי להעתיק או להוריד.' : 'Sign in to copy or download.',
            true
        );
    }
    return false;
}

function qsCurrentUrlLooksLikeAuthCallback() {
    try {
        const search = new URLSearchParams(window.location.search || '');
        if (search.has('code') || search.has('error') || search.has('error_description')) return true;
    } catch (_) {}
    try {
        const hash = String(window.location.hash || '');
        return /(?:access_token|refresh_token|error_description)=/.test(hash);
    } catch (_) {
        return false;
    }
}

function qsLikelyHasPersistedAuthSession() {
    try {
        const raw = qsSupabaseAuthStorage.getItem(QS_SUPABASE_AUTH_STORAGE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return !!(parsed && (parsed.access_token || parsed.currentSession?.access_token || parsed.refresh_token || parsed.currentSession?.refresh_token));
    } catch (_) {
        return false;
    }
}

async function qsGetAuthUserForUi(options = {}) {
    const waitMs = Math.max(0, Number(options.waitMs || 0));
    const shouldWait = waitMs > 0 && (qsCurrentUrlLooksLikeAuthCallback() || qsLikelyHasPersistedAuthSession());
    const deadline = Date.now() + (shouldWait ? waitMs : 0);
    do {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) return user;
        } catch (_) {}
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session && session.user) return session.user;
        } catch (_) {}
        if (!shouldWait || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (true);
    return null;
}
window.qsGetAuthUserForUi = qsGetAuthUserForUi;

async function qsEnsureWelcomeCredits() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session && session.access_token ? session.access_token : '';
        if (!token) return null;
        const user = session && session.user ? session.user : null;
        const info = user && typeof getAuthUserDisplayInfo === 'function' ? getAuthUserDisplayInfo(user) : null;
        const user_name = info && info.displayName && info.displayName !== 'Account' ? info.displayName : null;
        const res = await fetch('/api/user/credits/ensure-welcome', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(user_name ? { user_name } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            console.warn('qsEnsureWelcomeCredits:', data.error || res.status);
            return null;
        }
        const minutes = Number(data.credit_minutes);
        if (Number.isFinite(minutes)) {
            try { window.__QS_USER_CREDIT_MINUTES = minutes; } catch (_) {}
        }
        qsSyncUserCreditsUi();
        qsApplyDefaultPlanFromCredits();
        return data;
    } catch (err) {
        console.warn('qsEnsureWelcomeCredits failed:', err);
        return null;
    }
}

async function qsRefreshUserCredits(options = {}) {
    options = options || {};
    const silent = !!options.silent;
    try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session && session.access_token ? session.access_token : '';
        if (!token) {
            try { window.__QS_USER_CREDIT_MINUTES = null; } catch (_) {}
            qsSyncUserCreditsUi();
            return null;
        }
        if (options.ensureWelcome && !silent) {
            const ensured = await qsEnsureWelcomeCredits();
            if (ensured) return ensured;
        }
        const res = await fetch('/api/user/credits', {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (!silent) console.warn('qsRefreshUserCredits:', data.error || res.status);
            return null;
        }
        const minutes = Number(data.credit_minutes);
        if (Number.isFinite(minutes)) {
            try { window.__QS_USER_CREDIT_MINUTES = minutes; } catch (_) {}
        }
        qsSyncUserCreditsUi();
        if (!silent) {
            qsApplyDefaultPlanFromCredits();
        }
        return data;
    } catch (err) {
        if (!silent) console.warn('qsRefreshUserCredits failed:', err);
        return null;
    }
}

function qsShouldShowCreditBalance() {
    try {
        if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return false;
    } catch (_) {}
    try {
        if (window.__QS_MEDICAL_URL_ENTRY === true) return false;
    } catch (_) {}
    try {
        const p = (window.location && window.location.pathname)
            ? String(window.location.pathname).replace(/\/+$/, '') || '/'
            : '/';
        if (p === '/medical') return false;
    } catch (_) {}
    return true;
}

function qsSyncUserCreditsUi() {
    const signedIn = !!window.__QS_UX_USER_SIGNED_IN;
    const showCredits = signedIn && qsShouldShowCreditBalance();
    const minutes = Number(window.__QS_USER_CREDIT_MINUTES);
    const hasValue = Number.isFinite(minutes);
    const displayMinutes = hasValue ? String(Math.max(0, Math.floor(minutes))) : '0';
    const navWrap = document.getElementById('nav-credit-balance');
    const navMinutes = document.getElementById('nav-credit-minutes');
    const navWrapMobile = document.getElementById('nav-credit-balance-mobile');
    const navMinutesMobile = document.getElementById('nav-credit-minutes-mobile');
    const menuWrap = document.getElementById('user-menu-credits');
    const menuMinutes = document.getElementById('user-menu-credit-minutes');
    if (navWrap) navWrap.style.display = showCredits ? 'inline-flex' : 'none';
    if (navMinutes) navMinutes.textContent = displayMinutes;
    if (navWrapMobile) navWrapMobile.style.display = 'none';
    if (navMinutesMobile) navMinutesMobile.textContent = displayMinutes;
    if (menuWrap) menuWrap.style.display = showCredits ? '' : 'none';
    if (menuMinutes) menuMinutes.textContent = displayMinutes;
    try { if (typeof qsSyncStarterPlanUploadGate === 'function') qsSyncStarterPlanUploadGate(); } catch (_) {}
}

const QS_STARTER_PLAN_KEY = 'qs_starter_plan_selected';
const QS_SELECTED_PLAN_KEY = 'qs_selected_plan';

function qsGetStoredPlan() {
    try {
        const current = String(localStorage.getItem(QS_SELECTED_PLAN_KEY) || '').trim();
        if (current === 'starter' || current === 'pro' || current === 'enterprise') return current;
        if (localStorage.getItem(QS_STARTER_PLAN_KEY) === '1') return 'starter';
    } catch (_) {}
    return 'starter';
}

function qsGetSelectedPlan() {
    const stored = qsGetStoredPlan();
    const minutes = Number(window.__QS_USER_CREDIT_MINUTES);
    if (Number.isFinite(minutes) && minutes > 0 && stored !== 'pro' && stored !== 'enterprise') {
        return 'starter';
    }
    return stored;
}

function qsApplyDefaultPlanFromCredits() {
    try {
        const minutes = Number(window.__QS_USER_CREDIT_MINUTES);
        if (!Number.isFinite(minutes) || minutes <= 0) return;
        const stored = qsGetStoredPlan();
        if (stored === 'pro' || stored === 'enterprise') return;
        try { localStorage.setItem(QS_SELECTED_PLAN_KEY, 'starter'); } catch (_) {}
        if (typeof window.syncPlanCardsUi === 'function') window.syncPlanCardsUi();
        else if (typeof qsSyncStarterPlanUploadGate === 'function') qsSyncStarterPlanUploadGate();
    } catch (_) {}
}
window.qsEnsureWelcomeCredits = qsEnsureWelcomeCredits;
window.qsRefreshUserCredits = qsRefreshUserCredits;
window.qsSyncUserCreditsUi = qsSyncUserCreditsUi;
window.qsApplyDefaultPlanFromCredits = qsApplyDefaultPlanFromCredits;
window.qsGetSelectedPlan = qsGetSelectedPlan;

async function maybeShowInitialRegistrationPrompt() {
    try {
        const modal = document.getElementById('auth-modal');
        if (!modal) return;
        const user = await qsGetAuthUserForUi({ waitMs: 5000 });
        if (user) return;
        if (window.__QS_REG_PROMPT_DISMISSED_THIS_PAGE === true) return;
        if (window.isTriggering === true) return;
        try {
            if (String(localStorage.getItem('activeJobId') || '').trim()) return;
        } catch (_) {}
        isSignUpMode = true;
        applyAuthModalMode();
        if (typeof window.toggleModal === 'function') window.toggleModal(true);
    } catch (_) {}
}

// --- SUBTITLE CHUNKER ---
function splitLongSegments(segments, maxChars = 40) {
    const result = [];

    function pushChunk(chunks, text) {
        const t = text.trim();
        if (!t) return;
        if (t.length <= maxChars) {
            chunks.push(t);
            return;
        }
        for (let i = 0; i < t.length; i += maxChars) {
            chunks.push(t.slice(i, i + maxChars));
        }
    }

    for (const seg of segments) {
        // If it's already short enough, just keep it
        if (!seg.text || seg.text.length <= maxChars) {
            result.push(seg);
            continue;
        }

        // Split by ANY kind of space (crucial for Hebrew AI non-breaking spaces)
        const words = seg.text.split(/\s+/);
        let currentText = '';
        let chunks = [];

        // Group words into chunks that fit the maxChars limit
        for (const word of words) {
            // Single word longer than limit: flush current line, then split the word by chars
            if (word.length > maxChars) {
                pushChunk(chunks, currentText);
                currentText = '';
                for (let i = 0; i < word.length; i += maxChars) {
                    chunks.push(word.slice(i, i + maxChars));
                }
                continue;
            }

            // Check if adding this word (with space) would exceed the limit
            const testText = currentText + word + ' ';
            if (testText.length > maxChars && currentText.length > 0) {
                pushChunk(chunks, currentText);
                currentText = word + ' ';
            } else {
                currentText += word + ' ';
            }
        }
        pushChunk(chunks, currentText);

        // Assign proportional timeframes to the new chunks; enforce minimum duration so no 33ms segments
        const totalDuration = (seg.end || seg.start + 5) - seg.start;
        const totalChars = Math.max(1, seg.text.length);
        const MIN_CHUNK_DUR = 0.5;
        const rawDurations = chunks.map(chunk => Math.max(MIN_CHUNK_DUR, (chunk.length / totalChars) * totalDuration));
        const sum = rawDurations.reduce((a, b) => a + b, 0);
        const scale = sum > 0 && totalDuration < sum ? totalDuration / sum : 1;
        const durations = rawDurations.map(d => d * scale);
        let currentTime = seg.start;

        for (let i = 0; i < chunks.length; i++) {
            const chunkDuration = durations[i];
            result.push({
                start: currentTime,
                end: currentTime + chunkDuration,
                text: chunks[i],
                speaker: seg.speaker
            });
            currentTime += chunkDuration;
        }
    }
    return result;
}

/** User-facing messages.
 *  Errors  → blocking dialog with אישור / OK button.
 *  Non-errors → auto-dismissing toast (no button needed).
 */
function showStatus(message, isError = false, options = {}) {
    if (!message && message !== 0) return;
    const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
    const _translateStatusMessage = (msg) => {
        const raw = String(msg || '');
        if (!isHebrewUi) return raw;
        const unknownErr = 'שגיאה לא ידועה';
        if (raw === 'Retry failed') return 'הניסיון החוזר נכשל';
        if (raw === 'No uploaded file found for this recording.') return 'לא נמצא קובץ שהועלה עבור ההקלטה הזאת.';
        if (raw.startsWith('Transcribe failed: ')) {
            const tail = raw.slice('Transcribe failed: '.length).trim();
            const heTail = tail === 'Unknown error' ? unknownErr : tail;
            return `התמלול נכשל: ${heTail}`;
        }
        if (raw === 'Recording deleted') return 'ההקלטה נמחקה';
        if (raw.startsWith('Delete failed: ')) {
            const tail = raw.slice('Delete failed: '.length).trim();
            const heTail = tail === 'Unknown error' ? unknownErr : tail;
            return `המחיקה נכשלה: ${heTail}`;
        }
        if (raw === 'Recording renamed') return 'שם ההקלטה עודכן';
        if (raw.startsWith('Rename failed: ')) {
            const tail = raw.slice('Rename failed: '.length).trim();
            const heTail = tail === 'Unknown error' ? unknownErr : tail;
            return `שינוי השם נכשל: ${heTail}`;
        }
        if (raw === 'Could not load file.') return 'לא ניתן לטעון את הקובץ.';
        if (raw === 'Please sign in to download the movie.') return 'יש להתחבר כדי להוריד את הווידאו.';
        if (raw === 'No transcript available to export.') return 'אין תמלול זמין לייצוא.';
        if (raw === 'Load a video first, then use Styled Subtitles before downloading the movie.') {
            return 'יש לטעון קודם וידאו, להשתמש בכתוביות מעוצבות ואז להוריד את הסרטון.';
        }
        if (raw === 'Video must be from your uploads (save and use Styled Subtitles from an uploaded video).') {
            return 'הווידאו חייב להיות מהקבצים שהעלית (יש לשמור ולהשתמש בכתוביות מעוצבות על וידאו שהועלה).';
        }
        if (raw === 'Error: FileSaver library not loaded.') return 'שגיאה: ספריית FileSaver לא נטענה.';
        if (raw.startsWith('Google Login Error: ')) {
            return `שגיאת התחברות עם Google: ${raw.slice('Google Login Error: '.length).trim()}`;
        }
        if (raw === 'Select at least one output to generate.') return 'יש לבחור לפחות פלט אחד ליצירה.';
        if (raw === 'Missing recording context for transcription.') return 'חסר מידע הקשרי להקלטה לצורך תמלול.';
        if (raw === 'JSON transcript loaded locally.') return 'קובץ תמלול JSON נטען מקומית.';
        if (raw === 'No subtitle cues detected in this file. Please use a standard .srt/.vtt format.') {
            return 'לא זוהו מקטעי כתוביות בקובץ. יש להשתמש בפורמט תקני ‎.srt/.vtt‎.';
        }
        if (raw === 'Unknown error') return unknownErr;
        return raw;
    };
    const str = _translateStatusMessage(String(message));
    if (isError) {
        showGlobalAlert(str, { confirmText: isHebrewUi ? 'אישור' : 'OK' });
    } else {
        _showToast(str, options);
    }
}

function _showToast(message, options = {}) {
    const duration = typeof options === 'number' ? options : (options.duration ?? 3000);
    const position = (typeof options === 'object' && options.toastPosition) ? String(options.toastPosition) : 'bottom';
    const anchorId = (typeof options === 'object' && options.toastAnchorId) ? String(options.toastAnchorId) : '';
    let toast = document.getElementById('qs-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'qs-toast';
        toast.style.cssText = [
            'position:fixed', 'bottom:28px', 'left:50%', 'transform:translateX(-50%)',
            'background:#1e293b', 'color:#f8fafc', 'padding:10px 22px',
            'border-radius:10px', 'font-size:0.92rem', 'font-weight:500',
            'box-shadow:0 4px 18px rgba(0,0,0,0.22)', 'z-index:99999',
            'opacity:0', 'transition:opacity 0.2s ease', 'pointer-events:none',
            'white-space:nowrap', 'max-width:92vw', 'text-align:center'
        ].join(';');
        document.body.appendChild(toast);
    }
    clearTimeout(toast._hideTimer);
    toast.textContent = message;
    const long = String(message).length > 55;
    toast.style.whiteSpace = long ? 'normal' : 'nowrap';
    toast.style.maxWidth = long ? 'min(92vw, 520px)' : '92vw';
    if (position === 'center') {
        let cx = window.innerWidth / 2;
        let cy = window.innerHeight / 2;
        if (anchorId) {
            const anchor = document.getElementById(anchorId);
            if (anchor) {
                const r = anchor.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    cx = r.left + (r.width / 2);
                    cy = r.top + (r.height / 2);
                }
            }
        }
        toast.style.left = `${Math.round(cx)}px`;
        toast.style.top = `${Math.round(cy)}px`;
        toast.style.bottom = 'auto';
        toast.style.transform = 'translate(-50%, -50%)';
    } else if (position === 'above' && anchorId) {
        const anchor = document.getElementById(anchorId);
        if (anchor) {
            const r = anchor.getBoundingClientRect();
            toast.style.left = `${Math.round(r.left + (r.width / 2))}px`;
            toast.style.top = `${Math.round(Math.max(12, r.top - 10))}px`;
            toast.style.bottom = 'auto';
            toast.style.transform = 'translate(-50%, -100%)';
        } else {
            toast.style.top = 'auto';
            toast.style.bottom = '28px';
            toast.style.left = '50%';
            toast.style.transform = 'translateX(-50%)';
        }
    } else {
        toast.style.top = 'auto';
        toast.style.bottom = '28px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
    }
    toast.style.opacity = '1';
    toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}
window.showStatus = showStatus;

function _hideToastNow() {
    const toast = document.getElementById('qs-toast');
    if (!toast) return;
    try { clearTimeout(toast._hideTimer); } catch (_) {}
    toast.style.opacity = '0';
}

let _translationProgressInterval = null;
let _translationProgressTargetLang = '';
let _translationProgressDetail = '';

function _formatTranslationElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

/** Persistent bar above the transcript while /api/translate_text runs (not a timed toast). */
function showTranslationProgressBar(targetLang) {
    const bar = document.getElementById('translation-progress-bar');
    const textEl = document.getElementById('translation-progress-text');
    if (!bar || !textEl) return;
    hideTranslationProgressBar();
    _hideToastNow();
    _translationProgressTargetLang = String(targetLang || '').trim() || '?';
    _translationProgressDetail = '';
    const he = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
    const tick = () => {
        const elapsed = _formatTranslationElapsed(Date.now() - (bar._qsTranslationStart || Date.now()));
        const detail = _translationProgressDetail ? ` ${_translationProgressDetail}` : '';
        if (he) {
            textEl.textContent = `מתרגם ל${_translationProgressTargetLang}… התהליך עדיין רץ${detail} (זמן שעבר: ${elapsed}). אפשר להמשיך לעבוד בלשונית הזו.`;
        } else {
            textEl.textContent = `Translating to ${_translationProgressTargetLang}… Still in progress${detail} (${elapsed} elapsed). You can keep working in this tab.`;
        }
    };
    bar._qsTranslationStart = Date.now();
    bar._qsTranslationTick = tick;
    bar.style.display = 'flex';
    tick();
    _translationProgressInterval = setInterval(tick, 1000);
    try { bar.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
}

function updateTranslationProgressDetail(detail) {
    _translationProgressDetail = String(detail || '').trim();
    const bar = document.getElementById('translation-progress-bar');
    if (bar && typeof bar._qsTranslationTick === 'function') {
        try { bar._qsTranslationTick(); } catch (_) {}
    }
}

function hideTranslationProgressBar() {
    if (_translationProgressInterval) {
        try { clearInterval(_translationProgressInterval); } catch (_) {}
        _translationProgressInterval = null;
    }
    const bar = document.getElementById('translation-progress-bar');
    if (bar) {
        bar.style.display = 'none';
        try { delete bar._qsTranslationStart; } catch (_) {}
        try { delete bar._qsTranslationTick; } catch (_) {}
    }
    _translationProgressTargetLang = '';
    _translationProgressDetail = '';
}

function qsSyncHomepageScrollMode() {
    const seo = document.getElementById('seo-home-content');
    if (!seo) return;
    let visible = false;
    try {
        visible = seo.style.display !== 'none' && window.getComputedStyle(seo).display !== 'none';
    } catch (_) {}
    document.body.classList.toggle('qs-homepage-landing', !!visible);
}

function setSeoHomeContentVisibility(visible) {
    const seo = document.getElementById('seo-home-content');
    if (!seo) return;
    if (isMedicalModeEnabled()) {
        seo.style.display = 'none';
        qsSyncHomepageScrollMode();
        return;
    }
    seo.style.display = visible ? '' : 'none';
    qsSyncHomepageScrollMode();
    try { if (typeof window.qsSyncStarterPlanUploadGate === 'function') window.qsSyncStarterPlanUploadGate(); } catch (_) {}
}

function qsIsStarterPlanSelected() {
    return qsGetSelectedPlan() === 'starter';
}

function qsUserHasUploadCredits() {
    const minutes = Number(window.__QS_USER_CREDIT_MINUTES);
    return Number.isFinite(minutes) && minutes > 0;
}

function qsRequiresStarterPlanGate() {
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return false;
    const seo = document.getElementById('seo-home-content');
    if (!seo) return false;
    const hidden = seo.style.display === 'none' || window.getComputedStyle(seo).display === 'none';
    return !hidden;
}

function qsSyncNavWorkspaceCta(isSignedIn) {
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    const desktop = document.getElementById('nav-dashboard-cta');
    const mobile = document.getElementById('nav-new-session-btn');
    [desktop, mobile].forEach((el) => {
        if (!el) return;
        if (isSignedIn) {
            el.style.display = '';
            el.hidden = false;
            el.href = '/personal';
            el.setAttribute('data-i18n', 'nav_personal');
            el.textContent = T('nav_personal');
        } else {
            el.style.display = 'none';
            el.hidden = true;
        }
    });
}
window.qsSyncNavWorkspaceCta = qsSyncNavWorkspaceCta;

function qsEnsureDefaultStarterPlan() {
    try {
        const current = String(localStorage.getItem(QS_SELECTED_PLAN_KEY) || '').trim();
        if (current !== 'starter' && current !== 'pro' && current !== 'enterprise') {
            localStorage.setItem(QS_SELECTED_PLAN_KEY, 'starter');
            if (typeof window.syncPlanCardsUi === 'function') window.syncPlanCardsUi();
        }
    } catch (_) {}
}
window.qsEnsureDefaultStarterPlan = qsEnsureDefaultStarterPlan;

function qsSyncStarterPlanUploadGate() {
    const mainBtn = document.getElementById('main-btn');
    const regularRecordBtn = document.getElementById('regular-record-btn');
    const gated = qsRequiresStarterPlanGate()
        && qsGetSelectedPlan() !== 'starter';
    document.body.classList.toggle('qs-starter-plan-required', gated);
    if (mainBtn) {
        if (mainBtn.getAttribute('data-qs-plan-gated') === '1') {
            mainBtn.removeAttribute('data-qs-plan-gated');
        }
        if (!window.isTriggering) mainBtn.disabled = false;
    }
    if (regularRecordBtn) {
        regularRecordBtn.disabled = false;
        regularRecordBtn.setAttribute('aria-disabled', 'false');
    }
}

function qsBlockIfStarterPlanRequired() {
    if (!qsRequiresStarterPlanGate()) return false;
    if (qsUserHasUploadCredits()) return false;
    const plan = qsGetSelectedPlan();
    if (plan === 'starter') return false;
    const pricing = document.getElementById('pricing-section') || document.getElementById('seo-pricing-starter');
    if (pricing) {
        try { pricing.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    }
    const focusCard = document.getElementById(
        plan === 'pro' ? 'seo-pricing-pro' : (plan === 'enterprise' ? 'seo-pricing-enterprise' : 'seo-pricing-starter')
    );
    if (focusCard) {
        focusCard.classList.add('qs-plan-attention');
        setTimeout(() => { try { focusCard.classList.remove('qs-plan-attention'); } catch (_) {} }, 1200);
    }
    if (typeof showStatus === 'function') {
        const isHe = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
        const msg = !plan
            ? (isHe ? 'בחרו תוכנית כדי להתחיל.' : 'Select a plan to begin.')
            : (isHe ? 'לביצוע העלאה בחינם, בחרו את מסלול Starter.' : 'Select the free Starter plan to upload.');
        showStatus(msg, true, { duration: 4500 });
    }
    return true;
}

window.qsGetSelectedPlan = qsGetSelectedPlan;
window.qsIsStarterPlanSelected = qsIsStarterPlanSelected;
window.qsRequiresStarterPlanGate = qsRequiresStarterPlanGate;
window.qsSyncStarterPlanUploadGate = qsSyncStarterPlanUploadGate;
window.qsBlockIfStarterPlanRequired = qsBlockIfStarterPlanRequired;

/** Keep marketing SEO block in sync: hide when a job/transcript is active (standard mode), same as after upload. */
function syncSeoBlockWithAppState() {
    const seo = document.getElementById('seo-home-content');
    if (!seo) return;
    if (isMedicalModeEnabled()) {
        seo.style.display = 'none';
        qsSyncHomepageScrollMode();
        return;
    }
    if (window.isTriggering) {
        seo.style.display = 'none';
        qsSyncHomepageScrollMode();
        return;
    }
    if (typeof initOpenAppHasLoadedTranscriptPayload === 'function' && initOpenAppHasLoadedTranscriptPayload()) {
        seo.style.display = 'none';
        qsSyncHomepageScrollMode();
        return;
    }
    try {
        const pContainer = document.getElementById('p-container');
        if (pContainer) {
            const st = window.getComputedStyle(pContainer);
            if (st && st.display !== 'none' && pContainer.offsetWidth > 0) {
                seo.style.display = 'none';
                qsSyncHomepageScrollMode();
                return;
            }
        }
    } catch (_) {}
    seo.style.display = '';
    qsSyncHomepageScrollMode();
    try { if (typeof window.qsSyncStarterPlanUploadGate === 'function') window.qsSyncStarterPlanUploadGate(); } catch (_) {}
}
/** Toggle nav auth elements (inline display loses to .nav-item { display:inline-flex !important }). */
function qsSetNavAuthVisible(el, visible) {
    if (!el) return;
    el.classList.toggle('qs-nav-auth-hidden', !visible);
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
}

function wireUserMenuTrigger(btn) {
    if (!btn) return;
    btn.onclick = (e) => {
        e.preventDefault();
        toggleUserMenu();
    };
    btn.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleUserMenu();
        }
    };
}

/** @param {object} [userOverride] - If provided (e.g. from updateUser), use this user instead of getUser() so the UI shows fresh data. */
async function setupNavbarAuth(userOverride) {
    const signInBtn = document.getElementById('nav-auth-btn');
    const signInMobile = document.getElementById('nav-auth-btn-mobile');
    const signedInWrap = document.getElementById('nav-utility-signed-in');
    const mobileSignedInWrap = document.getElementById('nav-mobile-signed-in');
    const nameTrigger = document.getElementById('nav-user-name-trigger');
    const nameTriggerMobile = document.getElementById('nav-user-name-trigger-mobile');
    const logoutBtn = document.getElementById('nav-logout-btn');
    const logoutBtnMobile = document.getElementById('nav-logout-btn-mobile');
    if (!signInBtn && !signedInWrap) return;

    const hadSignedInNav = !!(nameTrigger && nameTrigger.textContent && nameTrigger.textContent !== 'Account');
    const user = userOverride != null ? userOverride : await qsGetAuthUserForUi({ waitMs: 1500 });
    const T = typeof window.t === 'function' ? window.t : (k) => k;

    if (!user && hadSignedInNav && window.__QS_PRESERVE_NAVBAR_AUTH_ON_LOCALE_SWITCH === true) {
        try { window.__QS_UX_USER_SIGNED_IN = true; } catch (_) {}
        if (logoutBtn) logoutBtn.textContent = T('nav_logout');
        qsSyncNavWorkspaceCta(true);
        closeUserMenu();
        return;
    }

    try { window.__QS_UX_USER_SIGNED_IN = !!user; } catch (_) {}
    try { document.body.classList.toggle('qs-user-signed-in', !!user); } catch (_) {}
    if (user) {
        try { void qsRefreshUserCredits({ ensureWelcome: true }); } catch (_) {}
    } else {
        try { window.__QS_USER_CREDIT_MINUTES = null; } catch (_) {}
        qsSyncUserCreditsUi();
    }
    if (user && typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
        try { void window.qsRefreshMedicalEndpointStatus(); } catch (_) {}
    }

    const wireSignIn = (btn) => {
        if (!btn) return;
        qsSetNavAuthVisible(btn, !user);
        btn.onclick = (e) => {
            e.preventDefault();
            if (typeof window.toggleModal === 'function') window.toggleModal(true);
        };
    };

    const wireLogout = async () => {
        if (typeof _qsSignOutThenMedicalOrReload === 'function') {
            await _qsSignOutThenMedicalOrReload();
        } else {
            await supabase.auth.signOut();
            window.location.reload();
        }
    };

    if (signedInWrap) signedInWrap.style.display = user ? 'inline-flex' : 'none';
    wireSignIn(signInBtn);
    wireSignIn(signInMobile);

    qsSyncNavWorkspaceCta(!!user);

    if (user) {
        const { displayName } = getAuthUserDisplayInfo(user);
        wireUserMenuTrigger(nameTrigger);
        wireUserMenuTrigger(nameTriggerMobile);
        if (nameTrigger) nameTrigger.textContent = displayName;
        if (nameTriggerMobile) {
            nameTriggerMobile.textContent = displayName;
            nameTriggerMobile.removeAttribute('data-i18n');
        }
        if (logoutBtn) {
            logoutBtn.textContent = T('nav_logout');
            logoutBtn.onclick = (e) => {
                e.preventDefault();
                void wireLogout();
            };
        }
        if (logoutBtnMobile) {
            logoutBtnMobile.textContent = T('nav_logout');
            logoutBtnMobile.onclick = (e) => {
                e.preventDefault();
                void wireLogout();
            };
        }
        qsSetNavAuthVisible(signInBtn, false);
        qsSetNavAuthVisible(signInMobile, false);
        qsSetNavAuthVisible(mobileSignedInWrap, true);
        if (signInMobile) signInMobile.removeAttribute('data-i18n');
    } else {
        if (window.__QS_MEDICAL_URL_ENTRY) {
            setMedicalMode(true);
        } else if (isMedicalModeEnabled()) {
            setMedicalMode(false);
        }
        if (nameTrigger) nameTrigger.textContent = 'Account';
        if (nameTriggerMobile) nameTriggerMobile.textContent = 'Account';
        qsSetNavAuthVisible(signInBtn, true);
        qsSetNavAuthVisible(mobileSignedInWrap, false);
        qsSetNavAuthVisible(signInMobile, true);
        if (signInMobile && !signInMobile.getAttribute('data-i18n')) {
            signInMobile.setAttribute('data-i18n', 'nav_sign_in');
        }
    }
    closeUserMenu();
    if (typeof window.applyTranslations === 'function') {
        window.applyTranslations();
        if (user) {
            qsSyncNavWorkspaceCta(true);
        }
        if (logoutBtn && user) logoutBtn.textContent = T('nav_logout');
        if (signInBtn && !user) signInBtn.textContent = T('nav_sign_in');
    }
}
window.setupNavbarAuth = setupNavbarAuth;

function closeUserMenuOnClickOutside(e) {
    const panel = document.getElementById('user-menu-panel');
    const trigger = document.getElementById('nav-user-name-trigger');
    const triggerMobile = document.getElementById('nav-user-name-trigger-mobile');
    if (!panel || !panel.classList.contains('is-open')) return;
    if (panel.contains(e.target)
        || (trigger && trigger.contains(e.target))
        || (triggerMobile && triggerMobile.contains(e.target))) return;
    closeUserMenu();
}

function closeUserMenu() {
    const panel = document.getElementById('user-menu-panel');
    if (panel) {
        panel.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        document.removeEventListener('click', closeUserMenuOnClickOutside);
    }
}

function ensureUserMenuCloseButton() {
    const panel = document.getElementById('user-menu-panel');
    if (!panel) return null;
    const header = panel.querySelector('.user-menu-header');
    if (!header) return null;
    let closeBtn = document.getElementById('user-menu-close');
    if (!closeBtn) {
        closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.id = 'user-menu-close';
        closeBtn.className = 'user-menu-close-btn';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.title = 'Close';
        closeBtn.textContent = '✕';
        header.appendChild(closeBtn);
    }
    // Inline fallback style in case stale CSS is cached.
    closeBtn.style.display = 'inline-flex';
    closeBtn.style.alignItems = 'center';
    closeBtn.style.justifyContent = 'center';
    closeBtn.style.minWidth = '40px';
    closeBtn.style.height = '32px';
    closeBtn.style.padding = '0 10px';
    closeBtn.style.marginInlineStart = '8px';
    closeBtn.style.background = '#111827';
    closeBtn.style.color = '#ffffff';
    closeBtn.style.border = 'none';
    closeBtn.style.borderRadius = '8px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '0.95rem';
    closeBtn.style.fontWeight = '700';
    closeBtn.onclick = () => closeUserMenu();
    return closeBtn;
}

function ensureBurnProgressOverlay() {
    let overlay = document.getElementById('burn-progress-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'burn-progress-overlay';
        overlay.innerHTML = `
            <div class="burn-progress-card">
                <div id="burn-progress-text" class="burn-progress-text"></div>
                <div class="burn-progress-track"><div id="burn-progress-fill" class="burn-progress-fill"></div></div>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    return overlay;
}

function setBurnProgress(pct, text) {
    // Center overlay progress was removed per UX request.
    return;
}

function hideBurnProgress() {
    return;
}

async function toggleUserMenu() {
    const panel = document.getElementById('user-menu-panel');
    if (!panel) return;
    ensureUserMenuCloseButton();
    const isOpen = panel.classList.toggle('is-open');
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (isOpen) {
        try { window.qsCloseMobileNav(); } catch (_) {}
        const { data: { user } } = await supabase.auth.getUser();
        if (user) loadUserMenuProfile(user);
        document.addEventListener('click', closeUserMenuOnClickOutside);
    } else {
        document.removeEventListener('click', closeUserMenuOnClickOutside);
    }
}

/** Populate user menu panel with name + email (editable), note, Save and Cancel. */
async function loadUserMenuProfile(user) {
    const nameInput = document.getElementById('user-menu-name');
    const emailInput = document.getElementById('user-menu-email');
    const messageEl = document.getElementById('user-menu-profile-message');
    const saveBtn = document.getElementById('user-menu-save');
    const cancelBtn = document.getElementById('user-menu-cancel');
    const closeBtn = document.getElementById('user-menu-close');
    const medicalModeInput = document.getElementById('user-menu-medical-mode');
    const medicalTrainingInput = document.getElementById('user-menu-medical-training-mode');
    const medicalTrainingResetBtn = document.getElementById('user-menu-medical-training-reset');
    const medicalTrainingStatus = document.getElementById('user-menu-medical-training-status');
    if (!nameInput || !emailInput) return;

    const { displayName, email } = getAuthUserDisplayInfo(user);
    const currentName = displayName === 'Account' ? '' : displayName;
    const currentEmail = email || '';
    nameInput.value = currentName;
    emailInput.value = currentEmail;
    if (messageEl) { messageEl.style.display = 'none'; messageEl.textContent = ''; }
    if (medicalModeInput) {
        medicalModeInput.checked = isMedicalModeEnabled();
        medicalModeInput.onchange = () => {
            setMedicalMode(!!medicalModeInput.checked, { bypassMedicalUrlLock: true });
            if (messageEl) {
                messageEl.style.display = 'block';
                messageEl.textContent = medicalModeInput.checked
                    ? 'Medical mode enabled. Local data was cleared.'
                    : 'Medical mode disabled.';
                messageEl.style.color = '#059669';
            }
        };
    }
    if (medicalTrainingInput) {
        medicalTrainingInput.checked = isMedicalTrainingModeEnabled();
        medicalTrainingInput.onchange = async () => {
            const enabled = !!medicalTrainingInput.checked;
            if (!enabled) {
                setMedicalTrainingModeEnabled(false);
                if (medicalTrainingStatus) medicalTrainingStatus.textContent = 'מצב אימון כבוי.';
                try {
                    if (typeof renderTranscriptFromCues === 'function') renderTranscriptFromCues(window.currentSegments || []);
                } catch (_) {}
                return;
            }
            try {
                await activateMedicalTrainingFlow();
            } catch (_) {
                medicalTrainingInput.checked = false;
            }
        };
    }
    if (medicalTrainingResetBtn) {
        medicalTrainingResetBtn.onclick = async () => {
            if (medicalTrainingStatus) medicalTrainingStatus.textContent = 'מאפס אימון...';
            try {
                await medicalTrainingApi('/api/medical_training/reset', {});
                setMedicalTrainingModeEnabled(false);
                window._medicalTrainingCandidatePrompt = '';
                window._medicalTrainingCandidatePreview = null;
                window._medicalTrainingLearnedRules = [];
                window._medicalTrainingDoctorDraft = '';
                window._medicalTrainingPostLearnPreviewReady = false;
                window._medicalTrainingPanelExpanded = false;
                window._medicalTrainingBaselineForRetry = '';
                window._medicalTrainingApprovedCandidatePrompt = '';
                if (medicalTrainingInput) medicalTrainingInput.checked = false;
                if (medicalTrainingStatus) medicalTrainingStatus.textContent = 'האימון אופס והפרומפט האישי הושבת.';
                if (typeof renderTranscriptFromCues === 'function') renderTranscriptFromCues(window.currentSegments || []);
            } catch (e) {
                if (medicalTrainingStatus) medicalTrainingStatus.textContent = 'איפוס נכשל: ' + String((e && e.message) || e).slice(0, 160);
            }
        };
    }

    if (cancelBtn) {
        cancelBtn.onclick = () => {
            nameInput.value = currentName;
            emailInput.value = currentEmail;
            if (messageEl) { messageEl.style.display = 'none'; messageEl.textContent = ''; }
            closeUserMenu();
        };
    }
    if (closeBtn) {
        closeBtn.onclick = () => closeUserMenu();
    }

    if (!saveBtn) return;
    saveBtn.onclick = async () => {
        const newName = (nameInput.value || '').trim();
        const newEmail = (emailInput.value || '').trim();
        if (!newEmail) {
            if (messageEl) {
                messageEl.style.display = 'block';
                messageEl.textContent = (typeof window.t === 'function' ? window.t('email_required') : 'Email is required.');
                messageEl.style.color = '#b91c1c';
            }
            return;
        }
        saveBtn.disabled = true;
        if (messageEl) { messageEl.style.display = 'block'; messageEl.textContent = ''; }
        try {
            const existingMeta = user.user_metadata || {};
            const updates = { data: { ...existingMeta, full_name: newName || null } };
            if (newEmail !== (user.email || '')) updates.email = newEmail;
            const { data: updated, error } = await supabase.auth.updateUser(updates);
            if (error) throw error;
            const userToShow = updated?.user || user;
            if (typeof setupNavbarAuth === 'function') await setupNavbarAuth(userToShow);
            if (messageEl) {
                messageEl.textContent = (typeof window.t === 'function' ? window.t('changes_saved') : 'Changes saved');
                messageEl.style.color = '#059669';
            }
            const { displayName: d, email: em } = getAuthUserDisplayInfo(userToShow);
            nameInput.value = d === 'Account' ? '' : d;
            emailInput.value = em || '';
            if (typeof qsEnsureWelcomeCredits === 'function') {
                qsEnsureWelcomeCredits().catch((err) => console.warn('profile name sync to user_credits failed:', err));
            }
        } catch (e) {
            if (messageEl) {
                const msg = (e && (e.message || e.error_description || e.msg)) || (typeof window.t === 'function' ? window.t('save_failed') : 'Save failed');
                messageEl.textContent = msg;
                messageEl.style.color = '#b91c1c';
            }
            console.error('Profile save failed:', e);
        } finally {
            saveBtn.disabled = false;
        }
    };

    const eraseBtn = document.getElementById('user-menu-erase-account');
    if (eraseBtn) {
        eraseBtn.onclick = async () => {
            const T = typeof window.t === 'function' ? window.t : (k) => k;
            closeUserMenu();
            const warning = T('erase_account_warning');
            const approved = await showGlobalConfirm(warning, {
                confirmText: T('erase_account_confirm'),
                cancelText: T('cancel')
            });
            if (!approved) return;
            let session;
            try {
                const { data } = await supabase.auth.getSession();
                session = data?.session;
            } catch (_) {}
            if (!session?.access_token) {
                if (typeof showStatus === 'function') showStatus(T('save_failed') || 'Session expired. Please sign in again.', true);
                return;
            }
            try {
                const res = await fetch('/api/delete_account', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` }
                });
                const data = res.ok ? await res.json().catch(() => ({})) : {};
                if (!res.ok) {
                    const msg = data.error || res.statusText || (T('save_failed') || 'Failed');
                    if (typeof showStatus === 'function') showStatus(msg, true);
                    return;
                }
                if (typeof _qsSignOutThenMedicalOrReload === 'function') {
                    await _qsSignOutThenMedicalOrReload();
                } else {
                    await supabase.auth.signOut();
                    window.location.reload();
                }
            } catch (e) {
                if (typeof showStatus === 'function') showStatus(e?.message || (T('save_failed') || 'Failed'), true);
            }
        };
    }
}

/** @deprecated File list moved to personal area; kept for reference. */
async function loadUserMenuFiles(user) {
    const panel = document.getElementById('user-menu-panel');
    const filesEl = document.getElementById('user-menu-files');
    const emptyEl = document.getElementById('user-menu-empty');
    if (!panel || !filesEl) return;

    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('id, status, input_s3_key, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

    panel.dataset.loaded = '1';
    filesEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'none';

    if (error || !jobs || jobs.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    function filenameFromKey(key) {
        if (!key) return 'file';
        const parts = key.split('/');
        return parts[parts.length - 1] || key;
    }
    function displayNameFromKey(key) {
        const raw = filenameFromKey(key);
        return raw.replace(/^job_\d+_/, '') || raw;
    }
    function formatDate(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleDateString(undefined, { dateStyle: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { timeStyle: 'short' });
        } catch (_) { return iso || ''; }
    }

    for (const job of jobs) {
        const item = document.createElement('div');
        item.className = 'user-menu-file-item';
        const label = document.createElement('span');
        label.className = 'user-menu-file-label';
        label.textContent = displayNameFromKey(job.input_s3_key) + ' · ' + formatDate(job.created_at);
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'user-menu-file-open';
        openBtn.textContent = (typeof window.t === 'function' ? window.t('open_in_app') : 'Open in app');
        openBtn.title = (typeof window.t === 'function' ? window.t('open_in_app_tt') : 'Open in app with transcript');
        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'user-menu-file-get';
        downloadBtn.textContent = (typeof window.t === 'function' ? window.t('get_file') : 'Get file');
        if (!job.input_s3_key) {
            openBtn.disabled = true;
            downloadBtn.disabled = true;
            downloadBtn.title = 'No file key';
        } else {
            openBtn.onclick = () => {
                window.location.href = '/?open=' + encodeURIComponent(job.id);
            };
            downloadBtn.onclick = async () => {
                downloadBtn.disabled = true;
                try {
                    const res = await fetch('/api/get_presigned_url', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key: job.input_s3_key, userId: user.id })
                    });
                    const json = await res.json();
                    if (json.url) {
                        const blob = await fetch(json.url).then(r => r.blob());
                        const name = decodeURIComponent((job.input_s3_key || '').split('/').pop() || 'download');
                        if (typeof saveAs !== 'undefined') saveAs(blob, name);
                        else {
                            const url = window.URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = name;
                            a.click();
                            window.URL.revokeObjectURL(url);
                        }
                    } else showStatus(json.error || (typeof window.t === 'function' ? window.t('failed_to_get_link') : 'Failed to get link'), true);
                } catch (e) {
                    showStatus(e.message || 'Failed', true);
                }
                downloadBtn.disabled = false;
            };
        }
        item.appendChild(label);
        item.appendChild(openBtn);
        item.appendChild(downloadBtn);
        filesEl.appendChild(item);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Get display name and email from user. Prefer user_metadata (saved in app) over identity_data (OAuth) so name edits persist. */
function getAuthUserDisplayInfo(user) {
    if (!user) return { displayName: 'Account', email: '' };
    const meta = user.user_metadata || {};
    const identity = (user.identities && user.identities[0]) ? user.identities[0] : null;
    const idData = (identity && identity.identity_data) ? identity.identity_data : {};
    const merged = { ...idData, ...meta };
    const fullName = (merged.full_name || merged.name || '').trim()
        || [merged.given_name, merged.family_name].filter(Boolean).join(' ').trim()
        || (merged.given_name || '').trim();
    const displayName = fullName
        || (user.email ? user.email.replace(/@.*$/, '').replace(/^(\w)/, (m) => m.toUpperCase()) : null)
        || 'Account';
    const email = (user.email || merged.email || '').trim();
    return { displayName, email };
}

async function initHistoryPage() {
    const guestMsg = document.getElementById('history-guest-msg');
    const listWrap = document.getElementById('history-list-wrap');
    const emptyMsg = document.getElementById('history-empty-msg');
    const listEl = document.getElementById('history-list');
    if (!listEl) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        if (guestMsg) guestMsg.style.display = 'block';
        return;
    }

    listWrap.style.display = 'block';
    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('id, status, input_s3_key, created_at, type')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

    if (error) {
        if (emptyMsg) { emptyMsg.textContent = (typeof window.t === 'function' ? window.t('could_not_load_list') : 'Could not load list. ') + (error.message || ''); emptyMsg.style.display = 'block'; }
        return;
    }
    if (!jobs || jobs.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }

    function filenameFromKey(key) {
        if (!key) return 'file';
        const parts = key.split('/');
        return parts[parts.length - 1] || key;
    }
    function displayNameFromKey(key) {
        const raw = filenameFromKey(key);
        return raw.replace(/^job_\d+_/, '') || raw;
    }
    function formatDate(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleDateString(undefined, { dateStyle: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { timeStyle: 'short' });
        } catch (_) { return iso || ''; }
    }

    listEl.innerHTML = '';
    for (const job of jobs) {
        const li = document.createElement('li');
        li.style.cssText = 'padding:12px 0; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:12px; flex-wrap:wrap;';
        const label = document.createElement('span');
        label.style.flex = '1 1 200px';
        label.textContent = displayNameFromKey(job.input_s3_key) + ' · ' + formatDate(job.created_at);
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.textContent = (typeof window.t === 'function' ? window.t('open_in_app') : 'Open in app');
        openBtn.style.cssText = 'padding:6px 12px; background:#059669; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.875rem;';
        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.textContent = (typeof window.t === 'function' ? window.t('get_file') : 'Get file');
        dlBtn.style.cssText = 'padding:6px 12px; background:#1e3a8a; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.875rem;';
        if (!job.input_s3_key) {
            openBtn.disabled = true;
            dlBtn.disabled = true;
            dlBtn.title = 'No file key';
        } else {
            openBtn.onclick = () => { window.location.href = '/?open=' + encodeURIComponent(job.id); };
            dlBtn.onclick = async () => {
                dlBtn.disabled = true;
                try {
                    const res = await fetch('/api/get_presigned_url', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key: job.input_s3_key, userId: user.id })
                    });
                    const json = await res.json();
                    if (json.url) {
                        const blob = await fetch(json.url).then(r => r.blob());
                        const name = decodeURIComponent((job.input_s3_key || '').split('/').pop() || 'download');
                        if (typeof saveAs !== 'undefined') saveAs(blob, name);
                        else {
                            const url = window.URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = name;
                            a.click();
                            window.URL.revokeObjectURL(url);
                        }
                    } else showStatus(json.error || (typeof window.t === 'function' ? window.t('failed_to_get_link') : 'Failed to get link'), true);
                } catch (e) {
                    showStatus(e.message || 'Failed', true);
                }
                dlBtn.disabled = false;
            };
        }
        li.appendChild(label);
        li.appendChild(openBtn);
        li.appendChild(dlBtn);
        listEl.appendChild(li);
    }
}

async function initPersonalPage() {
    const guestMsg = document.getElementById('personal-guest-msg');
    const wrap = document.getElementById('personal-library-wrap');
    const emptyMsg = document.getElementById('personal-empty-msg');
    const listEl = document.getElementById('personal-recordings-list');
    const searchInput = document.getElementById('personal-search-input');
    const closeBtn = document.getElementById('personal-close-btn');
    if (!wrap || !listEl || !searchInput) return;

    if (closeBtn) {
        const lastJobDbId = localStorage.getItem('lastJobDbId');
        closeBtn.href = lastJobDbId ? ('/?open=' + encodeURIComponent(lastJobDbId)) : '/';
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        if (guestMsg) guestMsg.style.display = 'block';
        wrap.style.display = 'block';
        return;
    }

    wrap.style.display = 'block';
    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('id, created_at, input_s3_key, result_s3_key, runpod_job_id, metadata, status')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

    if (error) {
        if (emptyMsg) {
            emptyMsg.textContent = (typeof window.t === 'function' ? window.t('could_not_load_list') : 'Could not load list.') + ' ' + (error.message || '');
            emptyMsg.style.display = 'block';
        }
        return;
    }

    const displayNameFromKey = (key) => {
        if (!key) return 'recording';
        const raw = decodeURIComponent((key.split('/').pop() || key));
        return raw.replace(/^job_\d+_/, '') || raw;
    };
    const formatDate = (iso) => {
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return String(iso || '');
            return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return String(iso || '');
        }
    };
    const formatDuration = (seconds) => {
        const s = Number(seconds);
        if (!Number.isFinite(s) || s <= 0) return '';
        if (s < 60) return `${Math.round(s)} sec`;
        const mins = Math.floor(s / 60);
        if (mins < 60) return `${mins} min`;
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        return rem ? `${hrs} hr ${rem} min` : `${hrs} hr`;
    };
    /** Must match siteapp `_derive_output_key_base` + `.json` so Personal S3 probes find the transcript. */
    const deriveResultJsonKey = deriveTranscriptJsonKeyFromInputS3Key;
    const canProbeKeyForUser = (key) => String(key || '').startsWith(`users/${user.id}/`);
    const extractDurationSeconds = (job) => {
        const md = (job && job.metadata && typeof job.metadata === 'object') ? job.metadata : {};
        const vals = [
            md.duration_seconds, md.duration_sec, md.duration,
            md.media_duration_seconds, md.media_duration_sec, md.media_duration,
            md.ffprobe_duration_seconds, md.ffprobe_duration,
            md.video_duration_seconds, md.audio_duration_seconds
        ];
        for (const v of vals) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    };
    const isUploadedToS3 = (job) => {
        const md = (job && job.metadata && typeof job.metadata === 'object') ? job.metadata : {};
        const uploadStatus = String(md.upload_status || '').trim().toLowerCase();
        if (uploadStatus) return uploadStatus === 'uploaded_to_s3';
        return !!String((job && job.input_s3_key) || '').trim();
    };

    const rows = (Array.isArray(jobs) ? jobs : [])
        .filter((job) => isUploadedToS3(job))
        .map((job) => {
            const md = (job && job.metadata && typeof job.metadata === 'object') ? job.metadata : {};
            const resultKey = String(job.result_s3_key || '').trim();
            const resultKeyMeta = String(md.result_s3_key || md.resultS3Key || '').trim();
            const st = String(job.status || '').trim().toLowerCase();
            const statusLooksTranscribed = (
                ['processed', 'post-processed', 'exported', 'completed'].includes(st)
            );
            const transcriptExists = !!(
                resultKey ||
                resultKeyMeta ||
                md.transcript_exists === true ||
                statusLooksTranscribed
            );
            return {
                file_id: job.id,
                file_name: String(md.display_name || '').trim() || displayNameFromKey(job.input_s3_key),
                created_at: job.created_at,
                duration_seconds: extractDurationSeconds(job),
                transcript_exists: transcriptExists,
                s3_key: job.input_s3_key,
                runpod_job_id: job.runpod_job_id || null,
                derived_result_key: deriveResultJsonKey(job.input_s3_key)
            };
        })
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const grouped = new Map();
    const normName = (s) => String(s || '').trim().toLowerCase();
    rows.forEach((r) => {
        const key = normName(r.file_name);
        const ex = grouped.get(key);
        if (!ex) {
            grouped.set(key, {
                ...r,
                _row_ids: [r.file_id],
                _probe_keys: r.derived_result_key ? [r.derived_result_key] : [],
                _open_row_ts: r.transcript_exists ? new Date(r.created_at).getTime() : 0
            });
            return;
        }
        ex._row_ids.push(r.file_id);
        if (r.derived_result_key) ex._probe_keys.push(r.derived_result_key);
        if (!ex.duration_seconds && r.duration_seconds) ex.duration_seconds = r.duration_seconds;
        if (new Date(r.created_at).getTime() > new Date(ex.created_at).getTime()) {
            ex.created_at = r.created_at;
            ex.file_name = r.file_name;
            if (r.s3_key) ex.s3_key = r.s3_key;
        }
        if (r.transcript_exists) {
            const ts = new Date(r.created_at).getTime();
            if (!ex.transcript_exists || ts >= (ex._open_row_ts || 0)) {
                ex.file_id = r.file_id;
                ex.runpod_job_id = r.runpod_job_id || ex.runpod_job_id;
                ex._open_row_ts = ts;
            }
        }
        ex.transcript_exists = ex.transcript_exists || r.transcript_exists;
    });

    const files = Array.from(grouped.values()).sort((a, b) => {
        if (a.transcript_exists !== b.transcript_exists) return a.transcript_exists ? 1 : -1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    let filtered = files.slice();
    let openMenuId = null;
    let renamingId = null;
    let renameDraft = '';

    const openDeleteConfirm = (fileName) => new Promise((resolve) => {
        const existing = document.getElementById('recording-delete-overlay');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = 'recording-delete-overlay';
        overlay.className = 'personal-dialog-overlay';
        overlay.innerHTML = `
            <div class="personal-dialog" role="dialog" aria-modal="true">
                <p class="personal-dialog-message">Delete recording?</p>
                <p class="personal-delete-file-name">${escapeHtml(fileName)}</p>
                <p class="personal-delete-subtitle">This will permanently remove:</p>
                <ul class="personal-delete-list">
                    <li>video file</li>
                    <li>transcript</li>
                    <li>subtitles</li>
                    <li>exports</li>
                </ul>
                <div class="personal-dialog-actions">
                    <button type="button" class="personal-dialog-btn cancel">Cancel</button>
                    <button type="button" class="personal-dialog-btn primary danger">Delete</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const cancelBtn = overlay.querySelector('.personal-dialog-btn.cancel');
        const delBtn = overlay.querySelector('.personal-dialog-btn.danger');
        const done = (ok) => { overlay.remove(); resolve(ok); };
        cancelBtn.onclick = () => done(false);
        delBtn.onclick = () => done(true);
        overlay.onclick = (e) => { if (e.target === overlay) done(false); };
    });

    const render = () => {
        listEl.innerHTML = '';
        if (!filtered.length) {
            if (emptyMsg) {
                emptyMsg.style.display = 'block';
                emptyMsg.textContent = files.length
                    ? 'No recordings match your search.'
                    : 'No recordings available. Upload recordings from the main screen.';
            }
            return;
        }
        if (emptyMsg) emptyMsg.style.display = 'none';

        filtered.forEach((file) => {
            const item = document.createElement('article');
            item.className = 'personal-recording-item';
            item.setAttribute('role', 'listitem');
            const actionLabel = file.transcript_exists ? 'Open' : 'Transcribe';
            const dateText = formatDate(file.created_at);
            const durText = formatDuration(file.duration_seconds);
            const metaText = durText ? `${dateText} • ${durText}` : dateText;
            const isRenaming = renamingId === file.file_id;
            item.innerHTML = `
                <div class="personal-recording-main">
                    ${isRenaming
                        ? `<div class="personal-rename-inline">
                                <input class="personal-rename-input" type="text" value="${escapeHtml(renameDraft || file.file_name)}" />
                                <button type="button" class="personal-rename-save" title="Save">✔</button>
                                <button type="button" class="personal-rename-cancel" title="Cancel">✖</button>
                           </div>`
                        : `<div class="personal-recording-name">🎬 ${escapeHtml(file.file_name)}</div>`
                    }
                    <div class="personal-recording-date">${escapeHtml(metaText)}</div>
                </div>
                <div class="personal-recording-actions-row">
                    <button type="button" class="personal-recording-action">${escapeHtml(actionLabel)}</button>
                    <div class="personal-more-wrap">
                        <button type="button" class="personal-more-btn" aria-label="More actions">⋯</button>
                        <div class="personal-more-menu ${openMenuId === file.file_id ? 'open' : ''}">
                            <button type="button" class="personal-more-item" data-action="rename">Rename</button>
                            <button type="button" class="personal-more-item personal-more-item-danger" data-action="delete">Delete</button>
                            <button type="button" class="personal-more-item" data-action="cancel">Cancel</button>
                        </div>
                    </div>
                </div>
            `;

            const actionBtn = item.querySelector('.personal-recording-action');
            const handlePrimaryOpenAction = async () => {
                if (actionBtn.disabled) return;
                if (file.transcript_exists) {
                    window.location.href = '/?open=' + encodeURIComponent(file.file_id);
                    return;
                }
                if (!file.s3_key) {
                    if (typeof showStatus === 'function') showStatus('No uploaded file found for this recording.', true);
                    return;
                }
                const prevText = actionBtn.textContent;
                actionBtn.disabled = true;
                actionBtn.textContent = 'Transcribing...';
                try {
                    const transcribeJobId = file.runpod_job_id || ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('job_' + Date.now()));
                    localStorage.setItem('lastJobId', transcribeJobId);
                    localStorage.setItem('lastJobDbId', file.file_id);
                    localStorage.setItem('lastS3Key', file.s3_key);
                    if (typeof window.qsSetActiveJob === 'function') window.qsSetActiveJob(transcribeJobId);
                    else localStorage.setItem('activeJobId', transcribeJobId);
                    try {
                        await supabase.from('jobs').update({ runpod_job_id: transcribeJobId, updated_at: new Date().toISOString() }).eq('id', file.file_id).eq('user_id', user.id);
                    } catch (_) {}
                    const res = await fetch('/api/trigger_processing', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key: file.s3_key, jobId: transcribeJobId, task: 'transcribe', language: 'he', isMedical: isMedicalModeEnabled() })
                    });
                    const out = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(out.message || out.error || `HTTP ${res.status}`);
                    qsLogAudioProfileFromTrigger(transcribeJobId, out);
                    window.location.href = '/?open=' + encodeURIComponent(file.file_id);
                } catch (e) {
                    actionBtn.disabled = false;
                    actionBtn.textContent = prevText;
                    if (typeof showStatus === 'function') showStatus('Transcribe failed: ' + (e.message || 'Unknown error'), true);
                }
            };
            actionBtn.addEventListener('click', handlePrimaryOpenAction);
            const nameEl = item.querySelector('.personal-recording-name');
            if (nameEl) {
                nameEl.style.cursor = 'pointer';
                nameEl.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handlePrimaryOpenAction();
                });
            }

            const moreBtn = item.querySelector('.personal-more-btn');
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openMenuId = openMenuId === file.file_id ? null : file.file_id;
                render();
            });
            item.querySelectorAll('.personal-more-item').forEach((mi) => {
                mi.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const action = mi.getAttribute('data-action');
                    openMenuId = null;
                    if (action === 'cancel') {
                        render();
                        return;
                    }
                    if (action === 'rename') {
                        renamingId = file.file_id;
                        renameDraft = file.file_name;
                        render();
                        return;
                    }
                    if (action === 'delete') {
                        const ok = await openDeleteConfirm(file.file_name);
                        if (!ok) {
                            render();
                            return;
                        }
                        try {
                            const ids = Array.isArray(file._row_ids) && file._row_ids.length ? file._row_ids : [file.file_id];
                            for (const id of ids) {
                                const delRes = await fetch(`/recording/${encodeURIComponent(id)}`, {
                                    method: 'DELETE',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ userId: user.id })
                                });
                                const out = await delRes.json().catch(() => ({}));
                                if (!delRes.ok) throw new Error(out.error || `HTTP ${delRes.status}`);
                            }
                            const idx = files.findIndex((f) => f.file_id === file.file_id);
                            if (idx >= 0) files.splice(idx, 1);
                            const q = String(searchInput.value || '').trim().toLowerCase();
                            filtered = q ? files.filter((f) => String(f.file_name || '').toLowerCase().includes(q)) : files.slice();
                            render();
                            if (typeof showStatus === 'function') showStatus('Recording deleted', false);
                        } catch (err) {
                            if (typeof showStatus === 'function') showStatus('Delete failed: ' + (err.message || 'Unknown error'), true);
                        }
                        return;
                    }
                });
            });

            if (isRenaming) {
                const renameInput = item.querySelector('.personal-rename-input');
                const renameSave = item.querySelector('.personal-rename-save');
                const renameCancel = item.querySelector('.personal-rename-cancel');
                setTimeout(() => { try { renameInput.focus(); renameInput.select(); } catch (_) {} }, 0);
                renameInput.addEventListener('input', () => { renameDraft = renameInput.value; });
                const doRenameSave = async () => {
                    const next = String(renameInput.value || '').trim();
                    if (!next) return;
                    renameSave.disabled = true;
                    try {
                        const rr = await fetch(`/recording/${encodeURIComponent(file.file_id)}/rename`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: user.id, new_name: next })
                        });
                        const out = await rr.json().catch(() => ({}));
                        if (!rr.ok) throw new Error(out.error || `HTTP ${rr.status}`);
                        file.file_name = next;
                        renamingId = null;
                        renameDraft = '';
                        const q = String(searchInput.value || '').trim().toLowerCase();
                        filtered = q ? files.filter((f) => String(f.file_name || '').toLowerCase().includes(q)) : files.slice();
                        render();
                        if (typeof showStatus === 'function') showStatus('Recording renamed', false);
                    } catch (err) {
                        renameSave.disabled = false;
                        if (typeof showStatus === 'function') showStatus('Rename failed: ' + (err.message || 'Unknown error'), true);
                    }
                };
                renameSave.addEventListener('click', doRenameSave);
                renameCancel.addEventListener('click', () => { renamingId = null; renameDraft = ''; render(); });
                renameInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') doRenameSave();
                    if (e.key === 'Escape') { renamingId = null; renameDraft = ''; render(); }
                });
            }
            listEl.appendChild(item);
        });
    };

    searchInput.addEventListener('input', () => {
        const q = String(searchInput.value || '').trim().toLowerCase();
        filtered = q ? files.filter((f) => String(f.file_name || '').toLowerCase().includes(q)) : files.slice();
        render();
    });

    document.addEventListener('click', (e) => {
        if (!openMenuId) return;
        if (e.target.closest('.personal-more-wrap')) return;
        openMenuId = null;
        render();
    });

    render();

    (async () => {
        const toProbe = files.filter((f) => !f.transcript_exists && Array.isArray(f._probe_keys) && f._probe_keys.length > 0);
        if (!toProbe.length) return;
        let changed = 0;
        const concurrency = 6;
        for (let i = 0; i < toProbe.length; i += concurrency) {
            const batch = toProbe.slice(i, i + concurrency);
            const checks = batch.map(async (f) => {
                try {
                    const uniq = Array.from(new Set((f._probe_keys || []).filter((k) => canProbeKeyForUser(k))));
                    for (const k of uniq) {
                        const existsRes = await fetch('/api/s3_exists', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                s3Key: k,
                                userId: user.id,
                                isMedical: typeof isMedicalModeEnabled === 'function' ? isMedicalModeEnabled() : false
                            })
                        });
                        const ej = await existsRes.json().catch(() => ({}));
                        if (existsRes.ok && ej && ej.exists === true) return true;
                    }
                } catch (_) {}
                return false;
            });
            const exists = await Promise.all(checks);
            exists.forEach((ok, idx) => {
                if (!ok) return;
                batch[idx].transcript_exists = true;
                changed += 1;
            });
        }
        if (changed > 0) {
            files.sort((a, b) => {
                if (a.transcript_exists !== b.transcript_exists) return a.transcript_exists ? 1 : -1;
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            });
            const q = String(searchInput.value || '').trim().toLowerCase();
            filtered = q ? files.filter((f) => String(f.file_name || '').toLowerCase().includes(q)) : files.slice();
            render();
        }
    })();
}

/** True when open-in-app (or equivalent) already has transcript/summary data in memory. */
function initOpenAppHasLoadedTranscriptPayload() {
    if (Array.isArray(window.currentSegments) && window.currentSegments.length > 0) return true;
    if (Array.isArray(window.currentWords) && window.currentWords.length > 0) return true;
    const fmt = window.currentFormattedDoc;
    if (!fmt || typeof fmt !== 'object') return false;
    if (String(fmt.clean_transcript || '').trim()) return true;
    if (String(fmt.overview || '').trim()) return true;
    if (Array.isArray(fmt.key_points) && fmt.key_points.length > 0) return true;
    if (String(fmt.medical_chief_complaint || '').trim()) return true;
    if (String(fmt.medical_examination_transcript || '').trim()) return true;
    if (String(fmt.medical_patient_recommendations || '').trim()) return true;
    return false;
}

const QS_OPEN_STD_SUMMARY_HOST_ID = 'qs-open-standard-summary-host';

/** Remove legacy ?open= summary strip above #transcript-window (regular mode no longer shows inline summary). */
function clearOpenJobStandardSummaryHost() {
    const h = document.getElementById(QS_OPEN_STD_SUMMARY_HOST_ID);
    if (h) {
        h.innerHTML = '';
        h.style.display = 'none';
    }
}

/** Load a job in the app when user clicks "Open in app" (/?open=jobId). Loads file URL + transcript JSON. */
async function initOpenInApp(jobId) {
    setSeoHomeContentVisibility(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    try { clearOpenJobStandardSummaryHost(); } catch (_) {}
    // Fetch job without result first so we never 400 if result column is missing.
    // Accept both jobs.id (UUID) and runpod_job_id values like "job_..." / "job_sim_...".
    // Use maybeSingle() to avoid 406 when no row matches (PostgREST returns 406 for .single() when 0 rows).
    const _looksLikeUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || '').trim());
    const jobIdStr = String(jobId || '').trim();
    const tryByUuidFirst = _looksLikeUuid(jobIdStr);

    let job = null;
    let error = null;
    if (tryByUuidFirst) {
        ({ data: job, error } = await supabase
            .from('jobs')
            .select('id, input_s3_key')
            .eq('id', jobIdStr)
            .eq('user_id', user.id)
            .maybeSingle());
    } else {
        ({ data: job, error } = await supabase
            .from('jobs')
            .select('id, input_s3_key')
            .eq('runpod_job_id', jobIdStr)
            .eq('user_id', user.id)
            .maybeSingle());
    }
    if (error || !job || !job.input_s3_key) {
        if (typeof showStatus === 'function') showStatus('Could not load file.', true);
        return;
    }
    const resolvedJobId = job.id;
    // Personal / ?open= on clinical media: turn on HIPAA UI so תמלול + סיכום רפואי tabs are available (not transcript-only).
    if (isMedicalLayoutRawAudioKey(job.input_s3_key) && !isMedicalModeEnabled()) {
        if (typeof setMedicalMode === 'function') setMedicalMode(true);
    }
    if (isMedicalModeEnabled()) {
        window.medicalActiveTab = 'summary';
        window._medicalHasResult = true;
        try { if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi(); } catch (_) {}
    }
    // Prefer transcript from S3 (result_s3_key); fallback to jobs.result
    let segments = [];
    let hasTranscriptForOpen = false;
    const { data: keyRow } = await supabase.from('jobs').select('result_s3_key').eq('id', resolvedJobId).eq('user_id', user.id).maybeSingle();
    let resultKeyToFetch = (keyRow && keyRow.result_s3_key) ? String(keyRow.result_s3_key).trim() : '';
    const derivedResultKey = deriveTranscriptJsonKeyFromInputS3Key(job.input_s3_key);
    if (resultKeyToFetch && derivedResultKey && !transcriptResultKeyMatchesInput(job.input_s3_key, resultKeyToFetch)) {
        console.warn('[word-edit] open-in-app: result_s3_key does not match input_s3_key; using derived transcript key', {
            input_s3_key: job.input_s3_key,
            stored_result_s3_key: resultKeyToFetch,
            derived_result_key: derivedResultKey
        });
        resultKeyToFetch = derivedResultKey;
    }
    if (resultKeyToFetch) {
        hasTranscriptForOpen = true;
        try {
            console.log('[word-edit] open-in-app: fetching transcript JSON', { result_s3_key: resultKeyToFetch });
            const urlRes = await fetch('/api/get_presigned_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    s3Key: resultKeyToFetch,
                    userId: user.id,
                    isMedical: typeof isMedicalModeEnabled === 'function' ? isMedicalModeEnabled() : false
                })
            });
            const urlJson = await urlRes.json();
            if (urlJson.url) {
                const tr = await fetch(urlJson.url).then(r => r.json());
                if (tr) {
                    const trFmt = pickFormattedFromObject(tr);
                    if (trFmt) {
                        window.currentFormattedDoc = trFmt;
                        window._qsDocPreferSegmentsAfterEdit = false;
                        if (String(trFmt.clean_transcript || '').trim()) window._qsCleanupDone = true;
                    }
                    const cleanLen = trFmt ? String(trFmt.clean_transcript || '').trim().length : 0;
                    console.log('[word-edit] open-in-app: formatted in transcript JSON', {
                        found: !!trFmt,
                        clean_transcript_length: cleanLen,
                        top_level_keys: tr && typeof tr === 'object' ? Object.keys(tr).slice(0, 25) : [],
                        has_formatted_key: !!(tr && tr.formatted),
                        note: cleanLen
                            ? undefined
                            : 'No `formatted` object in this file — only what you see in keys (e.g. words/captions). Export can run GPT formatting once if needed.',
                    });
                    if (Array.isArray(tr.words) && Array.isArray(tr.captions) && tr.words.length > 0 && tr.captions.length > 0) {
                        console.log('[word-edit] open-in-app: loaded words/captions', { words: tr.words.length, captions: tr.captions.length });
                        window.currentWords = tr.words;
                        window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, tr.captions, 54);
                        window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                        segments = window.currentSegments;
                    } else if (Array.isArray(tr.segments)) {
                        console.log('[word-edit] open-in-app: loaded legacy segments', { segments: tr.segments.length });
                        segments = tr.segments;
                        try {
                            console.log('[word-edit] open-in-app: legacy segment start sample', segments.slice(0, 5).map(s => s && s.start));
                        } catch (_) {}
                        // If segments contain real word timestamps, build the word/caption model.
                        const model = _tryBuildWordModelFromSegmentsAndFlat(segments, tr.word_segments);
                        if (model) {
                            console.log('[word-edit] open-in-app: derived words/captions from segments[*].words or word_segments', { words: model.words.length, captions: model.captions.length });
                            window.currentWords = model.words;
                            window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, model.captions, 54);
                            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                            segments = window.currentSegments;
                        } // No fallback fetch here: avoids noisy 404s for jobs without an intermediate debug artifact.
                    }
                }
            }
        } catch (_) { /* fallback to result */ }
    }
    if (segments.length === 0) {
        const { data: resultData } = await supabase.from('jobs').select('result').eq('id', resolvedJobId).eq('user_id', user.id).maybeSingle();
        const res = resultData && resultData.result && typeof resultData.result === 'object' ? resultData.result : null;
        if (res) {
            if (Array.isArray(res.words) && Array.isArray(res.captions) && res.words.length > 0 && res.captions.length > 0) {
                window.currentWords = res.words;
                window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, res.captions, 54);
                segments = _captionsToCues(window.currentWords, window.currentCaptions);
                hasTranscriptForOpen = true;
            } else if (Array.isArray(res.segments)) {
                segments = res.segments;
                if (segments.length > 0) hasTranscriptForOpen = true;
            }
            const resFmt = pickFormattedFromObject(res);
            if (resFmt) {
                window.currentFormattedDoc = resFmt;
                window._qsDocPreferSegmentsAfterEdit = false;
                hasTranscriptForOpen = true;
            }
        }
    }
    const hasWordModel =
        Array.isArray(window.currentWords) &&
        Array.isArray(window.currentCaptions) &&
        window.currentWords.length > 0 &&
        window.currentCaptions.length > 0;
    if (!hasWordModel) {
        window.currentWords = null;
        window.currentCaptions = null;
    }
    window.currentSegments = segments;
    try {
        const segStarts = (window.currentSegments || []).slice(0, 5).map(s => s && s.start);
        const wordStarts = (window.currentWords || []).slice(0, 5).map(w => w && w.start);
        console.log('[word-edit] open-in-app: final model', {
            hasWords: Array.isArray(window.currentWords) && window.currentWords.length > 0,
            hasCaptions: Array.isArray(window.currentCaptions) && window.currentCaptions.length > 0,
            segStartSample: segStarts,
            wordStartSample: wordStarts,
        });
    } catch (_) {}

    // Medical + word model: paint summary/transcript tabs once; non-medical timing UI is built at end of open (with optional summary host).
    if (isMedicalModeEnabled() &&
        Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) &&
        window.currentWords.length > 0 && window.currentCaptions.length > 0) {
        try {
            renderTranscriptFromCues(window.currentSegments || []);
        } catch (_) {}
    }

    const res = await fetch('/api/get_presigned_url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            s3Key: job.input_s3_key,
            userId: user.id,
            isMedical: typeof isMedicalModeEnabled === 'function' ? isMedicalModeEnabled() : false
        })
    });
    const json = await res.json();
    if (!json.url) {
        if (typeof showStatus === 'function') showStatus(json.error || 'Failed to get file link', true);
        return;
    }
    const mediaUrl = qsNormalizeAbsoluteMediaUrl(json.url);
    const filename = decodeURIComponent((job.input_s3_key || '').split('/').pop() || 'file');
    window.originalFileName = filename.replace(/\.[^.]+$/, '') || 'file';
    const forceMedicalAudio =
        isMedicalModeEnabled() || isMedicalLayoutRawAudioKey(job.input_s3_key);
    let isAudio = qsIsAudioMediaFile(filename);
    let isVideo = !isAudio && qsIsVideoMediaFile(filename);
    if (forceMedicalAudio) {
        isAudio = true;
        isVideo = false;
    }
    window.uploadWasVideo = isVideo;
    const uniqueSpeakers = new Set(window.currentSegments.map(s => s.speaker).filter(Boolean));
    window.aiDiarizationRan = uniqueSpeakers.size > 1;

    const placeholderEl = document.getElementById('placeholder');
    if (placeholderEl) placeholderEl.style.display = 'none';

        if (isVideo) {
        const videoWrapper = document.getElementById('video-wrapper');
        const videoPlayer = document.getElementById('video-player-container');
        const audioContainer = document.getElementById('audio-player-container');
        const src = document.getElementById('video-source');
        const video = document.getElementById('main-video');
        // Restore audio container to original position (before video wrapper) when showing video
        if (audioContainer && videoWrapper && audioContainer.parentNode === videoPlayer) {
            videoWrapper.parentNode.insertBefore(audioContainer, videoWrapper);
        }
        if (audioContainer) audioContainer.style.display = 'none';
        if (video) video.style.display = '';
        if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
        try {
            const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
            if (isMobile) document.body.classList.add('mobile-video-session');
        } catch (_) {}
        if (src) {
            src.src = mediaUrl;
            // Use video/mp4 for .mov so Chrome/Firefox use MP4 decoder (many .mov are H.264 in QuickTime container)
            const mime = { '.mp4': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska' };
            const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
            src.type = mime[ext] || 'video/mp4';
        }
        if (video) {
            video.controls = true;
            video.load();
            video.pause();
            if (window.currentSegments.length > 0) {
                let subtitlesAttached = false;
                function attachSubtitles() {
                    if (subtitlesAttached) return;
                    subtitlesAttached = true;
                    if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                    if (typeof window.currentSubtitleStyle === 'string' && typeof window.applySubtitleStyle === 'function') {
                        window.applySubtitleStyle(window.currentSubtitleStyle);
                    }
                }
                video.addEventListener('loadedmetadata', attachSubtitles, { once: true });
                if (video.readyState >= 1) attachSubtitles();
            }
        }
        if (videoPlayer) videoPlayer.style.display = 'block';
        const movHint = document.getElementById('video-mov-hint');
        if (movHint) movHint.style.display = filename.toLowerCase().endsWith('.mov') ? 'block' : 'none';
    } else {
        // Audio only (m4a, mp3, etc.): use audio player only, no video
        const audioContainer = document.getElementById('audio-player-container');
        const videoWrapper = document.getElementById('video-wrapper');
        const videoPlayer = document.getElementById('video-player-container');
        const video = document.getElementById('main-video');
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        if (videoWrapper) { videoWrapper.style.display = 'none'; videoWrapper.classList.remove('visible'); }
        try { document.body.classList.remove('mobile-video-session'); } catch (_) {}
        if (video) video.style.display = 'none';
        const movHint = document.getElementById('video-mov-hint');
        if (movHint) movHint.style.display = 'none';
        if (audioContainer && videoWrapper && audioContainer.parentNode === videoPlayer) {
            videoWrapper.parentNode.insertBefore(audioContainer, videoWrapper);
        }
        if (audioContainer) audioContainer.style.display = 'block';
        if (audioSource && mainAudio) {
            audioSource.src = mediaUrl;
            audioSource.type = qsMimeForAudioElement(filename);
            mainAudio.load();
        }
    }

    document.querySelectorAll('.controls-bar').forEach(bar => { if (bar) bar.style.display = ''; });
    const hasTranscriptOrSummary = hasTranscriptForOpen || initOpenAppHasLoadedTranscriptPayload();
    setTranscriptActionButtonsVisible(!!hasTranscriptOrSummary);
    const mainBtn = document.getElementById('main-btn');
    const regularRecordBtn = document.getElementById('regular-record-btn');
    if (mainBtn) {
        mainBtn.disabled = false;
        // Completed job with transcript → "New session" (confirms before clearing).
        setMainButtonAction(hasTranscriptOrSummary ? 'new_session' : 'transcribe_loaded_file');
    }
    if (typeof syncSpeakerControls === 'function') syncSpeakerControls();
    if (!isMedicalModeEnabled()) {
        try { clearOpenJobStandardSummaryHost(); } catch (_) {}
        try { syncStandardFormatTabs(); } catch (_) {}
        const hasSummary = hasStandardFormattedSummary();
        if (hasTranscriptForOpen && hasSummary) {
            setFormatViewMode('summary');
            renderStandardSummaryView();
        } else if (hasTranscriptForOpen) {
            const hasWordModel =
                Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) &&
                window.currentWords.length > 0 && window.currentCaptions.length > 0;
            if (hasWordModel && typeof renderWordCaptionEditor === 'function') {
                renderWordCaptionEditor();
            } else if (typeof window.render === 'function') {
                window.render();
            }
        }
    } else if (typeof window.render === 'function') {
        window.render();
    }
    try {
        if (isMedicalModeEnabled() && typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs();
    } catch (_) {}
    if (typeof window.showSubtitleStyleSelector === 'function') window.showSubtitleStyleSelector();
    const speakerToggle = document.getElementById('toggle-speaker');
    if (window.aiDiarizationRan && speakerToggle) speakerToggle.checked = true;
    localStorage.setItem('lastJobDbId', job.id);
    localStorage.setItem('lastS3Key', job.input_s3_key || '');
    try {
        window._qsInputS3KeyForGpt = String(job.input_s3_key || '').trim() || null;
    } catch (_) {}
    if (isVideo && window.currentSegments.length > 0 && typeof window.currentSubtitleStyle === 'undefined') {
        window.currentSubtitleStyle = localStorage.getItem('subtitleStyle') || 'tiktok';
    }
}

/**
 * Load job from /?open=… once the user session exists. Magic-link and PKCE return after DOMContentLoaded;
 * getUser() is often null on the first tick, so initOpenInApp must be retried from onAuthStateChange.
 */
async function runOpenQueryIfPresent() {
    try {
        const p = (window.location && window.location.pathname) ? String(window.location.pathname).replace(/\/+$/, '') || '/' : '/';
        if (p !== '/' && p !== '/medical') return;
        const search = (window.location && window.location.search) || '';
        const m = search.match(/[?&]open=([^&]+)/);
        if (!m || !m[1]) return;
        const jobId = decodeURIComponent(m[1]).trim();
        if (!jobId) return;
        if (window.__qsOpenHandledFor === jobId) return;
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        if (window.__qsOpenHandledFor === jobId) return;
        if (typeof initOpenInApp !== 'function') return;
        await initOpenInApp(jobId);
        window.__qsOpenHandledFor = jobId;
    } catch (e) {
        console.warn('[qs] runOpenQueryIfPresent failed', e);
    }
}

// Job lifecycle: only when user is signed in. pending → uploaded → processed → exported | completed | failed
// jobs.id is UUID (auto-generated). We store the returned id as lastJobDbId for updates.

async function createJobOnUpload({ jobId, s3Key }) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const info = getAuthUserDisplayInfo(user);
    const user_name = info.displayName === 'Account' ? null : info.displayName;
    const user_email = info.email || null;

    const row = {
        user_id: user.id,
        type: 'transcription',
        status: 'pending',
        input_s3_key: s3Key,
        runpod_job_id: jobId,
        user_name,
        user_email,
        metadata: { job_id: jobId }
    };
    const { data, error } = await supabase.from('jobs').insert([row]).select('id').single();
    if (error) {
        console.error('createJobOnUpload:', error);
        return;
    }
    if (data && data.id) localStorage.setItem('lastJobDbId', data.id);
}

async function updateJobStatus(dbId, status, resultPayload = null) {
    if (!dbId) return;
    const payload = { status, updated_at: new Date().toISOString() };
    if (resultPayload != null && typeof resultPayload === 'object') {
        if (resultPayload.result_s3_key !== undefined) payload.result_s3_key = resultPayload.result_s3_key;
        if (resultPayload.segments !== undefined) payload.result = { segments: resultPayload.segments };
    }
    const { error } = await supabase
        .from('jobs')
        .update(payload)
        .eq('id', dbId);
    if (error) console.error('updateJobStatus:', error);
}

/**
 * After a successful /api/save_job_result, persist result_s3_key on the jobs row.
 * When the row pointed at another job's JSON (e.g. stale runpod id), downloads and ?open= would otherwise keep loading the wrong file.
 */
async function syncJobResultS3KeyFromSaveResponse(saveRes, dbIdOverride) {
    if (!saveRes || !saveRes.ok) return;
    let data = {};
    try {
        data = await saveRes.json();
    } catch (_) {}
    const key = data && data.result_s3_key ? String(data.result_s3_key).trim() : '';
    const dbId = String(dbIdOverride || localStorage.getItem('lastJobDbId') || '').trim();
    if (!key || !dbId || typeof updateJobStatus !== 'function') return;
    try {
        const { data: jr } = await supabase.from('jobs').select('status').eq('id', dbId).maybeSingle();
        const st = (jr && jr.status) ? String(jr.status) : 'processed';
        await updateJobStatus(dbId, st, { result_s3_key: key });
        console.log('[jobs] synced result_s3_key after save', { dbId, result_s3_key: key });
    } catch (e) {
        console.warn('[jobs] sync result_s3_key after save failed:', e);
    }
}

/** On export: update existing job to exported/completed, or create one if no row or wrong user (e.g. signed in as different user). */
async function ensureJobRecordOnExport() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const dbId = localStorage.getItem('lastJobDbId');
    if (dbId) {
        const { data: updated, error } = await supabase
            .from('jobs')
            .update({ status: 'exported', updated_at: new Date().toISOString() })
            .eq('id', dbId)
            .select('id', 'status');
        if (updated && updated.length) {
            console.log('Job status -> exported');
            return;
        }
        if (error) {
            const { data: d2, error: err2 } = await supabase
                .from('jobs')
                .update({ status: 'completed', updated_at: new Date().toISOString() })
                .eq('id', dbId)
                .select('id', 'status');
            if (d2 && d2.length) {
                console.log('Job status -> completed');
                return;
            }
        }
        // No row matched (stale lastJobDbId or RLS) — create a new job for current user below
    }

    const s3Key = localStorage.getItem('lastS3Key');
    const jobId = localStorage.getItem('lastJobId');
    if (!s3Key) return;

    const info = getAuthUserDisplayInfo(user);
    const user_name = info.displayName === 'Account' ? null : info.displayName;
    const user_email = info.email || null;
    const row = {
        user_id: user.id,
        type: 'transcription',
        status: 'exported',
        input_s3_key: s3Key,
        runpod_job_id: jobId || null,
        user_name,
        user_email,
        metadata: { job_id: jobId || null }
    };
    let { data, error } = await supabase.from('jobs').insert([row]).select('id').single();
    if (error && error.code === '22P02') {
        row.status = 'completed';
        const res = await supabase.from('jobs').insert([row]).select('id').single();
        data = res.data;
        error = res.error;
    }
    if (error) {
        console.error('ensureJobRecordOnExport insert:', error);
        return;
    }
    if (data && data.id) localStorage.setItem('lastJobDbId', data.id);
}
    function createDocxParagraphs(group, showTime, showSpeaker) {
        const { Paragraph, TextRun, AlignmentType } = docx;
        const paragraphs = [];
        if (showSpeaker || showTime) {
            let label = "";
            if (showTime) label += `[${formatTime(group.start)}] `;
            if (showSpeaker) label += formatSpeaker(group.speaker);

            paragraphs.push(new Paragraph({
                children: [new TextRun({
                    text: label,
                    bold: true,
                    color: getSpeakerColor(group.speaker).replace('#', ''),
                    size: 20,
                    rightToLeft: true,
                })],
                alignment: AlignmentType.RIGHT,
                bidirectional: true
            }));
        }
        paragraphs.push(new Paragraph({
            children: [new TextRun({
                text: group.text.trim(),
                size: 24,
                rightToLeft: true,
            })],
            alignment: AlignmentType.RIGHT,
            bidirectional: true,
            spacing: { after: 300 }
        }));
        return paragraphs;
    }

    function createDocxParagraphsFromPlainText(text, rtl = true) {
        const { Paragraph, TextRun, AlignmentType } = docx;
        const raw = String(text || '').replace(/\r\n/g, '\n').trim();
        let parts = raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        if (parts.length <= 1) {
            parts = raw.split(/\n+/).map(p => p.trim()).filter(Boolean);
        }
        return parts.map(p => new Paragraph({
                children: [new TextRun({ text: p, size: 24, rightToLeft: !!rtl })],
                alignment: rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
                bidirectional: !!rtl,
                spacing: { after: 260 }
            }));
    }


function _qsSubtitleColorForExport() {
    const raw = (typeof window.currentSubtitleColor === 'string' && window.currentSubtitleColor)
        ? window.currentSubtitleColor
        : (typeof localStorage !== 'undefined' ? localStorage.getItem('subtitleColor') : null) || 'yellow';
    return (raw === 'black' || raw === 'red' || raw === 'yellow' || raw === 'white') ? raw : 'yellow';
}

function _qsSubtitleStyleForExport() {
    const raw = (typeof window.currentSubtitleStyle === 'string' && window.currentSubtitleStyle)
        ? window.currentSubtitleStyle
        : (typeof localStorage !== 'undefined' ? localStorage.getItem('subtitleStyle') : null) || 'tiktok';
    return (raw === 'tiktok' || raw === 'clean' || raw === 'cinematic') ? raw : 'tiktok';
}

/** Burn subtitles into video via server (supports mp4, mov, webm, m4v, mkv, avi). */
window.downloadMovieWithBurnedSubtitles = async function(baseName) {
    const video = document.getElementById('main-video');
    const videoUrl = video ? (video.currentSrc || video.src || (video.querySelector('source') && video.querySelector('source').src) || '') : '';
    if (!videoUrl || videoUrl.startsWith('data:')) throw new Error('No video loaded');
    const segments = window.currentSegments || [];
    if (!segments.length) throw new Error('No segments');

    // Detect extension from video source URL or originalFileName (e.g. .mp4, .mov, .webm)
    const extMatch = videoUrl.match(/\.(mp4|mov|webm|m4v|mkv|avi)(\?|$)/i);
    const fromOriginal = (window.originalFileName || '').match(/\.(mp4|mov|webm|m4v|mkv|avi)$/i);
    const ext = extMatch ? '.' + extMatch[1].toLowerCase() : (fromOriginal ? '.' + fromOriginal[1].toLowerCase() : '.mp4');
    const base = (baseName || (window.originalFileName || 'video').replace(/\.[^.]+$/, ''));
    const filename = base + ext;

    const blob = await fetch(videoUrl).then(r => r.blob());
    const form = new FormData();
    form.append('video', blob, filename);
    const segPayload = segments.map((s, si) => {
        const row = { start: s.start, end: s.end || s.start + 1, text: s.text || '' };
        if (typeof window.getResolvedCaptionStyle === 'function') {
            const r = window.getResolvedCaptionStyle(si);
            row.style = { position: r.position, highlightMode: r.highlightMode || 'none' };
        }
        return row;
    });
    form.append('segments', JSON.stringify(segPayload));
    form.append('filename', filename);
    form.append('subtitle_color', _qsSubtitleColorForExport());
    form.append('subtitle_style', _qsSubtitleStyleForExport());
    const wPx = video && video.videoWidth > 0 ? video.videoWidth : 0;
    const hPx = video && video.videoHeight > 0 ? video.videoHeight : 0;
    if (hPx > 0 && wPx > 0 && hPx > wPx) form.append('is_portrait', '1');

    const res = await fetch('/api/burn_subtitles', { method: 'POST', body: form });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
    }
    const outBlob = await res.blob();
    const outName = (res.headers.get('Content-Disposition') || '').match(/filename="?([^";]+)"?/);
    const downloadName = outName ? outName[1] : 'video_with_subtitles' + ext;
    if (typeof saveAs !== 'undefined') saveAs(outBlob, downloadName);
    else {
        const url = URL.createObjectURL(outBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = downloadName;
        a.click();
        URL.revokeObjectURL(url);
    }
};

function extractSegmentsFromJobPayload(payload) {
    const output = (payload && (payload.result || payload.output)) || payload || {};
    const segments = (output && output.segments) || payload?.segments || (payload?.data && payload.data.segments) || [];
    return Array.isArray(segments) ? segments : [];
}

/** Legacy GPT verification prefix; strip on ingest so UI/export stay clean. */
function _stripLeadingMedicalExamLegacyPrefix(s) {
    let t = String(s || '').trim();
    if (t.startsWith('+++ ')) return t.slice(4).trim();
    if (t.startsWith('+++')) return t.slice(3).trimStart();
    return t;
}

/** All known Hebrew section header labels across all sections. */
const _MEDICAL_SECTION_ALL_LABELS = [
    'תלונה עיקרית', 'תלונה', 'תלונות',
    'ממצאים', 'בדיקה',
    'המלצות למטופל', 'המלצות'
];

/** Strip any leading section header (from any section) from the field value.
 *  Iterates up to 6 times to catch cases where the model stacks multiple headers.
 *  Handles:
 *   - "ממצאים:\ncontent"         (colon + newline)
 *   - "ממצאים:"                  (colon, content on same line)
 *   - "ממצאים\ncontent"          (NO colon — label on its own line)
 *   - "**ממצאים:**\ncontent"     (bold markers)
 *   - "המלצות\n"                  (label alone without colon) */
function _stripLeadingMedicalSectionHeader(text) {
    let t = String(text || '').trim();
    if (!t) return t;
    const escaped = _MEDICAL_SECTION_ALL_LABELS.map(
        (l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ).join('|');
    // With colon (optional bold, optional space before colon, optional whitespace after)
    const reWithColon    = new RegExp(`^\\*{0,2}(${escaped})\\*{0,2}\\s*:\\s*`, 'u');
    // Without colon: label must be the ENTIRE first line (nothing else on that line)
    const reLineOnly     = new RegExp(`^\\*{0,2}(${escaped})\\*{0,2}\\s*$`, 'um');

    for (let i = 0; i < 6; i++) {
        let m = reWithColon.exec(t);
        if (m) { t = t.slice(m[0].length).trim(); continue; }
        // Check if the very first non-empty line is only a label
        const firstLine = t.split('\n')[0].trim();
        if (firstLine && reLineOnly.test(firstLine)) {
            t = t.slice(firstLine.length).trim();
            continue;
        }
        break;
    }
    return t;
}

function _medicalSummaryFieldBody(text, sectionKey) {
    let t = _stripLeadingMedicalSectionHeader(text);
    if (sectionKey === 'exam') t = _stripLeadingMedicalExamLegacyPrefix(t);
    return t;
}

/** Client safety net when server guardrail missed a short-transcript GPT hallucination. */
function _medicalFormatLooksHallucinated(sourceText, fmt) {
    const src = String(sourceText || '').trim();
    if (!src || src.length > 120 || !fmt || typeof fmt !== 'object') return false;
    const parts = [
        fmt.clean_transcript,
        fmt.medical_chief_complaint,
        fmt.overview,
        fmt.medical_examination_transcript,
        fmt.medical_patient_recommendations,
    ].map((p) => String(p || '').trim());
    const maxOut = Math.max(0, ...parts.map((p) => p.length));
    return maxOut > Math.max(src.length * 2.5, src.length + 80);
}

function _medicalMinimalFormattedDocFromTranscript(sourceText) {
    const clean = String(sourceText || '').trim();
    const notStated = 'לא צוין (תמלול קצר מאוד).';
    const recTail = 'יש לוודא את התוכן מול ההקלטה והרופא האחראי.';
    return normalizeFormattedFields({
        clean_transcript: clean,
        overview: clean || notStated,
        key_points: clean ? [clean] : [],
        medical_chief_complaint: clean || notStated,
        medical_examination_transcript: notStated,
        medical_patient_recommendations: recTail,
    });
}

function normalizeActionItemEntry(p) {
    if (p && typeof p === 'object' && !Array.isArray(p)) {
        const task = String(p.task || '').trim();
        const owner = String(p.owner || '').trim();
        if (task && owner) return `${task} (${owner})`;
        return task || owner;
    }
    return String(p || '').trim();
}

function normalizeFormattedFields(f) {
    if (!f || typeof f !== 'object') return null;
    const out = {
        clean_transcript: String(f.clean_transcript || '').trim(),
        overview: String(f.overview || '').trim(),
        key_points: Array.isArray(f.key_points)
            ? f.key_points.map((p) => String(p || '').trim()).filter(Boolean)
            : [],
        action_items: Array.isArray(f.action_items)
            ? f.action_items.map((p) => normalizeActionItemEntry(p)).filter(Boolean)
            : []
    };
    if (
        f.medical_chief_complaint != null ||
        f.medical_examination_transcript != null ||
        f.medical_patient_recommendations != null
    ) {
        out.medical_chief_complaint = _medicalSummaryFieldBody(f.medical_chief_complaint, 'chief');
        out.medical_examination_transcript = _medicalSummaryFieldBody(f.medical_examination_transcript, 'exam');
        out.medical_patient_recommendations = _medicalSummaryFieldBody(f.medical_patient_recommendations, 'rec');
    }
    return out;
}

/** GPT-shaped formatting: nested `formatted`, flat keys, or under result/output/data (worker payloads). */
function pickFormattedFromObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    const nested = obj.formatted;
    if (nested && typeof nested === 'object') return normalizeFormattedFields(nested);
    if (
        obj.clean_transcript != null ||
        obj.overview != null ||
        Array.isArray(obj.key_points) ||
        Array.isArray(obj.action_items) ||
        obj.medical_chief_complaint != null ||
        obj.medical_examination_transcript != null ||
        obj.medical_patient_recommendations != null
    ) {
        return normalizeFormattedFields(obj);
    }
    for (const k of ['result', 'output', 'data', 'transcript']) {
        const inner = obj[k];
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            const got = pickFormattedFromObject(inner, depth + 1);
            if (got) return got;
        }
    }
    return null;
}

function extractFormattedFromJobPayload(payload) {
    const output = (payload && (payload.result || payload.output)) || payload || {};
    return pickFormattedFromObject(output) || pickFormattedFromObject(payload);
}

/**
 * If in-memory GPT formatting is missing, reload transcript JSON from S3 (same row as Open in app)
 * so export_docx receives formatted. Logs explain misses for debugging.
 */
async function hydrateFormattedFromSavedTranscript() {
    const fmtMem = window.currentFormattedDoc;
    const hasClean = !!(fmtMem && String(fmtMem.clean_transcript || '').trim());
    const hasSummary = hasStandardFormattedSummary();
    if (hasClean && hasSummary) {
        window._qsCleanupDone = true;
        return true;
    }
    if (hasClean) {
        window._qsCleanupDone = true;
        return true;
    }
    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            console.warn('[export] hydrate formatted: not signed in');
            return false;
        }
        const dbId = localStorage.getItem('lastJobDbId');
        if (!dbId) {
            console.warn('[export] hydrate formatted: no lastJobDbId (open a job from history or finish upload in this tab)');
            return false;
        }
        const { data: row } = await supabase
            .from('jobs')
            .select('result_s3_key')
            .eq('id', dbId)
            .eq('user_id', user.id)
            .maybeSingle();
        if (!row || !row.result_s3_key) {
            console.warn('[export] hydrate formatted: jobs.result_s3_key missing');
            return false;
        }
        const urlRes = await fetch('/api/get_presigned_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ s3Key: row.result_s3_key, userId: user.id })
        });
        const urlJson = await urlRes.json();
        if (!urlJson.url) {
            console.warn('[export] hydrate formatted: presign failed', urlJson.error || urlJson);
            return false;
        }
        const tr = await fetch(urlJson.url).then((r) => r.json());
        const trFmt = pickFormattedFromObject(tr);
        const clen = trFmt ? String(trFmt.clean_transcript || '').trim().length : 0;
        if (trFmt) {
            const prev = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
                ? window.currentFormattedDoc
                : {};
            window.currentFormattedDoc = normalizeFormattedFields({ ...prev, ...trFmt });
            window._qsDocPreferSegmentsAfterEdit = false;
            if (clen > 0) {
                window._qsCleanupDone = true;
                console.log('[export] hydrated formatted from S3 (clean_transcript length=%s)', clen);
                return true;
            }
            if (hasStandardFormattedSummary()) {
                console.log('[export] hydrated summary from S3 (no clean_transcript yet)');
                return true;
            }
        }
        const topKeys = tr && typeof tr === 'object' ? Object.keys(tr) : [];
        console.info(
            '[export] Transcript JSON at result_s3_key has no `formatted` block (keys=%s). ' +
                'That is the file the app loads — it is not a different “GPT” object in S3 unless you use another key. ' +
                'Old saves without `formatted` match this. We will try to build formatting on export if needed.',
            topKeys.join(', ')
        );
        return false;
    } catch (e) {
        console.warn('[export] hydrate formatted failed:', e);
        return false;
    }
}

/**
 * When S3/ memory lack GPT formatting, run /api/format_transcript_summary once and persist to S3 (same as post-job flow).
 */
/** Join cue texts for GPT format pass: spaces, not newlines, so the model does not lock in ~54-char subtitle lines. */
function buildTranscriptTextForGptFormat() {
    const fromSegments = (window.currentSegments || [])
        .map((s) => String((s && s.text) || '').trim())
        .filter(Boolean)
        .join(' ');
    if (fromSegments.trim()) return fromSegments;
    const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
        ? window.currentFormattedDoc
        : null;
    return String((fmt && fmt.clean_transcript) || '').trim();
}

/** Paragraph-style transcript body for DOCX/TXT and doc mode (ignore subtitle cue line breaks). */
function buildTranscriptPlainBodyForExport() {
    let segs = Array.isArray(window.currentSegments) ? window.currentSegments : [];
    if (
        Array.isArray(window.currentWords) &&
        Array.isArray(window.currentCaptions) &&
        window.currentWords.length > 0 &&
        window.currentCaptions.length > 0 &&
        typeof _captionsToCues === 'function'
    ) {
        try {
            const fromModel = _captionsToCues(window.currentWords, window.currentCaptions);
            if (Array.isArray(fromModel) && fromModel.length > 0) segs = fromModel;
        } catch (_) {}
    }
    if (!segs.length) return '';
    const full = segs
        .map((s) => String((s && s.text) || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!full) return '';
    // Heuristic paragraphizer: split by sentence endings, then pack into larger paragraph chunks.
    const sentenceSplit = full
        .split(/(?<=[\.\!\?\u05C3])\s+/)
        .map((x) => String(x || '').trim())
        .filter(Boolean);
    if (!sentenceSplit.length) return full;
    const paragraphs = [];
    let cur = '';
    let sentCount = 0;
    for (const s of sentenceSplit) {
        const next = cur ? (cur + ' ' + s) : s;
        if (cur && (next.length > 900 || sentCount >= 9)) {
            paragraphs.push(cur.trim());
            cur = s;
            sentCount = 1;
        } else {
            cur = next;
            sentCount += 1;
        }
    }
    if (cur.trim()) paragraphs.push(cur.trim());
    return paragraphs.join('\n\n');
}

function getMedicalActiveTabTextForCopy() {
    const active = String(window.medicalActiveTab || 'summary');
    if (active === 'summary') {
        const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object') ? window.currentFormattedDoc : {};
        const mc = String(fmt.medical_chief_complaint || '').trim();
        const me = String(fmt.medical_examination_transcript || '').trim();
        const mr = String(fmt.medical_patient_recommendations || '').trim();
        if (mc || me || mr) {
            const lines = [];
            lines.push('תלונה:');
            lines.push(mc || 'לא צוין.');
            lines.push('');
            lines.push('ממצאים:');
            lines.push(me || 'לא צוין.');
            lines.push('');
            lines.push('המלצות למטופל:');
            lines.push(mr || 'לא צוין.');
            return lines.join('\n').trim();
        }
        const overview = String(fmt.overview || '').trim();
        const points = Array.isArray(fmt.key_points) ? fmt.key_points.map((p) => String(p || '').trim()).filter(Boolean) : [];
        const lines = [];
        lines.push('סקירה:');
        lines.push(overview || 'אין סיכום רפואי זמין עדיין.');
        lines.push('');
                lines.push('נקודות מפתח:');
                (points.length ? points : ['לא הוחזרו נקודות מפתח.']).forEach((p) => lines.push(p));
                const actions = Array.isArray(fmt.action_items) ? fmt.action_items.map((p) => String(p || '').trim()).filter(Boolean) : [];
                lines.push('');
                lines.push('פריטי פעולה:');
                (actions.length ? actions : ['לא הוחזרו פריטי פעולה.']).forEach((p) => lines.push(p));
                return lines.join('\n').trim();
    }
    return String(buildTranscriptPlainBodyForExport() || '').trim();
}

function getDocumentSourceForTranslation() {
    const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
        ? window.currentFormattedDoc
        : null;
    const fromFmt = fmt ? String(fmt.clean_transcript || '').trim() : '';
    if (fromFmt) return fromFmt;
    return String(buildTranscriptPlainBodyForExport() || '').trim();
}

function applyTranslatedDocumentText(translatedDocText) {
    const clean = String(translatedDocText || '').trim();
    if (!clean) return false;
    const prev = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
        ? window.currentFormattedDoc
        : {};
    window.currentFormattedDoc = { ...prev, clean_transcript: clean };
    window._qsDocPreferSegmentsAfterEdit = false;
    return true;
}

function rerenderTranscriptAfterTranslation() {
    if (typeof window._qsRerenderTranscriptView === 'function') {
        window._qsRerenderTranscriptView();
        return;
    }
    if (typeof renderTranscriptFromCues === 'function') {
        renderTranscriptFromCues(window.currentSegments || []);
        return;
    }
    if (typeof window.render === 'function') window.render();
}

function getCurrentTextForTranslation() {
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
        const medicalText = String(getMedicalActiveTabTextForCopy() || '').trim();
        if (medicalText) return medicalText;
    }
    const docSource = getDocumentSourceForTranslation();
    if (docSource) return docSource;
    const transcriptWindow = document.getElementById('transcript-window');
    return String((transcriptWindow && (transcriptWindow.innerText || transcriptWindow.textContent)) || '').trim();
}

function renderPlainTextInTranscriptWindow(text, title) {
    const transcriptWindow = document.getElementById('transcript-window');
    if (!transcriptWindow) return;
    const safeTitle = String(title || '').trim();
    const safeText = escapeHtml(String(text || '').trim()).replace(/\r?\n/g, '<br>');
    transcriptWindow.innerHTML = (
        safeTitle
            ? `<div class="translation-result-title">${escapeHtml(safeTitle)}</div>`
            : ''
    ) + `<div class="translation-result-body">${safeText}</div>`;
    transcriptWindow.setAttribute('contenteditable', 'false');
}

const QS_TRANSLATION_LANGUAGES = [
    { label: 'English', native: 'English' },
    { label: 'Hebrew', native: 'עברית' },
    { label: 'Arabic', native: 'العربية' },
    { label: 'Russian', native: 'Русский' },
    { label: 'French', native: 'Français' },
    { label: 'Spanish', native: 'Español' },
    { label: 'German', native: 'Deutsch' },
    { label: 'Italian', native: 'Italiano' },
    { label: 'Portuguese', native: 'Português' },
    { label: 'Chinese', native: '中文' },
    { label: 'Japanese', native: '日本語' },
    { label: 'Korean', native: '한국어' },
    { label: 'Hindi', native: 'हिन्दी' },
    { label: 'Ukrainian', native: 'Українська' },
    { label: 'Polish', native: 'Polski' },
];

function askTranslationLanguage() {
    return new Promise((resolve) => {
        const modal = document.getElementById('translation-language-modal');
        const input = document.getElementById('translation-language-input');
        const list = document.getElementById('translation-language-list');
        const confirmBtn = document.getElementById('translation-language-confirm');
        const cancelBtn = document.getElementById('translation-language-cancel');
        if (!modal || !input || !list || !confirmBtn || !cancelBtn) {
            resolve('');
            return;
        }
        let selected = '';
        let done = false;
        const close = (value) => {
            if (done) return;
            done = true;
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
            input.removeEventListener('input', render);
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKeydown);
            resolve(String(value || '').trim());
        };
        const render = () => {
            const q = String(input.value || '').trim().toLowerCase();
            const matches = QS_TRANSLATION_LANGUAGES
                .filter((lang) => {
                    if (!q) return true;
                    return lang.label.toLowerCase().includes(q) || String(lang.native || '').toLowerCase().includes(q);
                })
                .slice(0, 12);
            list.innerHTML = '';
            matches.forEach((lang) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'translation-language-option' + (selected === lang.label ? ' is-selected' : '');
                btn.setAttribute('role', 'option');
                btn.innerHTML = `<span>${escapeHtml(lang.label)}</span><span class="translation-language-native">${escapeHtml(lang.native)}</span>`;
                btn.addEventListener('click', () => {
                    selected = lang.label;
                    input.value = lang.label;
                    render();
                });
                btn.addEventListener('dblclick', () => close(lang.label));
                list.appendChild(btn);
            });
            if (!matches.length && q) {
                const custom = document.createElement('button');
                custom.type = 'button';
                custom.className = 'translation-language-option is-selected';
                custom.innerHTML = `<span>${escapeHtml(input.value.trim())}</span><span class="translation-language-native">Custom</span>`;
                custom.addEventListener('click', () => close(input.value.trim()));
                list.appendChild(custom);
            }
        };
        const onConfirm = () => close(selected || input.value);
        const onCancel = () => close('');
        const onBackdrop = (event) => { if (event.target === modal) close(''); };
        const onKeydown = (event) => {
            if (event.key === 'Escape') close('');
            if (event.key === 'Enter') close(selected || input.value);
        };
        selected = 'English';
        input.value = '';
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        input.addEventListener('input', render);
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKeydown);
        render();
        setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
    });
}

const QS_TRANSLATION_TEXT_CHUNK_CHARS = 6000;
const QS_CLEANUP_MAX_SINGLE_CHARS = 6500;
const QS_CLEANUP_CHUNK_PARALLEL = 2;
const QS_TRANSLATION_SEGMENT_BATCH_SIZE = 96;
const QS_TRANSLATION_TEXT_MAX_CLIENT_CONCURRENCY = 2;
const QS_TRANSLATION_SEGMENT_MAX_CLIENT_CONCURRENCY = 2;

function splitTextForClientTranslation(text, maxChunkChars = QS_TRANSLATION_TEXT_CHUNK_CHARS) {
    const raw = String(text || '').trim();
    const maxChars = Math.max(1200, Number(maxChunkChars) || QS_TRANSLATION_TEXT_CHUNK_CHARS);
    if (!raw) return [];
    if (raw.length <= maxChars) return [raw];
    const chunks = [];
    let start = 0;
    while (start < raw.length) {
        let end = Math.min(start + maxChars, raw.length);
        if (end < raw.length) {
            const windowText = raw.slice(start, end);
            const paragraphBreak = windowText.lastIndexOf('\n\n');
            const newline = windowText.lastIndexOf('\n');
            const space = windowText.lastIndexOf(' ');
            const minBreak = Math.floor(maxChars * 0.45);
            const breakAt = paragraphBreak > minBreak
                ? paragraphBreak + 2
                : (newline > minBreak ? newline + 1 : (space > minBreak ? space + 1 : -1));
            if (breakAt > 0) end = start + breakAt;
        }
        const chunk = raw.slice(start, end).trim();
        if (chunk) chunks.push(chunk);
        start = Math.max(end, start + 1);
    }
    return chunks;
}

async function fetchTranslationJson(payload) {
    const res = await fetch('/api/translate_text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Translation failed (${res.status})`);
    return data;
}

async function translatePlainTextInClientBatches(sourceText, target, isMedical) {
    const chunks = splitTextForClientTranslation(sourceText);
    const translatedParts = new Array(chunks.length);
    let completed = 0;
    let nextIdx = 0;
    const workers = Math.max(1, Math.min(QS_TRANSLATION_TEXT_MAX_CLIENT_CONCURRENCY, chunks.length));
    const runWorker = async () => {
        while (true) {
            const idx = nextIdx;
            nextIdx += 1;
            if (idx >= chunks.length) return;
            const data = await fetchTranslationJson({
                text: chunks[idx],
                targetLang: target,
                isMedical,
            });
            const translated = String(data.translation || '').trim();
            if (!translated) throw new Error('Translation returned empty text');
            translatedParts[idx] = translated;
            completed += 1;
            updateTranslationProgressDetail(`(${completed}/${chunks.length})`);
        }
    };
    await Promise.all(Array.from({ length: workers }, () => runWorker()));
    return {
        translation: translatedParts.join('\n\n').trim(),
        meta: { client_chunks: chunks.length, client_concurrency: workers },
    };
}

async function translateSegmentsInClientBatches(segments, target, isMedical) {
    const sourceSegments = Array.isArray(segments) ? segments : [];
    const translatedSegments = sourceSegments.map((seg) => (
        seg && typeof seg === 'object' ? { ...seg } : {}
    ));
    const translatable = [];
    sourceSegments.forEach((seg, idx) => {
        if (seg && typeof seg === 'object' && String(seg.text || seg.translated_text || '').trim()) {
            translatable.push({ idx, seg });
        }
    });
    const totalBatches = Math.max(1, Math.ceil(translatable.length / QS_TRANSLATION_SEGMENT_BATCH_SIZE));
    const batchJobs = [];
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const batch = translatable.slice(
            batchIndex * QS_TRANSLATION_SEGMENT_BATCH_SIZE,
            (batchIndex + 1) * QS_TRANSLATION_SEGMENT_BATCH_SIZE
        );
        if (batch.length) batchJobs.push({ batchIndex, batch });
    }
    let completed = 0;
    let nextJob = 0;
    const workers = Math.max(1, Math.min(QS_TRANSLATION_SEGMENT_MAX_CLIENT_CONCURRENCY, batchJobs.length));
    const runWorker = async () => {
        while (true) {
            const jobIdx = nextJob;
            nextJob += 1;
            if (jobIdx >= batchJobs.length) return;
            const { batch } = batchJobs[jobIdx];
            const data = await fetchTranslationJson({
                segments: batch.map((item) => item.seg),
                targetLang: target,
                isMedical,
            });
            const batchTranslations = Array.isArray(data.segments) ? data.segments : [];
            if (!batchTranslations.length) throw new Error('Translation returned empty segments');
            batchTranslations.forEach((translated, idx) => {
                const original = batch[idx];
                if (original && translated && typeof translated === 'object') {
                    translatedSegments[original.idx] = translated;
                }
            });
            completed += 1;
            updateTranslationProgressDetail(`(${completed}/${totalBatches})`);
        }
    };
    await Promise.all(Array.from({ length: workers }, () => runWorker()));
    return {
        segments: translatedSegments,
        meta: {
            client_batches: totalBatches,
            batch_size: QS_TRANSLATION_SEGMENT_BATCH_SIZE,
            client_concurrency: workers,
        },
    };
}

async function runUserRequestedTranslation() {
    const translateBtn = document.getElementById('btn-translate');
    const sourceText = getCurrentTextForTranslation();
    if (!sourceText) {
        if (typeof showStatus === 'function') showStatus('No text to translate.', true);
        return;
    }
    const targetLang = await askTranslationLanguage();
    const target = String(targetLang || '').trim();
    if (!target) return;
    const originalLabel = translateBtn ? translateBtn.textContent : '';
    const canTranslateSegments = !(
        typeof isMedicalModeEnabled === 'function' &&
        isMedicalModeEnabled() &&
        String(window.medicalActiveTab || 'summary') === 'summary'
    ) && Array.isArray(window.currentSegments) && window.currentSegments.some((s) => String((s && s.text) || '').trim());
    const isMedical = typeof isMedicalModeEnabled === 'function' ? isMedicalModeEnabled() : false;
    try {
        if (translateBtn) {
            translateBtn.disabled = true;
            translateBtn.textContent = '…';
        }
        showTranslationProgressBar(target);
        if (canTranslateSegments) {
            const docSourceHe = getDocumentSourceForTranslation();
            const [segmentResult, docResult] = await Promise.all([
                translateSegmentsInClientBatches(window.currentSegments, target, isMedical),
                docSourceHe
                    ? translatePlainTextInClientBatches(docSourceHe, target, isMedical)
                    : Promise.resolve(null),
            ]);
            if (!Array.isArray(segmentResult.segments) || !segmentResult.segments.length) {
                throw new Error('Translation returned empty segments');
            }
            window.currentSegments = segmentResult.segments;
            window.currentWords = null;
            window.currentCaptions = null;
            window.currentTranslationTargetLang = target;
            let translatedDoc = docResult && String(docResult.translation || '').trim();
            if (!translatedDoc) {
                translatedDoc = String(buildTranscriptPlainBodyForExport() || '').trim();
            }
            if (translatedDoc) {
                applyTranslatedDocumentText(translatedDoc);
                window.currentTranslationText = translatedDoc;
            } else {
                window.currentTranslationText = String(buildTranscriptPlainBodyForExport() || '').trim();
            }
            rerenderTranscriptAfterTranslation();
            if (typeof setTranscriptActionButtonsVisible === 'function') setTranscriptActionButtonsVisible(true);
            if (typeof showStatus === 'function') showStatus(`Translated to ${target}.`, false, { duration: 5000 });
            return;
        }
        const data = await translatePlainTextInClientBatches(sourceText, target, isMedical);
        const translated = String(data.translation || '').trim();
        if (!translated) throw new Error('Translation returned empty text');
        window.currentTranslationText = translated;
        window.currentTranslationTargetLang = target;
        applyTranslatedDocumentText(translated);
        rerenderTranscriptAfterTranslation();
        if (typeof showStatus === 'function') showStatus(`Translated to ${target}.`, false, { duration: 5000 });
    } catch (e) {
        console.warn('[translate_text] failed', e);
        if (typeof showStatus === 'function') showStatus(e.message || 'Translation failed.', true);
    } finally {
        hideTranslationProgressBar();
        if (translateBtn) {
            translateBtn.disabled = false;
            translateBtn.textContent = originalLabel || '🌐';
        }
    }
}

async function commitActiveWordTokenEditIfAny() {
    try {
        const win = document.getElementById('transcript-window');
        const activeInput = win ? win.querySelector('span.word-token.editing input.qs-token-input') : null;
        if (activeInput && typeof activeInput.blur === 'function') {
            window._qsSkipCommitRefocus = true;
            activeInput.blur();
            await new Promise((r) => setTimeout(r, 0));
        }
    } catch (_) {}
}

/** Long transcripts: one HTTP call runs past reverse-proxy limits → 504. Use plan + per-chunk + summary requests. */
// Below this length, one POST is usually under proxy limits; above it, use plan + per-chunk + summary (sequential chunks).
const QS_FORMAT_MULTI_REQUEST_CHARS = 4000;

/**
 * @returns {Promise<{ ok: boolean, res: Response, fmt: Record<string, unknown> }>}
 */
async function qsCurrentUserId() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        return user && user.id ? String(user.id) : '';
    } catch (_) {
        return '';
    }
}

const QS_MEDICAL_TRAINING_MODE_KEY = 'qs_medical_training_mode';

function isMedicalTrainingModeEnabled() {
    try { return localStorage.getItem(QS_MEDICAL_TRAINING_MODE_KEY) === '1'; } catch (_) { return false; }
}

function setMedicalTrainingModeEnabled(on) {
    try {
        if (on) localStorage.setItem(QS_MEDICAL_TRAINING_MODE_KEY, '1');
        else localStorage.removeItem(QS_MEDICAL_TRAINING_MODE_KEY);
    } catch (_) {}
    window._medicalTrainingMode = !!on;
}

function medicalTrainingSummaryText(fmt) {
    const f = normalizeFormattedFields(fmt) || ((fmt && typeof fmt === 'object') ? fmt : {});
    const parts = [];
    const chief = _medicalSummaryFieldBody(f.medical_chief_complaint, 'chief');
    const exam = _medicalSummaryFieldBody(f.medical_examination_transcript, 'exam');
    const rec = _medicalSummaryFieldBody(f.medical_patient_recommendations, 'rec');
    if (chief || exam || rec) {
        parts.push(`תלונה:\n${chief}`);
        parts.push(`ממצאים:\n${exam}`);
        parts.push(`המלצות למטופל:\n${rec}`);
        return parts.join('\n\n').trim();
    }
    const overview = String(f.overview || '').trim();
    if (overview) parts.push(overview);
    if (Array.isArray(f.key_points) && f.key_points.length) {
        parts.push(f.key_points.map((p) => `- ${String(p || '').trim()}`).filter(Boolean).join('\n'));
    }
    return parts.filter(Boolean).join('\n\n').trim();
}

/** Normalize doctor-summary textarea for compare (retry gate). */
function _qsNormMedicalTrainingSummaryText(s) {
    return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

const QS_MEDICAL_TRAINING_TOAST_UPDATE_SUMMARY = 'עדכן את הסיכום הרצוי.';

function _medicalTrainingBtnSetDisabled(btn, disabled) {
    if (!btn) return;
    btn.disabled = false;
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    btn.classList.toggle('qs-medical-training-btn-inactive', !!disabled);
    btn.style.opacity = disabled ? '0.5' : '1';
    btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

function _medicalTrainingBtnBlockIfInactive(btn) {
    if (!btn || btn.getAttribute('aria-disabled') !== 'true') return false;
    if (typeof showStatus === 'function') {
        showStatus(QS_MEDICAL_TRAINING_TOAST_UPDATE_SUMMARY, false, { duration: 5000 });
    }
    return true;
}

async function medicalTrainingApi(path, payload) {
    const userId = await qsCurrentUserId();
    if (!userId) throw new Error('יש להתחבר כדי לאמן פרומפט אישי.');
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...(payload || {}) })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.error)) {
        throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
}

/** Learn step can exceed reverse-proxy timeout; server returns 202 + poll until done. */
async function medicalTrainingLearn(payload) {
    const start = await medicalTrainingApi('/api/medical_training/learn', { ...(payload || {}), async: true });
    const learnJobId = start && start.learn_job_id;
    if (!learnJobId) {
        return start;
    }
    const pollMs = 2500;
    const maxPolls = 180;
    for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, pollMs));
        const stRes = await fetch(`/api/medical_training/learn_status?learn_job_id=${encodeURIComponent(learnJobId)}`);
        const st = await stRes.json().catch(() => ({}));
        if (st.status === 'done' && st.ok !== false) {
            return st;
        }
        if (st.status === 'error') {
            throw new Error(st.error || 'האימון נכשל');
        }
        if (!stRes.ok && stRes.status !== 200) {
            throw new Error(st.error || `HTTP ${stRes.status}`);
        }
    }
    throw new Error('האימון לוקח יותר מדי זמן — נסה שוב');
}

/** Shared by account-menu toggle and summary CTA (e.g. after drag-drop JSON/WAV). */
async function activateMedicalTrainingFlow() {
    const medicalTrainingStatus = document.getElementById('user-menu-medical-training-status');
    const medicalTrainingInput = document.getElementById('user-menu-medical-training-mode');
    const medicalModeInput = document.getElementById('user-menu-medical-mode');
    if (medicalTrainingStatus) medicalTrainingStatus.textContent = 'מפעיל מצב אימון...';
    setMedicalTrainingModeEnabled(true);
    try {
        await medicalTrainingApi('/api/medical_training/start', {});
        if (!isMedicalModeEnabled()) {
            if (medicalModeInput) medicalModeInput.checked = true;
            setMedicalMode(true, { bypassMedicalUrlLock: true });
        }
        if (medicalTrainingInput) medicalTrainingInput.checked = true;
        if (medicalTrainingStatus) {
            medicalTrainingStatus.textContent = 'מצב אימון פעיל — אזור האימון מוצג מתחת לסיכום הרפואי.';
        }
        if (typeof renderTranscriptFromCues === 'function') renderTranscriptFromCues(window.currentSegments || []);
    } catch (e) {
        setMedicalTrainingModeEnabled(false);
        if (medicalTrainingInput) medicalTrainingInput.checked = false;
        if (medicalTrainingStatus) medicalTrainingStatus.textContent = String((e && e.message) || e);
        throw e;
    }
}

/** When training mode is off, offer one-click enable on the medical summary pane (visible after drag-drop, upload, etc.). */
function renderMedicalTrainingOnboardingCta(container) {
    if (!container || !isMedicalModeEnabled() || isMedicalTrainingModeEnabled()) return;
    const transcript = String(buildTranscriptTextForGptFormat() || '').trim();
    const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object') ? window.currentFormattedDoc : {};
    const aiSummary = medicalTrainingSummaryText(fmt);
    if (!transcript || !aiSummary) return;
    const wrap = document.createElement('div');
    wrap.id = 'medical-training-enable-cta';
    wrap.style.cssText = 'direction:rtl;text-align:right;margin-top:14px;padding:12px;border:1px dashed #5eead4;border-radius:10px;background:#ecfdf5;';
    wrap.innerHTML = `
        <div style="font-size:0.9rem;color:#0f766e;margin-bottom:6px;font-weight:700;">התאמת סגנון סיכום (אימון פרומפט)</div>
        <div style="font-size:0.85rem;color:#115e59;margin-bottom:10px;line-height:1.55;">ניתן ללמד העדפות סגנון ומבנה מהסיכום שלכם. לחצו להפעלת מצב האימון — אותו מצב כמו בתפריט החשבון.</div>
        <button type="button" id="medical-training-enable-cta-btn" style="padding:8px 14px;border:none;border-radius:8px;background:#0f766e;color:#fff;font-weight:700;cursor:pointer;">הפעל מצב אימון</button>
        <div id="medical-training-enable-cta-msg" style="margin-top:8px;font-size:0.85rem;color:#b91c1c;"></div>
    `;
    container.appendChild(wrap);
    const btn = wrap.querySelector('#medical-training-enable-cta-btn');
    const msg = wrap.querySelector('#medical-training-enable-cta-msg');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        if (msg) msg.textContent = '';
        try {
            const userId = await qsCurrentUserId();
            if (!userId) {
                if (msg) msg.textContent = 'יש להתחבר כדי להפעיל אימון.';
                btn.disabled = false;
                return;
            }
            await activateMedicalTrainingFlow();
        } catch (e) {
            if (msg) msg.textContent = String((e && e.message) || e || 'ההפעלה נכשלה').slice(0, 200);
            btn.disabled = false;
        }
    });
}

function renderMedicalTrainingPanel(container) {
    if (!container || !isMedicalModeEnabled() || !isMedicalTrainingModeEnabled()) return;
    const transcript = String(buildTranscriptTextForGptFormat() || '').trim();
    const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object') ? window.currentFormattedDoc : {};
    const aiSummary = medicalTrainingSummaryText(fmt);
    if (!transcript || !aiSummary) return;
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const preview = window._medicalTrainingCandidatePreview;
    const previewText = preview ? medicalTrainingSummaryText(preview) : '';
    const rules = Array.isArray(window._medicalTrainingLearnedRules) && window._medicalTrainingLearnedRules.length
        ? `<ul style="margin:6px 0 0; padding-inline-start:20px;">${window._medicalTrainingLearnedRules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
        : '';
    const postLearnPreview = !!window._medicalTrainingPostLearnPreviewReady;
    let draftText = _qsNormMedicalTrainingSummaryText(window._medicalTrainingDoctorDraft || '');
    const retryBaseline = _qsNormMedicalTrainingSummaryText(window._medicalTrainingBaselineForRetry || '');
    if (!postLearnPreview && !retryBaseline && draftText && draftText === _qsNormMedicalTrainingSummaryText(aiSummary)) {
        window._medicalTrainingDoctorDraft = '';
        draftText = '';
    }
    const canLearnNow = !!draftText && (!postLearnPreview || !retryBaseline || draftText !== retryBaseline);
    const learnBtnLabel = postLearnPreview ? 'נסה שנית' : 'למד מהסיכום הזה';
    const learnBtnStyle = postLearnPreview
        ? 'padding:10px 14px;border:1px solid #0f766e;border-radius:10px;background:#ffffff;color:#0f766e;font-weight:700;cursor:pointer;'
        : 'padding:10px 14px;border:none;border-radius:10px;background:#0f766e;color:#ffffff;font-weight:700;cursor:pointer;';
    const approveEnabled = (
        postLearnPreview &&
        !!String(window._medicalTrainingCandidatePrompt || '').trim() &&
        !window._medicalTrainingApprovedCandidatePrompt
    );
    const approveBtnStyle = postLearnPreview
        ? 'padding:10px 14px;border:none;border-radius:10px;background:#0f766e;color:#ffffff;font-weight:700;cursor:pointer;'
        : 'padding:10px 14px;border:1px solid #0f766e;border-radius:10px;background:#ffffff;color:#0f766e;font-weight:700;cursor:pointer;';
    const panel = document.createElement('div');
    panel.id = 'medical-training-panel';
    panel.style.cssText = 'direction:rtl;text-align:right;margin-top:18px;padding:14px;border:1px solid #99f6e4;border-radius:12px;background:#f0fdfa;line-height:1.6;';
    const expanded = !!window._medicalTrainingPanelExpanded;
    const chevron = expanded ? '▼' : '▶';
    const textareaInitialEsc = expanded ? esc(draftText) : '';
    panel.innerHTML = `
        <button type="button" id="medical-training-toggle" aria-expanded="${expanded ? 'true' : 'false'}" style="display:flex;width:100%;align-items:center;gap:10px;background:transparent;border:none;cursor:pointer;padding:0;margin:0;font:inherit;text-align:right;direction:rtl;color:inherit;">
            <span id="medical-training-chevron" style="font-size:0.72rem;color:#0f766e;flex-shrink:0;width:1.1em;line-height:1;text-align:center;" aria-hidden="true">${chevron}</span>
            <span style="font-weight:800;color:#0f766e;flex:1;">מצב אימון: התאמת סיכום לרופא</span>
        </button>
        <div id="medical-training-panel-body" style="display:${expanded ? 'block' : 'none'};margin-top:12px;">
        <div style="font-size:0.88rem;color:#0f766e;margin-bottom:10px;">ערכו/הדביקו את הסיכום הרצוי. המערכת תלמד העדפות סגנון ומבנה בלבד, לא עובדות קליניות.</div>
        <textarea id="medical-training-doctor-summary" class="qs-medical-training-textarea" rows="8" placeholder="כתוב פה את הסיכום הרצוי" style="width:100%;box-sizing:border-box;border:1px solid #99f6e4;border-radius:10px;padding:10px;resize:vertical;direction:rtl;text-align:right;font:inherit;">${textareaInitialEsc}</textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
            <button type="button" id="medical-training-learn-btn" style="${learnBtnStyle}">${learnBtnLabel}</button>
            <button type="button" id="medical-training-approve-btn" style="${approveBtnStyle}">אשר אימון</button>
        </div>
        <div id="medical-training-message" style="margin-top:8px;font-size:0.88rem;color:#0f766e;">${esc(window._medicalTrainingMessage || '')}</div>
        ${previewText ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #99f6e4;"><strong>תצוגה מקדימה עם מודל הייצור:</strong><div style="white-space:pre-wrap;margin-top:6px;">${esc(previewText)}</div></div>` : ''}
        ${rules ? `<div style="margin-top:10px;"><strong>כללים שנלמדו:</strong>${rules}</div>` : ''}
        </div>
    `;
    container.appendChild(panel);
    const toggleBtn = panel.querySelector('#medical-training-toggle');
    const bodyEl = panel.querySelector('#medical-training-panel-body');
    const chevronEl = panel.querySelector('#medical-training-chevron');
    if (toggleBtn && bodyEl && chevronEl) {
        toggleBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const ta = panel.querySelector('#medical-training-doctor-summary');
            if (window._medicalTrainingPanelExpanded && ta) {
                window._medicalTrainingDoctorDraft = ta.value;
            }
            const next = !window._medicalTrainingPanelExpanded;
            window._medicalTrainingPanelExpanded = next;
            bodyEl.style.display = next ? 'block' : 'none';
            chevronEl.textContent = next ? '▼' : '▶';
            toggleBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
            if (next && ta) {
                ta.value = String(window._medicalTrainingDoctorDraft || '');
            }
        });
    }
    const textarea = panel.querySelector('#medical-training-doctor-summary');
    const message = panel.querySelector('#medical-training-message');
    const learnBtn = panel.querySelector('#medical-training-learn-btn');
    const approveBtn = panel.querySelector('#medical-training-approve-btn');
    const syncTrainingButtons = () => {
        const currentDraft = _qsNormMedicalTrainingSummaryText(textarea ? textarea.value : '');
        const baseline = _qsNormMedicalTrainingSummaryText(window._medicalTrainingBaselineForRetry || '');
        const hasChangedForRetry = !window._medicalTrainingPostLearnPreviewReady || !baseline || currentDraft !== baseline;
        const learnActive = !!(currentDraft && hasChangedForRetry);
        const approveActive = !!(
            window._medicalTrainingPostLearnPreviewReady &&
            String(window._medicalTrainingCandidatePrompt || '').trim() &&
            !window._medicalTrainingApprovedCandidatePrompt
        );
        _medicalTrainingBtnSetDisabled(learnBtn, !learnActive);
        _medicalTrainingBtnSetDisabled(approveBtn, !approveActive);
    };
    if (textarea) {
        textarea.addEventListener('input', () => {
            window._medicalTrainingDoctorDraft = textarea.value;
            syncTrainingButtons();
        });
    }
    syncTrainingButtons();
    if (learnBtn) {
        learnBtn.onclick = async () => {
            if (_medicalTrainingBtnBlockIfInactive(learnBtn)) return;
            try {
                if (window._medicalTrainingPostLearnPreviewReady) {
                    const cur = _qsNormMedicalTrainingSummaryText(textarea ? textarea.value : '');
                    const baseline = _qsNormMedicalTrainingSummaryText(window._medicalTrainingBaselineForRetry);
                    if (baseline && cur === baseline) {
                        if (typeof showStatus === 'function') {
                            showStatus('יש לערוך את הטקסט לפני ניסיון חדש.', false, { duration: 5000 });
                        }
                        return;
                    }
                }
                const doctorSummary = _qsNormMedicalTrainingSummaryText(textarea ? textarea.value : '');
                if (!doctorSummary) {
                    if (typeof showStatus === 'function') {
                        showStatus('יש לערוך את הטקסט לפני ניסיון חדש.', false, { duration: 5000 });
                    }
                    syncTrainingButtons();
                    return;
                }
                learnBtn.disabled = true;
                window._medicalTrainingPostLearnPreviewReady = false;
                window._medicalTrainingApprovedCandidatePrompt = '';
                if (message) message.textContent = 'מנתח סגנון ומגבש מודל סיכום מותאם...';
                if (typeof window.showClinicalTrainingModal === 'function') window.showClinicalTrainingModal();
                const learned = await medicalTrainingLearn({
                    transcript,
                    ai_summary: fmt,
                    doctor_summary: doctorSummary,
                    candidate_prompt: window._medicalTrainingCandidatePrompt || ''
                });
                window._medicalTrainingCandidatePrompt = learned.candidate_prompt || '';
                window._medicalTrainingLastExampleId = learned.example_id || '';
                window._medicalTrainingLearnedRules = Array.isArray(learned.learned_rules) ? learned.learned_rules : [];
                if (learned.optimizer_model || learned.preview_model) {
                    console.info('[medical training] learn models:', {
                        optimizer: learned.optimizer_model,
                        preview_planned: learned.preview_model,
                    });
                }
                window._medicalTrainingMessage = learned.rationale || 'נוצר פרומפט מועמד. מריץ תצוגה מקדימה...';
                const previewRes = await medicalTrainingApi('/api/medical_training/preview', {
                    transcript,
                    candidate_prompt: window._medicalTrainingCandidatePrompt,
                    target_lang: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he') || 'he'
                });
                window._medicalTrainingCandidatePreview = previewRes.formatted
                    ? (normalizeFormattedFields(previewRes.formatted) || previewRes.formatted)
                    : null;
                if (previewRes.preview_model) {
                    console.info('[medical training] preview model:', previewRes.preview_model);
                }
                window._medicalTrainingMessage = 'התצוגה המקדימה מוכנה. אם סגנון הסיכום מתאים, אשרו את הגדרות האימון..';
                window._medicalTrainingPostLearnPreviewReady = true;
                window._medicalTrainingPanelExpanded = true;
                window._medicalTrainingBaselineForRetry = doctorSummary;
                if (typeof window.hideClinicalTrainingModal === 'function') window.hideClinicalTrainingModal();
                if (typeof renderTranscriptFromCues === 'function') renderTranscriptFromCues(window.currentSegments || []);
            } catch (e) {
                if (typeof window.hideClinicalTrainingModal === 'function') window.hideClinicalTrainingModal();
                if (message) message.textContent = 'האימון נכשל: ' + String((e && e.message) || e).slice(0, 220);
            } finally {
                syncTrainingButtons();
            }
        };
    }
    if (approveBtn) {
        approveBtn.onclick = async () => {
            if (_medicalTrainingBtnBlockIfInactive(approveBtn)) return;
            try {
                if (!window._medicalTrainingPostLearnPreviewReady || !String(window._medicalTrainingCandidatePrompt || '').trim()) {
                    if (typeof showStatus === 'function') {
                        showStatus('יש להריץ למידה ותצוגה מקדימה לפני אישור האימון.', false, { duration: 5000 });
                    }
                    return;
                }
                approveBtn.disabled = true;
                const candidateToApprove = String(window._medicalTrainingCandidatePrompt || '').trim();
                if (window._medicalTrainingApprovedCandidatePrompt === candidateToApprove) {
                    if (typeof showStatus === 'function') {
                        showStatus('האימון הזה כבר אושר.', false, { duration: 5000 });
                    }
                    return;
                }
                if (message) message.textContent = 'שומר סיגנון סיכום...';
                const approved = await medicalTrainingApi('/api/medical_training/approve', {
                    candidate_prompt: candidateToApprove,
                    example_id: window._medicalTrainingLastExampleId || ''
                });
                window._medicalTrainingMessage = `נשמר סיגנון סיכום, גרסה ${approved?.profile?.version || ''}.`;
                window._medicalTrainingApprovedCandidatePrompt = candidateToApprove;
                window._medicalTrainingPostLearnPreviewReady = false;
                window._medicalTrainingBaselineForRetry = '';
                window._medicalTrainingDoctorDraft = '';
                window._medicalTrainingCandidatePrompt = '';
                window._medicalTrainingCandidatePreview = null;
                window._medicalTrainingLearnedRules = [];
                window._medicalTrainingLastExampleId = '';
                if (typeof renderTranscriptFromCues === 'function') renderTranscriptFromCues(window.currentSegments || []);
            } catch (e) {
                if (message) message.textContent = 'שמירת סיגנון הסיכום נכשלה: ' + String((e && e.message) || e).slice(0, 220);
            } finally {
                syncTrainingButtons();
            }
        };
    }
}

async function qsTrackEvent(event, properties) {
    try {
        const props = { ...(properties || {}) };
        const jobId = String(localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || '').trim();
        if (jobId && !props.job_id) props.job_id = jobId;
        const headers = { 'Content-Type': 'application/json' };
        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session && session.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        } catch (_) {}
        fetch('/api/analytics/event', {
            method: 'POST',
            headers,
            body: JSON.stringify({ event: String(event || '').trim(), properties: props }),
            keepalive: true,
        }).catch(() => {});
    } catch (_) {}
}
window.qsTrackEvent = qsTrackEvent;

function hasCleanTranscript() {
    const fmt = window.currentFormattedDoc;
    return !!(fmt && String(fmt.clean_transcript || '').trim());
}

function qsTranscriptCleanupBannerHtml() {
    if (!window._qsCleanupInFlight) return '';
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    let msg = T('transcript_cleanup_in_progress') || 'Improving transcript readability…';
    const prog = window._qsCleanupProgress;
    if (prog && prog.total > 1 && Number.isFinite(prog.current)) {
        msg += ` (${prog.current}/${prog.total})`;
    }
    return `<div id="qs-cleanup-banner" class="qs-cleanup-banner" role="status" style="margin:0 0 10px;padding:8px 12px;border-radius:8px;background:#eff6ff;color:#1e40af;font-size:13px;line-height:1.4;">${msg.replace(/</g, '&lt;')}</div>`;
}

function qsResetCleanupState() {
    window._qsCleanupDone = false;
    window._qsCleanupInFlight = false;
    window._qsCleanupFailed = false;
    window._qsCleanupPromise = null;
    window._qsCleanupProgress = null;
}

async function qsPersistFormattedDocToS3() {
    try {
        const { data: { user } } = await supabase.auth.getUser();
        const s3Key = (typeof currentJobInputS3KeyHint === 'function' ? currentJobInputS3KeyHint() : '') ||
            String(localStorage.getItem('lastS3Key') || '').trim();
        if (!user || !s3Key || !(window.currentSegments || []).length) return;
        const saveFmtRes = await fetch('/api/save_job_result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user.id,
                input_s3_key: s3Key,
                segments: window.currentSegments,
                words: window.currentWords || undefined,
                captions: window.currentCaptions || undefined,
                formatted: window.currentFormattedDoc,
                stage: 'gpt',
                isMedical: typeof effectiveIsMedicalForFormatting === 'function' ? effectiveIsMedicalForFormatting() : false
            })
        });
        if (saveFmtRes.ok) {
            await syncJobResultS3KeyFromSaveResponse(saveFmtRes, localStorage.getItem('lastJobDbId'));
        }
    } catch (e) {
        console.warn('[GPT] save formatted payload failed:', e);
    }
}

async function runFormatSummaryOnlyRequest(fullText, targetLang, jobId) {
    const hint = typeof currentJobInputS3KeyHint === 'function' ? currentJobInputS3KeyHint() : '';
    const userId = await qsCurrentUserId();
    const base = () => ({
        target_lang: targetLang,
        jobId: jobId || undefined,
        userId: userId || undefined,
        isMedical: typeof effectiveIsMedicalForFormatting === 'function' ? effectiveIsMedicalForFormatting() : false,
        mode: 'summary',
        ...(hint ? { input_s3_key: hint } : {}),
    });
    const t0 = performance.now();
    const res = await fetch('/api/format_transcript_summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base(), text: fullText })
    });
    const fmt = await res.json().catch(() => ({}));
    const elapsedMs = Math.round(performance.now() - t0);
    const summarySec = Number(fmt && fmt.summary_generation_time);
    qsTrackEvent('summary_generation_time', {
        duration_ms: elapsedMs,
        summary_generation_time: Number.isFinite(summarySec) ? summarySec : undefined,
        ok: !!(res.ok && fmt && !fmt.error),
    });
    return { ok: res.ok && fmt && typeof fmt === 'object' && !fmt.error, res, fmt: fmt && !fmt.error ? normalizeFormattedFields(fmt) : fmt };
}

async function fetchTranscriptFormatChunksPlan(fullText) {
    const res = await fetch('/api/transcript_format_chunks_plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fullText }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.chunks)) {
        throw new Error((data && data.error) ? String(data.error) : `chunk plan HTTP ${res.status}`);
    }
    return data.chunks.map((c) => String(c || '').trim()).filter(Boolean);
}

function qsCleanupRequestBase(targetLang, jobId) {
    const hint = typeof currentJobInputS3KeyHint === 'function' ? currentJobInputS3KeyHint() : '';
    return {
        target_lang: targetLang,
        jobId: jobId || undefined,
        userId: undefined,
        isMedical: typeof effectiveIsMedicalForFormatting === 'function' ? effectiveIsMedicalForFormatting() : false,
        ...(hint ? { input_s3_key: hint } : {}),
    };
}

async function runFormatTranscriptCleanupRequest(fullText, targetLang, jobId) {
    const userId = await qsCurrentUserId();
    const base = { ...qsCleanupRequestBase(targetLang, jobId), userId: userId || undefined, mode: 'cleanup' };
    const t0 = performance.now();
    const res = await fetch('/api/format_transcript_summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, text: fullText }),
    });
    const fmt = await res.json().catch(() => ({}));
    const elapsedMs = Math.round(performance.now() - t0);
    const cleanupSec = Number(fmt && (fmt.cleanup_generation_time || fmt.gpt_format_sec));
    qsTrackEvent('cleanup_generation_time', {
        duration_ms: elapsedMs,
        cleanup_generation_time: Number.isFinite(cleanupSec) ? cleanupSec : undefined,
        ok: !!(res.ok && fmt && !fmt.error),
        chunked: false,
    });
    const normalized = fmt && !fmt.error
        ? normalizeFormattedFields({ clean_transcript: fmt.clean_transcript || '' })
        : fmt;
    return { ok: res.ok && normalized && typeof normalized === 'object' && !normalized.error, res, fmt: normalized };
}

async function runFormatTranscriptCleanChunkRequest(chunkText, targetLang, jobId) {
    const userId = await qsCurrentUserId();
    const base = { ...qsCleanupRequestBase(targetLang, jobId), userId: userId || undefined, mode: 'clean_chunk' };
    const res = await fetch('/api/format_transcript_summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, text: chunkText }),
    });
    const fmt = await res.json().catch(() => ({}));
    const normalized = fmt && !fmt.error
        ? normalizeFormattedFields({ clean_transcript: fmt.clean_transcript || '' })
        : fmt;
    return { ok: res.ok && normalized && typeof normalized === 'object' && !normalized.error, res, fmt: normalized };
}

async function runFormatTranscriptCleanupChunked(fullText, targetLang, jobId) {
    const chunks = await fetchTranscriptFormatChunksPlan(fullText);
    if (!chunks.length) return { ok: false, res: null, fmt: null };
    if (chunks.length === 1) {
        return runFormatTranscriptCleanupRequest(fullText, targetLang, jobId);
    }
    const parts = new Array(chunks.length);
    let completed = 0;
    const parallel = Math.max(1, Math.min(QS_CLEANUP_CHUNK_PARALLEL, chunks.length));
    window._qsCleanupProgress = { current: 0, total: chunks.length };
    const t0 = performance.now();
    let nextIdx = 0;
    const processOne = async () => {
        while (nextIdx < chunks.length) {
            const i = nextIdx++;
            const { ok, res, fmt } = await runFormatTranscriptCleanChunkRequest(chunks[i], targetLang, jobId);
            if (!ok || !fmt || !String(fmt.clean_transcript || '').trim()) {
                const errMsg = (fmt && fmt.error) ? String(fmt.error) : `HTTP ${res && res.status}`;
                throw new Error(`cleanup chunk ${i + 1}/${chunks.length} failed: ${errMsg}`);
            }
            parts[i] = String(fmt.clean_transcript || '').trim();
            completed++;
            window._qsCleanupProgress = { current: completed, total: chunks.length };
            if (typeof window._qsRerenderTranscriptView === 'function') window._qsRerenderTranscriptView();
        }
    };
    await Promise.all(Array.from({ length: parallel }, () => processOne()));
    const clean = parts.filter(Boolean).join('\n\n').trim();
    const elapsedMs = Math.round(performance.now() - t0);
    qsTrackEvent('cleanup_generation_time', {
        duration_ms: elapsedMs,
        ok: !!clean,
        chunked: true,
        chunk_count: chunks.length,
    });
    if (!clean) return { ok: false, res: null, fmt: null };
    return { ok: true, res: { status: 200 }, fmt: normalizeFormattedFields({ clean_transcript: clean }) };
}

function qsApplyCleanupResult(cleanTranscript) {
    const clean = String(cleanTranscript || '').trim();
    if (!clean) return false;
    const prev = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
        ? window.currentFormattedDoc
        : {};
    window.currentFormattedDoc = normalizeFormattedFields({
        ...prev,
        clean_transcript: clean,
    });
    window._qsCleanupDone = true;
    window._qsDocPreferSegmentsAfterEdit = false;
    return true;
}

/** Single shared cleanup runner — Transcript tab and export await the same in-flight work. */
async function runTranscriptCleanupShared(options) {
    options = options || {};
    if (typeof effectiveIsMedicalForFormatting === 'function' && effectiveIsMedicalForFormatting()) {
        return hasCleanTranscript();
    }
    if (window._qsCleanupDone || hasCleanTranscript()) {
        window._qsCleanupDone = true;
        return true;
    }
    if (window._qsCleanupPromise) {
        return window._qsCleanupPromise;
    }
    const fullText = buildTranscriptTextForGptFormat();
    if (!fullText.trim()) return false;

    const targetLang = (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he') || 'he';
    const jobId = localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || undefined;
    window._qsCleanupInFlight = true;
    window._qsCleanupFailed = false;
    window._qsCleanupProgress = null;
    if (options.rerender !== false && typeof window._qsRerenderTranscriptView === 'function') {
        window._qsRerenderTranscriptView();
    }

    window._qsCleanupPromise = (async () => {
        try {
            const useChunked = fullText.length > QS_CLEANUP_MAX_SINGLE_CHARS;
            const { ok, fmt } = useChunked
                ? await runFormatTranscriptCleanupChunked(fullText, targetLang, jobId)
                : await runFormatTranscriptCleanupRequest(fullText, targetLang, jobId);
            if (!ok || !fmt || !String(fmt.clean_transcript || '').trim()) {
                window._qsCleanupFailed = true;
                return false;
            }
            if (!qsApplyCleanupResult(fmt.clean_transcript)) {
                window._qsCleanupFailed = true;
                return false;
            }
            qsTrackEvent('cleanup_completed', { ok: true, chunked: useChunked });
            void qsPersistFormattedDocToS3();
            if (typeof window._qsRerenderTranscriptView === 'function') window._qsRerenderTranscriptView();
            return true;
        } catch (e) {
            window._qsCleanupFailed = true;
            console.warn('[GPT] transcript cleanup failed:', e);
            return false;
        } finally {
            window._qsCleanupInFlight = false;
            window._qsCleanupPromise = null;
            window._qsCleanupProgress = null;
            if (options.rerender !== false && typeof window._qsRerenderTranscriptView === 'function') {
                window._qsRerenderTranscriptView();
            }
        }
    })();

    return window._qsCleanupPromise;
}
window.runTranscriptCleanupShared = runTranscriptCleanupShared;

async function ensureTranscriptCleanupLazy(options) {
    return runTranscriptCleanupShared(options);
}
window.ensureTranscriptCleanupLazy = ensureTranscriptCleanupLazy;

async function runFormatTranscriptSummaryRequests(fullText, targetLang, jobId) {
    const medFmt = typeof effectiveIsMedicalForFormatting === 'function' && effectiveIsMedicalForFormatting();
    if (!medFmt) {
        return runFormatSummaryOnlyRequest(fullText, targetLang, jobId);
    }
    const hint = typeof currentJobInputS3KeyHint === 'function' ? currentJobInputS3KeyHint() : '';
    const userId = await qsCurrentUserId();
    const base = () => ({
        target_lang: targetLang,
        jobId: jobId || undefined,
        userId: userId || undefined,
        isMedical: true,
        ...(hint ? { input_s3_key: hint } : {}),
    });
    const res = await fetch('/api/format_transcript_summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base(), text: fullText })
    });
    const fmt = await res.json().catch(() => ({}));
    return { ok: res.ok && fmt && typeof fmt === 'object' && !fmt.error, res, fmt: fmt && !fmt.error ? normalizeFormattedFields(fmt) : fmt };
}

/** Keep document-format source in sync after manual subtitle edits. */
function syncFormattedDocWithCurrentSegments() {
    const clean = String(buildTranscriptPlainBodyForExport() || '').trim();
    if (!clean) return;
    const prev = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
        ? window.currentFormattedDoc
        : {};
    const next = {
        clean_transcript: clean,
        overview: String(prev.overview || '').trim(),
        key_points: Array.isArray(prev.key_points)
            ? prev.key_points.map((p) => String(p || '').trim()).filter(Boolean)
            : [],
        action_items: Array.isArray(prev.action_items)
            ? prev.action_items.map((p) => String(p || '').trim()).filter(Boolean)
            : []
    };
    if (
        prev.medical_chief_complaint != null ||
        prev.medical_examination_transcript != null ||
        prev.medical_patient_recommendations != null
    ) {
        next.medical_chief_complaint = String(prev.medical_chief_complaint || '').trim();
        next.medical_examination_transcript = String(prev.medical_examination_transcript || '').trim();
        next.medical_patient_recommendations = String(prev.medical_patient_recommendations || '').trim();
    }
    window.currentFormattedDoc = next;
}

async function ensureFormattedViaApiForExport() {
    const fullText = buildTranscriptTextForGptFormat();
    if (!fullText.trim()) return false;
    const targetLang = (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he') || 'he';
    const medFmt = typeof effectiveIsMedicalForFormatting === 'function' && effectiveIsMedicalForFormatting();
    const needSummary = !hasStandardFormattedSummary();
    const needClean = !hasCleanTranscript();
    if (!needSummary && !needClean) return true;
    if (typeof showStatus === 'function') {
        const msg = medFmt
            ? 'מייצר סיכום רפואי ומעצב תמלול (GPT)…'
            : (needClean && needSummary ? 'מייצר סיכום ומעצב תמלול…' : (needClean ? 'מעצב תמלול לייצוא…' : 'מייצר סיכום…'));
        showStatus(msg, false, { duration: 720000 });
    }
    try {
        const jobId = localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || undefined;
        let safeFmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
            ? { ...window.currentFormattedDoc }
            : {};
        if (medFmt) {
            const { ok, res, fmt } = await runFormatTranscriptSummaryRequests(fullText, targetLang, jobId);
            if (!ok || !fmt || typeof fmt !== 'object') {
                const errMsg = (fmt && fmt.error) ? String(fmt.error) : `HTTP ${res.status}`;
                console.warn('[export] format_transcript_summary failed', res.status, errMsg);
                if (typeof showStatus === 'function') {
                    showStatus('עיצוב התמלול נכשל: ' + errMsg.slice(0, 200), true);
                }
                return false;
            }
            safeFmt = fmt;
            if (_medicalFormatLooksHallucinated(fullText, fmt)) {
                console.warn('[export] medical format guardrail: rejecting hallucinated summary for short transcript');
                safeFmt = _medicalMinimalFormattedDocFromTranscript(fullText) || fmt;
            }
        } else {
            if (needSummary) {
                const { ok, res, fmt } = await runFormatSummaryOnlyRequest(fullText, targetLang, jobId);
                if (!ok || !fmt || typeof fmt !== 'object') {
                    const errMsg = (fmt && fmt.error) ? String(fmt.error) : `HTTP ${res.status}`;
                    console.warn('[export] summary format failed', res.status, errMsg);
                    if (typeof showStatus === 'function') {
                        showStatus('יצירת הסיכום נכשלה: ' + errMsg.slice(0, 200), true);
                    }
                    return false;
                }
                safeFmt = { ...safeFmt, ...fmt };
            }
            if (needClean) {
                const cleanupOk = await runTranscriptCleanupShared({ rerender: false });
                if (!cleanupOk || !hasCleanTranscript()) {
                    const errMsg = window._qsCleanupFailed ? 'cleanup failed or timed out' : 'no clean transcript';
                    console.warn('[export] cleanup format failed', errMsg);
                    if (typeof showStatus === 'function') {
                        showStatus('עיצוב התמלול נכשל: ' + errMsg.slice(0, 200), true);
                    }
                    return false;
                }
                safeFmt.clean_transcript = String(window.currentFormattedDoc.clean_transcript || '').trim();
            }
        }
        const rawFmt = {
            clean_transcript: String(safeFmt.clean_transcript || '').trim(),
            overview: String(safeFmt.overview || '').trim(),
            key_points: Array.isArray(safeFmt.key_points)
                ? safeFmt.key_points.map((p) => normalizeActionItemEntry(p)).filter(Boolean)
                : [],
            action_items: Array.isArray(safeFmt.action_items)
                ? safeFmt.action_items.map((p) => normalizeActionItemEntry(p)).filter(Boolean)
                : []
        };
        for (const k of ['medical_chief_complaint', 'medical_examination_transcript', 'medical_patient_recommendations']) {
            if (safeFmt[k] != null) rawFmt[k] = safeFmt[k];
        }
        window.currentFormattedDoc = normalizeFormattedFields(rawFmt);
        window._qsDocPreferSegmentsAfterEdit = false;
        console.log(
            '[export] GPT formatting computed for export (clean_transcript length=%s)',
            String(window.currentFormattedDoc.clean_transcript || '').length
        );
        if (medFmt && window.currentFormattedDoc) {
            try {
                const d = window.currentFormattedDoc;
                console.info('[export] medical summary fields (char counts)', {
                    medical_chief_complaint: String(d.medical_chief_complaint || '').length,
                    medical_examination_transcript: String(d.medical_examination_transcript || '').length,
                    medical_patient_recommendations: String(d.medical_patient_recommendations || '').length
                });
            } catch (_) {}
        }
        try {
            await qsPersistFormattedDocToS3();
        } catch (e) {
            console.warn('[export] persist formatted after API format:', e);
        }
        try {
            if (typeof effectiveIsMedicalForFormatting === 'function' && effectiveIsMedicalForFormatting()) {
                window.medicalActiveTab = 'summary';
                if (typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs();
                if (typeof renderTranscriptFromCues === 'function') renderTranscriptFromCues(window.currentSegments || []);
            } else if (hasStandardFormattedSummary()) {
                setFormatViewMode('summary');
                renderStandardSummaryView();
            }
        } catch (_) {}
        if (typeof showStatus === 'function') {
            showStatus(
                medFmt ? 'סיכום רפואי ותמלול מעוצב עודכנו.' : 'עיצוב התמלול הושלם.',
                false,
                { duration: 5000 }
            );
        }
        return true;
    } catch (e) {
        console.warn('[export] ensureFormattedViaApiForExport:', e);
        if (typeof showStatus === 'function') {
            showStatus('עיצוב/סיכום נכשל: ' + String((e && e.message) || e).slice(0, 160), true);
        }
        return false;
    }
}

/**
 * Re-run GPT transcript formatting + (for clinical jobs) the three-part medical summary.
 * Replaces `window.currentFormattedDoc` from the transcript (same as export formatting path).
 * Clinical paragraphs stay in the session target language (usually Hebrew)—not the colored UI hints.
 * Unsaved edits in the summary pane are not sent here; calling this after local edits will overwrite them.
 */
window.qsRegenerateMedicalSummaryFromTranscript = async function qsRegenerateMedicalSummaryFromTranscript() {
    return ensureFormattedViaApiForExport();
};

async function tryRecoverSegmentsForExport() {
    if (
        (!Array.isArray(window.currentSegments) || window.currentSegments.length === 0) &&
        Array.isArray(window.currentWords) &&
        Array.isArray(window.currentCaptions) &&
        window.currentWords.length > 0 &&
        window.currentCaptions.length > 0
    ) {
        try {
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        } catch (_) {}
    }
    if (Array.isArray(window.currentSegments) && window.currentSegments.length > 0) return true;
    const jobId = localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId');
    if (!jobId) return false;
    try {
        const res = await fetch(`/api/check_status/${encodeURIComponent(jobId)}`);
        if (!res.ok) return false;
        const data = await res.json();
        const recovered = extractSegmentsFromJobPayload(data);
        const recoveredFormatted = extractFormattedFromJobPayload(data);
        if (recovered.length > 0) {
            window.currentSegments = recovered;
            if (recoveredFormatted) window.currentFormattedDoc = recoveredFormatted;
            if (typeof window.render === 'function') window.render();
            return true;
        }
    } catch (e) {
        console.warn('[export recover] Failed to recover segments from check_status:', e);
    }
    if (
        (!Array.isArray(window.currentSegments) || window.currentSegments.length === 0) &&
        Array.isArray(window.currentWords) &&
        Array.isArray(window.currentCaptions) &&
        window.currentWords.length > 0 &&
        window.currentCaptions.length > 0
    ) {
        try {
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        } catch (_) {}
    }
    return Array.isArray(window.currentSegments) && window.currentSegments.length > 0;
}

async function _serverForceRtlDocx(blob, filename) {
    try {
        const fd = new FormData();
        fd.append('file', blob, filename || 'document.docx');
        const res = await fetch('/api/docx_force_rtl', {
            method: 'POST',
            body: fd
        });
        if (!res.ok) {
            console.warn('[docx] docx_force_rtl returned non-OK:', res.status);
            if (typeof showStatus === 'function') showStatus('שמירת DOCX ב-RTL נכשלה, מוריד גרסה רגילה.', true);
            return blob;
        }
        return await res.blob();
    } catch (e) {
        console.warn('[docx] server rtl post-process failed, keeping original docx:', e);
        return blob;
    }
}

async function _saveDocxWithRtl(blob, filename) {
    const fixedBlob = await _serverForceRtlDocx(blob, filename);
    await deliverBlobToUser(fixedBlob, filename);
}

function isMobileClient() {
    const ua = (navigator.userAgent || navigator.vendor || '').toLowerCase();
    if (/iphone|ipad|ipod|android|mobile/.test(ua)) return true;
    try {
        if (navigator.userAgentData && navigator.userAgentData.mobile === true) return true;
    } catch (_) {}
    // Fallback for Android Chrome profiles that sometimes report desktop UA.
    // Treat touch + coarse pointer + phone/tablet-sized short edge as mobile.
    try {
        const hasTouch = (navigator.maxTouchPoints || 0) > 1 || ('ontouchstart' in window);
        const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        const sw = Math.min(
            Number((window.screen && window.screen.width) || 0),
            Number((window.screen && window.screen.height) || 0)
        );
        if (hasTouch && coarse && sw > 0 && sw <= 1024) return true;
    } catch (_) {}
    return false;
}

function isAndroidClient() {
    const ua = (navigator.userAgent || navigator.vendor || '').toLowerCase();
    if (ua.includes('android')) return true;
    try {
        const p = navigator.userAgentData && Array.isArray(navigator.userAgentData.platform)
            ? navigator.userAgentData.platform.join(' ').toLowerCase()
            : String(navigator.userAgentData?.platform || '').toLowerCase();
        if (p.includes('android')) return true;
    } catch (_) {}
    return false;
}

window._qsMobileBatchShareMode = false;
window._qsMobileBatchFiles = [];

function _queueMobileBatchFile(blob, filename, mimeType) {
    window._qsMobileBatchFiles = Array.isArray(window._qsMobileBatchFiles) ? window._qsMobileBatchFiles : [];
    window._qsMobileBatchFiles.push({
        blob,
        filename: String(filename || 'download.bin'),
        mimeType: String(mimeType || blob?.type || 'application/octet-stream')
    });
}

async function _flushMobileBatchShare() {
    const items = Array.isArray(window._qsMobileBatchFiles) ? window._qsMobileBatchFiles : [];
    if (!items.length) return true;
    if (!isMobileClient() || !navigator.share || typeof File === 'undefined') return false;
    try {
        // Share one file at a time for better iOS compatibility with mixed types (e.g. mp4 + docx).
        for (const it of items) {
            const file = new File([it.blob], it.filename, { type: it.mimeType });
            const canShare = typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
            if (!canShare) return false;
            await navigator.share({ files: [file] });
        }
        return true;
    } catch (_) {
        return false;
    } finally {
        window._qsMobileBatchFiles = [];
    }
}

window._postExportFeedbackStars = 0;

function setPostExportFeedbackStars(n) {
    const v = Math.max(0, Math.min(5, Number(n) || 0));
    window._postExportFeedbackStars = v;
    try {
        document.querySelectorAll('.post-exp-star-btn').forEach((btn) => {
            const sn = parseInt(btn.getAttribute('data-post-exp-star'), 10);
            btn.style.color = v >= sn ? '#f59e0b' : '#d1d5db';
        });
    } catch (_) {}
}

function _qsFeedbackUserKey(user) {
    if (!user) return '';
    const email = String(user.email || (user.user_metadata && user.user_metadata.email) || '').trim().toLowerCase();
    return String(user.id || email || '').trim();
}

function _qsFeedbackSubmittedStorageKey(user) {
    const key = _qsFeedbackUserKey(user);
    return key ? `qs_pefb_submitted_${key}` : '';
}

function hasUserSubmittedPostExportFeedback(user) {
    if (!user) return false;
    const meta = user.user_metadata || {};
    if (meta.qs_post_export_feedback_submitted_at || meta.qs_feedback_submitted_at) return true;
    const storageKey = _qsFeedbackSubmittedStorageKey(user);
    if (!storageKey) return false;
    try { return String(localStorage.getItem(storageKey) || '') === '1'; } catch (_) { return false; }
}

async function markUserSubmittedPostExportFeedback(user) {
    if (!user) return;
    const storageKey = _qsFeedbackSubmittedStorageKey(user);
    try { if (storageKey) localStorage.setItem(storageKey, '1'); } catch (_) {}
    try {
        if (supabase && supabase.auth && typeof supabase.auth.updateUser === 'function') {
            await supabase.auth.updateUser({
                data: { qs_post_export_feedback_submitted_at: new Date().toISOString() }
            });
        }
    } catch (_) {}
}

/**
 * After a file is delivered to the user, optionally show feedback for signed-in users.
 * A real submitted response suppresses future prompts for that account.
 */
function maybeQueuePostExportFeedbackPrompt(safeFilename, kind) {
    const name = String(safeFilename || '').toLowerCase();
    if (!name || name === 'download.bin') return;
    if (!/\.(srt|vtt|txt|docx?|mp4|mov|webm|m4a|mp3|zip)$/i.test(name)) {
        if (!/transcript|summary|subtitle|סיכום|תמלול/i.test(name)) return;
    }
    if (String(sessionStorage.getItem('qs_pefb_shown') || '') === '1') return;
    try {
        const am = document.getElementById('auth-modal');
        if (am) {
            const d = am.style.display || '';
            if (d === 'flex' || (window.getComputedStyle && window.getComputedStyle(am).display === 'flex')) return;
        }
    } catch (_) {}
    setTimeout(() => {
        try { void maybeShowPostExportFeedbackModal(kind || 'export'); } catch (_) {}
    }, 500);
}

/** @param {'export'|'medical_copy'|'medical_download'} kind */
async function maybeShowPostExportFeedbackModal(kind) {
    if (String(sessionStorage.getItem('qs_pefb_shown') || '') === '1') return;
    const hp = document.getElementById('post-exp-fb-website');
    if (hp && String(hp.value || '').trim()) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    if (hasUserSubmittedPostExportFeedback(user)) return;
    const m = document.getElementById('post-export-feedback-modal');
    if (!m) return;
    if (m.style.display === 'flex') return;
    try { sessionStorage.setItem('qs_pefb_shown', '1'); } catch (_) {}
    try {
        window._qsFeedbackModalSource = kind === 'medical_copy'
            ? 'medical_copy'
            : (kind === 'medical_download' ? 'medical_download' : 'post_export');
    } catch (_) {}
    m.style.display = 'flex';
    m.setAttribute('aria-hidden', 'false');
    const pl = document.getElementById('post-exp-fb-like');
    const pi = document.getElementById('post-exp-fb-improve');
    if (pl) pl.value = '';
    if (pi) pi.value = '';
    if (hp) hp.value = '';
    setPostExportFeedbackStars(0);
    try { if (typeof window.applyTranslations === 'function') window.applyTranslations(); } catch (_) {}
}

function closePostExportFeedbackModal() {
    const m = document.getElementById('post-export-feedback-modal');
    if (m) {
        m.style.display = 'none';
        m.setAttribute('aria-hidden', 'true');
    }
}

async function deliverBlobToUser(blob, filename, mimeType) {
    const safeName = String(filename || 'download.bin');
    const fileType = String(mimeType || blob?.type || 'application/octet-stream');
    const feedbackKind = (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) ? 'medical_download' : 'export';
    if (isMobileClient() && window._qsMobileBatchShareMode) {
        _queueMobileBatchFile(blob, safeName, fileType);
        try { maybeQueuePostExportFeedbackPrompt(safeName, feedbackKind); } catch (_) {}
        return true;
    }
    if (isMobileClient() && navigator.share && typeof File !== 'undefined') {
        try {
            const file = new File([blob], safeName, { type: fileType });
            const canShare = typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
            if (canShare) {
                await navigator.share({ files: [file] });
                try { maybeQueuePostExportFeedbackPrompt(safeName, feedbackKind); } catch (_) {}
                return true;
            }
        } catch (_) {}
    }
    if (isMobileClient()) {
        // On mobile require system share/save chooser; avoid forced open/download fallbacks.
        return false;
    }
    if (typeof saveAs !== 'undefined') {
        saveAs(blob, safeName);
        try { maybeQueuePostExportFeedbackPrompt(safeName, feedbackKind); } catch (_) {}
        return true;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.click();
    URL.revokeObjectURL(url);
    try { maybeQueuePostExportFeedbackPrompt(safeName, feedbackKind); } catch (_) {}
    return true;
}

async function tryShareUrlOnMobile(url, title) {
    if (!isMobileClient() || !navigator.share || !url) return false;
    try {
        await navigator.share({ url: String(url) });
        return true;
    } catch (_) {
        return false;
    }
}

async function tryShareMovieBlobOnMobile(outputUrl, filename, mimeType) {
    if (!isMobileClient() || !navigator.share || typeof File === 'undefined' || !outputUrl) return false;
    try {
        const res = await fetch(outputUrl);
        if (!res.ok) return false;
        const blob = await res.blob();
        const safeName = String(filename || 'movie.mp4');
        // Share as a generic file to encourage "Save to Files" instead of "Save Video" (Photos).
        const type = 'application/octet-stream';
        const file = new File([blob], safeName, { type });
        const canShare = typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
        if (!canShare) return false;
        await navigator.share({ files: [file] });
        return true;
    } catch (_) {
        return false;
    }
}

async function downloadBlobAsFileOnly(blob, filename) {
    try {
        const safeName = String(filename || 'movie.mp4');
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u;
        a.download = safeName;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(u); } catch (_) {} }, 10000);
        return true;
    } catch (_) {
        return false;
    }
}

/** Base filename without extension for DOCX/TXT/SRT exports when upload name was not captured. */
function getExportBaseNameNoExt() {
    const stripJobPrefix = (s) =>
        String(s || '')
            .trim()
            .replace(/^job_\d+_/, '')
            .trim();
    const sanitize = (s) =>
        stripJobPrefix(String(s || '').trim())
            .replace(/[\\/:*?"<>|]+/g, '_')
            .replace(/\s+/g, ' ')
            .trim();

    const rawOrig = String(window.originalFileName || '').trim();
    if (rawOrig && rawOrig.toLowerCase() !== 'transcript') {
        const orig = sanitize(rawOrig);
        if (orig) return orig;
    }

    const key = (localStorage.getItem('lastS3Key') || localStorage.getItem('pendingS3Key') || '').trim();
    if (key) {
        let leaf = '';
        try {
            leaf = decodeURIComponent(key.split('/').pop() || '');
        } catch (_) {
            leaf = key.split('/').pop() || '';
        }
        const fromKey = sanitize(String(leaf).replace(/\.[^.]+$/, ''));
        if (fromKey) return fromKey;
    }

    const jid = (localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || '').trim();
    const m = jid.match(/^job_\d+_(.+)$/);
    if (m && m[1]) {
        try {
            const t = sanitize(decodeURIComponent(m[1]).replace(/\.[^.]+$/, ''));
            if (t) return t;
        } catch (_) {
            const t2 = sanitize(String(m[1]).replace(/\.[^.]+$/, ''));
            if (t2) return t2;
        }
    }

    return 'transcript';
}

window.downloadFile = async function(type, bypassUser = null, options = {}) {
    const baseName = getExportBaseNameNoExt() || 'transcript';
    await commitActiveWordTokenEditIfAny();

    if (!bypassUser && typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
        if (typeof requireUserForCopyOrDownload === 'function') {
            const ok = await requireUserForCopyOrDownload();
            if (!ok) return;
        }
    }

    if (type === 'movie') {
        const movieStageT0 = Date.now();
        let movieExportSucceeded = false;
        let movieBurnCompleted = false;
        const forceSubtitleFormatForMovie = true;
        const toMovieSubtitleText = (text) => {
            const src = String(text || '').trim();
            if (!src) return '';
            if (!forceSubtitleFormatForMovie) return src;
            const wrapped = (typeof wrapTextByMaxChars === 'function')
                ? wrapTextByMaxChars(src, 50)
                : src;
            return String(wrapped || src).replace(/<br\s*\/?>/gi, '\n');
        };
        const buildMovieSubtitleSegments = () => {
            if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length && window.currentCaptions.length) {
                const out = [];
                for (let ci = 0; ci < window.currentCaptions.length; ci++) {
                    const c = window.currentCaptions[ci];
                    const ws = window.currentWords[c.wordStartIndex];
                    const we = window.currentWords[c.wordEndIndex];
                    if (!ws || !we) continue;
                    const segWords = [];
                    const textParts = [];
                    for (let wi = c.wordStartIndex; wi <= c.wordEndIndex; wi++) {
                        const w = window.currentWords[wi];
                        if (!w) continue;
                        const wt = String(w.text || '').trim();
                        if (!wt) continue;
                        textParts.push(wt);
                        segWords.push({
                            text: wt,
                            start: Number(w.start),
                            end: Number(w.end),
                            highlighted: !!w.highlighted
                        });
                    }
                    const resolved = (typeof window.getResolvedCaptionStyle === 'function')
                        ? window.getResolvedCaptionStyle(ci)
                        : { position: 'bottom', highlightMode: 'none' };
                    const capStyle = (c.style && typeof c.style === 'object') ? { ...c.style } : {};
                    out.push({
                        start: Number(ws.start),
                        end: Number(we.end) || (Number(ws.start) + 1),
                        text: toMovieSubtitleText(textParts.join(' ')),
                        // Match preview VTT: include global subtitle position (top/middle/bottom) when caption has no override.
                        style: { ...capStyle, position: resolved.position, highlightMode: resolved.highlightMode || 'none' },
                        words: segWords
                    });
                }
                if (out.length) return out;
            }
            return (window.currentSegments || []).map((s, si) => {
                const resolved = (typeof window.getResolvedCaptionStyle === 'function')
                    ? window.getResolvedCaptionStyle(si)
                    : { position: 'bottom', highlightMode: 'none' };
                return {
                    start: s.start,
                    end: s.end || s.start + 1,
                    text: toMovieSubtitleText(s.text || ''),
                    style: { position: resolved.position, highlightMode: resolved.highlightMode || 'none' }
                };
            });
        };
        const _movieTs = () => new Date().toISOString();
        const _movieElapsed = () => ((Date.now() - movieStageT0) / 1000).toFixed(2) + 's';
        const logMovieStage = (stage, extra) => {
            if (typeof extra !== 'undefined') {
                console.log(`[movie export][${_movieTs()}][+${_movieElapsed()}] ${stage}`, extra);
            } else {
                console.log(`[movie export][${_movieTs()}][+${_movieElapsed()}] ${stage}`);
            }
        };
        logMovieStage('Start');
        if (typeof showStatus === 'function') {
            showStatus('מתחילים ליצור את הסרטון... זה עשוי לקחת כמה דקות.', false, { duration: 900000 });
        }
        const { data: { user: movieUser } } = await supabase.auth.getUser();
        if (!movieUser) {
            logMovieStage('No user – show sign-in');
            if (typeof showStatus === 'function') showStatus("Please sign in to download the movie.", true);
            isSignUpMode = true;
            applyAuthModalMode();
            window.pendingExportType = 'movie';
            localStorage.setItem('pendingExportType', 'movie');
            localStorage.setItem('pendingS3Key', localStorage.getItem('lastS3Key') || '');
            localStorage.setItem('pendingJobId', localStorage.getItem('lastJobId') || '');
            if (typeof window.toggleModal === 'function') window.toggleModal(true);
            return;
        }
        logMovieStage('User OK', { userId: movieUser.id });
        if (!window.currentSegments.length) {
            logMovieStage('Segments missing – trying recovery');
            await tryRecoverSegmentsForExport();
            logMovieStage('Segment recovery finished', { segments: (window.currentSegments || []).length });
        }
        if (!window.currentSegments.length) {
            if (typeof showStatus === 'function') showStatus("No transcript available to export.", true);
            return;
        }
        try {
            fetch('/api/runpod_scale', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ min: 1 }) }).catch(() => {});
        } catch (_) { /* ignore */ }
        const video = document.getElementById('main-video');
        const videoUrl = video ? (video.currentSrc || video.src || (video.querySelector('source') && video.querySelector('source').src) || '') : '';
        if (!video || !videoUrl || videoUrl.startsWith('data:')) {
            console.log('[movie export] No video/URL');
            if (typeof showStatus === 'function') showStatus("Load a video first, then use Styled Subtitles before downloading the movie.", true);
            return;
        }

        const durationSec = (video.duration && Number.isFinite(video.duration)) ? video.duration : 0;
        const widthPx = (video.videoWidth && video.videoWidth > 0) ? video.videoWidth : 0;
        const heightPx = (video.videoHeight && video.videoHeight > 0) ? video.videoHeight : 0;
        const isPortrait = heightPx > 0 && widthPx > 0 && heightPx > widthPx;
        logMovieStage('Video OK', { durationSec, widthPx, heightPx, isPortrait });
        const inputS3Key = localStorage.getItem('lastS3Key');
        if (!inputS3Key || !inputS3Key.startsWith('users/')) {
            logMovieStage('No/invalid lastS3Key', inputS3Key ? inputS3Key.substring(0, 30) + '…' : 'null');
            if (typeof showStatus === 'function') {
                const baseErr = movieT('movie_burn_failed', 'יצירת סרטון נכשלה');
                showStatus(baseErr, true);
                showStatus("Video must be from your uploads (save and use Styled Subtitles from an uploaded video).", true);
            }
            return;
        }
        logMovieStage('S3 key OK');

        const mainBtn = document.getElementById('main-btn');
        const creatingMovieText = (typeof window.t === 'function' ? (window.t('creating_movie') || 'Creating movie...') : 'Creating movie...');
        const movieT = (key, fallback) => {
            if (typeof window.t !== 'function') return fallback;
            const val = window.t(key);
            return (!val || val === key) ? fallback : val;
        };
        if (mainBtn) {
            mainBtn.disabled = true;
            mainBtn.innerText = creatingMovieText;
        }

        try {
            if (typeof ensureJobRecordOnExport === 'function') {
                const tJob = Date.now();
                logMovieStage('Ensuring job record');
                await ensureJobRecordOnExport();
                logMovieStage('Job record done', { tookMs: Date.now() - tJob });
            }
            logMovieStage('Fetching simulation_mode');
            let isSimulation = false;
            try {
                const tSim = Date.now();
                const simRes = await fetch('/api/simulation_mode', { cache: 'no-store' });
                const simJson = simRes.ok ? await simRes.json() : {};
                isSimulation = simJson.simulation === true;
                logMovieStage('simulation_mode fetched', { simulation: isSimulation, tookMs: Date.now() - tSim });
            } catch (e) {
                // Network/proxy hiccup on this check should not block production export.
                isSimulation = false;
                console.warn(`[movie export][${_movieTs()}][+${_movieElapsed()}] simulation_mode check failed; assuming production mode:`, e);
            }
            const useLegacySimulationBurn = false;
            if (isSimulation === true && !useLegacySimulationBurn) {
                logMovieStage('Simulation mode detected – using worker/server async pipeline (legacy direct burn disabled)');
            }
            if (isSimulation === true && useLegacySimulationBurn) {
                logMovieStage('Simulation branch – direct burn_subtitles route');
                const segments = buildMovieSubtitleSegments();
                const normSegs = typeof normalizeSegmentDurations === 'function' ? normalizeSegmentDurations(segments, 0.5) : segments;
                const tBlob = Date.now();
                logMovieStage('Fetching video blob for simulation burn');
                const videoBlob = await fetch(videoUrl).then(r => r.blob());
                logMovieStage('Video blob fetched', { tookMs: Date.now() - tBlob, sizeBytes: videoBlob.size });
                const ext = (videoUrl.match(/\.(mp4|mov|webm|m4v|mkv|avi)(\?|$)/i) || [])[1] || 'mp4';
                const filename = (baseName || 'video') + '.' + ext.toLowerCase();
                const form = new FormData();
                form.append('video', videoBlob, filename);
                form.append('segments', JSON.stringify(normSegs.map((s, si) => {
                    const row = { start: s.start, end: s.end || s.start + 1, text: s.text || '' };
                    const fromSeg = (s.style && typeof s.style === 'object') ? { ...s.style } : {};
                    const r = (typeof window.getResolvedCaptionStyle === 'function') ? window.getResolvedCaptionStyle(si) : { position: 'bottom', highlightMode: 'none' };
                    row.style = { ...fromSeg, position: fromSeg.position != null ? fromSeg.position : r.position, highlightMode: fromSeg.highlightMode || r.highlightMode || 'none' };
                    return row;
                })));
                form.append('filename', filename);
                form.append('subtitle_color', _qsSubtitleColorForExport());
                form.append('subtitle_style', _qsSubtitleStyleForExport());
                if (isPortrait) form.append('is_portrait', '1');
                try {
                    const tBurnReq = Date.now();
                    logMovieStage('POST /api/burn_subtitles start', { segments: normSegs.length, filename });
                    const burnRes = await fetch('/api/burn_subtitles', { method: 'POST', body: form });
                    logMovieStage('POST /api/burn_subtitles done', { status: burnRes.status, tookMs: Date.now() - tBurnReq });
                    if (burnRes.ok) {
                        const tOutBlob = Date.now();
                        const outBlob = await burnRes.blob();
                        logMovieStage('Burned movie blob received', { tookMs: Date.now() - tOutBlob, sizeBytes: outBlob.size });
                        const outName = (burnRes.headers.get('Content-Disposition') || '').match(/filename="?([^";]+)"?/);
                        const downloadName = outName ? outName[1] : 'video_with_subtitles.' + ext;
                        await deliverBlobToUser(outBlob, downloadName);
                    } else {
                        const err = await burnRes.json().catch(() => ({}));
                        throw new Error(err.error || burnRes.statusText);
                    }
                } catch (e) {
                    console.warn(`[movie export][${_movieTs()}][+${_movieElapsed()}] Burn failed, falling back to video+SRT:`, e);
                    await deliverBlobToUser(videoBlob, filename);
                    const srt = typeof srtFromCues === 'function' ? srtFromCues(normSegs) : '';
                    if (srt) await deliverBlobToUser(new Blob([srt], { type: 'text/plain;charset=utf-8' }), (baseName || 'video') + '.srt', 'text/plain;charset=utf-8');
                    let errMsg = movieT('movie_burn_failed', 'יצירת סרטון נכשלה') + '. ';
                    if (e && e.message) errMsg += e.message + '. ';
                    errMsg += movieT('download_fallback_hint', 'הווידאו וקובץ SRT הורדו במקום צריבה. ודא/י ש־ffmpeg זמין בשרת.');
                    if (typeof showStatus === 'function') showStatus(errMsg, true);
                }
                if (mainBtn) { mainBtn.disabled = false; mainBtn.innerText = (typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload'); }
                logMovieStage('Simulation movie export finished');
                return;
            }

            const encodingMsg = '';
            const pContainer = document.getElementById('p-container');
            const progressBar = document.getElementById('progress-bar-legacy');
            const statusTxt = document.getElementById('upload-status');
            let burnProgressTimer = null;
            const startBurnProgress = () => {
                let pct = 8;
                if (mainBtn) mainBtn.innerText = creatingMovieText + ' ' + pct + '%';
                if (progressBar) progressBar.style.width = pct + '%';
                if (statusTxt) {
                    statusTxt.innerText = '';
                    statusTxt.style.display = 'none';
                }
                setBurnProgress(pct, encodingMsg);
                burnProgressTimer = setInterval(() => {
                    pct = Math.min(95, pct + Math.max(1, Math.round((95 - pct) * 0.1)));
                    if (mainBtn) mainBtn.innerText = creatingMovieText + ' ' + pct + '%';
                    if (progressBar) progressBar.style.width = pct + '%';
                    setBurnProgress(pct, encodingMsg);
                }, 1000);
            };
            const stopBurnProgress = (completed) => {
                if (burnProgressTimer) {
                    clearInterval(burnProgressTimer);
                    burnProgressTimer = null;
                }
                if (progressBar) progressBar.style.width = completed ? '100%' : '0%';
                if (mainBtn) mainBtn.innerText = completed ? creatingMovieText + ' 100%' : creatingMovieText;
                if (statusTxt) {
                    statusTxt.innerText = '';
                    statusTxt.style.display = 'none';
                }
                if (completed) {
                    setBurnProgress(100, typeof window.t === 'function' ? window.t('movie_downloaded') : 'Movie downloaded');
                }
                setTimeout(() => {
                    hideProgressBar();
                    hideBurnProgress();
                }, completed ? 1200 : 0);
                if (!completed) hideBurnProgress();
            };
            startBurnProgress();
            logMovieStage('Preparing segments for burn request');
            const rawSegments = buildMovieSubtitleSegments();
            const segments = typeof normalizeSegmentDurations === 'function' ? normalizeSegmentDurations(rawSegments, 0.5) : rawSegments;
            const subtitleStyle = (typeof window.currentSubtitleStyle === 'string' && window.currentSubtitleStyle) ? window.currentSubtitleStyle : 'tiktok';
            const hasCustomFormatting = Array.isArray(window.currentCaptions) && window.currentCaptions.some((c) => {
                const st = c && c.style && typeof c.style === 'object' ? c.style : null;
                if (st && st.position) return true;
                return false;
            });
            const hasWordHighlights = Array.isArray(window.currentWords) && window.currentWords.some((w) => !!(w && w.highlighted));
            const forceLocalBurn = false; // Always prefer worker burn when available.
            logMovieStage('Segments prepared', {
                rawSegments: rawSegments.length,
                finalSegments: segments.length,
                subtitleStyle,
                hasCustomFormatting,
                hasWordHighlights,
                forceLocalBurn
            });
            const tBurnStart = Date.now();
            logMovieStage('POST /api/burn_subtitles_server start');
            const burnRes = await fetch('/api/burn_subtitles_server', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input_s3_key: inputS3Key,
                    segments,
                    duration_seconds: durationSec || undefined,
                    width_px: widthPx || undefined,
                    userId: movieUser.id,
                    subtitle_style: subtitleStyle,
                    subtitle_color: _qsSubtitleColorForExport(),
                    export_format_mode: 'subtitle',
                    is_portrait: isPortrait,
                    notify_email: movieUser.email || undefined,
                    job_id: localStorage.getItem('lastJobId') || undefined,
                    force_local_burn: forceLocalBurn
                })
            });
            const burnData = burnRes.ok ? await burnRes.json() : {};
            logMovieStage('POST /api/burn_subtitles_server done', {
                status: burnRes.status,
                tookMs: Date.now() - tBurnStart,
                mode: burnData && burnData.mode ? burnData.mode : 'unknown'
            });
            if (!burnRes.ok) {
                const err = burnData.error || burnRes.statusText;
                throw new Error(err);
            }
            const taskId = burnData.task_id;
            if (!taskId) throw new Error("No task_id");
            logMovieStage('Task accepted', { taskId });

            const pollInterval = 2500;
            const maxWait = 600000;
            const start = Date.now();
            let statusJson = { status: 'processing' };
            let pollCount = 0;
            const tPollStart = Date.now();
            logMovieStage('Polling burn status started', { pollIntervalMs: pollInterval, maxWaitMs: maxWait });
            while (statusJson.status === 'processing' && (Date.now() - start) < maxWait) {
                await new Promise(r => setTimeout(r, pollInterval));
                pollCount++;
                if (pollCount === 1 || pollCount % 10 === 0) {
                    logMovieStage('Polling burn status', { pollCount });
                }
                const statusRes = await fetch(`/api/burn_subtitles_status?task_id=${encodeURIComponent(taskId)}`);
                statusJson = statusRes.ok ? await statusRes.json() : {};
            }
            logMovieStage('Polling burn status ended', {
                finalStatus: statusJson && statusJson.status ? statusJson.status : 'unknown',
                polls: pollCount,
                tookMs: Date.now() - tPollStart
            });
            if (statusJson.status === 'failed') {
                stopBurnProgress(false);
                logMovieStage('Burn failed', { error: statusJson.error || 'Burn failed' });
                throw new Error(statusJson.error || "Burn failed");
            }
            if (statusJson.status === 'completed' && statusJson.output_url) {
                stopBurnProgress(true);
                movieBurnCompleted = true;
                logMovieStage('Burn completed – downloading output');
                const outName = (baseName || 'video') + '.mp4';
                const tOutDownload = Date.now();
                const blob = await fetch(statusJson.output_url).then(r => r.blob());
                logMovieStage('Output downloaded', { tookMs: Date.now() - tOutDownload, sizeBytes: blob.size, outName });
                if (isMobileClient()) {
                    _hideToastNow();
                    const saveNow = await showGlobalConfirm(
                        'הסרטון מוכן.\nלשמור עכשיו?',
                        { confirmText: 'שמור', cancelText: 'אחר כך' }
                    );
                    if (!saveNow) {
                        movieExportSucceeded = true;
                        if (typeof showStatus === 'function') {
                            showStatus('הסרטון מוכן. אפשר לשמור אותו בהמשך מתפריט הייצוא.', false, { duration: 4000 });
                        }
                        return;
                    }
                }
                const delivered = await deliverBlobToUser(blob, outName);
                if (!delivered) throw new Error('Could not open save/share dialog on this device');
                movieExportSucceeded = true;
                if (typeof showStatus === 'function') {
                    const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
                    showStatus(isHebrewUi ? 'הסרטון נשמר בהצלחה.' : 'Movie successfully saved.', false, { duration: 5000 });
                }
            } else {
                stopBurnProgress(false);
                logMovieStage('Timeout or no output_url', statusJson);
                throw new Error("Burn did not complete in time");
            }
        } catch (e) {
            console.error(`[movie export][${_movieTs()}][+${_movieElapsed()}] Error:`, e);
            if (typeof showStatus === 'function') {
                const errMsg = String((e && e.message) || '');
                const isDeliveryIssue = movieBurnCompleted || /save\/share dialog|save|share|delivery/i.test(errMsg);
                if (isDeliveryIssue) {
                    showStatus('הסרטון נוצר, אבל פתיחת חלון השמירה נכשלה. נסה/י שוב לשמור.', true);
                } else {
                    const baseErr = movieT('movie_burn_failed', 'יצירת סרטון נכשלה');
                    const hint = typeof window.t === 'function'
                        ? ""
                        : " Please try again later.";
                    showStatus(baseErr + hint, true);
                }
            }
        } finally {
            if (!movieExportSucceeded) _hideToastNow();
            if (mainBtn) {
                mainBtn.disabled = false;
                mainBtn.innerText = (typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload');
            }
            logMovieStage('Movie export finished');
        }
        return;
    }

    const { data: { user: activeUser } } = bypassUser ? { data: { user: bypassUser } } : await supabase.auth.getUser();
    if (!activeUser) {
        console.log("💾 Parking export type:", type);
        isSignUpMode = true;
        applyAuthModalMode();
        window.pendingExportType = type;
        localStorage.setItem('pendingExportType', type);
        localStorage.setItem('pendingS3Key', localStorage.getItem('lastS3Key') || '');
        localStorage.setItem('pendingJobId', localStorage.getItem('lastJobId') || '');

        window.toggleModal(true); // Open the sign-in modal
        return; // <--- CRITICAL: This stops the function here so the file doesn't download
    }
    if (
        (!Array.isArray(window.currentSegments) || window.currentSegments.length === 0) &&
        Array.isArray(window.currentWords) &&
        Array.isArray(window.currentCaptions) &&
        window.currentWords.length > 0 &&
        window.currentCaptions.length > 0
    ) {
        try {
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        } catch (_) {}
    }
    if (!window.currentSegments.length) {
        await tryRecoverSegmentsForExport();
    }
    if (!window.currentSegments.length) {
        if (typeof showStatus === 'function') showStatus("No transcript available to export.", true);
        return;
    }
    try {
        fetch('/api/runpod_scale', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ min: 1 }) }).catch(() => {});
    } catch (_) { /* ignore */ }
    const showTime = isTimeToggleVisible();
    const showSpeaker = document.getElementById('toggle-speaker')?.checked;

    // Update job to exported, or create job if user signed in after upload
    try {
        if (typeof ensureJobRecordOnExport === 'function') {
            await ensureJobRecordOnExport();
        }
    } catch (err) {
        console.error("Failed to update job status:", err);
    }

    if (typeof saveAs === 'undefined') {
        if (typeof showStatus === 'function') showStatus("Error: FileSaver library not loaded.", true);
        return;
    }

    if (type === 'docx' || type === 'txt') {
        await hydrateFormattedFromSavedTranscript();
        const docBase = (String(baseName || '').trim() || 'transcript').replace(/[\\/:*?"<>|]+/g, '_');
        const requestedKinds = Array.isArray(options && options.docxKinds)
            ? options.docxKinds.map((k) => String(k || '').toLowerCase()).filter((k) => k === 'transcript' || k === 'summary')
            : [];
        const docxKind = (options && options.docxKind) ? String(options.docxKind) : 'transcript';
        const effectiveKinds = requestedKinds.length ? requestedKinds : [docxKind];
        const wantTranscript = effectiveKinds.includes('transcript');
        const wantSummary    = effectiveKinds.includes('summary');
        const fmtDoc = window.currentFormattedDoc;
        const hasClean = !!(fmtDoc && String(fmtDoc.clean_transcript || '').trim());
        const hasSummaryBits = !!(
            fmtDoc &&
            (String(fmtDoc.overview || '').trim() ||
                (Array.isArray(fmtDoc.key_points) && fmtDoc.key_points.length) ||
                (Array.isArray(fmtDoc.action_items) && fmtDoc.action_items.length) ||
                String(fmtDoc.medical_chief_complaint || '').trim() ||
                String(fmtDoc.medical_examination_transcript || '').trim() ||
                String(fmtDoc.medical_patient_recommendations || '').trim())
        );
        if ((wantTranscript && !hasClean) || (wantSummary && !hasSummaryBits)) {
            await ensureFormattedViaApiForExport();
        }
        // Caption cues are reflowed (~54 chars per line); do not use newline-joined segments as export body.
        const segmentFlowFallback = (window.currentSegments || [])
            .map(s => String((s && s.text) || '').trim())
            .filter(Boolean)
            .join(' ');

        const _buildExportPayload = () => {
            const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
                ? window.currentFormattedDoc
                : null;
            // Source of truth for transcript export is edited segments/captions.
            const fromSegments = String(buildTranscriptPlainBodyForExport() || '').trim();
            const fromFmt = String((fmt && fmt.clean_transcript) || '').trim();
            const clean = ((!window._qsDocPreferSegmentsAfterEdit && fromFmt) ? fromFmt : (fromSegments || fromFmt || segmentFlowFallback)).trim();
            const overview = String((fmt && fmt.overview) || '').trim();
            const keyPoints = Array.isArray(fmt && fmt.key_points)
                ? fmt.key_points.map((p) => String(p || '').trim()).filter(Boolean)
                : [];
            const actionItems = Array.isArray(fmt && fmt.action_items)
                ? fmt.action_items.map((p) => normalizeActionItemEntry(p)).filter(Boolean)
                : [];
            const mc = String((fmt && fmt.medical_chief_complaint) || '').trim();
            const me = String((fmt && fmt.medical_examination_transcript) || '').trim();
            const mr = String((fmt && fmt.medical_patient_recommendations) || '').trim();
            return { clean, overview, keyPoints, actionItems, mc, me, mr };
        };
        const _buildKindText = (kind, payload) => {
            if (kind === 'summary') {
                if (payload.mc || payload.me || payload.mr) {
                    const lines = [];
                    lines.push('תלונה:');
                    lines.push(payload.mc || 'לא צוין.');
                    lines.push('');
                    lines.push('ממצאים:');
                    lines.push(payload.me || 'לא צוין.');
                    lines.push('');
                    lines.push('המלצות למטופל:');
                    lines.push(payload.mr || 'לא צוין.');
                    return lines.join('\n').trim();
                }
                const lines = [];
                lines.push('סקירה:');
                lines.push(payload.overview || 'N/A');
                lines.push('');
                lines.push('נקודות מפתח:');
                (payload.keyPoints.length ? payload.keyPoints : ['לא הוחזרו נקודות מפתח.']).forEach((p) => lines.push(p));
                lines.push('');
                lines.push('פריטי פעולה:');
                (payload.actionItems.length ? payload.actionItems : ['לא הוחזרו פריטי פעולה.']).forEach((p) => lines.push(p));
                return lines.join('\n').trim();
            }
            return payload.clean;
        };
        const _downloadTxt = async (text, name) => {
            const toRtlTxt = (src) => {
                const s = String(src || '');
                // Plain TXT has no direction metadata; inject RLM so Hebrew content opens RTL.
                if (!/[\u0590-\u05FF]/.test(s)) return s;
                const rlm = '\u200F';
                return s
                    .split('\n')
                    .map((line) => (line.trim() ? (rlm + line) : line))
                    .join('\n');
            };
            const txtBlob = new Blob([toRtlTxt(text)], { type: 'text/plain;charset=utf-8' });
            const delivered = await deliverBlobToUser(txtBlob, name, 'text/plain;charset=utf-8');
            if (!delivered) {
                const fallbackOk = await downloadBlobAsFileOnly(txtBlob, name);
                if (!fallbackOk) {
                    throw new Error('Unable to download TXT on this device. Please allow file sharing/download prompts.');
                }
                try {
                    maybeQueuePostExportFeedbackPrompt(
                        name,
                        (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) ? 'medical_download' : 'export'
                    );
                } catch (_) {}
            }
        };

        const _exportKindDocx = async (kind, dlName) => {
            if (typeof showStatus === 'function') showStatus(
                kind === 'summary' ? 'מייצר סיכום…' : 'מייצר תמלול…', false, { duration: 10000 }
            );
            const payload = _buildExportPayload();
            const textForServer = String(payload.clean || segmentFlowFallback || '').trim();
            const baseFmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
                ? window.currentFormattedDoc
                : {};
            const formattedForServer = {
                clean_transcript: kind === 'transcript'
                    ? textForServer
                    : String(baseFmt.clean_transcript || ''),
                overview: String(baseFmt.overview || ''),
                key_points: Array.isArray(baseFmt.key_points) ? baseFmt.key_points : [],
                action_items: Array.isArray(baseFmt.action_items) ? baseFmt.action_items : []
            };
            for (const k of ['medical_chief_complaint', 'medical_examination_transcript', 'medical_patient_recommendations']) {
                if (baseFmt[k] != null) formattedForServer[k] = String(baseFmt[k] || '');
            }
            const t0 = performance.now();
            const res = await fetch('/api/export_docx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    text: textForServer,
                    segments: window.currentSegments || [],
                    formatted: formattedForServer,
                    allow_gpt_fallback: false,
                    filename: docBase,
                    isMedical: typeof isMedicalModeEnabled === 'function' ? isMedicalModeEnabled() : false
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || res.statusText || 'export failed');
            }
            const src = res.headers.get('X-Docx-Format-Source') || 'unknown';
            console.log(`[docx] export source=${src} kind=${kind} took=${Math.round(performance.now() - t0)}ms`);
            if (src === 'raw_no_gpt') {
                console.warn(
                    '[docx] raw_no_gpt: POST body had no usable `formatted` dict (or empty clean_transcript). ' +
                        'Check [word-edit] open-in-app / [export] hydrate logs; S3 JSON may lack formatted after an old save.'
                );
            }
            const blob = await res.blob();
            const delivered = await deliverBlobToUser(blob, dlName);
            if (!delivered) {
                const fallbackOk = await downloadBlobAsFileOnly(blob, dlName);
                if (!fallbackOk) {
                    throw new Error(`Unable to download ${kind} DOCX on this device. Please allow file sharing/download prompts.`);
                }
                try {
                    maybeQueuePostExportFeedbackPrompt(
                        dlName,
                        (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) ? 'medical_download' : 'export'
                    );
                } catch (_) {}
            }
        };
        const _exportKindTxt = async (kind) => {
            const payload = _buildExportPayload();
            let outText = _buildKindText(kind, payload);
            if (kind === 'transcript' && outText && String(outText).trim()) {
                try {
                    const wres = await fetch('/api/wrap_transcript_text', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: outText })
                    });
                    const wjson = await wres.json().catch(() => ({}));
                    if (wres.ok && wjson.text) outText = wjson.text;
                } catch (e) {
                    console.warn('[txt] wrap_transcript_text failed, using raw clean_transcript:', e);
                }
            }
            const dlName = kind === 'summary' ? `${docBase}_summary.txt` : `${docBase}.txt`;
            await _downloadTxt(outText, dlName);
        };

        const _confirmNextDocExportOnMobile = async (nextKind, fileType) => {
            if (!isMobileClient()) return true;
            const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
            const label = (() => {
                if (String(nextKind || '').toLowerCase() === 'summary') {
                    return isHebrewUi ? 'סיכום' : 'summary';
                }
                return isHebrewUi ? 'תמלול' : 'transcript';
            })();
            const ext = String(fileType || type || '').toLowerCase() === 'txt' ? 'txt' : 'docx';
            return await showGlobalConfirm(
                isHebrewUi
                    ? `האם לשמור את קובץ ה-${label} (${ext})?`
                    : `Save the ${label} file (${ext})?`,
                {
                    confirmText: isHebrewUi ? 'שמור' : 'Save',
                    cancelText: isHebrewUi ? 'עצור' : 'Stop'
                }
            );
        };
        try {
            if (type === 'docx') {
                if (wantTranscript) await _exportKindDocx('transcript', `${docBase}.docx`);
                if (wantTranscript && wantSummary) {
                    const proceed = await _confirmNextDocExportOnMobile('summary', 'docx');
                    if (!proceed) return;
                }
                if (wantSummary) await _exportKindDocx('summary', `${docBase}_summary.docx`);
            } else {
                if (wantTranscript) await _exportKindTxt('transcript');
                if (wantTranscript && wantSummary) {
                    const proceed = await _confirmNextDocExportOnMobile('summary', 'txt');
                    if (!proceed) return;
                }
                if (wantSummary) await _exportKindTxt('summary');
            }
        } catch (e) {
            console.error('[docx/txt] export failed:', e);
            if (typeof showStatus === 'function') showStatus('שגיאה בייצוא: ' + e.message, true);
        }
    } else if (type === 'srt') {
        const segs = typeof normalizeSegmentDurations === 'function' ? normalizeSegmentDurations(window.currentSegments, 0.5) : window.currentSegments;
        const content = typeof srtFromCues === 'function' ? srtFromCues(segs) : '';
        await deliverBlobToUser(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${baseName}.srt`, 'text/plain;charset=utf-8');
    } else {
        let content = type === 'vtt' ? "WEBVTT\n\n" : "";
        const segs = typeof normalizeSegmentDurations === 'function' ? normalizeSegmentDurations(window.currentSegments, 0.5) : window.currentSegments;
        segs.forEach((seg, i) => {
            const ts = (s) => {
                let d = new Date(0); d.setMilliseconds(s * 1000);
                let iso = d.toISOString().substr(11, 12);
                return iso;
            };
            content += `${ts(seg.start)} --> ${ts(seg.end)}\n${seg.text.trim()}\n\n`;
        });
        await deliverBlobToUser(new Blob([content], {type: "text/plain;charset=utf-8"}), `${baseName}.${type}`, "text/plain;charset=utf-8");
    }
};


// Google Login Handler (only on pages that have the auth modal, e.g. index)
const googleLoginBtn = document.getElementById('google-login');
if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', async () => {
        try {
            if (await qsCompleteAuthIfAlreadySignedIn()) return;
        } catch (_) {}
        try {
            if (!(await qsMaybeWarnIOSPrivateBeforeOAuth())) return;
        } catch (_) {}
        try {
            if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
                saveMedicalAuthSnapshotForPendingSignIn();
            }
        } catch (_) {}
        if (window.currentSegments && window.currentSegments.length > 0 && !isMedicalModeEnabled()) {
            localStorage.setItem('pendingTranscript', JSON.stringify(window.currentSegments));
        }
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: qsOAuthRedirectTo() }
        });
        if (error) {
            if (typeof showStatus === 'function') showStatus("Google Login Error: " + error.message, true);
        }
    });
}

function dismissAuthModalAsGuest() {
    window.__QS_REG_PROMPT_DISMISSED_THIS_PAGE = true;
    if (typeof window.toggleModal === 'function') window.toggleModal(false);
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    if (typeof showStatus === 'function') {
        const msg = T('auth_skipped_hint') || 'You can keep working in this window. To upload, copy, export, or use your list — use Sign in in the top bar.';
        showStatus(msg, false, { duration: 8000, toastPosition: 'center', toastAnchorId: 'transcript-window' });
    }
}

const authSkipForNowBtn = document.getElementById('auth-skip-for-now');
if (authSkipForNowBtn) {
    authSkipForNowBtn.addEventListener('click', () => dismissAuthModalAsGuest());
}

const authModalOverlay = document.getElementById('auth-modal');
if (authModalOverlay) {
    authModalOverlay.addEventListener('click', (e) => {
        if (e.target === authModalOverlay) dismissAuthModalAsGuest();
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const am = document.getElementById('auth-modal');
    if (!am || am.style.display !== 'flex') return;
    e.preventDefault();
    dismissAuthModalAsGuest();
}, true);

document.querySelectorAll('.post-exp-star-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
        const v = parseInt(btn.getAttribute('data-post-exp-star'), 10);
        if (!Number.isFinite(v)) return;
        if (window._postExportFeedbackStars === v) setPostExportFeedbackStars(0);
        else setPostExportFeedbackStars(v);
    });
});
const postExpFbClose = document.getElementById('post-exp-fb-close');
if (postExpFbClose) {
    postExpFbClose.addEventListener('click', () => closePostExportFeedbackModal());
}
const postExpFbSubmit = document.getElementById('post-exp-fb-submit');
if (postExpFbSubmit) {
    postExpFbSubmit.addEventListener('click', async () => {
        const websiteEl = document.getElementById('post-exp-fb-website');
        if (websiteEl && String(websiteEl.value || '').trim()) {
            closePostExportFeedbackModal();
            return;
        }
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            closePostExportFeedbackModal();
            return;
        }
        const like = (document.getElementById('post-exp-fb-like') && document.getElementById('post-exp-fb-like').value || '').trim();
        const improve = (document.getElementById('post-exp-fb-improve') && document.getElementById('post-exp-fb-improve').value || '').trim();
        const stars = Number(window._postExportFeedbackStars || 0);
        if (!like && !improve && !stars) {
            closePostExportFeedbackModal();
            return;
        }
        const info = getAuthUserDisplayInfo(user);
        const email = (info.email || user.email || '').trim();
        const name = (String(info.displayName || '').replace(/\s*\|\s*.*$/, '').trim());
        if (!email) {
            closePostExportFeedbackModal();
            return;
        }
        let feedbackStored = false;
        try {
            const res = await fetch('/api/registration-feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    name,
                    like,
                    improve,
                    stars,
                    source: (window._qsFeedbackModalSource || 'post_export'),
                    website: websiteEl ? websiteEl.value : ''
                })
            });
            feedbackStored = !!(res && res.ok);
        } catch (_) {}
        if (feedbackStored) {
            await markUserSubmittedPostExportFeedback(user);
        }
        const T = typeof window.t === 'function' ? window.t : (k) => k;
        if (typeof showStatus === 'function') {
            showStatus(T('post_export_feedback_thanks') || 'Thank you for the feedback.', false, { duration: 3500 });
        }
        closePostExportFeedbackModal();
    });
}
const postExportFbModal = document.getElementById('post-export-feedback-modal');
if (postExportFbModal) {
    postExportFbModal.addEventListener('click', (e) => {
        if (e.target === postExportFbModal) closePostExportFeedbackModal();
    });
}

// Toggle auth mode (Sign Up / Log In) — magic link flow is the same for both
const toggleAuthBtn = document.getElementById('toggle-auth-mode');
if (toggleAuthBtn) {
    toggleAuthBtn.addEventListener('click', (e) => {
        e.preventDefault();
        isSignUpMode = !isSignUpMode;
        applyAuthModalMode();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Navbar auth first so signed-in CTA → Personal Area before i18n pass
    await setupNavbarAuth();
    if (typeof window.applyTranslations === 'function') window.applyTranslations();
    if (typeof window.qsSyncNavWorkspaceCta === 'function') {
        qsSyncNavWorkspaceCta(!!window.__QS_UX_USER_SIGNED_IN);
    }
    try { void qsHandleOAuthReturnIfNeeded(); } catch (_) {}

    try {
        if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
            let hasSnap = false;
            try {
                hasSnap = !!(localStorage.getItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY) || sessionStorage.getItem(QS_MEDICAL_AUTH_SNAPSHOT_KEY));
            } catch (_) {}
            const { data: { user: bootUser } } = await supabase.auth.getUser();
            if (hasSnap) {
                if (bootUser) {
                    try { restoreMedicalAuthSnapshotAfterSignIn(); } catch (_) {}
                } else {
                    try { clearMedicalAuthSnapshot(); } catch (_) {}
                }
            }
        }
    } catch (_) {}

    // Home page: "Open in app" — load job by ?open=jobId (retried from SIGNED_IN if session is not ready yet)
    const pathname = typeof window.location !== 'undefined' ? String(window.location.pathname || '').replace(/\/+$/, '') || '/' : '/';
    const isMainAppHome = pathname === '/';
    const isMedicalEntry = pathname === '/medical';
    if (isMainAppHome || isMedicalEntry) {
        try {
            const activeJobId = typeof window.qsGetActiveJobForResume === 'function'
                ? window.qsGetActiveJobForResume()
                : String(localStorage.getItem('activeJobId') || '').trim();
            if (activeJobId) {
                window.isTriggering = true;
                if (typeof window.startJobStatusPolling === 'function') {
                    window.startJobStatusPolling(activeJobId);
                }
                try {
                    if (typeof socket !== 'undefined') socket.emit('join', { room: activeJobId });
                } catch (_) {}
            }
        } catch (_) {}
        if (typeof runOpenQueryIfPresent === 'function') {
            await runOpenQueryIfPresent();
        }
        if (typeof maybeShowInitialRegistrationPrompt === 'function') {
            setTimeout(() => {
                void maybeShowInitialRegistrationPrompt();
            }, 1400);
        }
    }

    // History / My files page: list user's jobs and allow downloading originals from S3
    if (typeof window.location !== 'undefined' && (window.location.pathname === '/history' || window.location.pathname.endsWith('/history'))) {
        initHistoryPage();
    }

    // Personal area (איזור אישי): table view with dropdown actions
    if (typeof window.location !== 'undefined' && (window.location.pathname === '/personal' || window.location.pathname.endsWith('/personal'))) {
        initPersonalPage();
    }

    const transcriptWindow = document.getElementById('transcript-window');
    const mainAudio = document.getElementById('main-audio');
    const dBtn = document.getElementById('btn-download');
    const dBtnLabel = document.querySelector('#btn-download .btn-download-label');
    const dMenu = document.getElementById('download-menu');
    /** Assigned after export-panel helpers load; clears defaults each time user opens export panel. */
    let resetExportPanelSelectionsOnOpen = () => {};

    let removeMobileMenuBackdrop = () => {};
    if (dBtn && dMenu) {
        const downloadMenuParent = dMenu.parentElement;
        let mobileMenuBackdrop = null;
        function ensureMobileMenuBackdrop() {
            if (mobileMenuBackdrop && document.body.contains(mobileMenuBackdrop)) return mobileMenuBackdrop;
            mobileMenuBackdrop = document.createElement('div');
            mobileMenuBackdrop.id = 'download-menu-backdrop';
            mobileMenuBackdrop.addEventListener('click', () => {
                dMenu.style.display = 'none';
                dMenu.classList.remove('show');
                positionDownloadMenuClosed();
            });
            document.body.appendChild(mobileMenuBackdrop);
            return mobileMenuBackdrop;
        }
        removeMobileMenuBackdrop = function() {
            if (mobileMenuBackdrop && mobileMenuBackdrop.parentNode) {
                mobileMenuBackdrop.parentNode.removeChild(mobileMenuBackdrop);
            }
            mobileMenuBackdrop = null;
        };
        function positionDownloadMenuOpen() {
            const isMobile = window.matchMedia('(max-width: 768px)').matches;
            if (dMenu.parentElement !== document.body) {
                document.body.appendChild(dMenu);
            }
            dMenu.style.position = 'fixed';
            dMenu.style.zIndex = isMobile ? '9999' : '10050';
            dMenu.style.pointerEvents = 'auto';
            function place() {
                if (isMobile) {
                    dMenu.classList.add('is-mobile-overlay');
                    const backdrop = ensureMobileMenuBackdrop();
                    if (backdrop) backdrop.classList.add('show');
                    dMenu.style.left = '8px';
                    dMenu.style.right = '8px';
                    dMenu.style.top = '8px';
                    dMenu.style.bottom = '8px';
                    dMenu.style.maxWidth = 'none';
                    return;
                }
                dMenu.classList.remove('is-mobile-overlay');
                const btnRect = dBtn.getBoundingClientRect();
                const pad = 12;
                const maxW = Math.max(320, Math.min(420, window.innerWidth - (pad * 2)));
                const maxH = Math.max(260, window.innerHeight - (pad * 2));
                dMenu.style.width = `${maxW}px`;
                dMenu.style.maxWidth = `${maxW}px`;
                dMenu.style.maxHeight = `${maxH}px`;
                const card = dMenu.querySelector('.export-panel-card');
                if (card) card.style.maxHeight = `${Math.max(240, maxH - 16)}px`;
                const w = Math.min(dMenu.offsetWidth || maxW, maxW);
                const h = dMenu.offsetHeight || 120;
                const preferredLeft = btnRect.right - w;
                const left = Math.min(Math.max(pad, preferredLeft), Math.max(pad, window.innerWidth - w - pad));

                // Prefer above the toolbar; allow overlaying the video if that's where space exists.
                const aboveTop = btnRect.top - h - 8;
                const belowTop = btnRect.bottom + 8;
                let top = aboveTop >= pad ? aboveTop : belowTop;
                top = Math.min(Math.max(pad, top), Math.max(pad, window.innerHeight - h - pad));

                dMenu.style.left = `${left}px`;
                dMenu.style.top = `${top}px`;
                dMenu.style.right = 'auto';
                dMenu.style.bottom = 'auto';
            }
            place();
            requestAnimationFrame(place);
        }
        function positionDownloadMenuClosed() {
            dMenu.style.position = '';
            dMenu.style.zIndex = '';
            dMenu.style.pointerEvents = '';
            dMenu.style.top = '';
            dMenu.style.right = '';
            dMenu.style.left = '';
            dMenu.style.bottom = '';
            dMenu.style.width = '';
            dMenu.style.maxHeight = '';
            dMenu.style.maxWidth = '';
            const card = dMenu.querySelector('.export-panel-card');
            if (card) card.style.maxHeight = '';
            dMenu.classList.remove('is-mobile-overlay');
            removeMobileMenuBackdrop();
            if (downloadMenuParent && dMenu.parentElement !== downloadMenuParent) {
                downloadMenuParent.appendChild(dMenu);
            }
            setExportMenuAuxiliaryControlsDisabled(false);
        }
        dBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (isMedicalModeEnabled()) {
                const activeDocKind = String(window.medicalActiveTab || 'summary') === 'summary' ? 'summary' : 'transcript';
                window.downloadFile('docx', null, { docxKinds: [activeDocKind], docxKind: activeDocKind });
                return;
            }
            const isHidden = dMenu.style.display === 'none' || window.getComputedStyle(dMenu).display === 'none';
            if (isHidden) {
                const movieInput = document.querySelector('#docx-submenu .export-extra-choice[data-export-kind="movie"]');
                if (movieInput) {
                    const label = movieInput.closest('.export-check-item');
                    const hasVideo = Boolean(window.uploadWasVideo);
                    movieInput.disabled = !hasVideo;
                    if (!hasVideo) movieInput.checked = false;
                    if (label) label.classList.toggle('is-disabled', !hasVideo);
                }
                try { resetExportPanelSelectionsOnOpen(); } catch (_) {}
                setExportMenuAuxiliaryControlsDisabled(true);
                dMenu.style.display = 'flex';
                dMenu.classList.add('show');
                positionDownloadMenuOpen();
            } else {
                dMenu.style.display = 'none';
                dMenu.classList.remove('show');
                positionDownloadMenuClosed();
            }
        };
        document.addEventListener('click', function(e) {
            if (!dMenu.contains(e.target) && !dBtn.contains(e.target)) {
                dMenu.style.display = 'none';
                dMenu.classList.remove('show');
                positionDownloadMenuClosed();
            }
        });
    }

    const selectedDocFormatByKind = {
        transcript: 'docx',
        summary: 'docx'
    };
    const closeDownloadMenu = () => {
        const menu = document.getElementById('download-menu');
        if (menu) {
            menu.style.display = 'none';
            menu.classList.remove('show');
            menu.style.position = '';
            menu.style.zIndex = '';
            menu.style.pointerEvents = '';
            menu.style.top = '';
            menu.style.right = '';
            menu.style.left = '';
            menu.style.bottom = '';
            menu.style.width = '';
            menu.style.maxHeight = '';
            menu.style.maxWidth = '';
            const card = menu.querySelector('.export-panel-card');
            if (card) card.style.maxHeight = '';
            menu.classList.remove('is-mobile-overlay');
            removeMobileMenuBackdrop();
            const parent = document.getElementById('btn-download')?.parentElement;
            if (parent && menu.parentElement !== parent) {
                parent.appendChild(menu);
            }
        }
        setExportMenuAuxiliaryControlsDisabled(false);
    };
    const getSelectedDocxKinds = () => {
        const checked = Array.from(document.querySelectorAll('#docx-submenu .export-doc-choice:checked'))
            .map((el) => (el.getAttribute('data-docx-kind') || '').toLowerCase())
            .filter((k) => k === 'transcript' || k === 'summary');
        return checked;
    };
    const getSelectedExtraKinds = () => {
        return Array.from(document.querySelectorAll('#docx-submenu .export-extra-choice:checked'))
            .map((el) => (el.getAttribute('data-export-kind') || '').toLowerCase())
            .filter((k) => k === 'srt' || k === 'vtt' || k === 'movie');
    };
    const updateMovieGenerateAvailability = () => {
        const movieInput = document.querySelector('#docx-submenu .export-extra-choice[data-export-kind="movie"]');
        if (!movieInput) return;
        const card = movieInput.closest('.option-card');
        const hasVideo = Boolean(window.uploadWasVideo);
        movieInput.disabled = !hasVideo;
        if (!hasVideo) movieInput.checked = false;
        if (card) card.classList.toggle('is-disabled', !hasVideo);
    };
    const setSubtitlesEnabled = (enabled) => {
        const srtInput = document.querySelector('#docx-submenu .export-extra-choice[data-export-kind="srt"]');
        const vttInput = document.querySelector('#docx-submenu .export-extra-choice[data-export-kind="vtt"]');
        if (!srtInput || !vttInput) return;
        if (enabled) {
            if (!srtInput.checked && !vttInput.checked) srtInput.checked = true;
        } else {
            srtInput.checked = false;
            vttInput.checked = false;
        }
    };
    const syncGenerateCardState = () => {
        const transcriptEnabled = !!document.querySelector('#docx-submenu .export-doc-choice[data-docx-kind="transcript"]')?.checked;
        const summaryEnabled = !!document.querySelector('#docx-submenu .export-doc-choice[data-docx-kind="summary"]')?.checked;
        const movieEnabled = !!document.querySelector('#docx-submenu .export-extra-choice[data-export-kind="movie"]')?.checked;
        const subtitlesEnabled = !!(
            document.querySelector('#docx-submenu .export-extra-choice[data-export-kind="srt"]')?.checked ||
            document.querySelector('#docx-submenu .export-extra-choice[data-export-kind="vtt"]')?.checked
        );
        const subtitlesEnableInput = document.querySelector('#docx-submenu .export-subtitles-enable');
        if (subtitlesEnableInput) subtitlesEnableInput.checked = subtitlesEnabled;
        document.querySelectorAll('#docx-submenu .option-card[data-card-kind]').forEach((card) => {
            const kind = (card.getAttribute('data-card-kind') || '').toLowerCase();
            const on = (kind === 'transcript' && transcriptEnabled)
                || (kind === 'summary' && summaryEnabled)
                || (kind === 'movie' && movieEnabled)
                || (kind === 'subtitles' && subtitlesEnabled);
            card.classList.toggle('is-selected', !!on);
        });
    };
    const syncSubtitleFormatSwitches = () => {
        document.querySelectorAll('#docx-submenu .export-format-choice[data-extra-kind]').forEach((btn) => {
            const kind = (btn.getAttribute('data-extra-kind') || '').toLowerCase();
            const input = document.querySelector(`#docx-submenu .export-extra-choice[data-export-kind="${kind}"]`);
            btn.classList.toggle('is-selected', !!(input && input.checked));
        });
        syncGenerateCardState();
    };
    resetExportPanelSelectionsOnOpen = function() {
        const sub = document.getElementById('docx-submenu');
        if (!sub) return;
        sub.querySelectorAll('.export-doc-choice').forEach((el) => { el.checked = false; });
        const movieIn = sub.querySelector('.export-extra-choice[data-export-kind="movie"]');
        if (movieIn && !movieIn.disabled) movieIn.checked = false;
        const subEn = sub.querySelector('.export-subtitles-enable');
        if (subEn) subEn.checked = false;
        setSubtitlesEnabled(false);
        syncSubtitleFormatSwitches();
    };
    document.querySelectorAll('#docx-submenu .export-format-choice[data-docx-kind]').forEach((btn) => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const kind = (this.getAttribute('data-docx-kind') || '').toLowerCase();
            const fmt = (this.getAttribute('data-format') || 'docx').toLowerCase();
            if (kind !== 'transcript' && kind !== 'summary') return;
            selectedDocFormatByKind[kind] = (fmt === 'txt') ? 'txt' : 'docx';
            document.querySelectorAll(`#docx-submenu .export-format-choice[data-docx-kind="${kind}"]`).forEach((it) => {
                it.classList.toggle('is-selected', it === this);
            });
            syncGenerateCardState();
        });
    });
    document.querySelectorAll('#docx-submenu .export-format-choice[data-extra-kind]').forEach((btn) => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const kind = (this.getAttribute('data-extra-kind') || '').toLowerCase();
            const input = document.querySelector(`#docx-submenu .export-extra-choice[data-export-kind="${kind}"]`);
            if (!input || input.disabled) return;
            // Subtitle format behaves as segmented switch (single-choice), like DOCX/TXT.
            document.querySelectorAll('#docx-submenu .export-extra-choice[data-export-kind="srt"], #docx-submenu .export-extra-choice[data-export-kind="vtt"]').forEach((el) => {
                el.checked = (el === input);
            });
            syncSubtitleFormatSwitches();
        });
    });
    document.querySelectorAll('#docx-submenu .export-doc-choice, #docx-submenu .export-extra-choice[data-export-kind="movie"]').forEach((input) => {
        input.addEventListener('change', () => syncGenerateCardState());
    });
    const subtitlesEnableInput = document.querySelector('#docx-submenu .export-subtitles-enable');
    if (subtitlesEnableInput) {
        subtitlesEnableInput.addEventListener('change', () => {
            setSubtitlesEnabled(!!subtitlesEnableInput.checked);
            syncSubtitleFormatSwitches();
        });
    }
    document.querySelectorAll('#docx-submenu .option-card[data-card-kind]').forEach((card) => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.export-check-ui')) return;
            const kind = (card.getAttribute('data-card-kind') || '').toLowerCase();
            if (kind === 'transcript' || kind === 'summary') {
                const cb = card.querySelector(`.export-doc-choice[data-docx-kind="${kind}"]`);
                if (!cb || cb.disabled) return;
                cb.checked = !cb.checked;
                syncGenerateCardState();
                return;
            }
            if (kind === 'movie') {
                const cb = card.querySelector('.export-extra-choice[data-export-kind="movie"]');
                if (!cb || cb.disabled) return;
                cb.checked = !cb.checked;
                syncGenerateCardState();
                return;
            }
            if (kind === 'subtitles') {
                const cb = card.querySelector('.export-subtitles-enable');
                if (!cb || cb.disabled) return;
                cb.checked = !cb.checked;
                setSubtitlesEnabled(!!cb.checked);
                syncSubtitleFormatSwitches();
            }
        });
    });
    syncSubtitleFormatSwitches();
    syncGenerateCardState();
    const docExportBtn = document.querySelector('#docx-submenu [data-type="generate-export"]');
    const closeExportPanelBtn = document.querySelector('#docx-submenu [data-type="close-export-panel"]');
    if (closeExportPanelBtn) {
        const closePanel = function(e) {
            e.preventDefault();
            e.stopPropagation();
            closeDownloadMenu();
        };
        closeExportPanelBtn.addEventListener('click', closePanel);
        closeExportPanelBtn.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            closePanel(e);
        });
    }
    if (docExportBtn) {
        docExportBtn.addEventListener('click', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            qsTrackEvent('export_clicked');
            const selectedDocKinds = getSelectedDocxKinds();
            const selectedExtraKinds = getSelectedExtraKinds();
            if (!selectedDocKinds.length && !selectedExtraKinds.length) {
                if (typeof showStatus === 'function') showStatus('Select at least one output to generate.', true);
                return;
            }

            // If not signed in, we delay the auth modal until the user explicitly confirms.
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
                const wantsDoc = selectedDocKinds.length > 0;
                const wantsMovie = selectedExtraKinds.includes('movie');
                const wantsSubtitles = selectedExtraKinds.includes('srt') || selectedExtraKinds.includes('vtt');

                const msg = isHebrewUi
                    ? (
                        (() => {
                            // 2 sentences only (required). Sentence 1 depends on what was selected.
                            if (wantsDoc && wantsMovie && wantsSubtitles) return 'כדי ליצור את המסמך, את הווידאו ואת הכתוביות יש להתחבר למערכת.\nלהתחבר עכשיו?';
                            if (wantsDoc && wantsMovie) return 'כדי ליצור את המסמך וגם את הווידאו יש להתחבר למערכת.\nלהתחבר עכשיו?';
                            if (wantsDoc && wantsSubtitles) return 'כדי ליצור את המסמך וגם את הכתוביות יש להתחבר למערכת.\nלהתחבר עכשיו?';
                            if (wantsMovie && wantsSubtitles) return 'כדי ליצור את הווידאו וגם את הכתוביות יש להתחבר למערכת.\nלהתחבר עכשיו?';
                            if (wantsDoc) return 'כדי ליצור את המסמך יש להתחבר למערכת.\nלהתחבר עכשיו?';
                            if (wantsMovie) return 'כדי ליצור את הווידאו יש להתחבר למערכת.\nלהתחבר עכשיו?';
                            if (wantsSubtitles) return 'כדי ליצור את הכתוביות יש להתחבר למערכת.\nלהתחבר עכשיו?';
                            return 'כדי ליצור את המסמך יש להתחבר למערכת.\nלהתחבר עכשיו?';
                        })()
                    )
                    : 'To generate this document/movie, you need to be connected.\nDo you want to connect now?';

                const wantsConnect = await showGlobalConfirm(msg, {
                    confirmText: isHebrewUi ? 'כן' : 'Yes',
                    cancelText: isHebrewUi ? 'לא' : 'No'
                });
                if (!wantsConnect) return; // Keep the generate menu open

                // Do NOT auto-resume export after sign-in for this flow.
                // User should explicitly press "Generate" again.
                window.pendingExportType = null;
                localStorage.removeItem('pendingExportType');
                localStorage.removeItem('pendingS3Key');
                localStorage.removeItem('pendingJobId');
                localStorage.setItem('pendingOpenGenerateMenu', '1');

                isSignUpMode = true;
                try { applyAuthModalMode(); } catch (_) {}

                closeDownloadMenu();
                if (typeof window.toggleModal === 'function') window.toggleModal(true);
                return;
            }

            closeDownloadMenu();
            // Run exports sequentially. On mobile with multiple outputs, collect files
            // and open a single system share/save chooser for all of them.
            // iOS often blocks multi-share sequences in one flow; prefer per-file save dialogs.
            const useBatchShare = false;
            const orderedExtraKinds = selectedExtraKinds.slice().sort((a, b) => {
                if (a === 'movie' && b !== 'movie') return -1;
                if (b === 'movie' && a !== 'movie') return 1;
                return 0;
            });
            const exportTasks = [];
            if (orderedExtraKinds.includes('movie')) {
                exportTasks.push({
                    label: 'movie',
                    run: async () => { await window.downloadFile('movie', null, {}); }
                });
            }
            if (selectedDocKinds.length) {
                const orderedDocKinds = ['transcript', 'summary'].filter((k) => selectedDocKinds.includes(k));
                for (const docKind of orderedDocKinds) {
                    const selectedFmt = selectedDocFormatByKind[docKind] === 'txt' ? 'txt' : 'docx';
                    exportTasks.push({
                        label: docKind,
                        run: async () => {
                            await window.downloadFile(selectedFmt, null, { docxKinds: [docKind], docxKind: docKind });
                        }
                    });
                }
            }
            for (const kind of orderedExtraKinds) {
                if (kind === 'movie') continue;
                exportTasks.push({
                    label: kind,
                    run: async () => { await window.downloadFile(kind, null, {}); }
                });
            }
            if (useBatchShare) {
                window._qsMobileBatchShareMode = true;
                window._qsMobileBatchFiles = [];
            }
            try {
                const mobileMulti = isMobileClient() && exportTasks.length > 1;
                const isHebrewUi2 = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
                const getExportLabel = (labelKey) => {
                    const key = String(labelKey || '').toLowerCase();
                    if (isHebrewUi2) {
                        if (key === 'movie') return 'וידאו';
                        if (key === 'srt') return 'SRT';
                        if (key === 'vtt') return 'VTT';
                        if (key === 'summary') return 'סיכום';
                        return 'תמלול';
                    }
                    if (key === 'movie') return 'movie';
                    if (key === 'srt') return 'SRT';
                    if (key === 'vtt') return 'VTT';
                    if (key === 'summary') return 'summary';
                    return 'transcript';
                };
                for (let i = 0; i < exportTasks.length; i++) {
                    if (i > 0 && mobileMulti) {
                        const nextLabel = getExportLabel(exportTasks[i].label);
                        const proceed = await showGlobalConfirm(
                            isHebrewUi2
                                ? `האם לשמור את קובץ ה-${nextLabel}?`
                                : `Save the ${nextLabel} file?`,
                            {
                                confirmText: isHebrewUi2 ? 'שמור' : 'Save',
                                cancelText: isHebrewUi2 ? 'עצור' : 'Stop'
                            }
                        );
                        if (!proceed) break;
                    }
                    await exportTasks[i].run();
                }
            } finally {
                if (useBatchShare) {
                    window._qsMobileBatchShareMode = false;
                    const ok = await _flushMobileBatchShare();
                    if (!ok && typeof showStatus === 'function') {
                        showStatus('לא הצלחתי לפתוח שמירה עבור כל הקבצים. נסה/י לייצא קובץ אחד בכל פעם.', true);
                    }
                }
            }
        });
    }
    updateMovieGenerateAvailability();
    document.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.addEventListener('click', function(e) {
            try {
                e.preventDefault();
                e.stopPropagation();
            } catch (_) {}
            const type = this.getAttribute('data-type');
            closeDownloadMenu();
            console.log("🖱️ User requested export:", type);
            window.downloadFile(type, null, {});
        });
    });

    if (mainAudio) {
            // Attach audio handlers once
            if (!mainAudio._qs_listeners_attached) {
                mainAudio.addEventListener('timeupdate', () => {
                    const currentTime = mainAudio.currentTime;
                    const activeSegment = typeof window.getActiveSegmentAtTime === 'function' ? window.getActiveSegmentAtTime(window.currentSegments || [], currentTime) : null;

                    if (activeSegment) {
                        document.querySelectorAll('.paragraph-row').forEach(row => {
                            row.style.backgroundColor = "transparent";
                            row.style.borderLeft = "none";
                        });
                        document.querySelectorAll('.paragraph-row p').forEach(p => {
                            p.style.backgroundColor = "transparent";
                        });

                        const rowIndex = typeof window.getGroupIndexForSegment === 'function' ? window.getGroupIndexForSegment(window.currentSegments, activeSegment) : 0;
                        const activeRow = document.getElementById('seg-row-' + rowIndex);
                        if (activeRow) {
                            activeRow.style.backgroundColor = "#f0f7ff"; // Light blue highlight
                            activeRow.style.borderLeft = "4px solid #1e3a8a"; // Navy accent
                            const p = activeRow.querySelector('p');
                            if (p) {
                                p.style.backgroundColor = "#fff9c4"; // Light yellow (same as MP4)
                            }
                        }
                    }
                });

                // Legacy simulation-start-on-play removed (caused duplicate/stale process behavior).

                mainAudio._qs_listeners_attached = true;
            }
        }

        // Always attach video handlers (do not require audio to exist)
        const mainVideoEl = document.getElementById('main-video');
        const hardenVideoControlsForMobile = (videoEl) => {
            if (!videoEl) return;
            try {
                videoEl.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
                videoEl.setAttribute('disablePictureInPicture', '');
                videoEl.setAttribute('disableRemotePlayback', '');
            } catch (_) {}
            try {
                videoEl.oncontextmenu = () => false;
            } catch (_) {}
            if (!videoEl._qs_rate_locked) {
                videoEl.addEventListener('ratechange', () => {
                    try {
                        if (Math.abs((videoEl.playbackRate || 1) - 1) > 0.001) {
                            videoEl.playbackRate = 1;
                        }
                    } catch (_) {}
                });
                videoEl._qs_rate_locked = true;
            }
        };
        if (mainVideoEl) hardenVideoControlsForMobile(mainVideoEl);
        if (mainVideoEl && !mainVideoEl._qs_listeners_attached) {
            mainVideoEl.addEventListener('timeupdate', () => {
                const currentTime = mainVideoEl.currentTime;
                const activeSegment = typeof window.getActiveSegmentAtTime === 'function' ? window.getActiveSegmentAtTime(window.currentSegments || [], currentTime) : null;

                try {
                    document.querySelectorAll('.paragraph-row').forEach(row => row.classList.remove('active-highlight'));
                    document.querySelectorAll('.paragraph-row p').forEach(p => p.style.backgroundColor = "transparent");

                    if (activeSegment) {
                        const rowIndex = typeof window.getGroupIndexForSegment === 'function' ? window.getGroupIndexForSegment(window.currentSegments, activeSegment) : 0;
                        const activeRow = document.getElementById('seg-row-' + rowIndex);
                        if (activeRow) {
                            activeRow.classList.add('active-highlight');
                            activeRow.scrollIntoView({ behavior: 'auto', block: 'nearest' });
                            const p = activeRow.querySelector('p');
                            if (p) p.style.backgroundColor = "#fff9c4";
                        }
                    }
                } catch (e) {
                    console.warn('Highlighting failure', e);
                }
            });

            // Legacy simulation-start-on-play removed (caused duplicate/stale process behavior).

            mainVideoEl._qs_listeners_attached = true;
        }

        // Do not auto-restore pendingTranscript here: it can show stale old transcripts.

        const savedS3Key = localStorage.getItem('pendingS3Key');
        if (savedS3Key) {
            localStorage.setItem('lastS3Key', savedS3Key);
        }
        const savedJobId = localStorage.getItem('pendingJobId');
        if (savedJobId) {
            localStorage.setItem('lastJobId', savedJobId);
        }

        const savedExportType = localStorage.getItem('pendingExportType') || window.pendingExportType;

        if (savedExportType) {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                console.log(`🚀 Auto-resuming pending ${savedExportType} export...`);
                window.downloadFile(savedExportType, user);
            }
            // Reset the pending type so it doesn't loop
            window.pendingExportType = null;
            localStorage.removeItem('pendingExportType');
            // Intentionally no status toast here (user requested no export popup for DOCX flow).
        }

        // Re-open Generate menu after auth (without auto-export), when requested by flow.
        const shouldReopenGenerateMenu = localStorage.getItem('pendingOpenGenerateMenu') === '1';
        if (shouldReopenGenerateMenu) {
            const { data: { user } } = await supabase.auth.getUser();
            if (user && dBtn && dMenu) {
                try {
                    const lastJobIdForReopen = localStorage.getItem('lastJobDbId') || localStorage.getItem('lastJobId');
                    const hasTranscriptInMemory = Array.isArray(window.currentSegments) && window.currentSegments.length > 0;
                    if (!hasTranscriptInMemory && lastJobIdForReopen && typeof initOpenInApp === 'function') {
                        await initOpenInApp(lastJobIdForReopen);
                    }
                    const isHidden = dMenu.style.display === 'none' || window.getComputedStyle(dMenu).display === 'none';
                    if (isHidden) dBtn.click();
                } catch (_) {}
            }
            localStorage.removeItem('pendingOpenGenerateMenu');
        }


        // Clean up LocalStorage so it doesn't run again on next refresh
        localStorage.removeItem('pendingTranscript');
        localStorage.removeItem('pendingS3Key');
        localStorage.removeItem('pendingJobId');
    }
);

async function updateUIForUser() {
    const user = await qsGetAuthUserForUi({ waitMs: 1500 });
    const authBtn = document.getElementById('main-auth-trigger'); // The button that opens the modal

    if (user && authBtn) {
        authBtn.innerText = typeof window.t === 'function' ? window.t('nav_logout') : "Log Out";
        authBtn.onclick = async () => {
            if (typeof _qsSignOutThenMedicalOrReload === 'function') {
                await _qsSignOutThenMedicalOrReload();
            } else {
                await supabase.auth.signOut();
                window.location.reload();
            }
        };
    }
}

const authSubmitBtn = document.getElementById('auth-submit-btn');
if (authSubmitBtn) {
    authSubmitBtn.addEventListener('click', async () => {
        const email = document.getElementById('auth-email').value?.trim();
        if (!email) {
            if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('enter_email') : "Please enter your email address.", true);
            return;
        }

        authSubmitBtn.disabled = true;
        authSubmitBtn.innerText = typeof window.t === 'function' ? window.t('sending_link') : "Sending link...";

        try {
            const fullName = document.getElementById('auth-name')?.value?.trim();
            if (!(await qsMaybeWarnIOSPrivateBeforeOAuth())) {
                authSubmitBtn.disabled = false;
                authSubmitBtn.innerText = typeof window.t === 'function' ? window.t('send_magic_link') : 'Send me a link';
                return;
            }
            const { data, error } = await supabase.auth.signInWithOtp({
                email,
                options: {
                    emailRedirectTo: qsOAuthRedirectTo(),
                    data: fullName ? { full_name: fullName } : undefined
                }
            });

            if (error) throw error;

            console.log("✅ Magic link sent to:", email);
            showStatus(typeof window.t === 'function' ? window.t('check_email_link') : "Check your email for the login link.", false);
            authSubmitBtn.innerText = typeof window.t === 'function' ? window.t('link_sent') : "Link sent! Check your email.";
        } catch (err) {
            console.error("❌ Auth Error:", err);
            // Log full error so we can see Supabase response (e.g. 500 "Error sending magic link email")
            if (err && (err.message || err.error_description || err.msg)) {
                console.error("Auth error detail:", {
                    message: err.message,
                    status: err.status,
                    error_description: err.error_description,
                    msg: err.msg,
                    name: err.name
                });
            }
            showStatus(err.message || (err.error_description || err.msg || "Login failed"), true);
        } finally {
            authSubmitBtn.disabled = false;
        }
    });
}

function qsSetMainBtnDynamicLabel(text) {
    const mainBtn = document.getElementById('main-btn');
    if (!mainBtn || text == null) return;
    mainBtn.setAttribute('data-qs-dynamic-label', '1');
    mainBtn.innerText = String(text);
}

function qsClearMainBtnDynamicLabel() {
    const mainBtn = document.getElementById('main-btn');
    if (!mainBtn) return;
    mainBtn.removeAttribute('data-qs-dynamic-label');
}

function setMainButtonAction(mode) {
    window.mainBtnAction = mode || 'upload';
    const mainBtn = document.getElementById('main-btn');
    if (!mainBtn) return;
    qsClearMainBtnDynamicLabel();
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    if (window.mainBtnAction === 'transcribe_loaded_file') {
        mainBtn.setAttribute('data-i18n', 'transcribe');
        mainBtn.innerText = (T('transcribe') || T('transcribe_btn')) || 'תמלל';
    } else if (window.mainBtnAction === 'new_session') {
        mainBtn.setAttribute('data-i18n', 'new_session');
        mainBtn.innerText = T('new_session') || 'New Session';
    } else {
        mainBtn.setAttribute('data-i18n', 'upload_and_process');
        mainBtn.innerText = T('upload_and_process') || 'Upload';
    }
}

function isTimeToggleVisible() {
    const el = document.getElementById('toggle-time');
    // Default is ON when toggle is missing/not initialized yet.
    return !el || el.checked !== false;
}

function isDocumentFormatEnabled() {
    if (isSummaryViewEnabled()) return false;
    const docBtn = document.getElementById('format-mode-doc');
    if (docBtn && docBtn.classList.contains('is-active')) return true;
    const subBtn = document.getElementById('format-mode-subtitle');
    if (subBtn && subBtn.classList.contains('is-active')) return false;
    // Buttons not in DOM yet, or no active class: match default (subtitle-first in setFormatMode).
    return false;
}

function isSummaryViewEnabled() {
    if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return false;
    const summaryBtn = document.getElementById('format-mode-summary');
    return !!(summaryBtn && summaryBtn.classList.contains('is-active'));
}

function hasStandardFormattedSummary() {
    const fmt = window.currentFormattedDoc;
    if (!fmt || typeof fmt !== 'object') return false;
    if (String(fmt.overview || '').trim()) return true;
    if (Array.isArray(fmt.key_points) && fmt.key_points.some((p) => String(p || '').trim())) return true;
    if (Array.isArray(fmt.action_items) && fmt.action_items.some((p) => String(p || '').trim())) return true;
    return false;
}

function syncStandardFormatTabs() {
    const summaryBtn = document.getElementById('format-mode-summary');
    const switchWrap = document.getElementById('format-mode-switch');
    if (!summaryBtn || !switchWrap) return;
    const showSummary = !(typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled());
    summaryBtn.style.display = showSummary ? '' : 'none';
}

function setFormatViewMode(mode) {
    const subtitleBtn = document.getElementById('format-mode-subtitle');
    const docBtn = document.getElementById('format-mode-doc');
    const summaryBtn = document.getElementById('format-mode-summary');
    const next = String(mode || 'summary').toLowerCase();
    if (subtitleBtn) subtitleBtn.classList.toggle('is-active', next === 'subtitle');
    if (docBtn) docBtn.classList.toggle('is-active', next === 'doc');
    if (summaryBtn) summaryBtn.classList.toggle('is-active', next === 'summary');
    window.qsFormatViewMode = next;
    syncStandardFormatTabs();
    if (next === 'doc' && !(typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled())) {
        qsTrackEvent('transcript_tab_opened');
        void ensureTranscriptCleanupLazy();
    }
    if (typeof window._qsRerenderTranscriptView === 'function') window._qsRerenderTranscriptView();
}
window.setFormatViewMode = setFormatViewMode;
window.syncStandardFormatTabs = syncStandardFormatTabs;

function renderStandardSummaryView() {
    const container = document.getElementById('transcript-window');
    if (!container) return;
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object') ? window.currentFormattedDoc : {};
    const locale = String(typeof qsResolveAppLocale === 'function' ? qsResolveAppLocale() : (window.currentLocale || 'he')).toLowerCase();
    const isRtl = locale.startsWith('he') || locale.startsWith('ar');
    const summaryDirection = isRtl ? 'rtl' : 'ltr';
    const summaryAlign = isRtl ? 'right' : 'left';
    const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const overview = String(fmt.overview || '').trim();
    const points = Array.isArray(fmt.key_points) ? fmt.key_points.map((p) => String(p || '').trim()).filter(Boolean) : [];
    const actions = Array.isArray(fmt.action_items) ? fmt.action_items.map((p) => String(p || '').trim()).filter(Boolean) : [];
    const emptyMsg = T('summary_empty') || 'No summary yet.';
    const pointsHtml = points.length
        ? `<ul id="standard-summary-points" style="margin:8px 0 0; padding-inline-start:20px;">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
        : `<div style="color:#6b7280;">${esc(emptyMsg)}</div>`;
    const actionsHtml = actions.length
        ? `<ul id="standard-summary-actions" style="margin:8px 0 0; padding-inline-start:20px;">${actions.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
        : `<div style="color:#6b7280;">${esc(emptyMsg)}</div>`;
    container.innerHTML = `
        <div id="standard-summary-content" style="direction:${summaryDirection}; text-align:${summaryAlign}; line-height:1.72;">
            <div style="font-weight:700; margin-bottom:6px;">${esc(T('summary_overview') || 'Overview')}</div>
            <div id="standard-summary-overview">${esc(overview || emptyMsg)}</div>
            <div style="font-weight:700; margin:14px 0 6px;">${esc(T('summary_key_points') || 'Key points')}</div>
            ${pointsHtml}
            <div style="font-weight:700; margin:14px 0 6px;">${esc(T('summary_action_items') || 'Action items')}</div>
            ${actionsHtml}
        </div>`;
    container.contentEditable = 'false';
}

function wrapTextByMaxChars(text, maxChars) {
    const s = String(text || '').trim();
    if (!s || !maxChars || s.length <= maxChars) return s;
    const words = s.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
        const next = line ? (line + ' ' + w) : w;
        if (next.length <= maxChars) {
            line = next;
        } else {
            if (line) lines.push(line);
            line = w;
        }
    }
    if (line) lines.push(line);
    return lines.join('<br>');
}

function getDocFormatParagraphs() {
    const fromFmt = String((window.currentFormattedDoc && window.currentFormattedDoc.clean_transcript) || '').trim();
    const fromSeg = String(buildTranscriptPlainBodyForExport() || '').trim();
    const clean = (!window._qsDocPreferSegmentsAfterEdit && fromFmt) ? fromFmt : (fromSeg || fromFmt);
    if (!clean) return [];
    // Match backend DOCX paragraph logic:
    // - Paragraphs split only by blank lines (\n\n)
    // - Single \n inside a paragraph are display wraps and collapse to spaces
    return clean
        .split(/(?:\r?\n\s*){2,}/)
        .map((block) => String(block || '').replace(/\s*\r?\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim())
        .filter(Boolean);
}

const PROCESSING_PHASES_HE = [
    "מפעיל שרתים מרוחקים...",
    "מנתח את האודיו ומזהה מילים...",
    "מייצר כתוביות ומסנכרן לוידאו...",
    "מבצע פינישים אחרונים...",
    "משפר תמלול וכותב סיכום (GPT)..."
];
const QS_GPT_PHASE_INDEX = 4;
const QS_PIPELINE_TRANSCRIBE_MS = 45000;
const QS_PIPELINE_SUMMARY_MS = 16000;

function qsProgressBarElement() {
    return document.getElementById('progress-bar-legacy');
}

function qsSetProgressBarPct(pct) {
    const bar = qsProgressBarElement();
    if (!bar) return;
    const n = Math.max(0, Math.min(100, Number(pct) || 0));
    bar.style.width = n + '%';
}

function qsUnifiedPhaseLabel(phase) {
    const keyByPhase = {
        upload: 'pipeline_upload',
        transcribe: 'pipeline_transcribe',
        summary: 'pipeline_summary',
    };
    const key = keyByPhase[phase];
    if (key && typeof window.t === 'function') {
        const tr = window.t(key);
        if (tr) return tr;
    }
    const isHe = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
    const labels = isHe
        ? { warmup: 'התחממות', upload: 'העלאה', transcribe: 'תמלול', summary: 'יצירת סיכום' }
        : { warmup: 'Warmup', upload: 'Uploading', transcribe: 'Transcribing', summary: 'Summary creation' };
    return labels[phase] || labels.upload;
}

function qsClearUnifiedProgressTimer() {
    if (window.__QS_UNIFIED_PROGRESS_TIMER) {
        clearInterval(window.__QS_UNIFIED_PROGRESS_TIMER);
        window.__QS_UNIFIED_PROGRESS_TIMER = null;
    }
}

/** Upload-zone bar + phase label (upload → transcribe → summary). */
function qsShowPipelineBarChrome() {
    const wrap = document.getElementById('qs-pipeline-phase-wrap');
    const spinnerWrap = document.getElementById('processing-state-spinner-wrap');
    const phaseEl = document.getElementById('processing-state-phase');
    const overlayUnified = document.getElementById('processing-unified-progress');
    if (wrap) wrap.style.display = 'block';
    if (overlayUnified) overlayUnified.style.display = 'none';
    if (spinnerWrap) spinnerWrap.style.display = 'none';
    if (phaseEl) phaseEl.style.display = 'none';
}

function qsHidePipelineBarChrome() {
    const wrap = document.getElementById('qs-pipeline-phase-wrap');
    if (wrap) wrap.style.display = 'none';
    qsClearUnifiedProgressTimer();
    window.__QS_UNIFIED_PROGRESS_PHASE = null;
    qsSetProgressBarPct(0);
}

function qsShowUnifiedProgressChrome() {
    qsShowPipelineBarChrome();
}

function qsHideUnifiedProgressChrome() {
    qsHidePipelineBarChrome();
}

/** One bar in the upload zone: phase label + fill (0–100). */
function qsSetUnifiedProgressPhase(phase, pct) {
    window.__QS_UNIFIED_PROGRESS_PHASE = phase;
    const labelEl = document.getElementById('qs-pipeline-phase-label');
    if (labelEl) labelEl.textContent = qsUnifiedPhaseLabel(phase);
    if (pct != null) qsSetProgressBarPct(pct);
}

function qsAnimateUnifiedProgress(durationMs, capPct) {
    const cap = capPct != null ? capPct : 95;
    const ms = Math.max(1000, Number(durationMs) || QS_PIPELINE_TRANSCRIBE_MS);
    const bar = qsProgressBarElement();
    if (!bar) return null;
    const start = Date.now();
    return setInterval(() => {
        if (!window.isTriggering) return;
        const elapsed = Date.now() - start;
        const pct = Math.min(cap, Math.round((elapsed / ms) * cap));
        qsSetProgressBarPct(pct);
    }, 400);
}

function qsStartUnifiedProgressPhase(phase) {
    qsClearUnifiedProgressTimer();
    qsShowPipelineBarChrome();
    qsSetUnifiedProgressPhase(phase, 0);
    if (phase === 'transcribe') {
        window.__QS_UNIFIED_PROGRESS_TIMER = qsAnimateUnifiedProgress(QS_PIPELINE_TRANSCRIBE_MS, 95);
    } else if (phase === 'summary') {
        window.__QS_UNIFIED_PROGRESS_TIMER = qsAnimateUnifiedProgress(QS_PIPELINE_SUMMARY_MS, 95);
    }
}

function qsCompleteTranscribePipelineProgress() {
    qsClearUnifiedProgressTimer();
    qsSetUnifiedProgressPhase('transcribe', 100);
}

function qsStartSummaryPipelineProgress() {
    qsStartUnifiedProgressPhase('summary');
}

function qsCompleteSummaryPipelineProgress() {
    qsClearUnifiedProgressTimer();
    qsSetUnifiedProgressPhase('summary', 100);
}

function qsShowProcessingPipelineChrome() {
    qsShowPipelineBarChrome();
}

/** Console breadcrumb when processing overlay / fake % animation stops (debug UI freezes). */
function qsLogProcessingAnimStop(kind, detail) {
    try {
        const info =
            typeof detail === 'object' && detail !== null && !Array.isArray(detail)
                ? detail
                : { note: detail };
        console.info('[qs-processing-ui] animation stopped:', kind, Object.assign({
            ts: new Date().toISOString(),
            isTriggering: !!window.isTriggering
        }, info));
    } catch (_) {}
}

function qsStopFakeProgress(reason) {
    if (!window.fakeProgressInterval) {
        return;
    }
    clearInterval(window.fakeProgressInterval);
    window.fakeProgressInterval = null;
    qsLogProcessingAnimStop('fake_progress_bar', { reason: reason != null ? String(reason) : 'unspecified' });
}

function stopProcessingStateUI(reason) {
    const hadPhaseTimer = !!window.processingStateTimer;
    const phaseIndexWhenStopped = Number(window.processingPhaseIndex || 0);
    const panel = document.getElementById('processing-state-panel');
    const controlsRow = document.querySelector('.upload-zone .upload-controls-row');
    qsClearUnifiedProgressTimer();
    qsClearMedicalWarmupWaitTimer();
    qsStopMedicalWarmupPhaseTick();
    window.__QS_MEDICAL_RECORDING_WARMUP_BAR = false;
    qsHidePipelineBarChrome();
    let panelWasVisible = false;
    try {
        if (panel) {
            const st = window.getComputedStyle(panel);
            panelWasVisible = st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
        }
    } catch (_) {}
    if (window.processingStateTimer) {
        clearInterval(window.processingStateTimer);
        window.processingStateTimer = null;
    }
    window.processingPhaseIndex = 0;
    if (panel) panel.style.display = 'none';
    qsSetProcessingOverlayActive(false);
    const twWrap = document.querySelector('.transcript-area-wrap');
    const twOuter = document.querySelector('.transcription-wrapper');
    if (twWrap) twWrap.style.minHeight = '';
    if (twOuter) twOuter.style.minHeight = '';
    if (controlsRow) controlsRow.style.display = '';
    qsLogProcessingAnimStop('phase_lines_panel', {
        reason: reason != null ? String(reason) : 'unspecified',
        hadPhaseTimer,
        phaseIndexWhenStopped,
        panelWasVisible
    });
    qsSyncAppChromeBodyClasses();
}

function qsSetProcessingOverlayActive(active) {
    const on = !!active;
    document.querySelectorAll('.transcript-area-wrap, .transcription-wrapper').forEach((el) => {
        if (el) el.classList.toggle('qs-processing-active', on);
    });
}

function _processingIntroThreeSentencesHe(loggedIn) {
    if (isMedicalModeEnabled()) {
        return loggedIn
            ? 'התמלול והסיכום הרפואי בתהליך — אפשר לסגור את העמוד. נשלח מייל כשיהיה מוכן.'
            : 'כשתתחבר לאתר נוכל להודיע לך באמצעות מייל.';
    }
    return loggedIn ? '' : 'כשתתחבר לאתר נוכל להודיע לך באמצעות מייל.';
}

function _processingIntroThreeSentencesEn(loggedIn) {
    if (isMedicalModeEnabled()) {
        return loggedIn
            ? 'Your transcript and medical summary are processing — you can leave this page. We will email you when ready.'
            : 'Sign in to the site so we can notify you by email when it is ready.';
    }
    return loggedIn ? '' : 'Sign in to the site so we can notify you by email when it is ready.';
}

function startProcessingStateUI() {
    const panel = document.getElementById('processing-state-panel');
    const controlsRow = document.querySelector('.upload-zone .upload-controls-row');
    const phaseEl = document.getElementById('processing-state-phase');
    const introEl = document.getElementById('processing-state-intro');
    const spinnerWrap = document.getElementById('processing-state-spinner-wrap');
    if (!panel) return;

    if (typeof window.hideSubtitleStyleSelector === 'function') window.hideSubtitleStyleSelector();

    if (window.processingStateTimer) {
        clearInterval(window.processingStateTimer);
        window.processingStateTimer = null;
    }

    if (spinnerWrap) spinnerWrap.style.display = 'none';
    if (phaseEl) phaseEl.style.display = 'none';
    window.processingPhaseIndex = 0;
    const showOverlayPanel = typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled();
    panel.style.display = showOverlayPanel ? 'flex' : 'none';
    qsSetProcessingOverlayActive(true);
    qsSyncAppChromeBodyClasses();
    if (controlsRow) controlsRow.style.display = 'none';

    const phase = window.__QS_UNIFIED_PROGRESS_PHASE;
    if (phase !== 'transcribe' && phase !== 'summary' && phase !== 'upload' && phase !== 'warmup') {
        qsStartUnifiedProgressPhase('transcribe');
    } else {
        qsShowPipelineBarChrome();
    }

    if (introEl) {
        const isHe = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
        const setIntro = (loggedIn) => {
            const text = isHe
                ? _processingIntroThreeSentencesHe(loggedIn)
                : _processingIntroThreeSentencesEn(loggedIn);
            introEl.textContent = text;
            introEl.style.display = text ? '' : 'none';
        };
        setIntro(false);
        (async () => {
            let loggedIn = false;
            try {
                if (typeof supabase !== 'undefined' && supabase.auth && typeof supabase.auth.getSession === 'function') {
                    const { data } = await supabase.auth.getSession();
                    loggedIn = !!(data && data.session && data.session.user);
                }
            } catch (_) {}
            setIntro(loggedIn);
        })();
    }
}

/** Stop polling/UI for the current in-flight job without waiting for gpu_callback (browser console: qsDismissActiveJob()). */
window.qsDismissActiveJob = function () {
    if (window._checkStatusPollInterval) {
        clearInterval(window._checkStatusPollInterval);
        window._checkStatusPollInterval = null;
    }
    window.isTriggering = false;
    window._triggerRetriedForJobId = null;
    qsStopFakeProgress('dismiss_active_job');
    window._medicalWarmupSession = null;
    window._medicalWarmupPromise = null;
    if (typeof window.qsClearActiveJob === 'function') {
        window.qsClearActiveJob();
    } else {
        ['activeJobId', 'pendingJobId', 'pendingS3Key'].forEach((k) => {
            try { localStorage.removeItem(k); } catch (_) {}
        });
    }
    if (typeof stopProcessingStateUI === 'function') stopProcessingStateUI('dismiss_active_job');
    const mb = document.getElementById('main-btn');
    if (mb) mb.disabled = false;
    if (typeof setDiarizationBusyState === 'function') setDiarizationBusyState(false);
    console.info('[qs] dismissed active job; lastJobId/lastS3Key kept for library reopen');
};

/** Reset the main screen to initial state (as on first load) — e.g. when user clicks Upload to start a new file. */
function resetScreenToInitial() {
    try { window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON = false; } catch (_) {}
    try { window.__QS_FILE_PICKER_PURPOSE = 'new_upload'; } catch (_) {}
    window.isTriggering = false;
    qsStopFakeProgress('reset_screen_to_initial');
    window.currentSegments = [];
    window.currentWords = null;
    window.currentCaptions = null;
    window._qsShowEmptyTranscriptNotice = false;
    window._medicalHasResult = false;
    window.currentFormattedDoc = null;
    window._qsDocPreferSegmentsAfterEdit = false;
    try { window.__QS_UPLOAD_PREVIEW_READY = false; } catch (_) {}
    setSeoHomeContentVisibility(true);
    stopProcessingStateUI('reset_screen_to_initial');

    const placeholder = document.getElementById('placeholder');
    const transcriptWindow = document.getElementById('transcript-window');
    const pContainer = document.getElementById('p-container');
    const statusTxt = document.getElementById('upload-status');
    const mainBtn = document.getElementById('main-btn');
    const preparingScreen = document.getElementById('preparing-screen');
    const audioPlayerContainer = document.getElementById('audio-player-container');
    const audioSource = document.getElementById('audio-source');
    const mainAudio = document.getElementById('main-audio');
    const videoWrapper = document.getElementById('video-wrapper');
    const mainVideo = document.getElementById('main-video');
    const videoSource = document.getElementById('video-source');
    const editActions = document.getElementById('edit-actions');

    if (preparingScreen) preparingScreen.style.display = 'none';
    hideProgressBar();
    if (statusTxt) {
        statusTxt.style.display = 'block';
        statusTxt.innerText = typeof window.t === 'function' ? window.t('ready') : 'Ready';
    }
    if (mainBtn) {
        setMainButtonAction('upload');
    }
    try { qsSyncStarterPlanUploadGate(); } catch (_) {}

    if (transcriptWindow) {
        qsClearTranscriptEditState(transcriptWindow);
        qsClearTranscriptWindowIdle();
    }
    if (placeholder) placeholder.style.display = 'none';

    if (audioPlayerContainer) audioPlayerContainer.style.display = 'none';
    if (audioSource) audioSource.removeAttribute('src');
    if (mainAudio) mainAudio.load();
    _qsRevokeLocalPreviewAudio();
    try { localStorage.removeItem('currentAudioUrl'); } catch (_) {}
    try { localStorage.removeItem('currentAudioMime'); } catch (_) {}

    if (videoWrapper) {
        videoWrapper.style.display = 'none';
        videoWrapper.classList.remove('visible');
    }
    if (mainVideo) {
        mainVideo.style.display = 'none';
        if (mainVideo.src) mainVideo.removeAttribute('src');
        const vs = mainVideo.querySelector('source');
        if (vs) vs.removeAttribute('src');
    }
    if (videoSource) videoSource.removeAttribute('src');

    if (editActions) editActions.style.display = 'none';

    if (typeof window.hideSubtitleStyleSelector === 'function') window.hideSubtitleStyleSelector();
    if (typeof setTranscriptActionButtonsVisible === 'function') setTranscriptActionButtonsVisible(false);
    try { document.body.classList.remove('qs-transcript-present'); } catch (_) {}
    try { document.body.classList.remove('qs-app-busy'); } catch (_) {}
    qsSyncAppChromeBodyClasses();
    try { document.body.classList.remove('mobile-video-session'); } catch (_) {}
    try { if (typeof window.syncMedicalPrimaryActionBtn === 'function') window.syncMedicalPrimaryActionBtn(); } catch (_) {}
    if (typeof syncSpeakerControls === 'function') syncSpeakerControls();
}

/** Show upload-zone pipeline bar and scroll it into view. */
function showProgressBar() {
    const keepWarmupBarForPostRecord =
        window.__QS_MEDICAL_RECORDING_WARMUP_BAR
        && window.__QS_MEDICAL_WARMUP_STATE !== 'ready';
    if (!keepWarmupBarForPostRecord) {
        window.__QS_MEDICAL_RECORDING_WARMUP_BAR = false;
        qsStopMedicalWarmupPhaseTick();
    }
    qsHideMedicalWarmupBanner();
    qsShowPipelineBarChrome();
    qsSetUnifiedProgressPhase('upload', 0);
    const wrap = document.getElementById('qs-pipeline-phase-wrap');
    if (wrap) {
        setTimeout(() => { wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
    }
}

function hideProgressBar() {
    qsHidePipelineBarChrome();
}

function qsHasTranscriptResult() {
    return !!(
        (Array.isArray(window.currentSegments) && window.currentSegments.length > 0)
        || (Array.isArray(window.currentWords) && window.currentWords.length > 0)
    );
}

function qsSyncAppChromeBodyClasses() {
    try {
        const hasTranscript = qsHasTranscriptResult() || document.body.classList.contains('has-transcript-actions');
        document.body.classList.toggle('qs-app-busy', !!window.isTriggering);
        document.body.classList.toggle('qs-transcript-present', !!hasTranscript);
    } catch (_) {}
}

/** Idempotent: show export/format toolbar whenever transcript data exists (guards intermittent races). */
function qsEnsureTranscriptToolbarVisible(reason, opts) {
    opts = opts || {};
    if (!qsHasTranscriptResult()) return false;
    if (!opts.force && window.isTriggering) return false;
    try { qsSetProcessingOverlayActive(false); } catch (_) {}
    try {
        if (typeof setTranscriptActionButtonsVisible === 'function') {
            setTranscriptActionButtonsVisible(true);
        }
    } catch (_) {}
    try { document.body.classList.add('qs-transcript-present'); } catch (_) {}
    qsSyncAppChromeBodyClasses();
    if (reason) {
        console.info('[qs-transcript-toolbar] ensured visible', { reason: String(reason) });
    }
    try {
        const bar = document.querySelector('.transcription-wrapper .controls-bar.is-visible');
        if (bar && typeof bar.scrollIntoView === 'function') {
            bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    } catch (_) {}
    return true;
}

function qsScheduleTranscriptToolbarEnsure(reason, opts) {
    const run = () => { qsEnsureTranscriptToolbarVisible(reason, opts); };
    try {
        requestAnimationFrame(() => requestAnimationFrame(run));
    } catch (_) {
        setTimeout(run, 0);
    }
    setTimeout(() => { qsEnsureTranscriptToolbarVisible(reason, Object.assign({ force: true }, opts || {})); }, 400);
    setTimeout(() => { qsEnsureTranscriptToolbarVisible(reason, Object.assign({ force: true }, opts || {})); }, 2000);
}

function qsInvokeHandleJobUpdate(data) {
    if (typeof window.handleJobUpdate !== 'function') return Promise.resolve();
    return Promise.resolve(window.handleJobUpdate(data)).catch((err) => {
        console.error('[qs] handleJobUpdate unhandled error', err);
        try { window.isTriggering = false; } catch (_) {}
        try {
            if (typeof stopProcessingStateUI === 'function') {
                stopProcessingStateUI('handle_job_update_unhandled_error');
            }
        } catch (_) {}
        if (qsHasTranscriptResult()) {
            qsEnsureTranscriptToolbarVisible('handleJobUpdate_unhandled_error', { force: true });
            qsScheduleTranscriptToolbarEnsure('handleJobUpdate_unhandled_error_deferred', { force: true });
            const mainBtn = document.getElementById('main-btn');
            if (mainBtn) {
                mainBtn.disabled = false;
                if (typeof setMainButtonAction === 'function') setMainButtonAction('new_session');
            }
        }
        try {
            const jobId = data && (data.jobId || (data.result && data.result.jobId));
            if (jobId) window._handleJobUpdateInFlight = null;
        } catch (_) {}
    });
}

function setTranscriptActionButtonsVisible(visible) {
    const downloadBtn = document.getElementById('btn-download');
    const editBtn = document.getElementById('btn-edit') || document.querySelector('.toolbar-group button[onclick="window.toggleEditMode()"]');
    const translateBtn = document.getElementById('btn-translate');
    const medicalNewSessionBtn = document.getElementById('medical-toolbar-new-session-btn');
    const togglesGroup = document.querySelector('.switches-top-bar .toggles-group') || document.querySelector('.controls-bar .toggles-group');
    const switchesTopBar = document.querySelector('.switches-top-bar');
    const controlsBar = document.querySelector('.controls-bar');
    const editActions = document.getElementById('edit-actions');
    const downloadMenu = document.getElementById('download-menu');

    [downloadBtn, editBtn, translateBtn].forEach((el) => {
        if (el) el.style.display = visible ? '' : 'none';
    });
    if (medicalNewSessionBtn) {
        const showMedicalNewSession = !!(
            visible &&
            typeof isMedicalModeEnabled === 'function' &&
            isMedicalModeEnabled()
        );
        medicalNewSessionBtn.style.display = showMedicalNewSession ? 'inline-flex' : 'none';
        medicalNewSessionBtn.classList.toggle('is-visible', showMedicalNewSession);
    }
    if (togglesGroup) togglesGroup.style.display = visible ? '' : 'none';
    if (switchesTopBar) switchesTopBar.classList.toggle('is-visible', !!visible);
    if (controlsBar) {
        controlsBar.style.display = '';
        controlsBar.classList.toggle('is-visible', !!visible);
    }
    if (visible) {
        try { qsSetProcessingOverlayActive(false); } catch (_) {}
    }
    if (!visible) {
        try { qsClearTranscriptEditState(); } catch (_) {}
        if (typeof window.hideSubtitleStyleSelector === 'function') window.hideSubtitleStyleSelector();
        if (editActions) editActions.style.display = 'none';
        if (downloadMenu) downloadMenu.style.display = 'none';
        setExportMenuAuxiliaryControlsDisabled(false);
    }
    try {
        document.body.classList.toggle('has-transcript-actions', !!visible);
        document.body.classList.toggle('qs-transcript-present', !!visible || qsHasTranscriptResult());
    } catch (_) {}
    if (visible) {
        try {
            if (typeof window.showSubtitleStyleSelector === 'function') window.showSubtitleStyleSelector();
        } catch (_) {}
    }
    qsSyncAppChromeBodyClasses();
}

/** While the export menu is open, disable other transcript toolbar controls. */
function setExportMenuAuxiliaryControlsDisabled(disabled) {
    const fmtSub = document.getElementById('format-mode-subtitle');
    const fmtDoc = document.getElementById('format-mode-doc');
    const fmtSummary = document.getElementById('format-mode-summary');
    const editBtn = document.getElementById('btn-edit');
    const subStyleToggle = document.getElementById('subtitle-style-toggle');
    const medicalNewSessionBtn = document.getElementById('medical-toolbar-new-session-btn');
    [fmtSub, fmtDoc, fmtSummary, editBtn, subStyleToggle, medicalNewSessionBtn].forEach((el) => {
        if (!el) return;
        el.disabled = !!disabled;
    });
    const subPanel = document.getElementById('subtitle-style-drawer');
    if (subPanel && disabled) subPanel.classList.remove('is-open');
}

document.addEventListener('DOMContentLoaded', () => {
    qsEnsureUploadConfirmModalInBody();
    const transcriptWindow = document.getElementById('transcript-window');
    if (transcriptWindow && transcriptWindow.dataset.qsCopyAnalyticsBound !== '1') {
        transcriptWindow.dataset.qsCopyAnalyticsBound = '1';
        transcriptWindow.addEventListener('copy', () => {
            if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) return;
            if (isSummaryViewEnabled()) return;
            qsTrackEvent('transcript_copied');
        });
    }
    const fileInput = document.getElementById('fileInput');
    const medicalRecordWrap = document.getElementById('medical-recording-wrap');
    const medicalRecordBtn = document.getElementById('medical-record-btn');
    const medicalRecordOuter = medicalRecordBtn ? medicalRecordBtn.querySelector('.medical-record-outer') : null;
    const medicalRecordShape = document.getElementById('medical-record-shape');
    const medicalRecordMicSvg = document.getElementById('medical-record-mic-svg');
    const medicalRecordPauseSymbol = document.getElementById('medical-record-pause-symbol');
    const medicalRecordNewSessionLabel = document.getElementById('medical-record-new-session-label');
    const medicalCancelBtn = document.getElementById('medical-cancel-btn');
    const medicalConfirmBtn = document.getElementById('medical-confirm-btn');
    const medicalCancelStack = document.getElementById('medical-cancel-stack');
    const medicalConfirmStack = document.getElementById('medical-confirm-stack');
    const medicalRecordTimer = document.getElementById('medical-record-timer');
    const medicalRecordingTimerSlot = document.getElementById('medical-recording-timer-slot');
    const medicalDeleteConfirmModal = document.getElementById('medical-delete-confirm-modal');
    const medicalDeleteConfirmYes = document.getElementById('medical-delete-confirm-yes');
    const medicalDeleteConfirmNo = document.getElementById('medical-delete-confirm-no');
    const medicalTabsWrap = document.getElementById('medical-result-tabs');
    const medicalTabTranscript = document.getElementById('medical-tab-transcript');
    const medicalTabSummary = document.getElementById('medical-tab-summary');
    const medicalCopyBtn = document.getElementById('medical-copy-btn');
    const translateBtn = document.getElementById('btn-translate');
    const medicalToolbarNewSessionBtn = document.getElementById('medical-toolbar-new-session-btn');
    const mobileSessionBtn = document.getElementById('mobile-new-session-btn');
    const navNewSessionBtn = document.getElementById('nav-new-session-btn');
    const statusTxt = document.getElementById('upload-status');
    const mainBtn = document.getElementById('main-btn');
    const regularRecordBtn = document.getElementById('regular-record-btn');
    const diarizationToggle = document.getElementById('diarization-toggle');
    const speakerToggle = document.getElementById('toggle-speaker');
    const mainAudio = document.getElementById('main-audio');
    setTranscriptActionButtonsVisible(false);
    if (typeof syncSeoBlockWithAppState === 'function') {
        syncSeoBlockWithAppState();
    }
    if (translateBtn) {
        translateBtn.addEventListener('click', (event) => {
            event.preventDefault();
            void runUserRequestedTranslation();
        });
    }
    window.medicalActiveTab = window.medicalActiveTab || 'summary';
    window._medicalRecorder = null;
    window._medicalRecorderChunks = [];
    window._medicalRecorderSegments = [];
    window._medicalRecorderTimer = null;
    window._medicalRecordingStartedAt = 0;
    window._medicalRecordingAccumMs = 0;
    window._medicalRecorderPaused = false;
    window._medicalSubmitOnStop = false;
    /** True only while the user explicitly tapped pause — distinguishes OS/call interruption from manual pause. */
    window._medicalPauseUserIntent = false;
    /** True when the MediaRecorder was paused by the system (e.g. incoming phone call) so we can auto-resume when possible. */
    window._medicalSystemRecordingInterrupted = false;
    window._medicalRollingRestart = false;
    window._medicalRestartInProgress = false;
    window._medicalResumeRetryTimer = null;
    window._medicalWarmupSession = null;
    window._medicalWarmupPromise = null;
    window._medicalWarmupToken = 0;
    window._medicalWave = window._medicalWave || null;
    window._qsRegularRecordVisible = false;
    if (medicalRecordTimer) medicalRecordTimer.style.display = 'none';

    function updateMedicalTabUi() {
        if (!medicalTabsWrap) return;
        const hasSegments = Array.isArray(window.currentSegments) && window.currentSegments.length > 0;
        const hasWordModel = Array.isArray(window.currentWords) && window.currentWords.length > 0
            && Array.isArray(window.currentCaptions) && window.currentCaptions.length > 0;
        const hasFormattedSummary = !!(
            window.currentFormattedDoc &&
            (
                String(window.currentFormattedDoc.overview || '').trim() ||
                (Array.isArray(window.currentFormattedDoc.key_points) && window.currentFormattedDoc.key_points.length > 0) ||
                (Array.isArray(window.currentFormattedDoc.action_items) && window.currentFormattedDoc.action_items.length > 0) ||
                String(window.currentFormattedDoc.medical_chief_complaint || '').trim() ||
                String(window.currentFormattedDoc.medical_examination_transcript || '').trim() ||
                String(window.currentFormattedDoc.medical_patient_recommendations || '').trim()
            )
        );
        const hasTranscript = hasSegments || hasWordModel;
        const showTabs = isMedicalModeEnabled() && (hasTranscript || hasFormattedSummary || window._medicalHasResult === true);
        medicalTabsWrap.style.display = showTabs ? 'flex' : 'none';
        if (medicalCopyBtn) medicalCopyBtn.style.display = showTabs ? 'inline-flex' : 'none';
        if (!showTabs) return;
        // In medical mode, summary should be the main/default tab, including simulation.
        if (!window.medicalActiveTab) {
            window.medicalActiveTab = hasFormattedSummary ? 'summary' : 'transcript';
        }
        const isSummary = String(window.medicalActiveTab || 'summary') === 'summary';
        if (medicalTabTranscript) medicalTabTranscript.classList.toggle('is-active', !isSummary);
        if (medicalTabSummary) medicalTabSummary.classList.toggle('is-active', isSummary);
        try { if (typeof syncMedicalPrimaryActionBtn === 'function') syncMedicalPrimaryActionBtn(); } catch (_) {}
    }
    window.refreshMedicalTabs = updateMedicalTabUi;
    function syncRegularRecordUi() {
        if (!regularRecordBtn) return;
        const canShow = !isMedicalModeEnabled() && !window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON;
        regularRecordBtn.style.display = canShow ? 'inline-flex' : 'none';
        const rec = window._medicalRecorder;
        if (canShow && rec && (rec.state === 'recording' || rec.state === 'paused')) {
            regularRecordBtn.textContent = '⏸️ Recording...';
        } else {
            regularRecordBtn.textContent = '🎤 Record audio';
        }
    }

    async function loadTranscriptJsonFile(file, options = {}) {
        if (!file) return false;
        const text = await file.text();
        const tr = JSON.parse(text || '{}');
        const words = Array.isArray(tr.words) ? tr.words : null;
        const captions = Array.isArray(tr.captions) ? tr.captions : null;
        const segments = Array.isArray(tr.segments) ? tr.segments : [];
        const trFmt = pickFormattedFromObject(tr);
        window.currentFormattedDoc = trFmt || null;
        window._qsDocPreferSegmentsAfterEdit = false;

        if (words && captions && words.length > 0 && captions.length > 0) {
            window.currentWords = words;
            window.currentCaptions = captions;
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        } else if (segments.length > 0) {
            const model = _tryBuildWordModelFromSegmentsAndFlat(segments, tr.word_segments);
            if (model) {
                window.currentWords = model.words;
                window.currentCaptions = model.captions;
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            } else {
                window.currentWords = null;
                window.currentCaptions = null;
                window.currentSegments = segments;
            }
        } else if (trFmt) {
            window.currentWords = null;
            window.currentCaptions = null;
            window.currentSegments = [];
        } else {
            throw new Error('JSON must include segments[], words[]+captions[], or formatted medical fields');
        }

        window.uploadWasVideo = false;
        window.originalFileName = String(file.name || '').replace(/\.json$/i, '') || 'transcript';
        if (isMedicalModeEnabled()) {
            window._medicalHasResult = true;
            window.medicalActiveTab = trFmt ? 'summary' : 'transcript';
            try { window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON = false; } catch (_) {}
            setTranscriptActionButtonsVisible(true);
            try { if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi(); } catch (_) {}
            if (typeof renderTranscriptFromCues === 'function') {
                renderTranscriptFromCues(window.currentSegments || []);
            } else if (typeof window.render === 'function') {
                window.render();
            }
            updateMedicalTabUi();
        } else {
            try { window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON = true; } catch (_) {}
            // Keep export / format toolbar hidden until local video or audio is attached.
            setTranscriptActionButtonsVisible(false);
            const transcriptWindow = document.getElementById('transcript-window');
            if (transcriptWindow) {
                if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length > 0 && window.currentCaptions.length > 0) {
                    renderWordCaptionEditor();
                } else if (typeof window.render === 'function') {
                    window.render();
                }
            }
        }
        syncSpeakerControls();
        if (mainBtn) mainBtn.disabled = false;
        setDiarizationBusyState(false);
        hideProgressBar();
        if (typeof setMainButtonAction === 'function') setMainButtonAction('upload');
        if (typeof window.applyMedicalModeUi === 'function') {
            try { window.applyMedicalModeUi(); } catch (_) {}
        }
        const hasTranscriptForMedicalSummary = String(buildTranscriptTextForGptFormat() || '').trim();
        const shouldGenerateMissingMedicalSummary = (
            isMedicalModeEnabled() &&
            !medicalFormattedDocHasSummary(window.currentFormattedDoc) &&
            !!hasTranscriptForMedicalSummary
        );
        if (shouldGenerateMissingMedicalSummary && typeof ensureFormattedViaApiForExport === 'function') {
            await ensureFormattedViaApiForExport();
        } else if (typeof showStatus === 'function') {
            showStatus('JSON transcript loaded locally.', false, { duration: 5000 });
        }
        if (!isMedicalModeEnabled() && !(options && options.skipScroll)) {
            try {
                document.querySelector('.upload-zone .upload-controls-row')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (_) {}
        }
        return true;
    }

    function medicalFormattedDocHasSummary(fmt) {
        if (!fmt || typeof fmt !== 'object') return false;
        if (String(fmt.medical_chief_complaint || '').trim()) return true;
        if (String(fmt.medical_examination_transcript || '').trim()) return true;
        if (String(fmt.medical_patient_recommendations || '').trim()) return true;
        if (String(fmt.overview || '').trim()) return true;
        const points = fmt.key_points;
        return Array.isArray(points) && points.some((p) => String(p || '').trim());
    }

    function medicalJsonDropFileFromEvent(e) {
        const files = e && e.dataTransfer && e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
        return files.find(isTranscriptJsonFile) || files.find(isMedicalAudioFile) || files[0] || null;
    }

    function isTranscriptJsonFile(file) {
        return !!(
            file &&
            ((file.type && file.type.includes('json')) || /\.json$/i.test(file.name || ''))
        );
    }

    function isMedicalAudioFile(file) {
        return !!(file && qsIsAudioMediaFile(file));
    }

    function medicalJsonDragHasFile(e) {
        const dt = e && e.dataTransfer;
        if (!dt) return false;
        if (dt.files && dt.files.length > 0) return true;
        const types = dt.types ? Array.from(dt.types) : [];
        return types.some((t) => String(t || '').toLowerCase() === 'files');
    }

    function handleMedicalJsonDropEvent(e, evtName) {
        if (!isMedicalModeEnabled() || !medicalJsonDragHasFile(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (evtName !== 'drop') return;
        if (e._qsMedicalJsonDropHandled) return;
        e._qsMedicalJsonDropHandled = true;
        if (window.isTriggering) {
            if (typeof showStatus === 'function') showStatus('A transcription is already running.', true);
            return;
        }
        const file = medicalJsonDropFileFromEvent(e);
        if (!file) return;
        if (isTranscriptJsonFile(file)) {
            loadTranscriptJsonFile(file, { source: 'medical_drop', skipScroll: true }).catch((err) => {
                console.warn('Medical JSON transcript load failed', err);
                if (typeof showStatus === 'function') showStatus(`Failed to load JSON: ${err.message || err}`, true);
            });
            return;
        }
        if (isMedicalAudioFile(file)) {
            const rec = window._medicalRecorder;
            if (rec && rec.state && rec.state !== 'inactive') {
                if (typeof showStatus === 'function') showStatus('Finish or cancel the current recording before uploading audio.', true);
                return;
            }
            try {
                resetScreenToInitial();
                if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi();
                window.__QS_FILE_PICKER_PURPOSE = 'new_upload';
            } catch (_) {}
            pushFileIntoPickerAndUpload(file).catch((err) => {
                console.warn('Medical audio upload failed', err);
                if (typeof showStatus === 'function') showStatus(`Failed to upload audio: ${err.message || err}`, true);
            });
            return;
        }
        if (typeof showStatus === 'function') showStatus('Please drop a JSON transcript or audio file (M4A, MP3, WAV, etc.).', true);
    }

    ['dragenter', 'dragover', 'drop'].forEach((evtName) => {
        document.addEventListener(evtName, (e) => handleMedicalJsonDropEvent(e, evtName), true);
    });

    window.applyMedicalModeUi = function() {
        const on = isMedicalModeEnabled();
        const mainAppContainer = document.getElementById('main-app-container');
        const medicalHeader = document.getElementById('medical-session-header');
        const medicalTitle = document.getElementById('medical-session-title');
        const medicalSubtitle = document.getElementById('medical-session-subtitle');
        const seoHome = document.getElementById('seo-home-content');
        const downloadBtnLabel = document.querySelector('#btn-download .btn-download-label');
        if (medicalRecordWrap) {
            const rec = window._medicalRecorder;
            const recActive = !!(rec && (rec.state === 'recording' || rec.state === 'paused'));
            const showRegularRecWrap = (!on && (window._qsRegularRecordVisible || recActive));
            const showNewSessionOnly = !!(
                on
                && window._medicalHasResult === true
                && !recActive
                && !window.isTriggering
            );
            medicalRecordWrap.style.display = showNewSessionOnly
                ? 'none'
                : ((on || showRegularRecWrap) ? '' : 'none');
        }
        const medicalUploadNewSessionBtn = document.getElementById('medical-upload-new-session-btn');
        if (medicalUploadNewSessionBtn) {
            const rec = window._medicalRecorder;
            const recActive = !!(rec && (rec.state === 'recording' || rec.state === 'paused'));
            const showNewSessionOnly = !!(
                on
                && window._medicalHasResult === true
                && !recActive
                && !window.isTriggering
            );
            medicalUploadNewSessionBtn.style.display = showNewSessionOnly ? '' : 'none';
        }
        if (mainAppContainer) {
            const rec = window._medicalRecorder;
            const recActive = !!(rec && (rec.state === 'recording' || rec.state === 'paused'));
            const showNewSessionOnly = !!(
                on
                && window._medicalHasResult === true
                && !recActive
                && !window.isTriggering
            );
            mainAppContainer.classList.toggle('medical-has-session-result', showNewSessionOnly);
        }
        if (mainBtn) {
            const allowMediaAfterLocalJson = !!window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON;
            if (on && !allowMediaAfterLocalJson) {
                mainBtn.style.display = 'none';
            } else {
                mainBtn.style.display = '';
            }
            if (allowMediaAfterLocalJson) {
                const T = typeof window.t === 'function' ? window.t : function(k) { return k; };
                mainBtn.innerText = T('add_local_media') || 'Add video or audio';
            }
        }
        const T = typeof window.t === 'function' ? window.t : function(k) { return k; };
        if (downloadBtnLabel) downloadBtnLabel.textContent = on
            ? (T('download_docx') || 'Download as Docx')
            : (T('export_and_download') || 'Export and download');
        if (on) {
            if (seoHome) seoHome.style.display = 'none';
        } else {
            if (typeof syncSeoBlockWithAppState === 'function') {
                syncSeoBlockWithAppState();
            } else if (seoHome) {
                seoHome.style.display = 'none';
            }
        }
        if (mainAppContainer) mainAppContainer.classList.toggle('medical-mode', on);
        if (medicalHeader) medicalHeader.style.display = on ? '' : 'none';
        if (medicalTitle) medicalTitle.textContent = T('medical_session_secure_recording') || 'Secure medical recording session';
        if (medicalSubtitle) medicalSubtitle.textContent = T('medical_session_hipaa_active') || 'Clinical transcription with HIPAA mode active';
        if (!on) {
            if (typeof qsSetMedicalWarmupBanner === 'function') qsSetMedicalWarmupBanner('hidden');
            if (window.__QS_MEDICAL_WARMUP_POLL_TIMER) {
                clearInterval(window.__QS_MEDICAL_WARMUP_POLL_TIMER);
                window.__QS_MEDICAL_WARMUP_POLL_TIMER = null;
            }
        } else if (window.__QS_MEDICAL_WARMUP_STATE === 'ready') {
            if (typeof qsSetMedicalWarmupBanner === 'function') qsSetMedicalWarmupBanner('ready');
            const warmUid = String(window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
            if (warmUid) {
                if (typeof qsStartMedicalWarmupReadyRecheck === 'function') {
                    qsStartMedicalWarmupReadyRecheck(warmUid, window.__QS_MEDICAL_WARMUP_JOB_ID);
                }
                void qsPollMedicalWarmupStatus(warmUid, window.__QS_MEDICAL_WARMUP_JOB_ID);
            }
        } else if (
            window.__QS_MEDICAL_WARMUP_STATE === 'preparing'
            || window.__QS_MEDICAL_WARMUP_STATE === 'starting'
            || window.__QS_MEDICAL_WARMUP_STATE === 'off'
        ) {
            if (typeof qsSetMedicalWarmupBanner === 'function') {
                qsSetMedicalWarmupBanner(
                    window.__QS_MEDICAL_WARMUP_STATE === 'off' ? 'off' : 'preparing'
                );
            }
            const warmUid = String(window.__QS_MEDICAL_WARMUP_USER_ID || '').trim();
            if (warmUid && !window.__QS_MEDICAL_WARMUP_POLL_TIMER && typeof qsStartMedicalWarmupPoll === 'function') {
                qsStartMedicalWarmupPoll(warmUid, window.__QS_MEDICAL_WARMUP_JOB_ID);
            }
        }
        if (on) {
            const hasLoadedPayload = typeof initOpenAppHasLoadedTranscriptPayload === 'function'
                ? initOpenAppHasLoadedTranscriptPayload()
                : false;
            if (!hasLoadedPayload) window.medicalActiveTab = 'summary';
            try {
                if (typeof window.hideSubtitleStyleSelector === 'function') window.hideSubtitleStyleSelector();
                if (typeof window.toggleSubtitleStyleDrawer === 'function') window.toggleSubtitleStyleDrawer(false);
            } catch (_) {}
            // Existing transcript may still be regular word/caption HTML; repaint medical summary / clinical transcript.
            try {
                if (typeof window._qsRerenderTranscriptView === 'function') {
                    window._qsRerenderTranscriptView();
                }
            } catch (_) {}
        } else {
            try {
                const tw = document.getElementById('transcript-window');
                if (tw) tw.classList.remove('medical-wave-active');
            } catch (_) {}
            try {
                if (typeof setTranscriptActionButtonsVisible === 'function' && typeof initOpenAppHasLoadedTranscriptPayload === 'function') {
                    if (!window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON) {
                        setTranscriptActionButtonsVisible(!!initOpenAppHasLoadedTranscriptPayload());
                    }
                }
            } catch (_) {}
            try {
                if (typeof window._qsRerenderTranscriptView === 'function') {
                    window._qsRerenderTranscriptView();
                }
            } catch (_) {}
        }
        try {
            if (window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON && typeof setTranscriptActionButtonsVisible === 'function') {
                setTranscriptActionButtonsVisible(false);
            }
        } catch (_) {}
        updateMedicalTabUi();
        try { if (typeof syncStandardFormatTabs === 'function') syncStandardFormatTabs(); } catch (_) {}
        syncRegularRecordUi();
        try { if (typeof syncMedicalPrimaryActionBtn === 'function') syncMedicalPrimaryActionBtn(); } catch (_) {}
        try { qsSyncStarterPlanUploadGate(); } catch (_) {}
        try { qsSyncUserCreditsUi(); } catch (_) {}
    };

    function stopMedicalRecordingTimer() {
        if (window._medicalRecorderTimer) {
            clearInterval(window._medicalRecorderTimer);
            window._medicalRecorderTimer = null;
        }
    }

    function renderMedicalRecordingTimer() {
        const timerTarget = medicalRecordingTimerSlot || medicalRecordTimer;
        if (!timerTarget) return;
        const base = Number(window._medicalRecordingAccumMs || 0);
        const runningDelta = window._medicalRecorderPaused
            ? 0
            : Math.max(0, Date.now() - Number(window._medicalRecordingStartedAt || 0));
        const elapsedMs = Math.max(0, base + runningDelta);
        const totalSec = Math.floor(elapsedMs / 1000);
        const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
        const ss = String(totalSec % 60).padStart(2, '0');
        timerTarget.textContent = `${mm}:${ss}`;
    }

    function setMedicalTimerVisibility(show) {
        if (!medicalRecordTimer && !medicalRecordingTimerSlot) return;
        if (show) {
            if (medicalRecordingTimerSlot) {
                medicalRecordingTimerSlot.style.display = 'flex';
                medicalRecordingTimerSlot.style.visibility = 'visible';
            } else if (medicalRecordTimer) {
                medicalRecordTimer.style.visibility = 'visible';
            }
            return;
        }
        if (medicalRecordingTimerSlot) {
            medicalRecordingTimerSlot.style.visibility = 'hidden';
            medicalRecordingTimerSlot.style.display = 'none';
            medicalRecordingTimerSlot.textContent = '';
        }
        if (medicalRecordTimer) {
            medicalRecordTimer.style.visibility = 'hidden';
            medicalRecordTimer.textContent = '';
        }
    }

    function attachMedicalRecordingTimerSlot() {
        if (!medicalRecordingTimerSlot) return;
        const transcriptWindowEl = document.getElementById('transcript-window');
        if (transcriptWindowEl && medicalRecordingTimerSlot.parentNode !== transcriptWindowEl) {
            transcriptWindowEl.appendChild(medicalRecordingTimerSlot);
        }
        medicalRecordingTimerSlot.style.display = 'flex';
    }

    function detachMedicalRecordingTimerSlot() {
        if (!medicalRecordingTimerSlot) return;
        const shell = document.querySelector('.medical-transcript-shell');
        if (shell && medicalRecordingTimerSlot.parentNode !== shell) {
            shell.appendChild(medicalRecordingTimerSlot);
        }
        medicalRecordingTimerSlot.style.display = 'none';
    }

    function confirmMedicalDeleteRecording() {
        return new Promise((resolve) => {
            if (!medicalDeleteConfirmModal || !medicalDeleteConfirmYes || !medicalDeleteConfirmNo) {
                const T = typeof window.t === 'function' ? window.t : function(k) { return k; };
                resolve(window.confirm(T('medical_delete_recording_message') || 'Are you sure you want to delete this recording?'));
                return;
            }
            medicalDeleteConfirmModal.style.display = 'flex';
            medicalDeleteConfirmModal.setAttribute('aria-hidden', 'false');
            const cleanup = () => {
                medicalDeleteConfirmModal.style.display = 'none';
                medicalDeleteConfirmModal.setAttribute('aria-hidden', 'true');
                medicalDeleteConfirmYes.removeEventListener('click', onYes);
                medicalDeleteConfirmNo.removeEventListener('click', onNo);
                medicalDeleteConfirmModal.removeEventListener('click', onBackdrop);
                document.removeEventListener('keydown', onEsc);
            };
            const onYes = () => {
                cleanup();
                resolve(true);
            };
            const onNo = () => {
                cleanup();
                resolve(false);
            };
            const onBackdrop = (e) => {
                if (e.target === medicalDeleteConfirmModal) onNo();
            };
            const onEsc = (e) => {
                if (e.key === 'Escape') onNo();
            };
            medicalDeleteConfirmYes.addEventListener('click', onYes);
            medicalDeleteConfirmNo.addEventListener('click', onNo);
            medicalDeleteConfirmModal.addEventListener('click', onBackdrop);
            document.addEventListener('keydown', onEsc);
        });
    }

    function setMedicalRecordingVisualState(mode) {
        const isRecording = mode === 'recording';
        const isPaused = mode === 'paused';
        const isIdle = mode === 'idle';
        const isActive = isRecording || isPaused;
        if (medicalRecordShape) {
            medicalRecordShape.classList.toggle('medical-record-shape-pause', isActive);
        }
        if (medicalRecordOuter) {
            medicalRecordOuter.classList.toggle('is-idle', isIdle);
            medicalRecordOuter.classList.toggle('is-recording', isRecording);
            medicalRecordOuter.classList.toggle('is-paused', isPaused);
        }
        if (medicalRecordMicSvg) medicalRecordMicSvg.style.display = isPaused || !isActive ? '' : 'none';
        if (medicalRecordPauseSymbol) medicalRecordPauseSymbol.style.display = (!isPaused && isActive) ? '' : 'none';
        if (medicalCancelStack) medicalCancelStack.style.display = isPaused ? 'flex' : 'none';
        if (medicalConfirmStack) medicalConfirmStack.style.display = isPaused ? 'flex' : 'none';
        if (medicalRecordShape) medicalRecordShape.style.opacity = '1';
        syncMedicalPrimaryActionBtn();
    }

    function syncMedicalPrimaryActionBtn() {
        if (!medicalRecordBtn || !isMedicalModeEnabled()) {
            if (medicalRecordBtn) medicalRecordBtn.classList.remove('is-new-session');
            return;
        }
        medicalRecordBtn.classList.remove('is-new-session');
        if (medicalRecordMicSvg) medicalRecordMicSvg.style.display = '';
        if (medicalRecordNewSessionLabel) medicalRecordNewSessionLabel.style.display = 'none';
        if (medicalRecordPauseSymbol) medicalRecordPauseSymbol.style.display = 'none';
        const T = typeof window.t === 'function' ? window.t : function(k) { return k; };
        medicalRecordBtn.setAttribute('aria-label', T('medical_recording') || 'Recording');
    }
    window.syncMedicalPrimaryActionBtn = syncMedicalPrimaryActionBtn;

    function pauseMedicalWaveform() {
        const wf = window._medicalWave;
        if (!wf) return;
        try {
            if (wf.rafId) cancelAnimationFrame(wf.rafId);
        } catch (_) {}
        wf.rafId = null;
    }

    function resetMedicalWaveformClock() {
        const wf = window._medicalWave;
        if (!wf) return;
        wf.lastTs = 0;
        wf.wasHidden = false;
    }

    function stopMedicalWaveform(keepCanvas = true) {
        const wf = window._medicalWave;
        if (!wf) return;
        pauseMedicalWaveform();
        try { if (wf.audioCtx) wf.audioCtx.close(); } catch (_) {}
        wf.audioCtx = null;
        wf.analyser = null;
        wf.dataArray = null;
        wf.sourceNode = null;
        wf.lastTs = 0;
        if (!keepCanvas) {
            const host = document.getElementById('medical-wave-wrap');
            if (host && host.parentNode) host.parentNode.removeChild(host);
            const transcriptWindow = document.getElementById('transcript-window');
            if (transcriptWindow) transcriptWindow.classList.remove('medical-wave-active');
            window._medicalWave = null;
        }
    }

    function ensureMedicalWaveformCanvas() {
        const transcriptWindow = document.getElementById('transcript-window');
        if (!transcriptWindow) return null;
        transcriptWindow.classList.add('medical-wave-active');
        let wrap = document.getElementById('medical-wave-wrap');
        let canvas = document.getElementById('medical-wave-canvas');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'medical-wave-wrap';
            wrap.style.cssText = 'width:100%; height:110px; display:flex; align-items:center; justify-content:center; overflow:hidden;';
            canvas = document.createElement('canvas');
            canvas.id = 'medical-wave-canvas';
            canvas.width = 900;
            canvas.height = 96;
            canvas.style.cssText = 'width:100%; height:96px; display:block;';
            wrap.appendChild(canvas);
            transcriptWindow.innerHTML = '';
            transcriptWindow.appendChild(wrap);
            if (medicalRecordingTimerSlot) transcriptWindow.appendChild(medicalRecordingTimerSlot);
        } else if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'medical-wave-canvas';
            canvas.width = 900;
            canvas.height = 96;
            canvas.style.cssText = 'width:100%; height:96px; display:block;';
            wrap.appendChild(canvas);
        }
        return canvas;
    }

    function startMedicalWaveform(stream, options = {}) {
        const preserveExistingWave = !!(options && options.preserveExistingWave);
        const existing = window._medicalWave;
        if (existing && existing.canvas && existing.ctx && existing.analyser && existing.dataArray && existing.audioCtx) {
            pauseMedicalWaveform();
            existing.lastTs = 0;
        } else {
            const canvas = ensureMedicalWaveformCanvas();
            if (!canvas) return;
            stopMedicalWaveform(true);
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const audioCtx = new Ctx();
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.78;
            const sourceNode = audioCtx.createMediaStreamSource(stream);
            sourceNode.connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            if (!preserveExistingWave) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            window._medicalWave = {
                canvas, ctx, audioCtx, analyser, dataArray, sourceNode,
                rafId: null, lastTs: 0, wasHidden: false
            };
        }

        const draw = (ts) => {
            const wf = window._medicalWave;
            if (!wf || window._medicalRecorderPaused || !window._medicalRecorder) return;
            const { canvas: c, ctx: x, analyser: a, dataArray: arr } = wf;
            if (document.visibilityState === 'hidden') {
                // Recording continues in the background, but drawing is throttled.
                // Do not scroll the waveform while hidden; otherwise returning to
                // the tab creates an artificial blank gap.
                wf.wasHidden = true;
                wf.lastTs = 0;
                wf.rafId = requestAnimationFrame(draw);
                return;
            }
            const prev = wf.lastTs || ts;
            let dt = Math.max(0.001, (ts - prev) / 1000);
            if (wf.wasHidden || dt > 0.25) {
                dt = 1 / 60;
                wf.wasHidden = false;
            }
            wf.lastTs = ts;
            const shiftPx = Math.max(1, Math.round(28 * dt)); // approx 28px/sec to the left
            x.drawImage(c, -shiftPx, 0);
            x.fillStyle = '#ffffff';
            x.fillRect(c.width - shiftPx, 0, shiftPx, c.height);
            a.getByteTimeDomainData(arr);
            let sumSq = 0;
            for (let i = 0; i < arr.length; i++) {
                const n = (arr[i] - 128) / 128;
                sumSq += n * n;
            }
            const rms = Math.sqrt(sumSq / arr.length);
            // Keep the waveform responsive but avoid clipping at normal speech levels.
            const amp = Math.min(1, rms * 5.8);
            const centerY = c.height / 2;
            const maxHalf = Math.max(2, Math.floor((c.height / 2) - 4));
            const half = Math.max(2, Math.min(maxHalf, Math.round((c.height * 0.42) * amp)));
            x.strokeStyle = '#0f766e';
            x.lineWidth = 2;
            x.beginPath();
            x.moveTo(c.width - 2, centerY - half);
            x.lineTo(c.width - 2, centerY + half);
            x.stroke();
            wf.rafId = requestAnimationFrame(draw);
        };
        window._medicalWave.rafId = requestAnimationFrame(draw);
    }

    async function pushFileIntoPickerAndUpload(file) {
        if (!fileInput) throw new Error('Missing file input');
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function beginMedicalRecordingWarmup(mimeRaw) {
        if (!isMedicalModeEnabled()) return null;
        if (window._medicalWarmupPromise) return window._medicalWarmupPromise;
        const warmupToken = (Number(window._medicalWarmupToken || 0) + 1);
        window._medicalWarmupToken = warmupToken;
        const mime = String(mimeRaw || 'audio/webm').trim() || 'audio/webm';
        const ext = medicalBlobExtensionFromMime(mime);
        window._medicalWarmupPromise = (async () => {
            if (typeof window.qsDismissActiveJob === 'function') {
                window.qsDismissActiveJob();
            }
            const { data: { user } } = await supabase.auth.getUser();
            const userId = user ? user.id : null;
            const filename = `medical_recording_${Date.now()}.${ext}`;
            qsUploadTraceErr('medical_recording_warmup_start', { filename, mime });
            const res = await fetch('/api/sign-s3', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename,
                    filetype: mime,
                    isMedical: true,
                    userId,
                    language: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he')
                })
            });
            const out = await res.json().catch(() => ({}));
            if (!res.ok || !out.data || !out.data.url || !out.data.s3Key || !out.data.jobId) {
                throw new Error(out.message || out.error || `Warmup failed: HTTP ${res.status}`);
            }
            if (window._medicalWarmupToken !== warmupToken) {
                throw new Error('medical_warmup_cancelled');
            }
            const session = {
                url: out.data.url,
                s3Key: out.data.s3Key,
                jobId: out.data.jobId,
                bucket: out.data.bucket,
                filetype: mime,
                signedHeaders: out.data.signedHeaders || {}
            };
            window._medicalWarmupSession = session;
            localStorage.setItem('lastS3Key', session.s3Key);
            localStorage.setItem('pendingS3Key', session.s3Key);
            localStorage.setItem('lastJobId', session.jobId);
            if (typeof createJobOnUpload === 'function') await createJobOnUpload({ jobId: session.jobId, s3Key: session.s3Key });
            try { if (typeof socket !== 'undefined') socket.emit('join', { room: session.jobId }); } catch (_) {}
            qsUploadTraceErr('medical_recording_warmup_ready', { jobId: session.jobId, s3Key: session.s3Key });
            return session;
        })();
        window._medicalWarmupPromise.catch((err) => {
            const msg = String((err && err.message) || err);
            if (msg === 'medical_warmup_cancelled') return;
            qsUploadTraceErr('medical_recording_warmup_failed', { err: msg });
            window._medicalWarmupPromise = null;
            window._medicalWarmupSession = null;
        });
        return window._medicalWarmupPromise;
    }

    async function clearMedicalRecordingWarmup(markFailed = false) {
        const session = window._medicalWarmupSession;
        window._medicalWarmupToken = Number(window._medicalWarmupToken || 0) + 1;
        window._medicalWarmupSession = null;
        window._medicalWarmupPromise = null;
        if (markFailed && session && typeof updateJobStatus === 'function') {
            try {
                const dbId = localStorage.getItem('lastJobDbId');
                if (dbId) await updateJobStatus(dbId, 'failed');
            } catch (_) {}
        }
    }

    async function uploadWarmedMedicalRecordingFile(file) {
        let session = window._medicalWarmupSession;
        if (!session && window._medicalWarmupPromise) {
            try {
                session = await window._medicalWarmupPromise;
            } catch (err) {
                qsUploadTraceErr('medical_recording_warmup_unavailable_fallback', { err: String((err && err.message) || err) });
                window._medicalWarmupSession = null;
                window._medicalWarmupPromise = null;
                return false;
            }
        }
        if (!session || !session.url || !session.s3Key || !session.jobId) return false;

        const objectUrl = URL.createObjectURL(file);
        window.originalFileName = file.name.replace(/\.[^.]+$/, '') || 'medical_recording';
        window.uploadWasVideo = false;
        setLocalPreviewAudio(objectUrl, file.type || session.filetype || 'audio/webm');

        const headers = {
            'Content-Type': session.filetype || file.type || 'audio/webm',
            ...(session.signedHeaders || {})
        };
        showProgressBar();
        qsSetProgressBarPct(10);
        const uploadLabel = ((typeof window.t === 'function' ? window.t('uploading') : 'Uploading...') || '').replace(/\.\.\.?$/, '');
        if (mainBtn) {
            mainBtn.disabled = true;
            mainBtn.innerText = uploadLabel;
        }
        setDiarizationBusyState(true);
        setTranscriptActionButtonsVisible(false);
        qsUploadTraceErr('medical_recording_put_start', { jobId: session.jobId, bytes: file.size });
        const putRes = await fetch(session.url, { method: 'PUT', headers, body: file });
        if (!putRes.ok) throw new Error(`Recording upload failed: HTTP ${putRes.status}`);
        qsSetProgressBarPct(100);
        if (mainBtn) mainBtn.innerText = uploadLabel;
        qsUploadTraceErr('medical_recording_put_done', { jobId: session.jobId, bytes: file.size });

        localStorage.setItem('lastS3Key', session.s3Key);
        localStorage.setItem('pendingS3Key', session.s3Key);
        localStorage.setItem('lastJobId', session.jobId);
        window._lastProcessedJobId = null;
        window._qsSummaryGptDoneJobId = null;
        window._qsCreditsDeferredForJobId = null;
        qsResetCleanupState();
        const dbId = localStorage.getItem('lastJobDbId');
        if (typeof updateJobStatus === 'function' && dbId) await updateJobStatus(dbId, 'uploaded');
        let warmUserId = window.__QS_MEDICAL_WARMUP_USER_ID;
        try {
            const { data: { user: wu } } = await supabase.auth.getUser();
            if (wu && wu.id) warmUserId = wu.id;
        } catch (_) {}
        if (window.__QS_MEDICAL_WARMUP_STATE !== 'ready') {
            if (typeof window.qsMaybeMedicalSessionWarmup === 'function') {
                await window.qsMaybeMedicalSessionWarmup();
            }
            if (window.__QS_MEDICAL_WARMUP_STATE !== 'ready') {
                qsShowMedicalFirstWakeupWaitNotice(window.__QS_MEDICAL_LAST_RECORDING_MS || 0);
                qsShowMedicalWarmupProgressDuringRecording();
                await qsAwaitMedicalWarmupReady(warmUserId);
            }
        }
        qsStartUnifiedProgressPhase('transcribe');
        startProcessingStateUI();
        window.isTriggering = true;
        window._triggerRetriedForJobId = null;

        const triggerPayload = {
            s3Key: session.s3Key,
            bucket: session.bucket,
            jobId: session.jobId,
            diarization: false,
            isMedical: true,
            language: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he')
        };
        const { triggerRes, triggerData } = await qsPostTriggerProcessingWithRetry(triggerPayload, session.jobId);
        if (!triggerRes.ok) {
            throw new Error(triggerData.message || triggerData.error || `Server error (${triggerRes.status})`);
        }
        if (triggerData.sagemaker_already_submitted) {
            console.warn('[medical] trigger reported sagemaker_already_submitted — if transcription stalls, redeploy server fix');
        }
        if (typeof window.qsSetActiveJob === 'function') {
            window.qsSetActiveJob(session.jobId);
        } else {
            localStorage.setItem('activeJobId', session.jobId);
        }
        try {
            if (typeof socket !== 'undefined') socket.emit('join', { room: session.jobId });
        } catch (_) {}
        if (typeof startFakeProgress === 'function') startFakeProgress();
        if (typeof window.startJobStatusPolling === 'function') window.startJobStatusPolling(session.jobId);
        window._medicalWarmupSession = null;
        window._medicalWarmupPromise = null;
        return true;
    }

    /** Safari / iOS often need an explicit supported mime and timesliced start() or blobs stay empty. */
    function pickMedicalMediaRecorderOptions() {
        try {
            if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return {};
            const candidates = [
                'audio/mp4',
                'audio/mp4;codecs=mp4a.40.2',
                'audio/aac',
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus'
            ];
            for (let i = 0; i < candidates.length; i++) {
                const m = candidates[i];
                if (MediaRecorder.isTypeSupported(m)) return { mimeType: m };
            }
        } catch (_) {}
        return {};
    }

    function medicalBlobExtensionFromMime(mimeRaw) {
        const mime = String(mimeRaw || '').toLowerCase();
        if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac') || mime.includes('caf')) return 'm4a';
        if (mime.includes('ogg')) return 'ogg';
        return 'webm';
    }

    function encodeAudioBufferToWavBlob(buffers) {
        const valid = (buffers || []).filter(Boolean);
        if (!valid.length) return null;
        const targetRate = valid[0].sampleRate || 44100;
        const channels = Math.max(1, Math.min(2, ...valid.map((b) => b.numberOfChannels || 1)));

        function channelDataAtRate(buffer, ch) {
            const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
            if (buffer.sampleRate === targetRate) return src;
            const ratio = targetRate / buffer.sampleRate;
            const out = new Float32Array(Math.max(1, Math.round(src.length * ratio)));
            for (let i = 0; i < out.length; i++) {
                const pos = i / ratio;
                const lo = Math.floor(pos);
                const hi = Math.min(src.length - 1, lo + 1);
                const frac = pos - lo;
                out[i] = (src[lo] || 0) * (1 - frac) + (src[hi] || 0) * frac;
            }
            return out;
        }

        const rendered = valid.map((buffer) => {
            const data = [];
            for (let ch = 0; ch < channels; ch++) data.push(channelDataAtRate(buffer, ch));
            return { data, length: data[0] ? data[0].length : 0 };
        });
        const totalFrames = rendered.reduce((sum, part) => sum + part.length, 0);
        const bytesPerSample = 2;
        const blockAlign = channels * bytesPerSample;
        const dataBytes = totalFrames * blockAlign;
        const out = new ArrayBuffer(44 + dataBytes);
        const view = new DataView(out);
        let off = 0;
        const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };
        writeStr('RIFF');
        view.setUint32(off, 36 + dataBytes, true); off += 4;
        writeStr('WAVE');
        writeStr('fmt ');
        view.setUint32(off, 16, true); off += 4;
        view.setUint16(off, 1, true); off += 2;
        view.setUint16(off, channels, true); off += 2;
        view.setUint32(off, targetRate, true); off += 4;
        view.setUint32(off, targetRate * blockAlign, true); off += 4;
        view.setUint16(off, blockAlign, true); off += 2;
        view.setUint16(off, 16, true); off += 2;
        writeStr('data');
        view.setUint32(off, dataBytes, true); off += 4;
        for (const part of rendered) {
            for (let i = 0; i < part.length; i++) {
                for (let ch = 0; ch < channels; ch++) {
                    const sample = Math.max(-1, Math.min(1, part.data[ch][i] || 0));
                    view.setInt16(off, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
                    off += 2;
                }
            }
        }
        return new Blob([out], { type: 'audio/wav' });
    }

    async function buildMedicalRecordingFile(prefix, fallbackMime) {
        const segments = (window._medicalRecorderSegments || []).filter((b) => b && b.size > 0);
        if (segments.length <= 1) {
            const only = segments[0] || new Blob(window._medicalRecorderChunks || [], { type: fallbackMime || 'audio/webm' });
            const ext = medicalBlobExtensionFromMime(only.type || fallbackMime);
            return new File([only], `${prefix}_${Date.now()}.${ext}`, { type: only.type || fallbackMime || 'audio/webm' });
        }
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) throw new Error('AudioContext unavailable');
            const ctx = new Ctx();
            const buffers = [];
            for (const segment of segments) {
                const arr = await segment.arrayBuffer();
                buffers.push(await ctx.decodeAudioData(arr.slice(0)));
            }
            try { await ctx.close(); } catch (_) {}
            const wav = encodeAudioBufferToWavBlob(buffers);
            if (wav) return new File([wav], `${prefix}_${Date.now()}.wav`, { type: 'audio/wav' });
        } catch (e) {
            console.warn('[medical] failed to stitch recording segments as wav; falling back to raw segments', e);
        }
        const mime = fallbackMime || (segments[0] && segments[0].type) || 'audio/webm';
        const ext = medicalBlobExtensionFromMime(mime);
        return new File(segments, `${prefix}_${Date.now()}.${ext}`, { type: mime });
    }

    function finishMedicalRecorderResumeAfterOsInterrupt() {
        if (!window._medicalSystemRecordingInterrupted) return;
        const rec = window._medicalRecorder;
        if (!rec || rec.state !== 'recording') return;
        window._medicalRecorderPaused = false;
        window._medicalSystemRecordingInterrupted = false;
        stopMedicalResumeRetryLoop();
        window._medicalRecordingStartedAt = Date.now();
        setMedicalRecordingVisualState('recording');
        renderMedicalRecordingTimer();
        const stream = rec.stream;
        if (stream) startMedicalWaveform(stream);
    }

    function startMedicalResumeRetryLoop() {
        if (window._medicalResumeRetryTimer) return;
        window._medicalResumeRetryTimer = setInterval(() => {
            if (!window._medicalSystemRecordingInterrupted) {
                stopMedicalResumeRetryLoop();
                return;
            }
            if (document.visibilityState && document.visibilityState !== 'visible') return;
            try { tryResumeMedicalRecordingAfterOsInterrupt(); } catch (_) {}
        }, 900);
    }

    function stopMedicalResumeRetryLoop() {
        if (!window._medicalResumeRetryTimer) return;
        clearInterval(window._medicalResumeRetryTimer);
        window._medicalResumeRetryTimer = null;
    }

    function markMedicalRecorderInterrupted(reason) {
        const rec = window._medicalRecorder;
        if (!rec || rec.state === 'inactive') return;
        window._medicalSystemRecordingInterrupted = true;
        window._medicalPauseReason = reason || 'system';
        if (!window._medicalRecorderPaused) {
            window._medicalRecordingAccumMs += Math.max(0, Date.now() - Number(window._medicalRecordingStartedAt || 0));
        }
        window._medicalRecorderPaused = true;
        setMedicalRecordingVisualState('paused');
        renderMedicalRecordingTimer();
        pauseMedicalWaveform();
        startMedicalResumeRetryLoop();
    }

    function pauseMedicalRecordingForInterruption(reason) {
        const rec = window._medicalRecorder;
        if (!rec || rec.state !== 'recording') return;
        markMedicalRecorderInterrupted(reason);
        try { rec.pause(); } catch (_) {}
    }

    async function restartMedicalRecorderAfterInterruption() {
        if (window._medicalRestartInProgress) return;
        const rec = window._medicalRecorder;
        if (!window._medicalSystemRecordingInterrupted) return;
        window._medicalRestartInProgress = true;
        window._medicalRollingRestart = !!rec;
        try {
            if (rec) {
                try { if (typeof rec.requestData === 'function' && rec.state !== 'inactive') rec.requestData(); } catch (_) {}
                try { if (rec.state !== 'inactive') rec.stop(); } catch (_) {}
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            await startMedicalRecording({ preserveChunks: true, resumeFromInterruption: true });
        } catch (e) {
            window._medicalRollingRestart = false;
            window._medicalSystemRecordingInterrupted = true;
            window._medicalRecorderPaused = true;
            startMedicalResumeRetryLoop();
        } finally {
            window._medicalRestartInProgress = false;
        }
    }

    function tryResumeMedicalRecordingAfterOsInterrupt() {
        // After a phone call many mobile browsers leave the old mic track alive but silent.
        // Re-acquire a fresh stream instead of trusting MediaRecorder.resume().
        void restartMedicalRecorderAfterInterruption();
    }

    if (!window._medicalOsInterruptListenersBound) {
        window._medicalOsInterruptListenersBound = true;
        // Resume after real OS interrupts (phone call, mic revoked) — not tab switches.
        const onReturnToApp = () => {
            if (document.visibilityState !== 'visible') return;
            if (!window._medicalSystemRecordingInterrupted) return;
            const reason = String(window._medicalPauseReason || '');
            if (reason === 'visibility_hidden' || reason === 'window_blur') return;
            setTimeout(() => { try { tryResumeMedicalRecordingAfterOsInterrupt(); } catch (_) {} }, 50);
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                resetMedicalWaveformClock();
                onReturnToApp();
            }
        });
        window.addEventListener('focus', onReturnToApp);
        window.addEventListener('pageshow', () => {
            if (!window._medicalSystemRecordingInterrupted) return;
            setTimeout(() => { try { tryResumeMedicalRecordingAfterOsInterrupt(); } catch (_) {} }, 80);
        });
    }

    async function startMedicalRecording(options = {}) {
        if (window._medicalStartRecordingInFlight || (window._medicalRecorder && window._medicalRecorder.state !== 'inactive')) {
            return;
        }
        window._medicalStartRecordingInFlight = true;
        const preserveChunks = !!(options && options.preserveChunks);
        const resumeFromInterruption = !!(options && options.resumeFromInterruption);
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (resumeFromInterruption) {
                // iOS can hand back a stream while the phone call still owns the mic. Do not accept muted/ended tracks.
                await new Promise((resolve) => setTimeout(resolve, 220));
                const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
                const hasUsableTrack = tracks.some((t) => t && t.readyState === 'live' && t.muted !== true && t.enabled !== false);
                if (!hasUsableTrack) {
                    (stream.getTracks() || []).forEach((t) => { try { t.stop(); } catch (_) {} });
                    throw new Error('microphone_not_ready_after_call');
                }
            }
        const recOpts = pickMedicalMediaRecorderOptions();
        const rec = Object.keys(recOpts).length ? new MediaRecorder(stream, recOpts) : new MediaRecorder(stream);
        if (isMedicalModeEnabled() && !preserveChunks) {
            void beginMedicalRecordingWarmup((rec.mimeType || recOpts.mimeType || 'audio/webm').toLowerCase());
        }
        const localChunks = [];
        if (!preserveChunks) {
            window._medicalRecorderChunks = [];
            window._medicalRecorderSegments = [];
        }
        rec.addEventListener('pause', () => {
            if (window._medicalPauseUserIntent) {
                window._medicalPauseUserIntent = false;
                return;
            }
            markMedicalRecorderInterrupted('recorder_pause_event');
        });
        rec.addEventListener('resume', () => {
            if (!window._medicalSystemRecordingInterrupted) return;
            finishMedicalRecorderResumeAfterOsInterrupt();
        });
        (stream.getAudioTracks ? stream.getAudioTracks() : []).forEach((track) => {
            try {
                track.addEventListener('mute', () => {
                    // Browsers may briefly mute on tab blur; keep recording unless track is dead.
                    if (document.visibilityState === 'hidden') return;
                    pauseMedicalRecordingForInterruption('track_mute');
                });
                track.addEventListener('unmute', () => {
                    setTimeout(() => { try { tryResumeMedicalRecordingAfterOsInterrupt(); } catch (_) {} }, 80);
                });
                track.addEventListener('ended', () => {
                    markMedicalRecorderInterrupted('track_ended');
                });
            } catch (_) {}
        });
        rec.ondataavailable = (e) => {
            if (e && e.data && e.data.size > 0) {
                localChunks.push(e.data);
                window._medicalRecorderChunks.push(e.data);
            }
        };
        rec.onstop = async () => {
            const mime = (rec.mimeType || (localChunks[0] && localChunks[0].type) || 'audio/webm').toLowerCase();
            if (localChunks.length) {
                const segmentBlob = new Blob(localChunks, { type: mime });
                if (segmentBlob.size > 0) window._medicalRecorderSegments.push(segmentBlob);
            }
            if (window._medicalRollingRestart && !window._medicalSubmitOnStop) {
                try {
                    stopMedicalWaveform(true);
                    (stream.getTracks() || []).forEach((t) => { try { t.stop(); } catch (_) {} });
                    if (window._medicalRecorder === rec) window._medicalRecorder = null;
                } finally {
                    window._medicalRollingRestart = false;
                }
                return;
            }
            // Recording is complete once onstop has delivered the last chunk. Stop the live
            // stream before warmup/upload waits so the mic indicator and waveform do not linger.
            stopMedicalWaveform(false);
            (stream.getTracks() || []).forEach((t) => { try { t.stop(); } catch (_) {} });
            let shouldSubmit = false;
            try {
                if (!window._medicalRecorderPaused) {
                    window._medicalRecordingAccumMs += Math.max(0, Date.now() - Number(window._medicalRecordingStartedAt || 0));
                }
                stopMedicalRecordingTimer();
                setMedicalRecordingVisualState('idle');
                shouldSubmit = !!window._medicalSubmitOnStop;
                const prefix = isMedicalModeEnabled() ? 'medical_recording' : 'transcript_record';
                if (shouldSubmit) {
                    window.__QS_MEDICAL_LAST_RECORDING_MS = Math.max(0, Number(window._medicalRecordingAccumMs || 0));
                    const file = await buildMedicalRecordingFile(prefix, mime);
                    const uploadedViaWarmup = isMedicalModeEnabled()
                        ? await uploadWarmedMedicalRecordingFile(file)
                        : false;
                    if (!uploadedViaWarmup) await pushFileIntoPickerAndUpload(file);
                }
            } catch (e) {
                if (typeof showStatus === 'function') showStatus(`Recording upload failed: ${e.message || e}`, true);
            } finally {
                window._medicalRecorder = null;
                window._medicalRecorderChunks = [];
                window._medicalRecorderSegments = [];
                window._medicalRecorderPaused = false;
                window._medicalSystemRecordingInterrupted = false;
                stopMedicalResumeRetryLoop();
                window._medicalRecordingAccumMs = 0;
                window._medicalRecordingStartedAt = 0;
                window._medicalSubmitOnStop = false;
                if (!shouldSubmit) {
                    void clearMedicalRecordingWarmup(true);
                    qsHideMedicalRecordingWarmupProgress();
                } else if (
                    isMedicalModeEnabled()
                    && window.__QS_MEDICAL_WARMUP_STATE !== 'ready'
                    && !window.isTriggering
                ) {
                    qsShowMedicalWarmupProgressDuringRecording();
                } else {
                    window.__QS_MEDICAL_RECORDING_WARMUP_BAR = false;
                }
                if (!isMedicalModeEnabled()) window._qsRegularRecordVisible = false;
                setMedicalTimerVisibility(false);
                detachMedicalRecordingTimerSlot();
                if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi();
            }
        };
            attachMedicalRecordingTimerSlot();
            const sliceMs = typeof isMobileClient === 'function' && isMobileClient() ? 250 : 1000;
            try {
                rec.start(sliceMs);
            } catch (startErr) {
                try { rec.start(); } catch (_) { throw startErr; }
            }
            window._medicalRecorder = rec;
            startMedicalWaveform(stream, { preserveExistingWave: resumeFromInterruption });
        } catch (e) {
            if (stream) (stream.getTracks() || []).forEach((t) => { try { t.stop(); } catch (_) {} });
            detachMedicalRecordingTimerSlot();
            setMedicalTimerVisibility(false);
            window._medicalRecorder = null;
            throw e;
        } finally {
            window._medicalStartRecordingInFlight = false;
        }
        if (!preserveChunks) window._medicalRecordingAccumMs = 0;
        window._medicalRecorderPaused = false;
        window._medicalSubmitOnStop = false;
        window._medicalSystemRecordingInterrupted = false;
        window._medicalRecordingStartedAt = Date.now();
        setMedicalTimerVisibility(true);
        renderMedicalRecordingTimer();
        if (!window._medicalRecorderTimer || !preserveChunks) {
            stopMedicalRecordingTimer();
            window._medicalRecorderTimer = setInterval(renderMedicalRecordingTimer, 500);
        }
        setMedicalRecordingVisualState('recording');
        if (resumeFromInterruption) stopMedicalResumeRetryLoop();
    }

    async function toggleMedicalRecording() {
        if (window._medicalRecordingToggleBusy) return;
        const rec = window._medicalRecorder;
        if (rec && rec.state === 'recording') {
            window._medicalPauseUserIntent = true;
            window._medicalSystemRecordingInterrupted = false;
            stopMedicalResumeRetryLoop();
            try { rec.pause(); } catch (_) { window._medicalPauseUserIntent = false; return; }
            window._medicalRecordingAccumMs += Math.max(0, Date.now() - Number(window._medicalRecordingStartedAt || 0));
            window._medicalRecorderPaused = true;
            setMedicalRecordingVisualState('paused');
            renderMedicalRecordingTimer();
            pauseMedicalWaveform();
            return;
        }
        if (rec && rec.state === 'paused') {
            window._medicalSystemRecordingInterrupted = false;
            stopMedicalResumeRetryLoop();
            try { rec.resume(); } catch (_) { return; }
            window._medicalRecordingStartedAt = Date.now();
            window._medicalRecorderPaused = false;
            setMedicalRecordingVisualState('recording');
            renderMedicalRecordingTimer();
            const stream = rec.stream;
            if (stream) startMedicalWaveform(stream);
            return;
        }
        window._medicalRecordingToggleBusy = true;
        try {
            await startMedicalRecording();
            if (isMedicalModeEnabled() && typeof window.qsMaybeMedicalSessionWarmup === 'function') {
                void window.qsMaybeMedicalSessionWarmup();
            }
        } catch (e) {
            if (typeof showStatus === 'function') showStatus(`Microphone access failed: ${e.message || e}`, true);
        } finally {
            window._medicalRecordingToggleBusy = false;
        }
    }

    if (medicalRecordBtn) {
        medicalRecordBtn.addEventListener('click', () => {
            toggleMedicalRecording();
        });
    }
    const medicalUploadNewSessionBtn = document.getElementById('medical-upload-new-session-btn');
    if (medicalUploadNewSessionBtn) {
        medicalUploadNewSessionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            void confirmAndStartMedicalNewSession();
        });
    }
    if (regularRecordBtn) {
        regularRecordBtn.addEventListener('click', async () => {
            if (isMedicalModeEnabled()) return;
            window._qsRegularRecordVisible = true;
            if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi();
            await toggleMedicalRecording();
        });
    }
    if (medicalCancelBtn) {
        medicalCancelBtn.addEventListener('click', async () => {
            const rec = window._medicalRecorder;
            if (!rec) return;
            const ok = await confirmMedicalDeleteRecording();
            if (!ok) return;
            window._medicalSubmitOnStop = false;
            stopMedicalWaveform(true);
            try { rec.stop(); } catch (_) {}
        });
    }
    if (medicalConfirmBtn) {
        medicalConfirmBtn.addEventListener('click', () => {
            const rec = window._medicalRecorder;
            if (!rec) return;
            window._medicalSubmitOnStop = true;
            stopMedicalWaveform(false);
            stopMedicalRecordingTimer();
            setMedicalTimerVisibility(false);
            setMedicalRecordingVisualState('idle');
            if (
                isMedicalModeEnabled()
                && window.__QS_MEDICAL_WARMUP_STATE !== 'ready'
            ) {
                qsShowMedicalWarmupProgressDuringRecording();
            }
            try { rec.stop(); } catch (_) {}
        });
    }
    if (medicalTabTranscript) {
        medicalTabTranscript.addEventListener('click', (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            window.medicalActiveTab = 'transcript';
            updateMedicalTabUi();
            if (typeof renderMedicalTranscriptMainView === 'function') {
                renderMedicalTranscriptMainView();
            } else if (typeof window.render === 'function') {
                window.render();
            }
        });
    }
    if (medicalTabSummary) {
        medicalTabSummary.addEventListener('click', () => {
            window.medicalActiveTab = 'summary';
            updateMedicalTabUi();
            renderTranscriptFromCues(window.currentSegments || []);
        });
    }
    if (medicalCopyBtn) {
        medicalCopyBtn.addEventListener('click', async () => {
            if (typeof requireUserForCopyOrDownload === 'function') {
                const ok = await requireUserForCopyOrDownload();
                if (!ok) return;
            }
            const text = getMedicalActiveTabTextForCopy();
            if (!text) {
                if (typeof showStatus === 'function') showStatus('אין טקסט להעתקה.', true);
                return;
            }
            try {
                await navigator.clipboard.writeText(text);
                if (typeof showStatus === 'function') showStatus('הטקסט הועתק.', false);
                try {
                    if (typeof ensureJobRecordOnExport === 'function') {
                        await ensureJobRecordOnExport();
                    }
                } catch (_) {}
                try {
                    if (String(sessionStorage.getItem('qs_pefb_shown') || '') !== '1') {
                        if (String(sessionStorage.getItem('qs_medical_show_feedback_on_next_copy') || '') === '1') {
                            try { sessionStorage.removeItem('qs_medical_show_feedback_on_next_copy'); } catch (_) {}
                        }
                        setTimeout(() => {
                            try { void maybeShowPostExportFeedbackModal('medical_copy'); } catch (_) {}
                        }, 400);
                    }
                } catch (_) {}
            } catch (e) {
                if (typeof showStatus === 'function') showStatus('העתקה נכשלה.', true);
            }
        });
    }
    setMedicalRecordingVisualState('idle');
    setMedicalTimerVisibility(false);
    _wireMedicalSummarySectionCopyButtonsOnce();
    window.applyMedicalModeUi();

    function setDiarizationBusyState(isBusy) {
        if (!diarizationToggle) return;
        diarizationToggle.disabled = !!isBusy;
        if (diarizationToggle.parentElement) {
            diarizationToggle.parentElement.style.opacity = isBusy ? "0.6" : "1";
        }
    }

    function openFilePickerAfterDisclaimer() {
        if (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
            qsMedicalHardResetToEntry();
            return;
        }
        resetScreenToInitial();
        if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi();
        if (typeof syncMedicalPrimaryActionBtn === 'function') syncMedicalPrimaryActionBtn();
        if (fileInput) {
            try { window.__QS_FILE_PICKER_PURPOSE = 'new_upload'; } catch (_) {}
            fileInput.click();
        }
    }

    window.qsMedicalStartNewSession = openFilePickerAfterDisclaimer;

    async function confirmAndStartNewSession() {
        if (window.isTriggering) return;
        const T = typeof window.t === 'function' ? window.t : (k) => k;
        const isHebrewUi = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
        const msg = T('start_new_session_confirm')
            || (isHebrewUi
                ? 'להתחיל סשן חדש? התמלול והמדיה הנוכחיים יימחקו מהמסך.'
                : 'Start a new session? Your current transcript and media will be cleared.');
        let approved = true;
        if (typeof showGlobalConfirm === 'function') {
            approved = await showGlobalConfirm(msg, {
                confirmText: T('new_session') || (isHebrewUi ? 'סשן חדש' : 'New Session'),
                cancelText: T('cancel') || (isHebrewUi ? 'ביטול' : 'Cancel'),
                danger: true,
            });
        } else {
            approved = window.confirm(msg);
        }
        if (!approved) return;
        openFilePickerAfterDisclaimer();
    }
    window.confirmAndStartNewSession = confirmAndStartNewSession;

    async function confirmAndStartMedicalNewSession() {
        if (window.isTriggering) return;
        const rec = window._medicalRecorder;
        if (rec && rec.state && rec.state !== 'inactive') {
            if (typeof showStatus === 'function') showStatus('Finish or cancel the current recording before starting a new session.', true);
            return;
        }
        const isHebrewUi = String(document.documentElement.lang || '').toLowerCase().startsWith('he');
        let approved = true;
        if (typeof showGlobalConfirm === 'function') {
            approved = await showGlobalConfirm(
                isHebrewUi
                    ? 'האם להתחיל סשן חדש? התצוגה הנוכחית תתאפס.'
                    : 'Start a new session? The current view will be reset.',
                {
                    confirmText: isHebrewUi ? 'כן, סשן חדש' : 'Yes, start new session',
                    cancelText: isHebrewUi ? 'ביטול' : 'Cancel',
                }
            );
        } else {
            approved = window.confirm(isHebrewUi ? 'האם להתחיל סשן חדש?' : 'Start a new session?');
        }
        if (!approved) return;
        openFilePickerAfterDisclaimer();
    }

    function syncMobileVideoSessionState() {
        try {
            const isMobile = (
                (window.matchMedia && window.matchMedia('(max-width: 768px)').matches)
                || isMobileClient()
            );
            const videoWrapper = document.getElementById('video-wrapper');
            const audioContainer = document.getElementById('audio-player-container');
            const hasLoadedVideo = !!(videoWrapper && videoWrapper.classList.contains('visible'));
            let hasLoadedAudio = false;
            if (audioContainer) {
                const st = window.getComputedStyle(audioContainer);
                hasLoadedAudio = st.display !== 'none' && st.visibility !== 'hidden';
            }
            // Mobile layout hides upload CTA for video; same for audio-only (mp3) once the player is shown.
            document.body.classList.toggle('mobile-video-session', !!(isMobile && (hasLoadedVideo || hasLoadedAudio)));
        } catch (_) {}
        syncLandingLogoSize();
    }
    window.syncMobileVideoSessionState = syncMobileVideoSessionState;

    function syncLandingLogoSize() {
        const bodyEl = document.body;
        if (!bodyEl) return;
        // Apply only on the main app screen where upload CTA exists.
        const isMainUploadScreen = !!document.getElementById('main-btn');
        if (!isMainUploadScreen) {
            bodyEl.classList.remove('landing-logo-large');
            return;
        }
        const videoWrapper = document.getElementById('video-wrapper');
        const videoShown = !!(
            videoWrapper &&
            videoWrapper.classList.contains('visible') &&
            videoWrapper.style.display !== 'none'
        );
        const audioEl = document.getElementById('audio-player-container');
        let audioShown = false;
        if (audioEl) {
            const st = window.getComputedStyle(audioEl);
            audioShown = st.display !== 'none' && st.visibility !== 'hidden';
        }
        bodyEl.classList.toggle('landing-logo-large', !(videoShown || audioShown));
    }

    if (mobileSessionBtn) {
        mobileSessionBtn.addEventListener('click', () => {
            if (window.isTriggering) return;
            if (isMedicalModeEnabled()) {
                openFilePickerAfterDisclaimer();
                return;
            }
            resetScreenToInitial();
            if (typeof window.applyMedicalModeUi === 'function') {
                try { window.applyMedicalModeUi(); } catch (_) {}
            }
            if (typeof syncMedicalPrimaryActionBtn === 'function') {
                try { syncMedicalPrimaryActionBtn(); } catch (_) {}
            }
            try {
                const mb = document.getElementById('main-btn');
                if (mb) {
                    mb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    setTimeout(() => { try { mb.focus(); } catch (_) {} }, 120);
                }
            } catch (_) {}
        });
    }
    const closeMobileNav = () => {
        try { window.qsCloseMobileNav(); } catch (_) {}
    };
    const onNavWorkspaceCta = (e) => {
        const target = e.currentTarget;
        const href = target && target.getAttribute ? String(target.getAttribute('href') || '') : '';
        if (href === '/personal') {
            closeMobileNav();
            return;
        }
        e.preventDefault();
        if (window.isTriggering) return;
        if (!fileInput) {
            window.location.href = '/';
            return;
        }
        openFilePickerAfterDisclaimer();
        closeMobileNav();
    };
    if (navNewSessionBtn) navNewSessionBtn.addEventListener('click', onNavWorkspaceCta);
    const navDashboardCta = document.getElementById('nav-dashboard-cta');
    if (navDashboardCta) navDashboardCta.addEventListener('click', onNavWorkspaceCta);
    if (medicalToolbarNewSessionBtn) {
        medicalToolbarNewSessionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            void confirmAndStartMedicalNewSession();
        });
    }
    window.addEventListener('resize', syncMobileVideoSessionState);
    syncMobileVideoSessionState();
    try { qsEnsureDefaultStarterPlan(); } catch (_) {}
    try { qsSyncStarterPlanUploadGate(); } catch (_) {}
    try {
        const videoWrapper = document.getElementById('video-wrapper');
        if (videoWrapper && typeof MutationObserver !== 'undefined') {
            const logoSizeObserver = new MutationObserver(() => syncLandingLogoSize());
            logoSizeObserver.observe(videoWrapper, { attributes: true, attributeFilter: ['class', 'style'] });
        }
    } catch (_) {}

    if (mainBtn) {
        mainBtn.addEventListener('click', async () => {
            if (window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON) {
                if (fileInput) {
                    try { window.__QS_FILE_PICKER_PURPOSE = 'attach_local_media'; } catch (_) {}
                    fileInput.click();
                }
                return;
            }
            if (window.mainBtnAction === 'transcribe_loaded_file') {
                const s3Key = localStorage.getItem('lastS3Key');
                const dbId = localStorage.getItem('lastJobDbId');
                if (!s3Key || !dbId) {
                    if (typeof showStatus === 'function') showStatus('Missing recording context for transcription.', true);
                    return;
                }
                const prev = mainBtn.innerText;
                mainBtn.disabled = true;
                mainBtn.innerText = ((typeof window.t === 'function' ? window.t('processing') : 'Processing') || 'Processing').replace(/\.\.\.?$/, '');
                startProcessingStateUI();
                setDiarizationBusyState(true);
                try {
                    const transcribeJobId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                        ? crypto.randomUUID()
                        : ('job_' + Date.now() + '_' + Math.floor(Math.random() * 100000));
                    localStorage.setItem('lastJobId', transcribeJobId);
                    if (typeof window.qsSetActiveJob === 'function') window.qsSetActiveJob(transcribeJobId);
                    else localStorage.setItem('activeJobId', transcribeJobId);
                    window._lastProcessedJobId = null;
                    window._qsSummaryGptDoneJobId = null;
                    window._qsCreditsDeferredForJobId = null;
                    qsResetCleanupState();
                    try {
                        await supabase
                            .from('jobs')
                            .update({ runpod_job_id: transcribeJobId, status: 'processing', updated_at: new Date().toISOString() })
                            .eq('id', dbId);
                    } catch (_) {}
                    const triggerRes = await fetch('/api/trigger_processing', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key, jobId: transcribeJobId, task: 'transcribe', language: 'he', isMedical: isMedicalModeEnabled() })
                    });
                    const triggerData = await triggerRes.json().catch(() => ({}));
                    if (!triggerRes.ok) {
                        const msg = qsCreditsTriggerErrorMessage(triggerData)
                            || triggerData.message || triggerData.error || `HTTP ${triggerRes.status}`;
                        if (triggerData && (triggerData.error === 'insufficient_credits' || Number.isFinite(Number(triggerData.credit_minutes)))) {
                            qsApplyTriggerCreditFields(triggerData);
                        }
                        throw new Error(msg);
                    }
                    qsLogAudioProfileFromTrigger(transcribeJobId, triggerData);
                    qsApplyTriggerCreditFields(triggerData);
                    if (typeof window.startJobStatusPolling === 'function') window.startJobStatusPolling(transcribeJobId);
                } catch (e) {
                    stopProcessingStateUI('transcribe_loaded_file_error');
                    mainBtn.disabled = false;
                    mainBtn.innerText = prev;
                    setDiarizationBusyState(false);
                    if (typeof showStatus === 'function') showStatus('Transcribe failed: ' + (e.message || 'Unknown error'), true);
                }
                return;
            }
            if (window.mainBtnAction === 'new_session') {
                void confirmAndStartNewSession();
                return;
            }
            openFilePickerAfterDisclaimer();
        });
    }

    if (transcriptWindow && mainBtn) {
        transcriptWindow.addEventListener('click', (e) => {
            if (isMedicalModeEnabled()) return;
            if (window.isTriggering) return;
            if (transcriptWindow.classList.contains('transcript-editing')) return;
            if (transcriptWindow.classList.contains('transcript-sync-mode')) return;
            if (document.body.classList.contains('has-transcript-actions')) return;
            if (Array.isArray(window.currentSegments) && window.currentSegments.length > 0) return;
            const t = e && e.target;
            if (t && t.closest && t.closest('button,a,input,textarea,select,[role="button"]')) return;
            mainBtn.click();
        });
    }

    // Ensure toggles refresh the view immediately
    const toggleTimeEl = document.getElementById('toggle-time');
    const transcriptWindowEl = document.getElementById('transcript-window');
    if (toggleTimeEl && transcriptWindowEl) {
        transcriptWindowEl.classList.toggle('hide-time', !isTimeToggleVisible());
    }
    const rerenderTranscriptView = () => {
        const twRerender = document.getElementById('transcript-window');
        const toggleTimeSync = document.getElementById('toggle-time');
        if (toggleTimeSync && twRerender) {
            twRerender.classList.toggle('hide-time', !isTimeToggleVisible());
        }
        if (isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'summary') {
            renderTranscriptFromCues(window.currentSegments || []);
            return;
        }
        if (isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'transcript') {
            if (typeof renderMedicalTranscriptMainView === 'function') {
                renderMedicalTranscriptMainView();
                return;
            }
        }
        const inTranscriptEdit = !!(
            twRerender &&
            (twRerender.classList.contains('transcript-editing') ||
                twRerender.classList.contains('transcript-sync-mode') ||
                window._qsTimingMode)
        );
        if (isSummaryViewEnabled() && !inTranscriptEdit) {
            renderStandardSummaryView();
            return;
        }
        const hasWordModel =
            Array.isArray(window.currentWords) &&
            Array.isArray(window.currentCaptions) &&
            window.currentWords.length > 0 &&
            window.currentCaptions.length > 0;
        const inWordCaptionChrome = !!(
            window._qsTimingMode ||
            (twRerender &&
                (twRerender.classList.contains('transcript-editing') ||
                    twRerender.classList.contains('transcript-sync-mode')))
        );
        if (
            hasWordModel &&
            typeof renderWordCaptionEditor === 'function' &&
            isDocumentFormatEnabled() &&
            !inWordCaptionChrome &&
            typeof window.render === 'function'
        ) {
            window.render();
            return;
        }
        if (hasWordModel && typeof renderWordCaptionEditor === 'function') {
            renderWordCaptionEditor();
            return;
        }
        if (typeof window.render === 'function') {
            window.render();
            return;
        }
        if (typeof renderTranscriptFromCues === 'function') {
            renderTranscriptFromCues(window.currentSegments || []);
        }
    };
    try { window._qsRerenderTranscriptView = rerenderTranscriptView; } catch (_) {}
    document.getElementById('toggle-time')?.addEventListener('change', () => rerenderTranscriptView());
    const subtitleModeBtn = document.getElementById('format-mode-subtitle');
    const docModeBtn = document.getElementById('format-mode-doc');
    const summaryModeBtn = document.getElementById('format-mode-summary');
    if (subtitleModeBtn && docModeBtn) {
        subtitleModeBtn.addEventListener('click', () => setFormatViewMode('subtitle'));
        docModeBtn.addEventListener('click', () => setFormatViewMode('doc'));
        summaryModeBtn?.addEventListener('click', () => setFormatViewMode('summary'));
        syncStandardFormatTabs();
        setFormatViewMode(window.qsFormatViewMode || 'summary');
    } else {
        document.getElementById('toggle-doc-format')?.addEventListener('change', () => rerenderTranscriptView());
    }
    document.getElementById('toggle-speaker')?.addEventListener('change', () => rerenderTranscriptView());
    if (mainAudio) {
        mainAudio.addEventListener('timeupdate', () => {
            const currentTime = mainAudio.currentTime;
            const activeSegment = typeof window.getActiveSegmentAtTime === 'function' ? window.getActiveSegmentAtTime(window.currentSegments || [], currentTime) : null;

            if (activeSegment) {
                // Word-caption editor highlighting
                if (document.querySelector('#transcript-window .caption-row')) {
                    highlightActiveCaptionRowByTime(currentTime);
                    if (typeof window.updateVideoWordOverlay === 'function') window.updateVideoWordOverlay(currentTime);
                    return;
                }
                document.querySelectorAll('.paragraph-row').forEach(row => {
                    row.style.backgroundColor = "transparent";
                    row.style.borderLeft = "none";
                });
                document.querySelectorAll('.paragraph-row p').forEach(p => {
                    p.style.backgroundColor = "transparent";
                });

                const rowIndex = typeof window.getGroupIndexForSegment === 'function' ? window.getGroupIndexForSegment(window.currentSegments, activeSegment) : 0;
                const activeRow = document.getElementById('seg-row-' + rowIndex);
                if (activeRow) {
                    activeRow.style.backgroundColor = "#f0f7ff";
                    activeRow.style.borderLeft = "4px solid #1e3a8a";
                    const p = activeRow.querySelector('p');
                    if (p) p.style.backgroundColor = "#fff9c4";
                }
            }
            // Always update video overlay (works with word-level timestamps).
            if (typeof window.updateVideoWordOverlay === 'function') window.updateVideoWordOverlay(currentTime);
        });
        const mainVideo = document.getElementById('main-video');
        if (mainVideo) {
            mainVideo.addEventListener('timeupdate', () => {
                const currentTime = mainVideo.currentTime;
                const activeSegment = typeof window.getActiveSegmentAtTime === 'function' ? window.getActiveSegmentAtTime(window.currentSegments || [], currentTime) : null;

                try {
                    // Word-caption editor highlighting
                    if (document.querySelector('#transcript-window .caption-row')) {
                        highlightActiveCaptionRowByTime(currentTime);
                        if (typeof window.updateVideoWordOverlay === 'function') window.updateVideoWordOverlay(currentTime);
                        return;
                    }
                    document.querySelectorAll('.paragraph-row').forEach(row => row.classList.remove('active-highlight'));
                    document.querySelectorAll('.paragraph-row p').forEach(p => p.style.backgroundColor = "transparent");

                    if (activeSegment) {
                        const rowIndex = typeof window.getGroupIndexForSegment === 'function' ? window.getGroupIndexForSegment(window.currentSegments, activeSegment) : 0;
                        const activeRow = document.getElementById('seg-row-' + rowIndex);
                        if (activeRow) {
                            activeRow.classList.add('active-highlight');
                            activeRow.scrollIntoView({ behavior: 'auto', block: 'nearest' });
                            const p = activeRow.querySelector('p');
                            if (p) p.style.backgroundColor = "#fff9c4";
                        }
                    }
                } catch (e) {
                    console.warn('Highlighting failure', e);
                }
                if (typeof window.updateVideoWordOverlay === 'function') window.updateVideoWordOverlay(currentTime);
            });
        }
        // Legacy simulation-start-on-play removed (caused duplicate/stale process behavior).
    }
    // If the user flips the "Show" switch, we just re-render
    if (speakerToggle) {
        speakerToggle.addEventListener('change', () => {
            if (window.currentSegments.length > 0) {
                document.getElementById('transcript-window').innerHTML = renderParagraphs(window.currentSegments);
            }
        });
    }

    // If the user flips "Detect", we just update the visual state (Snapshot rule)
    if (diarizationToggle) {
        diarizationToggle.addEventListener('change', syncSpeakerControls);
    }
    // Set initial state
    syncSpeakerControls();
    setDiarizationBusyState(!!window.isTriggering);

    /** Late check_status/socket with segments after an empty first completion — render only, no second GPT pass. */
    async function qsHandleJobUpdateLateSegmentsOnly(rawResult, incomingSegs, jobId) {
        const output = rawResult.result || rawResult.output || rawResult;
        let segments = incomingSegs.length ? incomingSegs.slice() : [];
        const flatWordSegments = (output && output.word_segments) || rawResult.word_segments || (rawResult.result && rawResult.result.word_segments);
        const wordModel = _tryBuildWordModelFromSegmentsAndFlat(segments, flatWordSegments);
        if (wordModel) {
            window.currentWords = wordModel.words;
            window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, wordModel.captions, 54);
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        } else {
            window.currentWords = null;
            window.currentCaptions = null;
            segments = splitLongSegments(segments, 40);
            window.currentSegments = segments;
        }
        window._qsShowEmptyTranscriptNotice = !(window.currentSegments && window.currentSegments.length);
        const transcriptWindow = document.getElementById('transcript-window');
        if (transcriptWindow && window.currentSegments && window.currentSegments.length) {
            try {
                if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions)) {
                    renderWordCaptionEditor();
                } else if (typeof window.render === 'function') {
                    window.render();
                }
            } catch (e) {
                console.warn('[qs] late segments render failed', e);
            }
        }
        const mainBtn = document.getElementById('main-btn');
        if (mainBtn) {
            mainBtn.disabled = false;
            if (typeof setMainButtonAction === 'function') setMainButtonAction('new_session');
        }
        setTranscriptActionButtonsVisible(true);
        qsEnsureTranscriptToolbarVisible('handleJobUpdate_late_segments', { force: true });
        console.info('[qs] handleJobUpdate late segments merged (skipped GPT re-run)', { jobId, segments: (window.currentSegments || []).length });
    }

    // --- 2. THE HANDLER (Hides overlay and turns switch Blue) ---
    window.handleJobUpdate = async function(rawResult) {
        const jobId = rawResult.jobId || (rawResult.output && rawResult.output.jobId) || (rawResult.result && rawResult.result.jobId);
        const incomingSegs = extractSegmentsFromJobPayload(rawResult);

        function qsJobSummaryAlreadyDone(id) {
            if (!id) return false;
            if (window._qsSummaryGptDoneJobId === id) return true;
            if (window._lastProcessedJobId === id && hasStandardFormattedSummary()) return true;
            if (window._lastProcessedJobId === id && typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) {
                const fmt = window.currentFormattedDoc;
                return !!(fmt && (
                    String(fmt.overview || '').trim() ||
                    String(fmt.medical_chief_complaint || '').trim()
                ));
            }
            return false;
        }

        if (jobId && window._lastProcessedJobId === jobId) {
            const haveUi = qsHasTranscriptResult();
            const haveSummary = qsJobSummaryAlreadyDone(jobId);
            if (haveUi && haveSummary) {
                qsEnsureTranscriptToolbarVisible('handleJobUpdate_duplicate_socket', { force: true });
                try {
                    if (!(typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) && isSummaryViewEnabled()) {
                        renderStandardSummaryView();
                    }
                } catch (_) {}
                return;
            }
            if (haveUi || !incomingSegs.length) {
                if (haveUi) qsEnsureTranscriptToolbarVisible('handleJobUpdate_duplicate_socket', { force: true });
                return;
            }
            await qsHandleJobUpdateLateSegmentsOnly(rawResult, incomingSegs, jobId);
            return;
        }
        if (jobId && window._handleJobUpdateInFlight === jobId) {
            const persisted = !!(rawResult && rawResult.transcript_persisted);
            if (!persisted && !incomingSegs.length) return;
            let spins = 0;
            while (window._handleJobUpdateInFlight === jobId && spins < 120) {
                await new Promise((r) => setTimeout(r, 500));
                spins++;
            }
            if (window._handleJobUpdateInFlight === jobId) return;
            if (window._lastProcessedJobId === jobId) {
                qsEnsureTranscriptToolbarVisible('handleJobUpdate_duplicate_after_wait', { force: true });
                try {
                    if (!(typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) && isSummaryViewEnabled()) {
                        renderStandardSummaryView();
                    }
                } catch (_) {}
                return;
            }
        }
        if (jobId) window._handleJobUpdateInFlight = jobId;

        let dbId = localStorage.getItem('lastJobDbId');
        let inputS3KeyForJob = null;
        try {
            const { data: { user: uAlign } } = await supabase.auth.getUser();
            const rjid = String(jobId || '').trim();
            if (uAlign && rjid) {
                const { data: runRow, error: runRowErr } = await supabase
                    .from('jobs')
                    .select('id, input_s3_key')
                    .eq('runpod_job_id', rjid)
                    .eq('user_id', uAlign.id)
                    .maybeSingle();
                if (!runRowErr && runRow && runRow.id) {
                    dbId = runRow.id;
                    inputS3KeyForJob = String(runRow.input_s3_key || '').trim() || null;
                    try {
                        localStorage.setItem('lastJobDbId', runRow.id);
                        if (inputS3KeyForJob) localStorage.setItem('lastS3Key', inputS3KeyForJob);
                    } catch (_) {}
                }
            }
        } catch (e) {
            console.warn('[qs] handleJobUpdate: could not align jobs row with RunPod job id', e);
        }
        if (!inputS3KeyForJob) {
            try {
                inputS3KeyForJob = String(localStorage.getItem('lastS3Key') || '').trim() || null;
            } catch (_) {}
        }
        try {
            if (inputS3KeyForJob) window._qsInputS3KeyForGpt = inputS3KeyForJob;
        } catch (_) {}

        if (window._checkStatusPollInterval) {
            clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
        }

        // 1. CLEAR OVERLAYS & STOP PROGRESS
        // Keep window.isTriggering true until the end of this handler so the fake-% interval does not
        // self-stop mid-flight before GPT translate (user saw "animation died" while chunks ran).
        setDiarizationBusyState(false);
        setSeoHomeContentVisibility(false);
        if (typeof window.qsClearActiveJob === 'function') {
            window.qsClearActiveJob();
        } else {
            localStorage.removeItem('activeJobId');
        }
        qsStopFakeProgress('handle_job_update_start');

        const statusTxt = document.getElementById('upload-status');
        const preparingScreen = document.getElementById('preparing-screen');
        if (preparingScreen) preparingScreen.style.display = 'none';

        const output = rawResult.result || rawResult.output || rawResult;
        const incomingFmt = extractFormattedFromJobPayload(rawResult);
        const prevFmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
            ? window.currentFormattedDoc
            : null;
        if (incomingFmt) {
            window.currentFormattedDoc = normalizeFormattedFields({ ...(prevFmt || {}), ...incomingFmt });
        } else if (jobId && (qsJobSummaryAlreadyDone(jobId) || (prevFmt && hasStandardFormattedSummary()))) {
            window.currentFormattedDoc = prevFmt;
        } else if (!jobId || jobId !== window._lastProcessedJobId) {
            window.currentFormattedDoc = null;
        }
        window._qsDocPreferSegmentsAfterEdit = false;
        const jobStatus = String(rawResult.status || (output && output.status) || '').toLowerCase();
        const jobError = String(rawResult.error || (output && output.error) || '').trim();
        const hasSegments = Array.isArray(rawResult.segments) && rawResult.segments.length > 0
            || (output && Array.isArray(output.segments) && output.segments.length > 0);
        const isFailedJob = jobStatus === 'failed' || (!!jobError && !hasSegments);

        // 1. SHOW PLAYER: same layout (video-wrapper) for both audio (m4a) and video so transcript is visible in parallel
        const playerContainer = document.getElementById('audio-player-container');
        const videoWrapper = document.getElementById('video-wrapper');
        const videoPlayer = document.getElementById('video-player-container');
        const mainVideo = document.getElementById('main-video');
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        const savedUrl = getLocalPreviewAudioUrl();

        if (!savedUrl) {
            try {
                const s3KeyForPreview = localStorage.getItem('lastS3Key') || localStorage.getItem('pendingS3Key');
                if (s3KeyForPreview && typeof supabase !== 'undefined' && supabase.auth) {
                    const { data: { user: previewUser } } = await supabase.auth.getUser();
                    if (previewUser && previewUser.id) {
                        await qsAttachS3MediaPreview(s3KeyForPreview, previewUser.id, {
                            filename: window.originalFileName || undefined,
                        });
                    }
                }
            } catch (_) {}
        }
        const previewUrl = getLocalPreviewAudioUrl();

        if (window.uploadWasVideo === true) {
            // Video: show mp4 viewer immediately so user can edit transcript (no separate "edit video" step)
            if (playerContainer && videoWrapper && videoPlayer && playerContainer.parentNode === videoPlayer) {
                videoWrapper.parentNode.insertBefore(playerContainer, videoWrapper);
            }
            if (playerContainer) playerContainer.style.display = 'none';
            if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
            if (mainVideo) mainVideo.style.display = '';
            const videoSrc = document.getElementById('video-source');
            if (videoSrc && previewUrl) {
                videoSrc.src = previewUrl;
                let mime = getLocalPreviewAudioMime() || 'video/mp4';
                if (mime.toLowerCase().includes('quicktime') || (previewUrl + '').toLowerCase().includes('.mov')) mime = 'video/mp4';
                videoSrc.type = mime;
            }
            if (mainVideo) {
                mainVideo.controls = true;
                mainVideo.load();
                mainVideo.pause();
                if (window.currentSegments && window.currentSegments.length > 0) {
                    const attachSubtitles = () => {
                        if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                        if (typeof window.showSubtitleStyleSelector === 'function') window.showSubtitleStyleSelector();
                    };
                    mainVideo.addEventListener('loadedmetadata', attachSubtitles, { once: true });
                    if (mainVideo.readyState >= 1) attachSubtitles();
                }
            }
            if (videoPlayer) videoPlayer.style.display = 'block';
        } else {
            // Audio only (m4a, mp3, etc.): use audio player only, no video
            if (playerContainer && videoWrapper && videoPlayer && playerContainer.parentNode === videoPlayer) {
                videoWrapper.parentNode.insertBefore(playerContainer, videoWrapper);
            }
            if (playerContainer) playerContainer.style.display = 'block';
            if (videoWrapper) { videoWrapper.style.display = 'none'; videoWrapper.classList.remove('visible'); }
            if (mainVideo) mainVideo.style.display = 'none';
            if (audioSource && mainAudio && previewUrl) {
                audioSource.src = previewUrl;
                const mime = getLocalPreviewAudioMime() || '';
                if (mime) audioSource.type = mime;
                else audioSource.type = 'audio/mp4';
                mainAudio.load();
            }
        }
        syncMobileVideoSessionState();

        const mainBtn = document.getElementById('main-btn');

        if (isFailedJob) {
            window.currentSegments = [];
            window.currentFormattedDoc = null;
            window._qsDocPreferSegmentsAfterEdit = false;
            setTranscriptActionButtonsVisible(false);
            if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
            const transcriptWindow = document.getElementById('transcript-window');
            const safeErr = (jobError || 'Transcription failed. Please try again.').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            if (transcriptWindow) {
                transcriptWindow.innerHTML = `<p style="color:#b91c1c; text-align:center; margin-top:40px; white-space:pre-wrap;">${safeErr}</p>`;
                transcriptWindow.setAttribute('contenteditable', 'false');
            }
            if (typeof showStatus === 'function') showStatus(safeErr, true);
            setDiarizationBusyState(false);
            window.isTriggering = false;
            stopProcessingStateUI('handle_job_update_job_failed');
            if (jobId) {
                window._handleJobUpdateInFlight = null;
                window._lastProcessedJobId = jobId;
            }
            return;
        }

        if (window.isTriggering) {
            qsCompleteTranscribePipelineProgress();
            qsStartSummaryPipelineProgress();
        }

        /** Keep toolbar hidden until summary GPT completes (cleanup is lazy on Transcript tab). */
        const deferToolbarUntilGptDone = true;
        const summaryAlreadyDone = qsJobSummaryAlreadyDone(jobId);
        if (!summaryAlreadyDone) {
            qsResetCleanupState();
            window._medicalHasResult = false;
            setTranscriptActionButtonsVisible(false);
            try { if (typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs(); } catch (_) {}
            try { if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi(); } catch (_) {}
            try { if (typeof syncStandardFormatTabs === 'function') syncStandardFormatTabs(); } catch (_) {}
        }

        // 3. PROCESS DATA — support multiple API shapes (RunPod, simulation, etc.)
        let segments = incomingSegs.length ? incomingSegs.slice() : [];
        if (!segments.length) {
            const hydrated = await qsHydrateSegmentsWithRetry(rawResult, inputS3KeyForJob);
            if (hydrated && hydrated.length) {
                segments = hydrated;
            }
        }
        if (!segments.length && jobId) {
            try {
                const res = await fetch(`/api/check_status/${encodeURIComponent(jobId)}`);
                if (res.ok) {
                    const statusData = await res.json();
                    const polled = extractSegmentsFromJobPayload(statusData);
                    if (polled.length) {
                        console.info('[qs] recovered segments from check_status', { jobId, segments: polled.length });
                        segments = polled;
                    }
                }
            } catch (_) {}
        }
        const flatWordSegments = (output && output.word_segments) || rawResult.word_segments || (rawResult.result && rawResult.result.word_segments);
        // Real word timestamps → word/caption model (coerces numeric strings; optional flat `word_segments`).
        const wordModel = _tryBuildWordModelFromSegmentsAndFlat(segments, flatWordSegments);
        if (wordModel) {
            window.currentWords = wordModel.words;
            // Keep caption line width consistent with file-open/import flow.
            window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, wordModel.captions, 54);
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        } else {
            window.currentWords = null;
            window.currentCaptions = null;
            segments = splitLongSegments(segments, 40);
            window.currentSegments = segments;
        }

        if (!window.currentSegments || !window.currentSegments.length) {
            window._qsShowEmptyTranscriptNotice = true;
            console.warn('[qs] completed job has no transcript segments after socket + S3 hydrate', {
                jobId,
                outputKey: rawResult.outputKey || (output && output.outputKey),
            });
        } else {
            window._qsShowEmptyTranscriptNotice = false;
        }

        // First, treat these as raw segments (or derived captions).

        let userLang = 'he';
        try {
            userLang = (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he');
        } catch (_) {}

        // Keep processing spinner through summary GPT stage (skip if already generated for this job).
        if (!summaryAlreadyDone) {
            if (mainBtn) mainBtn.disabled = true;
            console.info('[qs-processing-ui] summary_gpt_start', {
                segment_count: (window.currentSegments || []).length
            });

            if (!(typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled())) {
                setFormatViewMode('summary');
            }
        } else {
            console.info('[qs-processing-ui] summary_gpt_skip (already done for job)', { jobId });
        }

        // Summary GPT first; transcript cleanup runs lazily when the user opens the Transcript tab.
        const runPostTranscriptionFormatting = async () => {
            const fullText = buildTranscriptTextForGptFormat();
            if (!fullText) return false;
            const jobId = localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || undefined;
            const medFmt = typeof effectiveIsMedicalForFormatting === 'function' && effectiveIsMedicalForFormatting();
            try {
                console.info('[GPT] format_transcript_summary start', {
                    chars: fullText.length,
                    medical: medFmt,
                    mode: medFmt ? 'unified' : 'summary_only'
                });
                const { ok, fmt } = await runFormatTranscriptSummaryRequests(fullText, userLang || 'he', jobId);
                if (!ok || !fmt || typeof fmt !== 'object') return false;
                let safeFmt = fmt;
                if (medFmt && _medicalFormatLooksHallucinated(fullText, fmt)) {
                    console.warn('[medical] format guardrail: rejecting hallucinated summary for short transcript');
                    safeFmt = _medicalMinimalFormattedDocFromTranscript(fullText) || fmt;
                }
                const prev = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
                    ? window.currentFormattedDoc
                    : {};
                const rawFmt = {
                    clean_transcript: medFmt ? String(safeFmt.clean_transcript || '').trim() : String(prev.clean_transcript || '').trim(),
                    overview: String(safeFmt.overview || '').trim(),
                    key_points: Array.isArray(safeFmt.key_points)
                        ? safeFmt.key_points.map((p) => normalizeActionItemEntry(p)).filter(Boolean)
                        : [],
                    action_items: Array.isArray(safeFmt.action_items)
                        ? safeFmt.action_items.map((p) => normalizeActionItemEntry(p)).filter(Boolean)
                        : []
                };
                for (const k of ['medical_chief_complaint', 'medical_examination_transcript', 'medical_patient_recommendations']) {
                    if (safeFmt[k] != null) rawFmt[k] = safeFmt[k];
                }
                window.currentFormattedDoc = normalizeFormattedFields(rawFmt);
                window._qsDocPreferSegmentsAfterEdit = false;
                if (medFmt && hasCleanTranscript()) window._qsCleanupDone = true;
                if (jobId) {
                    window._qsSummaryGptDoneJobId = jobId;
                    window._lastProcessedJobId = jobId;
                }
                void qsPersistFormattedDocToS3();
                try {
                    if (isMedicalModeEnabled()) {
                        window.medicalActiveTab = 'summary';
                        if (typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs();
                        if (typeof renderTranscriptFromCues === 'function') {
                            renderTranscriptFromCues(window.currentSegments || []);
                        }
                    } else if (hasStandardFormattedSummary()) {
                        setFormatViewMode('summary');
                        renderStandardSummaryView();
                    }
                } catch (_) {}
                return true;
            } catch (e) {
                console.warn('[GPT] format_transcript_summary failed, export will fallback:', e);
                return false;
            }
        };

        if (!summaryAlreadyDone) {
            await runPostTranscriptionFormatting();
        } else if (!(typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled())) {
            setFormatViewMode('summary');
            renderStandardSummaryView();
        }
        qsCompleteSummaryPipelineProgress();

        // Ensure global segments are set (already handled above); keep legacy flow happy.
        const finalStatus = 'processed';

        // Persist transcript: save JSON to S3 and store only result_s3_key in DB (or fallback to result.segments)
        if (typeof updateJobStatus === 'function' && dbId) {
            (async () => {
                try {
                    const { data: { user } } = await supabase.auth.getUser();
                    const s3Key = (inputS3KeyForJob || localStorage.getItem('lastS3Key') || '').trim();
                    const medForSave = (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled()) ||
                        (typeof isMedicalLayoutRawAudioKey === 'function' && isMedicalLayoutRawAudioKey(s3Key));
                    if (user && s3Key && window.currentSegments.length) {
                        const res = await fetch('/api/save_job_result', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                userId: user.id,
                                input_s3_key: s3Key,
                                segments: window.currentSegments,
                                words: window.currentWords || undefined,
                                captions: window.currentCaptions || undefined,
                                formatted: window.currentFormattedDoc || undefined,
                                stage: 'gpt',
                                isMedical: medForSave
                            })
                        });
                        const data = res.ok ? await res.json() : {};
                        if (data.result_s3_key) {
                            updateJobStatus(dbId, finalStatus, { result_s3_key: data.result_s3_key });
                        } else {
                            updateJobStatus(dbId, finalStatus, { segments: window.currentSegments });
                        }
                    } else {
                        updateJobStatus(dbId, finalStatus, { segments: window.currentSegments });
                    }
                } catch (_) {
                    updateJobStatus(dbId, finalStatus, { segments: window.currentSegments });
                }
            })();
        }

        // We create a Set of all speaker IDs found in the segments
        const uniqueSpeakers = new Set(
            (window.currentSegments || [])
                .map((seg) => seg && seg.speaker)
                .filter((sp) => sp != null && String(sp).trim() !== '')
        );

        // Only enable if there are 2 or more DIFFERENT speakers
        window.aiDiarizationRan = uniqueSpeakers.size > 1;
        // AUTO-ACTIVATE: If AI ran, we turn the 'Show Speakers' switch ON
        const speakerToggle = document.getElementById('toggle-speaker');
        if (window.aiDiarizationRan && speakerToggle) {
            speakerToggle.checked = true;
        }

        // Update toggles and render
        syncSpeakerControls();

        // Large word/caption + renderWordCaptionEditor blocks the main thread for seconds; without a yield the
        // UI looks frozen between translate finishing and format/save network chatter.
        if (mainBtn) mainBtn.disabled = true;
        await new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const transcriptWindow = document.getElementById('transcript-window');
        if (transcriptWindow) {
            try { qsClearTranscriptEditState(transcriptWindow); } catch (_) {}
            if (!window.currentSegments || !window.currentSegments.length) {
                qsRenderEmptyTranscriptMessage();
            } else if (isMedicalModeEnabled()) {
                if (String(window.medicalActiveTab || 'summary') === 'summary') {
                    renderTranscriptFromCues(window.currentSegments || []);
                } else if (typeof renderMedicalTranscriptMainView === 'function') {
                    renderMedicalTranscriptMainView();
                } else {
                    renderTranscriptFromCues(window.currentSegments || []);
                }
            } else {
                // Library ?open= puts summary in a host above #transcript-window; clear it on a fresh transcribe result.
                try { clearOpenJobStandardSummaryHost(); } catch (_) {}
                if (isSummaryViewEnabled()) {
                    renderStandardSummaryView();
                } else {
                    try {
                        if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions)) {
                            renderWordCaptionEditor();
                        } else {
                            window.render();
                        }
                    } catch (renderErr) {
                        console.error('[qs] transcript render failed; keeping export toolbar available', renderErr);
                    }
                }
            }
            try { if (typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs(); } catch (_) {}
            // Show subtitle style selector when subtitles are available (video only; audio uses transcript only)
            window.showSubtitleStyleSelector();
            // NEW: Live Preview for Subtitles (bind once — handleJobUpdate can run multiple times per session)
            if (transcriptWindow.dataset.qsCueInputBound !== '1') {
                transcriptWindow.dataset.qsCueInputBound = '1';
                transcriptWindow.addEventListener('input', (e) => {
                // Only run if we are actively in edit mode
                if (transcriptWindow.contentEditable !== 'true') return;
                
                const p = e.target.closest('p[data-idx]');
                if (p) {
                    const idx = parseInt(p.getAttribute('data-idx'));
                    const newText = p.innerText.trim();
                    
                    // Instantly update the HTML5 Video Track Cue
                    const video = document.getElementById('main-video');
                    if (video && video.textTracks && video.textTracks.length > 0) {
                        const track = video.textTracks[0];
                        if (track.cues && track.cues[idx]) {
                            track.cues[idx].text = newText;
                        }
                    }
                }
            });
            }
        }

        // Finally, restore button + status text after GPT stage completes.
        qsStopFakeProgress('handleJobUpdate_complete');
        if (mainBtn) {
            mainBtn.disabled = false;
            if (typeof setMainButtonAction === 'function') setMainButtonAction('new_session');
            else {
                qsClearMainBtnDynamicLabel();
                const T = typeof window.t === 'function' ? window.t : (k) => k;
                mainBtn.innerText = T('new_session') || 'New Session';
            }
        }
        if (statusTxt) {
            statusTxt.innerText = typeof window.t === 'function' ? window.t('transcription_complete') : "Transcription Complete";
            setTimeout(() => {
                const ps = document.getElementById('preparing-screen');
                if (ps) ps.style.display = 'none';
            }, 3000);
        }
        try {
            const cur = String(window.originalFileName || '').trim().toLowerCase();
            const bn = getExportBaseNameNoExt();
            if (bn && bn !== 'transcript' && (!cur || cur === 'transcript')) {
                window.originalFileName = bn;
            }
        } catch (_) {}
        window.isTriggering = false;
        if (isMedicalModeEnabled()) {
            window._medicalHasResult = true;
            try { if (typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs(); } catch (_) {}
            try { if (typeof window.applyMedicalModeUi === 'function') window.applyMedicalModeUi(); } catch (_) {}
            try { if (typeof window.syncMedicalPrimaryActionBtn === 'function') window.syncMedicalPrimaryActionBtn(); } catch (_) {}
        }
        console.info('[qs-processing-ui] handleJobUpdate finished (success path)', { ts: new Date().toISOString() });
        if (deferToolbarUntilGptDone) {
            stopProcessingStateUI('handle_job_update_success_pipeline_done');
        }
        setTranscriptActionButtonsVisible(true);
        qsEnsureTranscriptToolbarVisible('handle_job_update_success', { force: true });
        qsScheduleTranscriptToolbarEnsure('handle_job_update_success_deferred', { force: true });
        try {
            const hasTranscript = !!(window.currentSegments && window.currentSegments.length);
            const alreadyShown = jobId && window._qsSavedToastJobId === jobId;
            if (hasTranscript && !alreadyShown) {
                const { data: { user: savedToastUser } } = await supabase.auth.getUser();
                if (savedToastUser && typeof showStatus === 'function') {
                    if (jobId) window._qsSavedToastJobId = jobId;
                    const T = typeof window.t === 'function' ? window.t : (k) => k;
                    showStatus(
                        T('transcription_saved_toast') || 'התמלול נשמר בהצלחה! הקובץ זמין תמיד באזור האישי שלך.',
                        false,
                        { duration: 8000, toastPosition: 'above', toastAnchorId: 'main-btn' }
                    );
                }
            }
        } catch (_) {}
        if (jobId) {
            window._handleJobUpdateInFlight = null;
            window._lastProcessedJobId = jobId;
            if (hasStandardFormattedSummary() || (typeof isMedicalModeEnabled === 'function' && isMedicalModeEnabled())) {
                window._qsSummaryGptDoneJobId = jobId;
            }
        }
        qsDeferJobCreditsAfterDelivery(
            jobId,
            inputS3KeyForJob || localStorage.getItem('lastS3Key') || ''
        );
    };

function groupSegmentsBySpeaker(segments, enableGlue = true) {
        if (!segments || segments.length === 0) return [];

        // --- SUBTITLE MODE (No Glue) ---
        // If glue is disabled, just return the segments exactly as the Chopper cut them.
        if (!enableGlue) {
            return segments.map(seg => ({
                speaker: seg.speaker || 'monologue',
                start: seg.start,
                text: seg.text
            }));
        }

        // --- DOCUMENT MODE (Glue) ---
        // If glue is enabled, merge consecutive segments from the same speaker.
        const groups = [];
        let currentGroup = {
            speaker: segments[0].speaker || 'monologue',
            start: segments[0].start,
            text: segments[0].text
        };

        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i];
            const segSpeaker = seg.speaker || 'monologue';

            if (segSpeaker === currentGroup.speaker) {
                currentGroup.text += " " + seg.text;
            } else {
                groups.push(currentGroup);
                currentGroup = {
                    speaker: segSpeaker,
                    start: seg.start,
                    text: seg.text
                };
            }
        }
        groups.push(currentGroup);
        return groups;
    }

    /**
     * Returns the segment that contains the given playback time.
     * Uses next segment's start as end when segment.end is missing so only one segment matches.
     */
    function getActiveSegmentAtTime(segments, currentTime) {
        if (!segments || segments.length === 0) return null;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const end = seg.end != null ? seg.end : (segments[i + 1] ? segments[i + 1].start : seg.start + 9999);
            if (currentTime >= seg.start && currentTime < end) return seg;
        }
        const last = segments[segments.length - 1];
        if (currentTime >= last.start) return last;
        return null;
    }
    window.getActiveSegmentAtTime = getActiveSegmentAtTime;

    /**
     * Returns the paragraph-row index for a given segment (same grouping as groupSegmentsBySpeaker).
     * Used so audio/video timeupdate can highlight the correct row (seg-row-N).
     */
    function getGroupIndexForSegment(segments, targetSegment) {
        if (!segments || segments.length === 0 || !targetSegment) return 0;
        const enableGlue = !!window.isDocumentMode;
        if (!enableGlue) {
            const idx = segments.findIndex(s => s === targetSegment || (s.start === targetSegment.start && (s.text === targetSegment.text)));
            return idx >= 0 ? idx : 0;
        }
        let groupIndex = 0;
        let prevSpeaker = segments[0].speaker || 'monologue';
        if (segments[0] === targetSegment || (segments[0].start === targetSegment.start && segments[0].text === targetSegment.text))
            return 0;
        for (let i = 1; i < segments.length; i++) {
            const s = segments[i];
            const sp = s.speaker || 'monologue';
            if (sp !== prevSpeaker) groupIndex++;
            prevSpeaker = sp;
            if (s === targetSegment || (s.start === targetSegment.start && s.text === targetSegment.text))
                return groupIndex;
        }
        return groupIndex;
    }
    window.getGroupIndexForSegment = getGroupIndexForSegment;

    /**
     * Synchronizes the relationship between the 'Detect Speakers' AI toggle
     * and the 'Show Speakers' UI toggle.
     */
    function syncSpeakerControls() {
        const speakerToggle = document.getElementById('toggle-speaker');
        if (!speakerToggle) return;

        // RULE: Only enable the 'Show' switch if AI actually ran for this specific job
        if (window.aiDiarizationRan) {
            speakerToggle.disabled = false;
            speakerToggle.parentElement.style.opacity = "1";
            // We don't force it to 'checked' here so the user can still hide them if they want
        } else {
            speakerToggle.disabled = true;
            speakerToggle.checked = false; // Force OFF if no data exists
            speakerToggle.parentElement.style.opacity = "0.5";
        }

    // 1. Fixed: Attached to window to solve "ReferenceError"
    window.render = function() {
        const transcriptWindow = document.getElementById('transcript-window');
        if (!transcriptWindow) return;
        if (!window.currentSegments || !window.currentSegments.length) {
            if (qsShouldShowEmptyTranscriptNotice()) {
                qsRenderEmptyTranscriptMessage();
            } else {
                qsClearTranscriptWindowIdle();
            }
            return;
        }
        window._qsShowEmptyTranscriptNotice = false;

        // Medical UI uses tabs + formatted views, not the generic segment/subtitle renderer.
        if (isMedicalModeEnabled()) {
            if (String(window.medicalActiveTab || 'summary') === 'summary') {
                if (typeof renderTranscriptFromCues === 'function') {
                    renderTranscriptFromCues(window.currentSegments || []);
                }
                return;
            }
            if (typeof renderMedicalTranscriptMainView === 'function') {
                renderMedicalTranscriptMainView();
            } else if (typeof renderTranscriptFromCues === 'function') {
                renderTranscriptFromCues(window.currentSegments || []);
            }
            return;
        }

        // Subtitle mode = per-segment lines; Doc mode = glued paragraphs by speaker.
        window.isDocumentMode = isDocumentFormatEnabled();
        if (window.isDocumentMode) {
            const docParagraphs = getDocFormatParagraphs();
            const banner = qsTranscriptCleanupBannerHtml();
            if (docParagraphs.length) {
                const htmlDoc = docParagraphs.map((p) => {
                    const safe = p.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return `<div class="paragraph-row" style="display:block; margin-bottom: 0.35em;"><p style="margin: 0; line-height: 1.7; cursor: text;">${safe}</p></div>`;
                }).join('');
                transcriptWindow.innerHTML = banner + htmlDoc;
                transcriptWindow.contentEditable = 'false';
                return;
            }
        }
        const groupedData = groupSegmentsBySpeaker(window.currentSegments, window.isDocumentMode);


        const html = groupedData.map((g, rowIndex) => {
            // 2. Fixed: Get state of both toggles
            const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
            const isTimeVisible = isTimeToggleVisible();

            const showLabel = isSpeakerVisible && window.aiDiarizationRan;

            const startNum = Number(g.start);
            const rowClick = Number.isFinite(startNum) ? ` onclick="window.jumpTo(${startNum})"` : '';
            return `
            <div class="paragraph-row" id="seg-row-${rowIndex}" style="display:block; margin-bottom: 2px; cursor: pointer;"${rowClick}>
                <div style="font-size: 0.74em; color: #9ca3af; margin-bottom: 0; line-height: 1.05;">

                    <span class="timestamp" style="display: ${isTimeVisible ? 'block' : 'none'};">
                        ${formatTime(g.start)}
                    </span>

                    <span style="display: ${showLabel ? 'block' : 'none'}; font-weight: 600; color: ${getSpeakerColor(g.speaker)};">
                        ${g.speaker.replace('SPEAKER_', 'דובר ')}
                    </span>
                </div><p data-idx="${rowIndex}" style="margin: 0 !important; margin-top: -2px; line-height: 1.2;">${window.isDocumentMode ? g.text : wrapTextByMaxChars(g.text, 50)}</p>
            </div>`;
        }).join('');

        transcriptWindow.innerHTML = html;
        transcriptWindow.contentEditable = 'false';
    };
    }
    // --- 3. UI HELPERS ---
    function updateSpeakerToggleUI(hasSpeakerData) {
        const diarizationToggle = document.getElementById('diarization-toggle');
        const speakerToggle = document.getElementById('toggle-speaker');

        if (!diarizationToggle || !speakerToggle) return;

        // We only turn the 'Show' switch Blue  if the AI was active
        // AND it actually found speaker data.
        if (diarizationToggle.checked && hasSpeakerData) {
            speakerToggle.disabled = false;
            speakerToggle.checked = true; // This makes it Blue
            speakerToggle.parentElement.style.opacity = "1";
        } else {
            speakerToggle.disabled = true;
            speakerToggle.checked = false; // Stay Grey
            speakerToggle.parentElement.style.opacity = "0.5";
        }
    }

    // --- 4. RENDER LOGIC ---
    function renderParagraphs(segments) {
        if (!segments || segments.length === 0) return "";

        window.isDocumentMode = isDocumentFormatEnabled();
        if (!window.isDocumentMode) {
            return segments.map(seg => buildGroupHTML({
                speaker: seg.speaker,
                start: seg.start,
                sentences: [seg]
            })).join('');
        }

        let html = "", group = null;

        segments.forEach(seg => {
            // Normalize: Treat null, undefined, or missing as the same "none" speaker
            const currentSpeaker = seg.speaker || "none";
            const groupSpeaker = group ? (group.speaker || "none") : null;

            if (!group || groupSpeaker !== currentSpeaker) {
                // Close the previous group
                if (group) html += buildGroupHTML(group);

                // Start a new group
                group = {
                    speaker: seg.speaker, // Keep original for labels
                    start: seg.start,
                    sentences: []
                };
            }
            group.sentences.push(seg);
        });

        if (group) html += buildGroupHTML(group);
        return html;
    }
    // --- BUTTON HANDLERS ---
    window.jumpTo = function(seconds) {
        const win = document.getElementById('transcript-window');
        // Legacy paragraph edit: whole window is contenteditable; inline jumpTo on <p> would fight the caret — keep blocked.
        if (win && win.contentEditable === 'true') return;
        if (isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'summary' &&
            win && win.classList.contains('transcript-editing')) return;
        const t = typeof seconds === 'number' ? seconds : Number(seconds);
        if (!Number.isFinite(t)) return;
        const player = (typeof window._getPrimaryMediaElement === 'function')
            ? window._getPrimaryMediaElement()
            : (document.querySelector('video') || document.querySelector('audio'));
        if (!player) return;
        player.currentTime = t;
        // Word-caption edit or sync mode: seek but do not auto-play.
        if (win && win.classList && (
            win.classList.contains('transcript-editing') ||
            win.classList.contains('transcript-sync-mode')
        )) {
            try { player.pause(); } catch (_) {}
            return;
        }
        player.play();
    };

    // Debug helpers for simulation mode: re-test paragraph/doc view without re-uploading a file.
    window.qsDebugRebuildParagraphDoc = function() {
        try {
            const subBtn = document.getElementById('format-mode-subtitle');
            const docBtn = document.getElementById('format-mode-doc');
            if (docBtn && subBtn) {
                docBtn.classList.add('is-active');
                subBtn.classList.remove('is-active');
            }
            if (typeof renderWordCaptionEditor === 'function') {
                renderWordCaptionEditor();
            } else if (typeof window.render === 'function') {
                window.render();
            }
            console.info('[qs-debug] rebuilt paragraph doc view');
        } catch (e) {
            console.warn('[qs-debug] qsDebugRebuildParagraphDoc failed', e);
        }
    };
    window.qsDebugSubtitleView = function() {
        try {
            const subBtn = document.getElementById('format-mode-subtitle');
            const docBtn = document.getElementById('format-mode-doc');
            if (docBtn && subBtn) {
                docBtn.classList.remove('is-active');
                subBtn.classList.add('is-active');
            }
            if (typeof renderWordCaptionEditor === 'function') {
                renderWordCaptionEditor();
            } else if (typeof window.render === 'function') {
                window.render();
            }
            console.info('[qs-debug] switched to subtitle view');
        } catch (e) {
            console.warn('[qs-debug] qsDebugSubtitleView failed', e);
        }
    };
    window.qsDebugRegenerateFormattedFromApi = async function() {
        try {
            if (typeof ensureFormattedViaApiForExport !== 'function') return false;
            const ok = await ensureFormattedViaApiForExport();
            if (ok) {
                const subBtn = document.getElementById('format-mode-subtitle');
                const docBtn = document.getElementById('format-mode-doc');
                if (docBtn && subBtn) {
                    docBtn.classList.add('is-active');
                    subBtn.classList.remove('is-active');
                }
                if (typeof renderWordCaptionEditor === 'function') {
                    renderWordCaptionEditor();
                } else if (typeof window.render === 'function') {
                    window.render();
                }
                console.info('[qs-debug] regenerated formatted via API and refreshed doc view');
            } else {
                console.warn('[qs-debug] ensureFormattedViaApiForExport returned false');
            }
            return !!ok;
        } catch (e) {
            console.warn('[qs-debug] qsDebugRegenerateFormattedFromApi failed', e);
            return false;
        }
    };
    window.qsDebugCompareDocxSources = async function() {
        try {
            const fromSegments = String(buildTranscriptPlainBodyForExport() || '').trim();
            const fromFormatted = String((window.currentFormattedDoc && window.currentFormattedDoc.clean_transcript) || '').trim();
            const effectiveForExport = (fromSegments || fromFormatted).trim();
            const local = {
                fromSegments_len: fromSegments.length,
                fromFormatted_len: fromFormatted.length,
                effectiveForExport_len: effectiveForExport.length,
                fromSegments_head: fromSegments.slice(0, 220),
                fromFormatted_head: fromFormatted.slice(0, 220),
                effectiveForExport_head: effectiveForExport.slice(0, 220),
            };

            let s3 = { note: 'not_checked' };
            try {
                const dbId = localStorage.getItem('lastJobDbId');
                const { data: { user } } = await supabase.auth.getUser();
                if (dbId && user && user.id) {
                    const { data: row } = await supabase
                        .from('jobs')
                        .select('result_s3_key')
                        .eq('id', dbId)
                        .eq('user_id', user.id)
                        .maybeSingle();
                    if (row && row.result_s3_key) {
                        const p = await fetch('/api/get_presigned_url', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ s3Key: row.result_s3_key, userId: user.id })
                        });
                        const pj = await p.json().catch(() => ({}));
                        if (pj && pj.url) {
                            const tr = await fetch(pj.url).then((r) => r.json()).catch(() => ({}));
                            const s3Fmt = String((((tr || {}).formatted || {}).clean_transcript) || '').trim();
                            s3 = {
                                result_s3_key: row.result_s3_key,
                                formatted_len: s3Fmt.length,
                                formatted_head: s3Fmt.slice(0, 220),
                            };
                        } else {
                            s3 = { error: 'presign_failed', detail: pj };
                        }
                    } else {
                        s3 = { note: 'no_result_s3_key' };
                    }
                } else {
                    s3 = { note: 'no_lastJobDbId_or_no_user' };
                }
            } catch (e) {
                s3 = { error: String((e && e.message) || e) };
            }

            const out = { local, s3 };
            console.info('[qs-debug] docx source compare', out);
            return out;
        } catch (e) {
            console.warn('[qs-debug] qsDebugCompareDocxSources failed', e);
            return null;
        }
    };


    window.saveEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');
        const isMedicalSummaryEdit =
            isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'summary';
        const isMedicalTranscriptEdit =
            isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'transcript';
        if (isMedicalSummaryEdit) {
            const chiefEl = win ? (win.querySelector('[data-medical-section="chief"]') || win.querySelector('#medical-summary-chief')) : null;
            const examEl = win ? (win.querySelector('[data-medical-section="exam"]') || win.querySelector('#medical-summary-exam')) : null;
            const recEl = win ? (win.querySelector('[data-medical-section="rec"]') || win.querySelector('#medical-summary-rec')) : null;
            const overviewEl = win ? win.querySelector('#medical-summary-overview') : null;
            const pointsList = win ? win.querySelector('#medical-summary-points') : null;
            const existing = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
                ? window.currentFormattedDoc
                : {};
            const strip = (el) => (el ? String(el.innerText || '').trim().replace(/\s+/g, ' ') : '');
            if (chiefEl || examEl || recEl) {
                const medical_chief_complaint = strip(chiefEl);
                const medical_examination_transcript = _stripLeadingMedicalExamLegacyPrefix(strip(examEl));
                const medical_patient_recommendations = strip(recEl);
                const kp = [medical_examination_transcript, medical_patient_recommendations].filter(Boolean);
                window.currentFormattedDoc = {
                    ...existing,
                    overview: medical_chief_complaint,
                    key_points: kp,
                    medical_chief_complaint,
                    medical_examination_transcript,
                    medical_patient_recommendations
                };
            } else {
                const overview = strip(overviewEl);
                const key_points = pointsList
                    ? Array.from(pointsList.querySelectorAll('li'))
                        .map((li) => String(li.innerText || '').trim().replace(/\s+/g, ' '))
                        .filter(Boolean)
                    : [];
                window.currentFormattedDoc = {
                    ...existing,
                    overview,
                    key_points
                };
            }
            win.contentEditable = 'false';
            _qsSetMedicalSummaryPaneEditable(win, false);
            win.style.border = "1px solid #e2e8f0";
            win.style.backgroundColor = "transparent";
            win.classList.remove('transcript-editing', 'transcript-sync-mode');
            window._qsTimingMode = false;
            window._qsTimingModeBackup = null;
            _qsSetSyncModeButtonActive(false);
            if (editActions) editActions.style.display = 'none';
            window._qsForceLegacyEditMode = false;
            try { renderTranscriptFromCues(window.currentSegments || []); } catch (_) {}
            return;
        }
        if (isMedicalTranscriptEdit) {
            const lines = win
                ? Array.from(win.querySelectorAll('.qs-medical-plain-paragraph p, p'))
                    .map((el) => String(el.innerText || '').trim())
                    .filter(Boolean)
                : [];
            const clean = String(lines.join('\n\n')).trim();
            const prev = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
                ? window.currentFormattedDoc
                : {};
            window.currentFormattedDoc = { ...prev, clean_transcript: clean };
            win.contentEditable = 'false';
            win.style.border = "1px solid #e2e8f0";
            win.style.backgroundColor = "transparent";
            win.classList.remove('transcript-editing', 'transcript-sync-mode');
            window._qsTimingMode = false;
            window._qsTimingModeBackup = null;
            _qsSetSyncModeButtonActive(false);
            if (editActions) editActions.style.display = 'none';
            window._qsForceLegacyEditMode = false;
            try { renderMedicalTranscriptMainView(); } catch (_) {}
            return;
        }
        const timingOnly = !!window._qsTimingMode;
        // Edits should immediately drive doc view/export text, even if old GPT formatted text still exists.
        window._qsDocPreferSegmentsAfterEdit = true;
        // If a token input is currently open, commit it before extracting/saving data.
        // Mobile can lag blur -> commit, so we retry with a short delay and then force-apply.
        try {
            const activeInput = win ? win.querySelector('span.word-token.editing input.qs-token-input') : null;
            if (activeInput) {
                const retries = Number(window._qsSaveEditsPendingRetryCount || 0);
                if (typeof activeInput.blur === 'function' && retries < 2) {
                    window._qsSkipCommitRefocus = true;
                    try { activeInput.blur(); } catch (_) {}
                    window._qsSaveEditsPendingRetryCount = retries + 1;
                    setTimeout(() => {
                        try { window.saveEdits(); } catch (_) {}
                    }, 140);
                    return;
                }
                // Fallback: force-apply current token text if blur commit did not complete.
                const host = activeInput.closest('span.word-token[data-wi]');
                const wi = host ? parseInt(host.getAttribute('data-wi'), 10) : NaN;
                if (
                    Number.isFinite(wi) &&
                    Array.isArray(window.currentWords) &&
                    window.currentWords[wi]
                ) {
                    const forced = String(activeInput.value || '').trim();
                    window.currentWords[wi].text = forced;
                    if (Array.isArray(window.currentCaptions) && window.currentCaptions.length && typeof _captionsToCues === 'function') {
                        window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                    }
                }
            }
            window._qsSaveEditsPendingRetryCount = 0;
        } catch (_) {}
        const useWordModelEditor = (
            Array.isArray(window.currentWords) &&
            Array.isArray(window.currentCaptions) &&
            window.currentWords.length > 0 &&
            window.currentCaptions.length > 0 &&
            !window._qsForceLegacyEditMode
        );

        // Line-timing mode (legacy segments only): persist segments.
        if (timingOnly && !useWordModelEditor && Array.isArray(window.currentSegments) && window.currentSegments.length) {
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
            if (typeof updateJobStatus === 'function') {
                (async () => {
                    try {
                        const { data: { user } } = await supabase.auth.getUser();
                        const dbId = localStorage.getItem('lastJobDbId');
                        const s3Key = localStorage.getItem('lastS3Key');
                        if (user && dbId && s3Key) {
                            const res = await fetch('/api/save_job_result', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    userId: user.id,
                                    input_s3_key: s3Key,
                                    segments: window.currentSegments
                                })
                            });
                            const data = res.ok ? await res.json() : {};
                            if (data.result_s3_key) {
                                updateJobStatus(dbId, 'processed', { result_s3_key: data.result_s3_key });
                            }
                        }
                    } catch (_) { /* ignore */ }
                })();
            }
            window._qsTimingMode = false;
            window._qsTimingModeBackup = null;
            if (win) {
                win.classList.remove('transcript-sync-mode');
                win.style.border = "1px solid #e2e8f0";
                win.style.backgroundColor = "transparent";
            }
            if (editActions) editActions.style.display = 'none';
            try { renderTranscriptFromCues(window.currentSegments || []); } catch (_) {}
            _qsSetSyncModeButtonActive(false);
            return;
        }

        // Word-level caption editor: persist model directly (no DOM paragraph extraction; no timing estimation).
        if (useWordModelEditor) {
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);

            // Refresh subtitles (VTT) immediately
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();

            // Persist edited transcript JSON to S3
            if (typeof updateJobStatus === 'function' && window.currentSegments && window.currentSegments.length) {
                (async () => {
                    try {
                        const { data: { user } } = await supabase.auth.getUser();
                        const dbId = localStorage.getItem('lastJobDbId');
                        const s3Key = localStorage.getItem('lastS3Key');
                        if (user && dbId && s3Key) {
                            const res = await fetch('/api/save_job_result', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    userId: user.id,
                                    input_s3_key: s3Key,
                                    segments: window.currentSegments,
                                    words: window.currentWords,
                                    captions: window.currentCaptions
                                })
                            });
                            const data = res.ok ? await res.json() : {};
                            if (data.result_s3_key) {
                                updateJobStatus(dbId, 'processed', { result_s3_key: data.result_s3_key });
                            }
                        }
                    } catch (_) { /* ignore */ }
                })();
            }

            // Close unified edit + timing (and re-render read-only word editor)
            win.contentEditable = 'false';
            win.style.border = "1px solid #e2e8f0";
            win.style.backgroundColor = "transparent";
            win.classList.remove('transcript-editing', 'transcript-sync-mode');
            window._qsTimingMode = false;
            window._qsTimingModeBackup = null;
            _qsSetSyncModeButtonActive(false);
            if (editActions) editActions.style.display = 'none';
            try { renderWordCaptionEditor(); } catch (_) {}
            window._qsForceLegacyEditMode = false;
            console.log("✅ Word-level edits saved and subtitles re-synced.");
            return;
        }

        // 1. EXTRACT FROM SCREEN: paragraphs in DOM order, normalized text + timestamp per row
        const pEls = Array.from(win.querySelectorAll('p[data-idx]')).sort((a, b) => {
            const ia = parseInt(a.getAttribute('data-idx'), 10);
            const ib = parseInt(b.getAttribute('data-idx'), 10);
            return (isNaN(ia) ? 0 : ia) - (isNaN(ib) ? 0 : ib);
        });
        const parr = pEls.map(el => {
            const row = el.closest('.paragraph-row');
            const tsEl = row ? row.querySelector('.timestamp') : null;
            const timeStr = tsEl ? (tsEl.textContent || '').trim() : '';
            const startSec = typeof parseTimeDisplay === 'function' ? parseTimeDisplay(timeStr) : NaN;
            return {
                text: (el.innerText || '').trim().replace(/\s+/g, ' '),
                startSec: (startSec >= 0 && Number.isFinite(startSec)) ? startSec : null
            };
        });
        const segs = window.currentSegments || [];
        const isDocModeNow = !!isDocumentFormatEnabled();

        // Document-mode save: rows are grouped paragraphs, not 1:1 subtitle cues.
        // Use edited paragraph rows as the new transcript body directly (old exact-text merge was brittle).
        if (isDocModeNow) {
            const nonEmpty = parr.filter(p => p.text.length > 0);
            const groups = [];
            if (segs.length > 0) {
                let startIdx = 0;
                let prevSpeaker = (segs[0] && segs[0].speaker) || 'SPEAKER_00';
                for (let i = 1; i < segs.length; i++) {
                    const sp = (segs[i] && segs[i].speaker) || 'SPEAKER_00';
                    if (sp !== prevSpeaker) {
                        groups.push({
                            startIdx,
                            endIdx: i - 1,
                            speaker: prevSpeaker,
                            start: Number(segs[startIdx] && segs[startIdx].start) || 0,
                            end: Number(segs[i - 1] && segs[i - 1].end)
                        });
                        startIdx = i;
                        prevSpeaker = sp;
                    }
                }
                groups.push({
                    startIdx,
                    endIdx: segs.length - 1,
                    speaker: prevSpeaker,
                    start: Number(segs[startIdx] && segs[startIdx].start) || 0,
                    end: Number(segs[segs.length - 1] && segs[segs.length - 1].end)
                });
            }

            const rebuilt = [];
            for (let i = 0; i < nonEmpty.length; i++) {
                const p = nonEmpty[i];
                const g = groups[i] || groups[groups.length - 1] || null;
                const prev = i > 0 ? rebuilt[i - 1] : null;
                const fallbackStart = (prev && Number.isFinite(prev.end))
                    ? prev.end
                    : (g && Number.isFinite(g.start) ? g.start : 0);
                const start = Number.isFinite(p.startSec) ? p.startSec : fallbackStart;
                const guessedEnd = (g && Number.isFinite(g.end) && g.end > start) ? g.end : (start + 1);
                rebuilt.push({
                    start,
                    end: guessedEnd,
                    text: p.text,
                    speaker: (g && g.speaker) || ((segs[i] && segs[i].speaker) || 'SPEAKER_00')
                });
            }

            // Keep monotonic, contiguous timing for stable subtitle/export behavior.
            for (let i = 0; i < rebuilt.length; i++) {
                if (i < rebuilt.length - 1) {
                    const nextStart = Number(rebuilt[i + 1].start);
                    rebuilt[i].end = Number.isFinite(nextStart) && nextStart > rebuilt[i].start
                        ? nextStart
                        : (rebuilt[i].start + 1);
                } else if (!(Number.isFinite(rebuilt[i].end) && rebuilt[i].end > rebuilt[i].start)) {
                    rebuilt[i].end = rebuilt[i].start + 1;
                }
            }
            window.currentSegments = rebuilt;
        } else if (parr.length < segs.length) {
            // User merged rows (e.g. backspace): merge segments so one segment per non-empty paragraph
            const nonEmpty = parr.filter(p => p.text.length > 0);
            const newSegs = [];
            let segIdx = 0;
            for (const p of nonEmpty) {
                const pText = p.text;
                if (segIdx >= segs.length) break;
                let combined = '';
                const startIdx = segIdx;
                while (segIdx < segs.length) {
                    const part = (segs[segIdx].text || '').trim();
                    combined = (combined ? combined + ' ' + part : part).replace(/\s+/g, ' ');
                    if (combined === pText) { segIdx++; break; }
                    if (combined.length > pText.length) break;
                    segIdx++;
                }
                const endIdx = segIdx - 1;
                if (endIdx >= startIdx) {
                    const start = p.startSec != null ? p.startSec : segs[startIdx].start;
                    const end = segs[endIdx].end;
                    newSegs.push({
                        start: start,
                        end: end,
                        text: pText,
                        speaker: segs[startIdx].speaker || 'SPEAKER_00'
                    });
                }
            }
            while (segIdx < segs.length) {
                const last = newSegs[newSegs.length - 1];
                if (last) {
                    last.text = (last.text + ' ' + (segs[segIdx].text || '').trim()).trim().replace(/\s+/g, ' ');
                    last.end = segs[segIdx].end;
                } else {
                    newSegs.push({ ...segs[segIdx] });
                }
                segIdx++;
            }
            window.currentSegments = newSegs;
            if (typeof window.render === 'function') window.render();
        } else {
            // 1:1: update each segment's text and start (from edited timestamp) from the paragraph row
            parr.forEach((p, i) => {
                if (segs[i]) {
                    segs[i].text = p.text;
                    if (p.startSec != null) {
                        const duration = (segs[i].end != null ? segs[i].end : segs[i].start + 1) - segs[i].start;
                        segs[i].start = p.startSec;
                        segs[i].end = p.startSec + Math.max(0.1, duration);
                    }
                }
            });
        }

        // Make end times contiguous: each segment ends when the next one starts (so SRT has no gaps/overlaps)
        const finalSegs = window.currentSegments;
        for (let i = 0; i < finalSegs.length; i++) {
            if (i < finalSegs.length - 1) {
                finalSegs[i].end = finalSegs[i + 1].start;
            } else {
                const last = finalSegs[i];
                if (last.end == null || last.end <= last.start) last.end = last.start + 1;
            }
        }
        // 2. ELIMINATE CACHE: Force the video to use the fresh edits
        window.refreshVideoSubtitles();

        // 2b. Persist edited transcript to S3 so user can retrieve it (e.g. Open in app)
        if (typeof updateJobStatus === 'function' && window.currentSegments && window.currentSegments.length) {
            (async () => {
                try {
                    const { data: { user } } = await supabase.auth.getUser();
                    const dbId = localStorage.getItem('lastJobDbId');
                    const s3Key = localStorage.getItem('lastS3Key');
                    if (user && dbId && s3Key) {
                        const res = await fetch('/api/save_job_result', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                userId: user.id,
                                input_s3_key: s3Key,
                                segments: window.currentSegments
                            })
                        });
                        const data = res.ok ? await res.json() : {};
                        if (data.result_s3_key) {
                            updateJobStatus(dbId, 'processed', { result_s3_key: data.result_s3_key });
                        }
                        if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('changes_saved') : 'Changes saved', false);
                    }
                } catch (_) { /* ignore */ }
            })();
        }

        // 3. LOCK UI: Close edit mode
        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";
        win.classList.remove('transcript-editing', 'transcript-sync-mode');
        window._qsTimingMode = false;
        window._qsTimingModeBackup = null;
        _qsSetSyncModeButtonActive(false);

        if (editActions) editActions.style.display = 'none';
        window._qsForceLegacyEditMode = false;
        console.log("✅ Edits saved and subtitles re-synced.");
    };

    window.cancelEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');
        const isMedicalSummaryEdit =
            isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'summary';
        const isMedicalTranscriptEdit =
            isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'transcript';
        if (isMedicalSummaryEdit) {
            if (window.transcriptBackup) {
                win.innerHTML = window.transcriptBackup;
            }
            win.contentEditable = 'false';
            _qsSetMedicalSummaryPaneEditable(win, false);
            win.style.border = "1px solid #e2e8f0";
            win.style.backgroundColor = "transparent";
            win.classList.remove('transcript-editing', 'transcript-sync-mode');
            window._qsTimingMode = false;
            window._qsTimingModeBackup = null;
            _qsSetSyncModeButtonActive(false);
            if (editActions) editActions.style.display = 'none';
            window._qsForceLegacyEditMode = false;
            return;
        }
        if (isMedicalTranscriptEdit) {
            if (window.transcriptBackup) {
                win.innerHTML = window.transcriptBackup;
            }
            win.contentEditable = 'false';
            win.style.border = "1px solid #e2e8f0";
            win.style.backgroundColor = "transparent";
            win.classList.remove('transcript-editing', 'transcript-sync-mode');
            window._qsTimingMode = false;
            window._qsTimingModeBackup = null;
            _qsSetSyncModeButtonActive(false);
            if (editActions) editActions.style.display = 'none';
            window._qsForceLegacyEditMode = false;
            try { renderMedicalTranscriptMainView(); } catch (_) {}
            return;
        }

        // Unified word editor (edit + timing): one backup restores text and timings
        if (window.wordEditBackup && Array.isArray(window.wordEditBackup.words) && Array.isArray(window.wordEditBackup.captions)) {
            window.currentWords = window.wordEditBackup.words;
            window.currentCaptions = window.wordEditBackup.captions;
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            window.wordEditBackup = null;
            window._qsTimingModeBackup = null;
            window._qsTimingMode = false;
            if (win) {
                win.classList.remove('transcript-editing', 'transcript-sync-mode');
                win.style.border = "1px solid #e2e8f0";
                win.style.backgroundColor = "transparent";
            }
            if (editActions) editActions.style.display = 'none';
            _qsSetSyncModeButtonActive(false);
            try { renderWordCaptionEditor(); } catch (_) {}
            window._qsForceLegacyEditMode = false;
            return;
        }

        if (window._qsTimingMode && window._qsTimingModeBackup) {
            const b = window._qsTimingModeBackup;
            if (Array.isArray(b.words) && Array.isArray(b.captions)) {
                window.currentWords = b.words;
                window.currentCaptions = b.captions;
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            } else if (Array.isArray(b.segments)) {
                window.currentSegments = b.segments;
            }
            window._qsTimingMode = false;
            window._qsTimingModeBackup = null;
            if (win) {
                win.classList.remove('transcript-sync-mode');
                win.style.border = "1px solid #e2e8f0";
                win.style.backgroundColor = "transparent";
            }
            if (editActions) editActions.style.display = 'none';
            if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length && window.currentCaptions.length) {
                try { renderWordCaptionEditor(); } catch (_) {}
            } else {
                try { renderTranscriptFromCues(window.currentSegments || []); } catch (_) {}
            }
            _qsSetSyncModeButtonActive(false);
            return;
        }

        // Restore the original text from before they clicked the pencil (legacy paragraph edit)
        if (window.transcriptBackup) {
            win.innerHTML = window.transcriptBackup;
        }

        // Lock UI
        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";
        win.classList.remove('transcript-editing', 'transcript-sync-mode');
        window._qsTimingMode = false;
        window._qsTimingModeBackup = null;
        _qsSetSyncModeButtonActive(false);
        if (editActions) editActions.style.display = 'none';
        window._qsForceLegacyEditMode = false;
        // Ensure word editor becomes read-only after cancel
        if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length && window.currentCaptions.length) {
            try { renderWordCaptionEditor(); } catch (_) {}
        }
    };

    // --- SUBTITLE STYLE MANAGEMENT ---
    window.currentSubtitleStyle = localStorage.getItem('subtitleStyle') || 'tiktok';
    window.currentSubtitleColor = localStorage.getItem('subtitleColor') || 'yellow';
    const _subtitleColorMap = {
        black: '#111111',
        red: '#ef4444',
        yellow: '#facc15',
        white: '#ffffff',
    };
    const _sanitizeSubtitleColor = (c) => (c === 'black' || c === 'red' || c === 'yellow' || c === 'white') ? c : 'yellow';
    window.applySubtitleColor = function(colorKey) {
        const video = document.getElementById('main-video');
        const safeKey = _sanitizeSubtitleColor(colorKey);
        const colorHex = _subtitleColorMap[safeKey] || _subtitleColorMap.yellow;
        window.currentSubtitleColor = safeKey;
        try { localStorage.setItem('subtitleColor', safeKey); } catch (_) {}
        if (video) {
            video.style.setProperty('--qs-subtitle-color', colorHex);
            video.classList.remove('subtitle-color-black', 'subtitle-color-red', 'subtitle-color-yellow', 'subtitle-color-white');
            video.classList.add(`subtitle-color-${safeKey}`);
        }
        if (typeof window.syncSubtitleDrawerColorUI === 'function') {
            window.syncSubtitleDrawerColorUI();
        }
        if (window.currentSegments && window.currentSegments.length && typeof window.refreshVideoSubtitles === 'function') {
            window.refreshVideoSubtitles();
        }
    };
    
    window.applySubtitleStyle = function(style) {
        const video = document.getElementById('main-video');
        if (!video) return;
        
        // Remove all style classes
        video.classList.remove('subtitle-style-tiktok', 'subtitle-style-clean', 'subtitle-style-cinematic');
        
        // Apply selected style
        if (style) {
            video.classList.add(`subtitle-style-${style}`);
            window.currentSubtitleStyle = style;
            localStorage.setItem('subtitleStyle', style);
        }
        if (typeof window.applySubtitleColor === 'function') {
            window.applySubtitleColor(window.currentSubtitleColor);
        }
        
        // Update card selection
        document.querySelectorAll('.subtitle-style-card').forEach(card => {
            card.classList.remove('active');
            if (card.dataset.style === style) {
                card.classList.add('active');
            }
        });
        // Rebuild VTT so cue position matches style (TikTok = centered, clean/cinematic = default)
        if (window.currentSegments && window.currentSegments.length && typeof window.refreshVideoSubtitles === 'function') {
            window.refreshVideoSubtitles();
        }
    };
    
    window.showSubtitleStyleSelector = function() {
        if (!document.body.classList.contains('has-transcript-actions')) return;
        if (window.uploadWasVideo !== true) return;
        const selector = document.getElementById('subtitle-style-selector');
        const video = document.getElementById('main-video');
        const videoWrapper = document.getElementById('video-wrapper');
        const videoVisible = !!(videoWrapper && videoWrapper.classList.contains('visible'));
        if (selector && video && videoVisible && window.currentSegments && window.currentSegments.length > 0) {
            try { selector.querySelector('#caption-style-timeline-ui')?.remove(); } catch (_) {}
            selector.style.display = 'flex';
            selector.classList.remove('is-open');
            if (typeof window.syncSubtitleDrawerGlobalPositionUI === 'function') {
                window.syncSubtitleDrawerGlobalPositionUI();
            }
            if (typeof window.syncSubtitleDrawerColorUI === 'function') {
                window.syncSubtitleDrawerColorUI();
            }
            window.applySubtitleStyle(window.currentSubtitleStyle);
        }
    };

    window.hideSubtitleStyleSelector = function() {
        const selector = document.getElementById('subtitle-style-selector');
        if (selector) {
            selector.classList.remove('is-open');
            selector.style.display = 'none';
        }
    };

    window.toggleSubtitleStyleDrawer = function(forceOpen) {
        const selector = document.getElementById('subtitle-style-selector');
        if (!selector || selector.style.display === 'none') return;
        const drawer = document.getElementById('subtitle-style-drawer');
        const toggleBtn = document.getElementById('subtitle-style-toggle');

        const positionDrawerNearToggle = () => {
            if (!drawer || !toggleBtn) return;
            const margin = 8;
            const btnRect = toggleBtn.getBoundingClientRect();
            const panelRect = drawer.getBoundingClientRect();
            const panelW = panelRect.width || 320;
            const panelH = panelRect.height || 220;
            const vw = window.innerWidth || document.documentElement.clientWidth || 0;
            const vh = window.innerHeight || document.documentElement.clientHeight || 0;
            const isMobile = (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) || vw <= 768;
            const boundsEl = !isMobile
                ? (document.querySelector('.transcription-wrapper') || document.getElementById('transcript-window'))
                : null;
            const boundsRect = boundsEl ? boundsEl.getBoundingClientRect() : null;
            const minLeft = boundsRect ? (boundsRect.left + margin) : margin;
            const maxLeft = boundsRect ? (boundsRect.right - panelW - margin) : (vw - panelW - margin);
            const minTop = boundsRect ? (boundsRect.top + margin) : margin;
            const maxTop = boundsRect ? (boundsRect.bottom - panelH - margin) : (vh - panelH - margin);

            let left = btnRect.right - panelW;
            left = Math.max(minLeft, Math.min(left, maxLeft));

            let top = btnRect.top - panelH - 8;
            // Fallback when there isn't enough room above.
            if (top < minTop) top = Math.min(maxTop, btnRect.bottom + 8);
            top = Math.max(minTop, Math.min(top, maxTop));

            drawer.style.left = `${Math.round(left)}px`;
            drawer.style.top = `${Math.round(top)}px`;
        };

        if (typeof forceOpen === 'boolean') {
            selector.classList.toggle('is-open', forceOpen);
            if (forceOpen) {
                positionDrawerNearToggle();
                if (typeof window.syncSubtitleDrawerGlobalPositionUI === 'function') {
                    window.syncSubtitleDrawerGlobalPositionUI();
                }
                if (typeof window.syncSubtitleDrawerColorUI === 'function') {
                    window.syncSubtitleDrawerColorUI();
                }
            }
            return;
        }
        selector.classList.toggle('is-open');
        if (selector.classList.contains('is-open')) {
            positionDrawerNearToggle();
            if (typeof window.syncSubtitleDrawerGlobalPositionUI === 'function') {
                window.syncSubtitleDrawerGlobalPositionUI();
            }
            if (typeof window.syncSubtitleDrawerColorUI === 'function') {
                window.syncSubtitleDrawerColorUI();
            }
        }
    };

    // --- Caption layout / highlight: global defaults + per-caption overrides (no timeline, no keywords) ---
    function _defaultGlobalCaptionLayoutStyle() {
        return { position: 'bottom', highlightMode: 'none' };
    }
    function _sanitizeHighlightMode(m) {
        return m === 'active-word' ? 'active-word' : 'none';
    }
    function _sanitizePosition(p) {
        if (p === 'top' || p === 'middle' || p === 'bottom') return p;
        return 'bottom';
    }
    function _loadGlobalCaptionLayoutStyle() {
        if (window.globalCaptionLayoutStyle && typeof window.globalCaptionLayoutStyle === 'object') return;
        try {
            const raw = localStorage.getItem('globalCaptionLayoutStyle');
            if (raw) {
                const o = JSON.parse(raw);
                window.globalCaptionLayoutStyle = {
                    position: _sanitizePosition(o.position),
                    highlightMode: 'none',
                };
                return;
            }
        } catch (_) {}
        try {
            const rawKf = localStorage.getItem('captionStyleKeyframes');
            const parsed = rawKf ? JSON.parse(rawKf) : null;
            const kf0 = Array.isArray(parsed) && parsed[0] && parsed[0].style ? parsed[0].style : null;
            if (kf0) {
                window.globalCaptionLayoutStyle = {
                    position: _sanitizePosition(kf0.position),
                    highlightMode: 'none',
                };
                return;
            }
        } catch (_) {}
        window.globalCaptionLayoutStyle = _defaultGlobalCaptionLayoutStyle();
    }
    function _saveGlobalCaptionLayoutStyle() {
        try {
            localStorage.setItem('globalCaptionLayoutStyle', JSON.stringify(window.globalCaptionLayoutStyle || _defaultGlobalCaptionLayoutStyle()));
        } catch (_) {}
    }
    function _getCurrentMediaTime() {
        const el = (typeof window._getPrimaryMediaElement === 'function') ? window._getPrimaryMediaElement() : null;
        if (el && Number.isFinite(el.currentTime)) return el.currentTime;
        return 0;
    }
    window.getResolvedCaptionStyle = function(ci) {
        _loadGlobalCaptionLayoutStyle();
        const g = window.globalCaptionLayoutStyle || _defaultGlobalCaptionLayoutStyle();
        const cap = Array.isArray(window.currentCaptions) && Number.isFinite(ci) && ci >= 0 ? window.currentCaptions[ci] : null;
        const s = (cap && cap.style && typeof cap.style === 'object') ? cap.style : {};
        return {
            position: s.position != null ? _sanitizePosition(s.position) : _sanitizePosition(g.position),
            highlightMode: 'none',
            fontWeight: 'bold',
        };
    };
    /** @deprecated Legacy helper; returns global layout only (no timeline). */
    window.getStyleAtTime = function() {
        _loadGlobalCaptionLayoutStyle();
        const g = window.globalCaptionLayoutStyle || _defaultGlobalCaptionLayoutStyle();
        return { ...g, fontWeight: 'bold', highlightColor: '#000000' };
    };
    window.setGlobalCaptionStyle = function(partialStyle) {
        _loadGlobalCaptionLayoutStyle();
        window.globalCaptionLayoutStyle = {
            ..._defaultGlobalCaptionLayoutStyle(),
            ...(window.globalCaptionLayoutStyle || {}),
            ...(partialStyle || {}),
        };
        window.globalCaptionLayoutStyle.position = _sanitizePosition(window.globalCaptionLayoutStyle.position);
        window.globalCaptionLayoutStyle.highlightMode = 'none';
        _saveGlobalCaptionLayoutStyle();
        if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
        try {
            const now = _getCurrentMediaTime();
            if (typeof highlightActiveCaptionRowByTime === 'function') highlightActiveCaptionRowByTime(now);
            if (typeof window.updateVideoWordOverlay === 'function') window.updateVideoWordOverlay(now);
        } catch (_) {}
    };
    window.syncSubtitleDrawerGlobalPositionUI = function() {
        _loadGlobalCaptionLayoutStyle();
        const currentPos = _sanitizePosition((window.globalCaptionLayoutStyle || {}).position);
        document.querySelectorAll('#subtitle-style-drawer .subtitle-global-pos-btn').forEach((btn) => {
            btn.classList.toggle('is-selected', btn.getAttribute('data-global-pos') === currentPos);
        });
    };
    window.syncSubtitleDrawerColorUI = function() {
        const currentColor = _sanitizeSubtitleColor(window.currentSubtitleColor);
        document.querySelectorAll('#subtitle-style-drawer .subtitle-color-btn').forEach((btn) => {
            btn.classList.toggle('is-selected', btn.getAttribute('data-subtitle-color') === currentColor);
        });
    };
    window.applyGlobalCaptionPosition = function(pos) {
        const safePos = _sanitizePosition(pos);
        if (!window.currentCaptions || !window.currentCaptions.length) {
            window.setGlobalCaptionStyle({ position: safePos });
            window.syncSubtitleDrawerGlobalPositionUI();
            return;
        }
        window.currentCaptions.forEach((cap) => {
            if (!cap) return;
            cap.style = cap.style && typeof cap.style === 'object' ? { ...cap.style } : {};
            cap.style.position = safePos;
        });
        window.setGlobalCaptionStyle({ position: safePos });
        window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
        try {
            const now = _getCurrentMediaTime();
            if (typeof highlightActiveCaptionRowByTime === 'function') highlightActiveCaptionRowByTime(now);
            if (typeof window.updateVideoWordOverlay === 'function') window.updateVideoWordOverlay(now);
        } catch (_) {}
        if (typeof renderWordCaptionEditor === 'function') {
            const win = document.getElementById('transcript-window');
            if (win && (win.classList.contains('transcript-editing') || win.classList.contains('transcript-sync-mode'))) {
                try { renderWordCaptionEditor(); } catch (_) {}
            }
        }
        window.syncSubtitleDrawerGlobalPositionUI();
    };
    window.ensureCaptionStyleTimelineUI = function() { /* removed — use inline per-caption editor in transcript */ };

    window.refreshVideoSubtitles = function() {
        if (!window.currentSegments.length) return;
        const v = document.getElementById('main-video');
        const a = document.getElementById('main-audio');
        const primary = (typeof window._getPrimaryMediaElement === 'function')
            ? window._getPrimaryMediaElement()
            : (v || a);
        if (!primary) return;

        // Rebuild the entire VTT file from scratch
        const vttLines = ['WEBVTT\n'];
        const pad = (n, m=2) => String(n).padStart(m, '0');
        const fmt = (s) => {
            const t = Number(s);
            if (!Number.isFinite(t)) return '00:00:00.000';
            const ms = Math.floor((t - Math.floor(t)) * 1000);
            const hh = Math.floor(t / 3600);
            const mm = Math.floor((t % 3600) / 60);
            const ss = Math.floor(t % 60);
            return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
        };

        const styleToCueSettings = (style) => {
            const pos = style && style.position ? style.position : 'bottom';
            if (pos === 'top') return ' line:10% position:50% align:center';
            if (pos === 'middle') return ' line:50% position:50% align:center';
            return ' line:90% position:50% align:center';
        };
        const getCueStyleKey = () => {
            const raw = String(window.currentSubtitleStyle || '').toLowerCase();
            if (raw === 'clean' || raw === 'cinematic' || raw === 'tiktok') return raw;
            return 'tiktok';
        };
        const estimateCueFontPx = (videoEl, styleKey) => {
            const vw = window.innerWidth || document.documentElement.clientWidth || 0;
            const isMobileViewport = vw > 0 && vw <= 768;
            // Mirrors ::cue font-size rules from app_custom.css
            const emByStyleDesktop = { tiktok: 2.5, clean: 1.4, cinematic: 1.6 };
            const emByStyleMobile = { tiktok: 1.15, clean: 1.05, cinematic: 1.1 };
            const em = (isMobileViewport ? emByStyleMobile : emByStyleDesktop)[styleKey] || 1.15;
            const basePx = 16; // Browser default media text size reference.
            const h = Number(videoEl && videoEl.clientHeight) || Number(videoEl && videoEl.videoHeight) || 0;
            const heightScale = h > 0 ? Math.max(0.72, Math.min(1.35, h / 720)) : 1;
            return em * basePx * heightScale;
        };
        const estimateMaxCharsPerLine = (videoEl) => {
            const styleKey = getCueStyleKey();
            const widthPx = Number(videoEl && videoEl.clientWidth) || Number(videoEl && videoEl.videoWidth) || 0;
            const heightPx = Number(videoEl && videoEl.clientHeight) || Number(videoEl && videoEl.videoHeight) || 0;
            const isPortrait = widthPx > 0 && heightPx > 0 ? (heightPx > widthPx) : false;
            const fontPx = estimateCueFontPx(videoEl, styleKey);
            // Hebrew/Latin average glyph width is roughly 0.54-0.58 of font-size.
            const avgCharPx = Math.max(7, fontPx * 0.56);
            const horizontalPadding = isPortrait ? 20 : 36;
            const usableWidthPx = Math.max(120, widthPx - (horizontalPadding * 2));
            const estimated = Math.floor(usableWidthPx / avgCharPx);
            const minChars = isPortrait ? 10 : 14;
            const maxChars = isPortrait ? 38 : 68;
            return Math.max(minChars, Math.min(maxChars, estimated || 0));
        };
        const wrapCueTextByMaxChars = (rawText, maxChars) => {
            const s = String(rawText || '').replace(/\s+/g, ' ').trim();
            if (!s || !maxChars || s.length <= maxChars) return s;
            const words = s.split(' ').filter(Boolean);
            if (!words.length) return s;
            const lines = [];
            let line = '';
            for (const w of words) {
                const candidate = line ? `${line} ${w}` : w;
                if (candidate.length <= maxChars) {
                    line = candidate;
                } else {
                    if (line) lines.push(line);
                    line = w;
                }
            }
            if (line) lines.push(line);
            return lines.join('\n');
        };
        const maxCharsPerLine = estimateMaxCharsPerLine(primary);
        for (let i = 0; i < window.currentSegments.length; i++) {
            const c = window.currentSegments[i];
            const st = (typeof window.getResolvedCaptionStyle === 'function')
                ? window.getResolvedCaptionStyle(i)
                : { position: 'bottom', highlightMode: 'none' };
            const cueSettings = styleToCueSettings(st);
            const start = Number(c && c.start);
            let end = c && c.end != null ? Number(c.end) : NaN;
            if (!Number.isFinite(start)) continue;
            if (!Number.isFinite(end) || end <= start) {
                const next = window.currentSegments[i + 1];
                const nextS = next && Number(next.start);
                end = Number.isFinite(nextS) ? nextS : (start + 1);
            }
            if (end <= start) end = start + 0.05;
            vttLines.push(`${fmt(start)} --> ${fmt(end)}${cueSettings}`);
            let text = (c.text || '').replace(/<[^>]+>/g, '').trim();
            text = wrapCueTextByMaxChars(text, maxCharsPerLine);
            vttLines.push(text);
            vttLines.push('');
        }

        const vttBlob = new Blob([vttLines.join('\n')], { type: 'text/vtt' });
        try {
            if (window._qsVttObjectUrl) URL.revokeObjectURL(String(window._qsVttObjectUrl).split('#')[0]);
        } catch (_) {}
        const baseUrl = URL.createObjectURL(vttBlob);
        window._qsVttObjectUrl = baseUrl;
        const vttUrl = `${baseUrl}#t=${Date.now()}`;

        // Drop old tracks on both elements so cues cannot stay bound to a hidden/non-playing video.
        [v, a].forEach((el) => {
            if (!el) return;
            try { Array.from(el.querySelectorAll('track')).forEach(t => t.remove()); } catch (_) {}
        });

        const track = document.createElement('track');
        // Android Chrome native controls expose a confusing "Subtitles" menu item.
        // Use metadata track there and render subtitles via in-app overlay logic instead.
        track.kind = isAndroidClient() ? 'metadata' : 'subtitles';
        track.label = 'Subtitles';
        track.srclang = 'he';
        track.src = vttUrl;
        track.default = true;

        primary.appendChild(track);

        const syncAfterLoad = () => {
            try {
                const now = (typeof _getCurrentMediaTime === 'function')
                    ? _getCurrentMediaTime()
                    : (Number.isFinite(primary.currentTime) ? primary.currentTime : 0);
                if (typeof window.updateVideoWordOverlay === 'function') {
                    window.updateVideoWordOverlay(now);
                } else {
                    Array.from(primary.textTracks).forEach(tt => { try { tt.mode = 'showing'; } catch (_) {} });
                }
            } catch (e) {
                console.warn('Track load overlay sync error:', e);
            }
        };
        track.addEventListener('load', syncAfterLoad);
        setTimeout(syncAfterLoad, 0);
        setTimeout(syncAfterLoad, 120);
    };

    window.toggleEditMode = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');
        const isMedicalSummaryEdit =
            isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'summary';
        const isMedicalTranscriptEdit =
            isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'transcript';
        const hasWordModel = Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length && window.currentCaptions.length;
        const docMode = isDocumentFormatEnabled();
        const inUnifiedWordEdit = !!(
            win &&
            hasWordModel &&
            !docMode &&
            win.classList.contains('transcript-editing') &&
            window._qsTimingMode &&
            !window._qsForceLegacyEditMode
        );
        const isEditable = ((isMedicalSummaryEdit || isMedicalTranscriptEdit) && win)
            ? win.classList.contains('transcript-editing')
            : !!(win && (win.contentEditable === 'true' || inUnifiedWordEdit));

        if (!isEditable) {
            if (isMedicalSummaryEdit) {
                window._qsForceLegacyEditMode = false;
                window.transcriptBackup = win.innerHTML;
                _qsSetMedicalSummaryPaneEditable(win, true);
                win.style.border = "2px solid #1e3a8a";
                win.style.backgroundColor = "#fff";
                win.classList.add('transcript-editing');
                if (editActions) editActions.style.display = 'flex';
                requestAnimationFrame(() => {
                    const chief = win.querySelector('[data-medical-section="chief"]') || win.querySelector('#medical-summary-chief');
                    const overview = win.querySelector('#medical-summary-overview');
                    const target = chief || overview;
                    if (target) {
                        const sel = window.getSelection();
                        if (sel) {
                            const range = document.createRange();
                            range.selectNodeContents(target);
                            range.collapse(false);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                        target.focus();
                    }
                });
                return;
            }
            if (isMedicalTranscriptEdit) {
                window._qsForceLegacyEditMode = false;
                window.transcriptBackup = win.innerHTML;
                win.contentEditable = 'true';
                win.style.border = "2px solid #1e3a8a";
                win.style.backgroundColor = "#fff";
                win.classList.remove('transcript-sync-mode');
                win.classList.add('transcript-editing');
                window._qsTimingMode = false;
                window._qsTimingModeBackup = null;
                _qsSetSyncModeButtonActive(false);
                if (editActions) editActions.style.display = 'flex';
                requestAnimationFrame(() => {
                    const firstP = win.querySelector('.qs-medical-plain-paragraph p, p');
                    if (firstP) {
                        const sel = window.getSelection();
                        if (sel) {
                            const range = document.createRange();
                            range.selectNodeContents(firstP);
                            range.collapse(false);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }
                        firstP.focus();
                    }
                });
                return;
            }
            // --- START EDITING ---
            // Unified word-caption screen (pre-HIPAA): text + drag timing + nudges on one surface; window stays contentEditable=false.
            if (inUnifiedWordEdit) {
                window.saveEdits();
                return;
            }
            // Word-caption editor (desktop + mobile): subtitle mode — tokens + line timing together (no separate timing button).
            // Document mode uses legacy paragraph edit below.
            if (hasWordModel && !docMode) {
                qsActivateSubtitleFormatTabOnly();
                window._qsForceLegacyEditMode = false;
                win.contentEditable = 'false';
                try {
                    window.wordEditBackup = {
                        words: JSON.parse(JSON.stringify(window.currentWords)),
                        captions: JSON.parse(JSON.stringify(window.currentCaptions)),
                        segments: JSON.parse(JSON.stringify(window.currentSegments || [])),
                    };
                } catch (_) {
                    window.wordEditBackup = null;
                }
                try {
                    window._qsTimingModeBackup = _qsCloneTimingStateForBackup();
                } catch (_) {
                    window._qsTimingModeBackup = null;
                }
                window._qsTimingMode = true;
                if (!Number.isFinite(window._qsTimingSelectedCi)) window._qsTimingSelectedCi = 0;
                win.classList.add('transcript-editing', 'transcript-sync-mode');
                _qsSetSyncModeButtonActive(true);
                renderWordCaptionEditor();
                if (editActions) editActions.style.display = 'flex';
                win.style.border = "2px solid #1e3a8a";
                win.style.backgroundColor = "#fff";
                requestAnimationFrame(() => {
                    try {
                        const first = win.querySelector('.caption-row .caption-text');
                        if (first) first.focus();
                        const timingRow = win.querySelector('.caption-row.qs-timing-line-selected, .qs-timing-legacy-row.qs-timing-line-selected');
                        if (timingRow) timingRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    } catch (_) {}
                });
                return;
            }

            const hasSeg = Array.isArray(window.currentSegments) && window.currentSegments.length > 0;
            if (!hasWordModel && hasSeg && !docMode && !isMedicalModeEnabled()) {
                qsActivateSubtitleFormatTabOnly();
                window._qsForceLegacyEditMode = false;
                win.contentEditable = 'false';
                try {
                    window.transcriptBackup = win.innerHTML;
                } catch (_) {
                    window.transcriptBackup = null;
                }
                try {
                    window._qsTimingModeBackup = _qsCloneTimingStateForBackup();
                } catch (_) {
                    window._qsTimingModeBackup = null;
                }
                window._qsTimingMode = true;
                if (!Number.isFinite(window._qsTimingSelectedCi)) window._qsTimingSelectedCi = 0;
                win.classList.add('transcript-editing', 'transcript-sync-mode');
                _qsSetSyncModeButtonActive(true);
                renderLegacyTimingModeTranscript(win);
                if (editActions) editActions.style.display = 'flex';
                win.style.border = "2px solid #1e3a8a";
                win.style.backgroundColor = "#fff";
                requestAnimationFrame(() => {
                    try {
                        const timingRow = win.querySelector('.qs-timing-legacy-row.qs-timing-line-selected');
                        if (timingRow) timingRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    } catch (_) {}
                });
                return;
            }

            // Cue-only / paragraph transcript (or doc-mode edit over word model).
            if (hasWordModel) {
                // Start from the latest word/caption text so paragraph edit and export stay in sync.
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                window._qsForceLegacyEditMode = true;
            } else {
                window._qsForceLegacyEditMode = false;
            }
            if (typeof window.render === 'function') {
                try { window.render(); } catch (_) {}
            }
            win.contentEditable = 'true';
            win.style.border = "2px solid #1e3a8a";
            win.style.backgroundColor = "#fff";
            win.classList.add('transcript-editing');

            // Save a backup in case the user cancels
            window.transcriptBackup = win.innerHTML;

            // Show the Save/Cancel buttons
            if (editActions) editActions.style.display = 'flex';

            // Focus first paragraph so caret is inside a <p>, not between time div and <p> (avoids stray <br> on first edit)
            requestAnimationFrame(() => {
                const firstP = win.querySelector('p[data-idx]');
                if (firstP) {
                    const sel = window.getSelection();
                    if (sel) {
                        const range = document.createRange();
                        range.setStart(firstP.firstChild || firstP, 0);
                        range.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                    win.focus();
                }
            });
        } else {
            // If they click the "Pencil" again, we treat it as Save
            window.saveEdits();
        }
    };

    window.toggleTimingMode = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');
        if (!win) return;
        if (isMedicalModeEnabled() && String(window.medicalActiveTab || 'summary') === 'transcript') return;
        const hasWord = Array.isArray(window.currentWords) && window.currentWords.length &&
            Array.isArray(window.currentCaptions) && window.currentCaptions.length;
        const hasSeg = Array.isArray(window.currentSegments) && window.currentSegments.length;
        if (!hasWord && !hasSeg) return;
        // Exiting unified (or timing-only) mode: save
        if (window._qsTimingMode) {
            window.saveEdits();
            return;
        }
        window._qsTimingModeBackup = _qsCloneTimingStateForBackup();
        window._qsTimingMode = true;
        window._qsTimingSelectedCi = 0;
        // Word model: same unified screen as pencil (edit + timing)
        if (hasWord && !window._qsForceLegacyEditMode) {
            win.contentEditable = 'false';
            try {
                window.wordEditBackup = {
                    words: JSON.parse(JSON.stringify(window.currentWords)),
                    captions: JSON.parse(JSON.stringify(window.currentCaptions)),
                    segments: JSON.parse(JSON.stringify(window.currentSegments || [])),
                };
            } catch (_) {
                window.wordEditBackup = null;
            }
            win.classList.add('transcript-editing', 'transcript-sync-mode');
            win.style.border = '2px solid #1e3a8a';
            win.style.backgroundColor = '#fff';
            if (editActions) editActions.style.display = 'flex';
            _qsSetSyncModeButtonActive(true);
            try { renderWordCaptionEditor(); } catch (_) {}
            return;
        }
        // Legacy segments only: timing UI without token editor
        win.classList.add('transcript-sync-mode');
        win.style.border = '2px solid #0d9488';
        win.style.backgroundColor = '#fff';
        if (editActions) editActions.style.display = 'flex';
        _qsSetSyncModeButtonActive(true);
        try { renderWordCaptionEditor(); } catch (_) {}
    };

    window.toggleSyncMode = window.toggleTimingMode;

    // When user presses Enter in the middle of a line in edit mode: split segment and insert new row with computed time
    (function attachEnterSplitInTranscript() {
        const win = document.getElementById('transcript-window');
        if (!win) return;
        win.addEventListener('keydown', function(e) {
            
            if (e.key !== 'Enter' || win.contentEditable !== 'true') return;
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;

            const focusNode = sel.focusNode;
            const p = focusNode && (focusNode.nodeType === Node.ELEMENT_NODE ? focusNode.closest('p[data-idx]') : focusNode.parentElement && focusNode.parentElement.closest('p[data-idx]'));
            if (!p || !p.hasAttribute('data-idx')) return;

            const idx = parseInt(p.getAttribute('data-idx'), 10);
            if (isNaN(idx) || !window.currentSegments || !window.currentSegments[idx]) return;

            e.preventDefault();

            const offset = getCaretCharacterOffsetWithin(p);
            const seg = window.currentSegments[idx];
            const text = p.textContent || '';
            const len = text.length;
            const offsetClamped = Math.min(offset, len);
            if (offsetClamped <= 0) return;
            if (offsetClamped >= len) {
                e.preventDefault();
                if (p.innerHTML === '<br>' || p.innerHTML === '') {
                    p.innerHTML = '';
                }
                let end = seg.end != null ? seg.end : seg.start + 1;
                if (end <= seg.start) end = seg.start + 1;
                const newSeg = { start: end, end: end + 0.1, text: '', speaker: seg.speaker || 'SPEAKER_00' };
                window.currentSegments.splice(idx + 1, 0, newSeg);
                const isTimeVisible = isTimeToggleVisible();
                const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
                const row = p.closest('.paragraph-row');
                const newRowHtml = `
                <div class="paragraph-row" style="display:block; margin-bottom: 2px;">
                    <div style="font-size: 0.74em; color: #9ca3af; margin-bottom: 0; line-height: 1.05;">
                        <span class="timestamp" style="display: ${isTimeVisible ? 'block' : 'none'};">
                            ${formatTime(newSeg.start)}
                        </span>
                        <span style="display: ${isSpeakerVisible && window.aiDiarizationRan ? 'block' : 'none'}; font-weight: 600; color: ${getSpeakerColor(seg.speaker)};">
                            ${(seg.speaker || 'SPEAKER_00').replace('SPEAKER_', 'דובר ')}
                        </span>
                    </div>
                    <p data-idx="${idx + 1}" style="margin: 0 !important; margin-top: -2px; cursor: pointer; line-height: 1.2;" onclick="window.jumpTo(${newSeg.start})"><br></p>
                </div>`;
                const div = document.createElement('div');
                div.innerHTML = newRowHtml.trim();
                const newNode = div.firstChild;
                row.parentNode.insertBefore(newNode, row.nextSibling);
                win.querySelectorAll('p[data-idx]').forEach((el, i) => { el.setAttribute('data-idx', i); });
                win.querySelectorAll('.paragraph-row').forEach((r, i) => { r.id = 'seg-row-' + i; });
                const newP = newNode.querySelector('p');
                if (newP) { newP.focus(); sel.collapse(newP, 0); }
                return;
            }

            const start = seg.start;
            let end = seg.end != null ? seg.end : seg.start + 1;
            if (end <= start) end = start + 1;
            const duration = end - start;
            const MIN_DUR = 0.5;
            let splitTime = start + Math.max(0, Math.min(1, offsetClamped / len)) * duration;
            if (duration >= 2 * MIN_DUR) {
                splitTime = Math.max(start + MIN_DUR, Math.min(end - MIN_DUR, splitTime));
            }
            const beforeText = text.slice(0, offsetClamped).trimEnd();
            const afterText = text.slice(offsetClamped).trimStart();

            seg.end = splitTime;
            seg.text = beforeText;
            const newSeg = { start: splitTime, end: end, text: afterText, speaker: seg.speaker || 'SPEAKER_00' };
            window.currentSegments.splice(idx + 1, 0, newSeg);

            p.innerText = beforeText;

            const isTimeVisible = isTimeToggleVisible();
            const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
            const row = p.closest('.paragraph-row');
            const newRowHtml = `
            <div class="paragraph-row" style="display:block; margin-bottom: 2px;">
                <div style="font-size: 0.74em; color: #9ca3af; margin-bottom: 0; line-height: 1.05;">
                    <span class="timestamp" style="display: ${isTimeVisible ? 'block' : 'none'};">
                        ${formatTime(splitTime)}
                    </span>
                    <span style="display: ${isSpeakerVisible && window.aiDiarizationRan ? 'block' : 'none'}; font-weight: 600; color: ${getSpeakerColor(seg.speaker)};">
                        ${(seg.speaker || 'SPEAKER_00').replace('SPEAKER_', 'דובר ')}
                    </span>
                </div>
                <p data-idx="${idx + 1}" style="margin: 0 !important; margin-top: -2px; cursor: pointer; line-height: 1.2;" onclick="window.jumpTo(${splitTime})"></p>
            </div>`;
            const div = document.createElement('div');
            div.innerHTML = newRowHtml.trim();
            const newNode = div.firstChild;
            const newP = newNode.querySelector('p');
            if (newP) newP.textContent = afterText;
            row.parentNode.insertBefore(newNode, row.nextSibling);

            win.querySelectorAll('p[data-idx]').forEach((el, i) => { el.setAttribute('data-idx', i); });
            win.querySelectorAll('.paragraph-row').forEach((r, i) => { r.id = 'seg-row-' + i; });

            if (newP) {
                newP.focus();
                const range = document.createRange();
                range.setStart(newP.firstChild || newP, 0);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        },true);
    })();

    function buildGroupHTML(group) {
        const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
        const isTimeVisible = isTimeToggleVisible();

        const rawSpeaker = group.speaker || "SPEAKER_00";
        const speakerDisplay = rawSpeaker.replace('SPEAKER_', 'דובר ');
        const fullTextRaw = group.sentences.map(s => s.text).join(" ");
        const fullText = window.isDocumentMode ? fullTextRaw : wrapTextByMaxChars(fullTextRaw, 50);
        const translatedParts = group.sentences.map(s => s.translated_text).filter(Boolean);
        const translatedLine = translatedParts.length ? translatedParts.join(" ").replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';

        const startNum = Number(group.start);
        const rowClick = Number.isFinite(startNum) ? ` onclick="window.jumpTo(${startNum})"` : '';
        return `
        <div class="paragraph-row" style="display:block; width: 100%; margin-bottom: 2px; direction: rtl; text-align: right; cursor: pointer;"${rowClick}>
            <div style="font-size: 0.74em; color: #9ca3af; margin-bottom: 0; line-height: 1.05;">
                <div style="display: ${isTimeVisible ? 'block' : 'none'};">${formatTime(group.start)}</div>
                <div style="display: ${isSpeakerVisible ? 'block' : 'none'}; font-weight: 600; color: ${getSpeakerColor(rawSpeaker)};">
                    ${speakerDisplay}
                </div>
            </div>
            <p style="margin: 0 !important; margin-top: -2px; line-height: 1.2; font-size: 1.1em;">
                ${fullText}
            </p>
            ${translatedLine ? `<p class="translated-line" style="margin: 4px 0 0 0; font-size: 0.9em; color: #6b7280; direction: ltr; text-align: left;">${translatedLine}</p>` : ''}
        </div>`;
    }
    function startFakeProgress() {
        const processingLabel = ((typeof window.t === 'function' ? window.t('processing') : 'Processing...') || '').replace(/\.\.\.?$/, '');
        if (mainBtn) qsSetMainBtnDynamicLabel(processingLabel);
        qsStopFakeProgress('startFakeProgress_replace_previous');
    }

    // --- 5. UPLOAD LOGIC ---
    // Replace your existing fileInput listener with this
    if (fileInput) {
        fileInput.addEventListener('change', async function() {
            if (window.isTriggering) return;

            const file = this.files[0];
            if (!file) return;

            window._qsShowEmptyTranscriptNotice = false;
            qsClearTranscriptWindowIdle();
            try { window.__QS_USER_TREAT_AS_MUSIC = false; } catch (_) {}

            try {
                // Subtitle file: handle locally and keep existing media state (media + SRT workflow).
                const isSubtitle = (file.type && (file.type.includes('vtt') || file.type.includes('text'))) || /\.(srt|vtt|txt)$/i.test(file.name);
                if (isSubtitle) {
                    try {
                        await handleSubtitleFile(file);
                    } catch (e) {
                        console.warn('Local subtitle load failed', e);
                        showStatus(typeof window.t === 'function' ? window.t('subtitle_load_failed') : 'Failed to load subtitle locally', true);
                    }
                    fileInput.value = '';
                    return;
                }

                // Debug transcript JSON: load locally into editor (no upload/transcribe).
                const isTranscriptJson = (file.type && file.type.includes('json')) || /\.json$/i.test(file.name);
                if (isTranscriptJson) {
                    try {
                        await loadTranscriptJsonFile(file, { source: 'picker' });
                    } catch (e) {
                        console.warn('JSON transcript load failed', e);
                        if (typeof showStatus === 'function') showStatus(`Failed to load JSON: ${e.message || e}`, true);
                    } finally {
                        try { window.__QS_FILE_PICKER_PURPOSE = 'new_upload'; } catch (_) {}
                    }
                    fileInput.value = '';
                    return;
                }

                // Debug/local JSON flow: attach local video/audio to an already-loaded transcript (no upload/transcribe).
                // Do not trigger this for normal New Session uploads; stale transcript state can otherwise hijack iOS picker selections.
                const pickerPurpose = String(window.__QS_FILE_PICKER_PURPOSE || 'new_upload');
                const allowLocalMediaAttach = !!window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON && pickerPurpose === 'attach_local_media';
                if (allowLocalMediaAttach && typeof initOpenAppHasLoadedTranscriptPayload === 'function' && initOpenAppHasLoadedTranscriptPayload()) {
                    let isAudio = qsIsAudioMediaFile(file);
                    let isVideo = !isAudio && qsIsVideoMediaFile(file);
                    if (isMedicalModeEnabled()) {
                        isAudio = true;
                        isVideo = false;
                    }
                    if (isVideo || isAudio) {
                        const objectUrl = URL.createObjectURL(file);
                        window.originalFileName = file.name.replace(/\.[^.]+$/, '') || 'media';
                        window.uploadWasVideo = !!isVideo && !isMedicalModeEnabled();
                        if (isVideo) {
                            const src = document.getElementById('video-source');
                            const video = document.getElementById('main-video');
                            if (src) {
                                src.src = objectUrl;
                                const isMov = /\.mov$/i.test(file.name) || (file.type || '').toLowerCase().includes('quicktime');
                                src.type = isMov ? 'video/mp4' : (file.type || 'video/mp4');
                            }
                            if (video) {
                                video.style.position = 'relative';
                                video.style.zIndex = '1002';
                                video.controls = true;
                                video.load();
                                video.pause();
                                try { video.focus(); } catch (e) {}
                            }
                            const videoWrapper = document.getElementById('video-wrapper');
                            const videoPlayer = document.getElementById('video-player-container');
                            const playerContainer = document.getElementById('audio-player-container');
                            if (playerContainer) playerContainer.style.display = 'none';
                            if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
                            if (video) video.style.display = '';
                            if (videoPlayer) videoPlayer.style.display = 'block';
                        } else {
                            const audioContainer = document.getElementById('audio-player-container');
                            const videoWrapper = document.getElementById('video-wrapper');
                            const videoPlayer = document.getElementById('video-player-container');
                            const video = document.getElementById('main-video');
                            const audioSource = document.getElementById('audio-source');
                            const mainAudio = document.getElementById('main-audio');
                            if (videoWrapper) {
                                videoWrapper.style.display = 'none';
                                videoWrapper.classList.remove('visible');
                            }
                            try { document.body.classList.remove('mobile-video-session'); } catch (_) {}
                            if (video) video.style.display = 'none';
                            if (audioContainer && videoWrapper && videoPlayer && audioContainer.parentNode === videoPlayer) {
                                videoWrapper.parentNode.insertBefore(audioContainer, videoWrapper);
                            }
                            if (audioContainer) audioContainer.style.display = 'block';
                            if (audioSource && mainAudio) {
                                audioSource.src = objectUrl;
                                audioSource.type = qsMimeForAudioElement(file);
                                mainAudio.load();
                            }
                            if (videoPlayer) videoPlayer.style.display = 'block';
                        }
                        const mimeForMov = isMedicalModeEnabled()
                            ? qsGuessUploadMimeType(file, 'audio/webm')
                            : ((/\.mov$/i.test(file.name) || String(file.type || '').toLowerCase().includes('quicktime')) ? 'video/mp4' : (file.type || ''));
                        setLocalPreviewAudio(objectUrl, mimeForMov);
                        setTranscriptActionButtonsVisible(true);
                        if (mainBtn) {
                            mainBtn.disabled = false;
                            mainBtn.innerText = (typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload');
                        }
                        setDiarizationBusyState(false);
                        hideProgressBar();
                        try { window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON = false; } catch (_) {}
                        if (typeof setMainButtonAction === 'function') setMainButtonAction('upload');
                        if (typeof window.applyMedicalModeUi === 'function') {
                            try { window.applyMedicalModeUi(); } catch (_) {}
                        }
                        if (typeof showStatus === 'function') {
                            showStatus('Local media attached (no upload).', false, { duration: 5000 });
                        }
                        fileInput.value = '';
                        try { window.__QS_FILE_PICKER_PURPOSE = 'new_upload'; } catch (_) {}
                        return;
                    }
                }

                try { window.__QS_FILE_PICKER_PURPOSE = 'new_upload'; } catch (_) {}

                const runUploadPipeline = async () => {
                const previewReady = !!window.__QS_UPLOAD_PREVIEW_READY;
                let isAudio = qsIsAudioMediaFile(file);
                let isVideo = !isAudio && qsIsVideoMediaFile(file);
                if (isMedicalModeEnabled()) {
                    isAudio = true;
                    isVideo = false;
                }
                const skipLocalBlobPreview = qsIsLargeUploadFile(file);
                if (!previewReady) {
                setSeoHomeContentVisibility(false);
                try {
                    document.body.classList.add('qs-app-busy');
                    if (typeof qsSyncAppChromeBodyClasses === 'function') qsSyncAppChromeBodyClasses();
                } catch (_) {}
                const placeholderElUpload = document.getElementById('placeholder');
                if (placeholderElUpload) placeholderElUpload.style.display = 'none';

                window.uploadWasVideo = !!isVideo;
                let objectUrl = null;
                if (!skipLocalBlobPreview) {
                    objectUrl = URL.createObjectURL(file);
                }
                try {
                    if (isVideo && objectUrl) {
                        window.originalFileName = file.name.replace(/\.[^.]+$/, '');
                        const src = document.getElementById('video-source');
                        const video = document.getElementById('main-video');
                        if (src) {
                            src.src = objectUrl;
                            const isMov = /\.mov$/i.test(file.name) || (file.type || '').toLowerCase().includes('quicktime');
                            src.type = isMov ? 'video/mp4' : (file.type || 'video/mp4');
                        }
                        if (video) {
                            video.style.position = 'relative';
                            video.style.zIndex = '1002';
                            video.controls = true;
                            video.load();
                            video.pause();
                            try { video.focus(); } catch (e) {}
                        }
                        const videoWrapper = document.getElementById('video-wrapper');
                        const videoPlayer = document.getElementById('video-player-container');
                        const playerContainer = document.getElementById('audio-player-container');
                        if (playerContainer) playerContainer.style.display = 'none';
                        if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
                        if (video) video.style.display = '';
                        if (videoPlayer) videoPlayer.style.display = 'block';
                    } else if (isVideo && skipLocalBlobPreview) {
                        window.originalFileName = file.name.replace(/\.[^.]+$/, '');
                        const videoWrapper = document.getElementById('video-wrapper');
                        const videoPlayer = document.getElementById('video-player-container');
                        const playerContainer = document.getElementById('audio-player-container');
                        if (playerContainer) playerContainer.style.display = 'none';
                        if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
                        const video = document.getElementById('main-video');
                        if (video) video.style.display = '';
                        if (videoPlayer) videoPlayer.style.display = 'block';
                    }
                } catch (e) {
                    console.warn('Video preview failed', e);
                }

            const mimeForMov = isMedicalModeEnabled()
                ? qsGuessUploadMimeType(file, 'audio/webm')
                : ((/\.mov$/i.test(file.name) || String(file.type || '').toLowerCase().includes('quicktime')) ? 'video/mp4' : (file.type || ''));
            if (objectUrl) {
                if (isMedicalModeEnabled()) {
                    const audioContainer = document.getElementById('audio-player-container');
                    const videoWrapper = document.getElementById('video-wrapper');
                    const videoPlayer = document.getElementById('video-player-container');
                    const video = document.getElementById('main-video');
                    const audioSource = document.getElementById('audio-source');
                    const mainAudio = document.getElementById('main-audio');
                    if (videoWrapper) {
                        videoWrapper.style.display = 'none';
                        videoWrapper.classList.remove('visible');
                    }
                    try { document.body.classList.remove('mobile-video-session'); } catch (_) {}
                    if (video) video.style.display = 'none';
                    if (audioContainer && videoWrapper && videoPlayer && audioContainer.parentNode === videoPlayer) {
                        videoWrapper.parentNode.insertBefore(audioContainer, videoWrapper);
                    }
                    if (audioContainer) audioContainer.style.display = 'block';
                    if (audioSource && mainAudio) {
                        audioSource.src = objectUrl;
                        audioSource.type = qsMimeForAudioElement(file);
                        mainAudio.load();
                    }
                    if (videoPlayer) videoPlayer.style.display = 'block';
                }
                setLocalPreviewAudio(objectUrl, mimeForMov);
            }
                } else {
                    setSeoHomeContentVisibility(false);
                    try {
                        document.body.classList.add('qs-app-busy');
                        if (typeof qsSyncAppChromeBodyClasses === 'function') qsSyncAppChromeBodyClasses();
                    } catch (_) {}
                    const placeholderElUpload = document.getElementById('placeholder');
                    if (placeholderElUpload) placeholderElUpload.style.display = 'none';
                }

            const currentFile = file; // Captured for use in the fetch
            try { window.__QS_ALLOW_MEDIA_AFTER_LOCAL_JSON = false; } catch (_) {}
            fileInput.value = ""; // Reset for next selection

            // 1. Get the snapshot of the toggle state RIGHT NOW
            const diarizationValue = document.getElementById('diarization-toggle')?.checked || false;

            // Show progress bar for upload; processing phase uses % in button only
            showProgressBar();
            const uploadLabel = ((typeof window.t === 'function' ? window.t('uploading') : "Uploading...") || '').replace(/\.\.\.?$/, '');
            if (mainBtn) { mainBtn.disabled = true; qsSetMainBtnDynamicLabel(uploadLabel); }
            setDiarizationBusyState(true);
            if (statusTxt) statusTxt.style.display = "none";
            setTranscriptActionButtonsVisible(false);
            var placeholderEl = document.getElementById('placeholder');
            if (placeholderEl) placeholderEl.style.display = "none";

            try {
                const { data: { user: uploadUser } } = await supabase.auth.getUser();
                const userId = uploadUser ? uploadUser.id : null;

                // 1. Multipart upload init (presigned parts + server-side complete)
                const multipartInitBody = {
                    filename: currentFile.name,
                    filetype: qsGuessUploadMimeType(currentFile, currentFile.type),
                    diarization: diarizationValue,
                    isMedical: isMedicalModeEnabled(),
                    userId: userId,
                    language: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he'),
                    fileSize: currentFile.size,
                };
                if (!isMedicalModeEnabled()) {
                    multipartInitBody.treatAsMusic = qsUserTreatAsMusicForUpload();
                }
                const uploadDurationSec = qsUploadMediaDurationForApi();
                if (uploadDurationSec > 0) {
                    multipartInitBody.mediaDurationSec = uploadDurationSec;
                }
                const signRes = await fetch('/api/sign-s3-multipart-init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(multipartInitBody),
                });

                const result = await signRes.json();

                if (!signRes.ok || result.status === 'error' || !result.data) {
                    const creditMsg = qsCreditsTriggerErrorMessage(result);
                    if (creditMsg || result.error === 'insufficient_credits' || result.error === 'duration_unknown') {
                        if (typeof showStatus === 'function') {
                            showStatus(creditMsg || result.message || 'Not enough minutes for this file.', true, {
                                duration: 12000,
                                toastPosition: 'above',
                                toastAnchorId: 'main-btn',
                            });
                        }
                        qsApplyTriggerCreditFields(result);
                        window.isTriggering = false;
                        setDiarizationBusyState(false);
                        stopProcessingStateUI('multipart_init_insufficient_credits');
                        hideProgressBar();
                        if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                        return;
                    }
                    throw new Error(result.message || result.error || "Failed to start multipart upload.");
                }

                const { uploadId, s3Key, jobId, bucket, partSizeBytes, partCount } = result.data;

                // 2. 💾 PARK THE KEYS IMMEDIATELY + create job record (status: pending)
                localStorage.setItem('lastS3Key', s3Key);
                localStorage.setItem('pendingS3Key', s3Key);
                localStorage.setItem('lastJobId', jobId);
                if (typeof window.qsSetActiveJob === 'function') window.qsSetActiveJob(jobId);
                else localStorage.setItem('activeJobId', jobId);
                window._lastProcessedJobId = null;
                window._qsSummaryGptDoneJobId = null;
                window._qsCreditsDeferredForJobId = null;
                qsResetCleanupState();
                console.log("💾 Keys parked for recovery:", s3Key);
                if (typeof createJobOnUpload === 'function') await createJobOnUpload({ jobId, s3Key });

                // 3. Start Socket communication
                if (typeof socket !== 'undefined') {
                    socket.emit('join', { room: jobId });
                }

                // 4. Proceed with S3 Upload (multipart: parallel part PUTs) + wake lock + visibility hint
                let uploadWakeLock = null;
                let uploadPhase = 'signing_done';
                let onVisibilityDuringUpload = null;
                let hiddenHintShown = false;
                try {
                    uploadWakeLock = await qsAcquireUploadWakeLock();
                } catch (_) {}

                onVisibilityDuringUpload = function () {
                    if (!document.hidden || uploadPhase !== 's3_put' || hiddenHintShown) return;
                    hiddenHintShown = true;
                    qsUploadTrace('visibility_hidden_during_upload', { jobId, bytes: currentFile && currentFile.size });
                    const T = typeof window.t === 'function' ? window.t : function (k) { return k; };
                    if (typeof showStatus === 'function') {
                        showStatus(T('upload_keep_screen_on') || 'Keep the screen on until upload finishes.', false, { duration: 8000 });
                    }
                };
                document.addEventListener('visibilitychange', onVisibilityDuringUpload);

                const cleanupUploadMonitors = function () {
                    try {
                        if (onVisibilityDuringUpload) document.removeEventListener('visibilitychange', onVisibilityDuringUpload);
                    } catch (_) {}
                    onVisibilityDuringUpload = null;
                    qsReleaseUploadWakeLock(uploadWakeLock);
                    uploadWakeLock = null;
                };

                const isMedicalUpload = isMedicalModeEnabled();
                const multipartAbortPayload = {
                    userId,
                    uploadId,
                    s3Key,
                    bucket,
                    isMedical: isMedicalUpload,
                };

                uploadPhase = 's3_put';
                let multipartComplete = false;
                try {
                    await qsS3MultipartUploadFile({
                        currentFile,
                        userId,
                        uploadId,
                        s3Key,
                        bucket,
                        partSizeBytes,
                        partCount,
                        uploadLabel,
                        mainBtn,
                        isMedical: isMedicalUpload,
                    });
                    multipartComplete = true;
                } catch (upErr) {
                    qsUploadTrace('s3_multipart_failed', { jobId, err: String((upErr && upErr.message) || upErr) });
                    if (!multipartComplete && multipartAbortPayload && multipartAbortPayload.uploadId) {
                        await qsS3MultipartAbortQuiet(multipartAbortPayload);
                    }
                    cleanupUploadMonitors();
                    const dbIdFail = localStorage.getItem('lastJobDbId');
                    if (typeof updateJobStatus === 'function' && dbIdFail) updateJobStatus(dbIdFail, 'failed');
                    window.isTriggering = false;
                    setDiarizationBusyState(false);
                    localStorage.removeItem('activeJobId');
                    stopProcessingStateUI('s3_multipart_upload_failed');
                    hideProgressBar();
                    if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                    if (typeof showStatus === 'function') {
                        showStatus((upErr && upErr.message) || 'Upload failed.', true);
                    }
                    return;
                }

                uploadPhase = 's3_done';
                qsSetProgressBarPct(100);
                if (mainBtn) qsSetMainBtnDynamicLabel(uploadLabel);
                qsUploadTrace('s3_multipart_complete', { jobId, bytes: currentFile && currentFile.size });
                console.log("✅ File uploaded to S3 (multipart).");
                if (skipLocalBlobPreview && userId && s3Key) {
                    try {
                        await qsAttachS3MediaPreview(s3Key, userId, {
                            filename: currentFile.name,
                            isAudio,
                            isVideo,
                            mime: mimeForMov,
                        });
                    } catch (previewErr) {
                        console.warn('S3 media preview attach failed', previewErr);
                    }
                }
                setDiarizationBusyState(true);
                window._triggerRetriedForJobId = null; // allow one auto-retry if trigger gets stuck
                const dbId = localStorage.getItem('lastJobDbId');
                if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'uploaded');
                if (isMedicalUpload) {
                    if (window.__QS_MEDICAL_WARMUP_STATE !== 'ready') {
                        await qsAwaitMedicalWarmupReady(userId);
                    }
                    window.isTriggering = true;
                    qsSetUnifiedProgressPhase('upload', 100);
                    qsStartUnifiedProgressPhase('transcribe');
                } else {
                    window.isTriggering = true;
                    qsSetUnifiedProgressPhase('upload', 100);
                    qsStartUnifiedProgressPhase('transcribe');
                }
                startProcessingStateUI();
                if (statusTxt) statusTxt.style.display = 'none';

                try {
                    uploadPhase = 'trigger_processing';
                    // Always runs after S3 upload completes: tells server upload is complete (upload_status for worker).
                    console.log("Upload complete → /api/trigger_processing");
                    const mediaDurationSec = qsUploadMediaDurationForApi();
                    const triggerPayload = {
                        s3Key: s3Key,
                        bucket: bucket,
                        jobId: jobId,
                        diarization: diarizationValue,
                        isMedical: isMedicalModeEnabled(),
                        language: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he'),
                        ...(mediaDurationSec > 0 ? { mediaDurationSec } : {}),
                    };
                    if (!isMedicalUpload) {
                        triggerPayload.treatAsMusic = qsUserTreatAsMusicForUpload();
                    }
                    const { triggerRes, triggerData } = await qsPostTriggerProcessingWithRetry(triggerPayload, jobId);
                    if (!triggerRes.ok) {
                        console.log("trigger nack", triggerRes.status, triggerData);
                        console.log("❌ Triggering processing failed:", triggerRes.status, triggerData);
                        const msg = qsCreditsTriggerErrorMessage(triggerData)
                            || triggerData.message || triggerData.error
                            || (triggerRes.status === 502 && !triggerData.status
                                ? 'Server timed out starting transcription. Please try again.'
                                : `Server error (${triggerRes.status})`);
                        if (typeof showStatus === 'function') showStatus(msg, true);
                        if (triggerData && (triggerData.error === 'insufficient_credits' || Number.isFinite(Number(triggerData.credit_minutes)))) {
                            qsApplyTriggerCreditFields(triggerData);
                        }
                        const dbId2 = localStorage.getItem('lastJobDbId');
                        if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                        window.isTriggering = false;
                        setDiarizationBusyState(false);
                        localStorage.removeItem('activeJobId');
                        stopProcessingStateUI('upload_trigger_processing_http_not_ok');
                        hideProgressBar();
                        if (mainBtn) mainBtn.disabled = false;
                        return;
                    }

                    qsApplyTriggerCreditFields(triggerData);

                    // Option A: wait for RunPod trigger confirmation before showing "processing"
                    if (triggerRes.status === 202 && (triggerData.status === 'started' || triggerData.status === 'queued')) {
                        const skipRunpodHandshake = triggerData.engine === 'sagemaker_async';
                        if (skipRunpodHandshake) {
                            console.log("trigger ack (sagemaker async — skipping RunPod gpu_started handshake)");
                        } else {
                            console.log("trigger ack (started, waiting for worker handshake)");
                        }
                        const isHebrewUi = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
                        const processingLabel = (typeof window.t === 'function' ? window.t('processing') : 'Processing...');
                        qsStartUnifiedProgressPhase('transcribe');
                        if (mainBtn) qsSetMainBtnDynamicLabel(processingLabel.replace(/\.\.\.?$/, ''));
                        if (statusTxt) {
                            statusTxt.innerText = '';
                            statusTxt.style.display = 'none';
                        }
                        const pollInterval = 4000;
                        const maxTriggerWaitPolls = 240; // ~16 min at 4s; avoids infinite loop on 503 / empty body
                        let ts = skipRunpodHandshake ? { status: 'triggered' } : { status: '' };
                        let httpBadStreak = 0;
                        let vocalSepLogged = false;
                        const prepLabel = isHebrewUi ? 'מפריד קול מהמוזיקה...' : 'Separating vocals from music...';
                        // If socket delivers completion before /api/trigger_status shows "triggered", handleJobUpdate
                        // sets _lastProcessedJobId — don't block here or restart fake progress on top of GPT.
                        const jobAlreadyHandledBySocket = () => (jobId && window._lastProcessedJobId === jobId);
                        if (skipRunpodHandshake) {
                            console.log("✅ SageMaker transcription queued.", triggerData.endpoint || '');
                        } else if (jobAlreadyHandledBySocket()) {
                            console.log('[trigger] socket already handled job before handshake wait; skipping poll loop');
                        } else {
                            for (let pollIx = 0; pollIx < maxTriggerWaitPolls; pollIx++) {
                                if (ts.status === 'triggered' || ts.status === 'failed') break;
                                if (jobAlreadyHandledBySocket()) {
                                    console.log('[trigger] socket handled job during handshake wait; stopping poll loop');
                                    break;
                                }
                                await new Promise(r => setTimeout(r, pollInterval));
                                if (jobAlreadyHandledBySocket()) break;
                                try {
                                    const stRes = await fetch(`/api/trigger_status?job_id=${encodeURIComponent(jobId)}`);
                                    if (!stRes.ok) {
                                        httpBadStreak++;
                                        const giveUp =
                                            httpBadStreak >= 12
                                            || (qsIsSevereServerPollError(stRes.status) && httpBadStreak >= 5);
                                        if (giveUp) {
                                            ts = { status: 'failed', _serverUnavailable: true };
                                            break;
                                        }
                                        continue;
                                    }
                                    httpBadStreak = 0;
                                    ts = await stRes.json();
                                    if (ts.status === 'preprocessing' && !vocalSepLogged) {
                                        vocalSepLogged = true;
                                        console.log('[vocals]', prepLabel, jobId ? { jobId } : '');
                                    }
                                } catch (_) {
                                    httpBadStreak++;
                                    if (httpBadStreak >= 12) {
                                        ts = { status: 'failed', _serverUnavailable: true };
                                        break;
                                    }
                                }
                                if (ts.status === 'triggered' || ts.status === 'failed') break;
                            }
                        }
                        if (!skipRunpodHandshake && ts.status === 'failed' && ts._serverUnavailable) {
                            const dbId2 = localStorage.getItem('lastJobDbId');
                            window.isTriggering = false;
                            setDiarizationBusyState(false);
                            stopProcessingStateUI('trigger_handshake_server_unavailable');
                            hideProgressBar();
                            qsStopFakeProgress('trigger_handshake_server_unavailable');
                            const msg = isHebrewUi
                                ? 'השרת אינו זמין זמנית. רענן את הדף או נסה שוב בעוד רגע.'
                                : 'The server is temporarily unavailable. Refresh the page or try again in a moment.';
                            if (typeof showStatus === 'function') showStatus(msg, true);
                            if (mainBtn) mainBtn.disabled = false;
                            return;
                        }
                        if (!skipRunpodHandshake && ts.status === 'failed') {
                            console.log("trigger nack", ts.status);
                            console.log("❌ Trigger not confirmed:", ts.status);
                            const dbId2 = localStorage.getItem('lastJobDbId');
                            window.isTriggering = false;
                            setDiarizationBusyState(false);
                            stopProcessingStateUI('trigger_handshake_status_failed');
                            hideProgressBar();
                            const msg = isHebrewUi ? 'הפעלת העיבוד נכשלה.' : 'GPU trigger failed.';
                            showTriggerErrorDialog(msg, {
                                onClose: () => {
                                    localStorage.removeItem('activeJobId');
                                    if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                                    if (mainBtn) mainBtn.disabled = false;
                                }
                            });
                            return;
                        }
                        if (jobAlreadyHandledBySocket()) {
                            console.log('[trigger] results already handled via socket; skipping trigger_status messaging');
                        } else if (ts.status !== 'triggered') {
                            console.warn('[trigger] Handshake wait ended without triggered; continuing with job status polling');
                        } else {
                            console.log("trigger ack (triggered)");
                            const trigEngine = (triggerData && triggerData.engine) || 'runpod';
                            if (trigEngine === 'sagemaker_async') {
                                console.log("✅ SageMaker transcription started.", triggerData.endpoint || '');
                            } else {
                                console.log("✅ RunPod trigger confirmed.");
                            }
                        }
                        try {
                            if (typeof socket !== 'undefined' && jobId) {
                                socket.emit('join', { room: jobId });
                            }
                        } catch (_) {}
                        const supersededBySocket = jobAlreadyHandledBySocket();
                        if (!supersededBySocket && typeof startFakeProgress === 'function') {
                            startFakeProgress();
                        }
                    } else if (triggerRes.status === 202) {
                        console.log("trigger nack", "unexpected status", triggerData.status);
                    }
                    // Polling fallback: if socket misses callback (e.g. room encoding), poll check_status
                    if (jobId && typeof window.handleJobUpdate === 'function' && !(jobId && window._lastProcessedJobId === jobId)) {
                        window.startJobStatusPolling(jobId);
                    }
                } catch (err) {
                    console.log("trigger nack", "exception", err && err.message);
                    qsUploadTrace('trigger_processing_exception', { jobId, err: String((err && err.message) || err) });
                    const dbId2 = localStorage.getItem('lastJobDbId');
                    if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                    window.isTriggering = false;
                    setDiarizationBusyState(false);
                    localStorage.removeItem('activeJobId');
                    stopProcessingStateUI('upload_after_s3_trigger_processing_exception');
                    hideProgressBar();
                    if (mainBtn) mainBtn.disabled = false;
                }

                cleanupUploadMonitors();

            }
            catch (err) {
                console.error("Upload Error:", err);
                window.isTriggering = false;
                setDiarizationBusyState(false);
                localStorage.removeItem('activeJobId');
                stopProcessingStateUI('file_input_change_upload_catch');
                hideProgressBar();
                if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                if (typeof showStatus === 'function') showStatus((typeof window.t === 'function' ? window.t('error_starting_upload') : "Error starting upload."), true);
            }
                };

                if (isMedicalModeEnabled()) {
                    await runUploadPipeline();
                    return;
                }

                try { window.__QS_UPLOAD_PREVIEW_READY = false; } catch (_) {}
                qsShowLocalUploadMediaPreview(file);
                setSeoHomeContentVisibility(false);
                try {
                    document.body.classList.add('qs-app-busy');
                    if (typeof qsSyncAppChromeBodyClasses === 'function') qsSyncAppChromeBodyClasses();
                } catch (_) {}
                const placeholderElPrep = document.getElementById('placeholder');
                if (placeholderElPrep) placeholderElPrep.style.display = 'none';

                const durationProbeMs = qsIsLargeUploadFile(file) ? 12000 : 8000;
                const creditsRefresh = (typeof qsRefreshUserCredits === 'function')
                    ? qsRefreshUserCredits({ ensureWelcome: true })
                    : Promise.resolve();
                const [durationSec] = await Promise.all([
                    qsProbeFileMediaDurationSec(file, durationProbeMs),
                    creditsRefresh,
                ]);
                window.__QS_UPLOAD_MEDIA_DURATION_SEC = durationSec > 0 ? durationSec : null;
                if (qsShouldShowUploadMusicConfirm(durationSec)) {
                    const uploadChoice = await qsShowUploadConfirmModal(file, { durationSec });
                    if (!uploadChoice) {
                        fileInput.value = '';
                        try { window.__QS_UPLOAD_PREVIEW_READY = false; } catch (_) {}
                        qsRestoreUiAfterUploadConfirmCancel();
                        return;
                    }
                    qsSetUserAudioProfileChoice(!!uploadChoice.treatAsMusic);
                } else {
                    qsSetUserAudioProfileChoice(false);
                }
                if (!(await qsEnsureCreditsForUpload(durationSec, { skipRefresh: true }))) {
                    fileInput.value = '';
                    try { window.__QS_UPLOAD_PREVIEW_READY = false; } catch (_) {}
                    qsRestoreUiAfterUploadConfirmCancel({ keepMediaPreview: true });
                    return;
                }
                await runUploadPipeline();
                return;
            } catch (pickerFlowErr) {
                console.warn('File picker flow failed', pickerFlowErr);
                fileInput.value = '';
            }
        })
    }
});

// ----------------- Video + Subtitle Frontend Helpers -----------------
function parseSRT(srtText) {
    if (!srtText) return [];
    const blocks = srtText.trim().split(/\r?\n\r?\n/);
    const cues = [];
    const toSeconds = (t) => {
        // Accept MM:SS,mmm or HH:MM:SS,mmm (comma or dot)
        const parts = t.replace(',', '.').split(':').map(p => p.trim());
        if (parts.length === 2) {
            const m = parseFloat(parts[0] || 0);
            const s = parseFloat(parts[1] || 0);
            return m * 60 + s;
        }
        const h = parseFloat(parts[0] || 0);
        const m = parseFloat(parts[1] || 0);
        const s = parseFloat(parts[2] || 0);
        return h * 3600 + m * 60 + s;
    };

    for (const block of blocks) {
        const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        // Find the line with the timestamp (contains -->)
        let timeLine = null;
        let textStartIdx = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('-->')) {
                timeLine = lines[i];
                textStartIdx = i + 1;
                break;
            }
        }
        if (!timeLine) continue;

        // Accept:
        // - MM:SS
        // - MM:SS,mmm / MM:SS.mmm
        // - HH:MM:SS
        // - HH:MM:SS,mmm / HH:MM:SS.mmm
        const ts = '(?:\\d{1,2}:)?\\d{2}:\\d{2}(?:[.,]\\d{1,3})?';
        const m = timeLine.match(new RegExp(`(${ts})\\s*-->\\s*(${ts})`));
        if (!m) continue;
        const start = toSeconds(m[1]);
        const end = toSeconds(m[2]);
        const text = lines.slice(textStartIdx).join('\n');
        cues.push({ start, end, text });
    }
    return cues;
}

function getUserTargetLang() {
    const locale = (window.currentLocale || localStorage.getItem('locale') || 'he').toLowerCase();
    if (locale.startsWith('en')) return 'en';
    if (locale.startsWith('he')) return 'he';
    return locale;
}

/** Enforce minimum duration per segment and no overlaps. Returns new array; does not mutate. */
function normalizeSegmentDurations(segments, minDuration = 0.5) {
    if (!segments || segments.length === 0) return segments;
    const out = segments.map(s => ({
        ...s,
        start: s.start,
        end: Math.max(s.end != null ? s.end : s.start + 1, s.start + minDuration)
    }));
    for (let i = 1; i < out.length; i++) {
        const prevEnd = out[i - 1].end;
        if (out[i].start < prevEnd) out[i].start = prevEnd;
        const dur = out[i].end - out[i].start;
        if (dur < minDuration) out[i].end = out[i].start + minDuration;
    }
    return out;
}

// SRT: many players default to LTR, so Hebrew/mixed lines can display in wrong order.
// Wrap in Unicode RTL embedding so bidi-aware players show like the transcript.
const HEBREW_RE = /[\u0590-\u05FF]/;
const LATIN_WORD_RE = /[a-zA-Z]{2,}/;
const RTL_EMBED = '\u202B';  // U+202B Right-to-Left Embedding
const RTL_POP = '\u202C';   // U+202C Pop Directional Formatting

function rtlLineForSrtVisual(text) {
    if (!text || !HEBREW_RE.test(text)) return text;
    const original = String(text);
    const trimmed = original.trimEnd();
    if (!trimmed) return original;

    const isMixed = LATIN_WORD_RE.test(trimmed);

    if (isMixed) {
        // Mixed Hebrew+English: wrap in RTL embedding so player lays out like transcript (RTL with LTR embed for "QuickScribe").
        if (trimmed.startsWith(RTL_EMBED) && trimmed.endsWith(RTL_POP)) return original;
        return RTL_EMBED + trimmed + RTL_POP;
    }

    // Pure Hebrew: move trailing punctuation to start (no space) for LTR players.
    const m = trimmed.match(/^(.*?)([.,!?…:;]+)$/u);
    if (!m) return original;

    const body = m[1].trimStart();
    const punct = m[2];
    if (!body) return original;
    if (body.startsWith(punct)) return original;

    return `${punct}${body}`;
}

// Set to true in console (window.DEBUG_SRT = true) then export SRT to log each line's before/after
function srtFromCues(cues) {
    const normalized = normalizeSegmentDurations(cues, 0.5);
    const debug = !!window.DEBUG_SRT;
    return normalized.map((c, i) => {
        const pad = (n) => String(Math.floor(n)).padStart(2, '0');
        const fmt = (s) => {
            const ms = Math.floor((s - Math.floor(s)) * 1000);
            const hh = Math.floor(s / 3600);
            const mm = Math.floor((s % 3600) / 60);
            const ss = Math.floor(s % 60);
            return `${pad(hh)}:${pad(mm)}:${pad(ss)},${String(ms).padStart(3,'0')}`;
        };
        const raw = String(c.text || '').replace(/\n/g, ' ');
        const text = rtlLineForSrtVisual(raw);
        if (debug && i < 5) {
            const repr = (s) => {
                if (!s || s.length === 0) return '';
                const arr = Array.from(s);
                const first = arr.slice(0, 2).map((ch, idx) => ch + '(U+' + (s.codePointAt(idx) || 0).toString(16).toUpperCase() + ')').join(' ');
                const last = arr.length > 2 ? arr.slice(-2).map((ch, idx) => ch + '(U+' + (s.codePointAt(s.length - 2 + idx) || 0).toString(16).toUpperCase() + ')').join(' ') : first;
                return arr.length > 4 ? first + ' ... ' + last : first + ' ' + last;
            };
            console.log('[SRT debug] cue ' + (i + 1), { raw, text, rawRepr: repr(raw), outRepr: repr(text) });
        }
        return `${i+1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${text}\n`;
    }).join('\n');
}

const QS_MEDICAL_SUMMARY_SECTION_LABELS = {
    chief: 'תלונה',
    exam: 'ממצאים',
    rec: 'המלצות למטופל'
};

function _medicalText(key, fallback) {
    if (typeof window.t === 'function') {
        const value = window.t(key);
        if (value && value !== key) return value;
    }
    return fallback;
}

function _medicalSummarySectionLabel(sectionKey) {
    const keyMap = {
        chief: 'medical_summary_chief',
        exam: 'medical_summary_exam',
        rec: 'medical_summary_recommendations'
    };
    return _medicalText(keyMap[sectionKey], QS_MEDICAL_SUMMARY_SECTION_LABELS[sectionKey] || sectionKey);
}

function _medicalSummarySectionHeadHtml(title, sectionKey, esc) {
    const t = esc(title);
    const key = esc(sectionKey);
    const label = esc(_medicalSummarySectionLabel(sectionKey) || title);
    const copyLabel = esc(_medicalText('medical_copy', 'Copy'));
    return (
        `<div class="medical-summary-section-head" contenteditable="false">` +
        `<span class="medical-summary-section-title">${t}</span>` +
        `<button type="button" class="medical-summary-section-copy" data-medical-copy-section="${key}" ` +
        `aria-label="${copyLabel} ${label}" title="${copyLabel}">` +
        `<span class="medical-copy-icon" aria-hidden="true"></span></button></div>`
    );
}

async function _copyMedicalSummarySection(sectionKey) {
    const label = _medicalSummarySectionLabel(sectionKey) || sectionKey;
    if (typeof requireUserForCopyOrDownload === 'function') {
        const ok = await requireUserForCopyOrDownload();
        if (!ok) return;
    }
    const win = document.getElementById('transcript-window');
    const selMap = {
        chief: '[data-medical-section="chief"], #medical-summary-chief',
        exam: '[data-medical-section="exam"], #medical-summary-exam',
        rec: '[data-medical-section="rec"], #medical-summary-rec'
    };
    let text = '';
    if (win && selMap[sectionKey]) {
        const el = win.querySelector(selMap[sectionKey]);
        if (el) text = String(el.innerText || el.textContent || '').trim();
    }
    const skip = new Set([
        'לא צוין.',
        'אין סיכום רפואי זמין עדיין.',
        'Not specified.',
        'No medical summary is available yet.'
    ]);
    if (!text || skip.has(text)) {
        const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
            ? window.currentFormattedDoc : {};
        const fieldMap = {
            chief: 'medical_chief_complaint',
            exam: 'medical_examination_transcript',
            rec: 'medical_patient_recommendations'
        };
        const fk = fieldMap[sectionKey];
        if (fk) text = String(fmt[fk] || '').trim();
    }
    if (!text || skip.has(text)) {
        if (typeof showStatus === 'function') {
            showStatus(`${_medicalText('medical_no_text_to_copy', 'No text to copy')}: ${label}.`, true);
        }
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        if (typeof showStatus === 'function') showStatus(`${label} הועתק.`, false, { duration: 2500 });
        try {
            if (typeof ensureJobRecordOnExport === 'function') await ensureJobRecordOnExport();
        } catch (_) {}
    } catch (_) {
        if (typeof showStatus === 'function') showStatus('העתקה נכשלה.', true);
    }
}

function _wireMedicalSummarySectionCopyButtonsOnce() {
    const container = document.getElementById('transcript-window');
    if (!container || container._qsMedicalSectionCopyWired) return;
    container._qsMedicalSectionCopyWired = true;
    container.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-medical-copy-section]') : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const key = String(btn.getAttribute('data-medical-copy-section') || '').trim();
        if (!key) return;
        void _copyMedicalSummarySection(key);
    });
}

/** Enable editing only on medical summary body fields; keep the shell and section titles non-editable. */
function _qsSetMedicalSummaryPaneEditable(win, editable) {
    if (!win) return;
    const on = editable ? 'true' : 'false';
    win.contentEditable = 'false';
    const marked = win.querySelectorAll('[data-medical-section="chief"], [data-medical-section="exam"], [data-medical-section="rec"]');
    if (marked.length) {
        marked.forEach((el) => { el.contentEditable = on; });
    } else {
        win.querySelectorAll('#medical-summary-chief, #medical-summary-exam, #medical-summary-rec').forEach((el) => {
            el.contentEditable = on;
        });
    }
    const overview = win.querySelector('#medical-summary-overview');
    if (overview) overview.contentEditable = on;
    const points = win.querySelector('#medical-summary-points');
    if (points) {
        points.querySelectorAll('li').forEach((li) => { li.contentEditable = on; });
    }
}

function _medicalHasFormattedSummaryContent() {
    const fmt = window.currentFormattedDoc;
    if (!fmt || typeof fmt !== 'object') return false;
    if (String(fmt.medical_chief_complaint || '').trim()) return true;
    if (String(fmt.medical_examination_transcript || '').trim()) return true;
    if (String(fmt.medical_patient_recommendations || '').trim()) return true;
    if (String(fmt.overview || '').trim()) return true;
    const kp = fmt.key_points;
    return Array.isArray(kp) && kp.some((p) => String(p || '').trim());
}

/**
 * Medical "תמלול" tab: prefer GPT `clean_transcript` paragraphs, not word/caption subtitle rows.
 */
function renderMedicalTranscriptMainView() {
    const transcriptWindow = document.getElementById('transcript-window');
    if (!transcriptWindow) return;
    if (!isMedicalModeEnabled()) return;
    if (String(window.medicalActiveTab || 'summary') !== 'transcript') return;
    const preferSeg = !!window._qsDocPreferSegmentsAfterEdit;
    let clean = '';
    if (!preferSeg) {
        clean = String((window.currentFormattedDoc && window.currentFormattedDoc.clean_transcript) || '').trim();
    }
    if (!clean) {
        clean = String(buildTranscriptPlainBodyForExport() || '').trim();
    }
    const timedCues = Array.isArray(window.currentSegments)
        ? window.currentSegments.filter((c) => Number.isFinite(_asTranscriptTime(c && c.start)) && String((c && (c.translated_text || c.text)) || '').trim())
        : [];
    if (!clean && timedCues.length > 0) {
        renderTranscriptFromCues(window.currentSegments || []);
        return;
    }
    const locale = String(typeof qsResolveAppLocale === 'function' ? qsResolveAppLocale() : (window.currentLocale || 'he')).toLowerCase();
    const isRtl = locale.startsWith('he') || locale.startsWith('ar');
    const textDirection = isRtl ? 'rtl' : 'ltr';
    const textAlign = isRtl ? 'right' : 'left';
    if (clean) {
        const paragraphs = clean.split(/\r?\n+/).map((l) => String(l || '').trim()).filter(Boolean);
        const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        transcriptWindow.innerHTML = paragraphs.map((p) => (
            '<div class="qs-medical-plain-paragraph qs-medical-formatted-transcript" style="display:block; margin-bottom:0.55em;">' +
            `<p style="margin:0; line-height:1.72; white-space:pre-wrap;" dir="${textDirection}">${esc(p)}</p></div>`
        )).join('');
        transcriptWindow.style.direction = textDirection;
        transcriptWindow.style.textAlign = textAlign;
        transcriptWindow.contentEditable = 'false';
        return;
    }
    if (typeof renderTranscriptFromCues === 'function') {
        renderTranscriptFromCues(window.currentSegments || []);
    }
}

function _medicalHasTranscriptModel(cues) {
    if (Array.isArray(cues) && cues.length > 0) return true;
    return Array.isArray(window.currentWords) && window.currentWords.length > 0;
}

function renderTranscriptFromCues(cues) {
    window.currentSegments = cues;
    try { if (typeof window.refreshMedicalTabs === 'function') window.refreshMedicalTabs(); } catch (_) {}
    const container = document.getElementById('transcript-window');
    if (!container) return;
    container.classList.remove('medical-wave-active');
    const isMedical = isMedicalModeEnabled();
    const activeTab = String(window.medicalActiveTab || 'transcript');
    container.onclick = null;
    container.onbeforeinput = null;
    if (container._qsSelectionChangeHandler) {
        document.removeEventListener('selectionchange', container._qsSelectionChangeHandler);
        container._qsSelectionChangeHandler = null;
    }
    const locale = String(typeof qsResolveAppLocale === 'function' ? qsResolveAppLocale() : (window.currentLocale || 'he')).toLowerCase();
    const isRtl = locale.startsWith('he') || locale.startsWith('ar');
    const textDirection = isRtl ? 'rtl' : 'ltr';
    const textAlign = isRtl ? 'right' : 'left';
    // Do not paint the clinical summary shell on the landing screen (no job / no cues yet).
    const showMedicalSummaryPane =
        isMedical &&
        activeTab === 'summary' &&
        (_medicalHasTranscriptModel(cues) || _medicalHasFormattedSummaryContent());
    if (showMedicalSummaryPane) {
        const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object') ? window.currentFormattedDoc : {};
        const hasStructured =
            fmt.medical_chief_complaint != null ||
            fmt.medical_examination_transcript != null ||
            fmt.medical_patient_recommendations != null;
        const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const emptyMsg = _medicalText('medical_summary_empty', 'No medical summary is available yet.');
        const notSpecifiedMsg = _medicalText('medical_summary_not_specified', 'Not specified.');
        const summaryDirection = isRtl ? 'rtl' : 'ltr';
        const summaryAlign = isRtl ? 'right' : 'left';
        if (hasStructured) {
            const chief = _medicalSummaryFieldBody(fmt.medical_chief_complaint, 'chief');
            const exam = _medicalSummaryFieldBody(fmt.medical_examination_transcript, 'exam');
            const rec = _medicalSummaryFieldBody(fmt.medical_patient_recommendations, 'rec');
            container.innerHTML = `
            <div id="medical-summary-content" style="direction:${summaryDirection}; text-align:${summaryAlign}; line-height:1.72;" contenteditable="false">
                ${_medicalSummarySectionHeadHtml(_medicalSummarySectionLabel('chief'), 'chief', esc)}
                <div id="medical-summary-chief" data-medical-section="chief">${esc(chief || emptyMsg)}</div>
                ${_medicalSummarySectionHeadHtml(_medicalSummarySectionLabel('exam'), 'exam', esc)}
                <div id="medical-summary-exam" data-medical-section="exam">${esc(exam || notSpecifiedMsg)}</div>
                ${_medicalSummarySectionHeadHtml(_medicalSummarySectionLabel('rec'), 'rec', esc)}
                <div id="medical-summary-rec" data-medical-section="rec">${esc(rec || notSpecifiedMsg)}</div>
            </div>
        `;
        } else {
            const overview = String(fmt.overview || '').trim();
            const points = Array.isArray(fmt.key_points) ? fmt.key_points.map((p) => String(p || '').trim()).filter(Boolean) : [];
            const pointsHtml = points.length
                ? `<ul id="medical-summary-points" style="margin:8px 0 0; padding-inline-start:20px;" contenteditable="false">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
                : `<div id="medical-summary-empty" style="color:#6b7280;" contenteditable="false">${esc(emptyMsg)}</div>`;
            container.innerHTML = `
            <div id="medical-summary-content" style="direction:${summaryDirection}; text-align:${summaryAlign}; line-height:1.72;" contenteditable="false">
                <div style="font-weight:700; margin-bottom:6px;" contenteditable="false">${esc(_medicalText('medical_summary_overview', 'Overview'))}</div>
                <div id="medical-summary-overview">${esc(overview || emptyMsg)}</div>
                <div style="font-weight:700; margin:14px 0 6px;" contenteditable="false">${esc(_medicalText('medical_summary_key_points', 'Key points'))}</div>
                ${pointsHtml}
            </div>
        `;
        }
        _wireMedicalSummarySectionCopyButtonsOnce();
        try { renderMedicalTrainingPanel(container); } catch (e) { console.warn('[medical training] render failed', e); }
        try { renderMedicalTrainingOnboardingCta(container); } catch (e) { console.warn('[medical training] onboarding cta failed', e); }
        container.contentEditable = 'false';
        return;
    }
    if (!_medicalHasTranscriptModel(cues)) {
        if (isMedical) {
            const T = typeof window.t === 'function' ? window.t : function(k) { return k; };
            const medicalEmptyTitle = T('medical_secure_clinical_session') || 'Secure clinical session';
            const medicalEmptyHint = T('medical_start_recording_hint') || 'Start recording with the button below. The transcript will appear here after recording and processing finish.';
            container.innerHTML = `
                <div style="color:#64748b; text-align:center; margin-top:32px; line-height:1.75; font-size:0.95rem; direction:${textDirection};">
                    <div style="font-weight:600; color:#0f766e;">${medicalEmptyTitle}</div>
                    <div style="margin-top:12px;">${medicalEmptyHint}</div>
                </div>
            `;
        } else {
            container.innerHTML = '';
        }
        return;
    }
    // Legacy rendering path for cue-only transcripts (no word timestamps).
    const cueList = Array.isArray(cues) ? cues : [];
    const html = cueList.map((c, idx) => {
        const mainText = String(c.translated_text || c.text || '').trim();
        const safe = mainText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const startSec = _asTranscriptTime(c.start);
        const jumpAttr = Number.isFinite(startSec) ? ` onclick="window.jumpTo(${startSec})"` : '';
        return `
        <div class="paragraph-row" id="seg-${Math.floor(Number(startSec) || c.start || 0)}" style="display:block; margin-bottom: 0.1em; direction: ${textDirection}; text-align: ${textAlign}; cursor: pointer;"${jumpAttr}>
            <div style="font-size:0.85em; color:#6b7280; margin-bottom:0; line-height:1.05;">[${formatTime(c.start)}]</div>
            <p data-idx="${idx}" style="margin:0 !important; margin-top:-2px; line-height:1.2; white-space:pre-wrap;">${safe}</p>
        </div>`;
    }).join('');

    container.innerHTML = html;
    container.style.direction = textDirection;
    container.style.textAlign = textAlign;
    container.contentEditable = 'false';
}

/** Coerce Whisper word/segment times (API may send numbers or numeric strings). */
function _asTranscriptTime(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v.trim());
        if (Number.isFinite(n)) return n;
    }
    return NaN;
}

function _hasWordTimestampsInSegments(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return false;
    for (const seg of segments) {
        const ws = seg && seg.words;
        if (!Array.isArray(ws) || ws.length === 0) continue;
        const w0 = ws[0];
        const s = _asTranscriptTime(w0 && (w0.start ?? w0['start']));
        const e = _asTranscriptTime(w0 && (w0.end ?? w0['end']));
        if (Number.isFinite(s) && Number.isFinite(e)) return true;
    }
    return false;
}

function _normalizeWordsCaptionsModel(words, captions) {
    if (Array.isArray(words)) {
        words.forEach((w) => {
            if (w && typeof w === 'object' && w.highlighted == null) w.highlighted = false;
        });
    }
    if (Array.isArray(captions)) {
        captions.forEach((c) => {
            if (!c || typeof c !== 'object' || !c.style || typeof c.style !== 'object') return;
            c.style.highlightMode = 'none';
            const p = c.style.position;
            if (p !== 'top' && p !== 'middle' && p !== 'bottom') delete c.style.position;
        });
    }
}

function _buildWordModelFromSegments(segments) {
    // Build flat words[] + captions[] ONLY from real word timestamps (no estimating).
    const words = [];
    const captions = [];
    let wi = 0;
    for (let si = 0; si < segments.length; si++) {
        const seg = segments[si] || {};
        const ws = seg.words;
        if (!Array.isArray(ws) || ws.length === 0) continue;
        const startIndex = wi;
        for (let j = 0; j < ws.length; j++) {
            const w = ws[j] || {};
            const text = (w.text ?? w.word ?? '').toString();
            const start = _asTranscriptTime(w.start);
            const end = _asTranscriptTime(w.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
            words.push({ id: `w${wi}`, text, start, end, highlighted: false });
            wi++;
        }
        const endIndex = wi - 1;
        if (endIndex >= startIndex) {
            captions.push({ id: `c${captions.length}`, wordStartIndex: startIndex, wordEndIndex: endIndex });
        }
    }
    if (words.length === 0 || captions.length === 0) return null;
    return { words, captions };
}

/** When the worker sends `word_segments` (flat) but no per-segment `words`, group captions by silence gaps. */
function _buildWordModelFromFlatWordSegments(flatWords, gapSec) {
    const gap = gapSec == null ? 1.25 : Number(gapSec);
    const gapOk = Number.isFinite(gap) && gap > 0 ? gap : 1.25;
    if (!Array.isArray(flatWords) || flatWords.length === 0) return null;
    const words = [];
    for (let i = 0; i < flatWords.length; i++) {
        const w = flatWords[i] || {};
        const text = (w.text != null ? w.text : w.word);
        const start = _asTranscriptTime(w.start);
        const end = _asTranscriptTime(w.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        words.push({
            id: `w${i}`,
            text: String(text != null ? text : '').trim(),
            start,
            end,
            highlighted: false
        });
    }
    const captions = [];
    let startIdx = 0;
    for (let i = 0; i < words.length; i++) {
        const next = words[i + 1];
        const silence = next ? (next.start - words[i].end) : gapOk + 1;
        if (silence > gapOk || !next) {
            captions.push({ id: `c${captions.length}`, wordStartIndex: startIdx, wordEndIndex: i });
            startIdx = i + 1;
        }
    }
    if (words.length && captions.length === 0) {
        captions.push({ id: 'c0', wordStartIndex: 0, wordEndIndex: words.length - 1 });
    }
    if (words.length === 0 || captions.length === 0) return null;
    return { words, captions };
}

function _tryBuildWordModelFromSegmentsAndFlat(segments, flatWordSegments) {
    const segs = Array.isArray(segments) ? segments : [];
    if (_hasWordTimestampsInSegments(segs)) {
        const m = _buildWordModelFromSegments(segs);
        if (m) return m;
    }
    if (Array.isArray(flatWordSegments) && flatWordSegments.length) {
        return _buildWordModelFromFlatWordSegments(flatWordSegments);
    }
    return null;
}

function getCaptionText(caption, words) {
    return words
        .slice(caption.wordStartIndex, caption.wordEndIndex + 1)
        .map(w => (w && w.text ? String(w.text) : '').trim())
        .filter(Boolean)
        .join(' ');
}

const _QS_DISPLAY_TIME_BRACKET = /^\[\d{1,2}:\d{2}\.\d{2}\]$/;
const _QS_DISPLAY_TIME_BARE = /^\d{1,2}:\d{2}\.\d{2}$/;
const _QS_DISPLAY_TIME_TRAILING = /\[\d{1,2}:\d{2}\.\d{2}\]\s*$/;
const _QS_DISPLAY_TIME_LEADING = /^\s*\[\d{1,2}:\d{2}\.\d{2}\]\s*/;

function _qsWordTextIsDisplayTimestampOnly(t) {
    const s = String(t || '').trim();
    return _QS_DISPLAY_TIME_BRACKET.test(s) || _QS_DISPLAY_TIME_BARE.test(s);
}

/** When merging two captions, strip UI timestamps absorbed into word text (e.g. `[00:35.02]`). */
function _qsSanitizeWordModelCaptionMergeBoundaries(words, leftCaptionLastWi, rightCaptionFirstWi, rightCaptionLastWi) {
    if (!Array.isArray(words) || !Number.isFinite(leftCaptionLastWi) || !Number.isFinite(rightCaptionFirstWi) || !Number.isFinite(rightCaptionLastWi)) return;
    const lw = words[leftCaptionLastWi];
    if (lw && lw.text != null) {
        lw.text = String(lw.text).replace(_QS_DISPLAY_TIME_TRAILING, '').trimEnd();
    }
    for (let wi = rightCaptionFirstWi; wi <= rightCaptionLastWi; wi++) {
        const w = words[wi];
        if (!w) continue;
        const t = String(w.text || '').trim();
        if (_qsWordTextIsDisplayTimestampOnly(t)) w.text = '';
        else {
            w.text = String(w.text || '').replace(_QS_DISPLAY_TIME_LEADING, '').trim();
            break;
        }
    }
}

function _captionsToCues(words, captions) {
    const cues = [];
    if (!Array.isArray(words) || !Array.isArray(captions)) return cues;
    for (let i = 0; i < captions.length; i++) {
        const c = captions[i];
        const ws = words[c.wordStartIndex];
        const we = words[c.wordEndIndex];
        if (!ws || !we) continue;
        cues.push({
            start: ws.start,
            end: we.end,
            text: getCaptionText(c, words)
        });
    }
    return cues;
}

/** Line-timing mode: adjust whole caption/segment times (no per-word timing UI). */
window._qsTimingMode = false;
window._qsTimingModeBackup = null;
window._qsTimingSelectedCi = 0;

const QS_LINE_TIMING_STEP = 0.05;
const QS_LINE_MIN_DUR = 0.05;
const QS_SYNC_PX_PER_SEC = 90;

/** Pointer X increases to the right; map movement so drag-left advances time (positive Δs). */
function _qsSyncDxToDeltaSec(dx) {
    return -(Number(dx) / QS_SYNC_PX_PER_SEC);
}

/** Caption time range: RTL wraps outer dir=rtl so start stays on the right; inner dir=ltr keeps mm:ss digits readable. */
function _qsCaptionTimeRangeHtml(startSec, endSec) {
    const locale = String(window.currentLocale || (typeof localStorage !== 'undefined' && localStorage.getItem('locale')) || 'he').toLowerCase();
    const localeRtl = locale.startsWith('he') || locale.startsWith('ar');
    const win = typeof document !== 'undefined' ? document.getElementById('transcript-window') : null;
    const rtl = (win && win.classList.contains('qs-rtl')) || localeRtl;
    const a = formatTime(startSec);
    const b = formatTime(endSec);
    if (rtl) {
        return `<span dir="rtl" class="qs-time-range"><span dir="ltr">${a}</span> \u2192 <span dir="ltr">${b}</span></span>`;
    }
    return `<span dir="ltr" class="qs-time-range">${a} \u2192 ${b}</span>`;
}

/** Whole-line shift: sign left, value inside thin ↔ track (see .qs-line-time-drag). */
function _qsUpdateLineTimeDragDeltaLabel(container, ci, deltaSec) {
    if (!container || !Number.isFinite(ci)) return;
    const chip = container.querySelector(`.qs-line-time-drag[data-ci="${ci}"]`)
        || container.querySelector(`.qs-line-time-drag[data-timing-idx="${ci}"]`);
    if (!chip) return;
    const signEl = chip.querySelector('.qs-line-time-drag__sign');
    const valEl = chip.querySelector('.qs-line-time-drag__value');
    if (!signEl || !valEl) return;
    const d = Number(deltaSec) || 0;
    signEl.textContent = d >= 0 ? '+' : '\u2212';
    valEl.textContent = `${Math.abs(d).toFixed(2)}s`;
}

function _qsCloneTimingStateForBackup() {
    try {
        return {
            words: Array.isArray(window.currentWords) ? JSON.parse(JSON.stringify(window.currentWords)) : null,
            captions: Array.isArray(window.currentCaptions) ? JSON.parse(JSON.stringify(window.currentCaptions)) : null,
            segments: JSON.parse(JSON.stringify(window.currentSegments || [])),
        };
    } catch (_) {
        return null;
    }
}

function _qsTimingCuesForOverlap() {
    const w = window.currentWords;
    const c = window.currentCaptions;
    if (Array.isArray(w) && Array.isArray(c) && c.length) {
        return _captionsToCues(w, c);
    }
    return Array.isArray(window.currentSegments) ? window.currentSegments : [];
}

function _qsCaptionOverlapIndexSet() {
    const set = new Set();
    const cues = _qsTimingCuesForOverlap();
    if (!cues || cues.length < 2) return set;
    for (let i = 1; i < cues.length; i++) {
        const prev = cues[i - 1];
        const cur = cues[i];
        const pe = Number.isFinite(prev.end) ? prev.end : (Number(prev.start) + 1);
        const cs = Number.isFinite(cur.start) ? cur.start : 0;
        if (cs < pe - 1e-4) {
            set.add(i - 1);
            set.add(i);
        }
    }
    return set;
}

function _qsSeekToCaptionStart(ci) {
    const w = window.currentWords;
    const caps = window.currentCaptions;
    let t = NaN;
    if (Array.isArray(w) && Array.isArray(caps) && caps[ci]) {
        const cap = caps[ci];
        const ws = w[cap.wordStartIndex];
        if (ws) t = _asTranscriptTime(ws.start);
    } else if (window.currentSegments && window.currentSegments[ci]) {
        t = _asTranscriptTime(window.currentSegments[ci].start);
    }
    if (Number.isFinite(t) && typeof window.jumpTo === 'function') window.jumpTo(t);
}

function _qsSetSyncModeButtonActive(on) {
    const b = document.getElementById('btn-timing');
    if (b) b.classList.toggle('is-active', !!on);
}

function _qsSyncEnsureTooltip() {
    let el = document.getElementById('qs-sync-drag-tooltip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'qs-sync-drag-tooltip';
        el.className = 'qs-sync-drag-tooltip';
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
    }
    return el;
}

function _qsSyncRestoreWordsFromSnaps(lo, hi, snaps) {
    const w = window.currentWords;
    if (!w || !snaps) return;
    for (let i = 0; i < snaps.length; i++) {
        const ww = w[lo + i];
        const s = snaps[i];
        if (ww && s && Number.isFinite(s.start) && Number.isFinite(s.end)) {
            ww.start = s.start;
            ww.end = s.end;
        }
    }
}

function _qsSyncWordRangeSnaps(lo, hi) {
    const w = window.currentWords;
    if (!w) return null;
    const out = [];
    for (let wi = lo; wi <= hi; wi++) {
        const ww = w[wi];
        if (!ww) return null;
        const s = Number(ww.start);
        if (!Number.isFinite(s)) return null;
        let en = Number(ww.end);
        if (!Number.isFinite(en)) en = s + QS_LINE_MIN_DUR;
        out.push({ start: s, end: en });
    }
    return out;
}

function _qsSyncApplyWordMoveFromBaseline(ci, baselineSnaps, deltaSec) {
    const cap = window.currentCaptions && window.currentCaptions[ci];
    const words = window.currentWords;
    if (!cap || !words || !baselineSnaps) return false;
    const lo = cap.wordStartIndex;
    const hi = cap.wordEndIndex;
    _qsSyncRestoreWordsFromSnaps(lo, hi, baselineSnaps);
    for (let wi = lo; wi <= hi; wi++) {
        const ww = words[wi];
        if (!ww) continue;
        ww.start = Math.round((ww.start + deltaSec) * 1000) / 1000;
        ww.end = Math.round((ww.end + deltaSec) * 1000) / 1000;
    }
    let minS = Infinity;
    for (let wi = lo; wi <= hi; wi++) {
        const ww = words[wi];
        if (ww && Number.isFinite(ww.start)) minS = Math.min(minS, ww.start);
    }
    if (minS < 0) {
        const fix = -minS;
        for (let wi = lo; wi <= hi; wi++) {
            const ww = words[wi];
            if (!ww) continue;
            ww.start = Math.round((ww.start + fix) * 1000) / 1000;
            ww.end = Math.round((ww.end + fix) * 1000) / 1000;
        }
    }
    return true;
}

function _qsSyncApplyWordStretchStartFromBaseline(ci, baselineSnaps, deltaSec) {
    const cap = window.currentCaptions && window.currentCaptions[ci];
    const words = window.currentWords;
    if (!cap || !words || !baselineSnaps || baselineSnaps.length === 0) return false;
    const lo = cap.wordStartIndex;
    const hi = cap.wordEndIndex;
    const b0 = baselineSnaps[0];
    const b1 = baselineSnaps[baselineSnaps.length - 1];
    const oldS = b0.start;
    const oldE = b1.end;
    _qsSyncRestoreWordsFromSnaps(lo, hi, baselineSnaps);
    let newS = oldS + deltaSec;
    newS = Math.min(newS, oldE - QS_LINE_MIN_DUR);
    newS = Math.max(0, newS);
    return _qsRescaleWordsInRange(lo, hi, oldS, oldE, newS, oldE);
}

function _qsSyncApplyWordStretchEndFromBaseline(ci, baselineSnaps, deltaSec) {
    const cap = window.currentCaptions && window.currentCaptions[ci];
    const words = window.currentWords;
    if (!cap || !words || !baselineSnaps || baselineSnaps.length === 0) return false;
    const lo = cap.wordStartIndex;
    const hi = cap.wordEndIndex;
    const b0 = baselineSnaps[0];
    const b1 = baselineSnaps[baselineSnaps.length - 1];
    const oldS = b0.start;
    const oldE = b1.end;
    _qsSyncRestoreWordsFromSnaps(lo, hi, baselineSnaps);
    let newE = oldE + deltaSec;
    newE = Math.max(newE, oldS + QS_LINE_MIN_DUR);
    return _qsRescaleWordsInRange(lo, hi, oldS, oldE, oldS, newE);
}

function _qsSyncApplyLegacyMoveFromBaseline(idx, baseline, deltaSec) {
    const segs = window.currentSegments;
    if (!Array.isArray(segs) || !segs[idx] || !baseline) return false;
    const seg = segs[idx];
    let ns = Math.round((baseline.start + deltaSec) * 1000) / 1000;
    let ne = Math.round((baseline.end + deltaSec) * 1000) / 1000;
    if (ns < 0) {
        const fix = -ns;
        ns += fix;
        ne += fix;
    }
    seg.start = ns;
    seg.end = ne;
    return true;
}

function _qsSyncApplyLegacyStretchStartFromBaseline(idx, baseline, deltaSec) {
    const segs = window.currentSegments;
    if (!Array.isArray(segs) || !segs[idx] || !baseline) return false;
    const seg = segs[idx];
    let ns = Math.round((baseline.start + deltaSec) * 1000) / 1000;
    ns = Math.max(0, Math.min(ns, baseline.end - QS_LINE_MIN_DUR));
    seg.start = ns;
    seg.end = baseline.end;
    return true;
}

function _qsSyncApplyLegacyStretchEndFromBaseline(idx, baseline, deltaSec) {
    const segs = window.currentSegments;
    if (!Array.isArray(segs) || !segs[idx] || !baseline) return false;
    const seg = segs[idx];
    let ne = Math.round((baseline.end + deltaSec) * 1000) / 1000;
    ne = Math.max(ne, baseline.start + QS_LINE_MIN_DUR);
    seg.start = baseline.start;
    seg.end = ne;
    return true;
}

function _qsSyncUpdateOverlapClasses(container) {
    if (!container) return;
    const set = _qsCaptionOverlapIndexSet();
    container.querySelectorAll('.caption-row[data-ci]').forEach((el) => {
        const ci = parseInt(el.getAttribute('data-ci'), 10);
        if (Number.isFinite(ci)) el.classList.toggle('qs-timing-overlap', set.has(ci));
    });
    container.querySelectorAll('.qs-timing-legacy-row[data-timing-idx]').forEach((el) => {
        const idx = parseInt(el.getAttribute('data-timing-idx'), 10);
        if (Number.isFinite(idx)) el.classList.toggle('qs-timing-overlap', set.has(idx));
    });
}

function _qsSyncRefreshWordRowTimesDom(container, ci) {
    const cap = window.currentCaptions && window.currentCaptions[ci];
    const words = window.currentWords;
    if (!cap || !words) return;
    const row = container.querySelector(`.caption-row[data-ci="${ci}"]`);
    if (!row) return;
    const ws = words[cap.wordStartIndex];
    const we = words[cap.wordEndIndex];
    const start = ws ? ws.start : 0;
    const endT = we && typeof we.end === 'number' ? we.end : start;
    row.setAttribute('data-start', String(start));
    row.setAttribute('data-end', String(endT));
    const ts = row.querySelector('.caption-ts');
    if (ts) ts.innerHTML = _qsCaptionTimeRangeHtml(start, endT);
    for (let wi = cap.wordStartIndex; wi <= cap.wordEndIndex; wi++) {
        const tok = row.querySelector(`span.word-token[data-wi="${wi}"]`);
        const ww = words[wi];
        if (tok && ww) {
            const ws0 = ww.start;
            const we0 = ww.end;
            tok.setAttribute('data-start', typeof ws0 === 'number' ? String(ws0) : '');
            tok.setAttribute('data-end', typeof we0 === 'number' ? String(we0) : '');
            const title = (typeof ws0 === 'number' && typeof we0 === 'number') ? `${ws0.toFixed(2)}\u200e \u2192 ${we0.toFixed(2)}` : '';
            tok.setAttribute('title', title);
        }
    }
}

function _qsSyncRefreshLegacyRowDom(container, idx) {
    const cues = window.currentSegments;
    const row = container.querySelector(`.qs-timing-legacy-row[data-timing-idx="${idx}"]`);
    if (!row || !cues || !cues[idx]) return;
    const c = cues[idx];
    const cs = Number(c.start);
    const rawEnd = c.end != null ? Number(c.end) : NaN;
    const nextS = cues[idx + 1] != null ? Number(cues[idx + 1].start) : NaN;
    let endSec = rawEnd;
    if (!Number.isFinite(endSec) || endSec <= cs) {
        endSec = Number.isFinite(nextS) ? nextS : cs + 1;
    }
    const ts = row.querySelector('.qs-sync-legacy-ts');
    if (ts) ts.innerHTML = _qsCaptionTimeRangeHtml(cs, endSec);
}

function initQsSyncDirectManipulation(container) {
    if (typeof container._qsSyncDragCleanup === 'function') {
        try { container._qsSyncDragCleanup(); } catch (_) {}
    }
    container._qsSyncDragCleanup = null;
    if (!window._qsTimingMode || !container) return;

    const useWords = (
        Array.isArray(window.currentWords) &&
        Array.isArray(window.currentCaptions) &&
        window.currentCaptions.length > 0
    );

    let rafPending = false;
    let latestRefreshCi = null;
    const scheduleVisualRefresh = (ci) => {
        latestRefreshCi = ci;
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            const ciRun = latestRefreshCi;
            latestRefreshCi = null;
            if (!window._qsTimingMode || !container.isConnected || ciRun == null) return;
            if (useWords) {
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                _qsSyncRefreshWordRowTimesDom(container, ciRun);
            } else {
                _qsSyncRefreshLegacyRowDom(container, ciRun);
            }
            _qsSyncUpdateOverlapClasses(container);
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
            if (latestRefreshCi != null) scheduleVisualRefresh(latestRefreshCi);
        });
    };

    const onPointerDown = (e) => {
        const handleEl = e.target && e.target.closest && e.target.closest('[data-qs-sync-handle]');
        if (handleEl && container.contains(handleEl)) {
            let ci = parseInt(handleEl.getAttribute('data-ci'), 10);
            if (!Number.isFinite(ci)) ci = parseInt(handleEl.getAttribute('data-timing-idx'), 10);
            if (!Number.isFinite(ci) || ci < 0) return;
            if (useWords && ci >= window.currentCaptions.length) return;
            if (!useWords && (!window.currentSegments || ci >= window.currentSegments.length)) return;

            e.preventDefault();
            e.stopPropagation();

            const handle = handleEl.getAttribute('data-qs-sync-handle');
            const type = handle === 'start' ? 'start' : 'end';
            let baselineSnaps = null;
            let baselineSeg = null;
            if (useWords) {
                const cap = window.currentCaptions[ci];
                baselineSnaps = _qsSyncWordRangeSnaps(cap.wordStartIndex, cap.wordEndIndex);
                if (!baselineSnaps) return;
            } else {
                const seg = window.currentSegments[ci];
                const end = seg.end != null ? seg.end : seg.start + 1;
                baselineSeg = { start: seg.start, end: end };
            }

            const state = {
                ci,
                type,
                startX: e.clientX,
                startY: e.clientY,
                useWords,
                baselineSnaps,
                baselineSeg,
                dragCommitted: true,
                pointerId: e.pointerId,
                captureEl: handleEl,
            };
            const tooltip = _qsSyncEnsureTooltip();

            function detach() {
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                window.removeEventListener('pointercancel', onUp, true);
            }

            function applyDelta(deltaSec) {
                if (useWords) {
                    if (type === 'start') {
                        _qsSyncApplyWordStretchStartFromBaseline(ci, state.baselineSnaps, deltaSec);
                    } else {
                        _qsSyncApplyWordStretchEndFromBaseline(ci, state.baselineSnaps, deltaSec);
                    }
                } else if (type === 'start') {
                    _qsSyncApplyLegacyStretchStartFromBaseline(ci, state.baselineSeg, deltaSec);
                } else {
                    _qsSyncApplyLegacyStretchEndFromBaseline(ci, state.baselineSeg, deltaSec);
                }
                scheduleVisualRefresh(ci);
            }

            function onMove(ev) {
                if (ev.pointerId !== state.pointerId) return;
                const dx = ev.clientX - state.startX;
                const deltaSec = _qsSyncDxToDeltaSec(dx);
                applyDelta(deltaSec);
                _qsUpdateLineTimeDragDeltaLabel(container, ci, 0);
                const sign = deltaSec >= 0 ? '+' : '';
                tooltip.textContent = `${sign}${deltaSec.toFixed(2)}s`;
                tooltip.style.display = 'block';
                tooltip.style.left = `${ev.clientX}px`;
                tooltip.style.top = `${ev.clientY - 36}px`;
            }

            function onUp(ev) {
                if (ev.pointerId !== state.pointerId) return;
                const ciFinal = state.ci;
                detach();
                tooltip.style.display = 'none';
                if (useWords) {
                    window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                    try { renderWordCaptionEditor(); } catch (_) {}
                } else {
                    try { renderLegacyTimingModeTranscript(container); } catch (_) {}
                }
                if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                _qsSeekToCaptionStart(ciFinal);
            }

            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onUp, true);
            try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}
            _qsUpdateLineTimeDragDeltaLabel(container, ci, 0);
            return;
        }

        const lineDragEl = e.target && e.target.closest && e.target.closest('.qs-line-time-drag');
        if (lineDragEl && container.contains(lineDragEl)) {
            let ci = parseInt(lineDragEl.getAttribute('data-ci'), 10);
            if (!Number.isFinite(ci)) ci = parseInt(lineDragEl.getAttribute('data-timing-idx'), 10);
            if (!Number.isFinite(ci) || ci < 0) return;
            if (useWords && ci >= window.currentCaptions.length) return;
            if (!useWords && (!window.currentSegments || ci >= window.currentSegments.length)) return;
            if (ci !== window._qsTimingSelectedCi) return;

            e.preventDefault();
            e.stopPropagation();

            let baselineSnaps = null;
            let baselineSeg = null;
            if (useWords) {
                const cap = window.currentCaptions[ci];
                baselineSnaps = _qsSyncWordRangeSnaps(cap.wordStartIndex, cap.wordEndIndex);
                if (!baselineSnaps) return;
            } else {
                const seg = window.currentSegments[ci];
                const end = seg.end != null ? seg.end : seg.start + 1;
                baselineSeg = { start: seg.start, end: end };
            }

            const state = {
                ci,
                startX: e.clientX,
                useWords,
                baselineSnaps,
                baselineSeg,
                pointerId: e.pointerId,
            };
            const tooltip = _qsSyncEnsureTooltip();

            function detachLine() {
                window.removeEventListener('pointermove', onLineMove, true);
                window.removeEventListener('pointerup', onLineUp, true);
                window.removeEventListener('pointercancel', onLineUp, true);
            }

            function onLineMove(ev) {
                if (ev.pointerId !== state.pointerId) return;
                const dx = ev.clientX - state.startX;
                const deltaSec = _qsSyncDxToDeltaSec(dx);
                if (useWords) {
                    _qsSyncApplyWordMoveFromBaseline(ci, state.baselineSnaps, deltaSec);
                } else {
                    _qsSyncApplyLegacyMoveFromBaseline(ci, state.baselineSeg, deltaSec);
                }
                _qsUpdateLineTimeDragDeltaLabel(container, ci, deltaSec);
                scheduleVisualRefresh(ci);
                tooltip.style.display = 'none';
            }

            function onLineUp(ev) {
                if (ev.pointerId !== state.pointerId) return;
                const ciFinal = state.ci;
                detachLine();
                tooltip.style.display = 'none';
                if (useWords) {
                    window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                    try { renderWordCaptionEditor(); } catch (_) {}
                } else {
                    try { renderLegacyTimingModeTranscript(container); } catch (_) {}
                }
                if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                _qsSeekToCaptionStart(ciFinal);
            }

            window.addEventListener('pointermove', onLineMove, true);
            window.addEventListener('pointerup', onLineUp, true);
            window.addEventListener('pointercancel', onLineUp, true);
            try { lineDragEl.setPointerCapture(e.pointerId); } catch (_) {}
            _qsUpdateLineTimeDragDeltaLabel(container, ci, 0);
            return;
        }

        const row = e.target && e.target.closest && e.target.closest(
            '.caption-row.qs-timing-line-selected, .paragraph-row.qs-timing-legacy-row.qs-timing-line-selected'
        );
        if (!row || !container.contains(row)) return;

        {
            let tn = e.target;
            if (tn && tn.nodeType === Node.TEXT_NODE && tn.parentElement) tn = tn.parentElement;
            if (tn && tn.closest && tn.closest('.qs-line-time-drag')) return;
        }

        // Unified edit + timing: never start line-drag from words or token input — those need native focus / token edit clicks.
        if (container.classList.contains('transcript-editing')) {
            let t = e.target;
            if (t && t.nodeType === Node.TEXT_NODE && t.parentElement) t = t.parentElement;
            if (t && t.closest && (t.closest('.caption-text') || t.closest('input.qs-token-input'))) return;
        }

        let ci = parseInt(row.getAttribute('data-ci'), 10);
        if (!Number.isFinite(ci)) ci = parseInt(row.getAttribute('data-timing-idx'), 10);
        if (!Number.isFinite(ci) || ci < 0 || ci !== window._qsTimingSelectedCi) return;
        if (useWords && ci >= window.currentCaptions.length) return;
        if (!useWords && (!window.currentSegments || ci >= window.currentSegments.length)) return;

        let baselineSnaps = null;
        let baselineSeg = null;
        if (useWords) {
            const cap = window.currentCaptions[ci];
            baselineSnaps = _qsSyncWordRangeSnaps(cap.wordStartIndex, cap.wordEndIndex);
            if (!baselineSnaps) return;
        } else {
            const seg = window.currentSegments[ci];
            const end = seg.end != null ? seg.end : seg.start + 1;
            baselineSeg = { start: seg.start, end: end };
        }

        const state = {
            ci,
            type: 'move',
            startX: e.clientX,
            startY: e.clientY,
            useWords,
            baselineSnaps,
            baselineSeg,
            dragCommitted: false,
            pointerId: e.pointerId,
            captureEl: row,
        };
        const tooltip = _qsSyncEnsureTooltip();

        function detach() {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            window.removeEventListener('pointercancel', onUp, true);
        }

        function applyDelta(deltaSec) {
            if (useWords) {
                _qsSyncApplyWordMoveFromBaseline(ci, state.baselineSnaps, deltaSec);
            } else {
                _qsSyncApplyLegacyMoveFromBaseline(ci, state.baselineSeg, deltaSec);
            }
            _qsUpdateLineTimeDragDeltaLabel(container, ci, deltaSec);
            scheduleVisualRefresh(ci);
        }

        function onMove(ev) {
            if (ev.pointerId !== state.pointerId) return;
            const dx = ev.clientX - state.startX;
            const dy = ev.clientY - state.startY;
            if (!state.dragCommitted) {
                if (Math.hypot(dx, dy) < 10) return;
                if (Math.abs(dy) > Math.abs(dx) * 1.25 && Math.abs(dy) > 12) {
                    detach();
                    tooltip.style.display = 'none';
                    return;
                }
                state.dragCommitted = true;
                try { ev.preventDefault(); } catch (_) {}
                try { row.setPointerCapture(ev.pointerId); } catch (_) {}
            }
            const deltaSec = _qsSyncDxToDeltaSec(dx);
            applyDelta(deltaSec);
            const sign = deltaSec >= 0 ? '+' : '';
            tooltip.textContent = `${sign}${deltaSec.toFixed(2)}s`;
            tooltip.style.display = 'block';
            tooltip.style.left = `${ev.clientX}px`;
            tooltip.style.top = `${ev.clientY - 36}px`;
        }

        function onUp(ev) {
            if (ev.pointerId !== state.pointerId) return;
            const ciFinal = state.ci;
            const committed = state.dragCommitted;
            detach();
            tooltip.style.display = 'none';
            if (!committed) return;
            if (useWords) {
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                try { renderWordCaptionEditor(); } catch (_) {}
            } else {
                try { renderLegacyTimingModeTranscript(container); } catch (_) {}
            }
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
            _qsSeekToCaptionStart(ciFinal);
        }

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
    };

    container.addEventListener('pointerdown', onPointerDown, true);
    container._qsSyncDragCleanup = () => {
        container.removeEventListener('pointerdown', onPointerDown, true);
    };
}

function _qsRescaleWordsInRange(lo, hi, oldS, oldE, newS, newE) {
    const words = window.currentWords;
    if (!words) return false;
    const span = oldE - oldS;
    if (span < 1e-6) {
        const nlen = Math.max(1, hi - lo + 1);
        const slot = Math.max(QS_LINE_MIN_DUR, (newE - newS) / nlen);
        for (let wi = lo; wi <= hi; wi++) {
            const ww = words[wi];
            if (!ww) continue;
            const off = (wi - lo) * slot;
            ww.start = Math.round((newS + off) * 1000) / 1000;
            ww.end = Math.round((newS + off + slot) * 1000) / 1000;
        }
        return true;
    }
    const nspan = newE - newS;
    for (let wi = lo; wi <= hi; wi++) {
        const ww = words[wi];
        if (!ww) return false;
        const rs = (ww.start - oldS) / span;
        const re = (ww.end - oldS) / span;
        ww.start = Math.round((newS + rs * nspan) * 1000) / 1000;
        ww.end = Math.round((newS + re * nspan) * 1000) / 1000;
        if (ww.end < ww.start + QS_LINE_MIN_DUR) {
            ww.end = Math.round((ww.start + QS_LINE_MIN_DUR) * 1000) / 1000;
        }
    }
    return true;
}

function _qsApplyWordCaptionLineShift(ci, deltaSec) {
    const words = window.currentWords;
    const caps = window.currentCaptions;
    const cap = caps && caps[ci];
    if (!cap || !words) return false;
    const d = Math.round(Number(deltaSec) / QS_LINE_TIMING_STEP) * QS_LINE_TIMING_STEP;
    if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return false;
    const lo = cap.wordStartIndex;
    const hi = cap.wordEndIndex;
    for (let wi = lo; wi <= hi; wi++) {
        const ww = words[wi];
        if (!ww) continue;
        ww.start = Math.round((ww.start + d) * 1000) / 1000;
        ww.end = Math.round((ww.end + d) * 1000) / 1000;
    }
    let minS = Infinity;
    for (let wi = lo; wi <= hi; wi++) {
        const ww = words[wi];
        if (ww && Number.isFinite(ww.start)) minS = Math.min(minS, ww.start);
    }
    if (minS < 0) {
        const fix = -minS;
        for (let wi = lo; wi <= hi; wi++) {
            const ww = words[wi];
            if (!ww) continue;
            ww.start = Math.round((ww.start + fix) * 1000) / 1000;
            ww.end = Math.round((ww.end + fix) * 1000) / 1000;
        }
    }
    return true;
}

function _qsApplyWordCaptionStretchStart(ci, deltaSec) {
    const words = window.currentWords;
    const caps = window.currentCaptions;
    const cap = caps && caps[ci];
    if (!cap || !words) return false;
    const lo = cap.wordStartIndex;
    const hi = cap.wordEndIndex;
    const first = words[lo];
    const last = words[hi];
    if (!first || !last) return false;
    const oldS = first.start;
    const oldE = last.end;
    const d = Math.round(Number(deltaSec) / QS_LINE_TIMING_STEP) * QS_LINE_TIMING_STEP;
    if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return false;
    let newS = oldS + d;
    newS = Math.min(newS, oldE - QS_LINE_MIN_DUR);
    newS = Math.max(0, newS);
    if (Math.abs(newS - oldS) < 1e-6) return false;
    return _qsRescaleWordsInRange(lo, hi, oldS, oldE, newS, oldE);
}

function _qsApplyWordCaptionStretchEnd(ci, deltaSec) {
    const words = window.currentWords;
    const caps = window.currentCaptions;
    const cap = caps && caps[ci];
    if (!cap || !words) return false;
    const lo = cap.wordStartIndex;
    const hi = cap.wordEndIndex;
    const first = words[lo];
    const last = words[hi];
    if (!first || !last) return false;
    const oldS = first.start;
    const oldE = last.end;
    const d = Math.round(Number(deltaSec) / QS_LINE_TIMING_STEP) * QS_LINE_TIMING_STEP;
    if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return false;
    let newE = oldE + d;
    newE = Math.max(newE, oldS + QS_LINE_MIN_DUR);
    if (Math.abs(newE - oldE) < 1e-6) return false;
    return _qsRescaleWordsInRange(lo, hi, oldS, oldE, oldS, newE);
}

function _qsApplyLegacyLineShift(idx, deltaSec) {
    const segs = window.currentSegments;
    if (!Array.isArray(segs) || !segs[idx]) return false;
    const d = Math.round(Number(deltaSec) / QS_LINE_TIMING_STEP) * QS_LINE_TIMING_STEP;
    if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return false;
    const seg = segs[idx];
    let ns = Math.round((seg.start + d) * 1000) / 1000;
    let ne = Math.round(((seg.end != null ? seg.end : seg.start + 1) + d) * 1000) / 1000;
    if (ns < 0) {
        const fix = -ns;
        ns += fix;
        ne += fix;
    }
    seg.start = ns;
    seg.end = ne;
    return true;
}

function _qsApplyLegacyStretchStart(idx, deltaSec) {
    const segs = window.currentSegments;
    if (!Array.isArray(segs) || !segs[idx]) return false;
    const seg = segs[idx];
    const d = Math.round(Number(deltaSec) / QS_LINE_TIMING_STEP) * QS_LINE_TIMING_STEP;
    if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return false;
    const end = seg.end != null ? seg.end : seg.start + 1;
    let ns = Math.round((seg.start + d) * 1000) / 1000;
    ns = Math.max(0, Math.min(ns, end - QS_LINE_MIN_DUR));
    if (Math.abs(ns - seg.start) < 1e-6) return false;
    seg.start = ns;
    if (seg.end != null && seg.end - seg.start < QS_LINE_MIN_DUR) seg.end = seg.start + QS_LINE_MIN_DUR;
    return true;
}

function _qsApplyLegacyStretchEnd(idx, deltaSec) {
    const segs = window.currentSegments;
    if (!Array.isArray(segs) || !segs[idx]) return false;
    const seg = segs[idx];
    const d = Math.round(Number(deltaSec) / QS_LINE_TIMING_STEP) * QS_LINE_TIMING_STEP;
    if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return false;
    const end = seg.end != null ? seg.end : seg.start + 1;
    let ne = Math.round((end + d) * 1000) / 1000;
    ne = Math.max(ne, seg.start + QS_LINE_MIN_DUR);
    if (Math.abs(ne - end) < 1e-6) return false;
    seg.end = ne;
    return true;
}

function renderLegacyTimingModeTranscript(container) {
    if (!container || !window._qsTimingMode) return;
    const cues = window.currentSegments || [];
    if (!cues.length) return;
    const locale = String(window.currentLocale || localStorage.getItem('locale') || 'he').toLowerCase();
    const isRtl = locale.startsWith('he') || locale.startsWith('ar');
    const textDirection = isRtl ? 'rtl' : 'ltr';
    const textAlign = isRtl ? 'right' : 'left';
    container.classList.toggle('qs-rtl', !!isRtl);
    const overlap = _qsCaptionOverlapIndexSet();
    const sel = window._qsTimingSelectedCi;
    const html = cues.map((c, idx) => {
        const mainText = String(c.translated_text || c.text || '').trim();
        const safe = mainText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const ov = overlap.has(idx) ? ' qs-timing-overlap' : '';
        const sl = idx === sel ? ' qs-timing-line-selected' : '';
        const cs = Number(c.start);
        const rawEnd = c.end != null ? Number(c.end) : NaN;
        const nextS = cues[idx + 1] != null ? Number(cues[idx + 1].start) : NaN;
        let endSec = rawEnd;
        if (!Number.isFinite(endSec) || endSec <= cs) {
            endSec = Number.isFinite(nextS) ? nextS : cs + 1;
        }
        const timeLine = _qsCaptionTimeRangeHtml(cs, endSec);
        if (idx === sel) {
            const legacyLineDrag = `
                <div class="qs-line-time-drag-wrap">
                    <button type="button" class="qs-line-time-drag" data-timing-idx="${idx}" aria-label="גרור להזיז את כל השורה בזמן">
                        <span class="qs-line-time-drag__track" aria-hidden="true"></span>
                        <span class="qs-line-time-drag__inner" dir="ltr">
                            <span class="qs-line-time-drag__sign">+</span><span class="qs-line-time-drag__value">0.00s</span>
                        </span>
                    </button>
                </div>`;
            return `
        <div class="paragraph-row qs-timing-legacy-row qs-sync-legacy-selected${ov}${sl}" data-timing-idx="${idx}" id="seg-${Math.floor(c.start)}" style="display:flex; flex-direction:row; align-items:center; gap:16px; margin-bottom: 0.1em; direction: ${textDirection}; text-align: ${textAlign};">
            <button type="button" class="qs-sync-handle qs-sync-handle--start" data-timing-idx="${idx}" data-qs-sync-handle="start" aria-label="גרור לשינוי זמן התחלה"></button>
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; align-items:stretch;">
                <div class="qs-sync-legacy-ts segment-timestamps">${timeLine}</div>
                <div class="qs-sync-text-stack">
                    <div class="qs-sync-legacy-text-row" style="display:flex; flex-direction:row; align-items:center; width:100%; max-width:100%; min-width:0;">
                        <div class="segment-content-wrapper">
                            <p data-idx="${idx}" style="margin:0 !important; line-height:1.2; white-space:pre-wrap; flex:1; min-width:0;">${safe}</p>
                        </div>
                        <button type="button" class="qs-sync-handle qs-sync-handle--end" data-timing-idx="${idx}" data-qs-sync-handle="end" aria-label="גרור לשינוי זמן הסיום"></button>
                    </div>
                    ${legacyLineDrag}
                </div>
            </div>
        </div>`;
        }
        return `
        <div class="paragraph-row qs-timing-legacy-row${ov}${sl}" data-timing-idx="${idx}" id="seg-${Math.floor(c.start)}" style="display:block; margin-bottom: 0.1em; direction: ${textDirection}; text-align: ${textAlign};">
            <div class="qs-sync-legacy-ts segment-timestamps">${timeLine}</div>
            <div class="segment-content-wrapper">
              <p data-idx="${idx}" style="margin:0 !important; line-height:1.2; white-space:pre-wrap; flex:1; min-width:0;">${safe}</p>
            </div>
        </div>`;
    }).join('');
    container.innerHTML = html;
    container.style.direction = textDirection;
    container.style.textAlign = textAlign;
    container.contentEditable = 'false';
    container.classList.add('transcript-sync-mode');
    container.onclick = (e) => {
        let t = e.target;
        if (t && t.nodeType === Node.TEXT_NODE && t.parentElement) t = t.parentElement;
        if (!t || !t.closest) return;
        if (t.closest('button, a, input, textarea, select, [role="button"], [data-qs-sync-handle]')) return;
        const row = t.closest('.qs-timing-legacy-row');
        if (!row) return;
        const idx = parseInt(row.getAttribute('data-timing-idx'), 10);
        if (!Number.isFinite(idx)) return;
        window._qsTimingSelectedCi = idx;
        _qsSeekToCaptionStart(idx);
        renderLegacyTimingModeTranscript(container);
    };
    try { initQsSyncDirectManipulation(container); } catch (_) {}
}

function _setCaretToWordIndex(container, wordIndex, atStart = true) {
    const el = container.querySelector(`span.word-token[data-wi="${wordIndex}"]`);
    if (!el) return;
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(!!atStart);
    sel.removeAllRanges();
    sel.addRange(range);
    try { el.focus(); } catch (_) {}
}

/**
 * Insert new timed words immediately after insertAfterWi (same caption line).
 * Does not overwrite following tokens — shifts word indices for this and later captions.
 */
function _qsInsertWordTextsAfterIndex(insertAfterWi, texts) {
    if (!Array.isArray(texts) || texts.length === 0) return 0;
    const w = window.currentWords;
    const caps = window.currentCaptions;
    if (!Array.isArray(w) || !w[insertAfterWi] || !Array.isArray(caps)) return 0;

    const capIndex = caps.findIndex((c) => insertAfterWi >= c.wordStartIndex && insertAfterWi <= c.wordEndIndex);
    const cap = capIndex >= 0 ? caps[capIndex] : null;
    const n = texts.length;
    const left = w[insertAfterWi];
    const rightWi = insertAfterWi + 1;
    const right = w[rightWi] || null;

    const MIN = 0.05;
    let tL = _asTranscriptTime(left.end);
    if (!Number.isFinite(tL)) tL = _asTranscriptTime(left.start);
    if (!Number.isFinite(tL)) tL = 0;
    let tR = right ? _asTranscriptTime(right.start) : NaN;
    if (!Number.isFinite(tR)) tR = tL + MIN * (n + 2);

    let available = tR - tL;
    if (available < MIN * n) {
        tR = tL + MIN * (n + 1);
        if (right) {
            const push = tR + MIN - _asTranscriptTime(right.start);
            if (push > 0) {
                for (let j = rightWi; j < w.length; j++) {
                    const ww = w[j];
                    if (!ww) continue;
                    ww.start = Math.round((_asTranscriptTime(ww.start) + push) * 1000) / 1000;
                    ww.end = Math.round((_asTranscriptTime(ww.end) + push) * 1000) / 1000;
                }
            }
            tR = _asTranscriptTime(w[rightWi].start);
        }
        available = Math.max(MIN * n, tR - tL);
    }

    const dur = Math.max(MIN, available / (n + 1));
    const newWords = [];
    let s = tL;
    for (let i = 0; i < n; i++) {
        const e = Math.round((s + dur) * 1000) / 1000;
        newWords.push({
            id: `w${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
            text: String(texts[i] || '').trim(),
            start: Math.round(s * 1000) / 1000,
            end: e,
            highlighted: false
        });
        s = e;
    }

    w.splice(insertAfterWi + 1, 0, ...newWords);

    if (cap) {
        cap.wordEndIndex += n;
        for (let ci = capIndex + 1; ci < caps.length; ci++) {
            caps[ci].wordStartIndex += n;
            caps[ci].wordEndIndex += n;
        }
    } else {
        for (let ci = 0; ci < caps.length; ci++) {
            const c = caps[ci];
            if (c.wordStartIndex > insertAfterWi) {
                c.wordStartIndex += n;
                c.wordEndIndex += n;
            } else if (c.wordEndIndex > insertAfterWi) {
                c.wordEndIndex += n;
            }
        }
    }
    return n;
}

function reflowCaptionsByMaxChars(words, captions, maxChars = 54) {
    // Re-split captions using ONLY word boundaries (no timing estimation).
    if (!Array.isArray(words) || !Array.isArray(captions) || captions.length === 0) return captions;
    const out = [];
    for (let ci = 0; ci < captions.length; ci++) {
        const cap = captions[ci];
        let start = cap.wordStartIndex;
        let line = '';
        for (let wi = cap.wordStartIndex; wi <= cap.wordEndIndex; wi++) {
            const w = words[wi];
            const t = (w && w.text != null) ? String(w.text).trim() : '';
            if (!t) continue;
            const next = line ? (line + ' ' + t) : t;
            if (line && next.length > maxChars) {
                // close current caption at previous word
                const end = wi - 1;
                if (end >= start) out.push({ id: `c${Date.now()}_${out.length}`, wordStartIndex: start, wordEndIndex: end, style: cap.style ? { ...cap.style } : undefined });
                start = wi;
                line = t;
            } else {
                line = next;
            }
        }
        if (cap.wordEndIndex >= start) out.push({ id: cap.id || `c${Date.now()}_${out.length}`, wordStartIndex: start, wordEndIndex: cap.wordEndIndex, style: cap.style ? { ...cap.style } : undefined });
    }
    return out;
}

function _closestWordIndexFromSelection(container) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.anchorNode;
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentElement; // text -> element
    const token = node && node.closest ? node.closest('span.word-token[data-wi]') : null;
    if (token) {
        const wi = parseInt(token.getAttribute('data-wi'), 10);
        return Number.isFinite(wi) ? wi : null;
    }
    // caret may be in caption-text between tokens
    const captionText = node && node.closest ? node.closest('.caption-text') : null;
    if (!captionText) return null;
    // Find nearest token before caret
    const r = sel.getRangeAt(0);
    const walker = document.createTreeWalker(captionText, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (n) => (n.tagName === 'SPAN' && n.classList.contains('word-token')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    let last = null;
    while (walker.nextNode()) {
        const el = walker.currentNode;
        // If caret is before this token, stop
        try {
            const rr = document.createRange();
            rr.selectNode(el);
            if (r.compareBoundaryPoints(Range.START_TO_START, rr) < 0) break;
        } catch (_) {}
        last = el;
    }
    if (!last) return null;
    const wi = parseInt(last.getAttribute('data-wi'), 10);
    return Number.isFinite(wi) ? wi : null;
}

function renderWordCaptionEditor() {
    const container = document.getElementById('transcript-window');
    if (!container) return;
    const words = window.currentWords;
    const captions = window.currentCaptions;
    _normalizeWordsCaptionsModel(words, captions);
    // Highlight feature removed: clear any existing flags.
    if (Array.isArray(words)) {
        for (const w of words) {
            if (w && typeof w === 'object') w.highlighted = false;
        }
    }
    if (!Array.isArray(words) || !Array.isArray(captions) || captions.length === 0) {
        if (window._qsTimingMode && Array.isArray(window.currentSegments) && window.currentSegments.length) {
            renderLegacyTimingModeTranscript(container);
            return;
        }
        renderTranscriptFromCues(window.currentSegments || []);
        return;
    }

    const locale = String(window.currentLocale || localStorage.getItem('locale') || 'he').toLowerCase();
    const isRtl = locale.startsWith('he') || locale.startsWith('ar');
    const textDirection = isRtl ? 'rtl' : 'ltr';
    const textAlign = isRtl ? 'right' : 'left';
    const isEditing = container.classList.contains('transcript-editing');
    const timingMode = !!window._qsTimingMode;
    container.classList.toggle('qs-rtl', !!isRtl);

    // Document ("מסמך") layout is handled by rerenderTranscriptView → window.render when not editing/syncing.

    function syncInlineStylePanel(ci) {
        if (!Number.isFinite(ci)) return;
        const panel = container.querySelector(`.qs-inline-style-panel[data-ci="${ci}"]`);
        if (!panel || typeof window.getResolvedCaptionStyle !== 'function') return;
        const st = window.getResolvedCaptionStyle(ci);
        panel.querySelectorAll('.qs-pos-seg .qs-inline-seg-btn').forEach(b => {
            b.classList.toggle('is-selected', b.getAttribute('data-pos') === st.position);
        });
    }

    const overlapSet = _qsCaptionOverlapIndexSet();
    let timingSel = window._qsTimingSelectedCi;
    if (!Number.isFinite(timingSel) || timingSel < 0 || timingSel >= captions.length) {
        timingSel = 0;
        window._qsTimingSelectedCi = 0;
    }
    const rows = captions.map((cap, ci) => {
        const ws = words[cap.wordStartIndex];
        const we = words[cap.wordEndIndex];
        const start = ws ? ws.start : 0;
        const endT = we && typeof we.end === 'number' ? we.end : start;
        const tokenHtml = words
            .slice(cap.wordStartIndex, cap.wordEndIndex + 1)
            .map((w, k) => {
                const wi = cap.wordStartIndex + k;
                const raw = String(w.text || '');
                const safe = raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const isEmpty = safe.trim().length === 0;
                const display = isEmpty ? '&nbsp;' : safe;
                const wStart = (w && typeof w.start === 'number') ? w.start : '';
                const wEnd = (w && typeof w.end === 'number') ? w.end : '';
                const title = (typeof wStart === 'number' && typeof wEnd === 'number') ? `${wStart.toFixed(2)}\u200e \u2192 ${wEnd.toFixed(2)}` : '';
                const hl = w && w.highlighted ? '1' : '0';
                const tokTab = timingMode ? '-1' : '0';
                return `<span class="word-token" contenteditable="false" tabindex="${tokTab}" data-wi="${wi}" data-highlighted="${hl}" data-empty="${isEmpty ? '1' : '0'}" data-start="${wStart}" data-end="${wEnd}" title="${title}" style="display:inline-block; min-width:0.8ch;">${display}</span>`;
            })
            .join(' ');
        const posLabelMap = { bottom: 'תחתון', middle: 'אמצע', top: 'עליון' };
        const posSeg = ['bottom', 'middle', 'top'].map(p =>
            `<button type="button" class="qs-inline-seg-btn" data-pos="${p}">${posLabelMap[p] || p}</button>`
        ).join('');
        const styleTooltip = 'עיצוב שורה. גררו כדי לבחור כמה שורות.';
        const lineTimeDragChip = (timingMode && ci === timingSel) ? `
            <div class="qs-line-time-drag-wrap">
                <button type="button" class="qs-line-time-drag" data-ci="${ci}" aria-label="גרור להזיז את כל השורה בזמן">
                    <span class="qs-line-time-drag__track" aria-hidden="true"></span>
                    <span class="qs-line-time-drag__inner" dir="ltr">
                        <span class="qs-line-time-drag__sign">+</span><span class="qs-line-time-drag__value">0.00s</span>
                    </span>
                </button>
            </div>` : '';
        const toolbarHtml = isEditing ? `
            <div class="qs-caption-toolbar" style="display:flex;align-items:center;gap:6px;flex-shrink:0;opacity:0;transition:opacity .12s ease;">
              <button type="button" class="qs-style-btn" data-ci="${ci}" title="${styleTooltip}" aria-label="${styleTooltip}">🎨</button>
            </div>` : '';
        const panelHtml = isEditing ? `
            <div class="qs-inline-style-panel" data-ci="${ci}" style="display:none;width:100%;padding:10px 12px;border-radius:10px;background:#f9fafb;border:1px solid #e5e7eb;margin-top:6px;box-sizing:border-box;">
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                <span style="font-size:11px;color:#6b7280;width:64px;">מיקום</span>
                <div class="qs-inline-seg qs-pos-seg" data-ci="${ci}" style="display:flex;gap:4px;flex-wrap:wrap;">${posSeg}</div>
              </div>
            </div>` : '';
        const rowExtraClass = (timingMode && overlapSet.has(ci)) ? ' qs-timing-overlap' : '';
        const rowSelClass = (timingMode && ci === timingSel) ? ' qs-timing-line-selected' : '';
        const tsLine = timingMode
            ? _qsCaptionTimeRangeHtml(start, endT)
            : formatTime(start);
        const bodyBlock = (timingMode && ci === timingSel)
            ? `
              <div class="caption-row-body qs-sync-caption-body" style="display:flex; align-items:center; margin-top:0; width:100%; min-width:0;">
                ${toolbarHtml}
                <div class="segment-content-wrapper segment-content-wrapper--sync-text">
                  <div class="caption-text" ${isEditing ? 'contenteditable="true" spellcheck="false"' : 'contenteditable="false" spellcheck="false"'} style="margin:0 !important; padding:0; line-height:1.2; flex:1; min-width:0; direction:${textDirection}; text-align:${textAlign};">${tokenHtml}</div>
                </div>
              </div>`
            : `
              <div class="caption-row-body" style="display:flex; align-items:center; margin-top:0; width:100%; min-width:0;">
                <div class="segment-content-wrapper">
                  <div class="caption-text" ${isEditing ? 'contenteditable="true" spellcheck="false"' : ''} style="margin:0 !important; padding:0; line-height:1.2; flex:1; min-width:0;">${tokenHtml}</div>
                  ${(!timingMode && isEditing) ? '' : toolbarHtml}
                </div>
              </div>`;
        const tsBlock = `<div class="caption-ts segment-timestamps">${tsLine}</div>`;
        const captionMainHeader = (!timingMode && isEditing)
            ? `<div class="caption-row-ts-toolbar-row" dir="ltr">${toolbarHtml}${tsBlock}</div>`
            : tsBlock;
        const syncFlex = (timingMode && ci === timingSel)
            ? `<div class="qs-sync-row-flex" style="display:flex; flex-direction:row; align-items:center; gap:16px; width:100%;">
            <button type="button" class="qs-sync-handle qs-sync-handle--start" data-ci="${ci}" data-qs-sync-handle="start" aria-label="גרור לשינוי זמן התחלה"></button>
            <div class="qs-sync-row-core" style="flex:1; min-width:0; display:flex; flex-direction:column; gap:0; align-items:stretch;">
              ${tsBlock}<div class="qs-sync-text-stack">${bodyBlock}${lineTimeDragChip}</div>
            </div>
            <button type="button" class="qs-sync-handle qs-sync-handle--end" data-ci="${ci}" data-qs-sync-handle="end" aria-label="גרור לשינוי זמן הסיום"></button>
          </div>`
            : `<div class="caption-row-main" style="display:flex; flex-direction:column; gap:0; align-items:stretch;">
              ${captionMainHeader}${bodyBlock}
            </div>`;
        return `
          <div class="caption-row${rowExtraClass}${rowSelClass}" data-ci="${ci}" data-start="${start}" data-end="${endT}" style="margin-bottom:2px; direction:${textDirection}; text-align:${textAlign}; display:flex; flex-direction:column; align-items:stretch;">
            ${syncFlex}
            ${panelHtml}
          </div>
        `;
    }).join('');

    container.innerHTML = rows;

    container.style.direction = textDirection;
    container.style.textAlign = textAlign;
    container.contentEditable = 'false';

    // Base styles for word editor (non-debug)
    (function ensureWordEditorBaseStyles() {
        if (document.getElementById('qs-word-editor-base-style')) return;
        const st = document.createElement('style');
        st.id = 'qs-word-editor-base-style';
        st.textContent = `
          #transcript-window .word-token.editing {
            outline: none;
            background: transparent;
            border-radius: 0;
          }
          #transcript-window .caption-row {
            transition: background-color 150ms ease;
            margin-bottom: 2px !important;
          }
          #transcript-window .caption-row-main {
            display: grid !important;
            grid-template-rows: auto auto;
            row-gap: 0 !important;
          }
          #transcript-window .caption-row-ts-toolbar-row {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 12px;
            width: 100%;
            box-sizing: border-box;
            padding: 0 16px;
            margin: 0 0 6px 0;
          }
          #transcript-window .caption-row-ts-toolbar-row .caption-ts.segment-timestamps {
            margin-bottom: 0 !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
            flex: 1;
            min-width: 0;
          }
          #transcript-window .caption-ts {
            margin: 0 !important;
            padding: 0 !important;
            line-height: 1 !important;
          }
          #transcript-window .caption-ts.segment-timestamps,
          #transcript-window .qs-sync-legacy-ts.segment-timestamps,
          #transcript-window .segment-timestamps {
            color: #64748b;
            font-size: 0.85rem;
            margin: 0 0 6px 0 !important;
            padding: 0 16px !important;
            box-sizing: border-box;
            line-height: 1.15 !important;
            display: block;
          }
          #transcript-window .segment-content-wrapper {
            padding: 0 16px;
            display: flex;
            align-items: center;
            gap: 12px;
            flex: 1;
            min-width: 0;
            width: 100%;
            box-sizing: border-box;
          }
          #transcript-window .qs-sync-legacy-text-row .segment-content-wrapper {
            width: auto;
          }
          #transcript-window .caption-row-body.qs-sync-caption-body {
            direction: ltr;
            gap: 0;
          }
          #transcript-window .caption-row-body.qs-sync-caption-body .qs-caption-toolbar {
            margin-right: 10px;
          }
          #transcript-window .caption-row-body.qs-sync-caption-body .qs-sync-handle--end {
            margin-right: 4px;
            flex-shrink: 0;
          }
          #transcript-window .segment-content-wrapper.segment-content-wrapper--sync-text {
            padding: 0 16px 0 0;
            gap: 0;
            flex: 1;
            min-width: 0;
            width: auto;
          }
          #transcript-window .caption-row-body {
            margin-top: 0 !important;
            padding-top: 0 !important;
            align-items: center !important;
          }
          #transcript-window .qs-caption-toolbar {
            margin: 0;
            padding: 0;
            flex-shrink: 0;
          }
          #transcript-window .caption-text {
            margin: 0 !important;
            padding: 0 !important;
            line-height: 1.2 !important;
          }
          #transcript-window .caption-text .word-token {
            line-height: 1.2 !important;
            vertical-align: top !important;
          }
          #transcript-window.transcript-editing .caption-ts {
            cursor: pointer;
          }
          #transcript-window.transcript-editing .caption-row:hover {
            background: rgba(0,0,0,0.03);
            border-radius: 10px;
          }
          #transcript-window.transcript-editing .caption-row:hover .qs-caption-toolbar,
          #transcript-window.transcript-editing .caption-row.qs-line-selected .qs-caption-toolbar,
          #transcript-window.transcript-sync-mode .caption-row.qs-timing-line-selected .qs-caption-toolbar {
            opacity: 1 !important;
          }
          #transcript-window.transcript-editing .caption-row.qs-line-selected {
            background: rgba(0,0,0,0.08) !important;
            border-radius: 10px;
          }
          /* Keep timestamps visible by default; hide only when time toggle is OFF. */
          #transcript-window.hide-time .caption-ts {
            display: none !important;
          }
          #transcript-window .qs-inline-seg-btn {
            font-size: 11px;
            padding: 4px 10px;
            border-radius: 8px;
            border: 1px solid #e5e7eb;
            background: #fff;
            cursor: pointer;
            color: #374151;
          }
          #transcript-window .qs-inline-seg-btn.is-selected {
            background: #1e3a8a;
            color: #fff;
            border-color: #1e3a8a;
          }
          #transcript-window .word-token[data-highlighted="1"] {
            background: rgba(245, 158, 11, 0.28);
            color: #111827;
            box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.9);
            border-radius: 4px;
          }
          /* Stronger, obvious handle highlight */
          #transcript-window .caption-row.qs-handle-start { box-shadow: inset 8px 0 0 rgba(59,130,246,0.95); background: rgba(59,130,246,0.10); border-radius: 10px; padding-left:6px; }
          #transcript-window .caption-row.qs-handle-end { box-shadow: inset -8px 0 0 rgba(59,130,246,0.95); background: rgba(59,130,246,0.10); border-radius: 10px; padding-right:6px; }
          #transcript-window .word-token.qs-handle-start { box-shadow: inset 0 0 0 2px rgba(59,130,246,0.95), inset 6px 0 0 rgba(59,130,246,0.95); border-radius: 6px; background: rgba(59,130,246,0.12); }
          #transcript-window .word-token.qs-handle-end { box-shadow: inset 0 0 0 2px rgba(59,130,246,0.95), inset -6px 0 0 rgba(59,130,246,0.95); border-radius: 6px; background: rgba(59,130,246,0.12); }
          /* RTL visual correction: swap which physical side is highlighted. */
          #transcript-window.qs-rtl .word-token.qs-handle-start { box-shadow: inset 0 0 0 2px rgba(59,130,246,0.95), inset -6px 0 0 rgba(59,130,246,0.95); border-radius: 6px; background: rgba(59,130,246,0.12); }
          #transcript-window.qs-rtl .word-token.qs-handle-end { box-shadow: inset 0 0 0 2px rgba(59,130,246,0.95), inset 6px 0 0 rgba(59,130,246,0.95); border-radius: 6px; background: rgba(59,130,246,0.12); }
          #transcript-window .caption-row.qs-sel-caption { background: rgba(0,0,0,0.08) !important; border-radius: 10px; padding: 1px 0; }
          #transcript-window[data-multi-select="1"] .caption-row.qs-line-selected,
          #transcript-window[data-multi-select="1"] .caption-row.qs-sel-caption {
            background: rgba(0,0,0,0.08) !important;
          }
          #transcript-window[data-select-all="1"] .caption-row.qs-line-selected,
          #transcript-window[data-select-all="1"] .caption-row.qs-sel-caption {
            background: rgba(107,114,128,0.22) !important;
          }
          .qs-boundary-pipe {
            display: inline-block;
            padding: 0 6px;
            color: rgba(59,130,246,0.95);
            font-weight: 700;
            user-select: none;
            pointer-events: none;
            text-shadow: 0 0 0 rgba(59,130,246,0.4);
          }
          #transcript-window .qs-line-time-drag-wrap {
            display: flex;
            justify-content: center;
            margin-top: 0;
            padding-bottom: 0;
          }
          #transcript-window .qs-line-time-drag {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            padding: 3px 12px;
            min-width: 5.75rem;
            min-height: 1.35rem;
            border: none;
            background: transparent;
            cursor: grab;
            touch-action: none;
            -webkit-user-select: none;
            user-select: none;
            font: inherit;
            line-height: 1.15;
          }
          #transcript-window .qs-line-time-drag:active { cursor: grabbing; }
          #transcript-window .qs-line-time-drag__track {
            position: absolute;
            left: 4px;
            right: 4px;
            top: 50%;
            height: 1px;
            margin-top: -0.5px;
            background: #94a3b8;
            pointer-events: none;
            opacity: 0.85;
          }
          #transcript-window .qs-line-time-drag__track::before {
            content: '';
            position: absolute;
            left: -4px;
            top: 100%;
            margin-top: -1px;
            border-style: solid;
            border-width: 3px 5px 3px 0;
            border-color: transparent #94a3b8 transparent transparent;
          }
          #transcript-window .qs-line-time-drag__track::after {
            content: '';
            position: absolute;
            right: -4px;
            top: 100%;
            margin-top: -1px;
            border-style: solid;
            border-width: 3px 0 3px 5px;
            border-color: transparent transparent transparent #94a3b8;
          }
          #transcript-window .qs-line-time-drag__inner {
            position: relative;
            z-index: 1;
            display: inline-flex;
            align-items: baseline;
            gap: 2px;
            padding: 0 5px;
            margin: 0;
            background: rgba(255,255,255,0.88);
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            font-variant-numeric: tabular-nums;
            letter-spacing: 0.02em;
            box-shadow: 0 0 0 1px rgba(148,163,184,0.25);
          }
          #transcript-window .qs-line-time-drag__sign {
            font-weight: 700;
            color: #64748b;
            flex: 0 0 auto;
          }
          #transcript-window .qs-line-time-drag__value {
            color: #475569;
            flex: 0 0 auto;
          }
          #transcript-window .qs-style-btn {
            width: 34px;
            height: 30px;
            border: none;
            background: rgba(255,255,255,0.95);
            border-radius: 10px;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            box-shadow: 0 4px 14px rgba(0,0,0,0.08);
            padding: 0;
          }
          #transcript-window .qs-global-style-wrap {
            margin-bottom: 10px;
            padding: 6px 0 2px 0;
            border-bottom: 1px solid rgba(229,231,235,0.9);
            display: flex;
            flex-direction: column;
            align-items: flex-end !important;
            text-align: right;
            direction: rtl;
            width: 100%;
          }
          #transcript-window .qs-select-all-label {
            display: inline-flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            font-size: 12px;
            color: #374151;
            user-select: none;
            cursor: pointer;
            direction: rtl;
            width: auto;
            align-self: flex-end !important;
            margin: 0;
          }
          #transcript-window .qs-select-all-checkbox {
            width: 14px;
            height: 14px;
            margin: 0;
            accent-color: #1e3a8a;
          }
          #transcript-window .qs-global-style-panel {
            margin-top: 8px;
            width: 100%;
            padding: 10px 12px;
            border-radius: 10px;
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            box-sizing: border-box;
          }
          #transcript-window[data-multi-select="1"] .caption-row.qs-line-selected .qs-style-btn {
            display: none;
          }
          #transcript-window[data-multi-select="1"] .caption-row.qs-line-selected.qs-multi-lead .qs-style-btn {
            display: inline-block;
          }
          #transcript-window[data-multi-select="1"] .caption-row.qs-line-selected .qs-line-time-drag-wrap {
            display: none;
          }
          #transcript-window[data-multi-select="1"] .caption-row.qs-line-selected.qs-multi-lead .qs-line-time-drag-wrap {
            display: flex;
          }
          #qs-nudge-feedback-live {
            position: absolute;
            left: 12px;
            top: 0;
            z-index: 9999;
            display: none !important;
            pointer-events: none;
            font-size: 12px;
            color: #111827;
            background: rgba(255,255,255,0.96);
            border: 1px solid rgba(209,213,219,0.9);
            border-radius: 8px;
            padding: 2px 10px;
            white-space: nowrap;
            opacity: 0.98;
            max-width: 260px;
            overflow: hidden;
            text-overflow: ellipsis;
            box-shadow: 0 8px 22px rgba(0,0,0,0.06);
          }

          /* Temporary visual pulse so users see that a nudge happened */
          @keyframes qsHandleFlash {
            0% { box-shadow: 0 0 0 0 rgba(250,204,21,0); }
            30% { box-shadow: 0 0 0 4px rgba(250,204,21,0.55); }
            100% { box-shadow: 0 0 0 0 rgba(250,204,21,0); }
          }
          .qs-handle-flash {
            animation: qsHandleFlash 280ms ease-out;
          }
        `;
        document.head.appendChild(st);
    })();

    // Debug helpers: set window.DEBUG_WORD_EDITOR = true in console.
    (function ensureWordEditorDebugStyles() {
        if (!window.DEBUG_WORD_EDITOR) return;
        if (document.getElementById('qs-word-editor-debug-style')) return;
        const st = document.createElement('style');
        st.id = 'qs-word-editor-debug-style';
        st.textContent = `
          #transcript-window.qs-word-editor-debug .caption-row { outline: 1px dashed rgba(59,130,246,0.6); }
          #transcript-window.qs-word-editor-debug .word-token { outline: 1px solid rgba(239,68,68,0.6); padding: 0 2px; margin: 0 1px; border-radius: 3px; }
          #transcript-window.qs-word-editor-debug .word-token::after { content: attr(data-wi); font-size: 10px; color: rgba(239,68,68,0.8); margin-left: 4px; }
        `;
        document.head.appendChild(st);
    })();
    if (window.DEBUG_WORD_EDITOR) container.classList.add('qs-word-editor-debug');
    else container.classList.remove('qs-word-editor-debug');

    // Avoid accumulating handlers across re-renders.
    container.onclick = null;
    container.onbeforeinput = null;
    if (container._qsSelectionChangeHandler) {
        document.removeEventListener('selectionchange', container._qsSelectionChangeHandler);
        container._qsSelectionChangeHandler = null;
    }

    // Jump-to-time on row click (avoid interfering with word editing).
    // Use live class / timing flags here — not closure values — so save/cancel updates apply even if this handler was not re-assigned.
    container.onclick = (e) => {
        let t = e.target;
        if (t && t.nodeType === Node.TEXT_NODE && t.parentElement) t = t.parentElement;
        if (!t || !t.closest) return;
        const row = t.closest('.caption-row');
        if (!row) return;
        if (t.closest('button, a, input, textarea, select, [role="button"], .qs-inline-style-panel, .qs-sync-handle')) return;
        if (window._qsTimingMode) {
            const ci = parseInt(row.getAttribute('data-ci'), 10);
            if (!Number.isFinite(ci)) return;
            window._qsTimingSelectedCi = ci;
            _qsSeekToCaptionStart(ci);
            renderWordCaptionEditor();
            return;
        }
        // Word-token clicks bubble here (no stopPropagation) so time strip and text line both seek consistently.
        const start = parseFloat(row.getAttribute('data-start'));
        if (Number.isFinite(start) && typeof window.jumpTo === 'function') window.jumpTo(start);
    };

    // Token selection + constrained editing (no spaces/newlines).
    window._activeWordIndex = null;
    function setActiveTokenNoCaretMove(el) {
        container.querySelectorAll('span.word-token.active').forEach(t => t.classList.remove('active'));
        if (!el) return;
        el.classList.add('active');
        const wi = parseInt(el.getAttribute('data-wi'), 10);
        window._activeWordIndex = Number.isFinite(wi) ? wi : null;
    }
    function placeCaretAfterToken(tokenEl) {
        try {
            if (!tokenEl || !tokenEl.isConnected || !container.contains(tokenEl)) return;
            const range = document.createRange();
            range.setStartAfter(tokenEl);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            try { sel.addRange(range); } catch (_) { return; }
            const capText = tokenEl.closest('.caption-text');
            if (capText) capText.focus();
        } catch (_) {}
    }
    function setActiveToken(el) {
        container.querySelectorAll('span.word-token.active').forEach(t => t.classList.remove('active'));
        if (!el) return;
        el.classList.add('active');
        const wi = parseInt(el.getAttribute('data-wi'), 10);
        window._activeWordIndex = Number.isFinite(wi) ? wi : null;
        // Keep caret in the caption text flow (so arrow keys work).
        placeCaretAfterToken(el);
    }
    function caretIndexFromTapX(tokenEl, clientX, textLen) {
        try {
            const len = Math.max(0, Number(textLen || 0));
            if (!tokenEl || !Number.isFinite(clientX) || len <= 0) return len;
            const r = tokenEl.getBoundingClientRect();
            if (!r || !(r.width > 0)) return len;
            const isRtlDir = ((tokenEl.closest('.caption-row')?.style?.direction || '').toLowerCase() === 'rtl');
            let ratio = (clientX - r.left) / r.width;
            ratio = Math.max(0, Math.min(1, ratio));
            if (isRtlDir) ratio = 1 - ratio;
            return Math.max(0, Math.min(len, Math.round(ratio * len)));
        } catch (_) {
            return Math.max(0, Number(textLen || 0));
        }
    }
    function beginTokenEdit(tokenEl, options = {}) {
        const wi = parseInt(tokenEl.getAttribute('data-wi'), 10);
        if (!Number.isFinite(wi) || !window.currentWords || !window.currentWords[wi]) return;
        if (tokenEl.classList.contains('editing')) return;
        const onMobile = typeof isMobileClient === 'function' ? isMobileClient() : false;
        const isIOSMobile = /iphone|ipad|ipod/.test(String(navigator.userAgent || navigator.vendor || '').toLowerCase())
            || (/macintosh/.test(String(navigator.userAgent || navigator.vendor || '').toLowerCase()) && (navigator.maxTouchPoints || 0) > 1);
        // Use an <input> for editing to avoid nested contenteditable RTL quirks (1-char bug).
        const currentVal = String(window.currentWords[wi].text || '');
        tokenEl.classList.add('editing');
        tokenEl.setAttribute('data-empty', '0');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'qs-token-input';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.autocapitalize = 'off';
        const seed = (options && options.seed) ? String(options.seed) : '';
        input.value = seed ? seed : currentVal;
        input.style.font = 'inherit';
        input.style.border = onMobile ? '0' : '1px solid rgba(59,130,246,0.7)';
        input.style.borderRadius = onMobile ? '0' : '4px';
        input.style.padding = onMobile ? '0' : '0 6px';
        input.style.margin = '0';
        input.style.background = onMobile ? 'transparent' : 'rgba(255,255,255,0.95)';
        input.style.outline = 'none';
        input.style.boxShadow = 'none';
        input.style.direction = tokenEl.closest('.caption-row')?.style?.direction || '';
        input.style.boxSizing = 'content-box';
        input.style.letterSpacing = 'normal';
        input.style.textIndent = '0';
        input.style.width = Math.max(28, (Math.max(1, input.value.length) * 11)) + 'px';
        input.style.minWidth = '28px';
        if (onMobile) {
            input.style.width = Math.max(16, (Math.max(1, input.value.length) * 10)) + 'px';
            input.style.minWidth = '16px';
            // iOS uses horizontal/diagonal touch moves for the native caret handle; pan-y blocks that gesture.
            input.style.touchAction = 'auto';
            input.style.webkitUserSelect = 'text';
            input.style.userSelect = 'text';
        }

        tokenEl.innerHTML = '';
        tokenEl.appendChild(input);
        if (onMobile && !isIOSMobile && !input._qsTouchScrollReleaseBound) {
            input._qsTouchScrollReleaseBound = true;
            let startY = null;
            let startX = null;
            input.addEventListener('touchstart', (ev) => {
                const t = ev.touches && ev.touches[0];
                startY = t ? t.clientY : null;
                startX = t ? t.clientX : null;
            }, { passive: true });
            input.addEventListener('touchmove', (ev) => {
                const t = ev.touches && ev.touches[0];
                if (startY == null || startX == null || !t) return;
                const dy = Math.abs(t.clientY - startY);
                const dx = Math.abs(t.clientX - startX);
                // Only blur on clear vertical scroll — caret drag / selection moves diagonally and must not dismiss the keyboard.
                if (dy > 36 && dy > dx * 2.25) {
                    try { input.blur(); } catch (_) {}
                    startY = null;
                    startX = null;
                }
            }, { passive: true });
        }
        setTimeout(() => {
            try {
                input.focus();
                const optCaret = Number.isFinite(options && options.caretIndex) ? Number(options.caretIndex) : null;
                const pos = (optCaret != null)
                    ? Math.max(0, Math.min(input.value.length, optCaret))
                    : input.value.length;
                input.setSelectionRange(pos, pos);
            } catch (_) {}
        }, 0);

        const commit = () => {
            // Re-render (merge, arrow navigation, etc.) can detach this token before blur runs; avoid mutating stale DOM.
            if (!tokenEl || !tokenEl.isConnected) return;
            try { input.onblur = null; } catch (_) {}
            const skipRefocus = !!window._qsSkipCommitRefocus;
            window._qsSkipCommitRefocus = false;
            const raw = String(input.value || '').trim();
            const parts = raw.split(/\s+/).filter(Boolean);

            if (!parts.length) {
                window.currentWords[wi].text = '';
                tokenEl.innerHTML = '&nbsp;';
                tokenEl.setAttribute('data-empty', '1');
                tokenEl.classList.remove('editing');
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                if (!skipRefocus) {
                    if (onMobile) setActiveTokenNoCaretMove(tokenEl);
                    else setActiveToken(tokenEl);
                }
                return;
            }

            // First token = this word; each further space-separated piece = NEW word inserted after this one
            // (does not overwrite the next timed slots — fixes "adding a word deletes the next word").
            const first = parts[0];
            const inserted = parts.slice(1);
            window.currentWords[wi].text = first;
            let added = 0;
            if (inserted.length > 0) {
                added = _qsInsertWordTextsAfterIndex(wi, inserted);
            }

            tokenEl.classList.remove('editing');
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            renderWordCaptionEditor();
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
            if (!skipRefocus) {
                const focusWi = wi + added;
                const focusEl = container.querySelector(`span.word-token[data-wi="${focusWi}"]`);
                if (focusEl) {
                    if (onMobile) setActiveTokenNoCaretMove(focusEl);
                    else setActiveToken(focusEl);
                }
            }
        };
        input.onblur = commit;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); return; }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                try { input.onblur = null; } catch (_) {}
                if (!tokenEl || !tokenEl.isConnected) return;
                try {
                    // Replacing innerHTML removes the input; do not removeChild first (blur/re-render races leave detached trees).
                    tokenEl.innerHTML = (currentVal.trim().length ? currentVal.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '&nbsp;');
                    tokenEl.classList.remove('editing');
                    if (onMobile) setActiveTokenNoCaretMove(tokenEl);
                    else setActiveToken(tokenEl);
                } catch (_) {}
                return;
            }

            const getCaptionIndexForWi = () => (
                Array.isArray(window.currentCaptions)
                    ? window.currentCaptions.findIndex((c) => wi >= c.wordStartIndex && wi <= c.wordEndIndex)
                    : -1
            );
            const moveToNeighborTokenEdit = (delta, placeAtStart = false) => {
                commit();
                setTimeout(() => {
                    const nextWi = wi + delta;
                    const nextEl = container.querySelector(`span.word-token[data-wi="${nextWi}"]`);
                    if (nextEl) {
                        setActiveToken(nextEl);
                        beginTokenEdit(nextEl);
                        // Preserve "single line" typing feel: land caret on the touching edge.
                        setTimeout(() => {
                            try {
                                const inp = nextEl.querySelector('input.qs-token-input');
                                if (!inp) return;
                                const pos = placeAtStart ? 0 : inp.value.length;
                                inp.setSelectionRange(pos, pos);
                            } catch (_) {}
                        }, 0);
                    }
                }, 0);
            };
            const moveVerticalTokenEdit = (deltaRows) => {
                const capIndex = getCaptionIndexForWi();
                if (capIndex < 0 || !Array.isArray(window.currentCaptions)) return;
                const targetCi = capIndex + deltaRows;
                if (targetCi < 0 || targetCi >= window.currentCaptions.length) return;
                const targetCap = window.currentCaptions[targetCi];
                if (!targetCap) return;
                const srcRect = tokenEl.getBoundingClientRect();
                const targetX = srcRect.left + (srcRect.width / 2);
                let bestWi = targetCap.wordStartIndex;
                let bestDx = Number.POSITIVE_INFINITY;
                for (let twi = targetCap.wordStartIndex; twi <= targetCap.wordEndIndex; twi++) {
                    const el = container.querySelector(`span.word-token[data-wi="${twi}"]`);
                    if (!el) continue;
                    const r = el.getBoundingClientRect();
                    const cx = r.left + (r.width / 2);
                    const dx = Math.abs(cx - targetX);
                    if (dx < bestDx) {
                        bestDx = dx;
                        bestWi = twi;
                    }
                }
                commit();
                setTimeout(() => {
                    const nextEl = container.querySelector(`span.word-token[data-wi="${bestWi}"]`);
                    if (!nextEl) return;
                    setActiveToken(nextEl);
                    beginTokenEdit(nextEl);
                }, 0);
            };

            // Character-caret UX: allow keyboard move between words at token boundaries.
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const isLeft = e.key === 'ArrowLeft';
                const dir = ((input.dir || getComputedStyle(input).direction || '').toLowerCase() === 'rtl') ? 'rtl' : 'ltr';
                const ss = Number.isFinite(input.selectionStart) ? input.selectionStart : 0;
                const se = Number.isFinite(input.selectionEnd) ? input.selectionEnd : 0;
                const atStart = ss === 0 && se === 0;
                const atEnd = ss === input.value.length && se === input.value.length;
                const shouldCrossWord =
                    dir === 'rtl'
                        ? (isLeft ? atEnd : atStart)
                        : (isLeft ? atStart : atEnd);
                if (shouldCrossWord) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dir === 'rtl') {
                        if (isLeft) moveToNeighborTokenEdit(+1, true);
                        else moveToNeighborTokenEdit(-1, false);
                    } else {
                        if (isLeft) moveToNeighborTokenEdit(-1, false);
                        else moveToNeighborTokenEdit(+1, true);
                    }
                    return;
                }
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                moveVerticalTokenEdit(e.key === 'ArrowUp' ? -1 : +1);
                return;
            }

            // Backspace at start of line merges current caption into previous one.
            if (e.key === 'Backspace') {
                const ss = Number.isFinite(input.selectionStart) ? input.selectionStart : 0;
                const se = Number.isFinite(input.selectionEnd) ? input.selectionEnd : 0;
                if (ss === 0 && se === 0) {
                    const capIndex = getCaptionIndexForWi();
                    const cap = (capIndex >= 0 && window.currentCaptions) ? window.currentCaptions[capIndex] : null;
                    if (cap && capIndex > 0 && wi === cap.wordStartIndex) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (window.currentWords && window.currentWords[wi]) {
                            window.currentWords[wi].text = String(input.value || '').trim();
                        }
                        const prev = window.currentCaptions[capIndex - 1];
                        _qsSanitizeWordModelCaptionMergeBoundaries(window.currentWords, prev.wordEndIndex, cap.wordStartIndex, cap.wordEndIndex);
                        const merged = {
                            id: prev.id,
                            wordStartIndex: prev.wordStartIndex,
                            wordEndIndex: cap.wordEndIndex,
                            style: prev.style ? { ...prev.style } : (cap.style ? { ...cap.style } : undefined)
                        };
                        window.currentCaptions.splice(capIndex - 1, 2, merged);
                        window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                        renderWordCaptionEditor();
                        if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                        const focusEl = container.querySelector(`span.word-token[data-wi="${wi}"]`);
                        if (focusEl) {
                            setActiveToken(focusEl);
                            beginTokenEdit(focusEl);
                        }
                        return;
                    }
                }
            }

            // Delete at end of line merges the next caption upward into this one.
            if (e.key === 'Delete') {
                const ss = Number.isFinite(input.selectionStart) ? input.selectionStart : 0;
                const se = Number.isFinite(input.selectionEnd) ? input.selectionEnd : 0;
                const atEnd = ss === input.value.length && se === input.value.length;
                if (atEnd) {
                    const capIndex = getCaptionIndexForWi();
                    const cap = (capIndex >= 0 && window.currentCaptions) ? window.currentCaptions[capIndex] : null;
                    if (cap && capIndex < window.currentCaptions.length - 1 && wi === cap.wordEndIndex) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (window.currentWords && window.currentWords[wi]) {
                            window.currentWords[wi].text = String(input.value || '').trim();
                        }
                        const next = window.currentCaptions[capIndex + 1];
                        _qsSanitizeWordModelCaptionMergeBoundaries(window.currentWords, cap.wordEndIndex, next.wordStartIndex, next.wordEndIndex);
                        const merged = {
                            id: cap.id,
                            wordStartIndex: cap.wordStartIndex,
                            wordEndIndex: next.wordEndIndex,
                            style: cap.style ? { ...cap.style } : (next.style ? { ...next.style } : undefined)
                        };
                        window.currentCaptions.splice(capIndex, 2, merged);
                        window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                        renderWordCaptionEditor();
                        if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                        const focusEl = container.querySelector(`span.word-token[data-wi="${wi}"]`);
                        if (focusEl) {
                            setActiveToken(focusEl);
                            beginTokenEdit(focusEl);
                            setTimeout(() => {
                                try {
                                    const inp = focusEl.querySelector('input.qs-token-input');
                                    if (inp) inp.setSelectionRange(inp.value.length, inp.value.length);
                                } catch (_) {}
                            }, 0);
                        }
                        return;
                    }
                }
            }
        };
        input.oninput = () => {
            input.style.width = Math.max(16, (Math.max(1, input.value.length) * 10)) + 'px';
        };
    }

    container.querySelectorAll('span.word-token').forEach((el) => {
        el.addEventListener('click', (e) => {
            // Timing without text edit: click selects line + seek only
            if (timingMode && !isEditing) {
                e.stopPropagation();
                const row = el.closest('.caption-row');
                const ci = row ? parseInt(row.getAttribute('data-ci'), 10) : null;
                if (Number.isFinite(ci)) {
                    window._qsTimingSelectedCi = ci;
                    _qsSeekToCaptionStart(ci);
                    renderWordCaptionEditor();
                }
                return;
            }
            // Unified edit + timing: keep token edit; update selected timing row when switching lines
            if (timingMode && isEditing) {
                e.stopPropagation();
                const row = el.closest('.caption-row');
                const ci = row ? parseInt(row.getAttribute('data-ci'), 10) : null;
                const wi = parseInt(el.getAttribute('data-wi'), 10);
                if (Number.isFinite(ci) && typeof setActiveRow === 'function') {
                    if (e.shiftKey) setActiveRow(ci, { user: true, range: true });
                    else setActiveRow(ci, { user: true });
                }
                if (e.shiftKey) return;
                if (Number.isFinite(ci) && ci !== window._qsTimingSelectedCi) {
                    window._qsTimingSelectedCi = ci;
                    _qsSeekToCaptionStart(ci);
                    renderWordCaptionEditor();
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            const again = container.querySelector(`span.word-token[data-wi="${wi}"]`);
                            if (again && !again.classList.contains('editing')) {
                                const tapCaret = caretIndexFromTapX(
                                    again,
                                    Number.isFinite(e.clientX) ? e.clientX : NaN,
                                    String(window.currentWords?.[wi]?.text || '').length
                                );
                                setActiveToken(again);
                                beginTokenEdit(again, { caretIndex: tapCaret });
                            }
                        });
                    });
                    return;
                }
            }
            // Bubble to #transcript-window so container.onclick can jumpTo (same as clicking the time line).
            if (typeof isMobileClient === 'function' && isMobileClient()) setActiveTokenNoCaretMove(el);
            else setActiveToken(el);
            let ci = null;
            try {
                const row = el.closest('.caption-row');
                ci = row ? parseInt(row.getAttribute('data-ci'), 10) : null;
                if (isEditing && Number.isFinite(ci) && typeof setActiveRow === 'function') {
                    if (e.shiftKey) setActiveRow(ci, { user: true, range: true });
                    else setActiveRow(ci, { user: true });
                }
            } catch (_) {}
            if (isEditing) {
                // Character-level editing UX: single click enters token edit directly.
                // This avoids the "caret only between words" feeling.
                if (!e.shiftKey && !el.classList.contains('editing')) {
                    e.preventDefault();
                    const tapCaret = caretIndexFromTapX(
                        el,
                        Number.isFinite(e.clientX) ? e.clientX : NaN,
                        String(window.currentWords?.[parseInt(el.getAttribute('data-wi'), 10)]?.text || '').length
                    );
                    const activeEditingInput = container.querySelector('span.word-token.editing input.qs-token-input');
                    const activeEditingHost = activeEditingInput ? activeEditingInput.closest('span.word-token.editing') : null;
                    if (activeEditingInput && activeEditingHost && activeEditingHost !== el) {
                        window._qsSkipCommitRefocus = true;
                        try { activeEditingInput.blur(); } catch (_) {}
                        setTimeout(() => {
                            try {
                                beginTokenEdit(el, { caretIndex: tapCaret });
                            } catch (_) {}
                        }, 0);
                        return;
                    }
                    beginTokenEdit(el, { caretIndex: tapCaret });
                }
                return;
            }
        });
        el.addEventListener('dblclick', (e) => {
            if (!isEditing) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.altKey) {
                beginTokenEdit(el);
                return;
            }
            try {
                const row = el.closest('.caption-row');
                const ci = row ? parseInt(row.getAttribute('data-ci'), 10) : null;
                if (Number.isFinite(ci) && typeof setActiveRow === 'function') setActiveRow(ci, { user: true });
            } catch (_) {}
            return;
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); return; }
        });
    });

    // Keep active token in sync with caret as user moves left/right.
    // This lets ArrowLeft/ArrowRight naturally move the caret, while "active word" follows.
    container._qsSelectionChangeHandler = () => {
        try {
            // Only track when our editor is visible
            if (!container.isConnected) return;
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const an = sel.anchorNode;
            const host = an && an.nodeType === 3 ? an.parentElement : an;
            if (!host || !host.closest) return;
            const capText = host.closest('.caption-text');
            if (!capText || !container.contains(capText)) return;
            // If editing a token via <input>, ignore.
            if (host.closest('span.word-token.editing') || host.closest('input.qs-token-input')) return;

            // Prefer token containing caret; else token before caret; else token after caret.
            const inToken = host.closest('span.word-token[data-wi]');
            let tokenEl = inToken;
            if (!tokenEl) {
                // Find token nearest to caret within this caption-text (works in RTL and without relying on keydown-local helpers).
                const r = sel.getRangeAt(0);
                const tokens = Array.from(capText.querySelectorAll('span.word-token[data-wi]'));
                let lastBefore = null;
                let firstAfter = null;
                for (const t of tokens) {
                    try {
                        const rr = document.createRange();
                        rr.selectNode(t);
                        if (r.compareBoundaryPoints(Range.START_TO_START, rr) < 0) { firstAfter = t; break; }
                        lastBefore = t;
                    } catch (_) {}
                }
                tokenEl = lastBefore || firstAfter || null;
            }
            if (tokenEl) setActiveTokenNoCaretMove(tokenEl);
        } catch (_) {}
    };
    document.addEventListener('selectionchange', container._qsSelectionChangeHandler);
    function _mediaNow() {
        const v = document.getElementById('main-video');
        const a = document.getElementById('main-audio');
        if (v && Number.isFinite(v.currentTime)) return v.currentTime;
        if (a && Number.isFinite(a.currentTime)) return a.currentTime;
        return 0;
    }
    function _sanitizeSelectedRowCis(raw, maxLen) {
        const arr = Array.isArray(raw) ? raw : [];
        const out = [];
        const seen = new Set();
        for (const v of arr) {
            const ci = Number(v);
            if (!Number.isFinite(ci)) continue;
            if (ci < 0 || ci >= maxLen) continue;
            if (seen.has(ci)) continue;
            seen.add(ci);
            out.push(ci);
        }
        out.sort((a, b) => a - b);
        return out;
    }
    function _getSelectedRowSet() {
        const maxLen = Array.isArray(window.currentCaptions) ? window.currentCaptions.length : 0;
        const cis = _sanitizeSelectedRowCis(window._qsSelectedRowCis, maxLen);
        return new Set(cis);
    }
    function _isMultiSelectActive() {
        return _getSelectedRowSet().size > 1;
    }
    function _syncGlobalSelectAllUI() {
        // Legacy no-op: global selection UI was moved to subtitle style drawer.
        container.removeAttribute('data-select-all');
    }
    function _setSelectedRows(cis, opts = {}) {
        const { setAnchor = false } = opts || {};
        const maxLen = Array.isArray(window.currentCaptions) ? window.currentCaptions.length : 0;
        const safe = _sanitizeSelectedRowCis(cis, maxLen);
        window._qsSelectedRowCis = safe;
        container.querySelectorAll('.caption-row.qs-line-selected,.caption-row.qs-multi-lead').forEach(el => {
            el.classList.remove('qs-line-selected', 'qs-multi-lead');
        });
        safe.forEach((ci) => {
            const row = container.querySelector(`.caption-row[data-ci="${ci}"]`);
            if (row) row.classList.add('qs-line-selected');
        });
        const leadCi = safe.length > 0 ? safe[0] : null;
        if (Number.isFinite(leadCi)) {
            const leadRow = container.querySelector(`.caption-row[data-ci="${leadCi}"]`);
            if (leadRow) leadRow.classList.add('qs-multi-lead');
        }
        if (safe.length > 1) container.setAttribute('data-multi-select', '1');
        else container.removeAttribute('data-multi-select');
        if (safe.length > 0) {
            window._qsUserSelectedRowCi = safe[safe.length - 1];
            if (setAnchor) window._qsSelectionAnchorCi = safe[safe.length - 1];
        } else {
            window._qsUserSelectedRowCi = null;
        }
        _syncGlobalSelectAllUI();
    }
    function _selectRangeTo(ci) {
        const maxLen = Array.isArray(window.currentCaptions) ? window.currentCaptions.length : 0;
        if (!Number.isFinite(ci) || ci < 0 || ci >= maxLen) return;
        const anchor = Number.isFinite(window._qsSelectionAnchorCi) ? window._qsSelectionAnchorCi : ci;
        const lo = Math.min(anchor, ci);
        const hi = Math.max(anchor, ci);
        const range = [];
        for (let i = lo; i <= hi; i++) range.push(i);
        _setSelectedRows(range, { setAnchor: false });
    }

    function clearActiveRowUI() {
        container.querySelectorAll('.caption-row.qs-hover-line').forEach(el => el.classList.remove('qs-hover-line'));
    }

    function setActiveRow(ci, opts = {}) {
        const { user = false, hover = false, range = false } = opts || {};
        if (hover) {
            container.querySelectorAll('.caption-row.qs-hover-line').forEach(el => el.classList.remove('qs-hover-line'));
            const rowH = container.querySelector(`.caption-row[data-ci="${ci}"]`);
            if (rowH) rowH.classList.add('qs-hover-line');
        }
        if (user) {
            if (range) _selectRangeTo(ci);
            else _setSelectedRows([ci], { setAnchor: true });
        }
    }

    if (isEditing) {
        container.style.position = 'relative';
        try { const old = document.getElementById('qs-nudge-float'); if (old) old.remove(); } catch (_) {}
        try { container.querySelector('#qs-nudge-in-editor')?.remove(); } catch (_) {}
        window._qsRowDragMoved = false;

        if (Number.isFinite(window._qsUserSelectedRowCi) && window.currentCaptions &&
            (window._qsUserSelectedRowCi < 0 || window._qsUserSelectedRowCi >= window.currentCaptions.length)) {
            window._qsUserSelectedRowCi = null;
        }
        if (Number.isFinite(window._qsStylePanelOpenCi) && window.currentCaptions &&
            (window._qsStylePanelOpenCi < 0 || window._qsStylePanelOpenCi >= window.currentCaptions.length)) {
            window._qsStylePanelOpenCi = null;
        }

        if (!container._qsInlineStyleClickBound) {
            container._qsInlineStyleClickBound = true;
            container.addEventListener('click', (e) => {
                const styleBtn = e.target && e.target.closest ? e.target.closest('.qs-style-btn') : null;
                if (styleBtn && container.contains(styleBtn)) {
                    if (window._qsRowDragMoved) {
                        window._qsRowDragMoved = false;
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    const cci = parseInt(styleBtn.getAttribute('data-ci'), 10);
                    if (!Number.isFinite(cci)) return;

                    // If ALL caption rows are selected, clicking the style icon collapses
                    // the selection back to only the clicked row.
                    const totalCaps = Array.isArray(window.currentCaptions) ? window.currentCaptions.length : 0;
                    const selSet = _getSelectedRowSet();
                    const isAllSelected = totalCaps > 0 && selSet.size === totalCaps;
                    if (isAllSelected) {
                        setActiveRow(cci, { user: true });
                    }

                    const panel = container.querySelector(`.qs-inline-style-panel[data-ci="${cci}"]`);
                    if (!panel) return;
                    const willOpen = panel.style.display !== 'block';
                    container.querySelectorAll('.qs-inline-style-panel').forEach(p => { p.style.display = 'none'; });
                    if (willOpen) {
                        panel.style.display = 'block';
                        window._qsStylePanelOpenCi = cci;
                        syncInlineStylePanel(cci);
                    } else {
                        window._qsStylePanelOpenCi = null;
                    }
                    return;
                }
                const seg = e.target && e.target.closest ? e.target.closest('.qs-inline-seg-btn') : null;
                if (seg && container.contains(seg)) {
                    const wrap = seg.closest('.qs-inline-style-panel');
                    if (!wrap) return;
                    const cci = parseInt(wrap.getAttribute('data-ci'), 10);
                    if (!Number.isFinite(cci) || !window.currentCaptions || !window.currentCaptions[cci]) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const selSet = _getSelectedRowSet();
                    const targetCis = (selSet.size > 1) ? Array.from(selSet) : [cci];
                    targetCis.forEach((ti) => {
                        const cap = window.currentCaptions[ti];
                        if (!cap) return;
                        cap.style = cap.style && typeof cap.style === 'object' ? { ...cap.style } : {};
                        if (seg.hasAttribute('data-pos')) {
                            cap.style.position = seg.getAttribute('data-pos');
                        }
                    });
                    window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                    if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                    const t = _mediaNow();
                    if (typeof highlightActiveCaptionRowByTime === 'function') highlightActiveCaptionRowByTime(t);
                    if (typeof window.updateVideoWordOverlay === 'function') window.updateVideoWordOverlay(t);
                    targetCis.forEach((ti) => syncInlineStylePanel(ti));
                }
            });
        }

        clearActiveRowUI();

        container.querySelectorAll('.caption-row').forEach((rowEl) => {
            const ci = parseInt(rowEl.getAttribute('data-ci'), 10);
            if (!Number.isFinite(ci)) return;
            rowEl.addEventListener('pointerdown', (e) => {
                if (!isEditing) return;
                if (e.button !== 0) return;
                const isTouchPointer = e.pointerType === 'touch' || e.pointerType === 'pen';
                let t = e.target;
                if (t && t.nodeType === Node.TEXT_NODE && t.parentElement) t = t.parentElement;
                const onStyleBtn = !!(t && t.closest && t.closest('.qs-style-btn'));
                if (t && t.closest && (t.closest('.qs-inline-style-panel') || t.closest('span.word-token') || t.closest('input.qs-token-input'))) return;
                if (!onStyleBtn && t && t.closest && t.closest('.qs-caption-toolbar')) return;
                // Timestamp / row chrome: do not preventDefault — that suppresses click and breaks jumpTo on the container.
                if (t && t.closest && t.closest('.caption-ts')) return;
                // Row-drag multi-select only when pressing inside the text column (gaps between tokens), not from time strip or outer chrome.
                if (!t || !t.closest || !t.closest('.caption-text')) return;
                // On touch devices, allow native pan/scroll in the transcript window.
                // We still set active row, but avoid drag-selection and preventDefault.
                if (isTouchPointer) {
                    if (e.shiftKey) setActiveRow(ci, { user: true, range: true });
                    else setActiveRow(ci, { user: true });
                    return;
                }
                window._qsRowDragSelecting = true;
                window._qsRowDragStartCi = ci;
                window._qsRowDragMoved = false;
                if (e.shiftKey) setActiveRow(ci, { user: true, range: true });
                else setActiveRow(ci, { user: true });
                e.preventDefault();
            });
            rowEl.addEventListener('mouseenter', () => {
                setActiveRow(ci, { hover: true });
                if (window._qsRowDragSelecting) {
                    const startCi = Number.isFinite(window._qsRowDragStartCi) ? window._qsRowDragStartCi : ci;
                    const lo = Math.min(startCi, ci);
                    const hi = Math.max(startCi, ci);
                    const range = [];
                    for (let i = lo; i <= hi; i++) range.push(i);
                    if (ci !== startCi) window._qsRowDragMoved = true;
                    _setSelectedRows(range, { setAnchor: false });
                }
            });
            rowEl.addEventListener('mouseleave', (e) => {
                const tb = rowEl.querySelector('.qs-caption-toolbar');
                const rt = e && e.relatedTarget ? e.relatedTarget : null;
                if (tb && rt && tb.contains(rt)) return;
                rowEl.classList.remove('qs-hover-line');
            });
        });

        if (container._qsLineHandleClickHandler) {
            try { container.removeEventListener('click', container._qsLineHandleClickHandler); } catch (_) {}
        }
        container._qsLineHandleClickHandler = (e) => {
            let t = e.target;
            if (!t) return;
            if (t.nodeType === 3 && t.parentElement) t = t.parentElement;
            if (!t.closest) return;
            if (t.closest('span.word-token')) return;
            if (t.closest('.qs-caption-toolbar') || t.closest('.qs-inline-style-panel')) return;
            const rowEl = t.closest('.caption-row');
            if (!rowEl) return;
            const ci = parseInt(rowEl.getAttribute('data-ci'), 10);
            if (!Number.isFinite(ci)) return;
            if (e.shiftKey) setActiveRow(ci, { user: true, range: true });
            else setActiveRow(ci, { user: true });
        };
        container.addEventListener('click', container._qsLineHandleClickHandler, { capture: false });
        if (window._qsRowDragStopHandler) {
            try { window.removeEventListener('pointerup', window._qsRowDragStopHandler); } catch (_) {}
        }
        window._qsRowDragStopHandler = () => {
            window._qsRowDragSelecting = false;
            window._qsRowDragStartCi = null;
            setTimeout(() => { window._qsRowDragMoved = false; }, 0);
        };
        window.addEventListener('pointerup', window._qsRowDragStopHandler);

        if (!Array.isArray(window._qsSelectedRowCis) || window._qsSelectedRowCis.length === 0) {
            if (Number.isFinite(window._qsUserSelectedRowCi)) _setSelectedRows([window._qsUserSelectedRowCi], { setAnchor: false });
        } else {
            _setSelectedRows(window._qsSelectedRowCis, { setAnchor: false });
        }
        if (Number.isFinite(window._qsStylePanelOpenCi)) {
            const p = container.querySelector(`.qs-inline-style-panel[data-ci="${window._qsStylePanelOpenCi}"]`);
            if (p) {
                p.style.display = 'block';
                syncInlineStylePanel(window._qsStylePanelOpenCi);
            }
        }
        _syncGlobalSelectAllUI();
    }

    // Prevent "free text" edits in caption-text. Text changes must happen via token edit only.
    // This avoids a confusing state where the DOM changes but the underlying word model doesn't.
    container.onbeforeinput = (e) => {
        if (!isEditing) return;
        try {
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('.qs-inline-style-panel') || t.closest('.qs-caption-toolbar')) return;
            const inCaptionText = !!t.closest('.caption-text');
            if (!inCaptionText) return;
            // Allow any mutation if the CURRENT selection is inside an editing token.
            const sel = window.getSelection();
            const an = sel && sel.anchorNode ? sel.anchorNode : null;
            const host = an && an.nodeType === 3 ? an.parentElement : an;
            const inTokenEdit = !!(host && host.closest && host.closest('span.word-token.editing'));
            if (inTokenEdit) return;
            const it = String(e.inputType || '');
            // Block all mutations inside caption-text when not editing a token.
            if (
                it.startsWith('insert') ||
                it.startsWith('delete') ||
                it === 'historyUndo' ||
                it === 'historyRedo'
            ) {
                e.preventDefault();
            }
        } catch (_) {}
    };

    // Split / merge at word boundaries (based on caret/active token within caption-text).
    // Use onkeydown to avoid stacking listeners across re-renders.
    container.onkeydown = (e) => {
        if (!isEditing) return;
        if (!window.currentWords || !window.currentCaptions) return;
        if (e.target && e.target.closest && e.target.closest('span.word-token.editing')) return;
        // Space is not allowed in this editor outside explicit token editing.
        // Prevent browser/contenteditable from doing surprising RTL edits.
        if (e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (window.DEBUG_WORD_EDITOR && (e.key === 'Backspace' || e.key === 'Delete')) {
            try {
                const sel = window.getSelection();
                const an = sel && sel.anchorNode;
                const host = an && an.nodeType === 3 ? an.parentElement : an;
                const inToken = host && host.closest ? host.closest('span.word-token[data-wi]') : null;
                console.log('[word-edit][debug] key', e.key, {
                    anchorNodeType: an ? an.nodeType : null,
                    anchorOffset: sel ? sel.anchorOffset : null,
                    inTokenWi: inToken ? inToken.getAttribute('data-wi') : null,
                    activeWi: window._activeWordIndex,
                });
            } catch (_) {}
        }
        function clearWordAt(index) {
            if (!Number.isFinite(index) || !window.currentWords || !window.currentWords[index]) return false;
            if (window.DEBUG_WORD_EDITOR) {
                try {
                    const before = window.currentWords[index] ? window.currentWords[index].text : undefined;
                    console.log('[word-edit][debug] clearWordAt', { index, before });
                } catch (_) {}
            }
            window.currentWords[index].text = '';
            const tokenEl = container.querySelector(`span.word-token[data-wi="${index}"]`);
            if (window.DEBUG_WORD_EDITOR) {
                try {
                    console.log('[word-edit][debug] clearWordAt tokenEl', { found: !!tokenEl, textBefore: tokenEl ? tokenEl.textContent : null });
                } catch (_) {}
            }
            // If the token is currently being edited (contains an <input>), don't touch its DOM here.
            // The input blur/commit handler will re-render the token content.
            if (tokenEl && !tokenEl.classList.contains('editing')) {
                tokenEl.innerHTML = '&nbsp;';
                tokenEl.setAttribute('data-empty', '1');
            }
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
            if (window.DEBUG_WORD_EDITOR) {
                try {
                    console.log('[word-edit][debug] clearWordAt done', { index, textAfter: tokenEl ? tokenEl.textContent : null });
                } catch (_) {}
            }
            // Keep selection on the cleared token so typing replaces it (no jumping to previous token).
            try {
                const el = container.querySelector(`span.word-token[data-wi="${index}"]`);
                if (el) setActiveToken(el);
            } catch (_) {}
            return true;
        }

        function tokenIndexFromCaret(direction /* 'backward' | 'forward' */) {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return null;
            const node = sel.anchorNode;
            const host = node && node.nodeType === 3 ? node.parentElement : node;
            const insideToken = host && host.closest ? host.closest('span.word-token[data-wi]') : null;
            if (insideToken) {
                const idx = parseInt(insideToken.getAttribute('data-wi'), 10);
                return Number.isFinite(idx) ? idx : null;
            }
            const row = container.querySelector(`.caption-row[data-ci="${capIndex}"]`);
            const capText = row ? row.querySelector('.caption-text') : null;
            if (!capText) return null;
            const tokens = Array.from(capText.querySelectorAll('span.word-token[data-wi]'));
            if (tokens.length === 0) return null;
            const r = sel.getRangeAt(0);
            let lastBefore = null;
            let firstAfter = null;
            for (const t of tokens) {
                try {
                    const rr = document.createRange();
                    rr.selectNode(t);
                    if (r.compareBoundaryPoints(Range.START_TO_START, rr) < 0) { firstAfter = t; break; }
                    lastBefore = t;
                } catch (_) {}
            }
            const picked = direction === 'backward' ? lastBefore : (firstAfter || lastBefore);
            if (!picked) return null;
            const idx = parseInt(picked.getAttribute('data-wi'), 10);
            return Number.isFinite(idx) ? idx : null;
        }
        // Resolve current word index. For structural actions (Enter / merge), prefer caret-based token index.
        // For deletion fallback we may still use active token.
        const activeWi = Number.isFinite(window._activeWordIndex) ? window._activeWordIndex : null;
        const wi = activeWi != null ? activeWi : (_closestWordIndexFromSelection(container) ?? null);
        if (!Number.isFinite(wi)) return;
        const capIndex = window.currentCaptions.findIndex(c => wi >= c.wordStartIndex && wi <= c.wordEndIndex);
        if (capIndex < 0) {
            // If we can't find the caption (shouldn't happen), still allow deleting the active word.
            if ((e.key === 'Backspace' || e.key === 'Delete') && activeWi != null) {
                e.preventDefault();
                e.stopPropagation();
                clearWordAt(activeWi);
            }
            return;
        }
        const cap = window.currentCaptions[capIndex];
        if (window.DEBUG_WORD_EDITOR && (e.key === 'Backspace' || e.key === 'Delete')) {
            try { console.log('[word-edit][debug] resolved', { wi, capIndex, capStart: cap.wordStartIndex, capEnd: cap.wordEndIndex }); } catch (_) {}
        }

        // Caret-based index for split/move operations (prevents "active token" from hijacking Enter).
        const caretWi = tokenIndexFromCaret('backward') ?? tokenIndexFromCaret('forward') ?? wi;
        const caretCapIndex = window.currentCaptions.findIndex(c => caretWi >= c.wordStartIndex && caretWi <= c.wordEndIndex);
        const capForCaret = caretCapIndex >= 0 ? window.currentCaptions[caretCapIndex] : cap;

        // If user tries to move horizontally while not in token-input edit,
        // switch into character-level token edit first.
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const active = container.querySelector('span.word-token.active');
            if (active && !active.classList.contains('editing')) {
                e.preventDefault();
                e.stopPropagation();
                beginTokenEdit(active);
                return;
            }
        }

        // If user types while a token is active, switch into token-edit mode so they can
        // edit characters inside the word (but still keep splits/merges at word boundaries).
        // This also makes it easy to delete accidental characters (e.g. English letter).
        // If user types a character while a token is active, enter token-edit mode.
        // We intentionally do NOT auto-enter token-edit on Backspace/Delete because in RTL it can
        // mis-detect caret position and delete the wrong word; Backspace/Delete are reserved for
        // merge-at-boundaries behavior unless the user explicitly double-clicks to edit a token.
        if (e.key.length === 1) {
            const active = container.querySelector('span.word-token.active');
            if (active && !active.classList.contains('editing') && e.key !== 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                beginTokenEdit(active, { seed: e.key });
                return;
            }
        }

        // Arrow navigation between caption lines (up/down)
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const targetIndex = e.key === 'ArrowUp' ? (capIndex - 1) : (capIndex + 1);
            if (targetIndex < 0 || targetIndex >= window.currentCaptions.length) return;
            e.preventDefault();
            e.stopPropagation();
            const targetCap = window.currentCaptions[targetIndex];
            const offset = wi - cap.wordStartIndex;
            const targetLen = Math.max(0, targetCap.wordEndIndex - targetCap.wordStartIndex);
            const targetWi = targetCap.wordStartIndex + Math.max(0, Math.min(offset, targetLen));
            const tokenEl = container.querySelector(`.caption-row[data-ci="${targetIndex}"] span.word-token[data-wi="${targetWi}"]`);
            if (tokenEl) tokenEl.click();
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            // If Enter is pressed at the end of a caption line, move to the next line (if any)
            // instead of attempting to split (cannot create an empty caption).
            const sel = window.getSelection();
            let atEnd = false;
            try {
                if (sel && sel.rangeCount > 0) {
                    const row = container.querySelector(`.caption-row[data-ci="${caretCapIndex >= 0 ? caretCapIndex : capIndex}"]`);
                    const capText = row ? row.querySelector('.caption-text') : null;
                    if (capText) {
                        const endRange = document.createRange();
                        endRange.selectNodeContents(capText);
                        endRange.collapse(false);
                        const r = sel.getRangeAt(0);
                        atEnd = r.compareBoundaryPoints(Range.END_TO_END, endRange) >= 0;
                    }
                }
            } catch (_) {}
            if (atEnd) {
                const nextCap = window.currentCaptions[(caretCapIndex >= 0 ? caretCapIndex : capIndex) + 1];
                if (nextCap) {
                    const nextEl = container.querySelector(`.caption-row[data-ci="${(caretCapIndex >= 0 ? caretCapIndex : capIndex) + 1}"] span.word-token[data-wi="${nextCap.wordStartIndex}"]`);
                    if (nextEl) nextEl.click();
                }
                return;
            }
            if (caretWi < capForCaret.wordStartIndex || caretWi >= capForCaret.wordEndIndex) return;
            const splitIndex = caretWi;
            const left = { id: capForCaret.id, wordStartIndex: capForCaret.wordStartIndex, wordEndIndex: splitIndex, style: capForCaret.style ? { ...capForCaret.style } : undefined };
            const right = { id: `c${Date.now()}`, wordStartIndex: splitIndex + 1, wordEndIndex: capForCaret.wordEndIndex };
            window.currentCaptions.splice((caretCapIndex >= 0 ? caretCapIndex : capIndex), 1, left, right);
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            renderWordCaptionEditor();
            // Select first word of the new caption.
            const nextEl = container.querySelector(`span.word-token[data-wi="${right.wordStartIndex}"]`);
            if (nextEl) nextEl.click();
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
            return;
        }

        if (e.key === 'Backspace') {
            // Merge with previous when caret is at start of first token in caption.
            const sel = window.getSelection();
            const tokenEl = container.querySelector(`span.word-token[data-wi="${cap.wordStartIndex}"]`);
            const atStart = (wi === cap.wordStartIndex) && sel && sel.anchorOffset === 0;
            if (atStart && capIndex > 0) {
                e.preventDefault();
                e.stopPropagation();
                const prev = window.currentCaptions[capIndex - 1];
                _qsSanitizeWordModelCaptionMergeBoundaries(window.currentWords, prev.wordEndIndex, cap.wordStartIndex, cap.wordEndIndex);
                const merged = { id: prev.id, wordStartIndex: prev.wordStartIndex, wordEndIndex: cap.wordEndIndex, style: prev.style ? { ...prev.style } : (cap.style ? { ...cap.style } : undefined) };
                window.currentCaptions.splice(capIndex - 1, 2, merged);
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                renderWordCaptionEditor();
                if (tokenEl) tokenEl.click();
                if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                return;
            }
        }

        if (e.key === 'Delete') {
            // Merge with next when caret is at end of last token in caption.
            const sel = window.getSelection();
            const tokenEl = container.querySelector(`span.word-token[data-wi="${cap.wordEndIndex}"]`);
            const tokenLen = tokenEl ? String(tokenEl.innerText || '').length : 0;
            let atEnd = false;
            // Only allow merge-next when we're on the LAST word of the caption.
            // In RTL, caret positions can be reported in surprising nodes; use a range-based "end of caption" check.
            function caretAtEndOfCaptionText() {
                try {
                    if (!sel || sel.rangeCount === 0) return false;
                    const row = container.querySelector(`.caption-row[data-ci="${capIndex}"]`);
                    const capText = row ? row.querySelector('.caption-text') : null;
                    if (!capText) return false;
                    const endRange = document.createRange();
                    endRange.selectNodeContents(capText);
                    endRange.collapse(false); // end
                    const r = sel.getRangeAt(0);
                    return r.compareBoundaryPoints(Range.END_TO_END, endRange) >= 0;
                } catch (_) { return false; }
            }
            if (sel) {
                // Case 1: caret is inside the last token and at its end
                if (sel.anchorNode && tokenEl && tokenEl.contains(sel.anchorNode) && sel.anchorOffset === tokenLen) {
                    atEnd = true;
                }
                // Case 2: caret is anywhere at (or after) the end of caption-text
                if (!atEnd && caretAtEndOfCaptionText()) {
                    atEnd = true;
                }
            }
            if (atEnd && capIndex < window.currentCaptions.length - 1) {
                e.preventDefault();
                e.stopPropagation();
                const next = window.currentCaptions[capIndex + 1];
                _qsSanitizeWordModelCaptionMergeBoundaries(window.currentWords, cap.wordEndIndex, next.wordStartIndex, next.wordEndIndex);
                const merged = { id: cap.id, wordStartIndex: cap.wordStartIndex, wordEndIndex: next.wordEndIndex, style: cap.style ? { ...cap.style } : (next.style ? { ...next.style } : undefined) };
                window.currentCaptions.splice(capIndex, 2, merged);
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                renderWordCaptionEditor();
                // Restore focus near the old boundary
                const newLastToken = container.querySelector(`.caption-row[data-ci="${capIndex}"] span.word-token[data-wi="${merged.wordEndIndex}"]`);
                if (newLastToken) newLastToken.click();
                if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                return;
            }
            if (atEnd && capIndex === window.currentCaptions.length - 1) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        // Backspace/Delete inside captions: delete the ACTIVE word (stable in RTL) when not merging.
        if (e.key === 'Backspace') {
            e.preventDefault();
            e.stopPropagation();
            if (Number.isFinite(window._activeWordIndex)) clearWordAt(window._activeWordIndex);
            else {
                const idx = tokenIndexFromCaret('backward');
                if (idx != null) clearWordAt(idx);
            }
            return;
        }
        if (e.key === 'Delete') {
            e.preventDefault();
            e.stopPropagation();
            if (Number.isFinite(window._activeWordIndex)) clearWordAt(window._activeWordIndex);
            else {
                const idx = tokenIndexFromCaret('forward');
                if (idx != null) clearWordAt(idx);
            }
            return;
        }

    };

    if (timingMode) {
        try { initQsSyncDirectManipulation(container); } catch (_) {}
    } else if (container._qsSyncDragCleanup) {
        try { container._qsSyncDragCleanup(); } catch (_) {}
        container._qsSyncDragCleanup = null;
    }
}

function highlightActiveCaptionRowByTime(currentTime) {
    try {
        let rows = Array.from(document.querySelectorAll('#transcript-window .caption-row'));
        const useCaptionRows = rows.length > 0;
        if (!useCaptionRows) rows = Array.from(document.querySelectorAll('#transcript-window .paragraph-row'));
        if (!rows.length || !Array.isArray(window.currentSegments) || !window.currentSegments.length) return;
        let activeIdx = -1;
        // If we're in word-caption editor rows, index by captions (not raw segments)
        // so row index always matches the rendered caption rows.
        if (
            useCaptionRows &&
            Array.isArray(window.currentCaptions) &&
            Array.isArray(window.currentWords) &&
            window.currentCaptions.length > 0 &&
            window.currentWords.length > 0
        ) {
            for (let i = 0; i < window.currentCaptions.length; i++) {
                const cap = window.currentCaptions[i];
                const ws = window.currentWords[cap.wordStartIndex];
                const we = window.currentWords[cap.wordEndIndex];
                if (!ws || !we) continue;
                const start = Number(ws.start);
                const end = Number(we.end);
                if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
                if (currentTime >= start && currentTime < end) { activeIdx = i; break; }
            }
        } else {
            for (let i = 0; i < window.currentSegments.length; i++) {
                const seg = window.currentSegments[i];
                const end = seg && seg.end != null ? seg.end : (window.currentSegments[i + 1] ? window.currentSegments[i + 1].start : (seg.start + 9999));
                if (currentTime >= seg.start && currentTime < end) { activeIdx = i; break; }
            }
        }
        rows.forEach((r, idx) => {
            const isActive = idx === activeIdx;
            r.style.backgroundColor = isActive ? 'rgba(0,0,0,0.06)' : 'transparent';
            r.querySelectorAll('.word-token.qs-runtime-active-word,.word-token.qs-runtime-word-pinned').forEach(t => {
                t.classList.remove('qs-runtime-active-word', 'qs-runtime-word-pinned');
                t.style.backgroundColor = '';
                t.style.fontWeight = '';
                t.style.boxShadow = '';
                t.style.color = '';
            });
            const txt = r.querySelector('.caption-text');
            if (txt) {
                txt.style.backgroundColor = '';
                txt.style.fontWeight = '';
            }
            const p = r.querySelector('p[data-idx]');
            if (p) {
                p.style.backgroundColor = '';
                p.style.fontWeight = '';
            }
        });
    } catch (_) {}
}

// --- Video word overlay (disabled in phase 1; position-only editing uses native VTT) ---
window.ensureVideoWordOverlay = function() {
    const videoWrapper = document.getElementById('video-player-container');
    const video = document.getElementById('main-video');
    if (!videoWrapper || !video) return null;
    if (!videoWrapper.style.position) videoWrapper.style.position = 'relative';
    let ov = document.getElementById('qs-video-word-overlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'qs-video-word-overlay';
        ov.innerHTML = `<div class="qs-video-word-overlay-inner"></div>`;
        videoWrapper.appendChild(ov);
    }
    // Always re-apply layout styles, even when overlay already exists.
    // This avoids stale inline CSS from older builds causing persistent misalignment.
    ov.style.cssText = `
      position:absolute;
      top:0;
      left:0;
      right:0;
      width:100%;
      height:100%;
      pointer-events:none;
      z-index:9998;
      display:none;
      padding:0 18px;
      box-sizing:border-box;
      text-align:center;
      font-size:1.6em;
      line-height:1.05;
      color:#fff;
      text-shadow: 0 2px 6px rgba(0,0,0,0.75);
      transform: translateZ(0);
    `;
    let inner = ov.querySelector('.qs-video-word-overlay-inner');
    // Migrate newer overlay DOM shape in-place.
    if (!inner) {
        try {
            ov.innerHTML = `<div class="qs-video-word-overlay-inner"></div>`;
            inner = ov.querySelector('.qs-video-word-overlay-inner');
        } catch (_) {}
    }
    if (inner) {
        // Geometric centering: absolutely position the inner block and use
        // left:50% + translateX(-50%). This is direction-agnostic and works
        // regardless of flex, block, or text-flow context.
        inner.style.position = 'absolute';
        inner.style.left = '50%';
        inner.style.transform = 'translateX(-50%)';
        inner.style.display = 'inline-block';
        inner.style.width = 'auto';
        inner.style.maxWidth = '92%';
        inner.style.margin = '0';
        inner.style.textAlign = 'center';
        inner.style.whiteSpace = 'normal';
        inner.style.overflowWrap = 'normal';
        inner.style.unicodeBidi = 'normal';
        // Clear any leftover flex/table properties from older code.
        inner.style.justifyContent = '';
        inner.style.alignItems = '';
        inner.style.flexWrap = '';
        inner.style.columnGap = '';
        inner.style.rowGap = '';
    }
    return ov;
};

function _escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

window.getActiveCaptionIndexAtTime = function(time) {
    if (!Array.isArray(window.currentCaptions) || !Array.isArray(window.currentWords)) return -1;
    const captions = window.currentCaptions;
    const words = window.currentWords;
    const t = Number(time);
    if (!Number.isFinite(t)) return -1;
    const EPS = 0.06; // tolerate small gaps/rounding mismatches
    for (let i = 0; i < captions.length; i++) {
        const cap = captions[i];
        const ws = words[cap.wordStartIndex];
        const we = words[cap.wordEndIndex];
        if (!ws || !we) continue;
        const start = Number(ws.start);
        const end = Number(we.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (t >= (start - EPS) && t <= (end + EPS)) return i;
    }
    // Fallback: nearest caption start within a small window (prevents overlay "missing" on gaps).
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < captions.length; i++) {
        const cap = captions[i];
        const ws = words[cap.wordStartIndex];
        if (!ws) continue;
        const start = Number(ws.start);
        if (!Number.isFinite(start)) continue;
        const d = Math.abs(t - start);
        if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI >= 0 && bestD <= 0.25) return bestI;
    return -1;
};

window.updateVideoWordOverlay = function(currentTime) {
    try {
        const ov = window.ensureVideoWordOverlay();
        if (!ov) return;
        const video = document.getElementById('main-video');
        const videoWrapper = document.getElementById('video-player-container');
        const setNativeTrackMode = (mode) => {
            if (!video || !video.textTracks || !video.textTracks.length) return;
            const targetMode = mode === 'hidden' ? 'disabled' : mode;
            for (let i = 0; i < video.textTracks.length; i++) {
                try { video.textTracks[i].mode = targetMode; } catch (_) {}
            }
        };
        const forceOverlayMode = isAndroidClient();
        // Non-Android: keep native subtitle rendering only.
        if (!forceOverlayMode) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }

        // Align overlay bounds to actual visible video rectangle.
        try {
            if (video && videoWrapper) {
                const vr = video.getBoundingClientRect();
                const wr = videoWrapper.getBoundingClientRect();
                if (vr.width > 0 && vr.height > 0) {
                    ov.style.top = `${Math.round(vr.top - wr.top)}px`;
                    ov.style.left = `${Math.round(vr.left - wr.left)}px`;
                    ov.style.right = 'auto';
                    ov.style.width = `${Math.round(vr.width)}px`;
                    ov.style.height = `${Math.round(vr.height)}px`;
                }
            }
        } catch (_) {}

        if (!Array.isArray(window.currentCaptions) || !Array.isArray(window.currentWords) || !window.currentWords.length) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }
        const ci = window.getActiveCaptionIndexAtTime(currentTime);
        if (ci < 0) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }

        const cap = window.currentCaptions[ci];
        const words = window.currentWords;
        if (!cap) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }
        const activeSeg = (typeof window.getActiveSegmentAtTime === 'function')
            ? window.getActiveSegmentAtTime(window.currentSegments || [], currentTime)
            : null;
        let activeCueText = '';
        try {
            if (video && video.textTracks && video.textTracks.length > 0) {
                const tt = video.textTracks[0];
                // Use full cues list by time instead of activeCues (activeCues can be empty when track is hidden).
                const cueList = tt && tt.cues ? tt.cues : null;
                if (cueList && cueList.length) {
                    for (let i = 0; i < cueList.length; i++) {
                        const c = cueList[i];
                        if (!c) continue;
                        const st = Number(c.startTime);
                        const et = Number(c.endTime);
                        if (!Number.isFinite(st) || !Number.isFinite(et)) continue;
                        if (Number(currentTime) >= st && Number(currentTime) <= et) {
                            activeCueText = String(c.text || '').replace(/\n+/g, ' ').trim();
                            break;
                        }
                    }
                }
                if (!activeCueText) {
                    const cues = tt && tt.activeCues ? tt.activeCues : null;
                    if (cues && cues.length > 0 && cues[0] && typeof cues[0].text === 'string') {
                        activeCueText = String(cues[0].text || '').replace(/\n+/g, ' ').trim();
                    }
                }
            }
        } catch (_) {}

        const st = (typeof window.getResolvedCaptionStyle === 'function')
            ? window.getResolvedCaptionStyle(ci)
            : { position: 'bottom' };
        const pos = st && st.position ? st.position : 'bottom';
        const inner = ov.querySelector('.qs-video-word-overlay-inner');
        if (!inner) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }

        const highlightedWords = (window.currentWords || [])
            .filter((w) => w && w.highlighted && String(w.text || '').trim())
            .map((w) => String(w.text || '').trim());
        const segText = String((activeSeg && activeSeg.text) || '').trim();
        const capText = String((cap && cap.text) || '').trim();
        const baseLine = (activeCueText || segText || capText).trim();
        if (!baseLine) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }
        const normToken = (s) => String(s || '').replace(/[^\w\u0590-\u05FF]+/g, '').toLowerCase();
        const hlSet = new Set(highlightedWords.map(normToken).filter(Boolean));
        const baseTokens = baseLine.split(/\s+/).filter(Boolean);
        const hasPinnedWord = baseTokens.some((tok) => hlSet.has(normToken(tok)));
        if (!hasPinnedWord) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }
        const renderedTokens = baseTokens.map((tok) => {
            const safeTok = _escapeHtml(tok);
            const isHl = hlSet.has(normToken(tok));
            if (isHl) {
                return `<span style="display:inline;padding:0 .22em;border-radius:4px;background:#000000;color:#ffffff;font-weight:700;">${safeTok}</span>`;
            }
            return `<span style="display:inline;color:#ffffff;font-weight:700;">${safeTok}</span>`;
        });

        // Overlay is ONLY used for highlighted-word display. Keep native track visible if overlay fails.
        inner.style.display = 'inline-block';
        const videoH = (Number.isFinite(video.clientHeight) && video.clientHeight > 0) ? video.clientHeight : 0;
        if (videoH <= 0) {
            ov.style.display = 'none';
            setNativeTrackMode('showing');
            return;
        }
        inner.style.top = '';
        inner.style.bottom = '';
        let anchorY = (videoH * 0.86); // bottom default within overlay box
        if (pos === 'top') anchorY = (videoH * 0.10);
        else if (pos === 'middle') anchorY = (videoH * 0.50);
        inner.style.top = `${Math.round(anchorY)}px`;
        inner.style.transform = (pos === 'middle') ? 'translate(-50%, -50%)' : 'translateX(-50%)';
        const isRtl = (() => {
            try {
                const lang = String(document.documentElement.lang || '').toLowerCase();
                const dir = String(document.documentElement.dir || '').toLowerCase();
                return dir === 'rtl' || lang.startsWith('he') || lang.startsWith('ar');
            } catch (_) {
                return true;
            }
        })();
        inner.style.direction = isRtl ? 'rtl' : 'ltr';
        inner.style.textAlign = 'center';
        inner.innerHTML = `<span dir="${isRtl ? 'rtl' : 'ltr'}" style="display:block;max-width:100%;white-space:normal;word-break:break-word;line-height:1.25;text-shadow:0 2px 6px rgba(0,0,0,0.85);unicode-bidi:plaintext;">${renderedTokens.join('<span aria-hidden="true">&nbsp;</span>')}</span>`;
        // For highlighted mode, use only overlay to avoid duplicate lines.
        ov.style.display = 'block';
        setNativeTrackMode('hidden');
        try {
            const canvas = ov.querySelector('#qs-video-word-overlay-canvas');
            if (canvas) canvas.style.display = 'none';
        } catch (_) {}
    } catch (_) {
        try {
            const ov = document.getElementById('qs-video-word-overlay');
            if (ov) ov.style.display = 'none';
            const video = document.getElementById('main-video');
            if (video && video.textTracks && video.textTracks.length) {
                for (let i = 0; i < video.textTracks.length; i++) {
                    try { video.textTracks[i].mode = 'showing'; } catch (_) {}
                }
            }
        } catch (_) {}
    }
};

async function readSubtitleTextFile(file) {
    const buf = await file.arrayBuffer();
    let text = '';
    try {
        text = new TextDecoder('utf-8').decode(buf);
    } catch (_) {
        text = '';
    }
    // Many exported SRT files are UTF-16LE; detect null-byte pattern and decode accordingly.
    if (text.includes('\u0000')) {
        try { text = new TextDecoder('utf-16le').decode(buf); } catch (_) {}
    }
    return String(text || '').replace(/^\uFEFF/, '');
}

async function _maybeLoadTranscriptJsonForCurrentUser() {
    // Best-effort: fetch transcript .json from S3 for the current user+media.
    // Used to enrich local SRT/VTT imports with word timestamps for editing.
    try {
        if (typeof supabase === 'undefined' || !supabase.auth) return null;
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            console.log('[word-edit] no user session; skipping transcript JSON fetch');
            return null;
        }
        const s3Key = localStorage.getItem('lastS3Key');
        if (!s3Key) {
            console.log('[word-edit] no lastS3Key; cannot locate transcript JSON');
            return null;
        }
        if (!String(s3Key).startsWith('users/' + user.id + '/')) {
            console.log('[word-edit] lastS3Key is not for this user; skipping transcript JSON fetch', { s3KeyPrefix: String(s3Key).slice(0, 30) });
            return null;
        }

        const path = String(s3Key).replace(/\/input\//, '/output/');
        const dot = path.lastIndexOf('.');
        const base = dot >= 0 ? path.slice(0, dot) : path;
        const resultKey = base ? base + '.json' : null;
        if (!resultKey) {
            console.log('[word-edit] could not derive transcript JSON key from lastS3Key', { s3Key });
            return null;
        }
        console.log('[word-edit] fetching transcript JSON', { resultKey });

        const res = await fetch('/api/get_presigned_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ s3Key: resultKey, userId: user.id })
        });
        const json = await res.json();
        if (!json.url) {
            console.log('[word-edit] transcript JSON not found / no url returned', { resultKey, error: json && (json.error || json.message) });
            return null;
        }
        const tr = await fetch(json.url).then(r => r.json());
        const hasWords = !!(tr && Array.isArray(tr.words) && tr.words.length);
        const hasCaptions = !!(tr && Array.isArray(tr.captions) && tr.captions.length);
        const hasSegments = !!(tr && Array.isArray(tr.segments) && tr.segments.length);
        console.log('[word-edit] transcript JSON loaded', { resultKey, hasWords, hasCaptions, hasSegments });
        return tr && typeof tr === 'object' ? tr : null;
    } catch (_) {
        console.log('[word-edit] transcript JSON fetch failed (exception)');
        return null;
    }
}

function _applyCueTextsOntoWordModel(cues, words, captions) {
    // Keeps timestamps; only updates word.text values within each caption range.
    if (!Array.isArray(cues) || !Array.isArray(words) || !Array.isArray(captions)) return false;
    if (cues.length !== captions.length) return false;
    for (let ci = 0; ci < captions.length; ci++) {
        const cap = captions[ci];
        const cueText = String((cues[ci] && (cues[ci].translated_text || cues[ci].text)) || '').trim();
        const parts = cueText.split(/\s+/).filter(Boolean);
        const len = cap.wordEndIndex - cap.wordStartIndex + 1;
        for (let k = 0; k < len; k++) {
            const wi = cap.wordStartIndex + k;
            if (!words[wi]) continue;
            if (parts[k] !== undefined) words[wi].text = parts[k];
        }
    }
    return true;
}

async function handleSubtitleFile(file) {
    if (!file) return;
    try { console.log('[word-edit] subtitle import: start', { name: file.name, type: file.type, size: file.size }); } catch (_) {}
    const text = await readSubtitleTextFile(file);
    // If VTT, strip header
    const isVtt = text.trim().startsWith('WEBVTT');
    const srtText = isVtt ? text.replace(/^WEBVTT.*\n+/,'') : text;
    
    let cues = parseSRT(srtText);
    if (!Array.isArray(cues) || cues.length === 0) {
        if (typeof showStatus === 'function') {
            showStatus('No subtitle cues detected in this file. Please use a standard .srt/.vtt format.', true);
        }
        renderTranscriptFromCues([]);
        return;
    }
    try {
        console.log('[word-edit] subtitle import: parsed cues timing sample', {
            start: cues.slice(0, 3).map(c => c && c.start),
            end: cues.slice(0, 3).map(c => c && c.end),
        });
    } catch (_) {}
    
    // NEW: Pass local subtitle uploads through the Chopper too!
    if (typeof splitLongSegments === 'function') {
        cues = splitLongSegments(cues, 55);
    }

    // If we have an existing transcript JSON on S3 (same user+media), load it so we can edit with word timestamps.
    // This avoids estimating timing in the frontend.
    try {
        console.log('[word-edit] subtitle import: attempting transcript JSON fetch');
        const tr = await _maybeLoadTranscriptJsonForCurrentUser();
        if (tr && Array.isArray(tr.words) && Array.isArray(tr.captions) && tr.words.length > 0 && tr.captions.length > 0) {
            console.log('[word-edit] using words/captions from transcript JSON for subtitle import', { words: tr.words.length, captions: tr.captions.length });
            window.currentWords = tr.words;
            window.currentCaptions = tr.captions;
            _applyCueTextsOntoWordModel(cues, window.currentWords, window.currentCaptions);
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            renderWordCaptionEditor();
            return;
        }
        if (tr && Array.isArray(tr.segments)) {
            const model = _tryBuildWordModelFromSegmentsAndFlat(tr.segments, tr.word_segments);
            if (model) {
                console.log('[word-edit] derived words/captions from transcript JSON (segments.words or word_segments) for subtitle import', { words: model.words.length, captions: model.captions.length });
                window.currentWords = model.words;
                window.currentCaptions = model.captions;
                _applyCueTextsOntoWordModel(cues, window.currentWords, window.currentCaptions);
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                renderWordCaptionEditor();
                return;
            }
        }
        console.log('[word-edit] no usable word-level transcript JSON found; falling back to local subtitle cues');
    } catch (_) {}

    console.log('[SRT] parsed cues:', cues.length, 'file:', file.name);
    // Run correction via backend (GPT)
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    const mainBtn = document.getElementById('main-btn');
    setTranscriptActionButtonsVisible(false);
    if (mainBtn) {
        mainBtn.disabled = true;
        mainBtn.innerText = (T('processing') || 'Processing...').replace(/\.\.\.?$/, '') + ' 0%';
    }
    const TRANSLATE_CHUNK_SIZE = 40;
    const TRANSLATE_CONCURRENCY = 4;
    try {
        const userLang = getUserTargetLang();
        const chunkedCues = [];
        for (let i = 0; i < cues.length; i += TRANSLATE_CHUNK_SIZE) {
            chunkedCues.push(cues.slice(i, i + TRANSLATE_CHUNK_SIZE));
        }
        const chunkResults = [];
        for (let b = 0; b < chunkedCues.length; b += TRANSLATE_CONCURRENCY) {
            if (mainBtn && chunkedCues.length > 1) {
                mainBtn.innerText = (T('processing') || 'Processing...').replace(/\.\.\.?$/, '') + ' ' + Math.min(b + TRANSLATE_CONCURRENCY, chunkedCues.length) + '/' + chunkedCues.length;
            }
            const batchIndices = [];
            for (let i = 0; i < TRANSLATE_CONCURRENCY && b + i < chunkedCues.length; i++) batchIndices.push(b + i);
            const batchPromises = batchIndices.map(function (c) {
                return fetch('/api/translate_segments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ segments: chunkedCues[c], targetLang: userLang })
                }).then(function (res) {
                    if (res.ok) return res.json().then(function (data) {
                        return { index: c, segments: Array.isArray(data.segments) ? data.segments : chunkedCues[c], meta: data.meta };
                    });
                    return { index: c, segments: chunkedCues[c], meta: null };
                }).catch(function () { return { index: c, segments: chunkedCues[c], meta: null }; });
            });
            const batchResults = await Promise.all(batchPromises);
            for (let r = 0; r < batchResults.length; r++) chunkResults.push(batchResults[r]);
        }
        chunkResults.sort(function (a, b) { return a.index - b.index; });
        const allTranslated = [];
        let lastMeta = null;
        for (let r = 0; r < chunkResults.length; r++) {
            allTranslated.push(...chunkResults[r].segments);
            if (chunkResults[r].meta) lastMeta = chunkResults[r].meta;
        }
        if (allTranslated.length) {
            const translatedCount = allTranslated.filter(s => String(s.translated_text || '').trim().length > 0).length;
            const changedCount = allTranslated.filter(s => {
                const t = String(s.translated_text || '').trim();
                const o = String(s.text || '').trim();
                return t.length > 0 && t !== o;
            }).length;
            cues = allTranslated.map((s) => ({ ...s, text: (s.translated_text || s.text || '').trim() }));
            console.log('[GPT] SRT translate success:', translatedCount + '/' + cues.length, 'changed:', changedCount + '/' + cues.length, 'meta:', lastMeta || null);
        }
    } catch (e) {
        console.warn('Translation skipped:', e);
        console.warn(`GPT debug: translation skipped (${e && e.message ? e.message : 'unknown'}) - using original SRT`);
    }
    if (mainBtn) {
        mainBtn.disabled = false;
        mainBtn.innerText = T('upload_and_process') || 'העלה';
    }
    renderTranscriptFromCues(cues);
    
    // Keep transcript read-only until user presses Edit; ensure controls and player visible
    try {
        const container = document.getElementById('transcript-window');
        if (container) container.setAttribute('contenteditable', 'false');
        setTranscriptActionButtonsVisible(true);
        const video = document.getElementById('main-video');
        const videoWrapper = document.getElementById('video-wrapper');
        const videoSrc = document.getElementById('video-source');
        const audioContainer = document.getElementById('audio-player-container');
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        // Keep previously loaded media visible (media + SRT workflow).
        const hasVideoLoaded = !!(
            (video && (video.currentSrc || video.src)) ||
            (videoSrc && (videoSrc.src || videoSrc.getAttribute('src')))
        );
        const hasAudioLoaded = !!(audioSource && audioSource.src);
        if (hasVideoLoaded) {
            if (audioContainer) audioContainer.style.display = 'none';
            if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
            if (video) video.style.display = 'block';
        } else if (hasAudioLoaded) {
            if (videoWrapper) { videoWrapper.style.display = 'none'; videoWrapper.classList.remove('visible'); }
            if (video) video.style.display = 'none';
            if (audioContainer) audioContainer.style.display = 'block';
            if (mainAudio) mainAudio.load();
        }
    } catch (e) { console.warn('Subtitle load UI:', e); }
    // Also attach a VTT track to the video for live preview
    try {
        // Always use the split cues to create VTT, even for original VTT files
        // This ensures the 55-character limit is applied
        const vttLines = ['WEBVTT\n'];
        const fmt = (s) => {
            const ms = Math.floor((s - Math.floor(s)) * 1000);
            const hh = Math.floor(s / 3600);
            const mm = Math.floor((s % 3600) / 60);
            const ss = Math.floor(s % 60);
            const pad = (n) => String(n).padStart(2, '0');
            return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${String(ms).padStart(3,'0')}`;
        };
        for (const c of cues) {
            vttLines.push(`${fmt(c.start)} --> ${fmt(c.end)}`);
            const vttText = (c.translated_text && String(c.translated_text).trim()) ? c.translated_text : (c.text || '');
            vttLines.push(String(vttText).replace(/<[^>]+>/g, ''));
            vttLines.push('');
        }
        const vttBlob = new Blob([vttLines.join('\n')], { type: 'text/vtt' });
        const vttUrl = URL.createObjectURL(vttBlob);

        const video = document.getElementById('main-video');
            if (video) {
            // Remove existing tracks
            Array.from(video.querySelectorAll('track')).forEach(t => t.remove());
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = 'Subtitles';
            track.srclang = 'he';
            track.src = vttUrl;
            track.default = true;
            video.appendChild(track);

            const syncTrackModeWithOverlay = () => {
                try {
                    const now = Number.isFinite(video.currentTime) ? video.currentTime : 0;
                    if (typeof window.updateVideoWordOverlay === 'function') {
                        window.updateVideoWordOverlay(now);
                    } else {
                        const tt = video.textTracks;
                        for (let i = 0; i < tt.length; i++) tt[i].mode = 'showing';
                    }
                } catch (e) {
                    console.warn('Failed to sync textTracks mode with overlay', e);
                }
            };

            track.addEventListener('load', () => {
                try { syncTrackModeWithOverlay(); } catch (e) { console.warn(e); }
            });

            // Fallback attempts in case load event doesn't fire
            setTimeout(syncTrackModeWithOverlay, 100);
            setTimeout(syncTrackModeWithOverlay, 500);
            setTimeout(syncTrackModeWithOverlay, 1500);

            // Additional fallback: if parsing earlier didn't populate the transcript,
            // read cues directly from the video's TextTrack and render them.
            setTimeout(() => {
                try {
                    const tt = video.textTracks;
                    if (tt && tt.length > 0) {
                        for (let i = 0; i < tt.length; i++) {
                            const trackObj = tt[i];
                            if (trackObj && trackObj.cues && trackObj.cues.length > 0) {
                                const cuesArr = [];
                                for (let j = 0; j < trackObj.cues.length; j++) {
                                    const cue = trackObj.cues[j];
                                    cuesArr.push({ start: cue.startTime, end: cue.endTime, text: cue.text });
                                }
                                if (cuesArr.length) {
                                    renderTranscriptFromCues(cuesArr);
                                    window.showSubtitleStyleSelector();
                                }
                                break;
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Failed to read cues from video.textTracks fallback', e);
                }
            }, 300);
            
            // Show style selector after VTT is attached
            window.showSubtitleStyleSelector();
        }
    } catch (e) {
        console.warn('Failed to attach VTT track', e);
    }
}

function downloadSRT() {
    if (!window.currentSegments || window.currentSegments.length === 0) return showStatus((typeof window.t === 'function' ? window.t('no_subtitles_to_download') : 'No subtitles to download'), true);
    const srt = srtFromCues(window.currentSegments);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    saveAs(blob, (window.originalFileName || 'video') + '.srt');
}

async function createBurnedInVideo() {
    const video = document.getElementById('main-video');
    if (!video || !video.currentSrc) return showStatus((typeof window.t === 'function' ? window.t('load_video_first') : 'Load a video file first'), true);
    if (!window.currentSegments || window.currentSegments.length === 0) return showStatus((typeof window.t === 'function' ? window.t('load_subtitles_first') : 'Load subtitles first'), true);

    // Prepare canvas
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 360;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    // subtitle styling
    const fontSize = Math.max(20, Math.floor(h / 20));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 6;

    // Capture canvas stream
    const stream = canvas.captureStream(30);
    const chunks = [];
    let mime = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        saveAs(blob, (window.originalFileName || 'video') + '-subbed.webm');
        showStatus((typeof window.t === 'function' ? window.t('video_created') : 'Video with subtitles created'), false);
        try { document.body.removeChild(canvas); } catch (e) {}
    };

    // Draw loop
    let rafId = null;
    const draw = () => {
        ctx.drawImage(video, 0, 0, w, h);

        // find active cue
        const t = video.currentTime;
        const active = window.currentSegments.find(c => t >= c.start && t <= c.end);
        if (active) {
            const lines = active.text.split('\n');
            const padding = 12;
            // measure height
            const lineHeight = fontSize + 6;
            const totalH = lines.length * lineHeight + padding * 2;
            // background
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(0, h - totalH - 20, w, totalH + 10);

            ctx.fillStyle = 'white';
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.lineWidth = 6;
            let y = h - totalH - 20 + padding + fontSize;
            for (const line of lines) {
                ctx.strokeText(line, w - 20, y);
                ctx.fillText(line, w - 20, y);
                y += lineHeight;
            }
        }

        rafId = requestAnimationFrame(draw);
    };

    // Start recording and playback
    recorder.start();
    // Play muted to avoid audio capture issues; we'll capture system audio is not possible reliably
    const prevMuted = video.muted;
    video.muted = true;
    await video.play();
    draw();

    // Stop when video ends
    video.onended = () => {
        cancelAnimationFrame(rafId);
        recorder.stop();
        video.muted = prevMuted;
    };

    showStatus((typeof window.t === 'function' ? window.t('rendering_video') : 'Rendering video — please wait until playback finishes'), false);
}

// Init handlers for the new UI elements
document.addEventListener('DOMContentLoaded', () => {
    const videoInput = document.getElementById('videoFileInput');
    const subtitleInput = document.getElementById('subtitleFileInput');
    const downloadBtn = document.getElementById('btn-download-srt');
    const burnBtn = document.getElementById('btn-burn-video');
    const video = document.getElementById('main-video');

    if (videoInput) videoInput.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        window.originalFileName = f.name.replace(/\.[^.]+$/, '');
        const src = document.getElementById('video-source');
        if (src) src.src = url;
        if (video) {
            video.style.position = 'relative';
            video.style.zIndex = '1002';
            video.controls = true;
            video.load();
            video.pause();
            try { video.focus(); } catch (e) {}
        }
        showStatus((typeof window.t === 'function' ? window.t('video_loaded') : 'Video loaded locally'), false);
    });

    if (subtitleInput) subtitleInput.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        await handleSubtitleFile(f);
    });

    if (downloadBtn) downloadBtn.addEventListener('click', () => downloadSRT());
    if (burnBtn) burnBtn.addEventListener('click', () => createBurnedInVideo());
    
    // Subtitle style drawer event listeners
    document.addEventListener('click', function(e) {
        const toggleBtn = e.target.closest('#subtitle-style-toggle');
        if (toggleBtn) {
            e.preventDefault();
            window.toggleSubtitleStyleDrawer();
            return;
        }

        const globalPosBtn = e.target.closest('.subtitle-global-pos-btn');
        if (globalPosBtn) {
            e.preventDefault();
            const pos = globalPosBtn.getAttribute('data-global-pos');
            if (pos && typeof window.applyGlobalCaptionPosition === 'function') {
                window.applyGlobalCaptionPosition(pos);
            }
            return;
        }

        const colorBtn = e.target.closest('.subtitle-color-btn');
        if (colorBtn) {
            e.preventDefault();
            const colorKey = colorBtn.getAttribute('data-subtitle-color');
            if (colorKey && typeof window.applySubtitleColor === 'function') {
                window.applySubtitleColor(colorKey);
            }
            return;
        }

        const styleCard = e.target.closest('.subtitle-style-card');
        if (styleCard) {
            const style = styleCard.dataset.style;
            if (style) {
                window.applySubtitleStyle(style);
                window.toggleSubtitleStyleDrawer(false);
            }
            return;
        }

        const selector = document.getElementById('subtitle-style-selector');
        if (selector && selector.classList.contains('is-open') && !e.target.closest('#subtitle-style-selector')) {
            window.toggleSubtitleStyleDrawer(false);
        }
    });
    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        const selector = document.getElementById('subtitle-style-selector');
        if (selector && selector.classList.contains('is-open')) {
            window.toggleSubtitleStyleDrawer(false);
        }
    });
    window.addEventListener('resize', function() {
        const selector = document.getElementById('subtitle-style-selector');
        if (selector && selector.classList.contains('is-open')) {
            window.toggleSubtitleStyleDrawer(true);
        }
    });
});