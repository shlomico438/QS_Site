#!/usr/bin/env python3
"""Upload a media file through the regular QuickScribe pipeline and save .vtt.

Goes through ASR, GPT post-processing, and screen-width subtitle adaptation.

Examples:

  python scripts/profile_transcribe_vtt.py sample.mp3 -o sample.vtt

  python scripts/profile_transcribe_vtt.py sample.mp4 \\
      --base https://www.getquickscribe.com \\
      --secret %QS_PROFILE_API_SECRET% \\
      --width 1080 --height 1920 --style tiktok \\
      -o sample.vtt

  curl -sS -X POST http://127.0.0.1:8000/api/profile/vtt \\
      -H "X-QS-Profile-Secret: $QS_PROFILE_API_SECRET" \\
      -F "file=@sample.mp3" -F "width=1920" -F "height=1080" \\
    | python -c "import sys,json; print(json.load(sys.stdin)['job_id'])"

  curl -sS "http://127.0.0.1:8000/api/profile/vtt/JOB_ID?download=1" \\
      -H "X-QS-Profile-Secret: $QS_PROFILE_API_SECRET" \\
      -o sample.vtt
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


def _headers(secret: str, content_type: str | None = None) -> dict:
    headers = {}
    if secret:
        headers['X-QS-Profile-Secret'] = secret
    if content_type:
        headers['Content-Type'] = content_type
    return headers


def _request(url, method='GET', data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, dict(resp.headers.items()), body
    except urllib.error.HTTPError as e:
        body = e.read() if e.fp else b''
        return e.code, dict(e.headers.items() if e.headers else []), body


def _multipart(field_name, filename, file_bytes, extra_fields):
    boundary = '----qsProfileVtt' + str(int(time.time() * 1000))
    chunks = []
    for key, value in extra_fields:
        if value is None or value == '':
            continue
        chunks.append(f'--{boundary}\r\n'.encode('utf-8'))
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode('utf-8'))
        chunks.append(str(value).encode('utf-8'))
        chunks.append(b'\r\n')
    chunks.append(f'--{boundary}\r\n'.encode('utf-8'))
    chunks.append(
        f'Content-Disposition: form-data; name="{field_name}"; filename="{os.path.basename(filename)}"\r\n'.encode('utf-8')
    )
    chunks.append(b'Content-Type: application/octet-stream\r\n\r\n')
    chunks.append(file_bytes)
    chunks.append(b'\r\n')
    chunks.append(f'--{boundary}--\r\n'.encode('utf-8'))
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


def _parse_json(body: bytes):
    try:
        return json.loads(body.decode('utf-8') or '{}')
    except json.JSONDecodeError:
        return {"raw": body.decode('utf-8', errors='replace')[:500]}


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe a file through QuickScribe and write .vtt")
    parser.add_argument('file', help='Audio or video file to upload')
    parser.add_argument('-o', '--out', default='', help='Output .vtt path (default: <input>.vtt)')
    parser.add_argument('--base', default='', help='Site origin, e.g. http://127.0.0.1:8000')
    parser.add_argument('--secret', default='', help='QS_PROFILE_API_SECRET (or env QS_PROFILE_API_SECRET)')
    parser.add_argument('--width', type=int, default=1920, help='Target screen width in px')
    parser.add_argument('--height', type=int, default=1080, help='Target screen height in px')
    parser.add_argument('--style', default='tiktok', choices=('tiktok', 'clean', 'cinematic'))
    parser.add_argument('--locale', default='he')
    parser.add_argument('--language', default='', help='Optional ASR language hint, e.g. he')
    parser.add_argument('--diarization', action='store_true')
    parser.add_argument('--poll-sec', type=float, default=3.0)
    parser.add_argument('--timeout-sec', type=float, default=5400.0)
    args = parser.parse_args()

    src = os.path.abspath(args.file)
    if not os.path.isfile(src):
        print(f'file not found: {src}', file=sys.stderr)
        return 2

    base = (
        args.base
        or os.environ.get('QS_PROFILE_BASE_URL')
        or os.environ.get('PUBLIC_BASE_URL')
        or 'http://127.0.0.1:8000'
    ).rstrip('/')
    secret = args.secret or os.environ.get('QS_PROFILE_API_SECRET') or ''
    out_path = args.out or (os.path.splitext(src)[0] + '.vtt')

    with open(src, 'rb') as f:
        file_bytes = f.read()
    extra = [
        ('width', args.width),
        ('height', args.height),
        ('style', args.style),
        ('locale', args.locale),
        ('language', args.language),
        ('diarization', '1' if args.diarization else ''),
    ]
    body, content_type = _multipart('file', src, file_bytes, extra)
    print(f'uploading {os.path.basename(src)} ({len(file_bytes)} bytes) to {base}/api/profile/vtt', flush=True)
    status, _headers_out, resp_body = _request(
        f'{base}/api/profile/vtt',
        method='POST',
        data=body,
        headers=_headers(secret, content_type),
        timeout=300,
    )
    data = _parse_json(resp_body)
    if status >= 400 or not data.get('job_id'):
        print(json.dumps(data, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    job_id = data['job_id']
    print(f'job_id={job_id} status={data.get("status")} poll={data.get("poll_url")}', flush=True)

    deadline = time.time() + max(30.0, float(args.timeout_sec))
    poll_url = f'{base}/api/profile/vtt/{job_id}'
    last_stage = ''
    while time.time() < deadline:
        status, resp_headers, resp_body = _request(
            poll_url,
            headers=_headers(secret),
            timeout=60,
        )
        ctype = str(resp_headers.get('Content-Type') or resp_headers.get('content-type') or '')
        if status == 200 and 'text/vtt' in ctype.lower():
            vtt = resp_body.decode('utf-8')
            with open(out_path, 'w', encoding='utf-8', newline='\n') as out:
                out.write(vtt)
            print(f'wrote {out_path} ({len(vtt)} chars)', flush=True)
            return 0
        payload = _parse_json(resp_body)
        if payload.get('status') == 'failed' or (status >= 400 and status != 202):
            print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
            return 1
        if status == 200 and payload.get('vtt'):
            with open(out_path, 'w', encoding='utf-8', newline='\n') as out:
                out.write(str(payload['vtt']))
            cues = payload.get('cue_count')
            gpt = payload.get('gpt_applied')
            print(
                f'wrote {out_path} cues={cues} gpt_applied={gpt} layout={payload.get("layout")}',
                flush=True,
            )
            return 0
        stage = payload.get('stage') or payload.get('status') or str(status)
        if stage != last_stage:
            print(f'waiting ({stage})...', flush=True)
            last_stage = stage
        time.sleep(max(0.5, float(args.poll_sec)))

    print(f'timed out waiting for job {job_id}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
