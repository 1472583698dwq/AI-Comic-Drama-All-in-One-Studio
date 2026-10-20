# -*- coding: utf-8 -*-
"""
全局配置与持久化引擎
支持多重路径自动探测与双重持久化保证：
1. 优先读取并写入工作区/根目录 `.env`
2. 同步写入 `storage/config_store.json` 作为热备
3. 在打包独立运行环境 (PyInstaller) 下自动落盘至可执行文件同级目录
4. 支持内存热重载与多 Provider 动态即时生效
"""
import os
import re
import sys
import json
from pathlib import Path
from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from dotenv import load_dotenv

#: 应用版本 —— **唯一真相源**：FastAPI 元信息（`app/main.py`）与插件 manifest 的
#: `min_app_version` 校验（`app/plugins/manager.py`）共用同一个值，避免两处漂移。
APP_VERSION = "2.1.0"

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
    "OPENAI_CUSTOM_HEADERS",
    "RESPONSES_API_URL",
    "RESPONSES_API_KEY",
    "RESPONSES_MODEL",
    # Image Generation
    "IMAGE_PROVIDER",
    "IMAGE_EDIT_PROVIDER",
    "COMFYUI_SERVER_URL",
    "COMFYUI_CHECKPOINT",
    "COMFYUI_TIMEOUT_SECONDS",
    "COMFYUI_WORKFLOWS_DIR",
    "COMFYUI_DEFAULT_IMAGE_WORKFLOW",
    "SILICONFLOW_API_KEY",
    "SILICONFLOW_IMAGE_MODEL",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_IMAGE_MODEL",
    "OPENAI_IMAGE_MODEL",
    "OPENAI_IMAGE_BASE_URL",
    "OPENAI_IMAGE_API_KEY",
    # l0veyou 网页生图（网页登录令牌，会轮换，见 providers/image/l0veyou_web.py）
    "L0VEYOU_BASE_URL",
    "L0VEYOU_ACCESS_TOKEN",
    "L0VEYOU_REFRESH_TOKEN",
    "L0VEYOU_IMAGE_MODEL",
    # Voice & TTS
    "TTS_PROVIDER",
    "COSYVOICE_URL",
    "GPTSOVITS_URL",
    "INDEXTTS_URL",
    "INDEXTTS_REF_AUDIO",
    "INDEXTTS_LANG",
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_MODEL",
    # Video Generation
    "VIDEO_PROVIDER",
    "COMFYUI_DEFAULT_VIDEO_WORKFLOW",
    "KLING_API_KEY",
    "KLING_BASE_URL",
    "KLING_MODEL",
    "VIDU_API_KEY",
    "MINIMAX_H3_MODEL",
    "MINIMAX_H3_BASE_URL",
    "SEEDANCE_API_KEY",
    "SEEDANCE_BASE_URL",
    "SEEDANCE_MODEL",
    "WAN_API_KEY",
    "WAN3_MODEL",
    "WAN3_BASE_URL",
    # OpenAI 兼容视频（自定义通道：独立 Key / 地址 / 模型，与文本/生图互不影响）
    "OPENAI_VIDEO_API_KEY",
    "OPENAI_VIDEO_BASE_URL",
    "OPENAI_VIDEO_MODEL",
    # JianYing Draft & Paths
    "JIANYIN_DRAFT_PATH",
    # 云端素材/工程同步（OpenList）
    "OPENLIST_SYNC_ENABLED",
    "OPENLIST_BASE_URL",
    "OPENLIST_USERNAME",
    "OPENLIST_PASSWORD",
    "OPENLIST_ROOT",
    # Trusted Mode 总闸（A档）
    "STUDIO_TRUSTED_MODE",
]


def _is_secret_key(key: str) -> bool:
    """要打码后才能回显给前端的键。"""
    return key.endswith("_API_KEY") or key in (
        "MINIMAX_API_KEY", "OPENLIST_PASSWORD", "L0VEYOU_ACCESS_TOKEN", "L0VEYOU_REFRESH_TOKEN",
    )


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


