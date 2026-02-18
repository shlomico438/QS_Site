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
        // Get name from Google or Manual Signup
        const firstName = user.user_metadata?.full_name?.split(' ')[0] || "Dana";

        // User is logged in: Show Name + Log Out
        navBtn.innerHTML = `Welcome, ${firstName} | <span style="font-weight:400; font-size:0.9em;">Log Out</span>`;
        navBtn.style.color = "#1e3a8a";
        navBtn.onclick = async (e) => {
            e.preventDefault();
            await supabase.auth.signOut();
            window.location.reload();
        };
    } else {
        // User is logged out: Show "Sign In"
        navBtn.innerText = "Sign In";
        navBtn.style.color = "#5d5dff";
        navBtn.onclick = (e) => {
            e.preventDefault();
            window.toggleModal(true);
        };
    }
}


async function startJobExport({ type, s3Key }) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
        .from('jobs')
        .insert([
            {
                user_id: user.id,
                type: type, // This will now save as 'copy', 'txt', etc.
                status: 'completed',
                input_s3_key: s3Key,
                // Add metadata if you want to track Shlomi's specific workshop
                metadata: { client_name: "Shlomi Cohen", exported_at: new Date() }
            }
        ]);

    if (error) throw error;
    console.log(`✅ Success! ${type} event saved for ${user.email}`);
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
    const { data: { user: activeUser } } = bypassUser ? { data: { user: bypassUser } } : await supabase.auth.getUser();
    if (!activeUser) {
        console.log("💾 Parking export type:", type);
        window.pendingExportType = type;
        localStorage.setItem('pendingExportType', type);

        window.toggleModal(true); // Open the sign-in modal
        return; // <--- CRITICAL: This stops the function here so the file doesn't download
    }
    const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";
    const showTime = document.getElementById('toggle-time')?.checked;
    const showSpeaker = document.getElementById('toggle-speaker')?.checked;

    //SAVE TO DATABASE ---
    try {
        const fileDetails = {
            type: 'transcription', // or 'render' depending on your logic
            s3Key: localStorage.getItem('lastS3Key') // We need to store this during upload
        };

        // Call your Supabase function
        await startJobExport(fileDetails);
        console.log("Job record synced to Supabase.");
    } catch (err) {
        console.error("Failed to sync job to database:", err);
        // We don't block the download if the DB fails,
        // but we log it for debugging.
    }
    // -----------------------------

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


// Google Login Handler
document.getElementById('google-login').addEventListener('click', async () => {
    if (window.currentSegments.length > 0) {
            localStorage.setItem('pendingTranscript', JSON.stringify(window.currentSegments));
        }
    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            // This ensures they come back to your current page after logging in
            redirectTo: window.location.origin
        }
    });
    if (error) alert("Google Login Error: " + error.message);
});

