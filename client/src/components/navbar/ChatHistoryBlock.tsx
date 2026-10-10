import React from 'react';
import { useProjectStore, selectSidebarCollapsed } from '../../stores/useProjectStore';
import { useProjectListStore } from '../../stores/useProjectListStore';
import type { ChatHistoryEntry } from '../../stores/useChatHistoryStore';
import { useAgentStore } from '../agent/agentStore';
import { markAttrs } from '../../ui-registry/types';
import { ChatHistory } from './ChatHistory';

/**
 * 侧栏下半部「会话 / 项目快捷区」（Phase 3：从 `Sidebar` 抽出来，登记为注册表条目
 * `sidebar.chat-history`，开关仍是 `sidebar_chat_history`）。
 *
 * 抽出来的原因：这块是**唯一由 UI 偏好控制**的侧栏内容，之前在 `Sidebar` 里硬编码。
 * 现在它是一条注册表条目（`scope: 'prefs'`），开关一关条目即从槽位移除、整块消失。
 *
 * 布局注意：`ChatHistory` 的根节点是 `flex-1 min-h-0 flex flex-col`，依赖自己是侧栏列的
 * flex 子元素；所以本组件自己渲染那层 `flex-1` 容器（同时把标注属性打在它上面），
 * 而不是让槽位再包一层普通 div —— 那会把 flex-1 链打断。
 */
export const ChatHistoryBlock: React.FC = () => {
  const collapsed = useProjectStore(selectSidebarCollapsed);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const setActiveTab = useProjectStore((s) => s.setActiveTab);

  /** 历史行点击：切项目（双 store 同步）→ 绑定并选中目标会话 → 进对话页 */
  const openEntry = async (e: ChatHistoryEntry) => {
    const cur = useProjectStore.getState().project;
    if (cur?.id !== e.projectId) {
      useProjectListStore.getState().setActiveProjectId(e.projectId);
      await useProjectStore.getState().loadActiveProject(e.projectId);
    }
    setActiveTab('agent');
    useAgentStore.getState().bindProject(e.projectId, e.session.id);
  };

  // 收起成图标轨时整块隐藏（与改造前 `!effectiveCollapsed && historyVisible` 一致）
  if (collapsed) return null;

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      // 自标：侧栏块必须自己是侧栏列的 flex 子元素，槽位不给它套包裹层（见 UISlot 注释）
      {...markAttrs({ id: 'sidebar.chat-history', kind: 'sidebar-block', scope: 'prefs', source: 'builtin' })}
    >
      <div className="mx-3 my-1.5 h-px bg-border shrink-0" />
      <ChatHistory activeSessionId={activeSessionId} onOpenEntry={(e) => { void openEntry(e); }} />
    </div>
  );
};

export default ChatHistoryBlock;