def get_possible_env_paths() -> List[Path]:
    """获取所有潜在的 .env 文件路径列表（按优先级排序）"""
    paths: List[Path] = []

    # 1. 如果是 PyInstaller 独立打包运行
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).parent
        paths.append(exe_dir / ".env")
        paths.append(exe_dir / "server" / ".env")

    # 2. 当前工作目录
    cwd = Path(os.getcwd())
    paths.append(cwd / ".env")
    paths.append(cwd / "server" / ".env")

    # 3. 基于当前代码文件的向上探测
    this_file = Path(__file__).resolve()
    # parents: [core, app, server, root]
    if len(this_file.parents) >= 3:
        paths.append(this_file.parents[2] / ".env")  # root
        paths.append(this_file.parents[1] / ".env")  # server
    if len(this_file.parents) >= 4:
        paths.append(this_file.parents[3] / ".env")

    # 去重
    unique_paths: List[Path] = []
    seen = set()
    for p in paths:
        try:
            resolved = p.resolve()
            if str(resolved) not in seen:
                seen.add(str(resolved))
                unique_paths.append(resolved)
        except Exception:
            if str(p) not in seen:
                seen.add(str(p))
                unique_paths.append(p)
    return unique_paths


def get_primary_env_file() -> Path:
    """获取主要的目标 .env 文件路径"""
    paths = get_possible_env_paths()
    for p in paths:
        if p.exists():
            return p
    # 若均不存在，优先选择最顶层的工作区 .env
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent / ".env"
    return paths[0] if paths else Path(os.getcwd()) / ".env"


# 初始化时从所有潜在的 .env 中合并加载
for _env_p in reversed(get_possible_env_paths()):
    if _env_p.exists():
        load_dotenv(_env_p, override=True)


