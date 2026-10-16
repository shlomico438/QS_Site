#!/usr/bin/env python3
"""Movie burn status must survive multi-instance AWS and RunPod-wrapped callbacks."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


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


class BurnEngineTests(unittest.TestCase):
    def test_prefers_ecs_over_runpod_and_lambda(self):
        import siteapp

        with patch.object(siteapp, "SIMULATION_MODE", False), patch.dict(
            "os.environ",
            {
                "BURN_ECS_TASK_DEFINITION": "quickscribe-burn-subtitles",
                "BURN_ECS_SUBNETS": "subnet-aaa",
                "BURN_LAMBDA_FUNCTION_NAME": "quickscribe-burn-subtitles",
                "RUNPOD_API_KEY": "k",
                "RUNPOD_CPU_ENDPOINT_ID": "cpu-ep",
            },
            clear=False,
        ):
            self.assertEqual(siteapp._burn_engine(), "ecs")

    def test_falls_back_to_runpod_without_ecs(self):
        import siteapp

        with patch.object(siteapp, "SIMULATION_MODE", False), patch.object(
            siteapp, "RUNPOD_API_KEY", "k"
        ), patch.object(siteapp, "RUNPOD_CPU_ENDPOINT_ID", "cpu-ep"), patch.dict(
            "os.environ",
            {
                "BURN_ECS_TASK_DEFINITION": "",
                "BURN_ECS_SUBNETS": "",
                "BURN_LAMBDA_FUNCTION_NAME": "",
                "BURN_LAMBDA_FUNCTION_ARN": "",
            },
            clear=False,
        ):
            self.assertEqual(siteapp._burn_engine(), "runpod")

    def test_falls_back_to_lambda_without_ecs_or_runpod(self):
        import siteapp

        with patch.object(siteapp, "SIMULATION_MODE", False), patch.object(
            siteapp, "RUNPOD_API_KEY", ""
        ), patch.dict(
            "os.environ",
            {
                "BURN_ECS_TASK_DEFINITION": "",
                "BURN_ECS_SUBNETS": "",
                "BURN_LAMBDA_FUNCTION_NAME": "quickscribe-burn-subtitles",
                "RUNPOD_API_KEY": "",
                "RUNPOD_CPU_ENDPOINT_ID": "",
            },
            clear=False,
        ):
            self.assertEqual(siteapp._burn_engine(), "lambda")


class QueueBurnTaskOnEcsTests(unittest.TestCase):
    def test_run_task_receives_burn_payload_env(self):
        import siteapp

        fake_ecs = MagicMock()
        fake_ecs.run_task.return_value = {
            "tasks": [{"taskArn": "arn:aws:ecs:eu-north-1:123:task/default/abc"}],
            "failures": [],
        }
        worker_input = {
            "task": "burn_subtitles",
            "task_id": "t1",
            "input_video_url": "https://example/v",
            "input_srt_url": "https://example/s",
            "output_upload_url": "https://example/o",
            "output_s3_key": "users/u/output/v.mp4",
            "callback_url": "https://site/api/burn_subtitles_callback",
        }
        meta = {
            "subtitle_format": "ass",
            "output_s3_key": "users/u/output/v.mp4",
            "bucket": "qs-bucket",
            "user_id": "u",
            "started_at": 1.0,
        }
        with patch.dict(
            "os.environ",
            {
                "BURN_ECS_CLUSTER": "default",
                "BURN_ECS_TASK_DEFINITION": "quickscribe-burn-subtitles",
                "BURN_ECS_SUBNETS": "subnet-a,subnet-b",
                "BURN_ECS_SECURITY_GROUPS": "sg-1",
                "BURN_ECS_ASSIGN_PUBLIC_IP": "ENABLED",
                "BURN_ECS_CONTAINER_NAME": "burn",
                "AWS_REGION": "eu-north-1",
            },
            clear=False,
        ), patch.object(
            siteapp, "_prepare_burn_worker_input", return_value=(worker_input, meta)
        ), patch.object(siteapp, "_save_burn_task"), patch(
            "boto3.client", return_value=fake_ecs
        ), patch.object(siteapp.threading, "Thread"):
            siteapp._queue_burn_task_on_ecs(
                task_id="t1",
                input_s3_key="users/u/input/v.mp4",
                segments=[{"text": "hi"}],
                user_id="u",
                callback_url="https://site/api/burn_subtitles_callback",
            )

        kwargs = fake_ecs.run_task.call_args.kwargs
        self.assertEqual(kwargs["cluster"], "default")
        self.assertEqual(kwargs["taskDefinition"], "quickscribe-burn-subtitles")
        self.assertNotIn("launchType", kwargs)
        cps = kwargs["capacityProviderStrategy"]
        self.assertEqual(cps[0]["capacityProvider"], "FARGATE_SPOT")
        self.assertEqual(cps[1]["capacityProvider"], "FARGATE")
        awsvpc = kwargs["networkConfiguration"]["awsvpcConfiguration"]
        self.assertEqual(awsvpc["subnets"], ["subnet-a", "subnet-b"])
        self.assertEqual(awsvpc["securityGroups"], ["sg-1"])
        env = {
            e["name"]: e["value"]
            for e in kwargs["overrides"]["containerOverrides"][0]["environment"]
        }
        self.assertIn("BURN_TASK_JSON", env)
        self.assertEqual(env["BURN_ENGINE"], "ecs")
        self.assertIn('"task_id":"t1"', env["BURN_TASK_JSON"])


if __name__ == "__main__":
    unittest.main()
