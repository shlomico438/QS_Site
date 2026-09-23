#!/usr/bin/env python3
"""Simulation checkout must persist across ECS tasks (not memory-only)."""

from __future__ import annotations

import unittest
from unittest.mock import patch


class CardcomMemoryStoreTests(unittest.TestCase):
    def test_simulation_does_not_force_memory_store(self):
        import cardcom_payments as cc

        cc._cardcom_db_available = None
        with patch.object(cc, "_simulation_mode", return_value=True):
            self.assertFalse(cc._use_memory_store())
        cc._cardcom_db_available = False
        with patch.object(cc, "_simulation_mode", return_value=True):
            self.assertTrue(cc._use_memory_store())
        cc._cardcom_db_available = None

    def test_hydrate_sim_token_from_low_profile_id(self):
        import cardcom_payments as cc

        row = cc._hydrate_sim_token({"order_id": "qs_cc_1", "low_profile_id": "sim:abc123"})
        self.assertEqual(row["sim_token"], "abc123")
        kept = cc._hydrate_sim_token({"sim_token": "kept", "low_profile_id": "sim:other"})
        self.assertEqual(kept["sim_token"], "kept")


if __name__ == "__main__":
    unittest.main()
