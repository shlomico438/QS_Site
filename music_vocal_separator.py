import os
import pathlib
import re
import shlex
import struct
import subprocess
import sys


def _split_command(command):
    return shlex.split(command, posix=(os.name != "nt"))


def _run_command(args, timeout_sec):
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )


def _probe_media_duration_sec(ffmpeg_path, input_path, timeout_sec=60):
    """Return media duration in seconds via ffmpeg -i stderr parse."""
    result = subprocess.run(
        [ffmpeg_path or "ffmpeg", "-hide_banner", "-i", str(input_path)],
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    stderr = result.stderr or ""
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+)[.,](\d*)", stderr)
    if not m:
        return None
    h, m_min, s, frac = int(m.group(1)), int(m.group(2)), int(m.group(3)), (m.group(4) or "0")[:3].ljust(3, "0")
    return h * 3600 + m_min * 60 + s + int(frac) / 1000.0


def _decode_mono_pcm_f32(ffmpeg_path, input_path, sr=16000, timeout_sec=600):
    cmd = [
        ffmpeg_path or "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", str(input_path),
        "-vn",
        "-ac", "1",
        "-ar", str(sr),
        "-f", "f32le",
        "-",
    ]
    run = subprocess.run(cmd, capture_output=True, timeout=timeout_sec)
    if run.returncode != 0 or not run.stdout:
        return None, sr
    return run.stdout, sr


