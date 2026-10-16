# REQ-toonflow-canvas · 无限画布原生移植 Toonflow 节点（设计）

> 分支 `feature/toonflow-canvas`（worktree `~/project/ads/dwq147-src-canvas`）。
> 调研结论与节点对照见 `~/project/drama/minimax-vs-toonflow-canvas.md`。
> Toonflow 源码参考：`~/project/drama/01-toonflow`（MIT），关键文件见文末附录。

## 1. 目标与已拍板的决定

把 Toonflow 的工作流画布用 React **原地替换**进 MiniMax Studio 的无限画布（`client/src/components/canvas/`）：

| 决定 | 内容 |
|---|---|
| 范围 | 一次做完 4 部分：①节点外壳、连线、分组、主题；②7 个核心节点用 Toonflow 交互重写；③MiniMax 独有节点统一换皮；④Toonflow 独有的素材编辑能力（局部重绘、标记、宫格切分、截帧、分离音轨、截取、变速、`{{ref N}}` 引用排序） |
| 路线 | 原地替换现有画布，不保留旧节点组件；交付在独立分支 |
| 样式 | 结构和交互照搬 Toonflow；颜色全部取 MiniMax 主题变量（跟随深浅色和插件主题）；图标用 `@tabler/icons-react` |
| 生成交互 | 照 Toonflow 的底部提示词面板；"模型"下拉换成 MiniMax 生成源；参数弹层用 MiniMax 的 `DynamicControl`（保留 Agent 可填徽标）；面板里加「智能规划」开关：开启时走 MiniMax `/canvas/agent/generate`（LLM 先规划技能、生成源和参数再生成），关闭时直接生成 |
| 3D 导演 | 合成一个节点：外壳用 Toonflow 的；节点内嵌精简 3D 舞台（复用 3D 片场的人偶、关节、预设代码），加 Toonflow 的运镜关键帧和导出 PNG/MP4；保留 MiniMax 原来输出的运镜提示词；一键跳到完整的 3D 片场页 |
| 旧画布 | 打开时自动迁移成新结构；第一次保存前先备份原画布 JSON |

## 2. 兼容策略（关键）

为了让后端执行器（`server/app/canvas/engine.py`）、画布 MCP 工具（`canvas_*`）、分镜⇄画布联动、插件节点继续工作：

1. **重合节点保留原类型 id**：`prompt`（文本）、`image`（图片生成）、`video`（视频生成）、`audio`（音频生成）、`director3d`、`load-image`（图片）、`load-video`（视频）、`load-audio`（音频）。新增 `group`（分组）。
2. **数据字段沿用 MiniMax 现有键**：`prompt`、`text`、`provider_id`、`model`、`params`、`image_url`、`video_url`、`audio_url`、`reference_images`、`first_frame`、`last_frame`、`camera_prompt`、`ref_audio`、`agent_state` 等不改名。新字段只做追加（见 §4）。
3. **被合并掉的旧类型迁移**（见 §7）：`text-prompt`→`prompt`、`video-legacy`→`video`、`tts`→`audio`、`asset`→按媒体类型转 `load-image/video/audio`、`load-image-batch`→多个 `load-image`、`brief` 和 `timeline-export` 保留但换皮。
4. 独有节点（`shot-card`、`comfy-workflow`、`timeline`、`export`、`script-split`、`brief`、`custom`、`ext-node`、`provider*`、`timeline-export`）保留类型和逻辑，只换外壳。

## 3. 节点框架 `client/src/components/canvas/kit/`

