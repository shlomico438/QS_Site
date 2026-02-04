// Add this to your GLOBAL STATE section
window.isTriggering = false;

// --- 1. GLOBAL SOCKET INITIALIZATION ---
if (typeof socket !== 'undefined') {
    socket.on('connect', () => {
        const savedJobId = localStorage.getItem('activeJobId');
        if (savedJobId) {
            console.log("🔄 Re-joining room:", savedJobId);
            socket.emit('join', { room: savedJobId });
        }
    });

    // CHANGE: Listen for 'job_status_update' instead of 'job_finished'
    socket.on('job_status_update', (data) => {
        console.log("📩 AI Results Received via Socket:", data);
        if (typeof window.handleJobUpdate === 'function') {
            window.handleJobUpdate(data);
        }
    });
}

// --- GLOBAL STATE ---
window.fakeProgressInterval = null;
window.currentSegments = [];
window.originalFileName = "transcript";
window.hasMultipleSpeakers = false;

document.addEventListener('DOMContentLoaded', () => {
    const transcriptWindow = document.getElementById('transcript-window');
    const fileInput = document.getElementById('fileInput');
    const statusTxt = document.getElementById('upload-status');
    const progressBar = document.getElementById('progress-bar');
    const mainBtn = document.getElementById('main-btn');

    // --- 2. THE HANDLER (Hides overlay and turns switch Blue) ---
    window.handleJobUpdate = function(rawResult) {
        // 1. Immediately hide the "Preparing" overlay
        const preparingScreen = document.getElementById('preparing-screen');
        if (preparingScreen) preparingScreen.style.display = 'none';

        // 2. Release the trigger lock for the next file upload
        window.isTriggering = false;

        // 3. Reset Button
        const mainBtn = document.getElementById('main-btn');
        if (mainBtn) {
            mainBtn.disabled = false;
            mainBtn.innerText = "Upload and Process";
        }
        try {
            if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

            // RESET BUTTON & STATUS
            if (mainBtn) {
                mainBtn.disabled = false;
                mainBtn.innerText = "Upload and Process";
            }
            if (statusTxt) statusTxt.innerText = "✅ Done";

            // HIDE OVERLAY
            const preparingScreen = document.getElementById('preparing-screen');
            if (preparingScreen) preparingScreen.style.display = 'none';

            // SHOW SWITCHES
            document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');

            // DATA EXTRACTION
            const output = rawResult.result || rawResult.output || rawResult;
            const segments = output.segments || (Array.isArray(output) ? output : null);

            if (!segments) return console.error("No segments found.");

            window.currentSegments = segments;
            const hasSpeakers = segments.some(s => s.speaker);

            // This triggers the Navy Blue color
            updateSpeakerToggleUI(hasSpeakers);

            if (transcriptWindow && typeof renderParagraphs === 'function') {
                transcriptWindow.innerHTML = renderParagraphs(segments);
            }
        } catch (e) { console.error("Handler Error:", e); }
    };

    // --- 3. UI HELPERS ---
    function updateSpeakerToggleUI(hasSpeakerData) {
        const switches = [document.getElementById('diarization-toggle'), document.getElementById('toggle-speaker')];
        switches.forEach(sw => {
            if (!sw) return;
            sw.disabled = false; // Always unlock
            sw.parentElement.style.opacity = "1";
            if (hasSpeakerData) sw.checked = true; // Turn Blue (#1e3a8a)
        });
    }

    const formatTime = (s) => {
        const d = new Date(0); d.setSeconds(s);
        return d.toISOString().substr(14, 5);
    };

    const getSpeakerColor = (id) => {
        const colors = ['#5d5dff', '#9333ea', '#059669', '#d97706'];
        const num = id ? parseInt(id.match(/\d+/)) : 0;
        return colors[num % colors.length];
    };

    // --- 4. RENDER LOGIC ---
    function renderParagraphs(segments) {
        const unique = new Set(segments.map(s => s.speaker));
        window.hasMultipleSpeakers = unique.size > 1;
        let html = "", group = null;
        segments.forEach(seg => {
            if (!group || group.speaker !== seg.speaker) {
                if (group) html += buildGroupHTML(group);
                group = { speaker: seg.speaker, start: seg.start, text: "" };
            }
            group.text += `<span class="clickable-sent" onclick="jumpTo(${seg.start})">${seg.text} </span>`;
        });
        if (group) html += buildGroupHTML(group);
        return html;
    }

    function buildGroupHTML(g) {
        const isDummy = (g.speaker === "SPEAKER_00" && !window.hasMultipleSpeakers);
        return `<div class="paragraph-row ${isDummy ? 'no-speaker' : ''}">
                <div class="ts-col">${formatTime(g.start)}</div>
                <div class="text-col">
                    <span class="speaker-label" style="color:${getSpeakerColor(g.speaker)}; ${isDummy ? 'display:none' : ''}">
                        ${g.speaker ? g.speaker.replace('SPEAKER_', 'דובר ') : ''}
                    </span>
                    <p>${g.text}</p>
                </div>
            </div>`;
    }

    // --- 5. UPLOAD LOGIC (FIXED 403) ---
    // Replace your existing fileInput listener with this
    if (fileInput) {
        fileInput.addEventListener('change', async function() {
            // 1. Check the lock
            if (window.isTriggering) {
                console.warn("Already processing. Please wait or refresh.");
                return;
            }

            const file = this.files[0];
            if (!file) return;

            // Clear the input value immediately.
            // This allows the 'change' event to fire again if you select the same file later.
            const currentFile = file;
            fileInput.value = "";

            // UI RESET
            if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = "Processing..."; }
            if (statusTxt) statusTxt.innerText = "Uploading...";

            try {
                const signRes = await fetch('/api/sign-s3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: currentFile.name, filetype: currentFile.type })
                });

                const signData = await signRes.json();
                const { url, s3Key, jobId } = signData.data || signData;

                localStorage.setItem('activeJobId', jobId);
                socket.emit('join', { room: jobId }); // Join room immediately

                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                xhr.setRequestHeader('Content-Type', currentFile.type);

                xhr.onload = async () => {
                    if (xhr.status === 200 && !window.isTriggering) {
                        window.isTriggering = true; // Lock engaged

                        await fetch('/api/trigger_processing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                s3Key: s3Key, jobId: jobId,
                                diarization: document.getElementById('diarization-toggle')?.checked || false
                            })
                        });
                        startFakeProgress();
                    } else {
                        // Release lock if upload fails
                        window.isTriggering = false;
                        if (mainBtn) mainBtn.disabled = false;
                    }
                };

                // Release lock if network error occurs during PUT
                xhr.onerror = () => {
                    window.isTriggering = false;
                    if (mainBtn) mainBtn.disabled = false;
                };

                xhr.send(currentFile);
            } catch (err) {
                console.error(err);
                window.isTriggering = false; // Release lock on error
                if (mainBtn) mainBtn.disabled = false;
            }
        });
    }
});