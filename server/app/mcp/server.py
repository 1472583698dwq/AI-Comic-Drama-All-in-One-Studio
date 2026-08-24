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


# 相机参数计算表
FRAMING_CAMERA = {
    "extreme_close_up": {"fov": 22, "position": [0, 1.55, 0.9], "target": [0, 1.5, 0]},
    "close_up": {"fov": 30, "position": [0, 1.52, 1.6], "target": [0, 1.45, 0]},
    "medium": {"fov": 45, "position": [0, 1.5, 3.2], "target": [0, 1.4, 0]},
    "full": {"fov": 50, "position": [0, 1.4, 4.8], "target": [0, 1.1, 0]},
    "long": {"fov": 55, "position": [0, 1.6, 6.5], "target": [0, 1.3, 0]},
    "bird_eye": {"fov": 60, "position": [0, 7.0, 2.0], "target": [0, 0.8, 0]},
    "low_angle": {"fov": 40, "position": [0, 0.5, 2.6], "target": [0, 1.6, 0]},
}

MOTION_TRAJECTORY = {
    "static": {"path_type": "hold", "amplitude_m": 0.0, "duration_hint_s": 0.0},
    "push_in": {"path_type": "dolly_in", "amplitude_m": 0.8, "duration_hint_s": 2.0},
    "pull_out": {"path_type": "dolly_out", "amplitude_m": 1.2, "duration_hint_s": 2.2},
    "pan_left": {"path_type": "pan", "amplitude_deg": -35.0, "duration_hint_s": 1.8},
    "pan_right": {"path_type": "pan", "amplitude_deg": 35.0, "duration_hint_s": 1.8},
    "tilt_up": {"path_type": "tilt", "amplitude_deg": 25.0, "duration_hint_s": 1.5},
    "tilt_down": {"path_type": "tilt", "amplitude_deg": -25.0, "duration_hint_s": 1.5},
    "orbit": {"path_type": "orbit", "amplitude_deg": 180.0, "duration_hint_s": 4.0},
    "shake": {"path_type": "handheld_shake", "amplitude_m": 0.06, "frequency_hz": 9.0, "duration_hint_s": 1.5},
}


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
                    "style_preset": {"type": "string", "enum": ["donghua_xianxia", "japanese_anime", "modern_webtoon", "cinematic_3d", "dark_comic"], "default": "donghua_xianxia"},
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
                    "style_preset": {"type": "string", "enum": ["donghua_xianxia", "japanese_anime", "modern_webtoon", "cinematic_3d", "dark_comic"]},
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
                    "style_preset": {"type": "string", "enum": ["donghua_xianxia", "japanese_anime", "modern_webtoon", "cinematic_3d", "dark_comic"]},
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
            description="[3D导演台] 根据景别与运镜计算相机FOV/机位/轨迹",
            category="workflow",
            icon="Camera",
            author="MiniMax Design",
            is_enabled=True,
            input_schema={
                "type": "object",
                "properties": {
                    "framing": {"type": "string", "enum": ["extreme_close_up", "close_up", "medium", "full", "long", "bird_eye", "low_angle"]},
                    "motion": {"type": "string", "enum": ["static", "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "orbit", "shake"]},
                    "pose": {"type": "string", "enum": ["stand", "fight", "look_back", "run"]}
                },
                "required": ["framing", "motion"]
            }
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

            elif tool_name == "director_3d_stage_plan":
                framing = arguments.get("framing", "medium")
                motion = arguments.get("motion", "push_in")
                pose = arguments.get("pose", "stand")
                cam = FRAMING_CAMERA.get(framing, FRAMING_CAMERA["medium"])
                traj = MOTION_TRAJECTORY.get(motion, MOTION_TRAJECTORY["push_in"])
                result = {"camera_fov": cam["fov"], "camera_position": cam["position"], "target_position": cam["target"], "motion_trajectory": traj, "pose_preset": pose, "depth_guidance_ready": True, "engine": "local-camera-calculator"}

            elapsed_ms = int((time.time() - start_time) * 1000)
            return MCPToolCallResponse(tool_name=tool_name, status="success", result=result, execution_time_ms=elapsed_ms)

        except Exception as e:
            elapsed_ms = int((time.time() - start_time) * 1000)
            return MCPToolCallResponse(tool_name=tool_name, status="error", result=None, error=str(e), execution_time_ms=elapsed_ms)


mcp_registry = MCPServerRegistry()
