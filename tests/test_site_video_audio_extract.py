#!/usr/bin/env python3
"""Regular video audio is extracted on the site; RunPod CPU is not used for that path."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch


class PreprocessedKeyTests(unittest.TestCase):
    def test_video_key_is_mp3_when_site_extract_on(self):
        import siteapp

        with patch.dict(os.environ, {'SITE_VIDEO_AUDIO_EXTRACT': 'true'}, clear=False):
            key = siteapp._audio_preprocessed_s3_key('users/u/input/job_1_talk.mp4', 'job_1_talk')
        self.assertTrue(key.endswith('job_1_talk.preprocessed.mp3'))
        self.assertNotEqual(key, 'users/u/input/job_1_talk.mp4')

    def test_audio_key_stays_wav_for_runpod_cpu(self):
        import siteapp

        with patch.dict(os.environ, {'SITE_VIDEO_AUDIO_EXTRACT': 'true'}, clear=False):
            key = siteapp._audio_preprocessed_s3_key('users/u/input/job_1_talk.mp3', 'job_1_talk')
        self.assertTrue(key.endswith('.preprocessed.wav'))

    def test_ffmpeg_child_is_lower_priority_than_the_worker(self):
        import siteapp

        captured = {}

        def _run(cmd, **kwargs):
            captured.update(kwargs)
            return type('R', (), {'returncode': 0, 'stderr': b''})()

        with patch.object(siteapp.subprocess, 'run', side_effect=_run), patch.object(
            siteapp, '_resolve_ffmpeg', return_value='ffmpeg'
        ), patch.object(siteapp.os.path, 'isfile', return_value=True), patch.object(
            siteapp.os.path, 'getsize', return_value=32
        ):
            siteapp._extract_video_audio_mp3_ffmpeg('in.mp4', 'out.mp3', timeout_sec=30)
        if os.name == 'nt':
            self.assertEqual(captured.get('creationflags'), 0x00004000)
        else:
            self.assertTrue(callable(captured.get('preexec_fn')))

    def test_video_key_stays_wav_when_site_extract_off(self):
        import siteapp

        with patch.dict(os.environ, {'SITE_VIDEO_AUDIO_EXTRACT': 'false'}, clear=False):
            key = siteapp._audio_preprocessed_s3_key('users/u/input/job_1_talk.mov', 'job_1_talk')
        self.assertTrue(key.endswith('.preprocessed.wav'))

    def test_cleanup_deletes_mp3_intermediate_only(self):
        import siteapp

        deleted = []

        class _S3:
            def delete_object(self, Bucket, Key):
                deleted.append((Bucket, Key))

        with patch.object(siteapp, '_s3_boto_client', return_value=_S3()), patch.object(
            siteapp, '_load_audio_preprocess_handoff', return_value={}
        ):
            siteapp._cleanup_audio_preprocess_intermediate('job', {
                'bucket': 'b',
                'input_s3_key': 'users/u/input/talk.mp4',
                'audio_preprocessed_s3_key': 'users/u/input/talk.preprocessed.mp3',
            })
            siteapp._cleanup_audio_preprocess_intermediate('job', {
                'bucket': 'b',
                'input_s3_key': 'users/u/input/talk.mp4',
                'audio_preprocessed_s3_key': 'users/u/input/talk.mp4',
            })
        self.assertEqual(deleted, [('b', 'users/u/input/talk.preprocessed.mp3')])


class PreprocessRoutingTests(unittest.TestCase):
    def _run(self, source_key, output_key, extract_side_effect=None):
        import siteapp

        job_id = 'job_extract_test'
        payload = {'input': {'s3Key': source_key, 'transcription_options': {}}}
        siteapp.pending_job_info.pop(job_id, None)
        finished = []
        queued = []

        def _finish(jid, trigger_payload, endpoint_id, api_key):
            finished.append((jid, trigger_payload, endpoint_id, api_key))

        def _queue(*args, **kwargs):
            queued.append(args)

        def _extract(*args):
            if extract_side_effect:
                raise extract_side_effect

        with patch.object(siteapp, '_set_trigger_state'), patch.object(
            siteapp, '_finish_audio_preprocess_and_trigger_gpu', side_effect=_finish
        ), patch.object(
            siteapp, '_queue_audio_preprocess_on_runpod', side_effect=_queue
        ), patch.object(
            siteapp, '_site_extract_video_audio_to_s3', side_effect=_extract
        ), patch.object(
            siteapp, '_run_on_os_thread', side_effect=lambda fn, *a: fn(*a)
        ):
            siteapp._preprocess_audio_then_trigger(
                job_id, payload, 'gpu-ep', 'gpu-key', 'bucket', source_key, output_key
            )
        siteapp.pending_job_info.pop(job_id, None)
        return finished, queued

    def test_video_extracts_on_site_and_points_gpu_at_mp3(self):
        source = 'users/u/input/talk.mp4'
        output = 'users/u/input/talk.preprocessed.mp3'
        with patch.dict(os.environ, {'SITE_VIDEO_AUDIO_EXTRACT': 'true'}, clear=False):
            finished, queued = self._run(source, output)
        self.assertEqual(queued, [])
        self.assertEqual(len(finished), 1)
        body = finished[0][1]['input']
        self.assertEqual(body['s3Key'], output)
        self.assertEqual(body['transcription_options']['preprocess_engine'], 'site_ffmpeg')
        self.assertTrue(body['transcription_options']['preprocessed_audio'])

    def test_video_extract_failure_fail_opens_to_original_without_runpod_cpu(self):
        source = 'users/u/input/talk.mp4'
        output = 'users/u/input/talk.preprocessed.mp3'
        with patch.dict(os.environ, {'SITE_VIDEO_AUDIO_EXTRACT': 'true'}, clear=False):
            finished, queued = self._run(source, output, extract_side_effect=RuntimeError('ffmpeg boom'))
        self.assertEqual(queued, [])
        self.assertEqual(len(finished), 1)
        body = finished[0][1]['input']
        self.assertEqual(body['s3Key'], source)
        self.assertTrue(body['transcription_options']['preprocess_failed'])
        self.assertEqual(body['transcription_options']['preprocess_engine'], 'site_ffmpeg')

    def test_audio_still_uses_runpod_cpu(self):
        source = 'users/u/input/talk.mp3'
        output = 'users/u/input/talk.preprocessed.wav'
        with patch.dict(os.environ, {'SITE_VIDEO_AUDIO_EXTRACT': 'true'}, clear=False):
            finished, queued = self._run(source, output)
        self.assertEqual(finished, [])
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0][2], source)


if __name__ == '__main__':
    unittest.main()
