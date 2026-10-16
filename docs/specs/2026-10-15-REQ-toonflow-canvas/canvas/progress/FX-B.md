# FX-B · E2E 修复轮（后端）

状态：完成（未提交）。只改了 `server/**`。

## 改了什么

| 文件 | 改动 |
|---|---|
| `server/app/pipelines/llm_service.py` | 新增 `chat_completion_stream()`：逐段 yield 增量（同 `chat_stream` 的 OpenAI 兼容 `stream: true` 通道，含整体时限、思考标签剥离）；流式失败或没产出任何内容时退化为一次性调用，整段 yield 一次；已产出部分内容后流中断则抛 `LLMServiceError`（不再补一次性结果，免得前半段重复）。原 `chat_completion` 的兜底单次调用抽成 `_one_shot_completion()`，两者共用，行为不变 |
| `server/app/canvas/text_skills.py` | 新增 `generate_request()` / `expand_request()`：LLM 请求（messages / temperature / max_tokens）的唯一来源，`generate_text` / `expand_prompt`（非流式）和新的 `stream_request()` / `stream_text()`（流式）共用。`STREAM_SKILLS`、`EXPAND_MAX_CHARS=1200`（流式扩写同样截断） |
| `server/app/api/routes.py` | 新增 `POST /api/v1/llm/generate/stream`（见下「契约」） |
| `server/app/mcp/server.py` | ① `infer_video_mode()`：生成源工具视频分支缺 `mode` 时按入参推断（替换写死的 `"i2v"`，task_center 登记也用推断值）；② `canvas_execute` 执行后写回画布，新增可选参数 `canvas_id`，工具描述补充新语义；③ `canvas_dispatch_skill` 的写回改用同一套 `result_patch`（多了 `agent_state` / `history`） |
| `server/app/canvas/persist.py`（新建） | 执行结果 → 节点数据补丁（`result_patch`）、`append_history`、`merge_results_into_nodes`、`persist_execution_results`（重读同一张画布 → 合并 → 按显式 canvas_id 保存） |
| `server/app/api/canvas_routes.py` | `/canvas/execute`（新增 `canvas_id`、`persist` 字段）与 `/projects/{id}/canvas/execute`（body 可带 `canvas_id` / `persist`）执行后同样写回；返回里多一个 `persisted` |
| `server/app/canvas/engine.py` | `execution_set()` / `upstream_needs_run()` / `static_outputs()`：指定 `target_ids` 时只执行目标 + 产出缺失的必要上游；上下文（取上游数据）仍是整张图。`collect_upstream_data` 的旧 `video`/`audio` 句柄和白名单兜底透传在来源本次没执行时读节点数据里的产出 |
| `server/app/canvas/agent_plan.py`、`server/app/core/config.py` | 智能规划 LLM 预算可配：`CANVAS_AGENT_PLAN_TIMEOUT_S`（环境变量 / `.env` / `config_store.json`），缺省 **90s**，合法范围 5–600，非法值回落 90；每次调用时读取。超时 / 失败仍降级规则规划；日志带上实际预算和异常类名 |
| `server/app/providers/image/comfyui.py` | `safe_negative_prompt()`：负向词为空用 `DEFAULT_NEGATIVE`，再补齐缺失的 `nsfw, nude, nudity, sexual, explicit`（按逗号分词、忽略大小写与 `(词:权重)`），用户自己的词原样保留。内置简易工作流和自定义工作流注入两处都用它 |
| `server/tests/test_canvas_fx_b.py`（新建） | 48 条 |
| `server/tests/test_ext_node_inputs.py` | `test_dag_uses_regenerated_upstream_not_stale_node_data` 按新语义调整（见「行为变化」） |

## 1. 文本流式接口（COORDINATION 第 14 条）

`POST /api/v1/llm/generate/stream`，请求体 `{prompt, skill?, system?, images?}`。

- `skill` 缺省 `free_generation`。系统提示与非流式完全同一份：
  - `free_generation`：`FREE_GEN_SYSTEM`；
  - `proposal_generation`：`PROPOSAL_SYSTEM`；
  - `prompt_expansion`：与 `/llm/expand` 相同的扩写提示（kind=image，max_tokens 600）。
