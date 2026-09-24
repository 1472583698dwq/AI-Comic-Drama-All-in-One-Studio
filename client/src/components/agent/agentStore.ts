/**
 * Agent 导演台运行时 Store — 页面与抽屉共用的唯一状态源
 * 收口：会话 CRUD/持久化、发送（Plan 预览→确认→执行）、流式事件、暂停/审批/清空、Creator 提案
 * 取代旧版两个组件各自为政的 useState + WS + session 逻辑。
 */
import { create } from 'zustand';
import { apiService } from '../../services/api';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { getNodeSpec } from '../canvas/nodeRegistry';
import { toast } from '../../stores/useDialogStore';
import { agentSocket } from './agentSocket';
import { clearAgentDraft } from './agentDraftStore';
import { collectFromExecutedTools, dispatchSideEffects, reduceAgentEvent } from './agentEventReducer';
import {
  behaviorOfRunMode, composeRunMode, executionOfRunMode, normalizeRunMode,
} from './agentTypes';
import type {
  AgentEvent, AgentMode, AgentSession, ApprovalInfo, ChatMsg, RunMode, WsStatus,
} from './agentTypes';

// 快捷指令按当前链路（无限画布 + 素材库 + 生图/生视频）组织：
// 分镜工作台 / 3D 片场 / 多轨剪辑 / 剪映导出已下线，不再引导这些方向。
export const QUICK_ASK = ['无限画布怎么排连续镜头？', '首尾帧和参考图有什么区别？', '素材库的图怎么挂到画布节点上？'];
export const QUICK_DO = ['在画布上生成一张主角特写并接到视频节点', '把画布现有节点全量执行一遍', '用素材库的道具图做参考生图', '给主角生成一段台词配音'];
export const QUICK_CREATE = ['制作国风悬疑短剧插件包', '给H3视频源补first_frame插槽', '做个6格漫剧画布模板', '新建古风战斗Skill规范'];
export const QUICK_PLAN = ['分析当前项目并给出完整制作计划', '为当前画布规划最佳生成方案', '检查全部生成源与工作流并给修复计划'];

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function uid(prefix: string) {
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
function welcomeMsg(mode: AgentMode): ChatMsg {
  return {
    id: uid('welcome_'),
    sender: 'agent',
    mode,
    text: mode === 'chat'
      ? '这里是 **问答模式**。我只做讲解不动手，不调用任何工具、零副作用。'
      : '这里是 **执行模式**。我会按 ReAct 循环直接调生图/生视频/配音/画布/素材等工具；敏感操作（删源/写文件/跑命令）会弹窗确认。',
    suggested: mode === 'chat' ? QUICK_ASK : QUICK_DO,
    time: '就绪',
  };
}
function makeSession(title: string, mode: AgentMode, runMode: RunMode): AgentSession {
  const iso = new Date().toISOString();
  return { id: uid('sess_'), title, created_at: iso, updated_at: iso, messages: [welcomeMsg(mode)], mode, run_mode: runMode };
}

function autoTitle(sess: AgentSession, messages: ChatMsg[]): string {
  const cur = sess.title;
  if (cur && cur !== '新会话' && !cur.startsWith('会话 ')) return cur;
  const firstUser = messages.find((m) => m.sender === 'user');
  return firstUser ? firstUser.text.slice(0, 20).replace(/[\r\n]+/g, ' ') : cur || '新会话';
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let sseController: AbortController | null = null;
let prevWsStatus: WsStatus = 'closed';

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const { projectId, sessions } = useAgentStore.getState();
    if (projectId && sessions.length) {
      apiService.saveProjectAgentSessions(projectId, sessions).catch((e) => console.warn('[agentStore] persist failed', e));
    }
  }, 600);
}

/**
 * 把「已加入会话」的节点整理成给 LLM 看的紧凑定义。
 *
 * 只给必要字段：模型要能据此定位「这个节点」（id/类型/名称/生成源/参数/已有产出），
 * 并知道它在流程图里的上下游关系 —— 不需要整份 data（里面有 URL 长串与运行时态）。
 */
