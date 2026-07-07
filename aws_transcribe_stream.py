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
import collections
import json
import logging
import os
import queue
import re
import sys
import threading
import time
import uuid
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

try:
    from gevent import monkey as _gevent_monkey
    _REAL_THREAD = _gevent_monkey.get_original('threading', 'Thread')
    _REAL_LOCK = _gevent_monkey.get_original('threading', 'Lock')
    _REAL_START_NEW_THREAD = _gevent_monkey.get_original('_thread', 'start_new_thread')
    _REAL_QUEUE = _gevent_monkey.get_original('queue', 'Queue')
    _REAL_QUEUE_EMPTY = _gevent_monkey.get_original('queue', 'Empty')
    _REAL_QUEUE_FULL = _gevent_monkey.get_original('queue', 'Full')
    # gevent ≥21 patches asyncio.new_event_loop() to return a GeventSelectorEventLoop that
    # must run on the gevent hub (main thread).  Running it from an OS thread deadlocks on the
    # first I/O await.  Grab the original selector so we can build a real asyncio loop.
    _REAL_SELECTOR_CLASS = _gevent_monkey.get_original('selectors', 'DefaultSelector')
    # Capture the main gevent hub at import time (we are on the main thread here).
    # _run_on_hub uses hub.loop.run_callback which is thread-safe in libev and always
    # dispatches to the main event loop even when called from an asyncio OS thread.
    import gevent as _gevent_mod
    _MAIN_GEVENT_HUB = _gevent_mod.get_hub()
except Exception:  # pragma: no cover
    import selectors as _selectors_mod
    _REAL_THREAD = threading.Thread
    _REAL_LOCK = threading.Lock
    _REAL_QUEUE = queue.Queue
    _REAL_QUEUE_EMPTY = queue.Empty
    _REAL_QUEUE_FULL = queue.Full
    _REAL_SELECTOR_CLASS = _selectors_mod.DefaultSelector
    _MAIN_GEVENT_HUB = None
    try:
        import _thread
        _REAL_START_NEW_THREAD = _thread.start_new_thread
    except Exception:
        _REAL_START_NEW_THREAD = None


def _start_real_os_thread(target: Callable[[], None], name: str) -> None:
    """Start target in a real OS thread, bypassing gevent-patched Thread.start()."""
    def _runner() -> None:
        try:
            threading.current_thread().name = name
        except Exception:
            pass
        target()

    if _REAL_START_NEW_THREAD is not None:
        _REAL_START_NEW_THREAD(_runner, ())
        return
    worker = _REAL_THREAD(target=_runner, name=name, daemon=True)
    worker.start()

DEFAULT_LANGUAGE = 'he-IL'
DEFAULT_SAMPLE_RATE = 16000
_TRANSCRIBE_STREAM_REGION_FALLBACK = 'eu-west-1'
# Amazon Transcribe Streaming is not available in every AWS/SageMaker region.
# Keep this allowlist separate from AWS_REGION because medical SageMaker runs in eu-north-1.
_TRANSCRIBE_STREAM_SUPPORTED_REGIONS = {
    'af-south-1',
    'ap-northeast-1',
    'ap-northeast-2',
    'ap-south-1',
    'ap-southeast-1',
    'ap-southeast-2',
    'ca-central-1',
    'eu-central-1',
    'eu-west-1',
    'eu-west-2',
    'sa-east-1',
    'us-east-1',
    'us-east-2',
    'us-gov-east-1',
    'us-gov-west-1',
    'us-west-2',
}
# AWS regions (not R2 "auto", not full endpoint URLs).
_AWS_REGION_RE = re.compile(
    r'^[a-z]{2}(-gov)?-(east|west|north|south|central|northeast|southeast|southwest|northwest)-\d+$'
)


