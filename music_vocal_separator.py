import os
import pathlib
import shlex
import subprocess
import sys


def _split_command(command):
    return shlex.split(command, posix=(os.name != "nt"))


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


def _run_command(args, timeout_sec):
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )


def separate_vocals(input_path, work_dir, ffmpeg_path="ffmpeg", timeout_sec=1800, model_name="htdemucs", command_template=None):
    """Separate vocals from a music file and return a 16 kHz mono WAV path.

    Uses Demucs by default:
      python -m demucs --two-stems=vocals -n htdemucs --out <work_dir>/demucs <input>

    Set AUDIO_SEPARATOR_COMMAND to override the command. Supported placeholders:
      {input}, {output_dir}, {model}

    The command must write a vocals file somewhere under {output_dir}.
    """
    src = pathlib.Path(input_path)
    out_root = pathlib.Path(work_dir) / "separator"
    out_root.mkdir(parents=True, exist_ok=True)

    if command_template:
        rendered = command_template.format(
            input=str(src),
            output_dir=str(out_root),
            model=str(model_name or "htdemucs"),
        )
        cmd = _split_command(rendered)
    else:
        cmd = [
            os.environ.get("PYTHON", sys.executable or "python"),
            "-m",
            "demucs",
            "--two-stems=vocals",
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

    wav_path = pathlib.Path(work_dir) / "vocals_16k_mono.wav"
    ff_cmd = [
        ffmpeg_path or "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(vocals_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(wav_path),
    ]
    conv = _run_command(ff_cmd, max(120, min(timeout_sec, 600)))
    if conv.returncode != 0 or not wav_path.exists() or wav_path.stat().st_size < 1024:
        stderr_tail = (conv.stderr or conv.stdout or "")[-1200:]
        raise RuntimeError(f"vocals wav conversion failed: {stderr_tail}")

    return {
        "vocals_path": str(wav_path),
        "separator": "demucs" if not command_template else "custom",
        "model": str(model_name or "htdemucs"),
    }
