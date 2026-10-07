# 设计系统与设计 Token · MiniMax AI 漫剧 Studio

> 版本：v1 ｜ 更新日期：2026-10-07
> 目标：固化视觉基线（Token）、页面状态、组件复用与响应式要求，作为前端实现的唯一口径。
> 关联：`client/src/index.css`、`client/tailwind.config.js`、`client/src/components/ui/designKit.tsx`、[`../README.md`](../README.md)

---

## 1. 设计语言概览

- **风格**：暗黑工业风（Dark Industrial），磨砂玻璃面板 + 品牌紫发光点缀。
- **主题机制**：暗色为默认；浅色通过 `:root[data-theme="light"] / .light` 覆盖；支持插件主题（CSS 变量包）在运行时注入 `:root`。
- **Token 载体**：
  - Tailwind v4 主题：`client/src/index.css:6-25`（`@theme` 块，部分为自引用，实际取值在下文 `:root`）
  - Tailwind v3 风格扩展：`client/tailwind.config.js:10-54`
  - CSS 变量：`client/src/index.css:27-68`
  - 复用常量：`client/src/components/ui/designKit.tsx`

---

## 2. 颜色 Token

### 2.1 品牌与强调色（`tailwind.config.js`）

| Token | 取值 | 用途 |
|---|---|---|
| `brand` | `#7C3AED` | 主品牌色（主按钮、强调） |
| `brand-light` | `#9333EA` | 主品牌浅 |
| `brand-glow` | `#A855F7` | 发光/描边高亮 |
| `brand-blue` | `#3B82F6` | 信息/次要品牌 |
| `brand-cyan` | `#06B6D4` | 数据/科技感 |
| `accent-orange` | `#F97316` | 警示/进度 |
| `accent-green` | `#10B981` | 成功 |
| `accent-pink` | `#EC4899` | 强调 |
| `accent-yellow` | `#EAB308` | 提醒 |
| `accent-purple`（仅 `index.css:24`） | `#8B5CF6` | 补充强调 |

### 2.2 中性 / 层级色

| Token | 暗色（默认） | 浅色 | 用途 |
|---|---|---|---|
| `background` / `--color-background` | `#0A0A0C` | `#F4F6F9` | 应用底 |
| `surface` | `#121216` | `#FFFFFF` | 基础面板 |
| `surface-secondary` | `#1A1A22` | `#F0F2F5` | 次级面板 |
| `surface-tertiary` | `#24242F` | `#E4E7EB` | 三级面板/输入 |
| `surface-hover` | `#2C2C3A` | `#D9DDE2` | 悬停态 |
| `border` | `#262630` | `#E2E8F0` | 常规描边 |
| `border-subtle` | `#1C1C24` | `#EDF2F7` | 弱描边 |
| `border-active` | `#3F3F50` | `#CBD5E1` | 选中/激活描边 |

### 2.3 文本色

| Token | 暗色 | 浅色 | 用途 |
|---|---|---|---|
| `--color-text-main` | `#F3F4F6` | `#0F172A` | 主文本 |
| `--color-text-secondary` | `#9CA3AF` | `#334155` | 次文本 |
| `--color-text-muted` | `#6B7280` | `#64748B` | 弱化/占位 |

### 2.4 画布专用变量（`index.css:27-68`）

| 变量 | 暗色 | 浅色 | 用途 |
|---|---|---|---|
| `--canvas-bg` | `#08080B` | `#E8ECF1` | 画布底 |
| `--canvas-grid` | `rgba(255,255,255,0.04)` | `rgba(15,23,42,0.055)` | 细网格 |
| `--canvas-grid-major` | `rgba(255,255,255,0.075)` | `rgba(15,23,42,0.1)` | 主网格 |
| `--canvas-edge` | `#5C5C78` | `#8A97AB` | 连线 |
| `--canvas-edge-hl` | `#A78BFA` | `#7C3AED` | 连线高亮 |
| `--canvas-card-edge` | `rgba(255,255,255,0.16)` | `rgba(15,23,42,0.2)` | 卡片描边 |
| `--canvas-card-edge-hover` | `rgba(167,139,250,0.55)` | `rgba(124,58,237,0.5)` | 卡片悬停描边 |

---

## 3. 字体与文本 Token

| Token | 取值 |
|---|---|
| `font-sans` | `Inter, PingFang SC, HarmonyOS Sans, sans-serif` |
| `font-mono` | `JetBrains Mono, Fira Code, monospace` |

> 未定义独立字号阶梯，沿用 Tailwind 默认 `text-xs/sm/base/lg/xl/2xl...`。

---

## 4. 动效 Token

