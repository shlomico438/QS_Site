# Movie subtitle burn (legacy Lambda)

**Preferred path is ECS Fargate.** See [burn-subtitles-ecs.md](burn-subtitles-ecs.md).

Lambda remains a last-resort remote backend if `BURN_LAMBDA_FUNCTION_NAME` is set and
ECS / RunPod are not configured. Do not create new Lambda burn functions; use
`python scripts/setup_burn_subtitles_ecs.py --apply` instead.
