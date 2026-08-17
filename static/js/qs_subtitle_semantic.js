/**
 * Stage 1 — Semantic segmentation (meaning only; no timing or pixel layout).
 */

const STRONG_END_RE = /[.!?؟…]["'»”)]*\s*$/;
const COMMA_END_RE = /[,،:;]\s*$/;
const MEDIUM_CONJUNCTIONS = new Set([
    'אבל', 'כי', 'ואז', 'כאשר', 'ולכן', 'לכן', 'אם', 'כדי', 'ש', 'וגם', 'או', 'אז',
]);
const PROTECTED_PHRASES = [
    'בינה מלאכותית',
    'בית ספר',
    'עורך דין',
    'ראש הממשלה',
    'יום העצמאות',
];

export function tokenizeWords(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function isProtectedSpan(words, start, end) {
    const slice = words.slice(start, end + 1).join(' ');
    return PROTECTED_PHRASES.some((phrase) => {
        const parts = phrase.split(' ');
        if (parts.length < 2) return false;
        return slice.includes(phrase);
    });
}

function isStrongBoundaryAfter(words, index) {
    if (index < 0 || index >= words.length - 1) return false;
    const left = words.slice(0, index + 1).join(' ');
    return STRONG_END_RE.test(left);
}

function isMediumBoundaryAfter(words, index) {
    if (index < 0 || index >= words.length - 1) return false;
    if (isStrongBoundaryAfter(words, index)) return true;
    const w = words[index + 1];
    if (w && MEDIUM_CONJUNCTIONS.has(w.replace(/[^\u0590-\u05FFa-zA-Z]/g, ''))) return true;
    const left = words.slice(0, index + 1).join(' ');
    return COMMA_END_RE.test(left);
}

const HEBREW_LETTER = /[\u0590-\u05FF]/;

function bareWord(word) {
    return String(word || '').replace(/^[^\u0590-\u05FFa-zA-Z0-9]+|[^\u0590-\u05FFa-zA-Z0-9]+$/g, '');
}

function isPhraseBoundaryAfter(words, index) {
    if (index < 0 || index >= words.length - 1) return false;
    if (isMediumBoundaryAfter(words, index)) return true;
    const next = bareWord(words[index + 1]);
    const prev = bareWord(words[index]);
    if (!next) return false;
    // New instruction clause: להשתחרר, … (not לעומס after a verb)
    if (next.startsWith('ל') && next.length >= 4 && HEBREW_LETTER.test(next[1])) {
        if (/(גוף|נחה|רגע|זמן|מקום|שלב)$/.test(prev)) return true;
        if (STRONG_END_RE.test(words.slice(0, index + 1).join(' '))) return true;
        return false;
    }
    // New subordinate clause: שמשחררת, שמאפשר, …
    if (next.startsWith('ש') && next.length >= 4 && HEBREW_LETTER.test(next[1])) {
        if (COMMA_END_RE.test(words.slice(0, index + 1).join(' '))) return true;
        if (/נחה$/.test(prev)) return true;
    }
    return false;
}

function isValidSplitPoint(words, index) {
    if (index < 0 || index >= words.length - 1) return false;
    if (isProtectedSpan(words, Math.max(0, index - 1), index + 1)) return false;
    return isPhraseBoundaryAfter(words, index);
}

function wordsToLines(words, splitIndices) {
    if (!words.length) return [];
    const sorted = [...splitIndices].sort((a, b) => a - b);
    const lines = [];
    let start = 0;
    for (const idx of sorted) {
        const line = words.slice(start, idx + 1).join(' ').trim();
        if (line) lines.push(line);
        start = idx + 1;
    }
    const tail = words.slice(start).join(' ').trim();
    if (tail) lines.push(tail);
    return lines.length ? lines : [words.join(' ')];
}

/**
 * Generate up to maxCandidates linguistic line splits for a text span.
 * @returns {string[][]}
 */
export function generateSplitCandidates(text, maxCandidates = 8) {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    const words = tokenizeWords(normalized);
    if (words.length <= 1) return [[normalized]];

    const seen = new Set();
    const candidates = [];
    const add = (lines) => {
        const clean = lines.map((l) => normalizeText(l)).filter(Boolean);
        if (!clean.length) return;
        const key = clean.join('\n');
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(clean);
    };

    add([normalized]);

    const splitPoints = [];
    for (let i = 0; i < words.length - 1; i++) {
        if (isValidSplitPoint(words, i)) splitPoints.push(i);
    }

    const strongPoints = splitPoints.filter((i) => isStrongBoundaryAfter(words, i));
    const mediumPoints = splitPoints.filter((i) => !isStrongBoundaryAfter(words, i));

    for (const idx of strongPoints) add(wordsToLines(words, [idx]));
    for (let a = 0; a < strongPoints.length; a++) {
        for (let b = a + 1; b < strongPoints.length; b++) {
            add(wordsToLines(words, [strongPoints[a], strongPoints[b]]));
        }
    }
    for (const idx of mediumPoints) add(wordsToLines(words, [idx]));
    for (let a = 0; a < splitPoints.length; a++) {
        for (let b = a + 1; b < splitPoints.length; b++) {
            add(wordsToLines(words, [splitPoints[a], splitPoints[b]]));
        }
    }

    const phrasePoints = [];
    for (let i = 0; i < words.length - 1; i++) {
        if (phrasePoints.includes(i)) continue;
        if (isPhraseBoundaryAfter(words, i) && !splitPoints.includes(i)) phrasePoints.push(i);
    }
    for (const idx of phrasePoints) add(wordsToLines(words, [idx]));
    for (let a = 0; a < phrasePoints.length; a++) {
        for (let b = a + 1; b < phrasePoints.length; b++) {
            add(wordsToLines(words, [phrasePoints[a], phrasePoints[b]]));
        }
    }
    if (phrasePoints.length && strongPoints.length) {
        for (const p of phrasePoints) {
            for (const s of strongPoints) {
                if (p !== s) add(wordsToLines(words, [Math.min(p, s), Math.max(p, s)]));
            }
        }
    }

    if (candidates.length < maxCandidates && splitPoints.length > 1) {
        const mid = splitPoints[Math.floor(splitPoints.length / 2)];
        add(wordsToLines(words, [mid]));
    }

    return candidates.slice(0, maxCandidates);
}

const TARGET_MAX_CHARS = 54;
const TARGET_MAX_WORDS = 12;
const TARGET_MIN_CHARS = 12;

function wordRangesFromSplits(words, splitIndices) {
    const sorted = [...splitIndices].filter((i) => i >= 0 && i < words.length - 1).sort((a, b) => a - b);
    const ranges = [];
    let start = 0;
    for (const idx of sorted) {
        if (idx < start) continue;
        ranges.push([start, idx]);
        start = idx + 1;
    }
    if (start <= words.length - 1) ranges.push([start, words.length - 1]);
    return ranges;
}

function spanTooLong(words, from, to) {
    const n = to - from + 1;
    if (n > TARGET_MAX_WORDS) return true;
    return words.slice(from, to + 1).join(' ').length > TARGET_MAX_CHARS;
}

function spanCharLen(words, from, to) {
    return words.slice(from, to + 1).join(' ').length;
}

/**
 * Split a Whisper/ASR span into subtitle-sized lines.
 * Always cut on sentence endings; then commas/conjunctions; then ~54-char wrap.
 */
export function segmentTextIntoSubtitleLines(text) {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    const words = tokenizeWords(normalized);
    if (!words.length) return [];
    if (words.length === 1 || (normalized.length <= TARGET_MAX_CHARS && words.length <= TARGET_MAX_WORDS)) {
        return [normalized];
    }

    const splits = new Set();
    for (let i = 0; i < words.length - 1; i++) {
        if (isProtectedSpan(words, Math.max(0, i - 1), Math.min(words.length - 1, i + 1))) continue;
        if (isStrongBoundaryAfter(words, i)) splits.add(i);
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const [from, to] of wordRangesFromSplits(words, splits)) {
            if (!spanTooLong(words, from, to)) continue;
            let added = false;
            for (let i = from; i < to; i++) {
                if (splits.has(i)) continue;
                if (isProtectedSpan(words, Math.max(from, i - 1), Math.min(to, i + 1))) continue;
                if (!isMediumBoundaryAfter(words, i) && !isPhraseBoundaryAfter(words, i)) continue;
                const leftLen = spanCharLen(words, from, i);
                const rightLen = spanCharLen(words, i + 1, to);
                if (leftLen < TARGET_MIN_CHARS || rightLen < TARGET_MIN_CHARS) continue;
                splits.add(i);
                added = true;
                break;
            }
            if (added) changed = true;
        }
    }

    for (const [from, to] of wordRangesFromSplits(words, splits)) {
        if (!spanTooLong(words, from, to)) continue;
        let acc = '';
        for (let i = from; i <= to; i++) {
            const next = acc ? `${acc} ${words[i]}` : words[i];
            if (acc && next.length > TARGET_MAX_CHARS && i - 1 >= from && i - 1 < to) {
                splits.add(i - 1);
                acc = words[i];
            } else {
                acc = next;
            }
        }
    }

    return wordsToLines(words, [...splits]);
}

/**
 * Pick one segmentation for the timing stage (semantic only — not pixel-based).
 * @param {string[][]} candidates
 * @returns {string[]}
 */
export function pickTimingSegmentation(candidates) {
    const joined = Array.isArray(candidates) && candidates[0]
        ? candidates[0].join(' ')
        : '';
    const fromText = segmentTextIntoSubtitleLines(joined);
    if (fromText.length) return fromText;
    if (!Array.isArray(candidates) || !candidates.length) return [];
    return candidates[0];
}

function normalizeMatchText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripTokenPunctuation(s) {
    return String(s || '').replace(/^[^\u0590-\u05FF\w]+|[^\u0590-\u05FF\w]+$/g, '');
}

function tokensRoughlyEqual(a, b) {
    const x = stripTokenPunctuation(a);
    const y = stripTokenPunctuation(b);
    if (!x || !y) return x === y;
    return x === y;
}

function joinCaptionWordEntries(entries, from, to) {
    return normalizeMatchText(
        entries.slice(from, to + 1).map((e) => e.text).join(' ')
    );
}

/**
 * Map semantic lines back to inclusive word-index ranges inside a caption.
 * @returns {{wordStartIndex:number, wordEndIndex:number}[]}
 */
export function mapLinesToWordRanges(words, wordStartIndex, wordEndIndex, lines) {
    const captionWords = [];
    for (let wi = wordStartIndex; wi <= wordEndIndex; wi++) {
        const t = String((words[wi] && words[wi].text) || '').trim();
        if (t) captionWords.push({ wi, text: t });
    }
    if (!captionWords.length) return [];

    const ranges = [];
    let cursor = 0;
    for (const line of lines) {
        const want = normalizeMatchText(line);
        if (!want) continue;
        const lineWords = tokenizeWords(want);
        if (!lineWords.length) continue;
        if (cursor >= captionWords.length) break;

        const startEntry = captionWords[cursor];
        let endEntry = startEntry;
        let li = 0;
        let endCursor = cursor;

        while (li < lineWords.length && endCursor < captionWords.length) {
            if (!tokensRoughlyEqual(lineWords[li], captionWords[endCursor].text)) break;
            endEntry = captionWords[endCursor];
            li++;
            endCursor++;
        }

        const joined = joinCaptionWordEntries(captionWords, cursor, endCursor - 1);
        if (li < lineWords.length || joined !== want) {
            // Fallback: advance by token count when punctuation differs slightly.
            let fallbackEnd = cursor;
            for (let n = 0; n < lineWords.length && fallbackEnd < captionWords.length; n++) {
                endEntry = captionWords[fallbackEnd];
                fallbackEnd++;
            }
            const fallbackJoined = joinCaptionWordEntries(captionWords, cursor, fallbackEnd - 1);
            if (fallbackJoined !== want) break;
            endCursor = fallbackEnd;
        }

        ranges.push({ wordStartIndex: startEntry.wi, wordEndIndex: endEntry.wi });
        cursor = endCursor;
    }

    if (!ranges.length) {
        ranges.push({ wordStartIndex, wordEndIndex });
        return ranges;
    }

    // Ensure ranges are contiguous, non-overlapping, and cover no duplicate words.
    const deduped = [];
    let nextWi = wordStartIndex;
    for (const range of ranges) {
        const start = Math.max(nextWi, range.wordStartIndex);
        const end = Math.max(start, range.wordEndIndex);
        if (end < start) continue;
        deduped.push({ wordStartIndex: start, wordEndIndex: end });
        nextWi = end + 1;
    }
    if (deduped.length && deduped[deduped.length - 1].wordEndIndex < wordEndIndex) {
        const tailStart = deduped[deduped.length - 1].wordEndIndex + 1;
        if (tailStart <= wordEndIndex) {
            deduped.push({ wordStartIndex: tailStart, wordEndIndex });
        }
    }
    return deduped.length ? deduped : [{ wordStartIndex, wordEndIndex }];
}
