#!/usr/bin/env python3
"""Movie burn status must survive multi-instance AWS and RunPod-wrapped callbacks."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch


class MergeBurnInfoTests(unittest.TestCase):
    def test_completed_on_disk_wins_over_processing_in_memory(self):
        from siteapp import _merge_burn_info

        mem = {"status": "processing", "runpod_run_id": "rp-1", "updated_at": 10}
        disk = {"status": "completed", "output_s3_key": "users/u/output/v.mp4", "updated_at": 5}
        merged = _merge_burn_info(mem, disk)
        self.assertEqual(merged["status"], "completed")
        self.assertEqual(merged["output_s3_key"], "users/u/output/v.mp4")
        self.assertEqual(merged["runpod_run_id"], "rp-1")


class ParseBurnCallbackTaskIdTests(unittest.TestCase):
    def test_prefers_nested_task_id_over_runpod_envelope_id(self):
        from siteapp import _parse_burn_callback_task_id

        body = {
            "id": "runpod-job-111",
            "status": "COMPLETED",
            "output": {
                "task_id": "5fd95f3d-0b8b-4007-9f8a-1c67c38b8f78",
                "status": "completed",
                "output_s3_key": "users/u/output/v.mp4",
            },
        }
        self.assertEqual(
            _parse_burn_callback_task_id(body),
            "5fd95f3d-0b8b-4007-9f8a-1c67c38b8f78",
        )

    def test_maps_runpod_envelope_id_when_output_lacks_task_id(self):
        import siteapp

        siteapp.burn_tasks["our-task"] = {"runpod_run_id": "runpod-job-222", "status": "processing"}
        try:
            self.assertEqual(
                siteapp._parse_burn_callback_task_id({
                    "id": "runpod-job-222",
                    "status": "COMPLETED",
                    "output": {"output_s3_key": "users/u/output/v.mp4"},
                }),
                "our-task",
            )
        finally:
            siteapp.burn_tasks.pop("our-task", None)


class ReconcileBurnTaskTests(unittest.TestCase):
    def test_marks_completed_when_output_object_is_fresh(self):
        import siteapp

        task_id = "task-s3"
        info = {
            "status": "processing",
            "bucket": "qs-bucket",
            "output_s3_key": "users/u/output/v_with_subtitles.mp4",
            "started_at": 1_000.0,
            "user_id": "u",
        }
        siteapp.burn_tasks[task_id] = dict(info)
        try:
            with patch.object(siteapp, "_s3_object_is_fresh", return_value=True), patch.object(
                siteapp, "_persist_burn_task_s3"
            ):
                out = siteapp._reconcile_burn_task(task_id, info)
            self.assertEqual(out["status"], "completed")
            self.assertEqual(out["output_s3_key"], "users/u/output/v_with_subtitles.mp4")
        finally:
            siteapp.burn_tasks.pop(task_id, None)

    def test_marks_failed_when_runpod_job_failed(self):
        import siteapp

        task_id = "task-rp-fail"
        info = {
            "status": "processing",
            "bucket": "qs-bucket",
            "output_s3_key": "users/u/output/v_with_subtitles.mp4",
            "started_at": 1_000.0,
            "runpod_run_id": "rp-fail",
            "endpoint_id": "cpu-ep",
        }
        siteapp.burn_tasks[task_id] = dict(info)
        try:
            with patch.object(siteapp, "_s3_object_is_fresh", return_value=False), patch.object(
                siteapp, "_fetch_runpod_job_status", return_value=("FAILED", {}, "ffmpeg crashed")
            ), patch.object(siteapp, "_persist_burn_task_s3"):
                out = siteapp._reconcile_burn_task(task_id, info)
            self.assertEqual(out["status"], "failed")
            self.assertIn("ffmpeg crashed", out.get("error") or "")
        finally:
            siteapp.burn_tasks.pop(task_id, None)


class BurnCallbackBaseTests(unittest.TestCase):
    def test_simulation_uses_request_host_not_production_public_base(self):
        import siteapp

        req = SimpleNamespace(
            url_root="http://qu-sim.ecs.eu-north-1.on.aws/",
            host="qu-sim.ecs.eu-north-1.on.aws",
            headers={"X-Forwarded-Proto": "https"},
        )
        with patch.object(siteapp, "SIMULATION_MODE", True), patch.dict(
            "os.environ",
            {"PUBLIC_BASE_URL": "https://www.getquickscribe.com", "SIMULATION_PUBLIC_BASE_URL": ""},
            clear=False,
        ):
            self.assertEqual(
                siteapp._burn_callback_base(req),
                "https://qu-sim.ecs.eu-north-1.on.aws",
            )


if __name__ == "__main__":
    unittest.main()
