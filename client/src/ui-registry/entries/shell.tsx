import React from 'react';
import { Loader2 } from 'lucide-react';
import { Header } from '../../components/navbar/Header';
import { Sidebar } from '../../components/navbar/Sidebar';
import { NoPageEnabled } from '../../components/ui/NoPageEnabled';
import { useProjectStore } from '../../stores/useProjectStore';
import { register } from '../registry';
import { useModalIntentsStore } from '../modalIntents';
import { useShellStatusStore } from '../shellStatus';
import { useT } from '../i18n';
import {
  markAttrs, SHELL_HOST_EMPTY, SHELL_HOST_LOADING, SHELL_HOST_SIDEBAR, SHELL_HOST_TOP,
  type UIEntryKind,
} from '../types';

/**
 * 最小形态：**锁定壳**条目（设计 §5.2 的清单，1:1 落地）。
 *
 * 一句话：这些区域「关掉之后用户就回不来了」，所以它们不仅不绑开关，连开关判断都短路
 * （`locked: true` → `resolveEntryCore` 直接返回 true），任何开关全关时它们照旧渲染。
 * 只有一条例外：`config`（设置页）是 page 条目 —— 它的锁定真相在后端（不可停用），
 * 前端给它也标了 locked，见 `entries/pages.tsx`。
 *
 * 与槽位的关系：壳条目**自标** `data-ui-mark`（把 `markAttrs` 展开到自己的根元素上），
 * 槽位不给壳加包裹层 —— 多一层 div 就会动到 Header / Sidebar / 占位块的 flex 布局。
 * 因此这里每个条目都把属性写在它自己那一层（`Header` / `Sidebar` 组件本身不改）。
 */

/** ① 顶栏：品牌 + 面包屑 + 全局动作（props 全部来自弹窗意图 store，不再由 App 传） */
export const AppHeaderShell: React.FC = () => {
  const openExport = useModalIntentsStore((s) => s.openExport);

  return (
    <div
      className="shrink-0"
      {...markAttrs({ id: 'shell.header', kind: 'toolbar', locked: true, source: 'builtin' })}
    >
      {/* 「更多」菜单里的入口已条目化（`header.menu` / `header.tools`，第 2 条）：
          宿主只保留常驻的「导出剪映」与「生成」，其余回调不再需要 */}
      <Header onOpenExport={openExport} />
    </div>
  );
};

/** ② 启动/运行期 API 错误横幅：后端没起来时页面不能只剩空白（B 类：反馈通道） */
export const ApiErrorBanner: React.FC = () => {
  const apiError = useProjectStore((s) => s.apiError);
  const clearApiError = useProjectStore((s) => s.clearApiError);
  const t = useT();
  if (!apiError) return null;

  return (
    <div
      className="mx-4 mt-2 px-4 py-2 rounded-lg bg-red-500/15 border border-red-500/40 text-xs text-red-300 flex items-center justify-between"
      {...markAttrs({ id: 'shell.banner.api', kind: 'toolbar', locked: true, source: 'builtin' })}
    >
      <span>⚠️ {apiError}</span>
      <button onClick={clearApiError} className="ml-3 px-2 py-0.5 rounded bg-red-500/30 hover:bg-red-500/50 text-white">
        {t('common.close')}
      </button>
    </div>
  );
};

/** ③ MCP 连接失败横幅：文案与展示位置与改造前逐字一致，只是状态搬到了 shellStatus store */
export const McpErrorBanner: React.FC = () => {
  const mcpError = useShellStatusStore((s) => s.mcpError);
  const setMcpError = useShellStatusStore((s) => s.setMcpError);
  const t = useT();
  if (!mcpError) return null;

  return (
    <div
      className="mx-4 mt-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center justify-between"
      {...markAttrs({ id: 'shell.banner.mcp', kind: 'toolbar', locked: true, source: 'builtin' })}
    >
      <span>{t('shell.mcpFailed', { msg: mcpError })}</span>
      <button onClick={() => setMcpError(null)} className="ml-3 px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/40">
        {t('common.close')}
      </button>
    </div>
  );
};

