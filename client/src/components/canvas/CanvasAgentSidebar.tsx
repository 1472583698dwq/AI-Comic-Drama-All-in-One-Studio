// -*- coding: utf-8 -*-
/**
 * 画布右侧「导演 Agent」侧栏（可收起）—— 画布上唯一的 Agent 入口。
 *
 * 本次重构合并了原先画布上重复的三处入口：
 *   ① 悬浮胶囊 / 可拖拽浮窗（`AgentChatDrawer`）→ 画布页不再渲染（见 App.tsx 的 activeTab 闸门）
 *   ② 底部「全局导演 Agent GO」（原 `FloatingAgentPromptBar` 的全局态）→ 已撤销
 *   ③ 底部节点控制块 → 保留在底部（`NodeControlBar`），只服务选中的生成节点
 *
 * 关于 ②：初版曾把「一句话编排 GO」搬进本侧栏，实测它是一条**无会话的一次性调用**
 * （走 `/agent/chat` 不带 sessionId，回复只回报一行摘要、不进历史），与同侧栏的
 * 会话流并列会让人误以为它也写入历史，且两套输入框只是重复。故按用户判断直接去掉：
 * **侧栏只做会话**，编排意图直接在会话里说即可（Agent 同样会走 canvas_* 工具建节点执行）。
 *
 * 会话仍是全局共享的 `agentStore` + `agentSocket` 单例：与「AI 导演」页、以及其它页面
 * 的悬浮抽屉**共用同一份会话**，所以在这里发的消息，切到 AI 导演页能看到完整后续。
 * `bindProject` / `agentSocket.ensure()` 都是幂等的，多处分别调用无副作用。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, Maximize2, RefreshCw, ChevronLeft, ChevronRight, ShieldAlert, Film,
  MessagesSquare, X,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { getNodeSpec } from './nodeRegistry';
import { agentSocket } from '../agent/agentSocket';
import { useAgentStore } from '../agent/agentStore';
import { AgentMessageList } from '../agent/AgentMessageList';
import { AgentComposer } from '../agent/AgentComposer';

const COLLAPSE_KEY = 'canvas_agent_sidebar_collapsed';
const WIDTH_KEY = 'canvas_agent_sidebar_width';

/** 侧栏宽度约束：Agent 回复常带表格/卡片，固定 368px 读起来太挤，改为可拖拽 */
const DEFAULT_W = 400;
const MIN_W = 320;
/** 上限按需求取视口 40% —— 再宽就会把画布挤到没法操作 */
const maxWidth = () => Math.max(MIN_W, Math.round(window.innerWidth * 0.4));
const clampWidth = (w: number) => Math.min(Math.max(Math.round(w), MIN_W), maxWidth());

