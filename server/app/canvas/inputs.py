# -*- coding: utf-8 -*-
"""REQ-toonflow-canvas 生成节点输入解析：单一输入口 ``in`` + 有序参考列表 → 生成源输入槽。

新画布（schema_version 2）里，生成类节点（prompt/image/video/audio/director3d）只有一个输入口
``in``；上游素材排成**有序参考列表**，提示词里 ``{{ref N}}`` 指列表第 N 项（从 1 开始）。
旧画布用具名输入口（prompt/reference/reference_images/first_frame/last_frame/camera_prompt/
ref_audio/text/reference_audio…）。本模块是后端唯一的组装规则，**新旧两种连法得到同一份槽位**，
对应前端 ``client/src/components/canvas/kit/assembleInputs.ts``（design §4）。

节点数据字段（只追加，不改旧键）：
- ``data.refOrder: [edgeKey]``：用户拖拽后的顺序；``edgeKey = f"{source}|{sourceHandle or ''}"``。
- ``data.refRoles: {edgeKey: slot}``：显式槽位，slot ∈ :data:`SLOTS`。
- ``data.mode``：视频参考模式 text | singleImage | startEnd | multiReference（空 = 自动）。

规则（改动须前后端同步）：
R1 参考边：指向本节点、来源节点存在且不是 provider*/group 的边，且 ``targetHandle == 'in'``；
   或目标是 in 口节点类型且 targetHandle 为空/旧具名口（未迁移的旧画布）。同一 edgeKey 只算第一条。
R2 顺序：``refOrder`` 里出现的按其下标，其余排在后面并保持连线数组顺序；N = 排序后 1 起的序号
   （暂无值的参考也占号）。
R3 类型：sourceHandle（image/video/audio/prompt/text/camera_prompt…）→ 来源节点类型 →
   产物键推断（video_url→VIDEO、audio_url→AUDIO、image_url→IMAGE、prompt/text→STRING）。
   取值：先读与 sourceHandle 同名的键（媒体须像 URL），再按类型的默认键；执行期上游产物优先于节点数据。
R4 显式槽位：旧具名口按 :data:`LEGACY_HANDLE_SLOTS`（以连线上的口名为准）；in 口/空口读
   ``refRoles[edgeKey]``。槽位与参考类型不符 / 不认识 → 视为未指定。
R5 分配：
   - STRING：显式 prompt/camera_prompt；未指定时来自 director3d（或 sourceHandle=camera_prompt）→ camera_prompt，
     其余 → prompt。
   - AUDIO → ref_audio；VIDEO → reference_video（列表，保序去重）。
   - IMAGE 显式：first_frame/last_frame 先到先得（多余的忽略），reference_images 追加。
   - IMAGE 未指定（按顺序）：
     · 目标是 video：模式 = 归一后的 ``data.mode``（旧值 i2v→singleImage〔同时有首尾帧时记 startEnd〕、
       r2v→multiReference、t2v→text）；为空时按**全部图片参考数**自动：0 → text（有音/视频参考时
       记 multiReference）、1 → singleImage、≥2 → multiReference。
       text：不发送；singleImage：第一张 → 首帧（已占则参考图），其余 → 参考图；
       startEnd：依次填首帧、尾帧（已占跳过），其余 → 参考图；multiReference：全部 → 参考图。
     · 其他目标（image/audio/prompt/director3d）：全部 → reference_images。
R6 提示词：own = 节点自身文本（audio 取 text 优先，其余 prompt 优先，trim）；
   texts = prompt 槽的文本参考 (N, text)，去掉空串和与 own 完全相同的（旧画布连线时拷贝进节点的副本）。
   主体 = own 中 ``{{ref N}}`` 换成 ``参考 N``；own 为空时主体 = 第一条文本参考原文（不加前缀，其余照常）。
   段落 = [主体] + ["参考 N：\n" + text …] + [对应关系]，空段丢弃，用 "\n\n" 连接。
   对应关系：own 里 ``{{ref N}}`` 提到的非文本参考，按落位写 ``（参考编号对应：参考 2=首帧图，参考 3=第 1 张参考图）``
   （首帧图 / 尾帧图 / 第 k 张参考图 / 参考音频 / 参考视频；k = 在最终 reference_images 里的位置）。
   camera_prompt 槽多条用 "\n" 连接。
R7 生成源模式（引擎）：data.mode 为新模式时 text→t2v、singleImage/startEnd→i2v、multiReference→r2v；
   旧值 i2v/r2v/t2v 原样；为空时有首帧 i2v、只有参考图/参考视频 r2v、都没有 t2v。
"""
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

