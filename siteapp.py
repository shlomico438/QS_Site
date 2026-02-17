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
from dotenv import load_dotenv

# --- CONFIGURATION ---
SIMULATION_MODE = False  # <--- Set to False when deploying to Koyeb
if SIMULATION_MODE is True:
    load_dotenv()
S3_BUCKET = os.environ.get("S3_BUCKET")
# Note: We don't need the keys here, we need them inside the function

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# Configuration for automation
RUNPOD_API_KEY = os.environ.get('RUNPOD_API_KEY')
RUNPOD_ENDPOINT_ID = os.environ.get('RUNPOD_ENDPOINT_ID')
BUCKET_NAME = "quickscribe-v2-12345"

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
        data = request.json
        s3_key = data.get('s3Key')

        if not s3_key:
            return jsonify({"error": "No s3Key provided"}), 400

        # Initialize S3 client with your specific credentials
        s3_client = boto3.client(
            's3',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
            region_name=os.environ.get('AWS_REGION')
        )
        # The correct way to access the region in boto3
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={
                'Bucket': os.environ.get('S3_BUCKET_NAME'),
                'Key': s3_key
            },
            ExpiresIn=3600  # Link valid for 1 hour
        )

        return jsonify({"url": url})

    except Exception as e:
        print(f"S3 Error: {str(e)}")  # This will show up in your terminal/logs
        return jsonify({"error": str(e)}), 500

# --- MOCK ROUTE FOR LOCAL DEBUGGING ---
@app.route('/api/mock-upload', methods=['PUT'])
def mock_upload():
    print("SIMULATION: Fake file upload received!")
    return "", 200

@app.after_request
def add_security_headers(resp):
    resp.headers['Cross-Origin-Embedder-Policy'] = 'require-corp'
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

# --- UPLOAD & TRIGGER API ---
import time  # Ensure time is imported at the top of your file



def trigger_gpu_job(job_id, s3_key, num_speakers, language, task):
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

    if SIMULATION_MODE:
        job_id = f"job_sim_{int(time.time())}"
        # We use a consistent key for simulation recovery
        # If you have a specific test file, name it simulation_audio in S3
        s3_key = 'simulation_audio'

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
        s3_key = f"input/{job_id}{extension}"

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