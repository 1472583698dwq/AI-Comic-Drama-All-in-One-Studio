// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas kit 外观样例（仅开发 / 评审用，不接入路由，也不从 kit/index.ts 导出）。
 * 一张小画布：文本、图片、机位文本三个上游 → 「视频生成（样例）」节点（参考列表 + {{ref N}} 提示词 + 生成源 / 参数 / 智能规划），
 * 外加一个分组；框选 ≥2 个节点出现选区工具栏。演示节点类型都带 `kit-demo-` 前缀且不进工具栏，不会和正式节点冲突。
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconFileText, IconMovie, IconPhoto, IconVideo, IconWand } from '@tabler/icons-react';
import {
  CanvasHostProvider, NodeSkeleton, PromptPanel, SelectionToolbar, ToolbarButton, assembleInputs, availableModes, defineNode,
  getNodeDef, isValidConnectionFactory, nodeTypesMap, ownPromptOf, useNodeReferences, GEN_MODE_LABELS,
  type CanvasHost, type GenMode, type GenSourceOption, type PortDef, type SlotSpec,
} from '../index';

const svgImage = (from: string, to: string, text: string) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="160" y="98" font-size="22" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${text}</text></svg>`,
)}`;

// —— 演示节点 ——
// 文本节点输出口 id 为 `prompt`（COORDINATION.md 第 1 条）
const TEXT_PORTS: PortDef[] = [{ id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' }];
function DemoTextNode(props: NodeProps) {
  const d = props.data as { prompt?: string };
  const rf = useReactFlow();
  return (
    <NodeSkeleton node={props} toolbar={<ToolbarButton icon={IconWand} title="扩写">扩写</ToolbarButton>} onFullscreen={null}>
      <textarea
        className="nodrag nopan nowheel"
        style={{ width: '100%', minHeight: 80, resize: 'vertical', border: 0, outline: 'none', background: 'transparent', color: 'var(--cv-text-1)', font: 'inherit', fontSize: 13 }}
        value={d.prompt ?? ''}
        placeholder="写点什么…"
        onChange={(e) => rf.updateNodeData(props.id, { prompt: e.target.value })}
      />
    </NodeSkeleton>
  );
}

const IMAGE_PORTS: PortDef[] = [{ id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' }];
function DemoImageNode(props: NodeProps) {
  const d = props.data as { image_url?: string };
  return (
    <NodeSkeleton node={props} width={d.image_url ? 278 : 220} downloadUrl={d.image_url} downloadName="demo.svg">
      {d.image_url
        ? <img src={d.image_url} alt="" style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} draggable={false} />
        : <div className="cv-media-empty"><IconPhoto size={48} stroke={1.25} /></div>}
    </NodeSkeleton>
  );
}

const CAMERA_PORTS: PortDef[] = [{ id: 'camera_prompt', type: 'source', dataType: 'STRING', label: '机位' }];
function DemoCameraNode(props: NodeProps) {
  const d = props.data as { camera_prompt?: string };
  return (
    <NodeSkeleton node={props} showToolbar={false}>
      <div style={{ fontSize: 12, color: 'var(--cv-text-2)', lineHeight: 1.6 }}>{d.camera_prompt}</div>
    </NodeSkeleton>
  );
}

const SOURCES: GenSourceOption[] = [
  { id: 'hailuo-02', label: '海螺 Hailuo-02', group: '海螺' },
  { id: 'kling-v2', label: 'Kling v2.1', group: '可灵' },
  { id: 'seedance', label: 'Seedance 2.5', group: '即梦' },
];
// 不同生成源支持的槽位（真实环境来自 extractSlotsFromProvider）
const SOURCE_SLOTS: Record<string, SlotSpec[]> = {
  'hailuo-02': [
    { key: 'first_frame', type: 'image', maxCount: 1, originalKey: 'first_frame_image', label: '首帧' },
    { key: 'last_frame', type: 'image', maxCount: 1, originalKey: 'last_frame_image', label: '尾帧' },
  ],
  'kling-v2': [
    { key: 'first_frame', type: 'image', maxCount: 1, label: '首帧' },
    { key: 'reference_images', type: 'image', maxCount: 4, multi: true, label: '参考图' },
  ],
  seedance: [
    { key: 'reference_images', type: 'image', maxCount: 9, multi: true, label: '参考图' },
    { key: 'reference_videos', type: 'video', maxCount: 3, multi: true, label: '参考视频' },
    { key: 'ref_audio', type: 'audio', maxCount: 1, label: '参考音频' },
  ],
};

const GEN_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['IMAGE', 'VIDEO', 'AUDIO', 'STRING'], label: '图片、视频、音频、文本输入' },
  { id: 'video', type: 'source', dataType: 'VIDEO', label: '视频输出' },
];
function DemoGenNode(props: NodeProps) {
  const d = props.data as { prompt?: string; provider_id?: string; mode?: GenMode | ''; smart?: boolean; ratio?: string };
  const rf = useReactFlow();
  const update = (patch: Record<string, unknown>) => rf.updateNodeData(props.id, patch);
  const { refs, moveRef, removeRef } = useNodeReferences(props.id);
  const slots = SOURCE_SLOTS[d.provider_id ?? ''] ?? null;
  const assembled = useMemo(() => assembleInputs({ refs, targetType: 'video', prompt: ownPromptOf('video', d), mode: d.mode, slots }), [refs, d, slots]);
  const modes = availableModes(slots);
  const [running, setRunning] = useState(false);
  const send = () => {
    setRunning(true);
    window.setTimeout(() => setRunning(false), 1500);
  };
  return (
    <NodeSkeleton
      node={props}
      width={300}
      toolbar={modes.map((m) => (
        <ToolbarButton key={m} title={GEN_MODE_LABELS[m]} active={assembled.mode === m} onClick={() => update({ mode: m })}>{GEN_MODE_LABELS[m]}</ToolbarButton>
      ))}
      panel={(
        <PromptPanel
          refs={refs}
          prompt={d.prompt ?? ''}
          onPromptChange={(v) => update({ prompt: v })}
          onMoveRef={moveRef}
          onRemoveRef={removeRef}
          slotOf={(item) => assembled.assignments[item.key] ?? null}
          sources={SOURCES}
          sourceId={d.provider_id}
          onSourceChange={(id) => update({ provider_id: id })}
          paramsSummary={`${d.ratio ?? '16:9'} · 5s · 1080P`}
          paramsRatio={d.ratio ?? '16:9'}
          renderParams={() => (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['16:9', '9:16', '1:1', '4:3'].map((r) => (
                <ToolbarButton key={r} title={r} active={(d.ratio ?? '16:9') === r} onClick={() => update({ ratio: r })}>{r}</ToolbarButton>
              ))}
            </div>
          )}
          smartPlan={!!d.smart}
          onSmartPlanChange={(v) => update({ smart: v })}
          running={running}
          onSend={send}
          onStop={() => setRunning(false)}
          sendDisabled={!d.prompt?.trim()}
          warnings={assembled.warnings}
        />
      )}
    >
      <div className="cv-media-empty" style={{ minHeight: 120 }}>
        <IconMovie size={40} stroke={1.25} />
      </div>
      <pre className="nodrag nopan nowheel" style={{ margin: 0, maxHeight: 120, overflow: 'auto', fontSize: 10, lineHeight: 1.4, color: 'var(--cv-text-3)', whiteSpace: 'pre-wrap' }}>
        {JSON.stringify({ mode: assembled.mode, providerMode: assembled.providerMode, args: assembled.args }, null, 1)}
      </pre>
    </NodeSkeleton>
  );
}

