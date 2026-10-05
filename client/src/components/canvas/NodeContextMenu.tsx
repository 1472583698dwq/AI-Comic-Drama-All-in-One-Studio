// -*- coding: utf-8 -*-
/**
 * 画布节点右键菜单。
 *
 * 菜单头（类型 / #id / 摘要）明确操作对象 + 「添加到会话 / 移出会话」（Agent 上下文聚焦）
 * + 「删除节点」（连带删掉挂在它身上的连线）。
 * 关闭时机：点菜单外、Esc、画布滚动、右键到别处（外部会换 menu 状态）。
 * 位置按视口夹紧，避免贴边被切掉。
 */
import React, { useEffect, useRef } from 'react';
import { MessagesSquare, Trash2, Box } from 'lucide-react';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { getNodeSpec } from './nodeRegistry';

export interface NodeMenuState {
  nodeId: string;
  /** 右键时的视口坐标（clientX/clientY） */
  x: number;
  y: number;
}

interface Props {
  menu: NodeMenuState | null;
  onClose: () => void;
  onDelete: (nodeId: string) => void;
}

const MENU_W = 208;
const EDGE = 8;

export const NodeContextMenu: React.FC<Props> = ({ menu, onClose, onDelete }) => {
  const nodes = useCanvasStore((s) => s.nodes);
  const agentFocusNodeIds = useCanvasStore((s) => s.agentFocusNodeIds);
  const toggleAgentFocusNode = useCanvasStore((s) => s.toggleAgentFocusNode);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const node = nodes.find((n: any) => n.id === menu.nodeId);
  // 节点在右键后、渲染前被删掉（例如快捷键）→ 直接不渲染
  if (!node) return null;

  const inSession = agentFocusNodeIds.includes(menu.nodeId);
  const spec = getNodeSpec(String(node.type || ''));
  const label = spec?.label || node.type || '节点';
  const title = String((node.data as any)?.prompt || (node.data as any)?.text || (node.data as any)?.brief || '').slice(0, 24);

  const top = Math.max(EDGE, Math.min(menu.y, window.innerHeight - 150 - EDGE));
  const left = Math.max(EDGE, Math.min(menu.x, window.innerWidth - MENU_W - EDGE));

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', top, left, width: MENU_W, zIndex: 9998 }}
      className="bg-white/55 dark:bg-white/[.06] border border-white/15 rounded-2xl p-1.5 shadow-2xl shadow-black/50 flex flex-col gap-0.5 backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
    >
      {/* 菜单头：明确操作对象，避免"右键的到底是哪个" */}
      <div className="px-2.5 py-1.5 border-b border-white/10 mb-1">
        <div className="text-[11px] font-bold [color:var(--color-text-main)] flex items-center gap-1.5">
          <Box className="w-3 h-3 text-violet-400 shrink-0" />
          <span className="truncate">{label}</span>
          <span className="text-[9px] font-mono [color:var(--color-text-muted)] ml-auto shrink-0">#{menu.nodeId.slice(-4)}</span>
        </div>
        {title && <div className="text-[10px] [color:var(--color-text-muted)] truncate mt-0.5">{title}</div>}
      </div>

      <button
        onClick={() => { toggleAgentFocusNode(menu.nodeId); onClose(); }}
        className="w-full px-2.5 py-2 rounded-xl text-left text-xs [color:var(--color-text-main)] hover:bg-white/10 flex items-center gap-2 transition-colors"
        title="加入会话后，AI 导演里说「这个节点」就会默认指向它"
      >
        <MessagesSquare className={`w-3.5 h-3.5 shrink-0 ${inSession ? 'text-emerald-400' : 'text-emerald-400/70'}`} />
        <span className="flex-1">{inSession ? '移出会话' : '添加到会话'}</span>
        {inSession && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-bold">已加入</span>}
      </button>

      <button
        onClick={() => { onDelete(menu.nodeId); onClose(); }}
        className="w-full px-2.5 py-2 rounded-xl text-left text-xs text-red-300 hover:bg-red-500/15 flex items-center gap-2 transition-colors"
        title="删除该节点及其连线"
      >
        <Trash2 className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1">删除节点</span>
      </button>
    </div>
  );
};
