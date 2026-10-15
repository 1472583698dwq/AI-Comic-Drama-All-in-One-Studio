# FX-F 前端 E2E 修复（C5 / B8 / D2 / D1 / D4 / B1 流式 + 小项）

状态：完成（未提交）。worktree `~/project/ads/dwq147-src-canvas`（HEAD 957929e），只改了 `client/**`。
后端由 FX-B 同期改（`/llm/generate/stream`、视频 mode 推断、`canvas_execute` 写回）；8001、5180 我没重启、没停。
截图：`e2e/FX-F/`。

## 汇总

| 项 | 结果 | 改了哪里 | 浏览器复验 |
|---|---|---|---|
| C5 custom 空提示词被拦 | 已修 | `hooks/nodeAgentExecutor.ts` | 只连视频、不填提示词点「运行节点」：发出 `/custom-nodes/run {inputs:{video}}`，出视频，没有「提示词为空」 |
| B8 多参考丢 `mode` | 已修 | `hooks/nodeAgentExecutor.ts` | comfyui_video + 两张参考图（多参考·自动）：MCP 入参带 `mode:"r2v"`，出片 |
| D2 换源残留 model | 已修 | `nodes2/legacy-b/inputs.ts` | 生图源先选 `comfyui_wf_4a19b2a2`（下游 model=krea2…），再切 `comfyui`：下游 `model` 键被删 |
| D1 分组里高亮边压面板 | 已修 | `host/canvasChrome.tsx` | 分组内两个节点，选中图片生成：边的 svg z=1000、节点 z=1000；边穿过面板的 162 个采样点，最上层都不是边 |
| D4 在画布中运行不回写 | 已修 | `host/executeRouter.ts`、新增 `host/shotAutoRun.ts`、`CreativeCanvas.tsx` | proj_55f08230 分镜 #1（首帧 + comfyui_video）自动运行：出片后分镜 `video_url` 自动写成 mock 视频、status=completed |
| B1 文本流式 | 已做 | 新增 `host/textStream.ts`，改 `host/executeRouter.ts`、`nodes2/text/*` | 自由生成：首个增量 26.6 秒到，之后正文边生成边增长；中途点「停止生成」保留已生成的 157 字、状态 idle；网关超时时显示错误、正文不动 |
| AI 润色浮钮滞留 | 已修 | `components/ui/GlobalAiPolish.tsx` | 文本弹窗原文里输入时浮钮出现，Esc 关弹窗后消失；标题改名回车后消失 |
| 画布下拉节点数不实时 | 已修 | `CreativeCanvas.tsx` | 加节点后下拉立即显示（1/3/4/5 节点） |
| 小地图挡发送键 | 已修 | 新增 `host/AutoHideMiniMap.tsx`、`host/host.css` | 选中节点的面板和小地图相交时小地图淡出、不拦鼠标，发送键可点；取消选中后恢复 |
| 3D 导演导出缺 asset_id | 已修 | `nodes2/director3d/{exportMedia,Director3DNode,model}.ts` | 单测覆盖（没在浏览器重录 MP4） |
| 音频波形 dev 跨域失败 | 已修 | `nodes2/audio/waveform.ts` | 波形两层 canvas 都有像素；复现对照：`<audio>` 预取后旧写法 `fetch(url)` 报 Failed to fetch，新写法 200 |
| 迁移去重叠时机过早 | 已修 | 新增 `host/settleLayout.ts`、`CreativeCanvas.tsx` | 旧画布打开：视频卡 242ms 时从 200 长到 290，去重叠在 655ms（媒体加载完、尺寸稳定后）执行，下方节点 300→336 |
| D5（协调人追加） | 已复验 | 无前端改动 | proj_1ed508e1 测试画布：MCP `canvas_execute(target_ids=[视频])` 后发 `agent-canvas-updated`，节点显示视频；存盘有 `video_url`、`agent_state.completed`、`history` 1 条，只执行了目标节点 |

验证：`cd client && npx tsc -b` 0 错；`npx vitest run` **57 个文件、621 / 621** 全绿（开工时 53 / 581）。
新增或改动的关键单测在修复前的代码上会失败（反向验证过：C5 / B8 6 条、D1 1 条、D2 2 条）。

---

## 逐项说明

### C5：custom 节点空提示词被拦（E2E-1 F1）
- **根因**：`executeAgentNode` 一开头就查提示词，只豁免了 director3d / export / timeline，custom 分支在后面，走不到。
- **改法**：
  - 新增 `PROMPT_OPTIONAL_TYPES`（custom、ext-node、export、timeline、timeline-export、director3d、script-split、brief、shot-card、comfy-workflow），这些类型不做「提示词为空」检查。图片 / 视频 / 音频生成照旧要提示词。
  - custom 是否必填，按代码节点自己的 `input_schema.required` / `params_schema.required` 判断（`missingRequiredInputs`）。缺了就报「缺少必填输入：输入视频（video）」，并写 `agent_state.failed`，不发请求。
