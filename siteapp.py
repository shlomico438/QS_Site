from gevent import monkey
monkey.patch_all()
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room
import os
import boto3
import json
import requests  # Added for RunPod API calls

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

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
@app.route('/api/upload_full_file', methods=['POST'])
def upload_full_file():
    try:
        file = request.files.get('file')
        job_id = request.form.get('jobId')

        if not file or not job_id:
            return jsonify({"error": "Missing file or jobId"}), 400

        # Save to S3 as full mp3
        s3_key = f"input/{job_id}.mp3"

        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={"ContentType": "audio/mpeg"}
        )

        print(f"DEBUG: Full file uploaded to S3: {s3_key}")

        # AUTOMATION: Trigger the GPU worker immediately
        trigger_gpu_job(job_id, s3_key)

        return jsonify({"message": "Upload complete, GPU triggered", "jobId": job_id}), 200
    except Exception as e:
        print(f"UPLOAD ERROR: {e}")
        return jsonify({"error": str(e)}), 500

def trigger_gpu_job(job_id, s3_key):
    print(f"Entering trigger_gpu_job")
    """Initiates the RunPod Serverless task."""
    if not RUNPOD_API_KEY or not RUNPOD_ENDPOINT_ID:
        print("ERROR: RunPod keys not found in environment variables.")
        return
    print(f"Before URL")
    url = f"https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/run"
    print(f"After URL",url)
    headers = {
        "Authorization": f"Bearer {RUNPOD_API_KEY}",
        "Content-Type": "application/json"
    }
    print(f"After headers",url)
    payload = {
        "input": {
            "jobId": job_id,
            "s3Key": s3_key
        }
    }
    print(f"After Payload",url)
    try:
        # Asynchronous call - we don't wait for the GPU here
        print(f"GPU TRIGGERing")
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        print(f"GPU TRIGGERED: {response.json()}")
    except Exception as e:
        print(f"FAILED TO TRIGGER GPU: {e}")

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