def transcribe_stream_region() -> str:
    """AWS region for Transcribe Streaming (never use R2's AWS_REGION=auto)."""
    invalid_sources = []
    unsupported_sources = []
    for key in (
        'MEDICAL_TRANSCRIBE_STREAM_REGION',
        'AWS_TRANSCRIBE_REGION',
        'AWS_REGION',
        'AWS_DEFAULT_REGION',
    ):
        raw = (os.environ.get(key) or '').strip()
        if not raw:
            continue
        if _AWS_REGION_RE.match(raw) and raw in _TRANSCRIBE_STREAM_SUPPORTED_REGIONS:
            return raw
        if _AWS_REGION_RE.match(raw):
            unsupported_sources.append(f'{key}={raw!r}')
        else:
            invalid_sources.append(f'{key}={raw!r}')
    if unsupported_sources:
        logger.warning(
            'Unsupported AWS Transcribe Streaming region env (%s); using %s. '
            'Use a streaming-supported region such as eu-west-1, eu-central-1, or eu-west-2.',
            ', '.join(unsupported_sources),
            _TRANSCRIBE_STREAM_REGION_FALLBACK,
        )
    if invalid_sources:
        logger.warning(
            'Invalid transcribe region env (%s); using %s. '
            'Set MEDICAL_TRANSCRIBE_STREAM_REGION=eu-west-1 (or another AWS Transcribe Streaming region).',
            ', '.join(invalid_sources),
            _TRANSCRIBE_STREAM_REGION_FALLBACK,
        )
    return _TRANSCRIBE_STREAM_REGION_FALLBACK


def normalize_transcribe_region(region: Optional[str]) -> str:
    raw = str(region or '').strip()
    if raw and _AWS_REGION_RE.match(raw) and raw in _TRANSCRIBE_STREAM_SUPPORTED_REGIONS:
        return raw
    if raw and _AWS_REGION_RE.match(raw):
        logger.warning(
            'Unsupported AWS Transcribe Streaming region %r; using %s',
            raw,
            _TRANSCRIBE_STREAM_REGION_FALLBACK,
        )
    return transcribe_stream_region()


DEFAULT_REGION = transcribe_stream_region()

# gevent greenlets must not call patched threading.Thread.start() for the AWS asyncio loop.
_ACTIVE_TRANSCRIBE_SESSIONS = {}
_ACTIVE_TRANSCRIBE_LOCK = _REAL_LOCK()


def _transcribe_max_session_sec() -> float:
    try:
        return max(15.0, float(os.environ.get('MEDICAL_TRANSCRIBE_STREAM_MAX_SEC', '900') or 900))
    except (TypeError, ValueError):
        return 900.0


def _mark_transcribe_active(session: 'AwsTranscribeStreamSession') -> None:
    with _ACTIVE_TRANSCRIBE_LOCK:
        _ACTIVE_TRANSCRIBE_SESSIONS[session.session_id] = {
            'session_id': session.session_id,
            'started_at': session._created_at,
            'accepted_at': time.time(),
            'region': session.region,
            'language_code': session.language_code,
            'sample_rate_hz': session.sample_rate_hz,
        }
        active = len(_ACTIVE_TRANSCRIBE_SESSIONS)
    logger.info('AWS Transcribe active sessions=%d session=%s', active, session.session_id)


def _mark_transcribe_inactive(session: 'AwsTranscribeStreamSession', reason: str) -> None:
    with _ACTIVE_TRANSCRIBE_LOCK:
        _ACTIVE_TRANSCRIBE_SESSIONS.pop(session.session_id, None)
        active = len(_ACTIVE_TRANSCRIBE_SESSIONS)
    logger.info('AWS Transcribe inactive sessions=%d session=%s reason=%s', active, session.session_id, reason)


def active_transcribe_sessions_snapshot() -> dict:
    now = time.time()
    with _ACTIVE_TRANSCRIBE_LOCK:
        sessions = []
        for info in _ACTIVE_TRANSCRIBE_SESSIONS.values():
            item = dict(info)
            item['age_sec'] = round(now - float(item.get('accepted_at') or item.get('started_at') or now), 3)
            sessions.append(item)
    return {'active_count': len(sessions), 'sessions': sessions}


