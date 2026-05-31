# Koyeb Deployment Troubleshooting

## If deployment hangs on "Starting" (>10 min)

### 1. Check instance logs
In Koyeb dashboard → your service → **Logs**, look for:
- Import errors (missing module, ffmpeg)
- Port binding errors
- Crash stack traces

### 2. Health check configuration
Koyeb → Service → **Settings** → **Health checks**:
- **Path**: `/health` (HTTP)
- **Port**: same as `$PORT` (usually 8000)
- **Timeout**: increase to 30–60s if startup is slow
- **Initial delay**: 10–30s to allow app to boot

### 3. Environment variables
Ensure these are set in Koyeb:
- `SIMULATION_MODE` = `0` or `false` (production)
- `PORT` is set by Koyeb automatically
- `S3_BUCKET`, `AWS_*`, `SUPABASE_*`, `RUNPOD_*` as needed

### 4. Buildpack / runtime
- Python buildpack should install from `requirements.txt`
- If using Docker: ensure `CMD` or `ENTRYPOINT` runs the Procfile command

### 5. ffmpeg (for burn-in)
If `bin/ffmpeg` is missing, the app now starts anyway (with a warning). Burn-in will fail at runtime. To fix: add ffmpeg to your build (e.g. apt-get in Dockerfile, or use a buildpack that includes it).

### 6. Music vocal separation (Demucs)
The Python buildpack installs dependencies from root `requirements.txt`, which includes CPU PyTorch, `demucs`, and `soundfile`.

- **System library**: root `Aptfile` installs `libsndfile1` (required by `soundfile` on Linux).
- **Bundled ffmpeg**: `bin/ffmpeg` and `bin/ffprobe` are used to decode uploads before Demucs runs.
- **Instance RAM**: use at least **2–4 GB**; Demucs on CPU is memory-heavy.
- **Build time**: first deploy after adding torch/demucs can take **10–20+ minutes**; increase build timeout if needed.
- **Runtime device**: Demucs defaults to `-d cpu` (override with `TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_DEVICE`).
- **CPU jobs**: defaults to `-j 1` (override with `TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_JOBS`).
- **Optional override**: `AUDIO_SEPARATOR_COMMAND=python -m demucs --two-stems=vocals -d cpu -n htdemucs --out {output_dir} {input}`
- **Verify**: after a music upload, logs should show `Music vocal separation complete` and S3 should have `{stem}.vocals.wav` beside the original upload.
- **If separation fails**: logs now include the Demucs command, return code, and stderr/stdout tail.
