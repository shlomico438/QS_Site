/**
 * Subtitle pipeline orchestrator — semantic → timing → (layout at render time).
 */

import {
    generateSplitCandidates,
    pickTimingSegmentation,
    mapLinesToWordRanges,
} from './qs_subtitle_semantic.js';
import { allocateLineTimes } from './qs_subtitle_timing.js';
import { buildLayoutConfig, layoutTimedCueText } from './qs_subtitle_layout.js';

export { generateSplitCandidates, pickTimingSegmentation, allocateLineTimes, buildLayoutConfig, layoutTimedCueText };

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
                semanticCandidates: candidates,
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
            out.push({
                id: `c${Date.now()}_${out.length}`,
                wordStartIndex: range.wordStartIndex,
                wordEndIndex: range.wordEndIndex,
                style: cap.style ? { ...cap.style } : undefined,
                semanticCandidates: candidates,
            });
        }
    }
    return out;
}

/**
 * Apply stage-3 layout to cues for VTT / preview (does not mutate timing).
 */
export function layoutCuesForDisplay(cues, videoEl, styleKey) {
    const config = buildLayoutConfig(videoEl, { styleKey, maxLines: 2 });
    return (cues || []).map((cue) => {
        const text = layoutTimedCueText(
            cue && cue.text,
            config,
            cue && cue.semanticCandidates
        );
        return { ...cue, text };
    });
}
