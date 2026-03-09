import { supabase } from './supabaseClient.js'

// --- GLOBAL STATE ---
window.isTriggering = false;
window.aiDiarizationRan = false;
window.fakeProgressInterval = null;
window.currentSegments = [];
window.originalFileName = "transcript";
window.hasMultipleSpeakers = false;
let isSignUpMode = true;

/** Start polling check_status and trigger_status for a job (used after trigger and on retry). */
window.startJobStatusPolling = function(jobId) {
    if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
    const pollMs = 4000;
    const maxPolls = 150; // ~10 min
    let polls = 0;
    window._checkStatusPollInterval = setInterval(async () => {
        polls++;
        if (polls > maxPolls || !localStorage.getItem('activeJobId')) {
            if (window._checkStatusPollInterval) clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
            if (polls > maxPolls && localStorage.getItem('activeJobId') === jobId) {
                window.isTriggering = false;
                if (window.fakeProgressInterval) { clearInterval(window.fakeProgressInterval); window.fakeProgressInterval = null; }
                const msg = typeof document.documentElement.lang !== 'undefined' && String(document.documentElement.lang).toLowerCase().startsWith('he')
                    ? 'העיבוד ארך יותר מדי או נכשל בשרת. נסה שוב.' : 'Job timed out or may have failed on the server. Try again.';
                if (typeof showStatus === 'function') showStatus(msg, true, { retryTrigger: true });
            }
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
                        if (typeof showStatus === 'function') showStatus(msg, true, { retryTrigger: true });
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
                            const retryMsg = typeof document.documentElement.lang !== 'undefined' && String(document.documentElement.lang).toLowerCase().startsWith('he')
                                ? 'הפעלה מחדש...' : 'Retrying trigger...';
                            if (typeof showStatus === 'function') showStatus(retryMsg, false);
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
            window.location.replace(window.location.pathname + window.location.search);
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
                    <button type="button" class="personal-dialog-btn primary danger"></button>
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
        cancelBtn.onclick = () => cleanup(false);
        okBtn.onclick = () => cleanup(true);
        overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    });
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
    const d = new Date(0); d.setSeconds(s);
    return d.toISOString().substr(14, 5);
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

function showStatus(message, isError = false, options = {}) {
    let toast = document.getElementById('toast-container');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-container';
        toast.className = 'toast-notification';
        document.body.appendChild(toast);
    }

    toast.textContent = '';
    toast.appendChild(document.createTextNode(message));
    toast.classList.toggle('toast-error', isError);
    toast.classList.add('show');

    if (options.retryTrigger && typeof window.retryTriggerForActiveJob === 'function') {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'toast-retry-btn';
        retryBtn.textContent = (typeof document.documentElement.lang !== 'undefined' && String(document.documentElement.lang).toLowerCase().startsWith('he')) ? 'נסה שוב' : 'Retry';
        retryBtn.addEventListener('click', () => {
            toast.classList.remove('show');
            window.retryTriggerForActiveJob();
        });
        toast.appendChild(document.createTextNode(' '));
        toast.appendChild(retryBtn);
    }

    const hideDelay = options.retryTrigger ? 15000 : 4000;
    if (toast._hideTimeout) clearTimeout(toast._hideTimeout);
    toast._hideTimeout = setTimeout(() => {
        toast.classList.remove('show');
        toast._hideTimeout = null;
    }, hideDelay);
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

const PERSONAL_DISPLAY_NAMES_KEY = 'qs_personal_display_names';

async function initPersonalPage() {
    const guestMsg = document.getElementById('personal-guest-msg');
    const tableWrap = document.getElementById('personal-table-wrap');
    const emptyMsg = document.getElementById('personal-empty-msg');
    const tableContainer = document.getElementById('personal-table-container');
    const tbody = document.getElementById('personal-files-tbody');
    const closeBtn = document.getElementById('personal-close-btn');
    if (!tbody) return;

    if (closeBtn) {
        const lastJobDbId = localStorage.getItem('lastJobDbId');
        closeBtn.href = lastJobDbId ? ('/?open=' + encodeURIComponent(lastJobDbId)) : '/';
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        if (guestMsg) guestMsg.style.display = 'block';
        if (tableWrap) tableWrap.style.display = 'block';
        return;
    }

    tableWrap.style.display = 'block';
    const { data: jobs, error } = await supabase
        .from('jobs')
        .select('id, status, input_s3_key, created_at, type, result_s3_key')
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

    tableContainer.style.display = 'block';
    function displayNameFromKey(key) {
        if (!key) return 'file';
        const raw = key.split('/').pop() || key;
        return raw.replace(/^job_\d+_/, '') || raw;
    }
    const UPLOADED_TIME_OFFSET_HOURS = -2;
    function formatDate(iso) {
        try {
            let d = new Date(iso);
            if (isNaN(d.getTime())) return iso || '';
            if (UPLOADED_TIME_OFFSET_HOURS !== 0) {
                d = new Date(d.getTime() + UPLOADED_TIME_OFFSET_HOURS * 60 * 60 * 1000);
            }
            return d.toLocaleDateString(undefined, { dateStyle: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { timeStyle: 'short' });
        } catch (_) { return iso || ''; }
    }
    function statusLabel(s) {
        const t = typeof window.t === 'function' ? window.t : (k) => k;
        if (s === 'post-processed') return t('status_post_processed') || 'עבר עיבוד';
        if (s === 'processed' || s === 'completed') return t('status_processed') || 'הושלם';
        if (s === 'processing') return t('status_processing') || 'מעבד';
        if (s === 'failed') return t('status_failed') || 'נכשל';
        if (s === 'uploaded') return t('status_uploaded') || 'הועלה';
        return s || '—';
    }
    let displayNames = {};
    try {
        const stored = localStorage.getItem(PERSONAL_DISPLAY_NAMES_KEY);
        if (stored) displayNames = JSON.parse(stored);
    } catch (_) {}

    const T = (k) => (typeof window.t === 'function' ? window.t(k) : k);

    const personalDialogMarkup = `
        <div class="personal-dialog" role="dialog" aria-modal="true">
            <p class="personal-dialog-message"></p>
            <input class="personal-dialog-input" type="text" />
            <div class="personal-dialog-actions">
                <button type="button" class="personal-dialog-btn cancel"></button>
                <button type="button" class="personal-dialog-btn primary"></button>
            </div>
        </div>`;
    function ensurePersonalDialog() {
        let overlay = document.getElementById('personal-dialog-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'personal-dialog-overlay';
            overlay.className = 'personal-dialog-overlay';
            overlay.innerHTML = personalDialogMarkup;
            document.body.appendChild(overlay);
        } else if (!overlay.querySelector('.personal-dialog-message')) {
            overlay.innerHTML = personalDialogMarkup;
        }
        return overlay;
    }

    function personalPrompt(message, defaultValue) {
        const overlay = ensurePersonalDialog();
        const msgEl = overlay.querySelector('.personal-dialog-message');
        const inputEl = overlay.querySelector('.personal-dialog-input');
        const cancelBtn = overlay.querySelector('.personal-dialog-btn.cancel');
        const okBtn = overlay.querySelector('.personal-dialog-btn.primary');
        if (!msgEl || !inputEl || !cancelBtn || !okBtn) {
            return Promise.resolve(prompt(message || '', defaultValue || '') || null);
        }

        msgEl.textContent = message || '';
        inputEl.style.display = '';
        inputEl.value = defaultValue || '';
        cancelBtn.textContent = T('cancel') || 'ביטול';
        okBtn.textContent = T('save') || 'שמור';
        okBtn.classList.remove('danger');
        okBtn.classList.add('primary');

        overlay.style.display = 'flex';
        inputEl.focus();
        inputEl.select();

        return new Promise((resolve) => {
            const cleanup = (value) => {
                overlay.style.display = 'none';
                cancelBtn.onclick = null;
                okBtn.onclick = null;
                overlay.onclick = null;
                window.removeEventListener('keydown', onKey);
                resolve(value);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') cleanup(null);
                if (e.key === 'Enter') cleanup(inputEl.value);
            };
            window.addEventListener('keydown', onKey);
            cancelBtn.onclick = () => cleanup(null);
            okBtn.onclick = () => cleanup(inputEl.value);
            overlay.onclick = (e) => {
                if (e.target === overlay) cleanup(null);
            };
        });
    }

    function personalConfirm(message) {
        const overlay = ensurePersonalDialog();
        const msgEl = overlay.querySelector('.personal-dialog-message');
        const inputEl = overlay.querySelector('.personal-dialog-input');
        const cancelBtn = overlay.querySelector('.personal-dialog-btn.cancel');
        const okBtn = overlay.querySelector('.personal-dialog-btn.primary');
        if (!msgEl || !cancelBtn || !okBtn) {
            return Promise.resolve(confirm(message || ''));
        }

        msgEl.textContent = message || '';
        if (inputEl) inputEl.style.display = 'none';
        cancelBtn.textContent = T('cancel') || 'ביטול';
        okBtn.textContent = T('confirm') || T('personal_action_delete') || 'אישור';
        okBtn.classList.remove('primary');
        okBtn.classList.add('danger');

        overlay.style.display = 'flex';

        return new Promise((resolve) => {
            const cleanup = (val) => {
                overlay.style.display = 'none';
                cancelBtn.onclick = null;
                okBtn.onclick = null;
                overlay.onclick = null;
                window.removeEventListener('keydown', onKey);
                resolve(val);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') cleanup(false);
                if (e.key === 'Enter') cleanup(true);
            };
            window.addEventListener('keydown', onKey);
            cancelBtn.onclick = () => cleanup(false);
            okBtn.onclick = () => cleanup(true);
            overlay.onclick = (e) => {
                if (e.target === overlay) cleanup(false);
            };
        });
    }

    const actionsLabel = T('personal_actions_btn') || 'פעולות';
    const actionsBtnHtml = `<span class="personal-dropdown-btn-text">${escapeHtml(actionsLabel)}</span><span class="personal-dropdown-chevron" aria-hidden="true">▼</span>`;
    tbody.innerHTML = '';
    for (const job of jobs) {
        const name = displayNames[job.id] != null ? displayNames[job.id] : displayNameFromKey(job.input_s3_key);
        const hasTranscript = Boolean(job.result_s3_key);
        const tr = document.createElement('tr');
        const pad = '\u00A0\u00A0\u00A0\u00A0';
        tr.innerHTML = `
            <td class="personal-cell-name">${escapeHtml(name)}${pad}</td>
            <td>${escapeHtml(formatDate(job.created_at))}${pad}</td>
            <td>${escapeHtml(statusLabel(job.status))}${pad}</td>
            <td class="personal-row-actions">
                <button type="button" class="personal-dropdown-btn" data-job-id="${escapeHtml(job.id)}" aria-haspopup="true" aria-expanded="false" aria-label="${escapeHtml(actionsLabel)}">${actionsBtnHtml}</button>
                <div class="personal-dropdown-menu" role="menu">
                    <button type="button" role="menuitem" data-action="open" ${hasTranscript ? '' : 'disabled'} class="${hasTranscript ? '' : 'personal-action-disabled'}">${T('personal_action_open') || 'פתיחת המדיה והתמליל'}</button>
                    <button type="button" role="menuitem" data-action="export" ${hasTranscript ? '' : 'disabled'} class="${hasTranscript ? '' : 'personal-action-disabled'}">${T('personal_action_export') || 'יצוא התמליל'}</button>
                    <button type="button" role="menuitem" data-action="download">${T('personal_action_download_media') || 'הורדת המדיה'}</button>
                    <button type="button" role="menuitem" data-action="rename">${T('personal_action_rename') || 'שינוי שם הקובץ'}</button>
                    <button type="button" role="menuitem" data-action="delete">${T('personal_action_delete') || 'מחיקת הקובץ'}</button>
                </div>
            </td>`;
        const btn = tr.querySelector('.personal-dropdown-btn');
        const menu = tr.querySelector('.personal-dropdown-menu');
        const cellName = tr.querySelector('.personal-cell-name');
        menu.classList.remove('open');
        menu.style.display = 'none';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.personal-dropdown-menu.open').forEach(m => {
                m.classList.remove('open');
                m.style.display = 'none';
                const otherBtn = m.closest('tr')?.querySelector('.personal-dropdown-btn');
                if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
            });
            const willOpen = !menu.classList.contains('open');
            if (willOpen) {
                menu.classList.add('open');
                menu.style.display = 'block';
                btn.setAttribute('aria-expanded', 'true');
            } else {
                menu.classList.remove('open');
                menu.style.display = 'none';
                btn.setAttribute('aria-expanded', 'false');
            }
        });
        menu.querySelectorAll('button[data-action]').forEach(b => {
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.classList.remove('open');
                menu.style.display = 'none';
                btn.setAttribute('aria-expanded', 'false');
                const action = b.getAttribute('data-action');
                if (action === 'open') {
                    window.location.href = '/?open=' + encodeURIComponent(job.id);
                    return;
                }
                if (action === 'download') {
                    if (!job.input_s3_key) { showStatus(T('failed_to_get_link'), true); return; }
                    try {
                        const res = await fetch('/api/get_presigned_url', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ s3Key: job.input_s3_key, userId: user.id })
                        });
                        const json = await res.json();
                        if (json.url) {
                            const blob = await fetch(json.url).then(r => r.blob());
                            const fname = decodeURIComponent((job.input_s3_key || '').split('/').pop() || 'download');
                            if (typeof saveAs !== 'undefined') saveAs(blob, fname);
                            else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click(); URL.revokeObjectURL(a.href); }
                            showStatus(T('copied_to_clipboard') || 'הורדה התחילה', false);
                        } else showStatus(json.error || T('failed_to_get_link'), true);
                    } catch (err) { showStatus(err.message || 'Failed', true); }
                    return;
                }
                if (action === 'export') {
                    const path = (job.input_s3_key || '').replace(/\/input\//, '/output/');
                    const dot = path.lastIndexOf('.');
                    const base = dot >= 0 ? path.slice(0, dot) : path;
                    const resultKey = base ? base + '.json' : null;
                    if (!resultKey || !resultKey.startsWith('users/' + user.id + '/')) { showStatus(T('no_subtitles_to_download') || 'אין תמליל לייצא', true); return; }
                    try {
                        const res = await fetch('/api/get_presigned_url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ s3Key: resultKey, userId: user.id }) });
                        const json = await res.json();
                        if (!json.url) { showStatus(json.error || 'Failed', true); return; }
                        const fetchRes = await fetch(json.url);
                        const data = await fetchRes.json();
                        const segments = (data && data.segments) ? data.segments : [];
                        if (segments.length === 0) { showStatus(T('no_subtitles_to_download') || 'אין תמליל לייצא', true); return; }
                        const srt = typeof srtFromCues === 'function' ? srtFromCues(segments) : '';
                        const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
                        if (typeof saveAs !== 'undefined') saveAs(blob, (displayNameFromKey(job.input_s3_key) || 'transcript').replace(/\.[^.]*$/, '') + '.srt');
                        else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (displayNameFromKey(job.input_s3_key) || 'transcript').replace(/\.[^.]*$/, '') + '.srt'; a.click(); URL.revokeObjectURL(a.href); }
                        showStatus(T('copied_to_clipboard') || 'הייבוא הושלם', false);
                    } catch (err) { showStatus(err.message || 'Export failed', true); }
                    return;
                }
                if (action === 'rename') {
                    const newName = await personalPrompt(T('personal_rename_prompt') || 'הזן שם חדש לקובץ:', name);
                    if (newName == null || newName.trim() === '') return;
                    const trimmed = newName.trim();
                    try {
                        const { error: updateErr } = await supabase.from('jobs').update({ display_name: trimmed }).eq('id', job.id).eq('user_id', user.id);
                        if (updateErr) { /* column may not exist; keep localStorage only */ }
                    } catch (_) { /* DB may not have display_name column */ }
                    displayNames[job.id] = trimmed;
                    try { localStorage.setItem(PERSONAL_DISPLAY_NAMES_KEY, JSON.stringify(displayNames)); } catch (_) {}
                    cellName.textContent = trimmed;
                    showStatus(T('personal_renamed') || 'השם עודכן', false);
                    return;
                }
                if (action === 'delete') {
                    const ok = await personalConfirm(T('personal_delete_confirm') || 'למחוק את הקובץ? פעולה זו לא ניתנת לביטול.');
                    if (!ok) return;
                    const { data: deleted, error: delErr } = await supabase.from('jobs').delete().eq('id', job.id).eq('user_id', user.id).select('id');
                    if (delErr) { showStatus(delErr.message || 'Delete failed', true); return; }
                    if (!deleted || deleted.length === 0) {
                        const res = await fetch('/api/delete_job', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jobId: job.id, userId: user.id })
                        });
                        const json = res.ok ? await res.json() : {};
                        if (json.deleted) {
                            tr.remove();
                            showStatus(T('personal_deleted') || 'הקובץ נמחק', false);
                        } else {
                            showStatus(json.error || (T('personal_delete_failed') || 'לא ניתן למחוק. ייתכן שאין הרשאה.'), true);
                        }
                        return;
                    }
                    tr.remove();
                    showStatus(T('personal_deleted') || 'הקובץ נמחק', false);
                }
            });
        });
        tbody.appendChild(tr);
    }
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.personal-dropdown-btn') && !e.target.closest('.personal-dropdown-menu')) {
            document.querySelectorAll('.personal-dropdown-menu.open').forEach(m => {
                m.classList.remove('open');
                m.style.display = 'none';
                const otherBtn = m.closest('tr')?.querySelector('.personal-dropdown-btn');
                if (otherBtn) otherBtn.setAttribute('aria-expanded', 'false');
            });
        }
    });
}

