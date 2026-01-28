document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const elements = {
        transcriptWindow: document.getElementById('transcript-window'),
        fileInput: document.getElementById('fileInput'),
        statusTxt: document.getElementById('upload-status'),
        progressBar: document.getElementById('progress-bar'),
        pContainer: document.getElementById('p-container'),
        mainBtn: document.getElementById('main-btn'),
        audioSource: document.getElementById('audio-source'),
        mainAudio: document.getElementById('main-audio'),
        controlsBar: document.querySelector('.controls-bar'),
        btnDownload: document.getElementById('btn-download'),
        downloadMenu: document.getElementById('download-menu'),
        btnEdit: document.getElementById('btn-edit'),
        btnCopy: document.getElementById('btn-copy'),
        editActions: document.getElementById('edit-actions'),
        toggleTime: document.getElementById('toggle-time'),
        toggleSpeaker: document.getElementById('toggle-speaker')
    };

    let socket, isEditMode = false;
    window.currentSegments = [];
    window.originalFileName = "transcript";

    // --- TOOLBAR & DROPDOWN ---
    elements.btnDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.downloadMenu.classList.toggle('show');
    });

    document.addEventListener('click', (e) => {
        if (!elements.btnDownload.contains(e.target)) elements.downloadMenu.classList.remove('show');
    });

    // --- EDIT MODE ---
    window.toggleEditMode = () => {
        isEditMode = true;
        elements.transcriptWindow.classList.add('is-editing');
        elements.btnEdit.style.display = elements.btnCopy.style.display = elements.btnDownload.style.display = 'none';
        elements.editActions.style.display = 'flex';
        elements.transcriptWindow.querySelectorAll('.clickable-sent').forEach(s => s.contentEditable = "true");
    };

    window.saveEdits = () => {
        elements.transcriptWindow.querySelectorAll('.clickable-sent').forEach((span, i) => {
            if (window.currentSegments[i]) window.currentSegments[i].text = span.innerText.trim();
        });
        exitEditMode();
    };

    window.cancelEdits = exitEditMode;

    function exitEditMode() {
        isEditMode = false;
        elements.transcriptWindow.classList.remove('is-editing');
        elements.btnEdit.style.display = elements.btnCopy.style.display = elements.btnDownload.style.display = 'flex';
        elements.editActions.style.display = 'none';
        elements.transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
    }

    // --- HELPERS & FORMATTING ---
    const formatTime = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
    const formatSpeaker = (raw) => {
        if (!raw) return "דובר לא ידוע";
        const m = raw.match(/SPEAKER_(\d+)/);
        return m ? `דובר ${parseInt(m[1]) + 1}` : raw;
    };

    // --- EXPORT LOGIC ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No data to export.");
        elements.downloadMenu.classList.remove('show');

        const showTime = elements.toggleTime.checked;
        const showSpeaker = elements.toggleSpeaker.checked;
        const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";

        if (type === 'srt' || type === 'vtt') {
            let content = type === 'vtt' ? "WEBVTT\n\n" : "";
            window.currentSegments.forEach((seg, i) => {
                const ts = (s) => {
                    let t = new Date(0); t.setMilliseconds(s * 1000);
                    let iso = t.toISOString().substr(11, 12);
                    return type === 'srt' ? iso.replace('.', ',') : iso;
                };
                if (type === 'srt') content += `${i + 1}\n`;
                content += `${ts(seg.start)} --> ${ts(seg.end)}\n${seg.text}\n\n`;
            });
            saveAs(new Blob([content], {type: "text/plain;charset=utf-8"}), `${baseName}.${type}`);

        } else if (type === 'docx') {
            const { Document, Packer, Paragraph, TextRun, AlignmentType } = docx;
            let children = [];
            let currentGroup = null;

            window.currentSegments.forEach(seg => {
                if (!currentGroup || currentGroup.speaker !== seg.speaker) {
                    if (currentGroup) children.push(createDocxParagraph(currentGroup, showTime, showSpeaker));
                    currentGroup = { speaker: seg.speaker, start: seg.start, text: "" };
                }
                currentGroup.text += seg.text + " ";
            });
            if (currentGroup) children.push(createDocxParagraph(currentGroup, showTime, showSpeaker));

            const doc = new Document({ sections: [{ children }] });
            Packer.toBlob(doc).then(blob => saveAs(blob, `${baseName}.docx`));
        }
    };

    function createDocxParagraph(group, showTime, showSpeaker) {
        const { Paragraph, TextRun, AlignmentType } = docx;
        const pChildren = [];

        // Label line (Speaker + Time) - Line above text
        if (showSpeaker || showTime) {
            let label = "";
            if (showTime) label += `[${formatTime(group.start)}] `;
            if (showSpeaker) label += formatSpeaker(group.speaker);

            pChildren.push(new TextRun({ text: label, bold: true, color: "5d5dff", size: 18 }));
            pChildren.push(new TextRun({ break: 1 })); // Hard line break
        }

        pChildren.push(new TextRun({ text: group.text, rightToLeft: true, size: 22 }));

        return new Paragraph({
            children: pChildren,
            spacing: { after: 300 },
            bidirectional: true,
            alignment: AlignmentType.RIGHT
        });
    }

    // --- CORE RENDERING ---
    function renderParagraphs(segments) {
        let html = "", group = null;
        segments.forEach(seg => {
            if (!group || group.speaker !== seg.speaker) {
                if (group) html += buildHTML(group);
                group = { speaker: seg.speaker, start: seg.start, sentences: [] };
            }
            group.sentences.push(seg);
        });
        if (group) html += buildHTML(group);
        return html;
    }

    function buildHTML(g) {
        const text = g.sentences.map(s => `<span class="clickable-sent" onclick="jumpTo(${s.start})">${s.text} </span>`).join("");
        return `<div class="paragraph-row"><div class="ts-col">${formatTime(g.start)}</div><div class="text-col"><span class="speaker-label">${formatSpeaker(g.speaker)}</span><p style="margin:0;">${text}</p></div></div>`;
    }

    window.jumpTo = (t) => { if (!isEditMode && elements.mainAudio) { elements.mainAudio.currentTime = t; elements.mainAudio.play(); }};

    // --- UPLOAD LOGIC ---
    elements.fileInput.addEventListener('change', function() {
        const file = this.files[0]; if (!file) return;
        window.originalFileName = file.name;

        // Reset UI
        elements.pContainer.style.display = 'block';
        elements.progressBar.style.width = "0%";
        elements.statusTxt.innerText = "Uploading...";
        elements.controlsBar.style.display = 'none';
        elements.transcriptWindow.innerHTML = `<p style="color:#9ca3af; text-align:center; margin-top:80px;">Processing...</p>`;

        const jobId = "job_" + Date.now();
        socket = io({ query: { jobId }, transports: ['websocket'] });
        socket.on('job_status_update', (data) => {
            if (data.status === "completed") {
                window.currentSegments = data.segments;
                elements.transcriptWindow.innerHTML = renderParagraphs(data.segments);
                elements.controlsBar.style.display = 'flex';
                elements.statusTxt.innerText = "Complete!";
                elements.pContainer.style.display = 'none';
            }
        });

        const fd = new FormData();
        fd.append('file', file); fd.append('jobId', jobId);
        fd.append('speakerCount', document.getElementById('speaker-count').value);
        fd.append('language', document.getElementById('audio-lang').value);
        fd.append('task', document.getElementById('task-mode').value);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload_full_file', true);
        xhr.upload.onprogress = (e) => { elements.progressBar.style.width = Math.round((e.loaded/e.total)*100) + "%"; };
        xhr.onload = () => { elements.statusTxt.innerText = "Processing AI..."; };
        xhr.send(fd);
    });
});