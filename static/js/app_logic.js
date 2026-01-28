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

    let socket;
    window.currentSegments = [];
    window.originalFileName = "transcript";

    // --- HELPERS ---
    const formatTime = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
    const formatSpeaker = (raw) => {
        const m = raw ? raw.match(/SPEAKER_(\d+)/) : null;
        return m ? `דובר ${parseInt(m[1]) + 1}` : "דובר לא ידוע";
    };

    // --- DOCX EXPORT (RTL FIXED) ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No transcript available.");
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
        }
        // ... SRT/VTT logic omitted for brevity ...
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

        return new Paragraph({
            children: runs,
            alignment: AlignmentType.RIGHT, // FORCES RTL ALIGNMENT
            bidirectional: true,
            spacing: { after: 300 }
        });
    }

    // --- UPLOAD ---
    fileInput.addEventListener('change', function() {
        const file = this.files[0]; if (!file) return;
        window.originalFileName = file.name;

        // FIX: Re-load audio properly so player works
        audioSource.src = URL.createObjectURL(file);
        mainAudio.load();
        audioContainer.style.display = 'block';

        const jobId = "job_" + Date.now();
        socket = io({ query: { jobId }, transports: ['websocket'] });
        socket.on('job_status_update', (data) => {
            if (data.status === "completed") {
                window.currentSegments = data.segments;
                transcriptWindow.innerHTML = renderParagraphs(data.segments);
                controlsBar.style.display = 'flex';
            }
        });

        const fd = new FormData();
        fd.append('file', file); fd.append('jobId', jobId);
        // ... append others ...

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload_full_file', true);
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

    window.jumpTo = (t) => { if (mainAudio) { mainAudio.currentTime = t; mainAudio.play(); }};
});