def _pcm16_level(chunk: bytes) -> tuple[int, int]:
    """Return RMS and peak for little-endian signed 16-bit PCM."""
    if not chunk:
        return 0, 0
    even_len = len(chunk) - (len(chunk) % 2)
    if even_len <= 0:
        return 0, 0
    pcm = chunk[:even_len]
    total = 0
    peak = 0
    samples = even_len // 2
    for i in range(0, even_len, 2):
        sample = int.from_bytes(pcm[i:i + 2], byteorder='little', signed=True)
        abs_sample = abs(sample)
        total += sample * sample
        if abs_sample > peak:
            peak = abs_sample
    return int((total / samples) ** 0.5) if samples else 0, peak


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
        self._event_count = 0

    def _notify_live(self) -> None:
        if not self._on_partial:
            return
        text = self.full_transcript
        if not text:
            return
        try:
            self._on_partial(text)
        except Exception:
            logger.debug('partial callback failed', exc_info=True)

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
            self._event_count += 1
            if result.is_partial:
                self._current_partial = text
                self._partial_history.append(text)
            else:
                self._final_parts.append(text)
                self._current_partial = ''
                self._partial_history.append(text)
            if self._event_count <= 3 or self._event_count % 10 == 0 or not result.is_partial:
                logger.info(
                    'AWS transcript event count=%d partial=%s text_len=%d full_len=%d',
                    self._event_count,
                    bool(result.is_partial),
                    len(text),
                    len(self.full_transcript),
                )
            asyncio.get_running_loop().call_soon(self._notify_live)

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
        on_ready: Optional[Callable[[], None]] = None,
        on_error: Optional[Callable[[BaseException], None]] = None,
    ):
        self.session_id = uuid.uuid4().hex[:12]
        self._created_at = time.time()
        self.region = normalize_transcribe_region(region)
        self.language_code = language_code
        self.sample_rate_hz = int(sample_rate_hz or DEFAULT_SAMPLE_RATE)
        self.on_partial = on_partial
        self.on_ready = on_ready
        self.on_error = on_error
        # Use a plain deque for cross-thread audio transfer.
        # deque.append / deque.popleft are GIL-atomic in CPython — no locks needed,
        # safe from any gevent greenlet or real OS thread without gevent interference.
        self._audio_deque: collections.deque = collections.deque()
        self._audio_deque_has_sentinel = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._handler: Optional[_CollectingTranscriptHandler] = None
        self._transcript = ''
        self._error: Optional[BaseException] = None
        self._ready_q = _REAL_QUEUE(maxsize=1)
        self._finished_q = _REAL_QUEUE(maxsize=1)
        self._closed = False
        self._chunks_queued = 0
        self._chunks_fed_to_aws = 0
        self._bytes_fed_to_aws = 0
        self._aws_accepted = False

    def _start_blocking(self, timeout_sec: float = 30.0) -> None:
        """Run only from an OS thread (ThreadPoolExecutor worker)."""
        if self._thread:
            return
        self._thread = True  # Marker only; low-level threads do not expose a joinable Thread object.
        _start_real_os_thread(self._thread_main, 'aws-transcribe-stream')
        t_wait = time.time()
        try:
            self._ready_q.get(timeout=timeout_sec)
        except _REAL_QUEUE_EMPTY:
            raise TimeoutError(f'AWS Transcribe stream did not start in time ({round(time.time() - t_wait, 3)}s)')
        if self._error:
            raise self._error
        logger.info('AWS Transcribe stream ready in %.3fs', time.time() - t_wait)

    def start(self, timeout_sec: float = 30.0) -> None:
        """Blocking start safe from HTTP handlers / health checks (not gevent WS greenlets)."""
        done_q = _REAL_QUEUE(maxsize=1)

        def _run() -> None:
            try:
                self._start_blocking(timeout_sec)
                done_q.put_nowait(None)
            except BaseException as e:
                try:
                    done_q.put_nowait(e)
                except _REAL_QUEUE_FULL:
                    pass

        _start_real_os_thread(_run, 'aws-transcribe-start-blocking')
        try:
            result = done_q.get(timeout=timeout_sec + 10)
        except _REAL_QUEUE_EMPTY:
            raise TimeoutError(f'AWS Transcribe stream did not start in time ({timeout_sec + 10:.1f}s)')
        if isinstance(result, BaseException):
            raise result

    def start_background(self) -> None:
        """Start the AWS asyncio worker; readiness is reported via on_ready callback."""
        if self._thread:
            return
        self._thread = True
        _start_real_os_thread(self._thread_main, 'aws-transcribe-stream')

    def _queue_audio(self, chunk: Optional[bytes]) -> None:
        """Enqueue PCM for the AWS asyncio worker (safe from gevent greenlets or OS threads).
        Uses a deque whose append/popleft are GIL-atomic in CPython — no locks required."""
        if chunk is None:
            if not self._audio_deque_has_sentinel:
                self._audio_deque_has_sentinel = True
                self._audio_deque.append(None)
            return
        self._chunks_queued += 1
        self._audio_deque.append(bytes(chunk))

    def feed_audio(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return
        self._queue_audio(bytes(chunk))

    def stop(self, timeout_sec: float = 120.0) -> str:
        if self._closed:
            return self.best_transcript
        self._closed = True
        try:
            self._queue_audio(None)
        except Exception as e:
            logger.warning('Failed to signal end-of-stream to AWS: %s', e)
        try:
            self._finished_q.get(timeout=timeout_sec)
        except _REAL_QUEUE_EMPTY:
            logger.warning(
                'AWS Transcribe stream stop timed out after %.1fs queued=%d chunks_fed=%d bytes_fed=%d transcript_len=%d',
                timeout_sec,
                self._chunks_queued,
                self._chunks_fed_to_aws,
                self._bytes_fed_to_aws,
                len(self._handler.full_transcript if self._handler else ''),
            )
        if self._error:
            raise self._error
        self._transcript = self.best_transcript
        return self._transcript

    @property
    def best_transcript(self) -> str:
        if self._transcript:
            return self._transcript
        if self._handler:
            text = self._handler.full_transcript
            if text:
                return text
            history = self._handler.partial_history
            if history:
                return str(history[-1] or '').strip()
        return ''

    @property
    def partial_history(self) -> List[str]:
        if self._handler:
            return self._handler.partial_history
        return []

    def _thread_main(self) -> None:
        # Build a genuine asyncio SelectorEventLoop using the original pre-gevent selector.
        # asyncio.new_event_loop() returns a GeventSelectorEventLoop in gevent ≥21 which
        # must run on the gevent hub — calling it from an OS thread deadlocks on I/O awaits.
        try:
            self._loop = asyncio.SelectorEventLoop(_REAL_SELECTOR_CLASS())
        except Exception:
            self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._transcript = self._loop.run_until_complete(self._async_run())
        except BaseException as e:
            self._error = e
            logger.exception('AWS Transcribe streaming session failed')
            if not self._aws_accepted and self.on_error:
                try:
                    self.on_error(e)
                except Exception:
                    logger.debug('AWS Transcribe on_error callback failed', exc_info=True)
        finally:
            if self._aws_accepted:
                _mark_transcribe_inactive(self, 'thread_finished')
            try:
                self._ready_q.put_nowait(True)
            except _REAL_QUEUE_FULL:
                pass
            try:
                self._finished_q.put_nowait(True)
            except _REAL_QUEUE_FULL:
                pass
            try:
                self._loop.close()
            except Exception:
                pass

    async def _async_run(self) -> str:
        logger.info('AWS Transcribe stream connecting region=%s lang=%s', self.region, self.language_code)
        client = TranscribeStreamingClient(region=self.region)
        stream = await client.start_stream_transcription(
            language_code=self.language_code,
            media_sample_rate_hz=self.sample_rate_hz,
            media_encoding='pcm',
        )
        logger.info('AWS Transcribe stream accepted by AWS')
        self._aws_accepted = True
        _mark_transcribe_active(self)
        try:
            self._ready_q.put_nowait(True)
        except _REAL_QUEUE_FULL:
            pass
        self._handler = _CollectingTranscriptHandler(
            stream.output_stream,
            on_partial=self.on_partial,
        )

        async def _feed_aws() -> None:
            # Poll the lock-free deque from this asyncio worker thread.
            # deque.popleft() is GIL-atomic: no gevent lock involvement.
            logger.info('transcribe AWS feed loop started session=%s', self.session_id)
            while True:
                drained = 0
                while self._audio_deque:
                    try:
                        chunk = self._audio_deque.popleft()
                    except IndexError:
                        break
                    drained += 1
                    if chunk is None:
                        logger.info('transcribe end-of-stream marker reached fed=%d', self._chunks_fed_to_aws)
                        await stream.input_stream.end_stream()
                        return
                    await stream.input_stream.send_audio_event(audio_chunk=chunk)
                    self._chunks_fed_to_aws += 1
                    self._bytes_fed_to_aws += len(chunk)
                    if self._chunks_fed_to_aws == 1:
                        logger.info('transcribe first chunk fed to AWS (%d bytes)', len(chunk))
                    elif self._chunks_fed_to_aws % 50 == 0:
                        logger.info(
                            'transcribe chunks fed to AWS: %d queued=%d bytes_fed=%d',
                            self._chunks_fed_to_aws,
                            self._chunks_queued,
                            self._bytes_fed_to_aws,
                        )
                if not drained:
                    await asyncio.sleep(0.005)

        # Call on_ready directly — it schedules the Socket.IO 'ready' emit via
        # _run_on_hub (main gevent hub), which is safe from this asyncio OS thread.
        if self.on_ready:
            try:
                self.on_ready()
            except Exception:
                logger.debug('AWS Transcribe on_ready callback failed', exc_info=True)

        feed_task = asyncio.create_task(_feed_aws())

        async def _max_session_guard() -> None:
            await asyncio.sleep(_transcribe_max_session_sec())
            if self._closed:
                return
            self._closed = True
            logger.warning(
                'AWS Transcribe stream max duration reached session=%s chunks_fed=%d bytes_fed=%d',
                self.session_id,
                self._chunks_fed_to_aws,
                self._bytes_fed_to_aws,
            )
            self._queue_audio(None)

        guard_task = asyncio.create_task(_max_session_guard())
        try:
            await asyncio.gather(feed_task, self._handler.handle_events())
        finally:
            guard_task.cancel()
        logger.info(
            'AWS Transcribe stream finished queued=%d fed=%d bytes_fed=%d transcript_len=%d',
            self._chunks_queued,
            self._chunks_fed_to_aws,
            self._bytes_fed_to_aws,
            len(self._handler.full_transcript if self._handler else ''),
        )
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


def _coerce_audio_chunk(data) -> Optional[bytes]:
    """Normalize Socket.IO / WebSocket binary payloads to raw PCM bytes."""
    if data is None:
        return None
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if isinstance(data, list):
        try:
            return bytes(data)
        except (TypeError, ValueError):
            return None
    if isinstance(data, dict):
        for key in ('data', 'buffer', 'audio', 'chunk'):
            val = data.get(key)
            if isinstance(val, (bytes, bytearray, memoryview)):
                return bytes(val)
            if isinstance(val, list):
                try:
                    return bytes(val)
                except (TypeError, ValueError):
                    pass
    return None


def _run_on_hub(callback) -> None:
    """Schedule callback on the main gevent hub (safe from asyncio OS threads).

    hub.loop.run_callback() is thread-safe in libev: it uses an async watcher to
    wake the main event loop from any OS thread.  gevent.spawn() must NOT be used
    here because get_hub() is thread-local — from an asyncio OS thread it returns a
    per-thread mini-hub that is never started, so the callback would never fire.
    """
    try:
        if _MAIN_GEVENT_HUB is not None:
            loop = getattr(_MAIN_GEVENT_HUB, 'loop', None)
            if loop is not None:
                loop.run_callback(callback)
                return
    except Exception:
        pass
    callback()


class TranscribeStreamBridge:
    """Shared orchestration for one live transcribe client (WS or Socket.IO)."""

    def __init__(self, send_json: Callable[[dict], None], on_fatal: Optional[Callable[[], None]] = None):
        self._send = send_json
        self._on_fatal = on_fatal
        self._alive = True
        self.region = transcribe_stream_region()
        self.language_code = DEFAULT_LANGUAGE
        self.sample_rate_hz = DEFAULT_SAMPLE_RATE
        self.session: Optional[AwsTranscribeStreamSession] = None
        self.audio_pending: List[bytes] = []
        self.session_live = False
        self.start_lock = _REAL_LOCK()
        self.start_scheduled = False
        self._logged_first_partial = False
        self._audio_chunks_received = 0
        self._last_audio_rms = 0
        self._last_audio_peak = 0

    def close(self) -> None:
        self._alive = False
        sess = self.session
        if sess and not sess._closed:
            try:
                sess._queue_audio(None)
            except Exception:
                logger.debug('transcribe bridge close end-marker failed', exc_info=True)

    def _emit(self, payload: dict) -> None:
        if not self._alive:
            return
        self._send(payload)

    def send_connected(self) -> None:
        self._emit({'type': 'connected', 'engine': 'aws_transcribe_stream'})

    def _on_partial(self, text: str) -> None:
        try:
            if not getattr(self, '_logged_first_partial', False):
                self._logged_first_partial = True
                logger.info('transcribe first partial (%d chars)', len(text))
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

    def _on_session_ready(self) -> None:
        if not self.session:
            return
        self.session_live = True
        self._emit({
            'type': 'ready',
            'language_code': self.session.language_code,
            'sample_rate_hz': self.session.sample_rate_hz,
            'region': self.session.region,
        })
        logger.info('transcribe aws ready region=%s (from aws thread)', self.session.region)
        self._flush_pending_audio()

    def _on_session_error(self, err: BaseException) -> None:
        logger.error(
            'AWS Transcribe stream start failed',
            exc_info=(type(err), err, err.__traceback__),
        )
        self._emit({
            'type': 'error',
            'error': str(err)[:500],
            'region': getattr(self.session, 'region', self.region),
        })
        if self._on_fatal:
            try:
                self._on_fatal()
            except Exception:
                logger.debug('transcribe fatal cleanup callback failed', exc_info=True)

    def _begin_session_in_os_thread(self) -> None:
        if not self.session:
            return
        try:
            self.session.start_background()
        except BaseException as e:
            self._on_session_error(e)

    def _schedule_session_start(self) -> None:
        with self.start_lock:
            if self.start_scheduled:
                return
            self.start_scheduled = True
        _start_real_os_thread(self._begin_session_in_os_thread, 'aws-transcribe-start')

    def _make_session(self) -> AwsTranscribeStreamSession:
        return AwsTranscribeStreamSession(
            region=self.region,
            language_code=self.language_code,
            sample_rate_hz=self.sample_rate_hz,
            on_partial=self._on_partial,
            on_ready=self._on_session_ready,
            on_error=self._on_session_error,
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
        if not chunk or not self._alive:
            return
        self._audio_chunks_received += 1
        rms, peak = _pcm16_level(chunk)
        self._last_audio_rms = rms
        self._last_audio_peak = peak
        if self._audio_chunks_received == 1:
            logger.info(
                'transcribe first audio chunk (%d bytes rms=%d peak=%d)',
                len(chunk),
                rms,
                peak,
            )
        elif self._audio_chunks_received % 50 == 0:
            logger.info(
                'transcribe audio chunks received: %d rms=%d peak=%d',
                self._audio_chunks_received,
                rms,
                peak,
            )
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

    def finish(self, stop_timeout_sec: float = 30.0) -> dict:
        result_payload = {
            'type': 'transcript',
            'transcript': '',
            'partials': [],
            'language_code': self.language_code,
            'sample_rate_hz': self.sample_rate_hz,
            'error': None,
        }
        self.close()
        if self.session:
            try:
                transcript = self.session.stop(timeout_sec=stop_timeout_sec)
            except BaseException as e:
                result_payload['error'] = str(e)[:500]
                transcript = self.session.best_transcript
            if not transcript:
                transcript = self.session.best_transcript
            result_payload['transcript'] = transcript
            result_payload['partials'] = self.session.partial_history
            result_payload['language_code'] = self.session.language_code
            result_payload['sample_rate_hz'] = self.session.sample_rate_hz
            logger.info(
                'transcribe socketio finish received=%d queued=%d fed=%d transcript_len=%d',
                self._audio_chunks_received,
                getattr(self.session, '_chunks_queued', 0),
                getattr(self.session, '_chunks_fed_to_aws', 0),
                len(transcript or ''),
            )
        return result_payload


_SOCKETIO_BRIDGES: dict = {}


def cleanup_transcribe_socketio_bridge(sid: str) -> None:
    bridge = _SOCKETIO_BRIDGES.pop(sid, None)
    if not bridge:
        return
    bridge.close()
    logger.info('transcribe socketio cleanup sid=%s', sid)
    try:
        bridge.finish(stop_timeout_sec=5.0)
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
        bridge = TranscribeStreamBridge(
            lambda payload: _emit_to_sid(sid, payload),
            on_fatal=lambda: _SOCKETIO_BRIDGES.pop(sid, None),
        )
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
        chunk = _coerce_audio_chunk(data)
        if not chunk:
            if data is not None:
                logger.warning(
                    'transcribe socketio audio ignored sid=%s type=%s',
                    sid,
                    type(data).__name__,
                )
            return
        bridge.handle_audio(chunk)

    @socketio.on('medical_transcribe_stop')
    def on_medical_transcribe_stop():
        sid = request.sid
        bridge = _SOCKETIO_BRIDGES.pop(sid, None)
        if not bridge:
            return
        logger.info('transcribe socketio stop sid=%s', sid)
        bridge.close()
        result = bridge.finish(stop_timeout_sec=45.0)
        logger.info(
            'transcribe socketio done sid=%s chunks=%d last_rms=%d last_peak=%d transcript_len=%d partials=%d error=%s',
            sid,
            bridge._audio_chunks_received,
            bridge._last_audio_rms,
            bridge._last_audio_peak,
            len(str(result.get('transcript') or '')),
            len(result.get('partials') or []),
            result.get('error'),
        )
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

    @app.route('/api/transcribe_stream_active', methods=['GET'])
    def api_transcribe_stream_active():
        """Non-PHI debug view of currently accepted AWS Transcribe Streaming sessions."""
        return jsonify(active_transcribe_sessions_snapshot()), 200

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
