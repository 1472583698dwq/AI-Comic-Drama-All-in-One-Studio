import type React from 'react';

/**
 * 前端 UI 注册表条目契约（《UI开关热插拔设计》§3.1）。
 *
 * 一句话：注册表是**版本容器** —— 同一挂载点（host）可以有多个版本（variant）的条目并存，
 * 同一时刻至多渲染一条（由 `page_variant.<pageId>` 单选偏好决定激活哪条）。
 *
 * 本轮（Phase 1+2）只把现有实现登记为 `default` 变体（= 测试初期版本，保底），
 * 并为每个页面登记一个 `next` 占位变体，让「切换 → 生效 → 切回保底」这条链路当场可验证。
 */

/** 保底版本标识：缺省激活版本，也是「激活版本不存在」时的回落目标 */
export const DEFAULT_VARIANT = 'default';

/**
 * **已下线页签**的版本标识（设计 §9.2「页签归一进注册表」）：
 * 登记为 `variant: 'retired'` 的页面条目只携带**展示名元数据**（`meta.label`），
 * 任何宿主都不会渲染它 —— `VARIANT_META` 里没有 `retired`，页面槽的激活版本恒为
 * `default`（或用户选择的 `next`），`selectVariant` 自然把它排除。
 */
export const RETIRED_VARIANT = 'retired';

/**
 * 条目类型。**只作展示分类，不参与任何开关判定**（判定只看 `locked` / `scope` / `switchId`）；
 * 目前出现在标注属性（`data-ui-kind`）与注册表视图表格里。
 *
 * 取值口径（2026-10-09 追认，对齐未完成清单第 8 条）：
 *   · `page` / `modal` / `toolbar` / `sidebar-block` / `panel` 按**结构**归类：
 *     页面槽、覆盖层弹窗、壳（顶栏与横幅）、侧栏块、设置台面板；
 *   · `prefs` 为**保留取值**（当前无使用者）：仅供「prefs 层且无法用上面任一结构性 kind 归类」
 *     的条目使用 —— 现阶段所有 prefs 层条目都能用 `panel` / `sidebar-block` 归类，
 *     层归属一律由 `scope: 'prefs'` 表达，不用 kind 重复表达。
 */
export type UIEntryKind = 'page' | 'panel' | 'modal' | 'toolbar' | 'sidebar-block' | 'prefs';

/** 开关归属层，判定口径见设计 §3.3（真相源不新造） */
export type UIScope = 'page' | 'feature' | 'prefs';

/** 条目来源：`builtin` = 内置；`plugin:<id>` = 插件贡献（Phase 4 接插件时用，供按源批量回滚） */
export type UISource = 'builtin' | `plugin:${string}`;

export interface UIEntry {
  /** 全局唯一，如 'page.studio@default' */
  id: string;
  kind: UIEntryKind;
  /** 挂载点：'app'（全局覆盖层）/ 'page.<pageId>'（按页分槽，同页多版本共享一个 host） */
  host: string;
  /** 同挂载点内排序（数字小的在前） */
  order: number;
  /** 最小形态：跳过一切开关判断永远渲染，且禁止绑定 switchId（注册时校验） */
  locked?: boolean;
  /** 页面版本标识；缺省 = DEFAULT_VARIANT */
  variant?: string;
  /**
   * 页面条目的**布局声明**（设计 §9.2：片场三页「共用 `ShotInspector` + 底部多轨时间线」的
   * 布局差异由**条目声明**，不再是宿主里的 `if` 分支）。
   *
   * 只有页面槽（`page.<id>`）读它：`UISlot` 渲染时用它包住 `render` 的输出。
   * 缺省 = 不包（页面组件自带满屏布局）。
   *
   * 入参用 `children` 而非具体的 `stage`，是为了把「布局」与「页面内容」解耦：布局只负责
   * 在自己的容器里放 `children`，页面组件身份仍由 `render` 决定 —— 因此 studio ↔ timeline
   * 两条条目用同一个 `render` 时，换页仍复用同一个组件实例（页内 state 不丢）。
   */
  layout?: React.ComponentType<{ children: React.ReactNode }>;
  /** 开关归属层；switchId 缺省时该字段不影响渲染（迁移期常驻） */
  scope?: UIScope;
  /** 对应开关 id（page 层 = page id）；缺省 = 迁移期常驻（已进注册表，后续绑开关零成本） */
  switchId?: string;
  source?: UISource;
  /**
   * DSL 适配器附加的原始声明（声明式扩展点的宿主渲染器读它）。
   * 例：分镜槽条目把 `TabDef` / `AnchorDef` / `ActionDef` 放在 `meta.slot` 里，
   * 宿主用 `useSlotDefs()` 取回文档后按 `ctx` 渲染（条目自身的 `render` 不参与）。
   *
   * 页面条目另用它承载**页签归一**的两项元数据（设计 §9.2，未完成清单第 15 条）：
   *   · `meta.global === true` —— 无项目时仍可停留的全局页（原 `GLOBAL_TABS`）；
   *   · `meta.retired` + `meta.label` —— 已下线页签的展示名（原 `LEGACY_TAB_LABEL`）。
   * 读取入口统一在 `ui-registry/pageTabs.ts`，消费方不再各持一张硬编码表。
   */
  meta?: Record<string, unknown>;
  render: React.ComponentType<any>;
}

/** 条目声明的版本（缺省 = 保底版本） */
export const variantOf = (entry: UIEntry): string => entry.variant || DEFAULT_VARIANT;

