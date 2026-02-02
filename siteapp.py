from gevent import monkey
monkey.patch_all()
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room
import json
import requests  # Added for RunPod API calls
import time
import logging
import os
# --- CONFIGURATION ---
SIMULATION_MODE = False  # <--- Set to False when deploying to Koyeb
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

# --- MOCK ROUTE FOR LOCAL DEBUGGING ---
@app.route('/api/mock-upload', methods=['PUT'])
def mock_upload():
    print("🔮 SIMULATION: Fake file upload received!")
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
        prompt = "הנה תמלול מלא של השיחה בעברית, כולל פיסוק מדויק."

    # 3. Build RunPod Payload
    payload = {
        "input": {
            "jobId": job_id,
            "s3Key": s3_key,
            "num_speakers": int(num_speakers),
            "language": language,
            "task": task,
            "initial_prompt": prompt  # <--- NEW FIELD
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
                    {"start": 0.0, "end": 2.5, "text": "This is a simulation test.", "speaker": "SPEAKER_00"},
                    {"start": 3.0, "end": 6.0, "text": "Great! I can check the GUI layout now.",
                     "speaker": "SPEAKER_01"},
                    {"start": 7.0, "end": 10.0, "text": "Does the download button work?", "speaker": "SPEAKER_00"},
                    {"start": 10.5, "end": 15.0, "text": "Yes, checking the pop-up menu.", "speaker": "SPEAKER_01"}
                ]
            }
        })
    # Check the global cache we created earlier
    if job_id in job_results_cache:
        print(f"🔎 Client checked status for {job_id} -> Found completed result!")
        return jsonify(job_results_cache[job_id])

    # If not in cache, it's still processing (or lost, but let's assume processing)
    return jsonify({"status": "processing"}), 202

# --- GPU FEEDBACK API ---
# --- 1. Add Global Cache at the top ---
job_results_cache = {}

# --- 2. Update GPU Callback to SAVE the data ---
@app.route('/api/gpu_callback', methods=['POST'])
def gpu_callback():
    data = request.json
    job_id = data.get('jobId')

    print(f"DEBUG: Received callback for {job_id}")

    # SAVE IT! (The Mailbox)
    job_results_cache[job_id] = data

    # Try to send it live (in case you are lucky and connected)
    socketio.emit('job_status_update', data, room=job_id)

    return jsonify({"status": "ok"}), 200


# --- 3. Update Join Logic to CHECK the Cache ---
@socketio.on('join')
def on_join(data):
    room = data.get('room')
    if room:
        join_room(room)
        print(f"🔌 Client joined room: {room}")

        # CHECK MAILBOX: Is the result already waiting?
        if room in job_results_cache:
            print(f"📦 Found cached result for {room}, sending now!")
            # Send it to this specific user who just reconnected
            socketio.emit('job_status_update', job_results_cache[room], room=request.sid)

@app.route('/api/sign-s3', methods=['POST'])
def sign_s3():
    import time
    import boto3

    if SIMULATION_MODE:
        import time
        print("🔮 SIMULATION: Skipping AWS S3 Signing")
        # Return a URL that points to our own server instead of S3
        return jsonify({
            'data': {
                'signedRequest': 'http://localhost:8000/api/mock-upload',
                'url': 'http://localhost:8000/api/mock-upload',
                'jobId': f"job_sim_{int(time.time())}",
                's3Key': 'simulation_key'
            }
        })
    else:
        data = request.json
        filename = data.get('filename')
        file_type = data.get('filetype')

        # --- DEBUG: PRINT CREDENTIAL STATUS ---
        key_id = os.environ.get("AWS_ACCESS_KEY_ID")
        secret = os.environ.get("AWS_SECRET_ACCESS_KEY")
        region = os.environ.get("AWS_REGION")

        print(f"DEBUG CHECK:")
        print(f"1. Key ID Present? {bool(key_id)} (Length: {len(key_id) if key_id else 0})")
        print(f"2. Secret Present? {bool(secret)} (Length: {len(secret) if secret else 0})")
        print(f"3. Region: '{region}'")

        # Initialize S3 Client ONLY when the user actually asks for it
        # s3_client = boto3.client(
        #     "s3",
        #     aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        #     aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        #     region_name=os.environ.get("AWS_REGION", "eu-north-1")
        # )
        s3_client = boto3.client(
            's3',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_KEY'),
            region_name = os.environ.get('AWS_REGION')
        )
        # 1. Create a clean Job ID
        # We use this ID for the room name, the file name, and the database if you add one later.
        job_id = f"job_{int(time.time())}_{filename}"

        # 2. Set the S3 Key
        # Note: We put it in an 'input/' folder to keep things organized
        s3_key = f"input/{job_id}"

        # 3. Generate the "VIP Pass" (Presigned URL)
        presigned_url = s3_client.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': S3_BUCKET,
                'Key': s3_key,
                'ContentType': file_type
            },
            ExpiresIn=3600
        )

        # 4. Return the specific structure the JavaScript expects
        return jsonify({
            'data': {
                'signedRequest': presigned_url,
                'url': f"https://{S3_BUCKET}.s3.amazonaws.com/{s3_key}",
                'jobId': job_id,
                's3Key': s3_key
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

        # DEBUG: Print status of keys (Don't print the actual key for security)
        print(f"🔑 checking keys... Endpoint ID exists? {bool(endpoint_id)} | API Key exists? {bool(api_key)}")

        if not endpoint_id or not api_key:
            print("❌ CRITICAL ERROR: RUNPOD Environment Variables are missing!")
            return jsonify({"status": "error", "message": "Server Env Vars missing"}), 500

        # --- 2. PREPARE DATA ---
        s3_key = data.get('s3Key')
        job_id = data.get('jobId')
        task = data.get('task', 'transcribe')
        language = data.get('language', 'he')

        try:
            speaker_count = int(data.get('speakerCount', 2))
        except:
            speaker_count = 2

        # --- 3. BUILD PAYLOAD ---
        payload = {
            "input": {
                "s3Key": s3_key,
                "jobId": job_id,
                "task": task,
                "language": language,
                "num_speakers": speaker_count
            }
        }

        # --- 4. SEND REQUEST WITH TIMEOUT & CLEAN URL ---
        # Strip any accidental spaces/newlines from the ID
        clean_id = endpoint_id.strip()
        endpoint_url = f"https://api.runpod.ai/v2/{clean_id}/run"

        headers = {
            "Authorization": f"Bearer {api_key.strip()}",
            "Content-Type": "application/json"
        }

        print(f"🚀 Connecting to RunPod URL: {endpoint_url}")

        # Added 'timeout=10' to prevent hanging
        response = requests.post(endpoint_url, json=payload, headers=headers, timeout=10)

        if response.status_code != 200:
            print(f"❌ RunPod Error ({response.status_code}): {response.text}")
            return jsonify({"status": "error", "message": f"RunPod Error: {response.text}"}), 500

        return jsonify({"status": "started", "runpod_id": response.json().get('id')})

    except requests.exceptions.ConnectionError as ce:
        print(f"❌ Network Connection Error: {ce}")
        return jsonify({"status": "error", "message": "Could not connect to RunPod API"}), 500
    except Exception as e:
        print(f"❌ Server Crash: {str(e)}")
        import traceback
        traceback.print_exc()
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