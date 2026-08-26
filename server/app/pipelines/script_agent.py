"""
智能剧本与长篇网文拆解 Agent
仅通过 MiniMax LLM 真实拆解；未配置 MINIMAX_API_KEY 或 API 不可达时抛出 LLMServiceError，
绝不降级为假数据或硬编码角色。
"""
import json
import uuid
import re
from typing import Dict, Any, List

from app.models.schemas import Project, Scene, StoryboardShot, Character
from app.pipelines.llm_service import llm_service

STYLE_PROMPTS = {
    "donghua_xianxia": "Chinese Donghua animation style, Xianxia fantasy, 8k resolution, cinematic lighting, ethereal atmosphere, volumetric clouds, highly detailed anime illustration, masterpiece",
    "japanese_anime": "Makoto Shinkai style, high quality Japanese anime, vibrant colors, beautiful lens flare, ultra-detailed background, 4k anime visual",
    "modern_webtoon": "Korean Webtoon manhwa style, dynamic line art, sharp character shading, modern urban aesthetic, trending on Webtoon, high contrast",
    "cinematic_3d": "Unreal Engine 5 render, 3D Pixar & Disney animation quality, ray tracing, subsurface scattering, 8k CGI movie still, vivid expressions",
    "dark_comic": "Frank Miller dark graphic novel style, high contrast noir, ink splatters, moody shadows, gritty comic book aesthetic",
    "pure_white_aesthetic": "Pure white aesthetic, high-key lighting, clean white minimalist anime style, bright ethereal atmosphere, soft delicate shading, pristine studio illumination, masterpiece, 8k resolution",
    "white_minimalist": "Pure white aesthetic, high-key lighting, clean white minimalist anime style, bright ethereal atmosphere, soft delicate shading, pristine studio illumination, masterpiece, 8k resolution",
}

