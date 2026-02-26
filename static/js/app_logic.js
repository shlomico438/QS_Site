import { supabase } from './supabaseClient.js'

// --- GLOBAL STATE ---
window.isTriggering = false;
window.aiDiarizationRan = false;
window.fakeProgressInterval = null;
window.currentSegments = [];
window.originalFileName = "transcript";
window.hasMultipleSpeakers = false;
let isSignUpMode = true;

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

/** Get character offset of the caret within an element (for contenteditable). */
function getCaretCharacterOffsetWithin(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(el);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    return range.toString().length;
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
function splitLongSegments(segments, maxChars = 45) {
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

        // Assign proportional timeframes to the new chunks
        const totalDuration = (seg.end || seg.start + 5) - seg.start;
        const totalChars = seg.text.length;
        let currentTime = seg.start;

        for (const chunk of chunks) {
            // Calculate how much time this chunk takes based on its character length
            const chunkDuration = (chunk.length / totalChars) * totalDuration;
            
            result.push({
                start: currentTime,
                end: currentTime + chunkDuration,
                text: chunk,
                speaker: seg.speaker
            });
            
            currentTime += chunkDuration;
        }
    }
    return result;
}

function showStatus(message, isError = false) {
    // Create element if it doesn't exist
    let toast = document.getElementById('toast-container');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-container';
        toast.className = 'toast-notification';
        document.body.appendChild(toast);
    }

    toast.innerText = message;
    toast.classList.toggle('toast-error', isError);
    toast.classList.add('show');

    // Hide after 4 seconds
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}
async function setupNavbarAuth() {
    const navBtn = document.getElementById('nav-auth-btn');
    if (!navBtn) return;

    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
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

async function toggleUserMenu() {
    const panel = document.getElementById('user-menu-panel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('is-open');
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (isOpen) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user && !panel.dataset.loaded) loadUserMenuFiles(user);
        document.addEventListener('click', closeUserMenuOnClickOutside);
    } else {
        document.removeEventListener('click', closeUserMenuOnClickOutside);
    }
}

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

/** Get display name and email from user, including Google OAuth (identity_data). */
function getAuthUserDisplayInfo(user) {
    if (!user) return { displayName: 'Account', email: '' };
    const meta = user.user_metadata || {};
    const identity = (user.identities && user.identities[0]) ? user.identities[0] : null;
    const idData = (identity && identity.identity_data) ? identity.identity_data : {};
    const merged = { ...meta, ...idData };
    const fullName = (merged.full_name || merged.name || '').trim()
        || [merged.given_name, merged.family_name].filter(Boolean).join(' ').trim()
        || (merged.given_name || '').trim();
    const displayName = fullName
        || (user.email ? user.email.replace(/@.*$/, '').replace(/^(\w)/, (m) => m.toUpperCase()) : null)
        || 'Account';
    const email = (user.email || merged.email || '').trim();
    return { displayName, email };
}

async function initSettingsPage() {
    const guestMsg = document.getElementById('settings-guest-msg');
    const formWrap = document.getElementById('settings-form-wrap');
    const form = document.getElementById('settings-form');
    const nameInput = document.getElementById('settings-name');
    const emailInput = document.getElementById('settings-email');
    const messageEl = document.getElementById('settings-message');
    const saveBtn = document.getElementById('settings-save');
    if (!formWrap || !form) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        if (guestMsg) guestMsg.style.display = 'block';
        return;
    }
    formWrap.style.display = 'block';
    const { displayName, email } = getAuthUserDisplayInfo(user);
    nameInput.value = displayName === 'Account' ? '' : displayName;
    emailInput.value = email;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newName = (nameInput.value || '').trim();
        const newEmail = (emailInput.value || '').trim();
        if (!newEmail) {
            messageEl.textContent = (typeof window.t === 'function' ? window.t('email_required') : 'Email is required.');
            messageEl.style.color = '#b91c1c';
            return;
        }
        saveBtn.disabled = true;
        messageEl.textContent = '';
        try {
            const updates = { data: { full_name: newName || null } };
            if (newEmail !== (user.email || '')) updates.email = newEmail;
            const { data: updated, error } = await supabase.auth.updateUser(updates);
            if (error) throw error;
            if (typeof setupNavbarAuth === 'function') await setupNavbarAuth();
            messageEl.textContent = (typeof window.t === 'function' ? window.t('saved') : 'Saved.');
            messageEl.style.color = '#059669';
            if (updated && updated.user) {
                const { displayName: d, email: em } = getAuthUserDisplayInfo(updated.user);
                nameInput.value = d === 'Account' ? '' : d;
                emailInput.value = em;
            }
        } catch (err) {
            messageEl.textContent = err.message || (typeof window.t === 'function' ? window.t('save_failed') : 'Failed to save.');
            messageEl.style.color = '#b91c1c';
        }
        saveBtn.disabled = false;
    });
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

