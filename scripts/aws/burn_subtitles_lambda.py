"""AWS Lambda: burn ASS/SRT subtitles into a video via ffmpeg.

Receives the same `input` contract as the former RunPod cpu_image_burn worker:
  task_id, input_video_url, input_srt_url, input_subtitle_format,
  output_upload_url, output_s3_key, callback_url, ...

Downloads via presigned GET, encodes with ffmpeg, uploads via presigned PUT,
then POSTs /api/burn_subtitles_callback.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

FFMPEG_CANDIDATES = (
    os.environ.get("FFMPEG_PATH", "").strip(),
    "/opt/bin/ffmpeg",
    "/usr/bin/ffmpeg",
    "ffmpeg",
)
FONTS_DIR = (os.environ.get("BURN_FONTS_DIR") or "/opt/fonts").strip() or "/opt/fonts"


def _log(msg: str) -> None:
    print(msg, flush=True)


def _resolve_ffmpeg() -> str:
    for candidate in FFMPEG_CANDIDATES:
        if not candidate:
            continue
        if candidate == "ffmpeg":
            which = shutil.which("ffmpeg")
            if which:
                return which
            continue
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise RuntimeError("ffmpeg not found (set FFMPEG_PATH or install into /opt/bin/ffmpeg)")


def _download(url: str, dest: Path, timeout: int = 600) -> None:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)
    if not dest.is_file() or dest.stat().st_size <= 0:
        raise RuntimeError(f"download empty: {dest.name}")


def _upload(url: str, src: Path, content_type: str = "video/mp4", timeout: int = 900) -> None:
    data = src.read_bytes()
    req = urllib.request.Request(
        url,
        data=data,
        method="PUT",
        headers={
            "Content-Type": content_type,
            "Content-Length": str(len(data)),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = int(getattr(resp, "status", 200) or 200)
            if status >= 400:
                raise RuntimeError(f"upload HTTP {status}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"upload HTTP {exc.code}: {detail}") from exc


def _post_callback(callback_url: str, body: dict, timeout: int = 60) -> None:
    if not callback_url:
        return
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        callback_url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            _log(f"callback ok status={getattr(resp, 'status', '?')} task_id={body.get('task_id')}")
    except Exception as exc:
        _log(f"callback failed task_id={body.get('task_id')}: {exc}")


def _escape_ffmpeg_path(path: str) -> str:
    return path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _burn(video_path: Path, subs_path: Path, out_path: Path, subtitle_ext: str) -> None:
    ffmpeg = _resolve_ffmpeg()
    filter_name = "ass" if subtitle_ext == "ass" else "subtitles"
    subs_escaped = _escape_ffmpeg_path(str(subs_path))
    vf = f"{filter_name}='{subs_escaped}'"
    if os.path.isdir(FONTS_DIR):
        fonts_escaped = _escape_ffmpeg_path(FONTS_DIR)
        # fontsdir is a separate option, not part of the subtitle path.
        vf = f"{filter_name}='{subs_escaped}':fontsdir={fonts_escaped}"
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video_path),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(out_path),
    ]
    # Leave headroom under Lambda's 900s hard limit.
    timeout = max(60, min(840, int(os.environ.get("BURN_FFMPEG_TIMEOUT_SEC", "840") or 840)))
    _log(f"ffmpeg start timeout={timeout}s filter={filter_name}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "ffmpeg failed")[-800:]
        raise RuntimeError(err)
    if not out_path.is_file() or out_path.stat().st_size <= 0:
        raise RuntimeError("ffmpeg produced no output")


def _normalize_event(event) -> dict:
    if not isinstance(event, dict):
        return {}
    if isinstance(event.get("input"), dict):
        return event["input"]
    # Async invoke sometimes wraps body as JSON string.
    body = event.get("body")
    if isinstance(body, str) and body.strip():
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict) and isinstance(parsed.get("input"), dict):
                return parsed["input"]
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return event


def handler(event, context):
    inp = _normalize_event(event)
    task_id = str(inp.get("task_id") or "").strip()
    video_url = str(inp.get("input_video_url") or "").strip()
    subs_url = str(inp.get("input_srt_url") or inp.get("input_subtitle_url") or "").strip()
    output_upload_url = str(inp.get("output_upload_url") or "").strip()
    output_s3_key = str(inp.get("output_s3_key") or "").strip()
    callback_url = str(inp.get("callback_url") or "").strip()
    subtitle_ext = str(inp.get("input_subtitle_format") or "srt").strip().lower()
    if subtitle_ext not in ("ass", "srt"):
        subtitle_ext = "srt"

    if not task_id or not video_url or not subs_url or not output_upload_url:
        raise RuntimeError("task_id, input_video_url, input_srt_url, output_upload_url required")

    _log(
        f"burn start task_id={task_id} format={subtitle_ext} "
        f"output_s3_key={output_s3_key or '(none)'}"
    )
    try:
        with tempfile.TemporaryDirectory(prefix="qs-burn-") as tmp:
            tmpdir = Path(tmp)
            video_path = tmpdir / f"input.mp4"
            subs_path = tmpdir / f"subs.{subtitle_ext}"
            out_path = tmpdir / "output.mp4"
            _download(video_url, video_path)
            _download(subs_url, subs_path)
            _burn(video_path, subs_path, out_path, subtitle_ext)
            _upload(output_upload_url, out_path)
        body = {
            "task_id": task_id,
            "status": "completed",
            "output_s3_key": output_s3_key,
            "engine": "lambda",
        }
        _post_callback(callback_url, body)
        _log(f"burn completed task_id={task_id}")
        return body
    except Exception as exc:
        err = str(exc)[:500]
        _log(f"burn failed task_id={task_id}: {err}")
        _post_callback(
            callback_url,
            {
                "task_id": task_id,
                "status": "failed",
                "error": err,
                "output_s3_key": output_s3_key or None,
                "engine": "lambda",
            },
        )
        # Re-raise so async invoke surfaces as failed in CloudWatch metrics.
        raise
