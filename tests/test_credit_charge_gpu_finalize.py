#!/usr/bin/env python3
"""GPU-finalize credit charge uses file duration and is idempotent via _charge_job_credits."""

from __future__ import annotations

import math
import unittest
from unittest.mock import patch


class CreditMinutesFromDurationTests(unittest.TestCase):
    def test_ceil_minutes(self):
        from siteapp import _credit_minutes_from_duration

        self.assertEqual(_credit_minutes_from_duration(0), 0)
        self.assertEqual(_credit_minutes_from_duration(1), 1)
        self.assertEqual(_credit_minutes_from_duration(60), 1)
        self.assertEqual(_credit_minutes_from_duration(61), 2)
        self.assertEqual(_credit_minutes_from_duration(416.592), 7)


class ChargeCreditsOnGpuFinalizeTests(unittest.TestCase):
    def test_passes_stashed_duration_and_clears_context(self):
        import siteapp

        calls = []

        def fake_charge(user_id, runpod_job_id, segments, input_s3_key, result=None, pending_info=None, file_duration_sec=None):
            calls.append({
                "user_id": user_id,
                "job_id": runpod_job_id,
                "input_s3_key": input_s3_key,
                "file_duration_sec": file_duration_sec,
                "pending_info": pending_info,
            })
            return {
                "credit_minutes_used": math.ceil(float(file_duration_sec) / 60.0),
                "credit_minutes": 100,
                "file_duration_seconds": file_duration_sec,
            }

        job_id = "job_test_finalize_charge"
        siteapp.pending_credit_charge_context[job_id] = {
            "user_id": "user-1",
            "input_s3_key": "users/user-1/input/a.mp3",
            "credit_file_duration_sec": 416.592,
            "bucket": "qs-bucket",
        }
        try:
            with patch.object(siteapp, "_charge_job_credits", side_effect=fake_charge):
                out = siteapp._charge_credits_on_gpu_finalize(
                    user_id="user-1",
                    job_id=job_id,
                    segments=[{"start": 0, "end": 10, "text": "hi"}],
                    input_s3_key="users/user-1/input/a.mp3",
                    pending_info={"credit_file_duration_sec": 416.592},
                )
        finally:
            siteapp.pending_credit_charge_context.pop(job_id, None)

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["file_duration_sec"], 416.592)
        self.assertEqual(out.get("credit_minutes_used"), 7)
        self.assertNotIn(job_id, siteapp.pending_credit_charge_context)

    def test_falls_back_to_job_metadata_duration(self):
        import siteapp

        calls = []

        def fake_charge(user_id, runpod_job_id, segments, input_s3_key, result=None, pending_info=None, file_duration_sec=None):
            calls.append({"file_duration_sec": file_duration_sec})
            return {"credit_minutes_used": 7, "credit_minutes": 50}

        with patch.object(siteapp, "_charge_job_credits", side_effect=fake_charge), patch.object(
            siteapp,
            "_get_job_row_by_runpod_job_id",
            return_value={
                "metadata": {"qs_trigger": {"credit_file_duration_sec": 416.592}},
                "input_s3_key": "users/u/input/x.mp3",
            },
        ):
            siteapp._charge_credits_on_gpu_finalize(
                user_id="u",
                job_id="job_meta_dur",
                segments=[],
                input_s3_key="users/u/input/x.mp3",
                pending_info=None,
            )

        self.assertEqual(calls[0]["file_duration_sec"], 416.592)


class EarlyGpuCreditGateTests(unittest.TestCase):
    def test_unknown_duration_defers_early_gpu(self):
        import siteapp

        with patch.object(siteapp, "_credits_gate_applies", return_value=True):
            allow, reason = siteapp._credits_allow_early_gpu_dispatch(
                False,
                {"userId": "u1"},
                user_id="u1",
            )
        self.assertFalse(allow)
        self.assertEqual(reason, "duration_unknown_defer_gpu")

    def test_known_duration_requires_balance(self):
        import siteapp

        with patch.object(siteapp, "_credits_gate_applies", return_value=True), patch.object(
            siteapp,
            "_check_credits_for_duration",
            return_value={"ok": False, "error": "insufficient_credits"},
        ):
            allow, reason = siteapp._credits_allow_early_gpu_dispatch(
                False,
                {"userId": "u1", "mediaDurationSec": 2304},
                user_id="u1",
            )
        self.assertFalse(allow)
        self.assertEqual(reason, "insufficient_credits")

    def test_known_duration_with_balance_allows(self):
        import siteapp

        with patch.object(siteapp, "_credits_gate_applies", return_value=True), patch.object(
            siteapp,
            "_check_credits_for_duration",
            return_value={"ok": True, "credit_minutes": 100, "required_minutes": 39},
        ):
            allow, reason = siteapp._credits_allow_early_gpu_dispatch(
                False,
                {"userId": "u1", "mediaDurationSec": 2304},
                user_id="u1",
            )
        self.assertTrue(allow)
        self.assertEqual(reason, "credits_ok")


if __name__ == "__main__":
    unittest.main()
