from gevent import monkey
monkey.patch_all()
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
# Read simulation flag from environment so someone can set it before running
SIMULATION_MODE = str(os.environ.get('SIMULATION_MODE', 'false')).lower() in ('1', 'true', 'yes')

S3_BUCKET = os.environ.get("S3_BUCKET")

app = Flask(__name__) 
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# Configuration for automation
RUNPOD_API_KEY = os.environ.get('RUNPOD_API_KEY')
RUNPOD_ENDPOINT_ID = os.environ.get('RUNPOD_ENDPOINT_ID')
BUCKET_NAME = "quickscribe-v2-12345"

BASE_DIR = pathlib.Path(__file__).resolve().parent

ffmpeg_path = BASE_DIR / "bin" / "ffmpeg"
ffprobe_path = BASE_DIR / "bin" / "ffprobe"

# Ensure executable permissions (Windows strips them)
os.chmod(ffmpeg_path, 0o755)
os.chmod(ffprobe_path, 0o755)

subprocess.run(
    [str(ffmpeg_path), "-version"],
    check=True
)

# Strict settings to keep connections alive
socketio = SocketIO(app,
    cors_allowed_origins="*",
    async_mode='gevent',
    transports=['websocket'],
    ping_timeout=600,
    ping_interval=20,
    manage_session=False
)
print("--- STEP 11: socket io ---")

# --- GLOBAL CACHE ---
job_results_cache = {}