function buildAgentFocusNodes(): any[] {
  try {
    const cs = useCanvasStore.getState();
    const ids = cs.agentFocusNodeIds || [];
    if (!ids.length) return [];
    const byId = new Map((cs.nodes || []).map((n: any) => [n.id, n]));
    return ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((n: any) => {
        const d: any = n.data || {};
        const spec = getNodeSpec(String(n.type || ''));
        const produced = [
          d.image_url ? '图像' : '',
          d.video_url ? '视频' : '',
          d.audio_url ? '音频' : '',
        ].filter(Boolean).join('/');
        return {
          id: n.id,
          type: n.type,
          label: spec?.label || n.type,
          summary: (d.prompt || d.text || d.brief || d.ai_directive || '').slice(0, 160),
          provider_id: d.provider_id || d.provider || '',
          params: d.params || d.provider_params || undefined,
          produced: produced || undefined,
          agent_state: d.agent_state?.status || undefined,
          upstream: (cs.edges || []).filter((e: any) => e.target === n.id).map((e: any) => e.source),
          downstream: (cs.edges || []).filter((e: any) => e.source === n.id).map((e: any) => e.target),
        };
      });
  } catch {
    return [];
  }
}

function buildContext(): Record<string, any> {
  const ps = useProjectStore.getState();
  const project = ps.project;
  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const active = shots.find((s) => s.id === ps.activeShotId);
  let canvas_summary: string | null = null;
  try {
    const cn = useCanvasStore.getState().nodes;
    if (cn.length > 0) canvas_summary = useCanvasStore.getState().summary;
  } catch {}
  return {
    project_id: project?.id,
    project_title: project?.title,
    project: project || null,
    active_shot: active
      ? {
          id: active.id,
          shot_index: active.shot_index,
          action_desc: active.action_desc,
          image_prompt: active.image_prompt,
          dialogue: active.dialogue,
          camera_framing: active.camera_framing,
          camera_motion: active.camera_motion,
        }
      : null,
    platform: 'desktop',
    canvas_summary,
    // 用户显式「加入会话」的画布节点：让模型知道指令里的「这个节点」指谁
    agent_focus_nodes: buildAgentFocusNodes(),
    workspace: ps.workspace,
  };
}

interface AgentStoreState {
  projectId: string | null;
  sessions: AgentSession[];
  activeSessionId: string;
  loadingSessions: boolean;
  messages: ChatMsg[];
  isRunning: boolean;
  wsStatus: WsStatus;
  streamingMsgId: string | null;
  approvals: Record<string, ApprovalInfo>;
  mode: AgentMode;
  runMode: RunMode;

  bindProject(projectId: string | null): void;
  setMode(m: AgentMode): void;
  setRunMode(r: RunMode): void;
  createSession(): void;
  selectSession(id: string): void;
  deleteSession(id: string): Promise<void>;
  send(raw: string): Promise<void>;
  /** Plan Mode 产出计划后：批准并进入执行（注入 approved_plan） */
  executePlan(msgId: string): Promise<void>;
  abort(): void;
  approve(aid: string, ok: boolean): void;
  clearAll(): Promise<void>;
  applyAgentEvent(ev: AgentEvent): void;
  proposalAction(msgId: string, proposalId: string, kind: 'start' | 'persist' | 'discard' | 'rollback'): Promise<void>;
  applyArtifact(msgId: string, index: number): void;

  _commitMessages(updater: (prev: ChatMsg[]) => ChatMsg[]): void;
  _patchMsg(id: string, fn: (m: ChatMsg) => ChatMsg): void;
}

