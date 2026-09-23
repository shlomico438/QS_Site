# QuickScribe Site container

This image runs the existing Flask-SocketIO application with the same
single-worker Gunicorn command used in production.

## Build

```powershell
docker build -t quickscribe-site:local .
```

## Run locally

Create a local `.env` file (it is excluded from both Git and the Docker build
context), then run:

```powershell
docker run --rm --name quickscribe-site `
  --env-file .env `
  -e PORT=8000 `
  -e DISABLE_HTTPS_REDIRECT=true `
  -p 8000:8000 `
  quickscribe-site:local
```

Open `http://localhost:8000/health`; it should return `OK`.

`SIMULATION_MODE` defaults to `true`. Set `SIMULATION_MODE=false` only when the
container has the production Supabase, storage, RunPod, payment, and other
required configuration.

## AWS notes

- Use an ECS task role (or another AWS workload identity) instead of embedding
  AWS access keys in the image. AWS clients always use boto3's default credential
  chain, which resolves the ECS task role automatically. Do not add static AWS
  access-key variables to the task definition. Grant S3 permissions on your
  upload bucket (for example `s3:PutObject`, `s3:GetObject`,
  `s3:DeleteObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts`).
- Cloudflare R2 is separate from AWS IAM. When `S3_BUCKET` is an R2 bucket, set
  `R2_ENDPOINT_URL` (or `S3_ENDPOINT_URL`), `R2_ACCESS_KEY_ID`, and
  `R2_SECRET_ACCESS_KEY`; these explicit R2 credentials are used only for R2.
- Deploy with `deploy.bat` (defaults to cluster `default`, service `quickscribe-site`,
  profile `quickscribe-ecs`). If that profile is missing or still the Koyeb
  uploader, it prompts for infra IAM keys once and saves them to the profile.
- Configure the load balancer health check to use `GET /health` on the
  container port (success matcher `200`). Do not use `/` — production mode
  redirects plain HTTP to HTTPS and the checker will see `301` instead of `200`.
  The app also skips redirect for load-balancer `HealthChecker` user-agents.
- Set target group **health check grace period** to at least **120 seconds** on
  first deploy (the Flask app import can take ~10s before the worker accepts HTTP).
- During rollout, use **minimum healthy percent 100%** (or run one task) so the
  ALB does not drain all targets while new tasks are still booting.
- Keep the service at one Gunicorn worker per container. Scale by running more
  containers only after process-local job state has been externalized or its
  multi-instance behavior has been verified.
- Socket.IO uses in-memory sessions per container. If the ALB target group runs
  more than one ECS task, enable **target group stickiness** (ALB cookie, ~1 hour).
  Without it, `/socket.io` polling returns HTTP 400 (`Session ID unknown`).
  Use a **classic ECS service** with `minimumHealthyPercent=100` on **one**
  target group. Express Mode canary (two TGs) 503s sticky browsers after deploy.
  Migrate with `python scripts/migrate_express_to_classic_ecs.py` (dry-run;
  add `--apply` to change AWS). Then `deploy.bat default quickscribe-site`.
- Autoscaling: min **1** / max **2** tasks at 1 vCPU. Idle stays at one task.
  Maximum CPU ≥70% for 2 minutes adds a spare; Maximum CPU <20% for 10 minutes
  removes it. Re-apply with `python scripts/setup_ecs_site_autoscaling.py --apply`.
- The image includes FFmpeg for the existing media probing and local fallback
  paths.
- Set `PUBLIC_BASE_URL` and `QS_CANONICAL_ORIGIN` to the public HTTPS origin.
- Set `PORT` only if the platform does not use the default `8000`.

## Production command

The image runs:

```text
gunicorn --workers 1 --no-control-socket -c gunicorn.conf.py -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker --bind 0.0.0.0:$PORT siteapp:app
```
