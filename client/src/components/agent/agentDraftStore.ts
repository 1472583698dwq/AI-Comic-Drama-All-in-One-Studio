/**
 * Agent 输入框草稿 —— 独立的小 store，**刻意不放进 `agentStore`**。
 *
 * 两个原因：
 * 1. 切换工作区 tab（画布 ↔ AI 导演 ↔ 素材库）会卸载整棵子树，组件内 `useState`
 *    一卸载就没了，用户切回来发现刚写的指令被清空。草稿必须活在组件之外。
 * 2. 若把草稿塞进 `agentStore`，每次按键都会触发一次 store 变更；而画布侧栏等
 *    订阅方是"无选择器订阅整个 store"，于是**每个字符都会让整棵会话流重渲染**
 *    （消息多了会明显卡）。草稿单独成 store，订阅面就只有输入框本身。
 *
 * 待发送的附件（图/视频/音频）与草稿同生命周期：切 tab 不丢、发送/换会话即清。
 * 持久化：draft 到 localStorage；attachments 不持久化（避免刷新后引用失效）。
 */
import { create } from 'zustand';
import type { AgentAttachment } from './agentTypes';

const KEY = 'agent_draft';
export const MAX_ATTACHMENTS = 8;

interface AgentDraftState {
  draft: string;
  attachments: AgentAttachment[];
  /** 最近一次输入是通过长文本粘贴进入（用于消息列表折叠展示） */
  pastedBulk: boolean;
  setDraft: (t: string) => void;
  addAttachments: (list: AgentAttachment[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  markPastedBulk: (v: boolean) => void;
}

export const useAgentDraftStore = create<AgentDraftState>((set, get) => ({
  draft: (() => {
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  })(),
  attachments: [],
  pastedBulk: false,
  setDraft: (t) => {
    set({ draft: t });
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  },
  addAttachments: (list) => {
    const cur = get().attachments;
    const seen = new Set(cur.map((a) => a.ref));
    const next = [...cur];
    for (const a of list || []) {
      if (!a?.ref || seen.has(a.ref)) continue;
      seen.add(a.ref);
      next.push(a);
      if (next.length >= MAX_ATTACHMENTS) break;
    }
    set({ attachments: next });
  },
  removeAttachment: (id) => set({ attachments: get().attachments.filter((a) => a.id !== id) }),
  clearAttachments: () => set({ attachments: [] }),
  markPastedBulk: (v) => set({ pastedBulk: !!v }),
}));

/** 供 store 之外（agentStore 的换会话/发送逻辑）清空草稿与附件。 */
export function clearAgentDraft(): void {
  const st = useAgentDraftStore.getState();
  st.setDraft('');
  st.clearAttachments();
  st.markPastedBulk(false);
}
