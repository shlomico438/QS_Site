# QuickScribe Medical Chrome Extension

Side-panel client for clinic software (e.g. Clicks). Doctors start/stop a visit
here; audio goes to the QuickScribe medical backend; structured sections come
back for field fill.

The website does **not** need to be open.

**Note:** Backend contract is `/api/medical/client/v1/*` (shared with the Windows
Citrix helper). See `docs/medical-extension-backend.md`. Set
`MEDICAL_EXTENSION_IDS` for Chrome origins; desktop clients authenticate with
Bearer only.

## Install (developer)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → choose this `chrome-extension` folder
4. Copy the extension **ID**
5. On the server set:

```text
MEDICAL_EXTENSION_IDS=<that-id>
```

6. Restart / redeploy the Site backend
7. Pin the extension and open the **side panel**

## Doctor flow

1. **First time:** leave QuickScribe open and signed in, then open the extension —
   it imports that session (or click **ייבא מהאתר הפתוח**). After that the site
   can stay closed. Manual email/password login still works as a fallback.
2. Open Clicks (or the clinic page) in a normal tab
3. Press **התחל** — live raw transcript appears in the panel
4. Press **עצור** — backend finalizes and returns sections
5. Press **מלא בשדות** — fills matching fields in the active tab

If Socket.IO drops, recording continues locally; on Stop the extension archives
the blob, recovers gaps, then finalizes the same way as the website.

Live audio still uses the extension’s own Socket.IO connection (not the website’s
page socket). Only the **login session** is imported from the open site.

## Files

| Path | Role |
|---|---|
| `sidepanel.*` | UI: login, Start/Stop, live transcript, sections |
| `lib/session.js` | Visit orchestration (stream + fallback + finalize) |
| `lib/stream.js` | Socket.IO live PCM |
| `lib/recorder.js` | MediaRecorder + PCM tap |
| `lib/mic.js` | Mic error classify / report / recover |
| `lib/api.js` | Authenticated backend calls |
| `content/clicks.js` | Heuristic fill of labeled clinic fields |
| `config.js` | Public API + Supabase anon settings only |

## Notes

- No AWS / OpenAI / service-role secrets in the extension
- Mic diagnostics reuse `/api/medical/mic-event` with `client_source=extension`
- Clicks DOM differs by site/version; if auto-fill misses, copy from the panel
- For local backend testing, set API base under **הגדרות מתקדמות** to
  `http://127.0.0.1:8000` (origin only — no `/medical` path)
