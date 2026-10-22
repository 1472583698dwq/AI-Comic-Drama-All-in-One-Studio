/**
 * 侧栏下半部聊天历史区 —— ZCode WorkspaceSidebar 任务历史同位。
 *
 * - 会话/项目两种视图（圆角 Tabs，ZCode TabsList 同款）
 * - 筛选下拉（排序：更新时间/创建时间，localStorage 持久化）
 * - 归档：行 hover 两段式确认归档；归档切换按钮进归档视图（取消归档/删除）
 * - 点击行 → onOpenEntry（父级负责切项目/切会话/进对话页）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Hash, Folder, ListFilter, Archive, ArchiveX, Trash2, Check, ChevronDown, ChevronRight, Check as CheckIcon,
  Maximize2, Minimize2, Plus, MessageCirclePlus,
} from 'lucide-react';
import { useChatHistoryStore, type ChatHistoryEntry } from '../../stores/useChatHistoryStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useAgentStore } from '../agent/agentStore';
import { toast } from '../../stores/useDialogStore';
import { NewProjectModal } from '../project/NewProjectModal';
import { startNewTaskInProject } from '../../utils/newTaskFlow';

const MAIN = '[color:var(--color-text-main)]';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / M-D */
const relTime = (iso?: string) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  const dt = new Date(iso);
  return `${dt.getMonth() + 1}-${dt.getDate()}`;
};

