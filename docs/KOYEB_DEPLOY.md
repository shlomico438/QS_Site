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
- Optional faster uploads / media delivery (standard bucket only — not medical HIPAA bucket):
  ```env
  S3_CDN_URL=https://d1cqu238yrcgr7.cloudfront.net
  S3_CDN_UPLOAD=true
  S3_CDN_MEDIA_GET=true
  ```
  CloudFront must use the **same S3 bucket** as `S3_BUCKET` as origin, with **PUT/POST** allowed on the behavior, query strings forwarded, and OAC/origin access configured. Medical uploads still go direct to S3.
  Fallback without CDN upload: `S3_UPLOAD_ACCELERATE=true` (enable **S3 Transfer Acceleration** on the bucket in AWS).

### 4. Buildpack / runtime
- Python buildpack should install from `requirements.txt`
- If using Docker: ensure `CMD` or `ENTRYPOINT` runs the Procfile command

### 5. ffmpeg (for burn-in)
If `bin/ffmpeg` is missing, the app now starts anyway (with a warning). Burn-in will fail at runtime. To fix: add ffmpeg to your build (e.g. apt-get in Dockerfile, or use a buildpack that includes it).

### 6. Music vocal separation (Demucs)

**Recommended:** run separation on **RunPod CPU** (`cpu_image_burn`), not on Koyeb.

Koyeb 2GB instances OOM-kill Demucs (`returncode=-9`). The Site auto-dispatches to RunPod CPU when `RUNPOD_CPU_ENDPOINT_ID` (or `RUNPOD_MOVIE_ENDPOINT_ID`) is set. See [runpod-cpu-vocal-separation.md](runpod-cpu-vocal-separation.md).

Koyeb env (minimum):

```env
RUNPOD_CPU_ENDPOINT_ID=<cpu_image_burn endpoint id>
PUBLIC_BASE_URL=https://www.getquickscribe.com
TRANSCRIBE_MUSIC_VOCAL_SEPARATION_ENGINE=runpod
```

Local Demucs on Koyeb (fallback only — needs 4GB+ instance):

- `requirements.txt` includes CPU PyTorch + `demucs` + `soundfile`
- root `Aptfile` installs `libsndfile1`
- `bin/ffmpeg` decodes uploads before Demucs runs

Tuning (RunPod CPU or local):

- **Default model**: `mdx_extra_q`
- **Chunking**: 60s chunks (`TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_CHUNK_SEC`)
- **Shifts**: `--shifts 0` (`TRANSCRIBE_MUSIC_VOCAL_SEPARATOR_SHIFTS`)

Verify: logs show `Music vocal separation dispatched to RunPod CPU` then `Music vocal separation RunPod complete`, and S3 has `{stem}.vocals.wav`.
