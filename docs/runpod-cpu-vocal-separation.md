# RunPod CPU vocal separation (cpu_image_burn)

Music vocal separation (Demucs) needs **~2–4 GB+ RAM**. Do **not** run it on a small Koyeb web instance.

Use your existing RunPod CPU endpoint (`cpu_image_burn`) — same pattern as subtitle burn-in.

## Koyeb env

```env
# Same key as GPU + burn endpoints
RUNPOD_API_KEY=...

# CPU endpoint for burn + vocal separation (cpu_image_burn)
RUNPOD_CPU_ENDPOINT_ID=<your-cpu-endpoint-id>
# or reuse movie endpoint:
RUNPOD_MOVIE_ENDPOINT_ID=<your-cpu-endpoint-id>

# Site URL for worker callback (required)
PUBLIC_BASE_URL=https://www.getquickscribe.com

# Auto: use RunPod CPU when RUNPOD_CPU_ENDPOINT_ID is set (default)
TRANSCRIBE_MUSIC_VOCAL_SEPARATION_ENGINE=runpod

# Optional tuning (worker + site)
TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_MODEL=mdx_extra_q
TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_CHUNK_SEC=60
TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_SHIFTS=0
```

To force local Demucs on Koyeb (not recommended on 2GB):

```env
TRANSCRIBE_MUSIC_VOCAL_SEPARATION_ENGINE=local
```

## Flow

1. User uploads music → Site classifies `audio_profile=music`.
2. Site presigns S3 GET/PUT URLs and POSTs RunPod CPU job: `task=separate_vocals`.
3. Worker runs Demucs, uploads `{stem}.vocals.wav` to S3.
4. Worker POSTs `{PUBLIC_BASE_URL}/api/vocal_separation_callback`.
5. Site triggers GPU transcription on the vocals file.

## Worker changes (cpu_image_burn Docker image)

1. Copy into the image:
   - `music_vocal_separator.py`
   - `runpod_cpu_separate_vocals.py`

2. Install Python deps (CPU PyTorch + Demucs), e.g.:

```txt
--extra-index-url https://download.pytorch.org/whl/cpu
torch==2.3.1
torchaudio==2.3.1
demucs==4.0.1
soundfile>=0.12.1
requests
```

3. Route tasks in your existing handler:

```python
from runpod_cpu_separate_vocals import handle_separate_vocals_task

def handler(job):
    inp = job.get("input") or {}
    task = str(inp.get("task") or "").strip().lower()
    if task == "separate_vocals":
        return handle_separate_vocals_task(inp)
    if task == "burn_subtitles":
        return handle_burn_subtitles_task(inp)  # existing
    ...
```

4. Ensure `ffmpeg` is on PATH in the container.

## Verify

- Koyeb logs: `Music vocal separation dispatched to RunPod CPU job_id=...`
- RunPod CPU logs: Demucs progress, no OOM
- S3: `{upload_stem}.vocals.wav` beside the original
- Koyeb logs: `Music vocal separation RunPod complete job_id=...`
- Transcription proceeds on vocals-only audio
