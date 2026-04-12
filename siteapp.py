from gevent import monkey
monkey.patch_all()

# Load .env so GPT_API_KEY (and others) are available for simulation and translate_segments
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import Flask, render_template, request, jsonify, redirect
from flask_socketio import SocketIO, join_room
import json
import requests  # Added for RunPod API calls
import time
import logging
import boto3
from botocore.exceptions import ClientError
import os
import re
import subprocess
import shutil
import sys
import tempfile
import threading
import uuid
import pathlib
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import zipfile
from io import BytesIO
import smtplib
import ssl
from email.message import EmailMessage


# --- CONFIGURATION ---
# Read simulation flag from environment. Default True for local dev (F5); set SIMULATION_MODE=0 or false in production (e.g. Koyeb).
SIMULATION_MODE = str(os.environ.get('SIMULATION_MODE', 'true')).lower() in ('1', 'true', 'yes')

# App root (for Node translate script)
APP_ROOT = pathlib.Path(__file__).resolve().parent
TRANSLATE_SCRIPT = APP_ROOT / 'scripts' / 'translate.js'

S3_BUCKET = os.environ.get("S3_BUCKET")

# GPT clean transcript + DOCX export: max characters per wrapped line (override with TRANSCRIPT_LINE_MAX_CHARS).
TRANSCRIPT_LINE_MAX_CHARS = int(os.environ.get("TRANSCRIPT_LINE_MAX_CHARS", "200"))


def _safe_rsid(value, fallback):
    s = str(value or '').strip().upper()
    return s if re.fullmatch(r'[0-9A-F]{8}', s) else fallback


# DOCX RSIDs (override only if you know what you're doing; must be 8-char hex).
DOCX_RSID_ROOT = _safe_rsid(os.environ.get("DOCX_RSID_ROOT"), "00CA5FDD")
DOCX_RSID_P = _safe_rsid(os.environ.get("DOCX_RSID_P"), "009F2D46")

app = Flask(__name__) 
app.config['SECRET_KEY'] = 'secret_scribe_key_123'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# Configuration for automation
RUNPOD_API_KEY = os.environ.get('RUNPOD_API_KEY')
RUNPOD_ENDPOINT_ID = os.environ.get('RUNPOD_ENDPOINT_ID')
RUNPOD_MOVIE_ENDPOINT_ID = os.environ.get('RUNPOD_MOVIE_ENDPOINT_ID') or RUNPOD_ENDPOINT_ID
BUCKET_NAME = "quickscribe-v2-12345"


def _runpod_skip_warmup():
    """If true, do not POST RunPod /run from sign-s3; first /run happens in trigger_processing after upload."""
    v = (os.environ.get('RUNPOD_SKIP_WARMUP') or '').strip().lower()
    return v in ('1', 'true', 'yes', 'on')


def _public_base_url(req):
    """Best-effort public base URL for third-party callbacks (RunPod -> site)."""
    explicit = (os.environ.get('PUBLIC_BASE_URL') or '').strip().rstrip('/')
    if explicit:
        return explicit
    root = (req.url_root or '').rstrip('/')
    xfp = (req.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip().lower()
    # Behind reverse proxies, Flask may see http internally. Prefer https for public hosts.
    if root.startswith('http://') and (xfp == 'https' or str(req.host or '').endswith('getquickscribe.com')):
        root = 'https://' + root[len('http://'):]
    return root


def _is_local_host(host):
    h = str(host or '').split(':')[0].strip().lower()
    return h in ('localhost', '127.0.0.1', '::1') or h.endswith('.local')


@app.before_request
def enforce_https_on_proxy():
    """Force HTTPS behind reverse proxies (e.g. Koyeb) via X-Forwarded-Proto."""
    # Allow explicit opt-out for local/dev debugging.
    if str(os.environ.get('DISABLE_HTTPS_REDIRECT', '')).strip().lower() in ('1', 'true', 'yes', 'on'):
        return None
    if _is_local_host(request.host):
        return None
    if request.path.startswith('/health'):
        return None

    xfp = (request.headers.get('X-Forwarded-Proto') or '').split(',')[0].strip().lower()
    # If proxy explicitly says HTTPS, or app already sees HTTPS, do nothing.
    if xfp == 'https' or request.is_secure:
        return None

    # Only redirect when proxy indicates HTTP (or header missing but url is http).
    if xfp == 'http' or request.url.startswith('http://'):
        https_url = request.url.replace('http://', 'https://', 1)
        return redirect(https_url, code=301)
    return None


def _xml_esc(text):
    """Escape XML special characters in text content."""
    return (str(text)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;'))


def _merge_caption_lines_into_paragraphs(text):
    """Normalize transcript text before wrap: cue-style newlines and GPT 'micro-paragraphs'.

    1) Split on blank lines, collapse single newlines inside each block to spaces.
    2) Merge *runs* of short blocks (typical ~27-char subtitle cues, or GPT using \\n\\n
       between every cue line) into one paragraph so DOCX does not stay narrow from line 1.
    """
    text = str(text or "").strip()
    if not text:
        return text
    blocks = re.split(r'(?:\r?\n\s*){2,}', text)
    collapsed = []
    for block in blocks:
        line = re.sub(r'\s*\r?\n\s*', ' ', block)
        line = re.sub(r' {2,}', ' ', line).strip()
        if line:
            collapsed.append(line)
    if not collapsed:
        return ""
    # GPT often uses \n\n between hard-wrapped ~30–80 char fragments; merge those runs into real paragraphs.
    # Threshold just below line wrap so typical cue/GPT fragments merge; longer \n\n-separated blocks stay separate.
    short_thresh = min(TRANSCRIPT_LINE_MAX_CHARS, int(os.environ.get('FORMAT_SHORT_PARA_MERGE_CHARS', '120')))
    merged = []
    buf = []
    for p in collapsed:
        if len(p) <= short_thresh:
            buf.append(p)
        else:
            if buf:
                merged.append(' '.join(buf))
                buf = []
            merged.append(p)
    if buf:
        merged.append(' '.join(buf))
    return '\n\n'.join(merged)


def _wrap_line_max_chars(text, max_chars=None):
    """Wrap a single line by spaces so each physical line is <= max_chars."""
    if max_chars is None:
        max_chars = TRANSCRIPT_LINE_MAX_CHARS
    s = str(text or "").strip()
    if not s:
        return []
    out = []
    rest = s
    while len(rest) > max_chars:
        cut = rest.rfind(' ', 0, max_chars + 1)
        if cut <= 0:
            cut = max_chars
        out.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        out.append(rest)
    return out


def _wrap_text_to_max_chars(text, max_chars=None):
    """Wrap multi-line text to max chars per line, preserving paragraph breaks."""
    if max_chars is None:
        max_chars = TRANSCRIPT_LINE_MAX_CHARS
    text = _merge_caption_lines_into_paragraphs(text)
    result = []
    for raw_line in str(text or "").splitlines():
        if not raw_line.strip():
            result.append("")
            continue
        result.extend(_wrap_line_max_chars(raw_line, max_chars=max_chars))
    return "\n".join(result).strip()


def _build_rtl_docx(lines, bold_first=False):
    """
    Build a guaranteed-RTL DOCX completely from scratch as a ZIP with
    hand-crafted XML.  No python-docx template is loaded so every byte is
    under our control — namespace prefixes, element ordering, and RTL flags
    are exactly what Word expects.
    """
    # ---- paragraph XML ----
    para_xmls = []
    for i, line in enumerate(lines):
        line_s = str(line or '').strip()
        bold = bold_first and i == 0
        # Match empiric Word LTR->RTL diff: rsidP on paragraph + jc="left" within bidi paragraph.
        ppr = '<w:pPr><w:bidi w:val="1"/><w:jc w:val="left"/></w:pPr>'
        p_open = f'<w:p w:rsidP="{DOCX_RSID_P}">'
        if not line_s:
            para_xmls.append(f'{p_open}{ppr}</w:p>')
        else:
            b_tags = '<w:b/><w:bCs/>' if bold else ''
            rpr = (f'<w:rPr>{b_tags}'
                   '<w:rFonts w:ascii="David" w:hAnsi="David" w:cs="David"/>'
                   '<w:sz w:val="24"/><w:szCs w:val="24"/>'
                   '<w:rtl w:val="1"/>'
                   '<w:lang w:val="he-IL" w:bidi="he-IL"/></w:rPr>')
            t   = f'<w:t xml:space="preserve">{_xml_esc(line_s)}</w:t>'
            para_xmls.append(f'{p_open}{ppr}<w:r>{rpr}{t}</w:r></w:p>')

    body = '\n'.join(para_xmls)

    # ---- [Content_Types].xml ----
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels"'
        ' ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml"'
        ' ContentType="application/vnd.openxmlformats-officedocument'
        '.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml"'
        ' ContentType="application/vnd.openxmlformats-officedocument'
        '.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/settings.xml"'
        ' ContentType="application/vnd.openxmlformats-officedocument'
        '.wordprocessingml.settings+xml"/>'
        '</Types>'
    )

    # ---- _rels/.rels ----
    pkg_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1"'
        ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"'
        ' Target="word/document.xml"/>'
        '</Relationships>'
    )

    # ---- word/_rels/document.xml.rels ----
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1"'
        ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"'
        ' Target="styles.xml"/>'
        '<Relationship Id="rId2"'
        ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings"'
        ' Target="settings.xml"/>'
        '</Relationships>'
    )

    # ---- word/styles.xml ---- RTL at every level
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:docDefaults>'
        '<w:rPrDefault><w:rPr>'
        '<w:rFonts w:ascii="David" w:hAnsi="David" w:cs="David"/>'
        '<w:sz w:val="24"/><w:szCs w:val="24"/>'
        '<w:lang w:val="he-IL" w:bidi="he-IL"/>'
        '</w:rPr></w:rPrDefault>'
        '<w:pPrDefault><w:pPr>'
        '<w:bidi w:val="1"/><w:jc w:val="right"/>'
        '</w:pPr></w:pPrDefault>'
        '</w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
        '<w:name w:val="Normal"/>'
        '<w:pPr><w:bidi w:val="1"/><w:jc w:val="right"/></w:pPr>'
        '<w:rPr>'
        '<w:rFonts w:ascii="David" w:hAnsi="David" w:cs="David"/>'
        '<w:sz w:val="24"/><w:szCs w:val="24"/>'
        '<w:rtl w:val="1"/>'
        '<w:lang w:val="he-IL" w:bidi="he-IL"/>'
        '</w:rPr>'
        '</w:style>'
        '</w:styles>'
    )

    # ---- word/settings.xml ----
    settings = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:defaultTabStop w:val="720"/>'
        '<w:rsids>'
        f'<w:rsidRoot w:val="{DOCX_RSID_ROOT}"/>'
        f'<w:rsid w:val="{DOCX_RSID_P}"/>'
        f'<w:rsid w:val="{DOCX_RSID_ROOT}"/>'
        '</w:rsids>'
        '</w:settings>'
    )

    # ---- word/document.xml ----
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document'
        ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<w:body>'
        f'{body}'
        '<w:sectPr>'
        '<w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"'
        ' w:header="708" w:footer="708" w:gutter="0"/>'
        '</w:sectPr>'
        '</w:body>'
        '</w:document>'
    )

    out = BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types)
        zf.writestr('_rels/.rels', pkg_rels)
        zf.writestr('word/_rels/document.xml.rels', doc_rels)
        zf.writestr('word/document.xml', document)
        zf.writestr('word/styles.xml', styles)
        zf.writestr('word/settings.xml', settings)

    return out.getvalue()


def _force_docx_rtl_bytes(docx_bytes):
    """
    Patch RTL/right-alignment directly in the DOCX ZIP using regex string
    substitution — never re-parses XML so all OOXML namespace prefixes are
    preserved exactly (ElementTree re-serialisation was mangling them).

    What we inject per paragraph (w:pPr):
      <w:bidi/>                  — paragraph base direction = RTL
      <w:jc w:val="right"/>      — paragraph alignment = right  (= Ctrl+R)

    What we inject per run (w:rPr):
      <w:rtl/>                   — run direction = RTL (needed for mixed text)

    We also patch word/styles.xml so the Normal style and docDefaults
    inherit the same defaults, which means a new empty paragraph is also RTL.
    """

    _BIDI    = '<w:bidi w:val="1"/>'
    _JC      = '<w:jc w:val="right"/>'
    _RTL_RUN = '<w:rtl w:val="1"/>'

    # --- helpers --------------------------------------------------------

    def _strip(tag, xml):
        """Remove all occurrences of <tag .../> or <tag...>...</tag>."""
        xml = re.sub(r'<' + tag + r'(?:\s[^/]*)*/>', '', xml)
        xml = re.sub(r'<' + tag + r'(?:\s[^>]*)?>.*?</' + tag + r'>', '', xml, flags=re.DOTALL)
        return xml

    def _patch_ppr_inner(inner):
        """Given the content between <w:pPr> and </w:pPr>, enforce bidi+jc.
        w:pStyle MUST stay first in pPr — Word silently drops paragraphs otherwise."""
        inner = _strip('w:bidi', inner)
        inner = _strip('w:jc',   inner)
        # Keep pStyle first if present; insert bidi+jc immediately after it
        m = re.match(r'(\s*<w:pStyle\b[^/]*/>\s*)', inner)
        if m:
            return m.group(0) + _BIDI + _JC + inner[m.end():]
        return _BIDI + _JC + inner

    def _patch_rpr_inner(inner):
        """Given the content between <w:rPr> and </w:rPr>, enforce rtl."""
        if '<w:rtl' not in inner:
            return inner + _RTL_RUN
        return inner

    def patch_body_xml(xml):
        # Non-empty <w:pPr>...</w:pPr>
        xml = re.sub(
            r'<w:pPr>(.*?)</w:pPr>',
            lambda m: '<w:pPr>' + _patch_ppr_inner(m.group(1)) + '</w:pPr>',
            xml, flags=re.DOTALL
        )
        # Self-closing <w:pPr/>
        xml = xml.replace('<w:pPr/>', '<w:pPr>' + _BIDI + _JC + '</w:pPr>')
        # Non-empty <w:rPr>...</w:rPr>
        xml = re.sub(
            r'<w:rPr>(.*?)</w:rPr>',
            lambda m: '<w:rPr>' + _patch_rpr_inner(m.group(1)) + '</w:rPr>',
            xml, flags=re.DOTALL
        )
        # Self-closing <w:rPr/>
        xml = xml.replace('<w:rPr/>', '<w:rPr>' + _RTL_RUN + '</w:rPr>')
        return xml

    def patch_styles_xml(xml):
        # Patch every paragraph style block
        def _fix_style(m):
            block = m.group(0)
            if '<w:pPr>' in block:
                block = re.sub(
                    r'<w:pPr>(.*?)</w:pPr>',
                    lambda pm: '<w:pPr>' + _patch_ppr_inner(pm.group(1)) + '</w:pPr>',
                    block, flags=re.DOTALL
                )
                block = block.replace('<w:pPr/>', '<w:pPr>' + _BIDI + _JC + '</w:pPr>')
            else:
                block = block.replace('</w:style>', '<w:pPr>' + _BIDI + _JC + '</w:pPr></w:style>')
            return block

        xml = re.sub(
            r'<w:style\b[^>]*w:type="paragraph"[^>]*>.*?</w:style>',
            _fix_style, xml, flags=re.DOTALL
        )

        # Patch docDefaults pPrDefault and rPrDefault
        def _fix_defaults(m):
            block = m.group(0)
            # pPrDefault
            if '<w:pPrDefault' in block:
                if '<w:pPr>' in block:
                    block = re.sub(
                        r'(<w:pPrDefault[^>]*>.*?)<w:pPr>(.*?)</w:pPr>',
                        lambda pm: pm.group(1) + '<w:pPr>' + _patch_ppr_inner(pm.group(2)) + '</w:pPr>',
                        block, flags=re.DOTALL
                    )
                else:
                    block = block.replace('</w:pPrDefault>',
                        '<w:pPr>' + _BIDI + _JC + '</w:pPr></w:pPrDefault>')
            else:
                block = block.replace('</w:docDefaults>',
                    '<w:pPrDefault><w:pPr>' + _BIDI + _JC + '</w:pPr></w:pPrDefault></w:docDefaults>')
            # rPrDefault
            if '<w:rPrDefault' in block:
                if '<w:rPr>' in block:
                    block = re.sub(
                        r'(<w:rPrDefault[^>]*>.*?)<w:rPr>(.*?)</w:rPr>',
                        lambda rm: rm.group(1) + '<w:rPr>' + _patch_rpr_inner(rm.group(2)) + '</w:rPr>',
                        block, flags=re.DOTALL
                    )
                else:
                    block = block.replace('</w:rPrDefault>',
                        '<w:rPr>' + _RTL_RUN + '</w:rPr></w:rPrDefault>')
            else:
                block = block.replace('</w:docDefaults>',
                    '<w:rPrDefault><w:rPr>' + _RTL_RUN + '</w:rPr></w:rPrDefault></w:docDefaults>')
            return block

        xml = re.sub(r'<w:docDefaults>.*?</w:docDefaults>', _fix_defaults, xml, flags=re.DOTALL)
        return xml

    # --- zip pass -------------------------------------------------------

    in_mem  = BytesIO(docx_bytes)
    out_mem = BytesIO()
    BODY_PARTS = {
        'word/document.xml', 'word/footnotes.xml',
        'word/endnotes.xml', 'word/comments.xml',
    }

    with zipfile.ZipFile(in_mem, 'r') as zin, \
         zipfile.ZipFile(out_mem, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            name = item.filename.lower()
            try:
                if name in BODY_PARTS \
                        or (name.startswith('word/header') and name.endswith('.xml')) \
                        or (name.startswith('word/footer') and name.endswith('.xml')):
                    data = patch_body_xml(data.decode('utf-8', errors='replace')).encode('utf-8')
                elif name == 'word/styles.xml':
                    data = patch_styles_xml(data.decode('utf-8', errors='replace')).encode('utf-8')
            except Exception as e:
                logging.warning('RTL patch skipped for %s: %s', item.filename, e)
            zout.writestr(item, data)

    out_mem.seek(0)
    return out_mem.getvalue()



# Strict settings to keep connections alive
socketio = SocketIO(app,
    cors_allowed_origins="*",
    async_mode='gevent',
    transports=['websocket'],
    ping_timeout=600,
    ping_interval=20,
    manage_session=False
)

# --- GLOBAL CACHE ---
job_results_cache = {}
transcription_email_sent = set()

logging.basicConfig(level=logging.INFO)

print(f"SIMULATION_MODE is {SIMULATION_MODE}")
if not SIMULATION_MODE:
    BASE_DIR = pathlib.Path(__file__).resolve().parent
    ffmpeg_path = BASE_DIR / "bin" / "ffmpeg"
    ffprobe_path = BASE_DIR / "bin" / "ffprobe"
    try:
        if ffmpeg_path.exists():
            os.chmod(ffmpeg_path, 0o755)
        if ffprobe_path.exists():
            os.chmod(ffprobe_path, 0o755)
        if ffmpeg_path.exists():
            subprocess.run([str(ffmpeg_path), "-version"], check=True, timeout=5)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError) as e:
        logging.warning("ffmpeg check skipped or failed (app will start; burn-in may fail): %s", e)


