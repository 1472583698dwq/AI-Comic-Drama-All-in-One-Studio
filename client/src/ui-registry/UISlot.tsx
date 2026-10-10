import React, { useEffect } from 'react';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { toast } from '../stores/useDialogStore';
import { markFallbackToast, useResolvedSlot } from './resolveEnabled';
import {
  APP_HOST, DIRECTOR_ENVS_HOST, DIRECTOR_PROPS_HOST, EXPORTER_ROWS_HOST, MAIN_TIPS_HOST,
  isShellHost, markAttrs, pageIdOfHost, SHELL_HOST_LOADING, type UIEntry,
} from './types';

/**
 * **不加槽位包裹层**的宿主（三类，都是「包裹层会破坏布局或语义」）：
 *   1. 覆盖层宿主 `app` / `main.tips`：条目根是 `fixed` / `absolute`，静态包裹层高度为 0 ——
 *      描边会退化成视口底部一条游离细线（审查 M3）；
 *   2. 网格宿主 `modal.export` / `director3d.props` / `director3d.environments`：
 *      包裹层会成为 CSS grid 的子项，行卡片不再撑满格子（设计 §12 桥接）；
 *   3. （另外两类在下面按前缀判定）壳槽 `shell.*` 与侧栏块槽 `sidebar.*`：
 *      多一层 div 就会动到 Header / Sidebar 的 flex 布局。
 *
 * 这些宿主的条目**必须在自己的根元素上展开 `markAttrs`**（或用自己的同框标记层），
 * 否则标注模式下它们不可见 —— 约定见 `types.ts` 的 `markAttrs`。
 */
const NO_MARK_WRAPPER_HOSTS: ReadonlySet<string> = new Set([
  APP_HOST, MAIN_TIPS_HOST, EXPORTER_ROWS_HOST, DIRECTOR_PROPS_HOST, DIRECTOR_ENVS_HOST,
]);
import { useT } from './i18n';

export interface UISlotProps {
  host: string;
  /**
   * 「**开关就是没开**、槽里没有生效条目」时的兜底（设计 §9.2）。
   *
   * 刻意与「**还没拉到**开关」区分开：
   *   · 未加载（`loading`）→ 一律渲染统一加载占位，**不受 `fallback` 影响** ——
   *     「还没拉到」和「就是没开」是两件事，后者才轮得到宿主的兜底（如全关空态自救页）；
   *     否则传了空态兜底的宿主会在加载期闪一下「什么都不对」的界面。
   *   · 已加载但无条目 → 渲染 `fallback`；没传就是 `null`（迁移期常驻的宿主保持原样，不凭空造 UI）。
   */
  fallback?: React.ReactNode;
}

/** 同一页面槽里出现多条「同版本生效」条目时的告警（同一页只报一次，避免刷屏） */
const warnedPageConflicts = new Set<string>();
function warnDuplicatePageEntries(pageId: string, entries: UIEntry[]): void {
  if (warnedPageConflicts.has(pageId)) return;
  warnedPageConflicts.add(pageId);
  console.warn(
    `[ui-registry] 页面槽 ${pageId} 有多条同版本生效条目，只渲染 order 最小的一条：`,
    entries.map((e) => `${e.id}(order=${e.order})`).join(' · '),
  );
}

/**
 * 通用挂载槽：宿主只写 `<UISlot host="..." />`，不认识具体条目。
 *
 * 逐条错误边界（设计 §6.1）：单条 render 崩溃只把该条替换为可读占位，宿主与其他条目不受影响；
 * 崩溃**不自动关闭开关**（设计 §6.2）——开关本身就是手动杀开关。
 *
 * 版本回落提示（设计 §2.4.1-6）：激活版本没有条目时静默回落保底版本 + toast 一次（同一页不刷屏）。
 *
 * 加载占位（设计 §9.2「加载占位收敛为 `UISlot` 的统一 fallback」）：不再由 App 判断
 * `pagesLoaded`，改由槽按 `useResolvedSlot().loading`（统一口径）自己渲染 ——
 * 复用**已登记的锁定壳条目** `shell.loading`（同一个视觉、同一个文案，不新增组件）。
 * 这条自引用是安全的：`shell.loading` 是 locked 条目、无 scope，解析时 `loading` 必为 false，
 * 因此只会递归一层就落到真实内容；下面的加载分支另加一行护栏，兜住这条不变量被破坏的情况
 * （见该分支注释）。
 */