/** Load a job in the app when user clicks "Open in app" (/?open=jobId). Loads file URL + transcript JSON. */
async function initOpenInApp(jobId) {
    setSeoHomeContentVisibility(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // Fetch job without result first so we never 400 if result column is missing.
    // Use maybeSingle() to avoid 406 when no row matches (PostgREST returns 406 for .single() when 0 rows).
    const { data: job, error } = await supabase
        .from('jobs')
        .select('id, input_s3_key')
        .eq('id', jobId)
        .eq('user_id', user.id)
        .maybeSingle();
    if (error || !job || !job.input_s3_key) {
        if (typeof showStatus === 'function') showStatus('Could not load file.', true);
        return;
    }
    // Prefer transcript from S3 (result_s3_key); fallback to jobs.result
    let segments = [];
    const { data: keyRow } = await supabase.from('jobs').select('result_s3_key').eq('id', jobId).eq('user_id', user.id).maybeSingle();
    if (keyRow && keyRow.result_s3_key) {
        try {
            const urlRes = await fetch('/api/get_presigned_url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ s3Key: keyRow.result_s3_key, userId: user.id })
            });
            const urlJson = await urlRes.json();
            if (urlJson.url) {
                const tr = await fetch(urlJson.url).then(r => r.json());
                if (tr && Array.isArray(tr.segments)) segments = tr.segments;
            }
        } catch (_) { /* fallback to result */ }
    }
    if (segments.length === 0) {
        const { data: resultData } = await supabase.from('jobs').select('result').eq('id', jobId).eq('user_id', user.id).maybeSingle();
        if (resultData && resultData.result && Array.isArray(resultData.result.segments)) {
            segments = resultData.result.segments;
        }
    }
    window.currentSegments = segments;

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
    setTranscriptActionButtonsVisible(true);
    const mainBtn = document.getElementById('main-btn');
    if (mainBtn) { mainBtn.disabled = false; mainBtn.innerText = (typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload'); }
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
    form.append('segments', JSON.stringify(segments.map(s => ({ start: s.start, end: s.end || s.start + 1, text: s.text || '' }))));
    form.append('filename', filename);

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

async function tryRecoverSegmentsForExport() {
    if (Array.isArray(window.currentSegments) && window.currentSegments.length > 0) return true;
    const jobId = localStorage.getItem('lastJobId') || localStorage.getItem('pendingJobId');
    if (!jobId) return false;
    try {
        const res = await fetch(`/api/check_status/${encodeURIComponent(jobId)}`);
        if (!res.ok) return false;
        const data = await res.json();
        const recovered = extractSegmentsFromJobPayload(data);
        if (recovered.length > 0) {
            window.currentSegments = recovered;
            if (typeof window.render === 'function') window.render();
            return true;
        }
    } catch (e) {
        console.warn('[export recover] Failed to recover segments from check_status:', e);
    }
    return Array.isArray(window.currentSegments) && window.currentSegments.length > 0;
}

window.downloadFile = async function(type, bypassUser = null) {
    const baseName = ((window.originalFileName || '').trim()) || "transcript";

    if (type === 'movie') {
        console.log('[movie export] Start');
        const { data: { user: movieUser } } = await supabase.auth.getUser();
        if (!movieUser) {
            console.log('[movie export] No user – show sign-in');
            if (typeof showStatus === 'function') showStatus("Please sign in to download the movie.", true);
            window.pendingExportType = 'movie';
            localStorage.setItem('pendingExportType', 'movie');
            localStorage.setItem('pendingS3Key', localStorage.getItem('lastS3Key') || '');
            localStorage.setItem('pendingJobId', localStorage.getItem('lastJobId') || '');
            if (typeof window.toggleModal === 'function') window.toggleModal(true);
            return;
        }
        console.log('[movie export] User OK');
        if (!window.currentSegments.length) {
            await tryRecoverSegmentsForExport();
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
        console.log('[movie export] Video OK – duration', durationSec, 's, width', widthPx);
        const inputS3Key = localStorage.getItem('lastS3Key');
        if (!inputS3Key || !inputS3Key.startsWith('users/')) {
            console.log('[movie export] No/invalid lastS3Key:', inputS3Key ? inputS3Key.substring(0, 30) + '…' : 'null');
            if (typeof showStatus === 'function') {
                const baseErr = typeof window.t === 'function' ? window.t('movie_burn_failed') : "Movie burn failed.";
                showStatus(baseErr, true);
                showStatus("Video must be from your uploads (save and use Styled Subtitles from an uploaded video).", true);
            }
            return;
        }
        console.log('[movie export] S3 key OK');

        const mainBtn = document.getElementById('main-btn');
        const creatingMovieText = (typeof window.t === 'function' ? (window.t('creating_movie') || 'Creating movie...') : 'Creating movie...');
        if (mainBtn) {
            mainBtn.disabled = true;
            mainBtn.innerText = creatingMovieText;
        }

        try {
            if (typeof ensureJobRecordOnExport === 'function') {
                console.log('[movie export] Ensuring job record…');
                await ensureJobRecordOnExport();
                console.log('[movie export] Job record done');
            }
            console.log('[movie export] Fetching simulation_mode…');
            let isSimulation = false;
            try {
                const simRes = await fetch('/api/simulation_mode', { cache: 'no-store' });
                const simJson = simRes.ok ? await simRes.json() : {};
                isSimulation = simJson.simulation === true;
                console.log('[movie export] Simulation mode:', isSimulation);
            } catch (e) {
                // Network/proxy hiccup on this check should not block production export.
                isSimulation = false;
                console.warn('[movie export] simulation_mode check failed; assuming production mode:', e);
            }
            if (isSimulation === true) {
                console.log('[movie export] Simulation branch – downloading video+SRT');
                const videoBlob = await fetch(videoUrl).then(r => r.blob());
                if (typeof saveAs !== 'undefined') saveAs(videoBlob, (baseName || 'video') + '.mp4');
                const segments = window.currentSegments || [];
                let srt = '';
                const normSegs = typeof normalizeSegmentDurations === 'function' ? normalizeSegmentDurations(segments, 0.5) : segments;
                normSegs.forEach((seg, i) => {
                    const ts = (s) => {
                        const d = new Date(0); d.setMilliseconds(s * 1000);
                        return d.toISOString().substr(11, 12).replace('.', ',');
                    };
                    srt += `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${(seg.text || '').trim()}\n\n`;
                });
                if (typeof saveAs !== 'undefined') saveAs(new Blob([srt], { type: 'text/plain;charset=utf-8' }), (baseName || 'video') + '.srt');
                return;
            }

            const encodingMsg = '';
            const pContainer = document.getElementById('p-container');
            const progressBar = document.getElementById('progress-bar');
            const statusTxt = document.getElementById('upload-status');
            let burnProgressTimer = null;
            const startBurnProgress = () => {
                let pct = 8;
                if (pContainer) pContainer.style.display = 'block';
                if (progressBar) progressBar.style.width = pct + '%';
                if (statusTxt) {
                    statusTxt.innerText = '';
                    statusTxt.style.display = 'none';
                }
                setBurnProgress(pct, encodingMsg);
                burnProgressTimer = setInterval(() => {
                    pct = Math.min(95, pct + Math.max(1, Math.round((95 - pct) * 0.1)));
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
                if (statusTxt) {
                    statusTxt.innerText = '';
                    statusTxt.style.display = 'none';
                }
                if (completed) {
                    setBurnProgress(100, typeof window.t === 'function' ? window.t('movie_downloaded') : 'Movie downloaded');
                }
                setTimeout(() => {
                    if (pContainer) pContainer.style.display = 'none';
                    if (progressBar) progressBar.style.width = '0%';
                    hideBurnProgress();
                }, completed ? 1200 : 0);
                if (!completed) hideBurnProgress();
            };
            startBurnProgress();
            console.log('[movie export] Calling burn_subtitles_server…');
            const rawSegments = (window.currentSegments || []).map(s => ({ start: s.start, end: s.end || s.start + 1, text: s.text || '' }));
            const segments = typeof normalizeSegmentDurations === 'function' ? normalizeSegmentDurations(rawSegments, 0.5) : rawSegments;
            const subtitleStyle = (typeof window.currentSubtitleStyle === 'string' && window.currentSubtitleStyle) ? window.currentSubtitleStyle : 'tiktok';
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
                    notify_email: movieUser.email || undefined,
                    job_id: localStorage.getItem('lastJobId') || undefined
                })
            });
            const burnData = burnRes.ok ? await burnRes.json() : {};
            console.log('[movie export] Burn response:', burnRes.status, burnData);
            if (!burnRes.ok) {
                const err = burnData.error || burnRes.statusText;
                throw new Error(err);
            }
            const taskId = burnData.task_id;
            if (!taskId) throw new Error("No task_id");
            console.log('[movie export] Task id:', taskId);

            const pollInterval = 2500;
            const maxWait = 600000;
            const start = Date.now();
            let statusJson = { status: 'processing' };
            let pollCount = 0;
            while (statusJson.status === 'processing' && (Date.now() - start) < maxWait) {
                await new Promise(r => setTimeout(r, pollInterval));
                pollCount++;
                if (pollCount === 1 || pollCount % 10 === 0) {
                    console.log('[movie export] Poll', pollCount, '…');
                }
                const statusRes = await fetch(`/api/burn_subtitles_status?task_id=${encodeURIComponent(taskId)}`);
                statusJson = statusRes.ok ? await statusRes.json() : {};
            }
            if (statusJson.status === 'failed') {
                stopBurnProgress(false);
                console.log('[movie export] Failed:', statusJson.error);
                throw new Error(statusJson.error || "Burn failed");
            }
            if (statusJson.status === 'completed' && statusJson.output_url) {
                stopBurnProgress(true);
                console.log('[movie export] Completed – downloading');
                const outName = (baseName || 'video') + '.mp4';
                if (typeof saveAs !== 'undefined') {
                    const blob = await fetch(statusJson.output_url).then(r => r.blob());
                    saveAs(blob, outName);
                } else {
                    const a = document.createElement('a');
                    a.href = statusJson.output_url;
                    a.download = outName;
                    a.target = '_blank';
                    a.click();
                }
            } else {
                stopBurnProgress(false);
                console.log('[movie export] Timeout or no output_url:', statusJson);
                throw new Error("Burn did not complete in time");
            }
        } catch (e) {
            console.error('[movie export] Error:', e);
            if (typeof showStatus === 'function') {
                const baseErr = typeof window.t === 'function' ? window.t('movie_burn_failed') : "Movie burn failed.";
                const hint = typeof window.t === 'function'
                    ? ""
                    : " Please try again later.";
                showStatus(baseErr + hint, true);
            }
        } finally {
            if (mainBtn) {
                mainBtn.disabled = false;
                mainBtn.innerText = (typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload');
            }
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
    const showTime = document.getElementById('toggle-time')?.checked;
    const showSpeaker = document.getElementById('toggle-speaker')?.checked;

    // Update job to exported, or create job if user signed in after upload
    try {
        if (typeof ensureJobRecordOnExport === 'function') {
            await ensureJobRecordOnExport();
        }
    } catch (err) {
        console.error("Failed to update job status:", err);
    }

    if (type === 'docx' && typeof docx === 'undefined') {
        if (typeof showStatus === 'function') showStatus("Error: DOCX library not loaded.", true);
        return;
    }
    if (typeof saveAs === 'undefined') {
        if (typeof showStatus === 'function') showStatus("Error: FileSaver library not loaded.", true);
        return;
    }

    if (type === 'docx') {
        const { Document, Packer, Paragraph, TextRun, AlignmentType } = docx;
        let children = [];
        let current = null;
        window.currentSegments.forEach(seg => {
            if (!current || current.speaker !== seg.speaker) {
                if (current) children.push(...createDocxParagraphs(current, showTime, showSpeaker));
                current = { speaker: seg.speaker, text: "", start: seg.start };
            }
            current.text += seg.text + " ";
        });
        if (current) children.push(...createDocxParagraphs(current, showTime, showSpeaker));

        const doc = new Document({ sections: [{ properties: {}, children: children }] });
        Packer.toBlob(doc).then(blob => saveAs(blob, `${baseName}.docx`));
    } else {
        let content = type === 'vtt' ? "WEBVTT\n\n" : "";
        const segs = typeof normalizeSegmentDurations === 'function' ? normalizeSegmentDurations(window.currentSegments, 0.5) : window.currentSegments;
        segs.forEach((seg, i) => {
            const ts = (s) => {
                let d = new Date(0); d.setMilliseconds(s * 1000);
                let iso = d.toISOString().substr(11, 12);
                return type === 'srt' ? iso.replace('.', ',') : iso;
            };
            if (type === 'srt') content += `${i + 1}\n`;
            content += `${ts(seg.start)} --> ${ts(seg.end)}\n${seg.text.trim()}\n\n`;
        });
        saveAs(new Blob([content], {type: "text/plain;charset=utf-8"}), `${baseName}.${type}`);
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

    if (dBtn && dMenu) {
        dBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            const isHidden = dMenu.style.display === 'none' || window.getComputedStyle(dMenu).display === 'none';
            dMenu.style.display = isHidden ? 'block' : 'none';
        };
        document.addEventListener('click', function(e) {
            if (!dMenu.contains(e.target) && !dBtn.contains(e.target)) dMenu.style.display = 'none';
        });
    }

    document.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.addEventListener('click', function() {
            const type = this.getAttribute('data-type');
            const menu = document.getElementById('download-menu');
            if (menu) menu.style.display = 'none';
            console.log("🖱️ User requested export:", type);
            window.downloadFile(type);
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
            if (user && typeof showStatus === 'function') showStatus((typeof window.t === 'function' ? window.t('exporting_file') : 'Exporting your ') + savedExportType.toUpperCase() + (typeof window.t === 'function' ? window.t('exporting_file_suffix') : ' file...'), false);
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

/** Reset the main screen to initial state (as on first load) — e.g. when user clicks Upload to start a new file. */
function resetScreenToInitial() {
    window.isTriggering = false;
    if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
    window.fakeProgressInterval = null;
    window.currentSegments = [];
    setSeoHomeContentVisibility(true);

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
    if (pContainer) pContainer.style.display = 'none';
    if (progressBar) progressBar.style.width = '0%';
    if (statusTxt) {
        statusTxt.style.display = 'block';
        statusTxt.innerText = typeof window.t === 'function' ? window.t('ready') : 'Ready';
    }
    if (mainBtn) {
        mainBtn.disabled = false;
        mainBtn.innerText = typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload';
    }

    if (transcriptWindow) {
        const placeholderText = typeof window.t === 'function' ? window.t('upload_placeholder') : 'Upload a file to start';
        transcriptWindow.innerHTML = `<p id="placeholder" style="color:#9ca3af; text-align:center; margin-top:80px;" data-i18n="upload_placeholder">${placeholderText}</p>`;
    }
    if (placeholder && !transcriptWindow.querySelector('#placeholder')) {
        placeholder.style.display = 'block';
    }

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
}

function setTranscriptActionButtonsVisible(visible) {
    const downloadBtn = document.getElementById('btn-download');
    const copyBtn = document.getElementById('btn-copy') || document.querySelector('.toolbar-group button[onclick="window.copyTranscript()"]');
    const editBtn = document.getElementById('btn-edit') || document.querySelector('.toolbar-group button[onclick="window.toggleEditMode()"]');
    const togglesGroup = document.querySelector('.controls-bar .toggles-group');
    const editActions = document.getElementById('edit-actions');
    const downloadMenu = document.getElementById('download-menu');

    [downloadBtn, copyBtn, editBtn].forEach((el) => {
        if (el) el.style.display = visible ? '' : 'none';
    });
    if (togglesGroup) togglesGroup.style.display = visible ? '' : 'none';
    if (!visible) {
        if (editActions) editActions.style.display = 'none';
        if (downloadMenu) downloadMenu.style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const transcriptWindow = document.getElementById('transcript-window');
    const fileInput = document.getElementById('fileInput');
    const statusTxt = document.getElementById('upload-status');
    const progressBar = document.getElementById('progress-bar');
    const mainBtn = document.getElementById('main-btn');
    const diarizationToggle = document.getElementById('diarization-toggle');
    const speakerToggle = document.getElementById('toggle-speaker');
    const mainAudio = document.getElementById('main-audio');
    setTranscriptActionButtonsVisible(false);

    function openFilePickerAfterDisclaimer() {
        resetScreenToInitial();
        if (fileInput) fileInput.click();
    }

    if (mainBtn) {
        mainBtn.addEventListener('click', () => {
            openFilePickerAfterDisclaimer();
        });
    }

    // Ensure toggles refresh the view immediately
    document.getElementById('toggle-time')?.addEventListener('change', () => render());
    document.getElementById('toggle-speaker')?.addEventListener('change', () => render());
    if (mainAudio) {
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
                    activeRow.style.backgroundColor = "#f0f7ff";
                    activeRow.style.borderLeft = "4px solid #1e3a8a";
                    const p = activeRow.querySelector('p');
                    if (p) p.style.backgroundColor = "#fff9c4";
                }
            }
        });
        const mainVideo = document.getElementById('main-video');
        if (mainVideo) {
            mainVideo.addEventListener('timeupdate', () => {
                const currentTime = mainVideo.currentTime;
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
    // --- 2. THE HANDLER (Hides overlay and turns switch Blue) ---
    window.handleJobUpdate = async function(rawResult) {
        const dbId = localStorage.getItem('lastJobDbId');

        if (window._checkStatusPollInterval) {
            clearInterval(window._checkStatusPollInterval);
            window._checkStatusPollInterval = null;
        }

        // 1. CLEAR OVERLAYS & STOP PROGRESS
        window.isTriggering = false;
        setSeoHomeContentVisibility(false);
        localStorage.removeItem('activeJobId');
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

        const statusTxt = document.getElementById('upload-status');
        const preparingScreen = document.getElementById('preparing-screen');
        if (preparingScreen) preparingScreen.style.display = 'none';

        const pContainer = document.getElementById('p-container');
        const progressBar = document.getElementById('progress-bar');
        if (pContainer) pContainer.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';

        const output = rawResult.result || rawResult.output || rawResult;
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

        // 2. UNHIDE CORE COMPONENTS (Styled Subtitles button removed; video is shown immediately for video uploads)
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
        const mainBtn = document.getElementById('main-btn');

        if (isFailedJob) {
            window.currentSegments = [];
            setTranscriptActionButtonsVisible(false);
            if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
            const transcriptWindow = document.getElementById('transcript-window');
            const safeErr = (jobError || 'Transcription failed. Please try again.').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            if (transcriptWindow) {
                transcriptWindow.innerHTML = `<p style="color:#b91c1c; text-align:center; margin-top:40px; white-space:pre-wrap;">${safeErr}</p>`;
                transcriptWindow.setAttribute('contenteditable', 'false');
            }
            if (typeof showStatus === 'function') showStatus(safeErr, true);
            return;
        }

        setTranscriptActionButtonsVisible(true);

        // 3. PROCESS DATA — support multiple API shapes (RunPod, simulation, etc.)
        let segments = (output && output.segments) || rawResult.segments || (rawResult.data && rawResult.data.segments) || [];
        if (!Array.isArray(segments)) segments = [];
        segments = splitLongSegments(segments, 40);

        // First, treat these as raw Ivrit-AI segments.
        window.currentSegments = segments;

        // Then, run GPT post-processing via /api/translate_segments (decoupled from RunPod callback).
        // Chunk size: larger = fewer requests (faster when browser limits ~4–6 connections). Keep under ~55s for gateway.
        const TRANSLATE_CHUNK_SIZE = 40;
        let translationMeta = null;
        let translatedCount = 0;
        let changedCount = 0;
        try {
            const T = typeof window.t === 'function' ? window.t : (k) => k;
            if (mainBtn) {
                mainBtn.disabled = true;
                mainBtn.innerText = T('translating') || 'מטייב דיקדוק...';
            }
            const userLang = (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he');
            const chunks = [];
            for (let i = 0; i < segments.length; i += TRANSLATE_CHUNK_SIZE) {
                chunks.push(segments.slice(i, i + TRANSLATE_CHUNK_SIZE));
            }
            if (chunks.length > 1) console.log('[GPT] Chunked translate:', segments.length, 'segments ->', chunks.length, 'requests (all in flight)');
            var completedCount = 0;
            function onChunkDone() {
                completedCount++;
                if (mainBtn && chunks.length > 1) mainBtn.innerText = (T('translating') || 'מטייב דיקדוק...') + ' ' + completedCount + '/' + chunks.length;
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
                segments = allTranslated.map((s) => ({ ...s, text: (s.translated_text || s.text || '').trim() }));
                console.log('[GPT] Job translate success:', translatedCount + '/' + segments.length, 'changed:', changedCount + '/' + segments.length, 'meta:', translationMeta);
            } else if (lastMeta) {
                translationMeta = lastMeta;
            }
        } catch (e) {
            console.warn('[GPT] translate_segments failed, using raw Ivrit-AI output:', e);
        }

        window.currentSegments = segments;
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
                            body: JSON.stringify({ userId: user.id, input_s3_key: s3Key, segments: window.currentSegments, stage: 'gpt' })
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
            segments
                .map(s => s.speaker)
                .filter(s => s !== undefined && s.speaker !== null)
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
            window.render();
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

        // Placeholder variable: Set to 'false' for Subtitles, 'true' for Docx
        // Later, you can attach this to a toggle switch like: document.getElementById('view-mode-toggle').checked;
        window.isDocumentMode = false; 
        const groupedData = groupSegmentsBySpeaker(window.currentSegments, window.isDocumentMode);


        const html = groupedData.map((g, rowIndex) => {
            // 2. Fixed: Get state of both toggles
            const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
            const isTimeVisible = document.getElementById('toggle-time')?.checked;

            const showLabel = isSpeakerVisible && window.aiDiarizationRan;

            return `
            <div class="paragraph-row" id="seg-row-${rowIndex}" style="margin-bottom: 20px;">
                <div style="font-size: 0.85em; color: #888; margin-bottom: 4px;">

                    <span class="timestamp" style="display: ${isTimeVisible ? 'inline' : 'none'};">
                        ${formatTime(g.start)}
                    </span>

                    <span style="display: ${showLabel ? 'inline' : 'none'}; font-weight: bold; margin-right: 10px; color: ${getSpeakerColor(g.speaker)}">
                        ${isTimeVisible ? '| ' : ''}${g.speaker.replace('SPEAKER_', 'דובר ')}
                    </span>
                </div><p ${!window.isDocumentMode ? `data-idx="${rowIndex}"` : ''} style="margin: 0; cursor: pointer; line-height: 1.6;" onclick="window.jumpTo(${g.start})">${g.text}</p>
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
            player.play();
        }
    };


    window.copyTranscript = async function() {
        const text = document.getElementById('transcript-window').innerText;
        if (!text || !text.trim()) return;

        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            localStorage.setItem('pendingTranscript', JSON.stringify(window.currentSegments));
            const currentKey = localStorage.getItem('lastS3Key');
            if (currentKey) localStorage.setItem('pendingS3Key', currentKey);

            window.toggleModal(true);
            return;
        }

        // Copy to clipboard
        navigator.clipboard.writeText(text).then(async () => {
            showStatus(typeof window.t === 'function' ? window.t('copied_to_clipboard') : "Copied to clipboard!"); // Using our new toast!

            // --- NEW: Add the 'copy' type here ---
            const currentS3Key = localStorage.getItem('lastS3Key');
            try {
                if (typeof ensureJobRecordOnExport === 'function') {
                    await ensureJobRecordOnExport();
                }
            } catch (err) {
                console.error("Failed to log copy event:", err);
            }
        });
    };
    
    window.saveEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');

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
                            body: JSON.stringify({ userId: user.id, input_s3_key: s3Key, segments: window.currentSegments })
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

        // Restore the original text from before they clicked the pencil
        if (window.transcriptBackup) {
            win.innerHTML = window.transcriptBackup;
        }

        // Lock UI
        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";
        win.classList.remove('transcript-editing');
        if (editActions) editActions.style.display = 'none';
    };

    // --- SUBTITLE STYLE MANAGEMENT ---
    window.currentSubtitleStyle = localStorage.getItem('subtitleStyle') || 'tiktok';
    
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
            selector.style.display = 'block';
            window.applySubtitleStyle(window.currentSubtitleStyle);
        }
    };

    window.hideSubtitleStyleSelector = function() {
        const selector = document.getElementById('subtitle-style-selector');
        if (selector) {
            selector.style.display = 'none';
        }
    };

    // --- NEW: The VTT Cache Buster ---
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

        // Center cues only for TikTok style; clean/cinematic keep default (bottom) positioning
        const isTiktok = window.currentSubtitleStyle === 'tiktok';
        const cueSettings = isTiktok ? ' line:50% position:50% align:middle' : '';
        const maxCharsPerLine = isTiktok ? 28 : 42; // TikTok bold: 2 lines at 28 chars; others ~2 lines at 42
        for (const c of window.currentSegments) {
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
        track.kind = 'subtitles';
        track.label = 'Subtitles';
        track.srclang = 'he';
        track.src = vttUrl;
        track.default = true;
        
        video.appendChild(track);

        // Force the browser to display it (do not call applySubtitleStyle here — would loop with refreshVideoSubtitles)
        track.addEventListener('load', () => {
            try {
                Array.from(video.textTracks).forEach(tt => tt.mode = 'showing');
            } catch (e) { console.warn("Track mode error:", e); }
        });
    };

    window.toggleEditMode = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');
        const isEditable = win.contentEditable === 'true';

        if (!isEditable) {
            // --- START EDITING ---
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
                const isTimeVisible = document.getElementById('toggle-time')?.checked;
                const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
                const row = p.closest('.paragraph-row');
                const newRowHtml = `
                <div class="paragraph-row" style="margin-bottom: 20px;">
                    <div style="font-size: 0.85em; color: #888; margin-bottom: 4px;">
                        <span class="timestamp" style="display: ${isTimeVisible ? 'inline' : 'none'};">
                            ${formatTime(newSeg.start)}
                        </span>
                        <span style="display: ${isSpeakerVisible && window.aiDiarizationRan ? 'inline' : 'none'}; font-weight: bold; margin-right: 10px; color: ${getSpeakerColor(seg.speaker)}">
                            ${isTimeVisible ? '| ' : ''}${(seg.speaker || 'SPEAKER_00').replace('SPEAKER_', 'דובר ')}
                        </span>
                    </div>
                    <p data-idx="${idx + 1}" style="margin: 0; cursor: pointer; line-height: 1.6;" onclick="window.jumpTo(${newSeg.start})"><br></p>
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

            const isTimeVisible = document.getElementById('toggle-time')?.checked;
            const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
            const row = p.closest('.paragraph-row');
            const newRowHtml = `
            <div class="paragraph-row" style="margin-bottom: 20px;">
                <div style="font-size: 0.85em; color: #888; margin-bottom: 4px;">
                    <span class="timestamp" style="display: ${isTimeVisible ? 'inline' : 'none'};">
                        ${formatTime(splitTime)}
                    </span>
                    <span style="display: ${isSpeakerVisible && window.aiDiarizationRan ? 'inline' : 'none'}; font-weight: bold; margin-right: 10px; color: ${getSpeakerColor(seg.speaker)}">
                        ${isTimeVisible ? '| ' : ''}${(seg.speaker || 'SPEAKER_00').replace('SPEAKER_', 'דובר ')}
                    </span>
                </div>
                <p data-idx="${idx + 1}" style="margin: 0; cursor: pointer; line-height: 1.6;" onclick="window.jumpTo(${splitTime})"></p>
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
        const isTimeVisible = document.getElementById('toggle-time')?.checked;

        const rawSpeaker = group.speaker || "SPEAKER_00";
        const speakerDisplay = rawSpeaker.replace('SPEAKER_', 'דובר ');
        const fullText = group.sentences.map(s => s.text).join(" ");
        const translatedParts = group.sentences.map(s => s.translated_text).filter(Boolean);
        const translatedLine = translatedParts.length ? translatedParts.join(" ").replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';

        return `
        <div class="paragraph-row" style="display: flex; justify-content: flex-end; width: 100%; margin-bottom: 25px; direction: rtl;">

            <div style="min-width: 90px; text-align: right; margin-left: 15px; flex-shrink: 0; font-size: 0.85em; color: #888;">
                <div style="display: ${isTimeVisible ? 'block' : 'none'};">${formatTime(group.start)}</div>
                <div style="display: ${isSpeakerVisible ? 'block' : 'none'}; font-weight: bold; color: ${getSpeakerColor(rawSpeaker)};">
                    ${speakerDisplay}
                </div>
            </div>

            <div style="flex-grow: 1; text-align: right;">
                <p style="margin: 0; cursor: pointer; line-height: 1.7; font-size: 1.1em;" onclick="window.jumpTo(${group.start})">
                    ${fullText}
                </p>
                ${translatedLine ? `<p class="translated-line" style="margin: 4px 0 0 0; font-size: 0.9em; color: #6b7280; direction: ltr; text-align: left;">${translatedLine}</p>` : ''}
            </div>
        </div>`;
    }
    function startFakeProgress() {
        let current = 0;
        if (mainBtn) {
            mainBtn.innerText = (typeof window.t === 'function' ? window.t('processing') : 'Processing...');
        }
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
        window.fakeProgressInterval = setInterval(() => {
            if (current < 95) {
                current += 0.5;
                if (progressBar) progressBar.style.width = current + "%";
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

            // UI Feedback: show progress bar for upload phase
            const pContainer = document.getElementById('p-container');
            if (pContainer) { pContainer.style.display = "block"; }
            if (progressBar) { progressBar.style.width = "0%"; }
            const uploadLabel = (typeof window.t === 'function' ? window.t('uploading') : "Uploading...");
            if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = uploadLabel + " 0%"; }
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
                        userId: userId
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
                console.log("💾 Keys parked for recovery:", s3Key);
                if (typeof createJobOnUpload === 'function') await createJobOnUpload({ jobId, s3Key });

                // 3. Start Socket communication
                if (typeof socket !== 'undefined') {
                    socket.emit('join', { room: jobId });
                }

                // 4. Proceed with S3 Upload (XHR for progress tracking)
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                xhr.setRequestHeader('Content-Type', currentFile.type);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && progressBar) {
                        const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
                        progressBar.style.width = pct + "%";
                        if (mainBtn) mainBtn.innerText = uploadLabel + " " + pct + "%";
                    }
                };

                xhr.onload = async () => {
                    if (xhr.status === 200 || xhr.status === 201) {
                        if (progressBar) progressBar.style.width = "100%";
                        if (mainBtn) mainBtn.innerText = uploadLabel + " 100%";
                        console.log("✅ File uploaded to S3.");
                        window.isTriggering = true;
                        window._triggerRetriedForJobId = null; // allow one auto-retry if trigger gets stuck
                        const dbId = localStorage.getItem('lastJobDbId');
                        if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'uploaded');

                        try {
                            const triggerRes = await fetch('/api/trigger_processing', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    s3Key: s3Key,
                                    jobId: jobId,
                                    diarization: diarizationValue,
                                    language: (typeof getUserTargetLang === 'function' ? getUserTargetLang() : 'he')
                                })
                            });
                            let triggerData = {};
                            try { triggerData = await triggerRes.json(); } catch (_) {}
                            if (!triggerRes.ok) {
                                console.log("❌ Triggering processing failed:", triggerRes.status, triggerData);
                                const msg = triggerData.message || triggerData.error || `Server error (${triggerRes.status})`;
                                if (typeof showStatus === 'function') showStatus(msg, true);
                                const dbId2 = localStorage.getItem('lastJobDbId');
                                if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                                window.isTriggering = false;
                                localStorage.removeItem('activeJobId');
                                if (mainBtn) mainBtn.disabled = false;
                                return;
                            }

                            // Option A: wait for RunPod trigger confirmation before showing "processing"
                            if (triggerRes.status === 202 && (triggerData.status === 'started' || triggerData.status === 'queued')) {
                                const isHebrewUi = String(document.documentElement.lang || 'he').toLowerCase().startsWith('he');
                                const waitMsg = isHebrewUi ? 'מפעיל עיבוד...' : 'Triggering processing...';
                                if (progressBar) progressBar.style.width = '0%';
                                if (mainBtn) mainBtn.innerText = waitMsg;
                                if (statusTxt) {
                                    statusTxt.innerText = '';
                                    statusTxt.style.display = 'none';
                                }
                                const pollInterval = 2000;
                                const triggerConfirmTimeoutMs = 90000; // 90s max wait for RunPod handshake
                                const start = Date.now();
                                let ts = { status: '' };
                                while (ts.status !== 'triggered' && ts.status !== 'failed' && ts.status !== 'stale_queued' && (Date.now() - start) < triggerConfirmTimeoutMs) {
                                    await new Promise(r => setTimeout(r, pollInterval));
                                    const stRes = await fetch(`/api/trigger_status?job_id=${encodeURIComponent(jobId)}`);
                                    ts = stRes.ok ? await stRes.json() : {};
                                }
                                if (ts.status === 'failed' || ts.status === 'stale_queued') {
                                    console.log("❌ Trigger not confirmed:", ts.status);
                                    const dbId2 = localStorage.getItem('lastJobDbId');
                                    if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                                    window.isTriggering = false;
                                    localStorage.removeItem('activeJobId');
                                    if (mainBtn) mainBtn.disabled = false;
                                    const msg = isHebrewUi ? 'הפעלת העיבוד נכשלה.' : 'GPU trigger failed.';
                                    if (typeof showStatus === 'function') showStatus(msg, true, { retryTrigger: true });
                                    return;
                                }
                                if (ts.status !== 'triggered') {
                                    // timeout: still queued after 90s
                                    console.log("❌ Trigger confirmation timeout");
                                    const dbId2 = localStorage.getItem('lastJobDbId');
                                    if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                                    window.isTriggering = false;
                                    localStorage.removeItem('activeJobId');
                                    if (mainBtn) mainBtn.disabled = false;
                                    const msg = isHebrewUi ? 'הפעלת העיבוד ארכה יותר מדי. נסה שוב.' : 'Trigger timed out. Try again.';
                                    if (typeof showStatus === 'function') showStatus(msg, true, { retryTrigger: true });
                                    return;
                                }
                                console.log("✅ RunPod trigger confirmed.");
                                if (typeof startFakeProgress === 'function') startFakeProgress();
                            }
                            // Polling fallback: if socket misses callback (e.g. room encoding), poll check_status
                            if (jobId && typeof window.handleJobUpdate === 'function') {
                                window.startJobStatusPolling(jobId);
                            }
                        } catch (err) {
                            const dbId2 = localStorage.getItem('lastJobDbId');
                            if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                            window.isTriggering = false;
                            localStorage.removeItem('activeJobId');
                            if (mainBtn) mainBtn.disabled = false;
                            throw err;
                        }
                    } else {
                        console.error("S3 Upload Failed:", xhr.statusText);
                        const dbId = localStorage.getItem('lastJobDbId');
                        if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
                        window.isTriggering = false;
                        localStorage.removeItem('activeJobId');
                        if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                    }
                };

                xhr.onerror = () => {
                    console.error("XHR Network Error during upload.");
                    const dbId = localStorage.getItem('lastJobDbId');
                    if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
                    window.isTriggering = false;
                    localStorage.removeItem('activeJobId');
                };

                xhr.send(currentFile);

            }
            catch (err) {
                console.error("Upload Error:", err);
                window.isTriggering = false;
                localStorage.removeItem('activeJobId');
                if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                // Use our new toast notification for a professional feel
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

function srtFromCues(cues) {
    const normalized = normalizeSegmentDurations(cues, 0.5);
    return normalized.map((c, i) => {
        const pad = (n) => String(Math.floor(n)).padStart(2, '0');
        const fmt = (s) => {
            const ms = Math.floor((s - Math.floor(s)) * 1000);
            const hh = Math.floor(s / 3600);
            const mm = Math.floor((s % 3600) / 60);
            const ss = Math.floor(s % 60);
            return `${pad(hh)}:${pad(mm)}:${pad(ss)},${String(ms).padStart(3,'0')}`;
        };
        return `${i+1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`;
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
        container.innerHTML = '<p style="color:#9ca3af; text-align:center; margin-top:40px;">No subtitles loaded</p>';
        return;
    }
    const html = cues.map((c, idx) => {
        // Prefer GPT text; fall back to original text if GPT returned empty.
        const mainText = String(c.translated_text || c.text || '').trim();
        const words = mainText.split(/(\s+)/).filter(Boolean);
        const dur = Math.max(0.001, (c.end || (c.start + 0.5)) - c.start);
        let acc = 0;
        const wordSpans = words.map((w, wi) => {
            if (/^\s+$/.test(w)) return w.replace(/ /g, '&nbsp;');
            const start = c.start + (acc * dur / Math.max(1, words.length));
            const end = c.start + ((acc + 1) * dur / Math.max(1, words.length));
            acc++;
            const safe = w.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<span class="word-token" data-idx="${idx}" data-start="${start}" data-end="${end}">${safe}</span>`;
        }).join('');
        return `
        <div class="paragraph-row" id="seg-${Math.floor(c.start)}" style="margin-bottom:12px; direction: ${textDirection}; text-align: ${textAlign};">
            <div style="font-size:0.85em; color:#6b7280; margin-bottom:4px;">[${formatTime(Math.floor(c.start))}]</div>
            <p data-idx="${idx}" style="margin:0; line-height:1.6;">${wordSpans}</p>
        </div>`;
    }).join('');

    container.innerHTML = html;
    container.style.direction = textDirection;
    container.style.textAlign = textAlign;
    container.contentEditable = 'false';
}

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

async function handleSubtitleFile(file) {
    if (!file) return;
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
    
    // NEW: Pass local subtitle uploads through the Chopper too!
    if (typeof splitLongSegments === 'function') {
        cues = splitLongSegments(cues, 55);
    }
    console.log('[SRT] parsed cues:', cues.length, 'file:', file.name);
    // Run correction via backend (GPT)
    const T = typeof window.t === 'function' ? window.t : (k) => k;
    const mainBtn = document.getElementById('main-btn');
    setTranscriptActionButtonsVisible(false);
    if (mainBtn) {
        mainBtn.disabled = true;
        mainBtn.innerText = T('translating') || 'מטייב דיקדוק...';
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
                mainBtn.innerText = (T('translating') || 'מטייב דיקדוק...') + ' ' + Math.min(b + TRANSLATE_CONCURRENCY, chunkedCues.length) + '/' + chunkedCues.length;
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

            const setShowing = () => {
                try {
                    const tt = video.textTracks;
                    for (let i = 0; i < tt.length; i++) {
                        tt[i].mode = 'showing';
                    }
                } catch (e) {
                    console.warn('Failed to set textTracks mode', e);
                }
            };

            track.addEventListener('load', () => {
                try { setShowing(); } catch (e) { console.warn(e); }
            });

            // Fallback attempts in case load event doesn't fire
            setTimeout(setShowing, 100);
            setTimeout(setShowing, 500);
            setTimeout(setShowing, 1500);

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
    
    // Subtitle style selector event listeners
    document.addEventListener('click', function(e) {
        if (e.target.closest('.subtitle-style-card')) {
            const card = e.target.closest('.subtitle-style-card');
            const style = card.dataset.style;
            if (style) {
                window.applySubtitleStyle(style);
            }
        }
    });
});