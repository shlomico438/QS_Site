"""Server-side subtitle pipeline matching static/js/qs_subtitle_*.js.

Used by the profiling VTT API so cmd clients get the same semantic split,
screen-width layout, and WebVTT as the regular UI (headless measure fallback).
"""

from __future__ import annotations

import math
import re
from types import SimpleNamespace

STRONG_END_RE = re.compile(r'[.!?؟…]["\'»”)]*\s*$')
COMMA_END_RE = re.compile(r'[,،:;]\s*$')
PAUSE_END_RE = COMMA_END_RE
STRONG_PAUSE_END_RE = STRONG_END_RE
CONJUNCTION_START_RE = re.compile(r'^(אבל|כי|ואז|כאשר|ולכן|לכן|אם|כדי)\b')
HEBREW_LETTER = re.compile(r'[\u0590-\u05FF]')
MEDIUM_CONJUNCTIONS = {
    'אבל', 'כי', 'ואז', 'כאשר', 'ולכן', 'לכן', 'אם', 'כדי', 'ש', 'וגם', 'או', 'אז',
}
PROTECTED_PHRASES = (
    'בינה מלאכותית',
    'בית ספר',
    'עורך דין',
    'ראש הממשלה',
    'יום העצמאות',
)
TARGET_MAX_CHARS = 54
TARGET_MAX_WORDS = 12
TARGET_MIN_CHARS = 12

CUE_STYLE_METRICS = {
    'tiktok': {
        'font_family': 'sans-serif',
        'font_weight': '700',
        'em_desktop': 2.5,
        'em_mobile': 1.15,
        'width_scale': 1.1,
        'shadow_padding_px': 14,
        'letter_spacing_px': 0,
    },
    'clean': {
        'font_family': 'sans-serif',
        'font_weight': '500',
        'em_desktop': 1.4,
        'em_mobile': 1.05,
        'width_scale': 1.02,
        'shadow_padding_px': 6,
        'letter_spacing_px': 0,
    },
    'cinematic': {
        'font_family': 'Times New Roman, Times, serif',
        'font_weight': '400',
        'em_desktop': 1.6,
        'em_mobile': 1.1,
        'width_scale': 1.06,
        'shadow_padding_px': 6,
        'letter_spacing_px': 1.6,
    },
}


def tokenize_words(text):
    return [p for p in re.sub(r'\s+', ' ', str(text or '')).strip().split(' ') if p]


def _normalize_text(text):
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def _bare_word(word):
    return re.sub(r'^[^\u0590-\u05FFa-zA-Z0-9]+|[^\u0590-\u05FFa-zA-Z0-9]+$', '', str(word or ''))


def _is_protected_span(words, start, end):
    slice_ = ' '.join(words[start:end + 1])
    for phrase in PROTECTED_PHRASES:
        parts = phrase.split(' ')
        if len(parts) < 2:
            continue
        if phrase in slice_:
            return True
    return False


def _is_strong_boundary_after(words, index):
    if index < 0 or index >= len(words) - 1:
        return False
    left = ' '.join(words[: index + 1])
    return bool(STRONG_END_RE.search(left))


def _is_medium_boundary_after(words, index):
    if index < 0 or index >= len(words) - 1:
        return False
    if _is_strong_boundary_after(words, index):
        return True
    nxt = words[index + 1] if index + 1 < len(words) else ''
    if nxt and re.sub(r'[^\u0590-\u05FFa-zA-Z]', '', nxt) in MEDIUM_CONJUNCTIONS:
        return True
    left = ' '.join(words[: index + 1])
    return bool(COMMA_END_RE.search(left))


def _is_phrase_boundary_after(words, index):
    if index < 0 or index >= len(words) - 1:
        return False
    if _is_medium_boundary_after(words, index):
        return True
    nxt = _bare_word(words[index + 1])
    prev = _bare_word(words[index])
    if not nxt:
        return False
    if nxt.startswith('ל') and len(nxt) >= 4 and HEBREW_LETTER.search(nxt[1]):
        if re.search(r'(גוף|נחה|רגע|זמן|מקום|שלב)$', prev):
            return True
        if STRONG_END_RE.search(' '.join(words[: index + 1])):
            return True
        return False
    if nxt.startswith('ש') and len(nxt) >= 4 and HEBREW_LETTER.search(nxt[1]):
        if COMMA_END_RE.search(' '.join(words[: index + 1])):
            return True
        if prev.endswith('נחה'):
            return True
    return False


