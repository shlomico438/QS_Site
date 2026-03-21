from gevent import monkey
monkey.patch_all()

# Load .env so GPT_API_KEY (and others) are available for simulation and translate_segments
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room
import json
import requests  # Added for RunPod API calls
import time
import logging
import boto3
import os
import re
import subprocess
import shutil
import sys
import tempfile
import threading
import uuid
import pathlib

# python-docx imports for server-side RTL post-processing
from docx import Document as DocxDocument
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn


# --- CONFIGURATION ---
# Read simulation flag from environment. Default True for local dev (F5); set SIMULATION_MODE=0 or false in production (e.g. Koyeb).
SIMULATION_MODE = str(os.environ.get('SIMULATION_MODE', 'true')).lower() in ('1', 'true', 'yes')

# App root (for Node translate script)
APP_ROOT = pathlib.Path(__file__).resolve().parent
TRANSLATE_SCRIPT = APP_ROOT / 'scripts' / 'translate.js'

S3_BUCKET = os.environ.get("S3_BUCKET")

app = Flask(__name__) 
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# Configuration for automation
RUNPOD_API_KEY = os.environ.get('RUNPOD_API_KEY')
RUNPOD_ENDPOINT_ID = os.environ.get('RUNPOD_ENDPOINT_ID')
RUNPOD_MOVIE_ENDPOINT_ID = os.environ.get('RUNPOD_MOVIE_ENDPOINT_ID') or RUNPOD_ENDPOINT_ID
BUCKET_NAME = "quickscribe-v2-12345"


def _public_base_url(req):
    """Best-effort public base URL for third-party callbacks (RunPod -> site)."""
    explicit = (os.environ.get('PUBLIC_BASE_URL') or '').strip().rstrip('/')
    if explicit:
        return explicit
    root = (req.url_root or '').rstrip('/')
    xfp = (req.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip().lower()
    # Behind reverse proxies, Flask may see http internally. Prefer https for public hosts.
    if root.startswith('http://') and (xfp == 'https' or str(req.host or '').endswith('getquickscribe.com')):
        root = 'https://' + root[len('http://'):]
    return root



# Strict settings to keep connections alive
socketio = SocketIO(app,
    cors_allowed_origins="*",
    async_mode='gevent',
    transports=['websocket'],
    ping_timeout=600,
    ping_interval=20,
    manage_session=False
)

# --- GLOBAL CACHE ---
job_results_cache = {}

logging.basicConfig(level=logging.INFO)

print(f"SIMULATION_MODE is {SIMULATION_MODE}")
if not SIMULATION_MODE:
    BASE_DIR = pathlib.Path(__file__).resolve().parent
    ffmpeg_path = BASE_DIR / "bin" / "ffmpeg"
    ffprobe_path = BASE_DIR / "bin" / "ffprobe"
    try:
        if ffmpeg_path.exists():
            os.chmod(ffmpeg_path, 0o755)
        if ffprobe_path.exists():
            os.chmod(ffprobe_path, 0o755)
        if ffmpeg_path.exists():
            subprocess.run([str(ffmpeg_path), "-version"], check=True, timeout=5)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError) as e:
        logging.warning("ffmpeg check skipped or failed (app will start; burn-in may fail): %s", e)


@app.route('/api/get_presigned_url', methods=['POST'])
def get_presigned_url():
    try:
        data = request.json or {}
        s3_key = data.get('s3Key')
        user_id = data.get('userId') or data.get('user_id')

        if not s3_key:
            return jsonify({"error": "No s3Key provided"}), 400

        # Per-user keys: only allow access to users/{user_id}/...
        if s3_key.startswith("users/"):
            if not user_id:
                return jsonify({"error": "userId required for user-scoped keys"}), 400
            if not s3_key.startswith(f"users/{user_id}/"):
                return jsonify({"error": "Access denied: key does not belong to user"}), 403

        s3_client = boto3.client(
            's3',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
            region_name=os.environ.get('AWS_REGION')
        )
        params = {
            'Bucket': os.environ.get('S3_BUCKET'),
            'Key': s3_key
        }
        # Serve .mov with video/mp4 so Chrome/Firefox use MP4 decoder (many .mov are H.264)
        if s3_key and s3_key.lower().endswith('.mov'):
            params['ResponseContentType'] = 'video/mp4'
        url = s3_client.generate_presigned_url(
            'get_object',
            Params=params,
            ExpiresIn=3600
        )

        return jsonify({"url": url})

    except Exception as e:
        print(f"S3 Error: {str(e)}")
        return jsonify({"error": str(e)}), 500


def _derive_output_key_base(user_id, input_s3_key):
    """Base path (without suffix) for storing transcript JSON derived from input_s3_key."""
    if not input_s3_key:
        base_name = 'output'
        return f"users/{user_id or 'anonymous'}/output/{base_name}"
    if '/input/' in input_s3_key:
        # users/{id}/input/name.mp4 -> users/{id}/output/name
        return input_s3_key.replace('/input/', '/output/', 1).rsplit('.', 1)[0]
    # Fallback: derive from filename
    base_name = input_s3_key.rsplit('/', 1)[-1].rsplit('.', 1)[0] or 'output'
    if input_s3_key.startswith('users/'):
        # Preserve user prefix from path if present
        parts = input_s3_key.split('/', 2)
        if len(parts) >= 2:
            user_part = parts[1]
            return f"users/{user_part}/output/{base_name}"
    return f"users/{user_id or 'anonymous'}/output/{base_name}"


def _put_segments_json_to_s3(user_id, input_s3_key, segments, stage='gpt'):
    """Low-level helper to write segments JSON for a given processing stage.

    stage: 'raw' (Ivrit-AI output) or 'gpt' (post-processed).
    """
    if segments is None:
        raise ValueError("segments is required")
    if not isinstance(segments, list):
        raise ValueError("segments must be an array")
    return _put_transcript_json_to_s3(user_id, input_s3_key, {"segments": segments}, stage=stage)


def _flatten_words_from_segments(segments):
    """Flatten WhisperX-style segment words into flat words[] + captions[].

    Returns (words, captions) if word timestamps exist, else (None, None).
    """
    if not isinstance(segments, list) or not segments:
        return None, None
    words = []
    captions = []
    wi = 0
    for si, seg in enumerate(segments):
        if not isinstance(seg, dict):
            continue
        seg_words = seg.get("words")
        if not isinstance(seg_words, list) or len(seg_words) == 0:
            continue
        start_index = wi
        for w in seg_words:
            if not isinstance(w, dict):
                continue
            text = (w.get("word") if w.get("word") is not None else w.get("text")) or ""
            start = w.get("start")
            end = w.get("end")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
                # If ANY word is missing timing, we can't build a timing-safe word model.
                return None, None
            words.append({
                "id": f"w{wi}",
                "text": str(text),
                "start": float(start),
                "end": float(end),
            })
            wi += 1
        end_index = wi - 1
        if end_index >= start_index:
            captions.append({
                "id": f"c{len(captions)}",
                "wordStartIndex": int(start_index),
                "wordEndIndex": int(end_index),
            })
    if len(words) == 0 or len(captions) == 0:
        return None, None
    return words, captions


def _put_transcript_json_to_s3(user_id, input_s3_key, transcript, stage='gpt'):
    """Low-level helper to write transcript JSON for a given processing stage.

    transcript can include:
      - segments: legacy list[{start,end,text,...}]
      - words: flat list[{id,text,start,end}]
      - captions: list[{id,wordStartIndex,wordEndIndex}]
    """
    if transcript is None or not isinstance(transcript, dict):
        raise ValueError("transcript must be an object")
    base = _derive_output_key_base(user_id, input_s3_key)
    stage = (stage or 'gpt').strip().lower()
    if stage == 'raw':
        result_s3_key = base + '_raw.json'
    else:
        # Keep existing naming for GPT so older data remains compatible.
        result_s3_key = base + '.json'

    body = json.dumps(transcript, ensure_ascii=False).encode('utf-8')
    s3_client = boto3.client(
        's3',
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        region_name=os.environ.get('AWS_REGION')
    )
    s3_client.put_object(
        Bucket=os.environ.get('S3_BUCKET'),
        Key=result_s3_key,
        Body=body,
        ContentType='application/json'
    )
    return result_s3_key


@app.route('/api/save_job_result', methods=['POST'])
def save_job_result():
    """Save transcript JSON to S3; return the result_s3_key. Store only the key in DB, not the full JSON."""
    try:
        data = request.json or {}
        user_id = data.get('userId') or data.get('user_id')
        input_s3_key = data.get('input_s3_key') or data.get('s3Key')
        segments = data.get('segments')
        words = data.get('words')
        captions = data.get('captions')
        stage = (data.get('stage') or 'gpt').strip().lower()
        if not user_id or not input_s3_key:
            return jsonify({"error": "userId and input_s3_key (or s3Key) required"}), 400

        transcript = {}
        if segments is not None:
            if not isinstance(segments, list):
                return jsonify({"error": "segments must be an array"}), 400
            transcript["segments"] = segments
        if words is not None:
            if not isinstance(words, list):
                return jsonify({"error": "words must be an array"}), 400
            transcript["words"] = words
        if captions is not None:
            if not isinstance(captions, list):
                return jsonify({"error": "captions must be an array"}), 400
            transcript["captions"] = captions

        if "segments" not in transcript and "words" not in transcript:
            return jsonify({"error": "segments or words required"}), 400

        # If client didn't send words/captions but segments include word timestamps, derive them server-side.
        if "words" not in transcript and "segments" in transcript:
            w, c = _flatten_words_from_segments(transcript["segments"])
            if w is not None and c is not None:
                transcript["words"] = w
                transcript["captions"] = c

        result_s3_key = _put_transcript_json_to_s3(user_id, input_s3_key, transcript, stage=stage)
        return jsonify({"result_s3_key": result_s3_key})
    except Exception as e:
        logging.exception("save_job_result failed")
        return jsonify({"error": str(e)}), 500


@app.route('/api/delete_job', methods=['POST'])
def delete_job():
    """Delete a job from the DB by id and user_id. Uses Supabase service role so delete succeeds even if RLS blocks client."""
    try:
        data = request.json or {}
        job_id = data.get('jobId') or data.get('job_id')
        user_id = data.get('userId') or data.get('user_id')
        if not job_id or not user_id:
            return jsonify({"error": "jobId and userId required", "deleted": False}), 400
        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not service_key:
            return jsonify({"error": "Server not configured for delete (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)", "deleted": False}), 503
        url = f"{supabase_url}/rest/v1/jobs?id=eq.{job_id}&user_id=eq.{user_id}"
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        r = requests.delete(url, headers=headers, timeout=10)
        if r.status_code in (200, 204):
            deleted = []
            if r.text:
                try:
                    deleted = r.json()
                except Exception:
                    pass
            if isinstance(deleted, list) and len(deleted) > 0:
                return jsonify({"deleted": True})
            if r.status_code == 204:
                return jsonify({"deleted": True})
            return jsonify({"error": "No row deleted", "deleted": False}), 404
        return jsonify({"error": r.text or f"HTTP {r.status_code}", "deleted": False}), r.status_code
    except Exception as e:
        logging.exception("delete_job failed")
        return jsonify({"error": str(e), "deleted": False}), 500