IN_PORT = "in"

STRING, IMAGE, VIDEO, AUDIO = "STRING", "IMAGE", "VIDEO", "AUDIO"

SLOTS: Tuple[str, ...] = (
    "prompt", "camera_prompt", "first_frame", "last_frame", "reference_images", "ref_audio", "reference_video",
)
SLOT_KIND: Dict[str, str] = {
    "prompt": STRING,
    "camera_prompt": STRING,
    "first_frame": IMAGE,
    "last_frame": IMAGE,
    "reference_images": IMAGE,
    "ref_audio": AUDIO,
    "reference_video": VIDEO,
}
LIST_SLOTS = ("reference_images", "ref_audio", "reference_video")

# 新画布里只有一个 in 输入口的节点类型（design §6.1）
IN_PORT_NODE_TYPES = frozenset({"prompt", "image", "video", "audio", "director3d"})
GROUP_TYPE = "group"
PROVIDER_NODE_TYPES = frozenset({"provider", "provider-image", "provider-video", "provider-audio", "provider-llm"})

# 旧具名输入口 → 槽位（迁移与 canvas_connect 共用）
LEGACY_HANDLE_SLOTS: Dict[str, str] = {
    "prompt": "prompt", "text": "prompt", "brief": "prompt", "image_prompt": "prompt", "video_prompt": "prompt",
    "camera_prompt": "camera_prompt",
    "first_frame": "first_frame", "first_frame_url": "first_frame",
    "last_frame": "last_frame", "last_frame_url": "last_frame",
    "reference": "reference_images", "reference_images": "reference_images", "reference_image": "reference_images",
    "ref": "reference_images", "images": "reference_images", "image_list": "reference_images",
    "ref_audio": "ref_audio", "ref_audio_path": "ref_audio", "reference_audio": "ref_audio",
    "reference_audios": "ref_audio", "audios": "ref_audio",
    "reference_video": "reference_video", "reference_videos": "reference_video", "videos": "reference_video",
}

VIDEO_MODES = ("text", "singleImage", "startEnd", "multiReference")
_VIDEO_MODE_ALIASES = {
    "text": "text",
    "singleimage": "singleImage", "single_image": "singleImage", "single": "singleImage",
    "startend": "startEnd", "start_end": "startEnd", "startendrequired": "startEnd",
    "endframeoptional": "startEnd", "first_last": "startEnd", "first_last_frame": "startEnd",
    "multireference": "multiReference", "multi_reference": "multiReference", "reference": "multiReference",
    # 旧生成源模式（迁移后的旧视频节点，见 progress/COORDINATION.md 第 3 条）
    "r2v": "multiReference", "t2v": "text", "i2v": "singleImage",
}
PROVIDER_MODE_BY_VIDEO_MODE = {"text": "t2v", "singleImage": "i2v", "startEnd": "i2v", "multiReference": "r2v"}

_SOURCE_HANDLE_KIND = {
    "image": IMAGE, "images": IMAGE, "image_url": IMAGE, "result_url": IMAGE,
    "video": VIDEO, "videos": VIDEO, "video_url": VIDEO,
    "audio": AUDIO, "audios": AUDIO, "audio_url": AUDIO,
    "prompt": STRING, "text": STRING, "camera_prompt": STRING, "brief": STRING,
    "shot": STRING, "shots": STRING, "characters": STRING,
}
_SOURCE_TYPE_KIND = {
    "prompt": STRING, "text-prompt": STRING, "brief": STRING, "script-split": STRING, "director3d": STRING,
    "image": IMAGE, "generate-image": IMAGE, "load-image": IMAGE, "load-image-batch": IMAGE,
    "shot-card": IMAGE, "comfy-workflow": IMAGE,
    "video": VIDEO, "video-node": VIDEO, "video-legacy": VIDEO, "load-video": VIDEO,
    "audio": AUDIO, "tts": AUDIO, "voice": AUDIO, "load-audio": AUDIO,
}
REF_TOKEN_RE = re.compile(r"\{\{ref (\d+)\}\}")

