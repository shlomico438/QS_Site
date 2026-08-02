#!/usr/bin/env python3
"""Standalone Whisper "tiny" probe for transcription clean/noisy calibration.

Diagnostic tool only — does not touch production routing or the GPU worker.

Usage:
  python calibrate_probe.py path/to/audio.wav

Requires faster-whisper (CPU). Install if needed:
  pip install -r requirements-calibrate.txt
  # or: pip install faster-whisper
"""

from __future__ import annotations

import argparse
import math
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

PROBE_SECONDS = 15.0
HALF_WINDOW = PROBE_SECONDS / 2.0
SILENCE_SHIFT_SECONDS = 20.0
# float32 PCM in ~[-1, 1]; below this is treated as near-silent
SILENCE_RMS_THRESHOLD = 1e-3
SAMPLE_RATE = 16000


def _require_faster_whisper():
    try:
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
    except ImportError:
        print(
            "error: faster-whisper is not installed.\n"
            "Install with:\n"
            "  pip install -r requirements-calibrate.txt\n"
            "  # or: pip install faster-whisper",
            file=sys.stderr,
        )
        sys.exit(1)
    return WhisperModel, decode_audio


def _resolve_tool(names: tuple[str, ...]) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    bin_dir = Path(__file__).resolve().parent / "bin"
    for name in names:
        candidate = bin_dir / name
        if candidate.is_file():
            return str(candidate)
    return None


def _duration_ffprobe(ffprobe: str, path: Path) -> float | None:
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as exc:
        print(f"warning: ffprobe failed ({exc})", file=sys.stderr)
        return None
    if result.returncode != 0:
        return None
    out = (result.stdout or "").strip().splitlines()
    if not out:
        return None
    try:
        val = float(out[0].strip())
    except ValueError:
        return None
    return val if val > 0 else None


def _duration_decode(decode_audio, path: Path) -> float:
    audio = decode_audio(str(path), sampling_rate=SAMPLE_RATE)
    return float(len(audio)) / float(SAMPLE_RATE)


def _middle_window_start(duration: float) -> float:
    if duration < PROBE_SECONDS:
        return 0.0
    start = (duration / 2.0) - HALF_WINDOW
    start = max(0.0, start)
    return min(start, duration - PROBE_SECONDS)


def _write_wav_f32(path: Path, samples) -> None:
    import numpy as np

    pcm = np.asarray(samples, dtype=np.float32)
    pcm = np.clip(pcm, -1.0, 1.0)
    int16 = (pcm * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(int16.tobytes())


def _extract_window_ffmpeg(
    ffmpeg: str,
    src: Path,
    start: float,
    duration: float,
    dest: Path,
) -> None:
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        str(dest),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"ffmpeg extract failed: {err or result.returncode}")


def _load_window(
    *,
    src: Path,
    start: float,
    window_len: float,
    dest: Path,
    ffmpeg: str | None,
    decode_audio,
):
    if ffmpeg:
        _extract_window_ffmpeg(ffmpeg, src, start, window_len, dest)
        return decode_audio(str(dest), sampling_rate=SAMPLE_RATE)

    full = decode_audio(str(src), sampling_rate=SAMPLE_RATE)
    i0 = int(start * SAMPLE_RATE)
    i1 = int((start + window_len) * SAMPLE_RATE)
    samples = full[i0:i1]
    _write_wav_f32(dest, samples)
    return samples


def _rms(samples) -> float:
    import numpy as np

    if samples is None or len(samples) == 0:
        return 0.0
    x = np.asarray(samples, dtype=np.float64)
    return float(math.sqrt(float(np.mean(np.square(x)))))


def _mean_attr(segments: list, attr: str) -> float | None:
    values = []
    for seg in segments:
        val = getattr(seg, attr, None)
        if val is None:
            continue
        try:
            values.append(float(val))
        except (TypeError, ValueError):
            continue
    if not values:
        return None
    return sum(values) / len(values)


def _fmt(value: float | None, digits: int = 4) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{digits}f}"


def run_probe(audio_path: Path) -> int:
    if not audio_path.is_file():
        print(f"error: file not found: {audio_path}", file=sys.stderr)
        return 1

    WhisperModel, decode_audio = _require_faster_whisper()

    ffprobe = _resolve_tool(("ffprobe", "ffprobe.exe"))
    ffmpeg = _resolve_tool(("ffmpeg", "ffmpeg.exe"))

    duration = _duration_ffprobe(ffprobe, audio_path) if ffprobe else None
    if duration is None:
        print("info: using full-file decode for duration (ffprobe unavailable)")
        duration = _duration_decode(decode_audio, audio_path)

    start = _middle_window_start(duration)
    window_len = min(PROBE_SECONDS, duration)

    print(f"file: {audio_path}")
    print(f"total_duration_sec: {duration:.3f}")
    print(f"window_start_sec: {start:.3f}")
    print(f"window_len_sec: {window_len:.3f}")

    with tempfile.TemporaryDirectory(prefix="qs_calibrate_") as tmp:
        slice_path = Path(tmp) / "window.wav"

        if not ffmpeg:
            print("info: ffmpeg unavailable; slicing decoded samples in memory")

        samples = _load_window(
            src=audio_path,
            start=start,
            window_len=window_len,
            dest=slice_path,
            ffmpeg=ffmpeg,
            decode_audio=decode_audio,
        )
        rms = _rms(samples)
        print(f"window_rms: {rms:.6f}")

        if rms < SILENCE_RMS_THRESHOLD:
            shifted = start + SILENCE_SHIFT_SECONDS
            can_shift = duration >= PROBE_SECONDS and shifted + PROBE_SECONDS <= duration + 1e-6
            if can_shift:
                print(
                    f"info: window near-silent (rms < {SILENCE_RMS_THRESHOLD}); "
                    f"retrying at +{SILENCE_SHIFT_SECONDS:.0f}s"
                )
                start = min(shifted, duration - PROBE_SECONDS)
                window_len = PROBE_SECONDS
                print(f"window_start_sec: {start:.3f}")
                samples = _load_window(
                    src=audio_path,
                    start=start,
                    window_len=window_len,
                    dest=slice_path,
                    ffmpeg=ffmpeg,
                    decode_audio=decode_audio,
                )
                rms = _rms(samples)
                print(f"window_rms: {rms:.6f}")
            if rms < SILENCE_RMS_THRESHOLD:
                print("warning: extracted window may be mostly silent")

        print("loading WhisperModel(tiny, device=cpu, compute_type=int8)...")
        model = WhisperModel("tiny", device="cpu", compute_type="int8")
        segments_iter, _info = model.transcribe(str(slice_path), beam_size=1)
        segments = list(segments_iter)

    if not segments:
        print("no segments detected")
        return 0

    avg_logprob = _mean_attr(segments, "avg_logprob")
    avg_no_speech_prob = _mean_attr(segments, "no_speech_prob")
    avg_compression_ratio = _mean_attr(segments, "compression_ratio")

    print(f"avg_logprob: {_fmt(avg_logprob)}")
    print(f"avg_no_speech_prob: {_fmt(avg_no_speech_prob)}")
    print(f"avg_compression_ratio: {_fmt(avg_compression_ratio)}")
    print(f"num_segments: {len(segments)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Whisper tiny probe — print confidence metrics for calibration."
    )
    parser.add_argument(
        "audio",
        type=Path,
        help="Path to an audio file (wav/mp3/m4a/etc.)",
    )
    args = parser.parse_args(argv)
    return run_probe(args.audio.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
