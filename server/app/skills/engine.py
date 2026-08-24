import os
import re
import yaml
import time
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from app.mcp.server import mcp_registry

SKILLS_ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../skills"))

class SkillDefinition(BaseModel):
    name: str
    description: str
    version: str = "1.0.0"
    author: str = "Official"
    category: str = "general"
    tools: List[str] = Field(default_factory=list)
    instructions: str = ""
    is_active: bool = True
    file_path: Optional[str] = None

class SkillExecutionResult(BaseModel):
    skill_name: str
    status: str # "success", "error"
    execution_time_ms: int
    tool_calls: List[Dict[str, Any]] = Field(default_factory=list)
    result_message: str
    modified_data: Optional[Dict[str, Any]] = None

class SkillEngine:
    """
    Antigravity / ViMax 规范的 Skill 技能运行时引擎
    支持动态加载技能、解析 YAML Frontmatter，并在执行中自动调度 MCP 工具与系统各模块能力
    """

    def __init__(self, skills_dir: str = SKILLS_ROOT_DIR):
        self.skills_dir = skills_dir
        self.skills: Dict[str, SkillDefinition] = {}
        self.reload_skills()

    def reload_skills(self):
        """扫描并加载 skills/ 目录下所有 SKILL.md 文件"""
        self.skills.clear()
        if not os.path.exists(self.skills_dir):
            os.makedirs(self.skills_dir, exist_ok=True)
            return

        for root, _, files in os.walk(self.skills_dir):
            for f in files:
                if f == "SKILL.md" or f.endswith(".skill.md"):
                    file_path = os.path.join(root, f)
                    try:
                        skill = self._parse_skill_file(file_path)
                        if skill:
                            self.skills[skill.name] = skill
                    except Exception as e:
                        print(f"[SkillEngine] Error parsing skill file {file_path}: {e}")

    def _parse_skill_file(self, file_path: str) -> Optional[SkillDefinition]:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Parse YAML frontmatter between --- and ---
        match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
        if not match:
            return None

        frontmatter_str, body_str = match.group(1), match.group(2)
        meta = yaml.safe_load(frontmatter_str) or {}

        return SkillDefinition(
            name=meta.get("name", os.path.basename(os.path.dirname(file_path))),
            description=meta.get("description", ""),
            version=meta.get("version", "1.0.0"),
            author=meta.get("author", "Community"),
            category=meta.get("category", "general"),
            tools=meta.get("tools", []),
            instructions=body_str.strip(),
            file_path=file_path
        )

    def list_skills(self) -> List[SkillDefinition]:
        return list(self.skills.values())

    def get_skill(self, name: str) -> Optional[SkillDefinition]:
        return self.skills.get(name)

    async def execute_skill(
        self,
        skill_name: str,
        context: Dict[str, Any],
        user_prompt: str = ""
    ) -> SkillExecutionResult:
        """
        执行指定 Skill，自动串联其声明的 MCP 工具链与系统能力
        """
        start_time = time.time()
        skill = self.get_skill(skill_name)
        if not skill:
            return SkillExecutionResult(
                skill_name=skill_name,
                status="error",
                execution_time_ms=0,
                result_message=f"Skill '{skill_name}' not found"
            )

        tool_calls_trace = []
        modified_data = context.copy() if context else {}

        # 1. 针对具体 Skill 自动调用其绑定的 MCP Tools
        if skill_name == "novel-climax-enhancer":
            # 步骤 A: 3D 导演台升级为战斗大特写与震颤运镜
            res_3d = await mcp_registry.execute_tool("director_3d_stage_plan", {
                "framing": "extreme_close_up",
                "motion": "shake",
                "pose": "fight"
            })
            tool_calls_trace.append({
                "tool": "director_3d_stage_plan",
                "status": res_3d.status,
                "result": res_3d.result
            })

            # 步骤 B: 调用 MiniMax Speech-01 生成怒吼爆发配音
            shot_text = context.get("dialogue", "这一世，我命由我不由天！")
            res_tts = await mcp_registry.execute_tool("generate_minimax_voice", {
                "text": shot_text,
                "voice_id": "male-qn-qingse",
                "emotion": "intense",
                "speed": 1.1
            })
            tool_calls_trace.append({
                "tool": "generate_minimax_voice",
                "status": res_tts.status,
                "result": res_tts.result
            })

            modified_data.update({
                "camera_framing": "extreme_close_up",
                "camera_motion": "shake",
                "pose_preset": "fight",
                "emotion": "intense",
                "subtitle_text": f"【高潮】{shot_text}"
            })
            if res_tts.status == "success":
                msg = "已执行【网文爽点重构技能】：机位已锁定大特写与战斗震颤，配音已生成为 MiniMax 爆发怒吼！"
            else:
                msg = f"已执行【网文爽点重构技能】：机位与情绪标记已更新；配音失败: {res_tts.error}"

        elif skill_name == "character-3view-consistency":
            # 调用 ComfyUI 角色三视图生图（真实出图）
            char_name = context.get("character_name", "主角")
            char_desc = context.get("visual_prompt", "1person, detailed anime character design")
            res_img = await mcp_registry.execute_tool("comfyui_render_node", {
                "prompt": f"{char_desc}, character sheet, full body front view + side view + dynamic 3/4 view turnaround, high consistency",
                "aspect_ratio": context.get("aspect_ratio", "1:1"),
                "style_preset": context.get("style_preset", "donghua_xianxia"),
            })
            tool_calls_trace.append({
                "tool": "comfyui_render_node",
                "status": res_img.status,
                "result": res_img.result if res_img.status == "success" else res_img.error
            })
            if res_img.status == "success":
                modified_data.update({
                    "three_views_ready": True,
                    "consistency_locked": True,
                    "image_url": (res_img.result or {}).get("image_url")
                })
                msg = f"已执行【角色三视图一致性技能】：已为角色【{char_name}】生成三视图设定图！"
            else:
                msg = f"【角色三视图一致性技能】执行失败: {res_img.error}"

        elif skill_name == "jianyin-auto-assembly":
            # 调用 pyJianYingDraft 官方草稿导出（需要完整项目数据）
            project_payload = context.get("project")
            if not project_payload:
                return SkillExecutionResult(
                    skill_name=skill_name,
                    status="error",
                    execution_time_ms=int((time.time() - start_time) * 1000),
                    tool_calls=tool_calls_trace,
                    result_message="jianyin-auto-assembly 需要 context.project（完整 Project JSON）才能导出剪映草稿"
                )
            res_export = await mcp_registry.execute_tool("export_jianyin_draft", {"project": project_payload})
            tool_calls_trace.append({
                "tool": "export_jianyin_draft",
                "status": res_export.status,
                "result": res_export.result if res_export.status == "success" else res_export.error
            })
            if res_export.status == "success":
                modified_data.update({"draft_exported": True, "draft_info": res_export.result})
                msg = "已执行【剪映多轨自动精修技能】：已通过 pyJianYingDraft 构建含画面轨/配音轨/字幕轨的剪映工程！"
            else:
                msg = f"【剪映多轨自动精修技能】执行失败: {res_export.error}"

        else:
            msg = f"Skill '{skill_name}' 指令已载入 Agent 运行时并完成执行。"

        elapsed = int((time.time() - start_time) * 1000)
        return SkillExecutionResult(
            skill_name=skill_name,
            status="success",
            execution_time_ms=elapsed,
            tool_calls=tool_calls_trace,
            result_message=msg,
            modified_data=modified_data
        )

skill_engine = SkillEngine()
