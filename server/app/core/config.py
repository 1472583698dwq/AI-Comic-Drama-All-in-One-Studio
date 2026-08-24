import os
from pathlib import Path
from typing import Dict
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

# Keys managed via the Config page / API
MANAGED_KEYS = [
    # MiniMax
    "MINIMAX_API_KEY",
    "MINIMAX_GROUP_ID",
    "MINIMAX_BASE_URL",
    "LLM_MODEL",
    "TTS_MODEL",
    "VIDEO_MODEL",
    # LLM Provider & OpenAI / Responses API / DeepSeek / Qwen / SiliconFlow
    "LLM_PROVIDER",
    "LLM_API_TYPE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "RESPONSES_API_URL",
    "RESPONSES_API_KEY",
    "RESPONSES_MODEL",
    # Image Generation
    "IMAGE_PROVIDER",
    "COMFYUI_SERVER_URL",
    "COMFYUI_CHECKPOINT",
    "COMFYUI_TIMEOUT_SECONDS",
    "COMFYUI_WORKFLOWS_DIR",
    "SILICONFLOW_API_KEY",
    "SILICONFLOW_IMAGE_MODEL",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_IMAGE_MODEL",
    "OPENAI_IMAGE_MODEL",
    "OPENAI_IMAGE_BASE_URL",
    # Voice & TTS
    "TTS_PROVIDER",
    "COSYVOICE_URL",
    "GPTSOVITS_URL",
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_MODEL",
    # Video Generation
    "VIDEO_PROVIDER",
    "KLING_API_KEY",
    "VIDU_API_KEY",
    # JianYing Draft & Paths
    "JIANYIN_DRAFT_PATH",
]

def _mask_value(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "****"
    return value[:4] + "****" + value[-4:]

def get_default_jianyin_draft_path() -> str:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        candidate = os.path.join(local_app_data, "JianyingPro", "User Data", "Projects", "com.lveditor.draft")
        if os.path.exists(candidate):
            return candidate.replace("\\", "/")
    return ""

class Settings(BaseModel):
    PROJECT_NAME: str = "MiniMax AI Comic Drama Studio"
    API_V1_STR: str = "/api/v1"
    
    # MiniMax API Configuration
    MINIMAX_API_KEY: str = os.getenv("MINIMAX_API_KEY", "")
    MINIMAX_GROUP_ID: str = os.getenv("MINIMAX_GROUP_ID", "")
    MINIMAX_BASE_URL: str = os.getenv("MINIMAX_BASE_URL", "https://api.minimax.chat/v1")
    
    # Model names
    LLM_MODEL: str = os.getenv("LLM_MODEL", "abab6.5s-chat")
    TTS_MODEL: str = os.getenv("TTS_MODEL", "speech-01-turbo")
    VIDEO_MODEL: str = os.getenv("VIDEO_MODEL", "video-01")

    # LLM Provider & OpenAI-compatible / Responses API (DeepSeek / Qwen / SiliconFlow / Kimi / OpenAI)
    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "openai_compatible") # openai_compatible, responses_api, deepseek, qwen, siliconflow, minimax
    LLM_API_TYPE: str = os.getenv("LLM_API_TYPE", "chat_completions") # chat_completions, responses_api
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    OPENAI_BASE_URL: str = os.getenv("OPENAI_BASE_URL", "https://api.deepseek.com/v1")
    OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "deepseek-chat")
    RESPONSES_API_URL: str = os.getenv("RESPONSES_API_URL", "https://api.openai.com/v1/responses")
    RESPONSES_API_KEY: str = os.getenv("RESPONSES_API_KEY", "")
    RESPONSES_MODEL: str = os.getenv("RESPONSES_MODEL", "gpt-4o")

    # Image Generation Providers
    IMAGE_PROVIDER: str = os.getenv("IMAGE_PROVIDER", "comfyui") # comfyui, siliconflow, dashscope, openai_compat
    COMFYUI_SERVER_URL: str = os.getenv("COMFYUI_SERVER_URL", "http://127.0.0.1:8188")
    COMFYUI_CHECKPOINT: str = os.getenv("COMFYUI_CHECKPOINT", "")
    COMFYUI_TIMEOUT_SECONDS: int = int(os.getenv("COMFYUI_TIMEOUT_SECONDS", "240"))
    COMFYUI_WORKFLOWS_DIR: str = os.getenv("COMFYUI_WORKFLOWS_DIR", "")
    SILICONFLOW_API_KEY: str = os.getenv("SILICONFLOW_API_KEY", "")
    SILICONFLOW_IMAGE_MODEL: str = os.getenv("SILICONFLOW_IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell")
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")
    DASHSCOPE_IMAGE_MODEL: str = os.getenv("DASHSCOPE_IMAGE_MODEL", "wanx2.1-t2i-turbo")
    OPENAI_IMAGE_MODEL: str = os.getenv("OPENAI_IMAGE_MODEL", "dall-e-3")
    OPENAI_IMAGE_BASE_URL: str = os.getenv("OPENAI_IMAGE_BASE_URL", "")

    # Voice & TTS Providers
    TTS_PROVIDER: str = os.getenv("TTS_PROVIDER", "minimax") # minimax, cosyvoice, gpt_sovits, elevenlabs
    COSYVOICE_URL: str = os.getenv("COSYVOICE_URL", "http://127.0.0.1:9233")
    GPTSOVITS_URL: str = os.getenv("GPTSOVITS_URL", "http://127.0.0.1:9880")
    ELEVENLABS_API_KEY: str = os.getenv("ELEVENLABS_API_KEY", "")
    ELEVENLABS_MODEL: str = os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")

    # Video Generation Providers
    VIDEO_PROVIDER: str = os.getenv("VIDEO_PROVIDER", "minimax") # minimax, kling, vidu
    KLING_API_KEY: str = os.getenv("KLING_API_KEY", "")
    VIDU_API_KEY: str = os.getenv("VIDU_API_KEY", "")

    # JianYing Draft Custom Location
    JIANYIN_DRAFT_PATH: str = os.getenv("JIANYIN_DRAFT_PATH", get_default_jianyin_draft_path())

    # Local paths
    STORAGE_DIR: str = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../storage"))
    EXPORTS_DIR: str = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../exports"))

    def to_public_dict(self, masked: bool = True) -> Dict[str, str]:
        """Return managed keys. API keys are masked by default."""
        data: Dict[str, str] = {}
        for k in MANAGED_KEYS:
            v = str(getattr(self, k, ""))
            if (k.endswith("_API_KEY") or k == "MINIMAX_API_KEY") and masked and v:
                v = _mask_value(v)
            data[k] = v
        return data

