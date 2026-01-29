from gevent import monkey
monkey.patch_all()
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room
import os
import json
import requests  # Added for RunPod API calls
import time
import logging
import os
import boto3

# --- CONFIGURATION ---
S3_BUCKET = os.environ.get("S3_BUCKET")
AWS_ACCESS_KEY = os.environ.get("AWS_ACCESS_KEY_ID")
AWS_SECRET_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

RUNPOD_API_KEY = os.environ.get("RUNPOD_API_KEY")
RUNPOD_ENDPOINT_ID = os.environ.get("RUNPOD_ENDPOINT_ID")

# Initialize S3 Client (Global)
s3_client = boto3.client(
    "s3",
    aws_access_key_id=AWS_ACCESS_KEY,
    aws_secret_access_key=AWS_SECRET_KEY,
    region_name=AWS_REGION
)

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# Configuration for automation
RUNPOD_API_KEY = os.environ.get('RUNPOD_API_KEY')
RUNPOD_ENDPOINT_ID = os.environ.get('RUNPOD_ENDPOINT_ID')
BUCKET_NAME = "quickscribe-v2-12345"

# Strict settings to keep connections alive during long GPU gaps
socketio = SocketIO(app,
    cors_allowed_origins="*",
    async_mode='gevent',
    transports=['websocket'],
    ping_timeout=120,
    ping_interval=20,
    manage_session=False
)

