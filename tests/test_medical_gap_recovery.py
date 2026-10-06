import io
import json
import unittest
from unittest.mock import MagicMock

import medical_gap_transcribe as gap


class ValidateGapsTests(unittest.TestCase):
    def test_rejects_negative_and_inverted(self):
        out = gap.validate_gaps(
            [
                {"id": "neg", "startMs": -5, "endMs": 1000},
                {"id": "inv", "startMs": 4000, "endMs": 1000},
                {"id": "ok", "startMs": 1000, "endMs": 2500},
            ],
            8000,
        )
        self.assertEqual([g["id"] for g in out], ["ok"])

    def test_clamps_range_past_file_length(self):
        out = gap.validate_gaps(
            [{"id": "late", "startMs": 7000, "endMs": 12000, "placeholder": "x"}],
            8000,
        )
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["endMs"], 8000)
        self.assertEqual(out[0]["startMs"], 7000)

    def test_drops_range_that_starts_after_file(self):
        out = gap.validate_gaps([{"id": "after", "startMs": 9000, "endMs": 11000}], 8000)
        self.assertEqual(out, [])

    def test_clips_overlapping_gaps(self):
        out = gap.validate_gaps(
            [
                {"id": "a", "startMs": 1000, "endMs": 4000},
                {"id": "b", "startMs": 2500, "endMs": 6000},
            ],
            10000,
        )
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["endMs"], 4000)
        self.assertEqual(out[1]["startMs"], 4000)
        self.assertEqual(out[1]["endMs"], 6000)


class PlaceholderAndStitchTests(unittest.TestCase):
    def test_placeholder_hebrew(self):
        text = gap.gap_placeholder_text(72000, 125000, failed=False, locale="he")
        self.assertEqual(text, "[קטע בהשלמה 01:12–02:05]")

    def test_failed_marker_replaces_placeholder(self):
        filling = gap.gap_placeholder_text(1000, 4000, failed=False, locale="he")
        transcript = f"hello\n{filling}\nworld"
        out = gap.apply_failed_marker(
            transcript,
            {"startMs": 1000, "endMs": 4000, "placeholder": filling},
            locale="he",
        )
        self.assertIn("[קטע לא תומלל 00:01–00:04]", out)
        self.assertNotIn("בהשלמה", out)

    def test_replace_placeholder_inserts_recovered_text(self):
        filling = gap.gap_placeholder_text(1000, 4000, failed=False, locale="he")
        transcript = f"לפני\n{filling}\nאחרי"
        out = gap.replace_placeholder(transcript, filling, "הקטע שחזר")
        self.assertEqual(out, "לפני\nהקטע שחזר\nאחרי")

    def test_stitch_ok_and_failed(self):
        filling_a = gap.gap_placeholder_text(0, 2000, failed=False, locale="he")
        filling_b = gap.gap_placeholder_text(5000, 8000, failed=False, locale="he")
        transcript = f"A {filling_a} B {filling_b} C"
        out = gap.stitch_transcript(
            transcript,
            [
                {"placeholder": filling_a, "status": "ok", "text": "ONE", "startMs": 0, "endMs": 2000},
                {"placeholder": filling_b, "status": "failed", "text": "", "startMs": 5000, "endMs": 8000},
            ],
            locale="he",
        )
        self.assertIn("ONE", out)
        self.assertIn("[קטע לא תומלל 00:05–00:08]", out)
        self.assertNotIn(filling_b, out)


class OverlapTrimTests(unittest.TestCase):
    def test_trims_repeated_edge_words(self):
        out = gap.trim_overlap_edges(
            "patient has fever and cough",
            "cough started yesterday and pain",
            "pain in the chest",
        )
        self.assertEqual(out, "started yesterday and")

    def test_keeps_unique_gap_text(self):
        out = gap.trim_overlap_edges("hello there", "missing sentence here", "goodbye now")
        self.assertEqual(out, "missing sentence here")


class BatchRegionTests(unittest.TestCase):
    def test_eu_north_1_is_used_next_to_hipaa_bucket(self):
        self.assertEqual(gap.transcribe_batch_region("eu-north-1"), "eu-north-1")

    def test_unknown_region_falls_back_to_eu_north_1(self):
        self.assertEqual(gap.transcribe_batch_region("not-a-region"), "eu-north-1")

    def test_engine_names(self):
        self.assertEqual(gap.gap_transcribe_engine("stream"), "stream")
        self.assertEqual(gap.gap_transcribe_engine("batch"), "batch")


