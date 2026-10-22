# -*- coding: utf-8 -*-
"""导出前自动补配音：缺失 audio_url 的台词/旁白用 TTS 生成并写回项目。"""
import asyncio
import os
import sys
import unittest
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.media import voice_fill  # noqa: E402
from app.providers.audio.base import AudioGenerateResult  # noqa: E402


def _shots():
    return [
        {"id": "s1", "shot_index": 1, "dialogue": "", "voiceover": "旁白一",
         "audio_url": "", "audio_duration": 0, "audio_provider": "", "emotion": "neutral"},
        {"id": "s2", "shot_index": 2, "dialogue": "台词二", "voiceover": "",
         "audio_url": "", "audio_duration": 0, "audio_provider": "", "emotion": "happy"},
        {"id": "s3", "shot_index": 3, "dialogue": "", "voiceover": "",
         "audio_url": "", "audio_duration": 0, "audio_provider": "", "emotion": "neutral"},
    ]


def _content():
    return {"id": "p", "scenes": [{"shots": [
        {"id": "s1"}, {"id": "s2"}, {"id": "s3"},
    ]}]}


class TestFillMissingVoice(unittest.TestCase):
    def test_generates_for_text_shots_and_writes_back(self):
        seen = []

        async def fake_generate(req, provider_id=None):
            seen.append((req.text, req.voice_id, req.emotion, provider_id))
            return AudioGenerateResult(
                audio_url=f"/storage/tts/{len(seen)}.mp3", local_path="",
                voice_id=req.voice_id, text=req.text, emotion=req.emotion,
                duration=2.4, provider="mock_tts", engine="mock",
            )

        shots = _shots()
        content = _content()
        with mock.patch.object(voice_fill.audio_registry, "generate", fake_generate):
            generated, warnings = asyncio.run(voice_fill.fill_missing_voice(
                shots, project_content=content, characters=[], provider="mock_tts", project_id="p",
            ))

        self.assertEqual(generated, 2)
        self.assertEqual(warnings, [])
        self.assertEqual(shots[0]["audio_url"], "/storage/tts/1.mp3")
        self.assertEqual(shots[0]["audio_duration"], 2.4)
        self.assertEqual(shots[0]["audio_provider"], "mock_tts")
        self.assertEqual(shots[1]["audio_url"], "/storage/tts/2.mp3")
        self.assertEqual(shots[2]["audio_url"], "")
        self.assertEqual(content["scenes"][0]["shots"][0]["audio_url"], "/storage/tts/1.mp3")
        self.assertEqual(content["scenes"][0]["shots"][1]["audio_url"], "/storage/tts/2.mp3")
        self.assertEqual([s[0] for s in seen], ["旁白一", "台词二"])

    def test_keeps_existing_audio_untouched(self):
        texts = []

        async def fake_generate(req, provider_id=None):
            texts.append(req.text)
            return AudioGenerateResult(
                audio_url="/storage/tts/new.mp3", local_path="", voice_id=req.voice_id,
                text=req.text, emotion=req.emotion, duration=2.0,
                provider="mock_tts", engine="mock",
            )

        shots = _shots()
        shots[0]["audio_url"] = "/storage/existing.mp3"
        with mock.patch.object(voice_fill.audio_registry, "generate", fake_generate):
            generated, warnings = asyncio.run(voice_fill.fill_missing_voice(
                shots, characters=[], provider="mock_tts", project_id="p",
            ))
        self.assertEqual(generated, 1)
        self.assertEqual(texts, ["台词二"])
        self.assertEqual(shots[0]["audio_url"], "/storage/existing.mp3")

    def test_provider_error_becomes_warning(self):
        async def fake_generate(req, provider_id=None):
            raise RuntimeError("缺少 API Key")

        shots = _shots()[:1]
        with mock.patch.object(voice_fill.audio_registry, "generate", fake_generate):
            generated, warnings = asyncio.run(voice_fill.fill_missing_voice(
                shots, characters=[], provider="mock_tts", project_id="p",
            ))
        self.assertEqual(generated, 0)
        self.assertTrue(warnings)
        self.assertIn("自动配音失败", warnings[0])
        self.assertIn("缺少 API Key", warnings[0])
        self.assertEqual(shots[0]["audio_url"], "")

    def test_persist_only_writes_generated_shots(self):
        shots = [
            {"id": "s1", "shot_index": 1, "audio_url": "/a.mp3", "audio_duration": 1.2, "audio_provider": "p"},
            {"id": "s2", "shot_index": 2, "audio_url": "/b.mp3", "audio_duration": 2.0, "audio_provider": "p"},
        ]
        calls = []

        def fake_patch(project_id, shot_id, fields):
            calls.append((project_id, shot_id, fields))

        with mock.patch("app.providers.project.manager.project_manager.patch_shot", fake_patch):
            warnings = voice_fill.persist_generated_voice(shots, "proj", before_ids=["s1"])
        self.assertEqual(warnings, [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "s1")
        self.assertEqual(calls[0][2]["audio_url"], "/a.mp3")

    def test_no_provider_gives_warning(self):
        with mock.patch.object(voice_fill.audio_registry, "list_ids", return_value=[]), \
             mock.patch.object(voice_fill.settings, "TTS_PROVIDER", ""):
            generated, warnings = asyncio.run(voice_fill.fill_missing_voice(_shots()[:1]))
        self.assertEqual(generated, 0)
        self.assertTrue(warnings)
        self.assertIn("没有可用的 TTS 源", warnings[0])


if __name__ == "__main__":
    unittest.main()
