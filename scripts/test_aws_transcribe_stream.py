#!/usr/bin/env python3
"""Test AWS Transcribe Streaming without gunicorn (works on Windows).

Reads raw PCM int16 mono audio, or captures live mic audio using the same basic
browser path: native mic float samples -> averaged downsample to 16 kHz mono
-> optional quiet-speech gain -> PCM16 -> AWS Transcribe Streaming.

Examples:
  ffmpeg -i sample.wav -ar 16000 -ac 1 -f s16le sample.pcm
  python scripts/test_aws_transcribe_stream.py sample.pcm
  python scripts/test_aws_transcribe_stream.py --mic --duration 30 --save-pcm browser_like.pcm

Requires AWS credentials + transcribe:StartStreamTranscription.
Mic mode additionally requires: pip install sounddevice numpy
"""
from __future__ import annotations

import argparse
import os
import queue
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

TARGET_SAMPLE_RATE = 16000


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


def _downsample_float32_average(samples, from_rate: int, to_rate: int = TARGET_SAMPLE_RATE):
    import numpy as np

    mono = np.asarray(samples, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono[:, 0]
    if len(mono) == 0:
        return np.zeros(0, dtype=np.float32)
    if from_rate == to_rate:
        return mono.astype(np.float32, copy=False)
    ratio = float(from_rate) / float(to_rate)
    out_len = int(round(len(mono) / ratio))
    out = np.zeros(out_len, dtype=np.float32)
    for i in range(out_len):
        start = int(i * ratio)
        end = min(len(mono), int((i + 1) * ratio))
        if end > start:
            out[i] = float(np.mean(mono[start:end]))
        elif start < len(mono):
            out[i] = mono[start]
    return out


def _level_float32(samples) -> tuple[float, float]:
    import numpy as np

    arr = np.asarray(samples, dtype=np.float32)
    if arr.size == 0:
        return 0.0, 0.0
    return float(np.sqrt(np.mean(np.square(arr)))), float(np.max(np.abs(arr)))


def _apply_speech_gain(samples, rms: float, peak: float, *, enabled: bool, max_gain: float):
    import numpy as np

    arr = np.asarray(samples, dtype=np.float32)
    if not enabled or arr.size == 0 or rms <= 0.002:
        return arr, 1.0
    target_rms = 0.055
    max_peak = max(0.001, float(peak or 0.001))
    gain = max(1.0, min(float(max_gain), target_rms / rms, 0.92 / max_peak))
    if gain <= 1.05:
        return arr, 1.0
    return np.clip(arr * gain, -1.0, 1.0).astype(np.float32), gain


def _float32_to_pcm16(samples) -> bytes:
    import numpy as np

    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = np.where(clipped < 0, clipped * 32768.0, clipped * 32767.0).astype('<i2')
    return pcm.tobytes()


def _record_mic_pcm(args) -> bytes:
    try:
        import sounddevice as sd
    except ImportError as e:
        raise RuntimeError('Mic mode requires: pip install sounddevice numpy') from e

    if args.list_devices:
        print(sd.query_devices())
        return b''

    native_rate = int(args.native_rate or sd.query_devices(args.device, 'input')['default_samplerate'])
    blocksize = max(256, int(native_rate * args.chunk_ms / 1000))
    duration = max(1.0, float(args.duration or 30.0))
    audio_q: queue.Queue = queue.Queue()
    pcm_parts: list[bytes] = []
    gain_enabled = not args.no_gain

    def callback(indata, frames, _time_info, status):
        if status:
            print(f'mic status: {status}', file=sys.stderr)
        audio_q.put(indata.copy())

    print(f'Mic device: {args.device if args.device is not None else "default"}')
    print(f'Native mic rate: {native_rate} Hz')
    print(f'Target AWS rate: {args.sample_rate} Hz')
    print(f'Chunk: {args.chunk_ms} ms (~{blocksize} native frames)')
    print(f'Gain: {"on" if gain_enabled else "off"} (max {args.max_gain:g}x)')
    print(f'Recording {duration:.1f}s... speak now.')

    start = time.time()
    chunks = 0
    with sd.InputStream(
        samplerate=native_rate,
        channels=1,
        dtype='float32',
        blocksize=blocksize,
        device=args.device,
        callback=callback,
    ):
        while time.time() - start < duration:
            try:
                native = audio_q.get(timeout=0.5)
            except queue.Empty:
                continue
            down = _downsample_float32_average(native, native_rate, args.sample_rate)
            rms, peak = _level_float32(down)
            boosted, gain = _apply_speech_gain(
                down,
                rms,
                peak,
                enabled=gain_enabled,
                max_gain=args.max_gain,
            )
            pcm = _float32_to_pcm16(boosted)
            pcm_parts.append(pcm)
            chunks += 1
            if chunks == 1 or chunks % 50 == 0:
                print(
                    f'  mic chunk {chunks}: rms={rms:.4f} peak={peak:.4f} '
                    f'gain={gain:.2f} pcm_bytes={len(pcm)}'
                )

    data = b''.join(pcm_parts)
    if args.save_pcm and data:
        with open(args.save_pcm, 'wb') as f:
            f.write(data)
        print(f'Saved browser-like PCM: {args.save_pcm} ({len(data)} bytes)')
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description='Test AWS Transcribe Streaming (PCM file or live mic input)')
    parser.add_argument('pcm_file', nargs='?', help='Raw PCM file: int16, mono, 16 kHz (s16le)')
    parser.add_argument('--mic', action='store_true', help='Capture microphone audio using browser-like processing')
    parser.add_argument('--duration', type=float, default=30.0, help='Mic mode recording seconds (default: 30)')
    parser.add_argument('--device', default=None, help='Mic device id/name for sounddevice (default: system default)')
    parser.add_argument('--list-devices', action='store_true', help='List audio devices and exit')
    parser.add_argument('--native-rate', type=int, default=None, help='Mic capture sample rate (default: device default)')
    parser.add_argument('--save-pcm', default=None, help='Mic mode: save generated 16 kHz PCM to this file')
    parser.add_argument('--no-gain', action='store_true', help='Mic mode: disable browser-like software gain')
    parser.add_argument('--max-gain', type=float, default=6.0, help='Mic mode: max software gain (default: 6)')
    parser.add_argument('--language', default='he-IL', help='AWS language code (default: he-IL)')
    parser.add_argument('--sample-rate', type=int, default=TARGET_SAMPLE_RATE, help='AWS sample rate Hz (default: 16000)')
    parser.add_argument('--chunk-ms', type=int, default=100, help='Simulated realtime chunk size in ms')
    parser.add_argument('--region', default=None, help='AWS Transcribe Streaming region (default: MEDICAL_TRANSCRIBE_STREAM_REGION/AWS_TRANSCRIBE_REGION or eu-west-1)')
    args = parser.parse_args()

    region = (
        args.region
        or os.environ.get('MEDICAL_TRANSCRIBE_STREAM_REGION')
        or os.environ.get('AWS_TRANSCRIBE_REGION')
        or 'eu-west-1'
    ).strip()

    if args.list_devices:
        args.mic = True

    if args.mic:
        try:
            data = _record_mic_pcm(args)
        except Exception as e:
            print(f'Mic capture failed: {e}', file=sys.stderr)
            return 1
        if args.list_devices:
            return 0
    else:
        if not args.pcm_file:
            print('Provide a PCM file or use --mic', file=sys.stderr)
            return 1
        pcm_path = os.path.abspath(args.pcm_file)
        if not os.path.isfile(pcm_path):
            print(f'File not found: {pcm_path}', file=sys.stderr)
            return 1
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
