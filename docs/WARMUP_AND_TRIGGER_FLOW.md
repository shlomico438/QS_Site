# Warmup and Trigger Flow — How It Works

## Short answer

**The frontend now waits for trigger confirmation** before moving to "processing": it polls `trigger_status` until RunPod has been triggered (or failed/timeout), so the UI only shows "processing" after a real handshake.

---

## Backend flow (step by step)

1. **Frontend** uploads file to S3, then `POST /api/trigger_processing` with `{ s3Key, jobId, language, ... }`.

2. **Backend** `trigger_processing()`:
   - Builds the RunPod payload (`input: { s3Key, jobId, task, language }`).
   - Sets `pending_trigger[job_id] = "queued"` and `pending_trigger_at[job_id] = now`.
   - Starts a **background daemon thread** that runs `_trigger_gpu(...)`.
   - **Immediately** returns `202` with `{"status": "started", "job_id": "..."}`.

   So the HTTP response is sent **before** the thread has done anything. The thread runs in parallel.

3. **In the thread** `_trigger_gpu(job_id, payload, endpoint_id, api_key)`:
   - **Trigger:**  
     `POST https://api.runpod.ai/v2/{endpoint_id}/run` with the payload, timeout 15s.
   - The trigger itself wakes RunPod from cold (no polling for "running").
   - On **200/201/202** → sets `pending_trigger[job_id] = "run_accepted"`.
   - On other status or **exception** (timeout, connection error, crash) → sets `pending_trigger[job_id] = "failed"`.

So the only "handshake" with RunPod is: **backend thread** → RunPod `/run` → success/failure stored in `pending_trigger[job_id]`. The frontend is not part of that handshake at the moment.

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
Remaining weak points: trigger runs in a fire-and-forget thread with no retry inside `_trigger_gpu`; the frontend now waits for confirmation (Option A) before showing "processing".

---

## Stale and retry (status polling)

The 3‑minute "stale_queued" and retry logic in the **status polling** (every ~20s) still runs after the job is in "processing", and helps if the trigger succeeded but the job never completes or other edge cases occur.

*(Option A is now implemented in the Frontend flow above.)*