@app.route('/api/get_presigned_url', methods=['POST'])
def get_presigned_url():
    try:
        data = request.json or {}
        s3_key = data.get('s3Key')
        user_id = data.get('userId') or data.get('user_id')

        if not s3_key:
            return jsonify({"error": "No s3Key provided"}), 400

        # Per-user keys: only allow access to users/{user_id}/...
        if s3_key.startswith("users/"):
            if not user_id:
                return jsonify({"error": "userId required for user-scoped keys"}), 400
            if not s3_key.startswith(f"users/{user_id}/"):
                return jsonify({"error": "Access denied: key does not belong to user"}), 403

        s3_client = boto3.client(
            's3',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
            region_name=os.environ.get('AWS_REGION')
        )
        params = {
            'Bucket': os.environ.get('S3_BUCKET'),
            'Key': s3_key
        }
        # Serve .mov with video/mp4 so Chrome/Firefox use MP4 decoder (many .mov are H.264)
        if s3_key and s3_key.lower().endswith('.mov'):
            params['ResponseContentType'] = 'video/mp4'
        url = s3_client.generate_presigned_url(
            'get_object',
            Params=params,
            ExpiresIn=3600
        )

        return jsonify({"url": url})

    except Exception as e:
        print(f"S3 Error: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/s3_exists', methods=['POST'])
def api_s3_exists():
    """Check whether a given S3 key exists (without frontend hitting S3 and logging 404s)."""
    try:
        data = request.json or {}
        s3_key = data.get('s3Key')
        user_id = data.get('userId') or data.get('user_id')
        if not s3_key:
            return jsonify({"error": "No s3Key provided"}), 400

        # Per-user keys: only allow access to users/{user_id}/...
        if s3_key.startswith("users/"):
            if not user_id:
                return jsonify({"error": "userId required for user-scoped keys"}), 400
            if not s3_key.startswith(f"users/{user_id}/"):
                return jsonify({"error": "Access denied: key does not belong to user"}), 403

        s3_client = boto3.client(
            's3',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
            region_name=os.environ.get('AWS_REGION')
        )
        try:
            s3_client.head_object(Bucket=os.environ.get('S3_BUCKET'), Key=s3_key)
            return jsonify({"exists": True}), 200
        except ClientError as ce:
            code = str((ce.response or {}).get('Error', {}).get('Code', '')).strip()
            if code in ('404', 'NoSuchKey', 'NotFound'):
                return jsonify({"exists": False}), 200
            raise
    except Exception as e:
        print(f"S3 exists error: {str(e)}")
        return jsonify({"error": str(e)}), 500


def _derive_output_key_base(user_id, input_s3_key):
    """Base path (without suffix) for storing transcript JSON derived from input_s3_key."""
    if not input_s3_key:
        base_name = 'output'
        return f"users/{user_id or 'anonymous'}/output/{base_name}"
    if '/input/' in input_s3_key:
        # users/{id}/input/name.mp4 -> users/{id}/output/name
        return input_s3_key.replace('/input/', '/output/', 1).rsplit('.', 1)[0]
    # Fallback: derive from filename
    base_name = input_s3_key.rsplit('/', 1)[-1].rsplit('.', 1)[0] or 'output'
    if input_s3_key.startswith('users/'):
        # Preserve user prefix from path if present
        parts = input_s3_key.split('/', 2)
        if len(parts) >= 2:
            user_part = parts[1]
            return f"users/{user_part}/output/{base_name}"
    return f"users/{user_id or 'anonymous'}/output/{base_name}"


def _put_segments_json_to_s3(user_id, input_s3_key, segments, stage='gpt'):
    """Low-level helper to write segments JSON for a given processing stage.

    stage: 'raw' (Ivrit-AI output) or 'gpt' (post-processed).
    """
    if segments is None:
        raise ValueError("segments is required")
    if not isinstance(segments, list):
        raise ValueError("segments must be an array")
    return _put_transcript_json_to_s3(user_id, input_s3_key, {"segments": segments}, stage=stage)


def _flatten_words_from_segments(segments):
    """Flatten WhisperX-style segment words into flat words[] + captions[].

    Returns (words, captions) if word timestamps exist, else (None, None).
    """
    if not isinstance(segments, list) or not segments:
        return None, None
    words = []
    captions = []
    wi = 0
    for si, seg in enumerate(segments):
        if not isinstance(seg, dict):
            continue
        seg_words = seg.get("words")
        if not isinstance(seg_words, list) or len(seg_words) == 0:
            continue
        start_index = wi
        for w in seg_words:
            if not isinstance(w, dict):
                continue
            text = (w.get("word") if w.get("word") is not None else w.get("text")) or ""
            start = w.get("start")
            end = w.get("end")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
                # If ANY word is missing timing, we can't build a timing-safe word model.
                return None, None
            words.append({
                "id": f"w{wi}",
                "text": str(text),
                "start": float(start),
                "end": float(end),
            })
            wi += 1
        end_index = wi - 1
        if end_index >= start_index:
            captions.append({
                "id": f"c{len(captions)}",
                "wordStartIndex": int(start_index),
                "wordEndIndex": int(end_index),
            })
    if len(words) == 0 or len(captions) == 0:
        return None, None
    return words, captions


def _put_transcript_json_to_s3(user_id, input_s3_key, transcript, stage='gpt'):
    """Low-level helper to write transcript JSON.

    transcript can include:
      - segments: legacy list[{start,end,text,...}]
      - words: flat list[{id,text,start,end}]
      - captions: list[{id,wordStartIndex,wordEndIndex}]
    """
    if transcript is None or not isinstance(transcript, dict):
        raise ValueError("transcript must be an object")
    base = _derive_output_key_base(user_id, input_s3_key)
    # Keep a single canonical transcript object key.
    # `stage` is accepted for backward compatibility, but ignored.
    result_s3_key = base + '.json'

    body = json.dumps(transcript, ensure_ascii=False).encode('utf-8')
    s3_client = boto3.client(
        's3',
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        region_name=os.environ.get('AWS_REGION')
    )
    s3_client.put_object(
        Bucket=os.environ.get('S3_BUCKET'),
        Key=result_s3_key,
        Body=body,
        ContentType='application/json'
    )
    return result_s3_key


def _get_transcript_json_from_s3(user_id, input_s3_key, stage='gpt'):
    """Read existing transcript JSON from S3 (same key we would write). Returns dict or None."""
    bucket = os.environ.get('S3_BUCKET')
    if not bucket or not input_s3_key:
        return None
    base = _derive_output_key_base(user_id, input_s3_key)
    # Keep a single canonical transcript object key.
    # `stage` is accepted for backward compatibility, but ignored.
    key = base + '.json'
    try:
        s3_client = boto3.client(
            's3',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
            region_name=os.environ.get('AWS_REGION')
        )
        resp = s3_client.get_object(Bucket=bucket, Key=key)
        raw = resp['Body'].read().decode('utf-8')
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except ClientError as e:
        code = (e.response or {}).get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return None
        logging.warning("_get_transcript_json_from_s3 ClientError %s key=%s", code, key)
        return None
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        logging.warning("_get_transcript_json_from_s3 decode error key=%s: %s", key, e)
        return None
    except Exception as e:
        logging.warning("_get_transcript_json_from_s3 failed key=%s: %s", key, e)
        return None


@app.route('/api/save_job_result', methods=['POST'])
def save_job_result():
    """Save transcript JSON to S3; return the result_s3_key. Store only the key in DB, not the full JSON."""
    try:
        data = request.json or {}
        user_id = data.get('userId') or data.get('user_id')
        input_s3_key = data.get('input_s3_key') or data.get('s3Key')
        segments = data.get('segments')
        words = data.get('words')
        captions = data.get('captions')
        has_formatted_key = 'formatted' in data
        formatted = data.get('formatted')
        stage = (data.get('stage') or 'gpt').strip().lower()
        if stage == 'raw':
            stage = 'gpt'
        if not user_id or not input_s3_key:
            return jsonify({"error": "userId and input_s3_key (or s3Key) required"}), 400

        transcript = {}
        if segments is not None:
            if not isinstance(segments, list):
                return jsonify({"error": "segments must be an array"}), 400
            transcript["segments"] = segments
        if words is not None:
            if not isinstance(words, list):
                return jsonify({"error": "words must be an array"}), 400
            transcript["words"] = words
        if captions is not None:
            if not isinstance(captions, list):
                return jsonify({"error": "captions must be an array"}), 400
            transcript["captions"] = captions
        if has_formatted_key:
            if formatted is not None:
                if not isinstance(formatted, dict):
                    return jsonify({"error": "formatted must be an object"}), 400
                transcript["formatted"] = {
                    "clean_transcript": str(formatted.get("clean_transcript") or "").strip(),
                    "overview": str(formatted.get("overview") or "").strip(),
                    "key_points": [str(p).strip() for p in (formatted.get("key_points") or []) if str(p).strip()],
                }
            # JSON null: omit formatted from new object (explicit clear)
        else:
            # Client omitted `formatted` (e.g. saveEdits) — do not wipe GPT block already on S3.
            existing = _get_transcript_json_from_s3(user_id, input_s3_key, stage=stage)
            exf = existing.get("formatted") if isinstance(existing, dict) else None
            if isinstance(exf, dict):
                transcript["formatted"] = {
                    "clean_transcript": str(exf.get("clean_transcript") or "").strip(),
                    "overview": str(exf.get("overview") or "").strip(),
                    "key_points": [str(p).strip() for p in (exf.get("key_points") or []) if str(p).strip()],
                }

        # Canonical clean_transcript in S3: same merge+wrap as DOCX (fixes GPT \\n\\n micro-lines in JSON).
        if isinstance(transcript.get("formatted"), dict):
            _ct = str(transcript["formatted"].get("clean_transcript") or "").strip()
            if _ct:
                transcript["formatted"]["clean_transcript"] = _wrap_text_to_max_chars(_ct)

        if "segments" not in transcript and "words" not in transcript:
            return jsonify({"error": "segments or words required"}), 400

        # If client didn't send words/captions but segments include word timestamps, derive them server-side.
        if "words" not in transcript and "segments" in transcript:
            w, c = _flatten_words_from_segments(transcript["segments"])
            if w is not None and c is not None:
                transcript["words"] = w
                transcript["captions"] = c

        result_s3_key = _put_transcript_json_to_s3(user_id, input_s3_key, transcript, stage=stage)
        return jsonify({"result_s3_key": result_s3_key})
    except Exception as e:
        logging.exception("save_job_result failed")
        return jsonify({"error": str(e)}), 500


def _supabase_service_headers(service_key):
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }


def _delete_s3_keys_batch(keys):
    keys = [str(k).strip() for k in (keys or []) if str(k).strip()]
    if not keys:
        return 0
    bucket = os.environ.get('S3_BUCKET')
    if not bucket:
        return 0
    s3_client = boto3.client(
        's3',
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        region_name=os.environ.get('AWS_REGION')
    )
    deleted_count = 0
    for i in range(0, len(keys), 1000):
        chunk = keys[i:i + 1000]
        try:
            res = s3_client.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True}
            )
            deleted_count += len(res.get("Deleted") or [])
        except Exception:
            # Best effort cleanup; continue deleting DB row even if some objects fail.
            continue
    return deleted_count


@app.route('/recording/<file_id>/rename', methods=['POST'])
def recording_rename(file_id):
    """Rename a recording display name (stored in jobs.metadata.display_name)."""
    try:
        data = request.json or {}
        user_id = data.get('userId') or data.get('user_id')
        new_name = str(data.get('new_name') or '').strip()
        if not user_id or not file_id:
            return jsonify({"error": "userId and file_id required"}), 400
        if not new_name:
            return jsonify({"error": "new_name is required"}), 400

        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not service_key:
            return jsonify({"error": "Server not configured for rename"}), 503

        headers = _supabase_service_headers(service_key)
        get_url = f"{supabase_url}/rest/v1/jobs?id=eq.{file_id}&user_id=eq.{user_id}&select=id,metadata"
        r_get = requests.get(get_url, headers=headers, timeout=12)
        if r_get.status_code != 200:
            return jsonify({"error": r_get.text or f"HTTP {r_get.status_code}"}), r_get.status_code
        rows = r_get.json() if r_get.text else []
        if not rows:
            return jsonify({"error": "Recording not found"}), 404

        metadata = rows[0].get('metadata') if isinstance(rows[0].get('metadata'), dict) else {}
        metadata['display_name'] = new_name
        patch_url = f"{supabase_url}/rest/v1/jobs?id=eq.{file_id}&user_id=eq.{user_id}"
        payload = {"metadata": metadata, "updated_at": datetime.utcnow().isoformat() + "Z"}
        r_patch = requests.patch(patch_url, headers={**headers, "Prefer": "return=representation"}, json=payload, timeout=12)
        if r_patch.status_code not in (200, 204):
            return jsonify({"error": r_patch.text or f"HTTP {r_patch.status_code}"}), r_patch.status_code

        return jsonify({"ok": True, "file_id": file_id, "file_name": new_name}), 200
    except Exception as e:
        logging.exception("recording_rename failed")
        return jsonify({"error": str(e)}), 500


@app.route('/recording/<file_id>', methods=['DELETE'])
def recording_delete(file_id):
    """Delete recording row and related S3 artifacts (input/transcript/raw/exports by derived prefix)."""
    try:
        data = request.get_json(silent=True) or {}
        user_id = data.get('userId') or data.get('user_id')
        if not user_id or not file_id:
            return jsonify({"error": "userId and file_id required"}), 400

        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not service_key:
            return jsonify({"error": "Server not configured for delete"}), 503
        headers = _supabase_service_headers(service_key)

        get_url = f"{supabase_url}/rest/v1/jobs?id=eq.{file_id}&user_id=eq.{user_id}&select=id,input_s3_key,result_s3_key,metadata"
        r_get = requests.get(get_url, headers=headers, timeout=15)
        if r_get.status_code != 200:
            return jsonify({"error": r_get.text or f"HTTP {r_get.status_code}"}), r_get.status_code
        rows = r_get.json() if r_get.text else []
        if not rows:
            return jsonify({"error": "Recording not found"}), 404
        row = rows[0]

        input_key = str(row.get('input_s3_key') or '').strip()
        result_key = str(row.get('result_s3_key') or '').strip()
        metadata = row.get('metadata') if isinstance(row.get('metadata'), dict) else {}
        keys_to_delete = set()
        if input_key:
            keys_to_delete.add(input_key)
        if result_key:
            keys_to_delete.add(result_key)
        for k in ('result_s3_key', 'resultS3Key', 'raw_result_s3_key', 'rawResultS3Key', 'output_s3_key', 'outputS3Key'):
            vv = str(metadata.get(k) or '').strip()
            if vv:
                keys_to_delete.add(vv)

        # Remove all artifacts sharing the derived output base prefix.
        if input_key:
            try:
                bucket = os.environ.get('S3_BUCKET')
                if bucket:
                    s3_client = boto3.client(
                        's3',
                        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
                        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
                        region_name=os.environ.get('AWS_REGION')
                    )
                    base = _derive_output_key_base(user_id, input_key)
                    token = None
                    while True:
                        kwargs = {'Bucket': bucket, 'Prefix': base}
                        if token:
                            kwargs['ContinuationToken'] = token
                        res = s3_client.list_objects_v2(**kwargs)
                        for obj in (res.get('Contents') or []):
                            kk = str((obj or {}).get('Key') or '').strip()
                            if kk:
                                keys_to_delete.add(kk)
                        if not res.get('IsTruncated'):
                            break
                        token = res.get('NextContinuationToken')
            except Exception:
                pass

        deleted_s3 = _delete_s3_keys_batch(list(keys_to_delete))

        del_url = f"{supabase_url}/rest/v1/jobs?id=eq.{file_id}&user_id=eq.{user_id}"
        r_del = requests.delete(del_url, headers={**headers, "Prefer": "return=representation"}, timeout=15)
        if r_del.status_code not in (200, 204):
            return jsonify({"error": r_del.text or f"HTTP {r_del.status_code}", "deleted": False}), r_del.status_code

        return jsonify({"deleted": True, "deleted_s3_objects": deleted_s3}), 200
    except Exception as e:
        logging.exception("recording_delete failed")
        return jsonify({"error": str(e), "deleted": False}), 500


@app.route('/api/delete_job', methods=['POST'])
def delete_job():
    """Delete a job from the DB by id and user_id. Uses Supabase service role so delete succeeds even if RLS blocks client."""
    try:
        data = request.json or {}
        job_id = data.get('jobId') or data.get('job_id')
        user_id = data.get('userId') or data.get('user_id')
        if not job_id or not user_id:
            return jsonify({"error": "jobId and userId required", "deleted": False}), 400
        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not service_key:
            return jsonify({"error": "Server not configured for delete (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)", "deleted": False}), 503
        url = f"{supabase_url}/rest/v1/jobs?id=eq.{job_id}&user_id=eq.{user_id}"
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        r = requests.delete(url, headers=headers, timeout=10)
        if r.status_code in (200, 204):
            deleted = []
            if r.text:
                try:
                    deleted = r.json()
                except Exception:
                    pass
            if isinstance(deleted, list) and len(deleted) > 0:
                return jsonify({"deleted": True})
            if r.status_code == 204:
                return jsonify({"deleted": True})
            return jsonify({"error": "No row deleted", "deleted": False}), 404
        return jsonify({"error": r.text or f"HTTP {r.status_code}", "deleted": False}), r.status_code
    except Exception as e:
        logging.exception("delete_job failed")
        return jsonify({"error": str(e), "deleted": False}), 500


@app.route('/api/delete_account', methods=['POST'])
def delete_account():
    """Erase the current user's account: delete all their jobs, then delete the user from Auth. Requires Authorization: Bearer <access_token>."""
    try:
        auth_header = request.headers.get('Authorization') or ''
        token = auth_header.replace('Bearer ', '').strip() if auth_header.startswith('Bearer ') else (request.json or {}).get('access_token', '').strip()
        if not token:
            return jsonify({"error": "Authorization required (Bearer token or access_token in body)"}), 401
        supabase_url = os.environ.get('SUPABASE_URL', '').rstrip('/')
        service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not service_key:
            return jsonify({"error": "Server not configured for account deletion"}), 503
        # Validate token and get user id
        r_user = requests.get(
            f"{supabase_url}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": service_key},
            timeout=10
        )
        if r_user.status_code != 200:
            return jsonify({"error": "Invalid or expired token"}), 401
        try:
            user_data = r_user.json()
            user_id = (user_data.get('id') or user_data.get('user', {}).get('id') or '').strip()
        except Exception:
            return jsonify({"error": "Invalid user response"}), 401
        if not user_id:
            return jsonify({"error": "User id not found"}), 401
        # Delete all jobs for this user
        jobs_url = f"{supabase_url}/rest/v1/jobs?user_id=eq.{user_id}"
        requests.delete(
            jobs_url,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
            },
            timeout=30
        )
        # Delete user from Auth (admin)
        r_del = requests.delete(
            f"{supabase_url}/auth/v1/admin/users/{user_id}",
            headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
            timeout=10
        )
        if r_del.status_code not in (200, 204):
            return jsonify({"error": r_del.text or f"Failed to delete user ({r_del.status_code})"}), r_del.status_code
        return jsonify({"deleted": True}), 200
    except Exception as e:
        logging.exception("delete_account failed")
        return jsonify({"error": str(e)}), 500


