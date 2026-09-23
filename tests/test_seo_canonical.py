#!/usr/bin/env python3
"""SEO head URLs always use www.getquickscribe.com, never ECS *.on.aws."""

from __future__ import annotations

import unittest
from unittest.mock import patch


class SeoCanonicalOriginTests(unittest.TestCase):
    def test_rejects_on_aws_host(self):
        import siteapp

        with patch.dict(
            "os.environ",
            {"QS_CANONICAL_ORIGIN": "https://qu-69459015c3b2436ea0e90ed07c69522d.ecs.eu-north-1.on.aws"},
            clear=False,
        ):
            self.assertEqual(siteapp._seo_canonical_origin(), "https://www.getquickscribe.com")

    def test_rejects_alb_hostname(self):
        import siteapp

        with patch.dict(
            "os.environ",
            {"QS_CANONICAL_ORIGIN": "https://ecs-express-gateway-alb-8d56b504-1698335533.eu-north-1.elb.amazonaws.com"},
            clear=False,
        ):
            self.assertEqual(siteapp._seo_canonical_origin(), "https://www.getquickscribe.com")

    def test_keeps_production_domain(self):
        import siteapp

        with patch.dict(
            "os.environ",
            {"QS_CANONICAL_ORIGIN": "https://www.getquickscribe.com"},
            clear=False,
        ):
            self.assertEqual(siteapp._seo_canonical_origin(), "https://www.getquickscribe.com")


class SeoHreflangTests(unittest.TestCase):
    def test_home_and_english_home(self):
        import siteapp

        with patch.object(siteapp, "_seo_canonical_origin", return_value="https://www.getquickscribe.com"):
            home = siteapp._seo_hreflang_urls("/")
            en_home = siteapp._seo_hreflang_urls("/en")
        self.assertEqual(home["he"], "https://www.getquickscribe.com/")
        self.assertEqual(home["en"], "https://www.getquickscribe.com/en")
        self.assertEqual(en_home["he"], "https://www.getquickscribe.com/")
        self.assertEqual(en_home["en"], "https://www.getquickscribe.com/en")

    def test_medical_locale_pair(self):
        import siteapp

        with patch.object(siteapp, "_seo_canonical_origin", return_value="https://www.getquickscribe.com"):
            he = siteapp._seo_hreflang_urls("/medical")
            en = siteapp._seo_hreflang_urls("/en/medical")
        self.assertEqual(he["he"], "https://www.getquickscribe.com/medical")
        self.assertEqual(he["en"], "https://www.getquickscribe.com/en/medical")
        self.assertEqual(en["he"], he["he"])
        self.assertEqual(en["en"], he["en"])

    def test_products_locale_pair(self):
        import siteapp

        with patch.object(siteapp, "_seo_canonical_origin", return_value="https://www.getquickscribe.com"):
            he = siteapp._seo_hreflang_urls("/products")
            en = siteapp._seo_hreflang_urls("/en/products")
        self.assertEqual(he["he"], "https://www.getquickscribe.com/products")
        self.assertEqual(he["en"], "https://www.getquickscribe.com/en/products")
        self.assertEqual(en["he"], he["he"])
        self.assertEqual(en["en"], he["en"])


class ProductsLocaleRoutesTests(unittest.TestCase):
    def test_en_products_is_ok(self):
        import siteapp

        siteapp.app.config["TESTING"] = True
        with siteapp.app.test_client() as client:
            response = client.get("/en/products")
        self.assertEqual(response.status_code, 200)

    def test_en_products_slash_redirects(self):
        import siteapp

        siteapp.app.config["TESTING"] = True
        with siteapp.app.test_client() as client:
            response = client.get("/en/products/")
        self.assertEqual(response.status_code, 301)
        self.assertTrue(str(response.headers.get("Location") or "").endswith("/en/products"))


class EnglishHomeSlashTests(unittest.TestCase):
    def test_en_trailing_slash_redirects_to_en(self):
        import siteapp

        siteapp.app.config["TESTING"] = True
        with siteapp.app.test_client() as client:
            response = client.get("/en/")
        self.assertEqual(response.status_code, 301)
        location = str(response.headers.get("Location") or "")
        self.assertTrue(location.endswith("/en"), location)
        self.assertFalse(location.endswith("/en/"), location)

    def test_en_double_slash_redirects_to_en(self):
        import siteapp

        siteapp.app.config["TESTING"] = True
        with siteapp.app.test_client() as client:
            response = client.get("/en//")
        self.assertEqual(response.status_code, 301)
        location = str(response.headers.get("Location") or "")
        self.assertTrue(location.endswith("/en"), location)
        self.assertFalse(location.endswith("/en/"), location)


if __name__ == "__main__":
    unittest.main()