def _is_valid_split_point(words, index):
    if index < 0 or index >= len(words) - 1:
        return False
    if _is_protected_span(words, max(0, index - 1), index + 1):
        return False
    return _is_phrase_boundary_after(words, index)


def _words_to_lines(words, split_indices):
    if not words:
        return []
    sorted_idx = sorted(split_indices)
    lines = []
    start = 0
    for idx in sorted_idx:
        line = ' '.join(words[start:idx + 1]).strip()
        if line:
            lines.append(line)
        start = idx + 1
    tail = ' '.join(words[start:]).strip()
    if tail:
        lines.append(tail)
    return lines or [' '.join(words)]


def generate_split_candidates(text, max_candidates=8):
    normalized = _normalize_text(text)
    if not normalized:
        return []
    words = tokenize_words(normalized)
    if len(words) <= 1:
        return [[normalized]]

    seen = set()
    candidates = []

    def add(lines):
        clean = [_normalize_text(l) for l in lines if _normalize_text(l)]
        if not clean:
            return
        key = '\n'.join(clean)
        if key in seen:
            return
        seen.add(key)
        candidates.append(clean)

    add([normalized])
    split_points = [i for i in range(len(words) - 1) if _is_valid_split_point(words, i)]
    strong_points = [i for i in split_points if _is_strong_boundary_after(words, i)]
    medium_points = [i for i in split_points if not _is_strong_boundary_after(words, i)]

    for idx in strong_points:
        add(_words_to_lines(words, [idx]))
    for a in range(len(strong_points)):
        for b in range(a + 1, len(strong_points)):
            add(_words_to_lines(words, [strong_points[a], strong_points[b]]))
    for idx in medium_points:
        add(_words_to_lines(words, [idx]))
    for a in range(len(split_points)):
        for b in range(a + 1, len(split_points)):
            add(_words_to_lines(words, [split_points[a], split_points[b]]))

    phrase_points = []
    for i in range(len(words) - 1):
        if i in phrase_points:
            continue
        if _is_phrase_boundary_after(words, i) and i not in split_points:
            phrase_points.append(i)
    for idx in phrase_points:
        add(_words_to_lines(words, [idx]))
    for a in range(len(phrase_points)):
        for b in range(a + 1, len(phrase_points)):
            add(_words_to_lines(words, [phrase_points[a], phrase_points[b]]))
    if phrase_points and strong_points:
        for p in phrase_points:
            for s in strong_points:
                if p != s:
                    add(_words_to_lines(words, [min(p, s), max(p, s)]))
    if len(candidates) < max_candidates and len(split_points) > 1:
        mid = split_points[len(split_points) // 2]
        add(_words_to_lines(words, [mid]))
    return candidates[:max_candidates]


def _word_ranges_from_splits(words, split_indices):
    sorted_idx = sorted(i for i in split_indices if 0 <= i < len(words) - 1)
    ranges = []
    start = 0
    for idx in sorted_idx:
        if idx < start:
            continue
        ranges.append((start, idx))
        start = idx + 1
    if start <= len(words) - 1:
        ranges.append((start, len(words) - 1))
    return ranges


def _span_too_long(words, frm, to):
    n = to - frm + 1
    if n > TARGET_MAX_WORDS:
        return True
    return len(' '.join(words[frm:to + 1])) > TARGET_MAX_CHARS


def _span_char_len(words, frm, to):
    return len(' '.join(words[frm:to + 1]))


def segment_text_into_subtitle_lines(text):
    normalized = _normalize_text(text)
    if not normalized:
        return []
    words = tokenize_words(normalized)
    if not words:
        return []
    if len(words) == 1 or (
        len(normalized) <= TARGET_MAX_CHARS and len(words) <= TARGET_MAX_WORDS
    ):
        return [normalized]

    splits = set()
    for i in range(len(words) - 1):
        if _is_protected_span(words, max(0, i - 1), min(len(words) - 1, i + 1)):
            continue
        if _is_strong_boundary_after(words, i):
            splits.add(i)

    changed = True
    while changed:
        changed = False
        for frm, to in _word_ranges_from_splits(words, splits):
            if not _span_too_long(words, frm, to):
                continue
            added = False
            for i in range(frm, to):
                if i in splits:
                    continue
                if _is_protected_span(words, max(frm, i - 1), min(to, i + 1)):
                    continue
                if not _is_medium_boundary_after(words, i) and not _is_phrase_boundary_after(words, i):
                    continue
                left_len = _span_char_len(words, frm, i)
                right_len = _span_char_len(words, i + 1, to)
                if left_len < TARGET_MIN_CHARS or right_len < TARGET_MIN_CHARS:
                    continue
                splits.add(i)
                added = True
                break
            if added:
                changed = True

    for frm, to in _word_ranges_from_splits(words, splits):
        if not _span_too_long(words, frm, to):
            continue
        acc = ''
        for i in range(frm, to + 1):
            nxt = f'{acc} {words[i]}'.strip() if acc else words[i]
            if acc and len(nxt) > TARGET_MAX_CHARS and frm <= i - 1 < to:
                splits.add(i - 1)
                acc = words[i]
            else:
                acc = nxt
    return _words_to_lines(words, list(splits))


def pick_timing_segmentation(candidates):
    joined = ' '.join(candidates[0]) if candidates else ''
    from_text = segment_text_into_subtitle_lines(joined)
    if from_text:
        return from_text
    return list(candidates[0]) if candidates else []


def word_weight(word):
    w = str(word or '').strip()
    return math.sqrt(len(w)) if w else 0.0


def line_weight(line):
    return sum(word_weight(w) for w in tokenize_words(line))


def _punctuation_bias_multiplier(line, is_last):
    s = str(line or '').strip()
    if not s:
        return 1
    if STRONG_PAUSE_END_RE.search(s) and not is_last:
        return 1.05
    if PAUSE_END_RE.search(s) and not is_last:
        return 1.03
    if not is_last and CONJUNCTION_START_RE.search(s):
        return 0.97
    return 1


def allocate_line_times(start_time, end_time, lines, use_rhythm_bias=True):
    clean_lines = [str(l or '').strip() for l in (lines or []) if str(l or '').strip()]
    if not clean_lines:
        return []
    start = float(start_time)
    try:
        end = float(end_time)
    except (TypeError, ValueError):
        end = float('nan')
    if not math.isfinite(end) or end <= start:
        end = start + max(0.5, len(clean_lines) * 0.4)
    duration = max(0.05, end - start)
    if len(clean_lines) == 1:
        return [{'start': start, 'end': end, 'text': clean_lines[0]}]
    weights = [line_weight(line) for line in clean_lines]
    adjusted = [
        w * (_punctuation_bias_multiplier(clean_lines[i], i == len(clean_lines) - 1) if use_rhythm_bias else 1)
        for i, w in enumerate(weights)
    ]
    total = sum(adjusted) or 1.0
    raw = [duration * (w / total) for w in adjusted]
    out = []
    cursor = start
    for i, line in enumerate(clean_lines):
        line_start = cursor
        line_end = end if i == len(clean_lines) - 1 else (cursor + raw[i])
        out.append({
            'start': line_start,
            'end': max(line_start + 0.05, line_end),
            'text': line,
        })
        cursor = line_end
    if out:
        out[-1]['end'] = end
    return out


def process_whisper_segments(segments):
    result = []
    for seg in segments or []:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get('text') or '').strip()
        if not text:
            result.append(dict(seg))
            continue
        try:
            start = float(seg.get('start'))
        except (TypeError, ValueError):
            continue
        try:
            end = float(seg.get('end'))
        except (TypeError, ValueError):
            end = float('nan')
        if not math.isfinite(end) or end <= start:
            end = start + 5
        lines = segment_text_into_subtitle_lines(text) or [text]
        timed = allocate_line_times(start, end, lines)
        for row in timed:
            item = dict(seg)
            item['start'] = row['start']
            item['end'] = row['end']
            item['text'] = row['text']
            item['semanticCandidates'] = generate_split_candidates(row['text'])
            item.pop('words', None)
            result.append(item)
    return result


