/**
 * Agent 导演台运行时 Store 工厂 — 页面版（page）与悬浮窗版（float）各自独立。
 * 两个实例拥有独立的会话列表、运行状态、审批与偏好，互不干扰：
 * - 会话持久化走服务端 ?scope= 隔离（page / float 各写各的会话）；
 * - WS/SSE 事件按 session_id 分流到各自 store；
 * - 审批/自动允许/运行模式偏好按 scope 存 localStorage。
 */
import { create } from 'zustand';
import { apiService } from '../../services/api';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { toast } from '../../stores/useDialogStore';
import { agentSocket } from './agentSocket';
import { collectFromExecutedTools, dispatchSideEffects, reduceAgentEvent } from './agentEventReducer';
import {
  behaviorOfRunMode, composeRunMode, executionOfRunMode,
} from './agentTypes';
import type {
  AgentEvent, AgentMode, AgentSession, ApprovalInfo, BehaviorMode, ChatMsg, ExecutionMode, RunMode, WsStatus,
} from './agentTypes';

export type AgentScope = 'page' | 'float';

export const QUICK_ASK = ['这个项目怎么做分镜？', '首尾帧和参考图有什么区别？', '剪映导出需要什么前置条件？'];
export const QUICK_DO = ['为当前镜头规划3D特写推镜', '生成主角怒吼配音并对齐时长', '把画布现有节点全量执行一遍', '导出剪映工程草稿'];
export const QUICK_CREATE = ['制作国风悬疑短剧插件包', '给H3视频源补first_frame插槽', '做个6格漫剧画布模板', '新建古风战斗Skill规范'];
export const QUICK_PLAN = ['分析当前项目并给出完整制作计划', '为当前镜头规划最佳生成方案', '检查全部生成源与工作流并给修复计划'];

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
      : '这里是 **执行模式**。我会按 ReAct 循环直接调生图/配音/视频/画布/剪映等工具；「行为」决定我能干什么（标准/创造/计划），「执行」决定要不要逐项确认（审批/自动），两者可自由组合。',
    suggested: mode === 'chat' ? QUICK_ASK : QUICK_DO,
    time: '就绪',
  };
}
function makeSession(scope: AgentScope, title: string, mode: AgentMode, runMode: RunMode): AgentSession {
  const iso = new Date().toISOString();
  return { id: uid(scope === 'float' ? 'fsess_' : 'sess_'), title, created_at: iso, updated_at: iso, messages: [welcomeMsg(mode)], mode, run_mode: runMode };
}

function autoTitle(sess: AgentSession, messages: ChatMsg[]): string {
  const cur = sess.title;
  if (cur && cur !== '新会话' && !cur.startsWith('会话 ')) return cur;
  const firstUser = messages.find((m) => m.sender === 'user');
  return firstUser ? firstUser.text.slice(0, 20).replace(/[\r\n]+/g, ' ') : cur || '新会话';
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
          // 白模预演素材：MCP generate_video 会自动把 previz_video_url 作为参考视频注入
          image_url: active.image_url,
          previz_url: (active as any).previz_url,
          previz_video_url: (active as any).previz_video_url,
          character_ids: (active as any).character_ids,
        }
      : null,
    platform: 'desktop',
    canvas_summary,
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
  /** 组合 token（wire 口径）；UI 请用 behavior/execution 两个维度 */
  runMode: RunMode;
  /** 行为模式：能干什么（标准/创造/计划） */
  behavior: BehaviorMode;
  /** 执行方式：要不要逐项人审（审批/自动） */
  execution: ExecutionMode;
  /** 本会话始终自动允许的工具（行内审批"始终允许"持久化于此，IDE 式免打扰） */
  autoAllowTools: Record<string, boolean>;

  bindProject(projectId: string | null): void;
  setMode(m: AgentMode): void;
  setRunMode(r: RunMode): void;
  setBehavior(b: BehaviorMode): void;
  setExecution(e: ExecutionMode): void;
  setAutoAllow(tool: string, on: boolean): void;
  createSession(): void;
  selectSession(id: string): void;
  deleteSession(id: string): Promise<void>;
  send(raw: string): Promise<void>;
  /** 运行中插话（steer）：把新指令投进当前轮，不打断已产出 */
  steer(raw: string): Promise<void>;
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

