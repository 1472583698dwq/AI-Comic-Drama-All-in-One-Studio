# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas F2 文本节点（type=prompt）技能 — 后端唯一实现。

画布引擎（MCP ``canvas_execute`` / ``canvas_dispatch_skill``、``POST /canvas/execute``、Agent）执行文本节点时走这里，
与前端宿主 ``client/src/components/canvas/host/executeRouter.ts`` 的 ``runTextSkill`` 同口径（progress/N1.md、H1.md）：

技能 id（N1 ``nodes2/text/skills.ts``）：
- ``free_generation`` 自由生成：通用 LLM（= ``POST /llm/generate``，系统提示同前端 FREE_GEN_SYSTEM），带图片参考地址；
- ``prompt_expansion`` 扩写：= ``POST /llm/expand``（kind=image）；
- ``script_generation`` 剧本拆解：= ``POST /projects/parse-script``（script_agent），结果写逐行文本 + ``script_data``；
- ``proposal_generation`` 策划案：通用 LLM + 策划案系统提示（= 前端降级路径）。**不调** MCP ``split_novel_script``：
  它返回的是分场分镜摘要（同剧本拆解，没有策划案正文），且在有项目上下文时会把分镜写进项目内容。
旧值 ``custom_text`` 与未知值按自由生成处理（同前端 normalizeSkillId）。

数据键（N1）：正文 = ``prompt`` 优先、空白回落 ``text``；生成指令 = ``gen_prompt``（含 ``{{ref N}}``）。

技能输入（N1 ``buildSkillRequest``）：own = ``gen_prompt``，**全部**文本参考（含 3D 导演机位）进提示词，
按 inputs R6 组装（``{{ref N}}`` → 参考 N、文本参考「参考 N：」附后、提到的非文本参考附对应关系）；
指令为空时第一条文本参考作主体；指令与文本参考都空时，扩写 / 拆解 / 策划案回落当前正文，自由生成没有输入。

