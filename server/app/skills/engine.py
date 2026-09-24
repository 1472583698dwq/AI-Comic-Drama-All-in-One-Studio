import os
import re
import yaml
import time
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from app.mcp.server import mcp_registry

SKILLS_ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../skills"))
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))


def _project_skill_dirs() -> List[str]:
    """项目内技能目录（打包态随包走，开发态仓库根）。"""
    return [
        SKILLS_ROOT_DIR,
        os.path.join(_REPO_ROOT, "skills"),
        os.path.join(_REPO_ROOT, ".agent", "skills"),
    ]


def _extra_skill_dirs() -> List[str]:
    """项目外技能目录：必须用 STUDIO_SKILL_EXTRA_DIRS 显式声明（逗号或分号分隔）。

    以前这里硬编码扫 ~/.gemini/antigravity/skills，把别的装在本机上的产品的 SKILL.md
    当成本项目技能列出并喂进模型 system prompt —— 技能是提示词注入面，默认不该越出项目边界。
    """
    raw = os.getenv("STUDIO_SKILL_EXTRA_DIRS", "")
    out: List[str] = []
    for part in re.split(r"[,;]", raw):
        p = (part or "").strip()
        if not p:
            continue
        p = os.path.abspath(os.path.expanduser(p))
        if os.path.isdir(p):
            out.append(p)
    return out

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
    external: bool = False  # 来自 STUDIO_SKILL_EXTRA_DIRS（项目外），界面与审计要看得见

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
        self.load_errors: List[str] = []
        self.reload_skills()

    def search_dirs(self) -> List[str]:
        """当前生效的扫描根（供界面/审计展示来源，便于用户看清技能从哪来）。"""
        return self._project_dirs() + _extra_skill_dirs()

    def _project_dirs(self) -> List[str]:
        dirs = list(_project_skill_dirs())
        if self.skills_dir and self.skills_dir not in dirs:
            dirs.insert(0, self.skills_dir)
        return dirs

    def reload_skills(self):
        """扫描并加载所有有效路径下的真实 SKILL.md 规范文件。

        同名技能先到先得：项目目录排在前，项目外目录不得顶掉项目自带技能。
        """
        self.skills.clear()
        self.load_errors = []

        search_dirs = self.search_dirs()

        visited_paths = set()
        for s_dir in search_dirs:
            if not s_dir or not os.path.exists(s_dir):
                continue
            external = not any(os.path.normpath(s_dir).startswith(os.path.normpath(p))
                               for p in _project_skill_dirs())
            for root, _, files in os.walk(s_dir):
                for f in files:
                    if f == "SKILL.md" or f.endswith(".skill.md"):
                        file_path = os.path.normpath(os.path.join(root, f))
                        if file_path in visited_paths:
                            continue
                        visited_paths.add(file_path)
                        try:
                            skill = self._parse_skill_file(file_path)
                            if skill is None:
                                continue
                            skill.external = external
                            dup = self.skills.get(skill.name)
                            if dup:
                                self.load_errors.append(
                                    f"技能重名被忽略: {skill.name} @ {file_path}（已加载 {dup.file_path}）")
                                continue
                            self.skills[skill.name] = skill
                        except Exception as e:
                            err = f"技能解析失败 {file_path}: {e}"
                            print(f"[SkillEngine] {err}")
                            self.load_errors.append(err)

    def _parse_skill_file(self, file_path: str) -> Optional[SkillDefinition]:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Parse YAML frontmatter between --- and ---
        match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
        if not match:
            return None

        frontmatter_str, body_str = match.group(1), match.group(2)
        meta = yaml.safe_load(frontmatter_str) or {}
        if not isinstance(meta, dict):
            return None
        raw_active = meta.get("enabled", meta.get("is_active", True))
        if isinstance(raw_active, str):
            raw_active = raw_active.strip().lower() not in ("0", "false", "no", "off")

        return SkillDefinition(
            name=str(meta.get("name") or os.path.basename(os.path.dirname(file_path))),
            description=str(meta.get("description") or ""),
            version=str(meta.get("version", "1.0.0")),
            author=str(meta.get("author", "System")),
            category=str(meta.get("category", "general")),
            tools=[str(t) for t in (meta.get("tools") or []) if t],
            instructions=body_str.strip(),
            is_active=bool(raw_active),
            file_path=file_path
        )

    # ── 可用性判定（list / read / execute 共用同一口径） ─────────
    def is_usable(self, name: str) -> tuple:
        """返回 (可用?, 原因)。frontmatter 关掉与扩展中心停用都算不可用。"""
        skill = self.skills.get(name)
        if skill is None:
            return False, f"未找到系统技能 '{name}'，请确认该技能已存在于系统技能目录中"
        if not skill.is_active:
            return False, f"技能 {name} 已在 SKILL.md 里关闭（enabled: false）"
        try:
            from app.extensions import guard
            if not guard.is_enabled("skill", name):
                return False, f"技能已被停用：{name}（可在设置中心·扩展中心启用）"
        except Exception:
            pass  # 停用一个查不到的开关时按可用处理，别让扩展中心故障打死技能链路
        return True, ""

    def active_skills(self) -> List[SkillDefinition]:
        return [s for s in self.skills.values() if self.is_usable(s.name)[0]]

    def list_skills(self) -> List[SkillDefinition]:
        return list(self.skills.values())

    def get_skill(self, name: str) -> Optional[SkillDefinition]:
        return self.skills.get(name)

    def skill_brief(self, limit: int = 40, max_chars: int = 3000) -> str:
        """技能索引（名称+一句话描述），常驻系统提示；正文 SOP 仍按需用 read_skill 取。

        不含正文，所以 14+ 个技能的索引也只有 KB 级，但必须硬截断防失控。
        """
        lines: List[str] = []
        try:
            for s in sorted(self.active_skills(), key=lambda x: (x.category, x.name)):
                desc = re.sub(r"\s+", " ", s.description or "").strip()[:90]
                lines.append(f"- {s.name}（{s.category}）{desc}")
                if len(lines) >= limit:
                    break
        except Exception as e:
            print(f"[SkillEngine] skill_brief failed: {e}")
            return ""
        return "\n".join(lines)[:max_chars]

    async def execute_skill(
        self,
        skill_name: str,
        context: Dict[str, Any],
        user_prompt: str = ""
    ) -> SkillExecutionResult:
        """
        执行指定真实系统 Skill，自动调度其声明的 MCP 工具链与 SKILL.md 实际专业指引
        """
        start_time = time.time()
        skill = self.get_skill(skill_name)
        usable, why = self.is_usable(skill_name)
        if not usable:
            return SkillExecutionResult(
                skill_name=skill_name,
                status="error",
                execution_time_ms=0,
                result_message=why,
            )

        tool_calls_trace = []
        modified_data = context.copy() if context else {}

        # 1. 特定工具链编排技能
        if skill_name == "novel-climax-enhancer":
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
            msg = "已执行【网文爽点重构技能】：机位已锁定大特写与战斗震颤，配音已生成为 MiniMax 爆发怒吼！" if res_tts.status == "success" else f"已执行【网文爽点重构技能】：机位与情绪标记已更新；配音失败: {res_tts.error}"

        elif skill_name == "character-3view-consistency":
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
                info = res_export.result or {}
                skipped = info.get("skipped_shots") or []
                msg = (
                    "已生成剪映草稿：" + " / ".join(info.get("tracks") or [])
                    + f"，全片实长 {info.get('duration_seconds')}s"
                    + f"（{info.get('placed_shots')}/{info.get('total_shots')} 个镜头入轨）"
                    + (f"，{len(skipped)} 个镜头因无可用素材被跳过" if skipped else "")
                )
            else:
                msg = f"【剪映多轨自动精修技能】执行失败: {res_export.error}"

        else:
            # 2. 系统通用与提示词技能：严格根据实际 SKILL.md instructions 与用户具体要求执行
            original = (context.get("original_prompt") or context.get("prompt") or context.get("text") or "").strip()
            if not original and user_prompt:
                original = user_prompt.strip()

            user_req = (
                context.get("user_instruction")
                or context.get("user_requirement")
                or context.get("requirement")
                or (user_prompt if user_prompt != original else "")
                or ""
            ).strip()

            context_type = context.get("context_type", "prompt")
            is_dialogue = context_type == "dialogue" or skill_name == "dialogue-emotion-polish"

            try:
                from app.pipelines.llm_service import llm_service
                import asyncio as _asyncio
                from app.pipelines.llm_service import strip_think_tags

                # 直接载入该系统技能的真实 SKILL.md 指引
                system_prompt = (
                    f"你是执行系统技能【{skill.name}】的专业 AI 引擎。\n"
                    f"【系统技能定义 (SKILL.md)】\n"
                    f"技能描述: {skill.description}\n"
                    f"技能专业规范与执行指导:\n{skill.instructions if skill.instructions else '根据技能目标进行高水准的深度重构与专业优化。'}\n\n"
                    f"【核心原则】：\n"
                    f"1. 必须完全贯彻用户的具体定制要求（如增减元素、改变天气/光影/动作/服装/镜头/情绪等）。\n"
                    f"2. 严格遵循本系统技能的专业规范与质量标准。\n"
                    f"{'3. 请以 JSON 格式输出: {\"polished_text\": \"...\", \"suggested_emotion\": \"neutral|intense|sorrow|excited|whispering\"}' if is_dialogue else '3. 直接输出最终生成的专业提示词/文本，不要包含多余寒暄或解释。'}"
                )

                user_msg = (
                    f"【输入文本/原始描述】\n{original if original else '（用户未提供原描述，请根据定制要求直接创建）'}\n\n"
                    f"【用户的具体定制要求】\n{user_req if user_req else '（无特殊附加要求，请严格按照该技能规范进行全要素专业级精修）'}\n\n"
                    f"请输出优化结果："
                )

                polished_raw = await _asyncio.wait_for(
                    llm_service.chat_completion(
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_msg}
                        ],
                        temperature=0.7,
                    ),
                    timeout=1200.0,
                )

                cleaned = strip_think_tags(polished_raw).strip()
                if cleaned.startswith("```json"):
                    cleaned = cleaned[7:].strip()
                elif cleaned.startswith("```"):
                    cleaned = cleaned[3:].strip()
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3].strip()

                if is_dialogue:
                    import json as _js
                    import re as _re
                    suggested_emotion = "neutral"
                    final_text = original
                    try:
                        m = _re.search(r"\{[\s\S]*\"polished_text\"[\s\S]*\}", cleaned)
                        if m:
                            parsed = _js.loads(m.group(0))
                            final_text = parsed.get("polished_text") or cleaned
                            suggested_emotion = parsed.get("suggested_emotion") or "neutral"
                        else:
                            final_text = cleaned.strip('"').strip("'")
                    except Exception:
                        final_text = cleaned.strip('"').strip("'")

                    modified_data.update({
                        "polished_prompt": final_text,
                        "polished_text": final_text,
                        "suggested_emotion": suggested_emotion,
                        "original_prompt": original,
                        "user_instruction": user_req
                    })
                    msg = f"已根据您的要求通过系统技能【{skill.name}】润色完成（推荐情绪：{suggested_emotion}）"
                else:
                    final_text = cleaned.strip('"').strip("'").strip()
                    for prefix in ["润色结果：", "润色后：", "优化后：", "Prompt:", "提示词：", "输出："]:
                        if final_text.startswith(prefix):
                            final_text = final_text[len(prefix):].strip()

                    modified_data.update({
                        "polished_prompt": final_text,
                        "polished_text": final_text,
                        "original_prompt": original,
                        "user_instruction": user_req
                    })
                    msg = f"已根据您的要求通过系统技能【{skill.name}】完成优化！"

                tool_calls_trace.append({
                    "tool": "system_skill_engine",
                    "status": "success",
                    "result": {"skill": skill.name, "user_requirement": user_req, "output": final_text}
                })

            except Exception as e:
                fallback = f"{original} ({user_req})" if user_req else original
                modified_data.update({
                    "polished_prompt": fallback,
                    "polished_text": fallback,
                    "original_prompt": original,
                    "user_instruction": user_req
                })
                tool_calls_trace.append({"tool": "system_skill_engine", "status": "fallback", "result": str(e)})
                msg = f"系统技能执行异常（回退模式: {str(e)[:60]}）"

        elapsed = int((time.time() - start_time) * 1000)
        # 状态由真实工具调用结果决定：以前这里恒定 success，出图/配音失败也报成功，前端只能去猜文案。
        statuses = [str((t or {}).get("status")) for t in tool_calls_trace]
        final_status = "success" if statuses and all(s == "success" for s in statuses) else "error"
        return SkillExecutionResult(
            skill_name=skill_name,
            status=final_status,
            execution_time_ms=elapsed,
            tool_calls=tool_calls_trace,
            result_message=msg,
            modified_data=modified_data
        )

skill_engine = SkillEngine()