| 文件 | 职责 |
|---|---|
| `types.ts` | `DataType = 'STRING'|'IMAGE'|'VIDEO'|'AUDIO'|'*'`；`PortDef {id, type:'source'|'target', dataType: DataType|DataType[], label?}`；`NodeDef`（见下）；`RefItem`；`NodeOutputs` |
| `registry.ts` | `defineNode(def)` / `getNodeDef(type)` / `allNodeDefs()`；画布的 `nodeTypes`、工具栏、拖线菜单（按端口类型过滤）全部从这里生成 |
| `connection.ts` | `canConnect(srcPort, dstPort)`：两端类型有交集或含 `*`；`NodeDef.canConnect?` 可追加限制（如音频生成节点：图片+音频参考合计 ≤1） |
| `NodeSkeleton.tsx` | 统一外壳（见 §5） |
| `NodeHandles.tsx` | 端口渲染与磁吸 |
| `FloatingToolbar.tsx` / `PromptPanel.tsx` | 卡片上方工具栏、下方提示词面板（宽 660，可关闭） |
| `PromptInput.tsx` | tiptap 富文本输入：`{{ref N}}` 渲染成带缩略图的引用标签，可拖拽排序引用 |
| `RefList.tsx` / `useNodeReferences.ts` | 收集上游参考（按连线顺序，`data.refOrder` 可覆盖），产出有序 `RefItem[]` |
| `GroupNode.tsx` | 分组框；`SelectionToolbar.tsx` 框选后「成组」 |
| `theme.css` | 画布节点 CSS 变量（映射到 MiniMax 主题变量，见 §5） |

`NodeDef`：
```ts
interface NodeDef {
  type: string;                 // 节点类型 id（重合节点沿用旧 id）
  label: string;                // 默认标题
  icon: TablerIcon;
  category: 'text'|'image'|'video'|'audio'|'3d'|'output'|'tool'|'plugin';
  ports: PortDef[];             // 新节点：生成类只有一个 target 'in' + 一个 source
  defaultData?: () => Record<string, unknown>;
  component: React.ComponentType<NodeProps>;
  inPalette?: boolean;          // 是否出现在工具栏
  canConnect?(src: {node; port}, dst: PortDef, ctx): boolean;
  width?: number;               // 默认卡片宽
}
```

## 4. 输入模型：单一输入口 + 有序参考列表

- Toonflow 式：生成类节点只有一个输入口 `in`（接受多种类型），上游素材排成**有序参考列表**；提示词里 `{{ref N}}` 指向列表第 N 项（从 1 开始）。
- 新增数据字段：
  - `data.refOrder?: string[]`：用户拖拽后的顺序（元素为 `edgeKey = sourceId|sourceHandle`）。
  - `data.refRoles?: Record<edgeKey, Slot>`：显式槽位（`first_frame`、`last_frame`、`reference_images`、`camera_prompt`、`ref_audio`、`reference_video`），用于迁移旧画布和 Agent 指定槽位；未指定时按模式自动分配。
  - `data.mode?`：视频生成的参考模式（`text`、`singleImage`、`startEnd`、`multiReference`…），可选值由所选生成源的 `input_schema` 槽位决定；为空时按参考数量自动匹配（同 Toonflow）。
  - `data.history?: {url, created_at, provider_id, params}[]`：生成历史版本，当前版本由 `image_url/video_url/audio_url` 指向。
- **生成时组装**（`kit/assembleInputs.ts`）：参考列表 → MiniMax 生成源的输入槽。规则：
  - STRING：拼进 prompt（`参考 N：…`），来自 `director3d` 的文本进 `camera_prompt`；
  - IMAGE：按 `refRoles` 或模式填 `first_frame/last_frame/reference_images`；
  - AUDIO → `ref_audio`；VIDEO → `reference_video`；
  - 超出生成源 `maxItems` 的截断并在面板提示。
- **旧的具名端口**（`first_frame` 等）在迁移时改连到 `in`，原端口名写进 `refRoles`。画布 MCP 的 `canvas_connect` 收到旧端口名时同样转换。

## 5. 外观规格（照 Toonflow `nodeSkeleton.vue`，颜色走变量）

