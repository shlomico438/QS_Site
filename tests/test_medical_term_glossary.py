import json
import os
import unittest

import siteapp


class MedicalTermGlossaryTests(unittest.TestCase):
    def test_fixes_kifuf_fingers_phrase(self):
        text = "בבדיקה: קיפוף אצבעות מוגבל בצד שמאל."
        out = siteapp._apply_medical_term_glossary(text)
        self.assertIn("כיפוף אצבעות", out)
        self.assertNotIn("קיפוף אצבעות", out)

    def test_does_not_rewrite_kyphosis(self):
        text = "קיפוזיס תורקלי קל."
        self.assertEqual(siteapp._apply_medical_term_glossary(text), text)

    def test_fixes_orthopedics_spelling(self):
        text = "הופנה לאורטופדיה ולפיזיוטרפיה."
        out = siteapp._apply_medical_term_glossary(text)
        self.assertIn("אורתופדיה", out)
        self.assertIn("פיזיותרפיה", out)
        self.assertNotIn("אורטופדיה", out)
        self.assertNotIn("פיזיוטרפיה", out)
        self.assertIn("לאורתופדיה", out)
        self.assertIn("ולפיזיותרפיה", out)

    def test_summary_from_parsed_applies_glossary(self):
        parsed = {
            "chief_complaint": "כאבים עם קיפוף אצבעות.",
            "examination_transcript": "ROM: קיפוף אצבעות מוגבל.",
            "patient_recommendations": "המשך פיזיוטרפיה.",
        }
        out = siteapp._medical_summary_from_parsed(parsed, want_hebrew=True)
        self.assertIn("כיפוף אצבעות", out["medical_chief_complaint"])
        self.assertIn("כיפוף אצבעות", out["medical_examination_transcript"])
        self.assertIn("פיזיותרפיה", out["medical_patient_recommendations"])

    def test_format_dict_applies_to_clean_transcript(self):
        payload = {
            "clean_transcript": "יש קיפוף אצבעות.",
            "overview": "קיפוף אצבעות",
            "key_points": ["קיפוף ברך"],
            "medical_chief_complaint": "קיפוף אצבעות",
            "medical_examination_transcript": "",
            "medical_patient_recommendations": "",
        }
        out = siteapp._apply_medical_term_glossary_format_dict(payload)
        self.assertEqual(out["clean_transcript"], "יש כיפוף אצבעות.")
        self.assertEqual(out["overview"], "כיפוף אצבעות")
        self.assertEqual(out["key_points"], ["כיפוף ברך"])
        self.assertEqual(out["medical_chief_complaint"], "כיפוף אצבעות")

    def test_env_glossary_extends_pairs(self):
        prev = os.environ.get("MEDICAL_TERM_GLOSSARY")
        try:
            os.environ["MEDICAL_TERM_GLOSSARY"] = json.dumps(
                {"טסטמונח": "מונח בדיקה"}
            )
            out = siteapp._apply_medical_term_glossary("נמצא טסטמונח בבדיקה")
            self.assertIn("מונח בדיקה", out)
            self.assertNotIn("טסטמונח", out)
        finally:
            if prev is None:
                os.environ.pop("MEDICAL_TERM_GLOSSARY", None)
            else:
                os.environ["MEDICAL_TERM_GLOSSARY"] = prev


if __name__ == "__main__":
    unittest.main()