- **单测**：只连视频能跑；required 缺失时报错且不发请求；params 的 required 也校验；豁免表与媒体节点仍拦。

### B8：多参考没带 `mode`（E2E-2）
- **根因**：`buildAgentArgs` 只放行生成源声明过的键，comfyui_video 没声明 `mode`，kit 组装的 `providerMode=r2v` 被丢，后端缺省按 i2v 要首帧。
- **改法**（COORDINATION 15）：`buildAgentArgs` 加 `opts.nodeType`。视频节点放行**本次 override** 的 `mode`。
  - 界面模式名按第 3 条映射：singleImage / startEnd → i2v，multiReference → r2v，text → t2v。
  - 认不出的值不放行；节点 data 里的界面模式名不会被当成 mode 下发。
  - 非视频节点行为不变。
- **单测**：放行与映射；图片节点不放行；`executeAgentNode` 实际下发 `mode:r2v`。
- 后端 FX-B 也加了缺 mode 时的推断，两边任一处都能兜住。

### D2：生成源换源后下游残留旧 model（E2E-1）
- **改法**：`providerPatchFor` 总是带 `model` 键，新源没有 model 时值是 `undefined`。宿主合并补丁时遇到 undefined 会删键，下游的旧 model 就被删掉了。下游本来就没有 model 时不会产生多余的补丁。
- **单测**：`inputs.test`（键存在且为 undefined）、`propagation.test`（分镜卡 / 图片生成的旧 model 被删，干净的下游没有补丁）。

### D1：分组里选中节点，高亮边压在它的面板上（E2E-1）
- **根因**：高亮边设了 `zIndex: 1`。@xyflow/system 的 `getElevatedEdgeZIndex` 对端点带 `parentId` 的边，会再加上子节点的 `internals.z`（选中的子节点是 1000），结果是 1001，比节点的 1000 高。
- **改法**：`renderEdges` 只给两端都是顶层节点的高亮边抬层。端点在分组里的边保持 0，这时边和节点同为 1000，节点容器在 DOM 里排在边容器后面，面板 / 工具栏就在边上面。高亮颜色（`cv-edge-active`）不变。
- **单测**：直接调用 React Flow 自己的 `getElevatedEdgeZIndex` 核对：修复后 ≤1000；旧写法是 1001。
- **浏览器**：用 API 建了一张测试画布，分组里放文本和图片生成，文本在面板左下方，连线正好穿过面板。截图 `27-D1-nested-selected.jpg`。分组节点连顶层节点的情况也查了，同样在面板下面（`25-D1-edge-under-panel.jpg`）。

### D4：分镜「在画布中运行」出片后不回写（E2E-3）
- **改法**：
  - `createExecuteRouter` 的 `execute` 改为返回 `ExecuteResult`：媒体生成带产物 `{url}`，文本技能带 `{text}`，custom 带产物 url。
  - kit `CanvasHost.execute` 的类型放宽成 `Promise<unknown> | void`。节点侧 `useKitNodeActions.execute` 仍然丢弃返回值，行为不变。
  - 自动运行逻辑抽成 `host/shotAutoRun.ts` 的 `autoRunShotSubgraph`：3D 导演 → 视频 → 用 execute 返回的 url 回写分镜。返回值里没有 url 时，等 120ms 再从画布读一次。只有真失败才报错：生成失败报 error，回写失败报 warning，确实没出结果报 warning。原来那条「视频未自动产出」的 info 去掉了。
- **单测**：`shotAutoRun.test.ts` 4 条（execute 返回 url 时回写，此时 nodesRef 还是旧数据；导演失败不影响后续；兜底读节点；只有真失败才报错）。`executeRouter.test` 另有 1 条：execute 返回 url。
- **浏览器**：在 proj_55f08230 派发 `canvas-import-shot`，分镜 #1 带首帧 + comfyui_video，新建画布并自动运行。截图 `90-D4-after-run.jpg`。
  - 依次调了 `director_3d_stage_plan` → `provider_comfyui_video`；
  - 分镜 `video_url = /storage/videos/mock_e4cdc607.mp4`、`status = completed`，已经存进 content。

### B1：文本节点流式生成（E2E-2；design §6.1）
- **接口**：`POST /api/v1/llm/generate/stream`（COORDINATION 14）。
  - 请求体是 `{prompt, skill, images?}`，`images` 只有自由生成才带。不传 `system`，由后端按 skill 选系统提示。
  - 剧本拆解不走流式（仍是 parseScript）。
