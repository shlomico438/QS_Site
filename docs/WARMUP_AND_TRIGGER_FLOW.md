# Warmup and Trigger Flow — How It Works

## Short answer

**The frontend now waits for trigger confirmation** before moving to "processing": it polls `trigger_status` until RunPod has been triggered (or failed/timeout), so the UI only shows "processing" after a real handshake.

**Speech/music profiling** runs in the **browser** during upload (Web Audio API). The client sends `clientAudioProfile` on multipart-init (when ready within ~2.5s) and on `trigger_processing`, so the Site can skip the heavy S3/ffmpeg probe and finalize VAD options quickly.

---

## Backend flow (step by step)

1. **Frontend** selects a file and starts `qsInferAudioProfileFromFile()` in parallel with upload (non-medical only).

2. **Frontend** calls `POST /api/sign-s3` or `POST /api/sign-s3-multipart-init` with optional `clientAudioProfile` and `treatAsMusic` (upload-modal checkbox). **Backend** usually starts **one** RunPod `/run` on the **real `jobId`** immediately (before upload):
   - **Music checkbox + vocal separation enabled:** **no** early GPU `/run` (avoids GPU idle billing while CPU Demucs runs). GPU `/run` fires only after vocal separation completes.
   - **Client profile present:** final `transcription_options` from profile (`defer_final_options=false`, `worker_ready=true` on early handoff).
   - **No client profile yet:** provisional speech-safe VAD (`defer_final_options=true`); worker polls `job_transcription_options` until `trigger_processing`.

3. **Frontend** uploads file to S3, then `POST /api/trigger_processing` with `{ s3Key, jobId, clientAudioProfile, ... }`. Backend resolves profile via `_resolve_audio_profile_for_job` (client first, then optional S3/ffmpeg fallback), stores **final** `transcription_options` in job handoff, sets `upload_complete`, and **does not** send a second `/run` if the early trigger is already queued.

4. **RunPod worker** waits for S3 upload readiness (`head_object` polling), then polls `GET /api/job_transcription_options?job_id=...` (or upload_status handoff) until `worker_ready=true` and options are finalized, then transcribes.

5. **In the thread** `_trigger_gpu(job_id, payload, endpoint_id, api_key)`:
   - **Trigger:**  
     `POST https://api.runpod.ai/v2/{endpoint_id}/run` with the payload, timeout 15s.
   - The trigger itself wakes RunPod from cold (no polling for "running").
   - On **200/201/202** → sets `pending_trigger[job_id] = "run_accepted"`.
   - On other status or **exception** (timeout, connection error, crash) → sets `pending_trigger[job_id] = "failed"`.

So the only "handshake" with RunPod is: **backend thread** → RunPod `/run` → success/failure stored in `pending_trigger[job_id]`. The frontend is not part of that handshake at the moment.

---

## Client audio profile (browser)

| Step | Behavior |
|------|----------|
| On file select | `qsStartClientAudioProfile(file)` — decode ~20s @ 16 kHz mono, RMS variance (same thresholds as Site `AUDIO_PROFILE_*`) |
| multipart-init | Optional `clientAudioProfile` after `Promise.race` 2500 ms with profiling promise |
| trigger_processing | Always sends `clientAudioProfile` when profiling completed |
| Medical | Profiling skipped (server skips with `medical_mode`) |

**Fallback:** If the browser cannot decode the file, Site uses `_infer_audio_profile_from_s3` when `TRANSCRIBE_CLIENT_AUDIO_PROFILE_REQUIRE` is not set (default: allow server fallback).

**Env (Site):**

- `TRANSCRIBE_CLIENT_AUDIO_PROFILE` (default `true`) — accept client payload when present.
- `TRANSCRIBE_CLIENT_AUDIO_PROFILE_REQUIRE` (default `false`) — if `true`, never S3/ffmpeg fallback when client profile missing.

API responses include `audio_profile_source`: `client`, `server_s3`, `medical_mode`, etc.

---

## Frontend flow (Option A implemented)

- Frontend gets `202` and `triggerData.status === "started"` (or `"queued"`).
- It **polls** `GET /api/trigger_status?job_id=...` every 2s until:
  - `"triggered"` → then starts `startFakeProgress()` and `check_status` polling (only then does the UI show "processing").
  - `"failed"` or `"stale_queued"` → shows error and Retry button, stops.
  - **Timeout 90s** → shows "Trigger timed out. Try again." with Retry button.
- So the UI only enters "processing" after the backend has received a successful response from RunPod.

---

## Where it can fail (not bulletproof)

| What can go wrong | Where | Frontend sees |
|-------------------|--------|----------------|
| Thread crashes before/during POST | Backend | Frontend waits up to 90s; sees `trigger_status === "failed"` or timeout → error + Retry. |
| POST timeout (15s) or network error | Backend thread | `pending_trigger = "failed"`; frontend sees "failed" within 2s on next poll → error + Retry. |
| RunPod returns 4xx/5xx | Backend thread | Same as above. |
| RunPod accepts (200) but never runs the job | RunPod | Frontend shows "processing"; status polling may eventually time out or user retries. |
| Client profile fails | Browser + Site | Server S3 probe fallback (unless `TRANSCRIBE_CLIENT_AUDIO_PROFILE_REQUIRE=true`) |

Remaining weak points: trigger runs in a fire-and-forget thread with no retry inside `_trigger_gpu`; the frontend now waits for confirmation (Option A) before showing "processing".

---

## Manual test checklist

- **Speech interview MP4:** client `speech`, `trigger_processing` fast, logs show `audio-profile (client)`, no ffmpeg stderr on trigger.
- **Music file (checkbox on):** no early GPU warmup at multipart-init; `trigger_status` → `preprocessing` during Demucs; GPU `/run` after separation (`Music vocal separation complete — dispatching GPU /run (no early upload warmup)` in logs).
- **Client decode fails:** server fallback or `unknown` → speech VAD default.
- **Medical upload:** no client profile, no regression.
- **Parallelism:** profile during S3 PUT; trigger wall time dominated by credits reserve, not profile.

---

## Stale and retry (status polling)

The 3‑minute "stale_queued" and retry logic in the **status polling** (every ~20s) still runs after the job is in "processing", and helps if the trigger succeeded but the job never completes or other edge cases occur.

*(Option A is now implemented in the Frontend flow above.)*