- `system` 只在显式传入时覆盖。`images` 同 `/llm/generate`：地址附在提示词后（扩写不用）。
- 响应 `text/event-stream`：
  - 每个增量 `data: {"delta":"…"}`；
  - 结束 `data: {"done":true,"text":"<完整文本，已 trim>"}`；
  - 出错 `data: {"error":"…"}` 后结束，不发 done。
- 上游不支持流式时（返回非 SSE，或流式请求报错）退化为一次性调用：一条 delta + done。
- **给 FX-F 的注意事项**
  - 参数错误也按 SSE 的 `error` 事件返回，HTTP 状态码是 200。包括空 prompt，以及 `script_generation` 等不支持的技能。只有缺 `prompt` 字段时是 FastAPI 的 422。
  - 中途断流时，已经发出的 delta 作废，请按 error 处理。
  - 第一个 delta 可能来得很晚。实测本网关的 qwen3.8 先思考，首个增量约 **74s** 后才到，之后 2 秒内吐完。前端不要设过短的超时，「生成中」状态要一直保持到首个 delta。
  - 首个 delta 可能带前导换行。done 的 text 已 trim。

## 2. 视频 mode 推断（第 15 条）

`infer_video_mode(arguments)`：

- **显式 mode**：
  - `i2v` / `r2v` / `t2v` 原样保留，不区分大小写；
  - 新参考模式名换算：`singleImage` / `startEnd` → i2v，`multiReference` → r2v，`text` → t2v；
  - 未知值原样下发。
- **缺省时按入参推断**：
  - 有 `first_frame` / `first_frame_url` → i2v；
  - 只有 `reference_images`（或 `reference_image` / `reference_video` / `reference_videos`）→ r2v；
  - 否则 t2v。

## 3. canvas_execute 结果写回（第 16 条，E2E-3 D5）

写回口径与前端一致：kit/useGeneration、executeRouter.runTextSkill、patchFromPayload。

**媒体节点**（image / video / audio，以及产出媒体的 custom / ext-node）：
- 写 `image_url`（同时写 `result_url`）/ `video_url` / `audio_url`。
- `history` 最前插入 `{url, created_at, provider_id?, prompt?, params?}`：
  - 按 url 去重，最多 20 条；
  - `created_at` 用前端 `toISOString` 的格式；
  - `prompt` 取节点自身提示词，音频取 `text`；
  - `params` 取 `data.params`。

**视频源只返回 task_id、还没出片时**：
- 写 `_taskId`、`_polling: true`，`agent_state` 为 running；
- 节点挂载后由 N3 的 useTaskRecovery 续轮询。

**文本节点**：
- 只有真正执行了技能（结果带 `skill_id`）才写回 `text` / `prompt`（同值），以及 `script_data`。
- 原样透传的结果不改节点。

**3D 导演**：写 `camera_prompt` / `minimax_camera_prompt`（结果里有才写）。

**不写回的节点**：load-* / asset / brief / provider* / group。

**agent_state**：
- 成功：`{status: completed, tool: 'canvas_execute', provider_id?, elapsed_ms?, updated_at}`；
- 失败：`{status: failed, error}`。

**保存**：
- 执行可能要几分钟，期间前端可能已自动保存，所以执行完**重读同一张画布**，按节点 id 合并后再按该 canvas_id 保存。
- 画布 id 的来源：MCP 是参数 `canvas_id`，缺省为读出来的那张（即执行时的激活画布）。
- 画布里已不存在的节点跳过。`schema_version`、`viewport`、`name` 保留。
- 写回失败只记日志、在 `persisted.reason` 里说明，不影响执行结果。

**返回**：多了 `persisted: {persisted, canvas_id, updated_nodes[, reason]}`。

**前端**：Agent 调任何 `canvas_*` 工具后，前端本来就会重载画布（`agent-canvas-updated`），不用再监听 `agent-canvas-tool`。

**提醒**：`save_canvas` 的既有行为会把 `active_canvas_id` 设成被写的那张画布，与其他 `canvas_*` 工具一致。

## 4. 不重跑兄弟节点（第 16 条，E2E-3 高优先级发现）

