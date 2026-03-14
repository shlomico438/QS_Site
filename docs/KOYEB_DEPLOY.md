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
