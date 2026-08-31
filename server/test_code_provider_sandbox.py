# -*- coding: utf-8 -*-
"""冒烟：自定义代码源沙箱 + AI 生成源防御式契约 — 用真实 AutoDL 源定义，mock 网络层"""
import asyncio
import json

from app.providers.custom.manager import custom_provider_manager
from app.providers.generic import code_provider as cp

pd = custom_provider_manager.get_definition("prov_4dc87988")
assert pd and pd.code, "AutoDL H3 源定义缺失"
# 用户可能经 UI 编辑代码（PARAMS_SCHEMA 注释可被移除），schema 以显式声明为准
_ps_props = ((pd.params_schema or {}).get("properties") or {})
assert _ps_props.get("resolution", {}).get("enum", [None])[0] == "480p竖", f"真实枚举 schema 应存在: {list(_ps_props)}"
print("源:", pd.name, "| kind:", pd.kind, "| language:", pd.language, "| code_timeout:", pd.code_timeout)

# ---- mock aiohttp 网络层（不消耗真实配额） ----
import aiohttp

class FakeResp:
    def __init__(self, payload, status=200):
        self._p = payload
        self.status = status
    async def json(self):
        return self._p
    async def text(self):
        return json.dumps(self._p, ensure_ascii=False)
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False

class FakeSession:
    def __init__(self, *a, **k):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False
    def post(self, url, **k):
        print("  [mock] POST", url, "body:", json.dumps(k.get("json", {}), ensure_ascii=False))
        return FakeResp(CREATE_RESP)
    def get(self, url, **k):
        print("  [mock] GET", url)
        return FakeResp(RESULT_RESP)

# 真实 API 结构：results 是对象数组
CREATE_OK = {"code": "Success", "data": {"task_id": "T123", "status": "QUEUED"}, "msg": ""}
RESULT_OK = {"code": "Success", "data": {"task_id": "T123", "status": "SUCCESS",
            "results": [{"type": "video", "url": "https://fake.example/v.mp4"}]}, "msg": ""}
# 复现事故场景：参数枚举非法 → data:null
CREATE_BAD = {"code": "RequestParameterIsWrong", "data": None, "msg": "参数: resolution 的值: 480p 不在 options 列表中"}

CREATE_RESP = CREATE_OK
RESULT_RESP = RESULT_OK
aiohttp.ClientSession = FakeSession

async def fake_dl(url, prefix="gen"):
    return f"/storage/videos/{prefix}_fake.mp4", "local"

cp._download_to_storage = fake_dl

from app.providers.generic.code_provider import GenericCodeVideoProvider
from app.providers.video.base import VideoGenerateRequest

# ---- 1) 新代码：results 对象数组解析 + 成功链路 ----
prov = GenericCodeVideoProvider(pd)
req = VideoGenerateRequest(prompt="一个jk少女回眸一笑", mode="t2v", duration=5, resolution="480p竖",
                           dynamic_inputs={"resolution": "480p竖"})
result = asyncio.run(prov.generate(req))
print("生成结果:", result.video_url, "| engine:", result.engine)
assert result.video_url == "/storage/videos/vid_fake.mp4"
print("PASS1 真实代码执行成功（results 对象数组 → url 提取）")

# ---- 2) 服务端报错透出：合法枚举 + API 返回 data:null → 应抛带服务端 msg 的 RuntimeError ----
CREATE_RESP = CREATE_BAD
RESULT_RESP = RESULT_OK
prov2 = GenericCodeVideoProvider(pd)
try:
    asyncio.run(prov2.generate(VideoGenerateRequest(prompt="x", mode="t2v", duration=5,
                                                    dynamic_inputs={"resolution": "480p竖"})))
    raise SystemExit("should have raised")
except RuntimeError as _e:
    assert "不在 options 列表中" in str(_e), f"应透出服务端 msg, got {_e}"
    assert "NoneType" not in str(_e), "不应再出现 NoneType 崩溃"
    print("PASS2 失败场景报错透出:", str(_e)[:100])
CREATE_RESP = CREATE_OK

# ---- 3) PARAMS_SCHEMA 注释解析（用测试夹具，不依赖用户可编辑的存量代码） ----
from app.api.provider_routes import _extract_params_schema_from_code
ps = _extract_params_schema_from_code(
    "async def generate(ctx, api):\n    return {}\n"
    "# PARAMS_SCHEMA: {\"type\":\"object\",\"properties\":{\"resolution\":{\"type\":\"string\",\"enum\":[\"480p竖\",\"720p竖\"]}}}\n"
)
assert ps and ps["properties"]["resolution"]["enum"][0] == "480p竖", f"解析失败: {ps}"
assert _extract_params_schema_from_code("async def generate(ctx, api):\n    return {}\n") is None
print("PASS3 PARAMS_SCHEMA 解析:", list(ps["properties"].keys()))

