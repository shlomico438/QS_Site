// --- 1. GLOBAL SOCKET INITIALIZATION ---
if (typeof socket !== 'undefined') {
    socket.on('connect', () => {
        const savedJobId = localStorage.getItem('activeJobId');
        if (savedJobId) {
            console.log("🔄 Re-joining room:", savedJobId);
            socket.emit('join', { room: savedJobId });
            fetch(`/api/check_status/${savedJobId}`)
                .then(res => res.json())
                .then(data => {
                     if (data.status === 'completed' || data.status === 'success') {
                         window.handleJobUpdate(data);
                     }
                }).catch(() => {});
        }
    });

    socket.on('job_finished', (data) => {
        console.log("📩 SOCKET MESSAGE: Job Finished received", data);
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
    // --- UI ELEMENTS ---
    const transcriptWindow = document.getElementById('transcript-window');
    const fileInput = document.getElementById('fileInput');
    const statusTxt = document.getElementById('upload-status');
    const progressBar = document.getElementById('progress-bar');
    const mainBtn = document.getElementById('main-btn');
    const audioContainer = document.getElementById('audio-player-container');
    const audioSource = document.getElementById('audio-source');
    const mainAudio = document.getElementById('main-audio');

    // --- 2. THE HANDLER ---
    window.handleJobUpdate = function(rawResult) {
        console.log("🚀 handleJobUpdate STARTED");
        try {
            if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

            const preparingScreen = document.getElementById('preparing-screen');
            if (preparingScreen) preparingScreen.style.display = 'none';
            else transcriptWindow.innerHTML = '';

            const controlBars = document.querySelectorAll('.controls-bar');
            controlBars.forEach(bar => bar.style.display = 'flex');

            if (mainBtn) {
                mainBtn.disabled = false;
                mainBtn.innerText = "Upload and Process";
            }
            if (progressBar) progressBar.style.width = "100%";
            if (statusTxt) statusTxt.innerText = "✅ Done";

            let segments = null;
            if (rawResult.result && rawResult.result.segments) {
                segments = rawResult.result.segments;
            } else if (rawResult.output && rawResult.output.segments) {
                segments = rawResult.output.segments;
            } else if (rawResult.segments) {
                segments = rawResult.segments;
            }

            if (!segments || !Array.isArray(segments)) {
                console.error("❌ DATA ERROR: No segments found", rawResult);
                return;
            }

            window.currentSegments = segments;
            const hasSpeakerData = segments.some(s => s.speaker);
            updateSpeakerToggleUI(hasSpeakerData);

            if (transcriptWindow && typeof renderParagraphs === 'function') {
                transcriptWindow.innerHTML = renderParagraphs(segments);
            }
            console.log("✅ handleJobUpdate FINISHED");

        } catch (error) {
            console.error("⚠️ CRASH in handleJobUpdate:", error);
        }
    };

    // --- 3. TOOLBAR & HELPERS ---
    const downloadBtns = document.querySelectorAll('#btn-download');
    const allDownloadMenus = document.querySelectorAll('#download-menu');

    if (downloadBtns.length > 0) {
        downloadBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                allDownloadMenus.forEach(menu => menu.classList.toggle('show'));
            });
        });
    }

    document.addEventListener('click', (e) => {
        allDownloadMenus.forEach(menu => {
            if (!menu.contains(e.target)) menu.classList.remove('show');
        });
    });

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
        const match = raw.match(/SPEAKER_(\d+)/);
        return match ? `דובר ${parseInt(match[1]) + 1}` : raw;
    };

    function updateSpeakerToggleUI(hasSpeakerData) {
        const diarizationToggle = document.getElementById('diarization-toggle');
        const speakerSwitch = document.getElementById('toggle-speaker');
        const switches = [diarizationToggle, speakerSwitch];
        switches.forEach(sw => {
            if (!sw) return;
            sw.disabled = false;
            sw.parentElement.style.opacity = "1";
            sw.parentElement.style.pointerEvents = "auto";
            if (hasSpeakerData) sw.checked = true;
        });
    }

    // --- 4. RENDER LOGIC ---
    function renderParagraphs(segments) {
        const uniqueSpeakers = new Set(segments.map(s => s.speaker).filter(Boolean));
        window.hasMultipleSpeakers = uniqueSpeakers.size > 1;
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
        const isDummy = (g.speaker === "SPEAKER_00" && !window.hasMultipleSpeakers);
        const speakerStyle = isDummy ? 'style="display:none"' : `style="color: ${getSpeakerColor(g.speaker)}"`;
        const speakerText = isDummy ? '' : formatSpeaker(g.speaker);
        const rowClass = isDummy ? 'paragraph-row no-speaker' : 'paragraph-row';
        const text = g.sentences.map(s => `<span class="clickable-sent" onclick="jumpTo(${s.start})">${s.text} </span>`).join("");
        return `<div class="${rowClass}">
                <div class="ts-col">${formatTime(g.start)}</div>
                <div class="text-col">
                    <span class="speaker-label" ${speakerStyle}>${speakerText}</span>
                    <p style="margin:0;">${text}</p>
                </div>
            </div>`;
    }

    // --- 5. EXPORT ACTIONS ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No transcript available.");
        const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";
        const showTime = document.getElementById('toggle-time')?.checked;
        const showSpeaker = document.getElementById('toggle-speaker')?.checked;
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
                    return d.toISOString().substr(11, 12).replace('.', ',');
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
        const isDummy = (group.speaker === "SPEAKER_00" && !window.hasMultipleSpeakers);
        const effectiveShowSpeaker = showSpeaker && !isDummy;
        if (effectiveShowSpeaker || showTime) {
            let label = "";
            if (showTime) label += `[${formatTime(group.start)}] `;
            if (effectiveShowSpeaker) label += formatSpeaker(group.speaker);
            paragraphs.push(new Paragraph({
                children: [new TextRun({ text: label, bold: true, color: getSpeakerColor(group.speaker).replace('#', ''), size: 20, rightToLeft: true })],
                alignment: AlignmentType.RIGHT, bidirectional: true
            }));
        }
        paragraphs.push(new Paragraph({
            children: [new TextRun({ text: group.text.trim(), size: 24, rightToLeft: true })],
            alignment: AlignmentType.RIGHT, bidirectional: true, spacing: { after: 300 }
        }));
        return paragraphs;
    }

    window.jumpTo = (time) => { if (mainAudio) { mainAudio.currentTime = time; mainAudio.play(); } };

    // --- 6. UPLOAD SECTION (FIXED 403 ERROR) ---
    function resetUI() {
        if (progressBar) progressBar.style.width = "0%";
        if (statusTxt) statusTxt.innerText = "Uploading...";
        if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = "Processing..."; }
        if (transcriptWindow) transcriptWindow.innerHTML = `<p id="preparing-screen" style="color:#9ca3af; text-align:center; margin-top:80px;">Preparing file...</p>`;
        const controlBars = document.querySelectorAll('.controls-bar');
        controlBars.forEach(bar => bar.style.display = 'none');
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

    if (fileInput) {
        fileInput.addEventListener('change', async function() {
            const file = this.files[0];
            if (!file) return;
            window.originalFileName = file.name;
            resetUI();

            if (audioSource && mainAudio && audioContainer) {
                audioSource.src = URL.createObjectURL(file);
                mainAudio.load();
                audioContainer.style.display = 'block';
            }

            try {
                // THE FIX: Exact signature matching
                const signRes = await fetch('/api/sign-s3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, filetype: file.type })
                });

                const signData = await signRes.json();
                // Destructure for both naming conventions
                const { url, key, jobId } = signData.data || signData;

                localStorage.setItem('activeJobId', jobId);
                if (typeof socket !== 'undefined') socket.emit('join', { room: jobId });

                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                // MUST match the filetype sent to sign-s3 exactly
                xhr.setRequestHeader('Content-Type', file.type);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        if (progressBar) progressBar.style.width = percent + "%";
                        if (statusTxt) statusTxt.innerText = `Uploading: ${percent}%`;
                    }
                };

                xhr.onload = async () => {
                    if (xhr.status === 200) {
                        statusTxt.innerText = "Starting AI Engine...";
                        await fetch('/api/trigger_processing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                s3Key: key, jobId: jobId,
                                diarization: document.getElementById('diarization-toggle')?.checked || false
                            })
                        });
                        startFakeProgress();
                    } else {
                        console.error("Upload failed with status:", xhr.status);
                        statusTxt.innerText = "❌ Upload Failed (403)";
                    }
                };
                xhr.send(file);
            } catch (err) { console.error("Initialization Error:", err); }
        });
    }
});