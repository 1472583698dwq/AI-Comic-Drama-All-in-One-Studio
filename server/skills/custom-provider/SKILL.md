---
name: custom-provider
description: 导演 Agent 生成任意 API 自定义生成源的主 SOP（纯代码唯一模式）：有 Key 配 Key——注册 api_key 自动写入 config_store 双键 + 环境变量、代码读 ctx.api_key 禁硬编码、update 换 Key/传空串清 Key；流程=查重→收集文档→定 schema→写码→注册→零配额体检→汇报。schema x-* 模板与异步铁律引用 provider-factory，ComfyUI 系走 comfyui-provider。
version: 1.0.0
author: MiniMax Studio
category: ai_generation
tools:
  - list_custom_providers
  - register_custom_provider
  - get_provider_code
  - update_custom_provider
  - test_custom_provider
  - read_skill
  - fs_read
---

# 自定义生成源主 SOP (Custom Provider)

## 定位与边界
导演说「接一个 xxx API 当生成源 / 做个生图（生视频/配音）源 / 我有 API 文档和 Key」时，**本技能是通用入口**。
- **ComfyUI 系**（本机工作流、RunningHub、comfyui_workflow 网关）→ `read_skill {name:"comfyui-provider"}`
- **schema x-* 分组模板、文件插槽标准、异步视频铁律全文** → `read_skill {name:"provider-factory"}`（本文不重复）
- **改已有源** → `read_skill {name:"provider-author"}`：先 `get_provider_code` 分页读全旧码再增量改
- **查重先行**：`list_custom_providers {kind, q}`，同名/同类源存在则改不建。

### 两条铁律（与 comfyui-provider 同步遵守）
1. **纯代码唯一**：注册必须带 `code`（≥20 字符，`async def generate(ctx, api)`；JS 为 `async function generate` + `module.exports`）。JSON/transport 非代码模式已删除；`transport/auth/mapping/health_check/provider_type` 是 legacy 字段，更新时被静默丢弃——不要写、不要指望改它生效。注册前过 `ast` 语法预检，改码过沙箱体检（先验后存，坏码直接打回）。
2. **Key 禁硬编码**：Key 只活在 `api_key` 参数 → config_store/env，代码里只读 `ctx["api_key"]` / `api.get_api_key()`；Key 不写进 `code`、`doc_text`、汇报正文。

---

## API Key 配置全链路（用户给了 Key 就走这里）

### 有 Key：注册时带上（一次到位）
`register_custom_provider {kind, name, language, code, input_schema, params_schema, api_key: "sk-..."}` —— 后端自动做四件事：
1. `auth = {type: "bearer", key_env: "CUSTOM_PROVIDER_<id>", prefix: "Bearer "}`（注册即绑）
2. `storage/config_store.json` **双写持久化**：`custom_providers["<id>"].api_key` + 顶层 `"CUSTOM_PROVIDER_<id>"`
3. `os.environ["CUSTOM_PROVIDER_<id>"]` 即时生效（当次进程立即可调）
4. 沙箱读取顺序（`_get_api_key_for_provider`）：env `auth.key_env` → config_store 顶层 `CUSTOM_PROVIDER_<id>` → `<id>` → `custom_providers[<id>].api_key`

### 代码契约（有 Key / 无 Key 通用）
```python
import httpx

async def generate(ctx, api):
    key = str(ctx.get("api_key") or "").strip()   # 框架已解析好；空串 = 未配置
    if not key:
        raise RuntimeError("缺少 API Key（请在生成源配置里填入 Key 后重试）")
    headers = {"Authorization": f"Bearer {key}"}
    ...
```
- **框架不硬拦缺 Key**（允许个别源内联 Key），所以**必须由代码自检并给出引导性报错**，别让 401 裸奔。
- `api.get_api_key()` 同源等价；`ctx["api_key_env"]`（image 源）可在报错里带上键名方便排查。
- **无 Key 源**（公开接口/本机服务）：`api_key` 不传 → `auth.type=none`，代码不得强求 Key。

### 换 Key / 清 Key（已有源）
- 换：`update_custom_provider {provider_id, api_key: "新KEY"}` → 同样双写 + env，即时生效、重启不丢。
- 清：`update_custom_provider {provider_id, api_key: ""}` → 删除 config_store 两处 + `os.environ.pop`。
- **不传 `api_key` 字段 = 不动 Key**；传空串 = 清除（`None` 与 `""` 语义不同，别搞混）。
- 兜底：先无 Key 后补 Key 时 `auth.key_env` 可能仍为 `None`，读取顺序第二步照样按 `CUSTOM_PROVIDER_<id>` 命中 config_store，链路不断。

