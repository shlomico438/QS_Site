/* global AudioWorkletProcessor, registerProcessor */
/**
 * Mic capture on the audio thread. Replaces ScriptProcessorNode.
 * Posts mono Float32 blocks of 4096 frames (same size as the old processor).
 */
class QsPcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._blockSize = 4096;
        this._pending = new Float32Array(this._blockSize);
        this._filled = 0;
    }

    _push(mono) {
        let offset = 0;
        while (offset < mono.length) {
            const space = this._blockSize - this._filled;
            const n = Math.min(space, mono.length - offset);
            this._pending.set(mono.subarray(offset, offset + n), this._filled);
            this._filled += n;
            offset += n;
            if (this._filled < this._blockSize) continue;
            const samples = this._pending;
            this._pending = new Float32Array(this._blockSize);
            this._filled = 0;
            this.port.postMessage({ samples }, [samples.buffer]);
        }
    }

    process(inputs) {
        const channels = inputs && inputs[0];
        if (!channels || !channels.length || !channels[0] || !channels[0].length) return true;
        const ch0 = channels[0];
        const ch1 = channels.length > 1 ? channels[1] : null;
        if (!ch1 || ch1.length !== ch0.length) {
            this._push(ch0);
            return true;
        }
        const mixed = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) mixed[i] = 0.5 * (ch0[i] + ch1[i]);
        this._push(mixed);
        return true;
    }
}

registerProcessor('qs-pcm-capture', QsPcmCaptureProcessor);
