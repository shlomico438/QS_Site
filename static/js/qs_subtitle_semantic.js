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

function isValidSplitPoint(words, index) {
    if (index < 0 || index >= words.length - 1) return false;
    if (isProtectedSpan(words, Math.max(0, index - 1), index + 1)) return false;
    return isMediumBoundaryAfter(words, index);
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
export function generateSplitCandidates(text, maxCandidates = 5) {
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

    if (candidates.length < maxCandidates && splitPoints.length > 1) {
        const mid = splitPoints[Math.floor(splitPoints.length / 2)];
        add(wordsToLines(words, [mid]));
    }

    return candidates.slice(0, maxCandidates);
}

/**
 * Pick one segmentation for the timing stage (semantic only — not pixel-based).
 * @param {string[][]} candidates
 * @returns {string[]}
 */
export function pickTimingSegmentation(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const multis = candidates.filter((c) => c.length > 1);
    if (!multis.length) return candidates[0];

    let best = multis[0];
    let bestScore = -Infinity;
    for (const lines of multis) {
        let score = 0;
        for (let i = 0; i < lines.length - 1; i++) {
            if (STRONG_END_RE.test(lines[i])) score += 10;
            else if (COMMA_END_RE.test(lines[i])) score += 4;
            else if (MEDIUM_CONJUNCTIONS.has(tokenizeWords(lines[i + 1] || '')[0] || '')) score += 3;
        }
        score -= lines.length * 0.75;
        if (score > bestScore) {
            bestScore = score;
            best = lines;
        }
    }
    return best;
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
        const lineWords = tokenizeWords(line);
        if (!lineWords.length) continue;
        const startEntry = captionWords[cursor];
        if (!startEntry) break;
        let endEntry = startEntry;
        for (let li = 0; li < lineWords.length && cursor < captionWords.length; li++) {
            endEntry = captionWords[cursor];
            cursor++;
        }
        ranges.push({ wordStartIndex: startEntry.wi, wordEndIndex: endEntry.wi });
    }
    if (!ranges.length) {
        ranges.push({ wordStartIndex, wordEndIndex });
    }
    return ranges;
}
