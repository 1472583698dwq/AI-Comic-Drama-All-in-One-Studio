/**
 * 会话历史侧栏 — 从 AgentModeView 抽出（项目级持久化隔离）
 */
import React from 'react';
import { Clock, History, MessageSquare, PanelLeftClose, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { confirmAsync } from '../../stores/useDialogStore';
import type { AgentSession } from './agentTypes';

function formatSessionTime(isoString?: string) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const now = new Date();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `今天 ${timeStr}`;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`;
  } catch {
    return isoString;
  }
}

export interface SessionSidebarProps {
  sessions: AgentSession[];
  activeSessionId: string;
  loading: boolean;
  projectTitle?: string;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** 收起会话栏（按钮就位在标题行右侧，即原先「新建」的位置） */
  onCollapse: () => void;
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  sessions,
  activeSessionId,
  loading,
  projectTitle,
  onCreate,
  onSelect,
  onDelete,
  onCollapse,
}) => {
  const requestDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const ok = await confirmAsync({
      title: '删除会话',
      message: '确定要删除此会话历史记录吗？删除后不可恢复。',
      confirmText: '确认删除',
      cancelText: '取消',
      isDanger: true,
    });
    if (ok) onDelete(id);
  };

  return (
    <aside className="w-full h-full bg-surface-secondary/70 flex flex-col select-none">
      <div className="p-3 pb-2 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-brand/15 border border-brand/30 flex items-center justify-center text-brand shrink-0">
            <History className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-white truncate flex items-center gap-1.5">
              <span>项目会话</span>
              <span className="text-[9px] px-1 py-0.2 rounded bg-brand/20 text-brand font-mono">隔离</span>
            </div>
            <div className="text-[10px] text-gray-500 truncate" title={projectTitle}>
              {projectTitle || '当前项目'}
            </div>
          </div>
        </div>
        <button
          onClick={onCollapse}
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface/70 transition-colors shrink-0"
          title="收起会话列表"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* 通栏「新建会话」—— 与会话列表同属一栏，固定在列表顶部不随条目滚动 */}
      <div className="px-2 pb-2 shrink-0">
        <button
          onClick={onCreate}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-brand/10 hover:bg-brand/20 text-brand text-xs font-semibold transition-colors active:scale-[0.98]"
          title="新建独立会话"
        >
          <Plus className="w-4 h-4" />
          <span>新建会话</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5 custom-scrollbar">
        {loading && sessions.length === 0 ? (
          <div className="py-8 text-center text-xs text-gray-500 flex flex-col items-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin text-brand" />
            <span>加载会话中…</span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-12 text-center text-xs text-gray-500 space-y-2">
            <MessageSquare className="w-8 h-8 mx-auto text-gray-600 opacity-50" />
            <div>暂无会话记录</div>
            <button onClick={onCreate} className="px-3 py-1 rounded-full bg-brand/10 text-brand hover:bg-brand/20 text-xs transition-colors">
              创建新会话
            </button>
          </div>
        ) : (
          sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`group relative p-2.5 rounded-2xl transition-colors cursor-pointer flex flex-col gap-1 ${
                  isActive
                    ? 'bg-brand/15 text-white'
                    : 'hover:bg-surface/70 text-gray-300'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-brand' : 'text-gray-500 group-hover:text-gray-400'}`} />
                    <span className={`text-xs truncate block ${isActive ? 'font-bold text-white' : 'font-medium text-gray-200'}`} title={s.title}>
                      {s.title || '新会话'}
                    </span>
                  </div>
                  <button
                    onClick={(e) => requestDelete(e, s.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                    title="删除此会话"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500 pl-5">
                  <span className="flex items-center gap-1">
                    <Clock className="w-2.5 h-2.5" />
                    <span>{formatSessionTime(s.updated_at || s.created_at)}</span>
                  </span>
                  <span className="font-mono text-gray-400 bg-surface-secondary px-1.5 py-0.2 rounded text-[9px]">
                    {s.messages?.length || 0}条
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="p-2.5 flex items-center justify-between text-[10px] text-gray-500 shrink-0">
        <span className="flex items-center gap-1 text-gray-400">
          <History className="w-3 h-3 text-emerald-400" />
          <span>本工程专属持久化</span>
        </span>
        <span className="font-mono">{sessions.length}个会话</span>
      </div>
    </aside>
  );
};
