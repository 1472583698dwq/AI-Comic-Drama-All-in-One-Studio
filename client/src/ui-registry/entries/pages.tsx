import React, { Suspense } from 'react';
import { HomeView } from '../../views/HomeView';
import { ProjectDashboard } from '../../views/ProjectDashboard';
import { AssetsHub } from '../../components/asset/AssetsHub';
import { ShotInspector } from '../../components/storyboard/ShotInspector';
import { Director3DStage } from '../../components/director3d/Director3DStage';
import { MultiTrackTimeline } from '../../components/timeline/MultiTrackTimeline';
import { MobileCardFlow } from '../../components/mobile/MobileCardFlow';
import { AgentModeView } from '../../views/AgentModeView';
import { SetupView } from '../../views/setup/SetupView';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { useProjectStore } from '../../stores/useProjectStore';
import { register } from '../registry';
import { DEFAULT_VARIANT, RETIRED_VARIANT, pageHost } from '../types';
import { LOCKED_PAGE_IDS } from '../pageLocks';
import { useModalIntentsStore } from '../modalIntents';
import { NewVersionPlaceholder } from './placeholders';
import { NEXT_VARIANT, VARIANT_META } from './variants';

/**
 * 页面条目登记（Phase 1：把 `App.tsx` 的 `PAGE_HOSTS` / `STAGE_HOSTS` / renderTab if 链搬进注册表）。
 *
 * 与改造前的等价关系（逐条对照，行为零变化）：
 *   - `PAGE_HOSTS[host]` → 每个 page id 一条 `variant: default` 条目（host = `page.<id>`）；
 *     后端 11 个 page 的 host 字段与 id 一致（`server/app/core/pages.py` `PAGE_DEFS`），
 *     而 id 才是开关与准入的唯一口径，所以这里以 **id** 为键（设计决策：不绑后端 host 字段）。
 *   - 片场三页（studio / timeline / director3d）共用 `ShotInspector` + 底部多轨时间线：
 *     原 `STAGE_HOSTS` 分支改为**条目上的布局声明**（`layout: StageLayout`，设计 §9.2），
 *     桌面/移动分支照旧 —— 宿主里不再有 `if`，布局由条目自带。
 *   - 画布 / 成片工作室的 `lazyView` + `Suspense` + 各自的 `ErrorBoundary` 原样保留。
 *   - 同一页再登记一条 `variant: next` 占位（重构新版），让版本切换链路当场可验证。
 *
 * 页面组件 `export` 的原因与 `modals.tsx` 相同：本模块的导出**只有组件**（注册是模块副作用），
 * 既满足 fast refresh 的约束，也让单个页面组件可被单独渲染验证。
 */

/**
 * 懒加载视图 + 构建更新自愈（原样从 App.tsx 搬来）：
 * 旧窗口在构建更新后请求已被替换的分片会 404，React.lazy 直接抛错 → 整树卸载 = 黑屏。
 * 这里捕获加载失败并整页刷新一次（拿到新 index.html），刷新后再失败才交给 ErrorBoundary 显示红框。
 */
const lazyView = (loader: () => Promise<any>) =>
  React.lazy(() =>
    loader().catch((err) => {
      const KEY = 'studio_chunk_reload_once';
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, '1');
        try { location.reload(); } catch { /* ignore */ }
        return new Promise<any>(() => {}); // 挂起，等待刷新
      }
      throw err;
    })
  );

const CreativeCanvas = lazyView(() => import('../../components/canvas/CreativeCanvas').then((m) => ({ default: m.CreativeCanvas })));
/** 成片工作室：一键成片的独立页面（Agent 自主编排；替代原弹窗） */
const OneKeyStudioView = lazyView(() => import('../../views/OneKeyStudioView').then((m) => ({ default: m.OneKeyStudioView })));

const fallbackText = (text: string) => (
  <div className="flex-1 flex items-center justify-center text-xs text-gray-500">{text}</div>
);

export const CanvasPage: React.FC = () => (
  <ErrorBoundary name="创意画布">
    <Suspense fallback={fallbackText('画布加载中…')}>
      <CreativeCanvas />
    </Suspense>
  </ErrorBoundary>
);

/* ── 重构新版（`variant: 'next'`）──────────────────────────────
 * 逐页接入：只有填了 `nextView` 的页才渲染真实新版，其余仍是「待接入」占位。
 * 一律 **懒加载 + 各自的 ErrorBoundary**：不切到新版就永远不进主包，
 * 新版崩了也只影响该页、不影响保底版与其它页（设计 §6.1 逐条错误隔离）。
 */
