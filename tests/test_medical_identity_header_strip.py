import unittest

import siteapp


class MedicalIdentityHeaderStripTests(unittest.TestCase):
    def test_strips_bold_placeholder_identity_block(self):
        text = (
            "**תאריך:** לא צוין\n"
            "\n"
            "**שם:** לא צוין\n"
            "\n"
            "**ת.ז.:** לא צוין\n"
            "\n"
            "בן 18, נפצע ביד שמאל.\n"
            "DIGNOSIS: LEFT HAND FRACTURE"
        )
        out = siteapp._strip_leading_medical_patient_identity_header(text)
        self.assertTrue(out.startswith("בן 18"))
        self.assertNotIn("תאריך", out)
        self.assertNotIn("לא צוין", out.split("\n")[0])

    def test_strips_filled_identity_block(self):
        text = (
            "תאריך: 19/11/2026\n"
            "שם: יונתן רוטלווי\n"
            "ת.ז.: 217540343\n"
            "\n"
            "בן 18 עם שבר."
        )
        out = siteapp._strip_leading_medical_patient_identity_header(text)
        self.assertEqual(out, "בן 18 עם שבר.")

    def test_leaves_clinical_date_mentions(self):
        text = "כאבים ביד שמאל מאז תאריך האירוע אתמול."
        self.assertEqual(
            siteapp._strip_leading_medical_patient_identity_header(text),
            text,
        )

    def test_strips_date_under_complaint_section_title(self):
        """Injury date under תלונה is letterhead — narrative already has the day."""
        text = (
            "תלונה\n"
            "תאריך: 17/11/2026 :\n"
            "\n"
            "צעיר בן 26, בריא, נפגע בתאונת קורקינט ביום 17/11/2026."
        )
        out = siteapp._strip_leading_medical_patient_identity_header(text)
        self.assertIn("צעיר בן 26", out)
        self.assertIn("ביום 17/11/2026", out)
        self.assertNotIn("תאריך:", out)
        self.assertTrue(out.startswith("תלונה") or out.startswith("צעיר"))

    def test_leaves_compound_clinical_date_label(self):
        text = "תאריך ניתוח: 01/02/2026\nהמשך מעקב."
        self.assertEqual(
            siteapp._strip_leading_medical_patient_identity_header(text),
            text,
        )

    def test_prepend_uses_ui_header_only_once(self):
        parts = [
            "**תאריך:** לא צוין",
            "**שם:** לא צוין",
            "**ת.ז.:** לא צוין",
            "בן 18 עם שבר.",
        ]
        mask = [False] * len(parts)
        out_parts, _out_mask = siteapp._medical_summary_prepend_patient_lines(
            parts,
            mask,
            patient_name="יונתן רוטלווי",
            patient_id_number="217540343",
            visit_date="2026-11-19",
        )
        joined = "\n".join(out_parts)
        self.assertEqual(joined.count("תאריך:"), 1)
        self.assertEqual(joined.count("שם:"), 1)
        self.assertEqual(joined.count("ת.ז.:"), 1)
        self.assertIn("יונתן רוטלווי", joined)
        self.assertIn("בן 18 עם שבר.", joined)
        self.assertNotIn("לא צוין", joined)

    def test_summary_from_parsed_strips_identity_from_chief(self):
        parsed = {
            "chief_complaint": (
                "**תאריך:** לא צוין\n"
                "**שם:** לא צוין\n"
                "**ת.ז.:** לא צוין\n"
                "בן 18 עם שבר."
            ),
            "examination_transcript": "DIGNOSIS: FRACTURE",
            "patient_recommendations": "מנוחה",
        }
        out = siteapp._medical_summary_from_parsed(parsed, want_hebrew=True, keep_personal_headings=True)
        chief = out["medical_chief_complaint"]
        self.assertTrue(chief.startswith("בן 18") or "בן 18" in chief)
        self.assertNotIn("תאריך", chief)
        self.assertNotIn("ת.ז", chief)


if __name__ == "__main__":
    unittest.main()
