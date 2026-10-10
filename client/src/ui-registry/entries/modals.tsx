import React from 'react';
import { ScriptImportView } from '../../views/ScriptImportView';
import { ExportModal } from '../../components/export/ExportModal';
import { McpToolsModal } from '../../components/mcp/McpToolsModal';
import { SkillStudioModal } from '../../components/skills/SkillStudioModal';
import { ProviderManagerModal } from '../../components/provider/ProviderManagerModal';
import { ProviderCreateModal } from '../../components/provider/ProviderCreateModal';
import { WorkflowImportModal } from '../../components/workflow/WorkflowImportModal';
import { WorkflowInspectorModal } from '../../components/workflow/WorkflowInspectorModal';
import { GlobalDialogContainer } from '../../components/ui/GlobalDialogContainer';
import { FirstRunWizard } from '../../components/onboarding/FirstRunWizard';
import { register } from '../registry';
import { useModalIntentsStore } from '../modalIntents';
import { markAttrs } from '../types';

/**
 * 弹窗条目的**同框标记层**（审查 M3）。
 *
 * 为什么不是「给槽位加包裹层」：`app` 宿主的条目根元素是 `fixed inset-0` 的覆盖层，
 * 套一层静态 div 后那层高度为 0 —— 标注描边会退化成视口底部的一条游离细线
 * （`UISlot` 因此对 `app` / `main.tips` 不再加层）。这里由条目自己渲染一层与覆盖层**同框**
 * 的标记层：只在弹窗打开时出现、`pointer-events-none` 不吃点击、z-index 压在弹窗之上
 * 以便描边可见。于是「这条覆盖层是注册表条目」在标注模式下是看得见的。
 */
const ModalWithMark: React.FC<{ id: string; open: boolean; children: React.ReactNode }> = ({ id, open, children }) => (
  <>
    {open && (
      <div
        className="fixed inset-0 pointer-events-none z-[9999]"
        {...markAttrs({ id, kind: 'modal', source: 'builtin' })}
      />
    )}
    {children}
  </>
);

/**
 * 全局弹窗 / 覆盖层条目登记（Phase 2：把 `App.tsx` 的 10 段全局弹窗 JSX 搬进注册表）。
 *
 * **行为零变化**是本轮唯一验收口径，逐条对照如下：
 *   - 打开机制：仍是那 8 个 `window` 自定义事件 + Header/Sidebar 等既有触发点，
 *     事件名、触发时机、`detail` 参数一个都没改；变的是监听器写 `useModalIntentsStore`
 *     而不是改 App 的局部 state（弹窗渲染位置挪走后，槽里的组件读不到 App 局部 state）。
 *   - 参数传递：与改造前 JSX 的 props 一一对应（见每条组件的实现）。
 *   - 关闭行为：原 `onClose` 里做什么，这里就做什么（`closeProviderManager` 同时清 editProvider，
 *     与 `setIsProviderOpen(false); setProviderEdit(null)` 等价）。
 *   - 回调派发的事件：`provider-list-refresh` / `provider-created` / `onImported → 打开槽位配置` /
 *     `onSaved → 关闭 + provider-list-refresh` 全部原样保留。
 *   - 层叠顺序：**order 与原先 JSX 从上到下的顺序严格一一对应**
 *     （脚本导入 10 → 导出 20 → MCP 30 → 技能工坊 40 → 生成源管理 50 → 新建生成源 60 →
 *      工作流导入 70 → 工作流槽位配置 80 → 全局对话容器 90 → 首次安装向导 100）。
 *
 * `render` 一律用**模块级组件**（不是内联箭头函数）：槽按 `entry.id` 加 key，
 * 若每次 render 新建组件类型，React 会当成新类型整棵重建，弹窗内部 state 会莫名丢失。
 *
 * 这些组件之所以 `export`：本模块只有组件这一种导出，符合 `react/only-export-components`
 * （快刷新的前置条件），顺带让单测能单独渲染某一条弹窗；注册本身仍是模块副作用，与 pages.tsx 同构。
 *
 * 本轮 10 条都**不绑 switchId**（迁移期常驻，行为等于改造前的「永远挂载」）：
 * 绑了 switchId 而真相源里又没这个开关，条目会被判为「未开启」而整条不渲染 —— 那是行为变化，不是重构。
 */

