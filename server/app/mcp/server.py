"""
MCP 统一工具中枢 - 动态可扩展版
所有生成能力均通过 Provider Registry 动态分发，支持：
- 图片：comfyui(含工作流)/siliconflow/dashscope/openai_compat 动态扩展
- 音频：minimax/elevenlabs/cosyvoice/gpt_sovits 动态扩展
- 导演Agent 暴露全部生成工具
"""
import asyncio
import time
from typing import Dict, Any, List, Optional

from app.models.schemas import MCPToolDefinition, MCPToolCallResponse, Project
from app.pipelines.script_agent import script_agent
from app.pipelines.jianyin_exporter import jianyin_exporter

# Open-Source Integration: fastmcp
try:
    from fastmcp import FastMCP
    mcp_app = FastMCP("MiniMax-AI-Comic-Drama-MCP-Server")
    HAS_FASTMCP = True
except ImportError:
    HAS_FASTMCP = False
    mcp_app = None


# ========== A档可信模式：文件编辑 + 命令执行共用闸门与沙盒围栏 ==========
def _trusted_gate_or_raise():
    """总闸未开时直接明错，提示开启方式（不静默拒绝）。"""
    try:
        from app.core.config import is_trusted_mode_enabled
        if is_trusted_mode_enabled():
            return True
    except Exception:
        pass
    raise ValueError("可信模式未开启：需在 .env/环境变量设 STUDIO_TRUSTED_MODE=1 并重启后端（本地桌面端显式 opt-in，默认关闭）")


def _trusted_safe_roots():
    """A档允许的文件围栏：storage / exports / 工作区根。解析后必须落在此围栏内。"""
    import os as _os
    roots = []
    try:
        from app.core.config import settings as _settings
        roots.append(_os.path.abspath(_settings.STORAGE_DIR))
        roots.append(_os.path.abspath(_settings.EXPORTS_DIR))
    except Exception:
        pass
    try:
        roots.append(_os.path.abspath(_os.getcwd()))
    except Exception:
        pass
    try:
        roots.append(_trusted_repo_root())
    except Exception:
        pass
    # 去重
    uniq = []
    for r in roots:
        if r and r not in uniq:
            uniq.append(r)
    return uniq


def _trusted_repo_root() -> str:
    """仓库根（相对路径基址）：STORAGE_DIR 的父目录，兜底 cwd。"""
    import os as _os
    try:
        from app.core.config import settings as _settings2
        sd = _os.path.abspath(getattr(_settings2, "STORAGE_DIR", ""))
        if sd:
            return _os.path.abspath(_os.path.join(sd, ".."))
    except Exception:
        pass
    return _os.path.abspath(_os.getcwd())


def _resolve_trusted_path(path: str, allow_build_outputs: bool = False) -> str:
    """将用户传入 path 解析为绝对路径并校验围栏；越界/敏感文件直接拒绝。

    allow_build_outputs=True（只读查看 fs_read 用）：允许读 dist/build 构建产物目录；
    写操作（fs_file/shell）仍拦截，避免把改动落进构建产物。
    """
    import os as _os
    if not path or not str(path).strip():
        raise ValueError("path 不能为空")
    p = str(path).strip().replace("\\", "/")
    roots = _trusted_safe_roots()
    # 相对路径默认相对仓库根（含 storage 前缀的写法如 storage/... 可直达）
    if not _os.path.isabs(p) and not (len(p) > 2 and p[1] == ":"):
        p = _os.path.join(_trusted_repo_root(), p)
    ap = _os.path.abspath(p)
    # 围栏校验
    if roots and not any(ap == r or ap.startswith(r + _os.sep) for r in roots):
        raise ValueError(f"路径越界已拦截：{ap}（仅允许 {roots} 内）")
    # 敏感目录保护（最小集）
    deny = ["/.git/", "/__pycache__/", "/node_modules/", "/.venv/"]
    if not allow_build_outputs:
        deny += ["/dist/", "/build/"]
    low = ap.replace("\\", "/").lower()
    for seg in deny:
        if seg in low:
            raise ValueError(f"敏感目录已拦截：{seg.strip('/')}")
    return ap


_SHELL_DENY = ("rm -rf", "mkfs", "shutdown", "reboot", "halt", ":(){", "del /f /s /q c:\\", "format c:")


def _run_trusted_shell(command: str, cwd: str = "", timeout: int = 1200) -> dict:
    """A档 shell 执行：PowerShell(Win)/bash(Posix)，输出截断，超时可配（默认1200s=20分钟）。"""
    import os as _os
    import subprocess as _sp
    import sys as _sys
    _trusted_gate_or_raise()
    cmd = (command or "").strip()
    if not cmd:
        raise ValueError("command 不能为空")
    low = cmd.lower()
    for pat in _SHELL_DENY:
        if pat in low:
            raise ValueError(f"危险命令已拦截：{pat}")
    try:
        timeout = int(timeout or 1200)
    except Exception:
        timeout = 1200
    timeout = max(5, min(1200, timeout))
    # cwd 围栏（默认仓库根）
    if cwd and str(cwd).strip():
        workdir = _resolve_trusted_path(str(cwd).strip())
        if not _os.path.isdir(workdir):
            raise ValueError(f"cwd 不存在或非目录：{workdir}")
    else:
        workdir = _trusted_repo_root()
    if _sys.platform.startswith("win"):
        proc = _sp.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
                       cwd=workdir, capture_output=True, text=True, timeout=timeout)
    else:
        proc = _sp.run(["bash", "-lc", cmd], cwd=workdir, capture_output=True, text=True, timeout=timeout)
    out = (proc.stdout or "")[-12000:]
    err = (proc.stderr or "")[-4000:]
    return {"returncode": proc.returncode, "stdout": out, "stderr": err, "cwd": workdir, "truncated": bool(proc.stdout and len(proc.stdout) > 12000)}


def _fs_read_action(path: str, offset: int = 0, limit: int = 500, encoding: str = "utf-8") -> dict:
    """只读文件查看（无需可信模式）：围栏内 + 行分页（offset/limit），用于通读完整源码/JSON。

    - offset：起始行号（0 基）；limit：返回行数（默认 500，上限 2000）
    - 明文密钥类文件（.env / config_store.json）拒绝直读，防止泄进模型上下文
    - dist/build 构建产物允许只读查看（写操作仍由 fs_file 拦截）
    """
    import os as _os
    ap = _resolve_trusted_path(path, allow_build_outputs=True)
    base_low = _os.path.basename(ap).lower()
    if base_low in (".env", "config_store.json"):
        raise ValueError(f"敏感文件不允许直读（含明文密钥）：{ap}")
    if not _os.path.isfile(ap):
        raise ValueError(f"文件不存在：{ap}")
    size = _os.path.getsize(ap)
    if size > 5 * 1024 * 1024:
        raise ValueError(f"文件过大（>{5}MB）已拒绝：{ap}")
    try:
        off = max(0, int(offset or 0))
    except Exception:
        off = 0
    try:
        lim = int(limit or 500)
    except Exception:
        lim = 500
    lim = max(1, min(lim, 2000))
    enc = (encoding or "utf-8").strip() or "utf-8"
    lines: List[str] = []
    total = 0
    with open(ap, "r", encoding=enc, errors="ignore") as f:
        for i, line in enumerate(f):
            total = i + 1
            if off <= i < off + lim:
                lines.append(line)
    content = "".join(lines)
    end = off + len(lines)
    return {
        "path": ap.replace("\\", "/"),
        "offset": off,
        "limit": lim,
        "returned_lines": len(lines),
        "total_lines": total,
        "has_more": end < total,
        "next_offset": end if end < total else None,
        "content": content,
        "size": size,
    }


def _fs_file_action(action: str, path: str, content: str = "", encoding: str = "utf-8") -> dict:
    """A档文件工具单点实现：list/read/write/append/delete，全部走围栏校验 + 大小上限。"""
    import os as _os
    _trusted_gate_or_raise()
    act = (action or "").strip().lower()
    if act not in ("list", "read", "write", "append", "delete"):
        raise ValueError("action 需为 list/read/write/append/delete")
    ap = _resolve_trusted_path(path)
    enc = (encoding or "utf-8").strip() or "utf-8"
    if act == "list":
        if not _os.path.isdir(ap):
            raise ValueError(f"目录不存在：{ap}")
        items = []
        with _os.scandir(ap) as it:
            for e in it:
                try:
                    items.append({"name": e.name, "path": e.path.replace("\\", "/"), "is_dir": e.is_dir(), "size": e.stat().st_size if not e.is_dir() else 0})
                except Exception:
                    continue
                if len(items) >= 200:
                    break
        return {"path": ap.replace("\\", "/"), "items": items, "total": len(items)}
    if act == "read":
        if not _os.path.isfile(ap):
            raise ValueError(f"文件不存在：{ap}")
        if _os.path.getsize(ap) > 200 * 1024:
            raise ValueError(f"文件过大（>200KB）拒绝直读：{ap}，请用 shell 分段查看")
        with open(ap, "r", encoding=enc, errors="ignore") as f:
            data = f.read()
        return {"path": ap.replace("\\", "/"), "content": data[:60000], "size": len(data), "truncated": len(data) > 60000}
    if act in ("write", "append"):
        if content is None:
            content = ""
        if len(content) > 1024 * 1024:
            raise ValueError("写入内容过大（>1MB）已拒绝")
        parent = _os.path.dirname(ap)
        if parent:
            _os.makedirs(parent, exist_ok=True)
        mode = "a" if act == "append" else "w"
        with open(ap, mode, encoding=enc) as f:
            f.write(content)
        return {"path": ap.replace("\\", "/"), "action": act, "bytes": len(content.encode(enc, errors="ignore"))}
    # delete：仅文件，不删目录（防误删）；删后不可恢复，请谨慎
    if not _os.path.isfile(ap):
        raise ValueError(f"文件不存在：{ap}")
    _os.remove(ap)
    return {"path": ap.replace("\\", "/"), "action": "deleted"}


# 相机参数计算表 (景别与光学参数)
FRAMING_CAMERA = {
    "extreme_close_up": {"fov": 22, "focal_length_mm": 85, "position": [0, 1.68, 0.75], "target": [0, 1.68, 0], "desc": "眼神/微表情大特写"},
    "close_up": {"fov": 30, "focal_length_mm": 50, "position": [0, 1.55, 1.35], "target": [0, 1.5, 0], "desc": "面部与半身特写"},
    "medium": {"fov": 45, "focal_length_mm": 35, "position": [0, 1.3, 2.4], "target": [0, 1.25, 0], "desc": "胸部以上叙事中景"},
    "full": {"fov": 50, "focal_length_mm": 28, "position": [0, 1.15, 3.8], "target": [0, 1.0, 0], "desc": "全身与站位全景"},
    "long": {"fov": 58, "focal_length_mm": 24, "position": [0, 1.6, 6.0], "target": [0, 1.1, 0], "desc": "远景与宏大环境"},
    "bird_eye": {"fov": 65, "focal_length_mm": 20, "position": [0, 4.5, 2.0], "target": [0, 0.5, 0], "desc": "高空鸟瞰俯冲"},
    "low_angle": {"fov": 52, "focal_length_mm": 28, "position": [0, 0.25, 1.8], "target": [0, 1.5, 0], "desc": "贴地仰角英雄机位"},
    "over_shoulder": {"fov": 42, "focal_length_mm": 40, "position": [0.6, 1.55, 1.9], "target": [-0.2, 1.4, -0.2], "desc": "过肩纵深对峙机位"},
    "dutch_angle": {"fov": 48, "focal_length_mm": 32, "position": [0, 1.2, 2.2], "target": [0, 1.2, 0], "roll_deg": -15.0, "desc": "荷兰角倾斜悬疑机位"},
    "high_angle": {"fov": 55, "focal_length_mm": 28, "position": [0, 2.8, 2.8], "target": [0, 1.0, 0], "desc": "俯角压制视点"},
}

# 15+ 电影级运镜与 5 大双轴复合运镜矩阵 (MiniMax 01-Director 规范)
MOTION_TRAJECTORY = {
    # 基础单轴运镜
    "static": {"path_type": "hold", "amplitude_m": 0.0, "duration_hint_s": 0.0, "minimax_label": "Static Camera, Locked Shot"},
    "push_in": {"path_type": "dolly_in", "amplitude_m": 0.9, "duration_hint_s": 2.0, "minimax_label": "Dolly In, Push towards subject"},
    "pull_out": {"path_type": "dolly_out", "amplitude_m": 1.2, "duration_hint_s": 2.2, "minimax_label": "Dolly Out, Reveal surroundings"},
    "pan_left": {"path_type": "pan", "amplitude_deg": -35.0, "duration_hint_s": 1.8, "minimax_label": "Pan Left, Smooth horizontal turn"},
    "pan_right": {"path_type": "pan", "amplitude_deg": 35.0, "duration_hint_s": 1.8, "minimax_label": "Pan Right, Smooth horizontal turn"},
    "tilt_up": {"path_type": "tilt", "amplitude_deg": 25.0, "duration_hint_s": 1.5, "minimax_label": "Tilt Up, Ascending view"},
    "tilt_down": {"path_type": "tilt", "amplitude_deg": -25.0, "duration_hint_s": 1.5, "minimax_label": "Tilt Down, Descending view"},
    "orbit": {"path_type": "orbit", "amplitude_deg": 180.0, "duration_hint_s": 3.5, "minimax_label": "Orbit Clockwise 180°, Cinematic arc shot"},
    "orbit_ccw": {"path_type": "orbit_ccw", "amplitude_deg": -180.0, "duration_hint_s": 3.5, "minimax_label": "Orbit Counter-Clockwise 180°"},
    "truck_left": {"path_type": "truck_left", "amplitude_m": 1.5, "duration_hint_s": 2.0, "minimax_label": "Truck Left, Lateral tracking"},
    "truck_right": {"path_type": "truck_right", "amplitude_m": 1.5, "duration_hint_s": 2.0, "minimax_label": "Truck Right, Lateral tracking"},
    "boom_up": {"path_type": "boom_up", "amplitude_m": 1.8, "duration_hint_s": 2.2, "minimax_label": "Pedestal Up / Boom Up, Crane elevation"},
    "boom_down": {"path_type": "boom_down", "amplitude_m": -1.5, "duration_hint_s": 2.2, "minimax_label": "Pedestal Down / Crane Down"},
    "roll_left": {"path_type": "roll", "amplitude_deg": -25.0, "duration_hint_s": 1.8, "minimax_label": "Dutch Roll Left, Dynamic rotation"},
    "roll_right": {"path_type": "roll", "amplitude_deg": 25.0, "duration_hint_s": 1.8, "minimax_label": "Dutch Roll Right, Dynamic rotation"},
    "tracking": {"path_type": "follow", "amplitude_m": 1.8, "duration_hint_s": 2.5, "minimax_label": "Forward Tracking Shot, Follow subject"},
    "shake": {"path_type": "handheld_shake", "amplitude_m": 0.08, "frequency_hz": 9.0, "duration_hint_s": 1.5, "minimax_label": "Handheld Camera Shake, Action impact"},
    
    # 5 大电影级双轴复合运镜 (MiniMax Combos)
    "dolly_zoom": {"path_type": "vertigo", "amplitude_m": 1.2, "fov_delta": 22.0, "duration_hint_s": 3.0, "minimax_label": "Hitchcock Vertigo Zoom (Dolly In + Zoom Out), Psychological tension"},
    "orbit_boom_up": {"path_type": "spiral_up", "amplitude_deg": 180.0, "height_delta_m": 1.5, "duration_hint_s": 3.5, "minimax_label": "Orbit + Pedestal Up, Heroic ascending spiral reveal"},
    "pan_left_crane_down": {"path_type": "pan_crane", "amplitude_deg": -40.0, "height_delta_m": -1.6, "duration_hint_s": 3.0, "minimax_label": "Pan Left + Crane Down, Environment sweep to battle focus"},
    "fast_push_shake": {"path_type": "explosive_push", "amplitude_m": 1.4, "shake_intensity": 0.12, "duration_hint_s": 1.5, "minimax_label": "Fast Explosive Push-In with Impact Shake, Climax strike"},
    "low_angle_truck_right": {"path_type": "low_truck", "amplitude_m": 1.6, "duration_hint_s": 2.2, "minimax_label": "Low-Angle Ground Lateral Slide (Truck Right), Dramatic martial hero"},
}


