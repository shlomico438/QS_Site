import { supabase } from './supabaseClient.js'

// --- GLOBAL STATE ---
window.isTriggering = false;
window.aiDiarizationRan = false;
window.fakeProgressInterval = null;
window.currentSegments = [];
window.originalFileName = "transcript";
window.hasMultipleSpeakers = false;
let isSignUpMode = true;

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
function splitLongSegments(segments, maxChars = 55) {
    const result = [];
    
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
            // Check if adding this word (with space) would exceed the limit
            const testText = currentText + word + ' ';
            if (testText.length > maxChars && currentText.length > 0) {
                chunks.push(currentText.trim());
                currentText = word + ' ';
            } else {
                currentText += word + ' ';
            }
        }
        if (currentText.trim()) {
            chunks.push(currentText.trim());
        }

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
        navBtn.innerHTML = `<span class="nav-user-name" id="nav-user-name-trigger" role="button" tabindex="0">${escapeHtml(displayName)}</span> <span class="nav-auth-divider">|</span> <span class="nav-logout" id="nav-logout-btn">Log Out</span>`;
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
        navBtn.innerHTML = 'Sign In';
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
        label.textContent = filenameFromKey(job.input_s3_key) + ' — ' + (job.status || '') + ' · ' + formatDate(job.created_at);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'user-menu-file-get';
        btn.textContent = 'Get file';
        if (!job.input_s3_key) {
            btn.disabled = true;
            btn.title = 'No file key';
        } else {
            btn.onclick = async () => {
                btn.disabled = true;
                try {
                    const res = await fetch('/api/get_presigned_url', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key: job.input_s3_key, userId: user.id })
                    });
                    const json = await res.json();
                    if (json.url) window.open(json.url, '_blank');
                    else showStatus(json.error || 'Failed to get link', true);
                } catch (e) {
                    showStatus(e.message || 'Failed', true);
                }
                btn.disabled = false;
            };
        }
        item.appendChild(label);
        item.appendChild(btn);
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
            messageEl.textContent = 'Email is required.';
            messageEl.style.color = '#b91c1c';
            return;
        }
        saveBtn.disabled = true;
        messageEl.textContent = '';
        try {
            const updates = { data: { full_name: newName || undefined } };
            if (newEmail !== (user.email || '')) updates.email = newEmail;
            const { data, error } = await supabase.auth.updateUser(updates);
            if (error) throw error;
            if (typeof setupNavbarAuth === 'function') await setupNavbarAuth();
            window.location.href = '/';
        } catch (err) {
            messageEl.textContent = err.message || 'Failed to save.';
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
        if (emptyMsg) { emptyMsg.textContent = 'Could not load list. ' + (error.message || ''); emptyMsg.style.display = 'block'; }
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
        label.textContent = filenameFromKey(job.input_s3_key) + ' — ' + (job.status || '') + ' · ' + formatDate(job.created_at);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Get file';
        btn.style.cssText = 'padding:6px 12px; background:#1e3a8a; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.875rem;';
        if (!job.input_s3_key) {
            btn.disabled = true;
            btn.title = 'No file key';
        } else {
            btn.onclick = async () => {
                btn.disabled = true;
                try {
                    const res = await fetch('/api/get_presigned_url', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ s3Key: job.input_s3_key, userId: user.id })
                    });
                    const json = await res.json();
                    if (json.url) window.open(json.url, '_blank');
                    else showStatus(json.error || 'Failed to get link', true);
                } catch (e) {
                    showStatus(e.message || 'Failed', true);
                }
                btn.disabled = false;
            };
        }
        li.appendChild(label);
        li.appendChild(btn);
        listEl.appendChild(li);
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

