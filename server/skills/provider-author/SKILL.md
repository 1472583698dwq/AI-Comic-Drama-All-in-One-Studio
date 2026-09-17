---
name: provider-author
description: 生成源与插件直写 SOP：先用 get_provider_code / fs_read 分页通读现有完整代码，再直接手写生成源代码或插件包（含代码契约、异步双分支模板、插件 manifest 与 Creator 提案流程、质检清单）
version: 1.0.0
author: Studio
category: provider-extension
tools: [get_provider_code, fs_read, register_custom_provider, update_custom_provider, list_custom_providers, test_custom_provider, creator_propose_capability, creator_start_test, creator_finalize, read_skill]
---

# 生成源与插件直写 SOP

## 定位
用户说「接个新源 / 改源代码 / 给源补插槽 / 做个插件包 / 写个插件工具」时：**先读全（源码+规范）→ 直接写（代码/提案）→ 体检 → 汇报**。禁止只凭 800 字 `code_preview` 改码，禁止把坏码留给用户。

## 0. 前置：读全，不读预览
- **现有源**：`get_provider_code {provider_id|name|q, offset, limit}` 从 `offset=0` 分页读到 `code_next_offset` 为 `None`，拼出完整函数。重点看：提交/查询分支、ctx 取参、返回值契约、tail `# PARAMS_SCHEMA`、API 真实枚举。
- **任意文件**：`fs_read {path, offset, limit}`（行分页，只读，无需可信模式）。常用位置：
  - 源定义：`storage/providers/custom/<id>.json`
  - 技能规范：`server/skills/<name>/SKILL.md`（也可直接 `read_skill {name}`）
  - 已装插件：`storage/plugins/<plugin_id>/`
- **查重**：先 `list_custom_providers {kind, q}`，避免重复建源。
- **规范**：动手写生成源前先 `read_skill {name:"provider-factory"}`（参数/插槽标准与异步坑位表）。

## 1. 直写生成源（代码模式唯一，非代码 JSON 模式已删除）
- 新建：`register_custom_provider {kind, name, language, code, api_key?, input_schema?, params_schema?, models?}`
- 改码：`update_custom_provider {provider_id, code, input_schema/params_schema?}` —— 先通读旧码，**增量改**，不要整段重写丢逻辑。
- **代码契约**：
  - 入口 `async def generate(ctx, api)`（JS：`async function generate(ctx, api)` + `module.exports = { generate };`）。
  - `api` 沙箱：`httpx/aiohttp/requests/asyncio/json/re/time/uuid`、`api.download(url, prefix)->(url,path)`、`api.get_api_key()`、`api.storage_dir`；沙箱禁止 os/subprocess 系（trusted=True 且全局 `STUDIO_TRUSTED_MODE=1` 才放行）。
  - ctx 关键键：`prompt/text`、`reference_images`、`first_frame_url`、`last_frame_url`、`reference_audios`、`duration`、`resolution`、`aspect_ratio`、`fps`、`model`、`seed`、`api_key`、`headers`、`dynamic_inputs`、`task_id`。
  - 返回值：image `{"image_url": url}` / `{"b64_json": ...}`；video `{"video_url": url}` 或 `{"task_id": id}`；audio `{"audio_url": url}`。
  - **异步任务 API 必须双分支**：
    1) 提交（无 task_id）：POST 后**立即返回** `{"video_url": None, "task_id": id, "status": "SUBMITTED"}`，**禁止代码内 while/sleep 轮询**；
    2) 查询（有 task_id 且 prompt 为空）：单次 GET/POST 结果接口——完成返回 `{"video_url": url}`，未完成返回**同一个 task_id** + `status:"RUNNING"`，失败 `raise RuntimeError(...)` 或 `status:"FAILED"`；
    3) task_id 双路取：`ctx.get("task_id") or (ctx.get("dynamic_inputs") or {}).get("task_id")`。
  - **防御式解析**：一律 `.get()` 链；业务码非成功、data 缺失/为 null → `raise RuntimeError` 带 code/msg/原始响应前 300 字符；列表元素兼容对象与字符串两种形态。
  - **参数枚举**：API 有独立枚举时在代码最后一行追加 `# PARAMS_SCHEMA: {...}`（合法 JSON 单行注释），并标 `x-category/x-visibility/x-agent/x-priority`（layout→basic/auto；quality→advanced/suggest；seed/api_key→manual；x-priority 越小越靠前）。
  - **schema 分工**：文件/文本槽放 `input_schema`（prompt 带 `x-handle:"text"`；参考图 `x-handle:"image"`+`x-slot`+`maxItems`；首帧 `first_frame`）；可量化参数放 `params_schema`。严禁把文件插槽塞进 `params_schema`。