// Update your Toggle Mode logic to be cleaner
document.getElementById('toggle-auth-mode').addEventListener('click', (e) => {
    e.preventDefault();
    isSignUpMode = !isSignUpMode;

    document.getElementById('modal-title').innerText = isSignUpMode ? "Get Started" : "Welcome Back";
    document.getElementById('signup-fields').style.display = isSignUpMode ? "block" : "none";
    document.getElementById('auth-submit-btn').innerText = isSignUpMode ? "Sign Up & Export" : "Log In & Export";
    document.getElementById('auth-switch-text').innerText = isSignUpMode ? "Already have an account?" : "Need an account?";
    document.getElementById('toggle-auth-mode').innerText = isSignUpMode ? "Log In" : "Sign Up";
});

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Always setup the Navbar first
    await setupNavbarAuth();
    const transcriptWindow = document.getElementById('transcript-window');

    document.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.addEventListener('click', function() {
        const type = this.getAttribute('data-type');
        console.log("🖱️ User requested export:", type);
        window.downloadFile(type);
        });
    });

    if (transcriptWindow) {
        transcriptWindow.oncontextmenu = (e) => {
            // Only allow right-click if we are editing
            if (transcriptWindow.contentEditable !== "true") {
                e.preventDefault();
                return false;
            }
        };
    }
    // 2. Get the session
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) {
        console.error("Auth session error:", sessionError.message);
        return;
    }

    // 3. --- PASSWORD RECOVERY LOGIC (Keep this!) ---
    if (session && window.location.hash.includes('type=recovery')) {
        const newPassword = prompt("Please enter your new password:");
        if (newPassword) {
            const { error } = await supabase.auth.updateUser({ password: newPassword });
            if (error) alert("Error resetting password: " + error.message);
            else alert("Password updated successfully!");
        }
    }

    // 4. --- DATA RECOVERY LOGIC (For Google Login) ---
    const savedTranscript = localStorage.getItem('pendingTranscript');
    const savedS3Key = localStorage.getItem('pendingS3Key');

    if (savedTranscript && session) {
        console.log("Found pending transcript. Recovering UI...");

        window.currentSegments = JSON.parse(savedTranscript);

        // 1. UNHIDE UI COMPONENTS
        // This shows the player, the export buttons, and the switches
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');

        const playerContainer = document.getElementById('audio-player-container');
        if (playerContainer) playerContainer.style.display = 'block';

        // 2. RESTORE THE AUDIO
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        const savedUrl = localStorage.getItem('currentAudioUrl');

        if (audioSource && mainAudio && savedUrl) {
            fetch(savedUrl).catch(async () => {
                // Check both for existence and the literal string "undefined"
                if (savedS3Key && savedS3Key !== "undefined") {
                    console.log("Local audio expired. Fetching from S3...");
                    try {
                        const response = await fetch('/api/get_presigned_url', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ s3Key: savedS3Key })
                        });

                        if (!response.ok) throw new Error("Backend failed to provide URL");

                        const data = await response.json();

                        // Safety: Only load if we actually got a URL back
                        if (data.url) {
                            audioSource.src = data.url;
                            mainAudio.load();
                            console.log("✅ Audio restored from S3");
                        } else {
                            console.warn("Backend returned no URL:", data.error);
                        }
                    } catch (err) {
                        console.error("Fetch error:", err);
                    } // Added missing closing brace for 'try'
                } else {
                    console.warn("No S3 key found for recovery.");
                }
            });
        }

        // 3. RENDER THE TEXT
        if (typeof window.render === 'function') {
            window.render();
        }

        // 4. SYNC SWITCHES (Ensures 'Show Speakers' works)
        if (typeof syncSpeakerControls === 'function') {
            // We assume AI ran if there is speaker data
            const uniqueSpeakers = new Set(window.currentSegments.map(s => s.speaker).filter(s => s));
            window.aiDiarizationRan = uniqueSpeakers.size > 1;
            syncSpeakerControls();
        }

        // 5. DATABASE SYNC (Your existing logic)
        if (savedS3Key) {
            localStorage.setItem('lastS3Key', savedS3Key);
            try {
                await startJobExport({ type: 'transcription', s3Key: savedS3Key });
            } catch (err) { console.error("Export failed:", err); }
        }


        //const type = window.pendingExportType; // 'docx', 'srt', or 'vtt'
        const savedExportType = localStorage.getItem('pendingExportType') || window.pendingExportType;

        if (savedExportType) {
            const user = session.user; // Use the user from the session we just fetched
            console.log(`🚀 Auto-resuming pending ${savedExportType} export...`);

            // Trigger the download instantly
            window.downloadFile(savedExportType, user);

            // Reset the pending type so it doesn't loop
            window.pendingExportType = null;
            localStorage.removeItem('pendingExportType');
            showStatus(`Exporting your ${savedExportType.toUpperCase()} file...`, false);
        }


        // Clean up LocalStorage so it doesn't run again on next refresh
        localStorage.removeItem('pendingTranscript');
        localStorage.removeItem('pendingS3Key');
    }
});

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

            // Find the segment that matches the current time
            let activeSegment = null;
            window.currentSegments.forEach(seg => {
                if (currentTime >= seg.start) {
                    activeSegment = seg;
                }
            });

            if (activeSegment) {
                // Remove highlight from everyone
                document.querySelectorAll('.paragraph-row').forEach(row => {
                    row.style.backgroundColor = "transparent";
                    row.style.borderLeft = "none";
                });

                // Add highlight to the active one
                const activeRow = document.getElementById(`seg-${Math.floor(activeSegment.start)}`);
                if (activeRow) {
                    activeRow.style.backgroundColor = "#f0f7ff"; // Light blue highlight
                    activeRow.style.borderLeft = "4px solid #1e3a8a"; // Navy accent

                    // Optional: Auto-scroll the transcript to keep up with the audio
                    // activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

        // 1. UNHIDE THE PLAYER
        const playerContainer = document.getElementById('audio-player-container');
        if (playerContainer) playerContainer.style.display = 'block';

        // 2. LOAD THE AUDIO
        // Retrieve the local URL we stored during the 'change' event
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        const savedUrl = localStorage.getItem('currentAudioUrl');

        if (audioSource && mainAudio && savedUrl) {
            audioSource.src = savedUrl;
            mainAudio.load(); // Force the player to recognize the new file
        }

        // 2. UNHIDE CORE COMPONENTS
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
        const audioPlayer = document.getElementById('audio-player-container');
        if (audioPlayer) audioPlayer.style.display = 'block';

        const mainBtn = document.getElementById('main-btn');
        if (mainBtn) {
            mainBtn.disabled = false;
            mainBtn.innerText = "Upload and Process";
        }

        // 3. PROCESS DATA
        const output = rawResult.result || rawResult.output || rawResult;
        const segments = output.segments || [];
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
            transcriptWindow.innerHTML = renderParagraphs(segments);
        }
    };

    function groupSegmentsBySpeaker(segments) {
        if (!segments || segments.length === 0) return [];

        const groups = [];
        // Normalize the speaker: if it's missing, call it 'monologue'
        let currentGroup = {
            speaker: segments[0].speaker || 'monologue',
            start: segments[0].start,
            text: segments[0].text
        };

        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i];
            const segSpeaker = seg.speaker || 'monologue';

            // If the normalized speaker matches, merge the text
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

        const groupedData = groupSegmentsBySpeaker(window.currentSegments);

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
        const audio = document.querySelector('audio');
        if (audio) {
            audio.currentTime = seconds;
            audio.play();
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
                await startJobExport({
                    type: 'copy', // Distinguishes from 'txt' or 'docx'
                    s3Key: currentS3Key
                });
            } catch (err) {
                console.error("Failed to log copy event:", err);
            }
        });
    };
    window.saveEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');

        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";

        if (editActions) editActions.style.display = 'none';

        console.log("✅ Edits saved locally.");
        // Note: To save permanently to a database, you would add a fetch() here.
    };

    window.cancelEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');

        if (window.transcriptBackup) {
            win.innerHTML = window.transcriptBackup;
        }

        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";

        if (editActions) editActions.style.display = 'none';
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
                // 1. Get the Signed URL from Python
                const signRes = await fetch('/api/sign-s3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: currentFile.name,
                        filetype: currentFile.type,
                        diarization: diarizationValue
                    })
                });

                const result = await signRes.json();

                // Safety check for Dana's app logic
                if (!result.data) {
                    throw new Error("Failed to get S3 signature from server.");
                }

                const { url, s3Key, jobId } = result.data;

                // 2. 💾 PARK THE KEYS IMMEDIATELY
                // This ensures recovery works for shlomico1234@gmail.com after login
                localStorage.setItem('lastS3Key', s3Key);
                localStorage.setItem('pendingS3Key', s3Key);
                localStorage.setItem('lastJobId', jobId);
                console.log("💾 Keys parked for recovery:", s3Key);

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

                        // 5. Trigger GPU/RunPod
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
                    } else {
                        console.error("S3 Upload Failed:", xhr.statusText);
                        window.isTriggering = false;
                        if (typeof mainBtn !== 'undefined') mainBtn.disabled = false;
                    }
                };

                xhr.onerror = () => {
                    console.error("XHR Network Error during upload.");
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