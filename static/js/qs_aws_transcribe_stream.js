/**
 * Medical live transcription via Socket.IO HTTP long-polling only.
 * No WebSocket upgrade and no /ws/transcribe fallback (avoids mid-session WS stalls).
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
    for (let i = 0; i < len; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
            sum += buffer[j];
            count += 1;
        }
        out[i] = count ? (sum / count) : buffer[Math.min(start, buffer.length - 1)];
    }
    return out;
}

function qsSpeechGainAmount(rms, peak) {
    if (!Number.isFinite(rms) || rms <= 0.002) return 1;
    const gain = Math.max(1, Math.min(3, 0.03 / rms, 0.92 / Math.max(0.001, Number(peak) || 0.001)));
    return gain <= 1.05 ? 1 : gain;
}

function qsApplySpeechGain(float32, rms, peak) {
    const gain = qsSpeechGainAmount(rms, peak);
    if (!float32 || !float32.length || gain <= 1.05) return float32;
    const out = new Float32Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        out[i] = Math.max(-1, Math.min(1, float32[i] * gain));
    }
    return out;
}

function qsGetGlobalSocket() {
    // app_logic / base.html attach Socket.IO on window.socket. This file is an ES
    // module, so a bare `socket` identifier does not resolve to window.socket.
    try {
        if (typeof window !== 'undefined' && window.socket) return window.socket;
    } catch (_) {}
    try {
        if (typeof socket !== 'undefined' && socket) return socket;
    } catch (_) {}
    return null;
}

function qsSocketTransportName(sock) {
    try {
        return String(
            (sock && sock.io && sock.io.engine && sock.io.engine.transport
                && sock.io.engine.transport.name)
            || ''
        ).toLowerCase();
    } catch (_) {
        return '';
    }
}

/** True when this network is already on Socket.IO long-polling (raw /ws/transcribe will usually fail). */
function qsSocketIoIsPollingOnly(sock) {
    if (!sock) return false;
    const name = qsSocketTransportName(sock);
    if (name === 'polling') return true;
    try {
        const opts = sock.io && sock.io.opts;
        if (opts && opts.upgrade === false) return true;
        const transports = opts && opts.transports;
        if (Array.isArray(transports) && transports.length === 1 && transports[0] === 'polling') {
            return true;
        }
    } catch (_) {}
    return false;
}

