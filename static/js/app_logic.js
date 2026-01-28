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

    // --- EXPORT LOGIC (Word RTL & Spell-check Fix) ---
    window.downloadFile = function(type) {
        if (!window.currentSegments.length) return alert("No transcript available to export.");
        const baseName = window.originalFileName.split('.').slice(0, -1).join('.') || "transcript";
        const showTime = document.getElementById('toggle-time').checked;
        const showSpeaker = document.getElementById('toggle-speaker').checked;

        if (type === 'docx') {
            const { Document, Packer, Paragraph, TextRun, AlignmentType } = docx;
            let children = [];
            let current = null;

            window.currentSegments.forEach(seg => {
                if (!current || current.speaker !== seg.speaker) {
                    if (current) children.push(createDocxParagraph(current, showTime, showSpeaker));
                    current = { speaker: seg.speaker, text: "", start: seg.start };
                }
                current.text += seg.text + " ";
            });
            if (current) children.push(createDocxParagraph(current, showTime, showSpeaker));

            const doc = new Document({
                sections: [{ properties: {}, children: children }]
            });

            Packer.toBlob(doc).then(blob => saveAs(blob, `${baseName}.docx`));
        } else {
            // SRT/VTT - Speakers removed as requested
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
            saveAs(new Blob([content], {type: "text/plain;charset=utf-8"}), `${baseName}.${type}`);
        }
    };

    function createDocxParagraph(group, showTime, showSpeaker) {
        const { Paragraph, TextRun, AlignmentType } = docx;
        const runs = [];

        // Speaker/Time Labels - Colored and on line above text
        if (showSpeaker || showTime) {
            let label =