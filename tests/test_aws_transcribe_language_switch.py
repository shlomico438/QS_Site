from aws_transcribe_stream import (
    TranscribeStreamBridge,
    _CollectingTranscriptHandler,
    _is_full_script_rewrite,
    _keep_new_language_suffix,
)


def test_hebrew_is_not_a_script_rewrite_when_english_is_appended():
    prev = 'בנוסף רציתי לבדוק'
    mixed = 'בנוסף רציתי לבדוק if I change the language to English'
    assert _is_full_script_rewrite(prev, mixed) is False


def test_english_redecode_of_hebrew_is_a_script_rewrite():
    prev = 'בנוסף רציתי לבדוק'
    rewritten = 'Mina of a dog if I change the language to English, what is happening?'
    assert _is_full_script_rewrite(prev, rewritten) is True


def test_keep_english_spoken_after_hebrew_span():
    prev = 'בנוסף רציתי לבדוק'
    rewritten = 'Mina of a dog if I change the language to English, what is happening?'
    kept = _keep_new_language_suffix(prev, rewritten)
    assert 'Mina' not in kept
    assert 'dog' not in kept.lower()
    assert kept.lower().startswith('if i change')


def test_handler_keeps_hebrew_when_aws_rewrites_result_as_english():
    handler = _CollectingTranscriptHandler(None)
    handler.ingest_aws_result(
        rid='r1',
        text='בנוסף רציתי לבדוק',
        is_partial=True,
        language_code='he-IL',
        start_time=0.0,
        end_time=3.0,
    )
    handler.ingest_aws_result(
        rid='r1',
        text='Mina of a dog if I change the language to English, what is happening?',
        is_partial=True,
        language_code='en-US',
        start_time=0.0,
        end_time=8.0,
    )
    text = handler.full_transcript
    assert 'בנוסף רציתי לבדוק' in text
    assert 'Mina' not in text
    assert 'if I change the language to English' in text


def test_handler_does_not_overwrite_frozen_hebrew_final():
    handler = _CollectingTranscriptHandler(None)
    handler.ingest_aws_result(
        rid='r1',
        text='בנוסף רציתי לבדוק',
        is_partial=False,
        language_code='he-IL',
        start_time=0.0,
        end_time=3.0,
    )
    handler.ingest_aws_result(
        rid='r1',
        text='Mina of a dog',
        is_partial=False,
        language_code='en-US',
        start_time=0.0,
        end_time=3.0,
    )
    assert handler.full_transcript == 'בנוסף רציתי לבדוק'


class _FakeParkedSession:
    best_transcript = 'hello parked transcript after pause'
    language_code = 'he-IL'
    sample_rate_hz = 16000
    partial_history = ['hello parked transcript after pause']
    _closed = True
    _chunks_fed_to_aws = 12


def test_finish_returns_committed_transcript_after_audio_timeout_park():
    import time

    bridge = TranscribeStreamBridge(lambda payload: None)
    sess = _FakeParkedSession()
    bridge.session = sess
    bridge._last_client_audio_at = time.time() - 90.0
    bridge._on_partial(sess.best_transcript)
    bridge._on_session_finished(sess, 'audio_timeout')
    assert bridge.session is None
    result = bridge.finish()
    assert result['error'] is None
    assert result['transcript'] == 'hello parked transcript after pause'
    assert result['partials'][-1] == 'hello parked transcript after pause'


def test_park_emits_parked_event_for_client_ux():
    import time

    events = []
    bridge = TranscribeStreamBridge(lambda payload: events.append(payload))
    sess = _FakeParkedSession()
    bridge.session = sess
    bridge.session_live = True
    bridge._ever_ready = True
    bridge._last_client_audio_at = time.time() - 90.0
    bridge._on_partial(sess.best_transcript)
    bridge._on_session_finished(sess, 'audio_timeout')
    assert bridge.session is None
    parked = [e for e in events if e.get('type') == 'parked']
    assert len(parked) == 1
    assert parked[0]['reason'] == 'audio_timeout'


class _FakeLiveSession:
    def __init__(self):
        self.fed = []
        self._closed = False
        self.best_transcript = ''
        self.partial_history = []
        self.language_code = 'he-IL'
        self.sample_rate_hz = 16000
        self.session_id = 'fake'
        self.region = 'eu-west-1'

    def feed_audio(self, chunk):
        self.fed.append(chunk)


