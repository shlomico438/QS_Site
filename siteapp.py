from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room
import os
import boto3
import json

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

# Initialize SocketIO for live transcription delivery
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

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
def about(): return render_template('about.html')


# --- STREAMING API ---

@app.route('/api/upload_streaming_chunk', methods=['POST'])
def upload_streaming_chunk():
    """
    Receives an independent 30s chunk and pushes it to S3 immediately.
    Expected form data: file, filename, jobId
    """
    try:
        file = request.files.get('file')
        job_id = request.form.get('jobId')
        filename = request.form.get('filename')  # e.g., chunk_001.webm

        if not file or not job_id:
            return jsonify({"error": "Missing file or jobId"}), 400

        # Upload directly to S3 under the job_id prefix
        # Path: input/job_12345/chunk_001.webm
        s3_key = f"input/{job_id}/{filename}"

        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            s3_key,
            ExtraArgs={"ContentType": "video/webm"}  # Common for browser recordings
        )

        print(f"DEBUG: Streaming chunk {filename} uploaded for {job_id}")
        return jsonify({"message": "Chunk uploaded", "jobId": job_id}), 200

    except Exception as e:
        print(f"STREAMING ERROR: {e}")
        return jsonify({"error": str(e)}), 500


# --- GPU FEEDBACK API ---

@app.route('/api/push_transcription/<job_id>', methods=['POST'])
def push_transcription(job_id):
    """
    Endpoint for the GPU to send back the finished text for a specific chunk.
    """
    try:
        data = request.json  # {"text": "...", "chunkIndex": 0}

        # Broadcast the text to the specific user via WebSockets
        socketio.emit('new_transcription', data, room=job_id)

        print(f"DEBUG: Pushed chunk {data.get('chunkIndex')} text to user {job_id}")
        return jsonify({"status": "success"}), 200
    except Exception as e:
        print(f"PUSH ERROR: {e}")
        return jsonify({"error": str(e)}), 500


# --- WEBSOCKET EVENT HANDLERS ---

@socketio.on('connect')
def handle_connect():
    # User provides their jobId in the connection string to join their private room
    job_id = request.args.get('jobId')
    if job_id:
        join_room(job_id)
        print(f"CLIENT CONNECTED: Joined room {job_id}")


@socketio.on('disconnect')
def handle_disconnect():
    print("CLIENT DISCONNECTED")


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8000))
    # Note: Use socketio.run instead of app.run for WebSockets
    socketio.run(app, host='0.0.0.0', port=port)