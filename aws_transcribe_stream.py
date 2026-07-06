"""Real-time medical transcription via AWS Transcribe Streaming.

Primary transport: Socket.IO events (medical_transcribe_*), same origin as job updates.
Fallback: raw WebSocket /ws/transcribe (local dev; may not work behind some CDNs).

Socket.IO protocol:
  - Client emits medical_transcribe_start {language_code, sample_rate_hz}
  - Server emits medical_transcribe_event {type: connected|starting|ready|partial|error|transcript}
  - Client emits medical_transcribe_audio (binary PCM int16 mono)
  - Client emits medical_transcribe_stop

WebSocket protocol (/ws/transcribe):
  1. Optional JSON text frame to start: {"action":"start","sample_rate_hz":16000}
  2. Binary frames: PCM int16 mono audio (default 16 kHz)
  3. JSON {"action":"stop"} or WebSocket close → server sends final JSON:
     {"type":"transcript","transcript":"...","partials":[...],"error":null}

Requires: pip install amazon-transcribe
IAM: transcribe:StartStreamTranscription
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, List, Optional

from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent
from flask import Flask, jsonify, request

try:
    from geventwebsocket.exceptions import WebSocketError
except ImportError:  # pragma: no cover
    WebSocketError = Exception  # type: ignore

logger = logging.getLogger(__name__)

DEFAULT_LANGUAGE = 'he-IL'
DEFAULT_SAMPLE_RATE = 16000
_TRANSCRIBE_STREAM_REGION_FALLBACK = 'eu-north-1'
# AWS regions (not R2 "auto", not full endpoint URLs).
_AWS_REGION_RE = re.compile(
    r'^[a-z]{2}(-gov)?-(east|west|north|south|central|northeast|southeast|southwest|northwest)-\d+$'
)


def transcribe_stream_region() -> str:
    """AWS region for Transcribe Streaming (never use R2's AWS_REGION=auto)."""
    invalid_sources = []
    for key in (
        'MEDICAL_TRANSCRIBE_STREAM_REGION',
        'AWS_TRANSCRIBE_REGION',
        'AWS_REGION',
        'AWS_DEFAULT_REGION',
    ):
        raw = (os.environ.get(key) or '').strip()
        if not raw:
            continue
        if _AWS_REGION_RE.match(raw):
            return raw
        invalid_sources.append(f'{key}={raw!r}')
    if invalid_sources:
        logger.warning(
            'Invalid transcribe region env (%s); using %s. '
            'Set MEDICAL_TRANSCRIBE_STREAM_REGION=eu-north-1 (or your SageMaker region).',
            ', '.join(invalid_sources),
            _TRANSCRIBE_STREAM_REGION_FALLBACK,
        )
    return _TRANSCRIBE_STREAM_REGION_FALLBACK


def normalize_transcribe_region(region: Optional[str]) -> str:
    raw = str(region or '').strip()
    if raw and _AWS_REGION_RE.match(raw):
        return raw
    return transcribe_stream_region()


DEFAULT_REGION = transcribe_stream_region()

# gevent greenlets must not call threading.Thread.start() or queue.get() directly.
_TRANSCRIBE_THREAD_LAUNCHER = ThreadPoolExecutor(max_workers=8, thread_name_prefix='aws-transcribe')


class _CollectingTranscriptHandler(TranscriptResultStreamHandler):
    """Accumulate AWS transcript events into a final string."""

    def __init__(
        self,
        transcript_result_stream,
        *,
        on_partial: Optional[Callable[[str], None]] = None,
    ):
        super().__init__(transcript_result_stream)
        self._final_parts: List[str] = []
        self._partial_history: List[str] = []
        self._current_partial = ''
        self._on_partial = on_partial

    async def handle_transcript_event(self, transcript_event: TranscriptEvent):
        results = transcript_event.transcript.results
        for result in results:
            text = ''
            alts = result.alternatives or []
            for alt in alts:
                t = str(getattr(alt, 'transcript', '') or '').strip()
                if t:
                    text = t
                    break
            if not text:
                continue
            if result.is_partial:
                self._current_partial = text
                self._partial_history.append(text)
                if self._on_partial:
                    try:
                        self._on_partial(text)
                    except Exception:
                        logger.debug('partial callback failed', exc_info=True)
            else:
                self._final_parts.append(text)
                self._current_partial = ''
                self._partial_history.append(text)

    @property
    def full_transcript(self) -> str:
        parts = list(self._final_parts)
        if self._current_partial:
            parts.append(self._current_partial)
        return ' '.join(p.strip() for p in parts if p.strip()).strip()

    @property
    def partial_history(self) -> List[str]:
        return list(self._partial_history)


class AwsTranscribeStreamSession:
    """Bridge client PCM chunks → AWS Transcribe Streaming (async SDK in a worker thread)."""

    def __init__(
        self,
        *,
        region: Optional[str] = None,
        language_code: str = DEFAULT_LANGUAGE,
        sample_rate_hz: int = DEFAULT_SAMPLE_RATE,
        on_partial: Optional[Callable[[str], None]] = None,
    ):
        self.region = normalize_transcribe_region(region)
        self.language_code = language_code
        self.sample_rate_hz = int(sample_rate_hz or DEFAULT_SAMPLE_RATE)
        self.on_partial = on_partial
        self._audio_q: Optional[asyncio.Queue] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._handler: Optional[_CollectingTranscriptHandler] = None
        self._transcript = ''
        self._error: Optional[BaseException] = None
        self._ready_q: queue.Queue = queue.Queue(maxsize=1)
        self._finished_q: queue.Queue = queue.Queue(maxsize=1)
        self._closed = False

    def _start_blocking(self, timeout_sec: float = 30.0) -> None:
        """Run only from an OS thread (ThreadPoolExecutor worker)."""
        if self._thread:
            return
        worker = threading.Thread(target=self._thread_main, name='aws-transcribe-stream', daemon=True)
        worker.start()
        self._thread = worker
        t_wait = time.time()
        try:
            self._ready_q.get(timeout=timeout_sec)
        except queue.Empty:
            raise TimeoutError(f'AWS Transcribe stream did not start in time ({round(time.time() - t_wait, 3)}s)')
        if self._error:
            raise self._error
        logger.info('AWS Transcribe stream ready in %.3fs', time.time() - t_wait)

    def start(self, timeout_sec: float = 30.0) -> None:
        """Blocking start safe from HTTP handlers / health checks (not gevent WS greenlets)."""
        fut = _TRANSCRIBE_THREAD_LAUNCHER.submit(self._start_blocking, timeout_sec)
        fut.result(timeout=timeout_sec + 10)

    def _enqueue_audio(self, chunk: Optional[bytes]) -> None:
        """Schedule audio on the asyncio loop without blocking the caller (gevent-safe)."""
        if not self._loop or not self._audio_q:
            raise RuntimeError('Transcribe stream not started')

        def _put() -> None:
            try:
                self._audio_q.put_nowait(chunk)
            except asyncio.QueueFull:
                if chunk is None:
                    logger.warning('AWS Transcribe queue full at stop; end marker delayed')
                else:
                    logger.warning(
                        'AWS Transcribe audio queue full; dropping chunk (%d bytes)',
                        len(chunk) if chunk else 0,
                    )

        self._loop.call_soon_threadsafe(_put)

    def feed_audio(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return
        self._enqueue_audio(bytes(chunk))

    def stop(self, timeout_sec: float = 120.0) -> str:
        if self._closed:
            return self._transcript
        self._closed = True
        if self._loop and self._audio_q:
            try:
                self._enqueue_audio(None)
            except Exception as e:
                logger.warning('Failed to signal end-of-stream to AWS: %s', e)
        try:
            self._finished_q.get(timeout=timeout_sec)
        except queue.Empty:
            pass
        if self._error:
            raise self._error
        return self._transcript

    @property
    def partial_history(self) -> List[str]:
        if self._handler:
            return self._handler.partial_history
        return []

    def _thread_main(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._transcript = self._loop.run_until_complete(self._async_run())
        except BaseException as e:
            self._error = e
            logger.exception('AWS Transcribe streaming session failed')
        finally:
            try:
                self._ready_q.put_nowait(True)
            except queue.Full:
                pass
            try:
                self._finished_q.put_nowait(True)
            except queue.Full:
                pass
            try:
                self._loop.close()
            except Exception:
                pass

    async def _async_run(self) -> str:
        self._audio_q = asyncio.Queue()
        logger.info('AWS Transcribe stream connecting region=%s lang=%s', self.region, self.language_code)
        client = TranscribeStreamingClient(region=self.region)
        stream = await client.start_stream_transcription(
            language_code=self.language_code,
            media_sample_rate_hz=self.sample_rate_hz,
            media_encoding='pcm',
        )
        logger.info('AWS Transcribe stream accepted by AWS')
        try:
            self._ready_q.put_nowait(True)
        except queue.Full:
            pass
        self._handler = _CollectingTranscriptHandler(
            stream.output_stream,
            on_partial=self.on_partial,
        )

        async def _feed_aws() -> None:
            while True:
                chunk = await self._audio_q.get()
                if chunk is None:
                    await stream.input_stream.end_stream()
                    return
                await stream.input_stream.send_audio_event(audio_chunk=chunk)

        await asyncio.gather(_feed_aws(), self._handler.handle_events())
        return self._handler.full_transcript


def _ws_send_json(ws, payload: dict) -> None:
    ws.send(json.dumps(payload, ensure_ascii=False))


def _ws_send_json_from_hub(ws, payload: dict) -> None:
    """Send on the gevent hub thread (safe after ThreadPoolExecutor callbacks)."""
    try:
        import gevent
        hub = gevent.get_hub()
        if hub is not None and getattr(hub, 'loop', None) is not None:
            hub.loop.run_callback(_ws_send_json, ws, payload)
            return
    except Exception:
        pass
    _ws_send_json(ws, payload)


def _parse_start_config(raw: str) -> dict:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    action = str(data.get('action') or '').strip().lower()
    if action and action not in ('start', 'config'):
        return {}
    return data


def _run_on_hub(callback) -> None:
    try:
        import gevent
        hub = gevent.get_hub()
        if hub is not None and getattr(hub, 'loop', None) is not None:
            hub.loop.run_callback(callback)
            return
    except Exception:
        pass
    callback()


class TranscribeStreamBridge:
    """Shared orchestration for one live transcribe client (WS or Socket.IO)."""

    def __init__(self, send_json: Callable[[dict], None]):
        self._send = send_json
        self._alive = True
        self.region = transcribe_stream_region()
        self.language_code = DEFAULT_LANGUAGE
        self.sample_rate_hz = DEFAULT_SAMPLE_RATE
        self.session: Optional[AwsTranscribeStreamSession] = None
        self.audio_pending: List[bytes] = []
        self.session_live = False
        self.start_lock = threading.Lock()
        self.start_scheduled = False

    def close(self) -> None:
        self._alive = False

    def _emit(self, payload: dict) -> None:
        if not self._alive:
            return
        self._send(payload)

    def send_connected(self) -> None:
        self._emit({'type': 'connected', 'engine': 'aws_transcribe_stream'})

    def _on_partial(self, text: str) -> None:
        try:
            self._emit({'type': 'partial', 'text': text})
        except Exception:
            logger.debug('Failed to send partial transcript to client', exc_info=True)

    def _flush_pending_audio(self) -> None:
        if not self.session or not self.session_live:
            return
        for chunk in self.audio_pending:
            try:
                self.session.feed_audio(chunk)
            except Exception as e:
                logger.warning('Failed to feed buffered audio to AWS: %s', e)
                break
        self.audio_pending.clear()

    def _begin_session_in_os_thread(self) -> None:
        if not self.session:
            return
        try:
            self.session._start_blocking(30.0)
            self.session_live = True
            self._emit({
                'type': 'ready',
                'language_code': self.session.language_code,
                'sample_rate_hz': self.session.sample_rate_hz,
                'region': self.session.region,
            })
            logger.info('transcribe aws ready region=%s (from os thread)', self.session.region)
            self._flush_pending_audio()
        except BaseException as e:
            logger.exception('AWS Transcribe stream start failed')
            self._emit({
                'type': 'error',
                'error': str(e)[:500],
                'region': getattr(self.session, 'region', self.region),
            })

    def _schedule_session_start(self) -> None:
        with self.start_lock:
            if self.start_scheduled:
                return
            self.start_scheduled = True
        _TRANSCRIBE_THREAD_LAUNCHER.submit(self._begin_session_in_os_thread)

    def _make_session(self) -> AwsTranscribeStreamSession:
        return AwsTranscribeStreamSession(
            region=self.region,
            language_code=self.language_code,
            sample_rate_hz=self.sample_rate_hz,
            on_partial=self._on_partial,
        )

    def handle_start_config(self, cfg: dict) -> None:
        if not isinstance(cfg, dict):
            return
        action = str(cfg.get('action') or 'start').strip().lower()
        if action not in ('start', 'config'):
            return
        self.language_code = str(cfg.get('language_code') or self.language_code).strip() or self.language_code
        self.sample_rate_hz = int(cfg.get('sample_rate_hz') or self.sample_rate_hz)
        self.region = normalize_transcribe_region(cfg.get('region') or self.region)
        if self.session is None:
            logger.info(
                'transcribe start action lang=%s rate=%s region=%s',
                self.language_code,
                self.sample_rate_hz,
                self.region,
            )
            self._emit({
                'type': 'starting',
                'language_code': self.language_code,
                'sample_rate_hz': self.sample_rate_hz,
                'region': self.region,
            })
            self.session = self._make_session()
            self._schedule_session_start()

    def handle_audio(self, chunk: bytes) -> None:
        if not chunk:
            return
        if self.session is None:
            self.session = self._make_session()
            self._emit({
                'type': 'starting',
                'language_code': self.language_code,
                'sample_rate_hz': self.sample_rate_hz,
                'region': self.region,
            })
            self._schedule_session_start()
        if self.session_live:
            self.session.feed_audio(chunk)
        else:
            self.audio_pending.append(chunk)

    def finish(self) -> dict:
        result_payload = {
            'type': 'transcript',
            'transcript': '',
            'partials': [],
            'language_code': self.language_code,
            'sample_rate_hz': self.sample_rate_hz,
            'error': None,
        }
        if self.session:
            try:
                transcript = self.session.stop()
            except BaseException as e:
                result_payload['error'] = str(e)[:500]
                transcript = self.session._transcript or ''
            result_payload['transcript'] = transcript
            result_payload['partials'] = self.session.partial_history
            result_payload['language_code'] = self.session.language_code
            result_payload['sample_rate_hz'] = self.session.sample_rate_hz
        return result_payload


_SOCKETIO_BRIDGES: dict = {}


def cleanup_transcribe_socketio_bridge(sid: str) -> None:
    bridge = _SOCKETIO_BRIDGES.pop(sid, None)
    if not bridge:
        return
    bridge.close()
    logger.info('transcribe socketio cleanup sid=%s', sid)
    try:
        bridge.finish()
    except Exception:
        logger.debug('transcribe socketio cleanup finish failed', exc_info=True)


def register_transcribe_socketio_handlers(socketio) -> None:
    """Medical live transcribe via Socket.IO (works behind CDN/proxy; raw /ws/transcribe may not)."""
    from flask import request

    def _emit_to_sid(sid: str, payload: dict) -> None:
        def _do() -> None:
            try:
                socketio.emit('medical_transcribe_event', payload, room=sid)
            except Exception as e:
                logger.warning('transcribe socketio emit failed sid=%s: %s', sid, e)

        _run_on_hub(_do)

    @socketio.on('medical_transcribe_start')
    def on_medical_transcribe_start(data):
        sid = request.sid
        logger.info('transcribe socketio start sid=%s', sid)
        cleanup_transcribe_socketio_bridge(sid)
        bridge = TranscribeStreamBridge(lambda payload: _emit_to_sid(sid, payload))
        _SOCKETIO_BRIDGES[sid] = bridge
        bridge.send_connected()
        cfg = data if isinstance(data, dict) else {}
        bridge.handle_start_config({**cfg, 'action': 'start'})

    @socketio.on('medical_transcribe_audio')
    def on_medical_transcribe_audio(data):
        sid = request.sid
        bridge = _SOCKETIO_BRIDGES.get(sid)
        if not bridge:
            return
        if isinstance(data, (bytes, bytearray)):
            chunk = bytes(data)
        elif isinstance(data, list):
            chunk = bytes(data)
        else:
            return
        bridge.handle_audio(chunk)

    @socketio.on('medical_transcribe_stop')
    def on_medical_transcribe_stop():
        sid = request.sid
        bridge = _SOCKETIO_BRIDGES.pop(sid, None)
        if not bridge:
            return
        logger.info('transcribe socketio stop sid=%s', sid)
        result = bridge.finish()
        _emit_to_sid(sid, result)


def run_transcribe_websocket_session(ws) -> dict:
    """Handle one browser/client WebSocket: PCM in → AWS Transcribe → transcript out."""
    logger.info('transcribe ws session opened')
    bridge = TranscribeStreamBridge(lambda payload: _ws_send_json_from_hub(ws, payload))

    try:
        bridge.send_connected()
    except Exception as e:
        logger.warning('transcribe ws connected frame failed: %s', e)

    try:
        while not getattr(ws, 'closed', False):
            message = ws.receive()
            if message is None:
                logger.info('transcribe ws receive None (peer closed)')
                break

            if isinstance(message, str):
                cfg = _parse_start_config(message)
                action = str(cfg.get('action') or '').strip().lower()
                if action in ('start', 'config'):
                    bridge.handle_start_config(cfg)
                    continue
                if action == 'stop':
                    break
                continue

            if isinstance(message, (bytes, bytearray)):
                bridge.handle_audio(bytes(message))

        result_payload = bridge.finish()
        _ws_send_json(ws, result_payload)
        return result_payload

    except WebSocketError as e:
        logger.info('Transcribe WebSocket closed: %s', e)
        result_payload = bridge.finish()
        try:
            _ws_send_json(ws, result_payload)
        except Exception:
            pass
        return result_payload
    except BaseException as e:
        logger.exception('Transcribe WebSocket session error')
        result_payload = bridge.finish()
        result_payload['error'] = str(e)[:500]
        try:
            _ws_send_json(ws, result_payload)
        except Exception:
            pass
        return result_payload


def register_transcribe_websocket_routes(app: Flask) -> None:
    """Register /ws/transcribe (requires GeventWebSocketWorker — see Procfile)."""

    @app.route('/api/transcribe_stream_health', methods=['GET'])
    def api_transcribe_stream_health():
        """Probe AWS Transcribe Streaming from the running server (gunicorn + gevent)."""
        region = transcribe_stream_region()
        language = DEFAULT_LANGUAGE
        try:
            from gevent import monkey as _gevent_monkey
            gevent_patched = bool(_gevent_monkey.is_module_patched('threading'))
        except Exception:
            gevent_patched = 'gevent' in sys.modules
        t0 = time.time()
        session = AwsTranscribeStreamSession(region=region, language_code=language)
        try:
            session.start(timeout_sec=25)
            start_sec = round(time.time() - t0, 3)
            # Brief silence so AWS does not 15s-timeout before we stop.
            session.feed_audio(b'\x00\x00' * (DEFAULT_SAMPLE_RATE * 2 // 5))
            session.stop(timeout_sec=30)
            return jsonify({
                'ok': True,
                'region': region,
                'language_code': language,
                'start_sec': start_sec,
                'gevent_threading_patched': gevent_patched,
                'aws_region_env': (os.environ.get('AWS_REGION') or '').strip() or None,
                'medical_transcribe_stream_region_env': (
                    os.environ.get('MEDICAL_TRANSCRIBE_STREAM_REGION') or ''
                ).strip() or None,
            }), 200
        except BaseException as e:
            logger.exception('transcribe_stream_health failed')
            return jsonify({
                'ok': False,
                'region': region,
                'language_code': language,
                'error': str(e)[:500],
                'start_sec': round(time.time() - t0, 3),
                'gevent_threading_patched': gevent_patched,
                'aws_region_env': (os.environ.get('AWS_REGION') or '').strip() or None,
                'medical_transcribe_stream_region_env': (
                    os.environ.get('MEDICAL_TRANSCRIBE_STREAM_REGION') or ''
                ).strip() or None,
            }), 500

    @app.route('/ws/transcribe')
    def ws_transcribe_route():
        ws = request.environ.get('wsgi.websocket')
        if ws is None:
            logger.warning('transcribe ws upgrade missing (not GeventWebSocketWorker?)')
            return (
                'WebSocket upgrade required. '
                'Send PCM int16 mono audio; JSON {"action":"stop"} to finish.',
                400,
                {'Content-Type': 'text/plain; charset=utf-8'},
            )
        logger.info('transcribe ws upgrade ok')
        run_transcribe_websocket_session(ws)
        logger.info('transcribe ws session closed')
        return ''
