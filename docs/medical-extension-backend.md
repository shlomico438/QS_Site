# Medical client backend contract

Standalone medical clients (Chrome extension and Windows Citrix helper) talk to
this API. The QuickScribe website does not need to be open. Website medical
routes are unchanged and share `process_medical_transcript`.

Chrome extension client code lives in [`chrome-extension/`](../chrome-extension/).

## Authentication and origin

- Authenticate with Supabase; send `Authorization: Bearer <token>` on HTTP
  (optional duplicate `X-QS-Access-Token`). Socket.IO start uses `access_token`.
- Never put AWS, OpenAI, Supabase service-role, or KMS credentials in a client.
- Do not send `userId`. The server derives it from the bearer token and rejects
  a conflicting supplied value.
- **Chrome extension:** set `MEDICAL_EXTENSION_IDS` to approved IDs. Socket.IO
  start payloads must include `"client": "extension"`.
- **Windows helper:** omit `Origin` (or leave it empty). Bearer + entitlement
  are enough; no extension-ID allowlist entry is required.
- Optional mic diagnostics may send `client_source` of `web`, `extension`, or
  `windows_helper` (logged only).

## Discovery

`GET /api/medical/client/v1/config`

Returns the versioned stream events, sample rate, fallback paths, finalization
path, and the allowlisted microphone error/recovery contract. It contains no
secrets. Authentication and an active medical entitlement are required.

## Recording flow

1. Keep a local `MediaRecorder` recording for the whole visit.
2. Connect Socket.IO and emit `medical_transcribe_start` with:
   - `client: "extension"`
   - `access_token`
   - the language options returned by the config endpoint
3. Send signed 16-bit mono PCM chunks through `medical_transcribe_audio`.
4. Handle `medical_transcribe_event` partial/final/error events.
5. On Stop, emit `medical_transcribe_stop`.
6. If streaming remained healthy, call
   `POST /api/medical/client/v1/finalize` with the final transcript, duration,
   `jobId`, `s3Key`, and optional segments.
7. If Socket.IO failed or closed, keep recording. Upload the completed blob to
   `/api/medical/archive_recording`, recover the full missing interval with
   `/api/medical/transcribe_gaps`, then call the same finalization endpoint.

`jobId` is the retry/idempotency key. Medical usage recording is idempotent for
that job ID.

## Structured result

Successful `POST /api/medical/client/v1/finalize` and
`POST /api/medical/client/v1/process` responses contain:

```json
{
  "ok": true,
  "jobId": "opaque-job-id",
  "correctedTranscript": "...",
  "sections": {
    "medical_chief_complaint": "...",
    "medical_examination_transcript": "...",
    "medical_patient_recommendations": "..."
  },
  "formatGuardrail": null
}
```

Both endpoints call the same `process_medical_transcript` function used by the
website. The extension must map these stable section keys to Clicks fields; it
must not implement correction or summarization itself.

## Microphone errors

Use `POST /api/medical/mic-event` and the existing recovery endpoint. Allowed
causes are `no_mic`, `chrome_block`, `os_block`, `busy`, `hw_mute`,
`dead_device`, `device_lost`, `too_quiet`, and `overconstrained`. Phases are
`start` and `recording`. Optional allowlisted fields: `client_source`
(`web`|`extension`|`windows_helper`) and `client_version` (opaque `1.0.0`-style
string). They are logged only and never stored with PHI. Do not include transcript, summary,
patient data, or raw browser errors.

## Retry and error rules

- `401 medical_auth_required`: refresh/login, then retry.
- `403` entitlement reason: stop recording submission and show the account
  action required.
- `403 extension_origin_not_allowed`: deployment configuration is missing the
  extension ID.
- `428 medical_onboarding_required`: complete medical onboarding.
- `429 mic_event_rate_limited`: stop sending diagnostic events for the hour.
- `502 medical_processing_failed`: transcription may already be finalized;
  retry `/process` with the same `jobId` and transcript.
- `503 medical_entitlement_unavailable`: retry with bounded backoff.

Never log request bodies. Temporary local or derived server audio is deleted at
the end of processing; retained source objects use the same medical bucket,
prefix, encryption, and lifecycle policy as the website.
