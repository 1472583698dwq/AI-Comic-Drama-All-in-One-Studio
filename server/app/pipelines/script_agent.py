"""
智能剧本与长篇网文拆解 Agent
仅通过 MiniMax LLM 真实拆解；未配置 MINIMAX_API_KEY 或 API 不可达时抛出 LLMServiceError，
绝不降级为假数据或硬编码角色。
"""
import json
import os
import uuid
import re
from typing import Dict, Any, List

from app.models.schemas import Project, Scene, StoryboardShot, Character
from app.pipelines.llm_service import llm_service, LLMServiceError

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

# 空 shots 兜底：镜头节拍循环（连续打斗等文本被 LLM 只归纳成场景时的保底拆解）
_FALLBACK_FRAMINGS = ["full", "medium", "close_up", "extreme_close_up", "medium", "low_angle"]
_FALLBACK_MOTIONS = ["push_in", "pan_right", "shake", "static", "pull_out", "orbit"]


def _fallback_beats(text: str, max_beats: int = 24) -> List[str]:
    """把整段文本切成动作节拍（按句读/换行），供无 shots 的场景兜底成镜。

    短碎句（<6 字，如「甲出刀。」）两两合并成一个节拍；正常句子各自成拍。
    """
    parts = [p.strip() for p in re.split(r"(?<=[。！？!?；;，,])|\n+", text or "") if p and p.strip()]
    beats: List[str] = []
    buf = ""
    for p in parts:
        if buf:
            beats.append((buf + p)[:110])
            buf = ""
        elif len(p) < 6:
            buf = p
        else:
            beats.append(p[:110])
    if buf:
        beats.append(buf[:110])
    return [b for b in beats if b.strip()][:max_beats]


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
   - 画面生图英文 Prompt (image_prompt: 包含画风、场景、光影、人物特征，英文；**必须体现该镜所在场景的空间/光线/道具，并与场景参考保持一致**)
   - 镜头推荐时长秒数 (duration: 2.5 ~ 6.0)
2.1 每个场景（scenes[]）必须额外给出**场景资产定义**（用于生成无人的场景参考图，保证全片空间一致）：
   - image_prompt: 该场景的空镜英文 Prompt（只画环境：地点/时间/天气/光线/氛围/标志性陈设与道具，**不要出现人物**）
   - props: 该场景的关键道具清单（2~5 个短词，如 ["旧木凳","搪瓷杯"]），镜头与场景参考图都需包含这些道具
2.2 **shots 数组绝不允许为空**：每个场景至少 2 镜。连续打斗/连续动作的段落必须按招式节拍逐镜拆解
   （如：起手→突进→兵刃相撞→格挡→反击→命中→收势），每镜一个清晰动作+一个运镜，不要只做场景概括。
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
      "image_prompt": "masterpiece, empty ancient hall interior at dusk, cold moonlight through lattice windows, floating dust, wooden altar with bronze incense burner, no people, cinematic lighting...",
      "props": ["青铜香炉", "旧木案"],
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
        # 拆解 JSON 很大（角色+场景+每镜多字段 prompt），max_tokens 要给足；
        # 若源端拒绝大值（HTTP 400 提到 tokens），自动降档重试。总时限防网关挂起。
        preferred = int(os.environ.get("ONEKEY_SPLIT_MAX_TOKENS") or 32768)
        timeout_s = float(os.environ.get("ONEKEY_SPLIT_TIMEOUT_S") or 600)
        data: Dict[str, Any] = {}
        last_err: Exception | None = None
        for mt in (preferred, 16384, 8192):
            try:
                data = await llm_service.chat_json(
                    system_prompt=system_prompt, user_prompt=user_prompt,
                    temperature=0.3, max_tokens=mt, timeout=timeout_s,
                )
                break
            except LLMServiceError as e:
                last_err = e
                msg = str(e)
                if ("max_tokens" in msg or "max_completion_tokens" in msg
                        or "HTTP 400" in msg):
                    continue
                raise
        else:
            if last_err is not None:
                raise last_err

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
                image_prompt=s.get("image_prompt", ""),
                props=[str(x)[:40] for x in (s.get("props") or []) if str(x).strip()][:6],
                shots=shots
            ))

        # 兜底修复：LLM 只给出场景、shots 为空（连续打斗常见）→ 按文本节拍补镜头，保证项目不落成 0 镜
        empty = [sc for sc in scenes if not sc.shots]
        if empty:
            beats = _fallback_beats(novel_text)
            bi = 0
            for sc in empty:
                take = beats[bi:bi + 4]
                bi += 4
                if not take:
                    take = [f"{sc.title}：环境与人物状态镜头（{sc.atmosphere or '场景' }）"]
                for j, beat in enumerate(take):
                    sc.shots.append(StoryboardShot(
                        id=str(uuid.uuid4()),
                        shot_index=j + 1,
                        camera_framing=_FALLBACK_FRAMINGS[j % len(_FALLBACK_FRAMINGS)],
                        camera_motion=_FALLBACK_MOTIONS[j % len(_FALLBACK_MOTIONS)],
                        action_desc=beat,
                        dialogue="",
                        voiceover="",
                        emotion="intense" if any(k in beat for k in ("刀", "剑", "击", "闪", "拳", "撞", "劈", "挡")) else "neutral",
                        image_prompt=(f"{sc.image_prompt}, " if sc.image_prompt else "") + beat,
                        duration=3.0,
                        subtitle_text=beat,
                        status="ready",
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