class Settings(BaseModel):
    PROJECT_NAME: str = "MiniMax AI Comic Drama Studio"
    API_V1_STR: str = "/api/v1"

    # MiniMax API Configuration
    MINIMAX_API_KEY: str = os.getenv("MINIMAX_API_KEY", "")
    MINIMAX_GROUP_ID: str = os.getenv("MINIMAX_GROUP_ID", "")
    MINIMAX_BASE_URL: str = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com/v1")

    # Model names
    LLM_MODEL: str = os.getenv("LLM_MODEL", "MiniMax-M2.5")
    TTS_MODEL: str = os.getenv("TTS_MODEL", "speech-2.8-turbo")
    VIDEO_MODEL: str = os.getenv("VIDEO_MODEL", "MiniMax-Hailuo-02")

    # LLM Provider & OpenAI-compatible / Responses API (DeepSeek / Qwen / SiliconFlow / Kimi / OpenAI)
    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "openai_compatible")
    LLM_API_TYPE: str = os.getenv("LLM_API_TYPE", "chat_completions")
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    OPENAI_BASE_URL: str = os.getenv("OPENAI_BASE_URL", "https://api.deepseek.com/v1")
    OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "deepseek-v4-flash")
    OPENAI_CUSTOM_HEADERS: str = os.getenv("OPENAI_CUSTOM_HEADERS", "")
    RESPONSES_API_URL: str = os.getenv("RESPONSES_API_URL", "https://api.openai.com/v1/responses")
    RESPONSES_API_KEY: str = os.getenv("RESPONSES_API_KEY", "")
    RESPONSES_MODEL: str = os.getenv("RESPONSES_MODEL", "gpt-5.2")
    # REQ-toonflow-canvas FX-B 画布节点「智能规划」LLM 总预算（秒，缺省 90；超时降级规则规划，见 canvas/agent_plan.py）
    CANVAS_AGENT_PLAN_TIMEOUT_S: str = os.getenv("CANVAS_AGENT_PLAN_TIMEOUT_S", "90")

    # Image Generation Providers
    # 默认走 OpenAI 兼容生图（gpt-image 系列）；未配置时注册表会自动回退到已配置的其它源（如 ComfyUI）
    IMAGE_PROVIDER: str = os.getenv("IMAGE_PROVIDER", "openai_compat")
    # 图像编辑源（i2i：多张参考图合成分镜/改图），留空 = 沿用 IMAGE_PROVIDER。
    # 生成与编辑是两类模型：定妆/三视图/场景空镜走 IMAGE_PROVIDER（生成）；
    # 把角色/场景多图合并成一张分镜画面走 IMAGE_EDIT_PROVIDER（编辑）。
    IMAGE_EDIT_PROVIDER: str = os.getenv("IMAGE_EDIT_PROVIDER", "")
    COMFYUI_SERVER_URL: str = os.getenv("COMFYUI_SERVER_URL", "http://127.0.0.1:8188")
    COMFYUI_CHECKPOINT: str = os.getenv("COMFYUI_CHECKPOINT", "")
    COMFYUI_TIMEOUT_SECONDS: int = int(os.getenv("COMFYUI_TIMEOUT_SECONDS", "1200"))
    COMFYUI_WORKFLOWS_DIR: str = os.getenv("COMFYUI_WORKFLOWS_DIR", "")
    COMFYUI_DEFAULT_IMAGE_WORKFLOW: str = os.getenv("COMFYUI_DEFAULT_IMAGE_WORKFLOW", os.getenv("COMFYUI_WORKFLOW_ID", ""))
    SILICONFLOW_API_KEY: str = os.getenv("SILICONFLOW_API_KEY", "")
    SILICONFLOW_IMAGE_MODEL: str = os.getenv("SILICONFLOW_IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell")
    DASHSCOPE_API_KEY: str = os.getenv("DASHSCOPE_API_KEY", "")
    DASHSCOPE_IMAGE_MODEL: str = os.getenv("DASHSCOPE_IMAGE_MODEL", "wan2.6-t2i")
    OPENAI_IMAGE_MODEL: str = os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-2.5-flare")
    OPENAI_IMAGE_BASE_URL: str = os.getenv("OPENAI_IMAGE_BASE_URL", "")
    # 生图专用 Key：留空则回退到 OPENAI_API_KEY（沿用文本网关）
    OPENAI_IMAGE_API_KEY: str = os.getenv("OPENAI_IMAGE_API_KEY", "")
    # l0veyou 网页生图：团队共用的默认登录会话，拉下代码即用（同 OPENLIST_* 的做法）。
    #
    # ⚠️ 这对令牌和普通 API Key 不一样，共用有硬限制：
    #   - access_token 寿命 24 小时，到期要用 refresh_token 续；
    #   - refresh_token 是一次性的——谁先续期，它就作废，新的一对只写进**续期那台机器**的本地配置。
    #   所以写在这里的默认值，对其他机器来说只在「第一台机器续期之前」有效（最多约 24 小时）。
    #   之后其他机器设置页的「测试」会报令牌失效，需要各自填自己的令牌（填了就覆盖这里的默认值）。
    #
    # 用 `getenv(...) or 默认值` 而不是 getenv 的第二个参数：设置页保存时会把没填的项写成空串，
    # 那样 getenv 拿到的是 ""，默认值会被悄悄盖掉。
    L0VEYOU_BASE_URL: str = os.getenv("L0VEYOU_BASE_URL") or "https://l0veyou.com"
    L0VEYOU_ACCESS_TOKEN: str = os.getenv("L0VEYOU_ACCESS_TOKEN") or "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjo0NzcwLCJlbWFpbCI6ImxpbnV4ZG8tMTMxNzkzQGxpbnV4ZG8tY29ubmVjdC5pbnZhbGlkIiwicm9sZSI6InVzZXIiLCJ0b2tlbl92ZXJzaW9uIjo1OTk1OTYwODgyMjkwNDYwMzY5LCJzaWQiOiI5ZmY0NzgxNzEzNzgwYzZkMjQ0MzJlZWRkYWY1ZGU4NyIsImJuZCI6ImQ1ZDk2YTEyYjFhMmJlYjZhNzBiNzUzNzI5ZjRlYWY2IiwiZXhwIjoxNzkxNTMxMjc4LCJuYmYiOjE3OTE0NDQ4NzgsImlhdCI6MTc5MTQ0NDg3OH0.qRN9xgRwi6NCyV4ydfD2I3CITD3BtI17RprbC2K1HzA"
    L0VEYOU_REFRESH_TOKEN: str = os.getenv("L0VEYOU_REFRESH_TOKEN") or "rt_f59521488512e2edc87a467cc985e839d8dea42a690ea39dc9d608466c477f60"
    L0VEYOU_IMAGE_MODEL: str = os.getenv("L0VEYOU_IMAGE_MODEL") or "gpt-image-2"
    L0VEYOU_TIMEOUT: str = os.getenv("L0VEYOU_TIMEOUT", "180")

    # Voice & TTS Providers
    TTS_PROVIDER: str = os.getenv("TTS_PROVIDER", "minimax")
    COSYVOICE_URL: str = os.getenv("COSYVOICE_URL", "http://127.0.0.1:9233")
    GPTSOVITS_URL: str = os.getenv("GPTSOVITS_URL", "http://127.0.0.1:9880")
    # IndexTTS-2.5（本机 Gradio）：音色靠参考音频零样本克隆
    INDEXTTS_URL: str = os.getenv("INDEXTTS_URL", "")
    INDEXTTS_REF_AUDIO: str = os.getenv("INDEXTTS_REF_AUDIO", "")
    INDEXTTS_LANG: str = os.getenv("INDEXTTS_LANG", "ZH")
    INDEXTTS_NUM_BEAMS: int = int(os.getenv("INDEXTTS_NUM_BEAMS", "3"))
    INDEXTTS_SEG_TOKENS: int = int(os.getenv("INDEXTTS_SEG_TOKENS", "120"))
    INDEXTTS_TIMEOUT: int = int(os.getenv("INDEXTTS_TIMEOUT", "1800"))
    ELEVENLABS_API_KEY: str = os.getenv("ELEVENLABS_API_KEY", "")
    ELEVENLABS_MODEL: str = os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")

    # Video Generation
    VIDEO_PROVIDER: str = os.getenv("VIDEO_PROVIDER", "comfyui_video")
    COMFYUI_DEFAULT_VIDEO_WORKFLOW: str = os.getenv("COMFYUI_DEFAULT_VIDEO_WORKFLOW", os.getenv("COMFYUI_VIDEO_WORKFLOW_ID", ""))
    KLING_API_KEY: str = os.getenv("KLING_API_KEY", "")
    KLING_BASE_URL: str = os.getenv("KLING_BASE_URL", "https://api-beijing.klingai.com")
    KLING_MODEL: str = os.getenv("KLING_MODEL", "kling-v3")
    VIDU_API_KEY: str = os.getenv("VIDU_API_KEY", "")
    # MiniMax H3 (V2 多模态视频, 与 MINIMAX_API_KEY 同平台, 模型固定 MiniMax-H3)
    MINIMAX_H3_MODEL: str = os.getenv("MINIMAX_H3_MODEL", "MiniMax-H3")
    MINIMAX_H3_BASE_URL: str = os.getenv("MINIMAX_H3_BASE_URL", "https://api.minimaxi.com")
    # Seedance (字节火山引擎 Ark, doubao-seedance 系列)
    SEEDANCE_API_KEY: str = os.getenv("SEEDANCE_API_KEY", "")
    SEEDANCE_BASE_URL: str = os.getenv("SEEDANCE_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
    SEEDANCE_MODEL: str = os.getenv("SEEDANCE_MODEL", "doubao-seedance-2-0-260128")
    # 万相 Wan3.0：独立 Key + 账号专属 MaaS 实例地址（与通用 DashScope 不是一套）；
    # 留空时回退 DASHSCOPE_API_KEY 以兼容存量配置
    WAN_API_KEY: str = os.getenv("WAN_API_KEY", "")
    WAN3_MODEL: str = os.getenv("WAN3_MODEL", "wan3.0-video")
    WAN3_BASE_URL: str = os.getenv("WAN3_BASE_URL", "https://dashscope.aliyuncs.com")
    # OpenAI 兼容视频（自定义通道，按 OpenAI /v1/videos 协议对接任意中转/自建网关）
    OPENAI_VIDEO_API_KEY: str = os.getenv("OPENAI_VIDEO_API_KEY", "")
    OPENAI_VIDEO_BASE_URL: str = os.getenv("OPENAI_VIDEO_BASE_URL", "https://api.openai.com/v1")
    OPENAI_VIDEO_MODEL: str = os.getenv("OPENAI_VIDEO_MODEL", "sora-2")

    # JianYing Draft Custom Location
    JIANYIN_DRAFT_PATH: str = os.getenv("JIANYIN_DRAFT_PATH", get_default_jianyin_draft_path())

    # ── 云端素材/工程同步（OpenList）──────────────────────────
    # storage/ 下的素材与工程异步镜像到共用的 OpenList，换台机器按需拉回。
    #
    # 下面这套是**团队共用**的默认值，拉下代码即可用，不用再配。
    # 也就是说这个账号密码是随仓库分发的，任何拿到代码的人都能读写这块存储 ——
    # 它只管素材与工程，API Key 那些配置不在同步范围内，不会跟着出去。
    # 想收紧就在自己的 .env 里覆盖这几项（.env 不进仓库），或者换个受限账号。
    OPENLIST_SYNC_ENABLED: str = os.getenv("OPENLIST_SYNC_ENABLED", "1")
    # 默认走公网域名，换哪台机器都通；和 OpenList 同机跑的话在 .env 里
    # 覆盖成 http://127.0.0.1:5244 会快很多（实测 3MB：本地 1.4s / 公网 11s）
    OPENLIST_BASE_URL: str = os.getenv("OPENLIST_BASE_URL", "https://openlist.apeiria.cc.cd")
    OPENLIST_USERNAME: str = os.getenv("OPENLIST_USERNAME", "admin")
    OPENLIST_PASSWORD: str = os.getenv("OPENLIST_PASSWORD", "Autoword@773#")
    # 远端根目录：必须落在 OpenList 已挂载的存储下（那台挂的是 /autoword）
    OPENLIST_ROOT: str = os.getenv("OPENLIST_ROOT", "/autoword/comic-studio")
    # 以下三项只走 env，不进设置页：扫描间隔(秒) / 并发上传数 / 单次传输超时(秒)
    OPENLIST_SCAN_INTERVAL: str = os.getenv("OPENLIST_SCAN_INTERVAL", "20")
    OPENLIST_WORKERS: str = os.getenv("OPENLIST_WORKERS", "2")
    OPENLIST_TIMEOUT: str = os.getenv("OPENLIST_TIMEOUT", "300")
    # 每个可变文件在云端保留几个历史版本，超出的删掉
    OPENLIST_KEEP_VERSIONS: str = os.getenv("OPENLIST_KEEP_VERSIONS", "20")

    # Trusted Mode（可信模式总闸）：允许自定义生成源 trusted=True 跳出沙箱 + Agent fs/shell 工具生效
    # 本地桌面端默认关闭，需显式 STUDIO_TRUSTED_MODE=1 开启。开启后仍需逐源勾选 trusted。
    STUDIO_TRUSTED_MODE: str = os.getenv("STUDIO_TRUSTED_MODE", "0")

    # 跨源白名单：默认只认本机来源。打包态前端由本服务同源 serve（不受影响）；
    # 开发态 vite 在 localhost:5173 直连本服务属真跨域，也在本机来源内。
    # 需要放行别的机器（如局域网手机）时追加：STUDIO_CORS_EXTRA_ORIGINS=http://192.168.1.10:5173
    STUDIO_CORS_EXTRA_ORIGINS: str = os.getenv("STUDIO_CORS_EXTRA_ORIGINS", "")

    # Local storage paths
    # 开发态：仓库根 storage；打包态：优先复用仓库根 storage（避免构建清空用户配置）
    STORAGE_DIR: str = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../storage")
        if not getattr(sys, "frozen", False)
        else (os.path.join(os.path.dirname(sys.executable), "..", "..", "storage") if os.path.exists(os.path.join(os.path.dirname(sys.executable), "..", "..", "storage")) else os.path.join(os.path.dirname(sys.executable), "storage"))
    )
    EXPORTS_DIR: str = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../exports")
        if not getattr(sys, "frozen", False)
        else (os.path.join(os.path.dirname(sys.executable), "..", "..", "exports") if os.path.exists(os.path.join(os.path.dirname(sys.executable), "..", "..", "exports")) else os.path.join(os.path.dirname(sys.executable), "exports"))
    )

    def to_public_dict(self, masked: bool = False) -> Dict[str, str]:
        """返回受管理的配置字段字典"""
        data: Dict[str, str] = {}
        for k in MANAGED_KEYS:
            v = str(getattr(self, k, ""))
            if masked and _is_secret_key(k) and v:
                v = _mask_value(v)
            data[k] = v
        return data


