// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 3D 导演节点开发样例（仅开发 / 自测用，不接路由，不从 index.ts 导出）。
 *
 * 一张小画布：文本、图片 → 3D 导演 → 「视频生成（样例）」（用 kit 的 useNodeReferences + assembleInputs 展示它收到的
 * camera_prompt 槽位）。最小宿主：
 * - execute：照搬 CreativeCanvas 的 director3d 分支（MCP director_3d_stage_plan → 写回 {minimax_camera_prompt, ...r}）；
 * - navigate：记录到页面右上角（真实宿主由 H1 接 useProjectStore）；
 * - createNodes：不注入，走 kit 缺省实现；projectId 取地址栏 ?pid=（导出上传到该项目的素材库）。
 * 演示节点类型都带 `d3-demo-` 前缀且不进工具栏；load-image / load-video 未注册时注册一个极简版，供导出新节点显示。
 */
import { StrictMode, useCallback, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconFileText, IconMovie, IconPhoto, IconVideo } from '@tabler/icons-react';
import {
  CanvasHostProvider, NodeSkeleton, assembleInputs, defineNode, getNodeDef, isValidConnectionFactory, nodeTypesMap, ownPromptOf,
  useNodeReferences, type CanvasHost, type PortDef,
} from '../../../kit';
import { apiService } from '../../../../../services/api';
import { resolveMediaUrl } from '../../../../../utils/devOrigin';
import '../index';
import { createDirector3DData } from '../model';

const svgImage = (from: string, to: string, text: string) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="160" cy="70" r="26" fill="#fff" opacity="0.85"/><rect x="138" y="96" width="44" height="70" rx="12" fill="#fff" opacity="0.85"/><text x="16" y="28" font-size="18" fill="#ffffff" font-family="sans-serif">${text}</text></svg>`,
)}`;

const TEXT_PORTS: PortDef[] = [{ id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' }];
function DemoTextNode(props: NodeProps) {
  const d = props.data as { prompt?: string };
  const rf = useReactFlow();
  return (
    <NodeSkeleton node={props} onFullscreen={null}>
      <textarea
        className="nodrag nopan nowheel"
        style={{ width: '100%', minHeight: 72, resize: 'vertical', border: 0, outline: 'none', background: 'transparent', color: 'var(--cv-text-1)', font: 'inherit', fontSize: 13 }}
        value={d.prompt ?? ''}
        placeholder="剧情 / 镜头描述"
        onChange={(e) => rf.updateNodeData(props.id, { prompt: e.target.value })}
      />
    </NodeSkeleton>
  );
}

const IMAGE_PORTS: PortDef[] = [{ id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' }];
function DemoImageNode(props: NodeProps) {
  const d = props.data as { image_url?: string };
  return (
    <NodeSkeleton node={props} width={260} downloadUrl={d.image_url}>
      {d.image_url
        ? <img src={resolveMediaUrl(d.image_url)} alt="" style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} draggable={false} />
        : <div className="cv-media-empty"><IconPhoto size={48} stroke={1.25} /></div>}
    </NodeSkeleton>
  );
}

const GEN_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['IMAGE', 'VIDEO', 'AUDIO', 'STRING'], label: '图片、视频、音频、文本输入' },
  { id: 'video', type: 'source', dataType: 'VIDEO', label: '视频输出' },
];
function DemoGenNode(props: NodeProps) {
  const d = props.data as { prompt?: string };
  const { refs } = useNodeReferences(props.id);
  const assembled = useMemo(() => assembleInputs({ refs, targetType: 'video', prompt: ownPromptOf('video', d) }), [refs, d]);
  return (
    <NodeSkeleton node={props} width={300} showToolbar={false}>
      <div style={{ fontSize: 12, color: 'var(--cv-text-2)', marginBottom: 4 }}>收到的 camera_prompt 槽位：</div>
      <pre data-testid="gen-camera-prompt" className="nodrag nopan nowheel" style={{ margin: 0, maxHeight: 140, overflow: 'auto', fontSize: 11, lineHeight: 1.5, color: 'var(--cv-text-1)', whiteSpace: 'pre-wrap' }}>
        {assembled.camera_prompt || '（无）'}
      </pre>
    </NodeSkeleton>
  );
}

// 导出新节点的极简显示（N2 / N3 的正式节点注册后以正式的为准）
function DemoLoadImage(props: NodeProps) {
  const d = props.data as { image_url?: string };
  return (
    <NodeSkeleton node={props} width={260} downloadUrl={d.image_url ? resolveMediaUrl(d.image_url) : undefined}>
      {d.image_url ? <img src={resolveMediaUrl(d.image_url)} alt="" style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} draggable={false} /> : <div className="cv-media-empty"><IconPhoto size={40} /></div>}
    </NodeSkeleton>
  );
}
function DemoLoadVideo(props: NodeProps) {
  const d = props.data as { video_url?: string };
  return (
    <NodeSkeleton node={props} width={300} downloadUrl={d.video_url ? resolveMediaUrl(d.video_url) : undefined}>
      {d.video_url
        ? <video className="nodrag" src={resolveMediaUrl(d.video_url)} controls muted playsInline style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} />
        : <div className="cv-media-empty"><IconVideo size={40} /></div>}
    </NodeSkeleton>
  );
}