@app.route('/api/delete_account', methods=['POST'])
def delete_account():
    """Erase the current user's account: delete all their jobs, then delete the user from Auth. Requires Authorization: Bearer <access_token>."""
    try:
        auth_header = request.headers.get('Authorization') or ''
        token = auth_header.replace('Bearer ', '').strip() if auth_header.startswith('Bearer ') else (request.json or {}).get('access_token', '').strip()
        if not token:
            return jsonify({"error": "Authorization required (Bearer token or access_token in body)"}), 401
        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not service_key:
            return jsonify({"error": "Server not configured for account deletion"}), 503
        # Validate token and get user id
        r_user = requests.get(
            f"{supabase_url}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": service_key},
            timeout=10
        )
        if r_user.status_code != 200:
            return jsonify({"error": "Invalid or expired token"}), 401
        try:
            user_data = r_user.json()
            user_id = (user_data.get('id') or user_data.get('user', {}).get('id') or '').strip()
        except Exception:
            return jsonify({"error": "Invalid user response"}), 401
        if not user_id:
            return jsonify({"error": "User id not found"}), 401
        # Delete all jobs for this user
        jobs_url = f"{supabase_url}/rest/v1/jobs?user_id=eq.{user_id}"
        requests.delete(
            jobs_url,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
            },
            timeout=30
        )
        # Delete user from Auth (admin)
        r_del = requests.delete(
            f"{supabase_url}/auth/v1/admin/users/{user_id}",
            headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
            timeout=10
        )
        if r_del.status_code not in (200, 204):
            return jsonify({"error": r_del.text or f"Failed to delete user ({r_del.status_code})"}), r_del.status_code
        return jsonify({"deleted": True}), 200
    except Exception as e:
        logging.exception("delete_account failed")
        return jsonify({"error": str(e)}), 500


# --- MOCK ROUTE FOR LOCAL DEBUGGING ---
@app.route('/api/mock-upload', methods=['PUT'])
def mock_upload():
    print("SIMULATION: Fake file upload received!")
    return "", 200

@app.after_request
def add_security_headers(resp):
    # Use credentialless so cross-origin S3 media can load (S3 does not send CORP).
    # require-corp would block presigned S3 URLs with NotSameOriginAfterDefaultedToSameOriginByCoep.
    resp.headers['Cross-Origin-Embedder-Policy'] = 'credentialless'
    resp.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    return resp

@app.errorhandler(413)
def request_entity_too_large(error):
    return jsonify({"status": "error", "message": "File too large. Max 500MB."}), 413

@app.errorhandler(Exception)
def handle_exception(e):
    if hasattr(e, 'code'):
        return jsonify({"status": "error", "message": str(e.description)}), e.code
    logging.error(f"Unexpected Server Error: {str(e)}")
    return jsonify({"status": "error", "message": "Internal server error."}), 500

# --- WEB ROUTES ---
@app.route('/')
def index(): return render_template('index.html')

@app.route('/about')
def about(): return render_template('about.html')

@app.route('/blog')
def blog(): return render_template('blog.html')

@app.route('/contact')
def contact():
    return render_template('contact.html')


@app.route('/history')
def history():
    return render_template('history.html')


@app.route('/personal')
def personal():
    return render_template('personal.html')


@app.route('/legal')
def legal():
    return render_template('legal.html')

# --- UPLOAD & TRIGGER API ---
import time  # Ensure time is imported at the top of your file

# Job is queued until GPU warmup finishes, then we trigger RunPod. Frontend polls trigger_status.
# States:
# - "queued": we accepted the trigger request and are about to call RunPod /run
# - "run_accepted": RunPod /run returned 200/201/202 (container should start soon)
# - "triggered": app_transcribe.py has started and called /api/gpu_started
# - "failed": RunPod /run failed or warmup/trigger crashed
pending_trigger = {}  # job_id -> "queued" | "run_accepted" | "triggered" | "failed"
pending_trigger_at = {}  # job_id -> time when set to "queued" (for stale detection)
STALE_QUEUED_SEC = 180  # if still "queued" after this, treat as stale and allow retry
# So gpu_callback can save raw JSON even when RunPod does not echo input: job_id -> { input_s3_key, user_id, task, language }
pending_job_info = {}  # job_id -> {"input_s3_key": str, "user_id": str | None, "task": str, "language": str}
job_timings = {}  # job_id -> {"trigger_sec": float, "trigger_completed_at": float}
gpu_started_at = {}  # job_id -> when worker called /api/gpu_started (container running)
upload_complete = {}  # job_id -> True when trigger_processing called (upload done); worker polls until this


def _trigger_state_dir():
    """Directory for shared trigger state (survives across Gunicorn workers)."""
    d = (os.environ.get('TRIGGER_STATE_DIR') or '').strip() or os.path.join(tempfile.gettempdir(), 'qs_trigger')
    try:
        os.makedirs(d, mode=0o700, exist_ok=True)
    except OSError:
        pass
    return d


def _trigger_state_path(job_id):
    """Safe file path for one job's trigger state."""
    safe = re.sub(r'[^\w\-]', '_', str(job_id))[:200]
    return os.path.join(_trigger_state_dir(), f"{safe}.json")


def _get_trigger_state(job_id):
    """Return (status, at_ts) from shared store, or (None, None) if missing."""
    try:
        path = _trigger_state_path(job_id)
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return (data.get('status'), data.get('at'))
    except Exception:
        pass
    return (None, None)


def _set_trigger_state(job_id, status, **extra):
    """Write trigger state so all workers see it. Merges with existing to preserve timings."""
    try:
        path = _trigger_state_path(job_id)
        data = {}
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        data.update({"status": status, "at": time.time(), **extra})
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    except Exception as e:
        logging.warning("Could not write trigger state for %s: %s", job_id, e)


def _get_trigger_timings(job_id):
    """Read timing fields from shared file (for multi-worker)."""
    try:
        path = _trigger_state_path(job_id)
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return {
                "queued_at": data.get("queued_at") or data.get("at"),
                "trigger_sec": data.get("trigger_sec"),
                "trigger_completed_at": data.get("trigger_completed_at"),
                "gpu_started_at": data.get("gpu_started_at"),
            }
    except Exception:
        pass
    return {}


def _update_trigger_timings(job_id, **updates):
    """Merge timing fields into trigger state file (preserves existing)."""
    try:
        path = _trigger_state_path(job_id)
        data = {}
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        data.update(updates)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    except Exception as e:
        logging.warning("Could not update trigger timings for %s: %s", job_id, e)


def _set_last_callback_for_gpt(job_id: str, at: float, user_id: str = None) -> None:
    """Store last gpu_callback job so api_translate_segments can infer GPT timing."""
    try:
        path = os.path.join(_trigger_state_dir(), "last_callback.json")
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({"job_id": job_id, "at": at, "user_id": user_id}, f)
    except Exception as e:
        logging.warning("Could not set last_callback_for_gpt: %s", e)


def _get_last_callback_for_gpt() -> tuple:
    """Return (job_id, callback_at, user_id) for inferring GPT timing, or (None, None, None)."""
    try:
        path = os.path.join(_trigger_state_dir(), "last_callback.json")
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return (data.get("job_id"), data.get("at"), data.get("user_id"))
    except Exception:
        pass
    return (None, None, None)