export const UISlot: React.FC<UISlotProps> = ({ host, fallback }) => {
  const { entries, fellBack, activeVariant, loading } = useResolvedSlot(host);
  const pageId = pageIdOfHost(host);
  const t = useT();

  useEffect(() => {
    if (!fellBack || !pageId) return;
    if (markFallbackToast(pageId, activeVariant)) {
      toast.info(t('toast.variantUnavailable', { v: activeVariant }));
    }
  }, [fellBack, pageId, activeVariant, t]);

  // 同 host 同版本的多条条目（审查 M6）：`register` 只按 **id** 去重，两条 id 不同但 host+variant
  // 相同的条目会一起返回，而页面槽只渲染 `order` 最小的一条（见下方 `entries[0]`）。
  // 静默丢弃会让注册表视图（两条都显示「生效」）与真实渲染对不上 —— 这里告警一次把规则说清；
  // 要真正互斥得在 `register` 里做 host+variant 唯一校验，那属于「扩展点收敛」一起定的事。
  useEffect(() => {
    if (pageId && entries.length > 1) warnDuplicatePageEntries(pageId, entries);
  }, [pageId, entries]);

  // 护栏（审查 L6）：加载占位只对**非加载壳自身**生效。上面「自引用只递归一层」靠的是
  // 「`shell.loading` 下的条目都是 locked」这条不变量 —— 一旦有人（例如插件）往该挂载点
  // 注册一条非 locked 条目，它的 `loading` 会恒为 true，加载分支又把自己渲染成同一个槽
  // → 无限递归（栈溢出 = 白屏）。多一个 `host !== SHELL_HOST_LOADING` 条件即可封死，
  // 且不影响正常路径：该槽自身解析时 loading 本来就是 false。
  if (loading && host !== SHELL_HOST_LOADING) return <UISlot host={SHELL_HOST_LOADING} />;

  if (entries.length === 0) return <>{fallback ?? null}</>;

  // 页面槽至多一条：**故意不加 key** —— 分镜台 / 多轨剪辑 / 3D 片场共用 ShotInspector，
  // 若按 entry.id 加 key，换页会强制重建组件实例、丢掉页内 state（现状没有这个重建）。
  //
  // 布局（设计 §9.2「STAGE_HOSTS」）：条目的 `layout` 声明包住 `render` 的输出 ——
  // 片场三页的「舞台 + 底部时间线」不再由宿主 `if` 分支决定，而是条目自带。
  // 包住不引入 key，换页仍走同一棵 `ErrorBoundary → Layout → Render` 树，实例照旧复用。
  if (pageId) {
    const entry = entries[0];
    const Render = entry.render;
    const Layout = entry.layout;
    return (
      <ErrorBoundary name={entry.id}>
        {Layout ? <Layout><Render /></Layout> : <Render />}
      </ErrorBoundary>
    );
  }

  // 非页面、非壳的挂载点（settings.panels 等）：槽位补一层**只带标注属性**的包裹层。
  // 这一层不动布局（内容要么是平铺面板，要么自带定位），换来「标注模式免配置生效」；
  // 会破坏布局/语义的宿主见 `NO_MARK_WRAPPER_HOSTS`（覆盖层 / 网格 / 壳 / 侧栏块）—— 那批条目自标。
  const marked = !isShellHost(host)
    && !host.startsWith('sidebar.')
    && !NO_MARK_WRAPPER_HOSTS.has(host);
  return (
    <>
      {entries.map((entry) => {
        const Render = entry.render;
        return (
          <ErrorBoundary key={entry.id} name={entry.id}>
            {marked ? (
              <div {...markAttrs(entry)}>
                <Render />
              </div>
            ) : (
              <Render />
            )}
          </ErrorBoundary>
        );
      })}
    </>
  );
};

export default UISlot;
