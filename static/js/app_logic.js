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

            const statusTxt = document.getElementById('upload-status');
            if (statusTxt) statusTxt.innerText = "♻️ Connection Restored. Checking status...";
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn("⚠️ Socket Lost Connection:", reason);
        if (reason === "io server disconnect") {
            socket.connect();
        }
    });

    socket.on('job_status_update', (data) => {
        console.log("📩 AI Results Received:", data);
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
    window.hasMultipleSpeakers = false; // NEW FLAG

    // --- 2. THE HANDLER ---
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
                // RENDER
                transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
            } else if (data.transcription && transcriptWindow) {
                 transcriptWindow.innerText = data.transcription;
            }

            // === DISABLE SWITCHES IF FAST MODE (Only 1 speaker found) ===
            // We use the flag calculated during renderParagraphs
            speakerSwitches.forEach(sw => {
                if (!window.hasMultipleSpeakers) {
                    // CASE 1: Single Speaker (Fast Mode) -> Force OFF and Disabled
                    sw.checked = false;
                    sw.disabled = true;
                    sw.parentElement.title = "Speaker detection was disabled (or only 1 speaker found).";
                    sw.parentElement.style.opacity = "0.5";
                } else {
                    // CASE 2: Multiple Speakers -> Force ON and Enabled
                    sw.checked = true;  // <--- THIS WAS MISSING
                    sw.disabled = false;
                    sw.parentElement.title = "Toggle speaker labels";
                    sw.parentElement.style.opacity = "1";
                }
            });

        } else if (currentStatus === "failed" || currentStatus === "error") {
            handleUploadError(data.error || "Unknown error occurred");
            localStorage.removeItem('activeJobId');
        }
    };

    // --- 3. ERROR HANDLING ---
    window.onerror = (msg) => console.error("System Error: " + msg);

    // --- 4. TOOLBAR & DROPDOWN ---
    const downloadBtns = document.querySelectorAll('#btn-download');
    const allDownloadMenus = document.querySelectorAll('#download-menu');

    if (downloadBtns.length > 0) {
        downloadBtns.forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);

            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                allDownloadMenus.forEach(menu => {
                    menu.classList.toggle('show');
                });
            });
        });
    }

    document.addEventListener('click', (e) => {
        allDownloadMenus.forEach(menu => {
            if (!menu.contains(e.target) && menu.classList.contains('show')) {
                menu.classList.remove('show');
            }
        });
    });

    document.addEventListener('click', () => {
        if (downloadMenu && downloadMenu.classList.contains('show')) {
             downloadMenu.classList.remove('show');
        }
    });

    // --- 5. HELPERS ---
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
        // REMOVED the line that forced SPEAKER_00 to be empty
        const match = raw.match(/SPEAKER_(\d+)/);
        return match ? `דובר ${parseInt(match[1]) + 1}` : raw;
    };

// --- HTTP FALLBACK POLLING ---
setInterval(() => {
    const activeJobId = localStorage.getItem('activeJobId');
    if (activeJobId) {
        fetch(`/api/check_status/${activeJobId}`)
            .then(response => response.json())
            .then(data => {
                if (data.status === 'completed' || data.status === 'success') {
                    if (window.handleJobUpdate) {
                        window.handleJobUpdate(data);
                    }
                }
            })
                .catch(err => console.warn("Poll failed:", err));
    }
    }, 5000);

    // --- RENDER LOGIC (FIXED) ---
    function renderParagraphs(segments) {
        // 1. Detect if we have multiple speakers
        const uniqueSpeakers = new Set(segments.map(s => s.speaker));
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
        // SPEAKER_00 is only "Dummy" if it is the ONLY speaker in the whole file
        const isDummy = (g.speaker === "SPEAKER_00" && !window.hasMultipleSpeakers);

        const speakerStyle = isDummy ? 'style="display:none"' : `style="color: ${getSpeakerColor(g.speaker)}"`;
        const speakerText = isDummy ? '' : formatSpeaker(g.speaker);
        const rowClass = isDummy ? 'paragraph-row no-speaker' : 'paragraph-row';

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

        // Fix: Use the same logic as the HTML render
        const isDummy = (group.speaker === "SPEAKER_00" && !window.hasMultipleSpeakers);
        const effectiveShowSpeaker = showSpeaker && !isDummy;

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
        const allControlBars = document.querySelectorAll('.controls-bar');
        allControlBars.forEach(bar => {
            bar.style.display = 'none';
        });
        if (transcriptWindow) transcriptWindow.innerHTML = `<p style="color:#9ca3af; text-align:center; margin-top:80px;">Preparing file...</p>`;

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

    // --- 8. MAIN UPLOAD LISTENER ---
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
                const jobId = data.jobId;

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
                        const diarizationToggle = document.getElementById('diarization-toggle');

                        await fetch('/api/trigger_processing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                s3Key: key,
                                jobId: jobId,
                                speakerCount: speakerEl ? speakerEl.value : 2,
                                language: langEl ? langEl.value : 'he',
                                task: 'transcribe',
                                diarization: diarizationToggle ? diarizationToggle.checked : false
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