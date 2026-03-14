# GPU Callback API — Bulletproof contract (Site ↔ app_transcribe.py)

This document defines the contract between **QuickScribe Site** (Flask) and the **RunPod worker** (app_transcribe.py) so we know for sure that the app has **received and stored** the result, not only that RunPod started the job.

---

## 1. Trigger payload (Site → RunPod → worker)

When the Site calls RunPod `/run`, it sends an `input` object. The worker receives this and **must** use it to know where to POST the result:

- **`callback_url`** (string) — Full URL to POST the result. Example: `https://your-app.koyeb.app/api/gpu_callback`
- **`jobId`** (string) — Job id; must be sent back in the callback body.
- **`s3Key`** (string) — Input file S3 key (used by Site to build output path).
- **`task`**, **`language`** — Optional; for worker logic.

The worker **must** POST to `callback_url` when done; only when it receives **200 and `ok: true`** should it consider the job “delivered”.

---

## 2. Callback request (worker → Site)

**Endpoint:** `POST <callback_url>` (e.g. `POST /api/gpu_callback`)

**Headers:** `Content-Type: application/json`

**Body (JSON):**

- **`jobId`** (string, required) — Same as in trigger input.
- **`segments`** (array, required) — List of segment objects `{ start, end, text [, speaker] }`.
- **`result`** (object, optional) — Can contain `segments`; if present it is used.
- **`input`** (object, optional) — If worker echoes input, can include `s3Key`, `jobId` for fallback.

Minimum valid body:

```json
{
  "jobId": "abc-123",
  "segments": [
    { "start": 0.0, "end": 2.5, "text": "Hello" }
  ]
}
```

Or with `result` and optional `timing` (for PROCESS TIMING summary):

```json
{
  "jobId": "abc-123",
  "result": {
    "segments": [
      { "start": 0.0, "end": 2.5, "text": "Hello" }
    ],
    "timing": {
      "download_sec": 2.1,
      "wakeup_sec": 5.0,
      "transcribe_sec": 28.5,
      "gpt_sec": 4.2
    }
  }
}
```

- **`result.timing`** (optional) — If present, Site includes these in the PROCESS TIMING table:
  - **`download_sec`** — Time from trigger to download complete (worker fetching file from S3).
  - **`wakeup_sec`** — Time from download complete to runpod start (model load, etc.). If omitted, Site infers from `waiting_for_run - download_sec`.
  - **`transcribe_sec`**, **`gpt_sec`** — Optional breakdown of runpod process time.

---

## 3. Callback response (Site → worker)

The Site returns **200 only after** it has:

1. Validated `jobId` and `segments`.
2. Saved the raw result to S3 (when `input_s3_key` is known).
3. Stored the result in cache and emitted to the frontend.

**Success (200):**

```json
{
  "ok": true,
  "received": true,
  "job_id": "abc-123",
  "stage": "raw_saved",
  "raw_result_s3_key": "users/xxx/output/yyy_raw.json"
}
```

- **`ok: true`** — The app has accepted and stored the result. Worker should treat the job as **successfully delivered** only when it gets **200** and **`ok === true`**.
- **`raw_result_s3_key`** — Present when the result was written to S3; may be `null` if no input key was available.

**Client error (400):**

- Missing `jobId`: `{ "ok": false, "error": "jobId required" }`
- Invalid `segments`: `{ "ok": false, "error": "segments must be an array" }`

**Server error (500):**

- Save to S3 failed: `{ "ok": false, "error": "Failed to save result", "detail": "..." }`  
  The worker **should retry** (with backoff) when it gets **non-200** or **`ok: false`**.

---

## 4. Worker implementation requirements (app_transcribe.py)

1. Read **`callback_url`** and **`jobId`** (and optionally **`s3Key`**) from the RunPod job input.
2. After transcription, POST to **`callback_url`** with body `{ "jobId": job_id, "segments": segments }` (and optionally `result: { segments }` or `input: { s3Key, jobId }`).
3. **Check the response:**
   - If **status code 200** and **`response.json().get("ok") is True`** → consider the job **delivered**; exit success.
   - Otherwise → **retry** (e.g. 3 attempts with backoff). If all fail, exit failure so RunPod can retry the job.

Example (pseudo-code):

```python
import requests

def send_callback(callback_url: str, job_id: str, segments: list, s3_key: str = None) -> bool:
    payload = {
        "jobId": job_id,
        "segments": segments,
        "input": {"s3Key": s3_key, "jobId": job_id} if s3_key else None,
    }
    for attempt in range(1, 4):
        try:
            r = requests.post(callback_url, json=payload, timeout=60)
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            if r.status_code == 200 and body.get("ok") is True:
                return True
        except Exception as e:
            log.warning("Callback attempt %s failed: %s", attempt, e)
        time.sleep(2 ** attempt)
    return False
```

---

## 5. Frontend (app_logic.js)

No change required for the contract. The frontend already:

- Receives **`job_status_update`** (Socket.IO) when the Site has stored the result and emitted.
- Polls **`GET /api/check_status/<job_id>`** as fallback; the Site returns the cached result (with `status: "completed"`) once the callback has been accepted.

So “we know for sure the app has uploaded successfully” is guaranteed by: **worker only considers success when callback returns 200 + ok: true**, and **Site only returns that after persistence**.