def _style_metrics(style_key):
    key = str(style_key or 'tiktok').strip().lower()
    return CUE_STYLE_METRICS.get(key) or CUE_STYLE_METRICS['tiktok']


def estimate_cue_font_px(width_px, height_px, style_key, viewport_width=None):
    m = _style_metrics(style_key)
    vw = float(viewport_width if viewport_width is not None else width_px or 0)
    is_mobile = vw > 0 and vw <= 768
    em = m['em_mobile'] if is_mobile else m['em_desktop']
    h = float(height_px or 0)
    cue_base = h * 0.05 if h > 0 else 16.0
    return em * cue_base


def build_layout_config(width_px, height_px, style_key='tiktok', max_lines=2, direction='rtl', viewport_width=None):
    m = _style_metrics(style_key)
    w = float(width_px or 0)
    h = float(height_px or 0)
    is_portrait = w > 0 and h > 0 and h > w
    font_size = estimate_cue_font_px(w, h, style_key, viewport_width=viewport_width)
    horizontal_padding = 24 if is_portrait else 40
    max_width = max(100.0, w - (horizontal_padding * 2) - float(m['shadow_padding_px'] or 0))
    return SimpleNamespace(
        font_size=font_size,
        font_family=m['font_family'],
        font_weight=m['font_weight'],
        width_scale=m['width_scale'],
        letter_spacing_px=m['letter_spacing_px'],
        max_width_px=max_width,
        max_lines=int(max_lines) if int(max_lines) > 0 else 3,
        direction=direction or 'rtl',
        style_key=str(style_key or 'tiktok').lower(),
    )


