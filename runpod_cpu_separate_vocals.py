"""RunPod CPU handler task: separate_vocals (for cpu_image_burn).

Wire into your existing RunPod handler:

    from runpod_cpu_separate_vocals import handle_separate_vocals_task

    def handler(job):
        inp = job.get("input") or {}
        task = str(inp.get("task") or "").strip().lower()
        if task == "separate_vocals":
            return handle_separate_vocals_task(inp)
        if task == "burn_subtitles":
            ...  # existing burn handler

Requires in the Docker image: ffmpeg, demucs, torch (CPU), music_vocal_separator.py
"""
from __future__ import annotations

import logging
import os
import pathlib
import tempfile
import urllib.parse

import requests

logger = logging.getLogger(__name__)


def _guess_suffix_from_url(url):
    path = urllib.parse.urlparse(str(url or "")).path
    suffix = pathlib.Path(path).suffix
    return suffix if suffix else ".bin"


def _post_callback(callback_url, payload, timeout_sec=30):
    if not callback_url:
        return
    try:
        requests.post(callback_url, json=payload, timeout=timeout_sec)
    except Exception:
        logger.exception("vocal separation callback failed url=%s", callback_url)


def handle_separate_vocals_task(inp):
    """Run Demucs on RunPod CPU and upload vocals WAV via presigned PUT."""
    job_id = str(inp.get("job_id") or inp.get("jobId") or "").strip()
    input_audio_url = str(inp.get("input_audio_url") or "").strip()
    output_upload_url = str(inp.get("output_upload_url") or "").strip()
    output_s3_key = str(inp.get("output_s3_key") or "").strip()
    source_s3_key = str(inp.get("source_s3_key") or "").strip()
    callback_url = str(inp.get("callback_url") or "").strip()
    model_name = str(inp.get("model") or os.environ.get("TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_MODEL") or "mdx_extra_q")

    if not job_id or not input_audio_url or not output_upload_url:
        err = "job_id, input_audio_url, and output_upload_url are required"
        _post_callback(callback_url, {"job_id": job_id, "status": "failed", "error": err})
        return {"status": "failed", "error": err}

    if inp.get("chunk_sec") is not None:
        os.environ["TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_CHUNK_SEC"] = str(inp.get("chunk_sec"))
    if inp.get("shifts") is not None:
        os.environ["TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_SHIFTS"] = str(inp.get("shifts"))

    ffmpeg_path = (os.environ.get("FFMPEG_PATH") or "ffmpeg").strip() or "ffmpeg"
    timeout_sec = max(60, int(os.environ.get("TRANSCRIBE_MUSIC_VOCAL_SEPARATION_TIMEOUT_SEC", "1800") or 1800))

    try:
        from music_vocal_separator import separate_vocals

        with tempfile.TemporaryDirectory(prefix=f"qs_vocals_{job_id}_") as tmpdir:
            suffix = _guess_suffix_from_url(input_audio_url)
            local_input = os.path.join(tmpdir, f"input{suffix}")
            with requests.get(input_audio_url, stream=True, timeout=min(600, timeout_sec)) as r:
                r.raise_for_status()
                with open(local_input, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)

            result = separate_vocals(
                local_input,
                tmpdir,
                ffmpeg_path=ffmpeg_path,
                timeout_sec=timeout_sec,
                model_name=model_name,
                command_template=os.environ.get("AUDIO_SEPARATOR_COMMAND"),
            )

            with open(result["vocals_path"], "rb") as f:
                up = requests.put(
                    output_upload_url,
                    data=f,
                    headers={"Content-Type": "audio/wav"},
                    timeout=min(600, timeout_sec),
                )
                up.raise_for_status()

        payload = {
            "job_id": job_id,
            "status": "completed",
            "output_s3_key": output_s3_key,
            "source_s3_key": source_s3_key,
            "separator": result.get("separator") or "demucs",
            "model": result.get("model") or model_name,
            "source_duration_sec": result.get("source_duration_sec"),
            "vocal_onset_sec": result.get("vocal_onset_sec"),
            "prepended_silence_sec": result.get("prepended_silence_sec"),
        }
        _post_callback(callback_url, payload)
        return payload
    except Exception as e:
        logger.exception("RunPod separate_vocals failed job_id=%s", job_id)
        payload = {"job_id": job_id, "status": "failed", "error": str(e)[:1000]}
        _post_callback(callback_url, payload)
        return payload