class OrchestrationTests(unittest.TestCase):
    def test_failed_job_leaves_not_transcribed_marker(self):
        filling = gap.gap_placeholder_text(1000, 4000, failed=False, locale="he")
        transcript = f"start {filling} end"
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": io.BytesIO(b'{"results":{"transcripts":[{"transcript":""}]}}')}
        transcribe = MagicMock()
        transcribe.get_transcription_job.return_value = {
            "TranscriptionJob": {
                "TranscriptionJobStatus": "FAILED",
                "FailureReason": "bad audio",
            }
        }

        def fake_probe(*_a, **_k):
            return 10000

        def fake_slice(*_a, **_k):
            path = _a[2]
            with open(path, "wb") as fh:
                fh.write(b"R" * 80)

        orig_probe = gap.probe_duration_ms
        orig_slice = gap.slice_gap_wav
        gap.probe_duration_ms = fake_probe
        gap.slice_gap_wav = fake_slice
        try:
            out = gap.transcribe_medical_gaps(
                transcript=transcript,
                gaps=[{"id": "g1", "startMs": 1000, "endMs": 4000, "placeholder": filling}],
                recording_bytes=b"audio-bytes",
                recording_suffix=".m4a",
                ffmpeg_path="ffmpeg",
                ffprobe_path="ffprobe",
                s3_client=s3,
                transcribe_client=transcribe,
                bucket="quickscribe-hippa-backet",
                user_id="user-1",
                job_id="job-1",
                kms_arn="arn:aws:kms:eu-north-1:1:key/x",
                locale="he",
                timeout_sec=5,
                poll_sec=0,
                sleep_fn=lambda _s: None,
                engine="batch",
            )
        finally:
            gap.probe_duration_ms = orig_probe
            gap.slice_gap_wav = orig_slice

        self.assertIn("[קטע לא תומלל 00:01–00:04]", out["transcript"])
        self.assertEqual(out["gaps"][0]["status"], "failed")
        transcribe.start_transcription_job.assert_called_once()
        transcribe.delete_transcription_job.assert_called()

    def test_completed_job_stitches_text(self):
        filling = gap.gap_placeholder_text(1000, 4000, failed=False, locale="he")
        transcript = f"hello {filling} world"
        payload = json.dumps({"results": {"transcripts": [{"transcript": "recovered words"}]}}).encode("utf-8")
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": io.BytesIO(payload)}
        transcribe = MagicMock()
        transcribe.get_transcription_job.return_value = {
            "TranscriptionJob": {"TranscriptionJobStatus": "COMPLETED"}
        }

        def fake_probe(*_a, **_k):
            return 10000

        def fake_slice(*_a, **_k):
            with open(_a[2], "wb") as fh:
                fh.write(b"R" * 80)

        orig_probe = gap.probe_duration_ms
        orig_slice = gap.slice_gap_wav
        gap.probe_duration_ms = fake_probe
        gap.slice_gap_wav = fake_slice
        try:
            out = gap.transcribe_medical_gaps(
                transcript=transcript,
                gaps=[{"id": "g1", "startMs": 1000, "endMs": 4000, "placeholder": filling}],
                recording_bytes=b"audio-bytes",
                recording_suffix=".m4a",
                ffmpeg_path="ffmpeg",
                ffprobe_path="ffprobe",
                s3_client=s3,
                transcribe_client=transcribe,
                bucket="quickscribe-hippa-backet",
                user_id="user-1",
                job_id="job-1",
                kms_arn="",
                locale="he",
                timeout_sec=5,
                poll_sec=0,
                sleep_fn=lambda _s: None,
                engine="batch",
            )
        finally:
            gap.probe_duration_ms = orig_probe
            gap.slice_gap_wav = orig_slice

        self.assertIn("recovered words", out["transcript"])
        self.assertNotIn("בהשלמה", out["transcript"])
        self.assertEqual(out["gaps"][0]["status"], "ok")


