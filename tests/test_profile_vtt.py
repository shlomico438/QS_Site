#!/usr/bin/env python3
"""Profiling VTT API: screen layout, WebVTT, and secret gate."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch


class SubtitleServerLayoutTests(unittest.TestCase):
    def test_vtt_header_and_timestamps(self):
        from qs_subtitle_server import segments_to_adapted_vtt

        segments = [
            {"start": 0.0, "end": 2.0, "text": "שלום עולם"},
        ]
        vtt, cues = segments_to_adapted_vtt(segments, width_px=1920, height_px=1080)
        self.assertTrue(vtt.startswith("WEBVTT"))
        self.assertIn("-->", vtt)
        self.assertIn("שלום עולם", vtt)
        self.assertGreaterEqual(len(cues), 1)

    def test_narrow_portrait_splits_long_hebrew_line(self):
        from qs_subtitle_server import segments_to_adapted_vtt

        text = (
            "זה משפט ארוך מאוד שצריך להתאים לרוחב מסך אנכי של טיקטוק "
            "ולכן הוא לא יכול להישאר בשורה אחת על המסך"
        )
        vtt, cues = segments_to_adapted_vtt(
            [{"start": 0.0, "end": 8.0, "text": text}],
            width_px=1080,
            height_px=1920,
            style_key="tiktok",
        )
        self.assertTrue(vtt.startswith("WEBVTT"))
        self.assertGreater(len(cues), 1)
        joined = " ".join(" ".join(str(c.get("text") or "").split()) for c in cues)
        for token in ("משפט", "מסך", "טיקטוק"):
            self.assertIn(token, joined)

    def test_semantic_split_on_long_sentence_end(self):
        from qs_subtitle_server import process_whisper_segments

        segs = process_whisper_segments([
            {
                "start": 0.0,
                "end": 10.0,
                "text": (
                    "זה משפט ראשון שמסתיים בנקודה אחרי כמה מילים. "
                    "וזה משפט שני שנמשך מספיק כדי לחרוג ממגבלת התווים של כתובית."
                ),
            }
        ])
        self.assertGreaterEqual(len(segs), 2)
        self.assertTrue(any("ראשון" in str(s.get("text") or "") for s in segs))


class ProfileVttAuthTests(unittest.TestCase):
    def test_s3_key_detection(self):
        import siteapp

        self.assertTrue(siteapp._is_profile_vtt_s3_key("users/profile/input/job_1.mp3"))
        self.assertFalse(siteapp._is_profile_vtt_s3_key("users/anonymous/input/job_1.mp3"))

    def test_merge_keeps_profile_flags(self):
        import siteapp

        job_id = "job_profile_merge_test"
        siteapp.pending_job_info[job_id] = {
            "profile_vtt": True,
            "profile_width": 1080,
            "input_s3_key": "old",
        }
        try:
            merged = siteapp._merge_profile_pending_flags(job_id, {"input_s3_key": "new"})
            self.assertTrue(merged["profile_vtt"])
            self.assertEqual(merged["profile_width"], 1080)
            self.assertEqual(merged["input_s3_key"], "new")
        finally:
            siteapp.pending_job_info.pop(job_id, None)

    def test_localhost_allowed_when_secret_unset(self):
        import siteapp

        with patch.dict(os.environ, {"QS_PROFILE_API_SECRET": ""}, clear=False):
            with siteapp.app.test_request_context("/api/profile/vtt", headers={"Host": "127.0.0.1:8000"}):
                self.assertTrue(siteapp._profile_api_authorized())
            with siteapp.app.test_request_context(
                "/api/profile/vtt", headers={"Host": "www.getquickscribe.com"}
            ):
                self.assertFalse(siteapp._profile_api_authorized())

    def test_secret_header_required_when_configured(self):
        import siteapp

        with patch.dict(os.environ, {"QS_PROFILE_API_SECRET": "s3cret"}, clear=False):
            with siteapp.app.test_request_context("/api/profile/vtt", headers={"Host": "127.0.0.1:8000"}):
                self.assertFalse(siteapp._profile_api_authorized())
            with siteapp.app.test_request_context(
                "/api/profile/vtt",
                headers={"Host": "127.0.0.1:8000", "X-QS-Profile-Secret": "s3cret"},
            ):
                self.assertTrue(siteapp._profile_api_authorized())
            with siteapp.app.test_request_context(
                "/api/profile/vtt",
                headers={"Host": "127.0.0.1:8000", "X-QS-Profile-Secret": "wrong"},
            ):
                self.assertFalse(siteapp._profile_api_authorized())

    def test_gpt_ready_waits_for_clean_transcript(self):
        import siteapp

        with patch.object(siteapp, "_gpt_disabled", return_value=False):
            self.assertFalse(siteapp._profile_gpt_ready({"status": "completed", "server_gpt_pending": True}))
            self.assertTrue(siteapp._profile_gpt_ready({
                "status": "completed",
                "formatted": {"clean_transcript": "שלום"},
            }))
            self.assertTrue(siteapp._profile_gpt_ready({
                "status": "completed",
                "post_summary_formatting_done": True,
            }))

    def test_missing_file_returns_400(self):
        import siteapp

        with patch.dict(os.environ, {"QS_PROFILE_API_SECRET": "s3cret"}, clear=False):
            client = siteapp.app.test_client()
            resp = client.post("/api/profile/vtt", headers={"X-QS-Profile-Secret": "s3cret"})
            self.assertEqual(resp.status_code, 400)
            body = resp.get_json()
            self.assertEqual(body.get("error"), "file_required")


if __name__ == "__main__":
    unittest.main()