| Token | 取值 | 用途 |
|---|---|---|
| `animation-pulse-glow` | `pulseGlow 2s cubic-bezier(0.4,0,0.6,1) infinite` | 品牌发光呼吸 |
| `animation-fade-in` | `fadeIn 0.25s ease-out` | 入场淡入 |
| 侧栏宽度过渡 | `transition-[width] 260ms` | `Sidebar.tsx` 折叠 |

---

## 5. 圆角 / 间距 / 阴影

- **圆角**：`tailwind.config.js` **未扩展** `borderRadius`，沿用 Tailwind 默认阶梯（`rounded / rounded-md / rounded-lg / rounded-xl / rounded-2xl`）。
- **间距**：未扩展，沿用 Tailwind 默认 spacing 刻度。
- **阴影**：未扩展 `boxShadow`，以任意值形式内联，例如 `designKit.tsx` 的 `GLASS` / `GLASS_SOFT` 磨砂面板常量。

> **待改进**：圆角、间距、阴影目前无 Token 化，建议后续抽 `designKit` 常量统一，避免散落内联。

---

## 6. 复用常量（`designKit.tsx`）

全站"设置中心/首页"新版基线的**唯一出口**：

| 常量 | 说明 |
|---|---|
| `GLASS` / `GLASS_SOFT` | 磨砂玻璃面板（强/弱） |
| `T_MAIN` / `T_SEC` / `T_MUTED` | 文本色（映射 CSS 变量） |
| `PILL` | 药丸标签 |
| `CTA_GRADIENT` | 品牌渐变主按钮 |
| `BTN_GHOST` | 幽灵按钮 |
| `SectionTitle` | 品牌短竖线 + 图标 + 标题 |
| `Ambience` | 页面氛围光斑 |

**复用要求**：新增页面/面板优先使用上述常量，禁止另起一套颜色/阴影内联值。

---

## 7. 布局骨架

主壳布局见 `client/src/App.tsx`：

```
根容器  h-screen w-screen flex flex-col bg-background text-gray-100 overflow-hidden   (App.tsx:266)
├── Header（顶栏）                                                                    (App.tsx:268-274)
├── 错误横幅（API / MCP）                                                              (App.tsx:277-288)
└── <div className="flex-1 flex overflow-hidden">                                     (App.tsx:291)
    ├── Sidebar（左）  折叠 60px / 展开 218px                                          (Sidebar.tsx:129/134)
    └── <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">       (App.tsx:297)
        ├── ErrorBoundary → 加载占位 / renderTab() / NoPageEnabled                      (App.tsx:301-312)
        └── ContextTipCard                                                             (App.tsx:315-328)
```

- **导航来源**：侧栏分组由后端 `GET /api/v1/pages` 的 `group / order / label / icon` 驱动，仅渲染 enabled 页（`Sidebar.tsx:68-97`）。
- **页面 host 映射**（`App.tsx:60-72`）：`home→HomeView`、`projects→ProjectDashboard`、`canvas→CreativeCanvas`、`agent→AgentModeView`、`assets→AssetLibrary`、`characters→CharacterStudio`、`onekey→OneKeyStudioView`、`studio/timeline→ShotInspector`、`director3d→Director3DStage`、`config→SetupView`。
- **悬浮层**：`AgentChatDrawer`（有项目且非 canvas/agent 页时）、`GlobalDialogContainer`、`FirstRunWizard` 等（`App.tsx:337-404`）。

---

## 8. 组件清单与复用基线

### 8.1 基础 UI（`client/src/components/ui/`，10 个）

`AiPolishButton`、`AutoRatioMedia`、`AutoTextarea`、`designKit`、`ErrorBoundary`、`GlobalAiPolish`、`GlobalDialogContainer`、`NoPageEnabled`、`ProviderPicker`、`SelectionPolish`

> **注**：项目**没有** `Button` / `Modal` / `Input` 原子组件库；按钮/弹窗多为 Tailwind 类 + `designKit` 常量内联，全局弹窗由 `GlobalDialogContainer` + `useDialogStore` 统一承载。**这是当前一致性风险点。**

### 8.2 业务组件分组（`client/src/components/`）

