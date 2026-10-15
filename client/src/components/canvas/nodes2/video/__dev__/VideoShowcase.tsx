// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N3 开发样例（不进路由、不从 index.ts 导出）：
 * 视频节点 + 视频生成节点 + 演示上游（图片 / 文本），宿主只给最小能力（保存到素材库 / 全屏），
 * createNodes 走 kit 缺省实现（截帧 / 分离 / 截取的产物直接加到这张画布上）。
 * URL 参数：?video=/storage/...mp4 &img1= &img2= （缺省用内联 SVG）&project= &theme=light
 */
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconFileText, IconMusic, IconPhoto } from '@tabler/icons-react';
import {
  CanvasHostProvider, NodeSkeleton, SelectionToolbar, defineNode, getNodeDef, isValidConnectionFactory, nodeTypesMap,
  type CanvasHost, type PortDef,
} from '../../../kit';
import { resolveMediaUrl } from '../../../../../utils/devOrigin';
import { GlobalDialogContainer } from '../../../../ui/GlobalDialogContainer';
import '../index';

const svgImage = (from: string, to: string, text: string) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="360" height="640" fill="url(#g)"/><text x="180" y="330" font-size="28" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${text}</text></svg>`,
)}`;

// —— 演示上游节点（输出口 id 同真实节点：图片 image、文本 prompt）——
const IMAGE_PORTS: PortDef[] = [{ id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' }];
function DemoImageNode(props: NodeProps) {
  const d = props.data as { image_url?: string };
  const src = resolveMediaUrl(d.image_url);
  return (
    <NodeSkeleton node={props} downloadUrl={src || undefined}>
      {src ? <img src={src} alt="" style={{ display: 'block', width: '100%', maxHeight: 240, objectFit: 'contain', borderRadius: 'var(--cv-radius)' }} draggable={false} /> : <div className="cv-media-empty"><IconPhoto size={48} stroke={1.25} /></div>}
    </NodeSkeleton>
  );
}
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
        onChange={(e) => rf.updateNodeData(props.id, { prompt: e.target.value })}
      />
    </NodeSkeleton>
  );
}
// 截帧 / 提取音轨的产物类型（正式实现在 N2 / N4；这里没注册时放个只读占位，便于看结果）
function PlaceholderImage(props: NodeProps) {
  const d = props.data as { image_url?: string };
  return <NodeSkeleton node={props} downloadUrl={resolveMediaUrl(d.image_url) || undefined}>{d.image_url ? <img src={resolveMediaUrl(d.image_url)} alt="" style={{ display: 'block', width: '100%', maxHeight: 240, objectFit: 'contain' }} draggable={false} /> : null}</NodeSkeleton>;
}
function PlaceholderAudio(props: NodeProps) {
  const d = props.data as { audio_url?: string; duration?: number };
  return (
    <NodeSkeleton node={props} downloadUrl={resolveMediaUrl(d.audio_url) || undefined}>
      {d.audio_url ? <audio className="nodrag" src={resolveMediaUrl(d.audio_url)} controls style={{ width: '100%' }} /> : null}
      <div style={{ fontSize: 12, color: 'var(--cv-text-3)', marginTop: 4 }}>{d.duration ? `${d.duration.toFixed(2)} 秒` : ''}</div>
    </NodeSkeleton>
  );
}
defineNode({ type: 'n3-demo-image', label: '图片（样例）', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: DemoImageNode, inPalette: false });
defineNode({ type: 'n3-demo-text', label: '文本（样例）', icon: IconFileText, category: 'text', ports: TEXT_PORTS, component: DemoTextNode, inPalette: false });
if (!getNodeDef('load-image')) defineNode({ type: 'load-image', label: '图片（占位）', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: PlaceholderImage, inPalette: false });
if (!getNodeDef('load-audio')) defineNode({ type: 'load-audio', label: '音频（占位）', icon: IconMusic, category: 'audio', ports: [{ id: 'audio', type: 'source', dataType: 'AUDIO', label: '音频输出' }], component: PlaceholderAudio, inPalette: false });

function q(name: string): string {
  try { return new URLSearchParams(window.location.search).get(name) || ''; } catch { return ''; }
}