- **原来的闭包**：目标的上游祖先，加上整个闭包的全部下游。所以执行视频 V 时，共享上游文本的另一个图片节点也会被重跑。
- **现在的 `execution_set`**：目标 + 逐级向上找出的「必须先执行才有数据」的上游。判断规则：
  - provider* 配置节点：只读数据，不执行；
  - 参考边（in 口 / 生成节点的旧具名口）：按 `inputs.source_kind` / `source_values` 看节点数据里有没有这条参考的值，有就不执行；
  - 其余边：按来源类型的产出键看节点数据。类型未知时（custom / ext-node / script-split…）执行，与修复前一致。
- 祖先的其他下游、目标自己的下游都**不执行**。`target_ids` 为空时仍执行全图，行为不变。
- **行为变化**：
  - 已有产出的上游不会再被连带重新生成。要重新生成上游，就把它也放进 `target_ids`。
  - `test_ext_node_inputs::test_dag_uses_regenerated_upstream_not_stale_node_data` 原本断言「只指定 ext 也会重跑上游视频」。现在改为指定 `["gen","ext"]` 验证「用本次新产出、不用旧传播值」，并补充断言：只指定 `["ext"]` 时上游不执行、读它已有的产出。
  - `canvas_dispatch_skill`（`target_ids=[nid]`）也随之不再执行该节点的下游。原来下游会被执行，但结果直接丢弃。

## 5. 智能规划预算（E2E-2 B5）

- `CANVAS_AGENT_PLAN_TIMEOUT_S` 缺省 90s。
- 本网关首 token 实测约 74s，90s 仍可能偏紧。如果仍频繁降级，可在 `.env` 或 `config_store.json` 里调到 120–180。值在后端启动时从环境变量 / `.env` / `config_store.json` 读入，改完需重启 8001。
- `LLM_TOTAL_TIMEOUT_S` 若设置，会另外限制 `chat_completion` 内部流式的总时限（既有行为），本环境没有设置。

## 6. ComfyUI 内容安全（E2E-3 其他发现 2）

- 只补负向词，没有做中文提示词英文化。英文化可以靠智能规划或扩写来做。
- 实测：内置工作流 PNG 内嵌 prompt 的节点 7（负向）为 `lowres, …, jpeg artifacts, nsfw, nude, nudity, sexual, explicit`。

## 验证

**单测**
- `~/project/ads/dwq147-src/.venv/bin/python -m pytest -q server/tests`：**735 passed、4 skipped、1 failed**。失败的是既有的 `test_skill_engine::test_default_scan_stays_inside_project`（基线 687 passed，新增 48 条）。
- 跑测试前后 `git status storage` 一致。

**新增用例**（`test_canvas_fx_b.py`）
- **流式**：上游用 `httpx.MockTransport` 模拟 OpenAI 兼容 SSE，覆盖：
  - delta / done 顺序，思考标签被剥离；
  - 请求带 `stream: true`，messages 与非流式同一份；
  - 三个技能各自的系统提示，以及显式 `system` 覆盖；
  - 上游无视 stream 回 JSON → 退化一次性（第二次请求不带 stream）；
  - 流式端点 404 → 退化；
  - 上游 500 → error 事件；
  - 中途断流 → delta 之后 error、不发 done；
  - 空 prompt / 不支持的技能 → error 事件；
  - 扩写 1200 字截断。
- **mode**：`infer_video_mode` 12 种入参组合；经 MCP `provider_*` 工具实际传给注册表的 `req.mode`（多参考 → r2v、首帧 → i2v、纯文本 → t2v、显式保留）。
- **兄弟节点**：
  - 图为 t → A → V、t → V、t → S（兄弟）、V → D（下游）。执行 `["V"]` 时，provider 调用计数为 fakeimg = 1（只有缺首帧的 A）、fakevid = 1（只有 V），S、D 都不执行；
  - A 已有产出时 fakeimg = 0，V 的首帧用 A 已有的图，文本参考照常组装；
  - 不传 target 时全图执行；
  - `execution_set` 单测；
  - 旧 `video` 句柄能读到未执行来源的数据。