def build_minimax_camera_prompt(framing: str, motion: str, focal_length_mm: float = 35.0, roll_deg: float = 0.0, speed: str = "1.0x") -> str:
    """生成符合 MiniMax 01-Director / Hailuo AI 规范的结构化运镜提示词标签"""
    f_info = FRAMING_CAMERA.get(framing, FRAMING_CAMERA["medium"])
    m_info = MOTION_TRAJECTORY.get(motion, MOTION_TRAJECTORY["push_in"])
    
    parts = []
    # 1. 运镜动效
    parts.append(f"Motion: {m_info.get('minimax_label', motion)}")
    # 2. 景别
    parts.append(f"Framing: {framing.replace('_', ' ').title()}")
    # 3. 镜头焦距
    fl = focal_length_mm or f_info.get("focal_length_mm", 35)
    parts.append(f"Lens: {int(fl)}mm")
    # 4. 倾斜角
    if abs(roll_deg) > 1.0:
        parts.append(f"Dutch Roll: {roll_deg:+.1f}°")
    # 5. 速度
    if speed and speed != "1.0x":
        parts.append(f"Speed: {speed}")
    
    return f"[Camera: {', '.join(parts)}]"


def _lazy_image_registry():
    from app.providers.image.registry import image_registry
    from app.providers.init_providers import init_all_providers
    # 确保已初始化
    if not image_registry.list_ids():
        try:
            init_all_providers()
        except Exception:
            pass
    return image_registry

def _lazy_audio_registry():
    from app.providers.audio.registry import audio_registry
    from app.providers.init_providers import init_all_providers
    if not audio_registry.list_ids():
        try:
            init_all_providers()
        except Exception:
            pass
    return audio_registry

def _lazy_video_registry():
    from app.providers.video.registry import video_registry
    from app.providers.init_providers import init_all_providers
    if not video_registry.list_ids():
        try:
            init_all_providers()
        except Exception:
            pass
    return video_registry

def _lazy_workflow_manager():
    from app.providers.workflow.manager import workflow_manager
    return workflow_manager

def _lazy_asset_manager():
    from app.providers.asset.manager import asset_manager
    return asset_manager

def _infer_kind_from_doc(doc: str, url: str = "") -> str | None:
    low = f"{doc or ''} {url or ''}".lower()
    if any(k in low for k in ["video", "minimax_h3", "lightx2v", "kling", "vidu", "hailuo"]):
        if "video" in low or "h3" in low or "lightx2v" in low:
            return "video"
    if any(k in low for k in ["audio", "tts", "voice", "speech"]):
        return "audio"
    return None