export const useAgentStore = create<AgentStoreState>()((set, get) => {
  const getPrefs = (): { mode: AgentMode; runMode: RunMode } => {
    let mode: AgentMode = 'execute';
    let runMode: RunMode = 'approve';
    try {
      const m = localStorage.getItem('agent_mode');
      if (m === 'chat' || m === 'execute') mode = m;
      const r = localStorage.getItem('agent_run_mode');
      // 组合 token 归一：兼容历史单维值与口语值（create_auto / plan_auto 也在此恢复）
      if (r) runMode = composeRunMode(behaviorOfRunMode(r), executionOfRunMode(r));
    } catch {}
    return { mode, runMode };
  };

  const sessionKey = () => {
    const { projectId, activeSessionId } = get();
    return projectId && activeSessionId ? `proj_${projectId}_${activeSessionId}` : activeSessionId;
  };

  const commitMessages = (updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    const messages = updater(get().messages);
    const { activeSessionId, sessions, mode, runMode } = get();
    const nextSessions = sessions.map((s) =>
      s.id === activeSessionId
        ? { ...s, messages, title: autoTitle(s, messages), updated_at: new Date().toISOString(), mode, run_mode: runMode }
        : s
    );
    set({ messages, sessions: nextSessions });
    schedulePersist();
  };

  const patchMsg = (id: string, fn: (m: ChatMsg) => ChatMsg) => {
    commitMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  };

  const dispatchRun = async (msgId: string, text: string, ctx: Record<string, any>, mode: AgentMode, runMode: RunMode) => {
    agentSocket.ensure();
    const sent = agentSocket.send({
      action: 'agent_prompt',
      prompt: text,
      context: ctx,
      session_id: sessionKey(),
      mode,
      run_mode: runMode,
    });
    if (sent) return;

    // WS 不可用 → SSE 降级（与 WS 共用同一 reducer，功能对等）
    const ctrl = new AbortController();
    sseController = ctrl;
    try {
      await apiService.agentChatStream(
        text,
        ctx,
        sessionKey(),
        (event, data) => get().applyAgentEvent({ ...(data || {}), event: event || data?.event }),
        { signal: ctrl.signal, mode, runMode } as any
      );
      // 流结束仍未收到终态：兜底收尾，避免转圈
      if (get().streamingMsgId === msgId) {
        patchMsg(msgId, (m) => ({ ...m, isThinkingStreaming: false, isStreaming: false }));
        set({ isRunning: false, streamingMsgId: null });
      }
    } catch (e: any) {
      const aborted = e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('abort');
      if (aborted) {
        patchMsg(msgId, (m) => ({ ...m, isThinkingStreaming: false, isStreaming: false, text: m.text || '⏹️ 已暂停' }));
        set({ isRunning: false, streamingMsgId: null });
        return;
      }
      // 非流式兜底
      try {
        const res = await apiService.agentChat(text, ctx, sessionKey(), mode, runMode);
        const { steps, artifacts, errors } = collectFromExecutedTools(res?.executed_tools || []);
        patchMsg(msgId, (m) => ({
          ...m,
          text: res?.reply || '完成。',
          thinking: res?.thinking || m.thinking,
          suggested: res?.suggested_actions,
          steps, artifacts, errors,
          isThinkingStreaming: false,
          isStreaming: false,
        }));
      } catch (err: any) {
        patchMsg(msgId, (m) => ({
          ...m,
          text: `${m.text ? m.text + '\n\n' : ''}⚠️ 连接异常：${err?.message || '未知'}`,
          isThinkingStreaming: false,
          isStreaming: false,
        }));
      }
      set({ isRunning: false, streamingMsgId: null });
    } finally {
      sseController = null;
    }
  };

  const persistNow = () => {
    const { projectId, sessions } = get();
    if (projectId && sessions.length) {
      apiService.saveProjectAgentSessions(projectId, sessions).catch(() => {});
    }
  };

  /** 运行模式热推后端：切「审批/自动」立即对当前运行轮生效（WS 优先，HTTP 兜底） */
  const pushRunMode = (token: RunMode) => {
    const sid = sessionKey();
    if (!sid) return;
    agentSocket.ensure();
    const sent = agentSocket.send({ action: 'set_run_mode', session_id: sid, run_mode: token });
    if (!sent) apiService.agentSetRunMode(sid, token).catch(() => {});
  };

  const prefs = getPrefs();

  // 全局事件入口：WS 事件 + SSE 回调统一进这里
  agentSocket.onStatus((s) => {
    set({ wsStatus: s });
    // 重连成功：把服务端仍在运行的会话重新挂到新 socket，并取快照对账
    if (s === 'open' && prevWsStatus !== 'open') {
      try {
        const { projectId, activeSessionId, runMode } = get();
        if (projectId && activeSessionId) {
          agentSocket.send({ action: 'attach_session', session_id: `proj_${projectId}_${activeSessionId}`, tail: 120, run_mode: runMode });
        }
      } catch {}
    }
    prevWsStatus = s;
  });
  agentSocket.onEvent((ev: AgentEvent) => get().applyAgentEvent(ev));

  return {
    projectId: null,
    sessions: [],
    activeSessionId: '',
    loadingSessions: false,
    messages: [],
    isRunning: false,
    wsStatus: agentSocket.status,
    streamingMsgId: null,
    approvals: {},
    mode: prefs.mode,
    runMode: prefs.runMode,

    bindProject(projectId) {
      if (!projectId) {
        set({ projectId: null, sessions: [], activeSessionId: '', messages: [], isRunning: false, streamingMsgId: null, approvals: {} });
        clearAgentDraft();
        return;
      }
      // 幂等早退：切 tab 会重复调用，这里必须原样返回，否则会把草稿一起清掉
      if (get().projectId === projectId && get().sessions.length > 0) return;
      clearAgentDraft();
      if (get().projectId !== projectId && get().isRunning) get().abort();
      set({
        projectId,
        loadingSessions: true,
        sessions: [],
        activeSessionId: '',
        messages: [],
        isRunning: false,
        streamingMsgId: null,
        approvals: {},
          });
      const { mode, runMode } = get();
      apiService
        .getProjectAgentSessions(projectId)
        .then((res) => {
          if (get().projectId !== projectId) return;
          const list: AgentSession[] = (Array.isArray(res?.sessions) ? res.sessions : [])
            .slice()
            // 最近活跃会话优先：保证重开项目恢复到上次所在会话（其 run_mode/mode 才是用户刚设的）
            .sort((a: AgentSession, b: AgentSession) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
          if (list.length > 0) {
            const first = list[0];
            set({
              sessions: list,
              activeSessionId: first.id,
              messages: (first.messages || []).map((m) => ({ ...m, isThinkingStreaming: false, isStreaming: false })),
              mode: first.mode || mode,
              runMode: first.run_mode
                ? composeRunMode(behaviorOfRunMode(first.run_mode), executionOfRunMode(first.run_mode))
                : runMode,
              loadingSessions: false,
            });
          } else {
            const sess = makeSession('新会话', mode, runMode);
            set({ sessions: [sess], activeSessionId: sess.id, messages: sess.messages, loadingSessions: false });
            schedulePersist();
          }
        })
        .catch((e) => {
          console.warn('[agentStore] load sessions failed', e);
          if (get().projectId !== projectId) return;
          const sess = makeSession('新会话', mode, runMode);
          set({ sessions: [sess], activeSessionId: sess.id, messages: sess.messages, loadingSessions: false });
        });
    },

    setMode(m) {
      set({ mode: m });
      try { localStorage.setItem('agent_mode', m); } catch {}
      const { activeSessionId, sessions } = get();
      set({ sessions: sessions.map((s) => (s.id === activeSessionId ? { ...s, mode: m, updated_at: new Date().toISOString() } : s)) });
      schedulePersist();
    },

    setRunMode(r) {
      set({ runMode: r });
      try { localStorage.setItem('agent_run_mode', r); } catch {}
      const { activeSessionId, sessions } = get();
      set({ sessions: sessions.map((s) => (s.id === activeSessionId ? { ...s, run_mode: r, updated_at: new Date().toISOString() } : s)) });
      // 立即持久化 + 热推后端：避免防抖窗口内刷新导致服务端仍是旧模式（重开项目回退审批）
      persistNow();
      pushRunMode(r);
    },

    // 草稿已移到独立的 agentDraftStore（见该文件注释：避免每次按键重渲染整棵会话流）

    createSession() {
      const { projectId, sessions, mode, runMode } = get();
      if (!projectId) return;
      get().abort();
      const sess = makeSession(`会话 ${new Date().toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${nowTime()}`, mode, runMode);
      set({
        sessions: [sess, ...sessions],
        activeSessionId: sess.id,
        messages: sess.messages,
        approvals: {},
            streamingMsgId: null,
        isRunning: false,
      });
      persistNow();
      clearAgentDraft();   // 草稿属于当前对话，换会话即清空
      toast.success('已新建独立会话');
    },

    selectSession(id) {
      const target = get().sessions.find((s) => s.id === id);
      if (!target || id === get().activeSessionId) return;
      get().abort();
      set({
        activeSessionId: id,
        messages: (target.messages || []).map((m) => ({ ...m, isThinkingStreaming: false, isStreaming: false })),
        mode: target.mode || get().mode,
        // 历史会话可能存旧值/单维值：切会话时按组合口径归一
        runMode: target.run_mode
          ? composeRunMode(behaviorOfRunMode(target.run_mode), executionOfRunMode(target.run_mode))
          : get().runMode,
        approvals: {},
            streamingMsgId: null,
        isRunning: false,
        sessions: get().sessions.map((s) => (s.id === id ? { ...s, updated_at: new Date().toISOString() } : s)),
      });
      // 切换即持久化 + 热推：避免服务端旧 run_mode 覆盖回审批
      persistNow();
      pushRunMode(get().runMode);
      clearAgentDraft();   // 草稿属于当前对话，换会话即清空
    },

    async deleteSession(id) {
      const { projectId, sessions, activeSessionId } = get();
      if (!projectId) return;
      try {
        await apiService.deleteProjectAgentSession(projectId, id);
      } catch (e: any) {
        toast.error(`删除会话失败: ${e?.message || '未知错误'}`);
        return;
      }
      const remaining = sessions.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const { mode, runMode } = get();
        const sess = makeSession('新会话', mode, runMode);
        set({ sessions: [sess], activeSessionId: sess.id, messages: sess.messages, approvals: {} });
        clearAgentDraft();
      } else if (activeSessionId === id) {
        const first = [...remaining].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
        set({
          sessions: remaining,
          activeSessionId: first.id,
          messages: (first.messages || []).map((m) => ({ ...m, isThinkingStreaming: false, isStreaming: false })),
          mode: first.mode || get().mode,
          runMode: first.run_mode
            ? composeRunMode(behaviorOfRunMode(first.run_mode), executionOfRunMode(first.run_mode))
            : get().runMode,
          approvals: {},
                streamingMsgId: null,
          isRunning: false,
        });
        clearAgentDraft();   // 当前对话被切走 → 草稿跟着换（删别人的会话不动草稿）
      } else {
        set({ sessions: remaining });
      }
      persistNow();
      toast.success('会话已删除');
    },

    async send(raw) {
      const text = (raw || '').trim();
      const st = get();
      if (!text || st.isRunning || !st.projectId || !st.activeSessionId) return;
      const isPlanMode = behaviorOfRunMode(st.runMode) === 'plan';
      const ctx: Record<string, any> = { ...buildContext(), run_mode: st.runMode, plan_mode: isPlanMode };
      const userMsg: ChatMsg = { id: uid('u'), sender: 'user', text, time: nowTime() };
      const agentMsg: ChatMsg = {
        id: uid('m'),
        sender: 'agent',
        text: '',
        mode: st.mode,
        time: nowTime(),
        thinking: '',
        isThinkingStreaming: true,
        planMode: isPlanMode,
      };
      commitMessages((prev) => [...prev, userMsg, agentMsg]);
      set({ isRunning: true, streamingMsgId: agentMsg.id, approvals: {} });
      // 「添加到会话」是给**这一条消息**指定目标：上面的 buildContext 已经把节点定义
      // 随上下文带出去了，消息发出即消费掉 —— 否则下一轮还挂着上次的焦点会误指向。
      try { useCanvasStore.getState().clearAgentFocusNodes(); } catch { /* ignore */ }

      // 模式即约束（代码门控，非提示词）：
      // - plan：runtime 只绑定只读工具（绑定层）且执行口二次拒绝写工具，产出计划后由用户批准执行；
      // - 其余模式：直接进入 ReAct 循环，工具级审批/风险分级由 pipeline 按 run_mode 裁定。
      await dispatchRun(agentMsg.id, text, ctx, st.mode, st.runMode);
    },

    async executePlan(msgId) {
      const st = get();
      const planMsg = st.messages.find((m) => m.id === msgId);
      if (!planMsg || !planMsg.planMode || planMsg.planExecuted || st.isRunning) return;
      const planText = planMsg.text || '';
      if (!planText.trim()) return;
      // 批准计划：行为维回标准、执行维沿用用户当前选择（审批=逐步确认 / 自动=直接跑）
      const nextToken = composeRunMode('standard', executionOfRunMode(st.runMode));
      get().setRunMode(nextToken);
      const text = '按已批准的计划执行';
      const ctx: Record<string, any> = { ...buildContext(), run_mode: nextToken, approved_plan: planText };
      const userMsg: ChatMsg = { id: uid('u'), sender: 'user', text, time: nowTime() };
      const agentMsg: ChatMsg = { id: uid('m'), sender: 'agent', text: '', mode: 'execute', time: nowTime(), thinking: '', isThinkingStreaming: true };
      commitMessages((prev) => [
        ...prev.map((m) => (m.id === msgId ? { ...m, planExecuted: true, planConfirmed: true } : m)),
        userMsg,
        agentMsg,
      ]);
      set({ isRunning: true, streamingMsgId: agentMsg.id, approvals: {} });
      await dispatchRun(agentMsg.id, text, ctx, 'execute', nextToken);
    },

    abort() {
      agentSocket.send({ action: 'abort', session_id: sessionKey() });
      try { sseController?.abort(); } catch {}
      const id = get().streamingMsgId;
      if (id) {
        patchMsg(id, (m) => ({
          ...m,
          isThinkingStreaming: false,
          isStreaming: false,
          text: m.text || '⏹️ 已暂停',
        }));
      }
      set({ isRunning: false, streamingMsgId: null });
    },

    approve(aid, ok) {
      const sent = agentSocket.send({ action: 'approve_tool', approval_id: aid, approved: ok });
      if (!sent) toast.warning('WS 未连接，审批无法送达（HTTP 模式会自动拒绝）');
      set((s) => (s.approvals[aid] ? { approvals: { ...s.approvals, [aid]: { ...s.approvals[aid], decided: ok } } } : {}));
    },

    async clearAll() {
      const st = get();
      if (st.isRunning) st.abort();
      const key = sessionKey();
      try { await apiService.clearAgentHistory(key); } catch {}
      agentSocket.send({ action: 'clear_history', session_id: key });
      const reset: ChatMsg[] = [{ id: uid('welcome_'), sender: 'agent', mode: st.mode, text: '记忆已清空，从头开始吧。', time: '就绪' }];
      commitMessages(() => reset);
      set({ approvals: {}, streamingMsgId: null, isRunning: false });
      toast.info('已清空当前会话记忆');
    },

    applyAgentEvent(ev) {
      const st = get();
      if (ev.event === 'approval_ack') {
        const aid = String(ev.approval_id || '');
        if (aid) {
          set((s) => (s.approvals[aid] ? { approvals: { ...s.approvals, [aid]: { ...s.approvals[aid], decided: !!ev.approved } } } : {}));
        }
        return;
      }
      if (ev.event === 'approval_required') {
        const aid = String(ev.approval_id || '');
        if (aid) {
          // 全局「自动执行」兜底：模式热同步存在竞态（事件早于 set_run_mode 到达）时自动放行。
          // 按执行维判断：create_auto / plan_auto 同属自动执行。
          if (executionOfRunMode(get().runMode) === 'auto') {
            set((s) => (s.approvals[aid] ? { approvals: { ...s.approvals, [aid]: { ...s.approvals[aid], decided: true } } } : {}));
            get().approve(aid, true);
            return;
          }
          set((s) => ({ approvals: { ...s.approvals, [aid]: { tool_name: ev.tool_name || '', args: ev.arguments || {} } } }));
          const id = st.streamingMsgId;
          if (id) patchMsg(id, (m) => ({ ...m, text: `${m.text || ''}\n\n⚠️ 请求敏感操作 \`${ev.tool_name}\`，请在右侧确认卡允许/拒绝（120s 超时自动拒绝）。` }));
        }
        return;
      }
      const id = st.streamingMsgId;
      if (id) {
        const idx = st.messages.findIndex((m) => m.id === id);
        if (idx >= 0) {
          const { msg, sideEffects } = reduceAgentEvent(st.messages[idx], ev);
          if (msg !== st.messages[idx]) {
            const messages = [...st.messages];
            messages[idx] = msg;
            commitMessages(() => messages);
          }
          dispatchSideEffects(sideEffects);
        }
      }
      if (ev.event === 'agent_response' || ev.event === 'error') {
        set({ isRunning: false, streamingMsgId: null });
      }
    },

    async proposalAction(msgId, proposalId, kind) {
      try {
        if (kind === 'start') {
          const r: any = await apiService.creatorStart(proposalId);
          const checks = (r?.report?.checks || []).map((c: any) => `${c.ok ? '✓' : '✕'}${c.name}`).join('；');
          patchMsg(msgId, (m) =>
            !m.plan?.creator_proposal
              ? m
              : {
                  ...m,
                  plan: { ...m.plan, creator_proposal: { ...(m.plan.creator_proposal as any), status: r?.proposal?.status || 'tested' } },
                  text: `${m.text}\n\n试跑${r?.proposal?.status === 'tested' ? '通过' : '有问题'}：${checks || '无检查项'}`,
                }
          );
        } else {
          const r: any = await apiService.creatorFinalize(proposalId, kind);
          const refreshes: Array<{ type: 'template_refresh' | 'skill_refresh' | 'plugin_refresh' | 'provider_refresh'; on: boolean }> = [
            { type: 'template_refresh', on: !!r?.template_id },
            { type: 'skill_refresh', on: !!r?.skill },
            { type: 'plugin_refresh', on: !!r?.plugin_id },
            { type: 'provider_refresh', on: !!r?.provider_id },
          ];
          const effects = refreshes.filter((x) => x.on).map((x) => ({ type: x.type } as any));
          if (r?.plugin_id) effects.push({ type: 'skill_refresh' } as any);
          dispatchSideEffects(effects);
          patchMsg(msgId, (m) => {
            if (!m.plan?.creator_proposal) return m;
            const gone = kind === 'discard';
            const status = r?.status || (gone ? 'discarded' : 'persisted');
            return {
              ...m,
              plan: gone
                ? { ...m.plan, creator_proposal: undefined }
                : { ...m.plan, creator_proposal: { ...(m.plan.creator_proposal as any), status } },
              text: m.text + (gone ? '\n\n提案已丢弃（teardown），未动生产。' : `\n\n${r?.note || '完成。'}`),
            };
          });
        }
      } catch (e: any) {
        // 不再往消息正文追加失败行（重复点击会刷屏）；改为一次性提示
        toast.error(e?.message || '提案操作失败');
      }
    },

    applyArtifact(msgId, index) {
      const ps = useProjectStore.getState();
      const shotId = ps.activeShotId;
      const msg = get().messages.find((m) => m.id === msgId);
      const artifact = msg?.artifacts?.[index];
      if (!shotId || !artifact) return;
      const patch: any = { status: 'completed' };
      if (artifact.kind === 'image') { patch.image_url = artifact.url; patch.image_provider = artifact.tool; }
      if (artifact.kind === 'video') { patch.video_url = artifact.url; patch.video_provider = artifact.tool; }
      if (artifact.kind === 'audio') { patch.audio_url = artifact.url; patch.audio_provider = artifact.tool; }
      try { ps.updateShot(shotId, patch); } catch {}
      patchMsg(msgId, (m) => ({ ...m, artifacts: (m.artifacts || []).map((x, xi) => (xi === index ? { ...x, applied: true } : x)) }));
    },

    _commitMessages: commitMessages,
    _patchMsg: patchMsg,
  };
});