defineNode({ type: 'd3-demo-text', label: '文本（样例）', icon: IconFileText, category: 'text', ports: TEXT_PORTS, component: DemoTextNode, inPalette: false });
defineNode({ type: 'd3-demo-image', label: '图片（样例）', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: DemoImageNode, inPalette: false });
defineNode({ type: 'd3-demo-gen', label: '视频生成（样例）', icon: IconMovie, category: 'video', ports: GEN_PORTS, component: DemoGenNode, inPalette: false });
if (!getNodeDef('load-image')) defineNode({ type: 'load-image', label: '图片', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: DemoLoadImage, inPalette: false });
if (!getNodeDef('load-video')) defineNode({ type: 'load-video', label: '视频', icon: IconVideo, category: 'video', ports: [{ id: 'video', type: 'source', dataType: 'VIDEO', label: '视频输出' }], component: DemoLoadVideo, inPalette: false });

const initialNodes: Node[] = [
  { id: 'txt', type: 'd3-demo-text', position: { x: 0, y: 0 }, data: { label: '镜头描述', prompt: '主角在雨夜屋顶与宿敌对峙，镜头贴地缓慢推近' } },
  { id: 'img', type: 'd3-demo-image', position: { x: 0, y: 220 }, data: { label: '构图参考', image_url: svgImage('#0F172A', '#7C3AED', '构图参考') } },
  { id: 'd3', type: 'director3d', position: { x: 380, y: 0 }, selected: true, data: { label: '3D 导演', ...createDirector3DData(), ai_directive: '{{ref 1}}' } },
  // 旧画布数据（MinimalNodes 时代只有这些键，没有 camera_prompt）：节点挂载后应自动补齐输出
  { id: 'd3old', type: 'director3d', position: { x: 380, y: 760 }, data: { framing: 'close_up', motion: 'orbit', pose: 'fight', focal_length_mm: 50, cast_layout: 'duel', speed: '1.5x', ai_directive: '', minimax_camera_prompt: '[Camera: Motion: Orbit Clockwise 180°, Cinematic arc shot, Framing: Close Up, Lens: 50mm, Speed: 1.5x]' } },
  { id: 'gen', type: 'd3-demo-gen', position: { x: 820, y: 40 }, data: { label: '视频生成', prompt: '雨夜对峙' } },
];
const initialEdges: Edge[] = [
  { id: 'e1', source: 'txt', sourceHandle: 'prompt', target: 'd3', targetHandle: 'in' },
  { id: 'e2', source: 'img', sourceHandle: 'image', target: 'd3', targetHandle: 'in' },
  { id: 'e3', source: 'd3', sourceHandle: 'camera_prompt', target: 'gen', targetHandle: 'in' },
];

declare global {
  interface Window {
    __d3Showcase?: {
      getNodes: () => Node[];
      getEdges: () => Edge[];
      setViewport: (v: { x: number; y: number; zoom: number }) => void;
      setSelected: (id: string | null) => void;
      navigations: Array<{ tab: string; payload?: Record<string, unknown> }>;
    };
  }
}