VALID_FRAMINGS = {"close_up", "extreme_close_up", "medium", "full", "long", "bird_eye", "low_angle"}
VALID_MOTIONS = {"static", "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "orbit", "shake"}
VALID_EMOTIONS = {"neutral", "intense", "sorrow", "excited", "fearful", "whispering"}


class ScriptParserAgent:
    """长篇小说 → 结构化分镜剧本（MiniMax LLM 真实拆解）"""

    async def parse_novel_to_project(
        self,
        novel_text: str,
        style_preset: str = "donghua_xianxia",
        aspect_ratio: str = "9:16",
        custom_instructions: str = ""
    ) -> Project:
        if not novel_text or not novel_text.strip():
            raise ValueError("小说文本为空，无法拆解分镜")
        return await self._call_minimax_llm_parse(novel_text, style_preset, aspect_ratio, custom_instructions)

    async def _call_minimax_llm_parse(
        self,
        novel_text: str,
        style_preset: str,
        aspect_ratio: str,
        custom_instructions: str
    ) -> Project:
        system_prompt = "You are a professional AI Comic Drama director and script breakdown expert. You must output valid JSON only."
        user_prompt = f"""
你是一位顶尖的 AI 漫剧导演兼分镜大师。请将以下小说文本深度拆解为工业级漫剧分镜脚本。
要求：
1. 提取所有出场角色（姓名、性别、年龄段、性格外貌、台词音色建议、三视图提示词）。
2. 将小说切分为逻辑连贯的镜头序列。每个镜头必须包含：
   - 镜号 (shot_index)
   - 景别 (camera_framing: close_up, extreme_close_up, medium, full, long, bird_eye, low_angle)
   - 运镜 (camera_motion: static, push_in, pull_out, pan_left, pan_right, tilt_up, tilt_down, orbit, shake)
   - 角色动作描述 (action_desc)
   - 对白 (dialogue) 或 旁白 (voiceover)
   - 情绪标记 (emotion: neutral, intense, sorrow, excited, fearful, whispering)
   - 画面生图英文 Prompt (image_prompt: 包含画风、场景、光影、人物特征，英文)
   - 镜头推荐时长秒数 (duration: 2.5 ~ 6.0)
3. 画风设定：{style_preset} ({STYLE_PROMPTS.get(style_preset, '')})
4. 画幅比例：{aspect_ratio}

小说内容：
{novel_text}
{('额外导演指令：' + custom_instructions) if custom_instructions else ''}

请严格输出 JSON 格式（不要包含任何 markdown 标记以外的杂质）：
{{
  "title": "短剧标题",
  "characters": [
    {{
      "name": "角色名",
      "gender": "male/female",
      "age_group": "youth",
      "role": "protagonist/antagonist/supporting",
      "description": "性格服饰外貌简述",
      "visual_prompt": "1boy, black hair, handsome, ancient robes...",
      "voice_id": "male-qn-qingse",
      "voice_name": "少年主角"
    }}
  ],
  "scenes": [
    {{
      "scene_index": 1,
      "title": "场景名称",
      "location": "泰山之巅 / 虚空大殿",
      "time_of_day": "dusk",
      "atmosphere": "epic",
      "shots": [
        {{
          "shot_index": 1,
          "camera_framing": "extreme_close_up",
          "camera_motion": "push_in",
          "action_desc": "主角猛然睁开双眼，眼眸中金光闪烁",
          "speaker_name": "叶凡",
          "dialogue": "这一世，我命由我不由天！",
          "voiceover": "",
          "emotion": "intense",
          "image_prompt": "masterpiece, 1boy, glowing golden eyes, intense stare...",
          "duration": 3.5,
          "subtitle_text": "这一世，我命由我不由天！"
        }}
      ]
    }}
  ]
}}
"""
        data = await llm_service.chat_json(system_prompt=system_prompt, user_prompt=user_prompt, temperature=0.3)

        if not data.get("scenes"):
            raise ValueError(f"LLM 拆解结果中无分镜数据: {str(data)[:200]}")
        return self._build_project_from_dict(data, novel_text, style_preset, aspect_ratio)

    def _build_project_from_dict(self, data: Dict[str, Any], novel_text: str, style_preset: str, aspect_ratio: str) -> Project:
        characters = []
        for c in data.get("characters", []):
            characters.append(Character(
                id=str(uuid.uuid4()),
                name=c.get("name", "未命名"),
                gender=c.get("gender", "male"),
                age_group=c.get("age_group", "youth"),
                role=c.get("role", "protagonist"),
                description=c.get("description", ""),
                visual_prompt=c.get("visual_prompt", ""),
                voice_id=c.get("voice_id", "male-qn-qingse"),
                voice_name=c.get("voice_name", "主角音")
            ))

        scenes = []
        for s in data.get("scenes", []):
            shots = []
            for shot in s.get("shots", []):
                framing = shot.get("camera_framing", "medium")
                motion = shot.get("camera_motion", "push_in")
                emotion = shot.get("emotion", "neutral")
                dialogue = shot.get("dialogue", "") or ""
                voiceover = shot.get("voiceover", "") or ""

                shots.append(StoryboardShot(
                    id=str(uuid.uuid4()),
                    shot_index=int(shot.get("shot_index", len(shots) + 1)),
                    camera_framing=framing if framing in VALID_FRAMINGS else "medium",
                    camera_motion=motion if motion in VALID_MOTIONS else "push_in",
                    action_desc=shot.get("action_desc", ""),
                    speaker_name=shot.get("speaker_name", "") or None,
                    dialogue=dialogue,
                    voiceover=voiceover,
                    emotion=emotion if emotion in VALID_EMOTIONS else "neutral",
                    image_prompt=shot.get("image_prompt", ""),
                    video_prompt=shot.get("video_prompt", ""),
                    duration=max(1.5, min(10.0, float(shot.get("duration", 3.5)))),
                    subtitle_text=shot.get("subtitle_text") or dialogue or voiceover,
                    status="ready"
                ))
            scenes.append(Scene(
                id=str(uuid.uuid4()),
                scene_index=int(s.get("scene_index", len(scenes) + 1)),
                title=s.get("title", f"场景 {len(scenes) + 1}"),
                location=s.get("location", ""),
                time_of_day=s.get("time_of_day", "day"),
                atmosphere=s.get("atmosphere", "epic"),
                shots=shots
            ))

        return Project(
            id=str(uuid.uuid4()),
            title=data.get("title", "AI 漫剧项目")[:50],
            original_novel=novel_text,
            style_preset=style_preset,
            aspect_ratio=aspect_ratio,
            characters=characters,
            scenes=scenes,
            engine="minimax-llm"
        )

script_agent = ScriptParserAgent()