# 节点类型 → 主输出口 id（与前端迁移 PRIMARY_OUTPUT_PORT 一致；canvas_connect 省略 sourceHandle 时补上）
PRIMARY_OUTPUT_PORT = {
    "prompt": "prompt", "image": "image", "video": "video", "audio": "audio", "director3d": "camera_prompt",
    "load-image": "image", "load-video": "video", "load-audio": "audio",
}

_TEXT_KEYS = ("prompt", "text", "brief", "image_prompt", "video_prompt")
_CAMERA_KEYS = ("camera_prompt", "minimax_camera_prompt")
_IMAGE_KEYS = ("image_url", "result_url", "file_url", "thumb_url")
_VIDEO_KEYS = ("video_url", "file_url")
_AUDIO_KEYS = ("audio_url", "file_url")


# ---------- 基础工具 ----------

def edge_key(edge: Dict[str, Any]) -> str:
    """参考项键：``source|sourceHandle``（sourceHandle 为空记空串），与前端一致。"""
    return f"{edge.get('source') or ''}|{edge.get('sourceHandle') or edge.get('source_handle') or ''}"


def target_handle(edge: Dict[str, Any]) -> str:
    return str(edge.get("targetHandle") or edge.get("target_handle") or "").strip()


def normalize_slot(slot: Any) -> Optional[str]:
    """槽位名归一：合法槽位原样返回，旧端口名/复数别名映射到槽位，其余返回 None。"""
    if not isinstance(slot, str):
        return None
    s = slot.strip()
    if s in SLOT_KIND:
        return s
    return LEGACY_HANDLE_SLOTS.get(s)


def normalize_video_mode(mode: Any) -> str:
    """视频参考模式归一（含旧值 i2v→singleImage、r2v→multiReference、t2v→text）；空/未知 → ''（自动）。"""
    if not isinstance(mode, str):
        return ""
    return _VIDEO_MODE_ALIASES.get(mode.strip().lower(), "")


