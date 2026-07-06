#!/usr/bin/env python3
"""Test AWS Transcribe Streaming without gunicorn (works on Windows).

Reads raw PCM int16 mono audio and prints the final transcript.

Example:
  ffmpeg -i sample.wav -ar 16000 -ac 1 -f s16le sample.pcm
  python scripts/test_aws_transcribe_stream.py sample.pcm

Requires AWS credentials + transcribe:StartStreamTranscription in AWS_REGION.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

# Project root on sys.path
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, '.env'))
except ImportError:
    pass

from aws_transcribe_stream import AwsTranscribeStreamSession


def _print_caller_identity(region: str) -> None:
    try:
        import boto3
        sts = boto3.client(
            'sts',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
            region_name=region,
        )
        ident = sts.get_caller_identity()
        print('AWS identity:', ident.get('Arn') or ident.get('UserId') or '?')
    except Exception as e:
        print('AWS identity: (could not resolve)', e)


def main() -> int:
    parser = argparse.ArgumentParser(description='Test AWS Transcribe Streaming (PCM input)')
    parser.add_argument('pcm_file', help='Raw PCM file: int16, mono, 16 kHz (s16le)')
    parser.add_argument('--language', default='he-IL', help='AWS language code (default: he-IL)')
    parser.add_argument('--sample-rate', type=int, default=16000, help='Sample rate Hz (default: 16000)')
    parser.add_argument('--chunk-ms', type=int, default=100, help='Simulated realtime chunk size in ms')
    parser.add_argument('--region', default=None, help='AWS Transcribe Streaming region (default: MEDICAL_TRANSCRIBE_STREAM_REGION/AWS_TRANSCRIBE_REGION or eu-west-1)')
    args = parser.parse_args()

    pcm_path = os.path.abspath(args.pcm_file)
    if not os.path.isfile(pcm_path):
        print(f'File not found: {pcm_path}', file=sys.stderr)
        return 1

    region = (
        args.region
        or os.environ.get('MEDICAL_TRANSCRIBE_STREAM_REGION')
        or os.environ.get('AWS_TRANSCRIBE_REGION')
        or 'eu-west-1'
    ).strip()
    data = open(pcm_path, 'rb').read()
    if not data:
        print('PCM file is empty', file=sys.stderr)
        return 1

    bytes_per_sec = args.sample_rate * 2  # int16 mono
    chunk_bytes = max(320, int(bytes_per_sec * args.chunk_ms / 1000))

    partials: list[str] = []

    def on_partial(text: str) -> None:
        t = str(text or '').strip()
        if t:
            partials.append(t)
            print(f'  partial: {t}')

    print(f'Region: {region}')
    print(f'Language: {args.language}')
    print(f'Sample rate: {args.sample_rate} Hz')
    print(f'PCM bytes: {len(data)} (~{len(data) / bytes_per_sec:.1f}s)')
    _print_caller_identity(region)
    print('Starting stream...')

    session = AwsTranscribeStreamSession(
        region=region,
        language_code=args.language,
        sample_rate_hz=args.sample_rate,
        on_partial=on_partial,
    )
    try:
        session.start()
    except Exception as e:
        print(f'\nStartStreamTranscription failed: {e}', file=sys.stderr)
        print(
            '\nIf this is AccessDenied on QuickScribe_Koyeb_Uploader, confirm in IAM (admin console):\n'
            '  1. Policy is on user QuickScribe_Koyeb_Uploader in account 760351563015\n'
            '  2. Action is exactly transcribe:StartStreamTranscription with Resource "*"\n'
            '  3. No permissions boundary capping the user below Transcribe\n'
            '  4. No SCP/org policy denying transcribe in this account\n'
            'Quick test: temporarily attach AWS managed policy AmazonTranscribeFullAccess.',
            file=sys.stderr,
        )
        return 1

    for offset in range(0, len(data), chunk_bytes):
        session.feed_audio(data[offset : offset + chunk_bytes])
        time.sleep(args.chunk_ms / 1000.0)

    try:
        transcript = session.stop()
    except Exception as e:
        print(f'Stream error: {e}', file=sys.stderr)
        return 1

    print('\n--- Final transcript ---')
    print(transcript or '(empty)')
    print(f'Partial events: {len(partials)}')
    return 0 if transcript else 2


if __name__ == '__main__':
    raise SystemExit(main())