- 标题栏在卡片**外**上方：16px Tabler 图标 + 单行标题（双击改名、可拖动节点）；悬停出现 24×24 的「刷新/删除」按钮。
- 卡片：圆角 `--cv-radius-lg`（12px），1px 边框，无阴影，内边距 8px；最小高度 `max(100, (端口数+1)×44)px`；选中时边框 `color-mix(主色 50%, 边框色)`。默认宽 220，媒体节点按媒体宽高比（高 240）算宽。
- 端口：左入右出，按数量均分；平时透明，节点悬停、已连接、正在拖线时显示；未连用虚线圈、已连用实心圈；可连时主色、不可连时危险色；悬停有最多 6px 的磁吸偏移（120ms）。
- 卡片上方浮动工具栏（选中时出现）；下方浮动提示词面板。右键菜单：保存到素材库、复制、创建副本、删除。
- 画布：16 格吸附，点阵背景（间距 16，颜色 `--cv-border`），滚轮平移，`Ctrl/⌘ + 滚轮` 或双指捏合缩放，缩放 0.2–8；连线为平滑贝塞尔，默认描边 `--cv-edge`，与选中/拖动节点相连的边高亮为主色；点连线出现 32px 圆形「断开」按钮。
- 分组框：1px 边框，背景 `color-mix(--cv-fill 25%, transparent)`，标题在框外上方 12px，四角 9×9 缩放把手。
- 变量（`kit/theme.css`，全部映射 MiniMax 主题）：`--cv-bg`(卡片底)、`--cv-border`、`--cv-border-light`、`--cv-text-1/2/3`、`--cv-fill`、`--cv-primary`(=MiniMax 品牌色)、`--cv-danger`、`--cv-edge`、`--cv-radius`(8)/`--cv-radius-sm`(4)/`--cv-radius-lg`(12)；深浅色两套。

## 6. 节点清单

### 6.1 核心节点（Toonflow 交互重写，接 MiniMax 后端）

| 类型 | 标题 | 端口 | 功能（Toonflow 部分） | MiniMax 部分 |
|---|---|---|---|---|
| `prompt` | 文本 | in[STRING,IMAGE,VIDEO] → text[STRING] | Markdown 编辑/预览（tiptap），流式生成，`{{ref}}` 引用 | 技能下拉：剧本拆解（`parseScript`）、策划案（`split_novel_script`）、扩写（`/llm/expand`）、自由生成（LLM） |
| `load-image` | 图片 | → image[IMAGE] | 上传/替换、全屏、下载、**标记**、**局部重绘**、**宫格切分**（生成多个图片节点） | 从素材库拖入、保存到素材库 |
| `image` | 图片生成 | in[IMAGE,STRING] → image[IMAGE] | 提示词面板、比例/尺寸、历史版本、局部重绘、宫格切分 | 生成源下拉、`DynamicControl` 参数、智能规划开关、角色一致性技能（绑三视图） |
| `load-video` | 视频 | → video[VIDEO] | 上传、播放、**截帧**（当前/首/尾→图片节点）、**分离音轨**、**截取片段** | 素材库 |
| `video` | 视频生成 | in[IMAGE,VIDEO,AUDIO,STRING] → video[VIDEO] | 模式自动匹配、首尾帧、时长/分辨率/比例、生成音频开关、历史版本 | 生成源（海螺/Kling/Seedance/Wan…）、机位提示词、参考音频、视频任务轮询、智能规划 |
| `load-audio` | 音频 | → audio[AUDIO] | 上传、波形播放、**截取**、**变速** | 素材库 |
| `audio` | 音频生成 | in[IMAGE,AUDIO,STRING]（图片+音频 ≤1）→ audio[AUDIO] | 语种、采样率、格式、截取/变速 | 语音源（MiniMax/IndexTTS/CosyVoice/GPT-SoVITS/ElevenLabs）、音色、情感、参考音频 |
| `director3d` | 3D 导演 | in[STRING,IMAGE] → camera_prompt[STRING], image[IMAGE], video[VIDEO] | 节点内 three.js 舞台：人偶、关节拖拽、运镜关键帧、导出 PNG（→image 输出/新图片节点）、导出 MP4（→video 输出） | 景别/运镜预设（与 3D 片场同源）、输出海螺运镜指令 `camera_prompt`、「在 3D 片场打开」 |
| `group` | 分组 | 无 | 框选成组、缩放、改名 | — |

### 6.2 独有节点（只换外壳，逻辑不变）