def measure_line_width(text, config):
    """Headless fallback matching qs_subtitle_layout.js when canvas is unavailable."""
    raw = str(text or '')
    if not raw or not config:
        return 0.0
    return len(raw) * (float(config.font_size) * 0.56) * float(config.width_scale or 1)


def _normalize_cue_text(s):
    return re.sub(r'\s+', ' ', str(s or '')).strip()


def _text_fully_represented(lines, raw):
    want = _normalize_cue_text(raw)
    if not want:
        return True
    got = _normalize_cue_text(' '.join(lines or []))
    return got == want


def _line_fits(line, config):
    return measure_line_width(line, config) <= config.max_width_px


def _candidate_matches_cue_text(lines, cue_text):
    cue = _normalize_cue_text(cue_text)
    if not cue or not lines:
        return False
    return _normalize_cue_text(' '.join(lines)) == cue


def _split_line_at_width(line, config):
    words = tokenize_words(line)
    if len(words) <= 1:
        return [line]
    best = None
    best_cost = float('inf')
    for i in range(1, len(words)):
        l1 = ' '.join(words[:i])
        l2 = ' '.join(words[i:])
        w1 = measure_line_width(l1, config)
        w2 = measure_line_width(l2, config)
        overflow = max(0.0, w1 - config.max_width_px) + max(0.0, w2 - config.max_width_px)
        cost = overflow + abs(w1 - w2) * 0.03
        if cost < best_cost:
            best_cost = cost
            best = [l1, l2]
    return best or [line]


def _ensure_lines_fit_width(lines, config):
    rows = [_normalize_cue_text(l) for l in (lines or []) if _normalize_cue_text(l)]
    if not rows:
        return rows
    guard = 0
    while guard < 48:
        guard += 1
        overflow_idx = next((i for i, line in enumerate(rows) if not _line_fits(line, config)), -1)
        if overflow_idx < 0:
            break
        split = _split_line_at_width(rows[overflow_idx], config)
        if len(split) == 1 and split[0] == rows[overflow_idx]:
            break
        rows[overflow_idx:overflow_idx + 1] = split
    return rows


def _pixel_wrap_greedy(text, config, line_count):
    words = tokenize_words(text)
    if not words:
        return []
    n = max(1, int(line_count or 1))
    if n == 1:
        return [' '.join(words)]
    lines = []
    i = 0
    for _ in range(n - 1):
        line = ''
        while i < len(words):
            candidate = f'{line} {words[i]}'.strip() if line else words[i]
            if not line or _line_fits(candidate, config):
                line = candidate
                i += 1
            else:
                break
        if not line and i < len(words):
            line = words[i]
            i += 1
        if line:
            lines.append(line)
    if i < len(words):
        lines.append(' '.join(words[i:]))
    return lines or [' '.join(words)]


def _pick_matching_semantic_lines(raw, semantic_candidates):
    matching = []
    if isinstance(semantic_candidates, list):
        for c in semantic_candidates:
            if isinstance(c, list) and c and _candidate_matches_cue_text(c, raw):
                matching.append([_normalize_cue_text(l) for l in c if _normalize_cue_text(l)])
    if not matching:
        return None
    for n in (3, 2, 1):
        pool = [c for c in matching if len(c) == n]
        if pool:
            return pick_timing_segmentation(pool) if len(pool) > 1 else pool[0]
    return matching[0]


