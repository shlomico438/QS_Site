"""Real-time medical transcription via AWS Transcribe Streaming.

Client WebSocket protocol (/ws/transcribe):
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
DEFAULT_REGION = (os.environ.get('AWS_REGION') or 'eu-north-1').strip()

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
        region: str = DEFAULT_REGION,
        language_code: str = DEFAULT_LANGUAGE,
        sample_rate_hz: int = DEFAULT_SAMPLE_RATE,
        on_partial: Optional[Callable[[str], None]] = None,
    ):
        self.region = region
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

    def feed_audio(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return
        if not self._loop or not self._audio_q:
            raise RuntimeError('Transcribe stream not started')
        fut = asyncio.run_coroutine_threadsafe(self._audio_q.put(bytes(chunk)), self._loop)
        fut.result(timeout=10)

    def stop(self, timeout_sec: float = 120.0) -> str:
        if self._closed:
            return self._transcript
        self._closed = True
        if self._loop and self._audio_q:
            try:
                fut = asyncio.run_coroutine_threadsafe(self._audio_q.put(None), self._loop)
                fut.result(timeout=15)
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


def run_transcribe_websocket_session(ws) -> dict:
    """Handle one browser/client WebSocket: PCM in → AWS Transcribe → transcript out."""
    region = DEFAULT_REGION
    language_code = DEFAULT_LANGUAGE
    sample_rate_hz = DEFAULT_SAMPLE_RATE
    session: Optional[AwsTranscribeStreamSession] = None
    audio_pending: List[bytes] = []
    session_live = False
    start_error: Optional[str] = None
    start_lock = threading.Lock()
    start_scheduled = False
    result_payload = {
        'type': 'transcript',
        'transcript': '',
        'partials': [],
        'language_code': language_code,
        'sample_rate_hz': sample_rate_hz,
        'error': None,
    }

    logger.info('transcribe ws session opened')
    try:
        _ws_send_json(ws, {'type': 'connected', 'engine': 'aws_transcribe_stream'})
    except Exception as e:
        logger.warning('transcribe ws connected frame failed: %s', e)

    def _on_partial(text: str) -> None:
        try:
            _ws_send_json_from_hub(ws, {'type': 'partial', 'text': text})
        except WebSocketError:
            pass
        except Exception:
            logger.debug('Failed to send partial transcript to client', exc_info=True)

    def _flush_pending_audio() -> None:
        if not session or not session_live:
            return
        for chunk in audio_pending:
            try:
                session.feed_audio(chunk)
            except Exception as e:
                logger.warning('Failed to feed buffered audio to AWS: %s', e)
                break
        audio_pending.clear()

    def _begin_session_in_os_thread() -> None:
        nonlocal session_live, start_error
        if not session:
            return
        try:
            session._start_blocking(30.0)
            session_live = True
            _ws_send_json_from_hub(ws, {
                'type': 'ready',
                'language_code': session.language_code,
                'sample_rate_hz': session.sample_rate_hz,
            })
            logger.info('transcribe aws ready (from os thread)')
            try:
                import gevent
                gevent.get_hub().loop.run_callback(_flush_pending_audio)
            except Exception:
                _flush_pending_audio()
        except BaseException as e:
            logger.exception('AWS Transcribe stream start failed')
            start_error = str(e)[:500]
            _ws_send_json_from_hub(ws, {'type': 'error', 'error': start_error})

    def _schedule_session_start() -> None:
        nonlocal start_scheduled
        with start_lock:
            if start_scheduled:
                return
            start_scheduled = True
        _TRANSCRIBE_THREAD_LAUNCHER.submit(_begin_session_in_os_thread)

    def _make_session() -> AwsTranscribeStreamSession:
        return AwsTranscribeStreamSession(
            region=region,
            language_code=language_code,
            sample_rate_hz=sample_rate_hz,
            on_partial=_on_partial,
        )

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
                    language_code = str(cfg.get('language_code') or language_code).strip() or language_code
                    sample_rate_hz = int(cfg.get('sample_rate_hz') or sample_rate_hz)
                    region = str(cfg.get('region') or region).strip() or region
                    if session is None:
                        logger.info('transcribe ws start action lang=%s rate=%s', language_code, sample_rate_hz)
                        _ws_send_json(ws, {
                            'type': 'starting',
                            'language_code': language_code,
                            'sample_rate_hz': sample_rate_hz,
                        })
                        session = _make_session()
                        _schedule_session_start()
                    continue
                if action == 'stop':
                    break
                continue

            if isinstance(message, (bytes, bytearray)):
                chunk = bytes(message)
                if session is None:
                    session = _make_session()
                    _ws_send_json(ws, {
                        'type': 'starting',
                        'language_code': language_code,
                        'sample_rate_hz': sample_rate_hz,
                    })
                    _schedule_session_start()
                if session_live:
                    session.feed_audio(chunk)
                else:
                    audio_pending.append(chunk)

        if session:
            try:
                transcript = session.stop()
            except BaseException as e:
                result_payload['error'] = str(e)[:500]
                transcript = session._transcript or ''
            result_payload['transcript'] = transcript
            result_payload['partials'] = session.partial_history
            result_payload['language_code'] = session.language_code
            result_payload['sample_rate_hz'] = session.sample_rate_hz
        _ws_send_json(ws, result_payload)
        return result_payload

    except WebSocketError as e:
        logger.info('Transcribe WebSocket closed: %s', e)
        if session:
            try:
                result_payload['transcript'] = session.stop()
                result_payload['partials'] = session.partial_history
            except BaseException as stop_err:
                result_payload['error'] = str(stop_err)[:500]
                result_payload['transcript'] = getattr(session, '_transcript', '') or ''
        try:
            _ws_send_json(ws, result_payload)
        except Exception:
            pass
        return result_payload
    except BaseException as e:
        logger.exception('Transcribe WebSocket session error')
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
        region = DEFAULT_REGION
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