class StreamEngineTests(unittest.TestCase):
    def test_stream_engine_stitches_without_batch_job(self):
        filling = gap.gap_placeholder_text(1000, 4000, failed=False, locale="he")
        transcript = f"hello {filling} world"
        s3 = MagicMock()
        transcribe = MagicMock()

        def fake_probe(*_a, **_k):
            return 10000

        def fake_slice(*_a, **_k):
            with open(_a[2], "wb") as fh:
                fh.write(b"R" * 80)

        orig_probe = gap.probe_duration_ms
        orig_slice = gap.slice_gap_wav
        orig_pcm = gap.pcm_bytes_from_wav
        gap.probe_duration_ms = fake_probe
        gap.slice_gap_wav = fake_slice
        gap.pcm_bytes_from_wav = lambda *_a, **_k: b"\x00\x00" * 80
        try:
            out = gap.transcribe_medical_gaps(
                transcript=transcript,
                gaps=[{"id": "g1", "startMs": 1000, "endMs": 4000, "placeholder": filling}],
                recording_bytes=b"audio-bytes",
                recording_suffix=".m4a",
                ffmpeg_path="ffmpeg",
                ffprobe_path="ffprobe",
                s3_client=s3,
                transcribe_client=transcribe,
                bucket="quickscribe-hippa-backet",
                user_id="user-1",
                job_id="job-1",
                kms_arn="",
                locale="he",
                timeout_sec=5,
                engine="stream",
                stream_transcribe_fn=lambda *_a, **_k: "recovered stream",
            )
        finally:
            gap.probe_duration_ms = orig_probe
            gap.slice_gap_wav = orig_slice
            gap.pcm_bytes_from_wav = orig_pcm

        self.assertIn("recovered stream", out["transcript"])
        self.assertEqual(out["gaps"][0]["status"], "ok")
        transcribe.start_transcription_job.assert_not_called()
        s3.put_object.assert_not_called()

    def test_stream_engine_failure_leaves_marker(self):
        filling = gap.gap_placeholder_text(1000, 4000, failed=False, locale="he")
        transcript = f"start {filling} end"

        def fake_probe(*_a, **_k):
            return 10000

        def fake_slice(*_a, **_k):
            with open(_a[2], "wb") as fh:
                fh.write(b"R" * 80)

        def boom(*_a, **_k):
            raise RuntimeError("stream denied")

        orig_probe = gap.probe_duration_ms
        orig_slice = gap.slice_gap_wav
        orig_pcm = gap.pcm_bytes_from_wav
        gap.probe_duration_ms = fake_probe
        gap.slice_gap_wav = fake_slice
        gap.pcm_bytes_from_wav = lambda *_a, **_k: b"\x00\x00" * 80
        try:
            out = gap.transcribe_medical_gaps(
                transcript=transcript,
                gaps=[{"id": "g1", "startMs": 1000, "endMs": 4000, "placeholder": filling}],
                recording_bytes=b"audio-bytes",
                recording_suffix=".m4a",
                ffmpeg_path="ffmpeg",
                ffprobe_path="ffprobe",
                s3_client=MagicMock(),
                transcribe_client=MagicMock(),
                bucket="quickscribe-hippa-backet",
                user_id="user-1",
                job_id="job-1",
                kms_arn="",
                locale="he",
                engine="stream",
                stream_transcribe_fn=boom,
            )
        finally:
            gap.probe_duration_ms = orig_probe
            gap.slice_gap_wav = orig_slice
            gap.pcm_bytes_from_wav = orig_pcm

        self.assertIn("[קטע לא תומלל 00:01–00:04]", out["transcript"])
        self.assertEqual(out["gaps"][0]["status"], "failed")

    def test_pcm_buffer_stitches_without_s3(self):
        filling = gap.gap_placeholder_text(1000, 4000, failed=False, locale="he")
        out = gap.recover_gaps_from_pcm(
            transcript=f"hello {filling} world",
            gaps=[{"id": "g1", "startMs": 1000, "endMs": 4000, "placeholder": filling}],
            pcm=b"\x00\x00" * 80,
            stream_transcribe_fn=lambda *_a, **_k: "המילים שחסרו",
        )
        self.assertIn("המילים שחסרו", out["transcript"])
        self.assertNotIn("בהשלמה", out["transcript"])
        self.assertEqual(out["gaps"][0]["status"], "ok")
        self.assertEqual(out["engine"], "stream-pcm")

    def test_pcm_stream_helper_returns_session_text(self):
        class FakeSession:
            def __init__(self, **_kw):
                self._audio_deque_bytes = 0
                self._error = None
                self.fed = []

            def start(self, timeout_sec=30):
                self.started = timeout_sec

            def feed_audio(self, chunk):
                self.fed.append(chunk)

            def stop(self, timeout_sec=120):
                return "from session"

        text = gap.transcribe_pcm_via_stream(
            b"\x00\x00" * 200,
            region="eu-west-1",
            session_factory=FakeSession,
        )
        self.assertEqual(text, "from session")


if __name__ == "__main__":
    unittest.main()