何时执行技能（引擎专有；前端只有用户点「发送」一种入口）：
- ``skill_id`` 显式为四个技能之一 → 执行；
- ``skill_id`` 缺省 / ``custom_text`` / 未知，且 ``gen_prompt`` 非空 → 自由生成（界面缺省技能不落盘）；
- 其余 → 原样透传正文（Agent 建的文本源节点、旧画布的文本节点都没有 ``gen_prompt``，行为同修复前）；
- 技能有效但没有输入（如自由生成无指令也无文本参考）→ 透传正文。
技能失败返回 ``status=error``（前端同样 reject），不再静默透传。
"""
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from app.canvas import inputs as canvas_inputs

FREE_GENERATION = "free_generation"
PROMPT_EXPANSION = "prompt_expansion"
SCRIPT_GENERATION = "script_generation"
PROPOSAL_GENERATION = "proposal_generation"
TEXT_SKILLS: Tuple[str, ...] = (FREE_GENERATION, PROMPT_EXPANSION, SCRIPT_GENERATION, PROPOSAL_GENERATION)
SKILL_LABELS = {
    FREE_GENERATION: "自由生成", PROMPT_EXPANSION: "扩写", SCRIPT_GENERATION: "剧本拆解", PROPOSAL_GENERATION: "策划案",
}
# 指令与文本参考都空时能否改用当前正文（同前端 TextSkill.documentFallback）
DOCUMENT_FALLBACK = frozenset({PROMPT_EXPANSION, SCRIPT_GENERATION, PROPOSAL_GENERATION})

# 与前端 executeRouter 的 FREE_GEN_SYSTEM / PROPOSAL_SYSTEM 逐字一致
FREE_GEN_SYSTEM = "你是漫剧创作助手。按用户要求生成内容，使用 Markdown 排版；只输出正文，不要多余的解释。"
PROPOSAL_SYSTEM = ("你是一位金牌影视与漫剧总策划。根据用户输入的主题或题材，生成一份高吸引力的策划案，"
                   "包括世界观、主角人设、核心矛盾与前三集爆点大纲。使用 Markdown 输出。")

EXPAND_KIND_HINT = {
    "image": "生图提示词（主体、构图、景别、光线、材质风格、画质词，英文逗号短语）",
    "video": "视频运动提示词（主体动作、运镜轨迹、节奏、光影变化，中文一句到三句）",
    "dialogue": "角色台词与情绪标注（中文，带情绪标签）",
}

# collect_upstream_data 给文本节点预先组装的技能输入（upstream 私有键，只在引擎内部流转）
SKILL_INPUT_KEY = "_text_skill_input"


class EmptyResultError(RuntimeError):
    """LLM 返回空文本。"""


# ---------- LLM 调用（与 HTTP 接口共用，接口只做参数校验与错误码映射） ----------

# 扩写结果上限（字符），流式与非流式同口径
EXPAND_MAX_CHARS = 1200
# 流式接口支持的技能（剧本拆解是结构化 JSON 流程，不走流式，COORDINATION 第 14 条）
STREAM_SKILLS: Tuple[str, ...] = (FREE_GENERATION, PROMPT_EXPANSION, PROPOSAL_GENERATION)


def generate_request(prompt: str, system: Optional[str] = None, images: Optional[List[str]] = None,
                     temperature: float = 0.7, max_tokens: int = 2000) -> Dict[str, Any]:
    """通用文本生成的 LLM 请求（messages / temperature / max_tokens）；流式与非流式共用。空 prompt → ValueError。"""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")
    system = (system or "").strip() or FREE_GEN_SYSTEM
    user = prompt[:12000]
    imgs = [u for u in (images or []) if isinstance(u, str) and u.strip()][:8]
    if imgs:
        # 当前 LLM 通道为纯文本，只把参考图地址列进提示词
        user += "\n\n（参考图地址：" + "；".join(imgs) + "）"
    return {
        "messages": [{"role": "system", "content": system[:4000]}, {"role": "user", "content": user}],
        "temperature": max(0.0, min(float(temperature), 1.5)),
        "max_tokens": max(64, min(int(max_tokens), 8000)),
    }


def expand_request(prompt: str, kind: str = "image") -> Dict[str, Any]:
    """扩写的 LLM 请求（与 ``POST /llm/expand`` 同一系统提示）；流式与非流式共用。空 prompt → ValueError。"""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")
    kind_hint = EXPAND_KIND_HINT.get(kind, "生图提示词")
    return {
        "messages": [
            {"role": "system", "content": f"你是漫剧影视级提示词扩写引擎。把用户的简短画面构思扩写为专业{kind_hint}。只输出提示词本身，不要解释、不要引号、不要 markdown。"},
            {"role": "user", "content": prompt[:2000]},
        ],
        "temperature": 0.7,
        "max_tokens": 600,
    }


async def generate_text(prompt: str, system: Optional[str] = None, images: Optional[List[str]] = None,
                        temperature: float = 0.7, max_tokens: int = 2000) -> str:
    """通用文本生成（``POST /llm/generate`` 的实现）。

    空 prompt → ValueError；LLM 失败 → LLMServiceError；返回空 → EmptyResultError。
    """
    from app.pipelines.llm_service import llm_service
    text = await llm_service.chat_completion(**generate_request(prompt, system, images, temperature, max_tokens))
    text = (text or "").strip()
    if not text:
        raise EmptyResultError("LLM 返回为空")
    return text


async def expand_prompt(prompt: str, kind: str = "image") -> str:
    """电影级提示词扩写（``POST /llm/expand`` 的实现）；返回可能为空串，由调用方决定如何处理。"""
    from app.pipelines.llm_service import llm_service
    text = await llm_service.chat_completion(**expand_request(prompt, kind))
    return (text or "").strip()[:EXPAND_MAX_CHARS]


def stream_request(skill: Optional[str], prompt: str, system: Optional[str] = None,
                   images: Optional[List[str]] = None) -> Dict[str, Any]:
    """流式文本接口（``POST /llm/generate/stream``，COORDINATION 第 14 条）的 LLM 请求。

    系统提示按技能取与非流式完全相同的那份：free_generation=FREE_GEN_SYSTEM、proposal_generation=PROPOSAL_SYSTEM、
    prompt_expansion=与 ``/llm/expand`` 相同的扩写提示（kind=image）；``system`` 只在调用方显式传入时覆盖。
    未知技能 → ValueError；空 prompt → ValueError。
    """
    skill = (skill or "").strip() or FREE_GENERATION
    if skill not in STREAM_SKILLS:
        raise ValueError(f"不支持的流式技能: {skill}（可选 {' / '.join(STREAM_SKILLS)}）")
    override = (system or "").strip()
    if skill == PROMPT_EXPANSION:
        req = expand_request(prompt, "image")
        if override:
            req["messages"][0] = {"role": "system", "content": override[:4000]}
        return req
    default_system = PROPOSAL_SYSTEM if skill == PROPOSAL_GENERATION else FREE_GEN_SYSTEM
    return generate_request(prompt, system=override or default_system, images=images)


async def stream_text(skill: Optional[str], prompt: str, system: Optional[str] = None,
                      images: Optional[List[str]] = None) -> AsyncIterator[str]:
    """流式执行文本技能，逐段 yield 增量（上游不支持流式时整段 yield 一次）。

    扩写同非流式按 :data:`EXPAND_MAX_CHARS` 截断（超出部分不再下发）。参数错误 → ValueError（在第一次迭代前抛出）。
    """
    from app.pipelines.llm_service import llm_service
    req = stream_request(skill, prompt, system, images)
    cap = EXPAND_MAX_CHARS if (skill or "").strip() == PROMPT_EXPANSION else None
    sent = 0
    async for delta in llm_service.chat_completion_stream(**req):
        if not delta:
            continue
        if cap is not None:
            if sent >= cap:
                break
            delta = delta[:cap - sent]
        sent += len(delta)
        yield delta


def format_script(project: Optional[Dict[str, Any]]) -> str:
    """剧本拆解结果 → 逐行文本（与前端 executeRouter.formatScript 同格式）。"""
    scenes = (project or {}).get("scenes") if isinstance(project, dict) else None
    blocks = []
    for s in scenes if isinstance(scenes, list) else []:
        shots = s.get("shots") if isinstance(s.get("shots"), list) else []
        body = "\n\n".join(
            f"镜头 {sh.get('shot_index')}: [{sh.get('camera_framing')}] {sh.get('action_desc')}\n台词: {sh.get('dialogue') or '（无对白）'}"
            for sh in shots
        )
        blocks.append(f"【场景 {s.get('scene_index')}】\n" + body)
    return "\n\n".join(blocks)


# ---------- 技能选择与输入组装 ----------

def effective_skill(skill_id: Any, instruction: Any) -> Optional[str]:
    """本次执行的技能；None = 不执行技能、原样透传正文（规则见模块文档）。"""
    s = skill_id.strip() if isinstance(skill_id, str) else ""
    if s in TEXT_SKILLS:
        return s
    if isinstance(instruction, str) and instruction.strip():
        return FREE_GENERATION
    return None


def document_of(data: Dict[str, Any]) -> str:
    """正文：``prompt`` 优先、空白回落 ``text``（同前端 documentOf / 下游读取口径）。"""
    for k in ("prompt", "text"):
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return ""


def skill_refs_input(node: Dict[str, Any], resolved: Dict[str, Any]) -> Dict[str, Any]:
    """由 ``inputs.collect_inputs`` 的解析结果组装文本节点的技能输入（own = gen_prompt）。

    与前端 buildSkillRequest 一致：文本节点里所有文本参考（含 3D 导演机位）都进提示词，不分进 camera_prompt。
    """
    instruction = canvas_inputs.node_data(node).get("gen_prompt")
    instruction = instruction if isinstance(instruction, str) else ""
    refs = resolved.get("refs") or []
    slots = resolved.get("slots") or {}
    texts = [(r["n"], r["values"][0]) for r in refs if r.get("kind") == canvas_inputs.STRING and r.get("values")]
    mapping = canvas_inputs.ref_mapping(instruction, refs, slots)
    return {
        "prompt": canvas_inputs.assemble_prompt(instruction, texts, mapping),
        "reference_images": list(slots.get("reference_images") or []),
        "reference_videos": list(slots.get("reference_video") or []),
    }


def skill_input(skill: str, data: Dict[str, Any], upstream: Dict[str, Any]) -> Tuple[str, str, List[str]]:
    """→ (本次要处理的文本, 来源 instruction|refs|document, 图片参考)。

    DAG 执行时用 collect_upstream_data 预先组装的 :data:`SKILL_INPUT_KEY`；单节点执行（/canvas/node/execute，
    没有连线）时把调用方给的 upstream 文本当作第 1 条文本参考。
    """
    instruction = data.get("gen_prompt") if isinstance(data.get("gen_prompt"), str) else ""
    pre = upstream.get(SKILL_INPUT_KEY)
    if isinstance(pre, dict):
        text = pre.get("prompt") or ""
        images = [u for u in (pre.get("reference_images") or []) if isinstance(u, str) and u.strip()]
    else:
        up_text = canvas_inputs._first_str([upstream], ("prompt", "text")) or ""
        text = canvas_inputs.assemble_prompt(instruction, [(1, up_text)] if up_text else [])
        images = canvas_inputs._str_list(upstream.get("reference_images"))
    text = text if isinstance(text, str) else ""
    source = "instruction" if instruction.strip() else "refs"
    if not text.strip() and skill in DOCUMENT_FALLBACK:
        doc = document_of(data)
        if doc.strip():
            text, source = doc, "document"
    return text, source, images


# ---------- 执行 ----------

async def run_text_skill(skill: str, text: str, *, images: Optional[List[str]] = None,
                         style_preset: Optional[str] = None, aspect_ratio: Optional[str] = None) -> Dict[str, Any]:
    """执行一个文本技能 → ``{prompt, text[, script_data]}``（prompt 与 text 同值，N1）。失败抛异常。"""
    if skill == SCRIPT_GENERATION:
        from app.pipelines.script_agent import script_agent
        proj = await script_agent.parse_novel_to_project(text, style_preset or "donghua_xianxia", aspect_ratio or "9:16")
        dumped = proj.model_dump() if hasattr(proj, "model_dump") else dict(proj)
        out = format_script(dumped) or text
        return {"prompt": out, "text": out, "script_data": dumped}
    if skill == PROMPT_EXPANSION:
        out = await expand_prompt(text, "image")
        if not out:
            raise EmptyResultError("扩写返回为空")
    elif skill == PROPOSAL_GENERATION:
        out = await generate_text(text, system=PROPOSAL_SYSTEM)
    else:
        out = await generate_text(text, system=FREE_GEN_SYSTEM, images=images)
    return {"prompt": out, "text": out}