# --- MOCK ROUTE FOR LOCAL DEBUGGING ---
@app.route('/api/mock-upload', methods=['PUT'])
def mock_upload():
    print("SIMULATION: Fake file upload received!")
    return "", 200

@app.after_request
def add_security_headers(resp):
    # Use credentialless so cross-origin S3 media can load (S3 does not send CORP).
    # require-corp would block presigned S3 URLs with NotSameOriginAfterDefaultedToSameOriginByCoep.
    resp.headers['Cross-Origin-Embedder-Policy'] = 'credentialless'
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


@app.route('/history')
def history():
    return render_template('history.html')


@app.route('/personal')
def personal():
    return render_template('personal.html')


@app.route('/legal')
def legal():
    return render_template('legal.html')


@app.route('/loaderio-c1e5fa75e4a82891e47b968c879d134b/')
@app.route('/loaderio-c1e5fa75e4a82891e47b968c879d134b.txt')
@app.route('/loaderio-c1e5fa75e4a82891e47b968c879d134b.html')
def loaderio_verification():
    token = 'loaderio-c1e5fa75e4a82891e47b968c879d134b'
    return token, 200, {'Content-Type': 'text/plain; charset=utf-8'}


# --- UPLOAD & TRIGGER API ---
import time  # Ensure time is imported at the top of your file

# Job is queued until GPU warmup finishes, then we trigger RunPod. Frontend polls trigger_status.
# States:
# - "queued": we accepted the trigger request and are about to call RunPod /run
# - "run_accepted": RunPod /run returned 200/201/202 (container should start soon)
# - "triggered": app_transcribe.py has started and called /api/gpu_started
# - "failed": RunPod /run failed or warmup/trigger crashed
pending_trigger = {}  # job_id -> "queued" | "run_accepted" | "triggered" | "failed" (local cache; Supabase jobs row is source of truth)
pending_trigger_at = {}  # job_id -> time when set to "queued" (for stale detection)
STALE_QUEUED_SEC = 180  # if still "queued" after this, treat as stale and allow retry
# So gpu_callback can save raw JSON even when RunPod does not echo input: job_id -> { input_s3_key, user_id, task, language }
pending_job_info = {}  # job_id -> {"input_s3_key": str, "user_id": str | None, "task": str, "language": str}
job_timings = {}  # job_id -> {"trigger_sec": float, "trigger_completed_at": float}
gpu_started_at = {}  # job_id -> when worker called /api/gpu_started (container running)
upload_complete = {}  # job_id -> True when trigger_processing called (upload done); worker polls until this

# Trigger pipeline + timing fields shared across Gunicorn workers (stored in jobs.metadata.qs_trigger JSONB).
_QS_TRIGGER_META_KEY = "qs_trigger"

# Avoid a Supabase round-trip on every poll (trigger_status + check_status each hit DB). TTL seconds; set 0 to disable.
_job_poll_row_cache = {}  # runpod_job_id -> (time.time(), row dict)


def _job_poll_row_cache_ttl_sec():
    return max(0.0, float(os.environ.get("JOB_POLL_ROW_CACHE_SEC", "8")))


def _invalidate_job_poll_row_cache(runpod_job_id):
    if runpod_job_id is not None:
        _job_poll_row_cache.pop(str(runpod_job_id), None)


def _get_job_poll_row(runpod_job_id):
    """Cached `select=status,metadata` row for hot polling paths (_get_trigger_state / _get_trigger_timings)."""
    if not runpod_job_id:
        return None
    jid = str(runpod_job_id)
    ttl = _job_poll_row_cache_ttl_sec()
    if ttl <= 0:
        return _get_job_row_by_runpod_job_id(jid, select="status,metadata")
    now = time.time()
    hit = _job_poll_row_cache.get(jid)
    if hit and (now - hit[0]) < ttl:
        return hit[1]
    row = _get_job_row_by_runpod_job_id(jid, select="status,metadata")
    if row:
        _job_poll_row_cache[jid] = (now, row)
    return row


def _last_callback_gpt_path():
    """Small local file for GPT timing inference only (not multi-worker critical)."""
    return os.path.join(tempfile.gettempdir(), "qs_last_callback_gpt.json")


def _get_job_row_by_runpod_job_id(runpod_job_id, select="id,status,metadata"):
    """Fetch one jobs row by runpod_job_id. Best-effort; returns None if missing or misconfigured."""
    from urllib.parse import quote

    supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key or not runpod_job_id:
        return None
    rj = quote(str(runpod_job_id), safe="")
    rj_quoted = quote(f'"{runpod_job_id}"', safe="")
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
    }
    for rj_try in (rj, rj_quoted):
        url = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj_try}&select={select}&limit=1"
        try:
            r = requests.get(url, headers=headers, timeout=6)
            if r.status_code == 200 and r.text:
                rows = r.json()
                if isinstance(rows, list) and rows and isinstance(rows[0], dict):
                    return rows[0]
        except Exception as e:
            logging.warning("_get_job_row_by_runpod_job_id: GET failed for %s: %s", runpod_job_id, e)
    return None


def _merge_job_qs_trigger(runpod_job_id, merge_qs_trigger, update_job_status=None):
    """Read jobs row, merge merge_qs_trigger into metadata.qs_trigger, PATCH by id. Service role; best-effort.

    Pipeline states (queued, run_accepted, triggered, failed) go only into metadata.qs_trigger.trigger_status —
    do not write them to jobs.status: Postgres uses an enum (e.g. processing/completed) that rejects those strings.
    """
    try:
        row = _get_job_row_by_runpod_job_id(runpod_job_id, select="id,metadata,status")
        if not row or not row.get("id"):
            logging.warning("_merge_job_qs_trigger: no job row for runpod_job_id=%s", runpod_job_id)
            return
        md = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        md = dict(md)
        qt = dict(md.get(_QS_TRIGGER_META_KEY) if isinstance(md.get(_QS_TRIGGER_META_KEY), dict) else {})
        if merge_qs_trigger:
            qt.update(merge_qs_trigger)
        qt["at"] = time.time()
        if update_job_status is not None:
            qt["trigger_status"] = update_job_status
        md[_QS_TRIGGER_META_KEY] = qt
        supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        headers = {**_supabase_service_headers(service_key), "Prefer": "return=representation"}
        payload = {"metadata": md, "updated_at": datetime.utcnow().isoformat() + "Z"}
        patch_url = f"{supabase_url}/rest/v1/jobs?id=eq.{row['id']}"
        r = requests.patch(patch_url, json=payload, headers=headers, timeout=10)
        if r.status_code in (200, 204):
            _invalidate_job_poll_row_cache(runpod_job_id)
        else:
            logging.warning(
                "_merge_job_qs_trigger: PATCH failed for %s: %s %s",
                runpod_job_id,
                r.status_code,
                (r.text[:300] if r.text else ""),
            )
    except Exception as e:
        logging.warning("_merge_job_qs_trigger: %s", e)


def _get_trigger_state(job_id):
    """Return (trigger_status, at_ts) from Supabase (metadata.qs_trigger), or (None, None) if missing."""
    try:
        row = _get_job_poll_row(job_id)
        if not row:
            return (None, None)
        md = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        qt = md.get(_QS_TRIGGER_META_KEY) if isinstance(md.get(_QS_TRIGGER_META_KEY), dict) else {}
        st = qt.get("trigger_status") or row.get("status")
        at_ts = qt.get("at")
        return (st, at_ts)
    except Exception as e:
        logging.warning("_get_trigger_state: %s", e)
    return (None, None)


def _set_trigger_state(job_id, status, **extra):
    """Persist trigger pipeline to metadata.qs_trigger (cross-worker). pending_* remains in-memory cache."""
    _merge_job_qs_trigger(job_id, dict(extra), update_job_status=status)


def _get_trigger_timings(job_id):
    """Read timing fields from jobs.metadata.qs_trigger (for multi-worker)."""
    try:
        row = _get_job_poll_row(job_id)
        if not row:
            return {}
        md = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        data = md.get(_QS_TRIGGER_META_KEY) if isinstance(md.get(_QS_TRIGGER_META_KEY), dict) else {}
        return {
            "queued_at": data.get("queued_at") or data.get("at"),
            "trigger_sec": data.get("trigger_sec"),
            "trigger_completed_at": data.get("trigger_completed_at"),
            "gpu_started_at": data.get("gpu_started_at"),
            "upload_complete": bool(data.get("upload_complete")),
            "upload_complete_at": data.get("upload_complete_at"),
        }
    except Exception as e:
        logging.warning("_get_trigger_timings: %s", e)
    return {}


def _update_trigger_timings(job_id, **updates):
    """Merge timing fields into metadata.qs_trigger without changing jobs.status."""
    _merge_job_qs_trigger(job_id, updates, update_job_status=None)


def _mark_upload_complete(job_id):
    """Persist upload-complete signal so worker polling survives process/instance changes."""
    try:
        status, _ = _get_trigger_state(job_id)
        current_status = status or pending_trigger.get(job_id, "queued")
        _set_trigger_state(job_id, current_status, upload_complete=True, upload_complete_at=time.time())
    except Exception as e:
        logging.warning("Could not persist upload_complete for %s: %s", job_id, e)


def _set_last_callback_for_gpt(job_id: str, at: float, user_id: str = None) -> None:
    """Store last gpu_callback job so api_translate_segments can infer GPT timing."""
    try:
        path = _last_callback_gpt_path()
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"job_id": job_id, "at": at, "user_id": user_id}, f)
    except Exception as e:
        logging.warning("Could not set last_callback_for_gpt: %s", e)


def _get_last_callback_for_gpt() -> tuple:
    """Return (job_id, callback_at, user_id) for inferring GPT timing, or (None, None, None)."""
    try:
        path = _last_callback_gpt_path()
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return (data.get("job_id"), data.get("at"), data.get("user_id"))
    except Exception:
        pass
    return (None, None, None)


def _get_job_timings_from_db(runpod_job_id: str, user_id: str = None) -> dict:
    """Fetch current timing columns from jobs table (for cross-instance reads)."""
    supabase_url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not service_key:
        return {}
    from urllib.parse import quote
    rj = quote(str(runpod_job_id), safe='')
    url = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj}&select=trigger_sec,trigger_completed_at,gpu_started_at,runpod_wakeup_sec,gpt_sec,gpt_format_sec"
    if user_id:
        url += f"&user_id=eq.{quote(str(user_id), safe='')}"
    try:
        r = requests.get(url, headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"}, timeout=5)
        if r.status_code == 200 and r.text:
            rows = r.json()
            if isinstance(rows, list) and len(rows) > 0:
                return rows[0] or {}
    except Exception:
        pass
    return {}


def _update_job_timings(runpod_job_id: str, user_id: str = None, **timings) -> None:
    """Update jobs table with PROCESS TIMING data. Matches by runpod_job_id column or metadata.job_id."""
    supabase_url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not service_key:
        logging.warning("_update_job_timings: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set, skipping")
        return
    payload = {k: v for k, v in timings.items() if v is not None}
    if not payload:
        logging.debug("_update_job_timings: no values to update for %s", runpod_job_id)
        return
    from urllib.parse import quote
    # PostgREST: string values in eq filter need double quotes for reliability
    rj_quoted = quote(f'"{runpod_job_id}"', safe='')
    rj = quote(str(runpod_job_id), safe='')
    uid = quote(str(user_id), safe='') if user_id else None
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    try:
        # Prefer runpod_job_id column; use eq."value" for string match
        url = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj_quoted}"
        if uid:
            url += f"&user_id=eq.{uid}"
        r = requests.patch(url, json=payload, headers=headers, timeout=10)
        if r.status_code in (200, 204):
            updated = r.json() if r.text else []
            if isinstance(updated, list) and len(updated) > 0:
                logging.info("_update_job_timings: updated job %s with %s (%d rows)", runpod_job_id, list(payload.keys()), len(updated))
                return
            logging.warning("_update_job_timings: PATCH 200 but 0 rows matched for %s (filter: runpod_job_id=eq.%s)", runpod_job_id, rj_quoted[:50])
        # Fallback 1: try unquoted value
        url_alt = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj}"
        if uid:
            url_alt += f"&user_id=eq.{uid}"
        r2 = requests.patch(url_alt, json=payload, headers=headers, timeout=10)
        if r2.status_code in (200, 204):
            updated2 = r2.json() if r2.text else []
            if isinstance(updated2, list) and len(updated2) > 0:
                logging.info("_update_job_timings: updated job %s (fallback unquoted) with %s", runpod_job_id, list(payload.keys()))
                return
        # Fallback 2: runpod_job_id only (no user_id) in case UUID filter fails
        if uid:
            url_no_uid = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj}"
            r3 = requests.patch(url_no_uid, json=payload, headers=headers, timeout=10)
            if r3.status_code in (200, 204):
                updated3 = r3.json() if r3.text else []
                if isinstance(updated3, list) and len(updated3) > 0:
                    logging.info("_update_job_timings: updated job %s (no user_id) with %s", runpod_job_id, list(payload.keys()))
                    return
        # Fallback 3: GET job by runpod_job_id, then PATCH by id (most reliable)
        for rj_try in (rj, rj_quoted):
            get_url = f"{supabase_url}/rest/v1/jobs?runpod_job_id=eq.{rj_try}&select=id"
            get_r = requests.get(get_url, headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"}, timeout=5)
            if get_r.status_code == 200 and get_r.text:
                rows = get_r.json()
                if isinstance(rows, list) and len(rows) > 0 and rows[0].get("id"):
                    job_uuid = rows[0]["id"]
                    patch_url = f"{supabase_url}/rest/v1/jobs?id=eq.{job_uuid}"
                    r4 = requests.patch(patch_url, json=payload, headers=headers, timeout=10)
                    if r4.status_code in (200, 204):
                        updated4 = r4.json() if r4.text else []
                        if isinstance(updated4, list) and len(updated4) > 0:
                            logging.info("_update_job_timings: updated job %s (by id) with %s", runpod_job_id, list(payload.keys()))
                            return
                    break
        logging.warning("_update_job_timings: all attempts failed for %s. Last: %s %s", runpod_job_id, r.status_code, r.text[:200] if r.text else "")
    except Exception as e:
        logging.warning("Could not update job timings for %s: %s", runpod_job_id, e)


def get_runpod_endpoint_status(pod_id):
    """GET RunPod endpoint status via REST API. Returns dict with endpoint info and optional workers.
    Uses rest.runpod.io/v1/endpoints (management API), not api.runpod.ai/v2 (run API)."""
    if not RUNPOD_API_KEY or not pod_id:
        return {}
    url = f"https://rest.runpod.io/v1/endpoints/{pod_id.strip()}?includeWorkers=true"
    headers = {"Authorization": f"Bearer {RUNPOD_API_KEY}", "Content-Type": "application/json"}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            return r.json() or {}
    except Exception as e:
        logging.warning("get_runpod_endpoint_status: %s", e)
    return {}


def trigger_gpu_job(job_id, s3_key, num_speakers, language, task):
    """Initiates the RunPod Serverless task with 5 parameters and retry logic."""
    data = {
        "jobId": job_id,
        "s3Key": s3_key,
        "task": task,
        "language": language,
        "speakerCount": num_speakers,
        "diarization": False,
    }
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
        prompt = "讛谞讛 转诪诇讜诇 诪诇讗 砖诇 讛砖讬讞讛 讘注讘专讬转, 讻讜诇诇 驻讬住讜拽 诪讚讜讬拽."

    # 3. Build RunPod Payload
    payload = {
        "input": {
            "jobId": data.get('jobId'),
            "s3Key": data.get('s3Key'),
            "task": data.get('task', 'transcribe'),
            "language": data.get('language', 'he'),
            "num_speakers": int(data.get('speakerCount', 2)),
            "diarization": data.get('diarization', False),
            # Omit vad_onset, chunk_size, max_line_* etc. so the worker uses its defaults (speech).
        }
    }
    max_retries = 3
    last_error = ""

    for attempt in range(1, max_retries + 1):
        try:
            print(f"DEBUG: Triggering GPU Attempt {attempt}/{max_retries} for {job_id}...")
            response = requests.post(url, json=payload, headers=headers, timeout=30)

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
    # Never return a hard-coded fake transcript here.
    # check_status should only return actual cached result if available.
    # Check the global cache we created earlier
    if job_id in job_results_cache:
        print(f"馃攷 Client checked status for {job_id} -> Found completed result!")
        return jsonify(job_results_cache[job_id])

    # If trigger already failed, surface it immediately.
    persisted_status, _ = _get_trigger_state(job_id)
    mem_status = pending_trigger.get(job_id)
    status = persisted_status or mem_status
    if status == "failed":
        return jsonify({"jobId": job_id, "status": "failed", "error": "Processing trigger failed"}), 200

    # Guard against endless "processing" when callback is never received.
    timings = _get_trigger_timings(job_id)
    queued_at = timings.get("queued_at") or pending_trigger_at.get(job_id) or 0
    gpu_started = timings.get("gpu_started_at") or gpu_started_at.get(job_id) or 0
    now = time.time()
    max_sec_after_gpu_started = int(os.environ.get('CHECK_STATUS_MAX_AFTER_GPU_STARTED_SEC', '3600') or 3600)
    max_sec_after_queued = int(os.environ.get('CHECK_STATUS_MAX_AFTER_QUEUED_SEC', '5400') or 5400)

    if gpu_started and (now - float(gpu_started)) > max_sec_after_gpu_started:
        return jsonify({
            "jobId": job_id,
            "status": "failed",
            "error": "Processing timed out after worker start"
        }), 200

    if queued_at and (now - float(queued_at)) > max_sec_after_queued:
        return jsonify({
            "jobId": job_id,
            "status": "failed",
            "error": "Processing timed out while waiting for completion"
        }), 200

    # Not complete yet.
    return jsonify({"jobId": job_id, "status": "processing"}), 202


@app.route('/api/debug_job/<job_id>', methods=['GET'])
def debug_job(job_id):
    """Inspect server-side job state for troubleshooting stuck jobs."""
    try:
        persisted_status, persisted_at = _get_trigger_state(job_id)
        timings = _get_trigger_timings(job_id) or {}
        now = time.time()
        queued_at = timings.get("queued_at") or pending_trigger_at.get(job_id)
        gpu_started = timings.get("gpu_started_at") or gpu_started_at.get(job_id)
        upload_marked = bool((job_id in upload_complete) or timings.get("upload_complete"))

        out = {
            "job_id": job_id,
            "has_cached_result": bool(job_id in job_results_cache),
            "trigger_status_file": persisted_status,
            "trigger_status_memory": pending_trigger.get(job_id),
            "trigger_status_at": persisted_at,
            "upload_complete": upload_marked,
            "queued_at": queued_at,
            "gpu_started_at": gpu_started,
            "pending_info_exists": bool(job_id in pending_job_info),
            "elapsed_sec_since_queued": (int(now - queued_at) if queued_at else None),
            "elapsed_sec_since_gpu_started": (int(now - gpu_started) if gpu_started else None),
        }
        return jsonify(out), 200
    except Exception as e:
        logging.exception("debug_job failed for %s", job_id)
        return jsonify({"job_id": job_id, "error": str(e)}), 500

# --- GPU FEEDBACK API ---
def _translate_segments_via_python_openai(segments, target_lang='he'):
    """Fallback path when Node.js is unavailable: call OpenAI directly from Python."""
    api_key = (os.environ.get('GPT_API_KEY') or os.environ.get('OPENAI_API_KEY') or '').strip()
    # gpt-4o-mini is much cheaper than gpt-4o; set GPT_MODEL=gpt-4o for highest quality
    model = (os.environ.get('GPT_MODEL') or 'gpt-4o-mini').strip()
    fallback_model = (os.environ.get('GPT_FALLBACK_MODEL') or 'gpt-4o').strip()
    chunk_size = int(os.environ.get('GPT_CHUNK_SIZE', '30') or 30)
    timeout_sec = int(os.environ.get('GPT_TIMEOUT_SEC', '90') or 90)

    out = []
    ok_count = 0
    empty_count = 0
    error_count = 0
    changed_count = 0
    first_error = ''
    model_used = model

    def _extract_json_text(s):
        t = str(s or '').strip()
        t = re.sub(r'^```json\s*', '', t, flags=re.IGNORECASE)
        t = re.sub(r'^```\s*', '', t)
        t = re.sub(r'```$', '', t)
        return t.strip()

    def _process_chunk(items):
        nonlocal ok_count, empty_count, error_count, changed_count, first_error
        batch_input = {
            "results": [{"id": i, "text": str(seg.get("text") or "").strip()} for i, seg in enumerate(items)]
        }
        system_prompt = (
            "You are an expert transcript correction engine. "
            "Return ONLY valid JSON with this exact shape: {\"results\":[{\"id\":number,\"text\":string}]}. "
            "Do not add extra keys. Do not translate. Preserve original language and writing direction (RTL/LTR). "
            "Do not add explanations. Fix obvious transcription errors only."
        )
        user_prompt = (
            f"Target language hint: {target_lang or 'he'}.\n\n"
            "Fix the text values and return the exact same JSON structure with same ids.\n\n"
            f"{json.dumps(batch_input, ensure_ascii=False)}"
        )
        def _request_with_model(model_name):
            payload = {
                "model": model_name,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            }
            resp = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=timeout_sec,
            )
            if resp.status_code >= 400:
                # Keep response body in the error to understand model/endpoint incompatibilities.
                body_preview = (resp.text or "").strip()
                if len(body_preview) > 700:
                    body_preview = body_preview[:700] + "...[truncated]"
                raise RuntimeError(f"OpenAI API {resp.status_code}: {body_preview}")
            data = resp.json()
            content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
            parsed = json.loads(_extract_json_text(content))
            results_local = parsed.get("results") if isinstance(parsed, dict) else None
            if not isinstance(results_local, list):
                raise ValueError("OpenAI returned no results array")
            return results_local

        try:
            results = _request_with_model(model)
            model_used = model
        except Exception as e:
            err_text = str(e)
            should_try_fallback = (
                fallback_model
                and fallback_model != model
                and (
                    "400" in err_text
                    or "404" in err_text
                    or "403" in err_text
                    or "model" in err_text.lower()
                    or "unsupported" in err_text.lower()
                    or "not found" in err_text.lower()
                    or "does not exist" in err_text.lower()
                    or "permission" in err_text.lower()
                )
            )
            if should_try_fallback:
                try:
                    logging.warning("Primary GPT model failed (%s). Retrying with fallback (%s).", model, fallback_model)
                    results = _request_with_model(fallback_model)
                    model_used = fallback_model
                except Exception as e2:
                    if not first_error:
                        first_error = str(e2)
                    error_count += len(items)
                    for seg in items:
                        out.append({**seg, "translated_text": "", "translation_status": "error"})
                    return
            else:
                if not first_error:
                    first_error = str(e)
                error_count += len(items)
                for seg in items:
                    out.append({**seg, "translated_text": "", "translation_status": "error"})
                return

        for i, seg in enumerate(items):
            corrected = next((r for r in results if isinstance(r, dict) and r.get("id") == i), None)
            original_text = str(seg.get("text") or "")
            new_text = str((corrected or {}).get("text") or "").strip()
            copy = {**seg, "translated_text": new_text, "translation_status": "ok" if new_text else "empty"}
            out.append(copy)
            if new_text:
                ok_count += 1
                if new_text.strip() != original_text.strip():
                    changed_count += 1
            else:
                empty_count += 1

    for i in range(0, len(segments), max(1, chunk_size)):
        _process_chunk(segments[i:i + max(1, chunk_size)])

    return out, {
        "total": len(segments),
        "ok_count": ok_count,
        "empty_count": empty_count,
        "error_count": error_count,
        "changed_count": changed_count,
        "first_error": first_error,
        "model": model_used,
    }