def _pages_represent_full_text(pages, raw):
    lines = []
    for page in pages or []:
        for line in str(page or '').split('\n'):
            t = _normalize_cue_text(line)
            if t:
                lines.append(t)
    return _text_fully_represented(lines, raw)


def _paginate_by_semantic_units(semantic_lines, config):
    max_per_page = max(1, int(config.max_lines or 2))
    pages = []
    for sem_line in semantic_lines:
        wrapped = _ensure_lines_fit_width([_normalize_cue_text(sem_line)], config)
        if not wrapped:
            continue
        for i in range(0, len(wrapped), max_per_page):
            pages.append('\n'.join(wrapped[i:i + max_per_page]))
    return pages


def _paginate_visual_lines(visual_lines, config):
    max_per_page = max(1, int(config.max_lines or 2))
    lines = [_normalize_cue_text(l) for l in (visual_lines or []) if _normalize_cue_text(l)]
    if not lines:
        return ['']
    if len(lines) <= max_per_page:
        return ['\n'.join(lines)]
    pages = []
    for i in range(0, len(lines), max_per_page):
        pages.append('\n'.join(lines[i:i + max_per_page]))
    return pages


def layout_cue_pages(text, config, semantic_candidates=None):
    raw = _normalize_cue_text(text)
    if not raw or not config:
        return ['']
    semantic_lines = _pick_matching_semantic_lines(raw, semantic_candidates)
    if semantic_lines:
        pages = _paginate_by_semantic_units(semantic_lines, config)
        if pages and _pages_represent_full_text(pages, raw):
            return pages
    visual_lines = _ensure_lines_fit_width(
        _pixel_wrap_greedy(raw, config, max(8, int(config.max_lines or 2))),
        config,
    )
    return _paginate_visual_lines(visual_lines, config)


def _tokens_equal(a, b):
    x = re.sub(r'^[^\u0590-\u05FFa-zA-Z0-9]+|[^\u0590-\u05FFa-zA-Z0-9]+$', '', str(a or '')).strip()
    y = re.sub(r'^[^\u0590-\u05FFa-zA-Z0-9]+|[^\u0590-\u05FFa-zA-Z0-9]+$', '', str(b or '')).strip()
    if not x or not y:
        return x == y
    return x == y


def _align_pages_to_word_times(pages, words, cue_start, cue_end):
    clean_pages = [str(p or '').strip() for p in (pages or []) if str(p or '').strip()]
    clean_words = []
    for w in words or []:
        if not isinstance(w, dict):
            continue
        text = str(w.get('word') if w.get('word') is not None else w.get('text') or '').strip()
        if not text:
            continue
        try:
            start = float(w.get('start'))
            end = float(w.get('end'))
        except (TypeError, ValueError):
            continue
        clean_words.append({'text': text, 'start': start, 'end': end})
    if not clean_pages or not clean_words:
        return None
    out = []
    cursor = 0
    for page in clean_pages:
        tokens = tokenize_words(page)
        if not tokens:
            continue
        if cursor >= len(clean_words):
            return None
        start_idx = cursor
        consumed = 0
        ti = 0
        while ti < len(tokens) and cursor < len(clean_words):
            want = tokens[ti]
            if _tokens_equal(want, clean_words[cursor]['text']):
                cursor += 1
                consumed += 1
                ti += 1
                continue
            matched = False
            for look in (1, 2):
                if cursor + look < len(clean_words) and _tokens_equal(want, clean_words[cursor + look]['text']):
                    cursor += look + 1
                    consumed += 1
                    matched = True
                    break
            if not matched:
                return None
            ti += 1
        if not consumed:
            return None
        end_idx = max(start_idx, cursor - 1)
        start = clean_words[start_idx]['start'] if math.isfinite(clean_words[start_idx]['start']) else float(cue_start)
        end = clean_words[end_idx]['end'] if math.isfinite(clean_words[end_idx]['end']) else float(cue_end)
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            return None
        out.append({'start': start, 'end': end, 'text': page})
    if not out:
        return None
    try:
        first_start = float(cue_start)
        if math.isfinite(first_start):
            out[0]['start'] = first_start
    except (TypeError, ValueError):
        pass
    try:
        last_end = float(cue_end)
        if math.isfinite(last_end):
            out[-1]['end'] = max(out[-1]['end'], last_end)
    except (TypeError, ValueError):
        pass
    for i in range(1, len(out)):
        out[i]['start'] = max(out[i - 1]['end'], out[i]['start'])
        if out[i]['end'] <= out[i]['start']:
            out[i]['end'] = out[i]['start'] + 0.05
    return out


