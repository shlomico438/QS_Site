/**
 * Subtitle pipeline orchestrator — semantic → timing → (layout at render time).
 */

import {
    generateSplitCandidates,
    pickTimingSegmentation,
    mapLinesToWordRanges,
} from './qs_subtitle_semantic.js';
import { allocateLineTimes } from './qs_subtitle_timing.js';
import { buildLayoutConfig, layoutTimedCueText, layoutCuePages } from './qs_subtitle_layout.js';

export { generateSplitCandidates, pickTimingSegmentation, allocateLineTimes, buildLayoutConfig, layoutTimedCueText, layoutCuePages };

function captionTextFromWords(words, cap) {
    return words
        .slice(cap.wordStartIndex, cap.wordEndIndex + 1)
        .map((w) => String((w && w.text) || '').trim())
        .filter(Boolean)
        .join(' ');
}

/**
 * Stage 1+2 for segment-only transcripts (no word timestamps).
 * @param {object[]} segments Whisper segments {start,end,text,speaker?}
 */
export function processWhisperSegments(segments) {
    const result = [];
    for (const seg of segments || []) {
        const text = String((seg && seg.text) || '').trim();
        if (!text) {
            if (seg) result.push(seg);
            continue;
        }
        const start = Number(seg.start);
        let end = Number(seg.end);
        if (!Number.isFinite(start)) continue;
        if (!Number.isFinite(end) || end <= start) end = start + 5;

        const candidates = generateSplitCandidates(text);
        const lines = pickTimingSegmentation(candidates);
        const timed = allocateLineTimes(start, end, lines.length ? lines : [text]);
        for (const row of timed) {
            result.push({
                start: row.start,
                end: row.end,
                text: row.text,
                speaker: seg.speaker,
                semanticCandidates: generateSplitCandidates(row.text),
            });
        }
    }
    return result;
}

/**
 * Stage 1 for word-timestamp transcripts: split captions at linguistic boundaries only.
 * Timing remains derived from word start/end via _captionsToCues.
 */
export function reflowCaptionsSemantic(words, captions) {
    if (!Array.isArray(words) || !Array.isArray(captions) || !captions.length) return captions;
    const out = [];
    for (const cap of captions) {
        const text = captionTextFromWords(words, cap);
        const candidates = generateSplitCandidates(text);
        const lines = pickTimingSegmentation(candidates);
        if (lines.length <= 1) {
            out.push({
                ...cap,
                semanticCandidates: candidates,
            });
            continue;
        }
        const ranges = mapLinesToWordRanges(words, cap.wordStartIndex, cap.wordEndIndex, lines);
        for (const range of ranges) {
            const subText = captionTextFromWords(words, range);
            out.push({
                id: `c${Date.now()}_${out.length}`,
                wordStartIndex: range.wordStartIndex,
                wordEndIndex: range.wordEndIndex,
                style: cap.style ? { ...cap.style } : undefined,
                semanticCandidates: generateSplitCandidates(subText),
            });
        }
    }
    return out;
}

/**
 * Apply stage-3 layout to cues for VTT / preview.
 * TikTok: max 2 lines per screen; longer phrases become sequential timed cues.
 */
export function layoutCuesForDisplay(cues, videoEl, styleKey) {
    const style = String(styleKey || 'tiktok').toLowerCase();
    const maxLines = style === 'tiktok' ? 2 : 3;
    const config = buildLayoutConfig(videoEl, { styleKey: style, maxLines });
    const out = [];
    const list = cues || [];

    for (let i = 0; i < list.length; i++) {
        const cue = list[i];
        const pages = layoutCuePages(cue && cue.text, config, cue && cue.semanticCandidates);

        if (pages.length <= 1) {
            out.push({ ...cue, text: pages[0] || String((cue && cue.text) || '') });
            continue;
        }

        const start = Number(cue && cue.start);
        let end = cue && cue.end != null ? Number(cue.end) : NaN;
        if (!Number.isFinite(start)) {
            out.push({ ...cue, text: pages[0] || '' });
            continue;
        }
        if (!Number.isFinite(end) || end <= start) {
            const next = list[i + 1];
            const nextS = next && Number(next.start);
            end = Number.isFinite(nextS) && nextS > start ? nextS : (start + Math.max(0.5, pages.length * 0.4));
        }

        const timed = allocateLineTimes(start, end, pages, { useRhythmBias: false });
        for (const row of timed) {
            out.push({ ...cue, start: row.start, end: row.end, text: row.text });
        }
    }
    return out;
}
