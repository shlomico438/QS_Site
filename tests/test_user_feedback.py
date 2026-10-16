#!/usr/bin/env python3
"""Public reviews persist and aggregate for /reviews."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch


class FeedbackDisplayNameTests(unittest.TestCase):
    def test_first_name_only(self):
        import siteapp

        self.assertEqual(siteapp._feedback_public_display_name("דביר יוזף"), "דביר")
        self.assertEqual(siteapp._feedback_public_display_name("Ada Lovelace"), "Ada")

    def test_drops_emailish(self):
        import siteapp

        self.assertEqual(siteapp._feedback_public_display_name("a@b.com"), "")


class FeedbackAggregateTests(unittest.TestCase):
    def test_empty(self):
        import siteapp

        self.assertEqual(siteapp._user_feedback_aggregate([]), {"count": 0, "average": 0.0})

    def test_average(self):
        import siteapp

        out = siteapp._user_feedback_aggregate([
            {"stars": 5},
            {"stars": 4},
            {"stars": 5},
        ])
        self.assertEqual(out["count"], 3)
        self.assertEqual(out["average"], 4.7)


class PersistUserFeedbackTests(unittest.TestCase):
    def test_skips_empty(self):
        import siteapp

        self.assertFalse(siteapp._persist_user_feedback(like="", improve="", stars=0))

    def test_posts_public_row(self):
        import siteapp

        fake = MagicMock()
        fake.status_code = 201
        fake.text = ""
        with patch.object(
            siteapp, "_supabase_rest_config", return_value=("https://sb.example", "key", {})
        ), patch.object(siteapp.requests, "post", return_value=fake) as post:
            ok = siteapp._persist_user_feedback(
                email="a@b.com",
                name="Dana Cohen",
                like="fast",
                improve="ui",
                stars=5,
                source="post_export",
            )
        self.assertTrue(ok)
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["stars"], 5)
        self.assertTrue(payload["is_public"])
        self.assertEqual(payload["display_name"], "Dana")
        self.assertEqual(payload["liked"], "fast")
        self.assertEqual(payload["improve"], "ui")


class ReviewsRouteTests(unittest.TestCase):
    def test_reviews_ok(self):
        import siteapp

        with patch.object(
            siteapp,
            "_list_public_user_feedback",
            return_value=[{"id": "1", "stars": 5, "liked": "good", "display_name": "Dana", "created_at": "2026-10-16"}],
        ):
            client = siteapp.app.test_client()
            res = client.get("/reviews")
        self.assertEqual(res.status_code, 200)
        self.assertIn(b"Dana", res.data)
        self.assertIn(b"AggregateRating", res.data)


if __name__ == "__main__":
    unittest.main()