export const ChatHistory: React.FC<{
  activeSessionId: string;
  onOpenEntry: (e: ChatHistoryEntry) => void;
}> = ({ activeSessionId, onOpenEntry }) => {
  const {
    entries, projects, loading, view, sortBy, setView, setSortBy, setSessionArchived, removeSession, refresh,
  } = useChatHistoryStore();
  const [showArchived, setShowArchived] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [confirmActionId, setConfirmActionId] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  /** 收起全部：项目分组整列隐藏，只留一行「项目」可下拉展开 */
  const [projectsFolded, setProjectsFolded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /** 新建弹窗的用途：项目视图「+」建项目；会话空态「新建任务」建完直接进对话 */
  const [createIntent, setCreateIntent] = useState<'project' | 'task'>('project');
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen]);

  // 两段式确认超时自动复位
  useEffect(() => {
    if (!confirmActionId) return;
    const t = setTimeout(() => setConfirmActionId(null), 2500);
    return () => clearTimeout(t);
  }, [confirmActionId]);

  const sortByKey = useCallback((a: ChatHistoryEntry, b: ChatHistoryEntry) => {
    const k = sortBy === 'created' ? 'created_at' : 'updated_at';
    return String(b.session[k] || '').localeCompare(String(a.session[k] || ''));
  }, [sortBy]);

  const activeEntries = useMemo(
    () => entries.filter((e) => !e.session.archived).sort(sortByKey),
    [entries, sortByKey]
  );
  const archivedEntries = useMemo(
    () => entries.filter((e) => e.session.archived).sort(sortByKey),
    [entries, sortByKey]
  );
  // 项目视图显示全部项目（没有会话的新项目也占一个空分组，保证「新建完就能看到」）
  const projectGroups = useMemo(() => {
    const groups = projects.map((p) => ({
      projectId: p.id,
      projectTitle: p.title || p.id,
      items: activeEntries.filter((e) => e.projectId === p.id),
    }));
    const known = new Set(groups.map((g) => g.projectId));
    for (const e of activeEntries) {
      if (!known.has(e.projectId)) {
        groups.push({
          projectId: e.projectId,
          projectTitle: e.projectTitle,
          items: activeEntries.filter((x) => x.projectId === e.projectId),
        });
        known.add(e.projectId);
      }
    }
    return groups;
  }, [projects, activeEntries]);

  const doArchive = async (e: ChatHistoryEntry, archived: boolean) => {
    await setSessionArchived(e.projectId, e.session.id, archived);
    setConfirmActionId(null);
  };
  const doRemove = async (e: ChatHistoryEntry) => {
    await removeSession(e.projectId, e.session.id);
    setConfirmActionId(null);
  };

  /** 空态「新建任务」：有项目直接进对话；无项目先弹「名称+风格模板」引导（与侧栏顶部按钮同流程） */
  const handleStartTask = () => {
    if (!startNewTaskInProject()) {
      setCreateIntent('task');
      setCreateOpen(true);
    }
  };

  const actionBtn = 'p-1 rounded-md hover:bg-surface-tertiary [color:var(--color-text-main)] shrink-0';

  const renderRow = (e: ChatHistoryEntry, opts: { showProject?: boolean; archived?: boolean; indent?: boolean }) => {
    const sid = e.session.id;
    const isActive = !opts?.archived && sid === activeSessionId;
    const key = `${e.projectId}_${sid}`;
    return (
      <div
        key={key}
        onClick={() => { if (!opts?.archived) onOpenEntry(e); }}
        className={`group/hist flex items-start gap-1 rounded-lg pr-1 py-1 cursor-pointer transition-colors ${
          opts?.indent ? 'pl-10' : 'pl-2.5'
        } ${
          isActive ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'
        }`}
      >
        <div className="flex-1 min-w-0 py-0.5">
          <div className={`text-xs leading-4 truncate ${MAIN} ${isActive ? 'font-semibold' : ''}`}>
            {e.session.title || '新会话'}
          </div>
          <div className={`text-[10px] leading-4 truncate ${MAIN} opacity-60`}>
            {opts?.showProject !== false && <span>{e.projectTitle} · </span>}
            {relTime(sortBy === 'created' ? e.session.created_at : e.session.updated_at)}
          </div>
        </div>
        <div className="flex items-center gap-0.5 pt-1 opacity-0 group-hover/hist:opacity-100 shrink-0">
          {opts?.archived ? (
            <>
              <button type="button" title="取消归档" className={actionBtn}
                onClick={(ev) => { ev.stopPropagation(); void doArchive(e, false); }}>
                <ArchiveX className="w-3.5 h-3.5" />
              </button>
              <button type="button"
                title={confirmActionId === key ? '确认删除' : '删除会话'}
                className={`${actionBtn} ${confirmActionId === key ? 'bg-red-500/15 text-red-400!' : ''}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (confirmActionId === key) { void doRemove(e); } else { setConfirmActionId(key); }
                }}>
                {confirmActionId === key ? <CheckIcon className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
              </button>
            </>
          ) : (
            <button type="button"
              title={confirmActionId === key ? '确认归档' : '归档会话'}
              className={`${actionBtn} ${confirmActionId === key ? 'bg-amber-500/15 text-amber-500!' : ''}`}
              onClick={(ev) => {
                ev.stopPropagation();
                if (confirmActionId === key) { void doArchive(e, true); } else { setConfirmActionId(key); }
              }}>
              {confirmActionId === key ? <CheckIcon className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 工具行：视图 Tabs + 筛选 + 归档切换 */}
      <div className="flex items-center gap-1 px-2 pb-1.5 shrink-0">
        <div className="flex items-center rounded-full bg-surface p-0.5">
          <button
            type="button"
            title="按会话"
            onClick={() => { setView('sessions'); setShowArchived(false); }}
            className={`h-6 rounded-full px-2 text-[10px] font-medium inline-flex items-center gap-1 transition-colors ${
              view === 'sessions' && !showArchived ? 'bg-surface-tertiary [color:var(--color-text-main)]' : `${MAIN} opacity-60 hover:opacity-100`
            }`}
          >
            <Hash className="w-3 h-3" />会话
          </button>
          <button
            type="button"
            title="按项目"
            onClick={() => { setView('projects'); setShowArchived(false); }}
            className={`h-6 rounded-full px-2 text-[10px] font-medium inline-flex items-center gap-1 transition-colors ${
              view === 'projects' && !showArchived ? 'bg-surface-tertiary [color:var(--color-text-main)]' : `${MAIN} opacity-60 hover:opacity-100`
            }`}
          >
            <Folder className="w-3 h-3" />项目
          </button>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {view === 'projects' && !showArchived && (() => {
            // 动态单按钮：没全部展开 → 「全部展开」；已全部展开 → 「全部收起」（折叠成一行「项目」）
            const allExpanded = !projectsFolded && collapsedProjects.size === 0;
            return (
              <button
                type="button"
                title={allExpanded ? '收起全部：所有项目折叠成一行「项目」' : '全部展开：显示所有项目与其会话'}
                onClick={() => {
                  if (allExpanded) {
                    setProjectsFolded(true);
                    setCollapsedProjects(new Set(projectGroups.map((g) => g.projectId)));
                  } else {
                    setProjectsFolded(false);
                    setCollapsedProjects(new Set());
                  }
                }}
                className={`p-1.5 rounded-lg transition-colors ${MAIN} hover:bg-surface-hover`}
              >
                {allExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            );
          })()}
          {view === 'sessions' && !showArchived && (
            <button
              type="button"
              title="新建会话"
              aria-label="新建会话"
              onClick={handleStartTask}
              className="p-1.5 rounded-lg text-brand hover:bg-brand/10 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          <div ref={filterRef} className="relative">
            <button
              type="button"
              title="筛选与排序"
              onClick={() => setFilterOpen((v) => !v)}
              className={`p-1.5 rounded-lg transition-colors ${filterOpen ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'} ${MAIN}`}
            >
              <ListFilter className="w-3.5 h-3.5" />
            </button>
            {filterOpen && (
              <div className="absolute top-full mt-1 right-0 z-50 w-40 bg-surface border border-border rounded-xl p-1 animate-fade-in">
                <div className="px-2 pt-1 pb-0.5 text-[9px] font-bold [color:var(--color-text-main)] opacity-60">排序</div>
                {([
                  { key: 'updated', label: '更新时间' },
                  { key: 'created', label: '创建时间' },
                ] as const).map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => { setSortBy(o.key); setFilterOpen(false); }}
                    className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] [color:var(--color-text-main)] hover:bg-surface-hover ${
                      sortBy === o.key ? 'bg-surface-tertiary' : ''
                    }`}
                  >
                    <span className="flex-1 text-left">{o.label}</span>
                    {sortBy === o.key && <Check className="w-3 h-3 text-brand shrink-0" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            title={showArchived ? '退出归档视图' : '查看已归档会话'}
            onClick={() => setShowArchived((v) => !v)}
            className={`p-1.5 rounded-lg transition-colors ${
              showArchived ? 'bg-surface-tertiary text-amber-500' : `${MAIN} hover:bg-surface-hover`
            }`}
          >
            {showArchived ? <ArchiveX className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-1.5 pb-2 space-y-0.5">
        {loading && entries.length === 0 && (
          <div className={`px-2.5 py-3 text-[11px] ${MAIN} opacity-60`}>正在加载会话…</div>
        )}

        {!loading && entries.length === 0 && (
          <div className={`px-2.5 py-3 ${MAIN}`}>
            <div className="text-[11px] opacity-60 leading-5">还没有会话</div>
            <button
              type="button"
              onClick={handleStartTask}
              className="mt-2 w-full h-7 rounded-lg bg-gradient-to-r from-brand to-brand-blue text-white text-[11px] font-bold inline-flex items-center justify-center gap-1.5 hover:opacity-95 active:scale-[0.99] transition-all"
            >
              <MessageCirclePlus className="w-3.5 h-3.5" />新建任务
            </button>
            <div className="mt-1.5 text-[10px] opacity-50 leading-4">
              无项目时会先引导起个项目名、挑风格模板，创建后直接开始 AI 对话。
            </div>
          </div>
        )}

        {showArchived && (
          <>
            <div className={`px-2 pt-1 pb-1 text-[10px] font-bold ${MAIN} opacity-60`}>已归档 · {archivedEntries.length}</div>
            {archivedEntries.length === 0 && (
              <div className={`px-2.5 py-3 text-[11px] ${MAIN} opacity-60`}>没有已归档的会话</div>
            )}
            {archivedEntries.map((e) => renderRow(e, { archived: true }))}
          </>
        )}

        {!showArchived && view === 'sessions' && activeEntries.length > 0 && (
          <button
            type="button"
            onClick={handleStartTask}
            title="新建独立会话，不影响当前会话"
            className="mb-1 flex h-8 w-full items-center gap-2 rounded-lg border border-dashed border-brand/30 px-2.5 text-[11px] font-semibold text-brand transition-colors hover:border-brand/60 hover:bg-brand/10"
          >
            <MessageCirclePlus className="h-3.5 w-3.5 shrink-0" />
            <span>新建会话</span>
            <Plus className="ml-auto h-3 w-3 opacity-60" />
          </button>
        )}

        {!showArchived && view === 'sessions' && activeEntries.map((e) => renderRow(e, { showProject: true }))}

        {!showArchived && view === 'projects' && (
          <>
            {/* 项目常驻头行：箭头在文字右侧，最右加号新建项目 */}
            <div className="flex items-center gap-0.5 h-8 rounded-lg px-2 mb-0.5 shrink-0">
              <button
                type="button"
                onClick={() => setProjectsFolded((v) => !v)}
                title={projectsFolded ? '展开项目列表' : '收起项目列表'}
                className="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left group/prj"
              >
                <span className={`text-[11px] font-semibold ${MAIN}`}>项目</span>
                {projectsFolded && (
                  <span className={`text-[9px] font-mono ${MAIN} opacity-50`}>{activeEntries.length}</span>
                )}
                {projectsFolded
                  ? <ChevronRight className="ml-auto w-3 h-3 [color:var(--color-text-main)] opacity-60" />
                  : <ChevronDown className="ml-auto w-3 h-3 [color:var(--color-text-main)] opacity-60" />}
              </button>
              <button
                type="button"
                title="新建项目"
                onClick={() => { setCreateIntent('project'); setCreateOpen(true); }}
                className="p-1 rounded-md hover:bg-surface-hover [color:var(--color-text-main)] shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {!projectsFolded && projectGroups.map((g) => {
          const collapsed = collapsedProjects.has(g.projectId);
          return (
            <div key={g.projectId} className="space-y-0.5">
              <button
                type="button"
                onClick={() => setCollapsedProjects((prev) => {
                  const n = new Set(prev);
                  if (n.has(g.projectId)) n.delete(g.projectId); else n.add(g.projectId);
                  return n;
                })}
                className="w-full h-7 flex items-center gap-1.5 rounded-lg pl-6 pr-1 hover:bg-surface-hover transition-colors"
              >
                {collapsed ? <ChevronRight className="w-3 h-3 [color:var(--color-text-main)] opacity-60" /> : <ChevronDown className="w-3 h-3 [color:var(--color-text-main)] opacity-60" />}
                <Folder className="w-3.5 h-3.5 [color:var(--color-text-main)] opacity-60 shrink-0" />
                <span className={`text-[11px] font-semibold ${MAIN} truncate flex-1 text-left`}>{g.projectTitle}</span>
                <span className={`text-[9px] font-mono ${MAIN} opacity-50`}>{g.items.length}</span>
              </button>
              {!collapsed && (g.items.length === 0 ? (
                <div className={`pl-12 pr-2 py-1 text-[10px] ${MAIN} opacity-50`}>暂无会话</div>
              ) : g.items.map((e) => renderRow(e, { showProject: false, indent: true })))}
            </div>
          );
        })}
          </>
        )}

        <NewProjectModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          hint={createIntent === 'task'
            ? '起个项目名、挑个风格模板，创建后直接开始 AI 对话。'
            : undefined}
          onCreated={async (meta) => {
            setCreateOpen(false);
            await useProjectStore.getState().loadActiveProject(meta.id);
            if (createIntent === 'task') {
              // 与侧栏顶部「新建任务」同语义：建完项目直接进对话页
              useProjectStore.getState().setActiveTab('agent');
              useAgentStore.getState().bindProject(meta.id);
              void refresh();
            } else {
              toast.success(`已切换到「${meta.title}」`);
              void refresh();
            }
          }}
        />
      </div>
    </div>
  );
};
