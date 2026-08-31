"""
MCP 统一工具中枢 - 动态可扩展版
所有生成能力均通过 Provider Registry 动态分发，支持：
- 图片：comfyui(含工作流)/siliconflow/dashscope/openai_compat 动态扩展
- 音频：minimax/elevenlabs/cosyvoice/gpt_sovits 动态扩展
- 导演Agent 暴露全部生成工具
"""
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
        async def generate_voice(text: str, voice_id: str = "male-qn-qingse", provider: str = "minimax", emotion: str = "neutral", speed: float = 1.0) -> dict:
            """通用语音生成（动态Provider）"""
            from app.providers.audio.base import AudioGenerateRequest
            reg = _lazy_audio_registry()
            req = AudioGenerateRequest(text=text, voice_id=voice_id, emotion=emotion, speed=speed)
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
        async def generate_minimax_voice(text: str, voice_id: str = "male-qn-qingse", emotion: str = "neutral") -> dict:
            """MiniMax 配音（兼容）"""
            from app.providers.audio.base import AudioGenerateRequest
            reg = _lazy_audio_registry()
            req = AudioGenerateRequest(text=text, voice_id=voice_id, emotion=emotion)
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
        async def register_custom_provider(kind: str = "image", name: str = "", language: str = "python", code: str = "", doc_text: str = "", doc_url: str = "", curl: str = "", openapi_url: str = "", api_key: str = "", definition: dict = None) -> dict:
            """[生成源扩展-代码模式] 支持 python/javascript 携程源码直接注册，或据文档自动生成代码"""
            payload = {"kind": kind, "name": name, "language": language, "doc_text": doc_text, "doc_url": doc_url, "curl": curl, "openapi_url": openapi_url, "api_key": api_key, "definition": definition}
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
        async def get_provider_code(provider_id: str) -> dict:
            res = await mcp_registry.execute_tool("get_provider_code", {"provider_id": provider_id})
            if res.status == "success":
                return res.result
            raise RuntimeError(res.error)

        @mcp_app.tool
        async def upgrade_provider_to_code(provider_id: str, language: str = "python") -> dict:
            res = await mcp_registry.execute_tool("upgrade_provider_to_code", {"provider_id": provider_id, "language": language})
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

        # 2. 通用图片生成（核心新增，对Agent暴露）
        self.register_tool(MCPToolDefinition(
            name="generate_image",
            description="[通用生图] 动态选择Provider生成漫剧分镜图像。支持provider=comfyui/siliconflow/dashscope/openai_compat，支持workflow_id指定ComfyUI自定义工作流。Agent应优先使用此工具。",
            category="ai_generation",
            icon="Image",
            author="Dynamic Image Registry",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "生图提示词（英文画面描述，自动追加风格后缀）"},
                    "provider": {"type": "string", "enum": ["comfyui", "siliconflow", "dashscope", "openai_compat"], "description": "指定Provider，不填则使用系统默认 IMAGE_PROVIDER"},
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

        # 4. 通用语音生成（核心新增）
        self.register_tool(MCPToolDefinition(
            name="generate_voice",
            description="[通用配音] 动态选择TTS Provider生成语音。支持provider=minimax/elevenlabs/cosyvoice/gpt_sovits，支持emotion/speed/pitch/克隆。",
            category="audio",
            icon="Mic2",
            author="Dynamic Audio Registry",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "配音台词或旁白"},
                    "provider": {"type": "string", "enum": ["minimax", "elevenlabs", "cosyvoice", "gpt_sovits"], "default": "minimax"},
                    "voice_id": {"type": "string", "description": "音色ID（minimax: male-qn-qingse/female-shaonv等；elevenlabs: voice_id；cosyvoice/gpt_sovits: 参考音色）"},
                    "emotion": {"type": "string", "enum": ["neutral", "intense", "sorrow", "excited", "fearful", "whispering"], "default": "neutral"},
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
                    "voice_id": {"type": "string", "default": "male-qn-qingse"},
                    "emotion": {"type": "string", "enum": ["neutral", "intense", "sorrow", "excited", "fearful", "whispering"], "default": "neutral"},
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

        # 7.1 通用视频生成 (I2V / R2V / T2V)
        self.register_tool(MCPToolDefinition(
            name="generate_video",
            description="[通用视频] 动态选择视频Provider生成动态漫剧分镜视频。支持mode=i2v(图生视频)/r2v(参考生视频)/t2v(文生视频)，支持provider=comfyui_video/minimax_video/kling。",
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
                    "duration": {"type": "integer", "default": 5, "description": "视频时长秒数 3-10"},
                    "provider": {"type": "string", "enum": ["comfyui_video", "minimax_video", "kling"], "description": "指定Provider，不填则使用系统默认 VIDEO_PROVIDER"}
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
            description="[生成源扩展-代码模式] 根据 API 文档/cURL/OpenAPI/示例或直接提供的 python/javascript 携程源码，注册新的生成源 Provider（image/video/audio）。支持 python/javascript 双语言，导演自动生成可轮询、可签名等任意逻辑的携程代码。创建后可在无限画布作为独立节点使用。",
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
                    "definition": {"type": "object", "description": "若已自行构造完整 ProviderDefinition JSON，可直接传入"}
                },
                "required": ["kind"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="list_custom_providers",
            description="[查询] 列出所有自定义生成源 Provider（按 kind 过滤），包含健康状态",
            category="utility",
            icon="List",
            author="Provider Extension",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["image", "video", "audio", "llm"], "description": "按类型过滤，不填返回全部"}
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
                },
                "required": ["provider_id"]
            }
        ))
        self.register_tool(MCPToolDefinition(
            name="get_provider_code",
            description="[查询] 获取指定 Provider 的完整代码与元信息，供导演审查后升级",
            category="utility",
            icon="FileCode",
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
        try:
            result = None
            if tool_name == "split_novel_script":
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
                    voice_id=arguments.get("voice_id", "male-qn-qingse"),
                    emotion=arguments.get("emotion", "neutral"),
                    speed=float(arguments.get("speed", 1.0)),
                    pitch=float(arguments.get("pitch", 0.0)),
                    ref_audio_path=arguments.get("ref_audio_path"),
                    ref_text=arguments.get("ref_text"),
                    model=arguments.get("model"),
                )
                audio_res = await reg.generate(req, provider_id=provider or "minimax")
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
                definition = arguments.get("definition")
                # 分支1：直接提供 code（导演编辑后回写或用户粘贴）—— 统一创建入口
                if code and isinstance(code, str) and len(code.strip()) > 20:
                    from app.api.provider_routes import create_code_source as _ccs
                    _created = _ccs(
                        name=name, kind=kind, code=code,
                        language=language if language in ("python", "javascript") else "python",
                        code_entry=arguments.get("code_entry"),
                        description=f"由导演直接提供代码（{language}）",
                        api_key=api_key or None,
                        doc_text=doc_text, doc_url=doc_url,
                    )
                    result = {"status": "success" if _created["compile_check"].get("ok") else "compile_failed",
                              "provider": _created["provider"], "mode": "direct_code",
                              "language": _created["provider"].get("language"),
                              "compile_check": _created["compile_check"],
                              **({"hint": "代码未通过沙箱编译体检，请根据 compile_check.error 修正后重新提交"} if not _created["compile_check"].get("ok") else {})}
                elif definition and isinstance(definition, dict):
                    # 分支2：直接提供完整 definition —— 统一创建入口（schema 规整/超时/保存/注册/Key/体检）
                    definition["kind"] = kind
                    if not definition.get("name"):
                        definition["name"] = name
                    from app.api.provider_routes import create_code_source as _ccs
                    _created = _ccs(
                        name=definition.get("name") or name,
                        kind=kind,
                        code=definition.get("code") or "",
                        language=definition.get("language") or language or "python",
                        code_entry=definition.get("code_entry"),
                        description=definition.get("description") or "由导演提供完整定义",
                        api_key=api_key or None,
                        doc_text=definition.get("doc_text") or doc_text or "",
                        doc_url=definition.get("doc_url") or doc_url or "",
                        params_schema=definition.get("params_schema"),
                        input_schema=definition.get("input_schema"),
                        output_schema=definition.get("output_schema"),
                        models=definition.get("models"),
                        default_model=definition.get("default_model"),
                        provider_id=definition.get("id"),
                    )
                    result = {"status": "success" if _created["compile_check"].get("ok") else "compile_failed",
                              "provider": _created["provider"], "mode": "direct_definition",
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
                        raise ValueError("请提供 doc_text / doc_url / curl / openapi_url 或 code/definition")
                    from app.pipelines.llm_service import llm_service as _llm
                    from app.api.provider_routes import code_gen_system_prompt as _cgsp, create_code_source as _ccs
                    system_prompt = _cgsp(kind, language)
                    user_prompt = "kind: " + kind + "\nlanguage: " + language + "\nname_hint: " + (name or "") + "\n\nAPI 文档:\n" + full_doc[:5000]
                    try:
                        code_text = await _llm.chat_completion(
                            messages=[{"role":"system","content":system_prompt},{"role":"user","content":user_prompt}],
                            temperature=0.2
                        )
                    except Exception:
                        code_text = await _llm.chat_json(system_prompt=system_prompt, user_prompt=user_prompt, temperature=0.2)
                        if isinstance(code_text, dict):
                            code_text = code_text.get("code") or str(code_text)
                    # 统一创建入口：代码清洗/schema 规整/超时/保存注册/Key/沙箱体检 一条龙
                    _created = _ccs(
                        name=name or f"自定义{kind}源", kind=kind, code=code_text, language=language,
                        description=f"由导演从文档自动生成（{language}）",
                        api_key=api_key or None, doc_text=full_doc, doc_url=doc_url or "",
                    )
                    result = {"status": "success" if _created["compile_check"].get("ok") else "compile_failed",
                              "provider": _created["provider"], "mode": "llm_code", "code": _created["code"],
                              "compile_check": _created["compile_check"],
                              **({"hint": "生成的代码未通过沙箱编译体检，请根据 compile_check.error 修正后调用 update_custom_provider 重新提交"} if not _created["compile_check"].get("ok") else {})}
                    # 创建即体检（零配额）：结果回传给导演 Agent，坏代码当场自我修正而不是等生成时炸
                    try:
                        from app.providers.generic.code_provider import compile_check_code as _ccc
                        _cc = _ccc(saved2.language or "python", saved2.code or "", saved2.code_entry or "generate")
                        result["compile_check"] = _cc
                        if not _cc.get("ok"):
                            result["status"] = "compile_failed"
                            result["hint"] = "生成的代码未通过沙箱编译体检，请根据 error 修正后调用 update_custom_provider 重新提交"
                            print(f"[MCP] register_custom_provider 体检未通过 {pid}: {_cc.get('error')}")
                    except Exception as _cce:
                        print(f"[MCP] 体检执行异常: {_cce}")

            elif tool_name == "list_custom_providers":
                from app.providers.custom.manager import custom_provider_manager as _mgr
                kind = arguments.get("kind")
                defs = _mgr.list_definitions(kind=kind)
                # 附带健康检查（简化：仅 is_configured）
                result = {"providers": [d.to_provider_info() for d in defs], "total": len(defs)}

            elif tool_name == "test_custom_provider":
                pid = arguments.get("provider_id") or ""
                if not pid:
                    raise ValueError("provider_id 不能为空")
                from app.providers.custom.manager import custom_provider_manager as _mgr
                pd = _mgr.get_definition(pid)
                if not pd:
                    raise ValueError(f"Provider 不存在: {pid}")
                # 优先代码 provider
                prov = None
                if pd.code and not pd.legacy_json_mode:
                    from app.providers.generic.code_provider import GenericCodeImageProvider, GenericCodeAudioProvider, GenericCodeVideoProvider
                    if pd.kind == "image":
                        prov = GenericCodeImageProvider(pd)
                    elif pd.kind == "audio":
                        prov = GenericCodeAudioProvider(pd)
                    elif pd.kind == "video":
                        prov = GenericCodeVideoProvider(pd)
                    else:
                        prov = GenericCodeImageProvider(pd)
                else:
                    from app.providers.generic.http_provider import GenericHttpImageProvider, GenericHttpAudioProvider, GenericHttpVideoProvider
                    if pd.kind == "image":
                        prov = GenericHttpImageProvider(pd)
                    elif pd.kind == "audio":
                        prov = GenericHttpAudioProvider(pd)
                    elif pd.kind == "video":
                        prov = GenericHttpVideoProvider(pd)
                    else:
                        prov = GenericHttpImageProvider(pd)
                ok = await prov.check_health()
                result = {"provider_id": pid, "ok": ok, "is_configured": prov.is_configured(), "detail": "连通正常" if ok else "未通过（检查 Key/地址/代码）"}

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
                # 允许更新的字段
                for field in ["name","description","language","code","code_entry","models","default_model","doc_text"]:
                    if field in arguments and arguments[field] is not None:
                        setattr(pd, field, arguments[field])
                # 语法检查
                if pd.language == "python" and pd.code:
                    try:
                        import ast
                        ast.parse(pd.code)
                    except SyntaxError as se:
                        raise ValueError(f"Python 语法错误: {se}")
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
                result = {"status": "updated", "provider": saved.to_provider_info()}

            elif tool_name == "get_provider_code":
                pid = arguments.get("provider_id") or ""
                if not pid:
                    raise ValueError("provider_id 不能为空")
                from app.providers.custom.manager import custom_provider_manager as _mgr
                pd = _mgr.get_definition(pid)
                if not pd:
                    raise ValueError(f"Provider 不存在: {pid}")
                result = {"provider_id": pid, "language": pd.language, "code": pd.code or "", "code_entry": pd.code_entry, "kind": pd.kind, "name": pd.name, "description": pd.description}

            elif tool_name == "upgrade_provider_to_code":
                pid = arguments.get("provider_id") or ""
                lang = arguments.get("language") or "python"
                if not pid:
                    raise ValueError("provider_id 不能为空")
                from app.providers.custom.manager import custom_provider_manager as _mgr
                pd = _mgr.get_definition(pid)
                if not pd:
                    raise ValueError(f"Provider 不存在: {pid}")
                if pd.code and not pd.legacy_json_mode:
                    result = {"status": "already_code", "provider": pd.to_provider_info()}
                else:
                    # 根据旧 transport 生成模板代码
                    url = pd.transport.url or "https://api.example.com/v1/generate"
                    from app.api.provider_routes import CODE_TEMPLATES
                    tmpl = CODE_TEMPLATES.get((lang, pd.kind)) or CODE_TEMPLATES.get(("python", pd.kind)) or ""
                    code = tmpl.replace("https://api.example.com/v1/images/generations", url).replace("https://api.example.com/v1/videos/generations", url).replace("https://api.example.com/v1/audio/speech", url)
                    pd.language = lang
                    pd.code = code
                    pd.code_entry = "generate"
                    pd.legacy_json_mode = False
                    pd.provider_type = "code"
                    saved = _mgr.save_definition(pd)
                    from app.providers.init_providers import unregister_single_custom_provider, register_single_custom_provider
                    unregister_single_custom_provider(pid, kind=pd.kind)
                    register_single_custom_provider(saved)
                    result = {"status": "upgraded", "provider": saved.to_provider_info()}

            elif tool_name in ("canvas_query","canvas_create_node","canvas_update_node","canvas_connect","canvas_execute"):
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
                elif tool_name == "canvas_create_node":
                    if not pid:
                        raise ValueError("canvas_create_node 需要 project_id（或在上下文中提供 project）")
                    ntype = arguments.get("type")
                    if not ntype:
                        raise ValueError("type 不能为空")
                    pos = arguments.get("position") or {}
                    # 兼容 position 为字符串
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
                    # 生成唯一 id
                    import time as _time, random as _rnd
                    nid = f"{ntype}_{int(_time.time()*1000)%100000}_{_rnd.randint(100,999)}"
                    # 避免 id 冲突
                    existing_ids = {n.get("id") for n in nodes}
                    while nid in existing_ids:
                        nid = f"{ntype}_{int(_time.time()*1000)%100000}_{_rnd.randint(100,999)}"
                    new_node = {"id": nid, "type": ntype, "position": {"x": x, "y": y}, "data": dict(params or {})}
                    # 确保 data 有基本字段
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
                    # 去重：同源同目标同柄不再重复
                    for e in edges:
                        if e.get("source")==src and e.get("target")==tgt and (e.get("sourceHandle") or "")==(sh or "") and (e.get("targetHandle") or "")==(th or ""):
                            result = {"status": "already_connected", "project_id": pid, "edge": e}
                            break
                    else:
                        import time as _time3, uuid as _uuid
                        eid = f"e_{src}_{tgt}_{int(_time3.time()*1000)%10000}"
                        new_edge = {"id": eid, "source": src, "target": tgt, "sourceHandle": sh, "targetHandle": th, "type": "smoothstep", "animated": True}
                        # 清理空柄
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
                    # 执行画布 DAG（复用 engine，支持按 project_id 加载或按参数直传）
                    from app.canvas.engine import canvas_engine as _engine
                    # 优先使用前端传入的 nodes/edges，否则从存储加载
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
                    # 将结果写回节点 data 便于前端展示（可选）
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

                # 自然语言指令快速智能匹配（若传入）
                if ai_directive:
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
                    "engine": "minimax-01-director-camera-calculator"
                }

            elapsed_ms = int((time.time() - start_time) * 1000)
            return MCPToolCallResponse(tool_name=tool_name, status="success", result=result, execution_time_ms=elapsed_ms)

        except Exception as e:
            elapsed_ms = int((time.time() - start_time) * 1000)
            return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=str(e), execution_time_ms=elapsed_ms)


mcp_registry = MCPServerRegistry()
