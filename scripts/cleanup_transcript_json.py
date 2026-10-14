#!/usr/bin/env python3
"""Run GPT cleanup (new proofreader prompt) on a transcript JSON file.

Uses the local QuickScribe server so the prompt matches what production/sim uses.

Examples:

  # Restart local app first (F5), then:
  python scripts/cleanup_transcript_json.py path\\to\\job.json

  python scripts/cleanup_transcript_json.py job.json -o job.cleaned.json

  python scripts/cleanup_transcript_json.py job.json --base http://127.0.0.1:8000

  # Print only the cleaned text
  python scripts/cleanup_transcript_json.py job.json --text-only
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _join_segments(segments) -> str:
    if not isinstance(segments, list):
        return ""
    parts = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        t = str(seg.get("text") or "").strip()
        if t:
            parts.append(t)
    return "\n".join(parts)


def _extract_plain_text(doc: dict) -> str:
    """Prefer raw ASR segment text so cleanup re-runs on the original, not prior clean."""
    if not isinstance(doc, dict):
        return ""

    for nest_key in ("result", "output", "transcript"):
        nested = doc.get(nest_key)
        if isinstance(nested, dict):
            text = _extract_plain_text(nested)
            if text:
                return text

    segs = doc.get("segments")
    joined = _join_segments(segs)
    if joined:
        return joined

    fmt = doc.get("formatted") if isinstance(doc.get("formatted"), dict) else {}
    for key in ("clean_transcript", "text", "transcript"):
        for src in (fmt, doc):
            if not isinstance(src, dict):
                continue
            val = str(src.get(key) or "").strip()
            if val:
                return val
    return ""


def _post_cleanup(base_url: str, text: str, timeout: int) -> dict:
    url = base_url.rstrip("/") + "/api/format_transcript_summary"
    payload = json.dumps({"mode": "cleanup", "text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body) if body else {}
            if not isinstance(data, dict):
                raise RuntimeError(f"unexpected response type: {type(data)}")
            return data
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {err_body[:500]}") from e


def main() -> int:
    parser = argparse.ArgumentParser(description="GPT cleanup on a transcript JSON file")
    parser.add_argument("input", type=Path, help="Path to transcript/job JSON")
    parser.add_argument("-o", "--output", type=Path, default=None, help="Output JSON path (default: <input>.cleaned.json)")
    parser.add_argument("--base", default="http://127.0.0.1:8000", help="Local QuickScribe base URL")
    parser.add_argument("--timeout", type=int, default=300, help="HTTP timeout seconds")
    parser.add_argument("--text-only", action="store_true", help="Print cleaned text only (no JSON write)")
    parser.add_argument(
        "--from-clean",
        action="store_true",
        help="Use existing formatted.clean_transcript as input instead of segments",
    )
    args = parser.parse_args()

    if not args.input.is_file():
        print(f"File not found: {args.input}", file=sys.stderr)
        return 1

    doc = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        print("Input JSON must be an object", file=sys.stderr)
        return 1

    if args.from_clean:
        fmt = doc.get("formatted") if isinstance(doc.get("formatted"), dict) else {}
        plain = str((fmt or {}).get("clean_transcript") or doc.get("clean_transcript") or "").strip()
        if not plain:
            plain = _extract_plain_text(doc)
    else:
        plain = _extract_plain_text(doc)

    if not plain:
        print("No transcript text found (segments / clean_transcript / text)", file=sys.stderr)
        return 1

    print(f"Input chars: {len(plain)}", file=sys.stderr)
    print(f"POST {args.base.rstrip('/')}/api/format_transcript_summary mode=cleanup …", file=sys.stderr)

    try:
        out = _post_cleanup(args.base, plain, args.timeout)
    except Exception as e:
        print(f"Cleanup failed: {e}", file=sys.stderr)
        print("Is the local app running? Restart it after the prompt change (F5).", file=sys.stderr)
        return 1

    if out.get("error"):
        print(f"API error: {out['error']}", file=sys.stderr)
        return 1

    cleaned = str(out.get("clean_transcript") or "").strip()
    if not cleaned:
        print("API returned empty clean_transcript", file=sys.stderr)
        return 1

    print(
        f"Output chars: {len(cleaned)}  gpt_sec={out.get('cleanup_generation_time') or out.get('gpt_format_sec')}",
        file=sys.stderr,
    )

    if args.text_only:
        sys.stdout.buffer.write((cleaned + "\n").encode("utf-8"))
        return 0

    result = dict(doc)
    prev_fmt = result.get("formatted") if isinstance(result.get("formatted"), dict) else {}
    result["formatted"] = {**prev_fmt, "clean_transcript": cleaned}
    result["cleanup_generation_time"] = out.get("cleanup_generation_time") or out.get("gpt_format_sec")
    result["cleanup_changed"] = bool(out.get("changed")) if out.get("changed") is not None else (cleaned != plain)

    out_path = args.output or args.input.with_suffix(args.input.suffix + ".cleaned.json")
    if out_path == args.input:
        out_path = args.input.with_name(args.input.stem + ".cleaned.json")
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
