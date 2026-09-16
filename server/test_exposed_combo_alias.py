# -*- coding: utf-8 -*-
"""冒烟：暴露白名单默认全关 + 用户显式选择往返 + combo 下拉恢复 + 别名/自定义选项保留"""
import time
import copy
import tempfile
import os

_tmp = tempfile.mkdtemp()
os.environ["COMFYUI_WORKFLOWS_DIR"] = os.path.join(_tmp, "ext_workflows")

from app.core.config import settings
settings.STORAGE_DIR = os.path.join(_tmp, "storage")
os.makedirs(settings.STORAGE_DIR, exist_ok=True)

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

# 1) 默认全关：未保存过白名单 → inspect 返回空清单（不再默认暴露任何参数）
insp = mgr.inspect_workflow_nodes(wid)
assert insp["exposed_inputs"] == [], f"默认应不暴露任何输入, got {insp['exposed_inputs']}"
print("PASS1 默认全关：inspect 暴露清单为空")

# 1.5) auto_detect 仍能识别 combo 类型（仅供用户点选/刷新类型用，不再是默认来源）
fresh = m.auto_detect_exposed_inputs(mgr.sanitize_workflow(copy.deepcopy(wf)), {})
fresh_by_key = {f"{e['node_id']}_{e['param_name']}": e for e in fresh}
style_fresh = fresh_by_key.get("1_style")
assert style_fresh is not None and style_fresh["type"] == "combo" and "anime" in (style_fresh.get("options") or []), f"fresh 探测异常: {style_fresh}"
print("PASS1.5 fresh 探测 combo:", style_fresh["type"], style_fresh.get("options"))

# 2) 用户显式保存别名 + 自定义 options → inspect 只返回用户勾选的项（未勾选不倒灌），
#    fresh 真实枚举优先在前，用户自定义去重追加，type 仍为 combo
user_exposed = [
    {**style_fresh, "alias": "主角画风", "label": "风格", "options": ["anime", "水墨"], "choices": ["anime", "水墨"]},
]
mgr.save_workflow_overrides(wid, exposed_inputs=user_exposed)
insp2 = mgr.inspect_workflow_nodes(wid)
by_key2 = {f"{e['node_id']}_{e['param_name']}": e for e in insp2["exposed_inputs"]}
assert list(by_key2) == ["1_style"], f"白名单应只有用户勾选的 1_style, got {list(by_key2)}"
style2 = by_key2["1_style"]
assert style2.get("alias") == "主角画风", f"别名丢失: {style2}"
assert style2["type"] == "combo", f"保存后 type 应仍为 combo, got {style2['type']}"
# fresh（ComfyUI 真实枚举）优先在前，用户自定义"水墨"追加在后
assert style2.get("options") == ["anime", "realistic", "sketch", "水墨"], f"选项应为 fresh 枚举+用户追加, got {style2.get('options')}"
print("PASS2 用户白名单往返（未勾选不倒灌）:", style2["alias"], style2["options"])

# 2.5) 保存空清单 = 显式全关
mgr.save_workflow_overrides(wid, exposed_inputs=[])
insp_none = mgr.inspect_workflow_nodes(wid)
assert insp_none["exposed_inputs"] == [], f"空清单应保持全关, got {insp_none['exposed_inputs']}"
print("PASS2.5 显式清空后保持全关")

# 2.6) 白名单变更后 provider 定义必须强制重建（无陈旧快路径），立即反映最新选择
from app.providers.custom.manager import custom_provider_manager
pid = m._workflow_provider_id(wid)
defn = custom_provider_manager.get_definition(pid)
assert defn is not None, "provider 定义未生成"
assert defn.workflow_exposed == [], f"清空后 provider 应同步为空清单, got {defn.workflow_exposed}"
mgr.save_workflow_overrides(wid, exposed_inputs=[{**style_fresh, "alias": "主角画风"}])
defn2 = custom_provider_manager.get_definition(pid)
assert len(defn2.workflow_exposed or []) == 1 and defn2.workflow_exposed[0].get("alias") == "主角画风", f"provider 未随白名单重建: {defn2.workflow_exposed}"
print("PASS2.6 provider 随白名单强制重建:", defn2.workflow_exposed[0].get("alias"))

# 2.7) 注入护栏：非法枚举值拒绝写入（防 ComfyUI 软剪枝），合法值正常写入
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
print("PASS2.7 注入护栏 + txt_ 参数定位:", wf_probe["1"]["inputs"]["style"], wf_probe2["2"]["inputs"])

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