# ---- 4) 出网前枚举护栏：非法值直接报错且不发起任何网络请求 ----
post_called = []
_orig_post = FakeSession.post
def _spy_post(self, url, **k):
    post_called.append(url)
    return _orig_post(self, url, **k)
FakeSession.post = _spy_post
prov3 = GenericCodeVideoProvider(pd)
try:
    asyncio.run(prov3.generate(VideoGenerateRequest(prompt="x", mode="t2v", duration=5,
                                                    dynamic_inputs={"resolution": "480p"})))
    raise SystemExit("should have raised")
except RuntimeError as _e2:
    assert "参数校验失败" in str(_e2) and "480p竖" in str(_e2), f"应给出合法值列表, got {_e2}"
    assert not post_called, "非法枚举不应发起网络请求！"
    print("PASS4 出网前枚举护栏（零请求拦截）:", str(_e2)[:90])
FakeSession.post = _orig_post

# ---- 5) 创建即体检：坏代码（违禁 import / 无入口）当场暴露 ----
from app.providers.generic.code_provider import compile_check_code
r1 = compile_check_code("python", pd.code, "generate")
assert r1["ok"], f"现有代码应体检通过: {r1}"
r2 = compile_check_code("python", "import os\nasync def generate(ctx, api):\n    return {}", "generate")
assert not r2["ok"] and "沙箱" in r2["error"], f"违禁 import 应被捕获: {r2}"
r3 = compile_check_code("python", "async def a(ctx, api):\n    return {}\nasync def b(ctx, api):\n    return {}\n", "generate")
assert not r3["ok"] and "入口" in r3["error"], f"多函数且无入口应被捕获: {r3}"
r4 = compile_check_code("python", "x = undefined_module_level_name\nasync def generate(ctx, api):\n    return {}\n", "generate")
assert not r4["ok"], f"模块级错误应被捕获: {r4}"
print("PASS5 创建即体检: 违禁import/缺入口/模块级错误 全部当场捕获")

# ---- 6) 统一创建入口 create_code_source：PARAMS_SCHEMA 注释自动成控件 + 体检闭环 ----
import os as _os
from app.api.provider_routes import create_code_source

_good_code = (
    "import asyncio\nasync def generate(ctx, api):\n"
    "    return {'image_url': 'data:image/png;base64,iVBORw0KGgo='}\n"
    "# PARAMS_SCHEMA: {\"type\":\"object\",\"properties\":{\"style\":{\"type\":\"string\",\"title\":\"风格\",\"enum\":[\"anime\",\"realistic\"],\"default\":\"anime\"}}}\n"
)
created = create_code_source(name="重构冒烟源", kind="image", code=_good_code, language="python")
assert created["compile_check"]["ok"], f"好代码体检应通过: {created['compile_check']}"
assert created["provider"]["params_schema"]["properties"]["style"]["enum"] == ["anime", "realistic"], \
    f"PARAMS_SCHEMA 注释应成为控件: {created['provider']['params_schema']}"
_bad_created = create_code_source(name="重构冒烟坏源", kind="image",
                                  code="import os\nasync def generate(ctx, api):\n    return {}", language="python")
assert not _bad_created["compile_check"]["ok"], "坏代码体检应失败"
# 清理测试源
from app.providers.custom.manager import custom_provider_manager as _cpm
for _pid in (created["id"], _bad_created["id"]):
    try:
        _cpm.delete_definition(_pid)
    except Exception:
        try:
            _os.remove(_os.path.join(_cpm.__class__ and 'storage/providers/custom', f'{_pid}.json'))
        except Exception:
            pass
print("PASS6 create_code_source 统一入口: PARAMS_SCHEMA 控件化 + 体检闭环（好/坏代码）")

# ---- 7) 结果解析协议 extract_result_media 全形态 ----
from app.providers.generic.code_provider import extract_result_media
assert extract_result_media("video", {"video_url": "http://a/b.mp4"})[0] == "http://a/b.mp4"
assert extract_result_media("video", {"results": [{"type": "video", "url": "http://x/y.mp4"}]})[0] == "http://x/y.mp4"
assert extract_result_media("video", {"results": ["http://s/t.mp4"]})[0] == "http://s/t.mp4"
assert extract_result_media("video", {"task_id": "T1"})[1] == "T1"
assert extract_result_media("image", {"b64_json": "AAAA"})[0].startswith("data:image/png;base64,")
assert extract_result_media("image", {"image_urls": [{"url": "http://i/1.png"}]})[0] == "http://i/1.png"
assert extract_result_media("audio", {"audio_url": "http://a/1.mp3"})[0] == "http://a/1.mp3"
print("PASS7 extract_result_media 协议: 主键/对象数组/字符串数组/task_id/b64 全形态")
print("ALL PASS")