/** Load a job in the app when user clicks "Open in app" (/?open=jobId). Loads file URL + transcript JSON. */
async function initOpenInApp(jobId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // Fetch job without result first so we never 400 if result column is missing
    const { data: job, error } = await supabase
        .from('jobs')
        .select('id, input_s3_key')
        .eq('id', jobId)
        .eq('user_id', user.id)
        .single();
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
            const mime = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska' };
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
    const mainBtn = document.getElementById('main-btn');
    if (mainBtn) { mainBtn.disabled = false; mainBtn.innerText = (typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload and Process'); }
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

window.downloadFile = async function(type, bypassUser = null) {
    if (!window.currentSegments.length) return alert("No transcript available to export.");
    const baseName = (window.originalFileName && window.originalFileName.split('.').slice(0, -1).join('.')) || "transcript";

    if (type === 'movie') {
        console.log('[movie export] Start');
        const { data: { user: movieUser } } = await supabase.auth.getUser();
        if (!movieUser) {
            console.log('[movie export] No user – show sign-in');
            alert("Please sign in to download the movie.");
            window.pendingExportType = 'movie';
            localStorage.setItem('pendingExportType', 'movie');
            localStorage.setItem('pendingS3Key', localStorage.getItem('lastS3Key') || '');
            localStorage.setItem('pendingJobId', localStorage.getItem('lastJobId') || '');
            if (typeof window.toggleModal === 'function') window.toggleModal(true);
            return;
        }
        console.log('[movie export] User OK');
        const video = document.getElementById('main-video');
        const videoUrl = video ? (video.currentSrc || video.src || (video.querySelector('source') && video.querySelector('source').src) || '') : '';
        if (!video || !videoUrl || videoUrl.startsWith('data:')) {
            console.log('[movie export] No video/URL');
            return alert("Load a video first, then use Styled Subtitles before downloading the movie.");
        }

        const durationSec = (video.duration && Number.isFinite(video.duration)) ? video.duration : 0;
        const widthPx = (video.videoWidth && video.videoWidth > 0) ? video.videoWidth : 0;
        console.log('[movie export] Video OK – duration', durationSec, 's, width', widthPx);
        const limitMsg = typeof window.t === 'function' ? window.t('burn_limits_msg') : "The current system supports files under 10 minutes and 1080p resolution for this feature.";
        if (durationSec > 600 || (widthPx > 0 && widthPx > 1080)) {
            console.log('[movie export] Over limits – abort');
            if (typeof showStatus === 'function') showStatus(limitMsg, true);
            return alert(limitMsg);
        }

        const inputS3Key = localStorage.getItem('lastS3Key');
        if (!inputS3Key || !inputS3Key.startsWith('users/')) {
            console.log('[movie export] No/invalid lastS3Key:', inputS3Key ? inputS3Key.substring(0, 30) + '…' : 'null');
            if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('movie_burn_failed') : "Movie burn failed: ", true);
            return alert("Video must be from your uploads (save and use Styled Subtitles from an uploaded video).");
        }
        console.log('[movie export] S3 key OK');

        try {
            if (typeof showStatus === 'function') showStatus("Preparing export…", false);
            if (typeof ensureJobRecordOnExport === 'function') {
                console.log('[movie export] Ensuring job record…');
                await ensureJobRecordOnExport();
                console.log('[movie export] Job record done');
            }
            console.log('[movie export] Fetching simulation_mode…');
            const simRes = await fetch('/api/simulation_mode');
            const simJson = simRes.ok ? await simRes.json() : {};
            console.log('[movie export] Simulation mode:', simJson.simulation);
            if (simJson.simulation === true) {
                if (typeof showStatus === 'function') showStatus((typeof window.t === 'function' ? window.t('downloading_video_srt') : "Downloading video and subtitles..."), false);
                console.log('[movie export] Simulation branch – downloading video+SRT');
                const videoBlob = await fetch(videoUrl).then(r => r.blob());
                if (typeof saveAs !== 'undefined') saveAs(videoBlob, (baseName || 'video') + '.mp4');
                const segments = window.currentSegments || [];
                let srt = '';
                segments.forEach((seg, i) => {
                    const ts = (s) => {
                        const d = new Date(0); d.setMilliseconds(s * 1000);
                        return d.toISOString().substr(11, 12).replace('.', ',');
                    };
                    srt += `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${(seg.text || '').trim()}\n\n`;
                });
                if (typeof saveAs !== 'undefined') saveAs(new Blob([srt], { type: 'text/plain;charset=utf-8' }), (baseName || 'video') + '.srt');
                if (typeof showStatus === 'function') showStatus((typeof window.t === 'function' ? window.t('video_srt_downloaded') : "Video and SRT downloaded"), false);
                return;
            }

            const burnTakesMsg = typeof window.t === 'function' ? window.t('burn_takes_minutes') : "This usually takes 2–5 minutes. We'll email you when your video is ready.";
            const encodingMsg = typeof window.t === 'function' ? window.t('burn_encoding_in_progress') : "Encoding in progress… We'll email you when it's ready.";
            if (typeof showStatus === 'function') showStatus(burnTakesMsg, false);
            console.log('[movie export] Calling burn_subtitles_server…');
            const segments = (window.currentSegments || []).map(s => ({ start: s.start, end: s.end || s.start + 1, text: s.text || '' }));
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
                    if (typeof showStatus === 'function') showStatus(encodingMsg + (pollCount > 1 ? ` (${pollCount})` : ''), false);
                    console.log('[movie export] Poll', pollCount, '…');
                }
                const statusRes = await fetch(`/api/burn_subtitles_status?task_id=${encodeURIComponent(taskId)}`);
                statusJson = statusRes.ok ? await statusRes.json() : {};
            }
            if (statusJson.status === 'failed') {
                console.log('[movie export] Failed:', statusJson.error);
                throw new Error(statusJson.error || "Burn failed");
            }
            if (statusJson.status === 'completed' && statusJson.output_url) {
                console.log('[movie export] Completed – downloading');
                if (typeof showStatus === 'function') showStatus("Downloading…", false);
                const outName = (baseName || 'video') + '_with_subtitles.mp4';
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
                if (typeof showStatus === 'function') showStatus((typeof window.t === 'function' ? window.t('movie_downloaded') : "Movie downloaded"), false);
            } else {
                console.log('[movie export] Timeout or no output_url:', statusJson);
                throw new Error("Burn did not complete in time");
            }
        } catch (e) {
            console.error('[movie export] Error:', e);
            if (typeof showStatus === 'function') showStatus((typeof window.t === 'function' ? window.t('movie_burn_failed') : "Movie burn failed: ") + (e.message || e), true);
            alert("Failed to burn subtitles: " + (e.message || e));
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

    if (type === 'docx' && typeof docx === 'undefined') return alert("Error: DOCX library not loaded.");
    if (typeof saveAs === 'undefined') return alert("Error: FileSaver library not loaded.");

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
        window.currentSegments.forEach((seg, i) => {
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
        if (error) alert("Google Login Error: " + error.message);
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

    // Settings page: load user and handle form
    if (typeof window.location !== 'undefined' && (window.location.pathname === '/settings' || window.location.pathname.endsWith('/settings'))) {
        initSettingsPage();
    }

    // History / My files page: list user's jobs and allow downloading originals from S3
    if (typeof window.location !== 'undefined' && (window.location.pathname === '/history' || window.location.pathname.endsWith('/history'))) {
        initHistoryPage();
    }

    const transcriptWindow = document.getElementById('transcript-window');
    const mainAudio = document.getElementById('main-audio');

    document.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.addEventListener('click', function() {
            const type = this.getAttribute('data-type');
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

                // When the user presses Play, set a simulation flag and request the server
                mainAudio.addEventListener('play', async () => {
                    window.simulationFlag = true;
                    try {
                        await fetch('/api/set_simulation', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ run: true })
                        });

                        // Start a background python process (for local development)
                        await fetch('/api/start_process', { method: 'POST' });

                        if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('simulation_started') : 'Simulation started', false);
                    } catch (err) {
                        console.error('Failed to start simulation:', err);
                        if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('simulation_failed') : 'Failed to start simulation', true);
                    }
                });

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

            mainVideoEl.addEventListener('play', async () => {
                window.simulationFlag = true;
                try {
                    await fetch('/api/set_simulation', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ run: true })
                    });
                    await fetch('/api/start_process', { method: 'POST' });
                    if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('simulation_started') : 'Simulation started', false);
                } catch (err) {
                    console.error('Failed to start simulation:', err);
                    if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('simulation_failed') : 'Failed to start simulation', true);
                }
            });

            mainVideoEl._qs_listeners_attached = true;
        }

        // 5. RESTORE TRANSCRIPT FROM LOCALSTORAGE (so export works after refresh / auth)
        const savedTranscript = localStorage.getItem('pendingTranscript');
        if (savedTranscript) {
            try {
                const parsed = JSON.parse(savedTranscript);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    window.currentSegments = parsed;
                    if (typeof window.render === 'function') window.render();
                }
            } catch (e) { console.warn('Restore transcript:', e); }
        }

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
        if (!email) return alert(typeof window.t === 'function' ? window.t('enter_email') : "Please enter your email address.");

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
            showStatus(err.message, true);
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
    const btnStyled = document.getElementById('btn-styled-subtitles');
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
        mainBtn.innerText = typeof window.t === 'function' ? window.t('upload_and_process') : 'Upload and Process';
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

    if (btnStyled) btnStyled.style.display = 'none';
    if (editActions) editActions.style.display = 'none';

    document.querySelectorAll('.controls-bar').forEach(bar => { if (bar) bar.style.display = 'flex'; });
    if (typeof syncSpeakerControls === 'function') syncSpeakerControls();
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

    // When user clicks main upload button, reset screen to initial state then open file picker
    if (mainBtn) {
        mainBtn.addEventListener('click', () => {
            resetScreenToInitial();
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
        // When the user presses Play, set a simulation flag and request the server
        mainAudio.addEventListener('play', async () => {
            window.simulationFlag = true;
            try {
                await fetch('/api/set_simulation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ run: true })
                });

                // Start a background python process (for local development)
                await fetch('/api/start_process', { method: 'POST' });

                if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('simulation_started') : 'Simulation started', false);
            } catch (err) {
                console.error('Failed to start simulation:', err);
                if (typeof showStatus === 'function') showStatus(typeof window.t === 'function' ? window.t('simulation_failed') : 'Failed to start simulation', true);
            }
        });
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
    window.handleJobUpdate = function(rawResult) {
        const dbId = localStorage.getItem('lastJobDbId');

        // 1. CLEAR OVERLAYS & STOP PROGRESS
        window.isTriggering = false;
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

        const statusTxt = document.getElementById('upload-status');
        if (statusTxt) {
            statusTxt.innerText = typeof window.t === 'function' ? window.t('transcription_complete') : "Transcription Complete";
            setTimeout(() => {
                const preparingScreen = document.getElementById('preparing-screen');
                if (preparingScreen) preparingScreen.style.display = 'none';
            }, 3000);
        }
        const preparingScreen = document.getElementById('preparing-screen');
        if (preparingScreen) preparingScreen.style.display = 'none';

        const pContainer = document.getElementById('p-container');
        const progressBar = document.getElementById('progress-bar');
        if (pContainer) pContainer.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';

        // 1. SHOW PLAYER: same layout (video-wrapper) for both audio (m4a) and video so transcript is visible in parallel
        const playerContainer = document.getElementById('audio-player-container');
        const videoWrapper = document.getElementById('video-wrapper');
        const videoPlayer = document.getElementById('video-player-container');
        const mainVideo = document.getElementById('main-video');
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        const savedUrl = localStorage.getItem('currentAudioUrl');

        if (window.uploadWasVideo === true) {
            // Video: keep audio bar in place (will show video when user clicks Styled Subtitles)
            if (playerContainer && videoWrapper && videoPlayer && playerContainer.parentNode === videoPlayer) {
                videoWrapper.parentNode.insertBefore(playerContainer, videoWrapper);
            }
            if (playerContainer) playerContainer.style.display = 'block';
            if (videoWrapper) { videoWrapper.classList.remove('visible'); videoWrapper.style.display = 'none'; }
            if (mainVideo) mainVideo.style.display = '';
            if (audioSource && mainAudio && savedUrl) { audioSource.src = savedUrl; mainAudio.load(); }
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

        // 2. UNHIDE CORE COMPONENTS; show Styled Subtitles button only when MP4 was uploaded
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
        const btnStyled = document.getElementById('btn-styled-subtitles');
        if (btnStyled) btnStyled.style.display = (window.uploadWasVideo === true) ? 'inline-block' : 'none';

        const mainBtn = document.getElementById('main-btn');
        if (mainBtn) {
            mainBtn.disabled = false;
            mainBtn.innerText = typeof window.t === 'function' ? window.t('upload_and_process') : "Upload and Process";
        }

        // 3. PROCESS DATA — support multiple API shapes (RunPod, simulation, etc.)
        const output = rawResult.result || rawResult.output || rawResult;
        let segments = (output && output.segments) || rawResult.segments || (rawResult.data && rawResult.data.segments) || [];
        if (!Array.isArray(segments)) segments = [];
        segments = splitLongSegments(segments, 55);
        window.currentSegments = segments;

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
                            body: JSON.stringify({ userId: user.id, input_s3_key: s3Key, segments: window.currentSegments })
                        });
                        const data = res.ok ? await res.json() : {};
                        if (data.result_s3_key) {
                            updateJobStatus(dbId, 'processed', { result_s3_key: data.result_s3_key });
                        } else {
                            updateJobStatus(dbId, 'processed', { segments: window.currentSegments });
                        }
                    } else {
                        updateJobStatus(dbId, 'processed', { segments: window.currentSegments });
                    }
                } catch (_) {
                    updateJobStatus(dbId, 'processed', { segments: window.currentSegments });
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
                </div>
                <p ${!window.isDocumentMode ? `data-idx="${rowIndex}"` : ''} style="margin: 0; cursor: pointer; line-height: 1.6;" onclick="window.jumpTo(${g.start})">
                    ${g.text}
                </p>
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

        // 1. EXTRACT FROM SCREEN: Update the master array ONLY on save
        win.querySelectorAll('p[data-idx]').forEach(p => {
            const i = parseInt(p.getAttribute('data-idx'));
            if (!isNaN(i) && window.currentSegments[i]) {
                window.currentSegments[i].text = p.innerText.trim();
            }
        });

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
                    }
                } catch (_) { /* ignore */ }
            })();
        }

        // 3. LOCK UI: Close edit mode
        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";

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
        const cueSettings = (window.currentSubtitleStyle === 'tiktok') ? ' line:50% position:50% align:middle' : '';
        const maxCharsPerLine = 42; // Force ~2 lines on PC (mobile wraps naturally)
        for (const c of window.currentSegments) {
            vttLines.push(`${fmt(c.start)} --> ${fmt(c.end)}${cueSettings}`);
            let text = (c.text || '').replace(/<[^>]+>/g, '').trim();
            if (text.length > maxCharsPerLine) {
                const mid = Math.floor(text.length / 2);
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

            // Save a backup in case the user cancels
            window.transcriptBackup = win.innerHTML;

            // Show the Save/Cancel buttons
            if (editActions) editActions.style.display = 'flex';
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

            const p = sel.anchorNode && sel.anchorNode.nodeType === Node.ELEMENT_NODE
                ? sel.anchorNode.closest('p[data-idx]')
                : sel.anchorNode ? sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('p[data-idx]') : null;
            if (!p || !p.hasAttribute('data-idx')) return;

            const idx = parseInt(p.getAttribute('data-idx'), 10);
            if (isNaN(idx) || !window.currentSegments || !window.currentSegments[idx]) return;

            const offset = getCaretCharacterOffsetWithin(p);
            const seg = window.currentSegments[idx];
            const text = (seg.text || '').trim();
            const len = text.length;
            if (offset <= 0) { e.preventDefault(); return; }
            if (offset >= len) {
                e.preventDefault();
                const end = seg.end != null ? seg.end : seg.start + 1;
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

            e.preventDefault();
            const start = seg.start;
            const end = seg.end != null ? seg.end : seg.start + 1;
            const ratio = offset / len;
            const splitTime = start + ratio * (end - start);
            const beforeText = text.slice(0, offset).trimEnd();
            const afterText = text.slice(offset).trimStart();

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
        });
    })();

    function buildGroupHTML(group) {
        const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
        const isTimeVisible = document.getElementById('toggle-time')?.checked;

        const rawSpeaker = group.speaker || "SPEAKER_00";
        const speakerDisplay = rawSpeaker.replace('SPEAKER_', 'דובר ');
        const fullText = group.sentences.map(s => s.text).join(" ");

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
            </div>
        </div>`;
    }
    function startFakeProgress() {
        let current = 0;
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
        window.fakeProgressInterval = setInterval(() => {
            if (current < 95) {
                current += 0.5;
                if (progressBar) progressBar.style.width = current + "%";
                if (statusTxt) statusTxt.innerText = (typeof window.t === 'function' ? window.t('analyzing_content') : 'Analyzing content...') + ' ' + Math.floor(current) + '%';
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

            // Hide "Upload a file to start" placeholder as soon as user selects a file (and during processing)
            var placeholderEl = document.getElementById('placeholder');
            if (placeholderEl) placeholderEl.style.display = 'none';

            // Track whether this upload is video so we show Styled Subtitles button only for video. Treat m4a/mp3 etc. as audio.
            window.uploadWasVideo = false;
            try {
                const isAudio = (file.type && file.type.startsWith('audio')) || /\.(m4a|mp3|wav|aac|ogg|flac|weba)$/i.test(file.name);
                const isVideo = !isAudio && ((file.type && file.type.startsWith('video')) || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(file.name));
                if (isVideo) {
                    window.uploadWasVideo = true;
                    const url = URL.createObjectURL(file);
                    window.originalFileName = file.name.replace(/\.[^.]+$/, '');
                    const src = document.getElementById('video-source');
                    const video = document.getElementById('main-video');
                    if (src) src.src = url;
                    if (video) {
                        video.style.position = 'relative';
                        video.style.zIndex = '1002';
                        video.controls = true;
                        video.load();
                        video.pause();
                        try { video.focus(); } catch (e) {}
                    }
                    // Continue to upload and process (do not return) so transcription runs for video too
                }
                // If the user selected a subtitle file (srt/vtt/text), handle it locally
                const isSubtitle = (file.type && (file.type.includes('vtt') || file.type.includes('text'))) || /\.(srt|vtt|txt)$/i.test(file.name);
                if (isSubtitle) {
                    try {
                        await handleSubtitleFile(file);
                        showStatus(typeof window.t === 'function' ? window.t('subtitle_loaded') : 'Subtitle loaded locally', false);
                    } catch (e) {
                        console.warn('Local subtitle load failed', e);
                        showStatus(typeof window.t === 'function' ? window.t('subtitle_load_failed') : 'Failed to load subtitle locally', true);
                    }
                    fileInput.value = '';
                    return;
                }
            } catch (e) {
                console.warn('Video preview failed', e);
            }

            // CREATE A LOCAL PREVIEW URL
            const objectUrl = URL.createObjectURL(file);
            localStorage.setItem('currentAudioUrl', objectUrl);
            localStorage.setItem('currentAudioMime', file.type || '');

            const currentFile = file; // Captured for use in the fetch
            fileInput.value = ""; // Reset for next selection

            // 1. Get the snapshot of the toggle state RIGHT NOW
            const diarizationValue = document.getElementById('diarization-toggle')?.checked || false;

            // UI Feedback: show progress bar for upload phase
            const pContainer = document.getElementById('p-container');
            if (pContainer) { pContainer.style.display = "block"; }
            if (progressBar) { progressBar.style.width = "0%"; }
            if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = (typeof window.t === 'function' ? window.t('processing') : "Processing..."); }
            if (statusTxt) { statusTxt.innerText = (typeof window.t === 'function' ? window.t('uploading') : "Uploading..."); statusTxt.style.display = "block"; }
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
                        if (statusTxt) statusTxt.innerText = (typeof window.t === 'function' ? window.t('uploading') : "Uploading...") + " " + pct + "%";
                    }
                };

                xhr.onload = async () => {
                    if (xhr.status === 200 || xhr.status === 201) {
                        if (progressBar) progressBar.style.width = "100%";
                        if (statusTxt) statusTxt.innerText = (typeof window.t === 'function' ? window.t('uploading') : "Uploading...") + " 100%";
                        console.log("✅ File uploaded to S3. Triggering processing...");
                        window.isTriggering = true;
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
                                    language: 'he'
                                })
                            });
                            const triggerData = triggerRes.ok ? await triggerRes.json() : {};

                            if (triggerRes.status === 202 && triggerData.status === 'queued') {
                                const queuedMsg = typeof window.t === 'function' ? window.t('job_queued_waiting_gpu') : "Job queued. Waiting for GPU…";
                                if (statusTxt) statusTxt.innerText = queuedMsg;
                                const pollInterval = 2000;
                                const maxWait = 360000;
                                const start = Date.now();
                                let ts = { status: '' };
                                while (ts.status !== 'triggered' && ts.status !== 'failed' && (Date.now() - start) < maxWait) {
                                    await new Promise(r => setTimeout(r, pollInterval));
                                    const stRes = await fetch(`/api/trigger_status?job_id=${encodeURIComponent(jobId)}`);
                                    ts = stRes.ok ? await stRes.json() : {};
                                }
                                if (ts.status === 'failed') {
                                    const dbId2 = localStorage.getItem('lastJobDbId');
                                    if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                                    window.isTriggering = false;
                                    if (mainBtn) mainBtn.disabled = false;
                                    if (typeof showStatus === 'function') showStatus("GPU trigger failed.", true);
                                    return;
                                }
                                if (ts.status === 'triggered' && typeof startFakeProgress === 'function') startFakeProgress();
                            } else if (triggerRes.ok && (triggerData.status === 'started' || triggerData.status === 'queued')) {
                                if (typeof startFakeProgress === 'function') startFakeProgress();
                            }
                        } catch (err) {
                            const dbId2 = localStorage.getItem('lastJobDbId');
                            if (typeof updateJobStatus === 'function' && dbId2) updateJobStatus(dbId2, 'failed');
                            window.isTriggering = false;
                            if (mainBtn) mainBtn.disabled = false;
                            throw err;
                        }
                    } else {
                        console.error("S3 Upload Failed:", xhr.statusText);
                        const dbId = localStorage.getItem('lastJobDbId');
                        if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
                        window.isTriggering = false;
                        if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                    }
                };

                xhr.onerror = () => {
                    console.error("XHR Network Error during upload.");
                    const dbId = localStorage.getItem('lastJobDbId');
                    if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
                    window.isTriggering = false;
                };

                xhr.send(currentFile);

            }
            catch (err) {
                console.error("Upload Error:", err);
                window.isTriggering = false;
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
        // Accept 00:00:05,123 or 00:00:05.123
        const parts = t.replace(',', '.').split(':');
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

        const m = timeLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{1,3})/);
        if (!m) continue;
        const start = toSeconds(m[1]);
        const end = toSeconds(m[2]);
        const text = lines.slice(textStartIdx).join('\n');
        cues.push({ start, end, text });
    }
    return cues;
}

function srtFromCues(cues) {
    return cues.map((c, i) => {
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
    if (!cues || cues.length === 0) {
        container.innerHTML = '<p style="color:#9ca3af; text-align:center; margin-top:40px;">No subtitles loaded</p>';
        return;
    }
    const html = cues.map((c, idx) => {
        // split into words and assign approximate per-word timings
        const words = String(c.text || '').split(/(\s+)/).filter(Boolean);
        const dur = Math.max(0.001, (c.end || (c.start + 0.5)) - c.start);
        let acc = 0;
        const wordSpans = words.map((w, wi) => {
            // treat whitespace tokens as raw text (no timing)
            if (/^\s+$/.test(w)) return w.replace(/ /g, '&nbsp;');
            const start = c.start + (acc * dur / words.length);
            const end = c.start + ((acc + 1) * dur / words.length);
            acc++;
            const safe = w.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<span class="word-token" data-idx="${idx}" data-start="${start}" data-end="${end}">${safe}</span>`;
        }).join('');

        return `
        <div class="paragraph-row" id="seg-${Math.floor(c.start)}" style="margin-bottom:12px; direction: rtl; text-align: right;">
            <div style="font-size:0.85em; color:#6b7280; margin-bottom:4px;">[${formatTime(Math.floor(c.start))}]</div>
            <p data-idx="${idx}" style="margin:0; line-height:1.6;">${wordSpans}</p>
        </div>`;
    }).join('');

    container.innerHTML = html;
    container.contentEditable = 'false';
}

