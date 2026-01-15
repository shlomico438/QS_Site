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
    region_name='us-east-1' # Ensure this matches your bucket region
)

BUCKET_NAME = "getquickscribe-bucket"

@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400

    try:
        # Stream the file directly to S3
        s3_client.upload_fileobj(
            file,
            BUCKET_NAME,
            file.filename,
            ExtraArgs={"ContentType": file.content_type}
        )
        return jsonify({"message": "Upload successful!"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500
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
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file:
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(filepath)
        return jsonify({'message': 'File uploaded successfully!', 'filename': file.filename}), 200

if __name__ == '__main__':
    # Use 0.0.0.0 for Koyeb compatibility
    port = int(os.environ.get("PORT", 8000))
    app.run(host='0.0.0.0', port=port)