- **写回**：
  - `result_patch` 覆盖各类型、去重与 20 条上限、失败、待轮询视频、被动节点、3D 导演；
  - 真实落盘（临时 PROJECTS_ROOT）：
    - MCP `canvas_execute` 写进非默认画布 c2，default 不动，`schema_version` / `viewport` / `name` 保留；
    - 执行期间并发新增的节点没被覆盖；
    - 激活画布切走后，显式 `canvas_id` 仍写 c2；
    - `/canvas/execute`、`/projects/{id}/canvas/execute` 都会写回；`persist: false` 不写。
- **规划预算**：缺省 90，env 120 / 非法 / 0 / 1 / 9999 的取值；`plan_node_agent` 把预算传给 LLM，LLM 失败时降级规则规划。
- **ComfyUI**：`safe_negative_prompt` 的补齐与保留；内置工作流实际提交的节点 7 负向词含全部安全词（MockTransport 截获 `/prompt`）。

**集成实例 8001**（已按要求重启，跑的是本 worktree 的代码；日志在 scratchpad 的 `canvas-backend.log`）
- `curl -N` 自由生成：首个 delta 约 74s 后到达，之后 2.2s 内收到 67 个增量，最后一条 done 是完整的三句旁白。响应头为 `text/event-stream`，CORS 回了 `Access-Control-Allow-Origin: http://127.0.0.1:5180`。
- `curl -N` 扩写：29s，115 个增量，done 是英文逗号短语。
- `script_generation` 请求得到 error 事件。
- **画布写回**：临时项目 `proj_0ed35a81`，画布 `cv_fxb`（schema_version 2 + viewport），激活画布先切到 default。
  - 图：文本 t → 图片 A（comfyui，无产出）→ 视频 V（comfyui_video，A 作首帧）；t → V；t → 兄弟图片 S（comfyui，无产出）。
  - 执行 MCP `canvas_execute {canvas_id: cv_fxb, target_ids: [V]}`：
    - order 为 `[A, V]`，S 没执行；
    - A 走真实 ComfyUI，用时 37.8s；V 走 mock，用时 0.5s；
    - `persisted = {persisted: true, canvas_id: cv_fxb, updated_nodes: [A, V]}`。
  - 落盘结果：
    - A、V 都有产出键、`agent_state.completed` 和 1 条 history；
    - S、t 没有变化；default 仍为空；
    - `schema_version` / `viewport` / `name` 保留。
  - 出图 PNG 内嵌的负向词含 5 个安全词。
- **B8 复现**：`provider_comfyui_video {prompt, reference_images: [2 张]}`，不带 mode，返回 success（原来报「图生视频模式需要 first_frame_url」）。

**清理**
- 已删除临时项目，以及 `generated/gen_1792072315_04d1829f.png`、`videos/mock_543af332.mp4`、`videos/mock_db4898bc.mp4`。
- 重启后第一次列素材时（21:52:46，由前端触发；每个进程只扫一次），悬空素材清理删掉了 4 条文件缺失的记录：`ast_1a09171c`、`ast_4607892e`、`ast_eb4bd475`、`ast_f9459978`，并改写了 `.missing_backup.jsonl`。已按重启前的快照还原，`storage/assets` 与快照逐文件一致。本进程不会再扫，下次重启还会再扫一次。
- `projects/index.json` 与测试前一致，`git status storage` 与开工前一致。

## 遗留 / 提醒

- **前端（FX-F）**：
  - 接入流式接口时，注意上面「给 FX-F 的注意事项」，尤其是首 token 慢、参数错误也走 SSE error。
  - 后端已能推断 mode，但 B8 前端丢 `mode` 的问题仍建议在 `buildAgentArgs` 放行。原因是用户在多参考 / 首尾帧里的显式选择只能由前端带下来，后端推断只覆盖缺省情况。
- 写回会把 `active_canvas_id` 改成被写的画布（`save_canvas` 既有行为）。用户在 UI 里看另一张画布时，前端以自己的 canvasId 为准，不受影响。
- 智能规划在本网关上仍可能超过 90s（首 token 约 74s，规划请求的系统提示更长），必要时按上文调大 `CANVAS_AGENT_PLAN_TIMEOUT_S`。
