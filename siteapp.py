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
print(f"DEBUG: AWS Key loaded: {os.environ.get('AWS_ACCESS_KEY')[:5]}****")
print(f"DEBUG: AWS Key loaded: {os.environ.get('AWS_SECRET_KEY')[:5]}****")
BUCKET_NAME = "getquickscribe-bucket"


@app.route('/api/upload', methods=['POST'])
def upload_file():
    file = request.files.get('file')
    if not file:
        return jsonify({"error": "No file received by server"}), 400

    # Check if the file actually has data
    file.seek(0, os.SEEK_END)
    size = file.tell()
    if size == 0:
        return jsonify({"error": "File is empty (0 bytes)"}), 400

    # Reset pointer to the start so S3 can read it
    file.seek(0)

    try:
        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            file.filename,
            ExtraArgs={"ContentType": file.content_type}
        )
        return jsonify({"message": f"Success! Uploaded {size} bytes"}), 200
    except Exception as e:
        # This will show the REAL S3 error in your blue status text
        return jsonify({"error": f"S3 Error: {str(e)}"}), 500

app = Flask(__name__)
# --- Settings ---
UPLOAD_FOLDER = 'temp_uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

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
            file.filename,
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