settings = Settings()

os.makedirs(settings.STORAGE_DIR, exist_ok=True)
os.makedirs(settings.EXPORTS_DIR, exist_ok=True)

# ------------------------------------------------------------------
# .env read / write helpers (used by /api/v1/config endpoints)
# ------------------------------------------------------------------
def _parse_env_file() -> Dict[str, str]:
    result: Dict[str, str] = {}
    if not ENV_FILE.exists():
        return result
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        result[k.strip()] = v.strip().strip('"').strip("'")
    return result

def read_env_file() -> Dict[str, str]:
    """Raw values from .env (unmasked)."""
    merged = _parse_env_file()
    # Fill defaults for keys not yet persisted
    for k in MANAGED_KEYS:
        if k not in merged:
            merged[k] = str(getattr(settings, k, ""))
    return {k: merged.get(k, "") for k in MANAGED_KEYS}

def write_env_file(updates: Dict[str, str]) -> None:
    """Merge updates into .env and reload settings in-place."""
    existing: Dict[str, str] = {}
    header_lines: list[str] = []
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or "=" not in raw:
                header_lines.append(raw)
                continue
            k = raw.split("=", 1)[0].strip()
            if k not in MANAGED_KEYS:
                header_lines.append(raw)
            else:
                existing[k] = raw.split("=", 1)[1].strip()

    for k in MANAGED_KEYS:
        if k in updates:
            existing[k] = updates[k]

    # Rebuild file: keep header/comments, then managed keys
    lines: list[str] = []
    if header_lines:
        lines.extend(header_lines)
        if lines and lines[-1].strip() != "":
            lines.append("")
    for k in MANAGED_KEYS:
        v = existing.get(k, str(getattr(settings, k, "")))
        lines.append(f"{k}={v}")

    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Hot-reload in-memory settings
    for k in MANAGED_KEYS:
        if k in updates:
            val = updates[k]
            if k == "COMFYUI_TIMEOUT_SECONDS":
                try:
                    object.__setattr__(settings, k, int(val))
                except ValueError:
                    object.__setattr__(settings, k, 240)
            else:
                object.__setattr__(settings, k, val)
            os.environ[k] = str(getattr(settings, k))