### Key 排错顺序
401/403 → ① 代码是否写死了旧 Key 或没读 `ctx` ② `update` 是否真的传了 `api_key`（手改 config_store 不算，且易被并发覆盖）③ 源的 `auth.type` 是否 bearer（注册时带过 Key 才会置）④ Key 本身是否过期/未开通该模型。**报错与汇报都不得回显 Key 全文**（打码只留前 4 位）。

---

## 执行 SOP（导演必循）
1. **查重**：`list_custom_providers {kind, q}`；命中 → 走改码流程（第 6 步）。
2. **收集**：`kind`（image/video/audio/llm）、API 文档（doc_text / curl / openapi_url）、**是否有 Key**、同步 or 异步（有 task_id 查询接口 = 异步）、文件插槽（prompt 外几张图/几段音频、首帧是否必选）。
3. **定 schema**：
   - 文件 → `input_schema`（`x-handle: text|image|audio` + `x-slot` + `maxItems`，prompt 带 `x-role:prompt`）；
   - 可量化参数 → `params_schema`（x-category/x-visibility/x-agent/x-priority 四件套，模板缺了 `read_skill provider-factory`）；
   - 注册端兜底顺序：先提取 code 尾 `# PARAMS_SCHEMA` → 没有才套 kind 默认（video 默认是通用 `480p竖/768p竖/...`，**与真实 API 不符会被出网护栏按 enum 拦**）——真实枚举必须自己在 `# PARAMS_SCHEMA` 写对。
4. **写码**（纯代码骨架见下节）：同步直返 / 异步双分支（铁律全文见 provider-factory）；防御式 `.get()` 解析；Key 只读 `ctx`。
5. **注册**：`register_custom_provider {kind, name, language, code, input_schema, params_schema, api_key?}`——**有 Key 必须在本次一起传**，别让用户回头再配。
6. **体检**：`test_custom_provider {provider_id}` → 要求 `compile_check.ok=true`；**异步源零配额验链路**：用一个历史真实 `task_id` 走查询分支（或 provider 工具传 `task_id`+空 prompt），通了再花配额提交新任务。
7. **汇报**：已生成 `id`；**Key 状态：已配置/未配置（不回显 Key 值）**；暴露了哪些槽（输入几张图/参数几项·Agent 可填）；异步源加一句「提交返 task_id，后台轮询取片」。
8. **改已有源**：`get_provider_code` 分页读到 `code_next_offset=None` → `update_custom_provider` 增量补丁（code/params_schema/input_schema/api_key 均可单改，空 code 会被拒绝）。

## 纯代码骨架（同步 + 异步分岔，照抄改 URL/键名）
```python
import httpx

async def generate(ctx, api):
    dyn = ctx.get("dynamic_inputs") or {}
    key = str(ctx.get("api_key") or "").strip()
    if not key:
        raise RuntimeError("缺少 API Key（请在生成源配置里填入 Key 后重试）")
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    # —— 异步查询分支：task_id 非空且 prompt 为空 → 单次秒回，禁 sleep 轮询 ——
    task_id = str(ctx.get("task_id") or dyn.get("task_id") or "").strip()   # 双路取
    prompt = str(ctx.get("prompt") or ctx.get("text") or "").strip()
    if task_id and not prompt:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{BASE}/tasks/{task_id}", headers=headers)
            r.raise_for_status()
            data = r.json() or {}
            status = str(data.get("status") or "").upper()
            if status in ("SUCCESS", "COMPLETED"):
                return {"url": data.get("result_url")}          # url 键通用，框架统一落盘
            if status in ("FAILED", "ERROR", "CANCELLED"):
                raise RuntimeError(f"任务失败({status}): {str(data)[:300]}")   # 特征词→终态
            return {"video_url": None, "task_id": task_id, "status": status or "RUNNING"}

    # —— 提交/同步主干 ——
    if not prompt:
        raise ValueError("缺少 prompt")
    body = {"prompt": prompt, "duration": int(ctx.get("duration") or 5)}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(f"{BASE}/generate", json=body, headers=headers)
        if r.status_code >= 400:
            raise RuntimeError(f"提交失败({r.status_code}): {r.text[:300]}")  # 带出服务端 code/msg
        resp = r.json() or {}
        # 异步 API：提交即返，绝不阻塞等终态
        if resp.get("task_id"):
            return {"video_url": None, "task_id": str(resp["task_id"]), "status": "SUBMITTED"}
        # 同步 API：直接拿结果
        url = resp.get("data", {}).get("url") if isinstance(resp.get("data"), dict) else None
        if not url:
            raise RuntimeError(f"未返回结果URL: {str(resp)[:300]}")
        return {"url": url}
# PARAMS_SCHEMA: {"type":"object","properties":{"duration":{"type":"integer","title":"时长","default":5,"minimum":1,"maximum":15,"x-category":"motion","x-visibility":"basic","x-agent":"auto","x-priority":20}}}
```
- 同步 API（一次请求出片）删掉查询分支即可；image/audio 的返回键用 `image_url/audio_url`（或通用 `url`）。
- 模板更多（含完整异步 H3 版、JS 版）：`read_skill provider-factory`，或 REST `/providers/code/templates`。

