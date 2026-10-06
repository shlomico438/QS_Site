"""Recover medical live-transcription gaps with AWS Transcribe.

Default engine is the same streaming API as the live session
(transcribe:StartStreamTranscription). That works with the existing
Site credentials and does not need StartTranscriptionJob.

Optional MEDICAL_GAP_TRANSCRIBE_ENGINE=batch uses StartTranscriptionJob
in the HIPAA bucket region. Do not put batch permissions on the public
QuickScribe_Koyeb_Uploader user.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import tempfile
import time
import uuid
from typing import Any, Callable, Dict, Iterable, List, Optional

GAP_FILLING_TEMPLATE_HE = "[קטע בהשלמה {start}–{end}]"
GAP_FAILED_TEMPLATE_HE = "[קטע לא תומלל {start}–{end}]"
GAP_FILLING_TEMPLATE_EN = "[Filling in {start}–{end}]"
GAP_FAILED_TEMPLATE_EN = "[Not transcribed {start}–{end}]"
PLACEHOLDER_RE = re.compile(
    r"\[(?:קטע בהשלמה|קטע לא תומלל|Filling in|Not transcribed) [^\]]+\]"
)

# Batch Transcribe is available in eu-north-1; streaming is not.
TRANSCRIBE_BATCH_REGIONS = {
    "af-south-1",
    "ap-east-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "ca-central-1",
    "eu-central-1",
    "eu-north-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "me-south-1",
    "sa-east-1",
    "us-east-1",
    "us-east-2",
    "us-gov-east-1",
    "us-gov-west-1",
    "us-west-1",
    "us-west-2",
}

DEFAULT_TIMEOUT_SEC = 110
DEFAULT_POLL_SEC = 2.5
MIN_GAP_MS = 250
OVERLAP_MAX_WORDS = 8
STREAM_SAMPLE_RATE_HZ = 16000
STREAM_FEED_CHUNK_BYTES = 3200
STREAM_MAX_QUEUED_BYTES = STREAM_SAMPLE_RATE_HZ * 2 * 4

logger = logging.getLogger(__name__)


def transcribe_batch_region(preferred: Optional[str] = None) -> str:
    """Use the HIPAA bucket region when batch Transcribe is available there."""
    raw = str(
        preferred
        or os.environ.get("MEDICAL_TRANSCRIBE_BATCH_REGION")
        or os.environ.get("MEDICAL_S3_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("AWS_REGION")
        or "eu-north-1"
    ).strip()
    if raw in TRANSCRIBE_BATCH_REGIONS:
        return raw
    return "eu-north-1"


def gap_transcribe_engine(preferred: Optional[str] = None) -> str:
    """stream (default) reuses live IAM; batch needs a private role/user."""
    raw = str(
        preferred
        or os.environ.get("MEDICAL_GAP_TRANSCRIBE_ENGINE")
        or "stream"
    ).strip().lower()
    if raw in ("batch", "job", "transcription_job"):
        return "batch"
    return "stream"


def pcm_bytes_from_wav(path: str) -> bytes:
    import wave

    with wave.open(str(path), "rb") as wf:
        return wf.readframes(wf.getnframes())


def _stream_pcm_blocking(
    pcm: bytes,
    *,
    region: str,
    language_code: str,
    identify_multiple_languages: bool,
    language_options: Optional[List[str]],
    timeout_sec: float,
    sleep_fn: Callable[[float], None],
    session_factory: Callable[..., Any],
) -> str:
    session = session_factory(
        region=region,
        language_code=str(language_code or "he-IL").strip() or "he-IL",
        sample_rate_hz=STREAM_SAMPLE_RATE_HZ,
        identify_multiple_languages=bool(identify_multiple_languages),
        language_options=language_options,
    )
    start_timeout = min(30.0, max(8.0, float(timeout_sec or DEFAULT_TIMEOUT_SEC)))
    session.start(timeout_sec=start_timeout)
    deadline = time.time() + max(15.0, float(timeout_sec or DEFAULT_TIMEOUT_SEC))
    try:
        max_queued = STREAM_MAX_QUEUED_BYTES
        for offset in range(0, len(pcm), STREAM_FEED_CHUNK_BYTES):
            if time.time() >= deadline:
                raise TimeoutError("gap stream feed timed out")
            queued = int(getattr(session, "_audio_deque_bytes", 0) or 0)
            while queued > max_queued:
                if time.time() >= deadline:
                    raise TimeoutError("gap stream feed timed out")
                sleep_fn(0.05)
                if getattr(session, "_error", None):
                    raise session._error
                queued = int(getattr(session, "_audio_deque_bytes", 0) or 0)
            session.feed_audio(pcm[offset : offset + STREAM_FEED_CHUNK_BYTES])
        remaining = max(5.0, deadline - time.time())
        return str(session.stop(timeout_sec=remaining) or "").strip()
    except Exception:
        try:
            session.stop(timeout_sec=5)
        except Exception:
            pass
        raise


def _transcribe_pcm_direct(
    pcm: bytes,
    *,
    region: str,
    language_code: str,
    identify_multiple_languages: bool,
    language_options: Optional[List[str]],
    timeout_sec: float,
) -> str:
    """One asyncio loop, no nested live-session threads or gevent hub hops."""
    from amazon_transcribe.client import TranscribeStreamingClient
    from aws_transcribe_stream import (
        _CollectingTranscriptHandler,
        _REAL_SELECTOR_CLASS,
        _aws_max_audio_event_bytes,
        _iter_aws_audio_frames,
        normalize_transcribe_region,
    )

    region = normalize_transcribe_region(region)
    lang = str(language_code or "he-IL").strip() or "he-IL"
    opts = [str(x).strip() for x in (language_options or []) if str(x).strip()]
    if identify_multiple_languages and len(opts) < 2:
        opts = ["he-IL", "en-US"]
    limit = max(12.0, min(70.0, float(timeout_sec or DEFAULT_TIMEOUT_SEC)))

    async def _run() -> str:
        logger.info(
            "medical gap pcm stream start bytes=%s region=%s lang=%s multi=%s",
            len(pcm),
            region,
            lang,
            bool(identify_multiple_languages),
        )
        client = TranscribeStreamingClient(region=region)
        stream_kwargs = {
            "media_sample_rate_hz": STREAM_SAMPLE_RATE_HZ,
            "media_encoding": "pcm",
        }
        if identify_multiple_languages:
            stream = await client.start_stream_transcription(
                language_code=None,
                identify_multiple_languages=True,
                language_options=opts,
                **stream_kwargs,
            )
        else:
            stream = await client.start_stream_transcription(
                language_code=lang,
                **stream_kwargs,
            )
        logger.info("medical gap pcm stream accepted")
        handler = _CollectingTranscriptHandler(stream.output_stream)
        max_frame = _aws_max_audio_event_bytes(STREAM_SAMPLE_RATE_HZ)

        async def _feed() -> None:
            sent = 0
            for frame in _iter_aws_audio_frames(pcm, max_frame):
                await stream.input_stream.send_audio_event(audio_chunk=frame)
                sent += 1
                if sent == 1 or sent % 40 == 0:
                    logger.info("medical gap pcm fed frames=%s", sent)
                await asyncio.sleep(0)
            await stream.input_stream.end_stream()
            logger.info("medical gap pcm end_stream frames=%s", sent)

        await asyncio.gather(_feed(), handler.handle_events())
        text = str(handler.full_transcript or "").strip()
        logger.info("medical gap pcm done chars=%s", len(text))
        return text

    loop = asyncio.SelectorEventLoop(_REAL_SELECTOR_CLASS())
    try:
        asyncio.set_event_loop(loop)
        return str(loop.run_until_complete(asyncio.wait_for(_run(), timeout=limit)) or "").strip()
    finally:
        try:
            pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        except Exception:
            pass
        try:
            loop.close()
        except Exception:
            pass


def transcribe_pcm_via_stream(
    pcm: bytes,
    *,
    region: str,
    language_code: str = "he-IL",
    identify_multiple_languages: bool = False,
    language_options: Optional[List[str]] = None,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    sleep_fn: Callable[[float], None] = time.sleep,
    session_factory: Optional[Callable[..., Any]] = None,
) -> str:
    """Send gap PCM through AWS Transcribe Streaming.

    Must run on a real OS thread (see siteapp._run_on_os_thread). Do not call
    AwsTranscribeStreamSession.start() from a gevent request greenlet.
    """
    raw = bytes(pcm or b"")
    if not raw:
        return ""
    if session_factory is not None:
        return _stream_pcm_blocking(
            raw,
            region=region,
            language_code=language_code,
            identify_multiple_languages=identify_multiple_languages,
            language_options=language_options,
            timeout_sec=timeout_sec,
            sleep_fn=sleep_fn,
            session_factory=session_factory,
        )
    return _transcribe_pcm_direct(
        raw,
        region=region,
        language_code=language_code,
        identify_multiple_languages=identify_multiple_languages,
        language_options=language_options,
        timeout_sec=timeout_sec,
    )


def format_clock_ms(ms: Any) -> str:
    try:
        total = max(0, int(round(float(ms) / 1000.0)))
    except (TypeError, ValueError):
        total = 0
    return f"{total // 60:02d}:{total % 60:02d}"


def gap_placeholder_text(start_ms: Any, end_ms: Any, *, failed: bool = False, locale: str = "he") -> str:
    loc = str(locale or "he").lower()
    if failed:
        tmpl = GAP_FAILED_TEMPLATE_EN if loc.startswith("en") else GAP_FAILED_TEMPLATE_HE
    else:
        tmpl = GAP_FILLING_TEMPLATE_EN if loc.startswith("en") else GAP_FILLING_TEMPLATE_HE
    return tmpl.format(start=format_clock_ms(start_ms), end=format_clock_ms(end_ms))


def _to_int_ms(value: Any, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _norm_gap(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    start_ms = _to_int_ms(raw.get("startMs") if raw.get("startMs") is not None else raw.get("start_ms"))
    end_ms = _to_int_ms(raw.get("endMs") if raw.get("endMs") is not None else raw.get("end_ms"))
    gap_id = str(raw.get("id") or raw.get("gapId") or "").strip() or f"gap_{uuid.uuid4().hex[:8]}"
    placeholder = str(raw.get("placeholder") or "").strip()
    return {
        "id": gap_id,
        "startMs": start_ms,
        "endMs": end_ms,
        "placeholder": placeholder,
        "textOffset": _to_int_ms(raw.get("textOffset") if raw.get("textOffset") is not None else raw.get("text_offset")),
    }


def validate_gaps(gaps: Any, duration_ms: Any) -> List[Dict[str, Any]]:
    """Drop negative / inverted ranges; clamp to the file; clip overlaps."""
    try:
        file_ms = int(round(float(duration_ms)))
    except (TypeError, ValueError):
        file_ms = 0
    if file_ms <= 0:
        return []

    cleaned: List[Dict[str, Any]] = []
    raw_list = gaps if isinstance(gaps, list) else []
    for raw in raw_list:
        gap = _norm_gap(raw)
        if not gap:
            continue
        if gap["startMs"] < 0 or gap["endMs"] < 0:
            continue
        if gap["endMs"] <= gap["startMs"]:
            continue
        if gap["startMs"] >= file_ms:
            continue
        gap["endMs"] = min(gap["endMs"], file_ms)
        if gap["endMs"] - gap["startMs"] < MIN_GAP_MS:
            continue
        cleaned.append(gap)

    cleaned.sort(key=lambda g: (g["startMs"], g["endMs"]))
    out: List[Dict[str, Any]] = []
    prev_end = 0
    for gap in cleaned:
        start = max(gap["startMs"], prev_end)
        end = gap["endMs"]
        if end - start < MIN_GAP_MS:
            continue
        next_gap = dict(gap)
        next_gap["startMs"] = start
        next_gap["endMs"] = end
        out.append(next_gap)
        prev_end = end
    return out


def _word_tokens(text: str) -> List[str]:
    return [p for p in re.split(r"\s+", str(text or "").strip()) if p]


def _norm_token(token: str) -> str:
    return re.sub(r"[^\w\u0590-\u05ff]+", "", str(token or ""), flags=re.UNICODE).lower()


def _tokens_equal(left: Iterable[str], right: Iterable[str]) -> bool:
    a = [_norm_token(x) for x in left]
    b = [_norm_token(x) for x in right]
    if not a or not b or len(a) != len(b):
        return False
    return all(x and x == y for x, y in zip(a, b))


def trim_overlap_edges(left_text: str, gap_text: str, right_text: str, max_words: int = OVERLAP_MAX_WORDS) -> str:
    """Drop words repeated at the pad/overlap edges of a recovered span."""
    gap_words = _word_tokens(gap_text)
    if not gap_words:
        return ""
    left_words = _word_tokens(left_text)
    right_words = _word_tokens(right_text)
    limit = max(1, int(max_words or OVERLAP_MAX_WORDS))

    for n in range(min(limit, len(gap_words), len(left_words)), 0, -1):
        if _tokens_equal(left_words[-n:], gap_words[:n]):
            gap_words = gap_words[n:]
            break
    for n in range(min(limit, len(gap_words), len(right_words)), 0, -1):
        if _tokens_equal(gap_words[-n:], right_words[:n]):
            gap_words = gap_words[:-n]
            break
    return " ".join(gap_words).strip()


def replace_placeholder(transcript: str, placeholder: str, replacement: str) -> str:
    text = str(transcript or "")
    token = str(placeholder or "").strip()
    if not token:
        return text
    if token not in text:
        return text
    left, _, right = text.partition(token)
    trimmed = trim_overlap_edges(left, replacement, right)
    # Keep surrounding newlines if the marker sat on its own line.
    insert = trimmed
    if left.endswith("\n") or right.startswith("\n"):
        insert = trimmed
    elif trimmed:
        if left and not left.endswith((" ", "\n")):
            insert = " " + insert
        if right and not right.startswith((" ", "\n")):
            insert = insert + " "
    return left + insert + right


def apply_failed_marker(transcript: str, gap: Dict[str, Any], locale: str = "he") -> str:
    marker = gap_placeholder_text(gap.get("startMs"), gap.get("endMs"), failed=True, locale=locale)
    placeholder = str(gap.get("placeholder") or "").strip()
    if placeholder and placeholder in str(transcript or ""):
        return str(transcript or "").replace(placeholder, marker)
    if PLACEHOLDER_RE.search(str(transcript or "")):
        return PLACEHOLDER_RE.sub(marker, str(transcript or ""), count=1)
    text = str(transcript or "").rstrip()
    return f"{text}\n{marker}".strip() if text else marker


def stitch_transcript(transcript: str, gaps: List[Dict[str, Any]], locale: str = "he") -> str:
    """Replace each placeholder with recovered text, or the failed marker."""
    text = str(transcript or "")
    for gap in gaps or []:
        status = str(gap.get("status") or "").strip().lower()
        recovered = str(gap.get("text") or "").strip()
        placeholder = str(gap.get("placeholder") or "").strip()
        if status == "ok" and recovered:
            if placeholder and placeholder in text:
                text = replace_placeholder(text, placeholder, recovered)
            else:
                text = (text.rstrip() + "\n" + recovered).strip() if text.strip() else recovered
        else:
            text = apply_failed_marker(text, gap, locale=locale)
    return text


def probe_duration_ms(ffprobe_path: str, input_path: str, timeout_sec: int = 60) -> int:
    cmd = [
        ffprobe_path or "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(input_path),
    ]
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    if run.returncode != 0:
        raise RuntimeError((run.stderr or run.stdout or "ffprobe failed")[-300:])
    try:
        seconds = float((run.stdout or "").strip() or 0)
    except ValueError as exc:
        raise RuntimeError("ffprobe returned no duration") from exc
    return max(0, int(round(seconds * 1000)))


def slice_gap_wav(
    ffmpeg_path: str,
    input_path: str,
    output_path: str,
    start_ms: int,
    end_ms: int,
    timeout_sec: int = 90,
) -> None:
    start_sec = max(0.0, float(start_ms) / 1000.0)
    duration_sec = max(0.05, float(end_ms - start_ms) / 1000.0)
    cmd = [
        ffmpeg_path or "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        f"{start_sec:.3f}",
        "-i",
        str(input_path),
        "-t",
        f"{duration_sec:.3f}",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    if run.returncode != 0 or not os.path.isfile(output_path) or os.path.getsize(output_path) <= 44:
        raise RuntimeError((run.stderr or run.stdout or "ffmpeg slice failed")[-300:])


def _safe_job_name(job_id: str, gap_id: str) -> str:
    raw = f"qs-gap-{str(job_id or 'job')[:12]}-{str(gap_id or 'g')[:16]}-{uuid.uuid4().hex[:8]}"
    return re.sub(r"[^0-9A-Za-z._-]", "-", raw)[:200]


def _gap_object_prefix(user_id: str, job_id: str) -> str:
    safe_user = str(user_id or "anonymous").strip() or "anonymous"
    safe_job = str(job_id or "job").strip() or "job"
    return f"raw-audio/users/{safe_user}/gaps/{safe_job}"


def _extract_transcript_from_job_json(payload: Any) -> str:
    if isinstance(payload, dict):
        results = payload.get("results") or {}
        transcripts = results.get("transcripts") if isinstance(results, dict) else None
        if isinstance(transcripts, list) and transcripts:
            text = str((transcripts[0] or {}).get("transcript") or "").strip()
            if text:
                return text
        text = str(payload.get("transcript") or "").strip()
        if text:
            return text
    return ""


def _put_kms_object(s3_client, bucket: str, key: str, body: bytes, content_type: str, kms_arn: str) -> None:
    put_kw = {
        "Bucket": bucket,
        "Key": key,
        "Body": body,
        "ContentType": content_type,
    }
    if kms_arn:
        put_kw["ServerSideEncryption"] = "aws:kms"
        put_kw["SSEKMSKeyId"] = kms_arn
    s3_client.put_object(**put_kw)


def _delete_quiet(s3_client, bucket: str, key: str) -> None:
    if not key:
        return
    try:
        s3_client.delete_object(Bucket=bucket, Key=key)
    except Exception:
        logger.warning("medical gap cleanup failed key=%s", key)


def _public_gap_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    public_gaps = []
    for row in rows:
        public_gaps.append({
            "id": row.get("id"),
            "startMs": row.get("startMs"),
            "endMs": row.get("endMs"),
            "placeholder": row.get("placeholder") or "",
            "status": "ok" if row.get("status") == "ok" and row.get("text") else "failed",
            "text": row.get("text") or "",
        })
    return public_gaps


def recover_gaps_from_pcm(
    *,
    transcript: str,
    gaps: List[Dict[str, Any]],
    pcm: bytes,
    locale: str = "he",
    language_code: str = "he-IL",
    identify_multiple_languages: bool = False,
    language_options: Optional[List[str]] = None,
    stream_region: str = "eu-west-1",
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    stream_transcribe_fn: Optional[Callable[..., str]] = None,
) -> Dict[str, Any]:
    """Transcribe one buffered PCM gap without uploading the recording."""
    raw = bytes(pcm or b"")
    if not raw:
        raise ValueError("empty_pcm")
    rows = []
    for item in gaps or []:
        gap = _norm_gap(item)
        if gap and gap["endMs"] > gap["startMs"]:
            rows.append(gap)
    if not rows:
        raise ValueError("gaps required")
    stream_fn = stream_transcribe_fn or transcribe_pcm_via_stream
    text = ""
    error = ""
    try:
        text = str(
            stream_fn(
                raw,
                region=stream_region,
                language_code=language_code,
                identify_multiple_languages=bool(identify_multiple_languages),
                language_options=language_options,
                timeout_sec=timeout_sec,
            )
            or ""
        ).strip()
    except Exception as exc:
        error = str(exc)[:240]
        logger.warning("medical gap pcm stream failed: %s", exc)
    # The buffer is the audio for the open gap. Earlier gaps still need the file.
    target = rows[-1]
    for gap in rows:
        if gap is target and text:
            gap["status"] = "ok"
            gap["text"] = text
        else:
            gap["status"] = "failed"
            gap["text"] = ""
            if gap is target and error:
                gap["error"] = error
    public_gaps = _public_gap_rows(rows)
    return {
        "transcript": stitch_transcript(transcript, public_gaps, locale=locale),
        "gaps": public_gaps,
        "duration_ms": int(round(len(raw) / (STREAM_SAMPLE_RATE_HZ * 2) * 1000)),
        "engine": "stream-pcm",
    }


def transcribe_medical_gaps(
    *,
    transcript: str,
    gaps: List[Dict[str, Any]],
    recording_bytes: bytes,
    recording_suffix: str,
    ffmpeg_path: str,
    ffprobe_path: str,
    s3_client,
    transcribe_client,
    bucket: str,
    user_id: str,
    job_id: str,
    kms_arn: str,
    language_code: str = "he-IL",
    identify_multiple_languages: bool = False,
    language_options: Optional[List[str]] = None,
    locale: str = "he",
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    poll_sec: float = DEFAULT_POLL_SEC,
    sleep_fn: Callable[[float], None] = time.sleep,
    time_fn: Callable[[], float] = time.time,
    engine: Optional[str] = None,
    stream_region: Optional[str] = None,
    stream_transcribe_fn: Optional[Callable[..., str]] = None,
    pcm_bytes: Optional[bytes] = None,
) -> Dict[str, Any]:
    """Slice each gap, transcribe it, stitch, then delete temporary objects."""
    if pcm_bytes and gap_transcribe_engine(engine) != "batch":
        return recover_gaps_from_pcm(
            transcript=transcript,
            gaps=gaps,
            pcm=pcm_bytes,
            locale=locale,
            language_code=language_code,
            identify_multiple_languages=identify_multiple_languages,
            language_options=language_options,
            stream_region=str(stream_region or "eu-west-1"),
            timeout_sec=timeout_sec,
            stream_transcribe_fn=stream_transcribe_fn,
        )
    if not recording_bytes:
        raise ValueError("empty_recording")

    suffix = str(recording_suffix or ".m4a")
    if not suffix.startswith("."):
        suffix = "." + suffix
    work = tempfile.mkdtemp(prefix="qs-med-gap-")
    cleanup_keys: List[str] = []
    started_jobs: List[str] = []
    source_path = os.path.join(work, f"recording{suffix}")
    try:
        with open(source_path, "wb") as fh:
            fh.write(recording_bytes)
        duration_ms = probe_duration_ms(ffprobe_path, source_path)
        valid = validate_gaps(gaps, duration_ms)
        if not valid:
            failed = []
            for raw in gaps or []:
                gap = _norm_gap(raw) or {"startMs": 0, "endMs": 0, "placeholder": "", "id": "gap"}
                gap["status"] = "failed"
                gap["text"] = ""
                failed.append(gap)
            stitched = stitch_transcript(transcript, failed, locale=locale) if failed else str(transcript or "")
            return {
                "transcript": stitched,
                "gaps": failed,
                "duration_ms": duration_ms,
            }

        use_batch = gap_transcribe_engine(engine) == "batch"
        prefix = _gap_object_prefix(user_id, job_id)
        pending: List[Dict[str, Any]] = []
        stream_fn = stream_transcribe_fn or transcribe_pcm_via_stream
        stream_reg = str(
            stream_region
            or os.environ.get("MEDICAL_TRANSCRIBE_STREAM_REGION")
            or "eu-west-1"
        ).strip() or "eu-west-1"
        for gap in valid:
            wav_name = f"{gap['id']}.wav"
            wav_path = os.path.join(work, wav_name)
            slice_gap_wav(ffmpeg_path, source_path, wav_path, gap["startMs"], gap["endMs"])
            if not use_batch:
                row = {
                    **gap,
                    "status": "failed",
                    "text": "",
                }
                try:
                    pcm = pcm_bytes_from_wav(wav_path)
                    text = str(
                        stream_fn(
                            pcm,
                            region=stream_reg,
                            language_code=language_code,
                            identify_multiple_languages=bool(identify_multiple_languages),
                            language_options=language_options,
                            timeout_sec=timeout_sec,
                            sleep_fn=sleep_fn,
                        )
                        or ""
                    ).strip()
                    row["text"] = text
                    row["status"] = "ok" if text else "failed"
                except Exception as exc:
                    logger.warning("medical gap stream failed id=%s: %s", gap.get("id"), exc)
                    row["error"] = str(exc)[:240]
                pending.append(row)
                continue
            with open(wav_path, "rb") as fh:
                wav_body = fh.read()
            media_key = f"{prefix}/{wav_name}"
            out_key = f"{prefix}/{gap['id']}.json"
            _put_kms_object(s3_client, bucket, media_key, wav_body, "audio/wav", kms_arn)
            cleanup_keys.append(media_key)
            job_name = _safe_job_name(job_id, gap["id"])
            start_kw: Dict[str, Any] = {
                "TranscriptionJobName": job_name,
                "Media": {"MediaFileUri": f"s3://{bucket}/{media_key}"},
                "MediaFormat": "wav",
                "OutputBucketName": bucket,
                "OutputKey": out_key,
            }
            if kms_arn:
                start_kw["OutputEncryptionKMSKeyId"] = kms_arn
            if identify_multiple_languages:
                opts = [str(x).strip() for x in (language_options or []) if str(x).strip()]
                if len(opts) < 2:
                    opts = ["he-IL", "en-US"]
                start_kw["IdentifyMultipleLanguages"] = True
                start_kw["LanguageOptions"] = opts
            else:
                start_kw["LanguageCode"] = str(language_code or "he-IL").strip() or "he-IL"
            transcribe_client.start_transcription_job(**start_kw)
            started_jobs.append(job_name)
            cleanup_keys.append(out_key)
            pending.append({
                **gap,
                "status": "pending",
                "text": "",
                "job_name": job_name,
                "output_key": out_key,
            })

        if use_batch:
            deadline = time_fn() + max(15.0, float(timeout_sec or DEFAULT_TIMEOUT_SEC))
            unresolved = {row["job_name"]: row for row in pending}
            while unresolved and time_fn() < deadline:
                for job_name, row in list(unresolved.items()):
                    resp = transcribe_client.get_transcription_job(TranscriptionJobName=job_name)
                    job = (resp or {}).get("TranscriptionJob") or {}
                    status = str(job.get("TranscriptionJobStatus") or "").upper()
                    if status == "COMPLETED":
                        body = s3_client.get_object(Bucket=bucket, Key=row["output_key"])["Body"].read()
                        payload = json.loads(body.decode("utf-8"))
                        row["text"] = _extract_transcript_from_job_json(payload)
                        row["status"] = "ok" if row["text"] else "failed"
                        unresolved.pop(job_name, None)
                    elif status in ("FAILED", "COMPLETED_WITH_ERRORS"):
                        row["status"] = "failed"
                        row["error"] = str(job.get("FailureReason") or status)
                        unresolved.pop(job_name, None)
                if unresolved:
                    sleep_fn(max(0.2, float(poll_sec or DEFAULT_POLL_SEC)))

            for row in unresolved.values():
                row["status"] = "failed"
                row["error"] = "timeout"

        public_gaps = _public_gap_rows(pending)
        stitched = stitch_transcript(transcript, public_gaps, locale=locale)
        return {
            "transcript": stitched,
            "gaps": public_gaps,
            "duration_ms": duration_ms,
        }
    finally:
        for key in cleanup_keys:
            _delete_quiet(s3_client, bucket, key)
        for job_name in started_jobs:
            try:
                transcribe_client.delete_transcription_job(TranscriptionJobName=job_name)
            except Exception:
                logger.warning("medical gap job delete failed name=%s", job_name)
        try:
            for name in os.listdir(work):
                try:
                    os.remove(os.path.join(work, name))
                except OSError:
                    pass
            os.rmdir(work)
        except OSError:
            pass