class MCPServerRegistry:
    def __init__(self):
        self.tools: Dict[str, MCPToolDefinition] = {}
        self._register_default_tools()
        # 动态 Provider→MCP Tool 统一暴露（异构参数即工具输入）
        try:
            self._register_provider_dynamic_tools()
        except Exception as e:
            print(f"[MCP] provider dynamic tools init failed: {e}")
        if HAS_FASTMCP and mcp_app:
            self._setup_fastmcp_tools()

    def _setup_fastmcp_tools(self):
        """Register tools to FastMCP server instance"""
        @mcp_app.tool
        async def split_novel_script(novel_text: str, style_preset: str = "donghua_xianxia", aspect_ratio: str = "9:16") -> dict:
            """解析长篇小说章节并输出分镜 JSON"""
            proj = await script_agent.parse_novel_to_project(novel_text, style_preset, aspect_ratio)
            return proj.model_dump()

        @mcp_app.tool
        async def generate_image(prompt: str, provider: str = "", workflow_id: str = "", aspect_ratio: str = "9:16", style_preset: str = "donghua_xianxia", negative_prompt: str = "", seed: int = 0) -> dict:
            """通用图片生成（动态Provider + 工作流）"""
            from app.providers.image.base import ImageGenerateRequest
            reg = _lazy_image_registry()
            req = ImageGenerateRequest(prompt=prompt, negative_prompt=negative_prompt, aspect_ratio=aspect_ratio, style_preset=style_preset or None, seed=seed if seed else None, workflow_id=workflow_id or None, provider=provider or None)
            # 指定provider或使用workflow则精确路由
            prov_id = provider if provider else ("comfyui" if workflow_id else None)
            res = await reg.generate(req, provider_id=prov_id)
            return {"image_url": res.image_url, "local_path": res.local_path, "provider": res.provider, "engine": res.engine, "seed": res.seed}

        @mcp_app.tool
        async def generate_voice(text: str, voice_id: str = "", provider: str = "", emotion: str = "", speed: float = 1.0) -> dict:
            """通用语音生成（动态Provider；provider/voice_id 留空 = 系统默认源 + 该源声明的默认音色）"""
            from app.providers.audio.base import AudioGenerateRequest
            reg = _lazy_audio_registry()
            req = AudioGenerateRequest(text=text, voice_id=voice_id or "", emotion=emotion or "", speed=speed)
            res = await reg.generate(req, provider_id=provider or None)
            return {"audio_url": res.audio_url, "duration": res.duration, "provider": res.provider, "engine": res.engine}

        @mcp_app.tool
        async def comfyui_render_node(prompt: str, aspect_ratio: str = "9:16") -> dict:
            """ComfyUI 生图（兼容旧工具，内部走通用 generate_image）"""
            from app.providers.image.base import ImageGenerateRequest
            reg = _lazy_image_registry()
            req = ImageGenerateRequest(prompt=prompt, aspect_ratio=aspect_ratio)
            res = await reg.generate(req, provider_id="comfyui")
            return {"image_url": res.image_url, "provider": res.provider, "engine": res.engine}

        @mcp_app.tool
        async def generate_minimax_voice(text: str, voice_id: str = "", emotion: str = "") -> dict:
            """MiniMax 配音（兼容；voice_id/emotion 留空 = MiniMax 源声明的默认值）"""
            from app.providers.audio.base import AudioGenerateRequest
            reg = _lazy_audio_registry()
            req = AudioGenerateRequest(text=text, voice_id=voice_id or "", emotion=emotion or "")
            res = await reg.generate(req, provider_id="minimax")
            return {"audio_url": res.audio_url, "duration": res.duration, "provider": res.provider}

        @mcp_app.tool
        async def list_image_providers() -> dict:
            """列出所有图片Providers"""
            reg = _lazy_image_registry()
            return {"providers": reg.list_providers()}

        @mcp_app.tool
        async def list_voice_providers() -> dict:
            """列出所有音频Providers"""
            reg = _lazy_audio_registry()
            return {"providers": reg.list_providers()}

        @mcp_app.tool
        async def generate_video(prompt: str, mode: str = "i2v", first_frame_url: str = "", reference_images: list = None, duration: int = 5, provider: str = "") -> dict:
            """通用视频生成（图生视频/参考生视频/文生视频）"""
            from app.providers.video.base import VideoGenerateRequest
            reg = _lazy_video_registry()
            req = VideoGenerateRequest(prompt=prompt, mode=mode, first_frame_url=first_frame_url or None, reference_images=reference_images, duration=duration, provider=provider or None)
            res = await reg.generate(req, provider_id=provider or None)
            return {"video_url": res.video_url, "duration": res.duration, "provider": res.provider, "engine": res.engine, "task_id": res.task_id}

        @mcp_app.tool
        async def list_video_providers() -> dict:
            """列出所有视频Providers"""
            reg = _lazy_video_registry()
            return {"providers": reg.list_providers()}

        @mcp_app.tool
        async def list_assets(category: str = "", tag: str = "", q: str = "", page: int = 1, limit: int = 12) -> dict:
            """搜索/列出素材库（支持按 category/tag/q 过滤）"""
            mgr = _lazy_asset_manager()
            res = mgr.list_assets(category=category or None, tag=tag or None, q=q or None, page=page, limit=limit)
            return res

        @mcp_app.tool
        async def get_asset(asset_id: str) -> dict:
            """获取单个素材详情"""
            mgr = _lazy_asset_manager()
            asset = mgr.get_asset(asset_id)
            if not asset:
                raise ValueError(f"素材不存在: {asset_id}")
            return asset.model_dump()

        @mcp_app.tool
        async def create_asset(name: str, category: str = "character", visual_prompt: str = "", description: str = "") -> dict:
            """创建素材（常用于将生成结果固化为可复用资产）"""
            mgr = _lazy_asset_manager()
            asset = mgr.create_asset({"name": name, "category": category, "visual_prompt": visual_prompt, "description": description})
            return asset.model_dump()

        @mcp_app.tool
        async def register_custom_provider(kind: str = "image", name: str = "", language: str = "python", code: str = "", doc_text: str = "", doc_url: str = "", curl: str = "", openapi_url: str = "", api_key: str = "") -> dict:
            """[生成源扩展-代码模式] 支持 python/javascript 携程源码直接注册，或据文档自动生成代码"""
            payload = {"kind": kind, "name": name, "language": language, "doc_text": doc_text, "doc_url": doc_url, "curl": curl, "openapi_url": openapi_url, "api_key": api_key}
            if code: payload["code"] = code
            res = await mcp_registry.execute_tool("register_custom_provider", payload)
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error or "注册失败")

        @mcp_app.tool
        async def list_custom_providers(kind: str = "") -> dict:
            res = await mcp_registry.execute_tool("list_custom_providers", {"kind": kind} if kind else {})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def test_custom_provider(provider_id: str) -> dict:
            res = await mcp_registry.execute_tool("test_custom_provider", {"provider_id": provider_id})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def delete_custom_provider(provider_id: str) -> dict:
            res = await mcp_registry.execute_tool("delete_custom_provider", {"provider_id": provider_id})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def update_custom_provider(provider_id: str, language: str = "", code: str = "", name: str = "", description: str = "") -> dict:
            """[生成源升级] 编辑已有 Provider 代码"""
            payload = {"provider_id": provider_id}
            if language: payload["language"] = language
            if code: payload["code"] = code
            if name: payload["name"] = name
            if description: payload["description"] = description
            res = await mcp_registry.execute_tool("update_custom_provider", payload)
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def get_provider_code(provider_id: str, offset: int = 0, limit: int = 4000) -> dict:
            res = await mcp_registry.execute_tool("get_provider_code", {"provider_id": provider_id, "offset": offset, "limit": limit})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def fs_read(path: str, offset: int = 0, limit: int = 500, encoding: str = "utf-8") -> dict:
            """[文件查看-只读] 围栏内文件行分页读取（无需可信模式）"""
            res = await mcp_registry.execute_tool("fs_read", {"path": path, "offset": offset, "limit": limit, "encoding": encoding})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def read_skill(name: str = "") -> dict:
            """[技能] 列出/读取系统技能（SKILL.md）规范"""
            res = await mcp_registry.execute_tool("read_skill", {"name": name} if name else {})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def upgrade_provider_to_code(provider_id: str, language: str = "python") -> dict:
            res = await mcp_registry.execute_tool("upgrade_provider_to_code", {"provider_id": provider_id, "language": language})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def fs_file(action: str, path: str, content: str = "", encoding: str = "utf-8") -> dict:
            """[可信文件] list/read/write/append/delete（需 STUDIO_TRUSTED_MODE=1）"""
            res = await mcp_registry.execute_tool("fs_file", {"action": action, "path": path, "content": content, "encoding": encoding})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def shell_exec(command: str, cwd: str = "", timeout: int = 1200) -> dict:
            """[可信命令] 执行 shell（需 STUDIO_TRUSTED_MODE=1）"""
            res = await mcp_registry.execute_tool("shell_exec", {"command": command, "cwd": cwd, "timeout": timeout})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

    def _register_default_tools(self):
        # 1. 小说拆解
        self.register_tool(MCPToolDefinition(
            name="split_novel_script",
            description="[剧本 Agent (ViMax/小云雀)] 解析长篇网文或小说章节，提取人物关系并生成标准分镜序列 JSON",
            category="ai_generation",
            icon="BookOpen",
            author="HKUDS ViMax & MiniMax",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "novel_text": {"type": "string", "description": "小说或剧本文本内容"},
                    "style_preset": {"type": "string", "enum": ["donghua_xianxia", "japanese_anime", "modern_webtoon", "cinematic_3d", "dark_comic", "pure_white_aesthetic", "white_minimalist"], "default": "donghua_xianxia"},
                    "aspect_ratio": {"type": "string", "enum": ["9:16", "16:9", "1:1"], "default": "9:16"}
                },
                "required": ["novel_text"]
            }
        ))

        # 2. 通用图片生成（核心新增，对Agent暴露）：provider 枚举动态来自图像注册表，不写死
        try:
            _image_ids = _lazy_image_registry().list_ids()
        except Exception:
            _image_ids = []
        self.register_tool(MCPToolDefinition(
            name="generate_image",
            description="[通用生图] 动态选择Provider生成漫剧分镜图像。provider 留空 = 系统默认图像源；支持workflow_id指定ComfyUI自定义工作流。Agent应优先使用此工具。",
            category="ai_generation",
            icon="Image",
            author="Dynamic Image Registry",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "生图提示词（英文画面描述，自动追加风格后缀）"},
                    "provider": {"type": "string", "enum": _image_ids, "description": "指定图像源，不填则使用系统默认 IMAGE_PROVIDER"},
                    "workflow_id": {"type": "string", "description": "ComfyUI自定义工作流ID（仅provider=comfyui时有效，可通过list_comfyui_workflows查询）"},
                    "negative_prompt": {"type": "string", "description": "负向提示词"},
                    "aspect_ratio": {"type": "string", "enum": ["9:16", "16:9", "1:1"], "default": "9:16"},
                    "style_preset": {"type": "string", "enum": ["donghua_xianxia", "japanese_anime", "modern_webtoon", "cinematic_3d", "dark_comic", "pure_white_aesthetic", "white_minimalist"]},
                    "seed": {"type": "integer", "description": "随机种子"},
                    "model": {"type": "string", "description": "覆盖默认模型（如 siliconflow的 FLUX 模型）"},
                    "steps": {"type": "integer", "description": "采样步数 8-50"},
                    "cfg": {"type": "number", "description": "CFG 1.0-12.0"},
                },
                "required": ["prompt"]
            }
        ))

        # 3. 兼容旧：comfyui_render_node
        self.register_tool(MCPToolDefinition(
            name="comfyui_render_node",
            description="[ComfyUI生图-兼容] 通过 ComfyUI 生成图像（等价于 generate_image provider=comfyui）。保留兼容，老工作流可继续调用。",
            category="ai_generation",
            icon="Cpu",
            author="ComfyUI Open Source",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "生图提示词"},
                    "negative_prompt": {"type": "string"},
                    "aspect_ratio": {"type": "string", "enum": ["9:16", "16:9", "1:1"], "default": "9:16"},
                    "style_preset": {"type": "string", "enum": ["donghua_xianxia", "japanese_anime", "modern_webtoon", "cinematic_3d", "dark_comic", "pure_white_aesthetic", "white_minimalist"]},
                    "seed": {"type": "integer"},
                    "workflow_id": {"type": "string", "description": "指定已导入的ComfyUI工作流ID"},
                    "model": {"type": "string"}
                },
                "required": ["prompt"]
            }
        ))

        # 4. 通用语音生成（核心新增）：provider 枚举动态来自音频注册表，不写死
        try:
            _audio_ids = _lazy_audio_registry().list_ids()
        except Exception:
            _audio_ids = []
        self.register_tool(MCPToolDefinition(
            name="generate_voice",
            description="[通用配音] 动态选择TTS Provider生成语音。provider 留空 = 系统默认语音源；voice_id/emotion 留空 = 该源声明的默认值。",
            category="audio",
            icon="Mic2",
            author="Dynamic Audio Registry",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "配音台词或旁白"},
                    "provider": {"type": "string", "enum": _audio_ids, "description": "不填则用系统默认语音源"},
                    "voice_id": {"type": "string", "description": "音色ID，不填则由所选源用其声明的默认音色"},
                    "emotion": {"type": "string", "description": "情绪，不填则由所选源用其默认情绪"},
                    "speed": {"type": "number", "default": 1.0, "description": "语速 0.5-2.0"},
                    "pitch": {"type": "number", "default": 0.0, "description": "音调，仅部分Provider支持"},
                    "ref_audio_path": {"type": "string", "description": "克隆参考音频路径（gpt_sovits/cosyvoice）"},
                    "model": {"type": "string", "description": "覆盖TTS模型"}
                },
                "required": ["text"]
            }
        ))

        # 5. 兼容旧：generate_minimax_voice
        self.register_tool(MCPToolDefinition(
            name="generate_minimax_voice",
            description="[MiniMax配音-兼容] 调用 MiniMax Speech-01（等价于 generate_voice provider=minimax）。保留兼容。",
            category="audio",
            icon="Mic",
            author="MiniMax Speech",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "voice_id": {"type": "string", "description": "不填则由 MiniMax 源用其声明的默认音色"},
                    "emotion": {"type": "string", "enum": ["neutral", "intense", "sorrow", "excited", "fearful", "whispering"], "description": "不填 = 源默认"},
                    "speed": {"type": "number", "default": 1.0}
                },
                "required": ["text"]
            }
        ))

        # 6. 列出图片Providers
        self.register_tool(MCPToolDefinition(
            name="list_image_providers",
            description="[查询] 列出所有已注册的图片生成Providers及其健康状态与能力，供Agent自主选择最合适的生图通道。",
            category="utility",
            icon="List",
            author="System",
            is_enabled=True,
            input_schema={"type": "object", "properties": {}, "required": []}
        ))

        # 7. 列出音频Providers
        self.register_tool(MCPToolDefinition(
            name="list_voice_providers",
            description="[查询] 列出所有已注册的音频Providers及其能力，供Agent选择配音通道。",
            category="utility",
            icon="ListMusic",
            author="System",
            is_enabled=True,
            input_schema={"type": "object", "properties": {}, "required": []}
        ))

        # 7.1 通用视频生成 (I2V / R2V / T2V)：provider 枚举动态来自视频注册表，不写死
        try:
            _video_ids = _lazy_video_registry().list_ids()
        except Exception:
            _video_ids = []
        self.register_tool(MCPToolDefinition(
            name="generate_video",
            description="[通用视频] 动态选择视频Provider生成动态漫剧分镜视频。支持mode=i2v(图生视频)/r2v(参考生视频)/t2v(文生视频)。",
            category="ai_generation",
            icon="Film",
            author="Dynamic Video Registry",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "视频运动/运镜描述（如：镜头急速推近，角色长发飞扬，霸气怒吼）"},
                    "mode": {"type": "string", "enum": ["i2v", "r2v", "t2v"], "default": "i2v", "description": "i2v: 图生视频; r2v: 参考生视频; t2v: 文生视频"},
                    "first_frame_url": {"type": "string", "description": "首帧图像 URL (i2v 必选)"},
                    "reference_images": {"type": "array", "items": {"type": "string"}, "description": "参考图 URL 列表 (r2v 模式)"},
                    "duration": {"type": "integer", "default": 5, "description": "视频时长秒数"},
                    "provider": {"type": "string", "enum": _video_ids, "description": "指定视频源，不填则使用系统默认 VIDEO_PROVIDER"}
                },
                "required": ["prompt"]
            }
        ))

        # 7.2 列出视频Providers
        self.register_tool(MCPToolDefinition(
            name="list_video_providers",
            description="[查询] 列出所有已注册的视频生成Providers及其能力与健康状态。",
            category="utility",
            icon="Video",
            author="System",
            is_enabled=True,
            input_schema={"type": "object", "properties": {}, "required": []}
        ))

        # 8. 列出ComfyUI工作流
        self.register_tool(MCPToolDefinition(
            name="list_comfyui_workflows",
            description="[查询] 列出所有已导入的ComfyUI自定义工作流（ID/名称/节点分析/映射），供Agent选择 workflow_id 进行风格化生图。",
            category="utility",
            icon="Workflow",
            author="System",
            is_enabled=True,
            input_schema={"type": "object", "properties": {}, "required": []}
        ))

        # 9. 查询指定Provider音色列表
        self.register_tool(MCPToolDefinition(
            name="list_voices",
            description="[查询] 查询指定TTS Provider的可用音色列表。",
            category="utility",
            icon="Voices",
            author="System",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "provider": {"type": "string", "enum": ["minimax", "elevenlabs", "cosyvoice", "gpt_sovits"], "default": "minimax"}
                },
                "required": []
            }
        ))

        # 9.1 素材库 - 列出/搜索
        self.register_tool(MCPToolDefinition(
            name="list_assets",
            description="[素材库] 搜索/列出素材，支持按 category(character/scene/prop/background/effect/ui)、tag、关键词q 过滤，分页返回。Agent可通过此工具发现可复用的角色/场景/道具。",
            category="utility",
            icon="Library",
            author="Asset Library",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["character", "scene", "prop", "background", "effect", "ui", "other"], "description": "按类别过滤"},
                    "tag": {"type": "string", "description": "按标签过滤"},
                    "q": {"type": "string", "description": "关键词搜索 名称/描述/提示词/标签"},
                    "page": {"type": "integer", "default": 1},
                    "limit": {"type": "integer", "default": 12},
                },
                "required": []
            }
        ))

        # 9.2 素材库 - 获取详情
        self.register_tool(MCPToolDefinition(
            name="get_asset",
            description="[素材库] 获取单个素材详情，含文件URL、视觉提示词、标签、一致性参数。",
            category="utility",
            icon="FileSearch",
            author="Asset Library",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "asset_id": {"type": "string", "description": "素材ID，如 ast_xxx"}
                },
                "required": ["asset_id"]
            }
        ))

        # 9.3 素材库 - 创建
        self.register_tool(MCPToolDefinition(
            name="create_asset",
            description="[素材库] 创建新素材，常用于将生成结果固化为可复用资产。Agent可在生成后调用此工具入库。",
            category="ai_generation",
            icon="FolderPlus",
            author="Asset Library",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "素材名称"},
                    "category": {"type": "string", "enum": ["character", "scene", "prop", "background", "effect", "ui", "other"], "default": "character"},
                    "visual_prompt": {"type": "string", "description": "视觉提示词，用于一致性生成"},
                    "description": {"type": "string", "description": "描述"},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "标签列表"},
                },
                "required": ["name"]
            }
        ))

        # 10. 剪映导出
        self.register_tool(MCPToolDefinition(
            name="export_jianyin_draft",
            description="[pyJianYingDraft] 将漫剧多轨时间线无损导出为剪映/CapCut官方草稿工程",
            category="export",
            icon="Share2",
            author="pyJianYingDraft",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "project": {"type": "object", "description": "完整漫剧 Project JSON"}
                },
                "required": ["project"]
            }
        ))

        # 11. 3D导演台
        self.register_tool(MCPToolDefinition(
            name="director_3d_stage_plan",
            description="[MiniMax 3D导演台] 根据景别、运镜、焦距与角色站位计算3D相机坐标与MiniMax 01-Director结构化运镜Prompt",
            category="workflow",
            icon="Camera",
            author="MiniMax Design",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "framing": {"type": "string", "enum": ["extreme_close_up", "close_up", "medium", "full", "long", "bird_eye", "low_angle", "over_shoulder", "dutch_angle", "high_angle"], "default": "medium"},
                    "motion": {"type": "string", "enum": ["static", "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "orbit", "orbit_ccw", "truck_left", "truck_right", "boom_up", "boom_down", "roll_left", "roll_right", "tracking", "shake", "dolly_zoom", "orbit_boom_up", "pan_left_crane_down", "fast_push_shake", "low_angle_truck_right"], "default": "push_in"},
                    "pose": {"type": "string", "enum": ["stand", "fight", "look_back", "run", "cast_spell", "kneel", "defend", "fly", "injured"], "default": "stand"},
                    "focal_length_mm": {"type": "number", "description": "镜头焦距 (16 - 135mm)", "default": 35.0},
                    "camera_roll_deg": {"type": "number", "description": "荷兰角倾斜度 (-45° ~ +45°)", "default": 0.0},
                    "cast_layout": {"type": "string", "enum": ["solo", "duel", "ots", "surrounded"], "default": "solo"},
                    "speed": {"type": "string", "enum": ["0.5x", "1.0x", "1.5x", "2.0x"], "default": "1.0x"},
                    "ai_directive": {"type": "string", "description": "可选：自然语言导演指令，AI 自动推荐并覆盖运镜机位"}
                },
                "required": []
            }
        ))

        # 12. 自定义生成源扩展（导演自扩展核心）
        self.register_tool(MCPToolDefinition(
            name="register_custom_provider",
            description="[生成源扩展-代码模式] 代码模式为唯一方式：根据 API 文档/cURL/OpenAPI/示例生成、或直接提供 python/javascript 携程源码，注册新的生成源 Provider（image/video/audio）。不支持非代码（JSON/transport）模式。创建后可在无限画布作为独立节点使用。",
            category="ai_generation",
            icon="Plug",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["image", "video", "audio", "llm"], "default": "image", "description": "生成源类型"},
                    "name": {"type": "string", "description": "展示名，如 我的FLUX源"},
                    "language": {"type": "string", "enum": ["python", "javascript"], "default": "python", "description": "代码语言"},
                    "code": {"type": "string", "description": "完整携程源码（async def generate(ctx, api)），若提供则直接使用不再走 LLM"},
                    "code_entry": {"type": "string", "default": "generate", "description": "入口函数名"},
                    "doc_text": {"type": "string", "description": "API 文档文本/示例（可贴 curl、请求/响应示例）"},
                    "doc_url": {"type": "string", "description": "API 文档 URL（可选）"},
                    "curl": {"type": "string", "description": "cURL 示例（可选）"},
                    "openapi_url": {"type": "string", "description": "OpenAPI JSON URL（可选）"},
                    "api_key": {"type": "string", "description": "API Key（可选）"},
                    "trusted": {"type": "boolean", "description": "可信模式：True则该源跳出沙箱可执行任意代码（需全局 STUDIO_TRUSTED_MODE=1，否则创建后执行会明错）"},
                    "input_schema": {"type": "object", "description": "文件插槽声明（prompt/首帧/参考图/参考音频），可选，缺省由框架补全"},
                    "params_schema": {"type": "object", "description": "非文件参数 schema（必须带 x-category/x-visibility/x-agent/x-priority），可选"},
                    "models": {"type": "array", "items": {"type": "string"}, "description": "模型列表（可选）"},
                    "default_model": {"type": "string", "description": "默认模型（可选）"}
                },
                "required": ["kind"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="list_custom_providers",
            description="[查询] 列出所有自定义生成源 Provider，支持按 kind/q 过滤；返回 id/name/kind/params 摘要（已剔除 code），如需代码请调用 get_provider_code",
            category="utility",
            icon="List",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["image", "video", "audio", "llm"], "description": "按类型过滤，不填返回全部"},
                    "q": {"type": "string", "description": "按名称/ID/描述模糊搜索，支持 H3 等关键词，不填返回全部"}
                },
                "required": []
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="test_custom_provider",
            description="[查询] 测试指定自定义 Provider 的连通性与配置",
            category="utility",
            icon="Activity",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "provider_id": {"type": "string", "description": "Provider ID，如 prov_xxx"}
                },
                "required": ["provider_id"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="delete_custom_provider",
            description="[管理] 删除指定的自定义 Provider（内置不可删）",
            category="utility",
            icon="Trash2",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "provider_id": {"type": "string", "description": "Provider ID"}
                },
                "required": ["provider_id"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="update_custom_provider",
            description="[生成源升级] 编辑/升级已有 Provider 的代码（python/javascript 携程）。支持增量 patch：可只传 code/language/description/models 等，导演可据此修复或增强已有源。",
            category="ai_generation",
            icon="Edit",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "provider_id": {"type": "string", "description": "要编辑的 Provider ID"},
                    "name": {"type": "string", "description": "新展示名（可选）"},
                    "description": {"type": "string", "description": "新描述（可选）"},
                    "language": {"type": "string", "enum": ["python", "javascript"], "description": "语言"},
                    "code": {"type": "string", "description": "完整携程源码（async def generate(ctx, api)）"},
                    "code_entry": {"type": "string", "description": "入口函数名，默认 generate"},
                    "models": {"type": "array", "items": {"type": "string"}, "description": "模型列表（可选）"},
                    "default_model": {"type": "string"},
                    "doc_text": {"type": "string", "description": "补充文档（可选，用于 LLM 辅助重写）"},
                    "trusted": {"type": "boolean", "description": "可信开关：True=跳出沙箱（需全局 STUDIO_TRUSTED_MODE=1）"},
                },
                "required": ["provider_id"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="get_provider_code",
            description="[查询] 获取单个 Provider 的完整代码与参数结构，支持按 id/name/q 精准或模糊选择。代码支持 offset/limit 分页通读（默认窗口 4000 字符），配合 code_total_len/code_next_offset 逐页读完整源码，不再只看 800 字预览。",
            category="utility",
            icon="FileCode",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "provider_id": {"type": "string", "description": "Provider ID，如 prov_xxx；与 name/q 二选一，优先级最高"},
                    "name": {"type": "string", "description": "按名称精确或模糊匹配，如 'MiniMax H3 音视频' 或 'H3'"},
                    "q": {"type": "string", "description": "模糊搜索关键词（名称/ID/描述/类型），如 'h3' 或 'video'"},
                    "kind": {"type": "string", "enum": ["image", "video", "audio", "llm"], "description": "可选：限定类型，避免同名跨类型歧义"},
                    "offset": {"type": "integer", "default": 0, "description": "代码字符偏移（从 0 开始），用于分页通读完整代码"},
                    "limit": {"type": "integer", "default": 4000, "description": "本次返回的代码字符数 200-6000（默认 4000）"}
                },
                "required": []
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="upgrade_provider_to_code",
            description="[迁移] 将存量 JSON 模板 Provider 一键升级为代码模式（自动迁移 transport/mapping 为 python 模板）",
            category="utility",
            icon="ArrowUp",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "provider_id": {"type": "string", "description": "Provider ID"},
                    "language": {"type": "string", "enum": ["python", "javascript"], "default": "python"}
                },
                "required": ["provider_id"]
            }
        ))

        # --- Canvas Agent 深度绑定 5 工具 (P4) ---
        self.register_tool(MCPToolDefinition(
            name="canvas_query",
            description="[画布] 查询当前画布摘要与节点清单，Agent 画布感知入口",
            category="workflow",
            icon="Layout",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={"type":"object","properties":{"project_id":{"type":"string"}},"required":[]}
        ))
        self.register_tool(MCPToolDefinition(
            name="canvas_create_node",
            description="[画布] 创建节点，type 需为 nodeRegistry 中的合法类型；project_id 不传则使用当前项目",
            category="workflow",
            icon="Plus",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={"type":"object","properties":{"type":{"type":"string","description":"节点类型，如 prompt/image/video/audio/director3d/export/shot-card/comfy-workflow/brief/load-image/text-prompt"},"position":{"type":"object","description":"{x,y} 可选"},"params":{"type":"object","description":"节点初始 data"},"project_id":{"type":"string","description":"归属项目ID，不传则使用上下文项目"}},"required":["type"]}
        ))
        self.register_tool(MCPToolDefinition(
            name="canvas_update_node",
            description="[画布] 更新节点数据",
            category="workflow",
            icon="Edit",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={"type":"object","properties":{"node_id":{"type":"string"},"patch":{"type":"object"},"project_id":{"type":"string"}},"required":["node_id","patch"]}
        ))
        self.register_tool(MCPToolDefinition(
            name="canvas_delete_node",
            description="[画布] 删除节点（连带删除挂在它身上的连线，避免留下悬空边）。高危操作：需人工审批；删前先用 canvas_query 确认 node_id 与它连了什么",
            category="workflow",
            icon="Trash2",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={"type":"object","properties":{"node_id":{"type":"string","description":"要删除的节点 id（先用 canvas_query 取真实 id）"},"project_id":{"type":"string","description":"归属项目ID，不传则使用上下文项目"}},"required":["node_id"]}
        ))
        self.register_tool(MCPToolDefinition(
            name="canvas_connect",
            description="[画布] 连线两节点句柄，自动校验类型",
            category="workflow",
            icon="Link",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={"type":"object","properties":{"source":{"type":"string"},"sourceHandle":{"type":"string"},"target":{"type":"string"},"targetHandle":{"type":"string"},"project_id":{"type":"string"}},"required":["source","target"]}
        ))
        self.register_tool(MCPToolDefinition(
            name="canvas_execute",
            description="[画布] 执行画布 DAG，可指定 target_ids 仅执行选中",
            category="workflow",
            icon="Play",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={"type":"object","properties":{"target_ids":{"type":"array","items":{"type":"string"}},"project_id":{"type":"string"}},"required":[]}
        ))
        self.register_tool(MCPToolDefinition(
            name="canvas_dispatch_skill",
            description="[画布] 针对画布指定节点调度特定 Agent 技能（如 script_generation / proposal_generation / prompt_expansion / first_last_frame / all_round_reference / text_to_image / tts_voice）并执行",
            category="workflow",
            icon="Zap",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={
                "type":"object",
                "properties":{
                    "skill_id":{"type":"string","description":"技能ID：script_generation, proposal_generation, prompt_expansion, first_last_frame, all_round_reference, text_to_image, tts_voice"},
                    "prompt":{"type":"string","description":"提示词或文本内容"},
                    "node_id":{"type":"string","description":"目标节点ID（若不填则自动创建对应节点）"},
                    "first_frame_url":{"type":"string","description":"首帧图URL"},
                    "last_frame_url":{"type":"string","description":"尾帧图URL"},
                    "reference_images":{"type":"array","items":{"type":"string"},"description":"参考图URL列表"},
                    "project_id":{"type":"string","description":"归属项目ID"}
                },
                "required":["skill_id"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="canvas_query_assets",
            description="[画布] 查询当前画布上所有已生成的资源池（图片、首尾帧、视频、配音），用于在下游节点中作为参考或首帧挂载",
            category="workflow",
            icon="Folder",
            author="Canvas Engine",
            is_enabled=True,
            input_schema={"type":"object","properties":{"project_id":{"type":"string"}},"required":[]}
        ))
        self.register_tool(MCPToolDefinition(
            name="search_tools",
            description="[Agent检索] 按关键词检索可用工具子集（名/描述/分类加权），避免90个provider全量进prompt。侦察类，只返回名+描述+分类，先检索再执行，查而不做视为未完成。",
            category="utility",
            icon="Search",
            author="Agent Mode",
            is_enabled=True,
            input_schema={"type":"object","properties":{"query":{"type":"string","description":"检索关键词，如 生图 配音 画布 剪映"},"limit":{"type":"integer","default":12,"description":"返回条数 4-20"}},"required":[]}
        ))

        # --- A档可信模式双工具：文件编辑 + 命令执行（总闸 STUDIO_TRUSTED_MODE=1，未开则明错） ---
        self.register_tool(MCPToolDefinition(
            name="fs_read",
            description="[文件查看-只读] 读取围栏内文件（storage/exports/工作区根），支持 offset/limit 行分页，无需可信模式。用于通读生成源代码文件、插件包、技能规范与 JSON 配置等完整文件；明文密钥文件（.env/config_store.json）拒绝直读。",
            category="utility",
            icon="FileText",
            author="Runtime",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对工作区根或绝对路径（围栏内），如 storage/providers/custom/prov_xxx.json 或 server/skills/provider-factory/SKILL.md"},
                    "offset": {"type": "integer", "default": 0, "description": "起始行号（0 基），用于分页"},
                    "limit": {"type": "integer", "default": 500, "description": "返回行数 1-2000（默认 500）"},
                    "encoding": {"type": "string", "default": "utf-8", "description": "文件编码"},
                },
                "required": ["path"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="read_skill",
            description="[技能] 列出/读取系统技能（SKILL.md）规范：不传 name 列出全部技能（名称+描述+分类）；传 name 返回该技能完整执行 SOP。接生成源/插件/技能类需求前先读取对应 SOP 再动手。",
            category="utility",
            icon="Sparkles",
            author="Skill Engine",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "技能名（精确或包含匹配），如 provider-factory；留空则列出全部技能"},
                },
                "required": []
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="fs_file",
            description="[可信文件] list/read/write/append/delete 工作区文件（围栏 storage/exports/工作区根，禁.git等，读≤200KB写≤1MB）。需 STUDIO_TRUSTED_MODE=1。H3长任务可用它读写 task_id/回填分镜。",
            category="utility",
            icon="FileEdit",
            author="Trusted Mode",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "read", "write", "append", "delete"], "description": "list=目录列表 read=读文件 write=覆盖写 append=追加 delete=删文件"},
                    "path": {"type": "string", "description": "相对工作区根或绝对路径（围栏内），如 storage/providers/custom/prov_xxx.json"},
                    "content": {"type": "string", "description": "write/append 时的文件内容"},
                    "encoding": {"type": "string", "default": "utf-8", "description": "文件编码"},
                },
                "required": ["action", "path"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="shell_exec",
            description="[可信命令] 在工作区执行 shell（Win走PowerShell，输出截断12KB，timeout 5-1200s，默认1200s=20分钟）。需 STUDIO_TRUSTED_MODE=1。长任务建议提交拿task_id后轮询（单次GET秒回），也可在20分钟窗口内阻塞等终态。",
            category="utility",
            icon="Terminal",
            author="Trusted Mode",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的命令，如 curl -s https://api.../query?task_id=xxx"},
                    "cwd": {"type": "string", "description": "工作目录（围栏内，空=工作区根）"},
                    "timeout": {"type": "integer", "default": 1200, "description": "超时秒 5-1200（默认1200=20分钟）"},
                },
                "required": ["command"]
            }
        ))

        # --- Creator 能力提案链（参考 DeepSeek Harness Creator）：inspect/propose/start/finalize ---
        self.register_tool(MCPToolDefinition(
            name="creator_inspect_runtime",
            description="[Creator只读] 检查运行时：生成源/技能/画布/工作流现状，供提案依据。零副作用。",
            category="utility", icon="ScanEye", author="Creator", is_enabled=True,
            input_schema={"type": "object", "properties": {}, "required": []}
        ))
        self.register_tool(MCPToolDefinition(
            name="creator_propose_capability",
            description="[Creator提案] 缺能力先造能力：补源参数/接新源/新Skill/画布模板。只生成临时提案，需人Start才试跑。",
            category="workflow", icon="Lightbulb", author="Creator", is_enabled=True,
            input_schema={"type": "object", "properties": {
                "goal": {"type": "string", "description": "要补的能力，如 给H3补first_frame插槽 / 做个6格漫剧模板"},
            }, "required": ["goal"]}
        ))
        self.register_tool(MCPToolDefinition(
            name="creator_start_test",
            description="[Creator试跑] 人来Start后只做只读/小参试跑，不写生产。返回试跑报告。",
            category="workflow", icon="FlaskConical", author="Creator", is_enabled=True,
            input_schema={"type": "object", "properties": {
                "proposal_id": {"type": "string", "description": "提案ID，如 prop_xxx"},
            }, "required": ["proposal_id"]}
        ))
        self.register_tool(MCPToolDefinition(
            name="creator_finalize",
            description="[Creator收尾] persist真写生产（备份→写入→热重载→试跑，失败自回滚）/ discard卸载临时包 / rollback按备份恢复。",
            category="workflow", icon="PackageCheck", author="Creator", is_enabled=True,
            input_schema={"type": "object", "properties": {
                "proposal_id": {"type": "string"},
                "action": {"type": "string", "enum": ["persist", "discard", "rollback"], "default": "persist"},
            }, "required": ["proposal_id"]}
        ))

    # ========== 动态 Provider→MCP 统一：异构参数即工具输入，节点Agent按 Tool 调度 ==========
    def _provider_to_tool(self, provider_id: str, kind: str, definition=None, provider_obj=None) -> MCPToolDefinition:
        """将单个 ProviderDefinition/Provider实例转为 MCP Tool，输入= input_schema + params_schema + model"""
        try:
            # 优先用 Definition 的真实 schema，否则用 kind 默认
            input_props = {}
            input_req = []
            params_props = {}
            params_req = []
            models: List[str] = []
            default_model: Optional[str] = None
            display_name = provider_id
            description = ""
            if definition is not None:
                # 自定义 ProviderDefinition
                display_name = getattr(definition, 'get_display_name', lambda: provider_id)() if hasattr(definition, 'get_display_name') else getattr(definition, 'name', provider_id)
                description = getattr(definition, 'description', '') or f"{kind} 生成源 {provider_id}"
                if getattr(definition, 'input_schema', None) and getattr(definition.input_schema, 'get', None):
                    input_props = (definition.input_schema.get('properties') or {}) if isinstance(definition.input_schema, dict) else getattr(definition.input_schema, 'properties', {}) or {}
                    input_req = (definition.input_schema.get('required') or []) if isinstance(definition.input_schema, dict) else getattr(definition.input_schema, 'required', []) or []
                elif isinstance(getattr(definition, 'input_schema', None), dict):
                    input_props = definition.input_schema.get('properties', {}) or {}
                    input_req = definition.input_schema.get('required', []) or []
                if getattr(definition, 'params_schema', None):
                    ps = definition.params_schema
                    if isinstance(ps, dict):
                        params_props = ps.get('properties', {}) or {}
                        params_req = ps.get('required', []) or []
                models = getattr(definition, 'models', []) or []
                default_model = getattr(definition, 'default_model', None)
            elif provider_obj is not None:
                try:
                    cap = provider_obj.get_capabilities() if hasattr(provider_obj, 'get_capabilities') else {}
                    display_name = getattr(provider_obj, 'display_name', provider_id)
                    description = getattr(provider_obj, 'description', '') or f"内置 {kind} 源 {provider_id}"
                    models = cap.get('models', []) or []
                except Exception:
                    pass
            # kind 兜底默认
            if not input_props:
                if kind == 'image':
                    input_props = {
                        "prompt": {"type":"string","description":"画面提示词","x-handle":"text"},
                        "reference_images": {"type":"array","items":{"type":"string","format":"uri"},"description":"参考图","x-handle":"image"},
                    }
                    input_req = ["prompt"]
                elif kind == 'video':
                    input_props = {
                        "prompt": {"type":"string","description":"运动描述","x-handle":"text"},
                        "first_frame": {"type":"string","format":"uri","description":"首帧","x-handle":"image"},
                        "reference_images": {"type":"array","items":{"type":"string","format":"uri"},"description":"参考集","x-handle":"image"},
                    }
                    input_req = ["prompt"]
                elif kind == 'audio':
                    input_props = {"text": {"type":"string","description":"合成文本","x-handle":"text"}}
                    input_req = ["text"]
            if not params_props:
                # 兜底枚举需与 ComfyUI 真实 ResolutionSelector 一致，否则会被 _set_input_guarded 拦截
                _full_ar = ["1:1 (Square)","9:16 (Portrait Widescreen)","16:9 (Widescreen)","3:2 (Photo)","4:3 (Standard)","21:9 (Ultrawide)"]
                if kind == 'image':
                    params_props = {"aspect_ratio":{"type":"string","enum":_full_ar,"default":"9:16 (Portrait Widescreen)"},"resolution":{"type":"string","enum":["768P","2K"],"default":"768P"},"steps":{"type":"integer","default":20}}
                elif kind == 'video':
                    params_props = {"aspect_ratio":{"type":"string","enum":_full_ar,"default":"9:16 (Portrait Widescreen)"},"resolution":{"type":"string","enum":["768P","2K"],"default":"768P"},"duration":{"type":"integer","default":5},"hasSound":{"type":"boolean","default":False}}
            # 合并为 Tool 输入
            merged_props: Dict[str, Any] = {}
            merged_props.update(input_props)
            # params 覆盖合并（避免 prompt 重复）
            for k,v in params_props.items():
                if k not in merged_props:
                    merged_props[k] = v
            if models:
                merged_props["model"] = {"type":"string","enum":models, "default": default_model or (models[0] if models else ""), "description":"模型选择"}
            # required 合并
            merged_req = list(dict.fromkeys(list(input_req) + list(params_req)))
            # 保证 prompt/text 必填
            if kind=='image' and 'prompt' not in merged_req and 'prompt' in merged_props:
                merged_req.append('prompt')
            if kind=='audio' and 'text' not in merged_req and 'text' in merged_props:
                merged_req.append('text')
            # v2：为导演 Agent 在 description 中明示基础/高级分组，便于其只自动填 basic/auto 项
            try:
                basic_keys = [k for k,v in params_props.items() if isinstance(v, dict) and v.get('x-visibility')=='basic']
                adv_keys = [k for k,v in params_props.items() if isinstance(v, dict) and v.get('x-visibility')=='advanced']
                grp_hint = f"基础:{','.join(basic_keys) or '无'}|高级:{','.join(adv_keys) or '无'}"
            except Exception:
                grp_hint = "基础/高级按 x-visibility 分组"
            tool_name = f"provider_{provider_id}"
            return MCPToolDefinition(
                name=tool_name,
                description=f"[Provider:{kind}] {display_name} · {description[:60]} · {grp_hint} · 文件插槽=input_schema 基本/高级由 x-visibility 控制 高级需点⚙ auto可自动 suggest仅建议",
                category="ai_generation",
                icon="Zap" if kind=="image" else "Film" if kind=="video" else "Mic",
                author=f"Provider:{provider_id}",
                is_enabled=True,
                input_schema={"type":"object","properties": merged_props, "required": merged_req}
            )
        except Exception as e:
            print(f"[MCP] provider_to_tool failed {provider_id}: {e}")
            return MCPToolDefinition(name=f"provider_{provider_id}", description=f"Provider {provider_id}", category="ai_generation", icon="Zap", author="Provider", is_enabled=True, input_schema={"type":"object","properties":{"prompt":{"type":"string"}},"required":["prompt"]})

    def _register_provider_dynamic_tools(self):
        """扫描所有 ProviderRegistry，将每个生成源注册为独立 MCP Tool（用户选源 → 节点Agent调对应Tool）"""
        # 清理旧的 provider_ 工具
        for k in list(self.tools.keys()):
            if k.startswith("provider_"):
                del self.tools[k]
        try:
            from app.providers.image.registry import image_registry
            from app.providers.video.registry import video_registry
            from app.providers.audio.registry import audio_registry
            # 确保已初始化
            if not image_registry.list_ids():
                try:
                    from app.providers.init_providers import init_all_providers
                    init_all_providers()
                except Exception:
                    pass
            for kind, reg in [("image", image_registry), ("video", video_registry), ("audio", audio_registry)]:
                for pid in reg.list_ids():
                    try:
                        prov_obj = reg.get(pid)
                        definition = None
                        # 自定义源取 Definition
                        if reg.is_custom(pid):
                            try:
                                from app.providers.custom.manager import custom_provider_manager
                                definition = custom_provider_manager.get_definition(pid)
                            except Exception:
                                pass
                        if definition is None and hasattr(prov_obj, 'definition'):
                            definition = getattr(prov_obj, 'definition', None)
                        tool = self._provider_to_tool(pid, kind, definition=definition, provider_obj=prov_obj)
                        self.register_tool(tool)
                    except Exception as e:
                        print(f"[MCP] register provider tool {pid} failed: {e}")
            print(f"[MCP] 已注册 {len([k for k in self.tools if k.startswith('provider_')])} 个 Provider 动态 Tool")
        except Exception as e:
            print(f"[MCP] _register_provider_dynamic_tools error: {e}")

    def refresh_provider_tools(self):
        """供 provider_routes 热注册后调用，刷新 MCP 工具列表"""
        try:
            self._register_provider_dynamic_tools()
        except Exception as e:
            print(f"[MCP] refresh_provider_tools failed: {e}")

    def refresh_customnode_tools(self):
        """自定义代码节点 → customnode_<id> MCP Tool（一节点一Tool，Agent/节点可直接调度）"""
        for k in list(self.tools.keys()):
            if k.startswith("customnode_"):
                del self.tools[k]
        try:
            from app.custom_nodes.manager import custom_node_manager
            for d in custom_node_manager.list_nodes():
                if not d.enabled:
                    continue
                try:
                    in_props = dict(((d.input_schema or {}).get("properties") or {}))
                    in_req = list(((d.input_schema or {}).get("required") or []))
                    # 文本兜底：无显式文本槽也允许 prompt/text 直投
                    if "prompt" not in in_props:
                        in_props["prompt"] = {"type": "string", "description": "文本输入（未声明文本槽时的兜底）"}
                    param_props = dict(((d.params_schema or {}).get("properties") or {}))
                    merged_props = {**in_props, **param_props}
                    self.register_tool(MCPToolDefinition(
                        name=f"customnode_{d.id}",
                        description=f"[自定义节点·{d.kind}] {d.name} — {d.description or '用户代码节点'}",
                        category="ai_generation",
                        icon="Boxes",
                        author="CustomNode",
                        is_enabled=True,
                        input_schema={"type": "object", "properties": merged_props, "required": in_req},
                    ))
                except Exception as e:
                    print(f"[MCP] register customnode tool {d.id} failed: {e}")
        except Exception as e:
            print(f"[MCP] refresh_customnode_tools failed: {e}")

    def register_tool(self, tool: MCPToolDefinition):
        self.tools[tool.name] = tool

    def get_mcp_http_app(self):
        if not (HAS_FASTMCP and mcp_app):
            return None
        return mcp_app.http_app(path="/")

    def get_all_tools(self) -> List[MCPToolDefinition]:
        return list(self.tools.values())

    async def execute_tool(self, tool_name: str, arguments: Dict[str, Any], project_context: Any = None) -> MCPToolCallResponse:
        start_time = time.time()
        if tool_name not in self.tools:
            return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=f"MCP Tool '{tool_name}' not found", execution_time_ms=0)
        # 扩展中心的停用对全部工具生效（此前只有插件查壳工具过闸，内置工具停了也照跑）
        try:
            from app.extensions import guard as _ext_guard
            if not _ext_guard.is_enabled("mcp_tool", tool_name):
                return MCPToolCallResponse(
                    tool_name=tool_name, status="error", result=None,
                    error=f"工具已被停用：{tool_name}（可在设置·扩展中重新启用）",
                    execution_time_ms=0,
                )
        except Exception:
            pass
        try:
            result = None
            # Agent检索：关键词取工具子集，防provider全量爆context（Anthropic Code Mode同思路）
            if tool_name == "search_tools":
                try:
                    from app.agent.loop import search_tools as _search
                    q = (arguments or {}).get("query", "")
                    lim = int((arguments or {}).get("limit", 12) or 12)
                    result = {"tools": _search(q, max(4, min(lim, 20)))}
                except Exception as e:
                    return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=f"search_tools失败: {e}", execution_time_ms=int((time.time()-start_time)*1000))
                return MCPToolCallResponse(tool_name=tool_name, status="success", result=result, error=None, execution_time_ms=int((time.time()-start_time)*1000))
            # 插件查壳工具：plugin_<id>_<name>，强制trusted总闸 + 20分钟超时（与fs_file/shell_exec同闸）
            if tool_name.startswith("plugin_"):
                try:
                    from app.plugins.manager import run_plugin_tool
                    result = await run_plugin_tool(tool_name, arguments or {})
                except ValueError as e:
                    return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=str(e), execution_time_ms=int((time.time()-start_time)*1000))
                except Exception as e:
                    return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=f"插件工具执行失败: {e}", execution_time_ms=int((time.time()-start_time)*1000))
                return MCPToolCallResponse(tool_name=tool_name, status="success", result=result, error=None, execution_time_ms=int((time.time()-start_time)*1000))
            # 自定义代码节点：customnode_<id>，inputs 按 input_schema 键收集，其余进 params
            if tool_name.startswith("customnode_"):
                try:
                    from app.custom_nodes.manager import custom_node_manager, run_custom_node
                    cnid = tool_name[len("customnode_"):]
                    definition = custom_node_manager.get(cnid)
                    if not definition:
                        return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=f"自定义节点不存在: {cnid}", execution_time_ms=int((time.time()-start_time)*1000))
                    in_keys = set(((definition.input_schema or {}).get("properties") or {}).keys()) | {"prompt", "text"}
                    param_keys = set(((definition.params_schema or {}).get("properties") or {}).keys())
                    inputs = {k: v for k, v in (arguments or {}).items() if k in in_keys and v not in (None, "")}
                    params = {k: v for k, v in (arguments or {}).items() if k in param_keys and v not in (None, "")}
                    if isinstance((arguments or {}).get("params"), dict):
                        for k, v in arguments["params"].items():
                            if v not in (None, "") and k not in params:
                                params[k] = v
                    result = await run_custom_node(definition, inputs, params, {"project_id": (arguments or {}).get("_project_id")})
                    if not isinstance(result, dict):
                        return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error="自定义节点须返回dict", execution_time_ms=int((time.time()-start_time)*1000))
                    return MCPToolCallResponse(tool_name=tool_name, status="success", result={"custom_node_id": cnid, "kind": definition.kind, **result}, error=None, execution_time_ms=int((time.time()-start_time)*1000))
                except Exception as e:
                    return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=f"自定义节点执行失败: {e}", execution_time_ms=int((time.time()-start_time)*1000))
            # 动态 Provider Tool 统一调度：节点Agent按 Tool 调度，参数即该源 params_schema 异构输入
            if tool_name.startswith("provider_"):
                provider_id = tool_name[len("provider_"):]
                # 按三表探测 kind
                kind = None
                prov_obj = None
                try:
                    from app.providers.image.registry import image_registry as _ir
                    from app.providers.video.registry import video_registry as _vr
                    from app.providers.audio.registry import audio_registry as _ar
                    if _ir.get(provider_id) is not None:
                        kind = "image"
                    elif _vr.get(provider_id) is not None:
                        kind = "video"
                    elif _ar.get(provider_id) is not None:
                        kind = "audio"
                    else:
                        # 自定义但尚未注册到内存，尝试从持久化加载 definition 推断 kind
                        try:
                            from app.providers.custom.manager import custom_provider_manager as _cm
                            d = _cm.get_definition(provider_id)
                            if d:
                                kind = getattr(d, 'kind', 'image')
                        except Exception:
                            kind = "image"
                except Exception:
                    kind = "image"
                if kind == "image":
                    from app.providers.image.base import ImageGenerateRequest
                    reg = _lazy_image_registry()
                    # 将异构参数透传：prompt + 请求模型显式字段，其余全部进 dynamic_inputs（不锁死键名名单，媒体键由 input_schema 决定）
                    prompt = arguments.get("prompt") or arguments.get("text") or ""
                    ref_imgs = arguments.get("reference_images")
                    if isinstance(ref_imgs, str):
                        ref_imgs = [ref_imgs]
                    elif not isinstance(ref_imgs, list) and ref_imgs:
                        ref_imgs = [str(ref_imgs)]
                    _explicit = ("prompt","text","model","workflow_id","aspect_ratio","resolution","steps","cfg","seed","style_preset","negative_prompt","width","height","reference_images")
                    dyn = {k: v for k, v in arguments.items() if k not in _explicit and v not in (None, "")}
                    if ref_imgs and "reference_images" not in dyn:
                        dyn["reference_images"] = ref_imgs
                    req = ImageGenerateRequest(
                        prompt=prompt,
                        negative_prompt=arguments.get("negative_prompt") or "",
                        aspect_ratio=arguments.get("aspect_ratio") or "9:16",
                        resolution=arguments.get("resolution"),
                        style_preset=arguments.get("style_preset"),
                        seed=arguments.get("seed"),
                        width=arguments.get("width"),
                        height=arguments.get("height"),
                        steps=arguments.get("steps"),
                        cfg=arguments.get("cfg"),
                        workflow_id=arguments.get("workflow_id"),
                        model=arguments.get("model"),
                        reference_images=ref_imgs if ref_imgs else None,
                        dynamic_inputs=dyn if dyn else None,
                        extra={k: arguments.get(k) for k in ("aspect_ratio","resolution","steps","cfg","model") if arguments.get(k) not in (None,"")},
                    )
                    # 热注册保障
                    try:
                        from app.canvas.engine import _ensure_provider_registered as _ens
                        _ens(provider_id, "image")
                    except Exception:
                        pass
                    res = await reg.generate(req, provider_id=provider_id)
                    result = {"image_url": res.image_url, "local_path": res.local_path, "provider": res.provider, "engine": res.engine, "seed": res.seed, "width": res.width, "height": res.height}
                elif kind == "video":
                    from app.providers.video.base import VideoGenerateRequest
                    reg = _lazy_video_registry()
                    prompt = arguments.get("prompt") or ""
                    req = VideoGenerateRequest(
                        prompt=prompt,
                        mode=arguments.get("mode") or "i2v",
                        first_frame_url=arguments.get("first_frame") or arguments.get("first_frame_url"),
                        last_frame_url=arguments.get("last_frame") or arguments.get("last_frame_url"),
                        reference_images=arguments.get("reference_images"),
                        duration=int(arguments.get("duration") or 5),
                        resolution=arguments.get("resolution") or "768P",
                        aspect_ratio=arguments.get("aspect_ratio") or "9:16",
                        fps=arguments.get("fps"),
                        provider=provider_id,
                        dynamic_inputs={k: v for k,v in arguments.items() if k not in ("prompt","mode","first_frame","first_frame_url","last_frame","last_frame_url","reference_images","duration","resolution","aspect_ratio","fps","model") and v not in (None,"")},
                        extra={k: arguments.get(k) for k in ("model","duration","resolution","aspect_ratio","fps") if arguments.get(k) not in (None,"")},
                    )
                    try:
                        from app.canvas.engine import _ensure_provider_registered as _ens2
                        _ens2(provider_id, "video")
                    except Exception:
                        pass
                    res = await reg.generate(req, provider_id=provider_id)
                    result = {"video_url": res.video_url, "local_path": res.local_path, "provider": res.provider, "engine": res.engine, "duration": res.duration, "task_id": res.task_id}
                    # 统一异步任务抽象（TaskCenter）：提交即返 task_id 的源默认阻塞到成片，
                    # 全项目唯一轮询实现；wait=false 可转异步，用 task_wait/task_status 续查。
                    if not res.video_url and res.task_id:
                        from app.providers.tasks import task_center
                        _pid_ctx = str((project_context or {}).get("id") or "") if isinstance(project_context, dict) else ""
                        task_center.register(
                            str(res.task_id), provider_id, "video",
                            request={"mode": arguments.get("mode") or "i2v"},
                            project_id=_pid_ctx,
                        )
                        if arguments.get("wait") is False:
                            result["status"] = "SUBMITTED"
                            result["note"] = "任务已提交，可用 task_wait / task_status 查询进度"
                        else:
                            rec = await task_center.wait(str(res.task_id))
                            result["status"] = rec.status
                            if rec.status == "SUCCESS" and rec.video_url:
                                result["video_url"] = rec.video_url
                                result["local_path"] = rec.local_path or result.get("local_path")
                            elif rec.status == "FAILED":
                                raise RuntimeError(rec.error or "视频任务失败")
                            else:
                                result["note"] = (
                                    f"视频仍在生成（{rec.status}，已等待 {int(rec.age_s)}s），"
                                    f"可稍后用 task_wait 继续等待或 task_status 查询"
                                )
                elif kind == "audio":
                    from app.providers.audio.base import AudioGenerateRequest
                    reg = _lazy_audio_registry()
                    # voice_id/emotion 不写死：缺省传空，由各源自身默认兜底（接口声明）
                    req = AudioGenerateRequest(
                        text=arguments.get("text") or arguments.get("prompt") or "",
                        voice_id=arguments.get("voice_id") or "",
                        emotion=arguments.get("emotion") or "",
                        speed=float(arguments.get("speed") or 1.0),
                        pitch=float(arguments.get("pitch") or 0.0),
                        ref_audio_path=arguments.get("ref_audio") or arguments.get("ref_audio_path"),
                        model=arguments.get("model"),
                        extra={k: arguments.get(k) for k in arguments if k not in ("text","prompt") and arguments.get(k) not in (None,"")},
                    )
                    try:
                        from app.canvas.engine import _ensure_provider_registered as _ens3
                        _ens3(provider_id, "audio")
                    except Exception:
                        pass
                    res = await reg.generate(req, provider_id=provider_id)
                    result = {"audio_url": res.audio_url, "local_path": res.local_path, "provider": res.provider, "engine": res.engine, "duration": res.duration}
                else:
                    raise ValueError(f"未知 Provider kind for {provider_id}")
            elif tool_name == "split_novel_script":
                text = arguments.get("novel_text", "")
                style = arguments.get("style_preset", "donghua_xianxia")
                ratio = arguments.get("aspect_ratio", "9:16")
                project = await script_agent.parse_novel_to_project(text, style, ratio)
                result = project.model_dump()

            elif tool_name in ("generate_image", "comfyui_render_node"):
                from app.providers.image.base import ImageGenerateRequest
                reg = _lazy_image_registry()
                # 兼容：comfyui_render_node 默认 provider=comfyui
                provider = arguments.get("provider")
                if tool_name == "comfyui_render_node" and not provider:
                    provider = "comfyui"
                req = ImageGenerateRequest(
                    prompt=arguments.get("prompt", ""),
                    negative_prompt=arguments.get("negative_prompt") or "",
                    aspect_ratio=arguments.get("aspect_ratio", "9:16"),
                    style_preset=arguments.get("style_preset"),
                    seed=arguments.get("seed"),
                    workflow_id=arguments.get("workflow_id"),
                    model=arguments.get("model"),
                    steps=arguments.get("steps"),
                    cfg=arguments.get("cfg"),
                )
                if not req.prompt or not req.prompt.strip():
                    raise ValueError("生图提示词 prompt 不能为空")
                img_res = await reg.generate(req, provider_id=provider)
                result = {"image_url": img_res.image_url, "local_path": img_res.local_path, "provider": img_res.provider, "engine": img_res.engine, "seed": img_res.seed, "width": img_res.width, "height": img_res.height, "elapsed_ms": img_res.elapsed_ms}

            elif tool_name in ("generate_voice", "generate_minimax_voice"):
                from app.providers.audio.base import AudioGenerateRequest
                reg = _lazy_audio_registry()
                provider = arguments.get("provider")
                if tool_name == "generate_minimax_voice" and not provider:
                    provider = "minimax"
                req = AudioGenerateRequest(
                    text=arguments.get("text", ""),
                    voice_id=arguments.get("voice_id") or "",
                    emotion=arguments.get("emotion") or "",
                    speed=float(arguments.get("speed", 1.0)),
                    pitch=float(arguments.get("pitch", 0.0)),
                    ref_audio_path=arguments.get("ref_audio_path"),
                    ref_text=arguments.get("ref_text"),
                    model=arguments.get("model"),
                )
                audio_res = await reg.generate(req, provider_id=provider or ("minimax" if tool_name == "generate_minimax_voice" else None))
                result = {"audio_url": audio_res.audio_url, "local_path": audio_res.local_path, "provider": audio_res.provider, "engine": audio_res.engine, "duration": audio_res.duration, "voice_id": audio_res.voice_id}

            elif tool_name == "list_image_providers":
                reg = _lazy_image_registry()
                providers = reg.list_providers()
                # 附带健康检查
                health = await reg.check_health_all()
                for p in providers:
                    h = health.get(p["id"], {})
                    p["health"] = h
                result = {"providers": providers}

            elif tool_name == "list_voice_providers":
                reg = _lazy_audio_registry()
                providers = reg.list_providers()
                health = await reg.check_health_all()
                for p in providers:
                    h = health.get(p["id"], {})
                    p["health"] = h
                result = {"providers": providers}

            elif tool_name == "generate_video":
                from app.providers.video.base import VideoGenerateRequest
                reg = _lazy_video_registry()
                provider = arguments.get("provider")
                req = VideoGenerateRequest(
                    prompt=arguments.get("prompt", ""),
                    mode=arguments.get("mode", "i2v"),
                    first_frame_url=arguments.get("first_frame_url"),
                    reference_images=arguments.get("reference_images"),
                    duration=int(arguments.get("duration", 5)),
                    provider=provider,
                )
                if not req.prompt or not req.prompt.strip():
                    raise ValueError("视频运动提示词 prompt 不能为空")
                vid_res = await reg.generate(req, provider_id=provider)
                result = {
                    "video_url": vid_res.video_url,
                    "local_path": vid_res.local_path,
                    "provider": vid_res.provider,
                    "engine": vid_res.engine,
                    "duration": vid_res.duration,
                    "elapsed_ms": vid_res.elapsed_ms,
                    "task_id": vid_res.task_id,
                }

            elif tool_name == "list_video_providers":
                reg = _lazy_video_registry()
                providers = reg.list_providers()
                health = await reg.check_health_all()
                for p in providers:
                    h = health.get(p["id"], {})
                    p["health"] = h
                result = {"providers": providers}

            elif tool_name == "list_comfyui_workflows":
                mgr = _lazy_workflow_manager()
                result = {"workflows": mgr.list_workflows()}

            elif tool_name == "list_voices":
                reg = _lazy_audio_registry()
                provider = arguments.get("provider", "minimax")
                prov = reg.get(provider)
                if not prov:
                    raise ValueError(f"未知音频Provider: {provider}")
                voices = await prov.list_voices()
                result = {"provider": provider, "voices": voices}

            elif tool_name == "list_assets":
                mgr = _lazy_asset_manager()
                result = mgr.list_assets(
                    category=arguments.get("category"),
                    tag=arguments.get("tag"),
                    q=arguments.get("q"),
                    page=int(arguments.get("page", 1)),
                    limit=int(arguments.get("limit", 12)),
                )

            elif tool_name == "get_asset":
                mgr = _lazy_asset_manager()
                asset_id = arguments.get("asset_id", "")
                asset = mgr.get_asset(asset_id)
                if not asset:
                    raise ValueError(f"素材不存在: {asset_id}")
                result = asset.model_dump()

            elif tool_name == "create_asset":
                mgr = _lazy_asset_manager()
                asset = mgr.create_asset({
                    "name": arguments.get("name", "未命名素材"),
                    "category": arguments.get("category", "character"),
                    "visual_prompt": arguments.get("visual_prompt", ""),
                    "description": arguments.get("description", ""),
                    "tags": arguments.get("tags", []),
                })
                result = asset.model_dump()

            elif tool_name == "export_jianyin_draft":
                project_payload = project_context or arguments.get("project")
                if not project_payload:
                    return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error="export_jianyin_draft 需要完整Project JSON", execution_time_ms=int((time.time()-start_time)*1000))
                project = Project.model_validate(project_payload)
                result = await jianyin_exporter.export_project_to_jianyin_draft_async(project)

            elif tool_name == "register_custom_provider":
                from app.providers.custom.manager import custom_provider_manager
                kind = arguments.get("kind") or "image"
                name = arguments.get("name") or f"自定义{kind}源"
                language = arguments.get("language") or "python"
                if language == "js":
                    language = "javascript"
                code = arguments.get("code")
                doc_text = arguments.get("doc_text") or ""
                doc_url = arguments.get("doc_url") or ""
                curl = arguments.get("curl") or ""
                openapi_url = arguments.get("openapi_url") or ""
                api_key = arguments.get("api_key") or ""
                headers = arguments.get("headers") or arguments.get("custom_headers")
                _input_schema = arguments.get("input_schema") if isinstance(arguments.get("input_schema"), dict) else None
                _params_schema = arguments.get("params_schema") if isinstance(arguments.get("params_schema"), dict) else None
                _models = arguments.get("models") if isinstance(arguments.get("models"), list) else None
                _default_model = (arguments.get("default_model") or "").strip() or None
                # 分支1：直接提供 code（导演编辑后回写或用户粘贴）—— 统一创建入口
                _trusted_arg = arguments.get("trusted")
                _trusted_bool = bool(_trusted_arg) if not isinstance(_trusted_arg, str) else _trusted_arg.strip().lower() in ("1", "true", "yes", "on")
                if code and isinstance(code, str) and len(code.strip()) > 20:
                    from app.api.provider_routes import create_code_source as _ccs
                    _created = _ccs(
                        name=name, kind=kind, code=code,
                        language=language if language in ("python", "javascript") else "python",
                        code_entry=arguments.get("code_entry"),
                        description=f"由导演直接提供代码（{language}）",
                        api_key=api_key or None,
                        doc_text=doc_text, doc_url=doc_url,
                        trusted=_trusted_bool,
                        headers=headers,
                        input_schema=_input_schema,
                        params_schema=_params_schema,
                        models=_models,
                        default_model=_default_model,
                    )
                    result = {"status": "success" if _created["compile_check"].get("ok") else "compile_failed",
                              "provider": _created["provider"], "mode": "direct_code",
                              "language": _created["provider"].get("language"),
                              "compile_check": _created["compile_check"],
                              **({"hint": "代码未通过沙箱编译体检，请根据 compile_check.error 修正后重新提交"} if not _created["compile_check"].get("ok") else {})}
                else:
                    # 分支3：据文档 LLM 生成代码
                    full_doc = doc_text
                    if curl:
                        full_doc += f"\n\nCURL:\n{curl}"
                    if doc_url and not doc_text:
                        try:
                            import httpx as _httpx
                            async with _httpx.AsyncClient(timeout=8.0) as _client:
                                _r = await _client.get(doc_url, timeout=8.0)
                                if _r.status_code == 200:
                                    full_doc = _r.text[:6000]
                        except Exception:
                            full_doc += f"\ndoc_url: {doc_url}"
                    if openapi_url:
                        try:
                            import httpx as _httpx2
                            async with _httpx2.AsyncClient(timeout=8.0) as _client2:
                                _r2 = await _client2.get(openapi_url, timeout=8.0)
                                if _r2.status_code == 200:
                                    full_doc += f"\n\nOpenAPI:\n{_r2.text[:6000]}"
                        except Exception:
                            pass
                    if not full_doc or len(full_doc.strip()) < 10:
                        raise ValueError("请提供 code，或 doc_text / doc_url / curl / openapi_url 以便生成代码")
                    from app.api.provider_routes import llm_generate_code as _lgc, create_code_source as _ccs
                    code_text = await _lgc(kind, language, full_doc, name or "")
                    # 统一创建入口：代码清洗/schema 规整/超时/保存注册/Key/沙箱体检 一条龙
                    _created = _ccs(
                        name=name or f"自定义{kind}源", kind=kind, code=code_text, language=language,
                        description=f"由导演从文档自动生成（{language}）",
                        api_key=api_key or None, doc_text=full_doc, doc_url=doc_url or "",
                        trusted=_trusted_bool,
                        headers=headers,
                        input_schema=_input_schema,
                        params_schema=_params_schema,
                        models=_models,
                        default_model=_default_model,
                    )
                    result = {"status": "success" if _created["compile_check"].get("ok") else "compile_failed",
                              "provider": _created["provider"], "mode": "llm_code", "code": _created["code"],
                              "compile_check": _created["compile_check"],
                              **({"hint": "生成的代码未通过沙箱编译体检，请根据 compile_check.error 修正后调用 update_custom_provider 重新提交"} if not _created["compile_check"].get("ok") else {})}

            elif tool_name == "list_custom_providers":
                from app.providers.custom.manager import custom_provider_manager as _mgr
                kind = (arguments.get("kind") or "").strip() or None
                q = (arguments.get("q") or "").strip().lower()
                defs = _mgr.list_definitions(kind=kind)
                # q 模糊过滤：名称/ID/描述/类型
                if q:
                    def _hit(d):
                        hay = f"{d.id} {d.name} {d.display_name or ''} {d.description or ''} {d.kind}".lower()
                        return q in hay
                    defs = [d for d in defs if _hit(d)]
                # 返回摘要（不含 code 全文，防上下文爆炸）
                result = {"providers": [d.to_provider_info(include_code=False) for d in defs], "total": len(defs), "q": q or None, "kind": kind}

            elif tool_name == "test_custom_provider":
                pid = arguments.get("provider_id") or ""
                if not pid:
                    raise ValueError("provider_id 不能为空")
                # 与 HTTP /providers/{id}/test 共用同一实现：测试联通即写“生产可用”验证标记，
                # 保证 Agent 侧测试过的源会出现在画布/分镜的生产端选择器（原先 MCP 不落验证 → 画布选不到源）
                from app.api.provider_routes import run_provider_test
                result = await run_provider_test(pid)

            elif tool_name == "delete_custom_provider":
                pid = arguments.get("provider_id") or ""
                if not pid:
                    raise ValueError("provider_id 不能为空")
                from app.providers.custom.manager import custom_provider_manager as _mgr
                from app.providers.init_providers import unregister_single_custom_provider as _unreg
                pd = _mgr.get_definition(pid)
                if not pd:
                    raise ValueError(f"Provider 不存在: {pid}")
                if pd.builtin:
                    raise ValueError("内置 Provider 不可删除")
                kind = pd.kind
                _mgr.delete_definition(pid)
                import os, json as _json
                from app.core.config import settings as _settings
                cfg_path = os.path.join(_settings.STORAGE_DIR, "config_store.json")
                if os.path.exists(cfg_path):
                    try:
                        with open(cfg_path, "r", encoding="utf-8") as f:
                            data = _json.load(f)
                        if "custom_providers" in data and pid in data["custom_providers"]:
                            data["custom_providers"].pop(pid, None)
                        data.pop(f"CUSTOM_PROVIDER_{pid}", None)
                        with open(cfg_path, "w", encoding="utf-8") as f:
                            _json.dump(data, f, ensure_ascii=False, indent=2)
                        os.environ.pop(f"CUSTOM_PROVIDER_{pid}", None)
                    except Exception:
                        pass
                _unreg(pid, kind=kind)
                result = {"status": "deleted", "provider_id": pid}

            elif tool_name == "update_custom_provider":
                pid = arguments.get("provider_id") or ""
                if not pid:
                    raise ValueError("provider_id 不能为空")
                from app.providers.custom.manager import custom_provider_manager as _mgr
                pd = _mgr.get_definition(pid)
                if not pd:
                    raise ValueError(f"Provider 不存在: {pid}")
                if pd.builtin:
                    raise ValueError("内置 Provider 不可编辑")
                # 允许更新的字段（A档新增 trusted 开关）
                if "language" in arguments and arguments["language"] is not None:
                    _lang = str(arguments["language"]).strip().lower()
                    if _lang in ("js", "node"):
                        _lang = "javascript"
                    if _lang not in ("python", "javascript"):
                        raise ValueError(f"language 非法: {arguments['language']}（仅支持 python/javascript）")
                    pd.language = _lang
                if "models" in arguments and arguments["models"] is not None:
                    _models = arguments["models"]
                    if isinstance(_models, str):
                        _models = [_models]
                    if not isinstance(_models, list):
                        raise ValueError("models 需为字符串数组")
                    pd.models = [str(m) for m in _models]
                for field in ["name","description","code","code_entry","default_model","doc_text",
                              "input_schema","params_schema","output_schema","default_params"]:
                    if field in arguments and arguments[field] is not None:
                        setattr(pd, field, arguments[field])
                # schema 规整：补全 x-*（与创建/读取同一单点口径）
                try:
                    from app.api.provider_routes import _enrich_input_schema, _enrich_params_schema
                    if isinstance(pd.input_schema, dict) and pd.input_schema.get("properties"):
                        pd.input_schema = _enrich_input_schema(pd.input_schema, pd.kind)
                    if isinstance(pd.params_schema, dict) and pd.params_schema.get("properties"):
                        pd.params_schema = _enrich_params_schema(pd.params_schema, pd.kind)
                except Exception:
                    pass
                if "trusted" in arguments and arguments["trusted"] is not None:
                    v = arguments["trusted"]
                    pd.trusted = bool(v) if not isinstance(v, str) else v.strip().lower() in ("1", "true", "yes", "on")
                # 代码空洞拦截：空代码入库会导致后续每次生成都失败
                if "code" in arguments and (not pd.code or len(pd.code.strip()) < 20):
                    raise ValueError("code 内容过短（<20字符），拒绝保存以免生成源变砖；请提供完整 async def generate(ctx, api)")
                # 沙箱体检（先验后存）：坏码直接打回，不入库、不热注册，避免改码后服务崩溃/变砖
                if "code" in arguments or "language" in arguments or "trusted" in arguments:
                    from app.providers.generic.code_provider import compile_check_code as _ccc
                    _cc = _ccc(pd.language or "python", pd.code or "", pd.code_entry or "generate",
                               trusted=bool(getattr(pd, "trusted", False)))
                    if not _cc.get("ok"):
                        raise ValueError(f"代码未通过沙箱体检，已拒绝保存: {_cc.get('error')}")
                pd.touch()
                from app.api.provider_routes import _default_input_schema, _default_output_schema
                if not pd.input_schema:
                    pd.input_schema = _default_input_schema(pd.kind)
                if not pd.output_schema:
                    pd.output_schema = _default_output_schema(pd.kind)
                saved = _mgr.save_definition(pd)
                from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
                unregister_single_custom_provider(pid, kind=pd.kind)
                register_single_custom_provider(saved)
                from app.providers import verification as _verification
                _verification.clear(pid)  # 定义变更 → 需重新测试才可回到生产端（与 HTTP 更新同口径）
                result = {"status": "updated", "provider": saved.to_provider_info()}

            elif tool_name == "get_provider_code":
                # 支持 id/name/q/kind 多维精准或模糊单选
                raw_pid = (arguments.get("provider_id") or "").strip()
                raw_name = (arguments.get("name") or "").strip()
                raw_q = (arguments.get("q") or "").strip()
                raw_kind = (arguments.get("kind") or "").strip() or None
                from app.providers.custom.manager import custom_provider_manager as _mgr
                pd = None
                # 1) 精准 id 优先
                if raw_pid:
                    pd = _mgr.get_definition(raw_pid)
                # 2) 按 name/q 模糊单选
                if not pd:
                    search = (raw_name or raw_q or raw_pid).strip()
                    if search:
                        # 先精确匹配 id/name
                        candidates = _mgr.list_definitions(kind=raw_kind)
                        # 若仍为空，尝试不限 kind 再搜
                        if not candidates and raw_kind:
                            candidates = _mgr.list_definitions(kind=None)
                        sl = search.lower()
                        # 精确
                        for d in candidates:
                            if d.id.lower() == sl or (d.name and d.name.lower() == sl):
                                pd = d
                                break
                        # 模糊包含
                        if not pd:
                            for d in candidates:
                                hay = f"{d.id} {d.name} {d.display_name or ''} {d.description or ''}".lower()
                                if sl in hay:
                                    pd = d
                                    break
                        # 若仍无，尝试 id 前缀匹配
                        if not pd:
                            for d in candidates:
                                if d.id.lower().startswith(sl) or sl.startswith(d.id.lower()[:8]):
                                    pd = d
                                    break
                    else:
                        # 无任何搜索词但有 kind 且仅 1 个，自动单选
                        if raw_kind:
                            cands = _mgr.list_definitions(kind=raw_kind)
                            if len(cands) == 1:
                                pd = cands[0]
                if not pd:
                    # 给出可选清单以便导演二次选择
                    all_defs = _mgr.list_definitions(kind=raw_kind)
                    brief = [{"id": d.id, "name": d.name, "kind": d.kind, "description": (d.description or "")[:60]} for d in all_defs[:12]]
                    raise ValueError(f"未找到匹配的 Provider (provider_id='{raw_pid}' name='{raw_name}' q='{raw_q}' kind='{raw_kind}')，可选: {brief}")
                # 返回完整信息：含参数结构与代码；代码窗口可分页通读（offset/limit），便于诊断与改码
                info = pd.to_provider_info(include_code=False)
                full_code = pd.code or ""
                try:
                    _c_off = max(0, int(arguments.get("offset") or 0))
                except Exception:
                    _c_off = 0
                try:
                    _c_lim = int(arguments.get("limit") or 4000)
                except Exception:
                    _c_lim = 4000
                _c_lim = max(200, min(_c_lim, 6000))
                _chunk = full_code[_c_off:_c_off + _c_lim]
                _next_off = _c_off + len(_chunk)
                result = {
                    "provider_id": pd.id,
                    "id": pd.id,
                    "name": pd.name,
                    "kind": pd.kind,
                    "language": pd.language,
                    "code_entry": pd.code_entry,
                    "code": _chunk,
                    "code_offset": _c_off,
                    "code_total_len": len(full_code),
                    "code_has_more": _next_off < len(full_code),
                    "code_next_offset": _next_off if _next_off < len(full_code) else None,
                    "code_preview": (full_code[:800] + f"…(共{len(full_code)}字符)") if len(full_code) > 800 else full_code,
                    "code_length": len(full_code),
                    "description": pd.description,
                    "params_schema": pd.params_schema,
                    "input_schema": pd.input_schema,
                    "output_schema": pd.output_schema,
                    "default_params": pd.default_params,
                    "provider_info": info,
                }

            elif tool_name == "upgrade_provider_to_code":
                pid = arguments.get("provider_id") or ""
                lang = arguments.get("language") or "python"
                if not pid:
                    raise ValueError("provider_id 不能为空")
                from app.providers.custom.manager import custom_provider_manager as _mgr
                pd = _mgr.get_definition(pid)
                if not pd:
                    raise ValueError(f"Provider 不存在: {pid}")
                if pd.code:
                    result = {"status": "already_code", "provider": pd.to_provider_info()}
                else:
                    # 根据旧 transport 生成模板代码（存量非代码源的一次性升级迁移）
                    url = pd.transport.url or "https://api.example.com/v1/generate"
                    from app.api.provider_routes import CODE_TEMPLATES
                    tmpl = CODE_TEMPLATES.get((lang, pd.kind)) or CODE_TEMPLATES.get(("python", pd.kind)) or ""
                    code = tmpl.replace("https://api.example.com/v1/images/generations", url).replace("https://api.example.com/v1/videos/generations", url).replace("https://api.example.com/v1/audio/speech", url)
                    pd.language = lang
                    pd.code = code
                    pd.code_entry = "generate"
                    pd.provider_type = "code"
                    saved = _mgr.save_definition(pd)
                    from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
                    unregister_single_custom_provider(pid, kind=pd.kind)
                    register_single_custom_provider(saved)
                    result = {"status": "upgraded", "provider": saved.to_provider_info()}

            elif tool_name == "fs_read":
                result = _fs_read_action(
                    arguments.get("path") or "",
                    arguments.get("offset") or 0,
                    arguments.get("limit") or 500,
                    arguments.get("encoding") or "utf-8",
                )

            elif tool_name == "read_skill":
                from app.skills.engine import skill_engine as _se
                _name = (arguments.get("name") or "").strip()
                if not _name:
                    result = {
                        "skills": [
                            {"name": s.name, "description": (s.description or "")[:160],
                             "category": s.category or "", "version": s.version or ""}
                            for s in _se.list_skills()
                        ],
                        "total": len(_se.list_skills()),
                        "hint": "传 name 读取对应技能的完整执行 SOP（SKILL.md）",
                    }
                else:
                    _skill = _se.get_skill(_name)
                    if _skill is None:
                        _sl = _name.lower()
                        for _s in _se.list_skills():
                            if _sl in (_s.name or "").lower() or _sl in (_s.description or "").lower():
                                _skill = _s
                                break
                    if _skill is None:
                        _names = [s.name for s in _se.list_skills()][:30]
                        raise ValueError(f"未找到技能: {_name}，可选: {_names}")
                    result = {
                        "name": _skill.name,
                        "description": _skill.description,
                        "category": _skill.category,
                        "version": _skill.version,
                        "tools": list(_skill.tools or []),
                        "file_path": _skill.file_path,
                        "instructions": (_skill.instructions or "")[:12000],
                        "truncated": len(_skill.instructions or "") > 12000,
                    }

            elif tool_name == "fs_file":
                result = _fs_file_action(
                    arguments.get("action") or "",
                    arguments.get("path") or "",
                    arguments.get("content") or "",
                    arguments.get("encoding") or "utf-8",
                )

            elif tool_name == "shell_exec":
                try:
                    _to = int(arguments.get("timeout") or 1200)
                except Exception:
                    _to = 1200
                result = _run_trusted_shell(arguments.get("command") or "", arguments.get("cwd") or "", _to)

            elif tool_name in ("creator_inspect_runtime", "creator_propose_capability", "creator_start_test", "creator_finalize"):
                from app.agent import creator as _creator
                if tool_name == "creator_inspect_runtime":
                    result = _creator.inspect_runtime(project_context if isinstance(project_context, dict) else {"project": project_context})
                elif tool_name == "creator_propose_capability":
                    goal = (arguments.get("goal") or "").strip()
                    if not goal:
                        raise ValueError("goal 不能为空")
                    result = _creator.propose_capability(goal, {"project": project_context} if project_context else {})
                elif tool_name == "creator_start_test":
                    pid = (arguments.get("proposal_id") or "").strip()
                    if not pid:
                        raise ValueError("proposal_id 不能为空")
                    result = await _creator.start_test(pid, {"project": project_context} if project_context else {})
                elif tool_name == "creator_finalize":
                    pid = (arguments.get("proposal_id") or "").strip()
                    act = (arguments.get("action") or "persist").strip()
                    if not pid:
                        raise ValueError("proposal_id 不能为空")
                    result = await _creator.finalize(pid, act, {"project": project_context} if project_context else {})

            elif tool_name in ("canvas_query","canvas_create_node","canvas_update_node","canvas_delete_node","canvas_connect","canvas_execute","canvas_dispatch_skill","canvas_query_assets"):
                # 画布工具：真实持久化到 storage/projects/{id}/canvas.json，前端通过轮询/事件同步
                from app.providers.project.manager import project_manager as _pm
                # 尝试从参数或上下文获取 project_id
                pid = arguments.get("project_id")
                if not pid and isinstance(project_context, dict):
                    pid = project_context.get("id") or project_context.get("project_id")
                if not pid:
                    # 回退：取最近项目的 canvas（用于 dev 无 project 上下文时）
                    try:
                        lst = _pm.list_projects()
                        if lst:
                            pid = lst[0].get("id")
                    except Exception:
                        pid = None
                if tool_name == "canvas_query":
                    if not pid:
                        result = {"nodes": [], "edges": [], "summary": "暂无项目，无法查询画布"}
                    else:
                        snap = _pm.get_canvas(pid)
                        if not snap:
                            result = {"project_id": pid, "nodes": [], "edges": [], "summary": "画布为空"}
                        else:
                            nodes = snap.get("nodes") or []
                            edges = snap.get("edges") or []
                            # 压缩摘要
                            lines = [f"画布共 {len(nodes)} 节点 {len(edges)} 连线"]
                            for n in nodes[:10]:
                                d = n.get("data") or {}
                                title = (d.get("prompt") or d.get("text") or d.get("brief") or d.get("name") or "")[:24]
                                lines.append(f"- [{n.get('type')}] {n.get('id')} @({int(n.get('position',{}).get('x',0))},{int(n.get('position',{}).get('y',0))}) {title}")
                            if len(nodes) > 10:
                                lines.append(f"… 还有 {len(nodes)-10} 节点")
                            result = {"project_id": pid, "nodes": nodes, "edges": edges, "summary": "\n".join(lines)}
                elif tool_name == "canvas_query_assets":
                    if not pid:
                        result = {"assets": [], "summary": "暂无项目"}
                    else:
                        snap = _pm.get_canvas(pid) or {}
                        nodes = snap.get("nodes") or []
                        assets_list = []
                        seen_u = set()
                        for n in nodes:
                            d = n.get("data") or {}
                            candidates = [
                                {"url": d.get("image_url") or d.get("result_url"), "type": "image", "label": "图像", "node_id": n.get("id")},
                                {"url": d.get("first_frame") or d.get("first_frame_url"), "type": "image", "label": "首帧", "node_id": n.get("id")},
                                {"url": d.get("last_frame") or d.get("last_frame_url"), "type": "image", "label": "尾帧", "node_id": n.get("id")},
                                {"url": d.get("reference") or d.get("reference_image"), "type": "image", "label": "参考图", "node_id": n.get("id")},
                                {"url": d.get("video_url"), "type": "video", "label": "视频", "node_id": n.get("id")},
                                {"url": d.get("audio_url"), "type": "audio", "label": "音频", "node_id": n.get("id")},
                            ]
                            # 展开 reference_images 数组（多图垫图）
                            if isinstance(d.get("reference_images"), list):
                                for idx, u in enumerate(d.get("reference_images")):
                                    if u and isinstance(u, str) and u.strip() and u.strip() not in seen_u:
                                        seen_u.add(u.strip())
                                        assets_list.append({"url": u.strip(), "type": "image", "label": f"参考图{idx+1}", "node_id": n.get("id")})
                            for c in candidates:
                                u = c["url"]
                                if u and isinstance(u, str) and u.strip() and u not in seen_u:
                                    seen_u.add(u)
                                    assets_list.append(c)
                        result = {"project_id": pid, "total_assets": len(assets_list), "assets": assets_list}
                elif tool_name == "canvas_dispatch_skill":
                    if not pid:
                        raise ValueError("canvas_dispatch_skill 需要 project_id")
                    skill_id = arguments.get("skill_id")
                    prompt = arguments.get("prompt") or ""
                    nid = arguments.get("node_id")
                    snap = _pm.get_canvas(pid) or {"nodes": [], "edges": [], "version": 2}
                    nodes = snap.get("nodes") or []
                    
                    # Agent 节点类型推断（与前端 getSkillsForKind 对齐）
                    if "video" in skill_id or skill_id in ("first_last_frame", "all_round_reference", "text_to_video", "image_reference_video"):
                        ntype = "video"
                    elif "image" in skill_id or skill_id in ("text_to_image", "image_reference", "character_consistency", "image_character_consistency"):
                        ntype = "image"
                    elif "audio" in skill_id or skill_id in ("tts_voice", "audio_clone", "character_voice"):
                        ntype = "audio"
                    elif skill_id in ("camera_plan", "director_plan"):
                        ntype = "director3d"
                    else:
                        ntype = "prompt"
                    
                    target_node = None
                    if nid:
                        for n in nodes:
                            if n.get("id") == nid:
                                target_node = n
                                break
                    if not target_node:
                        import time as _t, random as _r
                        nid = f"{ntype}_{int(_t.time()*1000)%100000}_{_r.randint(100,999)}"
                        target_node = {
                            "id": nid,
                            "type": ntype,
                            "position": {"x": 120 + len(nodes) * 40, "y": 120 + len(nodes) * 40},
                            "data": {}
                        }
                        nodes.append(target_node)
                    
                    d = target_node.get("data") or {}
                    d["skill_id"] = skill_id
                    if prompt:
                        d["prompt"] = prompt
                        d["text"] = prompt
                        d["image_prompt"] = prompt
                        d["video_prompt"] = prompt
                    if arguments.get("first_frame_url"):
                        d["first_frame"] = arguments["first_frame_url"]
                        d["first_frame_url"] = arguments["first_frame_url"]
                    if arguments.get("last_frame_url"):
                        d["last_frame"] = arguments["last_frame_url"]
                        d["last_frame_url"] = arguments["last_frame_url"]
                    if arguments.get("reference_images"):
                        d["reference_images"] = arguments["reference_images"]
                    target_node["data"] = d
                    
                    from app.canvas.engine import canvas_engine as _engine
                    res = await _engine.execute_dag(nodes, snap.get("edges") or [], project_id=pid, target_ids=[nid])
                    node_res = (res.get("results") or {}).get(nid) or {}
                    
                    if node_res.get("status") == "success":
                        for k in ("image_url", "video_url", "audio_url", "prompt", "text", "script_data"):
                            if node_res.get(k):
                                d[k] = node_res[k]
                        target_node["data"] = d
                    
                    snap["nodes"] = nodes
                    import time as _t4
                    snap["updated_at"] = _t4.strftime("%Y-%m-%dT%H:%M:%SZ", _t4.gmtime())
                    _pm.save_canvas(pid, snap)
                    result = {
                        "status": "success",
                        "skill_id": skill_id,
                        "node_id": nid,
                        "result": node_res,
                        "project_id": pid
                    }
                elif tool_name == "canvas_create_node":
                    if not pid:
                        raise ValueError("canvas_create_node 需要 project_id（或在上下文中提供 project）")
                    ntype = arguments.get("type")
                    if not ntype:
                        raise ValueError("type 不能为空")
                    pos = arguments.get("position") or {}
                    if isinstance(pos, str):
                        try:
                            import json as _js
                            pos = _js.loads(pos)
                        except Exception:
                            pos = {}
                    x = int(pos.get("x", 120 + (len((_pm.get_canvas(pid) or {}).get("nodes") or []) * 40) % 600))
                    y = int(pos.get("y", 80 + len((_pm.get_canvas(pid) or {}).get("nodes") or []) * 120))
                    params = arguments.get("params") or {}
                    if isinstance(params, str):
                        try:
                            import json as _js2
                            params = _js2.loads(params)
                        except Exception:
                            params = {}
                    snap = _pm.get_canvas(pid) or {"nodes": [], "edges": [], "version": 2}
                    nodes = snap.get("nodes") or []
                    import time as _time, random as _rnd
                    nid = f"{ntype}_{int(_time.time()*1000)%100000}_{_rnd.randint(100,999)}"
                    existing_ids = {n.get("id") for n in nodes}
                    while nid in existing_ids:
                        nid = f"{ntype}_{int(_time.time()*1000)%100000}_{_rnd.randint(100,999)}"
                    new_node = {"id": nid, "type": ntype, "position": {"x": x, "y": y}, "data": dict(params or {})}
                    if ntype == "prompt" and not new_node["data"].get("prompt"):
                        new_node["data"]["prompt"] = params.get("prompt") or ""
                    nodes.append(new_node)
                    snap["nodes"] = nodes
                    snap["edges"] = snap.get("edges") or []
                    snap["updated_at"] = _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())
                    _pm.save_canvas(pid, snap)
                    result = {"status": "created", "project_id": pid, "node": new_node, "total_nodes": len(nodes)}
                elif tool_name == "canvas_update_node":
                    if not pid:
                        raise ValueError("canvas_update_node 需要 project_id")
                    nid = arguments.get("node_id")
                    patch = arguments.get("patch") or {}
                    if isinstance(patch, str):
                        try:
                            import json as _js3
                            patch = _js3.loads(patch)
                        except Exception:
                            patch = {}
                    snap = _pm.get_canvas(pid)
                    if not snap:
                        raise ValueError(f"项目 {pid} 画布不存在")
                    nodes = snap.get("nodes") or []
                    found = False
                    for n in nodes:
                        if n.get("id") == nid:
                            d = n.get("data") or {}
                            d.update(patch or {})
                            n["data"] = d
                            found = True
                            break
                    if not found:
                        raise ValueError(f"节点不存在: {nid}")
                    snap["nodes"] = nodes
                    import time as _time2
                    snap["updated_at"] = _time2.strftime("%Y-%m-%dT%H:%M:%SZ", _time2.gmtime())
                    _pm.save_canvas(pid, snap)
                    result = {"status": "updated", "project_id": pid, "node_id": nid, "patch": patch}
                elif tool_name == "canvas_delete_node":
                    if not pid:
                        raise ValueError("canvas_delete_node 需要 project_id（或在上下文中提供 project）")
                    nid = str(arguments.get("node_id") or "").strip()
                    if not nid:
                        raise ValueError("node_id 不能为空")
                    snap = _pm.get_canvas(pid)
                    if not snap:
                        raise ValueError(f"项目 {pid} 画布不存在")
                    nodes = snap.get("nodes") or []
                    edges = snap.get("edges") or []
                    hit = next((n for n in nodes if n.get("id") == nid), None)
                    if not hit:
                        raise ValueError(f"节点不存在: {nid}（先用 canvas_query 确认真实 id）")
                    # 连带删掉挂在它身上的连线：只删节点会留下 source/target 指向不存在节点的悬空边，
                    # 前端渲染与后续 canvas_execute 的拓扑排序都会受影响。
                    drop_edges = [e for e in edges if e.get("source") == nid or e.get("target") == nid]
                    snap["nodes"] = [n for n in nodes if n.get("id") != nid]
                    snap["edges"] = [e for e in edges if e.get("source") != nid and e.get("target") != nid]
                    import time as _time5
                    snap["updated_at"] = _time5.strftime("%Y-%m-%dT%H:%M:%SZ", _time5.gmtime())
                    _pm.save_canvas(pid, snap)
                    result = {
                        "status": "deleted",
                        "project_id": pid,
                        "deleted_node": {"id": nid, "type": hit.get("type")},
                        "deleted_edges": len(drop_edges),
                        "total_nodes": len(snap["nodes"]),
                        "total_edges": len(snap["edges"]),
                    }
                elif tool_name == "canvas_connect":
                    if not pid:
                        raise ValueError("canvas_connect 需要 project_id")
                    src = arguments.get("source")
                    tgt = arguments.get("target")
                    if not src or not tgt:
                        raise ValueError("source/target 不能为空")
                    sh = arguments.get("sourceHandle") or arguments.get("source_handle") or ""
                    th = arguments.get("targetHandle") or arguments.get("target_handle") or ""
                    snap = _pm.get_canvas(pid)
                    if not snap:
                        raise ValueError(f"项目 {pid} 画布不存在")
                    edges = snap.get("edges") or []
                    for e in edges:
                        if e.get("source")==src and e.get("target")==tgt and (e.get("sourceHandle") or "")==(sh or "") and (e.get("targetHandle") or "")==(th or ""):
                            result = {"status": "already_connected", "project_id": pid, "edge": e}
                            break
                    else:
                        import time as _time3, uuid as _uuid
                        eid = f"e_{src}_{tgt}_{int(_time3.time()*1000)%10000}"
                        new_edge = {"id": eid, "source": src, "target": tgt, "sourceHandle": sh, "targetHandle": th, "type": "smoothstep", "animated": True}
                        if not sh:
                            new_edge.pop("sourceHandle", None)
                        if not th:
                            new_edge.pop("targetHandle", None)
                        edges.append(new_edge)
                        snap["edges"] = edges
                        snap["updated_at"] = _time3.strftime("%Y-%m-%dT%H:%M:%SZ", _time3.gmtime())
                        _pm.save_canvas(pid, snap)
                        result = {"status": "connected", "project_id": pid, "edge": new_edge, "total_edges": len(edges)}
                elif tool_name == "canvas_execute":
                    from app.canvas.engine import canvas_engine as _engine
                    nodes = arguments.get("nodes")
                    edges = arguments.get("edges")
                    tgt_ids = arguments.get("target_ids") or arguments.get("targetIds")
                    if (not nodes or not edges) and pid:
                        snap = _pm.get_canvas(pid)
                        if snap:
                            nodes = snap.get("nodes") or nodes
                            edges = snap.get("edges") or edges
                    if not nodes:
                        raise ValueError("画布为空，无法执行")
                    exec_res = await _engine.execute_dag(nodes or [], edges or [], project_id=pid, target_ids=tgt_ids)
                    result = {"project_id": pid, "executed": True, "order": exec_res.get("order"), "results": exec_res.get("results")}
                else:
                    result = {"tool": tool_name, "arguments": arguments, "hint": "前端画布将执行此指令", "directive": True}

            elif tool_name == "director_3d_stage_plan":
                framing = arguments.get("framing") or "medium"
                motion = arguments.get("motion") or "push_in"
                pose = arguments.get("pose") or "stand"
                focal_length_mm = float(arguments.get("focal_length_mm") or 35.0)
                camera_roll_deg = float(arguments.get("camera_roll_deg") or 0.0)
                cast_layout = arguments.get("cast_layout") or "solo"
                speed = arguments.get("speed") or "1.0x"
                ai_directive = (arguments.get("ai_directive") or "").strip()

                # LLM 语义解析优先（白名单校验；失败/超时即回退关键词规则，保证离线可用）
                llm_hit = False
                if ai_directive:
                    try:
                        from app.pipelines.llm_service import llm_service as _llm
                        _sys = ("你是分镜导演调度器。把中文导演指令映射为机位参数，仅输出JSON："
                                "{\"framing\":...,\"motion\":...,\"pose\":...,\"cast_layout\":...,\"focal_length_mm\":...}。"
                                "framing可选：extreme_close_up/close_up/medium/full/long/bird_eye/low_angle/over_shoulder/dutch_angle/high_angle；"
                                "motion可选：static/push_in/pull_out/pan_left/pan_right/tilt_up/tilt_down/orbit/orbit_ccw/truck_left/truck_right/boom_up/boom_down/roll_left/roll_right/tracking/shake/dolly_zoom/orbit_boom_up/pan_left_crane_down/fast_push_shake/low_angle_truck_right；"
                                "pose可选：stand/fight/look_back/run/cast_spell/kneel/defend/fly/injured；"
                                "cast_layout可选：solo/duel/ots/surrounded；focal_length_mm取16/20/24/28/32/35/40/50/85其一。")
                        _parsed = await _llm.chat_json(_sys, ai_directive, temperature=0.2, timeout=12, max_tokens=300)
                        if isinstance(_parsed, dict):
                            _fr = str(_parsed.get("framing") or "")
                            _mo = str(_parsed.get("motion") or "")
                            _po = str(_parsed.get("pose") or "")
                            _ca = str(_parsed.get("cast_layout") or "")
                            if _fr in FRAMING_CAMERA:
                                framing = _fr
                            if _mo in MOTION_TRAJECTORY:
                                motion = _mo
                            if _po in ("stand", "fight", "look_back", "run", "cast_spell", "kneel", "defend", "fly", "injured"):
                                pose = _po
                            if _ca in ("solo", "duel", "ots", "surrounded"):
                                cast_layout = _ca
                            try:
                                _fl = float(_parsed.get("focal_length_mm") or 0)
                                if 12 <= _fl <= 135:
                                    focal_length_mm = _fl
                            except Exception:
                                pass
                            llm_hit = True
                    except Exception:
                        llm_hit = False

                # 自然语言指令快速智能匹配（LLM 未命中时的关键词兜底）
                if ai_directive and not llm_hit:
                    text_lower = ai_directive.lower()
                    if any(w in text_lower for w in ["希区柯克", "眩晕", "vertigo", "dolly zoom"]):
                        motion = "dolly_zoom"
                        framing = "close_up"
                    elif any(w in text_lower for w in ["仰视", "仰角", "霸气", "贴地", "low angle"]):
                        framing = "low_angle"
                        focal_length_mm = 28.0
                    elif any(w in text_lower for w in ["特写", "眼神", "微表情", "close up"]):
                        framing = "extreme_close_up"
                        focal_length_mm = 85.0
                    elif any(w in text_lower for w in ["鸟瞰", "俯冲", "高空", "俯视", "bird"]):
                        framing = "bird_eye"
                        focal_length_mm = 20.0
                    elif any(w in text_lower for w in ["对峙", "交锋", "双人", "duel"]):
                        cast_layout = "duel"
                        pose = "fight"
                    elif any(w in text_lower for w in ["过肩", "ots", "背后"]):
                        framing = "over_shoulder"
                        cast_layout = "ots"
                    elif any(w in text_lower for w in ["环绕", "升镜", "登场"]):
                        motion = "orbit_boom_up"
                    elif any(w in text_lower for w in ["冲击", "震颤", "震动", "命中"]):
                        motion = "fast_push_shake"
                        pose = "fight"
                    elif any(w in text_lower for w in ["施法", "御剑", "结界"]):
                        pose = "cast_spell"
                    elif any(w in text_lower for w in ["突进", "奔跑", "冲锋"]):
                        pose = "run"

                cam = FRAMING_CAMERA.get(framing, FRAMING_CAMERA["medium"])
                traj = MOTION_TRAJECTORY.get(motion, MOTION_TRAJECTORY["push_in"])
                
                # 如果机位有默认 roll_deg 且用户未显式设置，则使用预设
                if camera_roll_deg == 0.0 and "roll_deg" in cam:
                    camera_roll_deg = cam["roll_deg"]

                minimax_prompt = build_minimax_camera_prompt(
                    framing=framing,
                    motion=motion,
                    focal_length_mm=focal_length_mm,
                    roll_deg=camera_roll_deg,
                    speed=speed
                )

                result = {
                    "framing": framing,
                    "motion": motion,
                    "pose": pose,
                    "focal_length_mm": focal_length_mm,
                    "camera_roll_deg": camera_roll_deg,
                    "cast_layout": cast_layout,
                    "speed": speed,
                    "camera_fov": cam["fov"],
                    "camera_position": cam["position"],
                    "target_position": cam["target"],
                    "motion_trajectory": traj,
                    "minimax_camera_prompt": minimax_prompt,
                    "depth_guidance_ready": True,
                    "parse_mode": "llm" if llm_hit else ("keyword" if ai_directive else "explicit"),
                    "engine": "minimax-01-director-camera-calculator"
                }

            elapsed_ms = int((time.time() - start_time) * 1000)
            return MCPToolCallResponse(tool_name=tool_name, status="success", result=result, execution_time_ms=elapsed_ms)

        except asyncio.CancelledError:
            raise
        except BaseException as e:
            # SystemExit/KeyboardInterrupt 等必须就地转为普通错误，否则杀死 uvicorn worker 致服务崩溃重启
            elapsed_ms = int((time.time() - start_time) * 1000)
            return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=str(e), execution_time_ms=elapsed_ms)


mcp_registry = MCPServerRegistry()
