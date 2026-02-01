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

    // --- 1. SOCKET LOGIC ---
    // Socket is initialized in base.html, we just use it here
    if (typeof socket !== 'undefined') {
        socket.on('connect', () => {
            console.log("Connected with ID:", socket.id);
            const savedJobId = localStorage.getItem('activeJobId');
            if (savedJobId) {
                console.log("🔄 Re-joining room:", savedJobId);
                socket.emit('join', { room: savedJobId });
            }
        });

        socket.on('job_status_update', (data) => {
            console.log("📩 Message received:", data);
            handleJobUpdate(data);
        });
    }

    function handleJobUpdate(data) {
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
            if (controlsBar) controlsBar.style.display = 'flex';

            // Parse Data
            let finalSegments = null;
            if (data.result) {
                let resultObj = data.result;
                if (typeof resultObj === "string") {
                    try { resultObj = JSON.parse(resultObj); } catch(e) {}
                }
                if (resultObj.segments) finalSegments = resultObj.segments;
            }
            if (!finalSegments && data.segments) finalSegments = data.segments;

            if (finalSegments && transcriptWindow) {
                window.currentSegments = finalSegments;
                transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
            } else if (data.transcription && transcriptWindow) {
                 transcriptWindow.innerText = data.transcription;
            }
        } else if (currentStatus === "failed" || currentStatus === "error") {
            handleUploadError(data.error || "Unknown error occurred");
            localStorage.removeItem('activeJobId');
        }
    }

    // --- 2. ERROR HANDLING ---
    window.onerror = (msg) => console.error("System Error: " + msg);

    // --- 3. TOOLBAR & DROPDOWN ---
    const btnDownload = document.getElementById('btn-download');
    if (btnDownload) {
        btnDownload.addEventListener('click', (e) => {
            e.stopPropagation();
            if(downloadMenu) downloadMenu.classList.toggle('show');
        });
    }
    document.addEventListener('click', () => {
        if (downloadMenu && downloadMenu.classList.contains('show')) {
             downloadMenu.classList.remove('show');
        }
    });

    // --- 4. HELPERS ---
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
        const text = g.sentences.map(s => `<span class="clickable-sent" onclick="jumpTo(${s.start})">${s.text} </span>`).join("");
        return `
            <div class="paragraph-row">
                <div class="ts-col">${formatTime(g.start)}</div>
                <div class="text-col">
                    <span class="speaker-label" style="color: ${getSpeakerColor(g.speaker)}">${formatSpeaker(g.speaker)}</span>
                    <p style="margin:0;">${text}</p>
                </div>
            </div>`;
    }

    // --- 5. EXPORT & ACTIONS ---
    // Make these global so onclick attributes work if needed
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No transcript available to export.");
        const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";
        const showTime = document.getElementById('toggle-time')?.checked;
        const showSpeaker = document.getElementById('toggle-speaker')?.checked;

        // Ensure libraries are loaded
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

    window.jumpTo = (time) => {
        if (mainAudio) { mainAudio.currentTime = time; mainAudio.play(); }
    };

    // --- 6. UPLOAD & UI HELPERS ---
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
        if (controlsBar) controlsBar.style.display = 'none';
        if (transcriptWindow) transcriptWindow.innerHTML = `<p style="color:#9ca3af; text-align:center; margin-top:80px;">Preparing file...</p>`;
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

    // --- 7. MAIN EVENT LISTENER (The one and only) ---
    if (fileInput) {
        fileInput.addEventListener('change', async function() {
            const file = this.files[0];
            if (!file) return;

            // Reset inputs
            this.value = '';
            window.originalFileName = file.name;
            resetUI();

            // Setup Audio Player (Only if elements exist)
            if (audioSource && mainAudio && audioContainer) {
                audioSource.src = URL.createObjectURL(file);
                mainAudio.load();
                audioContainer.style.display = 'block';
            }

            const jobId = "job_" + Date.now();
            localStorage.setItem('activeJobId', jobId);

            console.log("🚀 Switching to NEW Room:", jobId);
            if (typeof socket !== 'undefined') socket.emit('join', { room: jobId });

            try {
                if (statusTxt) statusTxt.innerText = "Preparing secure upload...";

                // 1. Sign S3
                const signRes = await fetch('/api/sign-s3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, filetype: file.type })
                });

                if (!signRes.ok) throw new Error("Sign Failed");
                const signData = await signRes.json();
                const { data } = signData; // Based on your python structure
                const url = data.signedRequest || signData.url; // Fallback
                const key = data.s3Key || signData.key;

                // 2. Upload to S3
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                xhr.setRequestHeader('Content-Type', file.type);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && progressBar && statusTxt) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        progressBar.style.width = percent + "%";
                        statusTxt.innerText = `Uploading to Storage: ${percent}%`;
                    }
                };

                xhr.onload = async () => {
                    if (xhr.status === 200) {
                        if (statusTxt) statusTxt.innerText = "Starting AI Processing...";

                        // Get inputs safely
                        const speakerEl = document.getElementById('speaker-count');
                        const langEl = document.getElementById('audio-lang');
                        const speakers = speakerEl ? speakerEl.value : 2;
                        const lang = langEl ? langEl.value : 'he';

                        // 3. Trigger GPU
                        await fetch('/api/trigger_processing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                s3Key: key,
                                jobId: jobId,
                                speakerCount: speakers,
                                language: lang,
                                task: 'transcribe'
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
                console.error(err);
                handleUploadError("Initialization Failed: " + err.message);
            }
        });
    }
});