- **`host/textStream.ts`**：负责解析 SSE。
  - 能处理事件被拆在任意分块里、CRLF 换行、中文多字节被截断。
  - 以 `done.text` 为准；`error` 事件按失败处理（后端对无效输入返回 HTTP 200 + error 事件）；没收到 done 就断开也算失败。
  - 404 / 405 时抛 `StreamUnavailableError`，路由据此退回一次性接口（`/llm/generate`、`/llm/expand`）。
  - 代理把流缓冲成 JSON 时，按 `{text}` 处理。
  - **不设客户端超时**：网关首字可能要等 70–80 秒。
- **`executeRouter.runTextSkill`**：
  - 增量按 80ms 节流，`text` / `prompt` 同时写回；第一次写回时给 `agent_state` 加 `streaming:true`；`done` 时写入最终全文（trim）并标记 completed。
  - **出错**：如果流式已经改写过正文，就还原成执行前的正文，同时写 failed 并 reject。
  - **停止**：`overrides.signal`（AbortSignal）中止时保留已生成的部分，状态设为 idle，正常 resolve。
  - `signal` 在路由入口就剥掉，不会进任何请求体，也不会交给其他分支。
- **文本节点（`TextNode.tsx` / `text.css` / `skills.ts`）**：
  - 流式技能（自由生成 / 扩写 / 策划案）发送时创建 AbortController，发送键变成「停止生成」。
  - 首个增量到之前，整块显示「等待模型响应…」（卡片和面板页脚都显示）。
  - `streaming` 后不再盖住整块，正文边生成边显示、自动滚到底，左下角显示「生成中…」小角标。
  - 剧本拆解保持原来的整块转圈，不能停止。节点卸载时会中止本节点发起的请求。
- **单测**：
  - `textStream.test.ts` 5 条；
  - `executeRouter.test` 的流式部分：增量写入与 streaming 标记、80ms 节流、同一时刻到达的增量合并写、error 还原正文、断流、停止保留已生成部分且 signal 不进请求体、HTTP 失败、404 退回、策划案 / 扩写走流式与退回；
  - `TextNode.test` 2 条：streaming 时的显示；停止键与 signal（剧本拆解不传）。
- **浏览器**（网关是 8787 上的 qwen，时快时慢）：
  - **第 1 次**：发出请求后 41 秒内，正文出现 57 个不同长度（逐步增长），请求体是 `{"prompt":…,"skill":"free_generation"}`。
  - **第 2、3 次**：网关 ReadTimeout（120s / 215s）。节点按 error 事件显示红色错误，正文保持原样，状态 failed。
  - **等待阶段点停止**：请求 `net::ERR_ABORTED`，状态 idle，正文不变，没有错误提示。
  - **最后 1 次**：26.6 秒到首个增量，流式增长到 143 字时点停止。存盘正文 157 字（Markdown 原文），状态 idle。
  - 截图：`05-waiting-first-delta.jpg`、`06a-streaming-early.jpg`、`06b-streaming-before-stop.jpg`、`07-after-stop.jpg`。

### 小项
- **GlobalAiPolish**：
  - 聚焦期间每帧检查一次锚点：输入框被卸载（`!isConnected`，Chrome 卸载聚焦元素时不发 focusout）就隐藏；尺寸为 0 时暂时隐藏；位置变了（画布平移是 transform，不触发 scroll）就跟着走。
  - 焦点离开文本框时隐藏，润色中除外。
- **画布下拉节点数**：载入完成后，当前画布的 `node_count` 跟着 `nodes.length` 实时更新（管理弹窗用的是同一份列表）。
- **小地图**：`AutoHideMiniMap` 包了一层 MiniMap。选中节点的卡片和上下浮层（`.cv-node__slot`）与小地图相交（外扩 8px）时，加 `cv-minimap--away`（透明度 0、不拦鼠标）。
  - 视口变化、选中变化、选中节点移动 / 改尺寸时重新判断；浮层晚到时 300ms 后再补测一次。
  - 没有选中节点时总是显示。
- **3D 导演导出**：
  - `uploadStageBlob` / `uploadStageVideo` 改为返回 `{url, assetId}`（兼容 `{id}` 和 `{asset:{id}}` 两种返回）。WebM 转码后登记素材时也带回 id。
  - 新建的图片 / 视频节点带 `asset_id`。
  - 导演节点记录 `image_asset_id` / `video_asset_id`，并写 `_saved_asset`（`exportSavedPatch`）。宿主取导演产出时先取图片，所以导出视频时如果已有图片，沿用图片那份。