defineNode({ type: 'kit-demo-text', label: '文本（样例）', icon: IconFileText, category: 'text', ports: TEXT_PORTS, component: DemoTextNode, inPalette: false });
defineNode({ type: 'kit-demo-image', label: '图片（样例）', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: DemoImageNode, inPalette: false });
defineNode({ type: 'kit-demo-camera', label: '机位（样例）', icon: IconVideo, category: '3d', ports: CAMERA_PORTS, component: DemoCameraNode, inPalette: false });
defineNode({ type: 'kit-demo-gen', label: '视频生成（样例）', icon: IconMovie, category: 'video', ports: GEN_PORTS, component: DemoGenNode, inPalette: false });

const initialNodes: Node[] = [
  { id: 'g1', type: 'group', position: { x: -20, y: -60 }, width: 328, height: 520, style: { width: 328, height: 520 }, data: { label: '素材' } },
  { id: 'img1', type: 'kit-demo-image', parentId: 'g1', position: { x: 24, y: 40 }, data: { label: '角色立绘', image_url: svgImage('#7C3AED', '#06B6D4', '角色 A') } },
  { id: 'img2', type: 'kit-demo-image', parentId: 'g1', position: { x: 24, y: 260 }, data: { label: '场景', image_url: svgImage('#F97316', '#EC4899', '雨夜街道') } },
  { id: 'txt', type: 'kit-demo-text', position: { x: 0, y: 520 }, data: { label: '剧情', prompt: '雨夜，主角撑伞走过霓虹街道，回眸一笑。' } },
  { id: 'cam', type: 'kit-demo-camera', position: { x: 0, y: 760 }, data: { label: '3D 导演', camera_prompt: '[推进] 中景 → 近景，缓慢环绕' } },
  { id: 'gen', type: 'kit-demo-gen', position: { x: 460, y: 160 }, selected: true, data: { label: '视频生成', prompt: '{{ref 1}} 站在 {{ref 2}} 中，按 {{ref 3}} 的剧情表演', provider_id: 'kling-v2'} },
];
const initialEdges: Edge[] = [
  { id: 'e1', source: 'img1', sourceHandle: 'image', target: 'gen', targetHandle: 'in' },
  { id: 'e2', source: 'img2', sourceHandle: 'image', target: 'gen', targetHandle: 'in' },
  { id: 'e3', source: 'txt', sourceHandle: 'prompt', target: 'gen', targetHandle: 'in' },
  { id: 'e4', source: 'cam', sourceHandle: 'camera_prompt', target: 'gen', targetHandle: 'in' },
];

