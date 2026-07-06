/**
 * Medical live transcription via Socket.IO (primary) or /ws/transcribe fallback.
 * PCM int16 mono @ 16 kHz → AWS Transcribe Streaming.
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

function qsGetGlobalSocket() {
    try {
        if (typeof socket !== 'undefined' && socket) return socket;
    } catch (_) {}
    return null;
}

function qsWaitForSocketConnected(sock, timeoutMs = 15000) {
    if (!sock) return Promise.reject(new Error('socket_unavailable'));
    if (sock.connected) return Promise.resolve(sock);
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            sock.off('connect', onConnect);
            reject(new Error('socket_connect_timeout'));
        }, timeoutMs);
        function onConnect() {
            clearTimeout(t);
            sock.off('connect', onConnect);
            resolve(sock);
        }
        sock.on('connect', onConnect);
    });
}

export class MedicalAwsTranscribeStream {
    constructor(options = {}) {
        this.languageCode = options.languageCode || 'he-IL';
        this.sampleRateHz = Number(options.sampleRateHz) || 16000;
        this.transport = options.transport || 'socketio';
        this.onPartial = typeof options.onPartial === 'function' ? options.onPartial : null;
        this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
        this._ws = null;
        this._socket = null;
        this._socketEventHandler = null;
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

    _emitStatus(text) {
        if (this.onStatus) {
            try { this.onStatus(String(text || '')); } catch (_) {}
        }
    }

    _rejectStart(err) {
        if (!this._startReject) return;
        const reject = this._startReject;
        this._startReject = null;
        this._startResolve = null;
        reject(err instanceof Error ? err : new Error(String(err || 'transcribe_stream_start_failed')));
    }

    _resolveStart() {
        if (!this._startResolve) return;
        const resolve = this._startResolve;
        this._startReject = null;
        this._startResolve = null;
        resolve();
    }

    _handleServerMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'connected') {
            console.info('[transcribe-stream] server connected');
            this._emitStatus('connecting');
            return;
        }
        if msg.type === 'starting') {
            console.info('[transcribe-stream] server starting aws', msg.region ? `region=${msg.region}` : '');
            this._emitStatus('starting');
            return;
        }
        if (msg.type === 'error') {
            const err = String(msg.error || msg.message || 'transcribe_stream_error');
            const region = msg.region ? ` (region=${msg.region})` : '';
            console.error('[transcribe-stream] server error', err + region);
            this._rejectStart(new Error(err));
            return;
        }
        if (msg.type === 'ready') {
            console.info('[transcribe-stream] server ready');
            this._ready = true;
            this._emitStatus('listening');
            this._resolveStart();
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

    _canSendAudio() {
        if (this._feedPaused) return false;
        if (this._socket) return Boolean(this._socket.connected);
        return this._ws && this._ws.readyState === WebSocket.OPEN;
    }

    _sendAudioChunk(pcmArrayBuffer) {
        if (!this._canSendAudio()) return;
        try {
            if (this._socket) {
                this._socket.emit('medical_transcribe_audio', pcmArrayBuffer);
            } else if (this._ws) {
                this._ws.send(pcmArrayBuffer);
            }
        } catch (_) {}
    }

    _beginAudioCapture(mediaStream) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this._audioCtx = new AudioCtx();
        this._source = this._audioCtx.createMediaStreamSource(mediaStream);
        this._processor = this._audioCtx.createScriptProcessor(4096, 1, 1);
        this._mutedGain = this._audioCtx.createGain();
        this._mutedGain.gain.value = 0;

        this._processor.onaudioprocess = (ev) => {
            if (!this._canSendAudio()) return;
            const input = ev.inputBuffer.getChannelData(0);
            const pcm = qsDownsampleFloat32(input, this._audioCtx.sampleRate, this.sampleRateHz);
            if (!pcm.length) return;
            this._sendAudioChunk(qsFloat32ToPcm16(pcm));
        };

        this._source.connect(this._processor);
        this._processor.connect(this._mutedGain);
        this._mutedGain.connect(this._audioCtx.destination);
    }

    _teardownSocketIo() {
        if (this._socket && this._socketEventHandler) {
            try { this._socket.off('medical_transcribe_event', this._socketEventHandler); } catch (_) {}
        }
        this._socketEventHandler = null;
        this._socket = null;
    }

    async _startSocketIo(mediaStream) {
        const sock = qsGetGlobalSocket();
        if (!sock) throw new Error('socket_unavailable');
        await qsWaitForSocketConnected(sock);

        this._socket = sock;
        this._ready = false;
        this._socketEventHandler = (msg) => this._handleServerMessage(msg);
        sock.on('medical_transcribe_event', this._socketEventHandler);

        const readyPromise = new Promise((resolve, reject) => {
            this._startResolve = resolve;
            this._startReject = reject;
        });

        console.info('[transcribe-stream] connecting via socket.io');
        this._emitStatus('connecting');
        sock.emit('medical_transcribe_start', {
            action: 'start',
            sample_rate_hz: this.sampleRateHz,
            language_code: this.languageCode,
        });

        this._beginAudioCapture(mediaStream);

        const readyTimer = setTimeout(() => {
            this._rejectStart(new Error('transcribe_stream_not_ready'));
        }, 45000);

        try {
            await readyPromise;
        } finally {
            clearTimeout(readyTimer);
            this._startResolve = null;
            this._startReject = null;
        }
    }

    async _startWebSocket(mediaStream) {
        const wsUrl = qsTranscribeStreamWsUrl();
        console.info('[transcribe-stream] connecting', wsUrl);
        this._emitStatus('connecting');
        this._ws = new WebSocket(wsUrl);
        this._ws.binaryType = 'arraybuffer';
        this._ready = false;

        const readyPromise = new Promise((resolve, reject) => {
            this._startResolve = resolve;
            this._startReject = reject;
        });

        this._ws.onmessage = (ev) => {
            try {
                this._handleServerMessage(JSON.parse(ev.data));
            } catch (_) {}
        };

        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('transcribe_ws_connect_timeout')), 15000);
            this._ws.onopen = () => {
                clearTimeout(t);
                console.info('[transcribe-stream] websocket open');
                resolve();
            };
            this._ws.onerror = (ev) => {
                clearTimeout(t);
                console.error('[transcribe-stream] websocket error', ev);
                reject(new Error('transcribe_ws_error'));
            };
            this._ws.onclose = (ev) => {
                console.warn('[transcribe-stream] websocket closed', ev.code, ev.reason);
                if (!this._ready) {
                    this._rejectStart(new Error(`transcribe_ws_closed_${ev.code || 1005}`));
                }
            };
        });

        this._ws.send(JSON.stringify({
            action: 'start',
            sample_rate_hz: this.sampleRateHz,
            language_code: this.languageCode,
        }));

        this._beginAudioCapture(mediaStream);

        const readyTimer = setTimeout(() => {
            this._rejectStart(new Error('transcribe_stream_not_ready'));
        }, 45000);

        try {
            await readyPromise;
        } finally {
            clearTimeout(readyTimer);
            this._startResolve = null;
            this._startReject = null;
        }
    }

    async start(mediaStream) {
        if (!mediaStream) throw new Error('media_stream_required');
        const useSocketIo = this.transport !== 'websocket' && Boolean(qsGetGlobalSocket());
        if (useSocketIo) {
            await this._startSocketIo(mediaStream);
        } else {
            await this._startWebSocket(mediaStream);
        }
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

        if (this._socket) {
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
                if (this._socket.connected) {
                    this._socket.emit('medical_transcribe_stop');
                }
            } catch (_) {}
            const result = await resultPromise;
            this._teardownSocketIo();
            return result;
        }

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
            if (this._socket && this._socket.connected) {
                this._socket.emit('medical_transcribe_stop');
            }
        } catch (_) {}
        this._teardownSocketIo();
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
    return { use_aws_transcribe_stream: true, transcribe_stream_transport: 'socketio' };
}

export function qsMedicalUseAwsTranscribeStream() {
    const cfg = _medicalStreamConfigCache;
    if (cfg && typeof cfg.use_aws_transcribe_stream === 'boolean') {
        return cfg.use_aws_transcribe_stream;
    }
    return true;
}