function ShowcaseCanvas({ isLight }: { isLight: boolean }) {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const rf = useReactFlow();
  const [navigations, setNavigations] = useState<Array<{ tab: string; payload?: Record<string, unknown> }>>([]);
  const isValidConnection = useMemo(() => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }), [rf]);
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge(c, es)), [setEdges]);
  const active = new Set(nodes.filter((n) => n.selected || n.dragging).map((n) => n.id));
  const viewEdges = edges.map((e) => (active.has(e.source) || active.has(e.target) ? { ...e, className: 'cv-edge-active' } : e));
  const projectId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('pid') || undefined : undefined;

  const host = useMemo<CanvasHost>(() => ({
    projectId,
    openFullscreen: ({ url }) => window.open(url, '_blank', 'noopener'),
    // 与 CreativeCanvas.handleNodeExecute 的 director3d 分支同口径
    execute: async (nodeId, overrides) => {
      const node = rf.getNode(nodeId);
      if (!node) return;
      const d = { ...(node.data as Record<string, any>), ...(overrides || {}) };
      const res = await apiService.callMcpTool('director_3d_stage_plan', {
        framing: d.framing || 'medium', motion: d.motion || 'push_in', pose: d.pose || 'stand', focal_length_mm: d.focal_length_mm || 35,
        camera_roll_deg: d.camera_roll_deg || 0, cast_layout: d.cast_layout || 'solo', speed: d.speed || '1.0x', ai_directive: d.ai_directive || '',
      });
      if (res?.status === 'error') throw new Error(res.error || 'director_3d_stage_plan 失败');
      const r = res?.result || res;
      rf.updateNodeData(nodeId, { minimax_camera_prompt: r.minimax_camera_prompt || JSON.stringify(r).slice(0, 200), ...r });
    },
    navigate: (tab, payload) => {
      console.info('[Director3DShowcase] navigate', tab, payload);
      setNavigations((list) => [...list, { tab, payload }]);
    },
  }), [rf, projectId]);

  if (typeof window !== 'undefined') {
    window.__d3Showcase = {
      getNodes: () => rf.getNodes(),
      getEdges: () => rf.getEdges(),
      setViewport: (v) => { void rf.setViewport(v); },
      setSelected: (id) => rf.setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id }))),
      navigations,
    };
  }

  return (
    <CanvasHostProvider value={host}>
      <ReactFlow
        className={`cv-canvas ${isLight ? 'light' : 'dark'}`}
        colorMode={isLight ? 'light' : 'dark'}
        nodes={nodes}
        edges={viewEdges}
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
        defaultViewport={{ x: 60, y: 140, zoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
      </ReactFlow>
      {navigations.length > 0 && (
        <pre data-testid="nav-log" style={{ position: 'fixed', right: 8, bottom: 8, zIndex: 10, maxWidth: 420, maxHeight: 220, overflow: 'auto', margin: 0, padding: 8, fontSize: 10, borderRadius: 8, background: 'var(--cv-bg)', color: 'var(--cv-text-2)', border: '1px solid var(--cv-border-light)' }}>
          {JSON.stringify(navigations[navigations.length - 1], null, 1)}
        </pre>
      )}
    </CanvasHostProvider>
  );
}

/** 开发样例：放进任意有高度的容器，如 `<div style={{height: '100vh'}}><Director3DShowcase /></div>`。地址栏 ?theme=light 切浅色。 */
export function Director3DShowcase() {
  const initialLight = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('theme') === 'light';
  const [isLight, setIsLight] = useState(initialLight);
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  return (
    <StrictMode>
      <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 600 }}>
        <button
          type="button"
          data-testid="theme-toggle"
          className="cv-btn"
          style={{ position: 'absolute', left: 8, top: 8, zIndex: 10, border: '1px solid var(--cv-border-light)', background: 'var(--cv-bg)' }}
          onClick={() => setIsLight((v) => !v)}
        >
          {isLight ? '切到深色' : '切到浅色'}
        </button>
        <ReactFlowProvider>
          <ShowcaseCanvas isLight={isLight} />
        </ReactFlowProvider>
      </div>
    </StrictMode>
  );
}

export default Director3DShowcase;
