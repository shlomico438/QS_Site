// --- 1. GLOBAL SOCKET INITIALIZATION ---
// We define listeners here (outside DOMContentLoaded) so we never miss a message
if (typeof socket !== 'undefined') {
    socket.on('connect', () => {
        // 1. Check if we are actually waiting for a job
        const savedJobId = localStorage.getItem('activeJobId');
        if (savedJobId) {
            // CASE A: User is waiting -> Show the status!
            console.log("🔄 Re-joining room:", savedJobId);
            socket.emit('join', { room: savedJobId });

            // +++ NEW: Check immediately upon reconnection (don't wait 5s) +++
            fetch(`/api/check_status/${savedJobId}`)
                .then(res => res.json())
                .then(data => {
                     if (data.status === 'completed' || data.status === 'success') {
                         window.handleJobUpdate(data);
                     }
                }).catch(() => {});
            // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

            // Optional: Update UI only if a job exists
            const statusTxt = document.getElementById('upload-status');
            if (statusTxt) statusTxt.innerText = "♻️ Connection Restored. Checking status...";
        }
    });
    socket.on('disconnect', (reason) => {
        console.warn("⚠️ Socket Lost Connection:", reason);
        // If Koyeb kills the connection, try to kickstart it
        if (reason === "io server disconnect") {
            socket.connect();
        }
    });

    socket.on('job_status_update', (data) => {
        console.log("📩 AI Results Received:", data);
        // We call the handler that lives inside the DOM block
        if (window.handleJobUpdate) {
            window.handleJobUpdate(data);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // --- UI ELEMENTS ---
    const transcriptWindow = document.getElementById('transcript-window');
    const fileInput = document.getElementById('fileInput');
    const statusTxt = document.getElementById('upload-status');
    const progressBar = document.getElementById('progress-bar');
    const pContainer = document.getElementById('p-container');
    const mainBtn = document.getElementById('main-btn');
    const audioContainer = document.getElementById('audio-player-container');
    const audioSource = document.getElementById('audio-source');
    const mainAudio = document.getElementById('main-audio');
    const controlsBar = document.querySelector('.controls-bar');
    const downloadMenu = document.getElementById('download-menu');

    // --- GLOBAL STATE ---
    window.fakeProgressInterval = null;
    window.currentSegments = [];
    window.originalFileName = "transcript";

    // --- 2. THE HANDLER (Attached to window so global socket can see it) ---
 window.handleJobUpdate = function(data) {
        const currentStatus = data.status ? data.status.toLowerCase() : "";

        if (currentStatus === "completed" || currentStatus === "success") {
            localStorage.removeItem('activeJobId');
            if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

            if (pContainer) pContainer.style.display = 'none';
            if (statusTxt) statusTxt.innerText = "Transcription complete!";
            if (mainBtn) {
            mainBtn.innerText = "Process Another File";
            mainBtn.disabled = false;
            }
            const allControlBars = document.querySelectorAll('.controls-bar');
            allControlBars.forEach(bar => {
                bar.style.display = 'flex';
            });

            // === NEW: DISABLE SPEAKER TOGGLES IF FAST MODE ===
            // Check if the first segment is the "Dummy" speaker
            let isFastMode = false;
            let firstSeg = null;

            // Safe extraction of the first segment
            if (data.result && data.result.segments) firstSeg = data.result.segments[0];
            else if (data.segments) firstSeg = data.segments[0];

            if (firstSeg && firstSeg.speaker === "SPEAKER_00") {
                isFastMode = true;
            }

            // Find the switches in the toolbar (toggle-speaker)
            const speakerSwitches = document.querySelectorAll('#toggle-speaker, input[id$="speaker"]'); // Broad selector to catch it

            speakerSwitches.forEach(sw => {
                if (isFastMode) {
                    sw.checked = false;          // Turn it off
                    sw.disabled = true;          // Disable clicking
                    sw.parentElement.title = "Speaker detection was disabled for this file.";
                    sw.parentElement.style.opacity = "0.5";
                } else {
                    sw.disabled = false;
                    sw.parentElement.style.opacity = "1";
        }
    };

    // --- 3. ERROR HANDLING ---
    window.onerror = (msg) => console.error("System Error: " + msg);


// --- 4. TOOLBAR & DROPDOWN (Final Fix) ---
    const downloadBtns = document.querySelectorAll('#btn-download');
    // FIX: Select ALL menus (Mobile + PC) to ensure we get the right one
    const allDownloadMenus = document.querySelectorAll('#download-menu');

    if (downloadBtns.length > 0) {
        downloadBtns.forEach(btn => {
            // Remove old listeners to prevent "Double Click" stack
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);

            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log("🚑 Button Clicked! (Opening Menu)");

                // Toggle ALL menus found
                allDownloadMenus.forEach(menu => {
                    // Simple Toggle
                    menu.classList.toggle('show');
                });
            });
        });
    }

    // Close menu when clicking anywhere else
    document.addEventListener('click', (e) => {
        // Only close if we didn't click inside the menu itself
        allDownloadMenus.forEach(menu => {
            if (!menu.contains(e.target) && menu.classList.contains('show')) {
                menu.classList.remove('show');
            }
        });
    });


    // Close menu when clicking anywhere else on the document
    document.addEventListener('click', () => {
        if (downloadMenu && downloadMenu.classList.contains('show')) {
             downloadMenu.classList.remove('show');
        }
    });

    // --- 5. HELPERS (Time, Color, Formatting) ---
    const formatTime = (s) => {
        const mins = Math.floor(s / 60);
        const secs = Math.floor(s % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const getSpeakerColor = (speakerId) => {
        const colors = ['#5d5dff', '#9333ea', '#059669', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#ca8a04'];
        const match = speakerId ? speakerId.match(/\d+/) : null;
        const index = match ? parseInt(match[0]) : 0;
        return colors[index % colors.length];
    };

    const formatSpeaker = (raw) => {
        if (!raw) return "דובר לא ידוע";
        if (raw === "SPEAKER_00") return "";

        const match = raw.match(/SPEAKER_(\d+)/);
        return match ? `דובר ${parseInt(match[1]) + 1}` : raw;
    };

// --- HTTP FALLBACK POLLING ---
// This ensures you get the result even if the Socket dies completely.

setInterval(() => {
    const activeJobId = localStorage.getItem('activeJobId');

    // Only poll if we are actually waiting for a job
    if (activeJobId) {
        console.log("🚑 Safety Check: Asking server via HTTP...");

        fetch(`/api/check_status/${activeJobId}`)
            .then(response => response.json())
            .then(data => {
                // If the server says "completed", update the UI immediately
                if (data.status === 'completed' || data.status === 'success') {
                    console.log("✅ HTTP Poll found the result!", data);
                    if (window.handleJobUpdate) {
                        window.handleJobUpdate(data);
                    }
                }
            })
            .catch(err => console.warn("Poll failed (ignoring):", err));
    }
}, 5000); // Check every 5 seconds

    function renderParagraphs(segments) {
        let html = "", group = null;
        segments.forEach(seg => {
            if (!group || group.speaker !== seg.speaker) {
                if (group) html += buildGroupHTML(group);
                group = { speaker: seg.speaker, start: seg.start, sentences: [] };
            }
            group.sentences.push(seg);
        });
        if (group) html += buildGroupHTML(group);
        return html;
    }

    function buildGroupHTML(g) {
        // --- 1. DETECT DUMMY SPEAKER (FAST MODE) ---
        const isDummy = (g.speaker === "SPEAKER_00");

        // --- 2. HIDE LABEL IF DUMMY ---
        const speakerStyle = isDummy ? 'style="display:none"' : `style="color: ${getSpeakerColor(g.speaker)}"`;
        const speakerText = isDummy ? '' : formatSpeaker(g.speaker);
        const rowClass = isDummy ? 'paragraph-row no-speaker' : 'paragraph-row';
        // -----------------------------------------------------

        const text = g.sentences.map(s => `<span class="clickable-sent" onclick="jumpTo(${s.start})">${s.text} </span>`).join("");

        return `
            <div class="${rowClass}">
                <div class="ts-col">${formatTime(g.start)}</div>
                <div class="text-col">
                    <span class="speaker-label" ${speakerStyle}>${speakerText}</span>
                    <p style="margin:0;">${text}</p>
                </div>
            </div>`;
    }

    // --- 6. EXPORT ACTIONS ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No transcript available to export.");
        const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";
        const showTime = document.getElementById('toggle-time')?.checked;
        const showSpeaker = document.getElementById('toggle-speaker')?.checked;

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

    function createDocxParagraphs(group, showTime, showSpeaker) {
        const { Paragraph, TextRun, AlignmentType } = docx;
        const paragraphs = [];

        // --- FIX DOCX: Don't show SPEAKER_00 in Word Docs ---
        const isDummy = (group.speaker === "SPEAKER_00");
        const effectiveShowSpeaker = showSpeaker && !isDummy;
        // -----------------------------------------------------

        if (effectiveShowSpeaker || showTime) {
            let label = "";
            if (showTime) label += `[${formatTime(group.start)}] `;
            if (effectiveShowSpeaker) label += formatSpeaker(group.speaker);

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

    window.toggleEditMode = () => {
        transcriptWindow.classList.add('is-editing');
        const actions = document.getElementById('edit-actions');
        if (actions) actions.style.display = 'flex';
        transcriptWindow.querySelectorAll('.clickable-sent').forEach(s => s.contentEditable = "true");
    };

    window.saveEdits = () => {
        transcriptWindow.querySelectorAll('.clickable-sent').forEach((span, i) => {
            if (window.currentSegments[i]) window.currentSegments[i].text = span.innerText.trim();
        });
        transcriptWindow.classList.remove('is-editing');
        transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
        const actions = document.getElementById('edit-actions');
        if (actions) actions.style.display = 'none';
    };

    window.copyTranscript = () => {
        const text = window.currentSegments.map(s => s.text).join(" ");
        navigator.clipboard.writeText(text).then(() => alert("Transcript Copied!"));
    };

    window.jumpTo = (time) => {
        if (mainAudio) { mainAudio.currentTime = time; mainAudio.play(); }
    };

    // --- 7. UPLOAD & UI HELPERS ---
    function handleUploadError(msg) {
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
        if (statusTxt) {
        statusTxt.innerText = "Error: " + msg;
        statusTxt.style.color = "#ef4444";
        }
        if (mainBtn) {
        mainBtn.disabled = false;
        mainBtn.innerText = "Upload and Process";
        }
        if (fileInput) fileInput.value = '';
    }

    function resetUI() {
        if (pContainer) pContainer.style.display = 'block';
        if (progressBar) progressBar.style.width = "0%";
        if (statusTxt) {
        statusTxt.style.color = "#666";
        statusTxt.innerText = "Uploading...";
        }
        if (mainBtn) {
        mainBtn.disabled = true;
        mainBtn.innerText = "Processing...";
        }
        // --- FIX: Hide ALL control bars, not just the first one ---
        const allControlBars = document.querySelectorAll('.controls-bar');
        allControlBars.forEach(bar => {
            bar.style.display = 'none';
        });
        if (transcriptWindow) transcriptWindow.innerHTML = `<p style="color:#9ca3af; text-align:center; margin-top:80px;">Preparing file...</p>`;

        // --- NEW: Clear Cached Speaker Data ---
        localStorage.removeItem('speakerMap');
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


// --- 8. MAIN UPLOAD LISTENER (FIXED) ---
    if (fileInput) {
        fileInput.addEventListener('change', async function() {
            const file = this.files[0];
            if (!file) return;

            this.value = '';
            window.originalFileName = file.name;
            resetUI();

            if (audioSource && mainAudio && audioContainer) {
            audioSource.src = URL.createObjectURL(file);
            mainAudio.load();
            audioContainer.style.display = 'block';
            }

            try {
                statusTxt.innerText = "Preparing secure upload...";

                // 1. Get the Signed URL AND the Correct Job ID from Server
                const signRes = await fetch('/api/sign-s3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, filetype: file.type })
                });

                if (!signRes.ok) throw new Error("Sign Failed");

                const signData = await signRes.json();
                const { data } = signData;
                const url = data.signedRequest || signData.url;
                const key = data.s3Key || signData.key;

                // --- FIX IS HERE: Use the Server's ID, not a random one ---
                const jobId = data.jobId;
                // ----------------------------------------------------------

                // Now we can save it and join the room
                localStorage.setItem('activeJobId', jobId);
                if (typeof socket !== 'undefined') socket.emit('join', { room: jobId });

                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                xhr.setRequestHeader('Content-Type', file.type);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        progressBar.style.width = percent + "%";
                        statusTxt.innerText = `Uploading to Storage: ${percent}%`;
                    }
                };

                xhr.onload = async () => {
                    if (xhr.status === 200) {
                        statusTxt.innerText = "Starting AI Processing...";

                        const speakerEl = document.getElementById('speaker-count');
                        const langEl = document.getElementById('audio-lang');

                        await fetch('/api/trigger_processing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                s3Key: key,
                                jobId: jobId,
                                speakerCount: speakerEl ? speakerEl.value : 2,
                                language: langEl ? langEl.value : 'he',
                                task: 'transcribe',

                                // NEW: Send the toggle state (true/false)
                                diarization: document.getElementById('diarization-toggle').checked
                            })
                        });
                        startFakeProgress();
                    } else {
                        handleUploadError("Storage Upload Failed");
                    }
                };
                xhr.onerror = () => handleUploadError("Network Error during Upload");
                  xhr.send(file);
            } catch (err) {
                handleUploadError("Initialization Failed: " + err.message);
            }
        });
    }
});