| 分组 | 主要组件 |
|---|---|
| `agent/` | AgentChatDrawer、AgentMessageList、AgentComposer、AgentSwarmPanel、AgentToolSteps、OneKeySwarmBoard、SessionSidebar、MarkdownText |
| `canvas/` | CreativeCanvas、CanvasAgentSidebar、NodeAgentBar、NodeAgentConsole、NodeControlBar、NodeContextMenu、FloatingAgentPromptBar |
| `canvas/nodes/` | AssetNode、BriefNode、ComfyWorkflowNode、CustomNode、ExtNode、ProviderNode、ShotCardNode、TTSNode、VideoNode、TimelineNode |
| `canvas/timeline/` | TimelineStrip、TimelinePreview、TimelineClipInspector、TimelineStudioModal |
| `storyboard/` | ShotInspector、`slots/`（InspectorPanel、PreviewStage、PluginRender、ProviderSlotList、SlotManagerModal、VisualTab、MotionTab、DialogueTab…） |
| `timeline/` | MultiTrackTimeline |
| `director3d/` | Director3DStage |
| `character/` | CharacterStudio |
| `asset/` | AssetLibrary、AssetPickerModal |
| `export/` | ExportModal |
| `mcp/` | McpToolsModal |
| `mobile/` | MobileCardFlow |
| `navbar/` | Header、Sidebar |
| `provider/` | ProviderManagerModal、ProviderCreateModal、CustomHeadersEditor |
| `skills/` | SkillStudioModal、SkillVersionDiff |
| `workflow/` | WorkflowImportModal、WorkflowInspectorModal |
| `onboarding/` | FirstRunWizard、ContextTipCard |
| `ui/` | 见 8.1 |

---

## 9. 页面状态（空 / 加载 / 错误）

当前**无统一封装的 Empty / Loading / Skeleton 组件库**，状态实现分散。基线要求如下：

| 状态 | 现状实现 | 基线要求 |
|---|---|---|
| 错误态 | `ui/ErrorBoundary.tsx`（类组件，崩溃显示红框 + 重试），App 多处使用 | **必须**包裹所有页面级内容区 |
| 全页空态 | `ui/NoPageEnabled.tsx`（所有功能页关闭时唯一落点，`App.tsx:311`） | 保留，作为降级终点 |
| 加载态 | 无独立组件，`lucide-react` 的 `Loader2` + `animate-spin` 内联；全局占位见 `App.tsx:302-307`；Suspense fallback `App.tsx:244/256` | **建议**抽 `ui/Loading.tsx` 统一 |
| 局部空态 | `OneKeyStudioView.tsx:896` 内定义 `EmptyState`（仅本文件）；画布空态内联于 `CreativeCanvas.tsx:2111` | **建议**抽 `ui/EmptyState.tsx` 统一 |
| 骨架屏 | **未实现**（无 Skeleton / `animate-pulse` 骨架；`animate-pulse` 仅用于状态点呼吸） | 后续增强项 |

---

## 10. 响应式要求

- **断点**：`tailwind.config.js` 未自定义 `screens`，使用 Tailwind 默认断点：`sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536`。
- **源码内 `@media`**：业务代码无手写 media query；仅 `App.css`（Vite 脚手架残留）有 `@media (max-width:1024px)`，**该文件非设计系统主体**。
- **响应式前缀使用**：约 25 个文件使用 `sm: / md: / lg: / xl:`（如 `HomeView`、`Director3DStage`、`AssetLibrary`、`Header`、`MultiTrackTimeline`）。
- **桌面 / 移动区分**：非独立入口，而是运行时模式切换
  - `useProjectStore.platformMode: 'desktop' | 'mobile'`（`useProjectStore.ts:16`，持久化 key `app_platform_mode`）
  - `App.tsx:226-238`：`desktop` 时渲染 `ShotInspector + MultiTrackTimeline`，否则渲染 `MobileCardFlow`
  - `client/src/mobile-main.tsx` 为**已下线的遗留文件**（`vite.config.ts:23-27`），不要再据此新增移动端页面。

---

## 11. 主题机制（插件主题）

- **Store**：`client/src/stores/useThemeStore.ts`
  - `ThemeMode = 'dark' | 'light' | 'system'`；`PluginThemeInfo = { id, name, description?, icon?, mode?, vars? }`
  - `applyPluginVars()` 将 `vars` 中以 `--` 开头的键写入 `document.documentElement.style`
  - 持久化 key：`ai_manju_theme`、`ai_manju_plugin_theme`
- **同步服务**：`client/src/services/themeSpecs.ts::syncPluginThemes()` → `listThemes()`
- **后端**：`server/app/themes/*`、`server/app/api/theme_routes.py`；内置主题由后端下发（前端无硬编码列表）
- **热刷新**：`App.tsx:143-152` 监听 `theme-list-refresh`

**插件主题开发约束**：只允许覆盖本文第 2 节的变量名（含 `--canvas-*`），不得新增未登记变量。

---

## 12. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-07 | v1 | 首次建立；Token 取自 `tailwind.config.js` / `index.css`，组件与状态取自代码实测 |