const ProjectsBoardNext = lazyView(() => import('../../views/next/ProjectsBoardNext').then((m) => ({ default: m.ProjectsBoardNext })));

export const NextProjectsPage: React.FC = () => (
  <ErrorBoundary name="项目看板（新版）">
    <Suspense fallback={fallbackText('新版加载中…')}>
      <ProjectsBoardNext />
    </Suspense>
  </ErrorBoundary>
);
NextProjectsPage.displayName = 'NextProjectsPage';

export const OneKeyPage: React.FC = () => (
  <ErrorBoundary name="成片工作室">
    <Suspense fallback={fallbackText('成片工作室加载中…')}>
      <OneKeyStudioView />
    </Suspense>
  </ErrorBoundary>
);

export const AgentPage: React.FC = () => (
  <ErrorBoundary name="Agent模式页"><AgentModeView /></ErrorBoundary>
);

export const ConfigPage: React.FC = () => (
  <ErrorBoundary name="设置中心"><SetupView /></ErrorBoundary>
);

/**
 * 片场布局（原 App.renderTab 里 `STAGE_HOSTS` 分支的等价包装；2026-10-10 起改为**条目上的
 * 布局声明** —— 见 `PAGE_IMPLS` 的 `layout` 字段与设计 §9.2）：
 * 桌面模式 = 舞台 + 底部固定多轨时间线；非桌面 = 移动卡片流（导出走弹窗意图 store）。
 *
 * 元素树与改造前逐字一致（`<div flex-col><div flex-1><Stage/></div><MultiTrackTimeline/></div>`），
 * 差别只在舞台由 `children` 传入 —— 布局不认识具体页面，页面组件身份留在条目 `render` 上。
 */
export const StageLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const platformMode = useProjectStore((s) => s.platformMode);
  const openExport = useModalIntentsStore((s) => s.openExport);
  if (platformMode !== 'desktop') return <MobileCardFlow onOpenExport={openExport} />;
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 flex overflow-hidden">{children}</div>
      <MultiTrackTimeline />
    </div>
  );
};

interface PageImpl {
  id: string;
  /** 与后端 PAGE_DEFS 的 order 一致（仅作稳定排序） */
  order: number;
  view: React.ComponentType<any>;
  /**
   * 布局声明（设计 §9.2：布局差异「改为条目上的布局声明，而不是宿主里的 `if`」）。
   * 只对**保底版本**生效：`next` 占位自带满屏布局，不套片场壳。
   */
  layout?: React.ComponentType<{ children: React.ReactNode }>;
  /**
   * **重构新版实现**（`variant: 'next'`）。
   * 有它 → 该页的 `next` 变体直接渲染新版；没有 → 仍渲染「待接入」占位。
   * 逐页接入：每接一页就在这里填一个，保底版始终留着随时切回（设计 §2.4.1）。
   */
  nextView?: React.ComponentType<any>;
}

/**
 * **无项目时仍可停留的全局页**（其余都是项目内部页，需先有项目 —— 既有准入规则）。
 * 原为 `stores/usePageStore.ts` 的 `GLOBAL_TABS`；设计 §9.2 / 未完成清单第 15 条要求
 * 「页签归一进注册表」，故改为条目自带的 `meta.global`，由 `ui-registry/pageTabs.ts` 读回。
 */
const GLOBAL_PAGE_IDS: readonly string[] = ['home', 'projects', 'config'];

/**
 * 11 个功能页 → 当前实现（保底版本）。顺序即后端 `PAGE_DEFS` 顺序。
 *
 * studio / timeline **必须用同一个 `render`**（不是两个长得一样的组件）：改造前
 * `PAGE_HOSTS.studio === PAGE_HOSTS.timeline === ShotInspector`，两页互切时 React 见到
 * 相同元素类型 → 复用实例、页内 state 不丢。现在这两条条目共用 `render: ShotInspector`
 * 与同一份 `layout: StageLayout`，元素树不变；若拆成两个组件就会整棵重建 ——
 * 那是「看似等价、实则行为变了」的那类改动。
 */
