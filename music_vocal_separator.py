import os
import pathlib
import re
import shlex
import struct
import subprocess
import sys


def _split_command(command):
    return shlex.split(command, posix=(os.name != "nt"))


def _run_command(args, timeout_sec, env=None):
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        env=env,
    )


def _subprocess_env_with_ffmpeg(ffmpeg_path, work_dir=None):
    """Ensure demucs/torchaudio can find bundled ffmpeg and use a writable cache."""
    env = os.environ.copy()
    ff = (ffmpeg_path or "ffmpeg").strip()
    if ff and os.path.isfile(ff):
        ff_dir = str(pathlib.Path(ff).resolve().parent)
        env["PATH"] = ff_dir + os.pathsep + env.get("PATH", "")
        env["FFMPEG_PATH"] = ff
        ffprobe = str(pathlib.Path(ff_dir) / "ffprobe")
        if os.path.isfile(ffprobe):
            env["FFPROBE_PATH"] = ffprobe
    if work_dir:
        cache_root = str(pathlib.Path(work_dir) / "cache")
        env.setdefault("TORCH_HOME", os.path.join(cache_root, "torch"))
        env.setdefault("XDG_CACHE_HOME", cache_root)
    env.setdefault("OMP_NUM_THREADS", "1")
    env.setdefault("MKL_NUM_THREADS", "1")
    env.setdefault("OPENBLAS_NUM_THREADS", "1")
    env.setdefault("NUMEXPR_NUM_THREADS", "1")
    env.setdefault("MALLOC_ARENA_MAX", "2")
    return env


def _env_int(name, default):
    try:
        return int(os.environ.get(name, str(default)) or default)
    except (TypeError, ValueError):
        return default


def _env_float(name, default):
    try:
        return float(os.environ.get(name, str(default)) or default)
    except (TypeError, ValueError):
        return default


def _is_htdemucs_model(model_name):
    name = str(model_name or "").strip().lower()
    return name.startswith("htdemucs")


def _build_demucs_command(demucs_input, out_root, model_name, device=None, jobs=None):
    device = (device or os.environ.get("TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_DEVICE") or "cpu").strip() or "cpu"
    jobs = max(1, int(jobs if jobs is not None else _env_int("TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_JOBS", 1)))
    shifts = max(0, _env_int("TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_SHIFTS", 0))
    model = str(model_name or "mdx_extra_q")
    cmd = [
        os.environ.get("PYTHON", sys.executable or "python"),
        "-m",
        "demucs",
        "--two-stems=vocals",
        "-d",
        device,
        "-j",
        str(jobs),
        "--shifts",
        str(shifts),
        "-n",
        model,
        "--out",
        str(out_root),
    ]
    if not _is_htdemucs_model(model):
        segment = _env_float("TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_SEGMENT", 8.0)
        if segment > 0:
            cmd += ["--segment", str(segment)]
    cmd.append(str(demucs_input))
    return cmd


def _split_wav_into_chunks(ffmpeg_path, wav_path, work_dir, chunk_sec, timeout_sec, env):
    duration = _probe_media_duration_sec(ffmpeg_path, wav_path, timeout_sec=min(120, timeout_sec)) or 0.0
    chunk_sec = max(30.0, float(chunk_sec or 0))
    if duration <= 0 or duration <= chunk_sec + 1.0:
        return [(str(wav_path), 0.0)]

    ff = ffmpeg_path or "ffmpeg"
    chunks = []
    start = 0.0
    idx = 0
    while start < duration - 0.05:
        seg_dur = min(chunk_sec, max(0.0, duration - start))
        if seg_dur <= 0.05:
            break
        chunk_path = pathlib.Path(work_dir) / f"demucs_chunk_{idx:04d}.wav"
        cmd = [
            ff,
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-i", str(wav_path),
            "-ss", f"{start:.6f}",
            "-t", f"{seg_dur:.6f}",
            "-vn",
            "-ac", "2",
            "-ar", "44100",
            "-c:a", "pcm_s16le",
            str(chunk_path),
        ]
        conv = _run_command(cmd, timeout_sec, env=env)
        if conv.returncode != 0 or not chunk_path.is_file() or chunk_path.stat().st_size < 1024:
            raise RuntimeError(_format_subprocess_failure("demucs chunk split failed", cmd, conv))
        chunks.append((str(chunk_path), start))
        start += seg_dur
        idx += 1
    return chunks or [(str(wav_path), 0.0)]


def _concat_wav_files(ffmpeg_path, wav_paths, out_path, timeout_sec, env):
    paths = [str(p) for p in (wav_paths or []) if p]
    if not paths:
        raise RuntimeError("no vocal chunks to concatenate")
    if len(paths) == 1:
        return paths[0]

    ff = ffmpeg_path or "ffmpeg"
    out_path = str(out_path)
    list_path = pathlib.Path(out_path).with_suffix(".concat.txt")
    lines = []
    for path in paths:
        escaped = str(path).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cmd = [
        ff,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_path),
        "-c:a", "pcm_s16le",
        out_path,
    ]
    conv = _run_command(cmd, timeout_sec, env=env)
    if conv.returncode != 0 or not os.path.isfile(out_path) or os.path.getsize(out_path) < 1024:
        raise RuntimeError(_format_subprocess_failure("vocals chunk concat failed", cmd, conv))
    return out_path


