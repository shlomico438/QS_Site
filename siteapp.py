from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room
import os
import boto3
import json

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

# Strict settings to keep connections alive during long GPU gaps
socketio = SocketIO(app,
    cors_allowed_origins="*",
    async_mode='gevent',
    transports=['websocket'],
    # Send a ping every 20 seconds to prevent Cloudflare/Nginx timeouts
    ping_timeout=120,
    ping_interval=20,
    manage_session=False # Improves performance for high-traffic streaming
)

# Initialize S3 Client
s3_client = boto3.client(
    's3',
    aws_access_key_id=os.environ.get('AWS_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('AWS_SECRET_KEY'),
    region_name='eu-north-1'
)
BUCKET_NAME = "quickscribe-v2-12345"

# --- WEB ROUTES ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/about')
def about():
    return render_template('about.html')

# --- STREAMING API ---
@app.route('/api/upload_full_file', methods=['POST'])
def upload_full_file():
    try:
        file = request.files.get('file')
        job_id = request.form.get('jobId')

        if not file or not job_id:
            return jsonify({"error": "Missing file or jobId"}), 400

        # שמירה ב-S3 כקובץ mp3 מלא ולא כ-bin
        s3_key = f"input/{job_id}.mp3"

        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={"ContentType": "audio/mpeg"}
        )

        print(f"DEBUG: Full file uploaded to S3: {s3_key}")

        trigger_gpu_job(job_id, s3_key)

        return jsonify({"message": "Upload complete, GPU triggered", "jobId": job_id}), 200
    except Exception as e:
        print(f"UPLOAD ERROR: {e}")
        return jsonify({"error": str(e)}), 500

def trigger_gpu_job(job_id, s3_key):
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
        # שליחה אסינכרונית - לא מחכים לתוצאה מה-GPU כאן (היא תגיע ב-Callback)
        response = requests.post(url, json=payload, headers=headers)
        print(f"GPU TRIGGERED: {response.json()}")
    except Exception as e:
        print(f"FAILED TO TRIGGER GPU: {e}")

# @app.route('/api/upload_streaming_chunk', methods=['POST'])
# def upload_streaming_chunk():
#     """
#     Receives a raw binary chunk and pushes it to S3 immediately.
#     """
#     try:
#         file = request.files.get('file')
#         job_id = request.form.get('jobId')
#         filename = request.form.get('filename')
#
#         # Strict validation for all required fields
#         if not file or not job_id or not filename:
#             return jsonify({"error": "Missing fields"}), 400
#
#         # Upload as a raw binary object under the job_id prefix
#         s3_key = f"input/{job_id}/{filename}"
#
#         s3_client.upload_fileobj(
#             file,
#             BUCKET_NAME,
#             s3_key,
#             # Changed to octet-stream to handle raw binary fragments correctly
#             ExtraArgs={"ContentType": "application/octet-stream"}
#         )
#
#         print(f"DEBUG: Binary chunk {filename} uploaded for {job_id}")
#         return jsonify({"message": "Success", "jobId": job_id}), 200
#     except Exception as e:
#         print(f"STREAMING ERROR: {e}")
#         return jsonify({"error": str(e)}), 500

# --- GPU FEEDBACK API ---

@app.route('/api/gpu_callback', methods=['POST'])
def gpu_callback():
    try:
        data = request.json  # Expects {"jobId": "...", "segments": [...], "status": "..."}
        job_id = data.get('jobId')

        if not job_id:
            return jsonify({"error": "Missing jobId"}), 400

        # Broadcast the full data to the room named after the jobId
        # Event name 'job_status_update' must be what your frontend listens for
        socketio.emit('job_status_update', data, room=job_id)

        print(f"DEBUG: Forwarded GPU results to room: {job_id}")
        return jsonify({"status": "success"}), 200
    except Exception as e:
        print(f"CALLBACK ERROR: {e}")
        return jsonify({"error": str(e)}), 500

# --- WEBSOCKET EVENT HANDLERS ---

@socketio.on('connect')
def handle_connect():
    # Matches query: { jobId: "..." } in frontend socket connection
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