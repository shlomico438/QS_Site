from flask import Flask, render_template, request, redirect, url_for, jsonify
import os

app = Flask(__name__)

# --- הגדרות (בעתיד יבואו ממשתני סביבה ב-Render) ---
UPLOAD_FOLDER = 'temp_uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# --- הנתיב הראשי (דף הבית) ---
@app.route('/')
def index():
    # מציג את קובץ ה-HTML שבתיקיית templates
    return render_template('index.html')

# --- API: טיפול בהעלאת קובץ ---
@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file:
        # בשלב זה אנו רק שומרים את הקובץ זמנית בשרת
        # בעתיד: כאן תהיה השורה ששולחת את הקובץ ל-Cloudflare R2
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(filepath)
        print(f"File saved successfully: {filepath}")
        
        # כאן אפשר להפעיל את סקריפט התמלול שלך בעתיד
        
        return jsonify({'message': 'File uploaded successfully!', 'filename': file.filename}), 200

# --- ZOOM API: התחלת תהליך חיבור (OAuth) ---
@app.route('/zoom/login')
def zoom_login():
    # זהו נתיב דמה כרגע.
    # בעתיד, כאן נבנה את הלינק ששולח את המשתמש לאתר של זום לאשר הרשאות.
    # תצטרכי Zoom Client ID בשביל זה.
    print("User clicked Connect Zoom")
    return "Redirecting to Zoom for approval... (This needs Zoom App Credentials to work correctly)"

# --- ZOOM API: הכתובת שאליה זום מחזיר את המשתמש ---
@app.route('/zoom/callback')
def zoom_callback():
    # לכאן זום יחזיר את המשתמש עם "קוד" סודי אחרי שהוא אישר.
    # השרת יקח את הקוד וישמור אותו בבסיס הנתונים (Neon).
    code = request.args.get('code')
    return f"Zoom Connected! Received auth code (not saved yet): {code}"


if __name__ == '__main__':
    # הרצת השרת במצב פיתוח מקומי
    app.run(debug=True, port=5000)