def node_data(node: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    d = (node or {}).get("data")
    return d if isinstance(d, dict) else {}


def ref_order_of(data: Dict[str, Any]) -> List[str]:
    raw = data.get("refOrder", data.get("ref_order"))
    if isinstance(raw, dict):  # 兼容 Toonflow 的 {handleId: [...]}
        raw = raw.get(IN_PORT)
    return [k for k in raw if isinstance(k, str)] if isinstance(raw, list) else []


def ref_roles_of(data: Dict[str, Any]) -> Dict[str, str]:
    raw = data.get("refRoles", data.get("ref_roles"))
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(raw, dict) else {}


def is_ref_edge(edge: Dict[str, Any], target_type: Optional[str], source_type: Optional[str] = None) -> bool:
    """这条边是否按「参考列表」规则解析（规则 1）。provider* 与 group 来源不算参考。"""
    if target_type == GROUP_TYPE or source_type == GROUP_TYPE:
        return False
    if source_type in PROVIDER_NODE_TYPES:
        return False
    th = target_handle(edge)
    if th == IN_PORT:
        return True
    return target_type in IN_PORT_NODE_TYPES and (th == "" or th in LEGACY_HANDLE_SLOTS)


def _first_str(sources: Iterable[Optional[Dict[str, Any]]], keys: Iterable[str]) -> Optional[str]:
    keys = tuple(keys)
    for src in sources:
        if not isinstance(src, dict):
            continue
        for k in keys:
            v = src.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


def _str_list(v: Any) -> List[str]:
    if isinstance(v, str):
        return [v.strip()] if v.strip() else []
    if isinstance(v, list):
        return [x.strip() for x in v if isinstance(x, str) and x.strip()]
    return []


def _is_camera_source(source_type: str, source_handle: str) -> bool:
    if source_handle == "camera_prompt":
        return True
    return source_type == "director3d" and source_handle in ("", "camera_prompt", "prompt", "text")


def source_kind(source_node: Optional[Dict[str, Any]], source_handle: str = "",
                result: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """参考类型（规则 3）：sourceHandle → 来源节点类型 → 产物键推断。"""
    sh = (source_handle or "").strip()
    if sh in _SOURCE_HANDLE_KIND:
        return _SOURCE_HANDLE_KIND[sh]
    st = (source_node or {}).get("type") or ""
    if st in _SOURCE_TYPE_KIND:
        return _SOURCE_TYPE_KIND[st]
    data = node_data(source_node)
    for src in (result, data):
        if not isinstance(src, dict):
            continue
        if _first_str([src], ("video_url",)):
            return VIDEO
        if _first_str([src], ("audio_url",)):
            return AUDIO
        if _first_str([src], ("image_url", "result_url")):
            return IMAGE
        if _first_str([src], _TEXT_KEYS):
            return STRING
    return None


def _looks_like_url(v: str) -> bool:
    return v.startswith(("http:", "https:", "data:", "blob:", "/"))


def source_values(kind: Optional[str], source_node: Optional[Dict[str, Any]], source_handle: str = "",
                  result: Optional[Dict[str, Any]] = None) -> List[str]:
    """按类型取参考值：STRING 返回 [文本]，媒体返回 URL 列表（批量图节点可多张）。

    执行期产物（result）整体优先于节点数据；同一来源内先读与输出口同名的键（如 director3d.camera_prompt，
    媒体只认像 URL 的值，免得把枚举值当成图），再读类型默认键。
    """
    data = node_data(source_node)
    st = (source_node or {}).get("type") or ""
    sh = (source_handle or "").strip()
    if kind == IMAGE and (st == "load-image-batch" or (isinstance(result, dict) and isinstance(result.get("images"), list))):
        for src in (result, data):
            if isinstance(src, dict):
                for k in ("images", "image_urls", "reference_images"):
                    lst = _str_list(src.get(k))
                    if lst:
                        return lst
    if kind == STRING:
        keys = _CAMERA_KEYS if _is_camera_source(st, sh) else _TEXT_KEYS
    elif kind == IMAGE:
        keys = _IMAGE_KEYS
    elif kind == VIDEO:
        keys = _VIDEO_KEYS
    elif kind == AUDIO:
        keys = _AUDIO_KEYS
    else:
        return []
    for src in (result, data):
        if not isinstance(src, dict):
            continue
        if sh:
            own = _first_str([src], (sh,))
            if own and (kind == STRING or _looks_like_url(own)):
                return [own]
        v = _first_str([src], keys)
        if v:
            return [v]
    fallback = {IMAGE: ("image", "url"), VIDEO: ("video", "url"), AUDIO: ("audio", "url")}.get(kind)
    v = _first_str([data], fallback) if fallback else None
    return [v] if v else []


def own_prompt(node: Optional[Dict[str, Any]]) -> str:
    data = node_data(node)
    keys = ("text", "prompt") if (node or {}).get("type") == "audio" else ("prompt", "text")
    return _first_str([data], keys) or ""


def incoming_ref_edges(node: Dict[str, Any], edges: List[Dict[str, Any]],
                       nodes_by_id: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """规则 1+2：本节点的参考边，已按 refOrder 排好序。"""
    nid = node.get("id")
    ntype = node.get("type")
    picked: List[Dict[str, Any]] = []
    seen = set()
    for e in edges or []:
        if not isinstance(e, dict) or e.get("target") != nid:
            continue
        src = nodes_by_id.get(e.get("source"))
        if src is None:
            continue
        if not is_ref_edge(e, ntype, src.get("type")):
            continue
        k = edge_key(e)
        if k in seen:
            continue
        seen.add(k)
        picked.append(e)
    order = {}
    for i, k in enumerate(ref_order_of(node_data(node))):
        order.setdefault(k, i)
    tail = len(order)
    indexed = list(enumerate(picked))
    indexed.sort(key=lambda it: (order.get(edge_key(it[1]), tail), it[0]))
    return [e for _, e in indexed]


# ---------- 核心：参考列表 → 槽位 ----------

def collect_inputs(node: Dict[str, Any], edges: List[Dict[str, Any]], nodes_by_id: Dict[str, Dict[str, Any]],
                   results: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """解析生成节点的输入（新旧连法通用，规则见模块文档 R1–R6）。

    返回 ``{"refs": [...], "slots": {...}, "mode": str, "has_text_refs": bool}``：
    - refs：有序参考列表，每项 ``{n, key, edge_id, source, source_type, source_handle, target_handle,
      kind, slot, assigned_by(legacy_handle|ref_roles|auto), values, value_slots?, ignored?}``；
    - slots：``prompt``(最终提示词) / ``camera_prompt`` / ``first_frame`` / ``last_frame`` 为字符串，
      ``reference_images`` / ``ref_audio`` / ``reference_video`` 为列表；空槽不出现；
    - mode：视频节点实际生效的参考模式（其余节点为空串）。
    """
    results = results or {}
    data = node_data(node)
    ttype = node.get("type") or ""
    roles = ref_roles_of(data)
    ordered = incoming_ref_edges(node, edges, nodes_by_id)

    refs: List[Dict[str, Any]] = []
    prompt_texts: List[Tuple[int, str]] = []
    camera_texts: List[str] = []
    # 媒体落位：(n, 值序号, 槽位, url)，最后按 n 排序成列表，保证参考图顺序 = 参考列表顺序
    placements: List[Tuple[int, int, str, str]] = []
    single: Dict[str, Optional[str]] = {"first_frame": None, "last_frame": None}
    unassigned_images: List[Tuple[Dict[str, Any], int, str]] = []

    def _place(ref: Dict[str, Any], vi: int, slot: str, url: str) -> None:
        ref.setdefault("value_slots", [None] * len(ref["values"]))
        if slot in single:
            if single[slot] is not None:
                return  # 单值槽先到先得，多余的忽略
            single[slot] = url
        placements.append((ref["n"], vi, slot, url))
        ref["value_slots"][vi] = slot

    for n, e in enumerate(ordered, 1):
        src = nodes_by_id.get(e.get("source")) or {}
        st = src.get("type") or ""
        sh = str(e.get("sourceHandle") or e.get("source_handle") or "")
        th = target_handle(e)
        key = edge_key(e)
        res = results.get(e.get("source")) if isinstance(results.get(e.get("source")), dict) else None
        kind = source_kind(src, sh, res)
        values = source_values(kind, src, sh, res)
        if th and th != IN_PORT and th in LEGACY_HANDLE_SLOTS:
            explicit, by = LEGACY_HANDLE_SLOTS[th], "legacy_handle"
        else:
            explicit, by = normalize_slot(roles.get(key)), "ref_roles"
        if explicit and SLOT_KIND.get(explicit) != kind:
            explicit = None
        ref = {
            "n": n, "key": key, "edge_id": e.get("id"), "source": e.get("source"), "source_type": st,
            "source_handle": sh, "target_handle": th, "kind": kind, "slot": None,
            "assigned_by": by if explicit else "auto", "values": values,
        }
        refs.append(ref)
        if kind == STRING:
            slot = explicit or ("camera_prompt" if _is_camera_source(st, sh) else "prompt")
            ref["slot"] = slot
            text = values[0] if values else ""
            if text and slot == "camera_prompt":
                camera_texts.append(text)
            elif text:
                prompt_texts.append((n, text))
        elif kind == IMAGE:
            if explicit:
                ref["slot"] = explicit
            for vi, url in enumerate(values):
                if explicit:
                    _place(ref, vi, explicit, url)
                else:
                    unassigned_images.append((ref, vi, url))
        elif kind == AUDIO:
            ref["slot"] = "ref_audio"
            for vi, url in enumerate(values):
                _place(ref, vi, "ref_audio", url)
        elif kind == VIDEO:
            ref["slot"] = "reference_video"
            for vi, url in enumerate(values):
                _place(ref, vi, "reference_video", url)

    # R5：视频模式（显式 / 按全部图片参考数自动），未指定槽位的图片按模式落位
    mode = ""
    if ttype == "video":
        mode = normalize_video_mode(data.get("mode"))
        if not mode:
            n_images = sum(max(1, len(r["values"])) for r in refs if r["kind"] == IMAGE)
            if n_images == 0:
                mode = "multiReference" if any(r["kind"] in (AUDIO, VIDEO) for r in refs) else "text"
            else:
                mode = "singleImage" if n_images == 1 else "multiReference"
    for i, (ref, vi, url) in enumerate(unassigned_images):
        if ttype != "video" or mode == "multiReference":
            prefer = ("reference_images",)
        elif mode == "text":
            ref.setdefault("value_slots", [None] * len(ref["values"]))  # 文生视频：未指定槽位的图不发送
            continue
        elif mode == "singleImage":
            prefer = ("first_frame", "reference_images") if i == 0 else ("reference_images",)
        else:  # startEnd
            prefer = ("first_frame", "last_frame", "reference_images")
        slot = next((s for s in prefer if s not in single or single[s] is None), "reference_images")
        _place(ref, vi, slot, url)

    # 汇总每条参考的落位：全部未落位 = ignored；批量图各张落位不同才保留 value_slots
    for ref in refs:
        vs = ref.pop("value_slots", None)
        if vs is None:
            continue
        placed = [s for s in vs if s]
        if not placed:
            ref["ignored"] = True
            continue
        if ref["slot"] is None:
            ref["slot"] = placed[0]
        if len(set(vs)) > 1:
            ref["value_slots"] = vs

    if ttype == "video" and str(data.get("mode") or "").strip().lower() == "i2v" and single["first_frame"] and single["last_frame"]:
        mode = "startEnd"  # 旧 i2v 节点同时有首尾帧
    slots: Dict[str, Any] = {}
    if camera_texts:
        slots["camera_prompt"] = "\n".join(camera_texts)
    for s in ("first_frame", "last_frame"):
        if single[s]:
            slots[s] = single[s]
    placements.sort(key=lambda p: (p[0], p[1]))
    for s in LIST_SLOTS:
        lst: List[str] = []
        for _n, _vi, slot, url in placements:
            if slot == s and url not in lst:
                lst.append(url)
        if lst:
            slots[s] = lst
    prompt = assemble_prompt(own_prompt(node), prompt_texts, ref_mapping(own_prompt(node), refs, slots))
    if prompt:
        slots["prompt"] = prompt
    return {"refs": refs, "slots": slots, "mode": mode, "has_text_refs": bool(prompt_texts)}


_SLOT_DESC = {"first_frame": "首帧图", "last_frame": "尾帧图", "ref_audio": "参考音频", "reference_video": "参考视频"}


def ref_mapping(own: str, refs: List[Dict[str, Any]], slots: Dict[str, Any]) -> str:
    """R6 对应关系：own 里 {{ref N}} 提到的非文本参考 → 落位描述。"""
    mentioned = {int(m) for m in REF_TOKEN_RE.findall(own or "")}
    if not mentioned:
        return ""
    ref_imgs = slots.get("reference_images") or []
    parts = []
    for r in refs:
        if r["n"] not in mentioned or r["kind"] == STRING or r.get("ignored") or not r.get("values"):
            continue
        slot = r.get("slot")
        if slot == "reference_images":
            url = next((u for u, s in zip(r["values"], r.get("value_slots") or [slot] * len(r["values"]))
                        if s == "reference_images"), None)
            desc = f"第 {ref_imgs.index(url) + 1} 张参考图" if url in ref_imgs else ""
        else:
            desc = _SLOT_DESC.get(slot or "", "")
        if desc:
            parts.append(f"参考 {r['n']}={desc}")
    return f"（参考编号对应：{'，'.join(parts)}）" if parts else ""


def assemble_prompt(own: str, texts: List[Tuple[int, str]], mapping: str = "") -> str:
    """R6：主体 + 文本参考（``参考 N：``）+ 对应关系。与 own 完全相同的文本参考视为旧画布拷贝副本，去掉。"""
    own = (own or "").strip()
    items = [(n, t.strip()) for n, t in texts if isinstance(t, str) and t.strip() and t.strip() != own]
    parts: List[str] = []
    if own:
        parts.append(REF_TOKEN_RE.sub(lambda m: f"参考 {m.group(1)}", own))
    elif items:
        parts.append(items[0][1])
        items = items[1:]
    parts.extend(f"参考 {n}：\n{t}" for n, t in items)
    if mapping:
        parts.append(mapping)
    return "\n\n".join(p for p in parts if p)


# ---------- 引擎适配 ----------

ASSEMBLED_PROMPT_KEY = "_assembled_prompt"


def to_engine_upstream(slots: Dict[str, Any], has_text_refs: bool = False) -> Dict[str, Any]:
    """槽位 → 引擎 execute_node 读取的 upstream 键。

    只写规范键（及引擎分支读取的 *_url / reference_audios / reference_videos 兼容键）。
    **不**再写 image_url/reference/video_url/audio_url 别名：视频分支会把 image_url/reference 当首帧兜底，
    导致「只连参考图」被误判成图生视频；也**不**再把首帧顺带塞进 reference_images（Seedance 等会把同一张图
    同时当首帧和参考图）。
    """
    up: Dict[str, Any] = {}
    if slots.get("prompt"):
        up["prompt"] = slots["prompt"]
        up["text"] = slots["prompt"]
        if has_text_refs:
            up[ASSEMBLED_PROMPT_KEY] = slots["prompt"]
    if slots.get("camera_prompt"):
        up["camera_prompt"] = slots["camera_prompt"]
    if slots.get("first_frame"):
        up["first_frame"] = slots["first_frame"]
        up["first_frame_url"] = slots["first_frame"]
    if slots.get("last_frame"):
        up["last_frame"] = slots["last_frame"]
        up["last_frame_url"] = slots["last_frame"]
    if slots.get("reference_images"):
        up["reference_images"] = list(slots["reference_images"])
    if slots.get("ref_audio"):
        up["ref_audio"] = slots["ref_audio"][0]
        up["reference_audios"] = list(slots["ref_audio"])
    if slots.get("reference_video"):
        up["reference_videos"] = list(slots["reference_video"])
    return up


# ---------- 画布结构维护（canvas_connect / 删除节点共用） ----------

def ordered_ref_keys(node: Dict[str, Any], edges: List[Dict[str, Any]],
                     nodes_by_id: Dict[str, Dict[str, Any]]) -> List[str]:
    return [edge_key(e) for e in incoming_ref_edges(node, edges, nodes_by_id)]


def register_ref(node: Dict[str, Any], key: str, slot: Optional[str], existing_keys: List[str]) -> None:
    """把新参考写进 data.refOrder（末尾）与 data.refRoles。

    existing_keys 为加线前已解析好的参考顺序：refOrder 缺失或不全时先把现有参考按当前顺序补进去，
    避免新参考因「已列出的排在前面」而插到未列出的旧参考之前。
    slot 为 None 时不动已有的显式槽位（未指定 = 自动分配）。
    """
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    order = ref_order_of(data)
    order = order + [k for k in existing_keys if k not in order and k != key]
    if key not in order:
        order.append(key)
    data["refOrder"] = order
    roles = ref_roles_of(data)
    if slot:
        roles[key] = slot
    data["refRoles"] = roles
    node["data"] = data


def forget_ref(node: Dict[str, Any], key: str) -> bool:
    """连线/来源节点被删后，清理 refOrder / refRoles 中的残留键。"""
    data = node.get("data") if isinstance(node.get("data"), dict) else None
    if not data:
        return False
    changed = False
    raw_order = data.get("refOrder")
    if isinstance(raw_order, list) and key in raw_order:
        data["refOrder"] = [k for k in raw_order if k != key]
        changed = True
    raw_roles = data.get("refRoles")
    if isinstance(raw_roles, dict) and key in raw_roles:
        data["refRoles"] = {k: v for k, v in raw_roles.items() if k != key}
        changed = True
    return changed
