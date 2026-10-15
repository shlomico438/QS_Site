# Movie subtitle burn on AWS Lambda

Burn-in no longer needs the RunPod `cpu_image_burn` endpoint when Lambda is configured.

## Deploy the Lambda

```bat
set AWS_PROFILE=quickscribe-ecs
python scripts/setup_burn_subtitles_lambda.py --apply
```

This builds a container image (ffmpeg + fonts), pushes to ECR, and creates/updates
`quickscribe-burn-subtitles` (15 min timeout, ~3 GB RAM, 4 GB ephemeral disk).

## Site env

```env
BURN_LAMBDA_FUNCTION_NAME=quickscribe-burn-subtitles
ENABLE_AUDIO_PREPROCESSING=false
```

Grant the Site ECS task role:

```json
{
  "Effect": "Allow",
  "Action": ["lambda:InvokeFunction"],
  "Resource": "arn:aws:lambda:eu-north-1:ACCOUNT:function:quickscribe-burn-subtitles"
}
```

After a successful test burn, you can clear:

```env
RUNPOD_CPU_ENDPOINT_ID=
RUNPOD_MOVIE_ENDPOINT_ID=
RUNPOD_BURN_ENDPOINT_ID=
```

(and delete the RunPod CPU endpoint).

## Behavior

1. Browser → `POST /api/burn_subtitles_server`
2. Site uploads ASS/SRT to S3, presigns video/subtitle GET + output PUT
3. Site async-invokes Lambda with that payload
4. Lambda ffmpeg-burns and PUTs the MP4
5. Lambda POSTs `/api/burn_subtitles_callback`
6. Site also probes S3 if the callback hits another instance

**Limit:** Lambda max runtime is **15 minutes**. Very long/high-res encodes may fail; keep sources within the existing ~500 MB upload ceiling.

## Fallback order

1. `BURN_LAMBDA_FUNCTION_NAME` → Lambda  
2. else RunPod CPU (`RUNPOD_*`)  
3. else local ffmpeg only when `RUNPOD_BURN_ALLOW_LOCAL_FALLBACK` / simulation  