/** 1. 导入小说（脚本拆解） */
export const ScriptImportEntry: React.FC = () => {
  const isOpen = useModalIntentsStore((s) => s.importOpen);
  const onClose = useModalIntentsStore((s) => s.closeImport);
  return (
    <ModalWithMark id="modal.script-import" open={isOpen}>
      <ScriptImportView isOpen={isOpen} onClose={onClose} />
    </ModalWithMark>
  );
};

/** 2. 导出工程 */
export const ExportEntry: React.FC = () => {
  const isOpen = useModalIntentsStore((s) => s.exportOpen);
  const onClose = useModalIntentsStore((s) => s.closeExport);
  return (
    <ModalWithMark id="modal.export" open={isOpen}>
      <ExportModal isOpen={isOpen} onClose={onClose} />
    </ModalWithMark>
  );
};

/** 3. MCP 工具 */
export const McpToolsEntry: React.FC = () => {
  const isOpen = useModalIntentsStore((s) => s.mcpOpen);
  const onClose = useModalIntentsStore((s) => s.closeMcp);
  return (
    <ModalWithMark id="modal.mcp-tools" open={isOpen}>
      <McpToolsModal isOpen={isOpen} onClose={onClose} />
    </ModalWithMark>
  );
};

/** 4. 技能工坊 */
export const SkillStudioEntry: React.FC = () => {
  const isOpen = useModalIntentsStore((s) => s.skillsOpen);
  const onClose = useModalIntentsStore((s) => s.closeSkills);
  return (
    <ModalWithMark id="modal.skill-studio" open={isOpen}>
      <SkillStudioModal isOpen={isOpen} onClose={onClose} />
    </ModalWithMark>
  );
};

/** 5. 生成源管理（editProvider 非空则直接进编辑态） */
export const ProviderManagerEntry: React.FC = () => {
  const isOpen = useModalIntentsStore((s) => s.providerManagerOpen);
  const editProvider = useModalIntentsStore((s) => s.providerEdit);
  const onClose = useModalIntentsStore((s) => s.closeProviderManager);
  return (
    <ModalWithMark id="modal.provider-manager" open={isOpen}>
      <ProviderManagerModal isOpen={isOpen} editProvider={editProvider} onClose={onClose} />
    </ModalWithMark>
  );
};

/** 6. 新建自定义生成源（统一创建弹窗）：成功后刷新列表并广播 provider-created（画布可自动选中新源） */
export const ProviderCreateEntry: React.FC = () => {
  const isOpen = useModalIntentsStore((s) => s.providerCreate.open);
  const defaultTab = useModalIntentsStore((s) => s.providerCreate.tab);
  const defaultKind = useModalIntentsStore((s) => s.providerCreate.kind);
  const selectOnCreate = useModalIntentsStore((s) => s.providerCreate.select);
  // source 与改造前的 createState.source 等价（打开时才写入，弹窗生命周期内不变）
  const source = useModalIntentsStore((s) => s.providerCreate.source);
  const onClose = useModalIntentsStore((s) => s.closeProviderCreate);
  const onCreated = (provider: any, opts: { select: boolean }) => {
    window.dispatchEvent(new Event('provider-list-refresh'));
    window.dispatchEvent(new CustomEvent('provider-created', { detail: { provider, select: opts.select, source } }));
  };
  return (
    <ModalWithMark id="modal.provider-create" open={isOpen}>
      <ProviderCreateModal
        isOpen={isOpen}
        defaultTab={defaultTab}
        defaultKind={defaultKind}
        selectOnCreate={selectOnCreate}
        onClose={onClose}
        onCreated={onCreated}
      />
    </ModalWithMark>
  );
};