logging.basicConfig(level=logging.INFO)



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
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': os.environ.get('S3_BUCKET'),
                'Key': s3_key
            },
            ExpiresIn=3600
        )

        return jsonify({"url": url})

    except Exception as e:
        print(f"S3 Error: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/save_job_result', methods=['POST'])
def save_job_result():
    """Save transcript segments JSON to S3; return the result_s3_key. Store only the key in DB, not the full JSON."""
    try:
        data = request.json or {}
        user_id = data.get('userId') or data.get('user_id')
        input_s3_key = data.get('input_s3_key') or data.get('s3Key')
        segments = data.get('segments')
        if not user_id or not input_s3_key or segments is None:
            return jsonify({"error": "userId, input_s3_key (or s3Key), and segments required"}), 400
        if not isinstance(segments, list):
            return jsonify({"error": "segments must be an array"}), 400
        # Derive output key: users/{id}/input/name.mp4 -> users/{id}/output/name.json
        if '/input/' in input_s3_key:
            result_s3_key = input_s3_key.replace('/input/', '/output/', 1).rsplit('.', 1)[0] + '.json'
        else:
            base = input_s3_key.rsplit('/', 1)[-1].rsplit('.', 1)[0] or 'output'
            result_s3_key = f"users/{user_id}/output/{base}.json"
        body = json.dumps({"segments": segments}).encode('utf-8')
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
        return jsonify({"result_s3_key": result_s3_key})
    except Exception as e:
        logging.exception("save_job_result failed")
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


@app.route('/settings')
def settings():
    return render_template('settings.html')


@app.route('/history')
def history():
    return render_template('history.html')


@app.route('/legal')
def legal():
    return render_template('legal.html')

# --- UPLOAD & TRIGGER API ---
import time  # Ensure time is imported at the top of your file



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
            "jobId": data.get('jobId'),  # Match 'job_id = job_input.get("jobId")'
            "s3Key": data.get('s3Key'),  # Match 's3_key = job_input.get("s3Key")'
            "task": data.get('task', 'transcribe'),
            "language": data.get('language', 'he'),
            "num_speakers": int(data.get('speakerCount', 2)),
            "diarization": data.get('diarization', False)
        }
    }

    max_retries = 3
    last_error = ""

    for attempt in range(1, max_retries + 1):
        try:
            print(f"DEBUG: Triggering GPU Attempt {attempt}/{max_retries} for {job_id}...")
            response = requests.post(url, json=payload, headers=headers, timeout=10)

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
    if SIMULATION_MODE:
        # Return a fake completed response immediately
        return jsonify({
            "status": "completed",
            "result": {
                "segments": [
                    {"start": 0.0, "end": 2.5, "text": "砖诇讜诐 讞讘讬讘转讬. 讗讝 讝讗转 讛住驻专讬讬讛 砖诇讱? 讻谉. 诪讛 砖诇讜诪讱? ", "speaker": "SPEAKER_00"},
                    {"start": 3.0, "end": 6.0, "text": "诪转讜住讻诇转, 讗谞讬 诇讗 诪讜爪讗转 讗转 讛住驻专 砖谞转转 诇讬 讛诪谞爪讞, 讗讬讱 讝讛 谞拽专讗? 住讜讚 讛住讬驻讜专 讛诪谞爪讞? ", "speaker": "SPEAKER_01"},
                    {"start": 7.0, "end": 10.0, "text": "讻谉, 诇讗 讞砖讜讘, 讗谞讬 讗诪爪讗 讗讜转讜, 讗谞讬 讗诪爪讗 讗讜转讜. 诇讗, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 诪诇讗. 讗讘诇 讻讘专 谞转转讬, 讗讘诇 讻讘专 谞转转讬 ", "speaker": "SPEAKER_00"},
                    {"start": 10.5, "end": 15.0, "text": "诇讻诪讛 讗转 讛住驻专 砖诇讱 讬讜爪讗讜转 诪讙讚专谉, 讜砖诪讞讛 专讘讛. 讗讬讝讛 讻讬祝, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 讛诪讜谉 讘住驻专讬讬讛", "speaker": "SPEAKER_01"},
                    {"start": 0.0, "end": 2.5, "text": "砖诇讜诐 讞讘讬讘转讬. 讗讝 讝讗转 讛住驻专讬讬讛 砖诇讱? 讻谉. 诪讛 砖诇讜诪讱? ", "speaker": "SPEAKER_00"},
                    {"start": 3.0, "end": 6.0, "text": "诪转讜住讻诇转, 讗谞讬 诇讗 诪讜爪讗转 讗转 讛住驻专 砖谞转转 诇讬 讛诪谞爪讞, 讗讬讱 讝讛 谞拽专讗? 住讜讚 讛住讬驻讜专 讛诪谞爪讞? ", "speaker": "SPEAKER_01"},
                    {"start": 7.0, "end": 10.0, "text": "讻谉, 诇讗 讞砖讜讘, 讗谞讬 讗诪爪讗 讗讜转讜, 讗谞讬 讗诪爪讗 讗讜转讜. 诇讗, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 诪诇讗. 讗讘诇 讻讘专 谞转转讬, 讗讘诇 讻讘专 谞转转讬 ", "speaker": "SPEAKER_00"},
                    {"start": 10.5, "end": 15.0, "text": "诇讻诪讛 讗转 讛住驻专 砖诇讱 讬讜爪讗讜转 诪讙讚专谉, 讜砖诪讞讛 专讘讛. 讗讬讝讛 讻讬祝, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 讛诪讜谉 讘住驻专讬讬讛", "speaker": "SPEAKER_01"},
                    {"start": 0.0, "end": 2.5, "text": "砖诇讜诐 讞讘讬讘转讬. 讗讝 讝讗转 讛住驻专讬讬讛 砖诇讱? 讻谉. 诪讛 砖诇讜诪讱? ", "speaker": "SPEAKER_00"},
                    {"start": 3.0, "end": 6.0, "text": "诪转讜住讻诇转, 讗谞讬 诇讗 诪讜爪讗转 讗转 讛住驻专 砖谞转转 诇讬 讛诪谞爪讞, 讗讬讱 讝讛 谞拽专讗? 住讜讚 讛住讬驻讜专 讛诪谞爪讞? ", "speaker": "SPEAKER_01"},
                    {"start": 7.0, "end": 10.0, "text": "讻谉, 诇讗 讞砖讜讘, 讗谞讬 讗诪爪讗 讗讜转讜, 讗谞讬 讗诪爪讗 讗讜转讜. 诇讗, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 诪诇讗. 讗讘诇 讻讘专 谞转转讬, 讗讘诇 讻讘专 谞转转讬 ", "speaker": "SPEAKER_00"},
                    {"start": 10.5, "end": 15.0, "text": "诇讻诪讛 讗转 讛住驻专 砖诇讱 讬讜爪讗讜转 诪讙讚专谉, 讜砖诪讞讛 专讘讛. 讗讬讝讛 讻讬祝, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 讛诪讜谉 讘住驻专讬讬讛", "speaker": "SPEAKER_01"},
                    {"start": 0.0, "end": 2.5, "text": "砖诇讜诐 讞讘讬讘转讬. 讗讝 讝讗转 讛住驻专讬讬讛 砖诇讱? 讻谉. 诪讛 砖诇讜诪讱? ", "speaker": "SPEAKER_00"},
                    {"start": 3.0, "end": 6.0, "text": "诪转讜住讻诇转, 讗谞讬 诇讗 诪讜爪讗转 讗转 讛住驻专 砖谞转转 诇讬 讛诪谞爪讞, 讗讬讱 讝讛 谞拽专讗? 住讜讚 讛住讬驻讜专 讛诪谞爪讞? ", "speaker": "SPEAKER_01"},
                    {"start": 7.0, "end": 10.0, "text": "讻谉, 诇讗 讞砖讜讘, 讗谞讬 讗诪爪讗 讗讜转讜, 讗谞讬 讗诪爪讗 讗讜转讜. 诇讗, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 诪诇讗. 讗讘诇 讻讘专 谞转转讬, 讗讘诇 讻讘专 谞转转讬 ", "speaker": "SPEAKER_00"},
                    {"start": 10.5, "end": 15.0, "text": "诇讻诪讛 讗转 讛住驻专 砖诇讱 讬讜爪讗讜转 诪讙讚专谉, 讜砖诪讞讛 专讘讛. 讗讬讝讛 讻讬祝, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 讛诪讜谉 讘住驻专讬讬讛", "speaker": "SPEAKER_01"},
                    {"start": 0.0, "end": 2.5, "text": "砖诇讜诐 讞讘讬讘转讬. 讗讝 讝讗转 讛住驻专讬讬讛 砖诇讱? 讻谉. 诪讛 砖诇讜诪讱? ", "speaker": "SPEAKER_00"},
                    {"start": 3.0, "end": 6.0, "text": "诪转讜住讻诇转, 讗谞讬 诇讗 诪讜爪讗转 讗转 讛住驻专 砖谞转转 诇讬 讛诪谞爪讞, 讗讬讱 讝讛 谞拽专讗? 住讜讚 讛住讬驻讜专 讛诪谞爪讞? ", "speaker": "SPEAKER_01"},
                    {"start": 7.0, "end": 10.0, "text": "讻谉, 诇讗 讞砖讜讘, 讗谞讬 讗诪爪讗 讗讜转讜, 讗谞讬 讗诪爪讗 讗讜转讜. 诇讗, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 诪诇讗. 讗讘诇 讻讘专 谞转转讬, 讗讘诇 讻讘专 谞转转讬 ", "speaker": "SPEAKER_00"},
                    {"start": 10.5, "end": 15.0, "text": "诇讻诪讛 讗转 讛住驻专 砖诇讱 讬讜爪讗讜转 诪讙讚专谉, 讜砖诪讞讛 专讘讛. 讗讬讝讛 讻讬祝, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 讛诪讜谉 讘住驻专讬讬讛", "speaker": "SPEAKER_01"},
                    {"start": 0.0, "end": 2.5, "text": "砖诇讜诐 讞讘讬讘转讬. 讗讝 讝讗转 讛住驻专讬讬讛 砖诇讱? 讻谉. 诪讛 砖诇讜诪讱? ", "speaker": "SPEAKER_00"},
                    {"start": 3.0, "end": 6.0, "text": "诪转讜住讻诇转, 讗谞讬 诇讗 诪讜爪讗转 讗转 讛住驻专 砖谞转转 诇讬 讛诪谞爪讞, 讗讬讱 讝讛 谞拽专讗? 住讜讚 讛住讬驻讜专 讛诪谞爪讞? ", "speaker": "SPEAKER_01"},
                    {"start": 7.0, "end": 10.0, "text": "讻谉, 诇讗 讞砖讜讘, 讗谞讬 讗诪爪讗 讗讜转讜, 讗谞讬 讗诪爪讗 讗讜转讜. 诇讗, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 诪诇讗. 讗讘诇 讻讘专 谞转转讬, 讗讘诇 讻讘专 谞转转讬 ", "speaker": "SPEAKER_00"},
                    {"start": 10.5, "end": 15.0, "text": "诇讻诪讛 讗转 讛住驻专 砖诇讱 讬讜爪讗讜转 诪讙讚专谉, 讜砖诪讞讛 专讘讛. 讗讬讝讛 讻讬祝, 讗谞讬 讗讘讬讗 诇讱, 讬砖 诇讬 讛诪讜谉 讘住驻专讬讬讛", "speaker": "SPEAKER_01"}
                ]
            }
        })
    # Check the global cache we created earlier
    if job_id in job_results_cache:
        print(f"馃攷 Client checked status for {job_id} -> Found completed result!")
        return jsonify(job_results_cache[job_id])

    # If not in cache, it's still processing (or lost, but let's assume processing)
    return jsonify({"status": "processing"}), 202

