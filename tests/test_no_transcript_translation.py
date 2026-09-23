"""Cleanup must not replace an English cue with a Hebrew translation."""
import unittest

import siteapp


class ScriptFlipGuardTests(unittest.TestCase):
    def test_english_cue_survives_hebrew_cleanup(self):
        segments = [{
            "start": 48.0,
            "end": 55.0,
            "text": "Celebrities are often influential on their fans, but Angelina Jolie took it a step further.",
        }]
        cleaned = "לסלבריטאים יש לעיתים קרובות השפעה על המעריצים, אבל אנג'לינה ג'ולי לקחה זאת צעד נוסף."
        out, meta = siteapp._apply_clean_transcript_to_segments(segments, cleaned)
        self.assertIn("Celebrities", out[0]["text"])
        self.assertNotIn("לסלבריטאים", out[0]["text"])
        self.assertGreaterEqual(meta.get("script_flips_restored") or 0, 1)

    def test_hebrew_spelling_fix_is_kept(self):
        segments = [{"start": 1.0, "end": 3.0, "text": "והתענות של המטופל"}]
        cleaned = "והטענות של המטופל"
        out, meta = siteapp._apply_clean_transcript_to_segments(segments, cleaned)
        self.assertEqual(out[0]["text"], "והטענות של המטופל")
        self.assertEqual(meta.get("script_flips_restored") or 0, 0)

    def test_cleanup_prompt_locks_language(self):
        # Build the prompt the same way the cleanup call does, without calling OpenAI.
        target = "preserve"
        label, hint, _ = siteapp._format_output_lang_label(target)
        self.assertIn("never translate", hint)
        self.assertNotEqual(label, "Hebrew")


if __name__ == "__main__":
    unittest.main()
