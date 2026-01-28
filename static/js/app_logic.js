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
    const editActions = document.getElementById('edit-actions');

    // --- GLOBAL STATE ---
    let socket;
    let isEditMode = false;
    window.fakeProgressInterval = null;
    window.serverTimeout = null;
    window.currentSegments = [];
    window.originalFileName = "transcript";

    // --- GLOBAL ERROR CATCHERS ---
    window.onerror = (msg) => handleUploadError("System Error: " + msg);
    window.onunhandledrejection = (ev) => handleUploadError("Network Error: " + ev.reason);

    // --- TOOLBAR & DROPDOWN ---
    document.getElementById('btn-download').addEventListener('click', (e) => {
        e.stopPropagation();
        downloadMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        if (downloadMenu.classList.contains('show')) downloadMenu.classList.remove('show');
    });

    // --- HELPERS ---
    const formatTime = (s) => {
        const mins = Math.floor(s / 60);
        const secs = Math.floor(s % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const getSpeakerColor = (speakerId) => {
        const colors = ['#5d5dff', '#e11d48', '#059669', '#d97706', '#7c3aed', '#db2777', '#2563eb', '#ca8a04'];
        const match = speakerId ? speakerId.match(/\d+/) : null;
        const index = match ? parseInt(match[0]) : 0;
        return colors[index % colors.length];
    };

    const formatSpeaker = (raw) => {
        if (!raw) return "דובר לא ידוע";
        const match = raw.match(/SPEAKER_(\d+)/);
        return match ? `דובר ${parseInt(match[1]) + 1}` : raw;
    };

    // --- EXPORT LOGIC (Word RTL & Structure Fix) ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No transcript available to export.");
        const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";
        const showTime = document.getElementById('toggle-time').checked;
        const showSpeaker = document.getElementById('toggle-speaker').checked;

        if (type === 'docx') {
            const { Document, Packer } = docx;
            let children = [];
            let current = null;

            window.currentSegments.forEach(seg => {
                if (!current || current.speaker !== seg.speaker) {
                    if (current) {
                        // Spread the array of paragraphs into children
                        children.push(...createDocxParagraphs(current, showTime, showSpeaker));
                    }
                    current = { speaker: seg.speaker, text: "", start: seg.start };
                }
                current.text += seg.text + " ";
            });
            if (current) {
                children.push(...createDocxParagraphs(current, showTime, showSpeaker));
            }

            const doc = new Document({
                sections: [{ properties: {}, children: children }]
            });

            Packer.toBlob(doc).then(blob => saveAs(blob, `${baseName}.docx`));
        } else {
            // SRT/VTT - No speakers as requested
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

    function forceRTL(paragraph) {
        const p = paragraph._element;
        const pPr = p.getOrAddProperties();
        pPr.addChildElement(
            new docx.oxml.OxmlElement("w:bidi")
        );
        return paragraph;
    }


function createDocxParagraphs(group, showTime, showSpeaker) {
    const { Paragraph, TextRun, AlignmentType } = docx;
    const paragraphs = [];

    // --- LABEL PARAGRAPH ---
    if (showSpeaker || showTime) {
        let label = "";
        if (showTime) label += `[${formatTime(group.start)}] `;
        if (showSpeaker) label += formatSpeaker(group.speaker);

        const labelParagraph = new Paragraph({
            children: [
                new TextRun({
                    text: label,
                    bold: true,
                    color: "5d5dff",
                    size: 20,
                    rightToLeft: true
                })
            ],
            alignment: AlignmentType.RIGHT
        });

        // 🔥 FORCE RTL AT XML LEVEL
        const pPr = labelParagraph._element.getOrAddProperties();
        pPr.push(new docx.XmlComponent("w:bidi"));

        paragraphs.push(labelParagraph);
    }

    // --- TRANSCRIPTION PARAGRAPH ---
    const textParagraph = new Paragraph({
        children: [
            new TextRun({
                text: group.text.trim(),
                size: 24,
                language: { id: "he-IL" },
                rightToLeft: true
            })
        ],
        alignment: AlignmentType.RIGHT
    });

    // 🔥 FORCE RTL AT XML LEVEL
    const pPr2 = textParagraph._element.getOrAddProperties();
    pPr2.push(new docx.XmlComponent("w:bidi"));

    paragraphs.push(textParagraph);

    return paragraphs;
}

    // --- UI ACTIONS ---
    window.toggleEditMode = () => {
        isEditMode = true;
        transcriptWindow.classList.add('is-editing');
        document.getElementById('btn-edit').style.display = 'none';
        editActions.style.display = 'flex';
        transcriptWindow.querySelectorAll('.clickable-sent').forEach(s => s.contentEditable = "true");
    };

    window.saveEdits = () => {
        transcriptWindow.querySelectorAll('.clickable-sent').forEach((span, i) => {
            if (window.currentSegments[i]) window.currentSegments[i].text = span.innerText.trim();
        });
        isEditMode = false;
        transcriptWindow.classList.remove('is-editing');
        transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
        document.getElementById('btn-edit').style.display = 'flex';
        editActions.style.display = 'none';
    };

    window.copyTranscript = () => {
        const text = window.currentSegments.map(s => s.text).join(" ");
        navigator.clipboard.writeText(text).then(() => alert("Transcript copied to clipboard!"));
    };

    window.jumpTo = (time) => {
        if (!isEditMode && mainAudio) {
            mainAudio.currentTime = time;
            mainAudio.play();
        }
    };

    // --- UPLOAD & PROCESSING ---
    function handleUploadError(msg) {
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
        if (window.serverTimeout) clearTimeout(window.serverTimeout);
        statusTxt.innerText = "Error: " + msg;
        statusTxt.style.color = "#ef4444";
        mainBtn.disabled = false;
        mainBtn.innerText = "Upload and Process";
    }

    function resetUI() {
        pContainer.style.display = 'block';
        progressBar.style.width = "0%";
        statusTxt.style.color = "#666";
        statusTxt.innerText = "Uploading...";
        mainBtn.disabled = true;
        mainBtn.innerText = "Processing...";
        controlsBar.style.display = 'none';
        transcriptWindow.innerHTML = `<p style="color:#9ca3af; text-align:center; margin-top:80px;">Preparing file...</p>`;
    }

    fileInput.addEventListener('change', function() {
        const file = this.files[0];
        if (!file) return;

        window.originalFileName = file.name;
        resetUI();

        audioSource.src = URL.createObjectURL(file);
        mainAudio.load();
        audioContainer.style.display = 'block';

        const jobId = "job_" + Date.now();
        socket = io({ query: { jobId }, transports: ['websocket'] });

        socket.on('job_status_update', (data) => {
            if (window.serverTimeout) clearTimeout(window.serverTimeout);
            if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

            if (data.status === "completed") {
                pContainer.style.display = 'none';
                statusTxt.innerText = "Transcription complete!";
                statusTxt.style.color = "#28a745";
                window.currentSegments = data.segments;
                transcriptWindow.innerHTML = renderParagraphs(data.segments);
                controlsBar.style.display = 'flex';
                mainBtn.disabled = false;
                mainBtn.innerText = "Upload and Process";
            } else if (data.status === "error") {
                handleUploadError(data.message);
            }
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
            if (e.lengthComputable) progressBar.style.width = Math.round((e.loaded / e.total) * 100) + "%";
        };
        xhr.onload = () => {
            statusTxt.innerText = "AI Processing...";
            startFakeProgress();
            window.serverTimeout = setTimeout(() => {
                handleUploadError("Server timeout.");
            }, 300000);
        };
        xhr.send(fd);
    });

    function startFakeProgress() {
        let current = 0;
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);
        window.fakeProgressInterval = setInterval(() => {
            if (current < 95) {
                current += 0.5;
                progressBar.style.width = current + "%";
                statusTxt.innerText = `Analyzing content... ${Math.floor(current)}%`;
            }
        }, 1000);
    }

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
});