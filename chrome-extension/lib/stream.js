import { requireAccessToken } from './auth.js';
import { resolveApiBase, socketIoUrlFromApiBase } from './api.js';

function loadSocketIo() {
  return new Promise((resolve, reject) => {
    if (window.io) {
      resolve(window.io);
      return;
    }
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('vendor/socket.io.min.js');
    script.onload = () => {
      if (window.io) resolve(window.io);
      else reject(new Error('socket_io_missing'));
    };
    script.onerror = () => reject(new Error('socket_io_load_failed'));
    document.head.appendChild(script);
  });
}

function toUint8(payload) {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return new Uint8Array(0);
}

/**
 * Socket.IO for start/stop/events. PCM always goes through
 * POST /api/medical_transcribe_audio?sid=… so partials return on the same
 * response (Engine.IO binary from chrome-extension is unreliable).
 */
export class MedicalLiveStream {
  constructor({ onPartial, onFinal, onError, onStatus } = {}) {
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});
    this.socket = null;
    this.ready = false;
    this.failed = false;
    this.started = false;
    this.transcript = '';
    this.config = null;
    this._apiBase = '';
    this._httpBusy = false;
    this._httpQueue = [];
    this._chunksSent = 0;
    this._acksWithText = 0;
  }

  async start(clientConfig) {
    this.config = clientConfig || {};
    this.failed = false;
    this.ready = false;
    this.started = false;
    this.transcript = '';
    this._chunksSent = 0;
    this._acksWithText = 0;
    this._httpQueue = [];
    this._apiBase = socketIoUrlFromApiBase(await resolveApiBase());

    const io = await loadSocketIo();
    const token = await requireAccessToken();
    this.socket = io(this._apiBase, {
      // Polling is fine — audio is HTTP anyway.
      transports: ['polling', 'websocket'],
      withCredentials: false,
      reconnection: true,
      reconnectionAttempts: 4,
      upgrade: true,
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket_connect_timeout')), 20000);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err || new Error('socket_connect_error'));
      });
    });

    this.socket.on('medical_transcribe_event', (payload) => this._onEvent(payload));
    this.socket.on('disconnect', () => {
      if (!this.failed) {
        this.failed = true;
        this.onStatus('disconnected');
      }
    });

    const streamCfg = this.config.stream || {};
    this.socket.emit('medical_transcribe_start', {
      action: 'start',
      client: 'extension',
      extension_id: chrome.runtime.id,
      access_token: token,
      sample_rate_hz: streamCfg.sampleRateHz || 16000,
      language_code: 'he-IL',
      identify_multiple_languages: true,
      language_options: ['he-IL', 'en-US'],
      preferred_language: 'he-IL',
    });
    this.started = true;
    this.onStatus('starting');

    await new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        if (this.ready || this.failed) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > 15000) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });

    if (this.failed) throw new Error('stream_rejected');
    if (!this.ready) throw new Error('stream_not_ready');
    if (!this.socket?.id) throw new Error('socket_sid_missing');
  }

  _onEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const type = String(payload.type || '');
    if (type === 'connected' || type === 'starting') {
      this.onStatus(type);
      return;
    }
    if (type === 'ready') {
      this.ready = true;
      this.onStatus('ready');
      return;
    }
    if (type === 'partial') {
      const text = String(payload.text || payload.transcript || '').trim();
      if (text) {
        this.transcript = text;
        this._acksWithText += 1;
        this.onPartial(text);
      }
      return;
    }
    if (type === 'transcript' || type === 'final') {
      const text = String(payload.transcript || payload.text || '').trim();
      if (text) {
        this.transcript = text;
        this.onFinal(text, payload);
      }
      return;
    }
    if (type === 'error') {
      this.failed = true;
      this.onError(String(payload.error || 'stream_error'));
      this.onStatus('error');
    }
  }

  sendPcm(arrayBuffer) {
    // Not armed yet — ignore without failing (capture may start first).
    if (!this.started || !this.ready || this.failed) return true;
    if (!this.socket?.connected || !this.socket?.id) return true;

    const view = toUint8(arrayBuffer);
    if (!view.byteLength) return true;
    this._httpQueue.push(view.slice());
    this._pumpHttp();
    return true;
  }

  _pumpHttp() {
    if (this._httpBusy || !this._httpQueue.length) return;
    const parts = this._httpQueue;
    this._httpQueue = [];
    let total = 0;
    for (const part of parts) total += part.byteLength;
    if (!total) return;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    this._httpBusy = true;
    void this._postAudioHttp(merged).finally(() => {
      this._httpBusy = false;
      this._pumpHttp();
    });
  }

  async _postAudioHttp(view) {
    const sid = this.socket && this.socket.id;
    if (!sid || this.failed) return;
    this._chunksSent += 1;
    try {
      const res = await fetch(
        `${this._apiBase}/api/medical_transcribe_audio?sid=${encodeURIComponent(sid)}`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: view,
        },
      );
      if (res.status === 409) {
        // Bridge gone — mark failed so session can fall back.
        this.failed = true;
        this.onStatus('error');
        return;
      }
      if (!res.ok) {
        if (this._chunksSent <= 3 || this._chunksSent % 25 === 0) {
          console.warn('[qs-ext] audio POST status', res.status);
        }
        return;
      }
      const ack = await res.json().catch(() => null);
      if (ack && ack.type) this._onEvent(ack);
      else if (ack && ack.ok === false && ack.error) {
        console.warn('[qs-ext] audio POST error', ack.error);
      }
    } catch (err) {
      console.warn('[qs-ext] audio POST failed', err);
    }
  }

  async stop() {
    // Drain queued PCM first.
    while (this._httpQueue.length || this._httpBusy) {
      this._pumpHttp();
      await new Promise((r) => setTimeout(r, 40));
      if (!this._httpQueue.length && !this._httpBusy) break;
    }

    if (!this.socket) {
      return { transcript: this.transcript, failed: this.failed || !this.ready };
    }
    const sock = this.socket;
    const finalPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      const handler = (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const type = String(payload.type || '');
        if (type === 'transcript' || type === 'final' || type === 'error') {
          clearTimeout(timer);
          sock.off('medical_transcribe_event', handler);
          resolve(payload);
        }
      };
      sock.on('medical_transcribe_event', handler);
    });
    try { sock.emit('medical_transcribe_stop'); } catch (_) {}
    const finalPayload = await finalPromise;
    if (finalPayload) this._onEvent(finalPayload);
    try { sock.disconnect(); } catch (_) {}
    this.socket = null;
    console.info('[qs-ext] stream stop', {
      chunksSent: this._chunksSent,
      acksWithText: this._acksWithText,
      transcriptLen: this.transcript.length,
    });
    return {
      transcript: this.transcript,
      failed: this.failed || !this.ready || this._chunksSent === 0,
      payload: finalPayload,
    };
  }

  markFailed() {
    this.failed = true;
  }

  get isHealthy() {
    return !!(this.socket && this.socket.connected && this.ready && !this.failed);
  }
}