`shot-card`、`comfy-workflow`、`timeline`、`timeline-export`、`export`、`script-split`、`brief`、`custom`、`ext-node`、`provider`、`provider-image/video/audio/llm`：全部改用 `NodeSkeleton`，删掉写死的颜色，改用 `--cv-*` 变量；端口改用 `NodeHandles`（端口 id 不变）。`ext-node`/`custom` 的动态端口按声明渲染，并修掉调研发现的两处不一致：①`ext-node` 加入注册表参与连线类型检查，媒体值写到声明的端口 id；②`custom` 的注册端口与动态端口统一以 `input_schema` 为准。

## 7. 旧画布迁移 `client/src/components/canvas/migrate.ts`

- 纯函数 `migrateCanvas(raw) → {canvas, changed, report}`，加载画布时调用；`changed` 为真时，**第一次保存前**调用后端 `POST /projects/{id}/canvases/{cid}/backup`（新增，复制原 JSON 到 `storage/projects/{id}/canvas_backups/{cid}-{ts}.json`）。
- 画布 JSON 加 `schema_version: 2`；已是 2 的不再迁移（幂等）。
- 映射：见 §2.3；具名端口连线 → `in` + `refRoles`；`asset` 按 `data` 中的媒体字段判断类型；`load-image-batch` 拆成多个 `load-image`（横向排布）；未知类型原样保留并渲染为「不支持的节点」卡片（不丢数据）。
- 单元测试覆盖每条映射、幂等、未知类型保留。

## 8. 执行与后端

- 生成：前端 `nodeAgentExecutor` 继续调用 `POST /mcp/call`（`provider_<id>`），入参由 `assembleInputs` 组装；视频继续轮询任务。智能规划开启时先调 `/canvas/agent/generate`。
- 后端执行器 `engine.py` 与画布 MCP 工具：识别 `in` 端口 + `refRoles`，按 §4 规则组装；`canvas_create_node` 支持新类型 `group`；`canvas_connect` 兼容旧端口名。
- **新增媒体处理接口**（`server/app/media/ops.py` + `server/app/api/media_ops_routes.py`，都基于 ffmpeg/Pillow，产物写 storage 并返回 URL）：
  - `POST /media/ops/frame` {video_url, at: 'current'|'first'|'last', time?} → image
  - `POST /media/ops/extract-audio` {video_url} → audio；`POST /media/ops/split-av` → {video(无声), audio}
  - `POST /media/ops/trim` {url, start, end} → 同类型媒体
  - `POST /media/ops/speed` {audio_url, rate 0.5–2} → audio
  - `POST /media/ops/grid-split` {image_url, rows, cols} → image[]
  - `POST /media/ops/compose-mask` {image_url, mask_png(base64)} → 带标记的图（局部重绘时作为参考图之一，配合提示词描述）
- 新增备份接口：`POST /projects/{id}/canvases/{cid}/backup`。

## 9. 测试

- 前端 vitest：`kit/connection`、`assembleInputs`、`migrate`、`registry`；关键节点组件渲染冒烟。
- 后端 pytest：`media/ops` 每个操作（用 ffmpeg 生成的测试素材）、备份接口、engine 的 `in`+`refRoles` 组装、MCP `canvas_connect` 旧端口名兼容。
- E2E（见 `testing.md`）：在隔离实例（后端 8001、前端 5180、worktree 自己的 storage）用浏览器跑。
- 基线：前端 tsc 0 错、vitest 90/90；后端 486 通过、1 个与本需求无关的既有失败（`test_skill_engine::test_default_scan_stays_inside_project`）。

## 附录：Toonflow 参考文件（R = ~/project/drama/01-toonflow）

- 外壳：`R/packages/nodeScaffold/src/nodeSkeleton.vue`；连接：`connection.ts`；值：`values.ts`；引用：`useNodeReferences.ts`、`components/promptInput.vue`
- 节点：`R/packages/nodes/<name>/src/index.vue`（textNode/imageNode/imageGenerationNode/videoNode/videoGenerationNode/audioNode/audioGenerationNode/director3dNode）
- 画布：`R/apps/web/src/pages/workspace/panels/canvas/index.vue`、`components/{groupNode,selectionToolbar,nodeMenu,canvasControls}.vue`
- 主题：`R/apps/web/src/App.vue`、`R/apps/web/src/assets/main.scss`
