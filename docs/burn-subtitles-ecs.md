# Movie subtitle burn on ECS Fargate

Burn-in runs as a one-off Fargate task (not on the 2 GB Site service, not Lambda).

## Deploy the worker

```bat
set AWS_PROFILE=quickscribeAdmin
python scripts/setup_burn_subtitles_ecs.py --apply
```

`quickscribeAdmin` is the Koyeb uploader (ECR push only — no `ecs:DescribeServices`).
If register fails with AccessDenied, finish with the ecs profile and the image URI
the script printed:

```bat
set AWS_PROFILE=quickscribe-ecs
python scripts/setup_burn_subtitles_ecs.py --apply --skip-build --image-uri 760351563015.dkr.ecr.eu-north-1.amazonaws.com/quickscribe-burn-subtitles:TAG
```

The script uses live Site network/roles when the profile can describe ECS; otherwise
known Site defaults (subnets/SG/`ecsTaskExecutionRole`/`quickscribe_s3fullaccess`).
Task family: `quickscribe-burn-subtitles` (1 vCPU / 2 GB, low priority vs medical).
Worker runs ffmpeg under `nice -n 19` with a single encode thread. Site prefers
Fargate Spot (`BURN_ECS_USE_SPOT=true`) with on-demand Fargate as weight fallback.

## Site env

```env
BURN_ECS_CLUSTER=default
BURN_ECS_TASK_DEFINITION=quickscribe-burn-subtitles
BURN_ECS_SUBNETS=subnet-aaa,subnet-bbb
BURN_ECS_SECURITY_GROUPS=sg-ccc
BURN_ECS_ASSIGN_PUBLIC_IP=ENABLED
BURN_ECS_CONTAINER_NAME=burn
BURN_ECS_USE_SPOT=true
ENABLE_AUDIO_PREPROCESSING=false
```

Grant the Site ECS task role:

```json
[
  {
    "Effect": "Allow",
    "Action": ["ecs:RunTask", "ecs:DescribeTasks", "ecs:TagResource"],
    "Resource": "*"
  },
  {
    "Effect": "Allow",
    "Action": ["iam:PassRole"],
    "Resource": [
      "arn:aws:iam::ACCOUNT:role/SITE_EXECUTION_ROLE",
      "arn:aws:iam::ACCOUNT:role/SITE_TASK_ROLE"
    ]
  }
]
```

After a successful test burn, you can clear:

```env
RUNPOD_CPU_ENDPOINT_ID=
RUNPOD_MOVIE_ENDPOINT_ID=
RUNPOD_BURN_ENDPOINT_ID=
BURN_LAMBDA_FUNCTION_NAME=
```

(and delete the RunPod CPU endpoint).

## Behavior

1. Browser → `POST /api/burn_subtitles_server`
2. Site uploads ASS/SRT to S3, presigns video/subtitle GET + output PUT
3. Site `ecs.RunTask` with `BURN_TASK_JSON` container override
4. Fargate task ffmpeg-burns and PUTs the MP4
5. Worker POSTs `/api/burn_subtitles_callback`
6. Site also probes S3 if the callback hits another instance

**Limit:** ~500 MB upload ceiling. Watcher default is **30 minutes** (not Lambda’s 15).

## Fallback order

1. `BURN_ECS_TASK_DEFINITION` + `BURN_ECS_SUBNETS` → ECS  
2. else RunPod CPU (`RUNPOD_*`)  
3. else legacy `BURN_LAMBDA_*` if set  
4. else local ffmpeg only when `RUNPOD_BURN_ALLOW_LOCAL_FALLBACK` / simulation  