/** 页面挂载点键：以 page id（不是后端 host 字段）为键 —— id 才是开关与准入的唯一口径 */
export const pageHost = (pageId: string): string => `page.${pageId}`;

/** 从 host 反解 page id；非页面挂载点返回 null */
export const pageIdOfHost = (host: string): string | null =>
  host.startsWith('page.') && host.length > 5 ? host.slice(5) : null;

/* ───────────────────────── 挂载点常量 ───────────────────────── */

/** 全局覆盖层挂载点（弹窗 / 提示容器 / 标注图例） */
export const APP_HOST = 'app';
/** 设置台内的可插拔面板挂载点（注册表视图 / 诊断面板） */
export const SETTINGS_PANELS_HOST = 'settings.panels';
/** 侧栏扩展点（`Sidebar` 内的可插拔块；条目必须自标，见 `markAttrs`） */
export const SIDEBAR_HOST = 'sidebar.blocks';
/**
 * 顶栏「更多」菜单里的动作条目（低频入口，如导入小说）。宿主（`Header`）通过
 * `ToolbarChromeContext` 给条目注入「先把菜单收起来」的回调 —— 见 `toolbarContext.ts`。
 */
export const HEADER_MENU_HOST = 'header.menu';
/** 顶栏「更多」菜单里的扩展工具组（技能工坊 / MCP 工具 / 生成源管理；插件可继续往这里加） */
export const HEADER_TOOLS_HOST = 'header.tools';
/** 侧栏底部工具区（生成源 / 主题 / 设置 / 收起）：位于锁定壳 `shell.sidebar` 内，条目同样常驻 */
export const SIDEBAR_FOOTER_HOST = 'sidebar.footer';
/**
 * 导出中心（`ExportModal`）里的 **导出器行**宿主（设计 §12 桥接：`exporters` 扩展点）。
 * 条目必须自标：这一槽是 CSS grid 的子元素，槽位加的包裹层会让唯一子元素不再撑满格子。
 */
export const EXPORTER_ROWS_HOST = 'modal.export';
/**
 * 创意画布「画布操作台」（调色板）里的**插件节点行**宿主（设计 §12 桥接：
 * `custom_nodes` / `canvas_nodes` 两个扩展点）。宿主注入 `createNode`；
 * 内置模板 / 核心 Agent 节点是宿主 chrome，不进注册表。
 *
 * ⚠️ 命名规则：**只有页面槽**才以 `page.` 开头（`pageIdOfHost` 按前缀判定，且页面槽会走进
 * `scope: 'page'` 的开关分支）—— 嵌套的 `page.canvas.palette` 会被误判成页面槽、
 * 因 `switchId` 缺失而被过滤掉（这条是被 `canvasPalette.test.tsx` 抓出来的真缺陷）。
 * 多级挂载点一律用 `<域>.<区>` 形状（如 `studio.slot.tabs` / `canvas.palette`）。
 */
export const CANVAS_PALETTE_HOST = 'canvas.palette';
/**
 * 3D 片场「站位与道具」里的**插件道具行**宿主（设计 §12：`director_packs.props`）。
 * 它是 CSS grid 的子元素 → 条目必须自标（见 `UISlot` 的 `NO_MARK_WRAPPER_HOSTS`）。
 */
export const DIRECTOR_PROPS_HOST = 'director3d.props';
/**
 * 3D 片场「影棚环境」里的**插件环境预设行**宿主（设计 §12：`director_packs.environments`）。
 * 同上：grid 宿主 → 条目自标。
 */
export const DIRECTOR_ENVS_HOST = 'director3d.environments';
/** 内容区浮层扩展点（上下文引导卡等；挂在 `main` 内，以便用 `absolute` 定位） */
export const MAIN_TIPS_HOST = 'main.tips';
/**
 * 最小形态锁定壳的挂载点。壳条目**必须自标**（见 `markAttrs`）：槽位不给壳加包裹层，
 * 多一层 div 就会动到 `Header` / `Sidebar` / 占位块的 flex 布局。
 */
export const SHELL_HOST_TOP = 'shell.top';
export const SHELL_HOST_SIDEBAR = 'shell.sidebar';
export const SHELL_HOST_LOADING = 'shell.loading';
export const SHELL_HOST_EMPTY = 'shell.empty';

export const isShellHost = (host: string): boolean => host.startsWith('shell.');

/* ───────────────────── 标注模式（最小形态可视化） ───────────────────── */

export interface MarkSource {
  id: string;
  kind: UIEntryKind;
  scope?: UIScope;
  source?: UISource;
  locked?: boolean;
  variant?: string;
}

/**
 * 标注模式属性：条目把 `{...markAttrs({...})}` 展开到**自己的根元素**上。
 * 标注样式见 `index.css` 的 `body[data-ui-annot="1"]` 段：锁定=琥珀实线、可插拔=天蓝虚线、
 * 插件来源=橙色。属性只作可视标注，不参与任何开关判定。
 */
export const markAttrs = (e: MarkSource): Record<string, string> => {
  const out: Record<string, string> = {
    'data-ui-mark': e.id,
    'data-ui-kind': e.kind,
    'data-ui-source': e.source || 'builtin',
  };
  if (e.scope) out['data-ui-scope'] = e.scope;
  if (e.variant) out['data-ui-variant'] = e.variant;
  if (e.locked) out['data-ui-locked'] = '1';
  return out;
};