def _run_demucs_once(demucs_input, out_root, model_name, timeout_sec, env, command_template=None):
    out_root = pathlib.Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    if command_template:
        rendered = command_template.format(
            input=str(demucs_input),
            output_dir=str(out_root),
            model=str(model_name or "mdx_extra_q"),
        )
        cmd = _split_command(rendered)
    else:
        cmd = _build_demucs_command(demucs_input, out_root, model_name)

    sep = _run_command(cmd, timeout_sec, env=env)
    if sep.returncode != 0:
        raise RuntimeError(_format_subprocess_failure("vocal separation failed", cmd, sep))

    vocals_path = _find_vocals_file(out_root)
    if not vocals_path:
        raise RuntimeError("vocal separation completed but no vocals file was produced")
    return vocals_path


def _normalize_input_for_demucs(ffmpeg_path, input_path, work_dir, timeout_sec):
    """Decode any uploaded format to stereo 44.1 kHz PCM WAV before Demucs."""
    src = pathlib.Path(input_path)
    wav_path = pathlib.Path(work_dir) / "demucs_input.wav"
    cmd = [
        ffmpeg_path or "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(src),
        "-vn",
        "-ac", "2",
        "-ar", "44100",
        "-c:a", "pcm_s16le",
        str(wav_path),
    ]
    conv = _run_command(
        cmd,
        timeout_sec,
        env=_subprocess_env_with_ffmpeg(ffmpeg_path, work_dir),
    )
    if conv.returncode != 0 or not wav_path.is_file() or wav_path.stat().st_size < 1024:
        raise RuntimeError(_format_subprocess_failure("demucs input normalize failed", cmd, conv))
    return str(wav_path)


def _format_subprocess_failure(label, cmd, result):
    cmd_text = " ".join(shlex.quote(str(part)) for part in (cmd or []))
    stdout_tail = (result.stdout or "")[-1200:]
    stderr_tail = (result.stderr or "")[-1200:]
    detail = stderr_tail or stdout_tail
    if not detail and result.returncode in (-9, 137, -15, 9):
        detail = (
            "process killed by OS (usually out-of-memory). "
            "Use a larger Koyeb instance (4GB+), keep TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_MODEL=mdx_extra_q, "
            "and/or lower TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_CHUNK_SEC (default 60)."
        )
    if not detail:
        detail = f"exit code {result.returncode}"
    if result.returncode in (-9, 137, -15, 9):
        oom_hint = (
            "OOM-killed (out of memory). Use a 4GB+ Koyeb instance, "
            "TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_MODEL=mdx_extra_q, "
            "and/or TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_CHUNK_SEC=60. "
        )
    else:
        oom_hint = ""
    return (
        f"{oom_hint}{label}: returncode={result.returncode} cmd={cmd_text} "
        f"stderr={stderr_tail} stdout={stdout_tail or detail}"
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


def separate_vocals(input_path, work_dir, ffmpeg_path="ffmpeg", timeout_sec=1800, model_name="mdx_extra_q", command_template=None):
    """Separate vocals from a music file and return a timeline-aligned 16 kHz mono WAV.

    Uses Demucs by default:
      python -m demucs --two-stems=vocals -d cpu --shifts 0 -n mdx_extra_q --out <work_dir>/separator <input>

    Long tracks are split into short chunks on CPU to avoid OOM on small servers.
    """
    src = pathlib.Path(input_path)
    out_root = pathlib.Path(work_dir) / "separator"
    out_root.mkdir(parents=True, exist_ok=True)
    ff = ffmpeg_path or "ffmpeg"
    model = str(model_name or "mdx_extra_q")

    source_duration_sec = _probe_media_duration_sec(ff, str(src), timeout_sec=min(120, timeout_sec)) or 0.0
    demucs_input = _normalize_input_for_demucs(ff, str(src), work_dir, timeout_sec=min(600, timeout_sec))
    demucs_env = _subprocess_env_with_ffmpeg(ff, work_dir)
    chunk_sec = _env_float("TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_CHUNK_SEC", 60.0)
    chunks = _split_wav_into_chunks(ff, demucs_input, work_dir, chunk_sec, min(600, timeout_sec), demucs_env)

    vocals_paths = []
    per_chunk_timeout = max(120, int(timeout_sec / max(1, len(chunks))))
    for idx, (chunk_path, _chunk_offset) in enumerate(chunks):
        chunk_out = out_root / f"chunk_{idx:04d}"
        vocals_paths.append(
            _run_demucs_once(
                chunk_path,
                chunk_out,
                model,
                per_chunk_timeout,
                demucs_env,
                command_template=command_template if len(chunks) == 1 else None,
            )
        )

    if len(vocals_paths) == 1:
        vocals_path = vocals_paths[0]
    else:
        vocals_path = _concat_wav_files(
            ff,
            vocals_paths,
            pathlib.Path(work_dir) / "vocals_merged.wav",
            timeout_sec=min(600, timeout_sec),
            env=demucs_env,
        )

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
        "model": model,
        "source_duration_sec": round(source_duration_sec, 3) if source_duration_sec else None,
        "raw_vocals_duration_sec": round(raw_duration_sec, 3) if raw_duration_sec else None,
        "final_vocals_duration_sec": round(final_duration_sec, 3) if final_duration_sec else None,
        "vocal_onset_sec": round(float(vocal_onset_sec or 0.0), 3),
        "prepended_silence_sec": round(float(prepend_sec or 0.0), 3),
    }