## 坑位表
1. **`api_key` 传 `""` = 清 Key**，不传才不动；换 Key 走 `update_custom_provider`，别手改 `config_store.json`。
2. **update 里传 `transport/auth/provider_type` 等 legacy 字段会被静默丢弃**——你以为改了，实际没生效；`provider_type` 注册时已锁 `code`。
3. **env 只管当次进程**：持久化靠 config_store 双写（已内置）；换机器/重装 exe 后 Key 在 config_store 里随 storage 走。
4. **video 兜底 params 模板是通用的**（`480p竖/768p竖/480p横/768p横` + duration + seed），真实 API 枚举不同必须用 code 尾 `# PARAMS_SCHEMA` 覆盖，否则出网前护栏直接拦「参数校验失败（未发送请求）」。
5. **curl 文档里往往内嵌 Key**：注册前把 Key 抠进 `api_key` 参数，`doc_text` 里打码，不要让 Key 落进源定义文本。
6. 纯 HTTP 源不需要可信模式（默认沙箱 httpx 即可）；只有要 `os/subprocess/curl/ffmpeg` 才 `trusted:true` + 总闸 `STUDIO_TRUSTED_MODE=1`（双开）。
7. 代码缺 `# PARAMS_SCHEMA` 尾注且没传 `params_schema` → 套默认模板 → 与真实 API 不符 → 护栏拦提交。先补枚举再排查其他。
8. 改码后 `test_custom_provider` 失败先读 `compile_check.error`（沙箱体检在保存前拦截，坏码进不了库）。

## 质检清单（交付前自检）
- [ ] 纯代码：`code≥20`、`async def generate(ctx, api)`、编译/体检通过；无 legacy 字段操作、无 JSON 模式残留
- [ ] Key：有 Key → 已随注册/update 配好（汇报只说「已配置」不回显值）；代码读 `ctx["api_key"]` 且缺 Key 有引导报错；全文无硬编码 Key
- [ ] schema：文件槽在 `input_schema`、参数带 x-* 四件套、`# PARAMS_SCHEMA` 枚举与真实 API 一致
- [ ] 异步源：提交即返 + 查询分支（task_id 双路取、秒回无 sleep）+ 已用历史 task_id 验链路
- [ ] `test_custom_provider` `ok=true` / `compile_check.ok=true`
- [ ] 汇报含：`id`、Key 状态、暴露槽位、取片方式（同步直返 / 异步轮询）

## 示例
**用户**：接个生视频的源，API 文档给你，Key 是 sk-abcd1234
**导演**：`list_custom_providers {kind:video, q:"xxx"}` → 无 → 读文档定双分支与枚举 → `register_custom_provider {kind:video, name:"XXX视频", language:python, code:<纯代码>, input_schema:{prompt,first_frame,...}, params_schema:{duration/aspect_ratio/... x-*}, api_key:"sk-abcd1234"}` → `test_custom_provider {provider_id}` ok → 汇报：「已生成 `prov_xxx`，Key 已配置（不回显），首帧 1 张 + 参考图 0-3 张，提交返 task_id 后台约 N 分钟出片」。
**用户**：Key 换了
**导演**：`update_custom_provider {provider_id, api_key:"新KEY"}` → 回复「已更新，即时生效」。
