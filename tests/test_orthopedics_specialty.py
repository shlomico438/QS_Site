import unittest


class OrthopedicsSpecialtyTests(unittest.TestCase):
    def test_specialty_aliases_normalize_to_orthopedics(self):
        from medical_saas import normalize_professional_specialty

        self.assertEqual(normalize_professional_specialty("orthopedics"), "orthopedics")
        self.assertEqual(normalize_professional_specialty("Orthopaedic"), "orthopedics")
        self.assertEqual(normalize_professional_specialty("אורתופדיה"), "orthopedics")
        self.assertEqual(normalize_professional_specialty("not-a-profession"), "")

    def test_orthopedics_template_and_section_labels(self):
        import siteapp

        self.assertTrue(siteapp._is_orthopedics_specialty("orthopedics"))
        self.assertTrue(siteapp._is_orthopedics_specialty("אורתופד"))
        self.assertFalse(siteapp._is_orthopedics_specialty("neurology"))
        labels = siteapp._medical_summary_section_labels("orthopedics")
        self.assertIn("אורתופד", labels["exam"])
        prompt = siteapp._default_medical_task2_prompt_orthopedics_summary_only()
        self.assertIn("orthopedic", prompt.lower())
        self.assertIn("Range of motion", prompt)
        self.assertIn("chief_complaint", prompt)
        self.assertIn("patient_recommendations", prompt)
        self.assertNotIn("תכנים מרכזיים", prompt)

    def test_orthopedics_ignores_psychology_stock_prompt(self):
        import siteapp

        psychology = (
            'תכנים מרכזיים: topics\n'
            'התרשמות רגשית: affect\n'
            'דגשים להמשך: next session\n'
        )
        self.assertTrue(siteapp._prompt_belongs_to_other_specialty(psychology, "orthopedics"))
        self.assertFalse(siteapp._prompt_belongs_to_other_specialty(psychology, "psychologist"))
        ortho = siteapp._default_medical_task2_prompt_orthopedics_summary_only()
        self.assertFalse(siteapp._prompt_belongs_to_other_specialty(ortho, "orthopedics"))
        labels = siteapp._medical_summary_section_labels("Orthopedic")
        self.assertEqual(labels["chief"], "תלונה עיקרית / אנמנזה")
        self.assertNotEqual(labels["chief"], "תכנים מרכזיים")

    def test_profession_change_resets_training(self):
        from medical_saas import specialty_change_resets_training

        self.assertTrue(specialty_change_resets_training("psychologist", "orthopedics"))
        self.assertTrue(specialty_change_resets_training("Orthopedic", "neurology"))
        self.assertFalse(specialty_change_resets_training("orthopedics", "orthopedics"))
        self.assertFalse(specialty_change_resets_training("אורתופדיה", "orthopedics"))
        self.assertFalse(specialty_change_resets_training("", "orthopedics"))


if __name__ == "__main__":
    unittest.main()
