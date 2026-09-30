/**
 * 侧栏聊天历史（跨项目）—— ZCode WorkspaceSidebar 的任务历史同位。
 *
 * 数据形态：全项目列表 + 各项目的 page 会话并行拉取，摊平成 entries。
 * 归档：AgentSession.archived 字段透传（服务端原样落盘，后端零改动）；
 *       目标项目是当前活跃项目时，同步改 useAgentStore 的内存态（该列表就是它的持久化源）。
 * 视图偏好（会话/项目、排序）localStorage 持久化（ZCode sidebarTaskPreferences 同款）。
 */
import { create } from 'zustand';
import { apiService } from '../services/api';
import { useAgentStore } from '../components/agent/agentStore';
import type { AgentSession } from '../components/agent/agentTypes';

export type ChatHistoryView = 'sessions' | 'projects';
export type ChatHistorySort = 'updated' | 'created';

const PREFS_KEY = 'sidebar_chat_history_prefs';

export interface ChatHistoryEntry {
  projectId: string;
  projectTitle: string;
  session: AgentSession;
}

function loadPrefs(): { view: ChatHistoryView; sortBy: ChatHistorySort } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        view: p.view === 'projects' ? 'projects' : 'sessions',
        sortBy: p.sortBy === 'created' ? 'created' : 'updated',
      };
    }
  } catch { /* ignore */ }
  return { view: 'sessions', sortBy: 'updated' };
}

interface ChatHistoryState {
  entries: ChatHistoryEntry[];
  loading: boolean;
  loadedAt: number | null;
  view: ChatHistoryView;
  sortBy: ChatHistorySort;
  refresh(): Promise<void>;
  setView(v: ChatHistoryView): void;
  setSortBy(s: ChatHistorySort): void;
  /** 归档/取消归档；活跃项目的会话会同步 useAgentStore 内存态 */
  setSessionArchived(projectId: string, sessionId: string, archived: boolean): Promise<void>;
  removeSession(projectId: string, sessionId: string): Promise<void>;
}

export const useChatHistoryStore = create<ChatHistoryState>()((set, get) => {
  const prefs = loadPrefs();

  const saveProjectSessions = async (projectId: string, sessions: AgentSession[]) => {
    await apiService.saveProjectAgentSessions(projectId, sessions, 'page');
  };

  return {
    entries: [],
    loading: false,
    loadedAt: null,
    view: prefs.view,
    sortBy: prefs.sortBy,

    async refresh() {
      set({ loading: true });
      try {
        const { projects } = await apiService.listProjects({ sort: 'updated_at' });
        const lists = await Promise.all(
          (projects || []).map(async (p: any) => {
            try {
              const res = await apiService.getProjectAgentSessions(p.id, 'page');
              return { project: p, sessions: (res?.sessions || []) as AgentSession[] };
            } catch {
              return { project: p, sessions: [] as AgentSession[] };
            }
          })
        );
        const entries: ChatHistoryEntry[] = [];
        for (const { project, sessions } of lists) {
          for (const session of sessions) {
            entries.push({ projectId: project.id, projectTitle: project.title || project.id, session });
          }
        }
        set({ entries, loading: false, loadedAt: Date.now() });
      } catch {
        set({ loading: false });
      }
    },

    setView(v) {
      set({ view: v });
      try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), view: v })); } catch { /* ignore */ }
    },

    setSortBy(s) {
      set({ sortBy: s });
      try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), sortBy: s })); } catch { /* ignore */ }
    },

    async setSessionArchived(projectId, sessionId, archived) {
      const activePid = useAgentStore.getState().projectId;
      if (activePid === projectId) {
        // 活跃项目：改 useAgentStore 内存列表并以其为准落盘（该列表就是 page scope 的持久化源）
        const agent = useAgentStore.getState();
        const next = agent.sessions.map((s) => (s.id === sessionId ? { ...s, archived } : s));
        useAgentStore.setState({ sessions: next });
        await saveProjectSessions(projectId, next);
      } else {
        const res = await apiService.getProjectAgentSessions(projectId, 'page');
        const next = ((res?.sessions || []) as AgentSession[]).map((s) =>
          s.id === sessionId ? { ...s, archived } : s
        );
        await saveProjectSessions(projectId, next);
      }
      set({ entries: get().entries.map((e) => (e.projectId === projectId && e.session.id === sessionId ? { ...e, session: { ...e.session, archived } } : e)) });
    },

    async removeSession(projectId, sessionId) {
      const activePid = useAgentStore.getState().projectId;
      if (activePid === projectId) {
        await useAgentStore.getState().deleteSession(sessionId);
      } else {
        await apiService.deleteProjectAgentSession(projectId, sessionId);
      }
      set({ entries: get().entries.filter((e) => !(e.projectId === projectId && e.session.id === sessionId)) });
    },
  };
});
