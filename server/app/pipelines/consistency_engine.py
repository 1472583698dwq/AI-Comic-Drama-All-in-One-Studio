import os
import json
from typing import Dict, Any, List
from app.models.schemas import Character

ALIBABA_STYLES_PATH = os.path.join(os.path.dirname(__file__), "alibaba_styles.json")
ALIBABA_STYLES_CACHE = {}
if os.path.exists(ALIBABA_STYLES_PATH):
    try:
        with open(ALIBABA_STYLES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            for p in data.get("presets", []):
                ALIBABA_STYLES_CACHE[p["id"]] = p.get("positive_prompt", "")
    except Exception as e:
        print(f"[ConsistencyEngine] Failed to load Alibaba styles: {e}")

class ConsistencyEngine:
    """
    角色与场景一致性引擎 (深度融合阿里巴巴 LumenX 风格矩阵与小云雀 Seedance 2.0 角色一致性)
    """

    def build_character_3views_prompts(self, character: Character, style_preset: str = "donghua_xianxia") -> Dict[str, str]:
        base_desc = character.visual_prompt or f"1person, {character.name}, {character.description}"
        return {
            "front": f"{base_desc}, character sheet, full body front view, standing pose, neutral expression, white clean background, high detail turnaround, {style_preset}",
            "side": f"{base_desc}, character sheet, full body profile side view, standing pose, neutral expression, white clean background, {style_preset}",
            "three_quarter": f"{base_desc}, character sheet, 3/4 dynamic dynamic angle view, heroic standing posture, cinematic key lighting, {style_preset}"
        }

    def inject_character_consistency(
        self,
        base_shot_prompt: str,
        character: Character,
        emotion: str = "neutral",
        pose: str = "stand"
    ) -> str:
        emotion_map = {
            "neutral": "calm composed expression",
            "intense": "intense angry furious expression, sharp glowing eyes, clenched fists",
            "sorrow": "sorrowful mournful eyes, tears welling, heartbreaking expression",
            "excited": "triumphant smile, fiery energetic aura",
            "fearful": "shocked widened eyes, defensive tense posture",
            "whispering": "mysterious soft smirk, close whisper posture"
        }

        pose_map = {
            "stand": "standing majestically",
            "fight": "dynamic combat martial arts stance, motion lines, glowing aura",
            "look_back": "looking over shoulder back at camera, dramatic turn",
            "run": "sprinting forward at high speed, wind blowing hair and clothes"
        }

        char_tag = f"(({character.name}:1.2)), {character.visual_prompt}" if character.visual_prompt else character.name
        emo_tag = emotion_map.get(emotion, emotion_map["neutral"])
        pos_tag = pose_map.get(pose, pose_map["stand"])

        return f"{base_shot_prompt}, {char_tag}, {emo_tag}, {pos_tag}, master lighting, consistent character features, ultra-detailed face"

consistency_engine = ConsistencyEngine()