def _get_job_timings_from_db(runpod_job_id: str, user_id: str = None) -> dict:
    """Fetch current timing columns from jobs table (for cross-instance reads)."""
    supabase_url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not service_key:
        return {}
    from urllib.parse import quote
    rj = quote(str(runpod_job_id), safe='')
    url = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj}&select=trigger_sec,trigger_completed_at,gpu_started_at,runpod_wakeup_sec"
    if user_id:
        url += f"&user_id=eq.{quote(str(user_id), safe='')}"
    try:
        r = requests.get(url, headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"}, timeout=5)
        if r.status_code == 200 and r.text:
            rows = r.json()
            if isinstance(rows, list) and len(rows) > 0:
                return rows[0] or {}
    except Exception:
        pass
    return {}


def _update_job_timings(runpod_job_id: str, user_id: str = None, **timings) -> None:
    """Update jobs table with PROCESS TIMING data. Matches by runpod_job_id column or metadata.job_id."""
    supabase_url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not service_key:
        logging.warning("_update_job_timings: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set, skipping")
        return
    payload = {k: v for k, v in timings.items() if v is not None}
    if not payload:
        logging.debug("_update_job_timings: no values to update for %s", runpod_job_id)
        return
    from urllib.parse import quote
    # PostgREST: string values in eq filter need double quotes for reliability
    rj_quoted = quote(f'"{runpod_job_id}"', safe='')
    rj = quote(str(runpod_job_id), safe='')
    uid = quote(str(user_id), safe='') if user_id else None
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    try:
        # Prefer runpod_job_id column; use eq."value" for string match
        url = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj_quoted}"
        if uid:
            url += f"&user_id=eq.{uid}"
        r = requests.patch(url, json=payload, headers=headers, timeout=10)
        if r.status_code in (200, 204):
            updated = r.json() if r.text else []
            if isinstance(updated, list) and len(updated) > 0:
                logging.info("_update_job_timings: updated job %s with %s (%d rows)", runpod_job_id, list(payload.keys()), len(updated))
                return
            logging.warning("_update_job_timings: PATCH 200 but 0 rows matched for %s (filter: runpod_job_id=eq.%s)", runpod_job_id, rj_quoted[:50])
        # Fallback 1: try unquoted value
        url_alt = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj}"
        if uid:
            url_alt += f"&user_id=eq.{uid}"
        r2 = requests.patch(url_alt, json=payload, headers=headers, timeout=10)
        if r2.status_code in (200, 204):
            updated2 = r2.json() if r2.text else []
            if isinstance(updated2, list) and len(updated2) > 0:
                logging.info("_update_job_timings: updated job %s (fallback unquoted) with %s", runpod_job_id, list(payload.keys()))
                return
        # Fallback 2: runpod_job_id only (no user_id) in case UUID filter fails
        if uid:
            url_no_uid = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj}"
            r3 = requests.patch(url_no_uid, json=payload, headers=headers, timeout=10)
            if r3.status_code in (200, 204):
                updated3 = r3.json() if r3.text else []
                if isinstance(updated3, list) and len(updated3) > 0:
                    logging.info("_update_job_timings: updated job %s (no user_id) with %s", runpod_job_id, list(payload.keys()))
                    return
        # Fallback 3: GET job by runpod_job_id, then PATCH by id (most reliable)
        for rj_try in (rj, rj_quoted):
            get_url = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj_try}&select=id"
            get_r = requests.get(get_url, headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"}, timeout=5)
            if get_r.status_code == 200 and get_r.text:
                rows = get_r.json()
                if isinstance(rows, list) and len(rows) > 0 and rows[0].get("id"):
                    job_uuid = rows[0]["id"]
                    patch_url = f"{supabase_url}/rest/v1/jobs?id=eq.{job_uuid}"
                    r4 = requests.patch(patch_url, json=payload, headers=headers, timeout=10)
                    if r4.status_code in (200, 204):
                        updated4 = r4.json() if r4.text else []
                        if isinstance(updated4, list) and len(updated4) > 0:
                            logging.info("_update_job_timings: updated job %s (by id) with %s", runpod_job_id, list(payload.keys()))
                            return
                    break
        logging.warning("_update_job_timings: all attempts failed for %s. Last: %s %s", runpod_job_id, r.status_code, r.text[:200] if r.text else "")
    except Exception as e:
        logging.warning("Could not update job timings for %s: %s", runpod_job_id, e)


def get_runpod_endpoint_status(pod_id):
    """GET RunPod endpoint status via REST API. Returns dict with endpoint info and optional workers.
    Uses rest.runpod.io/v1/endpoints (management API), not api.runpod.ai/v2 (run API)."""
    if not RUNPOD_API_KEY or not pod_id:
        return {}
    url = f"https://rest.runpod.io/v1/endpoints/{pod_id.strip()}?includeWorkers=true"
    headers = {"Authorization": f"Bearer {RUNPOD_API_KEY}", "Content-Type": "application/json"}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            return r.json() or {}
    except Exception as e:
        logging.warning("get_runpod_endpoint_status: %s", e)
    return {}


def trigger_gpu_job(job_id, s3_key, num_speakers, language, task):
    data = []
    """Initiates the RunPod Serverless task with 5 parameters and retry logic."""
    if not RUNPOD_API_KEY or not RUNPOD_ENDPOINT_ID:
        error_text = "RunPod keys not found in environment variables."
        print(f"ERROR: {error_text}")
        raise Exception(error_text)

    url = f"https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/run"
    headers = {
        "Authorization": f"Bearer {RUNPOD_API_KEY}",
        "Content-Type": "application/json"
    }

    # --- SMART PROMPT LOGIC ---
    # "Primes" the AI to stick to the correct output language
    if task == "translate":
        # Force it to think in English
        prompt = "Here is the complete English translation of the Hebrew interview."
    else:
        # Force it to stay in Hebrew (helps with technical terms)
        prompt = "讛谞讛 转诪诇讜诇 诪诇讗 砖诇 讛砖讬讞讛 讘注讘专讬转, 讻讜诇诇 驻讬住讜拽 诪讚讜讬拽."

    # 3. Build RunPod Payload
    payload = {
        "input": {
            "jobId": data.get('jobId'),
            "s3Key": data.get('s3Key'),
            "task": data.get('task', 'transcribe'),
            "language": data.get('language', 'he'),
            "num_speakers": int(data.get('speakerCount', 2)),
            "diarization": data.get('diarization', False),
            
            # --- NEW CONTROLS FOR SONGS ---
            "vad_onset": 0.5,               # Higher = needs clearer speech to start a subtitle
            "vad_offset": 0.363,            # Standard offset for ending a segment
            "min_silence_duration_ms": 750, # Ignore silence/music gaps shorter than 1 sec
            "chunk_size": 30,               # Standard 30s chunks help alignment
            "word_timestamps": True,        # Vital for precise burning of subtitles
            "max_line_width": 50,           # Limits each line to ~50 characters
            "max_line_count": 2,            # Usually best to keep to 1 or 2 lines
        }
    }
    max_retries = 3
    last_error = ""

    for attempt in range(1, max_retries + 1):
        try:
            print(f"DEBUG: Triggering GPU Attempt {attempt}/{max_retries} for {job_id}...")
            response = requests.post(url, json=payload, headers=headers, timeout=30)

            if response.status_code in [200, 201]:
                print(f"GPU TRIGGERED SUCCESSFULLY: {response.json()}")
                return
            else:
                last_error = f"Status {response.status_code}: {response.text}"
                print(f"DEBUG: Attempt {attempt} failed - {last_error}")

        except Exception as e:
            last_error = str(e)
            print(f"DEBUG: Attempt {attempt} Exception - {last_error}")

        if attempt < max_retries:
            time.sleep(1)

    raise Exception(f"Failed to trigger GPU after {max_retries} attempts. Last error: {last_error}")


# --- Add this to app.py ---

@app.route('/api/check_status/<job_id>', methods=['GET'])
def check_job_status(job_id):
    # Never return a hard-coded fake transcript here.
    # check_status should only return actual cached result if available.
    # Check the global cache we created earlier
    if job_id in job_results_cache:
        print(f"馃攷 Client checked status for {job_id} -> Found completed result!")
        return jsonify(job_results_cache[job_id])

    # If not in cache, it's still processing (or lost, but let's assume processing)
    return jsonify({"status": "processing"}), 202

# --- GPU FEEDBACK API ---
def _translate_segments_via_python_openai(segments, target_lang='he'):
    """Fallback path when Node.js is unavailable: call OpenAI directly from Python."""
    api_key = (os.environ.get('GPT_API_KEY') or os.environ.get('OPENAI_API_KEY') or '').strip()
    # gpt-4o-mini is much cheaper than gpt-4o; set GPT_MODEL=gpt-4o for highest quality
    model = (os.environ.get('GPT_MODEL') or 'gpt-4o-mini').strip()
    fallback_model = (os.environ.get('GPT_FALLBACK_MODEL') or 'gpt-4o').strip()
    chunk_size = int(os.environ.get('GPT_CHUNK_SIZE', '30') or 30)
    timeout_sec = int(os.environ.get('GPT_TIMEOUT_SEC', '90') or 90)

    out = []
    ok_count = 0
    empty_count = 0
    error_count = 0
    changed_count = 0
    first_error = ''
    model_used = model

    def _extract_json_text(s):
        t = str(s or '').strip()
        t = re.sub(r'^```json\s*', '', t, flags=re.IGNORECASE)
        t = re.sub(r'^```\s*', '', t)
        t = re.sub(r'```$', '', t)
        return t.strip()

    def _process_chunk(items):
        nonlocal ok_count, empty_count, error_count, changed_count, first_error
        batch_input = {
            "results": [{"id": i, "text": str(seg.get("text") or "").strip()} for i, seg in enumerate(items)]
        }
        system_prompt = (
            "You are an expert transcript correction engine. "
            "Return ONLY valid JSON with this exact shape: {\"results\":[{\"id\":number,\"text\":string}]}. "
            "Do not add extra keys. Do not translate. Preserve original language and writing direction (RTL/LTR). "
            "Do not add explanations. Fix obvious transcription errors only."
        )
        user_prompt = (
            f"Target language hint: {target_lang or 'he'}.\n\n"
            "Fix the text values and return the exact same JSON structure with same ids.\n\n"
            f"{json.dumps(batch_input, ensure_ascii=False)}"
        )
        def _request_with_model(model_name):
            payload = {
                "model": model_name,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            }
            resp = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=timeout_sec,
            )
            if resp.status_code >= 400:
                # Keep response body in the error to understand model/endpoint incompatibilities.
                body_preview = (resp.text or "").strip()
                if len(body_preview) > 700:
                    body_preview = body_preview[:700] + "...[truncated]"
                raise RuntimeError(f"OpenAI API {resp.status_code}: {body_preview}")
            data = resp.json()
            content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
            parsed = json.loads(_extract_json_text(content))
            results_local = parsed.get("results") if isinstance(parsed, dict) else None
            if not isinstance(results_local, list):
                raise ValueError("OpenAI returned no results array")
            return results_local

        try:
            results = _request_with_model(model)
            model_used = model
        except Exception as e:
            err_text = str(e)
            should_try_fallback = (
                fallback_model
                and fallback_model != model
                and (
                    "400" in err_text
                    or "404" in err_text
                    or "403" in err_text
                    or "model" in err_text.lower()
                    or "unsupported" in err_text.lower()
                    or "not found" in err_text.lower()
                    or "does not exist" in err_text.lower()
                    or "permission" in err_text.lower()
                )
            )
            if should_try_fallback:
                try:
                    logging.warning("Primary GPT model failed (%s). Retrying with fallback (%s).", model, fallback_model)
                    results = _request_with_model(fallback_model)
                    model_used = fallback_model
                except Exception as e2:
                    if not first_error:
                        first_error = str(e2)
                    error_count += len(items)
                    for seg in items:
                        out.append({**seg, "translated_text": "", "translation_status": "error"})
                    return
            else:
                if not first_error:
                    first_error = str(e)
                error_count += len(items)
                for seg in items:
                    out.append({**seg, "translated_text": "", "translation_status": "error"})
                return

        for i, seg in enumerate(items):
            corrected = next((r for r in results if isinstance(r, dict) and r.get("id") == i), None)
            original_text = str(seg.get("text") or "")
            new_text = str((corrected or {}).get("text") or "").strip()
            copy = {**seg, "translated_text": new_text, "translation_status": "ok" if new_text else "empty"}
            out.append(copy)
            if new_text:
                ok_count += 1
                if new_text.strip() != original_text.strip():
                    changed_count += 1
            else:
                empty_count += 1

    for i in range(0, len(segments), max(1, chunk_size)):
        _process_chunk(segments[i:i + max(1, chunk_size)])

    return out, {
        "total": len(segments),
        "ok_count": ok_count,
        "empty_count": empty_count,
        "error_count": error_count,
        "changed_count": changed_count,
        "first_error": first_error,
        "model": model_used,
    }


# --- TRANSLATE SEGMENTS (GPT via Node script from package.json) ---
def translate_segments(segments, target_lang='he'):
    """Run Node translate script to add translated_text to each segment.
    Returns (segments, meta). On failure, returns original segments + error meta.
    """
    t0 = time.time()
    if not segments or not isinstance(segments, list):
        return segments, {"total": 0, "ok_count": 0, "empty_count": 0, "error_count": 0, "changed_count": 0, "first_error": ""}
    if not TRANSLATE_SCRIPT.exists():
        logging.warning("Translate script not found at %s", TRANSLATE_SCRIPT)
        return segments, {"total": len(segments), "ok_count": 0, "empty_count": 0, "error_count": len(segments), "changed_count": 0, "first_error": "translate.js not found"}
    api_key = os.environ.get('GPT_API_KEY') or os.environ.get('OPENAI_API_KEY')
    if not api_key or not str(api_key).strip():
        logging.warning("GPT_API_KEY not set; skipping translation")
        return segments, {"total": len(segments), "ok_count": 0, "empty_count": 0, "error_count": len(segments), "changed_count": 0, "first_error": "GPT_API_KEY missing"}
    node_exe = shutil.which("node")
    if not node_exe:
        logging.warning("Node.js not found in PATH; using Python OpenAI fallback")
        result = _translate_segments_via_python_openai(segments, target_lang=target_lang)
        return result
    try:
        logging.info("GPT translate: start segments=%s target=%s", len(segments), target_lang)
        payload = json.dumps({"segments": segments, "targetLang": target_lang}).encode("utf-8")
        proc = subprocess.run(
            [node_exe, str(TRANSLATE_SCRIPT)],
            input=payload,
            capture_output=True,
            timeout=300,
            cwd=str(APP_ROOT),
            env=os.environ.copy(),
        )

        stderr_text = (proc.stderr or b"").decode("utf-8", errors="replace")
        if stderr_text:
            logging.info("GPT translate stderr: %s", stderr_text[:500])

        if proc.returncode != 0:
            return segments, {
                "total": len(segments),
                "ok_count": 0,
                "empty_count": 0,
                "error_count": len(segments),
                "changed_count": 0,
                "first_error": f"node exit {proc.returncode}: {stderr_text[:300]}",
                "model": "",
            }

        out_text = (proc.stdout or b"").decode("utf-8", errors="replace").strip()
        if not out_text:
            return segments, {
                "total": len(segments),
                "ok_count": 0,
                "empty_count": 0,
                "error_count": len(segments),
                "changed_count": 0,
                "first_error": "empty stdout from translate.js",
                "model": "",
            }

        data = json.loads(out_text)
        translated = data.get("segments", segments)
        meta = data.get("meta") or {}
        if not isinstance(translated, list):
            return segments, {
                "total": len(segments),
                "ok_count": 0,
                "empty_count": 0,
                "error_count": len(segments),
                "changed_count": 0,
                "first_error": "translate.js returned non-list segments",
                "model": str(meta.get("model") or ""),
            }

        result_meta = {
            "total": int(meta.get("total") or len(translated)),
            "ok_count": int(meta.get("ok_count") or 0),
            "empty_count": int(meta.get("empty_count") or 0),
            "error_count": int(meta.get("error_count") or 0),
            "changed_count": int(meta.get("changed_count") or 0),
            "first_error": str(meta.get("first_error") or ""),
            "model": str(meta.get("model") or ""),
        }
        logging.info(
            "GPT translate: ok=%s/%s changed=%s/%s empty=%s error=%s model=%s first_error=%s",
            result_meta["ok_count"], result_meta["total"],
            result_meta["changed_count"], result_meta["total"],
            result_meta["empty_count"], result_meta["error_count"],
            result_meta["model"], result_meta["first_error"][:180]
        )
        return translated, result_meta
    except subprocess.TimeoutExpired:
        logging.warning("Translate script timed out")
        return segments, {
            "total": len(segments),
            "ok_count": 0,
            "empty_count": 0,
            "error_count": len(segments),
            "changed_count": 0,
            "first_error": "timeout",
            "model": "",
        }
    except Exception as e:
        logging.warning("Translate segments error: %s", e)
        return segments, {
            "total": len(segments),
            "ok_count": 0,
            "empty_count": 0,
            "error_count": len(segments),
            "changed_count": 0,
            "first_error": str(e),
            "model": "",
        }


