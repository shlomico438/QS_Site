#!/usr/bin/env python3
"""Guest → user claim must not treat R2 timeouts as missing media."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError


def _client_error(code, http=None):
    payload = {"Error": {"Code": code, "Message": code}}
    if http is not None:
        payload["ResponseMetadata"] = {"HTTPStatusCode": http}
    return ClientError(payload, "HeadObject")


class RewriteAnonymousKeyTests(unittest.TestCase):
    def test_rewrites_input_and_output(self):
        import siteapp

        uid = "10ec2c3b-5173-4da1-bb11-06249dd46d11"
        self.assertEqual(
            siteapp._rewrite_anonymous_standard_s3_key(
                "users/anonymous/input/job_1.mkv", uid
            ),
            f"users/{uid}/input/job_1.mkv",
        )
        self.assertEqual(
            siteapp._rewrite_anonymous_standard_s3_key(
                "users/anonymous/output/job_1.json", uid
            ),
            f"users/{uid}/output/job_1.json",
        )

    def test_rejects_non_anonymous(self):
        import siteapp

        self.assertIsNone(
            siteapp._rewrite_anonymous_standard_s3_key(
                "users/abc/input/job_1.mkv", "abc"
            )
        )


class S3ObjectStatTests(unittest.TestCase):
    def test_exists(self):
        import siteapp

        client = MagicMock()
        client.head_object.return_value = {"ContentLength": 12}
        with patch.object(siteapp, "_s3_boto_client", return_value=client):
            self.assertEqual(siteapp._s3_object_stat("b", "k"), "exists")
            self.assertTrue(siteapp._s3_object_exists("b", "k"))

    def test_true_404_is_missing(self):
        import siteapp

        client = MagicMock()
        client.head_object.side_effect = _client_error("404", http=404)
        with patch.object(siteapp, "_s3_boto_client", return_value=client):
            self.assertEqual(siteapp._s3_object_stat("b", "k"), "missing")
            self.assertFalse(siteapp._s3_object_exists("b", "k"))

    def test_timeout_is_error_not_missing(self):
        import siteapp

        client = MagicMock()
        client.head_object.side_effect = TimeoutError("read timeout")
        with patch.object(siteapp, "_s3_boto_client", return_value=client):
            self.assertEqual(siteapp._s3_object_stat("b", "k"), "error")
            self.assertFalse(siteapp._s3_object_exists("b", "k"))

    def test_forbidden_is_error_not_missing(self):
        import siteapp

        client = MagicMock()
        client.head_object.side_effect = _client_error("403", http=403)
        with patch.object(siteapp, "_s3_boto_client", return_value=client):
            self.assertEqual(siteapp._s3_object_stat("b", "k"), "error")


class CopyThenDeleteTimeoutTests(unittest.TestCase):
    def test_copy_uses_long_read_timeout(self):
        import siteapp

        client = MagicMock()
        with patch.object(siteapp, "_s3_boto_client", return_value=client) as make_client, patch.object(
            siteapp, "_s3_object_stat", side_effect=["missing", "exists"]
        ):
            ok = siteapp._s3_copy_then_delete("bucket", "users/anonymous/input/a.mkv", "users/u/input/a.mkv")
        self.assertTrue(ok)
        kwargs = make_client.call_args.kwargs
        self.assertGreaterEqual(int(kwargs.get("read_timeout") or 0), 60)
        client.copy_object.assert_called_once()

    def test_stat_error_on_source_raises_instead_of_skip(self):
        import siteapp

        with patch.object(siteapp, "_s3_boto_client", return_value=MagicMock()), patch.object(
            siteapp, "_s3_object_stat", side_effect=["missing", "error"]
        ):
            with self.assertRaises(RuntimeError):
                siteapp._s3_copy_then_delete("bucket", "src", "dst")


if __name__ == "__main__":
    unittest.main()