async function handleSubtitleFile(file) {
    if (!file) return;
    const text = await file.text();
    // If VTT, strip header
    const isVtt = text.trim().startsWith('WEBVTT');
    const srtText = isVtt ? text.replace(/^WEBVTT.*\n+/,'') : text;
    
    let cues = parseSRT(srtText);
    
    // NEW: Pass local subtitle uploads through the Chopper too!
    if (typeof splitLongSegments === 'function') {
        cues = splitLongSegments(cues, 55);
    }
    renderTranscriptFromCues(cues);
    
    // Keep transcript read-only until user presses Edit; ensure controls and player visible
    try {
        const container = document.getElementById('transcript-window');
        if (container) container.setAttribute('contenteditable', 'false');
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
        const video = document.getElementById('main-video');
        if (video) video.style.display = 'block';
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
            vttLines.push(c.text.replace(/<[^>]+>/g, ''));
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
    showStatus('Subtitles loaded', false);
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
    
    // Styled Subtitles button: show video player + style cards
    const btnStyledSubtitles = document.getElementById('btn-styled-subtitles');
    if (btnStyledSubtitles) {
        btnStyledSubtitles.addEventListener('click', function() {
            const audioContainer = document.getElementById('audio-player-container');
            const videoWrapper = document.getElementById('video-wrapper');
            if (audioContainer) audioContainer.style.display = 'none';
            if (videoWrapper) {
                videoWrapper.style.display = 'flex';
                videoWrapper.classList.add('visible');
            }
            if (window.currentSegments && window.currentSegments.length > 0) {
                if (typeof window.refreshVideoSubtitles === 'function') {
                    window.refreshVideoSubtitles();
                }
                if (typeof window.showSubtitleStyleSelector === 'function') {
                    window.showSubtitleStyleSelector();
                }
            }
        });
    }
    
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