_translate_in_flight = 0

@app.route('/api/translate_segments', methods=['POST'])
def api_translate_segments():
    """Accept segments JSON, run GPT correction, return segments with translated_text. Used by SRT/VTT upload and any client.
    If you get 504: gateway/proxy read timeout is too short; set it > GPT_TIMEOUT_SEC (default 90) or lower GPT_TIMEOUT_SEC."""
    global _translate_in_flight
    t0 = time.time()
    data = request.json or {}
    segments = data.get('segments') or []
    target_lang = data.get('targetLang') or data.get('target_lang') or 'he'
    if not isinstance(segments, list):
        return jsonify({"error": "segments must be an array"}), 400
    _translate_in_flight += 1
    logging.info("GPT translate: in_flight=%d (concurrent requests)", _translate_in_flight)
    try:
        translated, meta = translate_segments(segments, target_lang=target_lang)
        elapsed = time.time() - t0
        last_job, callback_at, last_user_id = _get_last_callback_for_gpt()
        if last_job and callback_at is not None and (time.time() - callback_at) < 120:
            _update_job_timings(last_job, user_id=last_user_id, gpt_sec=elapsed)
        return jsonify({"segments": translated, "meta": meta})
    finally:
        _translate_in_flight -= 1


# --- 1. Add Global Cache at the top ---
job_results_cache = {}

# --- 2. GPU Callback: bulletproof contract (return 200 only after we've saved) ---
# Worker must POST here; only 200 + body.ok=true means "app has received and stored the result".
# See docs/GPU_CALLBACK_API.md for full contract.
@app.route('/api/gpu_callback', methods=['POST'])
def gpu_callback():
    t0 = time.time()
    data = request.json or {}
    job_id = data.get('jobId')
    if not job_id:
        return jsonify({"ok": False, "error": "jobId required"}), 400
    result = data.get('result') or {}
    segments = result.get('segments') or data.get('segments') or []
    if not isinstance(segments, list):
        return jsonify({"ok": False, "error": "segments must be an array"}), 400

    # Resolve input_s3_key and user_id (for S3 path)
    pending = pending_job_info.pop(job_id, None)
    if pending:
        input_s3_key = pending.get('input_s3_key') or ''
        user_id = pending.get('user_id')
    else:
        input_info = data.get('input') or {}
        input_s3_key = input_info.get('s3Key') or data.get('s3Key') or ''
        user_id = _extract_user_id_from_s3_key(input_s3_key)

    raw_result_s3_key = None
    s3_sec = 0.0
    if input_s3_key:
        try:
            transcript_payload = {"segments": segments}
            w, c = _flatten_words_from_segments(segments)
            if w is not None and c is not None:
                transcript_payload["words"] = w
                transcript_payload["captions"] = c
            raw_result_s3_key = _put_transcript_json_to_s3(user_id or 'anonymous', input_s3_key, transcript_payload, stage='raw')
            result_dict = dict(result) if isinstance(result, dict) else {}
            result_dict['raw_result_s3_key'] = raw_result_s3_key
            data = dict(data)
            data['result'] = result_dict
        except Exception as e:
            logging.exception("Failed to save raw job result to S3 for %s", job_id)
            return jsonify({"ok": False, "error": "Failed to save result", "detail": str(e)}), 500

    data = dict(data)
    data.setdefault('result', {})
    data['result'] = dict(data.get('result') or result) if isinstance(result, dict) else {}
    data['result']['segments'] = segments
    data['segments'] = segments
    data['status'] = 'completed'

    job_results_cache[job_id] = data
    socketio.emit('job_status_update', data, room=job_id)

    # Build timing summary: read from shared file, in-memory, or DB (DB survives multi-instance / ephemeral storage)
    now = time.time()
    file_timings = _get_trigger_timings(job_id)
    mem_timings = job_timings.pop(job_id, {})
    db_timings = _get_job_timings_from_db(job_id, user_id) if user_id else {}
    queued_at = file_timings.get("queued_at") or pending_trigger_at.get(job_id, t0)
    trigger_completed_at = file_timings.get("trigger_completed_at") or mem_timings.get("trigger_completed_at")
    started_at = file_timings.get("gpu_started_at") or gpu_started_at.pop(job_id, None) or db_timings.get("gpu_started_at")

    total_sec = now - queued_at
    trigger_sec = mem_timings.get("trigger_sec") or file_timings.get("trigger_sec") or db_timings.get("trigger_sec")

    # runpod wakeup = trigger to gpu_started (cold start; download happens after gpu_started)
    waiting_for_run = None
    if trigger_completed_at is not None and started_at is not None:
        waiting_for_run = started_at - trigger_completed_at

    runpod_process = None
    if started_at is not None:
        runpod_process = now - started_at

    # Worker can send timing in result.timing: { download_sec, wakeup_sec, transcribe_sec, gpt_sec }
    worker_timing = (result if isinstance(result, dict) else {}).get("timing") or {}
    if not isinstance(worker_timing, dict):
        worker_timing = {}

    download_sec = worker_timing.get("download_sec")
    wakeup_sec = worker_timing.get("wakeup_sec") or waiting_for_run
    process_sec = runpod_process
    gpt_sec = worker_timing.get("gpt_sec")

    # So frontend handshake completes even if /api/gpu_started was never called; shared store for multi-worker
    if job_id in pending_trigger and pending_trigger.get(job_id) != "failed":
        pending_trigger[job_id] = "triggered"
    _set_trigger_state(job_id, "triggered")

    # Store for GPT timing inference: api_translate_segments will log addendum when it completes
    _set_last_callback_for_gpt(job_id, now, user_id=user_id)

    # Persist PROCESS TIMING to DB (runpod_wakeup_sec, runpod_process_sec, gpt_sec; gpt filled when translate completes)
    _update_job_timings(
        job_id,
        user_id=user_id,
        trigger_sec=trigger_sec,
        download_sec=download_sec,
        runpod_wakeup_sec=wakeup_sec,
        runpod_process_sec=process_sec,
        gpt_sec=gpt_sec,
        total_sec=total_sec,
    )

    return jsonify({
        "ok": True,
        "received": True,
        "job_id": job_id,
        "stage": "raw_saved",
        "raw_result_s3_key": raw_result_s3_key,
    }), 200


# --- 3. Update Join Logic to CHECK the Cache ---
@socketio.on('join')
def on_join(data):
    room = data.get('room')
    if room:
        join_room(room)
        print(f"Client joined room: {room}")

        # CHECK MAILBOX: Is the result already waiting?
        if room in job_results_cache:
            print(f"馃摝 Found cached result for {room}, sending now!")
            # Send it to this specific user who just reconnected
            socketio.emit('job_status_update', job_results_cache[room], room=request.sid)

# --- SIMULATION BACKGROUND TASK ---
# This simulates the GPU finishing and sending data back after 4 seconds
# Updated simulation thread logic
def simulate_completion(jid, run_diarization):
    import time
    time.sleep(1)
    segments = []

    # Simulation sample text (kept generic; old fixed Hebrew snippet removed)
    transcript_text = [
        "Simulation segment one.",
        "Simulation segment two.",
        "Simulation segment three.",
        "Simulation segment four."
    ]

    for i, text in enumerate(transcript_text):
        # Create a basic segment
        segment = {
            "start": float(i * 5),
            "end": float(i * 5 + 4),
            "text": text
        }

        # ONLY add the speaker key if diarization was requested
        if run_diarization:
            # Alternating speakers for the test
            segment["speaker"] = "SPEAKER_00" if i % 4 == 0 else "SPEAKER_01"

        segments.append(segment)

    # Post-process: add correction via GPT (Node script)
    segments, tmeta = translate_segments(segments, target_lang='he')

    mock_data = {
        "jobId": jid,
        "status": "completed",
        "result": {"segments": segments, "translation_meta": tmeta}
    }

    global job_results_cache
    job_results_cache[jid] = mock_data

    # Send the result to the frontend
    socketio.emit('job_status_update', mock_data, room=jid)
    print(f"🔮 SIMULATION COMPLETE: Room {jid} | Diarization Output: {run_diarization}")


@app.route('/api/sign-s3', methods=['POST'])
def sign_s3():
    import boto3
    import os
    import time
    from threading import Thread

    data = request.json or {}
    user_id = (data.get('userId') or data.get('user_id') or '').strip() or 'anonymous'
    user_prefix = f"users/{user_id}"

    if SIMULATION_MODE:
        job_id = f"job_sim_{int(time.time())}"
        s3_key = f"{user_prefix}/simulation_audio"

        is_diarization_requested = data.get('diarization', False)

        Thread(target=simulate_completion, args=(job_id, is_diarization_requested)).start()

        return jsonify({
            'data': {
                'url': 'http://localhost:8000/api/mock-upload',
                's3Key': s3_key,  # Matches the backup key
                'jobId': job_id
            }
        })

    else:
        # --- LIVE AWS LOGIC ---
        filename = data.get('filename')
        file_type = data.get('filetype')

        key_id = os.environ.get("AWS_ACCESS_KEY_ID")
        secret = os.environ.get("AWS_SECRET_ACCESS_KEY")
        region = os.environ.get("AWS_REGION", "eu-north-1")
        bucket = os.environ.get("S3_BUCKET") or "quickscribe-v2-12345"

        if not key_id or not secret:
            return jsonify({"status": "error", "message": "AWS Credentials missing on server"}), 500

        s3_client = boto3.client(
            's3',
            aws_access_key_id=key_id,
            aws_secret_access_key=secret,
            region_name=region
        )

        base_name, extension = os.path.splitext(filename)
        job_id = f"job_{int(time.time())}_{base_name}"
        s3_key = f"{user_prefix}/input/{job_id}{extension}"

        presigned_url = s3_client.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': bucket,
                'Key': s3_key,
                'ContentType': file_type
            },
            ExpiresIn=3600
        )

        # Trigger RunPod early (before upload) so container is warming during upload
        _start_trigger_if_configured(
            job_id=job_id,
            s3_key=s3_key,
            request=request,
            task='transcribe',
            language=data.get('language', 'he'),
            diarization=data.get('diarization', False),
            speaker_count=2,
        )

        return jsonify({
            'data': {
                'url': presigned_url,
                's3Key': s3_key,  # This must be saved by the frontend!
                'jobId': job_id
            }
        })

