import { useCallback, useEffect, useRef } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { toast } from '../../../stores/useDialogStore';
import { rectOf, findFreeInColumn } from '../autoLayout';

/**
 * 画布标准快捷键：撤销 / 重做 / 复制 / 粘贴 / 删除。
 *
 * 设计要点：
 * - 快照必须剔除 data 里的函数（onUpdate / onExecute）。老版本用
 *   JSON.parse(JSON.stringify(nodes)) 做历史，函数被静默丢掉，撤销后节点
 *   的回调就没了，按钮全哑。这里统一走 attachHandlers 还原。
 * - 历史按 400ms 防抖记录：拖动节点每帧都会触发 onNodesChange，
 *   不防抖的话一次拖拽能塞进去几十条历史，Ctrl+Z 要按到手酸。
 * - 撤销/重做自身引起的变更用 restoringRef 标记，不再进历史，避免自激。
 * - 焦点在输入框 / 文本域 / 可编辑区，或中文输入法组合中时，一律不拦截，
 *   否则在节点里打字按 Ctrl+Z 会把整张画布回退掉。
 */

export interface CanvasSnapshot {
  nodes: Node[];
  edges: Edge[];
}

interface Options {
  enabled: boolean;
  nodes: Node[];
  edges: Edge[];
  setNodes: (updater: any) => void;
  setEdges: (updater: any) => void;
  /** 给节点重新挂上 onUpdate / onExecute 等运行时回调 */
  attachHandlers: (node: Node) => Node;
  genId: (prefix: string) => string;
  onSelect?: (id: string | null) => void;
}

const MAX_HISTORY = 60;
const DEBOUNCE_MS = 400;

/** 内存剪贴板：跨画布、跨项目粘贴都走它 */
let memoryClipboard: CanvasSnapshot | null = null;

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return el.isContentEditable === true;
};

const stripNodes = (nds: Node[]): Node[] =>
  nds.map(n => ({
    ...n,
    data: Object.fromEntries(
      Object.entries((n.data || {}) as Record<string, any>).filter(([, v]) => typeof v !== 'function'),
    ),
  })) as Node[];

export function useCanvasShortcuts({
  enabled, nodes, edges, setNodes, setEdges, attachHandlers, genId, onSelect,
}: Options) {
  const past = useRef<CanvasSnapshot[]>([]);
  const future = useRef<CanvasSnapshot[]>([]);
  const last = useRef<CanvasSnapshot | null>(null);
  const restoring = useRef(false);
  // 最新的 nodes/edges，供快捷键回调读取，避免把 handler 绑成闭包陈旧值
  const live = useRef<CanvasSnapshot>({ nodes, edges });
  live.current = { nodes, edges };

  const snap = useCallback(
    (): CanvasSnapshot => ({
      nodes: stripNodes(live.current.nodes),
      edges: JSON.parse(JSON.stringify(live.current.edges)),
    }),
    [],
  );

  // ---- 历史记录（防抖） ----
  useEffect(() => {
    if (!enabled) return;
    if (restoring.current) {
      restoring.current = false;
      last.current = snap();
      return;
    }
    const t = setTimeout(() => {
      const cur = snap();
      const prev = last.current;
      if (prev && JSON.stringify(prev) === JSON.stringify(cur)) return;
      if (prev) {
        past.current.push(prev);
        if (past.current.length > MAX_HISTORY) past.current.shift();
        future.current = [];
      }
      last.current = cur;
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [nodes, edges, enabled, snap]);

  const restore = useCallback(
    (s: CanvasSnapshot) => {
      restoring.current = true;
      setNodes(s.nodes.map(n => attachHandlers(n)));
      setEdges(JSON.parse(JSON.stringify(s.edges)));
      last.current = s;
    },
    [setNodes, setEdges, attachHandlers],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) { toast.info('没有可撤销的操作'); return; }
    future.current.push(last.current ?? snap());
    restore(prev);
    toast.info('已撤销');
  }, [restore, snap]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) { toast.info('没有可重做的操作'); return; }
    past.current.push(last.current ?? snap());
    restore(next);
    toast.info('已重做');
  }, [restore, snap]);

  const copy = useCallback(() => {
    const sel = live.current.nodes.filter(n => n.selected);
    if (!sel.length) { toast.info('先选中节点再复制（按住 Shift 可多选）'); return; }
    const ids = new Set(sel.map(n => n.id));
    const inner = live.current.edges.filter(e => ids.has(e.source) && ids.has(e.target));
    memoryClipboard = { nodes: stripNodes(sel), edges: JSON.parse(JSON.stringify(inner)) };
    toast.info(`已复制 ${sel.length} 个节点`);
  }, []);

  const paste = useCallback(() => {
    const clip = memoryClipboard;
    if (!clip || !clip.nodes.length) { toast.info('剪贴板是空的'); return; }
    const idMap = new Map<string, string>();
    // 整组沿原列向下平移到第一个放得下整组的空位（自动放置统一规则，见 autoLayout.ts），不再固定 +48 叠在原卡上
    const rects = clip.nodes.map(n => rectOf(n as any));
    const bx = Math.min(...rects.map(r => r.x));
    const by = Math.min(...rects.map(r => r.y));
    const bw = Math.max(...rects.map(r => r.x + r.w)) - bx;
    const bh = Math.max(...rects.map(r => r.y + r.h)) - by;
    const slot = findFreeInColumn(live.current.nodes.map(n => rectOf(n as any)), bx, by, bw, bh);
    const dy = slot.y - by;
    const newNodes = clip.nodes.map(n => {
      const nid = genId(String(n.type || 'node'));
      idMap.set(n.id, nid);
      return attachHandlers({
        ...n,
        id: nid,
        position: { x: n.position?.x ?? 0, y: (n.position?.y ?? 0) + dy },
        selected: true,
        data: { ...(n.data as any) },
      } as Node);
    });
    const newEdges = clip.edges.map(e => ({
      ...e,
      id: `e_${idMap.get(e.source)}_${idMap.get(e.target)}_${Date.now()}`,
      source: idMap.get(e.source) as string,
      target: idMap.get(e.target) as string,
    }));
    setNodes((nds: Node[]) => [...nds.map(n => ({ ...n, selected: false })), ...newNodes]);
    if (newEdges.length) setEdges((es: Edge[]) => [...es, ...newEdges]);
    onSelect?.(newNodes[newNodes.length - 1]?.id ?? null);
    toast.info(`已粘贴 ${newNodes.length} 个节点`);
  }, [setNodes, setEdges, attachHandlers, genId, onSelect]);

  const removeSelected = useCallback(() => {
    const sel = live.current.nodes.filter(n => n.selected);
    const selEdges = live.current.edges.filter(e => e.selected);
    if (!sel.length && !selEdges.length) return;
    const ids = new Set(sel.map(n => n.id));
    setNodes((nds: Node[]) => nds.filter(n => !ids.has(n.id)));
    setEdges((es: Edge[]) =>
      es.filter(e => !ids.has(e.source) && !ids.has(e.target) && !e.selected),
    );
    onSelect?.(null);
    toast.info(sel.length ? `已删除 ${sel.length} 个节点` : `已删除 ${selEdges.length} 条连线`);
  }, [setNodes, setEdges, onSelect]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((mod && k === 'y') || (mod && k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
      if (mod && k === 'c') { e.preventDefault(); copy(); return; }
      if (mod && k === 'v') { e.preventDefault(); paste(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, undo, redo, copy, paste, removeSelected]);

  return { undo, redo, copy, paste, removeSelected };
}

export default useCanvasShortcuts;
