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
import threading
from typing import Callable, List, Optional

from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent
from flask import Flask, request

try:
    from geventwebsocket.exceptions import WebSocketError
except ImportError:  # pragma: no cover
    WebSocketError = Exception  # type: ignore

logger = logging.getLogger(__name__)

DEFAULT_LANGUAGE = 'he-IL'
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_REGION = (os.environ.get('AWS_REGION') or 'eu-north-1').strip()


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
        self._stream_ready = threading.Event()
        self._finished = threading.Event()
        self._closed = False

    def start(self, timeout_sec: float = 30.0) -> None:
        if self._thread:
            return
        self._thread = threading.Thread(target=self._thread_main, name='aws-transcribe-stream', daemon=True)
        self._thread.start()
        if not self._stream_ready.wait(timeout=timeout_sec):
            raise TimeoutError('AWS Transcribe stream did not start in time')
        if self._error:
            raise self._error

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
        self._finished.wait(timeout=timeout_sec)
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
            self._stream_ready.set()
            self._finished.set()
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
        self._stream_ready.set()
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
    result_payload = {
        'type': 'transcript',
        'transcript': '',
        'partials': [],
        'language_code': language_code,
        'sample_rate_hz': sample_rate_hz,
        'error': None,
    }

    def _on_partial(text: str) -> None:
        try:
            _ws_send_json(ws, {'type': 'partial', 'text': text})
        except WebSocketError:
            pass
        except Exception:
            logger.debug('Failed to send partial transcript to client', exc_info=True)

    try:
        while not getattr(ws, 'closed', False):
            message = ws.receive()
            if message is None:
                break

            if isinstance(message, str):
                cfg = _parse_start_config(message)
                action = str(cfg.get('action') or '').strip().lower()
                if action in ('start', 'config'):
                    language_code = str(cfg.get('language_code') or language_code).strip() or language_code
                    sample_rate_hz = int(cfg.get('sample_rate_hz') or sample_rate_hz)
                    region = str(cfg.get('region') or region).strip() or region
                    if session is None:
                        session = AwsTranscribeStreamSession(
                            region=region,
                            language_code=language_code,
                            sample_rate_hz=sample_rate_hz,
                            on_partial=_on_partial,
                        )
                        try:
                            session.start()
                        except BaseException as e:
                            logger.exception('AWS Transcribe stream start failed')
                            _ws_send_json(ws, {'type': 'error', 'error': str(e)[:500]})
                            raise
                        _ws_send_json(ws, {
                            'type': 'ready',
                            'language_code': language_code,
                            'sample_rate_hz': sample_rate_hz,
                        })
                    continue
                if action == 'stop':
                    break
                continue

            if isinstance(message, (bytes, bytearray)):
                if session is None:
                    session = AwsTranscribeStreamSession(
                        region=region,
                        language_code=language_code,
                        sample_rate_hz=sample_rate_hz,
                        on_partial=_on_partial,
                    )
                    try:
                        session.start()
                    except BaseException as e:
                        logger.exception('AWS Transcribe stream start failed')
                        _ws_send_json(ws, {'type': 'error', 'error': str(e)[:500]})
                        raise
                    _ws_send_json(ws, {
                        'type': 'ready',
                        'language_code': language_code,
                        'sample_rate_hz': sample_rate_hz,
                    })
                session.feed_audio(bytes(message))

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

    @app.route('/ws/transcribe')
    def ws_transcribe_route():
        ws = request.environ.get('wsgi.websocket')
        if ws is None:
            return (
                'WebSocket upgrade required. '
                'Send PCM int16 mono audio; JSON {"action":"stop"} to finish.',
                400,
                {'Content-Type': 'text/plain; charset=utf-8'},
            )
        run_transcribe_websocket_session(ws)
        return ''