def test_silence_keepalive_fires_only_once_per_idle_spell():
    import time

    bridge = TranscribeStreamBridge(lambda payload: None)
    sess = _FakeLiveSession()
    bridge.session = sess
    bridge.session_live = True
    bridge._last_client_audio_at = time.time() - 13.0
    assert bridge._feed_silence_keepalive_once() is True
    assert bridge._silence_keepalive_used is True
    assert len(sess.fed) == 1
    assert bridge._feed_silence_keepalive_once() is False
    assert len(sess.fed) == 1
    # Real client audio resets the one-shot allowance for the next pause.
    bridge.handle_audio(b'\x01\x00' * 160)
    assert bridge._silence_keepalive_used is False
    assert bridge.session is sess
    assert len(sess.fed) == 2


def test_silence_keepalive_skipped_before_any_client_audio():
    bridge = TranscribeStreamBridge(lambda payload: None)
    sess = _FakeLiveSession()
    bridge.session = sess
    bridge.session_live = True
    bridge._last_client_audio_at = 0.0
    assert bridge._feed_silence_keepalive_once() is False
    assert bridge._silence_keepalive_used is False
    assert len(sess.fed) == 0


def test_first_audio_is_counted_without_waking_poll():
    events = []
    bridge = TranscribeStreamBridge(lambda payload: events.append(payload))
    sess = _FakeLiveSession()
    bridge.session = sess
    bridge.session_live = True
    bridge.handle_audio(b'\x01\x00' * 160)
    assert bridge._audio_chunks_received == 1
    assert not any(e.get('type') == 'audio_rx' for e in events)
    ack = bridge.latest_audio_ack()
    assert ack is None or ack.get('type') == 'partial'


def test_should_push_partial_skips_during_live_audio():
    bridge = TranscribeStreamBridge(lambda payload: None)
    bridge._last_client_audio_at = __import__('time').time()
    assert bridge._should_push_partial('hello there') is False
    bridge._last_client_audio_at = __import__('time').time() - 5.0
    assert bridge._should_push_partial('hello there') is True


def test_seeded_commit_survives_in_combined_transcript():
    bridge = TranscribeStreamBridge(lambda payload: None)
    bridge._committed_segments = ['hello parked transcript']
    out = bridge._combined_transcript('new tail')
    assert out.startswith('hello parked transcript')
    assert 'new tail' in out


def test_run_on_hub_prefers_threadsafe_callback():
    import aws_transcribe_stream as m

    calls = []

    class Loop:
        def run_callback(self, cb, *args):
            calls.append('unsafe')
            cb(*args)

        def run_callback_threadsafe(self, cb, *args):
            calls.append('safe')
            cb(*args)

    class Hub:
        loop = Loop()

    old = m._MAIN_GEVENT_HUB
    m._MAIN_GEVENT_HUB = Hub()
    try:
        ran = []
        m._run_on_hub(lambda: ran.append(True))
        assert calls == ['safe']
        assert ran == [True]
    finally:
        m._MAIN_GEVENT_HUB = old


def test_session_error_does_not_drop_bridge_when_thread_will_finish():
    fatal = []
    bridge = TranscribeStreamBridge(lambda payload: None, on_fatal=lambda: fatal.append(True))
    sess = _FakeLiveSession()
    sess._loop = object()
    bridge.session = sess
    scheduled = []
    bridge._schedule_session_start = lambda: scheduled.append(True)
    bridge._on_session_error(RuntimeError('start failed'))
    assert fatal == []
    assert bridge.session is sess
    assert bridge._alive is True
    assert scheduled == []


def test_start_background_error_rolls_over_without_fatal():
    fatal = []
    events = []
    bridge = TranscribeStreamBridge(lambda payload: events.append(payload), on_fatal=lambda: fatal.append(True))
    sess = _FakeLiveSession()
    sess._loop = None
    bridge.session = sess
    scheduled = []
    bridge._schedule_session_start = lambda: scheduled.append(True)
    bridge._on_session_error(RuntimeError('start_background failed'))
    assert fatal == []
    assert bridge._alive is True
    assert bridge.session is not sess
    assert scheduled == [True]
    assert any(e.get('type') == 'resuming' for e in events)


def test_repeated_start_errors_emit_error_but_keep_bridge():
    fatal = []
    events = []
    bridge = TranscribeStreamBridge(lambda payload: events.append(payload), on_fatal=lambda: fatal.append(True))
    sess = _FakeLiveSession()
    sess._loop = None
    bridge.session = sess
    bridge._start_fail_count = 2
    bridge._schedule_session_start = lambda: None
    bridge._on_session_error(RuntimeError('still failing'))
    assert fatal == []
    assert bridge._alive is True
    assert bridge.session is None
    assert any(e.get('type') == 'error' for e in events)