settings = Settings()
os.makedirs(settings.STORAGE_DIR, exist_ok=True)
os.makedirs(settings.EXPORTS_DIR, exist_ok=True)


def is_trusted_mode_enabled() -> bool:
    """可信模式总闸：显式 STUDIO_TRUSTED_MODE=1/true/on 才放行。"""
    try:
        v = str(getattr(settings, "STUDIO_TRUSTED_MODE", "0") or os.getenv("STUDIO_TRUSTED_MODE", "0")).strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
    except Exception:
        pass
    try:
        if str(os.getenv("STUDIO_TRUSTED_MODE", "")).strip().lower() in ("1", "true", "yes", "on"):
            return True
    except Exception:
        pass
    return False


_LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$", re.IGNORECASE)


def cors_extra_origins() -> List[str]:
    """STUDIO_CORS_EXTRA_ORIGINS 解析出的显式白名单（去尾斜杠）。"""
    raw = str(getattr(settings, "STUDIO_CORS_EXTRA_ORIGINS", "") or "")
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]


def is_local_or_allowed_origin(origin: str) -> bool:
    """跨源判断唯一口径：CORS 白名单与执行口 Origin 校验共用，避免两处规则漂移。

    空 Origin（curl、原生壳、部分同源请求）放行；`null`（file:// 与沙箱页）拒绝。
    """
    o = (origin or "").strip().rstrip("/")
    if not o:
        return True
    return bool(_LOCAL_ORIGIN_RE.match(o)) or o in cors_extra_origins()


