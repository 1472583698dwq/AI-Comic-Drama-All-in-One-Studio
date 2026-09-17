/**
 * 悬浮导演 Agent 抽屉 — 薄壳：拖拽外壳 + 统一消息流/运行时 store（与 Agent 页共用同一会话）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, GripHorizontal, X, Maximize2, Minimize2, RefreshCw, Film, ArrowUpRight, ShieldAlert,
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { agentSocket } from './agentSocket';
import { useAgentStore } from './agentStore';
import { AgentMessageList } from './AgentMessageList';
import { AgentComposer } from './AgentComposer';

export const AgentChatDrawer: React.FC = () => {
  const { project, activeShotId, setActiveTab } = useProjectStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [proposalBusy, setProposalBusy] = useState<Record<string, string>>({});

  const {
    messages, isRunning, wsStatus, approvals, mode, runMode,
    bindProject, send, abort, clearAll, approve,
    executePlan, proposalAction, applyArtifact,
  } = useAgentStore();

  // 浮动按钮位置（可拖拽持久化）
  const [btnPos, setBtnPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('agent_float_btn_pos');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      x: typeof window !== 'undefined' ? window.innerWidth - 170 : 1200,
      y: typeof window !== 'undefined' ? window.innerHeight - 70 : 800,
    };
  });
  const [isBtnDragging, setIsBtnDragging] = useState(false);
  const btnDragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0, hasMoved: false });

  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null);
  const [isDialogDragging, setIsDialogDragging] = useState(false);
  const dialogDragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 项目绑定（幂等；页面同时调用无副作用）
  useEffect(() => {
    bindProject(project?.id || null);
  }, [project?.id, bindProject]);

  // 连接单例（自动重连）
  useEffect(() => {
    agentSocket.ensure();
  }, []);

  // 打开时把窗口放到按钮附近
  useEffect(() => {
    if (isOpen && dialogPos === null && typeof window !== 'undefined') {
      const w = isExpanded ? 540 : 410;
      const h = isExpanded ? 680 : 530;
      const targetX = Math.max(16, Math.min(window.innerWidth - w - 16, btnPos.x - w + 140));
      const targetY = Math.max(16, Math.min(window.innerHeight - h - 16, btnPos.y - h));
      setDialogPos({ x: targetX, y: targetY });
    }
  }, [isOpen, isExpanded, dialogPos, btnPos]);

  // 视口变化边界保护
  useEffect(() => {
    const onResize = () => {
      if (typeof window === 'undefined') return;
      setBtnPos((prev) => ({
        x: Math.max(10, Math.min(window.innerWidth - 170, prev.x)),
        y: Math.max(10, Math.min(window.innerHeight - 65, prev.y)),
      }));
      if (dialogPos) {
        const w = isExpanded ? 540 : 410;
        const h = isExpanded ? 680 : 530;
        setDialogPos((prev) =>
          prev
            ? {
                x: Math.max(10, Math.min(window.innerWidth - w - 10, prev.x)),
                y: Math.max(10, Math.min(window.innerHeight - h - 10, prev.y)),
              }
            : null
        );
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [dialogPos, isExpanded]);

  useEffect(() => {
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isOpen, isRunning]);

  // Esc 暂停
  useEffect(() => {
    if (!isOpen || !isRunning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isRunning, abort]);

  const onBtnMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsBtnDragging(true);
    btnDragRef.current = { startX: e.clientX, startY: e.clientY, origX: btnPos.x, origY: btnPos.y, hasMoved: false };
  };
  const onBtnTouchStart = (e: React.TouchEvent) => {
    if (!e.touches[0]) return;
    const t = e.touches[0];
    setIsBtnDragging(true);
    btnDragRef.current = { startX: t.clientX, startY: t.clientY, origX: btnPos.x, origY: btnPos.y, hasMoved: false };
  };
  useEffect(() => {
    const move = (cx: number, cy: number) => {
      const dx = cx - btnDragRef.current.startX;
      const dy = cy - btnDragRef.current.startY;
      if (Math.hypot(dx, dy) > 4) btnDragRef.current.hasMoved = true;
      setBtnPos({
        x: Math.max(10, Math.min(window.innerWidth - 170, btnDragRef.current.origX + dx)),
        y: Math.max(10, Math.min(window.innerHeight - 65, btnDragRef.current.origY + dy)),
      });
    };
    const onMouseMove = (e: MouseEvent) => { if (isBtnDragging) move(e.clientX, e.clientY); };
    const onTouchMove = (e: TouchEvent) => { if (isBtnDragging && e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY); };
    const onUp = () => {
      if (!isBtnDragging) return;
      setIsBtnDragging(false);
      if (btnDragRef.current.hasMoved) {
        try { localStorage.setItem('agent_float_btn_pos', JSON.stringify(btnPos)); } catch {}
      } else {
        setIsOpen((v) => !v);
      }
    };
    if (isBtnDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onTouchMove);
      window.addEventListener('touchend', onUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [isBtnDragging, btnPos]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (!dialogPos) return;
    if ((e.target as HTMLElement).closest('button')) return;
    setIsDialogDragging(true);
    dialogDragRef.current = { startX: e.clientX, startY: e.clientY, origX: dialogPos.x, origY: dialogPos.y };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDialogDragging) return;
      const w = isExpanded ? 540 : 410;
      const h = isExpanded ? 680 : 530;
      setDialogPos({
        x: Math.max(10, Math.min(window.innerWidth - w - 10, dialogDragRef.current.origX + e.clientX - dialogDragRef.current.startX)),
        y: Math.max(10, Math.min(window.innerHeight - h - 10, dialogDragRef.current.origY + e.clientY - dialogDragRef.current.startY)),
      });
    };
    const onUp = () => { if (isDialogDragging) setIsDialogDragging(false); };
    if (isDialogDragging) {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDialogDragging, isExpanded]);

  const handleProposalAction = useCallback(async (msgId: string, proposalId: string, kind: 'start' | 'persist' | 'discard' | 'rollback') => {
    setProposalBusy((p) => ({ ...p, [proposalId]: kind }));
    try {
      await proposalAction(msgId, proposalId, kind);
    } finally {
      setProposalBusy((p) => { const n = { ...p }; delete n[proposalId]; return n; });
    }
  }, [proposalAction]);

  const activeShot = project?.scenes.flatMap((s) => s.shots).find((s) => s.id === activeShotId);
  const pendingList = Object.entries(approvals).filter(([, v]) => v.decided === undefined);

  return (
    <>
      {/* 悬浮 Trigger 胶囊（可拖拽） */}
      <div style={{ position: 'fixed', left: `${btnPos.x}px`, top: `${btnPos.y}px`, zIndex: 60 }} className="touch-none select-none">
        <button
          onMouseDown={onBtnMouseDown}
          onTouchStart={onBtnTouchStart}
          className={`group flex items-center space-x-2 px-3.5 py-2.5 rounded-full backdrop-blur-xl border transition-all shadow-xl cursor-grab active:cursor-grabbing ${
            isOpen
              ? 'bg-brand text-white border-brand-glow shadow-brand/40 ring-2 ring-brand/50'
              : 'bg-surface/90 hover:bg-surface border-border hover:border-brand/60 text-white shadow-black/40 hover:scale-105'
          }`}
          title="点击展开/收起导演 Agent，按住可任意拖拽位置"
        >
          <div className="relative flex items-center justify-center">
            <div className="w-5 h-5 rounded-full bg-gradient-to-tr from-brand to-brand-cyan flex items-center justify-center text-white shadow-sm">
              <Bot className="w-3 h-3" />
            </div>
            <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-surface ${wsStatus === 'open' ? 'bg-accent-green animate-pulse' : 'bg-amber-400'}`} />
          </div>
          <div className="flex items-center gap-1.5 font-bold text-xs">
            <span className="[color:var(--color-text-main)] group-hover:text-brand">导演 Agent</span>
            <GripHorizontal className="w-3 h-3 [color:var(--color-text-muted)] opacity-50 group-hover:opacity-100" />
          </div>
        </button>
      </div>

      {/* 会话窗口 */}
      {isOpen && dialogPos && (
        <div
          style={{
            position: 'fixed',
            left: `${dialogPos.x}px`,
            top: `${dialogPos.y}px`,
            width: isExpanded ? '540px' : '410px',
            height: isExpanded ? '680px' : '530px',
            zIndex: 55,
          }}
          className="rounded-3xl border border-border bg-surface/95 backdrop-blur-2xl shadow-2xl flex flex-col overflow-hidden animate-fade-in"
        >
          <div
            onMouseDown={onHeaderMouseDown}
            className="h-12 px-4 border-b border-border flex items-center justify-between bg-surface-secondary/80 shrink-0 cursor-grab active:cursor-grabbing select-none"
            title="按住拖拽窗口位置"
          >
            <div className="flex items-center space-x-2.5">
              <GripHorizontal className="w-4 h-4 [color:var(--color-text-muted)]" />
              <div className="p-1.5 rounded-xl bg-gradient-to-tr from-brand to-brand-blue text-white shadow-md shadow-brand/30">
                <Bot className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-1.5">
                  <span className="text-xs font-bold [color:var(--color-text-main)]">AI 漫剧导演 Agent</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${wsStatus === 'open' ? 'bg-accent-green' : 'bg-amber-400'}`} title={wsStatus === 'open' ? 'WebSocket 流式通道已就绪' : 'HTTP 通道（自动重连中）'} />
                </div>
                <div className="text-[9px] [color:var(--color-text-muted)] flex items-center gap-1">
                  <span>多模态感知</span>
                  <span>·</span>
                  <span>与 Agent 页会话同步</span>
                </div>
              </div>
            </div>
            <div className="flex items-center space-x-1">
              <button
                onClick={() => void clearAll()}
                className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary transition-all"
                title="重置会话记忆"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary transition-all"
                title={isExpanded ? '还原默认尺寸' : '放大窗口'}
              >
                {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-tertiary transition-all"
                title="收起悬浮窗"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {activeShot && (
            <div className="px-3.5 py-1.5 bg-brand/10 border-b border-brand/20 flex items-center justify-between text-[11px] text-brand shrink-0">
              <span className="flex items-center space-x-1.5 truncate">
                <Film className="w-3.5 h-3.5 shrink-0" />
                <span className="font-semibold truncate">镜头 #{activeShot.shot_index}: {activeShot.action_desc || activeShot.image_prompt?.slice(0, 30)}</span>
              </span>
              <button onClick={() => setActiveTab('director3d')} className="text-[10px] text-brand hover:underline ml-2 shrink-0 font-bold flex items-center gap-0.5">
                3D机位 <ArrowUpRight className="w-2.5 h-2.5" />
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 space-y-3.5 custom-scrollbar text-xs">
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

          {pendingList.length > 0 && (
            <div className="px-3 py-2 border-t border-amber-500/30 bg-amber-500/5 space-y-1.5 shrink-0">
              <div className="text-[10px] font-bold text-amber-300 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" />待确认 {pendingList.length}
              </div>
              {pendingList.map(([aid, v]) => (
                <div key={aid} className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-white truncate flex-1">{v.tool_name}</span>
                  <button onClick={() => approve(aid, true)} className="px-2 py-0.5 rounded-md bg-amber-500 text-black text-[10px] font-bold">允许</button>
                  <button onClick={() => approve(aid, false)} className="px-2 py-0.5 rounded-md border border-border text-[10px] text-gray-300">拒绝</button>
                </div>
              ))}
            </div>
          )}

          <div className="p-3 border-t border-border bg-surface shrink-0">
            <AgentComposer
              compact
              mode={mode}
              runMode={runMode}
              isRunning={isRunning}
              wsStatus={wsStatus}
              onSend={(t) => void send(t)}
              onAbort={abort}
            />
          </div>
        </div>
      )}
    </>
  );
};