- 写完必须 `test_custom_provider {provider_id}` 验证编译+连通；`compile_check.ok` 不通过先按 error 修码再重试。

## 2. 直写插件（插件包）
按是否开启可信模式二选一：

**A) 推荐：Creator 提案链（人在环，四步不可跳）**
1. `creator_propose_capability {goal:"做xxx插件包"}` → 生成 plugin_spec（manifest + 文件清单），把要点（id/组件/风险/可逆性）转述给用户；
2. 用户点「Start 试跑」→ `creator_start_test {proposal_id}`；
3. 试跑通过且用户点「持久化」→ `creator_finalize {proposal_id, action:"persist"}`（安装+启用）；用户选「丢弃」→ `discard`。

**B) 已安装插件的代码编辑（需 `STUDIO_TRUSTED_MODE=1`）**
- 用 `fs_file write storage/plugins/<plugin_id>/<相对路径>` 改包内文件（生成源用 `code_file` 指向真文件更佳）；插件目录监听约 3s 自动热重载，或调用插件热重载接口。

**插件包结构**：`plugin.json`（id=kebab-case、name、version=semver、extensionPoints）+
- `providers/*.json`（生成源，字段同 §1，推荐 `code_file: "code/xxx.py"`）
- `custom_nodes/*.json`（画布代码节点，入口 `async def run(inputs, params, ctx)`）
- `skills/<slug>/SKILL.md`（技能，frontmatter：name/description/version/category/tools）
- `mcp_tools/*.py`（插件工具：`PLUGIN_TOOLS=[{name, description, input_schema, entry}]` + `def entry(args, ctx) -> dict`）
- `workflows/*.json`（ComfyUI 工作流，启用时自动派生 `comfyui_wf_<id>` 生成源）

## 3. 汇报格式
- 做了什么：id/名称、读了什么（旧码要点）、改了什么（before→after 各一两句）、体检结果（compile_check / test 连通）。
- 失败时给结构化三行：**what**（现象）/ **why**（原因）/ **next**（下一步），不要只回「失败了」。

## 质检清单（交付前自检）
- [ ] 改码前已分页通读完整旧码（offset 翻到 `code_next_offset=None`）
- [ ] 代码无 markdown 围栏；入口函数名 = `generate`（插件节点 = `run`）
- [ ] 文件插槽在 `input_schema`、可量化参数在 `params_schema`，`x-*` 齐全
- [ ] 异步源：提交即返 + 查询分支 + task_id 双路取，代码内无阻塞轮询
- [ ] `# PARAMS_SCHEMA` 枚举与代码/真实 API 一致
- [ ] `test_custom_provider` 返回 `ok=true` 且 `compile_check.ok=true`

## 常见坑
- 只读 `code_preview` 就改码 → 丢逻辑；**必须分页读全**。
- 查询分支 task_id 只从 `ctx` 顶层取 → `dynamic_inputs` 里的取不到，分支成死代码。
- 代码内长轮询 → 工具 20 分钟窗口仍会超时；改「提交即返 + 框架轮询」。
- 参考图/首帧塞进 `params_schema` → 前端无插槽句柄、无法挂载；必须放 `input_schema`。
- 空 code / 未通过体检就宣称完成 → 禁止；坏码要么修好，要么明确交给用户。