const PAGE_IMPLS: PageImpl[] = [
  { id: 'home', order: 10, view: HomeView },
  { id: 'projects', order: 20, view: ProjectDashboard, nextView: NextProjectsPage },
  // 角色设定并入素材库：两个页签都落到同一个容器，按页签决定显示「素材」还是「角色」
  { id: 'assets', order: 30, view: AssetsHub },
  { id: 'characters', order: 40, view: AssetsHub },
  { id: 'studio', order: 50, view: ShotInspector, layout: StageLayout },
  { id: 'onekey', order: 55, view: OneKeyPage },
  { id: 'director3d', order: 60, view: Director3DStage, layout: StageLayout },
  { id: 'timeline', order: 70, view: ShotInspector, layout: StageLayout },
  { id: 'agent', order: 80, view: AgentPage },
  { id: 'canvas', order: 90, view: CanvasPage },
  { id: 'config', order: 100, view: ConfigPage },
];

/** 生成某页某版本的占位组件（组件标识稳定：同一 pageId+variant 只创建一次） */
const makePlaceholder = (pageId: string, variant: string): React.ComponentType<any> => {
  const Comp: React.FC = () => <NewVersionPlaceholder pageId={pageId} variant={variant} />;
  Comp.displayName = `PageVariantPlaceholder(${pageId}@${variant})`;
  return Comp;
};

/**
 * 设置页在**最小形态里是必达入口**（设计 §5.2 第 4 条，依据 A+C）：
 * 关掉它用户就再也进不去开关面板。锁定真相本就在后端（`pages.is_locked('config')` 拒绝停用），
 * 前端这里再标一次 locked 只是为了表达同一个事实：只要页签归一落在 config，它就一定渲染。
 * 注意这不改准入语义 —— 页签能不能到 config 仍由 `resolveTab()` 按后端开关决定。
 * 清单本体在 `../pageLocks`（App 的页面槽标注也用同一份，审查 L4-2）。
 */

/** 注册所有页面条目；返回反注册函数（热重载/测试用，正常生命周期不需要调） */
function registerPageEntries(): () => void {
  const undo: Array<() => void> = [];
  PAGE_IMPLS.forEach((p) => {
    const locked = LOCKED_PAGE_IDS.includes(p.id);
    VARIANT_META.forEach((m) => {
      const isDefault = m.id === DEFAULT_VARIANT;
      undo.push(register({
        id: `page.${p.id}@${m.id}`,
        kind: 'page',
        host: pageHost(p.id),
        // 同一页槽内：保底版本在前、其余版本依次靠后（同一时刻只有一条生效，仅作稳定排序）
        order: p.order + (isDefault ? 0 : 1),
        variant: m.id,
        locked,
        scope: 'page',
        // locked 条目禁止绑 switchId（register 会拒绝）：设置页的锁定由后端 + 这里共同表达
        switchId: locked ? undefined : p.id,
        source: 'builtin',
        // 布局声明只挂在保底实现上（`next` 占位是整页自带布局，不套片场壳）
        layout: isDefault ? p.layout : undefined,
        // 页签归一元数据（设计 §9.2）：无项目也能停留的全局页由条目自带，消费方读 pageTabs
        meta: { global: GLOBAL_PAGE_IDS.includes(p.id) },
        // `next` 变体：该页填了 `nextView` 就渲染真实新版，否则仍是「待接入」占位
        render: isDefault
          ? p.view
          : (m.id === NEXT_VARIANT && p.nextView ? p.nextView : makePlaceholder(p.id, m.id)),
      }));
    });
  });
  return () => undo.forEach((fn) => fn());
}

/**
 * 已下线但仍在用户历史页签里的页（原 `stores/usePageStore.ts` 的 `LEGACY_TAB_LABEL`）。
 *
 * 登记为 `variant: 'retired'` 的**页面条目**只提供展示名（`meta.label`），不会被任何宿主
 * 渲染 —— 于是「页签相关的一切」都只活在页面条目上，归一逻辑整体由注册表接手（设计 §9.2）。
 */
const RETIRED_TABS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'mcp', label: 'MCP 工具' },
];

/** 已下线页签条目的占位渲染：永不被挂载（激活版本恒为 default / next，见 `RETIRED_VARIANT`） */
const RetiredNoRender: React.FC = () => null;

function registerRetiredTabs(): () => void {
  const undo: Array<() => void> = [];
  RETIRED_TABS.forEach((t) => {
    undo.push(register({
      id: `page.${t.id}@${RETIRED_VARIANT}`,
      kind: 'page',
      host: pageHost(t.id),
      order: 999,
      variant: RETIRED_VARIANT,
      scope: 'page',
      source: 'builtin',
      meta: { retired: true, label: t.label },
      render: RetiredNoRender,
    }));
  });
  return () => undo.forEach((fn) => fn());
}

registerPageEntries();
registerRetiredTabs();
