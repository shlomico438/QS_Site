/**
 * Stage 3 — Pixel-based layout (rendering only; never changes segmentation or timing).
 */

import { tokenizeWords } from './qs_subtitle_semantic.js';

let _measureCtx = null;

function getMeasureCtx() {
    if (typeof document === 'undefined') return null;
    if (!_measureCtx) {
        const canvas = document.createElement('canvas');
        _measureCtx = canvas.getContext('2d');
    }
    return _measureCtx;
}

export function estimateCueFontPx(videoEl, styleKey) {
    const vw = typeof window !== 'undefined' ? (window.innerWidth || document.documentElement.clientWidth || 0) : 0;
    const isMobileViewport = vw > 0 && vw <= 768;
    const emByStyleDesktop = { tiktok: 2.5, clean: 1.4, cinematic: 1.6 };
    const emByStyleMobile = { tiktok: 1.15, clean: 1.05, cinematic: 1.1 };
    const em = (isMobileViewport ? emByStyleMobile : emByStyleDesktop)[styleKey] || 1.15;
    const basePx = 16;
    const h = Number(videoEl && videoEl.clientHeight) || Number(videoEl && videoEl.videoHeight) || 0;
    const heightScale = h > 0 ? Math.max(0.72, Math.min(1.35, h / 720)) : 1;
    return em * basePx * heightScale;
}

/**
 * @param {HTMLVideoElement|HTMLAudioElement|null} videoEl
 * @param {{styleKey?:string,maxLines?:number,direction?:string}} options
 */
export function buildLayoutConfig(videoEl, options = {}) {
    const styleKey = String(options.styleKey || 'tiktok').toLowerCase();
    const widthPx = Number(videoEl && videoEl.clientWidth) || Number(videoEl && videoEl.videoWidth) || 0;
    const heightPx = Number(videoEl && videoEl.clientHeight) || Number(videoEl && videoEl.videoHeight) || 0;
    const isPortrait = widthPx > 0 && heightPx > 0 ? (heightPx > widthPx) : false;
    const fontSize = estimateCueFontPx(videoEl, styleKey);
    const horizontalPadding = isPortrait ? 20 : 36;
    const maxWidthPx = Math.max(120, widthPx - (horizontalPadding * 2));
    const locale = String(
        (typeof window !== 'undefined' && window.currentLocale)
        || (typeof localStorage !== 'undefined' && localStorage.getItem('locale'))
        || 'he'
    ).toLowerCase();
    const direction = options.direction || ((locale.startsWith('he') || locale.startsWith('ar')) ? 'rtl' : 'ltr');
    return {
        fontSize,
        fontFamily: '"Segoe UI", Arial, "Noto Sans Hebrew", sans-serif',
        maxWidthPx,
        maxLines: Number(options.maxLines) > 0 ? Number(options.maxLines) : 2,
        direction,
        styleKey,
    };
}

export function measureLineWidth(text, config) {
    const ctx = getMeasureCtx();
    if (!ctx || !config) return String(text || '').length * (config.fontSize * 0.56);
    ctx.direction = config.direction === 'rtl' ? 'rtl' : 'ltr';
    ctx.font = `${config.fontSize}px ${config.fontFamily}`;
    return ctx.measureText(String(text || '')).width;
}

function scoreLayout(lines, config) {
    const rows = Array.isArray(lines) ? lines : [String(lines || '')];
    let cost = 0;
    const widths = rows.map((line) => measureLineWidth(line, config));
    const maxW = Math.max(...widths, 0);
    if (maxW > config.maxWidthPx) {
        cost += 10000 + ((maxW - config.maxWidthPx) * 10);
    }
    if (rows.length > config.maxLines) {
        cost += 5000 + ((rows.length - config.maxLines) * 1000);
    }
    if (widths.length > 1) {
        const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
        for (const w of widths) cost += Math.abs(w - avg) * 0.05;
    }
  for (const line of rows) {
        const words = tokenizeWords(line);
        if (words.length === 1 && measureLineWidth(line, config) > config.maxWidthPx * 0.92) cost += 250;
    }
    return cost;
}

function pixelWrapLine(text, config) {
    const words = tokenizeWords(text);
    if (!words.length) return [];
    const lines = [];
    let line = '';
    for (const w of words) {
        const candidate = line ? `${line} ${w}` : w;
        if (!line || measureLineWidth(candidate, config) <= config.maxWidthPx) {
            line = candidate;
        } else {
            lines.push(line);
            line = w;
        }
    }
    if (line) lines.push(line);
    return lines.slice(0, config.maxLines);
}

/**
 * Choose visual line breaks for one timed cue (VTT display only).
 * @param {string} text
 * @param {object} config
 * @param {string[][]} [semanticCandidates]
 * @returns {string}
 */
export function layoutTimedCueText(text, config, semanticCandidates = null) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw || !config) return raw;

    const candidateSets = [];
    if (Array.isArray(semanticCandidates) && semanticCandidates.length) {
        for (const c of semanticCandidates) {
            if (Array.isArray(c) && c.length) candidateSets.push(c);
        }
    }
    candidateSets.push([raw]);

    let bestLines = [raw];
    let bestCost = Infinity;
    for (const lines of candidateSets) {
        let visual = lines;
        if (lines.length === 1) visual = pixelWrapLine(lines[0], config);
        else visual = lines.slice(0, config.maxLines);
        const cost = scoreLayout(visual, config);
        if (cost < bestCost) {
            bestCost = cost;
            bestLines = visual;
        }
    }

    if (bestLines.length === 1 && measureLineWidth(bestLines[0], config) > config.maxWidthPx) {
        const wrapped = pixelWrapLine(bestLines[0], config);
        if (wrapped.length) bestLines = wrapped;
    }
    return bestLines.filter(Boolean).join('\n');
}