function qsWaitForSocketConnected(sock, timeoutMs = 20000) {
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

/** Max PCM held before transport is armed (~45s @ 16 kHz mono int16). */
const QS_PRE_READY_BUFFER_MAX_BYTES = 16000 * 2 * 45;
/** When Socket.IO is on HTTP polling, batch PCM for fewer POSTs.
 * Server splits to ~100ms AWS frames. 900ms batches cut poll rate vs 300ms. */
const QS_POLLING_BATCH_MAX_BYTES = 32000; // ~1s @ 16 kHz mono int16; let the 900ms timer win
const QS_POLLING_BATCH_MAX_MS = 900;
/** Cold start: no server audio/partials at all. Mid-session gaps of 5–8s are normal for AWS. */
const QS_STARVATION_RESTART_MS = 8000;
/** After live text has started, only treat a stall as real if AWS is silent this long. */
const QS_PARTIAL_STALL_MS = 20000;

export class MedicalAwsTranscribeStream {
    constructor(options = {}) {
        this.languageCode = options.languageCode || 'he-IL';
        this.sampleRateHz = Number(options.sampleRateHz) || 16000;
        this.identifyMultipleLanguages = options.identifyMultipleLanguages === true;
        const opts = Array.isArray(options.languageOptions) ? options.languageOptions : null;
        this.languageOptions = (opts && opts.length >= 2)
            ? opts.map((x) => String(x || '').trim()).filter(Boolean)
            : ['he-IL', 'en-US'];
        this.preferredLanguage = String(options.preferredLanguage || this.languageCode || 'he-IL').trim() || 'he-IL';
        this.accessToken = String(options.accessToken || '').trim();
        this.committedTranscript = String(options.committedTranscript || '').trim();
        this.applySpeechGain = options.applySpeechGain !== false;
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
        this._partialUpdates = 0;
        this._ready = false;
        /** True after medical_transcribe_start was sent — server can buffer PCM before AWS ready. */
        this._transportArmed = false;
        /** Client still wants a live session (between connect and stop/abort). */
        this._sessionWanted = false;
        /** At least one AWS ready received this capture. */
        this._hadLiveSession = false;
        this._restartingAfterReconnect = false;
        this._onSocketDisconnect = null;
        this._onSocketConnect = null;
        this._startResolve = null;
        this._startReject = null;
        this._stopResolve = null;
        this._stopReject = null;
        this._chunksSent = 0;
        this._lastRms = 0;
        this._lastPeak = 0;
        this._lastGain = 1;
        this._audioWatchdog = null;
        this._preReadyBuffer = [];
        this._preReadyBufferBytes = 0;
        this._preReadyChunksBuffered = 0;
        this._pollingBatch = [];
        this._pollingBatchBytes = 0;
        this._pollingBatchTimer = null;
        this._pollingBatchLogged = false;
        this._serverGotAudio = false;
        this._starvationTimer = null;
        this._starvationRestarts = 0;
        this._stallTransportCycles = 0;
        this._loggedPartial = false;
        this._lastPartialText = '';
        this._lastPartialAt = 0;
        this._lastQuietAt = Date.now();
        this._partialsSinceReady = 0;
        this._restartingAfterStall = false;
        this._stallRestartAt = 0;
        this._chunksSentAtStallRestart = 0;
        this._httpAudio = true;
        this._httpAudioLogged = false;
        this._httpAudioFailed = false;
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
            // Socket.IO registers the bridge before emitting connected. WebSocket emits
            // connected on open before start — wait for "starting" there.
            if (this._socket) this._armTransport();
            this._emitStatus('connecting');
            return;
        }
        if (msg.type === 'starting') {
            console.info('[transcribe-stream] server starting aws', msg.region ? `region=${msg.region}` : '');
            this._armTransport();
            this._emitStatus('starting');
            return;
        }
        if (msg.type === 'resuming') {
            console.info('[transcribe-stream] server resuming aws', msg.region ? `region=${msg.region}` : '');
            this._armTransport();
            this._emitStatus('resuming');
            return;
        }
        if (msg.type === 'parked') {
            console.info('[transcribe-stream] aws parked', msg.reason || '', 'committed_len=', msg.committed_len);
            this._emitStatus('parked');
            this._armStarvationWatch();
            return;
        }
        if (msg.type === 'audio_rx') {
            this._serverGotAudio = true;
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
            console.info('[transcribe-stream] server ready', msg.resumed ? '(resumed)' : '');
            this._ready = true;
            this._hadLiveSession = true;
            this._restartingAfterReconnect = false;
            this._restartingAfterStall = false;
            this._httpAudioFailed = false;
            this._partialsSinceReady = 0;
            this._starvationRestarts = 0;
            this._armTransport();
            this._emitStatus('listening');
            this._resolveStart();
            this._armStarvationWatch();
            return;
        }
        if (msg.type === 'partial') {
            const t = String(msg.text || '').trim();
            if (t) {
                this._serverGotAudio = true;
                this._stallTransportCycles = 0;
                if (t === this._lastPartialText) return;
                this._partialsSinceReady += 1;
                this._lastPartialAt = Date.now();
                this._restartingAfterStall = false;
                this._armStarvationWatch();
                this._lastPartialText = t;
                this._partialUpdates += 1;
                if (!this._loggedPartial) {
                    this._loggedPartial = true;
                    const via = msg.via ? ` via ${msg.via}` : '';
                    console.info('[transcribe-stream] first partial received' + via);
                } else if (this._partialUpdates <= 5 || this._partialUpdates % 10 === 0) {
                    console.info('[transcribe-stream] partial update:', this._partialUpdates, 'chars:', t.length);
                }
                this._partials.push(t);
                if (this.onPartial) this.onPartial(t);
            }
            return;
        }
        if (msg.type === 'transcript') {
            const incoming = String(msg.transcript || '').trim();
            if (incoming) this._finalTranscript = incoming;
            if (Array.isArray(msg.partials) && msg.partials.length) {
                this._partials = msg.partials.map((p) => String(p || '')).filter(Boolean);
            }
            if (!this._finalTranscript && this._partials.length) {
                this._finalTranscript = String(this._partials[this._partials.length - 1] || '').trim();
            }
            if (msg.error && !this._finalTranscript) {
                if (this._stopReject) {
                    const reject = this._stopReject;
                    this._stopReject = null;
                    this._stopResolve = null;
                    reject(new Error(String(msg.error)));
                }
            } else if (this._stopResolve) {
                const resolve = this._stopResolve;
                this._stopResolve = null;
                this._stopReject = null;
                resolve({
                    transcript: this._finalTranscript,
                    partials: this._partials.slice(),
                    warning: msg.error ? String(msg.error) : null,
                });
            }
        }
    }

    _canCaptureAudio() {
        return !this._feedPaused && Boolean(this._processor);
    }

    _canSendLiveAudio() {
        if (this._feedPaused || !this._transportArmed) return false;
        if (this._socket) return Boolean(this._socket.connected);
        return this._ws && this._ws.readyState === WebSocket.OPEN;
    }

    _armTransport() {
        if (this._transportArmed) {
            this._flushPreReadyBuffer();
            return;
        }
        this._transportArmed = true;
        this._flushPreReadyBuffer();
        console.info('[transcribe-stream] transport armed; sending buffered PCM to server');
    }

    _socketTransportName() {
        return qsSocketTransportName(this._socket);
    }

    _isSocketPolling() {
        if (!this._socket) return false;
        return qsSocketIoIsPollingOnly(this._socket) || this._socketTransportName() === 'polling';
    }

    _snapshotCommittedText() {
        try {
            if (typeof window.qsSyncMedicalLiveStreamTextFromDom === 'function') {
                window.qsSyncMedicalLiveStreamTextFromDom();
            }
        } catch (_) {}
        let text = '';
        try { text = String(window._medicalLiveStreamText || '').trim(); } catch (_) {}
        if (!text) text = String(this.committedTranscript || '').trim();
        this.committedTranscript = text;
        try { window._medicalLiveCommitAnchor = text; } catch (_) {}
        return text;
    }

    _emitStartConfig() {
        if (!this._socket) return;
        const committed = this._snapshotCommittedText();
        this._socket.emit('medical_transcribe_start', {
            action: 'start',
            sample_rate_hz: this.sampleRateHz,
            language_code: this.languageCode,
            identify_multiple_languages: this.identifyMultipleLanguages === true,
            language_options: this.languageOptions,
            preferred_language: this.preferredLanguage,
            access_token: this.accessToken,
            guest_try: this.guestTry === true,
            committed_transcript: committed,
            transcript_prefix: committed,
        });
    }

    _clearStarvationWatch() {
        if (this._starvationTimer) {
            clearTimeout(this._starvationTimer);
            this._starvationTimer = null;
        }
    }

    _armStarvationWatch() {
        this._clearStarvationWatch();
        if (!this._socket) return;
        const delay = this._partialsSinceReady > 0
            ? QS_PARTIAL_STALL_MS
            : QS_STARVATION_RESTART_MS;
        this._starvationTimer = setTimeout(() => {
            this._starvationTimer = null;
            this._onStarvationTimeout();
        }, delay);
    }

    _restartAwsAfterStall(reason) {
        const now = Date.now();
        if (this._restartingAfterStall && (now - this._stallRestartAt) < 10000) {
            this._armStarvationWatch();
            return;
        }
        this._starvationRestarts += 1;
        this._restartingAfterStall = true;
        this._stallRestartAt = now;
        this._chunksSentAtStallRestart = this._chunksSent;
        this._partialsSinceReady = 0;
        console.warn(
            '[transcribe-stream]',
            reason,
            '— restarting AWS session (#',
            this._starvationRestarts,
            ') chunksSent=',
            this._chunksSent,
            'rms=',
            this.getLastRms().toFixed(4),
            'transport=',
            this._socketTransportName() || 'unknown'
        );
        // Keep transport armed so PCM POSTs continue. Disarming dumps audio into
        // a local buffer, so the new session never hears the speaker.
        this._emitStatus('resuming');
        try {
            this._emitStartConfig();
        } catch (e) {
            this._restartingAfterStall = false;
            console.warn('[transcribe-stream] stall restart failed', e);
        }
        this._armStarvationWatch();
    }

    _onStarvationTimeout() {
        if (!this._sessionWanted || this._feedPaused) return;
        const speaking = this.getLastRms() >= 0.008;
        if (!speaking) {
            this._armStarvationWatch();
            return;
        }
        const speechGapMs = Date.now() - Math.max(this._lastQuietAt || 0, this._lastPartialAt || 0);
        if (this._restartingAfterStall) {
            const sentSince = this._chunksSent - (this._chunksSentAtStallRestart || 0);
            if (sentSince < 80 || speechGapMs < QS_STARVATION_RESTART_MS) {
                this._armStarvationWatch();
                return;
            }
            if (this._starvationRestarts >= 3) {
                console.warn(
                    '[transcribe-stream] still no new partials after restarts;',
                    'chunksSent=',
                    this._chunksSent,
                    'transport=',
                    this._socketTransportName() || 'unknown'
                );
                this._armStarvationWatch();
                return;
            }
            this._restartAwsAfterStall('start issued but no new partials');
            return;
        }
        if (this._partialsSinceReady <= 0) {
            if (this._chunksSent < 20 || speechGapMs < QS_STARVATION_RESTART_MS) {
                this._armStarvationWatch();
                return;
            }
            this._restartAwsAfterStall('ready but no new partials');
            return;
        }
        if (this._chunksSent >= 20 && speechGapMs >= QS_PARTIAL_STALL_MS) {
            this._restartAwsAfterStall('no partial while speaking');
            return;
        }
        this._armStarvationWatch();
    }

    _unbindSocketLifecycle() {
        if (!this._socket) return;
        if (this._onSocketDisconnect) {
            try { this._socket.off('disconnect', this._onSocketDisconnect); } catch (_) {}
            this._onSocketDisconnect = null;
        }
        if (this._onSocketConnect) {
            try { this._socket.off('connect', this._onSocketConnect); } catch (_) {}
            this._onSocketConnect = null;
        }
    }

    _bindSocketLifecycle() {
        this._unbindSocketLifecycle();
        if (!this._socket) return;
        this._onSocketDisconnect = (reason) => {
            if (!this._sessionWanted || this._feedPaused) return;
            console.warn(
                '[transcribe-stream] socket disconnect during live session:',
                reason,
                '— will restart AWS on reconnect'
            );
            this._ready = false;
            // Force pre-ready buffering until the new bridge is ready (avoid dropped PCM).
            this._transportArmed = false;
            this._clearPollingBatch();
            this._snapshotCommittedText();
            this._emitStatus('resuming');
        };
        this._onSocketConnect = () => {
            if (!this._sessionWanted || this._feedPaused) return;
            if (!this._hadLiveSession) return;
            if (this._ready) return;
            if (this._restartingAfterReconnect) return;
            this._restartingAfterReconnect = true;
            this._httpAudioFailed = false;
            this._serverGotAudio = false;
            this._clearStarvationWatch();
            console.info(
                '[transcribe-stream] socket reconnected; restarting aws session',
                'transport=',
                qsSocketTransportName(this._socket) || 'unknown'
            );
            this._emitStatus('resuming');
            try {
                this._emitStartConfig();
            } catch (e) {
                this._restartingAfterReconnect = false;
                console.warn('[transcribe-stream] reconnect restart failed', e);
                return;
            }
        };
        try { this._socket.on('disconnect', this._onSocketDisconnect); } catch (_) {}
        try { this._socket.on('connect', this._onSocketConnect); } catch (_) {}
    }

    _clearPollingBatchTimer() {
        if (this._pollingBatchTimer) {
            clearTimeout(this._pollingBatchTimer);
            this._pollingBatchTimer = null;
        }
    }

    _clearPollingBatch() {
        this._clearPollingBatchTimer();
        this._pollingBatch = [];
        this._pollingBatchBytes = 0;
    }

    _flushPollingBatch() {
        this._clearPollingBatchTimer();
        if (!this._pollingBatch.length || !this._socket) return;
        if (!this._socket.connected) {
            this._clearPollingBatch();
            return;
        }
        let total = 0;
        for (const part of this._pollingBatch) total += part.byteLength || part.length || 0;
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const part of this._pollingBatch) {
            const view = part instanceof Uint8Array ? part : new Uint8Array(part);
            merged.set(view, offset);
            offset += view.byteLength;
        }
        this._pollingBatch = [];
        this._pollingBatchBytes = 0;
        this._emitAudioWithAck(merged);
    }

    _emitAudioWithAck(payload) {
        if (this._httpAudio && !this._httpAudioFailed && this._socket && this._socket.id) {
            void this._postAudioHttp(payload);
            return;
        }
        if (!this._socket) return;
        const onAck = (ack) => {
            if (!ack || typeof ack !== 'object') return;
            this._handleServerMessage(ack);
        };
        try {
            this._socket.emit('medical_transcribe_audio', payload, onAck);
        } catch (_) {}
    }

    async _postAudioHttp(payload) {
        const sid = this._socket && this._socket.id;
        if (!sid) return;
        if (!this._httpAudioLogged) {
            this._httpAudioLogged = true;
            console.info('[transcribe-stream] audio POST /api/medical_transcribe_audio (transcript on same response)');
        }
        try {
            const body = payload instanceof Uint8Array
                ? payload
                : new Uint8Array(payload instanceof ArrayBuffer ? payload : payload);
            const res = await fetch(
                `/api/medical_transcribe_audio?sid=${encodeURIComponent(sid)}`,
                {
                    method: 'POST',
                    credentials: 'include',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body,
                }
            );
            if (res.status === 409) {
                this._httpAudioFailed = true;
                this._emitAudioWithAck(payload);
                return;
            }
            if (!res.ok) return;
            const ack = await res.json().catch(() => null);
            if (ack && ack.type) this._handleServerMessage(ack);
        } catch (_) {}
    }

    _emitAudioPayload(payload) {
        if (this._socket) {
            // WebSocket can take many small emits. Polling batches them into one packet
            // so Engine.IO does not hit "Too many packets in payload".
            if (this._isSocketPolling()) {
                const view = payload instanceof Uint8Array
                    ? payload
                    : new Uint8Array(payload instanceof ArrayBuffer ? payload : payload);
                if (!view.byteLength) return;
                if (!this._pollingBatchLogged) {
                    this._pollingBatchLogged = true;
                    console.warn(
                        '[transcribe-stream] Socket.IO on polling — batching PCM audio'
                        + ' (hospital/proxy WebSocket likely blocked)'
                    );
                }
                this._pollingBatch.push(view);
                this._pollingBatchBytes += view.byteLength;
                if (this._pollingBatchBytes >= QS_POLLING_BATCH_MAX_BYTES) {
                    this._flushPollingBatch();
                    return;
                }
                if (!this._pollingBatchTimer) {
                    this._pollingBatchTimer = setTimeout(() => {
                        this._pollingBatchTimer = null;
                        this._flushPollingBatch();
                    }, QS_POLLING_BATCH_MAX_MS);
                }
                return;
            }
            this._flushPollingBatch();
            this._emitAudioWithAck(payload);
        } else if (this._ws) {
            this._ws.send(payload);
        }
    }

    _bufferPreReadyChunk(pcmArrayBuffer) {
        const buf = pcmArrayBuffer instanceof ArrayBuffer ? pcmArrayBuffer : pcmArrayBuffer.buffer;
        const bytes = buf.byteLength;
        if (!bytes) return;
        this._preReadyBuffer.push(buf);
        this._preReadyBufferBytes += bytes;
        this._preReadyChunksBuffered += 1;
        while (this._preReadyBufferBytes > QS_PRE_READY_BUFFER_MAX_BYTES && this._preReadyBuffer.length) {
            const dropped = this._preReadyBuffer.shift();
            this._preReadyBufferBytes -= dropped.byteLength;
            console.warn(
                '[transcribe-stream] pre-ready buffer overflow; dropped oldest chunk bytes=',
                dropped && dropped.byteLength
            );
        }
    }

    _flushPreReadyBuffer() {
        if (!this._preReadyBuffer.length) return;
        if (!this._canSendLiveAudio()) return;
        const count = this._preReadyBuffer.length;
        const bytes = this._preReadyBufferBytes;
        try {
            for (const chunk of this._preReadyBuffer) {
                this._emitAudioPayload(new Uint8Array(chunk));
            }
        } catch (_) {}
        console.info('[transcribe-stream] flushed pre-ready buffer:', count, 'chunks,', bytes, 'bytes');
        this._preReadyBuffer = [];
        this._preReadyBufferBytes = 0;
        this._preReadyChunksBuffered = 0;
    }

    _clearPreReadyBuffer() {
        this._preReadyBuffer = [];
        this._preReadyBufferBytes = 0;
        this._preReadyChunksBuffered = 0;
    }

    _sendAudioChunk(pcmArrayBuffer) {
        if (!this._canSendLiveAudio()) return;
        try {
            const payload = pcmArrayBuffer instanceof ArrayBuffer
                ? new Uint8Array(pcmArrayBuffer)
                : pcmArrayBuffer;
            this._emitAudioPayload(payload);
        } catch (_) {}
    }

    _setupAudioGraph(mediaStream) {
        if (this._processor) return;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) throw new Error('audio_context_unavailable');
        this._audioCtx = new AudioCtx();
        this._source = this._audioCtx.createMediaStreamSource(mediaStream);
        // Request stereo input so we can explicitly downmix when devices ignore channelCount=1.
        this._processor = this._audioCtx.createScriptProcessor(4096, 2, 1);
        this._mutedGain = this._audioCtx.createGain();
        this._mutedGain.gain.value = 0;
        this._chunksSent = 0;
        this._clearPreReadyBuffer();

        this._processor.onaudioprocess = (ev) => {
            if (!this._canCaptureAudio()) return;
            const inBuf = ev.inputBuffer;
            const channels = inBuf.numberOfChannels || 1;
            let mono = inBuf.getChannelData(0);
            if (channels > 1) {
                const ch1 = inBuf.getChannelData(1);
                const mixed = new Float32Array(mono.length);
                for (let i = 0; i < mono.length; i++) mixed[i] = 0.5 * (mono[i] + ch1[i]);
                mono = mixed;
            }
            const pcm = qsDownsampleFloat32(mono, this._audioCtx.sampleRate, this.sampleRateHz);
            if (!pcm.length) return;
            let sumSq = 0;
            let peak = 0;
            for (let i = 0; i < pcm.length; i++) {
                const v = Math.abs(pcm[i]);
                sumSq += v * v;
                if (v > peak) peak = v;
            }
            this._lastRms = Math.sqrt(sumSq / pcm.length);
            this._lastPeak = peak;
            if (this._lastRms < 0.008) this._lastQuietAt = Date.now();
            this._lastGain = this.applySpeechGain ? qsSpeechGainAmount(this._lastRms, this._lastPeak) : 1;
            const audioPcm = this.applySpeechGain ? qsApplySpeechGain(pcm, this._lastRms, this._lastPeak) : pcm;
            const pcmBuf = qsFloat32ToPcm16(audioPcm);
            if (this._canSendLiveAudio()) {
                this._sendAudioChunk(pcmBuf);
                this._chunksSent += 1;
            } else {
                this._bufferPreReadyChunk(pcmBuf);
                if (this._preReadyChunksBuffered === 1 || this._preReadyChunksBuffered % 20 === 0) {
                    console.info(
                        '[transcribe-stream] buffering pre-transport audio:',
                        this._preReadyChunksBuffered,
                        'chunks,',
                        this._preReadyBufferBytes,
                        'bytes'
                    );
                }
            }
            const totalChunks = this._chunksSent + this._preReadyChunksBuffered;
            const logLevels = (
                totalChunks === 1
                || this._chunksSent === 1
                || this._chunksSent === 10
                || this._chunksSent === 25
                || (this._chunksSent > 0 && this._chunksSent % 50 === 0)
            );
            if (logLevels) {
                // console.error survives the prod console gate (info/warn are no-oped).
                console.error(
                    '[transcribe-stream] audio chunks sent:',
                    this._chunksSent,
                    'rms:',
                    this._lastRms.toFixed(4),
                    'peak:',
                    this._lastPeak.toFixed(4),
                    'gain:',
                    this._lastGain.toFixed(2)
                );
            }
        };

        this._source.connect(this._processor);
        this._processor.connect(this._mutedGain);
        this._mutedGain.connect(this._audioCtx.destination);
    }

    async _activateAudioCapture() {
        if (!this._audioCtx) return;
        try {
            if (this._audioCtx.state === 'suspended') {
                await this._audioCtx.resume();
            }
        } catch (e) {
            console.warn('[transcribe-stream] AudioContext resume failed', e);
        }
        if (this._audioCtx.state !== 'running') {
            console.warn('[transcribe-stream] AudioContext not running:', this._audioCtx.state);
        } else {
            console.info('[transcribe-stream] AudioContext running at', this._audioCtx.sampleRate, 'Hz');
        }
        if (this._audioWatchdog) clearInterval(this._audioWatchdog);
        this._audioWatchdog = setInterval(() => {
            if (!this._audioCtx) return;
            if (this._audioCtx.state === 'suspended') {
                void this._audioCtx.resume().catch(() => {});
            }
        }, 2000);
        if (!this._visibilityBound) {
            this._visibilityBound = true;
            this._onVisibility = () => {
                if (document.visibilityState !== 'visible') return;
                if (this._feedPaused) return;
                if (this._audioCtx && this._audioCtx.state === 'suspended') {
                    void this._audioCtx.resume().catch(() => {});
                }
            };
            document.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    _teardownAudioGraph() {
        if (this._audioWatchdog) {
            clearInterval(this._audioWatchdog);
            this._audioWatchdog = null;
        }
        if (this._visibilityBound && this._onVisibility) {
            try { document.removeEventListener('visibilitychange', this._onVisibility); } catch (_) {}
            this._visibilityBound = false;
            this._onVisibility = null;
        }
        try {
            if (this._processor) this._processor.disconnect();
            if (this._source) this._source.disconnect();
            if (this._mutedGain) this._mutedGain.disconnect();
        } catch (_) {}
        this._processor = null;
        this._source = null;
        this._mutedGain = null;
    }

    async _closeAudioContext() {
        this._teardownAudioGraph();
        if (!this._audioCtx) return;
        try {
            await this._audioCtx.close();
        } catch (_) {}
        this._audioCtx = null;
    }

    _teardownSocketIo() {
        this._unbindSocketLifecycle();
        if (this._socket && this._socketEventHandler) {
            try { this._socket.off('medical_transcribe_event', this._socketEventHandler); } catch (_) {}
        }
        this._socketEventHandler = null;
        this._socket = null;
        this._sessionWanted = false;
        this._restartingAfterReconnect = false;
    }

    async _startSocketIo() {
        const sock = qsGetGlobalSocket();
        if (!sock) throw new Error('socket_unavailable');
        if (!sock.connected) {
            // Hospital networks can be slow to establish long-polling.
            try {
                await qsWaitForSocketConnected(sock, 20000);
            } catch (e) {
                throw new Error('socket_connect_timeout');
            }
        }

        this._socket = sock;
        this._sessionWanted = true;
        this._ready = false;
        this._transportArmed = false;
        this._serverGotAudio = false;
        this._starvationRestarts = 0;
        this._partialsSinceReady = 0;
        this._clearStarvationWatch();
        this._socketEventHandler = (msg) => this._handleServerMessage(msg);
        sock.on('medical_transcribe_event', this._socketEventHandler);
        this._bindSocketLifecycle();

        const readyPromise = new Promise((resolve, reject) => {
            this._startResolve = resolve;
            this._startReject = reject;
        });

        const onSockDisconnect = () => {
            this._rejectStart(new Error('socket_disconnected_during_start'));
        };
        try { sock.once('disconnect', onSockDisconnect); } catch (_) {}

        console.info(
            '[transcribe-stream] connecting via socket.io',
            'connected=',
            !!sock.connected,
            'transport=',
            qsSocketTransportName(sock) || 'unknown',
            'pollingOnly=',
            qsSocketIoIsPollingOnly(sock)
        );
        this._emitStatus('connecting');
        this._emitStartConfig();

        const readyTimer = setTimeout(() => {
            this._rejectStart(new Error('transcribe_stream_not_ready'));
        }, 45000);

        try {
            await readyPromise;
            console.info(
                '[transcribe-stream] socket.io live path ready',
                'transport=',
                qsSocketTransportName(sock) || 'unknown'
            );
        } finally {
            clearTimeout(readyTimer);
            try { sock.off('disconnect', onSockDisconnect); } catch (_) {}
            this._startResolve = null;
            this._startReject = null;
        }
    }

    async _startWebSocket() {
        const wsUrl = qsTranscribeStreamWsUrl();
        console.info('[transcribe-stream] connecting', wsUrl);
        this._emitStatus('connecting');
        this._ws = new WebSocket(wsUrl);
        this._ws.binaryType = 'arraybuffer';
        this._ready = false;
        this._transportArmed = false;

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
            identify_multiple_languages: this.identifyMultipleLanguages === true,
            language_options: this.languageOptions,
            preferred_language: this.preferredLanguage,
            access_token: this.accessToken,
            guest_try: this.guestTry === true,
        }));

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

    /**
     * Start mic PCM capture immediately (before auth/socket awaits).
     * Keeps early speech in a local buffer until transport is armed.
     */
    beginCapture(mediaStream) {
        if (!mediaStream) throw new Error('media_stream_required');
        this._setupAudioGraph(mediaStream);
        void this._activateAudioCapture();
    }

    async connectAndAwaitReady() {
        this._transportArmed = false;
        this._ready = false;
        this._hadLiveSession = false;
        const sock = qsGetGlobalSocket();
        if (!sock) {
            throw new Error('socket_unavailable');
        }
        try {
            await this._startSocketIo();
        } catch (err) {
            const transport = qsSocketTransportName(sock) || 'unknown';
            console.warn(
                '[transcribe-stream] Socket.IO start failed (polling-only; no WS fallback)',
                err,
                'transport=',
                transport,
                'connected=',
                !!sock.connected
            );
            try { this._teardownSocketIo(); } catch (_) {}
            this._ready = false;
            this._transportArmed = false;
            this._startResolve = null;
            this._startReject = null;
            this._finalTranscript = this._finalTranscript || '';
            const detail = String((err && err.message) || err || 'transcribe_stream_start_failed');
            throw new Error(
                /not_ready|timeout|disconnect|socket_/i.test(detail)
                    ? (detail.startsWith('socketio_') ? detail : `socketio_${detail}`)
                    : detail
            );
        }
    }

    async start(mediaStream) {
        this.beginCapture(mediaStream);
        await this.connectAndAwaitReady();
    }

    pause() {
        this._feedPaused = true;
        this._clearStarvationWatch();
        try { this._flushPollingBatch(); } catch (_) {}
        try {
            if (this._socket && this._socket.connected) {
                this._socket.emit('medical_transcribe_pause');
            }
        } catch (_) {}
        console.info('[transcribe-stream] feed paused');
    }

    isLive() {
        if (this._feedPaused) return false;
        if (!this._ready || !this._transportArmed) return false;
        if (this._audioCtx && this._audioCtx.state === 'closed') return false;
        if (this._socket) return !!this._socket.connected;
        if (this._ws) return this._ws.readyState === 1;
        return false;
    }

    resume() {
        const wasPaused = this._feedPaused;
        this._feedPaused = false;
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            void this._audioCtx.resume().catch(() => {});
        }
        if (wasPaused) {
            console.info('[transcribe-stream] feed resumed');
        }
    }

    /**
     * Tab/app return: keep this capture graph and Socket.IO sid.
     * The server parks AWS after ~15s with no PCM and starts a new AWS
     * session on the next chunk — tearing the client down waits 45s for a
     * new `ready` and is what froze live medical after a tab switch.
     */
    ensureLiveAfterForeground(hiddenMs = 0) {
        this.resume();
        this._sessionWanted = true;
        const sock = this._socket || qsGetGlobalSocket();
        if (sock) this._socket = sock;
        const hiddenLong = Number(hiddenMs) >= 8000;
        if (this.isLive() && !hiddenLong) {
            console.info(
                '[transcribe-stream] tab foreground: keeping live session',
                'hiddenMs=',
                hiddenMs,
                'transport=',
                qsSocketTransportName(sock) || 'unknown'
            );
            this._armStarvationWatch();
            return;
        }
        if (this.isLive() && hiddenLong) {
            console.info(
                '[transcribe-stream] tab foreground: hidden long; re-issuing aws start',
                'hiddenMs=',
                hiddenMs,
                'transport=',
                qsSocketTransportName(sock) || 'unknown'
            );
            this._partialsSinceReady = 0;
            this._emitStatus('resuming');
            try { this._emitStartConfig(); } catch (e) {
                console.warn('[transcribe-stream] tab foreground start failed', e);
            }
            this._armStarvationWatch();
            return;
        }
        if (!sock) {
            console.warn('[transcribe-stream] tab foreground: no socket');
            return;
        }
        if (!sock.connected) {
            console.info('[transcribe-stream] tab foreground: socket down; AWS will restart on reconnect');
            this._emitStatus('resuming');
            return;
        }
        this._armTransport();
        this._emitStatus('resuming');
        if (this._startResolve) {
            return;
        }
        if (!this._hadLiveSession || !this._ready) {
            console.info(
                '[transcribe-stream] tab foreground: re-issuing aws start on existing socket',
                'hiddenMs=',
                hiddenMs
            );
            try { this._emitStartConfig(); } catch (e) {
                console.warn('[transcribe-stream] tab foreground start failed', e);
            }
            return;
        }
        console.info(
            '[transcribe-stream] tab foreground: sending audio on existing bridge',
            'hiddenMs=',
            hiddenMs
        );
    }

    getLastRms() {
        if (this._feedPaused) return 0;
        const n = Number(this._lastRms);
        return Number.isFinite(n) ? n : 0;
    }

    _resolveStopWithLocalFallback(timeoutMs = 12000) {
        const partials = this._partials.slice();
        const localTranscript = String(this._finalTranscript || '').trim()
            || (partials.length ? String(partials[partials.length - 1] || '').trim() : '');
        return {
            transcript: localTranscript,
            partials,
            warning: 'stop_response_timeout',
        };
    }

    _localStopTranscript() {
        const partials = this._partials.slice();
        const localTranscript = String(this._finalTranscript || '').trim()
            || (partials.length ? String(partials[partials.length - 1] || '').trim() : '');
        return { transcript: localTranscript, partials };
    }

    async stop(options = {}) {
        this._feedPaused = true;
        this._sessionWanted = false;
        this._clearStarvationWatch();
        try { this._flushPollingBatch(); } catch (_) {}
        this._clearPreReadyBuffer();
        const chunksSent = this._chunksSent;
        const local = this._localStopTranscript();
        // Save UX: if we already have live text, do not wait up to 12s for Socket.IO
        // stop ack (polling often never delivers it before timeout).
        const quickLocal = options.quickLocal !== false && !!String(local.transcript || '').trim();
        const stopWaitMs = Number.isFinite(Number(options.waitMs))
            ? Math.max(0, Number(options.waitMs))
            : (quickLocal ? 0 : 12000);

        if (this._socket) {
            let result = null;
            try {
                if (this._socket.connected) {
                    this._socket.emit('medical_transcribe_stop');
                }
            } catch (_) {}
            if (quickLocal && stopWaitMs <= 0) {
                result = { ...local, warning: null };
            } else {
                const resultPromise = new Promise((resolve, reject) => {
                    this._stopResolve = resolve;
                    this._stopReject = reject;
                    setTimeout(() => {
                        if (this._stopResolve) {
                            this._stopResolve = null;
                            this._stopReject = null;
                            if (quickLocal) {
                                console.info(
                                    '[transcribe-stream] stop: using live transcript (server ack not required)'
                                );
                                resolve({ ...local, warning: null });
                            } else {
                                console.warn('[transcribe-stream] stop response timeout; using live transcript');
                                resolve(this._resolveStopWithLocalFallback());
                            }
                        }
                    }, stopWaitMs);
                });
                result = await resultPromise;
                // Prefer longer server transcript when it arrives within the short wait.
                if (
                    quickLocal
                    && result
                    && String(local.transcript || '').length > String(result.transcript || '').length
                ) {
                    result = { ...result, transcript: local.transcript, partials: local.partials };
                }
            }
            this._teardownSocketIo();
            this._clearPollingBatch();
            await this._closeAudioContext();
            console.error(
                '[transcribe-stream] stopped; chunks sent:',
                chunksSent,
                'last rms:',
                this._lastRms.toFixed(4),
                'last peak:',
                this._lastPeak.toFixed(4),
                'last gain:',
                this._lastGain.toFixed(2),
                'transcript chars:',
                String((result && result.transcript) || '').length
            );
            return result;
        }

        if (!this._ws || this._ws.readyState === WebSocket.CLOSED) {
            await this._closeAudioContext();
            return { transcript: this._finalTranscript, partials: this._partials.slice() };
        }

        const resultPromise = new Promise((resolve, reject) => {
            this._stopResolve = resolve;
            this._stopReject = reject;
            setTimeout(() => {
                if (this._stopResolve) {
                    this._stopResolve = null;
                    this._stopReject = null;
                    if (quickLocal) {
                        resolve({ ...local, warning: null });
                    } else {
                        console.warn('[transcribe-stream] stop response timeout; using live transcript');
                        resolve(this._resolveStopWithLocalFallback());
                    }
                }
            }, stopWaitMs);
        });

        try {
            if (this._ws.readyState === WebSocket.OPEN) {
                this._ws.send(JSON.stringify({ action: 'stop' }));
            }
        } catch (_) {}
        const result = await resultPromise;
        try {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.close();
        } catch (_) {}
        this._ws = null;
        await this._closeAudioContext();
        console.error(
            '[transcribe-stream] stopped; chunks sent:',
            chunksSent,
            'transcript chars:',
            String((result && result.transcript) || '').length
        );
        return result;
    }

    abort(options = {}) {
        const emitStop = options.emitStop !== false;
        this._feedPaused = true;
        this._transportArmed = false;
        this._ready = false;
        this._sessionWanted = false;
        this._clearStarvationWatch();
        this._clearPreReadyBuffer();
        this._clearPollingBatch();
        try {
            // When immediately starting a new session, skip stop — start cleans up the
            // server bridge. Emitting stop+start races on polling and can kill the new bridge.
            if (emitStop && this._socket && this._socket.connected) {
                this._socket.emit('medical_transcribe_stop');
            }
        } catch (_) {}
        this._teardownSocketIo();
        try {
            if (this._ws) this._ws.close();
        } catch (_) {}
        this._ws = null;
        void this._closeAudioContext();
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

export function qsGetMedicalTranscriptionConfigCached() {
    return _medicalStreamConfigCache;
}