def _start_trigger_if_configured(job_id, s3_key, request, task='transcribe', language='he', diarization=False, speaker_count=2):
    """Start RunPod trigger in background. Called from sign_s3 (before upload) so container warms during upload.
    No-op if RunPod not configured or SIMULATION_MODE."""
    if SIMULATION_MODE:
        return
    endpoint_id = os.environ.get('RUNPOD_ENDPOINT_ID')
    api_key = os.environ.get('RUNPOD_API_KEY')
    if not endpoint_id or not api_key:
        return
    public_base = _public_base_url(request)
    callback_url = f"{public_base}/api/gpu_callback"
    start_callback_url = f"{public_base}/api/gpu_started"
    upload_status_url = f"{public_base}/api/upload_status?job_id={job_id}"
    payload = {
        "input": {
            "s3Key": s3_key,
            "jobId": job_id,
            "task": task,
            "language": language,
            "callback_url": callback_url,
            "start_callback_url": start_callback_url,
            "upload_status_url": upload_status_url,
        }
    }
    pending_job_info[job_id] = {
        "input_s3_key": s3_key,
        "user_id": _extract_user_id_from_s3_key(s3_key),
        "task": task,
        "language": language,
    }
    pending_trigger[job_id] = "queued"
    t_queued = time.time()
    pending_trigger_at[job_id] = t_queued
    _set_trigger_state(job_id, "queued", queued_at=t_queued)
    t = threading.Thread(target=_trigger_gpu, args=(job_id, payload, endpoint_id, api_key))
    t.daemon = True
    t.start()
    logging.info("Trigger started at sign-s3 (before upload) for %s", job_id)


def _trigger_gpu(job_id, payload, endpoint_id, api_key):
    """Background: POST /run to wake RunPod from cold and start the job. No polling.
    The trigger itself starts the container; worker downloads from S3 and transcribes."""
    global pending_trigger, job_timings
    t0 = time.time()
    try:
        clean_id = str(endpoint_id).strip()
        endpoint_url = f"https://api.runpod.ai/v2/{clean_id}/run"
        headers = {"Authorization": f"Bearer {api_key.strip()}", "Content-Type": "application/json"}
        response = requests.post(endpoint_url, json=payload, headers=headers, timeout=15)
        trigger_sec = time.time() - t0
        trigger_completed_at = time.time()
        job_timings[job_id] = {"trigger_sec": trigger_sec, "trigger_completed_at": trigger_completed_at}
        _update_trigger_timings(job_id, trigger_sec=trigger_sec, trigger_completed_at=trigger_completed_at)
        # Persist to DB immediately (survives multi-instance / ephemeral storage)
        pending = pending_job_info.get(job_id, {})
        user_id = pending.get("user_id") or _extract_user_id_from_s3_key((pending.get("input_s3_key") or ""))
        _update_job_timings(job_id, user_id=user_id, trigger_sec=trigger_sec, trigger_completed_at=trigger_completed_at)
        if response.status_code in (200, 201, 202):
            pending_trigger[job_id] = "run_accepted"
            _set_trigger_state(job_id, "run_accepted")
            print(f"🚀 RunPod accepted job {job_id} (container starting)")
        else:
            pending_trigger[job_id] = "failed"
            _set_trigger_state(job_id, "failed")
            print(f"❌ RunPod API Error ({response.status_code}): {response.text}")
    except Exception as e:
        pending_trigger[job_id] = "failed"
        _set_trigger_state(job_id, "failed")
        logging.exception("trigger_gpu failed for %s", job_id)


@app.route('/api/gpu_started', methods=['POST'])
def gpu_started():
    """Early handshake from worker: called once app_transcribe.py starts.
    Marks pending_trigger[job_id] as 'triggered' so frontend can move from 'queued' to 'processing'."""
    global gpu_started_at
    data = request.json or {}
    job_id = data.get('jobId') or data.get('job_id')
    if not job_id:
        return jsonify({"ok": False, "error": "jobId required"}), 400
    started_at = time.time()
    gpu_started_at[job_id] = started_at
    _update_trigger_timings(job_id, gpu_started_at=started_at)
    # Persist runpod_wakeup_sec and gpu_started_at to DB (survives multi-instance)
    pending = pending_job_info.get(job_id, {})
    user_id = pending.get("user_id") or _extract_user_id_from_s3_key((pending.get("input_s3_key") or ""))
    trigger_completed_at = _get_trigger_timings(job_id).get("trigger_completed_at")
    if trigger_completed_at is None:
        db_timings = _get_job_timings_from_db(job_id, user_id)
        trigger_completed_at = db_timings.get("trigger_completed_at")
    if trigger_completed_at is not None:
        wakeup_sec = started_at - trigger_completed_at
        _update_job_timings(job_id, user_id=user_id, runpod_wakeup_sec=wakeup_sec, gpu_started_at=started_at)
    if job_id in pending_trigger and pending_trigger.get(job_id) != "failed":
        pending_trigger[job_id] = "triggered"
    _set_trigger_state(job_id, "triggered")
    if job_id not in pending_trigger or pending_trigger.get(job_id) == "failed":
        logging.warning("gpu_started for unknown or failed job_id %s", job_id)
    return jsonify({"ok": True, "job_id": job_id}), 200


@app.route('/api/upload_status', methods=['GET'])
def upload_status():
    """Worker polls this until upload is complete. Set when trigger_processing is called (after frontend upload)."""
    job_id = request.args.get('job_id')
    if not job_id:
        return jsonify({"error": "job_id required"}), 400
    status = "complete" if job_id in upload_complete else "pending"
    return jsonify({"job_id": job_id, "status": status}), 200


@app.route('/api/trigger_status', methods=['GET'])
def trigger_status():
    """Frontend polls this until status is 'triggered', then starts progress bar.
    If status stays 'queued' longer than STALE_QUEUED_SEC, returns 'stale_queued' so frontend can retry.
    Reads from shared store so any Gunicorn worker sees updates from gpu_callback/gpu_started."""
    job_id = request.args.get('job_id')
    if not job_id:
        return jsonify({"error": "job_id required"}), 400
    file_status, file_at = _get_trigger_state(job_id)
    status = file_status if file_status else pending_trigger.get(job_id, "unknown")
    queued_since_sec = None
    if status == "queued":
        at = file_at if file_at else pending_trigger_at.get(job_id, 0)
        queued_since_sec = int(time.time() - at) if at else 0
        if queued_since_sec > STALE_QUEUED_SEC:
            status = "stale_queued"
    out = {"job_id": job_id, "status": status}
    if status in ("queued", "stale_queued") and queued_since_sec is not None:
        out["queued_since_sec"] = queued_since_sec
    return jsonify(out), 200

