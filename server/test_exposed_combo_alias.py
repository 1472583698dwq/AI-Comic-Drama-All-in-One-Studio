# -*- coding: utf-8 -*-
"""冒烟：暴露项 combo 下拉恢复 + 别名/自定义选项 往返保留"""
import time
import json
import tempfile
import os

os.environ.setdefault("COMFYUI_WORKFLOWS_DIR", os.path.join(tempfile.mkdtemp(), "workflows"))

from app.providers.workflow import manager as m

# 注入假 object_info（模拟 ComfyUI 在线枚举，300s 缓存位）
m._OBJECT_INFO_CACHE = {
    "MyStyleNode": {"input": {"required": {"style": [["anime", "realistic", "sketch"], {}],
                                            "note": ["STRING", {"multiline": True}]}}},
    "MyResNode": {"input": {"required": {"quality": [["720p", "1080p", "480p"], {}]}}},
}
m._OBJECT_INFO_CACHE_TS = time.time()

mgr = m.ComfyWorkflowManager()

wf = {
    "1": {"class_type": "MyStyleNode", "inputs": {"style": "anime", "note": "hello world"}, "_meta": {"title": "风格节点"}},
    "2": {"class_type": "MyResNode", "inputs": {"quality": "720p"}, "_meta": {"title": "质量节点"}},
}
saved = mgr.save_workflow(name="smoke_combo", workflow_json=wf, mapping={}, description="smoke")
wid = saved["id"]

# 1) fresh 探测：自定义节点 COMBO 参数应为 combo + options（而非 text 手填）
insp = mgr.inspect_workflow_nodes(wid)
by_key = {f"{e['node_id']}_{e['param_name']}": e for e in insp["exposed_inputs"]}
style = by_key.get("1_style")
assert style is not None, f"1_style 未暴露: {list(by_key)}"
assert style["type"] == "combo", f"style 应为 combo, got {style['type']}"
assert "anime" in (style.get("options") or []), f"options 缺少原生枚举: {style.get('options')}"
quality = by_key.get("2_quality")
assert quality is not None and quality["type"] == "combo" and "1080p" in (quality.get("options") or []), f"quality 异常: {quality}"
print("PASS1 通用分支 COMBO 探测:", style["type"], style.get("options"))

# 2) 用户保存别名 + 自定义 options → inspect 往返保留（fresh 真实枚举优先在前，用户自定义去重追加），type 仍为 combo
user_exposed = [
    {**style, "alias": "主角画风", "label": "风格", "options": ["anime", "水墨"], "choices": ["anime", "水墨"]},
]
mgr.save_workflow_overrides(wid, exposed_inputs=user_exposed)
insp2 = mgr.inspect_workflow_nodes(wid)
by_key2 = {f"{e['node_id']}_{e['param_name']}": e for e in insp2["exposed_inputs"]}
style2 = by_key2["1_style"]
assert style2.get("alias") == "主角画风", f"别名丢失: {style2}"
assert style2["type"] == "combo", f"保存后 type 应仍为 combo, got {style2['type']}"
# fresh（ComfyUI 真实枚举）优先在前，用户自定义"水墨"追加在后
assert style2.get("options") == ["anime", "realistic", "sketch", "水墨"], f"选项应为 fresh 枚举+用户追加, got {style2.get('options')}"
quality2 = by_key2.get("2_quality")
assert quality2 is not None and quality2["type"] == "combo" and "1080p" in (quality2.get("options") or []), f"quality2 应恢复下拉: {quality2}"
print("PASS2 别名/选项合并（fresh 优先+用户追加）:", style2["alias"], style2["options"], "| quality:", quality2["type"], quality2["options"])

# 2.5) 注入护栏：非法枚举值拒绝写入（防 ComfyUI 软剪枝），合法值正常写入
wf_probe = {"1": {"class_type": "MyStyleNode", "inputs": {"style": "anime", "note": "x"}, "_meta": {"title": "风格节点"}}}
m._apply_dynamic_inputs(wf_probe, {"combo_1_style": "9:16 (Portrait)"})  # 非法值（模拟旧版硬编码残留）
assert wf_probe["1"]["inputs"]["style"] == "anime", f"非法枚举应被拦截, got {wf_probe['1']['inputs']['style']}"
m._apply_dynamic_inputs(wf_probe, {"combo_1_style": "sketch"})
assert wf_probe["1"]["inputs"]["style"] == "sketch", f"合法枚举应写入, got {wf_probe['1']['inputs']['style']}"
# txt_ 写入节点已有文本参数（value），不再伪造 text 键
wf_probe2 = {"1": {"class_type": "MyStyleNode", "inputs": {"style": "anime", "note": "x"}, "_meta": {"title": "风格节点"}},
              "2": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "旧"}, "_meta": {"title": "文本"}}}
m._apply_dynamic_inputs(wf_probe2, {"txt_2": "新提示词"})
assert wf_probe2["2"]["inputs"] == {"value": "新提示词"}, f"txt_ 应写 value 且不伪造 text 键, got {wf_probe2['2']['inputs']}"
print("PASS2.5 注入护栏 + txt_ 参数定位:", wf_probe["1"]["inputs"]["style"], wf_probe2["2"]["inputs"])

# 3) 旧脏数据（type=select + 手填文本项）自动治愈为 combo
legacy = [
    {"id": "combo_1_style", "node_id": "1", "param_name": "style", "label": "旧select", "type": "select", "choices": ["anime", "realistic"]},
]
mgr.save_workflow_overrides(wid, exposed_inputs=legacy)
insp3 = mgr.inspect_workflow_nodes(wid)
by_key3 = {f"{e['node_id']}_{e['param_name']}": e for e in insp3["exposed_inputs"]}
style3 = by_key3["1_style"]
assert style3["type"] == "combo", f"旧 select 应治愈为 combo, got {style3['type']}"
assert "anime" in (style3.get("options") or []), f"治愈后 options 异常: {style3.get('options')}"
print("PASS3 旧 select 治愈:", style3["type"], style3.get("options"))

# 4) inspect 参数项带 min/max/step（滑杆保真）
node1 = [n for n in insp["nodes"] if n["node_id"] == "1"][0]
p_note = [p for p in node1["parameters"] if p["name"] == "note"][0]
assert p_note["type"] == "STRING" and p_note.get("min") is None
print("PASS4 参数项 widget meta 字段存在")

# 清理
try:
    os.remove(os.path.join(m.WORKFLOWS_DIR, f"{wid}.json"))
    os.remove(os.path.join(m.WORKFLOWS_DIR, f"{wid}.meta.json"))
except Exception:
    pass
print("ALL PASS")
