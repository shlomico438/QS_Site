#!/usr/bin/env python3
"""Doctors with qs_medical_user cookie must never receive the regular Core app."""

from __future__ import annotations

import unittest


class MedicalUserCoreRedirectTests(unittest.TestCase):
    def test_core_home_redirects_when_lock_cookie_set(self):
        import siteapp

        client = siteapp.app.test_client()
        client.set_cookie("qs_medical_user", "1")
        resp = client.get("/", follow_redirects=False)
        self.assertEqual(resp.status_code, 302)
        self.assertTrue(str(resp.headers.get("Location") or "").endswith("/medical") or "/medical?" in str(resp.headers.get("Location") or ""))

    def test_english_core_home_redirects_to_en_medical(self):
        import siteapp

        client = siteapp.app.test_client()
        client.set_cookie("qs_medical_user", "1")
        resp = client.get("/en?open=job_1", follow_redirects=False)
        self.assertEqual(resp.status_code, 302)
        loc = str(resp.headers.get("Location") or "")
        self.assertIn("/en/medical", loc)
        self.assertIn("open=job_1", loc)

    def test_core_home_stays_regular_without_cookie(self):
        import siteapp

        client = siteapp.app.test_client()
        resp = client.get("/", follow_redirects=False)
        self.assertEqual(resp.status_code, 200)

    def test_products_page_not_redirected(self):
        import siteapp

        client = siteapp.app.test_client()
        client.set_cookie("qs_medical_user", "1")
        resp = client.get("/en/products", follow_redirects=False)
        self.assertNotEqual(resp.status_code, 302)


if __name__ == "__main__":
    unittest.main()