@app.route('/api/trigger_processing', methods=['POST'])
def trigger_processing():
    try:
        data = request.json if request.is_json else {}
        if not data:
            data = {}
        print(f"📩 Received Trigger Request: {data}")

        s3_key = data.get('s3Key')
        job_id = data.get('jobId')
        if SIMULATION_MODE:
            print("🔮 SIMULATION: Skipping RunPod Trigger")
            if job_id:
                upload_complete[job_id] = True
                pending_trigger[job_id] = "triggered"
                _set_trigger_state(job_id, "triggered")
            return jsonify({"status": "started", "runpod_id": "sim_id_123"}), 202

        if not s3_key or not job_id:
            return jsonify({"status": "error", "message": "s3Key and jobId required"}), 400

        # Trigger was already started at sign-s3 (before upload); signal upload complete for worker
        upload_complete[job_id] = True

        # Trigger already running; just confirm
        if job_id in pending_trigger and pending_trigger.get(job_id) not in ("failed", None):
            return jsonify({"status": "started", "job_id": job_id}), 202

        endpoint_id = os.environ.get('RUNPOD_ENDPOINT_ID')
        api_key = os.environ.get('RUNPOD_API_KEY')
        print(f"🔑 checking keys... Endpoint ID exists? {bool(endpoint_id)} | API Key exists? {bool(api_key)}")

        task = data.get('task', 'transcribe')
        language = data.get('language', 'he')
        diarization = data.get('diarization', False)

        if not endpoint_id or not api_key:
            print("🔮 RunPod not configured: falling back to simulation (mock result in ~1s)")
            pending_trigger[job_id] = "triggered"
            _set_trigger_state(job_id, "triggered")
            if not SIMULATION_MODE:
                t = threading.Thread(target=simulate_completion, args=(job_id, diarization))
                t.daemon = True
                t.start()
            return jsonify({"status": "started", "runpod_id": "sim_id_123"}), 202

        try:
            speaker_count = int(data.get('speakerCount', 2))
        except Exception:
            speaker_count = 2

        public_base = _public_base_url(request)
        callback_url = f"{public_base}/api/gpu_callback"
        start_callback_url = f"{public_base}/api/gpu_started"
        upload_status_url = f"{public_base}/api/upload_status?job_id={job_id}"

        payload = {
            "input": {
                "s3Key": s3_key,
                "jobId": job_id,
                "task": task,
                "language": language,
                "callback_url": callback_url,
                "start_callback_url": start_callback_url,
                "upload_status_url": upload_status_url,
            }
        }

        # So gpu_callback can save raw JSON even when RunPod does not echo input; store task/language for retry
        pending_job_info[job_id] = {
            "input_s3_key": s3_key,
            "user_id": _extract_user_id_from_s3_key(s3_key),
            "task": task,
            "language": language,
        }
        t_queued = time.time()
        pending_trigger[job_id] = "queued"  # thread will update to "triggered" or "failed"
        pending_trigger_at[job_id] = t_queued
        _set_trigger_state(job_id, "queued", queued_at=t_queued)
        t = threading.Thread(
            target=_trigger_gpu,
            args=(job_id, payload, endpoint_id, api_key)
        )
        t.daemon = True
        t.start()

        # Return "started" so first/cold run shows "Triggering processing..." not "Wait in line..."
        return jsonify({"status": "started", "job_id": job_id}), 202

    except Exception as e:
        print(f"❌ trigger_processing CRASHED: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/retry_trigger', methods=['POST'])
def retry_trigger():
    """Re-send RunPod trigger for a job that is stuck (e.g. trigger never fired). Uses stored job info."""
    global pending_trigger, pending_trigger_at
    try:
        data = request.json if request.is_json else {}
        job_id = (data or {}).get('jobId')
        if not job_id:
            return jsonify({"status": "error", "message": "jobId required"}), 400
        if SIMULATION_MODE:
            return jsonify({"status": "retry_started", "job_id": job_id}), 202
        info = pending_job_info.get(job_id)
        if not info:
            return jsonify({"status": "error", "message": "Job not found or expired"}), 404
        s3_key = info.get("input_s3_key")
        if not s3_key:
            return jsonify({"status": "error", "message": "Job missing s3 key"}), 400
        endpoint_id = os.environ.get('RUNPOD_ENDPOINT_ID')
        api_key = os.environ.get('RUNPOD_API_KEY')
        if not endpoint_id or not api_key:
            return jsonify({"status": "error", "message": "RunPod not configured"}), 503
        task = info.get('task', 'transcribe')
        language = info.get('language', 'he')
        public_base = _public_base_url(request)
        callback_url = f"{public_base}/api/gpu_callback"
        start_callback_url = f"{public_base}/api/gpu_started"
        upload_status_url = f"{public_base}/api/upload_status?job_id={job_id}"
        payload = {
            "input": {
                "s3Key": s3_key,
                "jobId": job_id,
                "task": task,
                "language": language,
                "callback_url": callback_url,
                "start_callback_url": start_callback_url,
                "upload_status_url": upload_status_url,
            }
        }
        upload_complete[job_id] = True  # retry: upload was already done
        t_queued = time.time()
        pending_trigger[job_id] = "queued"
        pending_trigger_at[job_id] = t_queued
        _set_trigger_state(job_id, "queued", queued_at=t_queued)
        t = threading.Thread(
            target=_trigger_gpu,
            args=(job_id, payload, endpoint_id, api_key)
        )
        t.daemon = True
        t.start()
        print(f"🔄 Retry trigger started for job {job_id}")
        return jsonify({"status": "retry_started", "job_id": job_id}), 202
    except Exception as e:
        logging.exception("retry_trigger failed")
        return jsonify({"status": "error", "message": str(e)}), 500


# --- SIMULATION MODE (for frontend) ---
@app.route('/api/simulation_mode', methods=['GET'])
def get_simulation_mode():
    """Return whether server is in simulation mode so frontend can show subtitle upload hint."""
    return jsonify({"simulation": SIMULATION_MODE}), 200


# --- BURN SUBTITLES (SERVER-SIDE ON KOYEB) ---
burn_tasks = {}  # task_id -> { status, output_s3_key?, error? }

def _resolve_ffmpeg():
    """Return an executable ffmpeg path.
    Order: env FFMPEG_PATH, PATH, project bin/, common system path.
    If a local binary exists but lacks execute bits, try chmod on non-Windows.
    """
    def _ensure_exec(path):
        if not path or not os.path.isfile(path):
            return None
        if sys.platform == 'win32':
            return path
        if os.access(path, os.X_OK):
            return path
        try:
            os.chmod(path, 0o755)
            if os.access(path, os.X_OK):
                return path
        except Exception:
            pass
        return None

    def _can_run(path):
        """Verify binary can execute in this environment (avoids noexec mounts)."""
        if not path:
            return False
        try:
            result = subprocess.run([path, '-version'], capture_output=True, text=True, timeout=10)
            return result.returncode == 0
        except Exception:
            return False

    path = os.environ.get('FFMPEG_PATH', '').strip()
    env_exec = _ensure_exec(path)
    if env_exec and _can_run(env_exec):
        return env_exec

    which_ffmpeg = shutil.which('ffmpeg')
    if which_ffmpeg and _can_run(which_ffmpeg):
        return which_ffmpeg
    # Project bin folder (e.g. QuickScribe/Site/bin/)
    app_dir = os.path.dirname(os.path.abspath(__file__))
    bin_dir = os.path.join(app_dir, 'bin')
    for name in ('ffmpeg', 'ffmpeg.exe'):
        candidate = os.path.join(bin_dir, name)
        candidate_exec = _ensure_exec(candidate)
        if candidate_exec and _can_run(candidate_exec):
            return candidate_exec
    sys_ffmpeg = _ensure_exec('/usr/bin/ffmpeg') if sys.platform != 'win32' else None
    if sys_ffmpeg and _can_run(sys_ffmpeg):
        return sys_ffmpeg
    return 'ffmpeg'

def _probe_video_with_ffmpeg(ffmpeg_path, video_path):
    """Get (duration_sec, max_width) by running ffmpeg -i and parsing stderr. No ffprobe needed."""
    result = subprocess.run(
        [ffmpeg_path, '-i', video_path],
        capture_output=True, text=True, timeout=30
    )
    stderr = result.stderr or ''
    duration = 0.0
    width = 0
    # Duration: 00:01:23.45, start: ...
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+)[.,](\d*)', stderr)
    if m:
        h, m_min, s, frac = int(m.group(1)), int(m.group(2)), int(m.group(3)), (m.group(4) or '0')[:3].ljust(3, '0')
        duration = h * 3600 + m_min * 60 + s + int(frac) / 1000.0
    # Video stream: ... 1920x1080 ...
    for m in re.finditer(r'(\d{3,5})\s*x\s*(\d{3,5})', stderr):
        w, h = int(m.group(1)), int(m.group(2))
        if w > 0 and h > 0:
            width = max(width, w)
    return (duration, width)

def _ass_ts(s):
    """ASS time: H:MM:SS.cc (centiseconds)."""
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    cs = int(round((sec % 1) * 100))
    return f"{h}:{m:02d}:{int(sec):02d}.{cs:02d}"

# Punctuation that should stay with previous line in RTL (not start the next line)
_RTL_LINE_END_PUNCT = '.,;:!?،؛؟'
_HEBREW_RE = re.compile(r'[\u0590-\u05FF]')
_RTL_EMBED_OPEN = '\u202B'  # Right-to-left embedding
_RTL_EMBED_CLOSE = '\u202C'  # Pop directional formatting


def _rtl_force_direction(text):
    """Force RTL direction for Hebrew lines in ASS/burn (embedding only)."""
    if not text or not _HEBREW_RE.search(text):
        return text
    if text.startswith(_RTL_EMBED_OPEN) and text.endswith(_RTL_EMBED_CLOSE):
        return text
    return f"{_RTL_EMBED_OPEN}{text}{_RTL_EMBED_CLOSE}"


_LATIN_WORD_RE = re.compile(r'[a-zA-Z]{2,}')


def _rtl_srt_visual_order(text):
    """For SRT: mixed Hebrew+English – wrap in RTL embedding so bidi-aware players show like transcript. Pure Hebrew – move trailing punct to start."""
    if not text or not _HEBREW_RE.search(text):
        return text
    original = text
    trimmed = original.rstrip()
    if not trimmed:
        return original
    if _LATIN_WORD_RE.search(trimmed):
        if trimmed.startswith(_RTL_EMBED_OPEN) and trimmed.endswith(_RTL_EMBED_CLOSE):
            return original
        return f"{_RTL_EMBED_OPEN}{trimmed}{_RTL_EMBED_CLOSE}"
    m = re.match(r'^(.*?)([.,!?…:;]+)$', trimmed, re.UNICODE)
    if not m:
        return original
    body = m.group(1).lstrip()
    punct = m.group(2)
    if not body or body.startswith(punct):
        return original
    return f"{punct}{body}"




def _wrap_text_rtl_safe(text, max_chars_per_line):
    """Split text into lines; keep trailing punctuation with previous line (fixes RTL burn: comma/period at start of line)."""
    if not text or len(text) <= max_chars_per_line:
        return [text.strip()] if text and text.strip() else []
    parts = []
    rest = text
    while rest:
        rest = rest.lstrip()
        if not rest:
            break
        if len(rest) <= max_chars_per_line:
            parts.append(rest.strip())
            break
        chunk = rest[: max_chars_per_line + 1]
        last_space = chunk.rfind(' ')
        split_at = last_space if last_space > 0 else max_chars_per_line
        part = rest[:split_at].strip()
        rest = rest[split_at:].lstrip()
        # Don't start next line with punctuation (RTL: keeps , . at end of previous line)
        while rest and rest[0] in _RTL_LINE_END_PUNCT:
            part += rest[0]
            rest = rest[1:].lstrip()
        parts.append(part)
    return parts


