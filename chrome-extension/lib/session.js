import {
  archiveRecording,
  fetchClientConfig,
  finalizeVisit,
  processTranscript,
  recoverGaps,
  resolveApiBase,
  signMedicalUpload,
} from './api.js';
import { ensureMicPermission } from './mic-permission.js';
import { classifyMicFailure, logMicEvent, markMicRecovered, micUserMessage } from './mic.js';
import { VisitAudioCapture } from './recorder.js';
import { MedicalLiveStream } from './stream.js';

function gapPlaceholder(startMs, endMs) {
  const fmt = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  };
  return `[קטע בהשלמה ${fmt(startMs)}–${fmt(endMs)}]`;
}

export class VisitSession {
  constructor({ onStatus, onPartial, onResult, onError, onLevel } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onPartial = onPartial || (() => {});
    this.onResult = onResult || (() => {});
    this.onError = onError || (() => {});
    this.onLevel = onLevel || (() => {});
    this.capture = null;
    this.stream = null;
    this.upload = null;
    this.clientConfig = null;
    this.running = false;
    this.streamHealthy = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      const apiBase = await resolveApiBase();
      this.onStatus(`מתחבר ל־${apiBase}…`);

      this.onStatus('טוען הגדרות…');
      this.clientConfig = await fetchClientConfig();
      const sampleRateHz = this.clientConfig?.stream?.sampleRateHz || 16000;

      this.onStatus('מבקש מיקרופון…');
      try {
        await ensureMicPermission();
      } catch (err) {
        const cause = await classifyMicFailure(err, null);
        logMicEvent(cause, 'start', '');
        throw new Error(micUserMessage(cause));
      }

      this.stream = new MedicalLiveStream({
        onPartial: (text) => this.onPartial(text),
        onFinal: (text) => this.onPartial(text),
        onError: (err) => {
          this.streamHealthy = false;
          this.onStatus(`שידור חי נכשל (${err}) — ממשיכים להקליט`);
        },
        onStatus: (st) => {
          if (st === 'ready') {
            this.streamHealthy = true;
            this.onStatus('מקליט (שידור חי)');
          }
          if (st === 'disconnected' || st === 'error') {
            this.streamHealthy = false;
            this.onStatus('מקליט (מצב גיבוי)');
          }
        },
      });

      // Upload session first (needed for fallback), then arm live stream,
      // then open the mic — so PCM never marks the stream failed pre-ready.
      this.onStatus('יוצר סשן העלאה…');
      const signed = await signMedicalUpload({
        filename: `medical_ext_${Date.now()}.webm`,
        filetype: 'audio/webm',
      });
      const data = signed?.data || signed || {};
      this.upload = {
        jobId: data.jobId || data.job_id,
        s3Key: data.s3Key || data.s3_key || data.key,
        bucket: data.bucket || '',
        url: data.url,
        filetype: 'audio/webm',
      };
      if (!this.upload.jobId || !this.upload.s3Key) {
        throw new Error('יצירת סשן העלאה נכשלה (אין jobId/s3Key)');
      }

      this.onStatus('מתחבר לשידור חי…');
      try {
        await this.stream.start(this.clientConfig);
        if (this.stream.failed || !this.stream.ready) {
          throw new Error(this.stream.failed ? 'stream_rejected' : 'stream_not_ready');
        }
        this.streamHealthy = true;
        this.onStatus('מקליט (שידור חי)');
      } catch (streamErr) {
        this.streamHealthy = false;
        this.stream?.markFailed();
        this.onStatus('מקליט (מצב גיבוי — ללא שידור חי)');
        console.warn('[qs-ext] live stream unavailable', streamErr);
      }

      this.capture = new VisitAudioCapture({
        sampleRateHz,
        onPcm: (buf) => {
          if (!this.stream) return;
          this.stream.sendPcm(buf);
        },
        onLevel: (info) => this.onLevel(info),
      });

      this.onStatus(this.streamHealthy ? 'מקליט (שידור חי)' : 'מתחיל הקלטה…');
      let track;
      try {
        const started = await this.capture.start();
        track = started.track;
        markMicRecovered();
        const mime = this.capture.mediaRecorder?.mimeType || 'audio/webm';
        this.upload.filetype = mime;
      } catch (err) {
        const cause = await classifyMicFailure(err, null);
        logMicEvent(cause, 'start', '');
        throw new Error(micUserMessage(cause));
      }

      track?.addEventListener('mute', () => {
        logMicEvent('hw_mute', 'recording', this.capture.deviceLabel);
        this.onError(micUserMessage('hw_mute'));
      });
      track?.addEventListener('ended', () => {
        logMicEvent('device_lost', 'recording', this.capture.deviceLabel);
        this.onError(micUserMessage('device_lost'));
      });

      this.onStatus(this.streamHealthy ? 'מקליט (שידור חי)' : 'מקליט (מצב גיבוי)');
    } catch (err) {
      this.running = false;
      await this._cleanupSoft();
      throw err;
    }
  }

  async stop() {
    if (!this.running) return null;
    this.running = false;
    this.onStatus('עוצר ומסכם…');

    let live = { transcript: '', failed: true };
    try {
      live = await this.stream?.stop() || live;
    } catch (_) {
      live = { transcript: this.stream?.transcript || '', failed: true };
    }

    const recorded = await this.capture.stop();
    markMicRecovered();

    let transcript = String(live.transcript || '').trim();
    const usedFallback = !this.streamHealthy || live.failed || !transcript;

    if (usedFallback) {
      this.onStatus('מעלה הקלטה…');
      await archiveRecording({
        jobId: this.upload.jobId,
        s3Key: this.upload.s3Key,
        file: recorded.blob,
        filetype: recorded.mimeType,
      });
      this.onStatus('משחזר תמלול מההקלטה (יכול לקחת עד כ־3 דקות)…');
      const durationMs = Math.max(250, Math.round((recorded.durationSec || 0) * 1000));
      const placeholder = gapPlaceholder(0, durationMs);
      const seed = transcript ? `${transcript}\n${placeholder}` : placeholder;
      const recovered = await recoverGaps({
        jobId: this.upload.jobId,
        s3Key: this.upload.s3Key,
        bucket: this.upload.bucket || undefined,
        transcript: seed,
        durationMs,
        gaps: [{
          id: 'full',
          startMs: 0,
          endMs: durationMs,
          placeholder,
        }],
        locale: 'he',
      });
      transcript = String(recovered.transcript || transcript || '').trim();
    }

    if (!transcript) {
      throw new Error('לא התקבל תמלול. נסו שוב.');
    }

    this.onPartial(transcript);
    this.onStatus('מכין סיכום…');

    let result;
    try {
      result = await finalizeVisit({
        jobId: this.upload.jobId,
        s3Key: this.upload.s3Key,
        bucket: this.upload.bucket || undefined,
        transcript,
        durationSec: recorded.durationSec,
      });
    } catch (err) {
      if (err?.status === 502 || err?.payload?.transcriptionFinalized) {
        result = await processTranscript({
          jobId: this.upload.jobId,
          transcript,
        });
      } else {
        throw err;
      }
    }

    this.onResult(result);
    this.onStatus('מוכן');
    this.stream = null;
    this.capture = null;
    return result;
  }

  async _cleanupSoft() {
    try { await this.stream?.stop(); } catch (_) {}
    try { await this.capture?.stop(); } catch (_) {}
    this.stream = null;
    this.capture = null;
  }
}
