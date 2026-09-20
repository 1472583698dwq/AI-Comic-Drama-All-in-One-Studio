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
 * 持久化到 localStorage：刷新页面也不丢（换会话/发送时由调用方显式清）。
 */
import { create } from 'zustand';

const KEY = 'agent_draft';

interface AgentDraftState {
  draft: string;
  setDraft: (t: string) => void;
}

export const useAgentDraftStore = create<AgentDraftState>((set) => ({
  draft: (() => {
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  })(),
  setDraft: (t) => {
    set({ draft: t });
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  },
}));

/** 供 store 之外（agentStore 的换会话/发送逻辑）清空草稿。 */
export function clearAgentDraft(): void {
  useAgentDraftStore.getState().setDraft('');
}
