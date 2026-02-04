// Add this to your GLOBAL STATE section
window.isTriggering = false;
window.aiDiarizationRan = false;

// --- 1. GLOBAL SOCKET INITIALIZATION ---
if (typeof socket !== 'undefined') {
    socket.on('connect', () => {
        const savedJobId = localStorage.getItem('activeJobId');
        if (savedJobId) {
            console.log("🔄 Re-joining room:", savedJobId);
            socket.emit('join', { room: savedJobId });
        }
    });

    // CHANGE: Listen for 'job_status_update' instead of 'job_finished'
    socket.on('job_status_update', (data) => {
        console.log("📩 AI Results Received via Socket:", data);
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
    const transcriptWindow = document.getElementById('transcript-window');
    const fileInput = document.getElementById('fileInput');
    const statusTxt = document.getElementById('upload-status');
    const progressBar = document.getElementById('progress-bar');
    const mainBtn = document.getElementById('main-btn');
    const diarizationToggle = document.getElementById('diarization-toggle');
    const speakerToggle = document.getElementById('toggle-speaker');
    const mainAudio = document.getElementById('main-audio');

    if (mainAudio) {
        mainAudio.addEventListener('timeupdate', () => {
            const currentTime = mainAudio.currentTime;

            // Find the segment that matches the current time
            let activeSegment = null;
            window.currentSegments.forEach(seg => {
                if (currentTime >= seg.start) {
                    activeSegment = seg;
                }
            });

            if (activeSegment) {
                // Remove highlight from everyone
                document.querySelectorAll('.paragraph-row').forEach(row => {
                    row.style.backgroundColor = "transparent";
                    row.style.borderLeft = "none";
                });

                // Add highlight to the active one
                const activeRow = document.getElementById(`seg-${Math.floor(activeSegment.start)}`);
                if (activeRow) {
                    activeRow.style.backgroundColor = "#f0f7ff"; // Light blue highlight
                    activeRow.style.borderLeft = "4px solid #1e3a8a"; // Navy accent

                    // Optional: Auto-scroll the transcript to keep up with the audio
                    // activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        });
    }
    // If the user flips the "Show" switch, we just re-render
    if (speakerToggle) {
        speakerToggle.addEventListener('change', () => {
            if (window.currentSegments.length > 0) {
                document.getElementById('transcript-window').innerHTML = renderParagraphs(window.currentSegments);
            }
        });
    }

    // If the user flips "Detect", we just update the visual state (Snapshot rule)
    if (diarizationToggle) {
        diarizationToggle.addEventListener('change', syncSpeakerControls);
    }
    // Set initial state
    syncSpeakerControls();
    // --- 2. THE HANDLER (Hides overlay and turns switch Blue) ---
    window.handleJobUpdate = function(rawResult) {
        // 1. CLEAR OVERLAYS & STOP PROGRESS
        window.isTriggering = false;
        if (window.fakeProgressInterval) clearInterval(window.fakeProgressInterval);

        const statusTxt = document.getElementById('upload-status');
        if (statusTxt) {
            statusTxt.innerText = "Transcription Complete"; // Or set to "" to hide it
            // Optional: Hide the container after 3 seconds
            setTimeout(() => {
                const preparingScreen = document.getElementById('preparing-screen');
                if (preparingScreen) preparingScreen.style.display = 'none';
            }, 3000);
        }
        const preparingScreen = document.getElementById('preparing-screen');
        if (preparingScreen) preparingScreen.style.display = 'none';

        // 1. UNHIDE THE PLAYER
        const playerContainer = document.getElementById('audio-player-container');
        if (playerContainer) playerContainer.style.display = 'block';

        // 2. LOAD THE AUDIO
        // Retrieve the local URL we stored during the 'change' event
        const audioSource = document.getElementById('audio-source');
        const mainAudio = document.getElementById('main-audio');
        const savedUrl = localStorage.getItem('currentAudioUrl');

        if (audioSource && mainAudio && savedUrl) {
            audioSource.src = savedUrl;
            mainAudio.load(); // Force the player to recognize the new file
        }

        // 2. UNHIDE CORE COMPONENTS
        document.querySelectorAll('.controls-bar').forEach(bar => bar.style.display = 'flex');
        const audioPlayer = document.getElementById('audio-player-container');
        if (audioPlayer) audioPlayer.style.display = 'block';

        const mainBtn = document.getElementById('main-btn');
        if (mainBtn) {
            mainBtn.disabled = false;
            mainBtn.innerText = "Upload and Process";
        }

        // 3. PROCESS DATA
        const output = rawResult.result || rawResult.output || rawResult;
        const segments = output.segments || [];
        window.currentSegments = segments;

        // We create a Set of all speaker IDs found in the segments
        const uniqueSpeakers = new Set(
            segments
                .map(s => s.speaker)
                .filter(s => s !== undefined && s.speaker !== null)
        );

        // Only enable if there are 2 or more DIFFERENT speakers
        window.aiDiarizationRan = uniqueSpeakers.size > 1;
        // AUTO-ACTIVATE: If AI ran, we turn the 'Show Speakers' switch ON
        const speakerToggle = document.getElementById('toggle-speaker');
        if (window.aiDiarizationRan && speakerToggle) {
            speakerToggle.checked = true;
        }

        // Update toggles and render
        syncSpeakerControls();

        const transcriptWindow = document.getElementById('transcript-window');
        if (transcriptWindow) {
            transcriptWindow.innerHTML = renderParagraphs(segments);
        }
    };
    function groupSegmentsBySpeaker(segments) {
        if (!segments.length) return [];

        const groups = [];
        let currentGroup = {
            speaker: segments[0].speaker,
            start: segments[0].start,
            text: segments[0].text
        };

        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i];
            // If the speaker is the same, just add the text to the current group
            if (seg.speaker === currentGroup.speaker) {
                currentGroup.text += " " + seg.text;
            } else {
                // Speaker changed: save the old group and start a new one
                groups.push(currentGroup);
                currentGroup = {
                    speaker: seg.speaker,
                    start: seg.start,
                    text: seg.text
                };
            }
    }
    groups.push(currentGroup);
    return groups;
    }
    /**
     * Synchronizes the relationship between the 'Detect Speakers' AI toggle
     * and the 'Show Speakers' UI toggle.
     */
    function syncSpeakerControls() {
        const speakerToggle = document.getElementById('toggle-speaker');
        if (!speakerToggle) return;

        // RULE: Only enable the 'Show' switch if AI actually ran for this specific job
        if (window.aiDiarizationRan) {
            speakerToggle.disabled = false;
            speakerToggle.parentElement.style.opacity = "1";
            // We don't force it to 'checked' here so the user can still hide them if they want
        } else {
            speakerToggle.disabled = true;
            speakerToggle.checked = false; // Force OFF if no data exists
            speakerToggle.parentElement.style.opacity = "0.5";
        }

        // Hard-coded render: buildGroupHTML will check the 'checked' state of speakerToggle
        function render() {
            const transcriptWindow = document.getElementById('transcript-window');
            if (!transcriptWindow || !window.currentSegments) return;

            // 1. Group the segments first
            const groupedData = groupSegmentsBySpeaker(window.currentSegments);

            // 2. Map through the groups instead of raw segments
            const html = groupedData.map(g => {
                const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
                const showLabel = isSpeakerVisible && window.aiDiarizationRan;

                return `
                <div class="paragraph-row" style="margin-bottom: 20px;">
                    <div style="font-size: 0.85em; color: #888; margin-bottom: 4px;">
                        ${formatTime(g.start)}
                        <span style="display: ${showLabel ? 'inline' : 'none'}; font-weight: bold; margin-right: 10px; color: ${getSpeakerColor(g.speaker)}">
                            | ${g.speaker.replace('SPEAKER_', 'דובר ')}
                        </span>
                    </div>
                    <p style="margin: 0; cursor: pointer;" onclick="window.jumpTo(${g.start})">${g.text}</p>
                </div>`;
            }).join('');

            transcriptWindow.innerHTML = html;
        }
    }
    // --- 3. UI HELPERS ---
    function updateSpeakerToggleUI(hasSpeakerData) {
        const diarizationToggle = document.getElementById('diarization-toggle');
        const speakerToggle = document.getElementById('toggle-speaker');

        if (!diarizationToggle || !speakerToggle) return;

        // We only turn the 'Show' switch Blue  if the AI was active
        // AND it actually found speaker data.
        if (diarizationToggle.checked && hasSpeakerData) {
            speakerToggle.disabled = false;
            speakerToggle.checked = true; // This makes it Blue
            speakerToggle.parentElement.style.opacity = "1";
        } else {
            speakerToggle.disabled = true;
            speakerToggle.checked = false; // Stay Grey
            speakerToggle.parentElement.style.opacity = "0.5";
        }
    }
    const formatTime = (s) => {
        const d = new Date(0); d.setSeconds(s);
        return d.toISOString().substr(14, 5);
    };

    const getSpeakerColor = (id) => {
        const colors = ['#5d5dff', '#9333ea', '#059669', '#d97706'];
        const num = id ? parseInt(id.match(/\d+/)) : 0;
        return colors[num % colors.length];
    };

    // --- 4. RENDER LOGIC ---
    function renderParagraphs(segments) {
        if (!segments || segments.length === 0) return "";

        const uniqueSpeakers = new Set(segments.map(s => s.speaker).filter(Boolean));
        window.hasMultipleSpeakers = uniqueSpeakers.size > 1;

        let html = "";
        segments.forEach(seg => {
            // Every segment gets passed through buildGroupHTML for proper row styling
            html += buildGroupHTML({
                speaker: seg.speaker,
                start: seg.start,
                text: seg.text
            });
        });
        return html;
    }

    // --- BUTTON HANDLERS ---
    window.jumpTo = function(seconds) {
        const audio = document.querySelector('audio');
        if (audio) {
            audio.currentTime = seconds;
            audio.play();
        }
    };
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

        const formatSpeaker = (raw) => {
        if (!raw) return "דובר לא ידוע";
        const match = raw.match(/SPEAKER_(\d+)/);
        return match ? `דובר ${parseInt(match[1]) + 1}` : raw;
    };

    window.copyTranscript = function() {
        const text = document.getElementById('transcript-window').innerText;
        navigator.clipboard.writeText(text).then(() => {
        });
    };
    window.saveEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');

        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";

        if (editActions) editActions.style.display = 'none';

        console.log("✅ Edits saved locally.");
        // Note: To save permanently to a database, you would add a fetch() here.
    };

    window.cancelEdits = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');

        if (window.transcriptBackup) {
            win.innerHTML = window.transcriptBackup;
        }

        win.contentEditable = 'false';
        win.style.border = "1px solid #e2e8f0";
        win.style.backgroundColor = "transparent";

        if (editActions) editActions.style.display = 'none';
    };
    window.toggleEditMode = function() {
        const win = document.getElementById('transcript-window');
        const editActions = document.getElementById('edit-actions');
        const isEditable = win.contentEditable === 'true';

        if (!isEditable) {
            // --- START EDITING ---
            win.contentEditable = 'true';
            win.style.border = "2px solid #1e3a8a";
            win.style.backgroundColor = "#fff";

            // Save a backup in case the user cancels
            window.transcriptBackup = win.innerHTML;

            // Show the Save/Cancel buttons
            if (editActions) editActions.style.display = 'flex';
        } else {
            // If they click the "Pencil" again, we treat it as Save
            window.saveEdits();
        }
    };

    function buildGroupHTML(g) {
        const isSpeakerVisible = document.getElementById('toggle-speaker')?.checked;
        const shouldHideSpeaker = !isSpeakerVisible;

        // Added data-start and a unique ID for highlighting
        return `
        <div class="paragraph-row" id="seg-${Math.floor(g.start)}" data-start="${g.start}" style="display: flex; margin-bottom: 12px; padding: 5px; transition: background 0.3s;">
            <div class="ts-col" style="min-width: 60px; color: #888;">${formatTime(g.start)}</div>
            <div class="text-col" style="flex: 1;">
                <span class="speaker-label" style="color:${getSpeakerColor(g.speaker)}; font-weight: bold; display: ${shouldHideSpeaker ? 'none' : 'block'};">
                    ${g.speaker ? g.speaker.replace('SPEAKER_', 'דובר ') : ''}
                </span>
                <p style="margin: 0; cursor: pointer;" onclick="window.jumpTo(${g.start})">${g.text}</p>
            </div>
        </div>`;
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

    // --- 5. UPLOAD LOGIC (FIXED 403) ---
    // Replace your existing fileInput listener with this
    if (fileInput) {
        fileInput.addEventListener('change', async function() {
            if (window.isTriggering) return;

            const file = this.files[0];
            if (!file) return;

            // CREATE A LOCAL PREVIEW URL
            const objectUrl = URL.createObjectURL(file);
            localStorage.setItem('currentAudioUrl', objectUrl);

            const currentFile = file; // Captured for use in the fetch
            fileInput.value = ""; // Reset for next selection

            // 1. Get the snapshot of the toggle state RIGHT NOW
            const diarizationValue = document.getElementById('diarization-toggle')?.checked || false;

            // UI Feedback
            if (mainBtn) { mainBtn.disabled = true; mainBtn.innerText = "Processing..."; }
            if (statusTxt) { statusTxt.innerText = "Uploading..."; statusTxt.style.display = "block"; }

            try {
                // THE FIX: This must stay inside the 'async' function
                const signRes = await fetch('/api/sign-s3', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: currentFile.name,
                        filetype: currentFile.type,
                        diarization: diarizationValue // Correctly passed to siteapp.py
                    })
                });

                const signData = await signRes.json();
                const { url, s3Key, jobId } = signData.data || signData;

                // Start Socket communication
                localStorage.setItem('activeJobId', jobId);
                if (typeof socket !== 'undefined') socket.emit('join', { room: jobId });

                // Proceed with S3 Upload
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', url, true);
                xhr.setRequestHeader('Content-Type', currentFile.type);

                xhr.onload = async () => {
                    if (xhr.status === 200) {
                        window.isTriggering = true;

                        // Trigger GPU (Pass the flag again for the live logic)
                        await fetch('/api/trigger_processing', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                s3Key: s3Key,
                                jobId: jobId,
                                diarization: diarizationValue
                            })
                        });
                        startFakeProgress();
                    } else {
                        window.isTriggering = false;
                        if (mainBtn) mainBtn.disabled = false;
                    }
                };
                xhr.send(currentFile);

            } catch (err) {
                console.error("Upload Error:", err);
                window.isTriggering = false;
                if (mainBtn) mainBtn.disabled = false;
            }
        });
    }
});