# RunPod CPU audio preprocessing

Standard speech uploads can be normalized on the existing RunPod CPU endpoint
before Whisper large-v3 runs on the GPU endpoint.

## Configuration

Set this on the Site service:

```text
ENABLE_AUDIO_PREPROCESSING=true
```

The feature defaults to enabled when the variable is absent. Set it to
`false`, `0`, `no`, or `off` to bypass CPU preprocessing without a deploy.

The CPU endpoint uses the existing `RUNPOD_CPU_ENDPOINT_ID` and
`RUNPOD_API_KEY`. `PUBLIC_BASE_URL` must be configured so the CPU worker can
post `/api/audio_preprocess_callback`.

## Scope

- Standard RunPod speech jobs: preprocessing enabled.
- Music/vocal-separation jobs: preprocessing bypassed; the existing vocal
  separation branch is not invoked by this feature.
- Medical/SageMaker jobs: preprocessing bypassed.
- ffmpeg failures: logged and failed open to the original upload.

## Processing

The CPU worker downloads the original through a presigned URL and runs:

```text
ffmpeg -y -i INPUT_FILE -ar 16000 -ac 1 -af loudnorm OUTPUT_FILE.wav
```

This produces a loudness-normalized, mono, 16 kHz PCM WAV. Arguments are
passed directly to `subprocess.run` without a shell, so paths containing
spaces are safe. ffprobe logs input duration when available. ffmpeg start,
end, elapsed time, and stderr on failure are logged by the CPU worker.

## Handoff and cleanup

1. Site uploads remain unchanged in their original S3 key.
2. Site gates the GPU worker with `worker_ready=false`.
3. The CPU task uploads `{source_stem}.preprocessed.wav` as an intermediate.
4. Site publishes that key to the waiting GPU worker and sets
   `worker_ready=true`.
5. The GPU worker downloads the WAV and transcribes it normally.
6. After the GPU success or failure callback, Site deletes only the
   `.preprocessed.wav` intermediate.

Callback and RunPod/S3 polling are both supported, so a missed CPU callback
does not leave the GPU worker waiting indefinitely.
