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
        if (window.isTriggering) return; // Prevent triple triggers if multiple events fire

        const file = this.files[0];
        if (!file) return;

        // RESET UI
        if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = "Processing..."; }
        if (statusTxt) statusTxt.innerText = "Uploading...";
        if (transcriptWindow) transcriptWindow.innerHTML = `<p id="preparing-screen" style="text-align:center; margin-top:80px;">Preparing file...</p>`;

        try {
            const signRes = await fetch('/api/sign-s3', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, filetype: file.type })
            });

            const signData = await signRes.json();
            // Extraction using s3Key to match backend sign_s3 return
            const { url, s3Key, jobId } = signData.data || signData;

            localStorage.setItem('activeJobId', jobId);
            socket.emit('join', { room: jobId }); // Join room immediately

            const xhr = new XMLHttpRequest();
            xhr.open('PUT', url, true);
            xhr.setRequestHeader('Content-Type', file.type);

            xhr.onload = async () => {
                // Ensure we only trigger ONCE even if the browser sends multiple onload events
                if (xhr.status === 200 && !window.isTriggering) {
                    window.isTriggering = true; // Lock engaged

                    await fetch('/api/trigger_processing', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            s3Key: s3Key,
                            jobId: jobId,
                            diarization: document.getElementById('diarization-toggle')?.checked || false
                        })
                    });

                    // Start progress bar
                    let current = 0;
                    window.fakeProgressInterval = setInterval(() => {
                        if (current < 95) {
                            current += 0.5;
                            if (progressBar) progressBar.style.width = current + "%";
                            if (statusTxt) statusTxt.innerText = `Transcribing... ${Math.floor(current)}%`;
                        }
                    }, 1000);
                }
            };
            xhr.send(file);
        } catch (err) {
            console.error(err);
            window.isTriggering = false; // Release lock if error occurs
        }
    });
}
});