def layout_cues_for_display(cues, width_px, height_px, style_key='tiktok', direction='rtl'):
    style = str(style_key or 'tiktok').lower()
    config = build_layout_config(width_px, height_px, style_key=style, max_lines=2, direction=direction)
    out = []
    lst = list(cues or [])
    for i, cue in enumerate(lst):
        if not isinstance(cue, dict):
            continue
        pages = layout_cue_pages(cue.get('text'), config, cue.get('semanticCandidates'))
        if len(pages) <= 1:
            item = dict(cue)
            item['text'] = pages[0] if pages else str(cue.get('text') or '')
            out.append(item)
            continue
        try:
            start = float(cue.get('start'))
        except (TypeError, ValueError):
            item = dict(cue)
            item['text'] = pages[0] if pages else ''
            out.append(item)
            continue
        try:
            end = float(cue.get('end')) if cue.get('end') is not None else float('nan')
        except (TypeError, ValueError):
            end = float('nan')
        if not math.isfinite(end) or end <= start:
            nxt = lst[i + 1] if i + 1 < len(lst) else None
            try:
                next_s = float((nxt or {}).get('start')) if isinstance(nxt, dict) else float('nan')
            except (TypeError, ValueError):
                next_s = float('nan')
            end = next_s if math.isfinite(next_s) and next_s > start else (start + max(0.5, len(pages) * 0.4))
        timed = _align_pages_to_word_times(pages, cue.get('words'), start, end)
        if not timed:
            timed = allocate_line_times(start, end, pages, use_rhythm_bias=False)
        for row in timed:
            item = dict(cue)
            item['start'] = row['start']
            item['end'] = row['end']
            item['text'] = row['text']
            out.append(item)
    return out


def _vtt_timestamp(seconds):
    t = float(seconds or 0)
    if not math.isfinite(t) or t < 0:
        t = 0.0
    ms = int(round((t - math.floor(t)) * 1000))
    if ms >= 1000:
        t += 1
        ms = 0
    total = int(math.floor(t))
    hh = total // 3600
    mm = (total % 3600) // 60
    ss = total % 60
    return f'{hh:02d}:{mm:02d}:{ss:02d}.{ms:03d}'


def cues_to_vtt(cues, position='bottom'):
    """WebVTT matching the regular player's refreshVideoSubtitles cue settings."""
    pos = str(position or 'bottom').strip().lower()
    if pos == 'top':
        settings = ' line:10% position:50% align:center'
    elif pos == 'middle':
        settings = ' line:50% position:50% align:center'
    else:
        settings = ' line:90% position:50% align:center'
    lines = ['WEBVTT', '']
    lst = [c for c in (cues or []) if isinstance(c, dict)]
    for i, cue in enumerate(lst):
        try:
            start = float(cue.get('start'))
        except (TypeError, ValueError):
            continue
        try:
            end = float(cue.get('end')) if cue.get('end') is not None else float('nan')
        except (TypeError, ValueError):
            end = float('nan')
        if not math.isfinite(end) or end <= start:
            nxt = lst[i + 1] if i + 1 < len(lst) else None
            try:
                next_s = float((nxt or {}).get('start')) if isinstance(nxt, dict) else float('nan')
            except (TypeError, ValueError):
                next_s = float('nan')
            end = next_s if math.isfinite(next_s) else (start + 1)
        if end <= start:
            end = start + 0.05
        text = re.sub(r'<[^>]+>', '', str(cue.get('text') or '')).strip()
        if not text:
            continue
        lines.append(f'{_vtt_timestamp(start)} --> {_vtt_timestamp(end)}{settings}')
        lines.append(text)
        lines.append('')
    return '\n'.join(lines) + ('\n' if lines and lines[-1] != '' else '')


def segments_to_adapted_vtt(
    segments,
    width_px=1920,
    height_px=1080,
    style_key='tiktok',
    direction='rtl',
):
    """Full regular subtitle path: semantic split → screen layout → WebVTT."""
    split = process_whisper_segments(segments or [])
    laid_out = layout_cues_for_display(
        split,
        width_px,
        height_px,
        style_key=style_key,
        direction=direction,
    )
    return cues_to_vtt(laid_out), laid_out
