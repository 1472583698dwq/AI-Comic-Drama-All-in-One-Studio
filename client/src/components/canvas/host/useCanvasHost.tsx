// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1：CanvasHost 的宿主实现（kit 节点只经 useKitNodeActions 调这些能力，COORDINATION 第 9 条）。
 *
 * updateNodeData（合并补丁、undefined = 删键 + 收窄后的下游传播）、saveToAssets / canSaveToAssets（带 asset_id 的
 * 素材节点与已保存过的同一产出置灰）、openFullscreen、execute（host/executeRouter）、createNodes（host/createNodes，
 * Toonflow 摆放）、navigate（3D 片场：setActiveShotId + updateShot + setActiveTab）、projectId、
 * rename / copy / duplicate / remove（分组只删框、子节点释放）/ removeEdge、右键菜单追加「添加到会话」「回写到分镜」。
 * 所有写操作都落在宿主自己的 nodes / edges 状态上（进撤销历史、走 800ms 自动保存）。
 */
import { useCallback, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { IconCornerUpLeft, IconMessages } from '@tabler/icons-react';
import { apiService } from '../../../services/api';
import { toast } from '../../../stores/useDialogStore';
import { useCanvasStore } from '../../../stores/useCanvasStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import type { CanvasHost, MediaKind } from '../kit/hostContext';
import type { MenuItemSpec } from '../kit/ui/Popover';
import { getNodeDef } from '../kit/registry';
import { readOutputValue } from '../kit/references';
import { GROUP_TYPE, defaultIdFactory, duplicateNodes, ungroupNodes } from '../kit/graphOps';
import { resolveDynamicPorts } from '../nodes2/legacy-b/ports';
import { collectNodeResults } from '../shotWriteBack';
import { applyDataPatch, applyPatches, downstreamPatches } from './propagation';
import { createExecuteRouter, type ExecuteResult } from './executeRouter';
import { hostCreateNodes } from './createNodes';
import type { ViewerState, WriteBackState } from './canvasChrome';

type AnyData = Record<string, any>;

const LOADER_TYPES = new Set(['load-image', 'load-video', 'load-audio']);
const TEXT_ASSET_TYPES = new Set(['prompt', 'brief']);

export interface NodeAsset {
  kind: 'image' | 'video' | 'audio' | 'text';
  /** 媒体 URL 或文本正文 */
  value: string;
}

/** 节点可保存到素材库的产出：文本节点 = 正文；其余按声明的输出口顺序取第一个媒体产出。 */
export function nodeAssetOf(node: Pick<Node, 'type' | 'data'> | undefined | null): NodeAsset | null {
  if (!node) return null;
  const d = (node.data || {}) as AnyData;
  if (TEXT_ASSET_TYPES.has(node.type || '')) {
    const text = String((node.type === 'brief' ? d.brief : d.prompt || d.text) || '').trim();
    return text ? { kind: 'text', value: text } : null;
  }
  for (const p of resolveDynamicPorts(node)) {
    if (p.type !== 'source') continue;
    const types = ([] as string[]).concat(p.dataType as string | string[]).filter((t) => t !== '*' && t !== 'STRING');
    for (const t of types) {
      const v = readOutputValue(node, p.id, t as 'IMAGE' | 'VIDEO' | 'AUDIO');
      if (v) return { kind: t.toLowerCase() as NodeAsset['kind'], value: v };
    }
  }
  return null;
}

/** 是否还能「保存到素材库」：有产出；素材节点带 asset_id（本就来自素材库）或同一产出已保存过 → 置灰（N2/N3/N4）。 */
export function canSaveNodeAsset(node: Pick<Node, 'type' | 'data'> | undefined | null): boolean {
  const a = nodeAssetOf(node);
  if (!a) return false;
  const d = (node?.data || {}) as AnyData;
  if (LOADER_TYPES.has(node?.type || '') && d.asset_id) return false;
  const saved = d._saved_asset;
  return !(saved && typeof saved === 'object' && saved.value === a.value);
}

export interface CanvasHostDeps {
  pid: string | null;
  nodesRef: MutableRefObject<Node[]>;
  edgesRef: MutableRefObject<Edge[]>;
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  setSelectedNodeId: (id: string | null) => void;
}

export interface CanvasHostController {
  host: CanvasHost;
  updateNodeData: (nodeId: string, patch: AnyData) => void;
  /** 返回产物（媒体生成的 url / 文本正文），见 host/executeRouter.ExecuteResult */
  execute: (nodeId: string, overrides?: AnyData) => Promise<ExecuteResult>;
  removeNodes: (ids: string[], opts?: { silent?: boolean }) => void;
  viewer: ViewerState | null;
  setViewer: (v: ViewerState | null) => void;
  writeBack: WriteBackState | null;
  setWriteBack: (v: WriteBackState | null) => void;
}

export function useCanvasHostController(deps: CanvasHostDeps): CanvasHostController {
  const { pid, nodesRef, edgesRef, setNodes, setEdges, setSelectedNodeId } = deps;
  const pidRef = useRef(pid);
  pidRef.current = pid;
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [writeBack, setWriteBack] = useState<WriteBackState | null>(null);

  const getNode = useCallback((id: string) => nodesRef.current.find((n) => n.id === id), [nodesRef]);

  // REQ-toonflow-canvas H1：合并补丁（undefined 删键）+ 收窄的下游传播（只传源端口产出值，见 propagation.ts）
  const updateNodeData = useCallback((nodeId: string, patch: AnyData) => {
    setNodes((nds) => {
      const idx = nds.findIndex((n) => n.id === nodeId);
      if (idx < 0) return nds;
      const cur = nds[idx];
      const data = applyDataPatch(cur.data as AnyData, patch);
      if (data === cur.data) return nds;
      const next = nds.slice();
      next[idx] = { ...cur, data };
      const downs = downstreamPatches(next, edgesRef.current, nodeId);
      return applyPatches(next, downs);
    });
  }, [setNodes, edgesRef]);

  const execute = useMemo(() => createExecuteRouter({
    getNode,
    getEdges: () => edgesRef.current,
    updateNodeData,
    projectId: () => pidRef.current || undefined,
  }), [getNode, edgesRef, updateNodeData]);

  const removeNodes = useCallback((ids: string[], opts: { silent?: boolean } = {}) => {
    if (!ids.length) return;
    const all = nodesRef.current;
    const groupIds = ids.filter((id) => all.find((n) => n.id === id)?.type === GROUP_TYPE);
    const drop = new Set(ids.filter((id) => !groupIds.includes(id)));
    // 分组只删框：子节点回到上一级并保持画布位置（同后端 canvas_delete_node）
    setNodes((nds) => ungroupNodes(nds, groupIds).filter((n) => !drop.has(n.id)));
    setEdges((es) => es.filter((e) => !drop.has(e.source) && !drop.has(e.target)));
    for (const id of ids) {
      try { useCanvasStore.getState().removeAgentFocusNode(id); } catch { /* ignore */ }
    }
    setSelectedNodeId(null);
    if (!opts.silent) toast.info(ids.length > 1 ? `已删除 ${ids.length} 个节点` : '节点已删除');
  }, [nodesRef, setNodes, setEdges, setSelectedNodeId]);

  const copyNode = useCallback((nodeId: string, withEdges: boolean) => {
    const res = duplicateNodes(nodesRef.current, edgesRef.current, [nodeId], { withEdges, placement: 'below', idFactory: defaultIdFactory });
    if (!res.newIds.length) return;
    const fresh = new Set(res.newIds);
    setNodes(res.nodes.map((n) => (n.selected === fresh.has(n.id) ? n : { ...n, selected: fresh.has(n.id) })));
    setEdges(res.edges);
    setSelectedNodeId(res.newIds[0]);
  }, [nodesRef, edgesRef, setNodes, setEdges, setSelectedNodeId]);

  const saveToAssets = useCallback(async (nodeId: string) => {
    const node = getNode(nodeId);
    const asset = nodeAssetOf(node);
    if (!node || !asset) { toast.warning('该节点还没有可保存的产出'); return; }
    const d = (node.data || {}) as AnyData;
    const name = String(d.label || getNodeDef(node.type)?.label || '画布节点').slice(0, 60);
    const fd = new FormData();
    fd.append('name', name);
    if (asset.kind === 'text') {
      fd.append('category', 'text');
      fd.append('content', asset.value);
    } else {
      fd.append('category', 'other');
      fd.append('file_url', asset.value);
    }
    fd.append('tags', JSON.stringify(['canvas']));
    fd.append('scope', 'project');
    if (pidRef.current) fd.append('project_id', pidRef.current);
    try {
      const res: AnyData = await apiService.createAsset(fd);
      const id = String(res?.asset?.id ?? res?.id ?? '');
      updateNodeData(nodeId, { _saved_asset: { id, value: asset.value } });
      try { window.dispatchEvent(new Event('asset-refresh')); } catch { /* ignore */ }
      toast.success('已保存到素材库');
    } catch (e) {
      toast.error(`保存到素材库失败：${(e as Error)?.message || e}`);
      throw e;
    }
  }, [getNode, updateNodeData]);

  const navigate = useCallback((tab: string, payload?: AnyData) => {
    const ps = useProjectStore.getState();
    if (tab === 'director3d') {
      // N5：3D 片场只认 activeShotId；有分镜归属就切到该镜并把节点的机位参数写回分镜
      const shotId = typeof payload?.shotId === 'string' ? payload.shotId : '';
      if (shotId) {
        ps.setActiveShotId(shotId);
        const shotPatch = payload?.shotPatch;
        if (shotPatch && typeof shotPatch === 'object' && Object.keys(shotPatch).length) {
          try { ps.updateShot(shotId, shotPatch as AnyData); } catch (e) { console.warn('[Canvas] updateShot failed', e); }
        }
      }
    }
    ps.setActiveTab(tab as Parameters<typeof ps.setActiveTab>[0]);
  }, []);

  const contextMenuItems = useCallback((nodeId: string): MenuItemSpec[] => {
    const node = getNode(nodeId);
    if (!node || node.type === GROUP_TYPE) return [];
    const cs = useCanvasStore.getState();
    const inSession = (cs.agentFocusNodeIds || []).includes(nodeId);
    const items: MenuItemSpec[] = [{
      key: 'agent-focus',
      label: inSession ? '移出会话' : '添加到会话',
      icon: <IconMessages size={16} aria-hidden />,
      onSelect: () => cs.toggleAgentFocusNode(nodeId),
    }];
    const results = collectNodeResults(node.type || '', node.data);
    if (results.length) {
      items.push({
        key: 'shot-writeback',
        label: '回写到分镜…',
        icon: <IconCornerUpLeft size={16} aria-hidden />,
        onSelect: () => setWriteBack({ nodeId, nodeType: node.type || '' }),
      });
    }
    return items;
  }, [getNode, setWriteBack]);

  const host = useMemo<CanvasHost>(() => ({
    projectId: pid || undefined,
    updateNodeData,
    saveToAssets,
    canSaveToAssets: (nodeId) => canSaveNodeAsset(getNode(nodeId)),
    openFullscreen: ({ url, kind }: { nodeId: string; url: string; kind?: MediaKind }) => { if (url) setViewer({ url, kind }); },
    execute,
    createNodes: (specs, opts) => hostCreateNodes({
      getNodes: () => nodesRef.current,
      getNode,
      setNodes: (u) => setNodes(u),
      setEdges: (u) => setEdges(u),
    }, specs, opts),
    navigate,
    rename: (nodeId, label) => updateNodeData(nodeId, { label }),
    copy: (nodeId) => copyNode(nodeId, false),
    duplicate: (nodeId) => copyNode(nodeId, true),
    remove: (nodeId) => removeNodes([nodeId]),
    removeEdge: (edgeId) => setEdges((es) => es.filter((e) => e.id !== edgeId)),
    contextMenuItems,
  }), [pid, updateNodeData, saveToAssets, getNode, execute, nodesRef, setNodes, setEdges, navigate, copyNode, removeNodes, contextMenuItems, setViewer]);

  return { host, updateNodeData, execute, removeNodes, viewer, setViewer, writeBack, setWriteBack };
}