async function updateJobStatus(dbId, status) {
    if (!dbId) return;
    const { error } = await supabase
        .from('jobs')
        .update({ status, updated_at: new Date().toISOString() })
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



window.downloadFile = async function(type, bypassUser = null) {
    if (!window.currentSegments.length) return alert("No transcript available to export.");
    const baseName = (window.originalFileName && window.originalFileName.split('.').slice(0, -1).join('.')) || "transcript";

    if (type === 'movie') {
        const { data: { user: movieUser } } = await supabase.auth.getUser();
        if (!movieUser) {
            alert("Please sign in to download the movie.");
            window.pendingExportType = 'movie';
            localStorage.setItem('pendingExportType', 'movie');
            localStorage.setItem('pendingS3Key', localStorage.getItem('lastS3Key') || '');
            localStorage.setItem('pendingJobId', localStorage.getItem('lastJobId') || '');
            if (typeof window.toggleModal === 'function') window.toggleModal(true);
            return;
        }
        const video = document.getElementById('main-video');
        const videoUrl = video ? (video.currentSrc || video.src || (video.querySelector('source') && video.querySelector('source').src) || '') : '';
        if (!video || !videoUrl || videoUrl.startsWith('data:')) return alert("Load a video first, then use Styled Subtitles before downloading the movie.");
        try {
            // Mark job as exported (or create job if user signed in after upload)
            if (typeof ensureJobRecordOnExport === 'function') {
                await ensureJobRecordOnExport();
            }
            const simRes = await fetch('/api/simulation_mode');
            const simJson = simRes.ok ? await simRes.json() : {};
            if (simJson.simulation === true) {
                // Simulation: download video + SRT (edited transcript) as separate files, no burn
                if (typeof showStatus === 'function') showStatus("Downloading video and subtitles...", false);
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
                if (typeof showStatus === 'function') showStatus("Video and SRT downloaded", false);
                return;
            }
            if (typeof showStatus === 'function') showStatus("Burning subtitles (browser)...", false);
            await window.downloadMovieWithBurnedSubtitles(baseName);
            if (typeof showStatus === 'function') showStatus("Movie downloaded", false);
        } catch (e) {
            if (typeof showStatus === 'function') showStatus("Movie burn failed: " + (e.message || e), true);
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

// Toggle auth mode (Sign Up / Log In) — only on pages that have the auth modal
const toggleAuthBtn = document.getElementById('toggle-auth-mode');
if (toggleAuthBtn) {
    toggleAuthBtn.addEventListener('click', (e) => {
        e.preventDefault();
        isSignUpMode = !isSignUpMode;
        document.getElementById('modal-title').innerText = isSignUpMode ? "Get Started" : "Welcome Back";
        document.getElementById('signup-fields').style.display = isSignUpMode ? "block" : "none";
        document.getElementById('auth-submit-btn').innerText = isSignUpMode ? "Sign Up & Export" : "Log In & Export";
        document.getElementById('auth-switch-text').innerText = isSignUpMode ? "Already have an account?" : "Need an account?";
        document.getElementById('toggle-auth-mode').innerText = isSignUpMode ? "Log In" : "Sign Up";
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Always setup the Navbar first
    await setupNavbarAuth();

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
                    // Debug: log current time and segment counts
                    console.debug('audio timeupdate', { currentTime, segments: (window.currentSegments || []).length });

                    // Find the segment that matches the current time (prefer segments where currentTime is between start and end)
                    let activeSegment = null;
                    if (window.currentSegments && window.currentSegments.length) {
                        activeSegment = window.currentSegments.find(seg => (currentTime >= seg.start && (seg.end ? currentTime <= seg.end : currentTime < (seg.start + 5))));
                        if (!activeSegment) {
                            // Fallback: choose last segment that started before currentTime
                            for (let i = 0; i < window.currentSegments.length; i++) {
                                const seg = window.currentSegments[i];
                                if (currentTime >= seg.start) activeSegment = seg;
                            }
                        }
                    }

                    if (activeSegment) {
                        // Remove highlight from everyone
                        document.querySelectorAll('.paragraph-row').forEach(row => {
                            row.style.backgroundColor = "transparent";
                            row.style.borderLeft = "none";
                        });
                        document.querySelectorAll('.paragraph-row p').forEach(p => {
                            p.style.backgroundColor = "transparent";
                        });

                        // Add highlight to the active one
                        const activeRow = document.getElementById(`seg-${Math.floor(activeSegment.start)}`);
                        if (activeRow) {
                            activeRow.style.backgroundColor = "#f0f7ff"; // Light blue highlight
                            activeRow.style.borderLeft = "4px solid #1e3a8a"; // Navy accent
                            const p = activeRow.querySelector('p');
                            if (p) {
                                p.style.backgroundColor = "#fff9c4"; // Light yellow
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

                        if (typeof showStatus === 'function') showStatus('Simulation started', false);
                    } catch (err) {
                        console.error('Failed to start simulation:', err);
                        if (typeof showStatus === 'function') showStatus('Failed to start simulation', true);
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
                console.debug('video timeupdate', { currentTime, segments: (window.currentSegments || []).length });

                // Find the active segment more precisely
                let activeSegment = null;
                if (window.currentSegments && window.currentSegments.length) {
                    activeSegment = window.currentSegments.find(seg => (currentTime >= seg.start && (seg.end ? currentTime <= seg.end : currentTime < (seg.start + 5))));
                    if (!activeSegment) {
                        for (let i = 0; i < window.currentSegments.length; i++) {
                            const seg = window.currentSegments[i];
                            if (currentTime >= seg.start) activeSegment = seg;
                        }
                    }
                }

                try {
                    // Clear previous highlights
                    document.querySelectorAll('.paragraph-row').forEach(row => row.classList.remove('active-highlight'));
                    document.querySelectorAll('.paragraph-row p').forEach(p => p.style.backgroundColor = "transparent");

                    if (activeSegment) {
                        const id = `seg-${Math.floor(activeSegment.start)}`;
                        const activeRow = document.getElementById(id);
                        if (activeRow) {
                            console.log('video activeSegment', activeSegment.start, 'id', id, 'elemExists=', !!activeRow);
                            activeRow.classList.add('active-highlight');
                            // auto-scroll a bit to keep in view
                            activeRow.scrollIntoView({ behavior: 'auto', block: 'nearest' });
                            const p = activeRow.querySelector('p');
                            if (p) {
                                p.style.backgroundColor = "#fff9c4"; // Light yellow
                                activeRow.scrollIntoView({ behavior: 'auto', block: 'nearest' });
                            }
                        } else {
                            console.log('Highlight: no element found for', id, 'currentTime=', currentTime);
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
                    if (typeof showStatus === 'function') showStatus('Simulation started', false);
                } catch (err) {
                    console.error('Failed to start simulation:', err);
                    if (typeof showStatus === 'function') showStatus('Failed to start simulation', true);
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
            if (user && typeof showStatus === 'function') showStatus(`Exporting your ${savedExportType.toUpperCase()} file...`, false);
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
        authBtn.innerText = "Log Out";
        authBtn.onclick = async () => {
            await supabase.auth.signOut();
            window.location.reload();
        };
    }
}

document.getElementById('forgot-password-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;

    if (!email) {
        alert("Please enter your email address first.");
        return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin, // This sends them back to your site
    });

    if (error) alert(error.message);
    else alert("Password reset email sent! Check your inbox.");
});

const authSubmitBtn = document.getElementById('auth-submit-btn');
if (authSubmitBtn) {
    authSubmitBtn.addEventListener('click', async () => {
        console.log("🖱️ Auth Submit Clicked. Current Mode:", isSignUpMode ? "SignUp" : "Login");

        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;

        if (!email || !password) return alert("Please fill in all fields.");

        authSubmitBtn.disabled = true;
        authSubmitBtn.innerText = "Processing...";

        try {
            let result;
            if (isSignUpMode) {
                result = await supabase.auth.signUp({
                    email, password,
                    options: { data: { full_name: document.getElementById('auth-name')?.value } }
                });
            } else {
                result = await supabase.auth.signInWithPassword({ email, password });
            }

            if (result.error) throw result.error;

            console.log("✅ Auth Success. User:", result.user?.email);

            // --- DEBUG: CHECKING PENDING STATE ---
            console.log("🔍 Pending Export Type:", window.pendingExportType);
            console.log("🔍 Current Segments Length:", window.currentSegments?.length);

            const user = result.data.user; // Get the user from the result
            console.log("✅ Login Success for:", user.email);
            window.toggleModal(false);

            if (typeof setupNavbarAuth === 'function') {
                await setupNavbarAuth();
            }

            // --- THE CRITICAL TRIGGER ---
            if (window.currentSegments && window.currentSegments.length > 0) {
                const typeToResume = window.pendingExportType || 'docx';
                console.warn("🚀 TRIGGERING DOWNLOAD AUTOMATICALLY FOR:", typeToResume);

                // We wrap this in a tiny timeout to ensure the modal
                // is fully closed and the browser is ready.
                setTimeout(() => {
                    if (window.pendingExportType) {
                        console.warn("🚀 EXECUTING DOWNLOAD:", typeToResume);
                        window.downloadFile(typeToResume, user);
                        window.pendingExportType = null;
                    }
                }, 100);
            } else {
                console.warn("⚠️ No transcript found to auto-export. Reloading...");
                window.location.reload();
            }

        } catch (err) {
            console.error("❌ Auth Error Details:", err);
            showStatus(err.message, true);
        } finally {
            authSubmitBtn.disabled = false;
            authSubmitBtn.innerText = isSignUpMode ? "Sign Up & Export" : "Log In & Export";
        }
    });
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

    // Ensure toggles refresh the view immediately
    document.getElementById('toggle-time')?.addEventListener('change', () => render());
    document.getElementById('toggle-speaker')?.addEventListener('change', () => render());
    if (mainAudio) {
        mainAudio.addEventListener('timeupdate', () => {
            const currentTime = mainAudio.currentTime;
            // Debug: log current time and segment counts
            console.debug('audio timeupdate', { currentTime, segments: (window.currentSegments || []).length });

            // Find the segment that matches the current time (prefer segments where currentTime is between start and end)
            let activeSegment = null;
            if (window.currentSegments && window.currentSegments.length) {
                activeSegment = window.currentSegments.find(seg => (currentTime >= seg.start && (seg.end ? currentTime <= seg.end : currentTime < (seg.start + 5))));
                if (!activeSegment) {
                    // Fallback: choose last segment that started before currentTime
                    for (let i = 0; i < window.currentSegments.length; i++) {
                        const seg = window.currentSegments[i];
                        if (currentTime >= seg.start) activeSegment = seg;
                    }
                }
            }

            if (activeSegment) {
                // Remove highlight from everyone
                document.querySelectorAll('.paragraph-row').forEach(row => {
                    row.style.backgroundColor = "transparent";
                    row.style.borderLeft = "none";
                });
                document.querySelectorAll('.paragraph-row p').forEach(p => {
                    p.style.backgroundColor = "transparent";
                });

                // Add highlight to the active one
                const activeRow = document.getElementById(`seg-${Math.floor(activeSegment.start)}`);
                if (activeRow) {
                    activeRow.style.backgroundColor = "#f0f7ff"; // Light blue highlight
                    activeRow.style.borderLeft = "4px solid #1e3a8a"; // Navy accent

                    // Optional: Auto-scroll the transcript to keep up with the audio
                    // activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    const p = activeRow.querySelector('p');
                    if (p) {
                        p.style.backgroundColor = "#fff9c4"; // Light yellow
                    }
                }
            }
        });
        // Mirror highlighting behavior for video element if present
        const mainVideo = document.getElementById('main-video');
        if (mainVideo) {
            mainVideo.addEventListener('timeupdate', () => {
                const currentTime = mainVideo.currentTime;
                console.debug('video timeupdate', { currentTime, segments: (window.currentSegments || []).length });

                // Find the active segment more precisely
                let activeSegment = null;
                if (window.currentSegments && window.currentSegments.length) {
                    activeSegment = window.currentSegments.find(seg => (currentTime >= seg.start && (seg.end ? currentTime <= seg.end : currentTime < (seg.start + 5))));
                    if (!activeSegment) {
                        for (let i = 0; i < window.currentSegments.length; i++) {
                            const seg = window.currentSegments[i];
                            if (currentTime >= seg.start) activeSegment = seg;
                        }
                    }
                }

                // Debug: log active times when no highlight appears
                // (This helps users paste console output if things still fail)
                try {
                    // Clear previous highlights
                    document.querySelectorAll('.paragraph-row').forEach(row => row.classList.remove('active-highlight'));
                    document.querySelectorAll('.paragraph-row p').forEach(p => p.style.backgroundColor = "transparent");

                    if (activeSegment) {
                        const id = `seg-${Math.floor(activeSegment.start)}`;
                        const activeRow = document.getElementById(id);
                            if (activeRow) {
                                console.log('video activeSegment', activeSegment.start, 'id', id, 'elemExists=', !!activeRow);
                                activeRow.classList.add('active-highlight');
                                // auto-scroll a bit to keep in view
                                activeRow.scrollIntoView({ behavior: 'auto', block: 'nearest' });
                                const p = activeRow.querySelector('p');
                                if (p) {
                                    p.style.backgroundColor = "#fff9c4"; // Light yellow
                                    activeRow.scrollIntoView({ behavior: 'auto', block: 'nearest' });
                                }
                            } else {
                                console.log('Highlight: no element found for', id, 'currentTime=', currentTime);
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

                if (typeof showStatus === 'function') showStatus('Simulation started', false);
            } catch (err) {
                console.error('Failed to start simulation:', err);
                if (typeof showStatus === 'function') showStatus('Failed to start simulation', true);
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
        if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'processed');

        // 1. CLEAR OVERLAYS & STOP PROGRESS
        window.isTriggering = false;
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

        const statusTxt = document.getElementById('upload-status');
        if (statusTxt) {
            statusTxt.innerText = "Transcription Complete"; // Or set to "" to hide it
            // Optional: Hide the container after 3 seconds
            setTimeout(() => {
                const preparingScreen = document.getElementById('preparing-screen');
                if (preparingScreen) preparingScreen.style.display = 'none';
            }, 3000);
        }
        const preparingScreen = document.getElementById('preparing-screen');
        if (preparingScreen) preparingScreen.style.display = 'none';

        // 1. UNHIDE AUDIO PLAYER (default view after transcription - no video yet)
        const playerContainer = document.getElementById('audio-player-container');
        if (playerContainer) playerContainer.style.display = 'block';

        // Hide video wrapper so user sees transcript + audio first
        const videoWrapper = document.getElementById('video-wrapper');
        if (videoWrapper) {
            videoWrapper.classList.remove('visible');
            videoWrapper.style.display = 'none';
        }

        // 2. LOAD THE AUDIO
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        const savedUrl = localStorage.getItem('currentAudioUrl');

        if (audioSource && mainAudio && savedUrl) {
            audioSource.src = savedUrl;
            mainAudio.load();
        }

        // 3. UNHIDE CORE COMPONENTS; show Styled Subtitles button only when MP4 was uploaded
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
        const audioPlayer = document.getElementById('audio-player-container');
        if (audioPlayer) audioPlayer.style.display = 'block';
        const btnStyled = document.getElementById('btn-styled-subtitles');
        if (btnStyled) btnStyled.style.display = (window.uploadWasVideo === true) ? 'inline-block' : 'none';

        const mainBtn = document.getElementById('main-btn');
        if (mainBtn) {
            mainBtn.disabled = false;
            mainBtn.innerText = "Upload and Process";
        }

        // 3. PROCESS DATA — support multiple API shapes (RunPod, simulation, etc.)
        const output = rawResult.result || rawResult.output || rawResult;
        let segments = (output && output.segments) || rawResult.segments || (rawResult.data && rawResult.data.segments) || [];
        if (!Array.isArray(segments)) segments = [];
        segments = splitLongSegments(segments, 55);
        window.currentSegments = segments;
        
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
            // Show subtitle style selector when subtitles are available
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


        const html = groupedData.map(g => {
            // 2. Fixed: Get state of both toggles
            const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
            const isTimeVisible = document.getElementById('toggle-time')?.checked;

            const showLabel = isSpeakerVisible && window.aiDiarizationRan;

            return `
            <div class="paragraph-row" style="margin-bottom: 20px;">
                <div style="font-size: 0.85em; color: #888; margin-bottom: 4px;">

                    <span class="timestamp" style="display: ${isTimeVisible ? 'inline' : 'none'};">
                        ${formatTime(g.start)}
                    </span>

                    <span style="display: ${showLabel ? 'inline' : 'none'}; font-weight: bold; margin-right: 10px; color: ${getSpeakerColor(g.speaker)}">
                        ${isTimeVisible ? '| ' : ''}${g.speaker.replace('SPEAKER_', 'דובר ')}
                    </span>
                </div>
                <p style="margin: 0; cursor: pointer; line-height: 1.6;" onclick="window.jumpTo(${g.start})">
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
            showStatus("Copied to clipboard!"); // Using our new toast!

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

        for (const c of window.currentSegments) {
            vttLines.push(`${fmt(c.start)} --> ${fmt(c.end)}`);
            vttLines.push(c.text.replace(/<[^>]+>/g, '')); // Strip out any HTML spans
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

        // Force the browser to display it
        track.addEventListener('load', () => {
            try {
                Array.from(video.textTracks).forEach(tt => tt.mode = 'showing');
                // Reapply subtitle style after track loads
                window.applySubtitleStyle(window.currentSubtitleStyle);
            } catch (e) { console.warn("Track mode error:", e); }
        });
        
        // Show style selector
        window.showSubtitleStyleSelector();
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
                if (statusTxt) statusTxt.innerText = `Analyzing content... ${Math.floor(current)}%`;
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

            // Track whether this upload is video (mp4) so we show Styled Subtitles button only for video
            window.uploadWasVideo = false;
            try {
                const isVideo = (file.type && file.type.startsWith('video')) || /\.(mp4|webm|mov)$/i.test(file.name);
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
                        showStatus('Subtitle loaded locally', false);
                    } catch (e) {
                        console.warn('Local subtitle load failed', e);
                        showStatus('Failed to load subtitle locally', true);
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

            const currentFile = file; // Captured for use in the fetch
            fileInput.value = ""; // Reset for next selection

            // 1. Get the snapshot of the toggle state RIGHT NOW
            const diarizationValue = document.getElementById('diarization-toggle')?.checked || false;

            // UI Feedback
            if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = "Processing..."; }
            if (statusTxt) { statusTxt.innerText = "Uploading..."; statusTxt.style.display = "block"; }

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

                xhr.onload = async () => {
                    if (xhr.status === 200 || xhr.status === 201) {
                        console.log("✅ File uploaded to S3. Triggering processing...");
                        window.isTriggering = true;
                        const dbId = localStorage.getItem('lastJobDbId');
                        if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'uploaded');

                        try {
                            await fetch('/api/trigger_processing', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    s3Key: s3Key,
                                    jobId: jobId,
                                    diarization: diarizationValue
                                })
                            });
                            if (typeof startFakeProgress === 'function') startFakeProgress();
                        } catch (err) {
                            const dbId = localStorage.getItem('lastJobDbId');
                            if (typeof updateJobStatus === 'function' && dbId) updateJobStatus(dbId, 'failed');
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
                if (typeof showStatus === 'function') showStatus("Error starting upload.", true);
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
    if (!window.currentSegments || window.currentSegments.length === 0) return showStatus('No subtitles to download', true);
    const srt = srtFromCues(window.currentSegments);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    saveAs(blob, (window.originalFileName || 'video') + '.srt');
}

async function createBurnedInVideo() {
    const video = document.getElementById('main-video');
    if (!video || !video.currentSrc) return showStatus('Load a video file first', true);
    if (!window.currentSegments || window.currentSegments.length === 0) return showStatus('Load subtitles first', true);

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
        showStatus('Video with subtitles created', false);
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

    showStatus('Rendering video — please wait until playback finishes', false);
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
        showStatus('Video loaded locally', false);
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