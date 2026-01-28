document.addEventListener('DOMContentLoaded', () => {
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

    let socket, isEditMode = false;
    window.currentSegments = [];
    window.originalFileName = "transcript";

    // --- HELPERS ---
    const formatTime = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
    const formatSpeaker = (raw) => {
        if (!raw) return "דובר לא ידוע";
        const m = raw.match(/SPEAKER_(\d+)/);
        return m ? `דובר ${parseInt(m[1]) + 1}` : raw;
    };

    // --- DOWNLOAD DROPDOWN ---
    document.getElementById('btn-download').addEventListener('click', (e) => {
        e.stopPropagation();
        downloadMenu.classList.toggle('show');
    });
    document.addEventListener('click', () => downloadMenu.classList.remove('show'));

    // --- EXPORT LOGIC ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return;
        const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";

        if (type === 'docx') {
            const { Document, Packer, Paragraph, TextRun, AlignmentType } = docx;
            let children = [];
            let current = null;

            window.currentSegments.forEach(seg => {
                if (!current || current.speaker !== seg.speaker) {
                    if (current) children.push(createDocxP(current));
                    current = { speaker: seg.speaker, start: seg.start, text: "" };
                }
                current.text += seg.text + " ";
            });
            if (current) children.push(createDocxP(current));

            const doc = new Document({ sections: [{ children }] });
            Packer.toBlob(doc).then(blob => saveAs(blob, `${baseName}.docx`));
        } else {
            // SRT and VTT - No speakers as requested
            let content = type === 'vtt' ? "WEBVTT\n\n" : "";
            window.currentSegments.forEach((seg, i) => {
                const ts = (s) => {
                    let d = new Date(0); d.setMilliseconds(s * 1000);
                    let iso = d.toISOString().substr(11, 12);
                    return type === 'srt' ? iso.replace('.', ',') : iso;
                };
                if (type === 'srt') content += `${i + 1}\n`;
                content += `${ts(seg.start)} --> ${ts(seg.end)}\n${seg.text}\n\n`;
            });
            saveAs(new Blob([content], {type: "text/plain"}), `${baseName}.${type}`);
        }
    };

    function createDocxP(group) {
        const { Paragraph, TextRun, AlignmentType } = docx;
        const runs = [];
        if (document.getElementById('toggle-speaker').checked || document.getElementById('toggle-time').checked) {
            let lbl = "";
            if (document.getElementById('toggle-time').checked) lbl += `[${formatTime(group.start)}] `;
            if (document.getElementById('toggle-speaker').checked) lbl += formatSpeaker(group.speaker);
            runs.push(new TextRun({ text: lbl, bold: true, color: "5d5dff", size: 18 }), new TextRun({ break: 1 }));
        }
        runs.push(new TextRun({ text: group.text, size: 22 }));
        return new Paragraph({ children: runs, alignment: AlignmentType.RIGHT, bidirectional: true, spacing: { after: 300 }});
    }

    // --- EDIT & COPY ---
    window.toggleEditMode = () => {
        isEditMode = true;
        transcriptWindow.classList.add('is-editing');
        document.getElementById('edit-actions').style.display = 'flex';
        transcriptWindow.querySelectorAll('.clickable-sent').forEach(s => s.contentEditable = "true");
    };
    window.saveEdits = () => {
        transcriptWindow.querySelectorAll('.clickable-sent').forEach((span, i) => {
            if (window.currentSegments[i]) window.currentSegments[i].text = span.innerText.trim();
        });
        isEditMode = false;
        transcriptWindow.innerHTML = renderParagraphs(window.currentSegments);
        document.getElementById('edit-actions').style.display = 'none';
    };
    window.copyTranscript = () => {
        const text = window.currentSegments.map(s => s.text).join(" ");
        navigator.clipboard.writeText(text).then(() => alert("Transcript Copied!"));
    };

    // --- UPLOAD PROCESS ---
    fileInput.addEventListener('change', function() {
        const file = this.files[0]; if (!file) return;
        window.originalFileName = file.name;

        // Reset and Load Audio
        audioSource.src = URL.createObjectURL(file);
        mainAudio.load();
        audioContainer.style.display = 'block';
        transcriptWindow.innerHTML = `<p style="color:#9ca3af; text-align:center; margin-top:80px;">Processing file...</p>`;
        pContainer.style.display = 'block';
        progressBar.style.width = "0%";

        const jobId = "job_" + Date.now();
        socket = io({ query: { jobId }, transports: ['websocket'] });
        socket.on('job_status_update', (data) => {
            if (data.status === "completed") {
                window.currentSegments = data.segments;
                transcriptWindow.innerHTML = renderParagraphs(data.segments);
                controlsBar.style.display = 'flex';
                pContainer.style.display = 'none';
                statusTxt.innerText = "Complete!";
            }
        });

        const fd = new FormData();
        fd.append('file', file); fd.append('jobId', jobId);
        fd.append('speakerCount', document.getElementById('speaker-count').value);
        fd.append('language', document.getElementById('audio-lang').value);
        fd.append('task', document.getElementById('task-mode').value);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload_full_file', true);
        xhr.upload.onprogress = (e) => progressBar.style.width = Math.round((e.loaded/e.total)*100) + "%";
        xhr.send(fd);
    });

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

    window.jumpTo = (t) => { if (!isEditMode && mainAudio) { mainAudio.currentTime = t; mainAudio.play(); }};
});