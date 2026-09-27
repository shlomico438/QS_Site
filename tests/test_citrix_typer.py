import unittest

from aws_transcribe_stream import final_phrase_delta
from citrix_typer import citrix_window_matches, split_final_words


class FinalPhraseDeltaTests(unittest.TestCase):
    def test_first_phrase_keeps_a_trailing_space(self):
        self.assertEqual(final_phrase_delta('', 'שלום עולם'), 'שלום עולם ')

    def test_suffix_only(self):
        self.assertEqual(final_phrase_delta('שלום', 'שלום עולם'), 'עולם ')

    def test_rewrite_is_not_typed(self):
        self.assertEqual(final_phrase_delta('hello world', 'שלום'), '')

    def test_unchanged_is_empty(self):
        self.assertEqual(final_phrase_delta('שלום', 'שלום'), '')


class CitrixTyperTests(unittest.TestCase):
    def test_words_keep_a_separator(self):
        self.assertEqual(split_final_words('בברכה, ד"ר כהן '), ['בברכה, ', 'ד"ר ', 'כהן '])

    def test_window_match_is_a_substring(self):
        self.assertTrue(citrix_window_matches('Clinic - Citrix Workspace', 'citrix workspace'))
        self.assertFalse(citrix_window_matches('Chrome', 'citrix'))


if __name__ == '__main__':
    unittest.main()
