/**
 * Stage 2 — Time allocation (rhythm only; independent of font/layout).
 */

import { tokenizeWords } from './qs_subtitle_semantic.js';

const PAUSE_END_RE = /[,،:;]\s*$/;
const STRONG_PAUSE_END_RE = /[.!?؟…]["'»”)]*\s*$/;
const CONJUNCTION_START_RE = /^(אבל|כי|ואז|כאשר|ולכן|לכן|אם|כדי)\b/;

export function wordWeight(word) {
    const w = String(word || '').trim();
    return w ? Math.sqrt(w.length) : 0;
}

export function lineWeight(line) {
    return tokenizeWords(line).reduce((sum, w) => sum + wordWeight(w), 0);
}

function punctuationBiasMultiplier(line, isLast) {
    const s = String(line || '').trim();
    if (!s) return 1;
    if (STRONG_PAUSE_END_RE.test(s) && !isLast) return 1.05;
    if (PAUSE_END_RE.test(s) && !isLast) return 1.03;
    if (!isLast && CONJUNCTION_START_RE.test(s)) return 0.97;
    return 1;
}

/**
 * Allocate start/end times across lines within one Whisper segment window.
 * @param {number} startTime
 * @param {number} endTime
 * @param {string[]} lines
 * @returns {{start:number,end:number,text:string}[]}
 */
export function allocateLineTimes(startTime, endTime, lines) {
    const cleanLines = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
    if (!cleanLines.length) return [];

    const start = Number(startTime);
    let end = Number(endTime);
    if (!Number.isFinite(start)) return [];
    if (!Number.isFinite(end) || end <= start) end = start + Math.max(0.5, cleanLines.length * 0.4);

    const duration = Math.max(0.05, end - start);
    if (cleanLines.length === 1) {
        return [{ start, end, text: cleanLines[0] }];
    }

    const weights = cleanLines.map((line) => lineWeight(line));
    const bias = cleanLines.map((line, i) => punctuationBiasMultiplier(line, i === cleanLines.length - 1));
    const adjusted = weights.map((w, i) => w * bias[i]);
    const total = adjusted.reduce((a, b) => a + b, 0) || 1;
    const rawDurations = adjusted.map((w) => duration * (w / total));

    const out = [];
    let cursor = start;
    for (let i = 0; i < cleanLines.length; i++) {
        const lineStart = cursor;
        const lineEnd = i === cleanLines.length - 1 ? end : (cursor + rawDurations[i]);
        out.push({
            start: lineStart,
            end: Math.max(lineStart + 0.05, lineEnd),
            text: cleanLines[i],
        });
        cursor = lineEnd;
    }
    if (out.length) out[out.length - 1].end = end;
    return out;
}