def _detect_vocal_onset_sec(pcm_bytes, sr, frame_ms=100, threshold=0.012):
    """First time (seconds) RMS exceeds threshold in mono float32 PCM."""
    if not pcm_bytes or sr <= 0:
        return 0.0
    frame = max(400, int(sr * (frame_ms / 1000.0)))
    sample_size = 4
    n_samples = len(pcm_bytes) // sample_size
    if n_samples < frame:
        return 0.0
    peak = 0.0
    for i in range(0, n_samples, max(1, frame // 4)):
        val = struct.unpack_from("<f", pcm_bytes, i * sample_size)[0]
        ax = abs(float(val))
        if ax > peak:
            peak = ax
    if peak < 1e-8:
        return 0.0
    norm_thr = threshold * peak
    for i in range(0, n_samples - frame + 1, frame):
        s2 = 0.0
        for j in range(i, i + frame):
            v = struct.unpack_from("<f", pcm_bytes, j * sample_size)[0]
            fv = float(v)
            s2 += fv * fv
        rms = (s2 / frame) ** 0.5
        if rms >= norm_thr:
            return i / float(sr)
    return 0.0


def _find_vocals_file(output_dir):
    root = pathlib.Path(output_dir)
    candidates = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        name = path.name.lower()
        if name == "vocals.wav" or (name.startswith("vocals.") and path.suffix.lower() in (".wav", ".mp3", ".flac", ".m4a")):
            candidates.append(path)
    if not candidates:
        return None
    candidates.sort(key=lambda p: (p.suffix.lower() != ".wav", len(str(p))))
    return str(candidates[0])


def _build_timeline_aligned_vocals_wav(ffmpeg_path, vocals_path, source_duration_sec, prepend_sec, out_path, timeout_sec=600):
    """Convert vocals to 16 kHz mono WAV, optionally prepend silence, pad to source duration."""
    ff = ffmpeg_path or "ffmpeg"
    out_path = str(out_path)
    prepend_sec = max(0.0, float(prepend_sec or 0))
    source_duration_sec = float(source_duration_sec or 0)
    tmp_prepended = None
    input_for_convert = vocals_path
    try:
        if prepend_sec > 0.05:
            tmp_prepended = str(pathlib.Path(out_path).with_name("_vocals_prepended.wav"))
            prepend_cmd = [
                ff,
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-f", "lavfi",
                "-i", f"anullsrc=r=44100:cl=mono:d={prepend_sec:.6f}",
                "-i", str(vocals_path),
                "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
                "-c:a", "pcm_s16le",
                tmp_prepended,
            ]
            prep = _run_command(prepend_cmd, timeout_sec)
            if prep.returncode != 0 or not os.path.isfile(tmp_prepended):
                stderr_tail = (prep.stderr or prep.stdout or "")[-800:]
                raise RuntimeError(f"vocals prepend silence failed: {stderr_tail}")
            input_for_convert = tmp_prepended

        ff_cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", str(input_for_convert)]
        if source_duration_sec > 0.05:
            ff_cmd += [
                "-af", f"apad=whole_dur={source_duration_sec:.6f}",
                "-t", f"{source_duration_sec:.6f}",
            ]
        ff_cmd += [
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "pcm_s16le",
            out_path,
        ]
        conv = _run_command(ff_cmd, timeout_sec)
        if conv.returncode != 0 or not os.path.isfile(out_path) or os.path.getsize(out_path) < 1024:
            stderr_tail = (conv.stderr or conv.stdout or "")[-1200:]
            raise RuntimeError(f"vocals wav conversion failed: {stderr_tail}")
    finally:
        if tmp_prepended and os.path.isfile(tmp_prepended):
            try:
                os.unlink(tmp_prepended)
            except OSError:
                pass


def separate_vocals(input_path, work_dir, ffmpeg_path="ffmpeg", timeout_sec=1800, model_name="htdemucs", command_template=None):
    """Separate vocals from a music file and return a timeline-aligned 16 kHz mono WAV.

    Uses Demucs by default:
      python -m demucs --two-stems=vocals -d cpu -n htdemucs --out <work_dir>/demucs <input>

    The output WAV is padded to the source duration so intro/outro music keeps real timing.
    """
    src = pathlib.Path(input_path)
    out_root = pathlib.Path(work_dir) / "separator"
    out_root.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_path or "ffmpeg"

    source_duration_sec = _probe_media_duration_sec(ff, str(src), timeout_sec=min(120, timeout_sec)) or 0.0

    if command_template:
        rendered = command_template.format(
            input=str(src),
            output_dir=str(out_root),
            model=str(model_name or "htdemucs"),
        )
        cmd = _split_command(rendered)
    else:
        device = (os.environ.get("TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_DEVICE") or "cpu").strip() or "cpu"
        cmd = [
            os.environ.get("PYTHON", sys.executable or "python"),
            "-m",
            "demucs",
            "--two-stems=vocals",
            "-d",
            device,
            "-n",
            str(model_name or "htdemucs"),
            "--out",
            str(out_root),
            str(src),
        ]

    sep = _run_command(cmd, timeout_sec)
    if sep.returncode != 0:
        stderr_tail = (sep.stderr or sep.stdout or "")[-1200:]
        raise RuntimeError(f"vocal separation failed: {stderr_tail}")

    vocals_path = _find_vocals_file(out_root)
    if not vocals_path:
        raise RuntimeError("vocal separation completed but no vocals file was produced")

    raw_duration_sec = _probe_media_duration_sec(ff, vocals_path, timeout_sec=min(120, timeout_sec)) or 0.0
    pcm_raw, sr = _decode_mono_pcm_f32(ff, vocals_path, timeout_sec=min(600, timeout_sec))
    onset_in_raw_sec = _detect_vocal_onset_sec(pcm_raw, sr) if pcm_raw else 0.0

    prepend_sec = 0.0
    if source_duration_sec > 0 and raw_duration_sec > 0:
        if raw_duration_sec < source_duration_sec - 1.0 and onset_in_raw_sec < 2.0:
            # Demucs/ffmpeg dropped leading instrumental silence — restore it.
            prepend_sec = max(0.0, source_duration_sec - raw_duration_sec)
        elif raw_duration_sec >= source_duration_sec - 1.0 and onset_in_raw_sec > 0.5:
            # Full-length stem; intro music is near-silent in vocals track.
            prepend_sec = 0.0

    wav_path = pathlib.Path(work_dir) / "vocals_16k_mono.wav"
    _build_timeline_aligned_vocals_wav(
        ff,
        vocals_path,
        source_duration_sec if source_duration_sec > 0 else raw_duration_sec,
        prepend_sec,
        wav_path,
        timeout_sec=min(600, timeout_sec),
    )

    pcm_final, sr_final = _decode_mono_pcm_f32(ff, str(wav_path), timeout_sec=min(600, timeout_sec))
    vocal_onset_sec = _detect_vocal_onset_sec(pcm_final, sr_final) if pcm_final else (prepend_sec + onset_in_raw_sec)
    final_duration_sec = _probe_media_duration_sec(ff, str(wav_path), timeout_sec=60) or source_duration_sec

    return {
        "vocals_path": str(wav_path),
        "separator": "demucs" if not command_template else "custom",
        "model": str(model_name or "htdemucs"),
        "source_duration_sec": round(source_duration_sec, 3) if source_duration_sec else None,
        "raw_vocals_duration_sec": round(raw_duration_sec, 3) if raw_duration_sec else None,
        "final_vocals_duration_sec": round(final_duration_sec, 3) if final_duration_sec else None,
        "vocal_onset_sec": round(float(vocal_onset_sec or 0.0), 3),
        "prepended_silence_sec": round(float(prepend_sec or 0.0), 3),
    }