/**
 * ④ 侧栏壳（含底部工具区：生成源 / 主题 / 设置 / 收起）。
 * 注意锁定的是**壳本身**：里面的导航项仍按页面开关过滤（关掉的页不在列表里），
 * 但「设置」这个自救入口永远在 —— 否则切到别的页后就再也进不去开关面板了。
 */
export const AppSidebarShell: React.FC = () => {
  return (
    <div
      className="shrink-0 flex"
      {...markAttrs({ id: 'shell.sidebar', kind: 'toolbar', locked: true, source: 'builtin' })}
    >
      {/* Sidebar 不再需要弹窗回调：底栏按钮已条目化（`sidebar.footer`，第 2 条），
          条目自己走 modalIntents / store，宿主只留容器与导航 */}
      <Sidebar />
    </div>
  );
};

/** ⑤ 加载占位：开关没到手之前绝不闪出「已关闭」的页（文案沿用改造前两条） */
export const AppLoadingShell: React.FC = () => {
  const isLoading = useProjectStore((s) => s.isLoading);
  const project = useProjectStore((s) => s.project);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const t = useT();
  const restoring = isLoading && !project && !!activeProjectId;

  return (
    <div
      className="flex-1 flex items-center justify-center gap-2 text-xs text-gray-500"
      {...markAttrs({ id: 'shell.loading', kind: 'panel', locked: true, source: 'builtin' })}
    >
      <Loader2 className="w-3.5 h-3.5 animate-spin" />
      {restoring ? t('shell.restoring') : t('shell.loading')}
    </div>
  );
};

/** ⑥ 全关空态自救页：所有页面关掉后的唯一落点，内含去开关面板的路 */
export const AppEmptyShell: React.FC = () => (
  <div
    className="flex-1 flex flex-col min-h-0"
    {...markAttrs({ id: 'shell.empty', kind: 'panel', locked: true, source: 'builtin' })}
  >
    <NoPageEnabled />
  </div>
);

interface ShellImpl {
  id: string;
  host: string;
  order: number;
  /**
   * `kind` 按**结构**归类（设计 §3.1）：顶栏与横幅是 `toolbar`，加载占位与空态页是 `panel`。
   * 必须与各组件自己展开的 `markAttrs(...).kind` 逐条一致 —— 否则注册表视图的 kind 列
   * 与标注属性会说两套话（审查 L4-1）。
   */
  kind: UIEntryKind;
  view: React.ComponentType<any>;
}

/**
 * 锁定壳条目表。**只登记，不绑 switchId**（`register` 会拒绝「既 locked 又绑开关」的自相矛盾条目）。
 * 顺序即渲染顺序：顶栏 → API 横幅 → MCP 横幅（与改造前 App 的 JSX 顺序一致）。
 */
const SHELL_IMPLS: ShellImpl[] = [
  { id: 'shell.header', kind: 'toolbar', host: SHELL_HOST_TOP, order: 10, view: AppHeaderShell },
  { id: 'shell.banner.api', kind: 'toolbar', host: SHELL_HOST_TOP, order: 20, view: ApiErrorBanner },
  { id: 'shell.banner.mcp', kind: 'toolbar', host: SHELL_HOST_TOP, order: 30, view: McpErrorBanner },
  { id: 'shell.sidebar', kind: 'toolbar', host: SHELL_HOST_SIDEBAR, order: 10, view: AppSidebarShell },
  { id: 'shell.loading', kind: 'panel', host: SHELL_HOST_LOADING, order: 10, view: AppLoadingShell },
  { id: 'shell.empty', kind: 'panel', host: SHELL_HOST_EMPTY, order: 10, view: AppEmptyShell },
];

/** 注册全部锁定壳条目；返回反注册函数（热重载 / 测试用） —— 不导出：本模块只导出组件 */
function registerShellEntries(): () => void {
  const undo: Array<() => void> = [];
  SHELL_IMPLS.forEach((s) => {
    undo.push(register({
      id: s.id,
      kind: s.kind,
      host: s.host,
      order: s.order,
      locked: true,
      source: 'builtin',
      render: s.view,
    }));
  });
  return () => undo.forEach((fn) => fn());
}

registerShellEntries();