ENV_FILE = get_primary_env_file()
JSON_CONFIG_FILE = os.path.join(settings.STORAGE_DIR, "config_store.json")


# ------------------------------------------------------------------
# JSON 备份与 .env 同步逻辑
# ------------------------------------------------------------------
def _load_json_config() -> Dict[str, str]:
    if os.path.exists(JSON_CONFIG_FILE):
        try:
            with open(JSON_CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return {k: str(v) for k, v in data.items()}
        except Exception as e:
            print(f"[Config] 加载 JSON 备份配置异常: {e}")
    return {}


def _save_json_config(data: Dict[str, str]) -> None:
    try:
        with open(JSON_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Config] 保存 JSON 备份配置异常: {e}")


def _parse_env_file(filepath: Path) -> Dict[str, str]:
    result: Dict[str, str] = {}
    if not filepath.exists():
        return result
    try:
        for raw in filepath.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            result[k.strip()] = v.strip().strip('"').strip("'")
    except Exception as e:
        print(f"[Config] 读取 .env 异常 ({filepath}): {e}")
    return result


def read_env_file(unmask: bool = True) -> Dict[str, str]:
    """读取所有已持久化的真实配置（按优先级合并 .env 与 config_store.json，非空优先）"""
    merged: Dict[str, str] = {}

    # 1. 优先读取 JSON 结构化存储
    json_data = _load_json_config()
    for k, v in json_data.items():
        if v:
            merged[k] = str(v)

    # 2. 读取所有潜在 .env 覆盖
    for env_p in reversed(get_possible_env_paths()):
        if env_p.exists():
            for k, v in _parse_env_file(env_p).items():
                if v:  # 仅非空值覆盖
                    merged[k] = v

    # 3. 填充 Settings 中的默认值
    for k in MANAGED_KEYS:
        if not merged.get(k):
            val = str(getattr(settings, k, ""))
            if val:
                merged[k] = val

    if not unmask:
        return {
            k: (_mask_value(v) if _is_secret_key(k) else v)
            for k, v in merged.items()
        }
    return {k: merged.get(k, "") for k in MANAGED_KEYS}


def write_env_file(updates: Dict[str, str]) -> None:
    """持久化更新至所有关联的 .env 文件和 config_store.json，并立即热重载内存中的 settings"""
    current_data = read_env_file(unmask=True)
    current_data.update({k: str(v) for k, v in updates.items() if v is not None})

    # 1. 写入 JSON 备份存储
    _save_json_config(current_data)

    # 2. 生成标准 .env 格式内容
    lines: List[str] = [
        "# ==================================================",
        "# AI 漫剧 Studio 核心配置 (.env)",
        "# 本文件由系统自动生成与持久化维护",
        "# ==================================================",
        "",
    ]
    for k in MANAGED_KEYS:
        v = current_data.get(k, "")
        if k == "OPENAI_CUSTOM_HEADERS" and v:
            try:
                parsed_json = json.loads(v)
                v = json.dumps(parsed_json, ensure_ascii=False)
                current_data[k] = v
            except Exception:
                v = str(v).replace("\r", "").replace("\n", " ").strip()
        lines.append(f"{k}={v}")

    env_content = "\n".join(lines) + "\n"

    # 3. 同步写入所有探测到的目标路径
    targets = get_possible_env_paths()
    primary = get_primary_env_file()
    if primary not in targets:
        targets.insert(0, primary)

    for target_path in targets:
        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(env_content, encoding="utf-8")
        except Exception as e:
            print(f"[Config] 写入 {target_path} 失败: {e}")

    # 4. 实时热重载内存 settings 与 os.environ
    for k in MANAGED_KEYS:
        if k in current_data:
            val = current_data[k]
            if k == "COMFYUI_TIMEOUT_SECONDS":
                try:
                    object.__setattr__(settings, k, int(val))
                except ValueError:
                    object.__setattr__(settings, k, 240)
            else:
                object.__setattr__(settings, k, val)
            os.environ[k] = str(getattr(settings, k))

    print(f"[Config] 全局配置已成功持久化并热重载生效！(主路径: {primary})")


# 启动时若存在配置存储，自动同步至内存 settings
try:
    _initial_config = read_env_file(unmask=True)
    for _k, _v in _initial_config.items():
        if _v:
            if _k == "COMFYUI_TIMEOUT_SECONDS":
                try:
                    object.__setattr__(settings, _k, int(_v))
                except Exception:
                    pass
            else:
                object.__setattr__(settings, _k, _v)
            os.environ[_k] = str(_v)
except Exception as e:
    print(f"[Config] 初始加载配置异常: {e}")
