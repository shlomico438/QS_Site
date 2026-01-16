from flask import Flask, render_template, request, redirect, url_for, jsonify
import os
import boto3

# Initialize the Flask application FIRST
app = Flask(__name__)
# Set the maximum upload size to 100 Megabytes
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

# Initialize S3 Client using Environment Variables
s3_client = boto3.client(
    's3',
    aws_access_key_id=os.environ.get('AWS_ACCESS_KEY'),
    aws_secret_access_key=os.environ.get('AWS_SECRET_KEY'),
    region_name='eu-north-1' # Ensure this matches your bucket region
)
BUCKET_NAME = "quickscribe-v2-12345"

# Define a safe temporary directory
TEMP_DIR = "/tmp"


@app.route('/api/upload_chunk', methods=['POST'])
def upload_chunk():
    try:
        file = request.files.get('file')
        filename = request.form.get('filename')
        chunk_index = int(request.form.get('chunkIndex'))
        total_chunks = int(request.form.get('totalChunks'))

        if not file or not filename:
            return jsonify({"error": "Invalid chunk data"}), 400

        # Create the temp path
        temp_path = os.path.join(TEMP_DIR, filename)

        # Append this chunk to the file
        # 'ab' mode = Append Binary (crucial for videos!)
        with open(temp_path, 'ab') as f:
            f.write(file.read())

        # Check if this was the LAST chunk
        if chunk_index + 1 == total_chunks:
            print(f"DEBUG: Assembly complete. Uploading {filename} to S3...")

            # Now upload the FULL file from disk to S3
            with open(temp_path, 'rb') as f:
                s3_client.upload_fileobj(
                    f,
                    BUCKET_NAME,
                    f"input/{filename}",  # Or strip the timestamp if you prefer
                    ExtraArgs={"ContentType": "video/mp4"}  # Assuming MP4 for now
                )

            # Cleanup: Delete the temp file to free up disk space
            os.remove(temp_path)

            return jsonify({"message": "File uploaded successfully"}), 200

        return jsonify({"message": f"Chunk {chunk_index} received"}), 200

    except Exception as e:
        print(f"CHUNK ERROR: {e}")
        return jsonify({"error": str(e)}), 500

# --- Routes ---

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

# --- API: Handling Uploads ---
@app.route('/api/upload', methods=['POST'])
def upload_file():
    file = request.files.get('file')
    if not file:
        return jsonify({"error": "No file"}), 400

    try:
        # ENSURE the cursor is at the very beginning of the file
        file.seek(0)

        # Use upload_fileobj - it is the most reliable for Flask file objects
        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            f"input/{filename}",
            ExtraArgs={
                "ContentType": file.content_type  # Matches the file type (mp3/mp4)
            }
        )

        # Log to the terminal so you can see it in Koyeb
        print(f"DEBUG: Successfully uploaded {file.filename} to {BUCKET_NAME}")

        return jsonify({"message": "Upload successful"}), 200

    except Exception as e:
        print(f"DEBUG S3 ERROR: {str(e)}")  # This is vital for debugging
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # Use 0.0.0.0 for Koyeb compatibility
    port = int(os.environ.get("PORT", 8000))
    app.run(host='0.0.0.0', port=port)