- **波形**：`decodeWaveform` 改成 `fetch(url, {mode:'cors', cache:'no-store'})`，绕开 `<audio>` 以 no-cors 预取后留在缓存里、没有 ACAO 的那份响应。
  - 没给 `<audio>` 加 `crossOrigin`：外部 CDN 地址如果不带 CORS，加了反而放不了。
  - 解码结果仍按 URL 缓存在内存里。
- **去重叠时机**：`useSettledRun` 等到两个条件都满足才执行 `resolveOverlaps`：画布里的 `<img>` 加载完、`<video>` 拿到元数据（出错或没地址的不算在内），且顶层节点的测量尺寸连续 400ms 不变。最长等 6 秒。
  - 挪动过节点才会重新适应视图。
  - 切画布时取消等待。
  - 单测 5 条。

## 文件

- **修改**：
  - `canvas/CreativeCanvas.tsx`
  - `canvas/hooks/nodeAgentExecutor.ts`
  - `canvas/host/{canvasChrome.tsx, executeRouter.ts, host.css, useCanvasHost.tsx}`
  - `canvas/kit/hostContext.tsx`（只放宽了 `execute` 返回类型）
  - `canvas/nodes2/audio/waveform.ts`
  - `canvas/nodes2/director3d/{Director3DNode.tsx, exportMedia.ts, model.ts}`
  - `canvas/nodes2/legacy-b/inputs.ts`
  - `canvas/nodes2/text/{TextNode.tsx, skills.ts, text.css}`
  - `components/ui/GlobalAiPolish.tsx`
- **新增**：
  - `canvas/host/{textStream.ts, shotAutoRun.ts, settleLayout.ts, AutoHideMiniMap.tsx}`
  - 测试 `canvas/host/__tests__/{textStream, shotAutoRun, settleLayout, autoHideMiniMap}.test.ts`
- **测试改动**：`host/__tests__/{executeRouter, executorFixes, hostRender, propagation}`、`nodes2/legacy-b/__tests__/inputs`、`nodes2/text/__tests__/TextNode`、`nodes2/director3d/__tests__/{exportMedia, render}`。
- oxlint：0 错。新增的 warning 与 kit 同类（latest-ref 写法、组件文件导出纯函数）。

## 清理

- **项目文件**：proj_338535d7、proj_55f08230、proj_1ed508e1 的 `canvas.json`、`content.json`、`agent_sessions.json` 已按测试前快照逐字节还原。测试画布 `cv_fxfd1`、`cv_fxfb8`、`cv_fxfau`、`cv_fxfov`、`cv_fxfd5` 和 D4 自动建的「FXF-D4」画布随之删除。
- **canvas_backups**：
  - proj_338535d7 原来没有这个目录，迁移测试新建的 `cv_fxfov` 备份已连目录一起删掉；
  - proj_1ed508e1 的备份目录与测试前一致。
- **projects/index.json**：只把这 3 个项目的条目还原成快照值，其他条目没动。
- **素材**：通过 `DELETE /assets` 删了 ast_d58769de（测试视频）、ast_d4ec1f7f（测试 wav）、ast_33da6bbe（竖屏视频）。
- **生成文件**：删了 `storage/videos/mock_{276d02ec,e4cdc607,15266a90}.mp4`（B8 / D4 / D5 的产物）。
- **插件与开关**：
  - example-drama-pack 已停用并卸载，`plugins/index.json`、`extensions/state.json` 与测试前一致；
  - `canvas_custom_nodes` 已关回去；开关第一次被改时后端才创建了 `storage/features.json`，已删除（全部回到出厂默认）。
- **核对**：`git status --short storage` 与开工时逐行一致。
  - 期间 `generated/gen_1792072315_04d1829f.png`、`videos/mock_543af332.mp4` 消失了，这不是我删的（应是其他 agent 清理自己的产物）。
- **进程**：我自起的 headless Chromium 和驱动脚本已退出；8001 / 5180 没动。
- 驱动脚本和原始截图在会话 scratchpad 的 `fxf/` 下。

## 留给协调人 / 其他观察

1. **LLM 网关不稳**：同一时段首字 26–80 秒，有两次 120s / 215s 超时（后端报「大模型流式响应超时」）。流式和停止都已实测通过；超时属于环境问题。
2. **custom 节点出图后变高，盖住下方节点**（`14-custom-ran.jpg`）：既有的摆放问题，与本次修复无关。
3. **B8 面板显示 `9:16`，但 MCP 入参没有 aspect_ratio / duration**：节点 `params` 为空时，面板显示的是缺省值、不下发。这是既有行为，后端用自己的缺省值。如果希望「显示什么就发什么」，需要在节点侧把缺省值写进 params（N3 范围）。
4. **控制台 warning**：React Flow 报「created a new nodeTypes object」。原因是 `CreativeCanvas` 的 nodeTypes 随未知类型集合变化重建，既有问题，不影响功能。