# Initialize S3 Client
s3_client = boto3.client(
    's3',
    aws_access_key_id=os.environ.get('AWS_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('AWS_SECRET_KEY'),
    region_name='eu-north-1'
)


# Configure logging to see errors in Koyeb logs
logging.basicConfig(level=logging.INFO)


@app.errorhandler(413)
def request_entity_too_large(error):
    # Specific error for files exceeding MAX_CONTENT_LENGTH
    return jsonify({
        "status": "error",
        "message": "File too large. Maximum limit is 500MB."
    }), 413


@app.errorhandler(Exception)
def handle_exception(e):
    # Pass through existing HTTP errors (like 404)
    if hasattr(e, 'code'):
        return jsonify({"status": "error", "message": str(e.description)}), e.code

    # Catch-all for unexpected Python crashes (500)
    logging.error(f"Unexpected Server Error: {str(e)}")
    return jsonify({
        "status": "error",
        "message": "Internal server error. Please try again later."
    }), 500
# --- WEB ROUTES ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/blog')
def blog():
    return render_template('blog.html')

@app.route('/contact')
def contact():
    return render_template('contact.html')

# --- UPLOAD & TRIGGER API ---
import time  # Ensure time is imported at the top of your file


@app.route('/api/upload_full_file', methods=['POST'])
def upload_full_file():
    try:
        file = request.files.get('file')
        job_id = request.form.get('jobId')
        # Get speakerCount from form, default to 2
        num_speakers = request.form.get('speakerCount', 2)
        language = request.form.get('language', 'he')
        task = request.form.get('task', 'transcribe')

        if not file or not job_id:
            return jsonify({"error": "Missing file or jobId"}), 400

        # Save to S3 as full mp3
        s3_key = f"input/{job_id}.mp3"

        print(f"DEBUG: Starting S3 upload for {job_id}...")
        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={"ContentType": "audio/mpeg"}
        )
        print(f"DEBUG: Full file uploaded to S3: {s3_key}")

        # AUTOMATION: Trigger the GPU worker with retry logic
        # This will now raise an Exception if it fails 3 times
        trigger_gpu_job(job_id, s3_key, num_speakers,language, task)

        return jsonify({"message": "Upload complete, GPU triggered", "jobId": job_id}), 200

    except Exception as e:
        error_msg = str(e)
        print(f"UPLOAD/TRIGGER ERROR: {error_msg}")
        # Returning 500 here is what triggers the Red Bar in your index.html
        return jsonify({
            "status": "error",
            "message": error_msg
        }), 500


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

    # Payload now includes all 5 parameters to pass to the Worker
    payload = {
        "input": {
            "jobId": job_id,
            "s3Key": s3_key,
            "num_speakers": int(num_speakers),
            "language": language,
            "task": task
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

# --- GPU FEEDBACK API ---
@app.route('/api/gpu_callback', methods=['POST'])
def gpu_callback():
    try:
        data = request.json  # Expects {"jobId": "...", "segments": [...], "status": "..."}
        job_id = data.get('jobId')

        if not job_id:
            return jsonify({"error": "Missing jobId"}), 400

        # Broadcast results to the specific job room
        socketio.emit('job_status_update', data, room=job_id)

        print(f"DEBUG: Forwarded GPU results to room: {job_id}")
        return jsonify({"status": "success"}), 200
    except Exception as e:
        print(f"CALLBACK ERROR: {e}")
        return jsonify({"error": str(e)}), 500


# --- NEW: Get Permission to Upload Direct to S3 ---
@app.route('/api/sign-s3', methods=['POST'])
def sign_s3():
    data = request.json
    filename = data.get('filename')
    file_type = data.get('filetype')

    # Generate a unique S3 key
    s3_key = f"uploads/{int(time.time())}_{filename}"

    # Generate the "Presigned URL" (The VIP Pass)
    presigned_url = s3_client.generate_presigned_url(
        'put_object',
        Params={
            'Bucket': S3_BUCKET,
            'Key': s3_key,
            'ContentType': file_type
        },
        ExpiresIn=3600  # Valid for 1 hour
    )

    return jsonify({
        'url': presigned_url,
        'key': s3_key
    })


@app.route('/api/trigger_processing', methods=['POST'])
def trigger_processing():
    try:
        data = request.json
        s3_key = data.get('s3Key')
        job_id = data.get('jobId')

        print(f"🚀 Triggering Job {job_id} with Key: {s3_key}")

        payload = {
            "input": {
                "jobId": job_id,
                "s3Key": s3_key,
                "num_speakers": int(data.get('speakerCount', 2)),
                "language": data.get('language'),
                "task": data.get('task'),
            }
        }

        # --- RETRY LOGIC (3 Attempts) ---
        for attempt in range(3):
            try:
                print(f"➡️ RunPod Trigger Attempt {attempt + 1}/3...")

                # --- DEBUG: REVEAL THE HIDDEN URL ---
                # We put brackets [] around the ID to see if there are hidden spaces like " id "
                print(f"DEBUG CHECK: ID is [{RUNPOD_ENDPOINT_ID}]")

                #target_url = f"https://api.runpod.io/v2/{RUNPOD_ENDPOINT_ID}/run"
                # Updated to use .ai as per your successful CURL
                target_url = f"https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/run"
                print(f"DEBUG CHECK: Hitting URL [{target_url}]")
                # ------------------------------------

                #response = requests.post(url, json=payload, headers=headers, timeout=10)

                response = requests.post(
                    f"https://api.runpod.io/v2/{RUNPOD_ENDPOINT_ID}/run",
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {RUNPOD_API_KEY}",
                        "Content-Type": "application/json"
                    },
                    timeout=10
                )

                print(f"RunPod Status: {response.status_code}")

                # If successful, return immediately
                if response.status_code == 200:
                    print(f"✅ Success: {response.json()}")
                    return jsonify(response.json())

                # If error, log it and wait before retrying
                print(f"⚠️ Failed: {response.text}")
                time.sleep(1)

            except requests.exceptions.RequestException as e:
                print(f"❌ Network Error (Attempt {attempt + 1}): {str(e)}")
                time.sleep(1)

        # If we reach here, all 3 attempts failed
        return jsonify({
            "status": "error",
            "message": "Failed to contact GPU server after 3 attempts."
        }), 502

    except Exception as e:
        print(f"❌ SYSTEM ERROR: {str(e)}")
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

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8000))
    socketio.run(app, host='0.0.0.0', port=port)