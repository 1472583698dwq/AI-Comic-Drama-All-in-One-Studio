# H1 宿主集成待办汇总（协调人从各任务 progress 归集，H1 逐条落实并在 H1.md 回填结果）

## 来自 T1（kit）
- `<ReactFlow className="cv-canvas" colorMode={应用主题}>`；`nodeTypes={nodeTypesMap()}`；`isValidConnection = isValidConnectionFactory(rf.getNode, getNodeDef, {getEdges})`，动态端口节点用 N7 的 `resolveDynamicPorts`。
- 边：`simplebezier`；吸附 16；缩放 0.2–8；点阵背景 `--cv-border` on `--cv-canvas-bg`；与选中/拖动节点相连的边加 `cv-edge-active`；32px 断开按钮由宿主渲染（`.cv-edge-disconnect`）。
- `CanvasHostProvider` 提供 `updateNodeData`（含向下游传播）、`saveToAssets`、`openFullscreen`、`execute`、`createNodes`、`navigate`、`projectId`、`removeEdge`、`rename`、`duplicate`、`copy`、`remove`。
- NodeSkeleton 自带右键菜单并阻止冒泡；宿主菜单要保留就传 `contextMenu={false}`。
- `<SelectionToolbar/>` 放进 `<ReactFlow>`；`onNodeDragStop` 调 `reparentOnDrop`（拖入/拖出分组）。
- 端口变化时 NodeSkeleton 不会自动删悬空边（防误删），宿主按需清理。

## 来自 T4/T5（迁移与后端）
- 加载画布：`migrateCanvas(raw)`；`changed` 时第一次保存前 `mediaOps.backupCanvas(projectId, canvasId, raw)`；保存带 `schema_version: 2`（后端已保留该字段）。
- 前端 `assembleInputs` 与后端 `inputs.py` 规则一致（已对齐，共用用例）。

## 来自 N1（文本节点）
- `execute(overrides)` 对 `prompt` 类型按 `overrides.skill_id` 路由：扩写 / 剧本拆解 / 策划案走原分支；新增 `free_generation`（目前无通用 LLM 接口：先把组装好的指令写进文档，或接一个通用 LLM 生成接口——优先找后端现有 `/llm/*` 能力）。
- `execute` 失败时要 **reject**（现在 alert 后 resolve，节点会显示成功）。
- 策划案分支写 `text` 与 `prompt` 不一致，统一成同一内容。
- 结果补丁不要把 `agent_state`、`script_data` 复制到下游。
- 后端 `canvas_execute` 对文本节点用文档当技能输入，不是 `gen_prompt`（记录，按需对齐）。

## 来自 N3（视频节点）
- `nodes2/index.ts` 引入各节点目录。
- 加载画布时**不要复位**视频节点的 `_polling`/`_taskId`（否则刷新后不能自动恢复轮询）。
- **最高优先**：旧 `handleNodeUpdate` 把补丁里所有非产出键原样拷给下游；必须收窄为只传产出值（按源端口 dataType 的值），`history`、`params`、`refRoles`、`agent_state` 等一律不下发。存量里视频节点上的错误 `url` 就是这么来的。
- `createNodes` 按传入坐标放置、尊重 `select:false`。
- 带 `asset_id` 的媒体已在素材库，「保存到素材库」置灰或复用。

## 来自 N7（独有节点 B）
- `resolveDynamicPorts(node)`、`edgeInputPatch`（连线时）、`collectDynamicInputs`（上游产出变化时）把值写到声明端口 id；`providerPatchFor` 下发生成源；`providerKindMatches` 拦截错类生成源；`registerCustomNodeDefs` 在宿主刷新代码节点列表时调用。
- `script-split`：后端返回 `{project}`，宿主要写 `result: rr.project`，否则拆解结果不显示。
- 后端插件节点输入 bug 已派 T6 修复。

## 来自 N6（独有节点 A）
- 生成源节点连到 `shot-card` 时，继续把 `provider_id`/`provider`/`model` 写进 shot-card（同旧宿主）。
- App.tsx 里 `open-export-modal`、`open-workflow-inspector` 事件监听保持不变（导出中心、工作流检查器靠它打开）。
- `ShotWriteBackControls` 已移植到 `nodes2/legacy-a/ShotWriteBackControl.tsx`；删除旧 `nodes/` 后，custom/ext-node 及节点控制台改从这里引入。
- 时间线全屏编辑器、素材选择弹窗仍是旧样式（宿主文件），可在 H1 顺带换成 `--cv-*` 变量。

## 来自 N4（音频节点）
- 引入 `./nodes2/audio` 即注册两个节点；`load-audio` 上传后带 `data.asset_id`，「保存到素材库」对其置灰或复用。
- 宿主真实 `createNodes` 采用 Toonflow 式摆放（新节点放锚点右侧、纵向间隔 48、用实测尺寸），参考 `nodes2/audio/__dev__/AudioShowcase.tsx`。
- 音频提示词规则已改（协调人决定，前后端同步）：音频不加「参考 N：」前缀，自身有台词只念台词。

## 来自 N2（图片节点）
- 引入 `./nodes2/image`；图片上传走项目素材库（`setImageUploader` 可替换上传通道）。
- **执行器 `hooks/nodeAgentExecutor.ts` 两处要修**：①节点里保存的 `params` 会覆盖本次传入的参数（本次 override 应优先）；②`patchFromPayload` 每次生成后把 `aspect_ratio` 改写成像素比（如 `832:1216`），后端随后又读它——改成单独字段（如 `result_aspect`），不要覆盖用户选的比例。
- 宿主 `createNodes` 实现 `connectTo`（新节点主输出连进当前节点 `in`，角色一致性绑定三视图用），坐标按绝对坐标处理（锚点在分组内时换算成相对父级）。
- 局部重绘贴回原图后的保存目前借用 1×1 `gridSplit`；后续可加一个正式的「保存图片」后端接口（可选）。

## 来自 N5（3D 导演）
- 引入 `./nodes2/director3d`。
- 宿主 `navigate('director3d', {nodeId, shotId?, shotPatch, stage})` 的实现：有 `shotId` 时 `setActiveShotId(shotId)`，可选 `updateShot(shotId, shotPatch)`，再 `setActiveTab('director3d')`；没有 shotId 时只切页（3D 片场页目前只认 activeShotId）。
- 文本节点等对 `execute` 失败要 reject；director3d 的 AI 规划依赖宿主 `director_3d_stage_plan` 分支把结果写回。

## 来自 K1（kit 修复，进行中）
- 缩略图走 `resolveMediaUrl`；`stripStaleSlotKeys`；PromptPanel `sourceLabel`、告警分级；共享表单控件 `kit/ui/controls`。
- 另：`createNodeData` 不覆盖计算型标题；右键菜单忽略来自 portal 的事件；无产出时隐藏下载按钮。
