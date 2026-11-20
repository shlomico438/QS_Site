/** Always-on MediaRecorder for offline fallback, plus PCM tap for live streaming. */

function downsampleFloat32(buffer, fromRate, toRate) {
  if (!buffer || !buffer.length) return new Float32Array(0);
  if (!fromRate || !toRate || fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const len = Math.max(1, Math.round(buffer.length / ratio));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(buffer.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += buffer[j];
      count += 1;
    }
    out[i] = count ? (sum / count) : buffer[Math.min(start, buffer.length - 1)];
  }
  return out;
}

function floatTo16BitPcm(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

export class VisitAudioCapture {
  constructor({ sampleRateHz = 16000, onPcm, onLevel } = {}) {
    this.sampleRateHz = sampleRateHz;
    this.onPcm = typeof onPcm === 'function' ? onPcm : null;
    this.onLevel = typeof onLevel === 'function' ? onLevel : null;
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.startedAt = 0;
    this.deviceLabel = '';
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('media_devices_unavailable');
      err.name = 'NotAllowedError';
      throw err;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
      video: false,
    });
    const track = this.stream.getAudioTracks()[0];
    this.deviceLabel = String(track?.label || '').slice(0, 120);
    this.chunks = [];
    this.startedAt = Date.now();

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    this.mediaRecorder = mime
      ? new MediaRecorder(this.stream, { mimeType: mime })
      : new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.mediaRecorder.start(1000);

    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: this.sampleRateHz,
      });
    } catch (_) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      try { await this.audioContext.resume(); } catch (_) {}
    }
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    const mute = this.audioContext.createGain();
    mute.gain.value = 0;
    const targetRate = this.sampleRateHz || 16000;
    this.processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const fromRate = this.audioContext.sampleRate || targetRate;
      const resampled = downsampleFloat32(input, fromRate, targetRate);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < resampled.length; i += 1) {
        const a = Math.abs(resampled[i]);
        sum += resampled[i] * resampled[i];
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / Math.max(1, resampled.length));
      if (this.onLevel) this.onLevel({ rms, peak });
      if (this.onPcm) this.onPcm(floatTo16BitPcm(resampled).buffer);
    };
    this.source.connect(this.processor);
    this.processor.connect(mute);
    mute.connect(this.audioContext.destination);

    return { deviceLabel: this.deviceLabel, track };
  }

  durationSec() {
    if (!this.startedAt) return 0;
    return Math.max(0, (Date.now() - this.startedAt) / 1000);
  }

  async stop() {
    const durationSec = this.durationSec();
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        await new Promise((resolve) => {
          this.mediaRecorder.onstop = () => resolve();
          try { this.mediaRecorder.stop(); } catch (_) { resolve(); }
        });
      }
    } catch (_) {}
    try { this.processor?.disconnect(); } catch (_) {}
    try { this.source?.disconnect(); } catch (_) {}
    try { await this.audioContext?.close(); } catch (_) {}
    try {
      this.stream?.getTracks()?.forEach((t) => t.stop());
    } catch (_) {}
    const type = this.mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    this.stream = null;
    this.mediaRecorder = null;
    this.processor = null;
    this.source = null;
    this.audioContext = null;
    this.chunks = [];
    return { blob, durationSec, mimeType: type, deviceLabel: this.deviceLabel };
  }
}
