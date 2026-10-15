// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 收集上游参考（对照 Toonflow nodeScaffold/src/useNodeReferences.ts）。
 * 从 React Flow store 读入边与上游节点数据，按连线顺序产出有序 RefItem[]；`data.refOrder` 可覆盖顺序。
 * 上游值读取见 references.readOutputValue（集成扩展点）。
 */
import { useCallback, useRef } from 'react';
import { useReactFlow, useStore, type Edge, type Node, type ReactFlowState } from '@xyflow/react';
import { useCanvasHost } from './hostContext';
import { buildRefs, moveKeys, refsEqual, remapRefTokens } from './references';
import type { RefItem, Slot } from './types';

export { readOutputValue, OUTPUT_VALUE_KEYS, buildRefs, orderRefs, remapRefTokens, refToken, refName } from './references';

export interface UseNodeReferencesOptions {
  /** 收集哪些入边：缺省 `in`（后端 R1 规则）；null = 所有入边；其他 = 只收该输入口。 */
  handleId?: string | null;
  /** 调整顺序时同步改写其中 `{{ref N}}` 编号的 data 键（缺省 audio 节点 ['text','prompt']，其余 ['prompt']）。 */
  promptKeys?: string[];
}

export interface NodeReferences {
  refs: RefItem[];
  /** 把第 from 项移到第 to 项（0 起），写 data.refOrder 并改写提示词编号。 */
  moveRef: (from: number, to: number) => void;
  /** 按完整 key 顺序重排（拖拽结束一次性提交）。 */
  setRefOrder: (keys: string[]) => void;
  /** 删除该参考对应的连线。 */
  removeRef: (item: RefItem) => void;
  /** 指定 / 清除显式槽位（写 data.refRoles）。 */
  setRefRole: (key: string, role: Slot | null) => void;
}

const EMPTY: RefItem[] = [];

export function useNodeReferences(nodeId: string, options: UseNodeReferencesOptions = {}): NodeReferences {
  const handleId = options.handleId === undefined ? 'in' : options.handleId;
  const promptKeysRef = useRef(options.promptKeys);
  promptKeysRef.current = options.promptKeys;
  const rf = useReactFlow();
  const host = useCanvasHost();

  const selector = useCallback((s: ReactFlowState) => {
    if (!s.nodeLookup.has(nodeId)) return EMPTY;
    // refOrder / refRoles 由 buildRefs 从目标节点 data 读取（与后端 inputs.py R1/R2 同规则）
    const items = buildRefs(s.edges as Edge[], (id) => s.nodeLookup.get(id) as Node | undefined, nodeId, { handleId });
    return items.length ? items : EMPTY;
  }, [nodeId, handleId]);

  const refs = useStore(selector, refsEqual);
  const refsRef = useRef(refs);
  refsRef.current = refs;

  const update = useCallback((patch: Record<string, unknown>) => {
    if (host.updateNodeData) host.updateNodeData(nodeId, patch);
    else rf.updateNodeData(nodeId, patch);
  }, [host, rf, nodeId]);

  const setRefOrder = useCallback((keys: string[]) => {
    const fromKeys = refsRef.current.map((r) => r.key);
    if (keys.length === fromKeys.length && keys.every((k, i) => k === fromKeys[i])) return;
    const patch: Record<string, unknown> = { refOrder: keys };
    const node = rf.getNode(nodeId);
    const data = (node?.data || {}) as Record<string, unknown>;
    // 缺省改写节点自身文本键：audio 为 text（+prompt），其余 prompt（同 ownPromptOf）
    const textKeys = promptKeysRef.current ?? (node?.type === 'audio' ? ['text', 'prompt'] : ['prompt']);
    for (const k of textKeys) {
      const v = data[k];
      if (typeof v !== 'string') continue;
      const next = remapRefTokens(v, fromKeys, keys);
      if (next !== v) patch[k] = next;
    }
    update(patch);
  }, [rf, nodeId, update]);

  const moveRef = useCallback((from: number, to: number) => {
    const keys = refsRef.current.map((r) => r.key);
    if (from === to || from < 0 || to < 0 || from >= keys.length || to >= keys.length) return;
    setRefOrder(moveKeys(keys, from, to));
  }, [setRefOrder]);

  const removeRef = useCallback((item: RefItem) => {
    const edgeId = item.edgeId ?? (rf.getEdges().find((e) => e.target === nodeId && e.source === item.sourceId && (e.sourceHandle ?? '') === item.sourceHandle)?.id);
    if (!edgeId) return;
    if (host.removeEdge) host.removeEdge(edgeId);
    else void rf.deleteElements({ edges: [{ id: edgeId }] });
  }, [rf, host, nodeId]);

  const setRefRole = useCallback((key: string, role: Slot | null) => {
    const data = (rf.getNode(nodeId)?.data || {}) as Record<string, unknown>;
    const roles = { ...((data.refRoles as Record<string, Slot>) || {}) };
    if (role) roles[key] = role;
    else delete roles[key];
    update({ refRoles: roles });
  }, [rf, nodeId, update]);

  return { refs, moveRef, setRefOrder, removeRef, setRefRole };
}
