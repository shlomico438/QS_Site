#!/usr/bin/env python3
"""Unit tests for email_risk_check."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from email_risk_check import (
    assess_email_risk,
    extract_email_domain,
    is_disposable_domain,
    load_disposable_domains,
)


class EmailRiskCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.blocklist_path = Path(self.tmp.name) / "blocklist.txt"
        self.blocklist_path.write_text(
            "0-mail.com\n"
            "GONRR.NET\n"
            "\n"
            "  example-disposable.test  \n",
            encoding="utf-8",
        )
        load_disposable_domains(self.blocklist_path, force_reload=True)

    def tearDown(self):
        self.tmp.cleanup()
        load_disposable_domains(force_reload=True)

    def test_known_disposable_domain(self):
        result = assess_email_risk(
            "abc@gonrr.net",
            blocklist=load_disposable_domains(self.blocklist_path),
            rdap_fetcher=lambda _d: 45,
        )
        self.assertTrue(result["disposable"])
        self.assertIn("disposable_email_domain", result["reasons"])
        self.assertIn("new_domain_less_than_6_months", result["reasons"])
        self.assertEqual(result["score"], 140)
        self.assertFalse(result["allowed"])

    def test_new_domain(self):
        result = assess_email_risk(
            "user@fresh-startup.io",
            blocklist=load_disposable_domains(self.blocklist_path),
            rdap_fetcher=lambda _d: 10,
        )
        self.assertFalse(result["disposable"])
        self.assertEqual(result["domainAgeDays"], 10)
        self.assertIn("new_domain_less_than_6_months", result["reasons"])
        self.assertIn("very_new_domain", result["reasons"])
        self.assertEqual(result["score"], 70)
        self.assertTrue(result["allowed"])
        self.assertEqual(result["action"], "verify")

    def test_gmail_user(self):
        result = assess_email_risk(
            "user@gmail.com",
            blocklist=load_disposable_domains(self.blocklist_path),
            rdap_fetcher=lambda _d: self.fail("RDAP should be skipped for Gmail"),
        )
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["reasons"], [])
        self.assertIsNone(result["domainAgeDays"])
        self.assertTrue(result["allowed"])

    def test_rdap_unavailable(self):
        result = assess_email_risk(
            "user@legit-company.co.il",
            blocklist=load_disposable_domains(self.blocklist_path),
            rdap_fetcher=lambda _d: None,
        )
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["reasons"], [])
        self.assertIsNone(result["domainAgeDays"])
        self.assertTrue(result["allowed"])

    def test_mixed_uppercase_domain(self):
        domain = extract_email_domain("User@0-Mail.COM")
        self.assertEqual(domain, "0-mail.com")
        self.assertTrue(
            is_disposable_domain(domain, blocklist=load_disposable_domains(self.blocklist_path))
        )
        result = assess_email_risk(
            "User@0-Mail.COM",
            blocklist=load_disposable_domains(self.blocklist_path),
            rdap_fetcher=lambda _d: None,
        )
        self.assertTrue(result["disposable"])
        self.assertEqual(result["score"], 100)
        self.assertFalse(result["allowed"])


if __name__ == "__main__":
    unittest.main()