def _split_text_for_format_chunks(text, max_chunk_chars):
    """Split long transcript into chunks at newlines/spaces so each OpenAI request stays small."""
    text = str(text or "").strip()
    if not text:
        return []
    max_chunk_chars = max(2000, int(max_chunk_chars))
    if len(text) <= max_chunk_chars:
        return [text]
    chunks = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + max_chunk_chars, n)
        if end < n:
            window = text[start:end]
            nl = window.rfind("\n")
            if nl > int(max_chunk_chars * 0.45):
                end = start + nl + 1
            else:
                sp = window.rfind(" ")
                if sp > int(max_chunk_chars * 0.45):
                    end = start + sp + 1
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        start = end
    return chunks


def _openai_chat_json_completion(system_prompt, user_prompt, timeout_sec, read_retries=0):
    """POST chat completions; return parsed JSON object from message content.

    Uses (connect, read) timeouts so slow generations get the full read budget.
    read_retries: extra attempts after ReadTimeout (formatting large Hebrew chunks often needs this).
    """
    api_key = (os.environ.get('GPT_API_KEY') or os.environ.get('OPENAI_API_KEY') or '').strip()
    if not api_key:
        raise RuntimeError("GPT_API_KEY missing")
    model = (os.environ.get('GPT_MODEL') or 'gpt-4o-mini').strip()
    payload = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    read_t = max(60, int(timeout_sec))
    connect_t = min(30, max(10, read_t // 8))
    timeout_tuple = (connect_t, read_t)
    last_timeout_exc = None
    for attempt in range(read_retries + 1):
        try:
            resp = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=timeout_tuple,
            )
            if resp.status_code >= 400:
                raise RuntimeError(f"OpenAI API {resp.status_code}: {(resp.text or '')[:500]}")
            data = resp.json()
            content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
            if not content:
                raise RuntimeError("OpenAI returned empty content")
            content = re.sub(r'^```json\s*', '', content, flags=re.IGNORECASE)
            content = re.sub(r'^```\s*', '', content)
            content = re.sub(r'```$', '', content).strip()
            return json.loads(content)
        except requests.exceptions.ReadTimeout as e:
            last_timeout_exc = e
            if attempt >= read_retries:
                raise RuntimeError(
                    f"OpenAI read timed out after {read_t}s (connect {connect_t}s), "
                    f"{read_retries + 1} attempt(s). "
                    f"Try GPT_FORMAT_TIMEOUT_SEC=360 or smaller FORMAT_TRANSCRIPT_CHUNK_CHARS."
                ) from e
            logging.warning(
                "OpenAI ReadTimeout format attempt %s/%s; retrying in %ss",
                attempt + 1,
                read_retries + 1,
                2 * (attempt + 1),
            )
            time.sleep(min(12, 2 * (attempt + 1)))
    raise RuntimeError(f"OpenAI read timed out: {last_timeout_exc}") from last_timeout_exc


def _maybe_translate_summary_to_hebrew(overview, key_points, want_hebrew):
    if not want_hebrew:
        return overview, key_points
    he_char_re = re.compile(r'[\u0590-\u05FF]')

    def _has_hebrew(s):
        return bool(he_char_re.search(str(s or "")))

    needs_translate = (overview and not _has_hebrew(overview)) or any(
        (p and not _has_hebrew(p)) for p in key_points
    )
    if not needs_translate:
        return overview, key_points
    to_translate = []
    if overview:
        to_translate.append({"id": 0, "text": overview})
    for i, p in enumerate(key_points):
        to_translate.append({"id": i + 1, "text": p})
    translated, _meta = translate_segments(to_translate, target_lang='he')
    translated_map = {
        int((seg or {}).get("id")): str((seg or {}).get("translated_text") or "").strip()
        for seg in (translated or [])
        if isinstance(seg, dict)
    }
    if overview:
        overview = translated_map.get(0) or overview
    key_points = [
        translated_map.get(i + 1) or p
        for i, p in enumerate(key_points)
    ]
    return overview, key_points


def _format_transcript_clean_chunk_openai(chunk_text, target_lang, timeout_sec, read_retries=0):
    """Format one transcript fragment into clean_transcript only (paragraphs, wrapped to TRANSCRIPT_LINE_MAX_CHARS)."""
    lang_hint = str(target_lang or 'he').strip().lower()[:8]
    want_hebrew = lang_hint.startswith('he')
    output_lang_label = 'Hebrew' if want_hebrew else target_lang
    system_prompt = (
        "You are an expert transcript editor. "
        "Return ONLY valid JSON: {\"clean_transcript\":string} . "
        "No markdown fences. Keep original language and directionality."
    )
    user_prompt = (
        "Edit this transcript fragment.\n\n"
        "* Correct grammar and punctuation; keep the original wording as much as possible.\n"
        "* Split into clear paragraphs (2–4 sentences each); new paragraph when the topic changes.\n"
        "* Prefer paragraph length under 350-450 characters.\n"
        "* Avoid sentences longer than 120 characters.\n"
        f"* Each LINE in clean_transcript must be at most {TRANSCRIPT_LINE_MAX_CHARS} characters; use line breaks.\n"
        "* Do NOT summarize or omit content.\n\n"
        f"Output language: {output_lang_label}\n\n"
        f"Fragment:\n\n{chunk_text}"
    )
    parsed = _openai_chat_json_completion(system_prompt, user_prompt, timeout_sec, read_retries=read_retries)
    clean = str((parsed or {}).get("clean_transcript") or "").strip()
    return _wrap_text_to_max_chars(clean)


def _format_summary_only_openai(transcript_excerpt, target_lang, timeout_sec, read_retries=0):
    """Produce overview + key_points from (possibly truncated) transcript text."""
    lang_hint = str(target_lang or 'he').strip().lower()[:8]
    want_hebrew = lang_hint.startswith('he')
    output_lang_label = 'Hebrew' if want_hebrew else target_lang
    system_prompt = (
        "You are an expert analyst. "
        "Return ONLY valid JSON: {\"overview\":string,\"key_points\":[string]} . "
        "No markdown fences."
    )
    user_prompt = (
        "Summarize this transcript.\n\n"
        "* A short 3–4 sentence overview.\n"
        "* 5–8 key points (strings in the array).\n"
        "Focus on decisions, insights, and actionable ideas. Ignore filler.\n\n"
        f"Output language must be {output_lang_label}.\n\n"
        f"Transcript:\n\n{transcript_excerpt}"
    )
    parsed = _openai_chat_json_completion(system_prompt, user_prompt, timeout_sec, read_retries=read_retries)
    overview = str((parsed or {}).get("overview") or "").strip()
    key_points = (parsed or {}).get("key_points")
    if not isinstance(key_points, list):
        key_points = []
    key_points = [str(p).strip() for p in key_points if str(p).strip()]
    overview, key_points = _maybe_translate_summary_to_hebrew(overview, key_points, want_hebrew)
    return {"overview": overview, "key_points": key_points}


def _format_transcript_and_summary_single_shot(transcript_text, target_lang='he'):
    """One OpenAI call: full transcript + summary (only for moderately sized input)."""
    timeout_sec = int(os.environ.get('GPT_FORMAT_TIMEOUT_SEC', '270') or 270)
    read_retries = max(0, int(os.environ.get('GPT_FORMAT_READ_RETRIES', '2') or 0))
    lang_hint = str(target_lang or 'he').strip().lower()[:8]
    want_hebrew = lang_hint.startswith('he')
    output_lang_label = 'Hebrew' if want_hebrew else target_lang
    system_prompt = (
        "You are an expert transcript editor. "
        "Return ONLY valid JSON in this exact shape: "
        "{\"clean_transcript\":string,\"overview\":string,\"key_points\":[string]} . "
        "Do not include markdown fences. Keep original language and directionality."
    )
    user_prompt = (
        "You are editing a transcript.\n\n"
        "Task 1 – Clean Transcript\n\n"
        "* Correct grammar and punctuation.\n"
        "* Keep the original wording as much as possible.\n"
        "* Split the text into clear paragraphs (2–4 sentences each).\n"
        "* Start a new paragraph when the topic changes.\n"
        "* Prefer paragraph length under 350-450 characters.\n"
        "* Avoid sentences longer than 120 characters.\n"
        f"* IMPORTANT: each line in clean_transcript must be at most {TRANSCRIPT_LINE_MAX_CHARS} characters.\n"
        f"* Add line breaks as needed to keep line length <= {TRANSCRIPT_LINE_MAX_CHARS} characters.\n"
        "* Do NOT summarize or remove content.\n\n"
        "Task 2 – Summary\n"
        "Create a separate summary including:\n\n"
        "* A short 3–4 sentence overview\n"
        "* 5–8 bullet key points\n"
        "Focus on decisions, insights, and actionable ideas.\n"
        "Ignore filler conversation.\n\n"
        "Return as JSON fields only (clean_transcript, overview, key_points).\n"
        f"Output language must be {output_lang_label} for all fields.\n\n"
        f"Language hint: {lang_hint}\n\n"
        "Transcript:\n\n"
        f"{transcript_text}"
    )
    parsed = _openai_chat_json_completion(system_prompt, user_prompt, timeout_sec, read_retries=read_retries)
    clean_transcript = str((parsed or {}).get("clean_transcript") or "").strip()
    clean_transcript = _wrap_text_to_max_chars(clean_transcript)
    overview = str((parsed or {}).get("overview") or "").strip()
    key_points = (parsed or {}).get("key_points")
    if not isinstance(key_points, list):
        key_points = []
    key_points = [str(p).strip() for p in key_points if str(p).strip()]
    overview, key_points = _maybe_translate_summary_to_hebrew(overview, key_points, want_hebrew)
    return {
        "clean_transcript": clean_transcript,
        "overview": overview,
        "key_points": key_points
    }


def _format_transcript_and_summary_via_openai(transcript_text, target_lang='he'):
    """Generate clean transcript paragraphs + summary. Uses chunked calls when input is very long."""
    transcript_text = str(transcript_text or "").strip()
    if not transcript_text:
        raise RuntimeError("empty transcript")

    max_single = int(os.environ.get('FORMAT_TRANSCRIPT_MAX_SINGLE_CHARS', '9000'))
    chunk_chars = int(os.environ.get('FORMAT_TRANSCRIPT_CHUNK_CHARS', '5000'))
    summary_in_max = int(os.environ.get('FORMAT_SUMMARY_MAX_INPUT_CHARS', '18000'))
    format_read_sec = int(os.environ.get('GPT_FORMAT_TIMEOUT_SEC', '270') or 270)
    read_retries = max(0, int(os.environ.get('GPT_FORMAT_READ_RETRIES', '2') or 0))
    parallel = max(1, min(8, int(os.environ.get('FORMAT_TRANSCRIPT_PARALLEL', '2'))))

    if len(transcript_text) <= max_single:
        return _format_transcript_and_summary_single_shot(transcript_text, target_lang=target_lang)

    logging.info(
        "format_transcript: chunked path total_chars=%s chunk≈%s parallel=%s",
        len(transcript_text),
        chunk_chars,
        parallel,
    )
    parts = _split_text_for_format_chunks(transcript_text, chunk_chars)
    if not parts:
        raise RuntimeError("no chunks after split")

    clean_parts = [None] * len(parts)

    def _run_chunk(idx_part):
        idx, part = idx_part
        logging.info(
            "format_transcript: chunk %s/%s chars=%s",
            idx + 1,
            len(parts),
            len(part),
        )
        return idx, _format_transcript_clean_chunk_openai(part, target_lang, format_read_sec, read_retries)

    if parallel <= 1 or len(parts) == 1:
        for i, part in enumerate(parts):
            _, c = _run_chunk((i, part))
            clean_parts[i] = c
    else:
        with ThreadPoolExecutor(max_workers=parallel) as pool:
            futures = [pool.submit(_run_chunk, (i, p)) for i, p in enumerate(parts)]
            for fut in as_completed(futures):
                try:
                    idx, c = fut.result()
                    clean_parts[idx] = c
                except Exception as e:
                    raise RuntimeError(f"OpenAI format chunk failed: {e}") from e

    clean_merged = "\n\n".join(p.strip() for p in clean_parts if p and str(p).strip())
    clean_merged = _wrap_text_to_max_chars(clean_merged)

    summ_input = clean_merged
    if len(summ_input) > summary_in_max:
        summ_input = (
            clean_merged[: summary_in_max // 2]
            + "\n\n[… פסקה מקוצרת — המשך התמלול …]\n\n"
            + clean_merged[-(summary_in_max // 2) :]
        )
    summary = _format_summary_only_openai(summ_input, target_lang, format_read_sec, read_retries)
    return {
        "clean_transcript": clean_merged,
        "overview": summary.get("overview") or "",
        "key_points": summary.get("key_points") or [],
    }


# --- TRANSLATE SEGMENTS (GPT via Node script from package.json) ---
def translate_segments(segments, target_lang='he'):
    """Run Node translate script to add translated_text to each segment.
    Returns (segments, meta). On failure, returns original segments + error meta.
    """
    t0 = time.time()
    if not segments or not isinstance(segments, list):
        return segments, {"total": 0, "ok_count": 0, "empty_count": 0, "error_count": 0, "changed_count": 0, "first_error": ""}
    if not TRANSLATE_SCRIPT.exists():
        logging.warning("Translate script not found at %s", TRANSLATE_SCRIPT)
        return segments, {"total": len(segments), "ok_count": 0, "empty_count": 0, "error_count": len(segments), "changed_count": 0, "first_error": "translate.js not found"}
    api_key = os.environ.get('GPT_API_KEY') or os.environ.get('OPENAI_API_KEY')
    if not api_key or not str(api_key).strip():
        logging.warning("GPT_API_KEY not set; skipping translation")
        return segments, {"total": len(segments), "ok_count": 0, "empty_count": 0, "error_count": len(segments), "changed_count": 0, "first_error": "GPT_API_KEY missing"}
    node_exe = shutil.which("node")
    if not node_exe:
        logging.warning("Node.js not found in PATH; using Python OpenAI fallback")
        result = _translate_segments_via_python_openai(segments, target_lang=target_lang)
        return result
    try:
        logging.info("GPT translate: start segments=%s target=%s", len(segments), target_lang)
        payload = json.dumps({"segments": segments, "targetLang": target_lang}).encode("utf-8")
        proc = subprocess.run(
            [node_exe, str(TRANSLATE_SCRIPT)],
            input=payload,
            capture_output=True,
            timeout=300,
            cwd=str(APP_ROOT),
            env=os.environ.copy(),
        )

        stderr_text = (proc.stderr or b"").decode("utf-8", errors="replace")
        if stderr_text:
            logging.info("GPT translate stderr: %s", stderr_text[:500])

        if proc.returncode != 0:
            return segments, {
                "total": len(segments),
                "ok_count": 0,
                "empty_count": 0,
                "error_count": len(segments),
                "changed_count": 0,
                "first_error": f"node exit {proc.returncode}: {stderr_text[:300]}",
                "model": "",
            }

        out_text = (proc.stdout or b"").decode("utf-8", errors="replace").strip()
        if not out_text:
            return segments, {
                "total": len(segments),
                "ok_count": 0,
                "empty_count": 0,
                "error_count": len(segments),
                "changed_count": 0,
                "first_error": "empty stdout from translate.js",
                "model": "",
            }

        data = json.loads(out_text)
        translated = data.get("segments", segments)
        meta = data.get("meta") or {}
        if not isinstance(translated, list):
            return segments, {
                "total": len(segments),
                "ok_count": 0,
                "empty_count": 0,
                "error_count": len(segments),
                "changed_count": 0,
                "first_error": "translate.js returned non-list segments",
                "model": str(meta.get("model") or ""),
            }

        result_meta = {
            "total": int(meta.get("total") or len(translated)),
            "ok_count": int(meta.get("ok_count") or 0),
            "empty_count": int(meta.get("empty_count") or 0),
            "error_count": int(meta.get("error_count") or 0),
            "changed_count": int(meta.get("changed_count") or 0),
            "first_error": str(meta.get("first_error") or ""),
            "model": str(meta.get("model") or ""),
        }
        logging.info(
            "GPT translate: ok=%s/%s changed=%s/%s empty=%s error=%s model=%s first_error=%s",
            result_meta["ok_count"], result_meta["total"],
            result_meta["changed_count"], result_meta["total"],
            result_meta["empty_count"], result_meta["error_count"],
            result_meta["model"], result_meta["first_error"][:180]
        )
        return translated, result_meta
    except subprocess.TimeoutExpired:
        logging.warning("Translate script timed out")
        return segments, {
            "total": len(segments),
            "ok_count": 0,
            "empty_count": 0,
            "error_count": len(segments),
            "changed_count": 0,
            "first_error": "timeout",
            "model": "",
        }
    except Exception as e:
        logging.warning("Translate segments error: %s", e)
        return segments, {
            "total": len(segments),
            "ok_count": 0,
            "empty_count": 0,
            "error_count": len(segments),
            "changed_count": 0,
            "first_error": str(e),
            "model": "",
        }


_translate_in_flight = 0

@app.route('/api/translate_segments', methods=['POST'])
def api_translate_segments():
    """Accept segments JSON, run GPT correction, return segments with translated_text. Used by SRT/VTT upload and any client.
    If you get 504: gateway/proxy read timeout is too short; set it > GPT_TIMEOUT_SEC (default 90) or lower GPT_TIMEOUT_SEC."""
    global _translate_in_flight
    t0 = time.time()
    data = request.json or {}
    segments = data.get('segments') or []
    target_lang = data.get('targetLang') or data.get('target_lang') or 'he'
    if not isinstance(segments, list):
        return jsonify({"error": "segments must be an array"}), 400
    _translate_in_flight += 1
    logging.info("GPT translate: in_flight=%d (concurrent requests)", _translate_in_flight)
    try:
        translated, meta = translate_segments(segments, target_lang=target_lang)
        elapsed = time.time() - t0
        last_job, callback_at, last_user_id = _get_last_callback_for_gpt()
        if last_job and callback_at is not None and (time.time() - callback_at) < 120:
            _update_job_timings(last_job, user_id=last_user_id, gpt_sec=elapsed)
        return jsonify({"segments": translated, "meta": meta})
    finally:
        _translate_in_flight -= 1


@app.route('/api/wrap_transcript_text', methods=['POST'])
def api_wrap_transcript_text():
    """Re-flow clean_transcript for TXT export (same merge+wrap as DOCX). Client TXT was raw GPT line breaks (~30 chars)."""
    data = request.json or {}
    text = str(data.get('text') or '').strip()
    if not text:
        return jsonify({"error": "No text provided"}), 400
    try:
        return jsonify({"text": _wrap_text_to_max_chars(text)}), 200
    except Exception as e:
        logging.warning("wrap_transcript_text failed: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route('/api/format_transcript_summary', methods=['POST'])
def api_format_transcript_summary():
    """Return clean transcript + summary fields for DOCX export."""
    t0 = time.time()
    data = request.json or {}
    target_lang = data.get('targetLang') or data.get('target_lang') or 'he'
    req_job_id = (data.get('jobId') or data.get('job_id') or '').strip() or None
    req_user_id = (data.get('userId') or data.get('user_id') or '').strip() or None
    raw_text = str(data.get('text') or '').strip()
    segments = data.get('segments') or []
    if not raw_text and isinstance(segments, list):
        raw_text = "\n".join(
            str((s or {}).get('text') or '').strip()
            for s in segments
            if str((s or {}).get('text') or '').strip()
        ).strip()
    if not raw_text:
        return jsonify({"error": "No transcript text provided"}), 400
    try:
        out = _format_transcript_and_summary_via_openai(raw_text, target_lang=target_lang)
        ct = str((out or {}).get('clean_transcript') or '').strip()
        if ct:
            out['clean_transcript'] = _wrap_text_to_max_chars(ct)
        elapsed = time.time() - t0
        timing_job_id = req_job_id
        timing_user_id = req_user_id
        if not timing_job_id:
            last_job, callback_at, last_user_id = _get_last_callback_for_gpt()
            if last_job and callback_at is not None and (time.time() - callback_at) < 600:
                timing_job_id = last_job
                timing_user_id = timing_user_id or last_user_id
        if timing_job_id:
            _update_job_timings(timing_job_id, user_id=timing_user_id, gpt_format_sec=elapsed)
        out['gpt_format_sec'] = round(float(elapsed), 3)
        return jsonify(out), 200
    except Exception as e:
        logging.warning("format_transcript_summary failed: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route('/api/docx_force_rtl', methods=['POST'])
def api_docx_force_rtl():
    """Receive a DOCX file and return a RTL/right-aligned DOCX."""
    try:
        uploaded = request.files.get('file')
        if not uploaded:
            return jsonify({"error": "file is required"}), 400
        filename = str(uploaded.filename or 'document.docx')
        if not filename.lower().endswith('.docx'):
            return jsonify({"error": "Only .docx is supported"}), 400
        raw = uploaded.read()
        if not raw:
            return jsonify({"error": "Empty file"}), 400
        fixed = _force_docx_rtl_bytes(raw)
        from flask import send_file
        out = BytesIO(fixed)
        out.seek(0)
        return send_file(
            out,
            as_attachment=True,
            download_name=filename,
            mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
    except Exception as e:
        logging.warning("docx_force_rtl failed: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route('/api/export_docx', methods=['POST'])
def api_export_docx():
    """
    Generate a fully RTL Hebrew DOCX in Python and stream it back.
    Body JSON: { text, segments, kind, filename }
      kind: 'transcript' | 'summary'
    The endpoint calls format_transcript_summary internally so the caller
    does not need a separate AI call.
    """
    try:
        data = request.json or {}
        kind     = str(data.get('kind') or 'transcript').lower()
        raw_text = str(data.get('text') or '').strip()
        segments = data.get('segments') or []
        filename = (str(data.get('filename') or 'document')
                    .replace('/', '_').replace('\\', '_').strip() or 'document')

        if not raw_text and isinstance(segments, list):
            raw_text = '\n'.join(
                str((s or {}).get('text') or '').strip()
                for s in segments
                if str((s or {}).get('text') or '').strip()
            ).strip()

        if not raw_text:
            return jsonify({"error": "No transcript text provided"}), 400

        # Prefer precomputed formatting from saved JSON/session to avoid GPT on each export.
        format_source = 'precomputed'
        allow_gpt_fallback = bool(data.get('allow_gpt_fallback'))
        fmt = data.get('formatted') if isinstance(data.get('formatted'), dict) else None
        if not isinstance(fmt, dict):
            if allow_gpt_fallback:
                try:
                    fmt = _format_transcript_and_summary_via_openai(raw_text, target_lang='he')
                    format_source = 'gpt_fallback'
                except Exception as ai_err:
                    logging.warning("export_docx: AI format failed (%s), using raw text", ai_err)
                    fmt = {'clean_transcript': raw_text, 'overview': '', 'key_points': []}
                    format_source = 'raw_no_gpt'
            else:
                fmt = {'clean_transcript': raw_text, 'overview': '', 'key_points': []}
                format_source = 'raw_no_gpt'

        if kind == 'summary':
            overview   = str(fmt.get('overview') or '').strip()
            key_points = [str(p).strip() for p in (fmt.get('key_points') or []) if str(p).strip()]
            lines = []
            lines.append('סקירה:')
            lines.append(overview or 'N/A')
            lines.append('')
            lines.append('נקודות מפתח:')
            lines.extend(key_points or ['לא הוחזרו נקודות מפתח.'])
            dl_name = filename + '_summary.docx'
        else:
            clean = str(fmt.get('clean_transcript') or '').strip() or raw_text
            clean = _wrap_text_to_max_chars(clean)
            lines = [l for l in clean.split('\n') if l.strip()]
            dl_name = filename + '.docx'

        docx_bytes = _build_rtl_docx(lines)

        from flask import send_file
        out = BytesIO(docx_bytes)
        out.seek(0)
        resp = send_file(
            out,
            as_attachment=True,
            download_name=dl_name,
            mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
        resp.headers['X-Docx-Format-Source'] = format_source
        return resp
    except Exception as e:
        logging.exception("export_docx failed: %s", e)
        return jsonify({"error": str(e)}), 500


# --- 1. Add Global Cache at the top ---
job_results_cache = {}

# --- 2. GPU Callback: bulletproof contract (return 200 only after we've saved) ---
# Worker must POST here; only 200 + body.ok=true means "app has received and stored the result".
# See docs/GPU_CALLBACK_API.md for full contract.
@app.route('/api/gpu_callback', methods=['POST'])
def gpu_callback():
    t0 = time.time()
    data = request.json or {}
    job_id = data.get('jobId')
    if not job_id:
        return jsonify({"ok": False, "error": "jobId required"}), 400
    result = data.get('result') or {}
    segments = result.get('segments') or data.get('segments') or []
    if not isinstance(segments, list):
        return jsonify({"ok": False, "error": "segments must be an array"}), 400

    # Resolve input_s3_key and user_id (for S3 path)
    pending = pending_job_info.pop(job_id, None)
    if pending:
        input_s3_key = pending.get('input_s3_key') or ''
        user_id = pending.get('user_id')
    else:
        input_info = data.get('input') or {}
        input_s3_key = input_info.get('s3Key') or data.get('s3Key') or ''
        user_id = _extract_user_id_from_s3_key(input_s3_key)

    result_s3_key = None
    s3_sec = 0.0
    if input_s3_key:
        try:
            transcript_payload = {"segments": segments}
            w, c = _flatten_words_from_segments(segments)
            if w is not None and c is not None:
                transcript_payload["words"] = w
                transcript_payload["captions"] = c
            result_s3_key = _put_transcript_json_to_s3(user_id or 'anonymous', input_s3_key, transcript_payload, stage='gpt')
            result_dict = dict(result) if isinstance(result, dict) else {}
            result_dict['result_s3_key'] = result_s3_key
            data = dict(data)
            data['result'] = result_dict
        except Exception as e:
            logging.exception("Failed to save job result to S3 for %s", job_id)
            return jsonify({"ok": False, "error": "Failed to save result", "detail": str(e)}), 500

    data = dict(data)
    data.setdefault('result', {})
    data['result'] = dict(data.get('result') or result) if isinstance(result, dict) else {}
    data['result']['segments'] = segments
    data['segments'] = segments
    data['status'] = 'completed'

    job_results_cache[job_id] = data
    socketio.emit('job_status_update', data, room=job_id)

    # Build timing summary: read from metadata.qs_trigger, in-memory, or timing columns (DB survives multi-instance)
    now = time.time()
    file_timings = _get_trigger_timings(job_id)
    mem_timings = job_timings.pop(job_id, {})
    db_timings = _get_job_timings_from_db(job_id, user_id) if user_id else {}
    queued_at = file_timings.get("queued_at") or pending_trigger_at.get(job_id, t0)
    trigger_completed_at = file_timings.get("trigger_completed_at") or mem_timings.get("trigger_completed_at")
    started_at = file_timings.get("gpu_started_at") or gpu_started_at.pop(job_id, None) or db_timings.get("gpu_started_at")

    total_sec = now - queued_at
    trigger_sec = mem_timings.get("trigger_sec") or file_timings.get("trigger_sec") or db_timings.get("trigger_sec")

    # runpod wakeup = trigger to gpu_started (cold start; download happens after gpu_started)
    waiting_for_run = None
    if trigger_completed_at is not None and started_at is not None:
        waiting_for_run = started_at - trigger_completed_at

    runpod_process = None
    if started_at is not None:
        runpod_process = now - started_at

    # Worker can send timing in result.timing: { download_sec, wakeup_sec, transcribe_sec, gpt_sec }
    worker_timing = (result if isinstance(result, dict) else {}).get("timing") or {}
    if not isinstance(worker_timing, dict):
        worker_timing = {}

    download_sec = worker_timing.get("download_sec")
    wakeup_sec = worker_timing.get("wakeup_sec") or waiting_for_run
    process_sec = runpod_process
    gpt_sec = worker_timing.get("gpt_sec")

    # So frontend handshake completes even if /api/gpu_started was never called; shared store for multi-worker
    if job_id in pending_trigger and pending_trigger.get(job_id) != "failed":
        pending_trigger[job_id] = "triggered"
    _set_trigger_state(job_id, "triggered")

    # Store for GPT timing inference: api_translate_segments will log addendum when it completes
    _set_last_callback_for_gpt(job_id, now, user_id=user_id)

    # Persist PROCESS TIMING to DB (runpod_wakeup_sec, runpod_process_sec, gpt_sec; gpt filled when translate completes)
    _update_job_timings(
        job_id,
        user_id=user_id,
        trigger_sec=trigger_sec,
        download_sec=download_sec,
        runpod_wakeup_sec=wakeup_sec,
        runpod_process_sec=process_sec,
        gpt_sec=gpt_sec,
        total_sec=total_sec,
    )

    # Optional transcription completion email.
    # Sends once per runpod job id for this process lifetime.
    try:
        if job_id not in transcription_email_sent:
            notify = _get_job_notification_info(job_id, user_id=user_id)
            to_email = (notify.get("user_email") or "").strip()
            open_job_id = (notify.get("job_id") or job_id)
            if to_email and open_job_id:
                from urllib.parse import quote
                public_base = _public_base_url(request)
                open_url = f"{public_base}/?open={quote(str(open_job_id), safe='')}"
                sent_ok = _send_transcription_ready_email(to_email, notify.get("user_name"), open_url)
                if sent_ok:
                    transcription_email_sent.add(job_id)
                else:
                    logging.warning("transcription ready email not sent for %s: SMTP send returned false", job_id)
            else:
                logging.warning(
                    "transcription ready email skipped for %s: missing to_email or open_job_id (to_email=%s, open_job_id=%s)",
                    job_id,
                    bool(to_email),
                    bool(open_job_id),
                )
    except Exception as _email_err:
        logging.warning("transcription ready email flow failed for %s: %s", job_id, _email_err)

    return jsonify({
        "ok": True,
        "received": True,
        "job_id": job_id,
        "stage": "saved",
        "result_s3_key": result_s3_key,
    }), 200


# --- 3. Update Join Logic to CHECK the Cache ---
@socketio.on('join')
def on_join(data):
    room = data.get('room')
    if room:
        join_room(room)
        print(f"Client joined room: {room}")

        # CHECK MAILBOX: Is the result already waiting?
        if room in job_results_cache:
            print(f"馃摝 Found cached result for {room}, sending now!")
            # Send it to this specific user who just reconnected
            socketio.emit('job_status_update', job_results_cache[room], room=request.sid)

# --- SIMULATION BACKGROUND TASK ---
# This simulates the GPU finishing and sending data back after 4 seconds
# Updated simulation thread logic
def simulate_completion(jid, run_diarization):
    import time
    time.sleep(1)
    segments = []

    # Simulation sample text (kept generic; old fixed Hebrew snippet removed)
    transcript_text = [
        "Simulation segment one.",
        "Simulation segment two.",
        "Simulation segment three.",
        "Simulation segment four."
    ]

    for i, text in enumerate(transcript_text):
        # Create a basic segment
        segment = {
            "start": float(i * 5),
            "end": float(i * 5 + 4),
            "text": text
        }

        # ONLY add the speaker key if diarization was requested
        if run_diarization:
            # Alternating speakers for the test
            segment["speaker"] = "SPEAKER_00" if i % 4 == 0 else "SPEAKER_01"

        segments.append(segment)

    # Post-process: add correction via GPT (Node script)
    segments, tmeta = translate_segments(segments, target_lang='he')

    mock_data = {
        "jobId": jid,
        "status": "completed",
        "result": {"segments": segments, "translation_meta": tmeta}
    }

    global job_results_cache
    job_results_cache[jid] = mock_data

    # Send the result to the frontend
    socketio.emit('job_status_update', mock_data, room=jid)
    print(f"🔮 SIMULATION COMPLETE: Room {jid} | Diarization Output: {run_diarization}")


@app.route('/api/sign-s3', methods=['POST'])
def sign_s3():
    import boto3
    import os
    import time
    from threading import Thread

    data = request.json or {}
    user_id = (data.get('userId') or data.get('user_id') or '').strip() or 'anonymous'
    user_prefix = f"users/{user_id}"

    if SIMULATION_MODE:
        job_id = f"job_sim_{int(time.time())}"
        s3_key = f"{user_prefix}/simulation_audio"

        is_diarization_requested = data.get('diarization', False)

        Thread(target=simulate_completion, args=(job_id, is_diarization_requested)).start()

        return jsonify({
            'data': {
                'url': 'http://localhost:8000/api/mock-upload',
                's3Key': s3_key,  # Matches the backup key
                'jobId': job_id
            }
        })

    else:
        # --- LIVE AWS LOGIC ---
        filename = data.get('filename')
        file_type = data.get('filetype')

        key_id = os.environ.get("AWS_ACCESS_KEY_ID")
        secret = os.environ.get("AWS_SECRET_ACCESS_KEY")
        region = os.environ.get("AWS_REGION", "eu-north-1")
        bucket = os.environ.get("S3_BUCKET") or "quickscribe-v2-12345"

        if not key_id or not secret:
            return jsonify({"status": "error", "message": "AWS Credentials missing on server"}), 500

        s3_client = boto3.client(
            's3',
            aws_access_key_id=key_id,
            aws_secret_access_key=secret,
            region_name=region
        )

        base_name, extension = os.path.splitext(filename)
        job_id = f"job_{int(time.time())}_{base_name}"
        s3_key = f"{user_prefix}/input/{job_id}{extension}"

        presigned_url = s3_client.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': bucket,
                'Key': s3_key,
                'ContentType': file_type
            },
            ExpiresIn=3600
        )

        # Trigger RunPod early (before upload) so container warms during upload — unless RUNPOD_SKIP_WARMUP.
        if not _runpod_skip_warmup():
            _start_trigger_if_configured(
                job_id=job_id,
                s3_key=s3_key,
                request=request,
                task='transcribe',
                language=data.get('language', 'he'),
                diarization=data.get('diarization', False),
                speaker_count=2,
            )
        else:
            logging.info("RUNPOD_SKIP_WARMUP: skipping sign-s3 RunPod trigger for %s", job_id)

        return jsonify({
            'data': {
                'url': presigned_url,
                's3Key': s3_key,  # This must be saved by the frontend!
                'jobId': job_id
            }
        })

def _start_trigger_if_configured(job_id, s3_key, request, task='transcribe', language='he', diarization=False, speaker_count=2):
    """Start RunPod trigger in background. Called from sign_s3 (before upload) so container warms during upload.
    No-op if RunPod not configured or SIMULATION_MODE."""
    if SIMULATION_MODE:
        return
    endpoint_id = os.environ.get('RUNPOD_ENDPOINT_ID')
    api_key = os.environ.get('RUNPOD_API_KEY')
    if not endpoint_id or not api_key:
        return
    public_base = _public_base_url(request)
    callback_url = f"{public_base}/api/gpu_callback"
    start_callback_url = f"{public_base}/api/gpu_started"
    upload_status_url = f"{public_base}/api/upload_status?job_id={job_id}"
    payload = {
        "input": {
            "s3Key": s3_key,
            "jobId": job_id,
            "task": task,
            "language": language,
            "callback_url": callback_url,
            "start_callback_url": start_callback_url,
            "upload_status_url": upload_status_url,
        }
    }
    pending_job_info[job_id] = {
        "input_s3_key": s3_key,
        "user_id": _extract_user_id_from_s3_key(s3_key),
        "task": task,
        "language": language,
    }
    pending_trigger[job_id] = "queued"
    t_queued = time.time()
    pending_trigger_at[job_id] = t_queued
    _set_trigger_state(job_id, "queued", queued_at=t_queued)
    t = threading.Thread(target=_trigger_gpu, args=(job_id, payload, endpoint_id, api_key))
    t.daemon = True
    t.start()
    logging.info("Trigger started at sign-s3 (before upload) for %s", job_id)


def _trigger_gpu(job_id, payload, endpoint_id, api_key):
    """Background: POST /run to wake RunPod from cold and start the job. No polling.
    The trigger itself starts the container; worker downloads from S3 and transcribes."""
    global pending_trigger, job_timings
    t0 = time.time()
    try:
        clean_id = str(endpoint_id).strip()
        endpoint_url = f"https://api.runpod.ai/v2/{clean_id}/run"
        headers = {"Authorization": f"Bearer {api_key.strip()}", "Content-Type": "application/json"}
        response = requests.post(endpoint_url, json=payload, headers=headers, timeout=15)
        trigger_sec = time.time() - t0
        trigger_completed_at = time.time()
        job_timings[job_id] = {"trigger_sec": trigger_sec, "trigger_completed_at": trigger_completed_at}
        _update_trigger_timings(job_id, trigger_sec=trigger_sec, trigger_completed_at=trigger_completed_at)
        # Persist to DB immediately (survives multi-instance / ephemeral storage)
        pending = pending_job_info.get(job_id, {})
        user_id = pending.get("user_id") or _extract_user_id_from_s3_key((pending.get("input_s3_key") or ""))
        _update_job_timings(job_id, user_id=user_id, trigger_sec=trigger_sec, trigger_completed_at=trigger_completed_at)
        if response.status_code in (200, 201, 202):
            pending_trigger[job_id] = "run_accepted"
            _set_trigger_state(job_id, "run_accepted")
            print(f"🚀 RunPod accepted job {job_id} (container starting)")
        else:
            pending_trigger[job_id] = "failed"
            _set_trigger_state(job_id, "failed")
            print(f"❌ RunPod API Error ({response.status_code}): {response.text}")
    except Exception as e:
        pending_trigger[job_id] = "failed"
        _set_trigger_state(job_id, "failed")
        logging.exception("trigger_gpu failed for %s", job_id)


@app.route('/api/gpu_started', methods=['POST'])
def gpu_started():
    """Early handshake from worker: called once app_transcribe.py starts.
    Marks pending_trigger[job_id] as 'triggered' so frontend can move from 'queued' to 'processing'."""
    global gpu_started_at
    data = request.json or {}
    job_id = data.get('jobId') or data.get('job_id')
    if not job_id:
        return jsonify({"ok": False, "error": "jobId required"}), 400
    started_at = time.time()
    gpu_started_at[job_id] = started_at
    _update_trigger_timings(job_id, gpu_started_at=started_at)
    # Persist runpod_wakeup_sec and gpu_started_at to DB (survives multi-instance)
    pending = pending_job_info.get(job_id, {})
    user_id = pending.get("user_id") or _extract_user_id_from_s3_key((pending.get("input_s3_key") or ""))
    trigger_completed_at = _get_trigger_timings(job_id).get("trigger_completed_at")
    if trigger_completed_at is None:
        db_timings = _get_job_timings_from_db(job_id, user_id)
        trigger_completed_at = db_timings.get("trigger_completed_at")
    if trigger_completed_at is not None:
        wakeup_sec = started_at - trigger_completed_at
        _update_job_timings(job_id, user_id=user_id, runpod_wakeup_sec=wakeup_sec, gpu_started_at=started_at)
    if job_id in pending_trigger and pending_trigger.get(job_id) != "failed":
        pending_trigger[job_id] = "triggered"
    _set_trigger_state(job_id, "triggered")
    if job_id not in pending_trigger or pending_trigger.get(job_id) == "failed":
        logging.warning("gpu_started for unknown or failed job_id %s", job_id)
    return jsonify({"ok": True, "job_id": job_id}), 200


@app.route('/api/upload_status', methods=['GET'])
def upload_status():
    """Worker polls this until upload is complete. Set when trigger_processing is called (after frontend upload)."""
    def _is_upload_complete_in_db(job_id_value: str) -> bool:
        try:
            supabase_url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
            service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
            if not supabase_url or not service_key or not job_id_value:
                return False
            from urllib.parse import quote
            jid = quote(str(job_id_value), safe='')
            url = (
                f"{supabase_url}/rest/v1/jobs"
                f"?runpod_job_id=eq.{jid}"
                f"&select=status,metadata,updated_at"
                f"&order=updated_at.desc"
                f"&limit=1"
            )
            headers = {
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Accept": "application/json",
            }
            r = requests.get(url, headers=headers, timeout=6)
            if r.status_code != 200:
                return False
            rows = r.json() if r.content else []
            if not rows:
                return False
            row = rows[0] if isinstance(rows[0], dict) else {}
            status_val = str(row.get("status") or "").strip().lower()
            if status_val in ("uploaded", "processing", "processed", "completed", "exported"):
                return True
            md = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            qt = md.get(_QS_TRIGGER_META_KEY) if isinstance(md.get(_QS_TRIGGER_META_KEY), dict) else {}
            if qt.get("upload_complete"):
                return True
            md_upload = str(md.get("upload_status") or "").strip().lower()
            return md_upload in ("complete", "completed", "uploaded", "done")
        except Exception:
            return False

    job_id = request.args.get('job_id')
    if not job_id:
        return jsonify({"error": "job_id required"}), 400
    file_timings = _get_trigger_timings(job_id)
    is_complete = (job_id in upload_complete) or bool(file_timings.get("upload_complete"))
    # Multi-instance safety: worker polling may hit a different app instance.
    # If in-memory / qs_trigger flag is missing, infer from jobs.status / metadata.
    if not is_complete and _is_upload_complete_in_db(job_id):
        upload_complete[job_id] = True
        _mark_upload_complete(job_id)
        is_complete = True
    status = "complete" if is_complete else "pending"
    return jsonify({"job_id": job_id, "status": status}), 200


@app.route('/api/trigger_status', methods=['GET'])
def trigger_status():
    """Frontend polls this until status is 'triggered', then starts progress bar.
    If status stays 'queued' longer than STALE_QUEUED_SEC, returns 'stale_queued' so frontend can retry.
    Reads persisted state from Supabase (and in-memory cache) so any Gunicorn worker sees updates."""
    job_id = request.args.get('job_id')
    if not job_id:
        return jsonify({"error": "job_id required"}), 400
    persisted_status, persisted_at = _get_trigger_state(job_id)
    status = persisted_status if persisted_status else pending_trigger.get(job_id, "unknown")
    queued_since_sec = None
    if status == "queued":
        at = persisted_at if persisted_at else pending_trigger_at.get(job_id, 0)
        queued_since_sec = int(time.time() - at) if at else 0
        if queued_since_sec > STALE_QUEUED_SEC:
            status = "stale_queued"
    out = {"job_id": job_id, "status": status}
    if status in ("queued", "stale_queued") and queued_since_sec is not None:
        out["queued_since_sec"] = queued_since_sec
    return jsonify(out), 200

@app.route('/api/trigger_processing', methods=['POST'])
def trigger_processing():
    try:
        data = request.json if request.is_json else {}
        if not data:
            data = {}
        logging.info("trigger_processing request: job_id=%s has_s3_key=%s", data.get('jobId'), bool(data.get('s3Key')))
        print(f"📩 Received Trigger Request: {data}")

        s3_key = data.get('s3Key')
        job_id = data.get('jobId')
        if SIMULATION_MODE:
            print("🔮 SIMULATION: Skipping RunPod Trigger")
            if job_id:
                upload_complete[job_id] = True
                pending_trigger[job_id] = "triggered"
                _set_trigger_state(job_id, "triggered")
                _mark_upload_complete(job_id)
            return jsonify({"status": "started", "runpod_id": "sim_id_123"}), 202

        if not s3_key or not job_id:
            return jsonify({"status": "error", "message": "s3Key and jobId required"}), 400

        # Trigger was already started at sign-s3 (before upload); signal upload complete for worker
        upload_complete[job_id] = True
        _mark_upload_complete(job_id)
        logging.info(
            "upload_complete set for job_id=%s (worker upload_status will see complete); s3_key_suffix=%s",
            job_id,
            (s3_key[-64:] if isinstance(s3_key, str) and len(s3_key) > 64 else s3_key),
        )

        # Trigger already running; just confirm
        if job_id in pending_trigger and pending_trigger.get(job_id) not in ("failed", None):
            logging.info("trigger_processing: job_id=%s already queued/triggered, skipping second RunPod /run", job_id)
            return jsonify({"status": "started", "job_id": job_id}), 202

        endpoint_id = os.environ.get('RUNPOD_ENDPOINT_ID')
        api_key = os.environ.get('RUNPOD_API_KEY')
        print(f"🔑 checking keys... Endpoint ID exists? {bool(endpoint_id)} | API Key exists? {bool(api_key)}")

        task = data.get('task', 'transcribe')
        language = data.get('language', 'he')
        diarization = data.get('diarization', False)

        if not endpoint_id or not api_key:
            print("🔮 RunPod not configured: falling back to simulation (mock result in ~1s)")
            pending_trigger[job_id] = "triggered"
            _set_trigger_state(job_id, "triggered")
            if not SIMULATION_MODE:
                t = threading.Thread(target=simulate_completion, args=(job_id, diarization))
                t.daemon = True
                t.start()
            return jsonify({"status": "started", "runpod_id": "sim_id_123"}), 202

        try:
            speaker_count = int(data.get('speakerCount', 2))
        except Exception:
            speaker_count = 2

        public_base = _public_base_url(request)
        callback_url = f"{public_base}/api/gpu_callback"
        start_callback_url = f"{public_base}/api/gpu_started"
        upload_status_url = f"{public_base}/api/upload_status?job_id={job_id}"

        payload = {
            "input": {
                "s3Key": s3_key,
                "jobId": job_id,
                "task": task,
                "language": language,
                "callback_url": callback_url,
                "start_callback_url": start_callback_url,
                "upload_status_url": upload_status_url,
            }
        }

        # So gpu_callback can save raw JSON even when RunPod does not echo input; store task/language for retry
        pending_job_info[job_id] = {
            "input_s3_key": s3_key,
            "user_id": _extract_user_id_from_s3_key(s3_key),
            "task": task,
            "language": language,
        }
        t_queued = time.time()
        pending_trigger[job_id] = "queued"  # thread will update to "triggered" or "failed"
        pending_trigger_at[job_id] = t_queued
        _set_trigger_state(job_id, "queued", queued_at=t_queued)
        t = threading.Thread(
            target=_trigger_gpu,
            args=(job_id, payload, endpoint_id, api_key)
        )
        t.daemon = True
        t.start()

        # Return "started" so first/cold run shows "Triggering processing..." not "Wait in line..."
        return jsonify({"status": "started", "job_id": job_id}), 202

    except Exception as e:
        print(f"❌ trigger_processing CRASHED: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/retry_trigger', methods=['POST'])
def retry_trigger():
    """Re-send RunPod trigger for a job that is stuck (e.g. trigger never fired). Uses stored job info."""
    global pending_trigger, pending_trigger_at
    try:
        data = request.json if request.is_json else {}
        job_id = (data or {}).get('jobId')
        if not job_id:
            return jsonify({"status": "error", "message": "jobId required"}), 400
        if SIMULATION_MODE:
            return jsonify({"status": "retry_started", "job_id": job_id}), 202
        info = pending_job_info.get(job_id)
        if not info:
            return jsonify({"status": "error", "message": "Job not found or expired"}), 404
        s3_key = info.get("input_s3_key")
        if not s3_key:
            return jsonify({"status": "error", "message": "Job missing s3 key"}), 400
        endpoint_id = os.environ.get('RUNPOD_ENDPOINT_ID')
        api_key = os.environ.get('RUNPOD_API_KEY')
        if not endpoint_id or not api_key:
            return jsonify({"status": "error", "message": "RunPod not configured"}), 503
        task = info.get('task', 'transcribe')
        language = info.get('language', 'he')
        public_base = _public_base_url(request)
        callback_url = f"{public_base}/api/gpu_callback"
        start_callback_url = f"{public_base}/api/gpu_started"
        upload_status_url = f"{public_base}/api/upload_status?job_id={job_id}"
        payload = {
            "input": {
                "s3Key": s3_key,
                "jobId": job_id,
                "task": task,
                "language": language,
                "callback_url": callback_url,
                "start_callback_url": start_callback_url,
                "upload_status_url": upload_status_url,
            }
        }
        upload_complete[job_id] = True  # retry: upload was already done
        _mark_upload_complete(job_id)
        t_queued = time.time()
        pending_trigger[job_id] = "queued"
        pending_trigger_at[job_id] = t_queued
        _set_trigger_state(job_id, "queued", queued_at=t_queued)
        t = threading.Thread(
            target=_trigger_gpu,
            args=(job_id, payload, endpoint_id, api_key)
        )
        t.daemon = True
        t.start()
        print(f"🔄 Retry trigger started for job {job_id}")
        return jsonify({"status": "retry_started", "job_id": job_id}), 202
    except Exception as e:
        logging.exception("retry_trigger failed")
        return jsonify({"status": "error", "message": str(e)}), 500


# --- SIMULATION MODE (for frontend) ---
@app.route('/api/simulation_mode', methods=['GET'])
def get_simulation_mode():
    """Return whether server is in simulation mode so frontend can show subtitle upload hint."""
    return jsonify({"simulation": SIMULATION_MODE}), 200


# --- BURN SUBTITLES (SERVER-SIDE ON KOYEB) ---
burn_tasks = {}  # task_id -> { status, output_s3_key?, error? }

def _resolve_ffmpeg():
    """Return an executable ffmpeg path.
    Order: env FFMPEG_PATH, PATH, project bin/, common system path.
    If a local binary exists but lacks execute bits, try chmod on non-Windows.
    """
    def _ensure_exec(path):
        if not path or not os.path.isfile(path):
            return None
        if sys.platform == 'win32':
            return path
        if os.access(path, os.X_OK):
            return path
        try:
            os.chmod(path, 0o755)
            if os.access(path, os.X_OK):
                return path
        except Exception:
            pass
        return None

    def _can_run(path):
        """Verify binary can execute in this environment (avoids noexec mounts)."""
        if not path:
            return False
        try:
            result = subprocess.run([path, '-version'], capture_output=True, text=True, timeout=10)
            return result.returncode == 0
        except Exception:
            return False

    path = os.environ.get('FFMPEG_PATH', '').strip()
    env_exec = _ensure_exec(path)
    if env_exec and _can_run(env_exec):
        return env_exec

    which_ffmpeg = shutil.which('ffmpeg')
    if which_ffmpeg and _can_run(which_ffmpeg):
        return which_ffmpeg
    # Project bin folder (e.g. QuickScribe/Site/bin/)
    app_dir = os.path.dirname(os.path.abspath(__file__))
    bin_dir = os.path.join(app_dir, 'bin')
    for name in ('ffmpeg', 'ffmpeg.exe'):
        candidate = os.path.join(bin_dir, name)
        candidate_exec = _ensure_exec(candidate)
        if candidate_exec and _can_run(candidate_exec):
            return candidate_exec
    sys_ffmpeg = _ensure_exec('/usr/bin/ffmpeg') if sys.platform != 'win32' else None
    if sys_ffmpeg and _can_run(sys_ffmpeg):
        return sys_ffmpeg
    return 'ffmpeg'

def _probe_video_with_ffmpeg(ffmpeg_path, video_path):
    """Get (duration_sec, max_width) by running ffmpeg -i and parsing stderr. No ffprobe needed."""
    result = subprocess.run(
        [ffmpeg_path, '-i', video_path],
        capture_output=True, text=True, timeout=30
    )
    stderr = result.stderr or ''
    duration = 0.0
    width = 0
    # Duration: 00:01:23.45, start: ...
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+)[.,](\d*)', stderr)
    if m:
        h, m_min, s, frac = int(m.group(1)), int(m.group(2)), int(m.group(3)), (m.group(4) or '0')[:3].ljust(3, '0')
        duration = h * 3600 + m_min * 60 + s + int(frac) / 1000.0
    # Video stream: ... 1920x1080 ...
    for m in re.finditer(r'(\d{3,5})\s*x\s*(\d{3,5})', stderr):
        w, h = int(m.group(1)), int(m.group(2))
        if w > 0 and h > 0:
            width = max(width, w)
    return (duration, width)

def _ass_ts(s):
    """ASS time: H:MM:SS.cc (centiseconds)."""
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    cs = int(round((sec % 1) * 100))
    return f"{h}:{m:02d}:{int(sec):02d}.{cs:02d}"

# Punctuation that should stay with previous line in RTL (not start the next line)
_RTL_LINE_END_PUNCT = '.,;:!?،؛؟'
_HEBREW_RE = re.compile(r'[\u0590-\u05FF]')
_RTL_EMBED_OPEN = '\u202B'  # Right-to-left embedding
_RTL_EMBED_CLOSE = '\u202C'  # Pop directional formatting


def _rtl_force_direction(text):
    """Force RTL direction for Hebrew lines in ASS/burn (embedding only)."""
    if not text or not _HEBREW_RE.search(text):
        return text
    if text.startswith(_RTL_EMBED_OPEN) and text.endswith(_RTL_EMBED_CLOSE):
        return text
    return f"{_RTL_EMBED_OPEN}{text}{_RTL_EMBED_CLOSE}"


_LATIN_WORD_RE = re.compile(r'[a-zA-Z]{2,}')


def _rtl_srt_visual_order(text):
    """For SRT: mixed Hebrew+English – wrap in RTL embedding so bidi-aware players show like transcript. Pure Hebrew – move trailing punct to start."""
    if not text or not _HEBREW_RE.search(text):
        return text
    original = text
    trimmed = original.rstrip()
    if not trimmed:
        return original
    if _LATIN_WORD_RE.search(trimmed):
        if trimmed.startswith(_RTL_EMBED_OPEN) and trimmed.endswith(_RTL_EMBED_CLOSE):
            return original
        return f"{_RTL_EMBED_OPEN}{trimmed}{_RTL_EMBED_CLOSE}"
    m = re.match(r'^(.*?)([.,!?…:;]+)$', trimmed, re.UNICODE)
    if not m:
        return original
    body = m.group(1).lstrip()
    punct = m.group(2)
    if not body or body.startswith(punct):
        return original
    return f"{punct}{body}"




def _wrap_text_rtl_safe(text, max_chars_per_line):
    """Split text into lines; keep trailing punctuation with previous line (fixes RTL burn: comma/period at start of line)."""
    if not text or len(text) <= max_chars_per_line:
        return [text.strip()] if text and text.strip() else []
    parts = []
    rest = text
    while rest:
        rest = rest.lstrip()
        if not rest:
            break
        if len(rest) <= max_chars_per_line:
            parts.append(rest.strip())
            break
        chunk = rest[: max_chars_per_line + 1]
        last_space = chunk.rfind(' ')
        split_at = last_space if last_space > 0 else max_chars_per_line
        part = rest[:split_at].strip()
        rest = rest[split_at:].lstrip()
        # Don't start next line with punctuation (RTL: keeps , . at end of previous line)
        while rest and rest[0] in _RTL_LINE_END_PUNCT:
            part += rest[0]
            rest = rest[1:].lstrip()
        parts.append(part)
    return parts


def _ass_primary_outline_from_ui_color(subtitle_color=None):
    """Map UI subtitle color key to ASS PrimaryColour and OutlineColour (&HAABBGGRR). Matches static player palette."""
    key = (subtitle_color or 'yellow').strip().lower()
    hex_map = {
        'black': '111111',
        'red': 'ef4444',
        'yellow': 'facc15',
        'white': 'ffffff',
    }
    if key not in hex_map:
        key = 'yellow'
    hx = hex_map[key]
    primary = f"&H00{hx[4:6]}{hx[2:4]}{hx[0:2]}".upper()
    r = int(hx[0:2], 16)
    g = int(hx[2:4], 16)
    b = int(hx[4:6], 16)
    luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    outline = "&H00FFFFFF" if luminance < 0.45 else "&H00000000"
    return primary, outline


def _build_ass(segments, style='tiktok', portrait=False, subtitle_color=None):
    """Build ASS content. style: tiktok, clean, cinematic. portrait=True uses 14 chars/line (tiktok).
    subtitle_color: black|red|yellow|white — must match player / localStorage subtitleColor."""
    primary_ass, outline_ass = _ass_primary_outline_from_ui_color(subtitle_color)
    # PlayRes chosen for scale; ffmpeg will scale
    play_res_x, play_res_y = 384, 288
    if style == 'tiktok':
        # Bold, large, center. PrimaryColour / OutlineColour from user choice (was hardcoded white).
        style_line = f"Style: Default,Arial,28,{primary_ass},&H000000FF,{outline_ass},&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1"
    elif style == 'cinematic':
        style_line = f"Style: Default,Times New Roman,22,{primary_ass},&H000000FF,{outline_ass},&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,50,1"
    else:
        # clean
        style_line = f"Style: Default,Arial,18,{primary_ass},&H000000FF,{outline_ass},&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,50,1"
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {play_res_y}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        style_line,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    ]
    # TikTok bold: wrap at N chars per line (portrait/vertical = 14, landscape = 27); ASS newline is \N
    max_chars_per_line = 14 if (style == 'tiktok' and portrait) else (27 if style == 'tiktok' else 9999)
    def _esc_ass_text(s):
        return str(s or '').replace('\n', ' ').replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}')

    # Per-word inline tags (\1c primary fill, \3c outline). Highlight = swap fill/outline for contrast.
    NORMAL_TAG = "{{\\1c" + primary_ass + "&\\3c" + outline_ass + "&\\bord2\\shad0}}"
    ACTIVE_TAG = "{{\\1c" + outline_ass + "&\\3c" + primary_ass + "&\\bord3\\shad0\\blur0.4}}"
    PINNED_TAG = ACTIVE_TAG

    for seg in segments:
        start = seg.get('start', 0)
        end = seg.get('end', start + 1)
        text = _esc_ass_text(seg.get('text') or '')
        seg_style = seg.get('style') if isinstance(seg, dict) else None
        pos = None
        if isinstance(seg_style, dict):
            pos = str(seg_style.get('position') or '').strip().lower()
        # ASS alignment override per caption:
        # an8=top-center, an5=middle-center, an2=bottom-center
        pos_override = ''
        if pos == 'top':
            pos_override = r"{\an8}"
        elif pos == 'middle':
            pos_override = r"{\an5}"
        elif pos == 'bottom':
            pos_override = r"{\an2}"

        highlight_mode = ''
        if isinstance(seg_style, dict):
            highlight_mode = str(seg_style.get('highlightMode') or '').strip().lower()

        seg_words = seg.get('words') if isinstance(seg, dict) else None
        use_word_karaoke = (
            highlight_mode == 'active-word'
            and isinstance(seg_words, list)
            and len(seg_words) > 0
        )
        use_word_pinned = (
            (not use_word_karaoke)
            and isinstance(seg_words, list)
            and any(bool((w or {}).get('highlighted')) for w in seg_words)
        )

        # High-fidelity word-level rendering:
        # For active-word mode, emit one Dialogue event per active word timing window
        # and style only that word (plus pinned words) as highlighted.
        if use_word_karaoke:
            words_clean = []
            for w in seg_words:
                wt = _esc_ass_text((w or {}).get('text') or '')
                if not wt:
                    continue
                ws = float((w or {}).get('start') or start)
                we = float((w or {}).get('end') or (ws + 0.12))
                if we <= ws:
                    we = ws + 0.08
                words_clean.append({
                    'text': wt,
                    'start': ws,
                    'end': we,
                    'highlighted': bool((w or {}).get('highlighted'))
                })

            if words_clean:
                for ai in range(len(words_clean)):
                    aw = words_clean[ai]
                    ev_start = max(float(start), float(aw['start']))
                    ev_end = min(float(end), float(aw['end']))
                    if ev_end <= ev_start + 0.01:
                        ev_end = ev_start + 0.06

                    token_parts = []
                    for i, tw in enumerate(words_clean):
                        if tw['highlighted']:
                            token_parts.append(PINNED_TAG + tw['text'])
                        elif i == ai:
                            token_parts.append(ACTIVE_TAG + tw['text'])
                        else:
                            token_parts.append(NORMAL_TAG + tw['text'])

                    ev_text = ' '.join(token_parts)
                    # Keep RTL visual order stable for Hebrew text.
                    ev_text = _rtl_force_direction(ev_text)
                    if pos_override:
                        ev_text = pos_override + ev_text
                    lines.append(f"Dialogue: 0,{_ass_ts(ev_start)},{_ass_ts(ev_end)},Default,,0,0,0,,{ev_text}")
                continue
        if use_word_pinned:
            token_parts = []
            for w in seg_words:
                wt = _esc_ass_text((w or {}).get('text') or '')
                if not wt:
                    continue
                if bool((w or {}).get('highlighted')):
                    token_parts.append(PINNED_TAG + wt)
                else:
                    token_parts.append(NORMAL_TAG + wt)
            if token_parts:
                text = ' '.join(token_parts)
                text = _rtl_force_direction(text)
                if pos_override:
                    text = pos_override + text
                lines.append(f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Default,,0,0,0,,{text}")
                continue

        if style == 'tiktok' and (not use_word_karaoke) and len(text) > max_chars_per_line:
            parts = _wrap_text_rtl_safe(text, max_chars_per_line)
            parts = [_rtl_force_direction(p) for p in parts]
            text = '\\N'.join(parts) if parts else text
        elif not use_word_karaoke:
            text = _rtl_force_direction(text)
        if pos_override:
            text = pos_override + text
        lines.append(f"Dialogue: 0,{_ass_ts(start)},{_ass_ts(end)},Default,,0,0,0,,{text}")
    return "\r\n".join(lines) + "\r\n"

def _send_email_via_zoho(to_email, subject, body_text):
    """Send a plain-text email through Zoho SMTP. Returns True on success."""
    smtp_host = 'smtp.zoho.com'
    smtp_port = 465
    smtp_user = 'info@getquickscribe.com'
    smtp_pass = (os.environ.get('ZOHO_SMTP_PASS') or '').strip()
    from_email = smtp_user
    from_name = 'QuickScribe'
    if not to_email or not smtp_user or not smtp_pass:
        return False

    msg = EmailMessage()
    msg['Subject'] = subject
    msg['From'] = f"{from_name} <{from_email}>"
    msg['To'] = to_email
    msg.set_content(body_text or "")

    attempts = 3
    for attempt in range(1, attempts + 1):
        try:
            if smtp_port == 465:
                context = ssl.create_default_context()
                with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context, timeout=20) as server:
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
            else:
                with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
                    server.ehlo()
                    server.starttls(context=ssl.create_default_context())
                    server.ehlo()
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
            return True
        except Exception as e:
            logging.warning(
                "Zoho SMTP send failed (attempt %s/%s) to=%s subject=%s: %s",
                attempt,
                attempts,
                to_email,
                subject,
                e,
            )
            if attempt < attempts:
                time.sleep(1.5 * attempt)
    return False


def _send_burn_ready_email(to_email, download_url, base_name):
    """Send 'video ready' email via Zoho SMTP."""
    if not to_email:
        return
    subject = "Your video with subtitles is ready"
    body = (
        f"Your video '{base_name}' with burned-in subtitles is ready.\n\n"
        f"Download (link valid 24 hours):\n{download_url}\n\n"
        "— QuickScribe"
    )
    _send_email_via_zoho(to_email, subject, body)


def _get_job_notification_info(runpod_job_id, user_id=None):
    """Best-effort fetch for job id + user_email + user_name by runpod_job_id."""
    supabase_url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    service_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not service_key or not runpod_job_id:
        return {}

    from urllib.parse import quote
    rj = quote(str(runpod_job_id), safe='')
    uid = quote(str(user_id), safe='') if user_id else None
    where_with_user = f"runpod_job_id=eq.{rj}"
    if uid:
        where_with_user += f"&user_id=eq.{uid}"
    where_no_user = f"runpod_job_id=eq.{rj}"

    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
    }

    # Try richer columns first; gracefully fallback if columns are missing.
    selects = ("id,user_email,user_name", "id")
    wheres = (where_with_user, where_no_user) if uid else (where_no_user,)
    for where in wheres:
        for sel in selects:
            try:
                url = f"{supabase_url}/rest/v1/jobs?{where}&select={sel}&order=created_at.desc&limit=1"
                r = requests.get(url, headers=headers, timeout=8)
                if not r.ok:
                    continue
                rows = r.json() if r.content else []
                if not rows:
                    continue
                row = rows[0] or {}
                return {
                    "job_id": row.get("id"),
                    "user_email": row.get("user_email"),
                    "user_name": row.get("user_name"),
                }
            except Exception:
                continue
    return {}


def _send_transcription_ready_email(to_email, user_name, open_url):
    """Send transcription-complete email via Zoho SMTP."""
    if not to_email:
        return False
    display_name = str(user_name or '').strip() or 'שם המשתמש'
    subject = "הוידאו שלך מוכן! 🎬 הכתוביות מחכות לך ב-QuickScribe"
    body = (
        f"היי {display_name},\n\n"
        "חדשות טובות! מנועי ה-AI שלנו סיימו את העבודה. הוידאו שלך תומלל, והכתוביות מסונכרנות ומוכנות על גבי הסאונד.\n\n"
        "זה הזמן להיכנס למערכת, לעבור ברפרוף על הטקסט כדי לוודא שהכל מושלם (בכל זאת, אנחנו עומדים על 94% דיוק 😉), "
        "לעשות פינישים קטנים אם צריך – ולהוריד את הוידאו מוכן להפצה.\n\n"
        f"👉 למעבר לוידאו שלך: {open_url}\n\n"
        "אם יש לך שאלות או פידבק על התוצאה, אפשר פשוט להשיב למייל הזה, אני קורא הכל.\n\n"
        "יצירה נעימה,\n"
        "QuickScribe"
    )
    return _send_email_via_zoho(to_email, subject, body)


def _segments_to_srt_text(segments, max_chars_per_line=None):
    """Build SRT text. If max_chars_per_line is set (e.g. 27 for tiktok), wrap with RTL-safe line breaks."""
    def to_srt_ts(s):
        h = int(s // 3600)
        m = int((s % 3600) // 60)
        sec = s % 60
        return f"{h:02d}:{m:02d}:{int(sec):02d},{int((sec % 1) * 1000):03d}"

    rows = []
    for i, seg in enumerate(segments or []):
        start = float(seg.get('start', 0) or 0)
        end = float(seg.get('end', start + 1) or (start + 1))
        if end <= start:
            end = start + 0.5
        text = str(seg.get('text') or '').replace('\n', ' ')
        text = _rtl_srt_visual_order(text)
        rows.append(f"{i + 1}\n{to_srt_ts(start)} --> {to_srt_ts(end)}\n{text}\n")
    return "\n".join(rows) + ("\n" if rows else "")


def _extract_user_id_from_s3_key(s3_key: str):
    """Best-effort user id extraction from S3 key like users/{user_id}/..."""
    try:
        if s3_key and s3_key.startswith('users/'):
            parts = s3_key.split('/', 2)
            if len(parts) >= 2 and parts[1]:
                return parts[1]
    except Exception:
        return None
    return None


def _build_output_key(user_id, input_s3_key, task_id):
    base_name = "video"
    if input_s3_key:
        base_name = os.path.splitext(os.path.basename(input_s3_key))[0] or "video"
    safe_name = "".join(c for c in base_name if c.isalnum() or c in (' ', '-', '_'))[:80].strip() or "video"
    return f"users/{user_id}/output/{safe_name}_with_subtitles.mp4", safe_name


def _queue_burn_task_on_runpod(task_id, input_s3_key, segments, user_id, callback_url, subtitle_style=None, is_portrait=False, notify_email=None, job_id=None, subtitle_color=None):
    """Dispatch burn task to RunPod using presigned S3 URLs."""
    endpoint_id = (RUNPOD_MOVIE_ENDPOINT_ID or "").strip()
    api_key = (RUNPOD_API_KEY or "").strip()
    if not endpoint_id or not api_key:
        raise RuntimeError("RunPod movie endpoint is not configured")

    bucket = os.environ.get('S3_BUCKET')
    s3_client = boto3.client(
        's3',
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        region_name=os.environ.get('AWS_REGION')
    )

    if not bucket:
        raise RuntimeError("S3_BUCKET missing")

    output_s3_key, safe_name = _build_output_key(user_id, input_s3_key, task_id)
    has_custom_position = any(
        isinstance((seg or {}).get('style'), dict) and str(((seg or {}).get('style') or {}).get('position') or '').strip().lower() in ('top', 'middle', 'bottom')
        for seg in (segments or [])
    )
    has_word_highlights = any(
        any(bool((w or {}).get('highlighted')) for w in (((seg or {}).get('words') or []) if isinstance(seg, dict) else []))
        for seg in (segments or [])
    )
    prefer_ass = (subtitle_style in ('tiktok', 'clean', 'cinematic')) or has_custom_position or has_word_highlights
    subtitle_ext = 'ass' if prefer_ass else 'srt'
    subtitle_s3_key = f"users/{user_id}/tmp/subtitles/{task_id}.{subtitle_ext}"
    if prefer_ass:
        subtitle_text = _build_ass(segments, subtitle_style or 'tiktok', portrait=is_portrait, subtitle_color=subtitle_color)
        subtitle_content_type = "text/x-ssa; charset=utf-8"
    else:
        max_chars = 14 if (subtitle_style == 'tiktok' and is_portrait) else (27 if subtitle_style == 'tiktok' else 9999)
        subtitle_text = _segments_to_srt_text(segments, max_chars_per_line=max_chars)
        subtitle_content_type = "application/x-subrip; charset=utf-8"
    s3_client.put_object(
        Bucket=bucket,
        Key=subtitle_s3_key,
        Body=subtitle_text.encode("utf-8"),
        ContentType=subtitle_content_type
    )

    input_video_url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': bucket, 'Key': input_s3_key},
        ExpiresIn=10800
    )
    input_subtitle_url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': bucket, 'Key': subtitle_s3_key},
        ExpiresIn=10800
    )
    output_upload_url = s3_client.generate_presigned_url(
        'put_object',
        Params={'Bucket': bucket, 'Key': output_s3_key, 'ContentType': 'video/mp4'},
        ExpiresIn=21600
    )

    payload = {
        "input": {
            "task": "burn_subtitles",
            "task_id": task_id,
            "input_video_url": input_video_url,
            "input_srt_url": input_subtitle_url,
            "input_subtitle_format": subtitle_ext,
            "output_upload_url": output_upload_url,
            "output_s3_key": output_s3_key,
            "subtitle_style": (subtitle_style or 'tiktok'),
            "subtitle_color": (subtitle_color or 'yellow'),
            "is_portrait": is_portrait,
            "job_id": job_id,
            "user_id": user_id,
            "notify_email": notify_email,
            "callback_url": callback_url,
        }
    }
    endpoint_url = f"https://api.runpod.ai/v2/{endpoint_id}/run"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    dispatch_timeout = int((os.environ.get('RUNPOD_BURN_DISPATCH_TIMEOUT_SEC') or '35').strip() or 35)
    max_attempts = int((os.environ.get('RUNPOD_BURN_DISPATCH_RETRIES') or '4').strip() or 4)
    backoff_sec = float((os.environ.get('RUNPOD_BURN_DISPATCH_BACKOFF_SEC') or '1.5').strip() or 1.5)
    r = None
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            r = requests.post(endpoint_url, json=payload, headers=headers, timeout=dispatch_timeout)
            if r.status_code in (200, 201, 202):
                break
            # Retry transient upstream statuses.
            if r.status_code in (408, 409, 425, 429, 500, 502, 503, 504) and attempt < max_attempts:
                sleep_s = backoff_sec * attempt
                logging.warning(
                    "RunPod burn dispatch transient HTTP %s (attempt %s/%s), retrying in %.1fs",
                    r.status_code, attempt, max_attempts, sleep_s
                )
                time.sleep(sleep_s)
                continue
            raise RuntimeError(f"RunPod movie dispatch failed ({r.status_code}): {str(r.text)[:300]}")
        except Exception as e:
            last_err = e
            if attempt >= max_attempts:
                break
            sleep_s = backoff_sec * attempt
            logging.warning(
                "RunPod burn dispatch exception (attempt %s/%s): %s; retrying in %.1fs",
                attempt, max_attempts, e, sleep_s
            )
            time.sleep(sleep_s)
    if not r or r.status_code not in (200, 201, 202):
        if last_err:
            raise RuntimeError(f"RunPod movie dispatch failed after {max_attempts} attempts: {last_err}")
        raise RuntimeError(f"RunPod movie dispatch failed after {max_attempts} attempts")

    burn_tasks[task_id] = {
        'status': 'processing',
        'mode': 'runpod',
        'subtitle_format': subtitle_ext,
        'output_s3_key': output_s3_key,
        'subtitle_s3_key': subtitle_s3_key,
        'safe_name': safe_name
    }

def _run_burn_task(task_id, input_s3_key, segments, user_id, subtitle_style=None, is_portrait=False, notify_email=None, job_id=None, subtitle_color=None):
    """Background task: download from S3, check duration limit, burn subtitles, upload to S3, optional email."""
    bucket = os.environ.get('S3_BUCKET')
    s3_client = boto3.client(
        's3',
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
        region_name=os.environ.get('AWS_REGION')
    )
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            ext = '.mp4'
            if input_s3_key:
                for e in ('.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi'):
                    if input_s3_key.lower().endswith(e):
                        ext = e
                        break
            video_path = os.path.join(tmpdir, 'input' + ext)
            s3_client.download_file(bucket, input_s3_key, video_path)

            ffmpeg_path = _resolve_ffmpeg()
            if not (os.path.isfile(ffmpeg_path) or shutil.which(ffmpeg_path)):
                burn_tasks[task_id] = {'status': 'failed', 'error': 'ffmpeg not found. Install ffmpeg, set FFMPEG_PATH, or add it to PATH.'}
                return
            use_ass = subtitle_style in ('tiktok', 'clean', 'cinematic')
            if use_ass:
                ass_content = _build_ass(segments, subtitle_style or 'tiktok', portrait=is_portrait, subtitle_color=subtitle_color)
                subs_path = os.path.join(tmpdir, 'subtitles.ass')
                with open(subs_path, 'w', encoding='utf-8') as f:
                    f.write(ass_content)
            else:
                def to_srt_ts(s):
                    h = int(s // 3600)
                    m = int((s % 3600) // 60)
                    sec = s % 60
                    return f"{h:02d}:{m:02d}:{int(sec):02d},{int((sec % 1) * 1000):03d}"
                subs_path = os.path.join(tmpdir, 'subtitles.srt')
                with open(subs_path, 'w', encoding='utf-8') as f:
                    for i, seg in enumerate(segments):
                        start = seg.get('start', 0)
                        end = seg.get('end', start + 1)
                        text = (seg.get('text') or '').replace('\n', ' ')
                        f.write(f"{i + 1}\n{to_srt_ts(start)} --> {to_srt_ts(end)}\n{text}\n\n")

            out_path = os.path.join(tmpdir, 'output.mp4')
            subs_escaped = subs_path.replace('\\', '/').replace(':', '\\:').replace("'", "\\'")
            filter_name = 'ass' if use_ass else 'subtitles'
            vf = f"{filter_name}='{subs_escaped}'"
            cmd = [
                ffmpeg_path, '-y', '-i', video_path,
                '-vf', vf,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                '-c:a', 'aac', '-b:a', '128k',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                out_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if result.returncode != 0:
                burn_tasks[task_id] = {'status': 'failed', 'error': (result.stderr or 'ffmpeg failed')[-500:]}
                return
            if not os.path.exists(out_path):
                burn_tasks[task_id] = {'status': 'failed', 'error': 'No output file'}
                return

            # Friendly base name from input key (e.g. job_123_video.mp4 -> job_123_video)
            base_name = "video"
            if input_s3_key:
                base_name = os.path.splitext(os.path.basename(input_s3_key))[0] or "video"
            safe_name = "".join(c for c in base_name if c.isalnum() or c in (' ', '-', '_'))[:80].strip() or "video"
            out_key_friendly = f"users/{user_id}/output/{safe_name}_with_subtitles.mp4"
            out_key_fallback = f"users/{user_id}/output/burn_{task_id}.mp4"
            try:
                s3_client.upload_file(out_path, bucket, out_key_friendly, ExtraArgs={'ContentType': 'video/mp4'})
                out_key = out_key_friendly
            except Exception:
                out_key = out_key_fallback
                s3_client.upload_file(out_path, bucket, out_key, ExtraArgs={'ContentType': 'video/mp4'})
            burn_tasks[task_id] = {'status': 'completed', 'output_s3_key': out_key}

            if notify_email:
                try:
                    presigned = s3_client.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': bucket, 'Key': out_key},
                        ExpiresIn=86400
                    )
                    _send_burn_ready_email(notify_email, presigned, safe_name)
                except Exception as e:
                    logging.warning("Notify email failed: %s", e)
    except Exception as e:
        logging.exception("burn task failed")
        burn_tasks[task_id] = {'status': 'failed', 'error': str(e)}


@app.route('/api/burn_subtitles_server', methods=['POST'])
def burn_subtitles_server():
    """Start burn job (RunPod if configured, local fallback). Returns task_id for polling."""
    try:
        data = request.json or {}
        input_s3_key = data.get('input_s3_key')
        segments = data.get('segments', [])
        user_id = data.get('userId') or data.get('user_id')
        subtitle_style = (data.get('subtitle_style') or 'tiktok').strip() or 'tiktok'
        subtitle_color = (data.get('subtitle_color') or 'yellow').strip() or 'yellow'
        is_portrait = bool(data.get('is_portrait'))
        force_local_burn = bool(data.get('force_local_burn'))
        notify_email = (data.get('notify_email') or '').strip() or None
        job_id = data.get('job_id')
        if not input_s3_key or not segments or not user_id:
            return jsonify({"error": "input_s3_key, segments, and userId required"}), 400
        if not input_s3_key.startswith(f"users/{user_id}/"):
            return jsonify({"error": "Access denied"}), 403

        task_id = str(uuid.uuid4())
        burn_tasks[task_id] = {'status': 'processing'}

        allow_runpod_in_simulation = str(os.environ.get('RUNPOD_ALLOW_IN_SIMULATION', 'true')).strip().lower() in ('1', 'true', 'yes', 'on')
        simulation_blocks_runpod = SIMULATION_MODE and not allow_runpod_in_simulation
        use_runpod = bool((RUNPOD_API_KEY or '').strip() and (RUNPOD_MOVIE_ENDPOINT_ID or '').strip()) and not simulation_blocks_runpod and not force_local_burn
        if use_runpod:
            public_base = _public_base_url(request)
            callback_url = f"{public_base}/api/burn_subtitles_callback"
            try:
                _queue_burn_task_on_runpod(
                    task_id=task_id,
                    input_s3_key=input_s3_key,
                    segments=segments,
                    user_id=user_id,
                    callback_url=callback_url,
                    subtitle_style=subtitle_style,
                    is_portrait=is_portrait,
                    notify_email=notify_email,
                    job_id=job_id,
                    subtitle_color=subtitle_color
                )
                return jsonify({"task_id": task_id, "status": "processing", "mode": "runpod"}), 202
            except Exception as e:
                logging.warning("RunPod burn dispatch failed; falling back to local ffmpeg: %s", e)
                allow_local_fallback = str(os.environ.get('RUNPOD_BURN_ALLOW_LOCAL_FALLBACK', 'true')).strip().lower() in ('1', 'true', 'yes', 'on')
                if not allow_local_fallback:
                    burn_tasks[task_id] = {'status': 'failed', 'mode': 'runpod', 'error': f'RunPod dispatch failed: {e}'}
                    return jsonify({"task_id": task_id, "status": "failed", "mode": "runpod", "error": "RunPod dispatch failed"}), 503

        # Local fallback (existing behavior)
        t = threading.Thread(
            target=_run_burn_task,
            args=(task_id, input_s3_key, segments, user_id),
            kwargs={'subtitle_style': subtitle_style, 'is_portrait': is_portrait, 'notify_email': notify_email, 'job_id': job_id, 'subtitle_color': subtitle_color}
        )
        t.daemon = True
        t.start()
        burn_tasks[task_id]['mode'] = 'local'
        return jsonify({"task_id": task_id, "status": "processing", "mode": "local"}), 202
    except Exception as e:
        logging.exception("burn_subtitles_server")
        return jsonify({"error": str(e)}), 500


@app.route('/api/burn_subtitles_callback', methods=['POST'])
def burn_subtitles_callback():
    """RunPod worker callback for movie burn completion/failure."""
    try:
        data = request.json or {}
        candidates = [
            data,
            data.get('input') if isinstance(data.get('input'), dict) else {},
            data.get('output') if isinstance(data.get('output'), dict) else {},
            data.get('result') if isinstance(data.get('result'), dict) else {},
        ]

        def _pick(keys):
            for c in candidates:
                for k in keys:
                    v = c.get(k) if isinstance(c, dict) else None
                    if v not in (None, ''):
                        return v
            return None

        task_id = _pick(['task_id', 'taskId', 'id'])
        if not task_id:
            return jsonify({"error": "task_id required"}), 400

        status_raw = str(_pick(['status']) or 'processing').strip().lower()
        output_s3_key = _pick(['output_s3_key', 'outputS3Key'])
        error_text = _pick(['error', 'message']) or ''

        info = burn_tasks.get(task_id) or {}
        if status_raw in ('completed', 'done', 'success', 'succeeded'):
            info['status'] = 'completed'
            if output_s3_key:
                info['output_s3_key'] = output_s3_key
            burn_tasks[task_id] = info
        elif status_raw in ('failed', 'error'):
            info['status'] = 'failed'
            info['error'] = str(error_text or 'RunPod burn failed')
            burn_tasks[task_id] = info
        else:
            info['status'] = 'processing'
            burn_tasks[task_id] = info

        return jsonify({"ok": True, "task_id": task_id, "status": burn_tasks[task_id].get('status')}), 200
    except Exception as e:
        logging.exception("burn_subtitles_callback")
        return jsonify({"error": str(e)}), 500


@app.route('/api/burn_subtitles_status', methods=['GET'])
def burn_subtitles_status():
    """Poll burn task status. When completed, returns output_url (presigned)."""
    try:
        task_id = request.args.get('task_id')
        if not task_id:
            return jsonify({"error": "task_id required"}), 400
        info = burn_tasks.get(task_id)
        if not info:
            return jsonify({"status": "not_found"}), 404
        status = info.get('status', 'processing')
        out = {"task_id": task_id, "status": status}
        if status == 'failed':
            out["error"] = info.get('error', 'Unknown error')
        if status == 'completed':
            output_s3_key = info.get('output_s3_key')
            if output_s3_key:
                out["output_s3_key"] = output_s3_key
                s3_client = boto3.client(
                    's3',
                    aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
                    aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
                    region_name=os.environ.get('AWS_REGION')
                )
                url = s3_client.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': os.environ.get('S3_BUCKET'), 'Key': output_s3_key},
                    ExpiresIn=3600
                )
                out["output_url"] = url
                out["download_name"] = "video_with_subtitles.mp4"
        return jsonify(out), 200
    except Exception as e:
        logging.exception("burn_subtitles_status")
        return jsonify({"error": str(e)}), 500


# --- BURN SUBTITLES (LEGACY: in-request, for small files) ---
# Supported video extensions for burn (ffmpeg can read/write these)
BURN_VIDEO_EXTENSIONS = ('.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi')
BURN_VIDEO_MIMES = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
}

@app.route('/api/burn_subtitles', methods=['POST'])
def burn_subtitles():
    """Accept video file + segments JSON; burn subtitles with ffmpeg; return the video file.
    Supports all common video formats (mp4, mov, webm, m4v, mkv, avi)."""
    try:
        video_file = request.files.get('video')
        segments_json = request.form.get('segments')
        if not video_file or not segments_json:
            return jsonify({"error": "Missing video or segments"}), 400
        segments = json.loads(segments_json)
        if not segments:
            return jsonify({"error": "No segments"}), 400

        # Detect extension from form filename or fallback to uploaded filename
        filename = (request.form.get('filename') or video_file.filename or '').strip()
        ext = None
        if filename:
            for e in BURN_VIDEO_EXTENSIONS:
                if filename.lower().endswith(e):
                    ext = e
                    break
        if not ext:
            ext = '.mp4'
        out_ext = ext if ext in BURN_VIDEO_EXTENSIONS else '.mp4'

        ffmpeg_path = _resolve_ffmpeg()
        try:
            subprocess.run([ffmpeg_path, '-version'], capture_output=True, timeout=5)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            return jsonify({
                "error": "ffmpeg not found or not runnable. Install ffmpeg and add it to PATH, or set FFMPEG_PATH.",
                "detail": str(e)
            }), 500

        subtitle_style = (request.form.get('subtitle_style') or 'tiktok').strip() or 'tiktok'
        if subtitle_style not in ('tiktok', 'clean', 'cinematic'):
            subtitle_style = 'tiktok'
        subtitle_color = (request.form.get('subtitle_color') or 'yellow').strip() or 'yellow'
        is_portrait_burn = str(request.form.get('is_portrait') or '').strip().lower() in ('1', 'true', 'yes', 'on')

        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, 'input' + ext)
            video_file.save(video_path)

            # ASS burn respects subtitle color/style (VTT via ffmpeg defaulted to white).
            ass_content = _build_ass(segments, subtitle_style, portrait=is_portrait_burn, subtitle_color=subtitle_color)
            subs_path = os.path.join(tmpdir, 'subtitles.ass')
            with open(subs_path, 'w', encoding='utf-8') as f:
                f.write(ass_content)

            out_path = os.path.join(tmpdir, 'output' + out_ext)
            subs_escaped = subs_path.replace('\\', '/').replace(':', '\\:').replace("'", "\\'")
            vf = f"ass='{subs_escaped}'"
            cmd = [
                ffmpeg_path, '-y', '-i', video_path,
                '-vf', vf,
                '-c:a', 'copy',
                out_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                return jsonify({"error": "ffmpeg failed", "stderr": result.stderr}), 500
            if not os.path.exists(out_path):
                return jsonify({"error": "ffmpeg did not produce output"}), 500

            from flask import send_file
            from io import BytesIO
            mimetype = BURN_VIDEO_MIMES.get(out_ext, 'video/mp4')
            download_name = 'video_with_subtitles' + out_ext
            with open(out_path, 'rb') as f:
                out_data = BytesIO(f.read())
            out_data.seek(0)
            return send_file(out_data, as_attachment=True, download_name=download_name, mimetype=mimetype)
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Processing timed out"}), 500
    except Exception as e:
        logging.exception("burn_subtitles failed")
        return jsonify({"error": str(e)}), 500


# --- CONTROL ROUTES FOR SIMULATION / PROCESS START ---
@app.route('/api/set_simulation', methods=['POST'])
def set_simulation():
    """Acknowledge simulation request from frontend (e.g. when user presses Play).
    Simulation mode is read-only from env (SIMULATION_MODE); the client cannot
    enable it, so production always uses RunPod regardless of this call."""
    try:
        # Never allow client to enable simulation; only env at startup decides
        return jsonify({"simulation_mode": SIMULATION_MODE}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/start_process', methods=['POST'])
def start_process():
    """Start a detached background process that runs siteapp.py (returns PID).

    Caution: starting another instance of this app may fail if the port is already in use.
    This endpoint is intended for local development/testing only.
    """
    try:
        global spawned_process_pid
        # If we already started one, check if it's alive
        if 'spawned_process_pid' in globals():
            try:
                os.kill(spawned_process_pid, 0)
                return jsonify({"status": "already_running", "pid": spawned_process_pid}), 200
            except Exception:
                pass

        python_exec = sys.executable or 'python'
        cmd = [python_exec, 'siteapp.py']

        if os.name == 'nt':
            # DETACHED/NO WINDOW on Windows
            CREATE_NO_WINDOW = 0x08000000
            p = subprocess.Popen(cmd, cwd=os.getcwd(), creationflags=CREATE_NO_WINDOW)
        else:
            # Detach on POSIX
            p = subprocess.Popen(cmd, cwd=os.getcwd(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setpgrp)

        spawned_process_pid = p.pid
        print(f"Started background process: PID={spawned_process_pid}")
        return jsonify({"status": "started", "pid": spawned_process_pid}), 200

    except Exception as e:
        print(f"Failed to start process: {e}")
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