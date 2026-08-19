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
    bridge._last_client_audio_at = time.time() - 20.0
    bridge._on_partial(sess.best_transcript)
    bridge._on_session_finished(sess, 'audio_timeout')
    assert bridge.session is None
    result = bridge.finish()
    assert result['error'] is None
    assert result['transcript'] == 'hello parked transcript after pause'
    assert result['partials'][-1] == 'hello parked transcript after pause'
