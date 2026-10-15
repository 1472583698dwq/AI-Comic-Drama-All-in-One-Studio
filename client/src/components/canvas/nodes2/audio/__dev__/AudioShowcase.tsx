// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N4 音频节点开发样例（仅开发 / 自测用，不接入路由，不从 nodes2/audio/index.ts 导出）。
 * 一张小画布：上游文本（演示节点）→「音频生成」，外加一个空的「音频」节点与一张演示图片（验证图片 + 音频参考 ≤1）。
 * 最小宿主：createNodes（Toonflow 规则：右侧 80px、向下避让 40px）、saveToAssets（只提示，不真入库）。
 * 右上角切换深浅色；window.__n4 暴露 React Flow 实例给浏览器自测脚本读节点数据。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconFileText, IconMoon, IconPhoto, IconSun } from '@tabler/icons-react';
import {
  CanvasHostProvider, NodeSkeleton, defineNode, getNodeDef, isValidConnectionFactory, nodeTypesMap,
  type CanvasHost, type NewNodeSpec, type CreateNodesOptions, type PortDef,
} from '../../../kit';
import { GlobalDialogContainer } from '../../../../ui/GlobalDialogContainer';
import { toast } from '../../../../../stores/useDialogStore';
import '../index';

// —— 演示上游：文本（输出口 prompt，COORDINATION 第 1 条）——
const TEXT_PORTS: PortDef[] = [{ id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' }];
function DemoTextNode(props: NodeProps) {
  const d = props.data as { prompt?: string };
  const rf = useReactFlow();
  return (
    <NodeSkeleton node={props} showToolbar={false}>
      <textarea
        className="nodrag nopan nowheel"
        aria-label="演示文本"
        style={{ width: '100%', minHeight: 84, resize: 'vertical', border: 0, outline: 'none', background: 'transparent', color: 'var(--cv-text-1)', font: 'inherit', fontSize: 13 }}
        value={d.prompt ?? ''}
        placeholder="写一段台词…"
        onChange={(e) => rf.updateNodeData(props.id, { prompt: e.target.value, text: e.target.value })}
      />
    </NodeSkeleton>
  );
}

const IMAGE_PORTS: PortDef[] = [{ id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' }];
const DEMO_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#7C3AED"/><text x="100" y="68" font-size="18" text-anchor="middle" fill="#fff" font-family="sans-serif">演示图片</text></svg>')}`;
function DemoImageNode(props: NodeProps) {
  return (
    <NodeSkeleton node={props} showToolbar={false}>
      <img src={DEMO_IMAGE} alt="演示图片" style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} draggable={false} />
    </NodeSkeleton>
  );
}

defineNode({ type: 'n4-demo-text', label: '文本（样例）', icon: IconFileText, category: 'text', ports: TEXT_PORTS, component: DemoTextNode, inPalette: false });
defineNode({ type: 'n4-demo-image', label: '图片（样例）', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: DemoImageNode, inPalette: false });

const initialNodes: Node[] = [
  { id: 'txt', type: 'n4-demo-text', position: { x: 0, y: 40 }, data: { label: '台词', prompt: '欢迎来到无限画布，这是一段测试配音。' } },
  { id: 'img', type: 'n4-demo-image', position: { x: 0, y: 300 }, data: { label: '参考图（演示）', image_url: DEMO_IMAGE } },
  { id: 'gen', type: 'audio', position: { x: 360, y: 40 }, data: { ...(getNodeDef('audio')?.defaultData?.() ?? {}), label: '音频生成' } },
  { id: 'load', type: 'load-audio', position: { x: 360, y: 420 }, data: { label: '音频' } },
];
const initialEdges: Edge[] = [{ id: 'e_txt_gen', source: 'txt', sourceHandle: 'prompt', target: 'gen', targetHandle: 'in' }];

function sizeOf(n: Node): { w: number; h: number } {
  return { w: (n.measured?.width ?? n.width ?? 360) as number, h: (n.measured?.height ?? n.height ?? 240) as number };
}

function ShowcaseCanvas({ isLight }: { isLight: boolean }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const rf = useReactFlow();
  useEffect(() => {
    (window as unknown as { __n4?: unknown }).__n4 = rf;
  }, [rf]);
  const isValidConnection = useMemo(() => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }), [rf]);
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge(c, es)), [setEdges]);

  const host = useMemo<CanvasHost>(() => ({
    saveToAssets: (id) => { toast.info(`（演示宿主）保存到素材库：${id}`); },
    // Toonflow audioActions 的摆放：源节点右侧 80px，与已有节点重叠时向下避让 40px
    createNodes: (specs: NewNodeSpec[], opts?: CreateNodesOptions) => {
      const anchor = opts?.anchorId ? rf.getNode(opts.anchorId) : undefined;
      const all = rf.getNodes();
      const ids: string[] = [];
      const created: Node[] = [];
      for (const spec of specs) {
        const a = anchor ? sizeOf(anchor) : { w: 360, h: 240 };
        const x = (anchor?.position.x ?? 0) + a.w + 80;
        let y = anchor?.position.y ?? 0;
        for (const other of [...all, ...created].sort((p, q) => p.position.y - q.position.y)) {
          const o = sizeOf(other);
          if (other.position.x < x + 360 && other.position.x + o.w > x && other.position.y < y + a.h && other.position.y + o.h > y) y = other.position.y + o.h + 40;
        }
        const id = `${spec.type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        ids.push(id);
        created.push({ id, type: spec.type, position: spec.position ?? { x, y }, data: spec.data, width: 360, height: 240 } as Node);
      }
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...created.map((n) => ({ ...n, width: undefined, height: undefined, selected: opts?.select !== false }))]);
      if (opts?.connectFrom) {
        const { nodeId, sourceHandle, targetHandle } = opts.connectFrom;
        setEdges((es) => [...es, ...ids.map((id) => ({ id: `e_${nodeId}_${id}`, source: nodeId, sourceHandle, target: id, targetHandle: targetHandle ?? 'in' }))]);
      }
      return ids;
    },
  }), [rf, setNodes, setEdges]);

  return (
    <CanvasHostProvider value={host}>
      <ReactFlow
        className={`cv-canvas ${isLight ? 'light' : 'dark'}`}
        colorMode={isLight ? 'light' : 'dark'}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypesMap()}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        connectionLineType={ConnectionLineType.SimpleBezier}
        defaultEdgeOptions={{ type: 'simplebezier' }}
        snapToGrid
        snapGrid={[16, 16]}
        minZoom={0.2}
        maxZoom={8}
        zoomOnScroll={false}
        panOnScroll
        zoomOnDoubleClick={false}
        defaultViewport={{ x: 80, y: 140, zoom: 0.9 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
      </ReactFlow>
    </CanvasHostProvider>
  );
}

/** 开发样例：放进任意有高度的容器即可。 */
export function AudioShowcase() {
  const [isLight, setLight] = useState(() => document.documentElement.getAttribute('data-theme') === 'light');
  const toggle = () => {
    const next = !isLight;
    const root = document.documentElement;
    root.setAttribute('data-theme', next ? 'light' : 'dark');
    root.classList.toggle('light', next);
    root.classList.toggle('dark', !next);
    setLight(next);
  };
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 600, background: 'var(--cv-canvas-bg)' }}>
      <button
        type="button"
        className="cv-audio-btn"
        style={{ position: 'absolute', top: 12, right: 12, zIndex: 10 }}
        aria-label={isLight ? '切换到深色' : '切换到浅色'}
        onClick={toggle}
      >
        {isLight ? <IconMoon size={16} aria-hidden /> : <IconSun size={16} aria-hidden />}
        {isLight ? '深色' : '浅色'}
      </button>
      <ReactFlowProvider>
        <ShowcaseCanvas isLight={isLight} />
      </ReactFlowProvider>
      <GlobalDialogContainer />
    </div>
  );
}

export default AudioShowcase;