# --- GPU FEEDBACK API ---
# --- 1. Add Global Cache at the top ---
job_results_cache = {}

# --- 2. Update GPU Callback to SAVE the data ---
# Inside siteapp.py -> gpu_callback
@app.route('/api/gpu_callback', methods=['POST'])
def gpu_callback():
    data = request.json
    job_id = data.get('jobId')

    # Store in cache for persistence
    job_results_cache[job_id] = data

    # EMIT: 'job_status_update' must match the listener in app_logic.js
    socketio.emit('job_status_update', data, room=job_id)
    print(f"DEBUG: Emitted result to room {job_id}")

    return jsonify({"status": "ok"}), 200


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

    # Use a real transcript snippet for the simulation
    transcript_text = [
        "כזה של אהבה וענווה, המון ענווה, המון תחושה שהן...",
        "אבל ראית כמה שונות אחת מהשנייה?",
        "ראית גם את השוני?",
        "שונות ואוהבות, ראיתי שונות ואוהבות."
        "כזה של אהבה וענווה, המון ענווה, המון תחושה שהן...",
        "אבל ראית כמה שונות אחת מהשנייה?",
        "ראית גם את השוני?",
        "שונות ואוהבות, ראיתי שונות ואוהבות."
        "כזה של אהבה וענווה, המון ענווה, המון תחושה שהן...",
        "אבל ראית כמה שונות אחת מהשנייה?",
        "ראית גם את השוני?",
        "שונות ואוהבות, ראיתי שונות ואוהבות."
        "כזה של אהבה וענווה, המון ענווה, המון תחושה שהן...",
        "אבל ראית כמה שונות אחת מהשנייה?",
        "ראית גם את השוני?",
        "שונות ואוהבות, ראיתי שונות ואוהבות."
        "כזה של אהבה וענווה, המון ענווה, המון תחושה שהן...",
        "אבל ראית כמה שונות אחת מהשנייה?",
        "ראית גם את השוני?",
        "שונות ואוהבות, ראיתי שונות ואוהבות."
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

    mock_data = {
        "jobId": jid,
        "status": "completed",
        "result": {"segments": segments}
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

        return jsonify({
            'data': {
                'url': presigned_url,
                's3Key': s3_key,  # This must be saved by the frontend!
                'jobId': job_id
            }
        })

@app.route('/api/trigger_processing', methods=['POST'])
def trigger_processing():
    try:
        if SIMULATION_MODE:
            print("🔮 SIMULATION: Skipping RunPod Trigger")
            return jsonify({"status": "started", "runpod_id": "sim_id_123"})

        data = request.json
        print(f"📩 Received Trigger Request: {data}")

        # --- 1. GET CREDENTIALS & CHECK THEM ---
        endpoint_id = os.environ.get('RUNPOD_ENDPOINT_ID')
        api_key = os.environ.get('RUNPOD_API_KEY')

        print(f"🔑 checking keys... Endpoint ID exists? {bool(endpoint_id)} | API Key exists? {bool(api_key)}")

        if not endpoint_id or not api_key:
            return jsonify({"status": "error", "message": "RunPod Env Vars missing on server"}), 500

        # --- PREPARE DATA ---
        s3_key = data.get('s3Key')
        job_id = data.get('jobId')
        task = data.get('task', 'transcribe')
        language = data.get('language', 'he')
        diarization = data.get('diarization', False)

        try:
            speaker_count = int(data.get('speakerCount', 2))
        except:
            speaker_count = 2

        # --- BUILD PAYLOAD ---
        payload = {
            "input": {
                "s3Key": s3_key,
                "jobId": job_id,
                "task": task,
                "language": language,
                "num_speakers": speaker_count,
                "diarization": diarization
            }
        }

        # Clean the ID to prevent URL errors
        clean_id = str(endpoint_id).strip()
        endpoint_url = f"https://api.runpod.ai/v2/{clean_id}/run"

        headers = {
            "Authorization": f"Bearer {api_key.strip()}",
            "Content-Type": "application/json"
        }

        print(f"🚀 Connecting to RunPod URL: {endpoint_url}")

        # Timeout added to prevent the 500 error from a hanging connection
        response = requests.post(endpoint_url, json=payload, headers=headers, timeout=15)

        if response.status_code != 200:
            print(f"❌ RunPod API Error ({response.status_code}): {response.text}")
            return jsonify({"status": "error", "message": f"RunPod API Rejected Request: {response.status_code}"}), 500

        return jsonify({"status": "started", "runpod_id": response.json().get('id')})

    except Exception as e:
        print(f"❌ trigger_processing CRASHED: {str(e)}")
        import traceback
        traceback.print_exc()  # This will show the exact line of the crash in Koyeb logs
        return jsonify({"status": "error", "message": str(e)}), 500


# --- SIMULATION MODE (for frontend) ---
@app.route('/api/simulation_mode', methods=['GET'])
def get_simulation_mode():
    """Return whether server is in simulation mode so frontend can show subtitle upload hint."""
    return jsonify({"simulation": SIMULATION_MODE}), 200


# --- BURN SUBTITLES (SERVER-SIDE ON KOYEB) ---
# Limits for small CPU: max 10 min, max width 1080
BURN_MAX_DURATION_SEC = 600
BURN_MAX_WIDTH = 1080
burn_tasks = {}  # task_id -> { status, output_s3_key?, error? }

def _resolve_ffmpeg():
    """Return path to ffmpeg: env FFMPEG_PATH, then project bin/, then PATH, then common paths."""
    path = os.environ.get('FFMPEG_PATH', '').strip()
    if path and os.path.isfile(path):
        return path
    if shutil.which('ffmpeg'):
        return shutil.which('ffmpeg')
    # Project bin folder (e.g. QuickScribe/Site/bin/)
    app_dir = os.path.dirname(os.path.abspath(__file__))
    bin_dir = os.path.join(app_dir, 'bin')
    for name in ('ffmpeg', 'ffmpeg.exe'):
        candidate = os.path.join(bin_dir, name)
        if os.path.isfile(candidate):
            return candidate
    if sys.platform != 'win32' and os.path.isfile('/usr/bin/ffmpeg'):
        return '/usr/bin/ffmpeg'
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

def _build_ass(segments, style='tiktok'):
    """Build ASS content. style: tiktok (bold yellow centered), clean, cinematic."""
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
    for seg in segments:
        start = seg.get('start', 0)
        end = seg.get('end', start + 1)
        text = (seg.get('text') or '').replace('\n', ' ').replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}')
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

def _run_burn_task(task_id, input_s3_key, segments, user_id, subtitle_style=None, notify_email=None, job_id=None):
    """Background task: download from S3, check limits, burn subtitles (SRT or ASS by style), upload to S3, optional email."""
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
            try:
                duration, width = _probe_video_with_ffmpeg(ffmpeg_path, video_path)
            except Exception as e:
                burn_tasks[task_id] = {'status': 'failed', 'error': f'Could not read video metadata: {e}'}
                return
            if duration > BURN_MAX_DURATION_SEC or width > BURN_MAX_WIDTH:
                burn_tasks[task_id] = {'status': 'failed', 'error': 'Video exceeds limits (max 10 min, 1080p)'}
                return

            use_ass = subtitle_style in ('tiktok', 'clean', 'cinematic')
            if use_ass:
                ass_content = _build_ass(segments, subtitle_style or 'tiktok')
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
            vf = f"scale=min(1080\\,iw):-2,{filter_name}='{subs_escaped}'"
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
    """Start server-side burn (async). Limits: max 10 min, max width 1080. Returns task_id for polling."""
    try:
        data = request.json or {}
        input_s3_key = data.get('input_s3_key')
        segments = data.get('segments', [])
        duration_seconds = data.get('duration_seconds')
        width_px = data.get('width_px')
        user_id = data.get('userId') or data.get('user_id')
        subtitle_style = (data.get('subtitle_style') or 'tiktok').strip() or 'tiktok'
        notify_email = (data.get('notify_email') or '').strip() or None
        job_id = data.get('job_id')
        if not input_s3_key or not segments or not user_id:
            return jsonify({"error": "input_s3_key, segments, and userId required"}), 400
        if duration_seconds is not None and (duration_seconds > BURN_MAX_DURATION_SEC or duration_seconds <= 0):
            return jsonify({"error": "Video must be under 10 minutes for this feature"}), 400
        if width_px is not None and width_px > BURN_MAX_WIDTH:
            return jsonify({"error": "Video resolution must be 1080p or lower for this feature"}), 400
        if not input_s3_key.startswith(f"users/{user_id}/"):
            return jsonify({"error": "Access denied"}), 403

        task_id = str(uuid.uuid4())
        burn_tasks[task_id] = {'status': 'processing'}
        t = threading.Thread(
            target=_run_burn_task,
            args=(task_id, input_s3_key, segments, user_id),
            kwargs={'subtitle_style': subtitle_style, 'notify_email': notify_email, 'job_id': job_id}
        )
        t.daemon = True
        t.start()
        return jsonify({"task_id": task_id, "status": "processing"}), 202
    except Exception as e:
        logging.exception("burn_subtitles_server")
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
            ffmpeg_path = _resolve_ffmpeg()
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