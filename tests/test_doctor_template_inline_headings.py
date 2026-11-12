# -*- coding: utf-8 -*-
"""Inline ``ברקע:`` mid-paragraph must land under the ברקע heading."""
import unittest

import siteapp


class DoctorTemplateInlineHeadingsTest(unittest.TestCase):
    def test_lift_inline_background_marker(self):
        headings = ["הנדון", "ברקע", "רגישות", "תרופות", "בבדיקה", "לסיכום", "המלצות"]
        chief = (
            "בן 51 מגיע להתייעצות. לא צוין כאב לאחר ארוחות. "
            "ברקע: יתר לחץ דם, טרומבוציטופניה, ניתוחים בעבר."
        )
        exam = "**בבדיקה:**\nבטן רכה, לא רגישה."
        rec = "לסיכום: CHOLELITHIASIS.\n- הפניה לניתוח."
        letter, exam_out, rec_out = siteapp._enforce_doctor_template_headings(
            chief, exam, rec, headings
        )
        self.assertEqual(exam_out, "")
        self.assertEqual(rec_out, "")
        self.assertIn("הנדון\nבן 51 מגיע להתייעצות.", letter)
        self.assertIn("ברקע\nיתר לחץ דם, טרומבוציטופניה, ניתוחים בעבר.", letter)
        # Background must not remain glued under הנדון.
        handon = letter.split("ברקע", 1)[0]
        self.assertNotIn("יתר לחץ דם", handon)
        self.assertIn("בבדיקה\nבטן רכה, לא רגישה.", letter)
        self.assertIn("לסיכום\nCHOLELITHIASIS.", letter)

    def test_does_not_lift_summary_or_meds_markers(self):
        """Peeling לסיכום/תרופות mid-letter put exam under תרופות — must not happen."""
        headings = ["הנדון", "ברקע", "רגישות", "תרופות", "בבדיקה", "לסיכום", "המלצות"]
        chief = (
            "עדן בן חיים\n"
            "כאבים במפסעות.\n"
            "רגישות\nלא ידוע\n"
            "תרופות\nאין\n"
            "בבדיקה\nדיבור תקין.\nטונוס לא צוין.\n"
            "לסיכום\nרושם מוסקולוסקלטלי.\n"
            "המלצות\n· מעקב"
        )
        lifted = siteapp._lift_inline_section_markers(chief, headings)
        # No rewrite when markers are already proper heading lines.
        self.assertEqual(lifted, chief)
        letter, _, _ = siteapp._enforce_doctor_template_headings(chief, "", "", headings)
        meds = letter.split("תרופות", 1)[1].split("בבדיקה", 1)[0]
        exam = letter.split("בבדיקה", 1)[1].split("לסיכום", 1)[0]
        self.assertIn("אין", meds)
        self.assertNotIn("דיבור תקין", meds)
        self.assertIn("דיבור תקין", exam)

    def test_trailing_summary_colon_not_lifted_from_chief(self):
        headings = ["הנדון", "ברקע", "בבדיקה", "לסיכום", "המלצות"]
        chief = "בת 34 עם כאבים. לסיכום: חשד לבקע."
        exam = "בבדיקה\nבטן רכה."
        lifted = siteapp._lift_inline_section_markers(chief + "\n" + exam, headings)
        # Must keep לסיכום: glued — lifting it early dumps exam into the wrong bucket.
        self.assertIn("לסיכום: חשד לבקע.", lifted)
        self.assertNotIn("\nלסיכום\nחשד לבקע.", lifted)

    def test_exam_findings_leaked_under_meds_are_moved(self):
        headings = ["הנדון", "ברקע", "רגישות", "תרופות", "בבדיקה", "לסיכום", "המלצות"]
        chief = (
            "הנדון\nעדן בן חיים\n"
            "ברקע\n· לא צוין\n"
            "רגישות\nלא ידוע\n"
            "תרופות\nלא לוקחת תרופות כרגע\n"
            "דיבור תקין.\n"
            "טונוס לא צוין, ריגידיות לא נבדקה.\n"
            "CN – לא נבדק, שדות ראייה – לא נבדקו.\n"
            "לסיכום\nרושם מוסקולוסקלטלי.\n"
            "המלצות\n· מעקב"
        )
        letter, _, _ = siteapp._enforce_doctor_template_headings(chief, "", "", headings)
        meds = letter.split("תרופות", 1)[1].split("בבדיקה", 1)[0]
        exam = letter.split("בבדיקה", 1)[1].split("לסיכום", 1)[0]
        self.assertIn("לא לוקחת תרופות כרגע", meds)
        self.assertNotIn("דיבור תקין", meds)
        self.assertNotIn("טונוס", meds)
        self.assertIn("דיבור תקין", exam)
        self.assertIn("טונוס", exam)

    def test_exam_continues_on_same_line_without_colon(self):
        """``בבדיקה נמצאה…`` must open בבדיקה, not stay under הנדון."""
        headings = ["הנדון", "ברקע", "בבדיקה", "המלצות"]
        chief = (
            "הנדון\n"
            "המטופל, ילד בן 5 שנים, הגיע לאחר שנדפקה דלת על אצבע יד שמאל.\n"
            "בבדיקה נמצאה אצבע יד שמאל עם חתך שעובר דרך הצד הדיסטלי.\n"
            "אין סימני זיהום.\n"
            "הומלץ להמשך מעקב והחלפת חבישה בקופת חולים.\n"
            "יש להגיע לביקורת בעוד שבוע.\n"
            "הטקסט חייב להיבדק מול ההקלטה והרופא האחראי."
        )
        letter, _, _ = siteapp._enforce_doctor_template_headings(chief, "", "", headings)
        handon = letter.split("בבדיקה", 1)[0]
        exam = letter.split("בבדיקה", 1)[1].split("המלצות", 1)[0]
        rec = letter.split("המלצות", 1)[1]
        self.assertIn("ילד בן 5", handon)
        self.assertNotIn("נמצאה אצבע", handon)
        self.assertNotIn("הומלץ", handon)
        self.assertIn("נמצאה אצבע", exam)
        self.assertIn("אין סימני זיהום", exam)
        self.assertNotIn("הומלץ", exam)
        self.assertIn("הומלץ להמשך מעקב", rec)
        self.assertIn("יש להגיע לביקורת", rec)
        self.assertIn("הטקסט חייב להיבדק", rec)

    def test_admin_header_lines_are_not_template_headings(self):
        letter = (
            "**שם: יוסי כהן**\n"
            "**ת.ז.: 123456789**\n"
            "**יעוץ טלפוני:**\n"
            "\n"
            "** **\n"
            "\n"
            "**תלונה**\n"
            "מתלונן על כאב.\n"
            "\n"
            "**ממצאים**\n"
            "קיימת בלט.\n"
            "\n"
            "**המלצות למטופל**\n"
            "מעקב בעוד שבוע.\n"
        )
        headings = siteapp._extract_doctor_template_headings(letter)
        self.assertEqual(headings, ["תלונה", "ממצאים", "המלצות למטופל"])
        labels = siteapp._extract_personal_section_labels(letter)
        self.assertEqual(labels.get("chief"), "תלונה")
        self.assertEqual(labels.get("exam"), "ממצאים")
        self.assertEqual(labels.get("rec"), "המלצות למטופל")

    def test_three_pane_telephone_template_keeps_separate_fields(self):
        headings = ["תלונה", "ממצאים", "המלצות למטופל"]
        chief = (
            "**שם: יוסי כהן**\n"
            "**ת.ז.: 123456789**\n"
            "**יעוץ טלפוני:**\n"
            "\n"
            "**תלונה**\n"
            "מתלונן על כאב בגב תחתון."
        )
        exam = "**ממצאים**\nקיימת בלט דיסק L4-L5."
        rec = "**המלצות למטופל**\nלהימנע מהרמה.\nיש להגיע לבדיקה בעוד שבועיים."
        chief_out, exam_out, rec_out = siteapp._enforce_doctor_template_headings(
            chief, exam, rec, headings
        )
        self.assertIn("שם: יוסי כהן", chief_out.replace("*", ""))
        self.assertIn("תלונה", chief_out)
        self.assertIn("מתלונן על כאב", chief_out)
        self.assertNotIn("ממצאים", chief_out)
        self.assertIn("ממצאים", exam_out)
        self.assertIn("בלט דיסק", exam_out)
        self.assertIn("המלצות למטופל", rec_out)
        self.assertIn("להימנע מהרמה", rec_out)
        self.assertTrue(exam_out.strip())
        self.assertTrue(rec_out.strip())


if __name__ == "__main__":
    unittest.main()