/** 7. ComfyUI 工作流导入 → 槽位配置（保存即派生生成源） */
export const WorkflowImportEntry: React.FC = () => {
  const isOpen = useModalIntentsStore((s) => s.workflowImportOpen);
  const onClose = useModalIntentsStore((s) => s.closeWorkflowImport);
  const openInspector = useModalIntentsStore((s) => s.openWorkflowInspector);
  const onImported = (wfId: string) => {
    onClose();
    if (wfId) openInspector(wfId);
  };
  return (
    <ModalWithMark id="modal.workflow-import" open={isOpen}>
      <WorkflowImportModal isOpen={isOpen} onClose={onClose} onImported={onImported} />
    </ModalWithMark>
  );
};

/**
 * 8. 工作流槽位配置：改造前外面包着 `{wfInspectId && (...)}`，
 * 「未选中工作流就不渲染」必须保留 —— 空 id 直接返回 null（组件不挂载，内部 state 不残留）。
 * 注意：改造前没传 `onDeleted`，这里也不传。
 */
export const WorkflowInspectorEntry: React.FC = () => {
  const wfInspectId = useModalIntentsStore((s) => s.wfInspectId);
  const onClose = useModalIntentsStore((s) => s.closeWorkflowInspector);
  const onSaved = () => {
    onClose();
    window.dispatchEvent(new Event('provider-list-refresh'));
  };
  if (!wfInspectId) return null;
  return (
    <ModalWithMark id="modal.workflow-inspector" open={!!wfInspectId}>
      <WorkflowInspectorModal
        workflowId={wfInspectId}
        isOpen={!!wfInspectId}
        onClose={onClose}
        onSaved={onSaved}
      />
    </ModalWithMark>
  );
};

/**
 * 9. 全局 Toast / Confirm / Prompt：唯一反馈通道（设计 §9.1），永远渲染。
 * 标注说明（M3）：本条目无「打开态」，且根是散落的 toast（不是同框覆盖层），
 * 故不做标记层 —— 标注模式里它保持不可见（注册表视图仍列出它）。
 */
export const GlobalDialogEntry: React.FC = () => <GlobalDialogContainer />;

/**
 * 10. 首次安装向导：首次启动且未配置能力时自动弹出（组件内部判定）；设置 → 系统 可随时重开。
 * 标注说明（M3）：开关状态在组件内部，宿主拿不到「是否打开」，同样不做标记层（同 9）。
 */
export const FirstRunWizardEntry: React.FC = () => <FirstRunWizard />;

interface ModalImpl {
  id: string;
  /** 与改造前 App.tsx 里 JSX 的先后顺序一一对应（决定同屏层叠顺序） */
  order: number;
  view: React.ComponentType<any>;
  /** 跳过一切开关判断永远渲染（且注册时禁止绑 switchId） */
  locked?: boolean;
}

const MODAL_IMPLS: ModalImpl[] = [
  { id: 'modal.script-import', order: 10, view: ScriptImportEntry },
  { id: 'modal.export', order: 20, view: ExportEntry },
  { id: 'modal.mcp-tools', order: 30, view: McpToolsEntry },
  { id: 'modal.skill-studio', order: 40, view: SkillStudioEntry },
  { id: 'modal.provider-manager', order: 50, view: ProviderManagerEntry },
  { id: 'modal.provider-create', order: 60, view: ProviderCreateEntry },
  { id: 'modal.workflow-import', order: 70, view: WorkflowImportEntry },
  { id: 'modal.workflow-inspector', order: 80, view: WorkflowInspectorEntry },
  { id: 'modal.global-dialog', order: 90, view: GlobalDialogEntry, locked: true },
  { id: 'modal.first-run-wizard', order: 100, view: FirstRunWizardEntry },
];

/** 注册全部全局弹窗条目；返回反注册函数（热重载 / 测试用，正常生命周期不需要调） */
function registerModalEntries(): () => void {
  const undo: Array<() => void> = [];
  MODAL_IMPLS.forEach((m) => {
    undo.push(register({
      id: m.id,
      kind: 'modal',
      host: 'app',
      order: m.order,
      locked: m.locked,
      source: 'builtin',
      render: m.view,
    }));
  });
  return () => undo.forEach((fn) => fn());
}

registerModalEntries();
