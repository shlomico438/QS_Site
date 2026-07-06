/**
 * Medical live transcription via Site WebSocket → AWS Transcribe Streaming.
 * PCM int16 mono @ 16 kHz to /ws/transcribe.
 */

function qsTranscribeStreamWsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws/transcribe`;
}

function qsFloat32ToPcm16(float32) {
    const buf = new ArrayBuffer(float32.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
}

function qsDownsampleFloat32(buffer, fromRate, toRate) {
    if (!buffer || !buffer.length) return new Float32Array(0);
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const len = Math.round(buffer.length / ratio);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = buffer[Math.floor(i * ratio)];
    return out;
}

export class MedicalAwsTranscribeStream {
    constructor(options = {}) {
        this.languageCode = options.languageCode || 'he-IL';
        this.sampleRateHz = Number(options.sampleRateHz) || 16000;
        this.onPartial = typeof options.onPartial === 'function' ? options.onPartial : null;
        this._ws = null;
        this._audioCtx = null;
        this._source = null;
        this._processor = null;
        this._mutedGain = null;
        this._feedPaused = false;
        this._finalTranscript = '';
        this._partials = [];
        this._ready = false;
        this._startResolve = null;
        this._startReject = null;
        this._stopResolve = null;
        this._stopReject = null;
    }

    _handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (_) {
            return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'starting') {
            return;
        }
        if (msg.type === 'error') {
            const err = String(msg.error || msg.message || 'transcribe_stream_error');
            if (this._startReject) {
                const reject = this._startReject;
                this._startReject = null;
                this._startResolve = null;
                reject(new Error(err));
            }
            return;
        }
        if (msg.type === 'ready') {
            this._ready = true;
            if (this._startResolve) {
                const resolve = this._startResolve;
                this._startResolve = null;
                this._startReject = null;
                resolve();
            }
            return;
        }
        if (msg.type === 'partial') {
            const t = String(msg.text || '').trim();
            if (t) {
                this._partials.push(t);
                if (this.onPartial) this.onPartial(t);
            }
            return;
        }
        if (msg.type === 'transcript') {
            this._finalTranscript = String(msg.transcript || '').trim();
            if (Array.isArray(msg.partials)) {
                this._partials = msg.partials.map((p) => String(p || '')).filter(Boolean);
            }
            if (msg.error) {
                if (this._stopReject) this._stopReject(new Error(String(msg.error)));
            } else if (this._stopResolve) {
                this._stopResolve({
                    transcript: this._finalTranscript,
                    partials: this._partials.slice(),
                });
            }
        }
    }

    async start(mediaStream) {
        if (!mediaStream) throw new Error('media_stream_required');
        const wsUrl = qsTranscribeStreamWsUrl();
        this._ws = new WebSocket(wsUrl);
        this._ws.binaryType = 'arraybuffer';
        this._ready = false;

        const readyPromise = new Promise((resolve, reject) => {
            this._startResolve = resolve;
            this._startReject = reject;
        });

        this._ws.onmessage = (ev) => this._handleMessage(ev.data);

        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('transcribe_ws_connect_timeout')), 15000);
            this._ws.onopen = () => {
                clearTimeout(t);
                resolve();
            };
            this._ws.onerror = () => {
                clearTimeout(t);
                reject(new Error('transcribe_ws_error'));
            };
        });

        this._ws.send(JSON.stringify({
            action: 'start',
            sample_rate_hz: this.sampleRateHz,
            language_code: this.languageCode,
        }));

        const readyTimer = setTimeout(() => {
            if (this._startReject) {
                const reject = this._startReject;
                this._startReject = null;
                this._startResolve = null;
                reject(new Error('transcribe_stream_not_ready'));
            }
        }, 45000);

        try {
            await readyPromise;
        } finally {
            clearTimeout(readyTimer);
            this._startResolve = null;
            this._startReject = null;
        }

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this._audioCtx = new AudioCtx();
        this._source = this._audioCtx.createMediaStreamSource(mediaStream);
        this._processor = this._audioCtx.createScriptProcessor(4096, 1, 1);
        this._mutedGain = this._audioCtx.createGain();
        this._mutedGain.gain.value = 0;

        this._processor.onaudioprocess = (ev) => {
            if (this._feedPaused || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
            const input = ev.inputBuffer.getChannelData(0);
            const pcm = qsDownsampleFloat32(input, this._audioCtx.sampleRate, this.sampleRateHz);
            if (!pcm.length) return;
            try {
                this._ws.send(qsFloat32ToPcm16(pcm));
            } catch (_) {}
        };

        this._source.connect(this._processor);
        this._processor.connect(this._mutedGain);
        this._mutedGain.connect(this._audioCtx.destination);
    }

    pause() {
        this._feedPaused = true;
    }

    resume() {
        this._feedPaused = false;
    }

    async stop() {
        this._feedPaused = true;
        try {
            if (this._processor) this._processor.disconnect();
            if (this._source) this._source.disconnect();
            if (this._mutedGain) this._mutedGain.disconnect();
            if (this._audioCtx) await this._audioCtx.close();
        } catch (_) {}

        if (!this._ws || this._ws.readyState === WebSocket.CLOSED) {
            return { transcript: this._finalTranscript, partials: this._partials.slice() };
        }

        const resultPromise = new Promise((resolve, reject) => {
            this._stopResolve = resolve;
            this._stopReject = reject;
            setTimeout(() => {
                if (this._stopResolve) {
                    this._stopResolve = null;
                    resolve({
                        transcript: this._finalTranscript,
                        partials: this._partials.slice(),
                    });
                }
            }, 30000);
        });

        try {
            if (this._ws.readyState === WebSocket.OPEN) {
                this._ws.send(JSON.stringify({ action: 'stop' }));
            }
        } catch (_) {}

        const result = await resultPromise;
        try { this._ws.close(); } catch (_) {}
        this._ws = null;
        return result;
    }

    abort() {
        this._feedPaused = true;
        try {
            if (this._processor) this._processor.disconnect();
            if (this._source) this._source.disconnect();
            if (this._audioCtx) void this._audioCtx.close();
        } catch (_) {}
        try {
            if (this._ws) this._ws.close();
        } catch (_) {}
        this._ws = null;
    }
}

let _medicalStreamConfigCache = null;

export async function qsFetchMedicalTranscriptionConfig() {
    if (_medicalStreamConfigCache) return _medicalStreamConfigCache;
    try {
        const res = await fetch('/api/medical_transcription_config');
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && typeof data === 'object') {
            _medicalStreamConfigCache = data;
            return data;
        }
    } catch (_) {}
    return { use_aws_transcribe_stream: true };
}

export function qsMedicalUseAwsTranscribeStream() {
    const cfg = _medicalStreamConfigCache;
    if (cfg && typeof cfg.use_aws_transcribe_stream === 'boolean') {
        return cfg.use_aws_transcribe_stream;
    }
    return true;
}
