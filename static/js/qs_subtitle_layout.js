/**
 * Stage 3 — Pixel-based layout (rendering only; never changes segmentation or timing).
 */

import { tokenizeWords, pickTimingSegmentation } from './qs_subtitle_semantic.js';

let _measureCtx = null;

const CUE_STYLE_METRICS = {
    tiktok: {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        fontWeight: '700',
        emDesktop: 2.5,
        emMobile: 1.15,
        widthScale: 1.1,
        shadowPaddingPx: 14,
        letterSpacingPx: 0,
    },
    clean: {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        fontWeight: '500',
        emDesktop: 1.4,
        emMobile: 1.05,
        widthScale: 1.02,
        shadowPaddingPx: 6,
        letterSpacingPx: 0,
    },
    cinematic: {
        fontFamily: '"Times New Roman", Times, serif',
        fontWeight: '400',
        emDesktop: 1.6,
        emMobile: 1.1,
        widthScale: 1.06,
        shadowPaddingPx: 6,
        letterSpacingPx: 1.6,
    },
};

function getMeasureCtx() {
    if (typeof document === 'undefined') return null;
    if (!_measureCtx) {
        const canvas = document.createElement('canvas');
        _measureCtx = canvas.getContext('2d');
    }
    return _measureCtx;
}

function styleMetrics(styleKey) {
    const key = String(styleKey || 'tiktok').toLowerCase();
    return CUE_STYLE_METRICS[key] || CUE_STYLE_METRICS.tiktok;
}

export function estimateCueFontPx(videoEl, styleKey) {
    const m = styleMetrics(styleKey);
    const vw = typeof window !== 'undefined' ? (window.innerWidth || document.documentElement.clientWidth || 0) : 0;
    const isMobileViewport = vw > 0 && vw <= 768;
    const em = isMobileViewport ? m.emMobile : m.emDesktop;
    const h = Number(videoEl && videoEl.clientHeight) || Number(videoEl && videoEl.videoHeight) || 0;
    // WebVTT ::cue `em` is relative to ~5% of the rendered video height (Chromium/WebKit).
    const cueBasePx = h > 0 ? h * 0.05 : 16;
    return em * cueBasePx;
}

/**
 * @param {HTMLVideoElement|HTMLAudioElement|null} videoEl
 * @param {{styleKey?:string,maxLines?:number,direction?:string}} options
 */
export function buildLayoutConfig(videoEl, options = {}) {
    const styleKey = String(options.styleKey || 'tiktok').toLowerCase();
    const m = styleMetrics(styleKey);
    const widthPx = Number(videoEl && videoEl.clientWidth) || Number(videoEl && videoEl.videoWidth) || 0;
    const heightPx = Number(videoEl && videoEl.clientHeight) || Number(videoEl && videoEl.videoHeight) || 0;
    const isPortrait = widthPx > 0 && heightPx > 0 ? (heightPx > widthPx) : false;
    const fontSize = estimateCueFontPx(videoEl, styleKey);
    const horizontalPadding = isPortrait ? 24 : 40;
    const maxWidthPx = Math.max(
        100,
        widthPx - (horizontalPadding * 2) - (Number(m.shadowPaddingPx) || 0)
    );
    const locale = String(
        (typeof window !== 'undefined' && window.currentLocale)
        || (typeof localStorage !== 'undefined' && localStorage.getItem('locale'))
        || 'he'
    ).toLowerCase();
    const direction = options.direction || ((locale.startsWith('he') || locale.startsWith('ar')) ? 'rtl' : 'ltr');
    return {
        fontSize,
        fontFamily: m.fontFamily,
        fontWeight: m.fontWeight,
        widthScale: m.widthScale,
        letterSpacingPx: m.letterSpacingPx,
        maxWidthPx,
        maxLines: Number(options.maxLines) > 0 ? Number(options.maxLines) : 3,
        direction,
        styleKey,
    };
}

export function measureLineWidth(text, config) {
    const ctx = getMeasureCtx();
    const raw = String(text || '');
    if (!raw) return 0;
    if (!ctx || !config) return raw.length * (config.fontSize * 0.56) * (config.widthScale || 1);

    ctx.direction = config.direction === 'rtl' ? 'rtl' : 'ltr';
    const weight = config.fontWeight || '400';
    const size = Number(config.fontSize) || 16;
    const family = config.fontFamily || 'sans-serif';
    ctx.font = `${weight} ${size}px ${family}`;

    let width = ctx.measureText(raw).width;
    const words = tokenizeWords(raw);
    if (config.letterSpacingPx && words.length > 1) {
        width += config.letterSpacingPx * (words.length - 1);
    }
    width *= Number(config.widthScale) || 1;
    return width;
}

function normalizeCueText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function textFullyRepresented(lines, raw) {
    const want = normalizeCueText(raw);
    if (!want) return true;
    const got = normalizeCueText((lines || []).join(' '));
    return got === want;
}

function lineFits(line, config) {
    return measureLineWidth(line, config) <= config.maxWidthPx;
}

/** Visual layout may only use splits of this cue's text — never a parent segment's lines. */
function candidateMatchesCueText(lines, cueText) {
    const cue = normalizeCueText(cueText);
    if (!cue || !Array.isArray(lines) || !lines.length) return false;
    return normalizeCueText(lines.join(' ')) === cue;
}

/**
 * Split one overflowing line into two at the best word boundary.
 */
