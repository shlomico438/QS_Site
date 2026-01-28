document.addEventListener('DOMContentLoaded', () => {
    const transcriptWindow = document.getElementById('transcript-window');
    const fileInput = document.getElementById('fileInput');
    const statusTxt = document.getElementById('upload-status');
    const progressBar = document.getElementById('progress-bar');
    const pContainer = document.getElementById('p-container');
    const placeholder = document.getElementById('placeholder');
    const mainBtn = document.getElementById('main-btn');
    const audioContainer = document.getElementById('audio-player-container');
    const audioSource = document.getElementById('audio-source');
    const mainAudio = document.getElementById('main-audio');
    const controlsBar = document.querySelector('.controls-bar');

    const btnDownload = document.getElementById('btn-download');
    const downloadMenu = document.getElementById('download-menu');
    const btnEdit = document.getElementById('btn-edit');
    const btnCopy = document.getElementById('btn-copy');
    const editActions = document.getElementById('edit-actions');

    let socket;
    window.fakeProgressInterval = null;
    window.serverTimeout = null;
    window.currentSegments = [];
    let isEditMode = false;

    // --- GLOBAL ERROR CATCHERS ---
    // Catches general JavaScript crashes
    window.onerror = function(message) {
        handleUploadError("System Error: " + message);
        return true;
    };

    // Catches failed async promises
    window.onunhandledrejection = function(event) {
        handleUploadError("Communication Error: " + event.reason);
    };

    // --- TOOLBAR LOGIC ---
    btnDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadMenu.classList.toggle('show');
    });

    document.addEventListener('click', (e) => {
        if (!btnDownload.contains(e.target) && !downloadMenu.contains(e.target)) {
            downloadMenu.classList.remove('show');
        }
    });

    window.toggleEditMode = function() {
        isEditMode = true;
        transcriptWindow.classList.add('is-editing');
        btnEdit.style.display = 'none';
        btnCopy.style.display = 'none';
        btnDownload.style.display = 'none';
        editActions.style.display = 'flex';

        const spans = transcriptWindow.querySelectorAll('.clickable-sent');
        spans.forEach(span => span.contentEditable = "true");
    };

    window.saveEdits = function() {
        const spans = transcriptWindow.querySelectorAll('.clickable-sent');
        spans.forEach((span, index) => {
            if (window.currentSegments[index]) {
                window.currentSegments[index].text = span.innerText.trim();
            }
        });
        exitEditMode();
        transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
    };

    window.cancelEdits = function() {
        exitEditMode();
        transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
    };

    function exitEditMode() {
        isEditMode = false;
        transcriptWindow.classList.remove('is-editing');
        btnEdit.style.display = 'flex';
        btnCopy.style.display = 'flex';
        btnDownload.style.display = 'flex';
        editActions.style.display = 'none';
    }

    window.copyTranscript = function() {
        const text = window.currentSegments.map(s => s.text).join(" ");
        navigator.clipboard.writeText(text).then(() => alert("Transcript copied to clipboard!"));
    };

    // --- TOGGLES ---
    document.getElementById('toggle-time').addEventListener('change', (e) => {
        transcriptWindow.classList.toggle('hide-time', !e.target.checked);
    });
    document.getElementById('toggle-speaker').addEventListener('change', (e) => {
        transcriptWindow.classList.toggle('hide-speaker', !e.target.checked);
    });

    // --- HELPERS ---
    function getSpeakerColor(speakerId) {
        const colors = ['#5d5dff', '#e11d48', '#059669', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#ca8a04'];
        const match = speakerId.match(/\d+/);
        const index = match ? parseInt(match[0]) : 0;
        return colors[index % colors.length];
    }

    function formatSpeaker(rawSpeaker) {
        if (!rawSpeaker) return "דובר לא ידוע";
        const match = rawSpeaker.match(/SPEAKER_(\d+)/);
        return match ? `דובר ${parseInt(match[1]) + 1}` : rawSpeaker;
    }

    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    // --- EXPORT ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No transcript available to export.");
        downloadMenu.classList.remove('show');

        let content = "";
        let filename = "transcript." + type;

        if (type === 'srt' || type === 'vtt') {
            const formatTS = (s) => {
                const d = new Date(0); d.setMilliseconds(s * 1000);
                let ts = d.toISOString().substr(11, 12);
                return type === 'srt' ? ts.replace('.', ',') : ts;
            };
            if (type === 'vtt') content += "WEBVTT\n\n";
            window.currentSegments.forEach((seg, i) => {
                if (type === 'srt') content += `${i + 1}\n`;
                content += `${formatTS(seg.start)} --> ${formatTS(seg.end)}\n`;
                content += type === 'srt' ? `[${formatSpeaker(seg.speaker)}] ${seg.text}\n\n` : `<v ${formatSpeaker(seg.speaker)}>${seg.text}</v>\n\n`;
            });
            saveAs(new Blob([content], {type: "text/plain;charset=utf-8"}), filename);
        } else if (type === 'docx') {
            const { Document, Packer, Paragraph, TextRun } = docx;
            let children = []; let current = null;
            window.currentSegments.forEach(seg => {
                if (!current || current.speaker !== seg.speaker) {
                    if (current) children.push(new Paragraph({ children: [new TextRun({ text: `[${formatTime(current.start)}] ${formatSpeaker(current.speaker)}: `, bold: true, color: "5d5dff" }), new TextRun({ text: current.text, rightToLeft: true })], spacing: { after: 200 }, bidirectional: true }));
                    current = { speaker: seg.speaker, text: "", start: seg.start };
                }
                current.text += seg.text + " ";
            });
            const doc = new Document({ sections: [{ children }] });
            Packer.toBlob(doc).then(blob => saveAs(blob, "transcript.docx"));
        }
    };

    // --- RENDER ---
    function renderParagraphs(segments) {
        let html = ""; let group = null;
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

    function buildGroupHTML(group) {
        const text = group.sentences.map(s => `<span class="clickable-sent" onclick="jumpTo(${s.start})">${s.text} </span>`).join("");
        return `<div class="paragraph-row"><div class="ts-col">${formatTime(group.start)}</div><div class="text-col"><span class="speaker-label" style="color: ${getSpeakerColor(group.speaker)}">${formatSpeaker(group.speaker)}</span><p style="margin:0;">${text}</p></div></div>`;
    }

    window.jumpTo = function(time) { if (!isEditMode && mainAudio) { mainAudio.currentTime = time; mainAudio.play(); } };

    // --- UPLOAD & ERROR HANDLING ---
    function handleUploadError(msg) {
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
        if (window.serverTimeout) clearTimeout(window.serverTimeout);
        statusTxt.innerText = "Error: " + msg;
        statusTxt.style.color = "#ef4444";
        pContainer.classList.add('progress-error');
        progressBar.style.width = "100%";
        mainBtn.disabled = false;
        mainBtn.innerText = "Try Again";
    }

    function resetUI() {
        pContainer.classList.remove('progress-error');
        pContainer.style.display = 'block';
        progressBar.style.width = "0%";
        statusTxt.style.color = "#666";
        mainBtn.disabled = true;
        mainBtn.innerText = "Processing...";
        controlsBar.style.display = 'none';
        transcriptWindow.innerHTML = `<p id="placeholder" style="color:#9ca3af; text-align:center; margin-top:80px;">Upload a file to start</p>`;
        if (isEditMode) cancelEdits();
    }

    fileInput.addEventListener('change', async function() {
        const file = this.files[0]; if (!file) return;
        resetUI();
        const jobId = "job_" + Date.now();
        audioSource.src = URL.createObjectURL(file);
        mainAudio.load();
        audioContainer.style.display = 'block';

        // Initialize Socket
        socket = io({ query: { jobId }, transports: ['websocket'] });

        socket.on('connect_error', () => {
            handleUploadError("Unable to connect to the update server.");
        });

        socket.on('job_status_update', (data) => {
            if (window.serverTimeout) clearTimeout(window.serverTimeout);
            if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

            if (data.status === "error") {
                return handleUploadError(data.message || "GPU processing failed.");
            }

            pContainer.style.display = 'none';
            statusTxt.innerText = "Transcription complete!";
            statusTxt.style.color = "#28a745";
            if (data.segments) {
                window.currentSegments = data.segments;
                transcriptWindow.innerHTML = renderParagraphs(data.segments);
                controlsBar.style.display = 'flex';
            }
            mainBtn.disabled = false;
            mainBtn.innerText = "Select file";
        });

        const fd = new FormData();
        fd.append('file', file);
        fd.append('jobId', jobId);
        fd.append('speakerCount', document.getElementById('speaker-count').value);
        fd.append('language', document.getElementById('audio-lang').value);
        fd.append('task', document.getElementById('task-mode').value);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload_full_file', true);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percent + "%";
                statusTxt.innerText = `Uploading: ${percent}%`;
            }
        };

        xhr.onload = () => {
            try {
                const response = JSON.parse(xhr.responseText);
                if (xhr.status === 200) {
                    statusTxt.innerText = "Processing (AI)...";
                    // Start 5-minute timeout for "Zombie" servers
                    window.serverTimeout = setTimeout(() => {
                        handleUploadError("Server is busy (timeout). Please try again later.");
                    }, 300000);
                } else {
                    // Handles 413 (File Too Large) and general 500 errors from backend
                    handleUploadError(response.message || "Error processing file.");
                }
            } catch (e) {
                handleUploadError("Invalid server response.");
            }
        };

        xhr.onerror = () => {
            handleUploadError("Network Error: Could not upload file. Check your connection.");
        };

        xhr.send(fd);
    });
});