def _build_ass(segments, style='tiktok', portrait=False):
    """Build ASS content. style: tiktok (bold yellow centered), clean, cinematic. portrait=True uses 14 chars/line."""
    # PlayRes chosen for scale; ffmpeg will scale
    play_res_x, play_res_y = 384, 288
    if style == 'tiktok':
        # Bold, large, yellow #ffd700, black outline, center. ASS colour &HAABBGGRR
        style_line = "Style: Default,Arial,28,&H0000D7FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1"
    elif style == 'cinematic':
        style_line = "Style: Default,Times New Roman,22,&H00F5F5F5,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,50,1"
    else:
        # clean
        style_line = "Style: Default,Arial,18,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,50,1"
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {play_res_y}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        style_line,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    ]
    # TikTok bold: wrap at N chars per line (portrait/vertical = 14, landscape = 27); ASS newline is \N
    max_chars_per_line = 14 if (style == 'tiktok' and portrait) else (27 if style == 'tiktok' else 9999)
    def _esc_ass_text(s):
        return str(s or '').replace('\n', ' ').replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}')

    # Per-word inline tags (ASS colors are AABBGGRR).
    NORMAL_TAG = r"{\1c&H00FFFFFF&\3c&H00000000&\bord2\shad0}"
    ACTIVE_TAG = r"{\1c&H00000000&\3c&H00FFFFFF&\bord3\shad0\blur0.4}"
    PINNED_TAG = r"{\1c&H00000000&\3c&H00FFFFFF&\bord3\shad0\blur0.4}"

    for seg in segments:
        start = seg.get('start', 0)
        end = seg.get('end', start + 1)
        text = _esc_ass_text(seg.get('text') or '')
        seg_style = seg.get('style') if isinstance(seg, dict) else None
        pos = None
        if isinstance(seg_style, dict):
            pos = str(seg_style.get('position') or '').strip().lower()
        # ASS alignment override per caption:
        # an8=top-center, an5=middle-center, an2=bottom-center
        pos_override = ''
        if pos == 'top':
            pos_override = r"{\an8}"
        elif pos == 'middle':
            pos_override = r"{\an5}"
        elif pos == 'bottom':
            pos_override = r"{\an2}"

        highlight_mode = ''
        if isinstance(seg_style, dict):
            highlight_mode = str(seg_style.get('highlightMode') or '').strip().lower()

        seg_words = seg.get('words') if isinstance(seg, dict) else None
        use_word_karaoke = (
            highlight_mode == 'active-word'
            and isinstance(seg_words, list)
            and len(seg_words) > 0
        )

        # High-fidelity word-level rendering:
        # For active-word mode, emit one Dialogue event per active word timing window
        # and style only that word (plus pinned words) as highlighted.
        if use_word_karaoke:
            words_clean = []
            for w in seg_words:
                wt = _esc_ass_text((w or {}).get('text') or '')
                if not wt:
                    continue
                ws = float((w or {}).get('start') or start)
                we = float((w or {}).get('end') or (ws + 0.12))
                if we <= ws:
                    we = ws + 0.08
                words_clean.append({
                    'text': wt,
                    'start': ws,
                    'end': we,
                    'highlighted': bool((w or {}).get('highlighted'))
                })

            if words_clean:
                for ai in range(len(words_clean)):
                    aw = words_clean[ai]
                    ev_start = max(float(start), float(aw['start']))
                    ev_end = min(float(end), float(aw['end']))
                    if ev_end <= ev_start + 0.01:
                        ev_end = ev_start + 0.06

                    token_parts = []
                    for i, tw in enumerate(words_clean):
                        if tw['highlighted']:
                            token_parts.append(PINNED_TAG + tw['text'])
                        elif i == ai:
                            token_parts.append(ACTIVE_TAG + tw['text'])
                        else:
                            token_parts.append(NORMAL_TAG + tw['text'])

                    ev_text = ' '.join(token_parts)
                    # Keep RTL visual order stable for Hebrew text.
                    ev_text = _rtl_force_direction(ev_text)
                    if pos_override:
                        ev_text = pos_override + ev_text
                    lines.append(f"Dialogue: 0,{_ass_ts(ev_start)},{_ass_ts(ev_end)},Default,,0,0,0,,{ev_text}")
                continue

        if style == 'tiktok' and (not use_word_karaoke) and len(text) > max_chars_per_line:
            parts = _wrap_text_rtl_safe(text, max_chars_per_line)
            parts = [_rtl_force_direction(p) for p in parts]
            text = '\\N'.join(parts) if parts else text
        elif not use_word_karaoke:
            text = _rtl_force_direction(text)
        if pos_override:
            text = pos_override + text
        lines.append(f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Default,,0,0,0,,{text}")
    return "\r\n".join(lines) + "\r\n"

def _send_burn_ready_email(to_email, download_url, base_name):
    """Send 'your video is ready' email via SendGrid if SENDGRID_API_KEY is set."""
    api_key = os.environ.get('SENDGRID_API_KEY')
    if not api_key or not to_email:
        return
    try:
        from_email = os.environ.get('SENDGRID_FROM', 'noreply@getquickscribe.com')
        payload = {
            "personalizations": [{"to": [{"email": to_email}]}],
            "from": {"email": from_email, "name": "QuickScribe"},
            "subject": "Your video with subtitles is ready",
            "content": [{
                "type": "text/plain",
                "value": f"Your video '{base_name}' with burned-in subtitles is ready.\n\nDownload (link valid 24 hours):\n{download_url}\n\n— QuickScribe"
            }]
        }
        r = requests.post(
            "https://api.sendgrid.com/v3/mail/send",
            json=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=10
        )
        if r.status_code >= 400:
            logging.warning("SendGrid send failed: %s %s", r.status_code, r.text[:200])
    except Exception as e:
        logging.warning("Send burn-ready email failed: %s", e)


def _segments_to_srt_text(segments, max_chars_per_line=None):
    """Build SRT text. If max_chars_per_line is set (e.g. 27 for tiktok), wrap with RTL-safe line breaks."""
    def to_srt_ts(s):
        h = int(s // 3600)
        m = int((s % 3600) // 60)
        sec = s % 60
        return f"{h:02d}:{m:02d}:{int(sec):02d},{int((sec % 1) * 1000):03d}"

    rows = []
    for i, seg in enumerate(segments or []):
        start = float(seg.get('start', 0) or 0)
        end = float(seg.get('end', start + 1) or (start + 1))
        if end <= start:
            end = start + 0.5
        text = str(seg.get('text') or '').replace('\n', ' ')
        text = _rtl_srt_visual_order(text)
        rows.append(f"{i + 1}\n{to_srt_ts(start)} --> {to_srt_ts(end)}\n{text}\n")
    return "\n".join(rows) + ("\n" if rows else "")


def _extract_user_id_from_s3_key(s3_key: str):
    """Best-effort user id extraction from S3 key like users/{user_id}/..."""
    try:
        if s3_key and s3_key.startswith('users/'):
            parts = s3_key.split('/', 2)
            if len(parts) >= 2 and parts[1]:
                return parts[1]
    except Exception:
        return None
    return None


def _build_output_key(user_id, input_s3_key, task_id):
    base_name = "video"
    if input_s3_key:
        base_name = os.path.splitext(os.path.basename(input_s3_key))[0] or "video"
    safe_name = "".join(c for c in base_name if c.isalnum() or c in (' ', '-', '_'))[:80].strip() or "video"
    return f"users/{user_id}/output/{safe_name}_with_subtitles.mp4", safe_name


def _queue_burn_task_on_runpod(task_id, input_s3_key, segments, user_id, callback_url, subtitle_style=None, is_portrait=False, notify_email=None, job_id=None):
    """Dispatch burn task to RunPod using presigned S3 URLs."""
    endpoint_id = (RUNPOD_MOVIE_ENDPOINT_ID or "").strip()
    api_key = (RUNPOD_API_KEY or "").strip()
    if not endpoint_id or not api_key:
        raise RuntimeError("RunPod movie endpoint is not configured")

    bucket = os.environ.get('S3_BUCKET')
    s3_client = boto3.client(
        's3',
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        region_name=os.environ.get('AWS_REGION')
    )

    if not bucket:
        raise RuntimeError("S3_BUCKET missing")

    output_s3_key, safe_name = _build_output_key(user_id, input_s3_key, task_id)
    subtitle_s3_key = f"users/{user_id}/tmp/subtitles/{task_id}.srt"
    max_chars = 14 if (subtitle_style == 'tiktok' and is_portrait) else (27 if subtitle_style == 'tiktok' else 9999)
    subtitle_text = _segments_to_srt_text(segments, max_chars_per_line=max_chars)
    s3_client.put_object(
        Bucket=bucket,
        Key=subtitle_s3_key,
        Body=subtitle_text.encode("utf-8"),
        ContentType="application/x-subrip; charset=utf-8"
    )

    input_video_url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': bucket, 'Key': input_s3_key},
        ExpiresIn=10800
    )
    input_srt_url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': bucket, 'Key': subtitle_s3_key},
        ExpiresIn=10800
    )
    output_upload_url = s3_client.generate_presigned_url(
        'put_object',
        Params={'Bucket': bucket, 'Key': output_s3_key, 'ContentType': 'video/mp4'},
        ExpiresIn=21600
    )

    payload = {
        "input": {
            "task": "burn_subtitles",
            "task_id": task_id,
            "input_video_url": input_video_url,
            "input_srt_url": input_srt_url,
            "output_upload_url": output_upload_url,
            "output_s3_key": output_s3_key,
            "subtitle_style": (subtitle_style or 'tiktok'),
            "is_portrait": is_portrait,
            "job_id": job_id,
            "user_id": user_id,
            "notify_email": notify_email,
            "callback_url": callback_url,
        }
    }
    endpoint_url = f"https://api.runpod.ai/v2/{endpoint_id}/run"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    r = requests.post(endpoint_url, json=payload, headers=headers, timeout=20)
    if r.status_code not in (200, 201, 202):
        raise RuntimeError(f"RunPod movie dispatch failed ({r.status_code}): {r.text[:300]}")

    burn_tasks[task_id] = {
        'status': 'processing',
        'mode': 'runpod',
        'output_s3_key': output_s3_key,
        'subtitle_s3_key': subtitle_s3_key,
        'safe_name': safe_name
    }

def _run_burn_task(task_id, input_s3_key, segments, user_id, subtitle_style=None, is_portrait=False, notify_email=None, job_id=None):
    """Background task: download from S3, check duration limit, burn subtitles, upload to S3, optional email."""
    bucket = os.environ.get('S3_BUCKET')
    s3_client = boto3.client(
        's3',
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        region_name=os.environ.get('AWS_REGION')
    )
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            ext = '.mp4'
            if input_s3_key:
                for e in ('.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi'):
                    if input_s3_key.lower().endswith(e):
                        ext = e
                        break
            video_path = os.path.join(tmpdir, 'input' + ext)
            s3_client.download_file(bucket, input_s3_key, video_path)

            ffmpeg_path = _resolve_ffmpeg()
            if not (os.path.isfile(ffmpeg_path) or shutil.which(ffmpeg_path)):
                burn_tasks[task_id] = {'status': 'failed', 'error': 'ffmpeg not found. Install ffmpeg, set FFMPEG_PATH, or add it to PATH.'}
                return
            use_ass = subtitle_style in ('tiktok', 'clean', 'cinematic')
            if use_ass:
                ass_content = _build_ass(segments, subtitle_style or 'tiktok', portrait=is_portrait)
                subs_path = os.path.join(tmpdir, 'subtitles.ass')
                with open(subs_path, 'w', encoding='utf-8') as f:
                    f.write(ass_content)
            else:
                def to_srt_ts(s):
                    h = int(s // 3600)
                    m = int((s % 3600) // 60)
                    sec = s % 60
                    return f"{h:02d}:{m:02d}:{int(sec):02d},{int((sec % 1) * 1000):03d}"
                subs_path = os.path.join(tmpdir, 'subtitles.srt')
                with open(subs_path, 'w', encoding='utf-8') as f:
                    for i, seg in enumerate(segments):
                        start = seg.get('start', 0)
                        end = seg.get('end', start + 1)
                        text = (seg.get('text') or '').replace('\n', ' ')
                        f.write(f"{i + 1}\n{to_srt_ts(start)} --> {to_srt_ts(end)}\n{text}\n\n")

            out_path = os.path.join(tmpdir, 'output.mp4')
            subs_escaped = subs_path.replace('\\', '/').replace(':', '\\:').replace("'", "\\'")
            filter_name = 'ass' if use_ass else 'subtitles'
            vf = f"{filter_name}='{subs_escaped}'"
            cmd = [
                ffmpeg_path, '-y', '-i', video_path,
                '-vf', vf,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                '-c:a', 'aac', '-b:a', '128k',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                out_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if result.returncode != 0:
                burn_tasks[task_id] = {'status': 'failed', 'error': (result.stderr or 'ffmpeg failed')[-500:]}
                return
            if not os.path.exists(out_path):
                burn_tasks[task_id] = {'status': 'failed', 'error': 'No output file'}
                return

            # Friendly base name from input key (e.g. job_123_video.mp4 -> job_123_video)
            base_name = "video"
            if input_s3_key:
                base_name = os.path.splitext(os.path.basename(input_s3_key))[0] or "video"
            safe_name = "".join(c for c in base_name if c.isalnum() or c in (' ', '-', '_'))[:80].strip() or "video"
            out_key_friendly = f"users/{user_id}/output/{safe_name}_with_subtitles.mp4"
            out_key_fallback = f"users/{user_id}/output/burn_{task_id}.mp4"
            try:
                s3_client.upload_file(out_path, bucket, out_key_friendly, ExtraArgs={'ContentType': 'video/mp4'})
                out_key = out_key_friendly
            except Exception:
                out_key = out_key_fallback
                s3_client.upload_file(out_path, bucket, out_key, ExtraArgs={'ContentType': 'video/mp4'})
            burn_tasks[task_id] = {'status': 'completed', 'output_s3_key': out_key}

            if notify_email:
                try:
                    presigned = s3_client.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': bucket, 'Key': out_key},
                        ExpiresIn=86400
                    )
                    _send_burn_ready_email(notify_email, presigned, safe_name)
                except Exception as e:
                    logging.warning("Notify email failed: %s", e)
    except Exception as e:
        logging.exception("burn task failed")
        burn_tasks[task_id] = {'status': 'failed', 'error': str(e)}


@app.route('/api/burn_subtitles_server', methods=['POST'])
def burn_subtitles_server():
    """Start burn job (RunPod if configured, local fallback). Returns task_id for polling."""
    try:
        data = request.json or {}
        input_s3_key = data.get('input_s3_key')
        segments = data.get('segments', [])
        user_id = data.get('userId') or data.get('user_id')
        subtitle_style = (data.get('subtitle_style') or 'tiktok').strip() or 'tiktok'
        is_portrait = bool(data.get('is_portrait'))
        force_local_burn = bool(data.get('force_local_burn'))
        notify_email = (data.get('notify_email') or '').strip() or None
        job_id = data.get('job_id')
        if not input_s3_key or not segments or not user_id:
            return jsonify({"error": "input_s3_key, segments, and userId required"}), 400
        if not input_s3_key.startswith(f"users/{user_id}/"):
            return jsonify({"error": "Access denied"}), 403

        task_id = str(uuid.uuid4())
        burn_tasks[task_id] = {'status': 'processing'}

        use_runpod = bool((RUNPOD_API_KEY or '').strip() and (RUNPOD_MOVIE_ENDPOINT_ID or '').strip()) and not SIMULATION_MODE and not force_local_burn
        if use_runpod:
            public_base = _public_base_url(request)
            callback_url = f"{public_base}/api/burn_subtitles_callback"
            try:
                _queue_burn_task_on_runpod(
                    task_id=task_id,
                    input_s3_key=input_s3_key,
                    segments=segments,
                    user_id=user_id,
                    callback_url=callback_url,
                    subtitle_style=subtitle_style,
                    is_portrait=is_portrait,
                    notify_email=notify_email,
                    job_id=job_id
                )
                return jsonify({"task_id": task_id, "status": "processing", "mode": "runpod"}), 202
            except Exception as e:
                logging.warning("RunPod burn dispatch failed; falling back to local ffmpeg: %s", e)

        # Local fallback (existing behavior)
        t = threading.Thread(
            target=_run_burn_task,
            args=(task_id, input_s3_key, segments, user_id),
            kwargs={'subtitle_style': subtitle_style, 'is_portrait': is_portrait, 'notify_email': notify_email, 'job_id': job_id}
        )
        t.daemon = True
        t.start()
        burn_tasks[task_id]['mode'] = 'local'
        return jsonify({"task_id": task_id, "status": "processing", "mode": "local"}), 202
    except Exception as e:
        logging.exception("burn_subtitles_server")
        return jsonify({"error": str(e)}), 500


@app.route('/api/burn_subtitles_callback', methods=['POST'])
def burn_subtitles_callback():
    """RunPod worker callback for movie burn completion/failure."""
    try:
        data = request.json or {}
        candidates = [
            data,
            data.get('input') if isinstance(data.get('input'), dict) else {},
            data.get('output') if isinstance(data.get('output'), dict) else {},
            data.get('result') if isinstance(data.get('result'), dict) else {},
        ]

        def _pick(keys):
            for c in candidates:
                for k in keys:
                    v = c.get(k) if isinstance(c, dict) else None
                    if v not in (None, ''):
                        return v
            return None

        task_id = _pick(['task_id', 'taskId', 'id'])
        if not task_id:
            return jsonify({"error": "task_id required"}), 400

        status_raw = str(_pick(['status']) or 'processing').strip().lower()
        output_s3_key = _pick(['output_s3_key', 'outputS3Key'])
        error_text = _pick(['error', 'message']) or ''

        info = burn_tasks.get(task_id) or {}
        if status_raw in ('completed', 'done', 'success', 'succeeded'):
            info['status'] = 'completed'
            if output_s3_key:
                info['output_s3_key'] = output_s3_key
            burn_tasks[task_id] = info
        elif status_raw in ('failed', 'error'):
            info['status'] = 'failed'
            info['error'] = str(error_text or 'RunPod burn failed')
            burn_tasks[task_id] = info
        else:
            info['status'] = 'processing'
            burn_tasks[task_id] = info

        return jsonify({"ok": True, "task_id": task_id, "status": burn_tasks[task_id].get('status')}), 200
    except Exception as e:
        logging.exception("burn_subtitles_callback")
        return jsonify({"error": str(e)}), 500


@app.route('/api/burn_subtitles_status', methods=['GET'])
def burn_subtitles_status():
    """Poll burn task status. When completed, returns output_url (presigned)."""
    try:
        task_id = request.args.get('task_id')
        if not task_id:
            return jsonify({"error": "task_id required"}), 400
        info = burn_tasks.get(task_id)
        if not info:
            return jsonify({"status": "not_found"}), 404
        status = info.get('status', 'processing')
        out = {"task_id": task_id, "status": status}
        if status == 'failed':
            out["error"] = info.get('error', 'Unknown error')
        if status == 'completed':
            output_s3_key = info.get('output_s3_key')
            if output_s3_key:
                out["output_s3_key"] = output_s3_key
                s3_client = boto3.client(
                    's3',
                    aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
                    aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
                    region_name=os.environ.get('AWS_REGION')
                )
                url = s3_client.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': os.environ.get('S3_BUCKET'), 'Key': output_s3_key},
                    ExpiresIn=3600
                )
                out["output_url"] = url
                out["download_name"] = "video_with_subtitles.mp4"
        return jsonify(out), 200
    except Exception as e:
        logging.exception("burn_subtitles_status")
        return jsonify({"error": str(e)}), 500


# --- BURN SUBTITLES (LEGACY: in-request, for small files) ---
# Supported video extensions for burn (ffmpeg can read/write these)
BURN_VIDEO_EXTENSIONS = ('.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi')
BURN_VIDEO_MIMES = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
}

@app.route('/api/burn_subtitles', methods=['POST'])
def burn_subtitles():
    """Accept video file + segments JSON; burn subtitles with ffmpeg; return the video file.
    Supports all common video formats (mp4, mov, webm, m4v, mkv, avi)."""
    try:
        video_file = request.files.get('video')
        segments_json = request.form.get('segments')
        if not video_file or not segments_json:
            return jsonify({"error": "Missing video or segments"}), 400
        segments = json.loads(segments_json)
        if not segments:
            return jsonify({"error": "No segments"}), 400

        # Detect extension from form filename or fallback to uploaded filename
        filename = (request.form.get('filename') or video_file.filename or '').strip()
        ext = None
        if filename:
            for e in BURN_VIDEO_EXTENSIONS:
                if filename.lower().endswith(e):
                    ext = e
                    break
        if not ext:
            ext = '.mp4'
        out_ext = ext if ext in BURN_VIDEO_EXTENSIONS else '.mp4'

        ffmpeg_path = _resolve_ffmpeg()
        try:
            subprocess.run([ffmpeg_path, '-version'], capture_output=True, timeout=5)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return jsonify({
                "error": "ffmpeg not found or not runnable. Install ffmpeg and add it to PATH, or set FFMPEG_PATH.",
                "detail": str(e)
            }), 500

        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, 'input' + ext)
            video_file.save(video_path)

            # Build VTT content (VTT uses HH:MM:SS.mmm)
            def to_vtt_ts(s):
                h = int(s // 3600)
                m = int((s % 3600) // 60)
                sec = s % 60
                return f"{h:02d}:{m:02d}:{sec:06.3f}"

            vtt_path = os.path.join(tmpdir, 'subs.vtt')
            with open(vtt_path, 'w', encoding='utf-8') as f:
                f.write("WEBVTT\n\n")
                for seg in segments:
                    start = seg.get('start', 0)
                    end = seg.get('end', start + 1)
                    text = (seg.get('text') or '').replace('\n', ' ')
                    f.write(f"{to_vtt_ts(start)} --> {to_vtt_ts(end)}\n{text}\n\n")

            out_path = os.path.join(tmpdir, 'output' + out_ext)
            # subtitles filter: use file path; on Windows avoid backslash in filter
            vtt_norm = os.path.normpath(vtt_path)
            if os.name == 'nt':
                vtt_norm = vtt_norm.replace('\\', '/').replace(':', '\\:')
            cmd = [
                ffmpeg_path, '-y', '-i', video_path,
                '-vf', f"subtitles={vtt_norm}",
                '-c:a', 'copy',
                out_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                return jsonify({"error": "ffmpeg failed", "stderr": result.stderr}), 500
            if not os.path.exists(out_path):
                return jsonify({"error": "ffmpeg did not produce output"}), 500

            from flask import send_file
            from io import BytesIO
            mimetype = BURN_VIDEO_MIMES.get(out_ext, 'video/mp4')
            download_name = 'video_with_subtitles' + out_ext
            with open(out_path, 'rb') as f:
                out_data = BytesIO(f.read())
            out_data.seek(0)
            return send_file(out_data, as_attachment=True, download_name=download_name, mimetype=mimetype)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Processing timed out"}), 500
    except Exception as e:
        logging.exception("burn_subtitles failed")
        return jsonify({"error": str(e)}), 500


# --- CONTROL ROUTES FOR SIMULATION / PROCESS START ---
@app.route('/api/set_simulation', methods=['POST'])
def set_simulation():
    """Acknowledge simulation request from frontend (e.g. when user presses Play).
    Simulation mode is read-only from env (SIMULATION_MODE); the client cannot
    enable it, so production always uses RunPod regardless of this call."""
    try:
        # Never allow client to enable simulation; only env at startup decides
        return jsonify({"simulation_mode": SIMULATION_MODE}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/start_process', methods=['POST'])
def start_process():
    """Start a detached background process that runs siteapp.py (returns PID).

    Caution: starting another instance of this app may fail if the port is already in use.
    This endpoint is intended for local development/testing only.
    """
    try:
        global spawned_process_pid
        # If we already started one, check if it's alive
        if 'spawned_process_pid' in globals():
            try:
                os.kill(spawned_process_pid, 0)
                return jsonify({"status": "already_running", "pid": spawned_process_pid}), 200
            except Exception:
                pass

        python_exec = sys.executable or 'python'
        cmd = [python_exec, 'siteapp.py']

        if os.name == 'nt':
            # DETACHED/NO WINDOW on Windows
            CREATE_NO_WINDOW = 0x08000000
            p = subprocess.Popen(cmd, cwd=os.getcwd(), creationflags=CREATE_NO_WINDOW)
        else:
            # Detach on POSIX
            p = subprocess.Popen(cmd, cwd=os.getcwd(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setpgrp)

        spawned_process_pid = p.pid
        print(f"Started background process: PID={spawned_process_pid}")
        return jsonify({"status": "started", "pid": spawned_process_pid}), 200

    except Exception as e:
        print(f"Failed to start process: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

# --- WEBSOCKET EVENT HANDLERS ---
@socketio.on('connect')
def handle_connect():
    job_id = request.args.get('jobId')
    if job_id:
        join_room(job_id)
        print(f"CLIENT CONNECTED: Joined room {job_id}")

@socketio.on('disconnect')
def handle_disconnect():
    print("CLIENT DISCONNECTED")

# --- HEALTH CHECK ROUTE ---
@app.route('/health')
def health_check():
    return "OK", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8000))
    socketio.run(app, host='0.0.0.0', port=port)