function splitLineAtWidth(line, config) {
    const words = tokenizeWords(line);
    if (words.length <= 1) return [line];

    let best = null;
    let bestCost = Infinity;
    for (let i = 1; i < words.length; i++) {
        const l1 = words.slice(0, i).join(' ');
        const l2 = words.slice(i).join(' ');
        const w1 = measureLineWidth(l1, config);
        const w2 = measureLineWidth(l2, config);
        const overflow = Math.max(0, w1 - config.maxWidthPx) + Math.max(0, w2 - config.maxWidthPx);
        const cost = overflow + Math.abs(w1 - w2) * 0.03;
        if (cost < bestCost) {
            bestCost = cost;
            best = [l1, l2];
        }
    }
    return best || [line];
}

/**
 * Keep splitting overflowing rows until every row fits (no silent truncation).
 */
function ensureLinesFitWidth(lines, config) {
    let rows = (lines || []).map((l) => normalizeCueText(l)).filter(Boolean);
    if (!rows.length) return rows;

    let guard = 0;
    while (guard < 48) {
        guard++;
        const overflowIdx = rows.findIndex((line) => !lineFits(line, config));
        if (overflowIdx < 0) break;

        const split = splitLineAtWidth(rows[overflowIdx], config);
        if (split.length === 1 && split[0] === rows[overflowIdx]) break;
        rows.splice(overflowIdx, 1, ...split);
    }
    return rows;
}

/**
 * Fill lines 1..N-1 to max width; put every remaining word on the last line (no omission).
 */
function pixelWrapGreedy(text, config, lineCount) {
    const words = tokenizeWords(text);
    if (!words.length) return [];
    const n = Math.max(1, Number(lineCount) || 1);
    if (n === 1) return [words.join(' ')];

    const lines = [];
    let i = 0;
    for (let L = 0; L < n - 1; L++) {
        let line = '';
        while (i < words.length) {
            const candidate = line ? `${line} ${words[i]}` : words[i];
            if (!line || lineFits(candidate, config)) {
                line = candidate;
                i++;
            } else {
                break;
            }
        }
        if (!line && i < words.length) {
            line = words[i];
            i++;
        }
        if (line) lines.push(line);
    }
    if (i < words.length) {
        lines.push(words.slice(i).join(' '));
    }
    return lines.length ? lines : [words.join(' ')];
}

function pickMatchingSemanticLines(raw, semanticCandidates) {
    const matching = [];
    if (Array.isArray(semanticCandidates)) {
        for (const c of semanticCandidates) {
            if (Array.isArray(c) && c.length > 0 && candidateMatchesCueText(c, raw)) {
                matching.push(c.map((l) => normalizeCueText(l)).filter(Boolean));
            }
        }
    }
    if (!matching.length) return null;
    // Prefer more phrases (3 over 2) for TikTok pagination — timing stage uses the opposite bias.
    for (const n of [3, 2, 1]) {
        const pool = matching.filter((c) => c.length === n);
        if (pool.length) {
            return pool.length > 1 ? pickTimingSegmentation(pool) : pool[0];
        }
    }
    return matching[0];
}

function pagesRepresentFullText(pages, raw) {
    const lines = [];
    for (const page of pages || []) {
        for (const line of String(page || '').split('\n')) {
            const t = normalizeCueText(line);
            if (t) lines.push(t);
        }
    }
    return textFullyRepresented(lines, raw);
}

/**
 * Pack semantic units into display pages of at most maxLines rows each.
 * Each semantic phrase starts on a new page — never mix phrases on one screen.
 */
function paginateBySemanticUnits(semanticLines, config) {
    const maxPerPage = Math.max(1, Number(config.maxLines) || 2);
    const pages = [];

    for (const semLine of semanticLines) {
        const wrapped = ensureLinesFitWidth([normalizeCueText(semLine)], config);
        if (!wrapped.length) continue;

        for (let i = 0; i < wrapped.length; i += maxPerPage) {
            pages.push(wrapped.slice(i, i + maxPerPage).join('\n'));
        }
    }
    return pages;
}

function paginateVisualLines(visualLines, config) {
    const maxPerPage = Math.max(1, Number(config.maxLines) || 2);
    const lines = (visualLines || []).map((l) => normalizeCueText(l)).filter(Boolean);
    if (!lines.length) return [''];
    if (lines.length <= maxPerPage) return [lines.join('\n')];

    const pages = [];
    for (let i = 0; i < lines.length; i += maxPerPage) {
        pages.push(lines.slice(i, i + maxPerPage).join('\n'));
    }
    return pages;
}

/**
 * Lay out one cue into 1+ display pages (each page has at most config.maxLines rows).
 * @returns {string[]}
 */
export function layoutCuePages(text, config, semanticCandidates = null) {
    const raw = normalizeCueText(text);
    if (!raw || !config) return [''];

    const semanticLines = pickMatchingSemanticLines(raw, semanticCandidates);
    if (semanticLines && semanticLines.length > 0) {
        const pages = paginateBySemanticUnits(semanticLines, config);
        if (pages.length && pagesRepresentFullText(pages, raw)) return pages;
    }

    const visualLines = ensureLinesFitWidth(
        pixelWrapGreedy(raw, config, Math.max(8, Number(config.maxLines) || 2)),
        config
    );
    return paginateVisualLines(visualLines, config);
}

/**
 * Choose visual line breaks for one timed cue (single page; legacy helper).
 */
export function layoutTimedCueText(text, config, semanticCandidates = null) {
    const pages = layoutCuePages(text, config, semanticCandidates);
    return pages[0] || normalizeCueText(text);
}