export const CanvasAgentSidebar: React.FC = () => {
  const { project, activeShotId, setActiveTab } = useProjectStore();
  const canvasNodes = useCanvasStore((s) => s.nodes);
  const agentFocusNodeIds = useCanvasStore((s) => s.agentFocusNodeIds);
  const removeAgentFocusNode = useCanvasStore((s) => s.removeAgentFocusNode);
  const clearAgentFocusNodes = useCanvasStore((s) => s.clearAgentFocusNodes);

  const {
    messages, isRunning, wsStatus, approvals, mode, runMode,
    bindProject, send, abort, clearAll, approve,
    executePlan, proposalAction, applyArtifact,
    setMode, setRunMode,
  } = useAgentStore();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  const [proposalBusy, setProposalBusy] = useState<Record<string, string>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // —— 宽度：左边界可拖拽（视口 40% 上限），持久化 ——
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= MIN_W) return clampWidth(saved);
    } catch { /* ignore */ }
    return clampWidth(DEFAULT_W);
  });
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* ignore */ }
  }, [width]);
  // 视口变小后旧宽度可能超上限 → 夹紧，避免侧栏把画布挤没
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    // 拖拽期间禁掉文本选中与默认光标，否则鼠标划过消息区会选中一大片文字
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      // 侧栏贴窗口右缘：宽度 = 视口右边界 - 指针 x
      setWidth(clampWidth(window.innerWidth - ev.clientX));
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // 拖到窗口外松手时 mouseup 收不到 → 失焦也算结束，避免"卡在拖拽态"
    window.addEventListener('blur', onUp);
  }, []);

  // 会话绑定 + WS 单例：与 AI 导演页 / 悬浮抽屉共用同一份运行时（幂等）
  useEffect(() => { bindProject(project?.id || null); }, [project?.id, bindProject]);
  useEffect(() => { agentSocket.ensure(); }, []);

  useEffect(() => {
    if (!collapsed) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isRunning, collapsed]);

  // Esc 暂停当前运行（与悬浮抽屉同一约定）
  useEffect(() => {
    if (collapsed || !isRunning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); abort(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, isRunning, abort]);

  const handleProposalAction = useCallback(async (msgId: string, proposalId: string, kind: 'start' | 'persist' | 'discard' | 'rollback') => {
    setProposalBusy((p) => ({ ...p, [proposalId]: kind }));
    try {
      await proposalAction(msgId, proposalId, kind);
    } finally {
      setProposalBusy((p) => { const n = { ...p }; delete n[proposalId]; return n; });
    }
  }, [proposalAction]);

  // 已加入会话的节点（去重 + 按当前画布校验存在性），用于侧栏顶部展示
  const focusNodes = agentFocusNodeIds
    .map((id) => canvasNodes.find((n: any) => n.id === id))
    .filter(Boolean)
    .map((n: any) => ({
      id: n.id,
      label: getNodeSpec(String(n.type || ''))?.label || n.type || '节点',
      title: String(n.data?.prompt || n.data?.text || n.data?.brief || n.data?.ai_directive || '').slice(0, 14),
    }));

  const activeShot = project?.scenes.flatMap((s) => s.shots).find((s) => s.id === activeShotId);
  const pendingList = Object.entries(approvals).filter(([, v]) => v.decided === undefined);

  // ── 收起态：竖向图标轨（保留 WS 状态与待确认角标，不占画布宽度） ──
  if (collapsed) {
    return (
      <aside className="w-12 shrink-0 bg-surface border-l border-border flex flex-col items-center py-3 gap-3">
        <button
          onClick={() => setCollapsed(false)}
          title="展开导演 Agent"
          className="relative p-2 rounded-xl bg-gradient-to-tr from-brand to-brand-cyan text-white shadow-md shadow-brand/30 hover:scale-105 transition-transform"
        >
          <Bot className="w-4 h-4" />
          <span
            className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-surface ${wsStatus === 'open' ? 'bg-accent-green animate-pulse' : 'bg-amber-400'}`}
            title={wsStatus === 'open' ? 'WebSocket 流式通道已就绪' : 'HTTP 通道（自动重连中）'}
          />
        </button>
        {pendingList.length > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500 text-black font-bold" title={`待确认 ${pendingList.length} 项`}>
            {pendingList.length}
          </span>
        )}
        {focusNodes.length > 0 && (
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/50 text-emerald-300 font-bold"
            title={`已加入会话 ${focusNodes.length} 个节点`}
          >
            {focusNodes.length}
          </span>
        )}
        <button
          onClick={() => setCollapsed(false)}
          className="text-[10px] [color:var(--color-text-muted)] tracking-widest select-none hover:[color:var(--color-text-main)]"
          style={{ writingMode: 'vertical-rl' }}
          title="展开导演 Agent"
        >
          导演 Agent
        </button>
        <button
          onClick={() => setCollapsed(false)}
          title="展开导演 Agent"
          className="mt-auto p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  // ── 展开态：会话流（与 AI 导演页同一份会话） ──
  return (
    <aside
      style={{ width }}
      className="relative shrink-0 bg-surface border-l border-border flex flex-col overflow-hidden"
    >
      {/* 左边界拖拽把手（贴在侧栏内侧，避免被 overflow-hidden 裁掉）：
          hover 显竖条，拖拽改宽（视口 40% 上限），双击复位默认宽度 */}
      <div
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(clampWidth(DEFAULT_W))}
        title="拖拽调整侧栏宽度（最大视口 40%）· 双击复位"
        className="absolute left-0 top-0 bottom-0 w-2 z-20 cursor-col-resize flex justify-center group/resize"
      >
        <span
          className={`w-[3px] h-full transition-colors ${resizing ? 'bg-brand' : 'bg-transparent group-hover/resize:bg-brand/50'}`}
        />
      </div>

      {/* 头部 */}
      <div className="h-12 px-3 border-b border-border flex items-center gap-2 shrink-0 bg-surface">
        <div className="p-1.5 rounded-xl bg-gradient-to-tr from-brand to-brand-blue text-white shadow-md shadow-brand/30 shrink-0">
          <Bot className="w-3.5 h-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold [color:var(--color-text-main)] truncate">导演 Agent</span>
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${wsStatus === 'open' ? 'bg-accent-green' : 'bg-amber-400'}`}
              title={wsStatus === 'open' ? 'WebSocket 流式通道已就绪' : 'HTTP 通道（自动重连中）'}
            />
          </div>
          <div className="text-[9px] [color:var(--color-text-muted)] truncate">与 AI 导演页会话同步 · 可操控本画布</div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setActiveTab('agent')}
            className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary"
            title="全屏打开「AI 导演」页（同一份会话）"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => void clearAll()}
            className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary"
            title="重置会话记忆"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary"
            title="收起侧栏"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 当前镜头上下文 */}
      {activeShot && (
        <div className="px-3 py-1.5 bg-brand/10 border-b border-brand/20 flex items-center text-[11px] text-brand shrink-0">
          <Film className="w-3.5 h-3.5 shrink-0 mr-1.5" />
          <span className="font-semibold truncate">镜头 #{activeShot.shot_index}: {activeShot.action_desc || activeShot.image_prompt?.slice(0, 30)}</span>
        </div>
      )}

      {/* 会话流 */}
      <div className="flex-1 overflow-y-auto px-3 py-3 custom-scrollbar text-xs">
        <AgentMessageList
          messages={messages}
          compact
          isRunning={isRunning}
          activeShotIndex={activeShot?.shot_index}
          onSendSuggestion={(t) => void send(t)}
          onExecutePlan={(id) => void executePlan(id)}
          onProposalAction={handleProposalAction}
          proposalBusy={proposalBusy}
          onApplyArtifact={applyArtifact}
        />
        <div ref={messagesEndRef} />
      </div>

      {/* 待确认审批 */}
      {pendingList.length > 0 && (
        <div className="px-3 py-2 border-t border-amber-500/30 bg-amber-500/5 space-y-1.5 shrink-0">
          <div className="text-[10px] font-bold text-amber-300 flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" />待确认 {pendingList.length}
          </div>
          {pendingList.map(([aid, v]) => (
            <div key={aid} className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono [color:var(--color-text-main)] truncate flex-1">{v.tool_name}</span>
              <button onClick={() => approve(aid, true)} className="px-2 py-0.5 rounded-md bg-amber-500 text-black text-[10px] font-bold">允许</button>
              <button onClick={() => approve(aid, false)} className="px-2 py-0.5 rounded-md border border-border text-[10px] [color:var(--color-text-secondary)]">拒绝</button>
            </div>
          ))}
        </div>
      )}

      {/* 输入：noPolish —— 这里是给 Agent 下指令，润色技能面向画面提示词/台词，
          挂上来不对路；标了它选区润色浮标不会在选中文字时冒出来。
          「已加入会话」的节点 chip 直接包在输入框内（headerSlot），
          让"这次说话 Agent 会针对谁"和"你要说什么"在同一块区域里。 */}
      <div className="p-3 border-t border-border bg-surface shrink-0">
        <AgentComposer
          compact
          noPolish
          mode={mode}
          runMode={runMode}
          isRunning={isRunning}
          wsStatus={wsStatus}
          onModeChange={setMode}
          onRunModeChange={setRunMode}
          onSend={(t) => void send(t)}
          onAbort={abort}
          headerSlot={focusNodes.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2.5">
              {focusNodes.map((n) => (
                <span
                  key={n.id}
                  className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[10px] [color:var(--color-text-main)] max-w-full"
                  title={`已加入会话：${n.label}${n.title ? ' · ' + n.title : ''}`}
                >
                  <MessagesSquare className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                  <span className="truncate max-w-[220px]">{n.label}{n.title ? ` · ${n.title}` : ''}</span>
                  <button
                    onClick={() => removeAgentFocusNode(n.id)}
                    className="p-0.5 rounded text-emerald-300/60 hover:text-red-300 hover:bg-red-500/20"
                    title="移出会话"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
              <button
                onClick={clearAgentFocusNodes}
                className="text-[10px] text-emerald-300/70 hover:text-emerald-200 px-1"
                title="全部移出会话"
              >
                清空
              </button>
            </div>
          ) : undefined}
        />
      </div>
    </aside>
  );
};