export function createAgentStore(scope: AgentScope) {
  const MODE_KEY = scope === 'float' ? 'agent_float_mode' : 'agent_mode';
  const RUNMODE_KEY = scope === 'float' ? 'agent_float_run_mode' : 'agent_run_mode';
  const ALLOW_KEY = scope === 'float' ? 'agent_float_auto_allow' : 'agent_auto_allow';

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let sseController: AbortController | null = null;
  let prevWsStatus: WsStatus = 'closed';

  const loadAutoAllow = (): Record<string, boolean> => {
    try {
      const raw = localStorage.getItem(ALLOW_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  };

  return create<AgentStoreState>()((set, get) => {
    const getPrefs = (): { mode: AgentMode; runMode: RunMode } => {
      let mode: AgentMode = 'execute';
      let runMode: RunMode = 'approve';
      try {
        const m = localStorage.getItem(MODE_KEY);
        if (m === 'chat' || m === 'execute') mode = m;
        const r = localStorage.getItem(RUNMODE_KEY);
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

    const schedulePersist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        const { projectId, sessions } = get();
        if (projectId && sessions.length) {
          apiService.saveProjectAgentSessions(projectId, sessions, scope).catch((e) => console.warn('[agentStore] persist failed', e));
        }
      }, 600);
    };

    const persistNow = () => {
      const { projectId, sessions } = get();
      if (projectId && sessions.length) {
        apiService.saveProjectAgentSessions(projectId, sessions, scope).catch(() => {});
      }
    };

    /** 组合 token 落地：同步 behavior/execution 两维 + localStorage + 当前会话持久化 */
    const applyRunMode = (token: RunMode) => {
      const runMode = composeRunMode(behaviorOfRunMode(token), executionOfRunMode(token));
      set({ runMode, behavior: behaviorOfRunMode(runMode), execution: executionOfRunMode(runMode) });
      try { localStorage.setItem(RUNMODE_KEY, runMode); } catch {}
      const { activeSessionId, sessions } = get();
      set({ sessions: sessions.map((s) => (s.id === activeSessionId ? { ...s, run_mode: runMode, updated_at: new Date().toISOString() } : s)) });
      schedulePersist();
    };

    /** 会话 token → 两维状态（加载/切换会话时用） */
    const dimsOf = (token: RunMode) => ({
      runMode: token,
      behavior: behaviorOfRunMode(token),
      execution: executionOfRunMode(token),
    });

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

    const prefs = getPrefs();

    // 全局事件入口：只处理属于本 store 会话的事件（两实例共用一条 WS）。
    agentSocket.onStatus((s) => {
      set({ wsStatus: s });
      // 重连成功：把服务端仍在运行的会话重新挂到新 socket，并取快照对账
      if (s === 'open' && prevWsStatus !== 'open') {
        try {
          const { projectId, activeSessionId } = get();
          if (projectId && activeSessionId) {
            agentSocket.send({ action: 'attach_session', session_id: `proj_${projectId}_${activeSessionId}`, tail: 120 });
          }
        } catch {}
      }
      prevWsStatus = s;
    });
    agentSocket.onEvent((ev: AgentEvent) => {
      try {
        const sid = (ev as any)?.session_id;
        if (sid && sid !== sessionKey()) return;
      } catch {}
      get().applyAgentEvent(ev);
    });

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
      behavior: behaviorOfRunMode(prefs.runMode),
      execution: executionOfRunMode(prefs.runMode),
      autoAllowTools: loadAutoAllow(),

      bindProject(projectId) {
        if (!projectId) {
          set({ projectId: null, sessions: [], activeSessionId: '', messages: [], isRunning: false, streamingMsgId: null, approvals: {} });
          return;
        }
        if (get().projectId === projectId && get().sessions.length > 0) return;
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
          .getProjectAgentSessions(projectId, scope)
          .then((res) => {
            if (get().projectId !== projectId) return;
            const list: AgentSession[] = Array.isArray(res?.sessions) ? res.sessions : [];
            if (list.length > 0) {
              const first = list[0];
              const token = composeRunMode(behaviorOfRunMode(first.run_mode || runMode), executionOfRunMode(first.run_mode || runMode));
              set({
                sessions: list,
                activeSessionId: first.id,
                messages: (first.messages || []).map((m) => ({ ...m, isThinkingStreaming: false, isStreaming: false })),
                mode: first.mode || mode,
                ...dimsOf(token),
                loadingSessions: false,
              });
            } else {
              const sess = makeSession(scope, '新会话', mode, runMode);
              set({ sessions: [sess], activeSessionId: sess.id, messages: sess.messages, loadingSessions: false });
              schedulePersist();
            }
          })
          .catch((e) => {
            console.warn('[agentStore] load sessions failed', e);
            if (get().projectId !== projectId) return;
            const sess = makeSession(scope, '新会话', mode, runMode);
            set({ sessions: [sess], activeSessionId: sess.id, messages: sess.messages, loadingSessions: false });
          });
      },

      setMode(m) {
        set({ mode: m });
        try { localStorage.setItem(MODE_KEY, m); } catch {}
        const { activeSessionId, sessions } = get();
        set({ sessions: sessions.map((s) => (s.id === activeSessionId ? { ...s, mode: m, updated_at: new Date().toISOString() } : s)) });
        schedulePersist();
      },

      setRunMode(r) {
        applyRunMode(r);
      },

      setBehavior(b) {
        // 行为维度独立切换：执行方式保持不变（计划只读时执行方式仅影响批准计划后的跑法）
        applyRunMode(composeRunMode(b, get().execution));
      },

      setExecution(e) {
        applyRunMode(composeRunMode(get().behavior, e));
      },

      setAutoAllow(tool, on) {
        set((s) => {
          const next = { ...s.autoAllowTools };
          if (on) next[tool] = true; else delete next[tool];
          try { localStorage.setItem(ALLOW_KEY, JSON.stringify(next)); } catch {}
          return { autoAllowTools: next };
        });
      },

      createSession() {
        const { projectId, sessions, mode, runMode } = get();
        if (!projectId) return;
        get().abort();
        const sess = makeSession(scope, `会话 ${new Date().toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${nowTime()}`, mode, runMode);
        set({
          sessions: [sess, ...sessions],
          activeSessionId: sess.id,
          messages: sess.messages,
          approvals: {},
          streamingMsgId: null,
          isRunning: false,
        });
        persistNow();
        toast.success('已新建独立会话');
      },

      selectSession(id) {
        const target = get().sessions.find((s) => s.id === id);
        if (!target || id === get().activeSessionId) return;
        get().abort();
        const token = composeRunMode(
          behaviorOfRunMode(target.run_mode || get().runMode),
          executionOfRunMode(target.run_mode || get().runMode)
        );
        set({
          activeSessionId: id,
          messages: (target.messages || []).map((m) => ({ ...m, isThinkingStreaming: false, isStreaming: false })),
          mode: target.mode || get().mode,
          ...dimsOf(token),
          approvals: {},
          streamingMsgId: null,
          isRunning: false,
        });
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
          const sess = makeSession(scope, '新会话', mode, runMode);
          set({ sessions: [sess], activeSessionId: sess.id, messages: sess.messages, approvals: {} });
        } else if (activeSessionId === id) {
          const first = remaining[0];
          const token = composeRunMode(
            behaviorOfRunMode(first.run_mode || get().runMode),
            executionOfRunMode(first.run_mode || get().runMode)
          );
          set({
            sessions: remaining,
            activeSessionId: first.id,
            messages: (first.messages || []).map((m) => ({ ...m, isThinkingStreaming: false, isStreaming: false })),
            mode: first.mode || get().mode,
            ...dimsOf(token),
            approvals: {},
            streamingMsgId: null,
            isRunning: false,
          });
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
        const isPlanMode = st.behavior === 'plan';
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

        // 模式即约束（代码门控，非提示词），两维正交：
        // - 行为 plan：只绑定只读工具（绑定层）+ 执行口二次拒绝写工具，产出计划后由用户批准执行；
        // - 行为 create：缺能力先提案，能力变更类默认人审（自动执行时不再等待点击）；
        // - 执行 auto：全部工具自动执行、不弹确认；approve：medium 以上先审后干。
        await dispatchRun(agentMsg.id, text, ctx, st.mode, st.runMode);
      },

      async steer(raw) {
        const text = (raw || '').trim();
        const st = get();
        if (!text || !st.isRunning || !st.projectId || !st.activeSessionId) return;
        try {
          await apiService.agentSteer(sessionKey(), text);
        } catch (e: any) {
          toast.error(`插话失败: ${e?.message || '未知错误'}`);
          return;
        }
        commitMessages((prev) => [...prev, { id: uid('u'), sender: 'user', text, time: nowTime() }]);
      },

      async executePlan(msgId) {
        const st = get();
        const planMsg = st.messages.find((m) => m.id === msgId);
        if (!planMsg || !planMsg.planMode || planMsg.planExecuted || st.isRunning) return;
        const planText = planMsg.text || '';
        if (!planText.trim()) return;
        // 批准计划：退出计划行为回到标准，执行方式沿用用户当前选择（审批=逐步确认 / 自动=直接跑）
        const nextToken = composeRunMode('standard', st.execution);
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
        if (!sent) {
          // WS 不可用时走 HTTP 审批回执（v2 内核按会话解析），失败再提示
          apiService.agentApprove(sessionKey(), aid, ok).catch(() => {
            toast.warning('审批无法送达，后端可能已超时拒绝');
          });
        }
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
          const tool = ev.tool_name || '';
          if (aid) {
            set((s) => ({ approvals: { ...s.approvals, [aid]: { tool_name: tool, args: ev.arguments || {}, createdAt: Date.now() } } }));
            // 本会话"始终允许"：自动放行（IDE 式免打扰）
            if (tool && get().autoAllowTools[tool]) {
              set((s) => (s.approvals[aid] ? { approvals: { ...s.approvals, [aid]: { ...s.approvals[aid], decided: true } } } : {}));
              get().approve(aid, true);
              return;
            }
            const id = st.streamingMsgId;
            if (id) patchMsg(id, (m) => ({ ...m, text: `${m.text || ''}\n\n⚠️ 请求敏感操作 \`${tool}\`，请在下方工具卡点允许/拒绝（120s 超时自动拒绝）。` }));
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
}

/** 页面版导演 Agent（独立会话/状态） */
export const useAgentStore = createAgentStore('page');
/** 悬浮窗版导演 Agent（独立会话/状态，与页面版互不影响） */
export const useAgentFloatStore = createAgentStore('float');