function ShowcaseCanvas() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const rf = useReactFlow();
  const nodeTypes = nodeTypesMap();
  const isValidConnection = useMemo(
    () => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }),
    [rf],
  );
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge(c, es)), [setEdges]);
  // 与选中 / 拖动节点相连的边高亮（宿主职责，这里演示 .cv-edge-active）
  const active = new Set(nodes.filter((n) => n.selected || n.dragging).map((n) => n.id));
  const viewEdges = edges.map((e) => (active.has(e.source) || active.has(e.target) ? { ...e, className: 'cv-edge-active' } : e));
  const host = useMemo<CanvasHost>(() => ({
    saveToAssets: (id) => console.info('[KitShowcase] 保存到素材库', id),
    openFullscreen: ({ url }) => window.open(url, '_blank'),
    refresh: async (id) => { console.info('[KitShowcase] 刷新', id); await new Promise((r) => setTimeout(r, 600)); },
  }), []);
  // MiniMax 用 <html data-theme> 切深浅色；React Flow 的 colorMode 会给包裹层加 .light/.dark，需跟随
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
  return (
    <CanvasHostProvider value={host}>
      <ReactFlow
        className={`cv-canvas ${isLight ? 'light' : 'dark'}`}
        colorMode={isLight ? 'light' : 'dark'}
        nodes={nodes}
        edges={viewEdges}
        nodeTypes={nodeTypes}
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
        defaultViewport={{ x: 120, y: 160, zoom: 0.85 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
        <SelectionToolbar />
      </ReactFlow>
    </CanvasHostProvider>
  );
}

/** 开发样例：放进任意有高度的容器即可，如 `<div style={{height: '100vh'}}><KitShowcase /></div>`。 */
export function KitShowcase() {
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 600 }}>
      <ReactFlowProvider>
        <ShowcaseCanvas />
      </ReactFlowProvider>
    </div>
  );
}

export default KitShowcase;
