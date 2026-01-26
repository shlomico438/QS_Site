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
        # קבלת מספר הדוברים (ברירת מחדל 2 אם לא נשלח)
        num_speakers = request.form.get('speakerCount', 2)

        if not file or not job_id:
            return jsonify({"status": "error", "message": "Missing file or jobId"}), 400

        # 1. העלאה ל-S3 (כפי שהיה קודם)
        s3_key = f"input/{job_id}.mp3"
        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={"ContentType": "audio/mpeg"}
        )
        print(f"DEBUG: Full file uploaded to S3: {s3_key}")

        # 2. בניית ה-Payload ל-RunPod עם מספר הדוברים
        payload = {
            "input": {
                "jobId": job_id,
                "s3Key": s3_key,
                "num_speakers": int(num_speakers)  # המרה למספר שלם
            }
        }

        # 3. הפעלת ה-GPU ב-RunPod
        # וודא שהגדרת את RUNPOD_ENDPOINT_URL ו-RUNPOD_API_KEY ב-ENV
        headers = {
            "Authorization": f"Bearer {os.environ.get('RUNPOD_API_KEY')}",
            "Content-Type": "application/json"
        }

        # שליחת הבקשה ל-RunPod
        runpod_url = f"https://api.runpod.ai/v2/{os.environ.get('RUNPOD_ENDPOINT_ID')}/run"
        response = requests.post(runpod_url, json=payload, headers=headers, timeout=15)

        # בדיקה אם ה-RunPod קיבל את העבודה בהצלחה
        if response.status_code not in [200, 201]:
            raise Exception(f"RunPod returned status {response.status_code}: {response.text}")

        return jsonify({
            "status": "success",
            "message": "File uploaded and GPU triggered",
            "runpod_job_id": response.json().get("id")
        })

    except Exception as e:
        # כאן נתפסת שגיאת ה-ConnectionResetError או כל תקלה אחרת
        error_msg = str(e)
        print(f"FAILED TO TRIGGER GPU: {error_msg}")

        # החזרת JSON עם סטטוס שגיאה - זה מה שיגרום ל-Frontend להפוך לאדום ולעצור
        return jsonify({
            "status": "error",
            "message": f"Server Error: {error_msg}"
        }), 500

def trigger_gpu_job(job_id, s3_key):
    """Initiates the RunPod Serverless task."""
    if not RUNPOD_API_KEY or not RUNPOD_ENDPOINT_ID:
        print("ERROR: RunPod keys not found in environment variables.")
        return
    url = f"https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/run"
    headers = {
        "Authorization": f"Bearer {RUNPOD_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "input": {
            "jobId": job_id,
            "s3Key": s3_key
        }
    }
    try:
        # Asynchronous call - we don't wait for the GPU here
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        print(f"GPU TRIGGERED: {response.json()}")
    except Exception as e:
        print(f"FAILED TO TRIGGER GPU: {e}")
        return jsonify({
                    "status": "error",
                    "message": e
                }), 500

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