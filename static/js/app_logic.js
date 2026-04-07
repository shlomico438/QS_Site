import { supabase } from './supabaseClient.js'

// Console gate:
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
    if (!enabled && window.console) {
        console.log = () => {};
        console.info = () => {};
        console.debug = () => {};
        console.warn = () => {};
    }
})();

// --- GLOBAL STATE ---
window.isTriggering = false;
window.aiDiarizationRan = false;
window.fakeProgressInterval = null;
window.currentSegments = [];
window.currentFormattedDoc = null;
// Per-caption layout + highlight (merged with global defaults). Timeline/keywords UI removed.
window.globalCaptionLayoutStyle = window.globalCaptionLayoutStyle || null;
window.currentWords = null;
window.currentCaptions = null;
window.originalFileName = "transcript";
window.hasMultipleSpeakers = false;
let isSignUpMode = true;

/** Start polling check_status and trigger_status for a job (used after trigger and on retry). */
window.startJobStatusPolling = function(jobId) {
    if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
    const pollMs = 4000;
    let polls = 0;
    window._checkStatusPollInterval = setInterval(async () => {
        polls++;
        if (!localStorage.getItem('activeJobId')) {
            if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
            return;
        }
        try {
            if (polls % 5 === 0) {
                const tsRes = await fetch(`/api/trigger_status?job_id=${encodeURIComponent(jobId)}`);
                if (tsRes.ok) {
                    const ts = await tsRes.json();
                    if (ts.status === 'failed') {
                        if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
                        window._checkStatusPollInterval = null;
                        window.isTriggering = false;
                        const msg = typeof document.documentElement.lang !== 'undefined' && String(document.documentElement.lang).toLowerCase().startsWith('he')
                            ? 'הפעלת העיבוד נכשלה.' : 'GPU trigger failed.';
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
            if (!res.ok) return;
            const data = await res.json();
            if (data.status === 'completed' || data.status === 'failed' || (data.segments && data.segments.length > 0)) {
                if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
                window._checkStatusPollInterval = null;
                window.handleJobUpdate(data);
            }
        } catch (_) {}
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
    if (event === 'SIGNED_IN' && session) {
        window.toggleModal(false);
        if (typeof setupNavbarAuth === 'function') setupNavbarAuth();
        if (window.location.hash && /access_token/.test(window.location.hash)) {
            // Keep the current in-memory transcript/video UI state.
            // Remove auth hash from URL without forcing a page reload.
            try {
                window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
            } catch (_) {
                // Fallback only if History API is unavailable.
                window.location.hash = '';
            }
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
                qsUploadTrace('trigger_processing_ok', { jobId, attempt, httpStatus: lastRes.status });
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

// --- 1. GLOBAL SOCKET INITIALIZATION ---
if (typeof socket !== 'undefined') {
    socket.on('connect', () => {
        const savedJobId = localStorage.getItem('activeJobId');
        if (savedJobId) {
            console.log("🔄 Re-joining room:", savedJobId);
            socket.emit('join', { room: savedJobId });
        }
    });

    socket.on('job_status_update', (data) => {
        console.log("📩 AI Results Received via Socket:", data);
        if (typeof window.handleJobUpdate === 'function') {
            window.handleJobUpdate(data);
        }
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


window.toggleModal = function(show) {
    if (show) {
        // Save the key before the user starts logging in
        const currentKey = localStorage.getItem('lastS3Key');
        if (currentKey) localStorage.setItem('pendingS3Key', currentKey);
    }
    const modal = document.getElementById('auth-modal');
    if (modal) modal.style.display = show ? 'flex' : 'none';
};

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
        _showToast(str, options.duration ?? 3000);
    }
}

function _showToast(message, duration = 3000) {
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
    toast.style.opacity = '1';
    toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

function _hideToastNow() {
    const toast = document.getElementById('qs-toast');
    if (!toast) return;
    try { clearTimeout(toast._hideTimer); } catch (_) {}
    toast.style.opacity = '0';
}

function setSeoHomeContentVisibility(visible) {
    const seo = document.getElementById('seo-home-content');
    if (!seo) return;
    seo.style.display = visible ? '' : 'none';
}
/** @param {object} [userOverride] - If provided (e.g. from updateUser), use this user instead of getUser() so the UI shows fresh data. */
async function setupNavbarAuth(userOverride) {
    const navBtn = document.getElementById('nav-auth-btn');
    if (!navBtn) return;

    const user = userOverride != null ? userOverride : (await supabase.auth.getUser()).data?.user;

    const personalLink = document.getElementById('nav-personal-link');
    if (user) {
        if (personalLink) personalLink.style.display = '';
        const { displayName } = getAuthUserDisplayInfo(user);
        const logoutText = (typeof window.t === 'function' ? window.t('nav_logout') : 'Log Out');
        navBtn.innerHTML = `<span class="nav-user-name" id="nav-user-name-trigger" role="button" tabindex="0">${escapeHtml(displayName)}</span> <span class="nav-auth-divider">|</span> <span class="nav-logout" id="nav-logout-btn">${escapeHtml(logoutText)}</span>`;
        navBtn.style.color = "#1e3a8a";
        navBtn.href = "#";
        navBtn.onclick = (e) => {
            e.preventDefault();
            if (e.target.id === 'nav-logout-btn' || e.target.closest('#nav-logout-btn')) {
                supabase.auth.signOut().then(() => window.location.reload());
                return;
            }
            toggleUserMenu();
        };
        const nameTrigger = document.getElementById('nav-user-name-trigger');
        if (nameTrigger) {
            nameTrigger.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleUserMenu(); } };
        }
    } else {
        if (personalLink) personalLink.style.display = 'none';
        navBtn.innerHTML = typeof window.t === 'function' ? window.t('nav_sign_in') : 'Sign In';
        navBtn.style.color = "#5d5dff";
        navBtn.href = "#";
        navBtn.onclick = (e) => {
            e.preventDefault();
            if (typeof window.toggleModal === 'function') window.toggleModal(true);
        };
    }
    closeUserMenu();
}

function closeUserMenuOnClickOutside(e) {
    const panel = document.getElementById('user-menu-panel');
    const trigger = document.getElementById('nav-user-name-trigger');
    if (!panel || !panel.classList.contains('is-open')) return;
    if (panel.contains(e.target) || (trigger && trigger.contains(e.target))) return;
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
    if (!nameInput || !emailInput) return;

    const { displayName, email } = getAuthUserDisplayInfo(user);
    const currentName = displayName === 'Account' ? '' : displayName;
    const currentEmail = email || '';
    nameInput.value = currentName;
    emailInput.value = currentEmail;
    if (messageEl) { messageEl.style.display = 'none'; messageEl.textContent = ''; }

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
                await supabase.auth.signOut();
                window.location.reload();
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
        .select('id, created_at, input_s3_key, result_s3_key, runpod_job_id, metadata')
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
    const deriveResultJsonKey = (inputKey) => {
        const s = String(inputKey || '').trim();
        if (!s) return '';
        if (s.includes('/input/')) return s.replace('/input/', '/output/').replace(/\.[^/.]+$/i, '.json');
        return s.replace(/\.[^/.]+$/i, '.json');
    };
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
            const transcriptExists = !!(resultKey || resultKeyMeta || md.transcript_exists === true);
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
                    localStorage.setItem('activeJobId', transcribeJobId);
                    try {
                        await supabase.from('jobs').update({ runpod_job_id: transcribeJobId, updated_at: new Date().toISOString() }).eq('id', file.file_id).eq('user_id', user.id);
                    } catch (_) {}
                    const res = await fetch('/api/trigger_processing', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key: file.s3_key, jobId: transcribeJobId, task: 'transcribe', language: 'he' })
                    });
                    const out = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(out.message || out.error || `HTTP ${res.status}`);
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
                            body: JSON.stringify({ s3Key: k, userId: user.id })
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

/** Load a job in the app when user clicks "Open in app" (/?open=jobId). Loads file URL + transcript JSON. */
async function initOpenInApp(jobId) {
    setSeoHomeContentVisibility(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
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
    // Prefer transcript from S3 (result_s3_key); fallback to jobs.result
    let segments = [];
    let hasTranscriptForOpen = false;
    const { data: keyRow } = await supabase.from('jobs').select('result_s3_key').eq('id', resolvedJobId).eq('user_id', user.id).maybeSingle();
    if (keyRow && keyRow.result_s3_key) {
        hasTranscriptForOpen = true;
        try {
            console.log('[word-edit] open-in-app: fetching transcript JSON', { result_s3_key: keyRow.result_s3_key });
            const urlRes = await fetch('/api/get_presigned_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ s3Key: keyRow.result_s3_key, userId: user.id })
            });
            const urlJson = await urlRes.json();
            if (urlJson.url) {
                const tr = await fetch(urlJson.url).then(r => r.json());
                if (tr) {
                    const trFmt = pickFormattedFromObject(tr);
                    if (trFmt) window.currentFormattedDoc = trFmt;
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
                        window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, tr.captions, 27);
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
                            window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, model.captions, 27);
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
        if (resultData && resultData.result && Array.isArray(resultData.result.segments)) {
            segments = resultData.result.segments;
            if (segments.length > 0) hasTranscriptForOpen = true;
        }
        const resFmt = resultData && resultData.result ? pickFormattedFromObject(resultData.result) : null;
        if (resFmt) {
            window.currentFormattedDoc = resFmt;
            hasTranscriptForOpen = true;
        }
    }
    if (!Array.isArray(window.currentWords) || !Array.isArray(window.currentCaptions)) {
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

    // If we have word-level data, show the token-based caption view (read-only) immediately.
    if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length > 0 && window.currentCaptions.length > 0) {
        try { renderWordCaptionEditor(); } catch (_) {}
    }

    const res = await fetch('/api/get_presigned_url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3Key: job.input_s3_key, userId: user.id })
    });
    const json = await res.json();
    if (!json.url) {
        if (typeof showStatus === 'function') showStatus(json.error || 'Failed to get file link', true);
        return;
    }
    const filename = decodeURIComponent((job.input_s3_key || '').split('/').pop() || 'file');
    window.originalFileName = filename.replace(/\.[^.]+$/, '') || 'file';
    const isAudio = /\.(m4a|mp3|wav|aac|ogg|flac|weba)$/i.test(filename);
    const isVideo = !isAudio && /\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(filename);
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
            src.src = json.url;
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
            audioSource.src = json.url;
            const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
            if (ext === '.m4a') audioSource.type = 'audio/mp4';
            else if (ext === '.mp3') audioSource.type = 'audio/mpeg';
            else if (ext === '.wav') audioSource.type = 'audio/wav';
            else if (ext === '.ogg') audioSource.type = 'audio/ogg';
            else audioSource.type = 'audio/mp4';
            mainAudio.load();
        }
    }

    document.querySelectorAll('.controls-bar').forEach(bar => { if (bar) bar.style.display = 'flex'; });
    setTranscriptActionButtonsVisible(!!hasTranscriptForOpen);
    const mainBtn = document.getElementById('main-btn');
    if (mainBtn) {
        mainBtn.disabled = false;
        setMainButtonAction(hasTranscriptForOpen ? 'upload' : 'transcribe_loaded_file');
    }
    if (typeof syncSpeakerControls === 'function') syncSpeakerControls();
    if (typeof window.render === 'function') window.render();
    if (typeof window.showSubtitleStyleSelector === 'function') window.showSubtitleStyleSelector();
    const speakerToggle = document.getElementById('toggle-speaker');
    if (window.aiDiarizationRan && speakerToggle) speakerToggle.checked = true;
    localStorage.setItem('lastJobDbId', job.id);
    localStorage.setItem('lastS3Key', job.input_s3_key || '');
    if (isVideo && window.currentSegments.length > 0 && typeof window.currentSubtitleStyle === 'undefined') {
        window.currentSubtitleStyle = localStorage.getItem('subtitleStyle') || 'tiktok';
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

function normalizeFormattedFields(f) {
    if (!f || typeof f !== 'object') return null;
    return {
        clean_transcript: String(f.clean_transcript || '').trim(),
        overview: String(f.overview || '').trim(),
        key_points: Array.isArray(f.key_points)
            ? f.key_points.map((p) => String(p || '').trim()).filter(Boolean)
            : []
    };
}

/** GPT-shaped formatting: nested `formatted`, flat keys, or under result/output/data (worker payloads). */
function pickFormattedFromObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    const nested = obj.formatted;
    if (nested && typeof nested === 'object') return normalizeFormattedFields(nested);
    if (obj.clean_transcript != null || obj.overview != null || Array.isArray(obj.key_points)) {
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
    const hasClean = !!(window.currentFormattedDoc && String(window.currentFormattedDoc.clean_transcript || '').trim());
    if (hasClean) return true;
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
        if (trFmt && clen > 0) {
            window.currentFormattedDoc = trFmt;
            console.log('[export] hydrated formatted from S3 (clean_transcript length=%s)', clen);
            return true;
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
/** Join cue texts for GPT format pass: spaces, not newlines, so the model does not lock in ~27-char “subtitle” lines. */
function buildTranscriptTextForGptFormat() {
    return (window.currentSegments || [])
        .map((s) => String((s && s.text) || '').trim())
        .filter(Boolean)
        .join(' ');
}

/** Keep document-format source in sync after manual subtitle edits. */
function syncFormattedDocWithCurrentSegments() {
    const clean = String(buildTranscriptTextForGptFormat() || '').trim();
    if (!clean) return;
    const prev = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
        ? window.currentFormattedDoc
        : {};
    window.currentFormattedDoc = {
        clean_transcript: clean,
        overview: String(prev.overview || '').trim(),
        key_points: Array.isArray(prev.key_points)
            ? prev.key_points.map((p) => String(p || '').trim()).filter(Boolean)
            : []
    };
}

async function ensureFormattedViaApiForExport() {
    const fullText = buildTranscriptTextForGptFormat();
    if (!fullText.trim()) return false;
    const targetLang = (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he') || 'he';
    if (typeof showStatus === 'function') {
        showStatus('מעצב תמלול לייצוא…', false, { duration: 720000 });
    }
    try {
        const res = await fetch('/api/format_transcript_summary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: fullText,
                target_lang: targetLang,
                jobId: localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || undefined
            })
        });
        const fmt = await res.json().catch(() => ({}));
        if (!res.ok || !fmt || typeof fmt !== 'object' || fmt.error) {
            const errMsg = (fmt && fmt.error) ? String(fmt.error) : `HTTP ${res.status}`;
            console.warn('[export] format_transcript_summary failed', res.status, errMsg);
            if (typeof showStatus === 'function') {
                showStatus('עיצוב התמלול נכשל: ' + errMsg.slice(0, 200), true);
            }
            return false;
        }
        window.currentFormattedDoc = {
            clean_transcript: String(fmt.clean_transcript || '').trim(),
            overview: String(fmt.overview || '').trim(),
            key_points: Array.isArray(fmt.key_points)
                ? fmt.key_points.map((p) => String(p || '').trim()).filter(Boolean)
                : []
        };
        console.log(
            '[export] GPT formatting computed for export (clean_transcript length=%s)',
            String(window.currentFormattedDoc.clean_transcript || '').length
        );
        try {
            const { data: { user } } = await supabase.auth.getUser();
            const s3Key = localStorage.getItem('lastS3Key');
            if (user && s3Key && (window.currentSegments || []).length) {
                const saveRes = await fetch('/api/save_job_result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: user.id,
                        input_s3_key: s3Key,
                        segments: window.currentSegments,
                        words: window.currentWords || undefined,
                        captions: window.currentCaptions || undefined,
                        formatted: window.currentFormattedDoc,
                        stage: 'gpt'
                    })
                });
                if (saveRes.ok) console.log('[export] saved transcript JSON with formatted to S3 for next open');
                else console.warn('[export] save_job_result after format failed', saveRes.status);
            }
        } catch (e) {
            console.warn('[export] persist formatted after API format:', e);
        }
        return true;
    } catch (e) {
        console.warn('[export] ensureFormattedViaApiForExport:', e);
        return false;
    }
}

async function tryRecoverSegmentsForExport() {
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

async function deliverBlobToUser(blob, filename, mimeType) {
    const safeName = String(filename || 'download.bin');
    const fileType = String(mimeType || blob?.type || 'application/octet-stream');
    if (isMobileClient() && window._qsMobileBatchShareMode) {
        _queueMobileBatchFile(blob, safeName, fileType);
        return true;
    }
    if (isMobileClient() && navigator.share && typeof File !== 'undefined') {
        try {
            const file = new File([blob], safeName, { type: fileType });
            const canShare = typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });
            if (canShare) {
                await navigator.share({ files: [file] });
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
        return true;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.click();
    URL.revokeObjectURL(url);
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

window.downloadFile = async function(type, bypassUser = null, options = {}) {
    const rawBaseName = ((window.originalFileName || '').trim()) || "transcript";
    const baseName = rawBaseName.replace(/^job_\d+_/, '').trim() || "transcript";

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
            const progressBar = document.getElementById('progress-bar');
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
        window.pendingExportType = type;
        localStorage.setItem('pendingExportType', type);
        localStorage.setItem('pendingS3Key', localStorage.getItem('lastS3Key') || '');
        localStorage.setItem('pendingJobId', localStorage.getItem('lastJobId') || '');

        window.toggleModal(true); // Open the sign-in modal
        return; // <--- CRITICAL: This stops the function here so the file doesn't download
    }
    if (!window.currentSegments.length) {
        await tryRecoverSegmentsForExport();
    }
    if (!window.currentSegments.length) {
        if (typeof showStatus === 'function') showStatus("No transcript available to export.", true);
        return;
    }
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
                (Array.isArray(fmtDoc.key_points) && fmtDoc.key_points.length))
        );
        if ((wantTranscript && !hasClean) || (wantSummary && !hasSummaryBits)) {
            await ensureFormattedViaApiForExport();
        }
        // Caption cues are reflowed (~27 chars per line); do not use newline-joined segments as export body.
        const segmentFlowFallback = (window.currentSegments || [])
            .map(s => String((s && s.text) || '').trim())
            .filter(Boolean)
            .join(' ');

        const _buildExportPayload = () => {
            const fmt = (window.currentFormattedDoc && typeof window.currentFormattedDoc === 'object')
                ? window.currentFormattedDoc
                : null;
            const clean = String((fmt && fmt.clean_transcript) || '').trim() || segmentFlowFallback;
            const overview = String((fmt && fmt.overview) || '').trim();
            const keyPoints = Array.isArray(fmt && fmt.key_points)
                ? fmt.key_points.map((p) => String(p || '').trim()).filter(Boolean)
                : [];
            return { clean, overview, keyPoints };
        };
        const _buildKindText = (kind, payload) => {
            if (kind === 'summary') {
                const lines = [];
                lines.push('סקירה:');
                lines.push(payload.overview || 'N/A');
                lines.push('');
                lines.push('נקודות מפתח:');
                (payload.keyPoints.length ? payload.keyPoints : ['לא הוחזרו נקודות מפתח.']).forEach((p) => lines.push(p));
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
            await deliverBlobToUser(new Blob([toRtlTxt(text)], { type: 'text/plain;charset=utf-8' }), name, 'text/plain;charset=utf-8');
        };

        const _exportKindDocx = async (kind, dlName) => {
            if (typeof showStatus === 'function') showStatus(
                kind === 'summary' ? 'מייצר סיכום…' : 'מייצר תמלול…', false, { duration: 10000 }
            );
            const payload = _buildExportPayload();
            const textForServer = String(payload.clean || segmentFlowFallback || '').trim();
            const t0 = performance.now();
            const res = await fetch('/api/export_docx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    text: textForServer,
                    segments: window.currentSegments || [],
                    formatted: window.currentFormattedDoc || undefined,
                    allow_gpt_fallback: false,
                    filename: docBase
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
            await deliverBlobToUser(blob, dlName);
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
        if (window.currentSegments && window.currentSegments.length > 0) {
            localStorage.setItem('pendingTranscript', JSON.stringify(window.currentSegments));
        }
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin }
        });
        if (error) {
            if (typeof showStatus === 'function') showStatus("Google Login Error: " + error.message, true);
        }
    });
}

// Toggle auth mode (Sign Up / Log In) — magic link flow is the same for both
const toggleAuthBtn = document.getElementById('toggle-auth-mode');
if (toggleAuthBtn) {
    toggleAuthBtn.addEventListener('click', (e) => {
        e.preventDefault();
        isSignUpMode = !isSignUpMode;
        const T = typeof window.t === 'function' ? window.t : (k) => k;
        document.getElementById('modal-title').innerText = isSignUpMode ? T('get_started') : T('welcome_back');
        document.getElementById('signup-fields').style.display = isSignUpMode ? "block" : "none";
        document.getElementById('auth-submit-btn').innerText = T('send_magic_link');
        document.getElementById('auth-switch-text').innerText = isSignUpMode ? T('already_have') : T('need_account');
        document.getElementById('toggle-auth-mode').innerText = isSignUpMode ? T('log_in') : T('sign_up');
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof window.applyTranslations === 'function') window.applyTranslations();
    // 1. Always setup the Navbar first
    await setupNavbarAuth();

    // Home page: "Open in app" — load job by ?open=jobId (file URL + transcript)
    const pathname = typeof window.location !== 'undefined' ? window.location.pathname : '';
    const search = typeof window.location !== 'undefined' ? (window.location.search || '') : '';
    if (pathname === '/' || pathname === '') {
        const openMatch = search.match(/[?&]open=([^&]+)/);
        if (openMatch && openMatch[1]) {
            const jobId = decodeURIComponent(openMatch[1]);
            if (jobId && typeof initOpenInApp === 'function') await initOpenInApp(jobId);
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
    const dMenu = document.getElementById('download-menu');
    /** Assigned after export-panel helpers load; clears defaults each time user opens "בחר מה ליצור". */
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
            // Keep menu constrained inside the transcript wrapper rectangle.
            const wrap = document.querySelector('.transcription-wrapper');
            if (wrap && dMenu.parentElement !== wrap) {
                wrap.appendChild(dMenu);
            }
            const isMobile = window.matchMedia('(max-width: 768px)').matches;
            dMenu.style.position = isMobile ? 'fixed' : 'absolute';
            dMenu.style.zIndex = isMobile ? '9999' : '220';
            dMenu.style.pointerEvents = 'auto';
            function place() {
                if (isMobile) {
                    if (dMenu.parentElement !== document.body) {
                        document.body.appendChild(dMenu);
                    }
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
                const host = document.querySelector('.transcription-wrapper') || downloadMenuParent;
                if (!host) return;
                const hostRect = host.getBoundingClientRect();
                const btnRect = dBtn.getBoundingClientRect();
                const pad = 8;
                const maxW = Math.max(240, hostRect.width - (pad * 2));
                dMenu.style.maxWidth = `${maxW}px`;
                const w = Math.min(dMenu.offsetWidth || 320, maxW);
                const h = dMenu.offsetHeight || 120;
                const preferredLeft = (btnRect.right - hostRect.left) - w;
                const maxLeft = Math.max(pad, hostRect.width - w - pad);
                const left = Math.min(Math.max(pad, preferredLeft), maxLeft);

                // Prefer below the toolbar button; fallback above when needed.
                const belowTop = (btnRect.bottom - hostRect.top) + 6;
                const aboveTop = (btnRect.top - hostRect.top) - h - 6;
                const maxTop = Math.max(pad, hostRect.height - h - pad);
                let top = belowTop;
                if ((belowTop + h) > (hostRect.height - pad)) {
                    top = aboveTop >= pad ? aboveTop : maxTop;
                }
                top = Math.min(Math.max(pad, top), maxTop);

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
            dMenu.style.maxWidth = '';
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
            menu.style.maxWidth = '';
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

                // Force the modal into "Sign Up" (registration) mode.
                try {
                    isSignUpMode = true;
                    const T = typeof window.t === 'function' ? window.t : (k) => k;
                    const modalTitleEl = document.getElementById('modal-title');
                    const signupFieldsEl = document.getElementById('signup-fields');
                    const authSubmitBtnEl = document.getElementById('auth-submit-btn');
                    const authSwitchTextEl = document.getElementById('auth-switch-text');
                    const toggleAuthModeEl = document.getElementById('toggle-auth-mode');

                    if (modalTitleEl) modalTitleEl.innerText = T('get_started');
                    if (signupFieldsEl) signupFieldsEl.style.display = 'block';
                    if (authSubmitBtnEl) authSubmitBtnEl.innerText = T('send_magic_link');
                    if (authSwitchTextEl) authSwitchTextEl.innerText = T('already_have');
                    if (toggleAuthModeEl) toggleAuthModeEl.innerText = T('log_in');
                } catch (_) {}

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
    const { data: { user } } = await supabase.auth.getUser();
    const authBtn = document.getElementById('main-auth-trigger'); // The button that opens the modal

    if (user && authBtn) {
        authBtn.innerText = typeof window.t === 'function' ? window.t('nav_logout') : "Log Out";
        authBtn.onclick = async () => {
            await supabase.auth.signOut();
            window.location.reload();
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
            const { data, error } = await supabase.auth.signInWithOtp({
                email,
                options: {
                    emailRedirectTo: window.location.origin + (window.location.pathname || '/'),
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

function setMainButtonAction(mode) {
    window.mainBtnAction = mode || 'upload';
    const mainBtn = document.getElementById('main-btn');
    if (!mainBtn) return;
    if (window.mainBtnAction === 'transcribe_loaded_file') {
        mainBtn.innerText = (typeof window.t === 'function'
            ? (window.t('transcribe') || window.t('transcribe_btn'))
            : '') || 'תמלל';
    } else {
        mainBtn.innerText = typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload';
    }
}

function isTimeToggleVisible() {
    const el = document.getElementById('toggle-time');
    // Default is ON when toggle is missing/not initialized yet.
    return !el || el.checked !== false;
}

function isDocumentFormatEnabled() {
    const subBtn = document.getElementById('format-mode-subtitle');
    const docBtn = document.getElementById('format-mode-doc');
    if (subBtn && docBtn) {
        return docBtn.classList.contains('is-active');
    }
    const el = document.getElementById('toggle-doc-format');
    return !!(el && el.checked);
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
    const clean = String((window.currentFormattedDoc && window.currentFormattedDoc.clean_transcript) || '').trim();
    if (!clean) return [];
    return clean
        .split(/\r?\n+/)
        .map((line) => String(line || '').trim())
        .filter(Boolean);
}

const PROCESSING_PHASES_HE = [
    "מפעיל שרתים מרוחקים...",
    "מנתח את האודיו ומזהה מילים...",
    "מייצר כתוביות ומסנכרן לוידאו...",
    "מבצע פינישים אחרונים..."
];

function stopProcessingStateUI() {
    const panel = document.getElementById('processing-state-panel');
    const controlsRow = document.querySelector('.upload-zone .upload-controls-row');
    if (window.processingStateTimer) {
        clearInterval(window.processingStateTimer);
        window.processingStateTimer = null;
    }
    window.processingPhaseIndex = 0;
    if (panel) panel.style.display = 'none';
    if (controlsRow) controlsRow.style.display = '';
}

function startProcessingStateUI() {
    const panel = document.getElementById('processing-state-panel');
    const controlsRow = document.querySelector('.upload-zone .upload-controls-row');
    const phaseEl = document.getElementById('processing-state-phase');
    if (!panel || !phaseEl) return;

    if (window.processingStateTimer) {
        clearInterval(window.processingStateTimer);
        window.processingStateTimer = null;
    }

    window.processingPhaseIndex = 0;
    phaseEl.textContent = PROCESSING_PHASES_HE[0];
    panel.style.display = 'flex';
    if (controlsRow) controlsRow.style.display = 'none';

    window.processingStateTimer = setInterval(() => {
        const currentIndex = Number(window.processingPhaseIndex || 0);
        if (currentIndex >= PROCESSING_PHASES_HE.length - 1) {
            clearInterval(window.processingStateTimer);
            window.processingStateTimer = null;
            return;
        }
        window.processingPhaseIndex = currentIndex + 1;
        phaseEl.textContent = PROCESSING_PHASES_HE[window.processingPhaseIndex];
    }, 15000);
}

/** Reset the main screen to initial state (as on first load) — e.g. when user clicks Upload to start a new file. */
function resetScreenToInitial() {
    window.isTriggering = false;
    if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
    window.fakeProgressInterval = null;
    window.currentSegments = [];
    window.currentFormattedDoc = null;
    setSeoHomeContentVisibility(true);
    stopProcessingStateUI();

    const placeholder = document.getElementById('placeholder');
    const transcriptWindow = document.getElementById('transcript-window');
    const pContainer = document.getElementById('p-container');
    const progressBar = document.getElementById('progress-bar');
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
        mainBtn.disabled = false;
        setMainButtonAction('upload');
    }

    if (transcriptWindow) {
        // Do not render `upload_placeholder` anywhere; keep transcript-window empty.
        transcriptWindow.innerHTML = '';
    }
    if (placeholder) placeholder.style.display = 'none';

    if (audioPlayerContainer) audioPlayerContainer.style.display = 'none';
    if (audioSource) audioSource.removeAttribute('src');
    if (mainAudio) mainAudio.load();

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

    document.querySelectorAll('.controls-bar').forEach(bar => { if (bar) bar.style.display = 'flex'; });
    if (typeof syncSpeakerControls === 'function') syncSpeakerControls();
    if (typeof setTranscriptActionButtonsVisible === 'function') setTranscriptActionButtonsVisible(false);
    try { document.body.classList.remove('mobile-video-session'); } catch (_) {}
}

/** Show progress bar in place and scroll it into view so it stays visible during processing. */
function showProgressBar() {
    const pc = document.getElementById('p-container');
    if (!pc) return;
    pc.style.display = 'block';
    const pb = document.getElementById('progress-bar');
    if (pb) pb.style.width = '0%';
    setTimeout(() => { pc.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
}

/** Hide progress bar. */
function hideProgressBar() {
    const pc = document.getElementById('p-container');
    if (!pc) return;
    pc.style.display = 'none';
    const pb = document.getElementById('progress-bar');
    if (pb) pb.style.width = '0%';
}

function setTranscriptActionButtonsVisible(visible) {
    const downloadBtn = document.getElementById('btn-download');
    const editBtn = document.getElementById('btn-edit') || document.querySelector('.toolbar-group button[onclick="window.toggleEditMode()"]');
    const togglesGroup = document.querySelector('.switches-top-bar .toggles-group') || document.querySelector('.controls-bar .toggles-group');
    const switchesTopBar = document.querySelector('.switches-top-bar');
    const controlsBar = document.querySelector('.controls-bar');
    const editActions = document.getElementById('edit-actions');
    const downloadMenu = document.getElementById('download-menu');

    [downloadBtn, editBtn].forEach((el) => {
        if (el) el.style.display = visible ? '' : 'none';
    });
    if (togglesGroup) togglesGroup.style.display = visible ? '' : 'none';
    if (switchesTopBar) switchesTopBar.classList.toggle('is-visible', !!visible);
    if (controlsBar) controlsBar.classList.toggle('is-visible', !!visible);
    if (!visible) {
        if (editActions) editActions.style.display = 'none';
        if (downloadMenu) downloadMenu.style.display = 'none';
        setExportMenuAuxiliaryControlsDisabled(false);
    }
    try {
        document.body.classList.toggle('has-transcript-actions', !!visible);
    } catch (_) {}
}

/** While the export ("בחר מה ליצור") menu is open, disable other transcript toolbar controls. */
function setExportMenuAuxiliaryControlsDisabled(disabled) {
    const fmtSub = document.getElementById('format-mode-subtitle');
    const fmtDoc = document.getElementById('format-mode-doc');
    const editBtn = document.getElementById('btn-edit');
    const subStyleToggle = document.getElementById('subtitle-style-toggle');
    [fmtSub, fmtDoc, editBtn, subStyleToggle].forEach((el) => {
        if (!el) return;
        el.disabled = !!disabled;
    });
    const subPanel = document.getElementById('subtitle-style-drawer');
    if (subPanel && disabled) subPanel.classList.remove('is-open');
}

document.addEventListener('DOMContentLoaded', () => {
    const transcriptWindow = document.getElementById('transcript-window');
    const fileInput = document.getElementById('fileInput');
    const mobileSessionBtn = document.getElementById('mobile-new-session-btn');
    const navNewSessionBtn = document.getElementById('nav-new-session-btn');
    const statusTxt = document.getElementById('upload-status');
    const progressBar = document.getElementById('progress-bar');
    const mainBtn = document.getElementById('main-btn');
    const diarizationToggle = document.getElementById('diarization-toggle');
    const speakerToggle = document.getElementById('toggle-speaker');
    const mainAudio = document.getElementById('main-audio');
    setTranscriptActionButtonsVisible(false);

    function setDiarizationBusyState(isBusy) {
        if (!diarizationToggle) return;
        diarizationToggle.disabled = !!isBusy;
        if (diarizationToggle.parentElement) {
            diarizationToggle.parentElement.style.opacity = isBusy ? "0.6" : "1";
        }
    }

    function openFilePickerAfterDisclaimer() {
        resetScreenToInitial();
        if (fileInput) fileInput.click();
    }

    function syncMobileVideoSessionState() {
        try {
            const isMobile = (
                (window.matchMedia && window.matchMedia('(max-width: 768px)').matches)
                || isMobileClient()
            );
            const videoWrapper = document.getElementById('video-wrapper');
            const hasLoadedVideo = !!(videoWrapper && videoWrapper.classList.contains('visible'));
            document.body.classList.toggle('mobile-video-session', !!(isMobile && hasLoadedVideo));
        } catch (_) {}
        syncLandingLogoSize();
    }

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
        bodyEl.classList.toggle('landing-logo-large', !videoShown);
    }

    if (mobileSessionBtn) {
        mobileSessionBtn.addEventListener('click', () => {
            if (window.isTriggering) return;
            openFilePickerAfterDisclaimer();
        });
    }
    if (navNewSessionBtn) {
        navNewSessionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.isTriggering) return;
            if (!fileInput) {
                window.location.href = '/';
                return;
            }
            openFilePickerAfterDisclaimer();
            const navMenu = document.getElementById('nav-menu');
            const hamburger = document.querySelector('.hamburger-menu');
            if (navMenu) navMenu.classList.remove('active');
            if (hamburger) hamburger.classList.remove('open');
        });
    }
    window.addEventListener('resize', syncMobileVideoSessionState);
    syncMobileVideoSessionState();
    try {
        const videoWrapper = document.getElementById('video-wrapper');
        if (videoWrapper && typeof MutationObserver !== 'undefined') {
            const logoSizeObserver = new MutationObserver(() => syncLandingLogoSize());
            logoSizeObserver.observe(videoWrapper, { attributes: true, attributeFilter: ['class', 'style'] });
        }
    } catch (_) {}

    if (mainBtn) {
        mainBtn.addEventListener('click', async () => {
            if (window.mainBtnAction === 'transcribe_loaded_file') {
                const s3Key = localStorage.getItem('lastS3Key');
                const dbId = localStorage.getItem('lastJobDbId');
                if (!s3Key || !dbId) {
                    if (typeof showStatus === 'function') showStatus('Missing recording context for transcription.', true);
                    return;
                }
                const prev = mainBtn.innerText;
                mainBtn.disabled = true;
                mainBtn.innerText = ((typeof window.t === 'function' ? window.t('processing') : 'Processing') || 'Processing').replace(/\.\.\.?$/, '') + ' 0%';
                startProcessingStateUI();
                setDiarizationBusyState(true);
                try {
                    const transcribeJobId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                        ? crypto.randomUUID()
                        : ('job_' + Date.now() + '_' + Math.floor(Math.random() * 100000));
                    localStorage.setItem('lastJobId', transcribeJobId);
                    localStorage.setItem('activeJobId', transcribeJobId);
                    window._lastProcessedJobId = null;
                    try {
                        await supabase
                            .from('jobs')
                            .update({ runpod_job_id: transcribeJobId, status: 'processing', updated_at: new Date().toISOString() })
                            .eq('id', dbId);
                    } catch (_) {}
                    const triggerRes = await fetch('/api/trigger_processing', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key, jobId: transcribeJobId, task: 'transcribe', language: 'he' })
                    });
                    const triggerData = await triggerRes.json().catch(() => ({}));
                    if (!triggerRes.ok) throw new Error(triggerData.message || triggerData.error || `HTTP ${triggerRes.status}`);
                    if (typeof window.startJobStatusPolling === 'function') window.startJobStatusPolling(transcribeJobId);
                } catch (e) {
                    stopProcessingStateUI();
                    mainBtn.disabled = false;
                    mainBtn.innerText = prev;
                    setDiarizationBusyState(false);
                    if (typeof showStatus === 'function') showStatus('Transcribe failed: ' + (e.message || 'Unknown error'), true);
                }
                return;
            }
            openFilePickerAfterDisclaimer();
        });
    }

    if (transcriptWindow && mainBtn) {
        transcriptWindow.addEventListener('click', (e) => {
            if (window.isTriggering) return;
            if (transcriptWindow.classList.contains('transcript-editing')) return;
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
        if (typeof window.render === 'function') {
            window.render();
            return;
        }
        if (typeof renderTranscriptFromCues === 'function') {
            renderTranscriptFromCues(window.currentSegments || []);
        }
    };
    document.getElementById('toggle-time')?.addEventListener('change', () => rerenderTranscriptView());
    const subtitleModeBtn = document.getElementById('format-mode-subtitle');
    const docModeBtn = document.getElementById('format-mode-doc');
    if (subtitleModeBtn && docModeBtn) {
        const setFormatMode = (mode) => {
            const isDoc = mode === 'doc';
            docModeBtn.classList.toggle('is-active', isDoc);
            subtitleModeBtn.classList.toggle('is-active', !isDoc);
            rerenderTranscriptView();
        };
        subtitleModeBtn.addEventListener('click', () => setFormatMode('subtitle'));
        docModeBtn.addEventListener('click', () => setFormatMode('doc'));
        // Default to subtitle mode (better for subtitle editing/readability).
        setFormatMode('subtitle');
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
    // --- 2. THE HANDLER (Hides overlay and turns switch Blue) ---
    window.handleJobUpdate = async function(rawResult) {
        const jobId = rawResult.jobId || (rawResult.output && rawResult.output.jobId) || (rawResult.result && rawResult.result.jobId);
        if (jobId && window._lastProcessedJobId === jobId) {
            return;
        }
        if (jobId) window._lastProcessedJobId = jobId;

        const dbId = localStorage.getItem('lastJobDbId');

        if (window._checkStatusPollInterval) {
            clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
        }

        // 1. CLEAR OVERLAYS & STOP PROGRESS
        window.isTriggering = false;
        setDiarizationBusyState(false);
        setSeoHomeContentVisibility(false);
        localStorage.removeItem('activeJobId');
        if (window.fakeProgressInterval) {
            clearInterval(window.fakeProgressInterval);
            window.fakeProgressInterval = null;
        }

        const statusTxt = document.getElementById('upload-status');
        const preparingScreen = document.getElementById('preparing-screen');
        if (preparingScreen) preparingScreen.style.display = 'none';

        hideProgressBar();

        const output = rawResult.result || rawResult.output || rawResult;
        window.currentFormattedDoc = extractFormattedFromJobPayload(rawResult) || null;
        const jobStatus = String(rawResult.status || (output && output.status) || '').toLowerCase();
        const jobError = String(rawResult.error || (output && output.error) || '').trim();
        const isFailedJob = jobStatus === 'failed' || !!jobError;

        // 1. SHOW PLAYER: same layout (video-wrapper) for both audio (m4a) and video so transcript is visible in parallel
        const playerContainer = document.getElementById('audio-player-container');
        const videoWrapper = document.getElementById('video-wrapper');
        const videoPlayer = document.getElementById('video-player-container');
        const mainVideo = document.getElementById('main-video');
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        const savedUrl = localStorage.getItem('currentAudioUrl');

        if (window.uploadWasVideo === true) {
            // Video: show mp4 viewer immediately so user can edit transcript (no separate "edit video" step)
            if (playerContainer && videoWrapper && videoPlayer && playerContainer.parentNode === videoPlayer) {
                videoWrapper.parentNode.insertBefore(playerContainer, videoWrapper);
            }
            if (playerContainer) playerContainer.style.display = 'none';
            if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
            if (mainVideo) mainVideo.style.display = '';
            const videoSrc = document.getElementById('video-source');
            if (videoSrc && savedUrl) {
                videoSrc.src = savedUrl;
                let mime = localStorage.getItem('currentAudioMime') || 'video/mp4';
                if (mime.toLowerCase().includes('quicktime') || (savedUrl + '').toLowerCase().includes('.mov')) mime = 'video/mp4';
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
            if (audioSource && mainAudio && savedUrl) {
                audioSource.src = savedUrl;
                const mime = localStorage.getItem('currentAudioMime') || '';
                if (mime) audioSource.type = mime;
                else audioSource.type = 'audio/mp4';
                mainAudio.load();
            }
        }
        syncMobileVideoSessionState();

        // 2. UNHIDE CORE COMPONENTS (Styled Subtitles button removed; video is shown immediately for video uploads)
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
        const mainBtn = document.getElementById('main-btn');

        if (isFailedJob) {
            window.currentSegments = [];
            window.currentFormattedDoc = null;
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
            stopProcessingStateUI();
            return;
        }

        setTranscriptActionButtonsVisible(true);

        // 3. PROCESS DATA — support multiple API shapes (RunPod, simulation, etc.)
        let segments = (output && output.segments) || rawResult.segments || (rawResult.data && rawResult.data.segments) || [];
        if (!Array.isArray(segments)) segments = [];
        const flatWordSegments = (output && output.word_segments) || rawResult.word_segments || (rawResult.result && rawResult.result.word_segments);
        // Real word timestamps → word/caption model (coerces numeric strings; optional flat `word_segments`).
        const wordModel = _tryBuildWordModelFromSegmentsAndFlat(segments, flatWordSegments);
        if (wordModel) {
            window.currentWords = wordModel.words;
            // Keep caption line width consistent with file-open/import flow.
            window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, wordModel.captions, 27);
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        } else {
            window.currentWords = null;
            window.currentCaptions = null;
            segments = splitLongSegments(segments, 40);
            window.currentSegments = segments;
        }

        // First, treat these as raw segments (or derived captions).

        // Then, run GPT post-processing via /api/translate_segments (decoupled from RunPod callback).
        // Chunk size: larger = fewer requests (faster when browser limits ~4–6 connections). Keep under ~55s for gateway.
        const TRANSLATE_CHUNK_SIZE = 40;
        const GPT_PHASE_BASE_PCT = 70; // GPT phase continues from 70% to 100% so progress doesn't restart
        let translationMeta = null;
        let translatedCount = 0;
        let changedCount = 0;
        let userLang = 'he';
        try {
            const T = typeof window.t === 'function' ? window.t : (k) => k;
            const processingLabel = (T('processing') || 'Processing...').replace(/\.\.\.?$/, '');
            if (mainBtn) {
                mainBtn.disabled = true;
                mainBtn.innerText = processingLabel + ' ' + GPT_PHASE_BASE_PCT + '%';
            }
            userLang = (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he');
            const chunks = [];
            for (let i = 0; i < window.currentSegments.length; i += TRANSLATE_CHUNK_SIZE) {
                chunks.push(window.currentSegments.slice(i, i + TRANSLATE_CHUNK_SIZE));
            }
            if (chunks.length > 1) console.log('[GPT] Chunked translate:', segments.length, 'segments ->', chunks.length, 'requests (all in flight)');
            var completedCount = 0;
            function onChunkDone() {
                completedCount++;
                var pct = chunks.length > 1
                    ? GPT_PHASE_BASE_PCT + Math.round(30 * completedCount / chunks.length)
                    : GPT_PHASE_BASE_PCT;
                if (mainBtn) mainBtn.innerText = processingLabel + ' ' + Math.min(100, pct) + '%';
            }
            const chunkPromises = chunks.map(function (chunk, c) {
                return fetch('/api/translate_segments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ segments: chunk, targetLang: userLang })
                }).then(function (res) {
                    if (res.ok) return res.json().then(function (data) {
                        onChunkDone();
                        return { index: c, segments: Array.isArray(data.segments) ? data.segments : chunk, meta: data.meta };
                    });
                    onChunkDone();
                    console.error('[GPT] translate_segments chunk ' + (c + 1) + '/' + chunks.length + ' failed:', res.status);
                    return { index: c, segments: chunk, meta: null };
                }).catch(function (err) {
                    onChunkDone();
                    console.warn('[GPT] translate chunk ' + (c + 1) + ' error:', err);
                    return { index: c, segments: chunk, meta: null };
                });
            });
            const chunkResults = await Promise.all(chunkPromises);
            chunkResults.sort(function (a, b) { return a.index - b.index; });
            const allTranslated = [];
            let lastMeta = null;
            for (let r = 0; r < chunkResults.length; r++) {
                allTranslated.push(...chunkResults[r].segments);
                if (chunkResults[r].meta) lastMeta = chunkResults[r].meta;
            }
            if (allTranslated.length) {
                translationMeta = lastMeta;
                translatedCount = allTranslated.filter(s => String(s.translated_text || '').trim().length > 0).length;
                changedCount = allTranslated.filter(s => {
                    const t = String(s.translated_text || '').trim();
                    const o = String(s.text || '').trim();
                    return t.length > 0 && t !== o;
                }).length;
                // Apply GPT text back onto our current cues.
                const updated = allTranslated.map((s) => ({ ...s, text: (s.translated_text || s.text || '').trim() }));
                window.currentSegments = updated;
                // If we are in word/caption mode, reflect caption text by updating words (timings remain unchanged).
                if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions)) {
                    for (let ci = 0; ci < window.currentCaptions.length && ci < updated.length; ci++) {
                        const cap = window.currentCaptions[ci];
                        const text = String(updated[ci].text || '').trim();
                        const parts = text.split(/\s+/).filter(Boolean);
                        const len = cap.wordEndIndex - cap.wordStartIndex + 1;
                        for (let k = 0; k < len; k++) {
                            const wi = cap.wordStartIndex + k;
                            if (window.currentWords[wi]) {
                                window.currentWords[wi].text = (parts[k] !== undefined ? parts[k] : window.currentWords[wi].text);
                            }
                        }
                    }
                    // Reflow after translation so subtitle cuts stay stable across upload flows.
                    window.currentCaptions = reflowCaptionsByMaxChars(window.currentWords, window.currentCaptions, 27);
                    // Re-derive segments from words/captions after applying text.
                    window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                }
                console.log('[GPT] Job translate success:', translatedCount + '/' + segments.length, 'changed:', changedCount + '/' + segments.length, 'meta:', translationMeta);
            } else if (lastMeta) {
                translationMeta = lastMeta;
            }
        } catch (e) {
            console.warn('[GPT] translate_segments failed, using raw Ivrit-AI output:', e);
        }

        // One-time doc formatting pass (clean transcript + summary), reused by exports.
        // IMPORTANT: run in background so transcript rendering is never blocked by this request.
        (() => {
            const fullText = buildTranscriptTextForGptFormat();
            if (!fullText) return;
            fetch('/api/format_transcript_summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: fullText,
                    target_lang: userLang || 'he',
                    jobId: localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId') || undefined
                })
            })
                .then((fmtRes) => (fmtRes.ok ? fmtRes.json() : null))
                .then((fmt) => {
                    if (!fmt || typeof fmt !== 'object') return;
                    window.currentFormattedDoc = {
                        clean_transcript: String(fmt.clean_transcript || '').trim(),
                        overview: String(fmt.overview || '').trim(),
                        key_points: Array.isArray(fmt.key_points)
                            ? fmt.key_points.map((p) => String(p || '').trim()).filter(Boolean)
                            : []
                    };
                    // Persist formatted payload so future exports can use cached formatting.
                    (async () => {
                        try {
                            const { data: { user } } = await supabase.auth.getUser();
                            const s3Key = localStorage.getItem('lastS3Key');
                            if (!user || !s3Key || !(window.currentSegments || []).length) return;
                            await fetch('/api/save_job_result', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    userId: user.id,
                                    input_s3_key: s3Key,
                                    segments: window.currentSegments,
                                    words: window.currentWords || undefined,
                                    captions: window.currentCaptions || undefined,
                                    formatted: window.currentFormattedDoc,
                                    stage: 'gpt'
                                })
                            });
                        } catch (e) {
                            console.warn('[GPT] save formatted payload failed:', e);
                        }
                    })();
                })
                .catch((e) => {
                    console.warn('[GPT] format_transcript_summary failed (background), export will fallback:', e);
                });
        })();

        // Ensure global segments are set (already handled above); keep legacy flow happy.
        const gptPostProcessed = (
            (translationMeta && Number(translationMeta.ok_count || 0) > 0 && Number(translationMeta.error_count || 0) === 0) ||
            translatedCount > 0
        );
        const finalStatus = gptPostProcessed ? 'post-processed' : 'processed';

        // Persist transcript: save JSON to S3 and store only result_s3_key in DB (or fallback to result.segments)
        if (typeof updateJobStatus === 'function' && dbId) {
            (async () => {
                try {
                    const { data: { user } } = await supabase.auth.getUser();
                    const s3Key = localStorage.getItem('lastS3Key');
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
                                stage: 'gpt'
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

        const transcriptWindow = document.getElementById('transcript-window');
        if (transcriptWindow) {
            if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions)) {
                renderWordCaptionEditor();
            } else {
                window.render();
            }
            // Show subtitle style selector when subtitles are available (video only; audio uses transcript only)
            window.showSubtitleStyleSelector();
            // NEW: Live Preview for Subtitles
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

        // Finally, restore button + status text after GPT stage completes.
        if (mainBtn) {
            mainBtn.disabled = false;
            mainBtn.innerText = typeof window.t === 'function' ? window.t('upload_and_process') : "Upload";
        }
        if (statusTxt) {
            statusTxt.innerText = typeof window.t === 'function' ? window.t('transcription_complete') : "Transcription Complete";
            setTimeout(() => {
                const ps = document.getElementById('preparing-screen');
                if (ps) ps.style.display = 'none';
            }, 3000);
        }
        stopProcessingStateUI();
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
        if (!transcriptWindow || !window.currentSegments) return;

        // Subtitle mode = per-segment lines; Doc mode = glued paragraphs by speaker.
        window.isDocumentMode = isDocumentFormatEnabled();
        if (window.isDocumentMode) {
            const docParagraphs = getDocFormatParagraphs();
            if (docParagraphs.length) {
                const htmlDoc = docParagraphs.map((p) => {
                    const safe = p.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return `<div class="paragraph-row" style="display:block; margin-bottom: 0.35em;"><p style="margin: 0; line-height: 1.7; cursor: text;">${safe}</p></div>`;
                }).join('');
                transcriptWindow.innerHTML = htmlDoc;
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

            return `
            <div class="paragraph-row" id="seg-row-${rowIndex}" style="display:block; margin-bottom: 2px;">
                <div style="font-size: 0.74em; color: #9ca3af; margin-bottom: 0; line-height: 1.05;">

                    <span class="timestamp" style="display: ${isTimeVisible ? 'block' : 'none'};">
                        ${formatTime(g.start)}
                    </span>

                    <span style="display: ${showLabel ? 'block' : 'none'}; font-weight: 600; color: ${getSpeakerColor(g.speaker)};">
                        ${g.speaker.replace('SPEAKER_', 'דובר ')}
                    </span>
                </div><p ${!window.isDocumentMode ? `data-idx="${rowIndex}"` : ''} style="margin: 0 !important; margin-top: -2px; cursor: pointer; line-height: 1.2;" onclick="window.jumpTo(${g.start})">${window.isDocumentMode ? g.text : wrapTextByMaxChars(g.text, 50)}</p>
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
        if (win && win.contentEditable === 'true') return;
        const video = document.querySelector('video');
        const audio = document.querySelector('audio');
        const player = video || audio;
        if (player) {
            player.currentTime = seconds;
            // While editing word-captions, do not auto-play on jump.
            if (win && win.classList && win.classList.contains('transcript-editing')) {
                try { player.pause(); } catch (_) {}
                return;
            }
            player.play();
        }
    };


    window.saveEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');

        // Word-level caption editor: persist model directly (no DOM paragraph extraction; no timing estimation).
        if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length > 0 && window.currentCaptions.length > 0) {
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            syncFormattedDocWithCurrentSegments();

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
                                    captions: window.currentCaptions,
                                    formatted: window.currentFormattedDoc || undefined
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

            // Close edit mode (and re-render read-only word editor)
            win.contentEditable = 'false';
            win.style.border = "1px solid #e2e8f0";
            win.style.backgroundColor = "transparent";
            win.classList.remove('transcript-editing');
            if (editActions) editActions.style.display = 'none';
            try { renderWordCaptionEditor(); } catch (_) {}
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

        if (parr.length < segs.length) {
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
        syncFormattedDocWithCurrentSegments();

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
                                segments: window.currentSegments,
                                formatted: window.currentFormattedDoc || undefined
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
        win.classList.remove('transcript-editing');

        if (editActions) editActions.style.display = 'none';
        console.log("✅ Edits saved and subtitles re-synced.");
    };

    window.cancelEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');

        // Word-level editor: restore model backup and re-render
        if (window.wordEditBackup && Array.isArray(window.wordEditBackup.words) && Array.isArray(window.wordEditBackup.captions)) {
            window.currentWords = window.wordEditBackup.words;
            window.currentCaptions = window.wordEditBackup.captions;
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            try { renderWordCaptionEditor(); } catch (_) {}
            window.wordEditBackup = null;
        } else {
        // Restore the original text from before they clicked the pencil
        if (window.transcriptBackup) {
            win.innerHTML = window.transcriptBackup;
        }
        }

        // Lock UI
        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";
        win.classList.remove('transcript-editing');
        if (editActions) editActions.style.display = 'none';
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
        const selector = document.getElementById('subtitle-style-selector');
        const video = document.getElementById('main-video');
        if (selector && video && window.currentSegments && window.currentSegments.length > 0) {
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
        const v = document.getElementById('main-video');
        const a = document.getElementById('main-audio');
        if (v && Number.isFinite(v.currentTime)) return v.currentTime;
        if (a && Number.isFinite(a.currentTime)) return a.currentTime;
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
            if (win && win.classList.contains('transcript-editing')) {
                try { renderWordCaptionEditor(); } catch (_) {}
            }
        }
        window.syncSubtitleDrawerGlobalPositionUI();
    };
    window.ensureCaptionStyleTimelineUI = function() { /* removed — use inline per-caption editor in transcript */ };

    window.refreshVideoSubtitles = function() {
        const video = document.getElementById('main-video');
        if (!video || !window.currentSegments.length) return;

        // Rebuild the entire VTT file from scratch
        const vttLines = ['WEBVTT\n'];
        const pad = (n, m=2) => String(n).padStart(m, '0');
        const fmt = (s) => {
            const ms = Math.floor((s - Math.floor(s)) * 1000);
            const hh = Math.floor(s / 3600);
            const mm = Math.floor((s % 3600) / 60);
            const ss = Math.floor(s % 60);
            return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(ms, 3)}`;
        };

        const styleToCueSettings = (style) => {
            const pos = style && style.position ? style.position : 'bottom';
            if (pos === 'top') return ' line:10% position:50% align:center';
            if (pos === 'middle') return ' line:50% position:50% align:center';
            return ' line:90% position:50% align:center';
        };
        // Keep line wrapping behavior tied to old tiktok style choice only.
        const isTiktok = window.currentSubtitleStyle === 'tiktok';
        const isPortrait = video.videoHeight > 0 && video.videoWidth > 0 && video.videoHeight > video.videoWidth;
        const maxCharsPerLine = isPortrait ? 14 : 27; // Enforce consistent wrapping in landscape.
        for (let i = 0; i < window.currentSegments.length; i++) {
            const c = window.currentSegments[i];
            const st = (typeof window.getResolvedCaptionStyle === 'function')
                ? window.getResolvedCaptionStyle(i)
                : { position: 'bottom', highlightMode: 'none' };
            const cueSettings = styleToCueSettings(st);
            vttLines.push(`${fmt(c.start)} --> ${fmt(c.end)}${cueSettings}`);
            let text = (c.text || '').replace(/<[^>]+>/g, '').trim();
            if (text.length > maxCharsPerLine) {
                const mid = Math.min(maxCharsPerLine, Math.floor(text.length / 2));
                const spaceBefore = text.lastIndexOf(' ', mid + 1);
                const breakAt = spaceBefore > 0 ? spaceBefore : mid;
                text = text.slice(0, breakAt).trim() + '\n' + text.slice(breakAt).trim();
            }
            vttLines.push(text);
            vttLines.push('');
        }

        const vttBlob = new Blob([vttLines.join('\n')], { type: 'text/vtt' });
        const vttUrl = URL.createObjectURL(vttBlob);

        // Delete the old cached track and attach the new one
        Array.from(video.querySelectorAll('track')).forEach(t => t.remove());
        const track = document.createElement('track');
        // Android Chrome native controls expose a confusing "Subtitles" menu item.
        // Use metadata track there and render subtitles via in-app overlay logic instead.
        track.kind = isAndroidClient() ? 'metadata' : 'subtitles';
        track.label = 'Subtitles';
        track.srclang = 'he';
        track.src = vttUrl;
        track.default = true;
        
        video.appendChild(track);

        // Important: avoid double-rendering native VTT + our custom overlay.
        // When the track finishes loading, immediately re-run overlay rendering logic,
        // which will decide whether native tracks should be `disabled` or `showing`.
        track.addEventListener('load', () => {
            try {
                const now = (typeof _getCurrentMediaTime === 'function')
                    ? _getCurrentMediaTime()
                    : (Number.isFinite(video.currentTime) ? video.currentTime : 0);

                if (typeof window.updateVideoWordOverlay === 'function') {
                    window.updateVideoWordOverlay(now);
                } else {
                    Array.from(video.textTracks).forEach(tt => tt.mode = 'showing');
                }
            } catch (e) {
                console.warn('Track load overlay sync error:', e);
            }
        });
    };

    window.toggleEditMode = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');
        const isEditable = win.contentEditable === 'true';

        if (!isEditable) {
            // --- START EDITING ---
            // Word-caption editor uses token UI (no contenteditable paragraphs).
            if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length && window.currentCaptions.length) {
                win.contentEditable = 'false';
                // Backup the underlying model so Cancel truly discards edits
                try {
                    window.wordEditBackup = {
                        words: JSON.parse(JSON.stringify(window.currentWords)),
                        captions: JSON.parse(JSON.stringify(window.currentCaptions)),
                        segments: JSON.parse(JSON.stringify(window.currentSegments || [])),
                    };
                } catch (_) {
                    window.wordEditBackup = null;
                }
                // IMPORTANT: mark edit mode BEFORE rendering so caption-text becomes contenteditable.
                win.classList.add('transcript-editing');
                renderWordCaptionEditor();
                if (editActions) editActions.style.display = 'flex';
                win.style.border = "2px solid #1e3a8a";
                win.style.backgroundColor = "#fff";
                // Focus first line for keyboard navigation
                requestAnimationFrame(() => {
                    try {
                        const first = win.querySelector('.caption-row .caption-text');
                        if (first) first.focus();
                    } catch (_) {}
                });
                return;
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

        return `
        <div class="paragraph-row" style="display:block; width: 100%; margin-bottom: 2px; direction: rtl; text-align: right;">
            <div style="font-size: 0.74em; color: #9ca3af; margin-bottom: 0; line-height: 1.05;">
                <div style="display: ${isTimeVisible ? 'block' : 'none'};">${formatTime(group.start)}</div>
                <div style="display: ${isSpeakerVisible ? 'block' : 'none'}; font-weight: 600; color: ${getSpeakerColor(rawSpeaker)};">
                    ${speakerDisplay}
                </div>
            </div>
            <p style="margin: 0 !important; margin-top: -2px; cursor: pointer; line-height: 1.2; font-size: 1.1em;" onclick="window.jumpTo(${group.start})">
                ${fullText}
            </p>
            ${translatedLine ? `<p class="translated-line" style="margin: 4px 0 0 0; font-size: 0.9em; color: #6b7280; direction: ltr; text-align: left;">${translatedLine}</p>` : ''}
        </div>`;
    }
    function startFakeProgress() {
        let current = 0;
        const processingLabel = ((typeof window.t === 'function' ? window.t('processing') : 'Processing...') || '').replace(/\.\.\.?$/, '');
        if (mainBtn) mainBtn.innerText = processingLabel + ' 0%';
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
        window.fakeProgressInterval = setInterval(() => {
            if (!window.isTriggering) {
                clearInterval(window.fakeProgressInterval);
                window.fakeProgressInterval = null;
                return;
            }
            if (current < 95) {
                current += 0.5;
                const pct = Math.round(current);
                if (progressBar) progressBar.style.width = current + "%";
                if (mainBtn) mainBtn.innerText = processingLabel + ' ' + pct + '%';
                if (statusTxt) statusTxt.style.display = 'none';
            }
        }, 1000);
    }

    // --- 5. UPLOAD LOGIC ---
    // Replace your existing fileInput listener with this
    if (fileInput) {
        fileInput.addEventListener('change', async function() {
            if (window.isTriggering) return;

            const file = this.files[0];
            if (!file) return;
            setSeoHomeContentVisibility(false);

            // Hide "Upload a file to start" placeholder as soon as user selects a file (and during processing)
            var placeholderEl = document.getElementById('placeholder');
            if (placeholderEl) placeholderEl.style.display = 'none';

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
                        const text = await file.text();
                        const tr = JSON.parse(text || '{}');
                        const words = Array.isArray(tr.words) ? tr.words : null;
                        const captions = Array.isArray(tr.captions) ? tr.captions : null;
                        const segments = Array.isArray(tr.segments) ? tr.segments : [];
                        const trFmt = pickFormattedFromObject(tr);
                        window.currentFormattedDoc = trFmt || null;

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
                        } else {
                            throw new Error('JSON must include segments[] or words[]+captions[]');
                        }

                        window.uploadWasVideo = false;
                        window.originalFileName = file.name.replace(/\.json$/i, '') || 'transcript';
                        setTranscriptActionButtonsVisible(true);
                        syncSpeakerControls();
                        const transcriptWindow = document.getElementById('transcript-window');
                        if (transcriptWindow) {
                            if (Array.isArray(window.currentWords) && Array.isArray(window.currentCaptions) && window.currentWords.length > 0 && window.currentCaptions.length > 0) {
                                renderWordCaptionEditor();
                            } else if (typeof window.render === 'function') {
                                window.render();
                            }
                            window.showSubtitleStyleSelector();
                        }
                        if (mainBtn) {
                            mainBtn.disabled = false;
                            mainBtn.innerText = (typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload');
                        }
                        setDiarizationBusyState(false);
                        hideProgressBar();
                        if (typeof showStatus === 'function') showStatus('JSON transcript loaded locally.', false, { duration: 5000 });
                    } catch (e) {
                        console.warn('JSON transcript load failed', e);
                        if (typeof showStatus === 'function') showStatus(`Failed to load JSON: ${e.message || e}`, true);
                    }
                    fileInput.value = '';
                    return;
                }

                const isAudio = (file.type && file.type.startsWith('audio')) || /\.(m4a|mp3|wav|aac|ogg|flac|weba)$/i.test(file.name);
                const isVideo = !isAudio && ((file.type && file.type.startsWith('video')) || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(file.name));
                window.uploadWasVideo = !!isVideo;
                if (isVideo) {
                    const url = URL.createObjectURL(file);
                    window.originalFileName = file.name.replace(/\.[^.]+$/, '');
                    const src = document.getElementById('video-source');
                    const video = document.getElementById('main-video');
                    if (src) {
                        src.src = url;
                        // Use video/mp4 for .mov so Chrome/Firefox can play (same as presigned-URL path)
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
                    // Show video player immediately; do not wait for transcription
                    const videoWrapper = document.getElementById('video-wrapper');
                    const videoPlayer = document.getElementById('video-player-container');
                    const playerContainer = document.getElementById('audio-player-container');
                    if (playerContainer) playerContainer.style.display = 'none';
                    if (videoWrapper) { videoWrapper.style.display = 'flex'; videoWrapper.classList.add('visible'); }
                    if (video) video.style.display = '';
                    if (videoPlayer) videoPlayer.style.display = 'block';
                    // Continue to upload and process (do not return) so transcription runs for video too
                }
            } catch (e) {
                console.warn('Video preview failed', e);
            }

            // CREATE A LOCAL PREVIEW URL
            const objectUrl = URL.createObjectURL(file);
            localStorage.setItem('currentAudioUrl', objectUrl);
            const storeMime = (file.type || '').toLowerCase();
            const mimeForMov = (/\.mov$/i.test(file.name) || storeMime.includes('quicktime')) ? 'video/mp4' : (file.type || '');
            localStorage.setItem('currentAudioMime', mimeForMov);

            const currentFile = file; // Captured for use in the fetch
            fileInput.value = ""; // Reset for next selection

            // 1. Get the snapshot of the toggle state RIGHT NOW
            const diarizationValue = document.getElementById('diarization-toggle')?.checked || false;

            // Show progress bar for upload; processing phase uses % in button only
            showProgressBar();
            if (progressBar) { progressBar.style.width = "0%"; }
            const uploadLabel = ((typeof window.t === 'function' ? window.t('uploading') : "Uploading...") || '').replace(/\.\.\.?$/, '');
            if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = uploadLabel + " 0%"; }
            setDiarizationBusyState(true);
            if (statusTxt) statusTxt.style.display = "none";
            setTranscriptActionButtonsVisible(false);
            var placeholderEl = document.getElementById('placeholder');
            if (placeholderEl) placeholderEl.style.display = "none";

            try {
                const { data: { user: uploadUser } } = await supabase.auth.getUser();
                const userId = uploadUser ? uploadUser.id : null;

                // 1. Get the Signed URL from Python (key will be under users/{userId}/ or users/anonymous/)
                const signRes = await fetch('/api/sign-s3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: currentFile.name,
                        filetype: currentFile.type,
                        diarization: diarizationValue,
                        userId: userId,
                        language: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he')
                    })
                });

                const result = await signRes.json();

                
                if (!result.data) {
                    throw new Error("Failed to get S3 signature from server.");
                }

                const { url, s3Key, jobId } = result.data;

                // 2. 💾 PARK THE KEYS IMMEDIATELY + create job record (status: pending)
                localStorage.setItem('lastS3Key', s3Key);
                localStorage.setItem('pendingS3Key', s3Key);
                localStorage.setItem('lastJobId', jobId);
                localStorage.setItem('activeJobId', jobId);
                window._lastProcessedJobId = null;
                console.log("💾 Keys parked for recovery:", s3Key);
                if (typeof createJobOnUpload === 'function') await createJobOnUpload({ jobId, s3Key });

                // 3. Start Socket communication
                if (typeof socket !== 'undefined') {
                    socket.emit('join', { room: jobId });
                }

                // 4. Proceed with S3 Upload (XHR for progress tracking) + wake lock + visibility hint
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

                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                xhr.setRequestHeader('Content-Type', currentFile.type);
                xhr.timeout = 0;

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && progressBar) {
                        const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
                        progressBar.style.width = pct + "%";
                        if (mainBtn) mainBtn.innerText = uploadLabel + " " + pct + "%";
                    }
                };

                xhr.onload = async () => {
                    try {
                        if (xhr.status === 200 || xhr.status === 201) {
                        uploadPhase = 's3_done';
                        if (progressBar) progressBar.style.width = "100%";
                        if (mainBtn) mainBtn.innerText = uploadLabel + " 100%";
                        qsUploadTrace('s3_put_complete', { jobId, bytes: currentFile && currentFile.size, status: xhr.status });
                        console.log("✅ File uploaded to S3.");
                        window.isTriggering = true;
                        setDiarizationBusyState(true);
                        window._triggerRetriedForJobId = null; // allow one auto-retry if trigger gets stuck
                        const dbId = localStorage.getItem('lastJobDbId');
                        if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'uploaded');
                        // Phase split: upload progress UI first, then "waking AI" processing UI.
                        hideProgressBar();
                        startProcessingStateUI();
                        if (statusTxt) statusTxt.style.display = 'none';

                        try {
                            uploadPhase = 'trigger_processing';
                            // Always runs after S3 PUT: tells server upload is complete (upload_status for worker).
                            console.log("Upload complete → /api/trigger_processing");
                            const triggerPayload = {
                                s3Key: s3Key,
                                jobId: jobId,
                                diarization: diarizationValue,
                                language: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he')
                            };
                            const { triggerRes, triggerData } = await qsPostTriggerProcessingWithRetry(triggerPayload, jobId);
                            if (!triggerRes.ok) {
                                console.log("trigger nack", triggerRes.status, triggerData);
                                console.log("❌ Triggering processing failed:", triggerRes.status, triggerData);
                                const msg = triggerData.message || triggerData.error || `Server error (${triggerRes.status})`;
                                if (typeof showStatus === 'function') showStatus(msg, true);
                                const dbId2 = localStorage.getItem('lastJobDbId');
                                if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                                window.isTriggering = false;
                                setDiarizationBusyState(false);
                                localStorage.removeItem('activeJobId');
                                stopProcessingStateUI();
                                hideProgressBar();
                                if (mainBtn) mainBtn.disabled = false;
                                return;
                            }

                            // Option A: wait for RunPod trigger confirmation before showing "processing"
                            if (triggerRes.status === 202 && (triggerData.status === 'started' || triggerData.status === 'queued')) {
                                console.log("trigger ack (started, waiting for worker handshake)");
                                const isHebrewUi = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
                                const processingLabel = (typeof window.t === 'function' ? window.t('processing') : 'Processing...');
                                hideProgressBar(); // from here on, progress is % in button only
                                if (mainBtn) mainBtn.innerText = processingLabel.replace(/\.\.\.?$/, '') + ' 0%';
                                if (statusTxt) {
                                    statusTxt.innerText = '';
                                    statusTxt.style.display = 'none';
                                }
                                const pollInterval = 2000;
                                let waitPct = 0;
                                let ts = { status: '' };
                                while (ts.status !== 'triggered' && ts.status !== 'failed') {
                                    await new Promise(r => setTimeout(r, pollInterval));
                                    // Keep progressing slowly and cap at 95% while we wait.
                                    if (waitPct < 95) waitPct = Math.min(95, waitPct + 1);
                                    if (mainBtn) mainBtn.innerText = processingLabel.replace(/\.\.\.?$/, '') + ' ' + waitPct + '%';
                                    try {
                                        const stRes = await fetch(`/api/trigger_status?job_id=${encodeURIComponent(jobId)}`);
                                        ts = stRes.ok ? await stRes.json() : {};
                                    } catch (_) {
                                        // Keep waiting on transient network issues instead of failing the job UI.
                                        ts = ts || { status: '' };
                                    }
                                }
                                if (ts.status === 'failed') {
                                    console.log("trigger nack", ts.status);
                                    console.log("❌ Trigger not confirmed:", ts.status);
                                    const dbId2 = localStorage.getItem('lastJobDbId');
                                    window.isTriggering = false;
                                    setDiarizationBusyState(false);
                                    stopProcessingStateUI();
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
                                console.log("trigger ack (triggered)");
                                console.log("✅ RunPod trigger confirmed.");
                                if (typeof startFakeProgress === 'function') startFakeProgress();
                            } else if (triggerRes.status === 202) {
                                console.log("trigger nack", "unexpected status", triggerData.status);
                            }
                            // Polling fallback: if socket misses callback (e.g. room encoding), poll check_status
                            if (jobId && typeof window.handleJobUpdate === 'function') {
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
                            stopProcessingStateUI();
                            hideProgressBar();
                            if (mainBtn) mainBtn.disabled = false;
                            throw err;
                        }
                        } else {
                        qsUploadTrace('s3_put_http_error', { jobId, status: xhr.status, statusText: xhr.statusText });
                        console.error("S3 Upload Failed:", xhr.statusText);
                        const dbId = localStorage.getItem('lastJobDbId');
                        if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
                        window.isTriggering = false;
                        setDiarizationBusyState(false);
                        localStorage.removeItem('activeJobId');
                        stopProcessingStateUI();
                        hideProgressBar();
                        if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                    }
                    } finally {
                        cleanupUploadMonitors();
                    }
                };

                xhr.onerror = () => {
                    qsUploadTrace('s3_put_xhr_network_error', { jobId });
                    console.error("XHR Network Error during upload.");
                    cleanupUploadMonitors();
                    const dbId = localStorage.getItem('lastJobDbId');
                    if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
                    window.isTriggering = false;
                    setDiarizationBusyState(false);
                    localStorage.removeItem('activeJobId');
                    stopProcessingStateUI();
                    hideProgressBar();
                };

                xhr.onabort = () => {
                    qsUploadTrace('s3_put_aborted', { jobId });
                    cleanupUploadMonitors();
                };

                uploadPhase = 's3_put';
                xhr.send(currentFile);

            }
            catch (err) {
                console.error("Upload Error:", err);
                window.isTriggering = false;
                setDiarizationBusyState(false);
                localStorage.removeItem('activeJobId');
                stopProcessingStateUI();
                hideProgressBar();
                if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                if (typeof showStatus === 'function') showStatus((typeof window.t === 'function' ? window.t('error_starting_upload') : "Error starting upload."), true);
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

function renderTranscriptFromCues(cues) {
    window.currentSegments = cues;
    const container = document.getElementById('transcript-window');
    if (!container) return;
    const locale = String(window.currentLocale || localStorage.getItem('locale') || 'he').toLowerCase();
    const isRtl = locale.startsWith('he') || locale.startsWith('ar');
    const textDirection = isRtl ? 'rtl' : 'ltr';
    const textAlign = isRtl ? 'right' : 'left';
    if (!cues || cues.length === 0) {
        container.innerHTML = `
            <div style="color:#6b7280; text-align:center; margin-top:40px; line-height:1.9;">
                <div style="font-weight:600;">🎥 וידאו</div>
                <div style="font-size:0.9em; color:#9ca3af;">MP4, MOV, WEBM, M4V, MKV, AVI</div>
                <div style="font-weight:600; margin-top:4px;">🎙️ אודיו</div>
                <div style="font-size:0.9em; color:#9ca3af;">M4A, MP3, WAV, AAC, OGG, FLAC</div>
                <div style="font-weight:600; margin-top:4px;">📁 קובץ</div>
                <div>בחר וידאו או אודיו כדי להתחיל</div>
            </div>
        `;
        return;
    }
    // Legacy rendering path for cue-only transcripts (no word timestamps).
    const html = cues.map((c, idx) => {
        const mainText = String(c.translated_text || c.text || '').trim();
        const safe = mainText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `
        <div class="paragraph-row" id="seg-${Math.floor(c.start)}" style="display:block; margin-bottom: 0.1em; direction: ${textDirection}; text-align: ${textAlign};">
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

function reflowCaptionsByMaxChars(words, captions, maxChars = 27) {
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
        renderTranscriptFromCues(window.currentSegments || []);
        return;
    }

    const locale = String(window.currentLocale || localStorage.getItem('locale') || 'he').toLowerCase();
    const isRtl = locale.startsWith('he') || locale.startsWith('ar');
    const textDirection = isRtl ? 'rtl' : 'ltr';
    const textAlign = isRtl ? 'right' : 'left';
    const isEditing = container.classList.contains('transcript-editing');
    const timingAdjustEnabled = !isMobileClient();
    container.classList.toggle('qs-rtl', !!isRtl);

    function clampWordTiming(index, nextStart, prevEnd, newStart, newEnd) {
        const w = window.currentWords && window.currentWords[index];
        if (!w) return null;
        const MIN_DUR = 0.05;
        let start = Number.isFinite(newStart) ? newStart : w.start;
        let end = Number.isFinite(newEnd) ? newEnd : w.end;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        // basic order
        if (end < start + MIN_DUR) end = start + MIN_DUR;
        // clamp against neighbors (non-overlap)
        if (Number.isFinite(prevEnd) && start < prevEnd) start = prevEnd;
        if (Number.isFinite(nextStart) && end > nextStart) end = nextStart;
        // re-check duration after clamps
        if (end < start + MIN_DUR) {
            // if squeezed, push end if possible, else pull start
            if (Number.isFinite(nextStart)) {
                end = Math.min(nextStart, start + MIN_DUR);
            } else {
                end = start + MIN_DUR;
            }
            if (Number.isFinite(prevEnd) && start > end - MIN_DUR) start = Math.max(prevEnd, end - MIN_DUR);
        }
        // avoid negative
        start = Math.max(0, start);
        end = Math.max(start + MIN_DUR, end);
        return { start, end };
    }

    function getNeighborBounds(index) {
        const prev = (window.currentWords && window.currentWords[index - 1]) || null;
        const next = (window.currentWords && window.currentWords[index + 1]) || null;
        return {
            prevEnd: prev && Number.isFinite(prev.end) ? prev.end : null,
            nextStart: next && Number.isFinite(next.start) ? next.start : null,
        };
    }

    // Timing UI selection:
    // - Caption mode: { type: 'caption', ci }
    // - Boundary mode: { type: 'boundary', boundaryIndex } where boundaryIndex is BEFORE words[boundaryIndex]
    if (!window._qsTimingHandle) window._qsTimingHandle = null;
    const QS_STEP = 0.05; // 50ms
    const QS_MIN_DUR = 0.05;

    function _clearTimingSelectionUI() {
        container.querySelectorAll('.qs-handle-start,.qs-handle-end,.qs-sel-caption').forEach(el => {
            el.classList.remove('qs-handle-start', 'qs-handle-end', 'qs-sel-caption');
        });
        container.querySelectorAll('.qs-boundary-pipe').forEach(el => {
            try { el.remove(); } catch (_) {}
        });
        container.querySelectorAll('.qs-timing-inline').forEach(el => {
            el.textContent = '';
            el.style.display = 'none';
        });
    }

    function _getCaptionByIndex(ci) {
        return (window.currentCaptions && Number.isFinite(ci)) ? window.currentCaptions[ci] : null;
    }
    function _getWordByIndex(wi) {
        return (window.currentWords && Number.isFinite(wi)) ? window.currentWords[wi] : null;
    }

    function _captionIndexForTimingHandle(sel) {
        if (!sel) return null;
        if (sel.type === 'caption') return sel.ci;
        if (sel.type === 'boundary' && window.currentCaptions) {
            const k = sel.boundaryIndex;
            for (let i = 0; i < window.currentCaptions.length; i++) {
                const c = window.currentCaptions[i];
                if (k > c.wordStartIndex && k <= c.wordEndIndex + 1) return i;
            }
        }
        return null;
    }

    function _updateTimingOverlay() {
        const sel = window._qsTimingHandle;
        container.querySelectorAll('.qs-timing-inline').forEach(el => {
            el.textContent = '';
            el.style.display = 'none';
        });
        if (!sel) return;

        let text = '';
        if (sel.type === 'caption') {
            const cap = _getCaptionByIndex(sel.ci);
            const ws = cap ? _getWordByIndex(cap.wordStartIndex) : null;
            const we = cap ? _getWordByIndex(cap.wordEndIndex) : null;
            if (ws && we) text = `${formatTime(ws.start)} – ${formatTime(we.end)}`;
        } else if (sel.type === 'boundary') {
            const k = sel.boundaryIndex;
            const prev = _getWordByIndex(k - 1);
            const next = _getWordByIndex(k);
            if (prev && next) text = `@ ${formatTime(prev.end)}`;
        }

        const ci = _captionIndexForTimingHandle(sel);
        if (Number.isFinite(ci)) {
            const row = container.querySelector(`.caption-row[data-ci="${ci}"]`);
            const disp = row && row.querySelector('.qs-timing-inline');
            if (disp && text) {
                disp.textContent = text;
                disp.style.display = 'inline';
            }
        }
    }

    function _updateNudgeButtonsState() {
        const sel = window._qsTimingHandle;
        if (!sel || !window.currentWords || !window.currentCaptions) {
            container.querySelectorAll('button.qs-nudge-btn[data-nudge]').forEach(b => {
                b.disabled = false;
                b.style.opacity = '1';
            });
            return;
        }

        const can = (delta) => {
            if (_isMultiSelectActive()) return false;
            const words = window.currentWords;
            if (sel.type === 'caption') {
                const cap = _getCaptionByIndex(sel.ci);
                if (!cap) return false;
                const startWi = cap.wordStartIndex;
                const endWi = cap.wordEndIndex;
                const first = words[startWi];
                const last = words[endWi];
                if (!first || !last) return false;
                const prev = startWi > 0 ? words[startWi - 1] : null;
                const next = (endWi + 1) < words.length ? words[endWi + 1] : null;
                let minDelta = prev ? (prev.end - first.start) : -Infinity;
                let maxDelta = next ? (next.start - last.end) : Infinity;
                minDelta = Math.max(minDelta, -first.start);
                const clampedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
                return Math.abs(clampedDelta) > 1e-9;
            }
            if (sel.type === 'boundary') {
                const k = sel.boundaryIndex;
                const prev = words[k - 1];
                const next = words[k];
                if (!prev || !next) return false;
                const boundary = prev.end;
                const proposed = boundary + delta;
                const minB = prev.start + QS_MIN_DUR;
                const maxB = next.end - QS_MIN_DUR;
                if (proposed < minB - 1e-9) return false;
                if (proposed > maxB + 1e-9) return false;
                return true;
            }
            return false;
        };

        container.querySelectorAll('.qs-caption-toolbar').forEach(toolbar => {
            const btnLeft = toolbar.querySelector('button.qs-nudge-btn[data-nudge="later"]');
            const btnRight = toolbar.querySelector('button.qs-nudge-btn[data-nudge="earlier"]');
            if (!btnLeft || !btnRight) return;
            const leftDir = btnLeft.getAttribute('data-nudge') === 'earlier' ? -QS_STEP : +QS_STEP;
            const rightDir = btnRight.getAttribute('data-nudge') === 'earlier' ? -QS_STEP : +QS_STEP;
            btnLeft.disabled = !can(leftDir);
            btnRight.disabled = !can(rightDir);
            btnLeft.style.opacity = btnLeft.disabled ? '0.45' : '1';
            btnRight.style.opacity = btnRight.disabled ? '0.45' : '1';
        });
    }

    function setTimingHandle(sel) {
        if (!timingAdjustEnabled && sel) {
            sel = null;
        }
        window._qsTimingHandle = sel;
        _clearTimingSelectionUI();
        if (!sel) {
            _updateTimingOverlay();
            _updateNudgeButtonsState();
            return;
        }

        if (sel.type === 'caption') {
            const row = container.querySelector(`.caption-row[data-ci="${sel.ci}"]`);
            if (row) row.classList.add('qs-sel-caption');
        } else if (sel.type === 'boundary') {
            const k = sel.boundaryIndex;
            // Insert a visible '|' between the two words (inline, not painted words).
            try {
                if (!Number.isFinite(k) || k <= 0 || !window.currentWords || k >= window.currentWords.length) {
                    // no boundary at edges
                } else {
                    const nextTok = container.querySelector(`span.word-token[data-wi="${k}"]`);
                    const prevTok = container.querySelector(`span.word-token[data-wi="${k - 1}"]`);
                    const host = (nextTok || prevTok) ? (nextTok || prevTok).closest('.caption-text') : null;
                    if (host) {
                        const pipe = document.createElement('span');
                        pipe.className = 'qs-boundary-pipe';
                        pipe.textContent = '|';
                        // Put pipe before next word (boundary BEFORE words[k])
                        if (nextTok) host.insertBefore(pipe, nextTok);
                        else host.appendChild(pipe);
                    }
                }
            } catch (_) {}
        }

        _updateTimingOverlay();
        _updateNudgeButtonsState();
    }

    function nudgeHandle(delta) {
        const sel = window._qsTimingHandle;
        if (!sel || !window.currentWords) return false;
        const step = Math.round(Number(delta) / QS_STEP) * QS_STEP;
        if (!Number.isFinite(step) || Math.abs(step) < 1e-9) return false;

        let changed = false;

        if (sel.type === 'caption') {
            const cap = _getCaptionByIndex(sel.ci);
            if (!cap) return false;
            const startWi = cap.wordStartIndex;
            const endWi = cap.wordEndIndex;
            const first = window.currentWords[startWi];
            const last = window.currentWords[endWi];
            if (!first || !last) return false;
            const prev = startWi > 0 ? window.currentWords[startWi - 1] : null;
            const next = (endWi + 1) < window.currentWords.length ? window.currentWords[endWi + 1] : null;
            let minDelta = prev ? (prev.end - first.start) : -Infinity;
            let maxDelta = next ? (next.start - last.end) : Infinity;
            minDelta = Math.max(minDelta, -first.start);
            const clampedDelta = Math.max(minDelta, Math.min(maxDelta, step));
            if (Math.abs(clampedDelta) < 1e-9) return false;
            for (let wi = startWi; wi <= endWi; wi++) {
                const w = window.currentWords[wi];
                if (!w) continue;
                w.start = Math.round((w.start + clampedDelta) * 1000) / 1000;
                w.end = Math.round((w.end + clampedDelta) * 1000) / 1000;
            }
            changed = true;
        } else if (sel.type === 'boundary') {
            const k = sel.boundaryIndex;
            if (k <= 0 || k >= window.currentWords.length) return false;
            const prev = window.currentWords[k - 1];
            const next = window.currentWords[k];
            if (!prev || !next) return false;
            const boundary = prev.end;
            const proposed = boundary + step;
            const minB = prev.start + QS_MIN_DUR;
            const maxB = next.end - QS_MIN_DUR;
            const clampedB = Math.max(minB, Math.min(maxB, proposed));
            if (Math.abs(clampedB - boundary) < 1e-9) return false;
            prev.end = Math.round(clampedB * 1000) / 1000;
            next.start = Math.round(clampedB * 1000) / 1000;
            changed = true;
        } else {
            return false;
        }

        if (!changed) return false;

        window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
        if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();

        _updateTimingOverlay();
        _updateNudgeButtonsState();

        // Pulse the affected item.
        try {
            if (sel.type === 'caption') {
                const row = container.querySelector(`.caption-row[data-ci="${sel.ci}"]`);
                if (row) {
                    row.classList.remove('qs-handle-flash');
                    row.classList.add('qs-handle-flash');
                    setTimeout(() => { try { row.classList.remove('qs-handle-flash'); } catch (_) {} }, 320);
                }
            } else {
                const prevTok = container.querySelector(`span.word-token[data-wi="${sel.boundaryIndex - 1}"]`);
                const nextTok = container.querySelector(`span.word-token[data-wi="${sel.boundaryIndex}"]`);
                [prevTok, nextTok].forEach(t => {
                    if (!t) return;
                    t.classList.remove('qs-handle-flash');
                    t.classList.add('qs-handle-flash');
                    setTimeout(() => { try { t.classList.remove('qs-handle-flash'); } catch (_) {} }, 320);
                });
            }
        } catch (_) {}

        // Show "Moving..." bubble while dragging (pointer hold handler already sets it).
        return true;
    }

    function syncInlineStylePanel(ci) {
        if (!Number.isFinite(ci)) return;
        const panel = container.querySelector(`.qs-inline-style-panel[data-ci="${ci}"]`);
        if (!panel || typeof window.getResolvedCaptionStyle !== 'function') return;
        const st = window.getResolvedCaptionStyle(ci);
        panel.querySelectorAll('.qs-pos-seg .qs-inline-seg-btn').forEach(b => {
            b.classList.toggle('is-selected', b.getAttribute('data-pos') === st.position);
        });
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
                const title = (typeof wStart === 'number' && typeof wEnd === 'number') ? `${wStart.toFixed(2)} → ${wEnd.toFixed(2)}` : '';
                const hl = w && w.highlighted ? '1' : '0';
                return `<span class="word-token" contenteditable="false" tabindex="0" data-wi="${wi}" data-highlighted="${hl}" data-empty="${isEmpty ? '1' : '0'}" data-start="${wStart}" data-end="${wEnd}" title="${title}" style="display:inline-block; min-width:0.8ch;">${display}</span>`;
            })
            .join(' ');
        const posLabelMap = { bottom: 'תחתון', middle: 'אמצע', top: 'עליון' };
        const posSeg = ['bottom', 'middle', 'top'].map(p =>
            `<button type="button" class="qs-inline-seg-btn" data-pos="${p}">${posLabelMap[p] || p}</button>`
        ).join('');
        const styleTooltip = 'עיצוב שורה. גררו כדי לבחור כמה שורות.';
        const toolbarHtml = (isEditing && timingAdjustEnabled) ? `
            <div class="qs-caption-toolbar" style="display:flex;align-items:center;gap:6px;flex-shrink:0;opacity:0;transition:opacity .12s ease;">
              <span class="qs-timing-inline" style="display:none;font-size:10px;color:#6b7280;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;"></span>
              <button type="button" class="qs-nudge-btn" data-nudge="later" title="Later">←</button>
              <button type="button" class="qs-nudge-btn" data-nudge="earlier" title="Earlier">→</button>
              <button type="button" class="qs-style-btn" data-ci="${ci}" title="${styleTooltip}" aria-label="${styleTooltip}">🎨</button>
            </div>` : '';
        const panelHtml = isEditing ? `
            <div class="qs-inline-style-panel" data-ci="${ci}" style="display:none;width:100%;padding:10px 12px;border-radius:10px;background:#f9fafb;border:1px solid #e5e7eb;margin-top:6px;box-sizing:border-box;">
              <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
                <span style="font-size:11px;color:#6b7280;width:64px;">מיקום</span>
                <div class="qs-inline-seg qs-pos-seg" data-ci="${ci}" style="display:flex;gap:4px;flex-wrap:wrap;">${posSeg}</div>
              </div>
            </div>` : '';
        return `
          <div class="caption-row" data-ci="${ci}" data-start="${start}" style="margin-bottom:2px; direction:${textDirection}; text-align:${textAlign}; display:flex; flex-direction:column; align-items:stretch;">
            <div class="caption-row-main" style="display:flex; flex-direction:column; gap:0; align-items:stretch;">
              <div class="caption-ts" style="font-size:0.74em; color:#9ca3af; white-space:nowrap; line-height:1.05; margin-bottom:0;">${formatTime(start)}</div>
              <div class="caption-row-body" style="display:flex; gap:10px; align-items:flex-start; margin-top:0;">
                <div class="caption-text" ${isEditing ? 'contenteditable="true" spellcheck="false"' : ''} style="margin:0 !important; padding:0; line-height:1.2; flex:1;">${tokenHtml}</div>
                ${toolbarHtml}
              </div>
            </div>
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
            outline: 2px solid rgba(59,130,246,0.85);
            background: rgba(59,130,246,0.08);
            border-radius: 4px;
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
          #transcript-window .caption-ts {
            margin: 0 !important;
            padding: 0 !important;
            line-height: 1 !important;
          }
          #transcript-window .caption-row-body {
            margin-top: 0 !important;
            padding-top: 0 !important;
            align-items: flex-start !important;
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
          #transcript-window.transcript-editing .caption-row:hover {
            background: rgba(0,0,0,0.03);
            border-radius: 10px;
          }
          #transcript-window.transcript-editing .caption-row:hover .qs-caption-toolbar,
          #transcript-window.transcript-editing .caption-row.qs-line-selected .qs-caption-toolbar {
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
          #transcript-window .qs-caption-toolbar .qs-nudge-btn {
            width: 32px;
            height: 30px;
            border: none;
            background: rgba(255,255,255,0.95);
            border-radius: 10px;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            box-shadow: 0 4px 14px rgba(0,0,0,0.08);
            padding: 0;
          }
          #transcript-window .qs-caption-toolbar .qs-nudge-btn:hover { background: rgba(243,244,246,1); }
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
          #transcript-window[data-multi-select="1"] .caption-row.qs-line-selected .qs-nudge-btn {
            display: none;
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
    container.onclick = (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.caption-row') : null;
        if (!row) return;
        // Do not auto-jump/play while editing.
        if (isEditing) return;
        // If user clicked a token, let them edit; otherwise jump.
        if (e.target && e.target.closest && e.target.closest('span.word-token')) return;
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
    function beginTokenEdit(tokenEl, options = {}) {
        const wi = parseInt(tokenEl.getAttribute('data-wi'), 10);
        if (!Number.isFinite(wi) || !window.currentWords || !window.currentWords[wi]) return;
        if (tokenEl.classList.contains('editing')) return;
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
        input.style.border = '1px solid rgba(59,130,246,0.7)';
        input.style.borderRadius = '4px';
        input.style.padding = '0 6px';
        input.style.margin = '0';
        input.style.background = 'rgba(255,255,255,0.95)';
        input.style.direction = tokenEl.closest('.caption-row')?.style?.direction || '';
        input.style.boxSizing = 'content-box';
        input.style.letterSpacing = 'normal';
        input.style.textIndent = '0';
        input.style.width = Math.max(28, (Math.max(1, input.value.length) * 11)) + 'px';
        input.style.minWidth = '28px';

        tokenEl.innerHTML = '';
        tokenEl.appendChild(input);
        setTimeout(() => {
            try {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            } catch (_) {}
        }, 0);

        const commit = () => {
            const raw = String(input.value || '').trim();
            const parts = raw.split(/\s+/).filter(Boolean);
            const allWords = Array.isArray(window.currentWords) ? window.currentWords : [];
            const capIndex = Array.isArray(window.currentCaptions)
                ? window.currentCaptions.findIndex((c) => wi >= c.wordStartIndex && wi <= c.wordEndIndex)
                : -1;
            const cap = (capIndex >= 0 && window.currentCaptions) ? window.currentCaptions[capIndex] : null;
            const capEndWi = cap ? cap.wordEndIndex : wi;
            const maxSlots = Math.max(1, capEndWi - wi + 1);

            if (!parts.length) {
                window.currentWords[wi].text = '';
                tokenEl.innerHTML = '&nbsp;';
                tokenEl.setAttribute('data-empty', '1');
                tokenEl.classList.remove('editing');
                window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
                if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
                setActiveToken(tokenEl);
                return;
            }

            // Allow typing multiple words with spaces; map them to consecutive timed words.
            // This preserves existing timings and never inserts extra timing slots.
            const usable = parts.slice(0, maxSlots);
            for (let i = 0; i < usable.length; i++) {
                const tgtWi = wi + i;
                if (!window.currentWords[tgtWi]) break;
                window.currentWords[tgtWi].text = usable[i];
            }

            // Overflow handling: create new timed words in the gap before next caption,
            // then use append-to-last only for any remaining overflow.
            if (parts.length > usable.length && usable.length > 0 && cap && Array.isArray(window.currentCaptions)) {
                const overflowParts = parts.slice(usable.length);
                const lastInCap = allWords[cap.wordEndIndex];
                const nextCap = window.currentCaptions[capIndex + 1] || null;
                const nextFirst = nextCap ? allWords[nextCap.wordStartIndex] : null;
                const gapStart = lastInCap && Number.isFinite(Number(lastInCap.end)) ? Number(lastInCap.end) : null;
                const gapEnd = nextFirst && Number.isFinite(Number(nextFirst.start)) ? Number(nextFirst.start) : null;
                const MIN_DUR = 0.05;
                let canCreate = 0;
                if (Number.isFinite(gapStart) && Number.isFinite(gapEnd) && gapEnd > gapStart + MIN_DUR) {
                    canCreate = Math.floor((gapEnd - gapStart) / MIN_DUR);
                } else if (Number.isFinite(gapStart) && !Number.isFinite(gapEnd)) {
                    // Last caption: allow creating timed words by extending timeline.
                    canCreate = overflowParts.length;
                }
                const createCount = Math.max(0, Math.min(overflowParts.length, canCreate));
                if (createCount > 0) {
                    const insertAt = cap.wordEndIndex + 1;
                    let start = Number(gapStart);
                    let step = 0.24;
                    if (Number.isFinite(gapEnd) && gapEnd > start) {
                        step = Math.max(MIN_DUR, (gapEnd - start) / createCount);
                    }
                    const newWords = [];
                    for (let i = 0; i < createCount; i++) {
                        let s = start + (i * step);
                        let e = s + step;
                        if (Number.isFinite(gapEnd)) {
                            const remaining = gapEnd - s;
                            const maxE = gapEnd - Math.max(0, (createCount - i - 1) * MIN_DUR);
                            e = Math.min(maxE, s + Math.max(MIN_DUR, remaining));
                            if (e < s + MIN_DUR) e = s + MIN_DUR;
                        }
                        newWords.push({
                            id: `w${Date.now()}_${i}`,
                            text: overflowParts[i],
                            start: s,
                            end: e,
                            highlighted: false
                        });
                    }
                    allWords.splice(insertAt, 0, ...newWords);
                    cap.wordEndIndex += newWords.length;
                    for (let ci = capIndex + 1; ci < window.currentCaptions.length; ci++) {
                        const c = window.currentCaptions[ci];
                        c.wordStartIndex += newWords.length;
                        c.wordEndIndex += newWords.length;
                    }
                }

                const stillOverflow = overflowParts.slice(createCount);
                if (stillOverflow.length) {
                    const lastWi = cap.wordEndIndex;
                    if (window.currentWords[lastWi]) {
                        window.currentWords[lastWi].text = `${window.currentWords[lastWi].text} ${stillOverflow.join(' ')}`.trim();
                    }
                }
            }

            tokenEl.classList.remove('editing');
            window.currentSegments = _captionsToCues(window.currentWords, window.currentCaptions);
            renderWordCaptionEditor();
            if (typeof window.refreshVideoSubtitles === 'function') window.refreshVideoSubtitles();
            const focusWi = wi + Math.max(0, usable.length - 1);
            const focusEl = container.querySelector(`span.word-token[data-wi="${focusWi}"]`);
            if (focusEl) setActiveToken(focusEl);
        };
        input.onblur = commit;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); return; }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                try {
                    if (tokenEl && tokenEl.isConnected) {
                        try { if (tokenEl.contains(input)) tokenEl.removeChild(input); } catch (_) {}
                        tokenEl.innerHTML = (currentVal.trim().length ? currentVal.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '&nbsp;');
                        tokenEl.classList.remove('editing');
                        setActiveToken(tokenEl);
                    }
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
            e.stopPropagation();
            setActiveToken(el);
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
                // Keep line timing handle behavior on click.
                if (timingAdjustEnabled && Number.isFinite(ci)) {
                    if (_isMultiSelectActive()) {
                        setTimingHandle(null);
                    } else {
                        setActiveRow(ci, { user: true });
                        setTimingHandle({ type: 'caption', ci });
                    }
                }
                // Character-level editing UX: single click enters token edit directly.
                // This avoids the "caret only between words" feeling.
                if (!e.shiftKey && !el.classList.contains('editing')) {
                    e.preventDefault();
                    beginTokenEdit(el);
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
            let ci = null;
            try {
                const row = el.closest('.caption-row');
                ci = row ? parseInt(row.getAttribute('data-ci'), 10) : null;
                if (Number.isFinite(ci) && typeof setActiveRow === 'function') setActiveRow(ci, { user: true });
            } catch (_) {}
            if (timingAdjustEnabled && e.shiftKey) {
                // Shift+double-click: boundary timing (visual side → logical boundary).
                try {
                    const r = el.getBoundingClientRect();
                    const clickX = e.clientX - r.left;
                    const isVisualStart = isRtl ? (clickX > (r.width / 2)) : (clickX < (r.width / 2));
                    const wi = parseInt(el.getAttribute('data-wi'), 10);
                    const boundaryIndex = isVisualStart ? wi : (wi + 1);
                    setTimingHandle({ type: 'boundary', boundaryIndex });
                } catch (_) {}
                return;
            }
            // Highlight feature removed.
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
        const live = container.querySelector('#qs-nudge-feedback-live');
        if (live) live.style.display = 'none';
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
            if (_isMultiSelectActive()) {
                window._qsTimingHandle = null;
            }
        }
        _updateTimingOverlay();
        _updateNudgeButtonsState();
        if (!isEditing) return;
        const rowRef = container.querySelector(`.caption-row[data-ci="${Number.isFinite(ci) ? ci : window._qsUserSelectedRowCi}"]`)
            || container.querySelector('.caption-row.qs-line-selected');
        const live = container.querySelector('#qs-nudge-feedback-live');
        if (live && rowRef) {
            const rowRect = rowRef.getBoundingClientRect();
            const contRect = container.getBoundingClientRect();
            live.style.top = `${(rowRect.bottom - contRect.top) + 6}px`;
            live.style.left = '12px';
        }
    }

    if (isEditing) {
        container.style.position = 'relative';
        try { const old = document.getElementById('qs-nudge-float'); if (old) old.remove(); } catch (_) {}
        try { container.querySelector('#qs-nudge-in-editor')?.remove(); } catch (_) {}
        window._qsRowDragMoved = false;

        if (!window._qsTimingHandle && window.currentCaptions && window.currentCaptions.length) {
            setTimingHandle({ type: 'caption', ci: 0 });
        }
        if (Number.isFinite(window._qsUserSelectedRowCi) && window.currentCaptions &&
            (window._qsUserSelectedRowCi < 0 || window._qsUserSelectedRowCi >= window.currentCaptions.length)) {
            window._qsUserSelectedRowCi = null;
        }
        if (Number.isFinite(window._qsStylePanelOpenCi) && window.currentCaptions &&
            (window._qsStylePanelOpenCi < 0 || window._qsStylePanelOpenCi >= window.currentCaptions.length)) {
            window._qsStylePanelOpenCi = null;
        }

        let liveFb = container.querySelector('#qs-nudge-feedback-live');
        if (!liveFb) {
            liveFb = document.createElement('div');
            liveFb.id = 'qs-nudge-feedback-live';
            liveFb.textContent = '—';
            container.appendChild(liveFb);
        }

        if (!container._qsInlineNudgePtrBound) {
            container._qsInlineNudgePtrBound = true;
            let nudgeRepeat = null;
            const stopNudgeRepeat = () => {
                if (nudgeRepeat) clearInterval(nudgeRepeat);
                nudgeRepeat = null;
            };
            container.addEventListener('pointerdown', (e) => {
                const b = e.target && e.target.closest ? e.target.closest('button.qs-nudge-btn[data-nudge]') : null;
                if (!b || !container.contains(b)) return;
                if (_isMultiSelectActive()) return;
                e.preventDefault();
                e.stopPropagation();
                const n = b.getAttribute('data-nudge');
                const apply = () => {
                    if (n === 'earlier') return nudgeHandle(-QS_STEP);
                    if (n === 'later') return nudgeHandle(+QS_STEP);
                    return false;
                };
                apply();
                stopNudgeRepeat();
                nudgeRepeat = setInterval(() => {
                    const ok = apply();
                    if (!ok) stopNudgeRepeat();
                }, 50);
                try { b.setPointerCapture(e.pointerId); } catch (_) {}
            }, true);
            container.addEventListener('pointerup', stopNudgeRepeat);
            container.addEventListener('pointercancel', stopNudgeRepeat);
            try {
                if (window._qsNudgeGlobalPointerUpHandler) window.removeEventListener('pointerup', window._qsNudgeGlobalPointerUpHandler);
                window._qsNudgeGlobalPointerUpHandler = stopNudgeRepeat;
                window.addEventListener('pointerup', stopNudgeRepeat);
            } catch (_) {}
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
                        setTimingHandle({ type: 'caption', ci: cci });
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
                const t = e.target;
                const onStyleBtn = !!(t && t.closest && t.closest('.qs-style-btn'));
                if (t && t.closest && (t.closest('.qs-inline-style-panel') || t.closest('span.word-token') || t.closest('input.qs-token-input'))) return;
                if (!onStyleBtn && t && t.closest && t.closest('.qs-caption-toolbar')) return;
                // On touch devices, allow native pan/scroll in the transcript window.
                // We still set active row, but avoid drag-selection and preventDefault.
                if (isTouchPointer) {
                    if (e.shiftKey) {
                        setActiveRow(ci, { user: true, range: true });
                        setTimingHandle(null);
                    } else {
                        setActiveRow(ci, { user: true });
                        setTimingHandle({ type: 'caption', ci });
                    }
                    return;
                }
                window._qsRowDragSelecting = true;
                window._qsRowDragStartCi = ci;
                window._qsRowDragMoved = false;
                if (e.shiftKey) {
                    setActiveRow(ci, { user: true, range: true });
                    setTimingHandle(null);
                } else {
                    setActiveRow(ci, { user: true });
                    setTimingHandle({ type: 'caption', ci });
                }
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
                    setTimingHandle(range.length > 1 ? null : { type: 'caption', ci });
                }
            });
            rowEl.addEventListener('mouseleave', (e) => {
                const tb = rowEl.querySelector('.qs-caption-toolbar');
                const rt = e && e.relatedTarget ? e.relatedTarget : null;
                if (tb && rt && tb.contains(rt)) return;
                rowEl.classList.remove('qs-hover-line');
                _updateTimingOverlay();
                _updateNudgeButtonsState();
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
            if (t.closest('.caption-ts')) return;
            if (t.closest('.qs-caption-toolbar') || t.closest('.qs-inline-style-panel')) return;
            const rowEl = t.closest('.caption-row');
            if (!rowEl) return;
            const ci = parseInt(rowEl.getAttribute('data-ci'), 10);
            if (!Number.isFinite(ci)) return;
            if (e.shiftKey) {
                setActiveRow(ci, { user: true, range: true });
                setTimingHandle(null);
            } else {
                setActiveRow(ci, { user: true });
                setTimingHandle(_isMultiSelectActive() ? null : { type: 'caption', ci });
            }
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
        _updateTimingOverlay();
        _updateNudgeButtonsState();
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
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
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