function initialGraph(): { nodes: Node[]; edges: Edge[] } {
  const img1 = q('img1') || svgImage('#7C3AED', '#06B6D4', '首帧 · 角色 A');
  const img2 = q('img2') || svgImage('#F97316', '#EC4899', '尾帧 · 回眸');
  const nodes: Node[] = [
    { id: 'lv', type: 'load-video', position: { x: 0, y: 0 }, data: { label: '素材视频', ...(q('video') ? { video_url: q('video'), video: q('video'), url: q('video') } : {}) } },
    { id: 'img1', type: 'n3-demo-image', position: { x: 0, y: 420 }, data: { label: '角色立绘', image_url: img1 } },
    { id: 'img2', type: 'n3-demo-image', position: { x: 0, y: 760 }, data: { label: '回眸', image_url: img2 } },
    { id: 'txt', type: 'n3-demo-text', position: { x: 0, y: 1100 }, data: { label: '剧情', prompt: '雨夜，主角撑伞走过霓虹街道，回眸一笑。' } },
    { id: 'gen', type: 'video', position: { x: 520, y: 420 }, data: { label: '视频生成', prompt: '{{ref 1}} 按 {{ref 2}} 的剧情慢慢转身', mode: '' } },
    // 旧画布迁移来的视频节点：mode=i2v + 首尾帧槽位 → 显示为「首尾帧」
    { id: 'legacy', type: 'video', position: { x: 520, y: 900 }, data: { label: '旧视频节点（i2v）', prompt: '镜头缓慢推进', mode: 'i2v', refRoles: { 'img1|image': 'first_frame', 'img2|image': 'last_frame' } } },
  ];
  const edges: Edge[] = [
    { id: 'e1', source: 'img1', sourceHandle: 'image', target: 'gen', targetHandle: 'in' },
    { id: 'e2', source: 'txt', sourceHandle: 'prompt', target: 'gen', targetHandle: 'in' },
    { id: 'e3', source: 'img1', sourceHandle: 'image', target: 'legacy', targetHandle: 'in' },
    { id: 'e4', source: 'img2', sourceHandle: 'image', target: 'legacy', targetHandle: 'in' },
  ];
  return { nodes, edges };
}

function applyTheme(theme: 'light' | 'dark') {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('light', theme === 'light');
  root.classList.toggle('dark', theme === 'dark');
}

function ShowcaseCanvas({ theme }: { theme: 'light' | 'dark' }) {
  const init = useMemo(() => initialGraph(), []);
  const [nodes, , onNodesChange] = useNodesState(init.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(init.edges);
  const rf = useReactFlow();
  const isValidConnection = useMemo(() => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }), [rf]);
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge(c, es)), [setEdges]);
  const active = new Set(nodes.filter((n) => n.selected || n.dragging).map((n) => n.id));
  const viewEdges = edges.map((e) => (active.has(e.source) || active.has(e.target) ? { ...e, className: 'cv-edge-active' } : e));
  // 最小宿主：不给 createNodes / updateNodeData（走 kit 缺省：React Flow addNodes / updateNodeData）
  const host = useMemo<CanvasHost>(() => ({
    saveToAssets: (id) => console.info('[VideoShowcase] 保存到素材库', id),
    openFullscreen: ({ url }) => window.open(url, '_blank', 'noopener'),
    projectId: q('project') || undefined,
  }), []);
  return (
    <CanvasHostProvider value={host}>
      <ReactFlow
        className={`cv-canvas ${theme}`}
        colorMode={theme}
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
        defaultViewport={{ x: 140, y: 60, zoom: 0.8 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
        <SelectionToolbar />
      </ReactFlow>
    </CanvasHostProvider>
  );
}

export function VideoShowcase() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (q('theme') === 'light' ? 'light' : 'dark'));
  useLayoutEffect(() => applyTheme(theme), [theme]);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--cv-canvas-bg)' }}>
      <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 10, display: 'flex', gap: 8 }}>
        <button type="button" className="cv-btn cv-btn--outline" data-testid="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '切到浅色' : '切到深色'}
        </button>
      </div>
      <ReactFlowProvider>
        <ShowcaseCanvas theme={theme} />
      </ReactFlowProvider>
      <GlobalDialogContainer />
    </div>
  );
}

export default VideoShowcase;
