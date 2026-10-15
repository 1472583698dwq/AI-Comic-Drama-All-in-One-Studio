// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N6 外观样例（仅开发 / 评审用，不接入路由，也不从 legacy-a/index.ts 导出）。
 * 一张小画布挂齐五个换皮节点 + 一个最小宿主（CanvasHostProvider），上游用 `la-demo-*` 演示节点造连线：
 *   演示视频 ×2 / 演示音频 → 时间线（自动入列）、导出草稿；演示文本 → ComfyUI 工作流的 prompt 口；分镜卡带样例项目与动态端口。
 * 地址参数（自测用）：?theme=light|dark、?v1=&v2=（演示视频 URL）、?a1=（演示音频 URL）、?wf=（预选工作流 id）。
 * 右上角显示全局意图事件（open-export-modal / open-workflow-inspector）与宿主回调日志。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, Controls, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconFileText, IconMusic, IconVideo } from '@tabler/icons-react';
import {
  CanvasHostProvider, NodeSkeleton, defineNode, getNodeDef, isValidConnectionFactory, nodeTypesMap, type CanvasHost,
} from '../../../kit';
import { useProjectStore } from '../../../../../stores/useProjectStore';
import { resolveMediaUrl } from '../../../../../utils/devOrigin';
import '../index';
import { ShotWriteBackControls } from '../ShotWriteBackControl';

const svgImage = (from: string, to: string, text: string, w = 360, h = 640) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><text x="${w / 2}" y="${h / 2}" font-size="28" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${text}</text></svg>`,
)}`;

// —— 演示上游节点（只为造连线，不进工具栏）——
function DemoVideoNode(props: NodeProps) {
  const url = (props.data as { video_url?: string }).video_url || '';
  return (
    <NodeSkeleton node={props} downloadUrl={url ? resolveMediaUrl(url) : undefined}>
      {url
        ? <video src={resolveMediaUrl(url)} muted playsInline preload="metadata" style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} />
        : <div className="cv-media-empty"><IconVideo size={40} stroke={1.25} /></div>}
    </NodeSkeleton>
  );
}
function DemoAudioNode(props: NodeProps) {
  const url = (props.data as { audio_url?: string }).audio_url || '';
  return (
    <NodeSkeleton node={props} showToolbar={false}>
      <div style={{ fontSize: 12, color: 'var(--cv-text-2)', wordBreak: 'break-all' }}>{url || '（无音频）'}</div>
    </NodeSkeleton>
  );
}
function DemoTextNode(props: NodeProps) {
  const text = (props.data as { prompt?: string }).prompt || '';
  return (
    <NodeSkeleton node={props} showToolbar={false}>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--cv-text-1)' }}>{text}</div>
    </NodeSkeleton>
  );
}
defineNode({ type: 'la-demo-video', label: '演示视频', icon: IconVideo, category: 'video', ports: [{ id: 'video', type: 'source', dataType: 'VIDEO', label: '视频输出' }], component: DemoVideoNode, inPalette: false });
defineNode({ type: 'la-demo-audio', label: '演示音频', icon: IconMusic, category: 'audio', ports: [{ id: 'audio', type: 'source', dataType: 'AUDIO', label: '音频输出' }], component: DemoAudioNode, inPalette: false });
defineNode({ type: 'la-demo-text', label: '演示文本', icon: IconFileText, category: 'text', ports: [{ id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' }], component: DemoTextNode, inPalette: false });

const SAMPLE_PROJECT = {
  id: 'proj_la_demo',
  title: '樱花回眸',
  aspect_ratio: '9:16',
  style_preset: 'donghua_xianxia',
  characters: [
    { id: 'char_a', name: '阿青', three_views: { front: svgImage('#7C3AED', '#06B6D4', '阿青', 120, 120) } },
    { id: 'char_b', name: '白狐', three_views: { front: svgImage('#F97316', '#EC4899', '白狐', 120, 120) } },
  ],
  scenes: [{
    scene_index: 1,
    shots: [{ id: 'shot_demo_3', shot_index: 3, action_desc: '雨夜回眸', character_ids: ['char_a', 'char_b'], scene_name: '雨夜霓虹街道', prop_prompts: '油纸伞' }],
  }],
};

function buildGraph(params: URLSearchParams): { nodes: Node[]; edges: Edge[] } {
  const v1 = params.get('v1') || '';
  const v2 = params.get('v2') || '';
  const a1 = params.get('a1') || '';
  const wf = params.get('wf') || '';
  const nodes: Node[] = [
    { id: 'demo_v1', type: 'la-demo-video', position: { x: -340, y: 0 }, data: { label: '镜头 1', video_url: v1 } },
    { id: 'demo_v2', type: 'la-demo-video', position: { x: -340, y: 460 }, data: { label: '镜头 2', video_url: v2 } },
    { id: 'demo_a1', type: 'la-demo-audio', position: { x: -340, y: 920 }, data: { label: '配音', audio_url: a1 } },
    { id: 'timeline_1', type: 'timeline', position: { x: 0, y: 40 }, data: { label: '', clips: [] } },
    { id: 'export_1', type: 'export', position: { x: 0, y: 640 }, data: {} },
    { id: 'demo_t1', type: 'la-demo-text', position: { x: 640, y: 760 }, data: { label: '提示词', prompt: 'masterpiece, cherry blossom, rainy night, girl looking back' } },
    {
      id: 'shot_card_1', type: 'shot-card', position: { x: 680, y: 0 },
      data: {
        label: '', shotId: 'shot_demo_3', shot_index: 3, camera_framing: 'close_up', camera_motion: 'dolly_in', provider: 'seedream-4-pro',
        action_desc: '雨夜回眸，发丝被风吹起', image_prompt: 'a girl looking back in the rain, neon street, cinematic',
        subtitle_text: '「你终于来了。」', image_url: svgImage('#0EA5E9', '#7C3AED', '首帧'),
        definition: { input_schema: { properties: {
          first_frame: { type: 'string', format: 'uri', 'x-handle': 'image' },
          ref_audio: { type: 'string', format: 'uri', 'x-handle': 'audio' },
        } } },
      },
    },
    { id: 'comfy_1', type: 'comfy-workflow', position: { x: 1060, y: 0 }, data: { workflow_id: wf, prompt: '' } },
    { id: 'tl_export_1', type: 'timeline-export', position: { x: 1460, y: 0 }, data: {} },
  ];
  const edges: Edge[] = [
    { id: 'e_v1_tl', source: 'demo_v1', sourceHandle: 'video', target: 'timeline_1', targetHandle: 'video' },
    { id: 'e_v2_tl', source: 'demo_v2', sourceHandle: 'video', target: 'timeline_1', targetHandle: 'video' },
    { id: 'e_a1_tl', source: 'demo_a1', sourceHandle: 'audio', target: 'timeline_1', targetHandle: 'audio' },
    { id: 'e_v1_ex', source: 'demo_v1', sourceHandle: 'video', target: 'export_1', targetHandle: 'video' },
    { id: 'e_a1_ex', source: 'demo_a1', sourceHandle: 'audio', target: 'export_1', targetHandle: 'audio' },
    { id: 'e_t1_cf', source: 'demo_t1', sourceHandle: 'prompt', target: 'comfy_1', targetHandle: 'prompt' },
  ];
  return { nodes, edges };
}

function ShowcaseCanvas({ isLight, onLog }: { isLight: boolean; onLog: (line: string) => void }) {
  const initial = useMemo(() => buildGraph(new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')), []);
  const [nodes, , onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const rf = useReactFlow();
  const isValidConnection = useMemo(
    () => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }),
    [rf],
  );
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge(c, es)), [setEdges]);
  // 与选中 / 拖动节点相连的边高亮（宿主职责，演示 .cv-edge-active）
  const active = new Set(nodes.filter((n) => n.selected || n.dragging).map((n) => n.id));
  const viewEdges = edges.map((e) => (active.has(e.source) || active.has(e.target) ? { ...e, className: 'cv-edge-active' } : e));
  // 最小宿主：数据写回走 React Flow（缺省），其余能力只记日志
  const host = useMemo<CanvasHost>(() => ({
    saveToAssets: (id) => onLog(`saveToAssets(${id})`),
    canSaveToAssets: (id) => id === 'shot_card_1' || id === 'comfy_1',
    openFullscreen: ({ nodeId, url, kind }) => onLog(`openFullscreen(${nodeId}, ${kind ?? '-'}, ${url.slice(0, 48)})`),
    projectId: SAMPLE_PROJECT.id,
  }), [onLog]);
  const shotCard = nodes.find((n) => n.id === 'shot_card_1');
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
        defaultViewport={{ x: 300, y: 70, zoom: 0.55 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
        <Controls showInteractive={false} position="top-left" />
      </ReactFlow>
      {shotCard && (
        <div className="cv-scope" style={{ position: 'absolute', left: 12, bottom: 12, width: 300, zIndex: 5 }}>
          <ShotWriteBackControls nodeId="shot_card_1" nodeType="shot-card" data={shotCard.data as Record<string, unknown>} />
        </div>
      )}
    </CanvasHostProvider>
  );
}

/** 开发样例：放进任意有高度的容器即可，如 `<div style={{height: '100vh'}}><LegacyAShowcase /></div>`。 */
export function LegacyAShowcase() {
  const [isLight, setIsLight] = useState(() => typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light');
  const [log, setLog] = useState<string[]>([]);
  const onLog = useCallback((line: string) => setLog((l) => [...l.slice(-7), line]), []);

  // 样例项目（直接写 store，不走 setProject，避免持久化到后端）
  useEffect(() => {
    const prev = useProjectStore.getState().project;
    useProjectStore.setState({ project: SAMPLE_PROJECT as never });
    return () => { useProjectStore.setState({ project: prev }); };
  }, []);

  useEffect(() => {
    const onExport = () => onLog('event: open-export-modal');
    const onInspector = (e: Event) => onLog(`event: open-workflow-inspector ${JSON.stringify((e as CustomEvent).detail)}`);
    window.addEventListener('open-export-modal', onExport);
    window.addEventListener('open-workflow-inspector', onInspector);
    return () => {
      window.removeEventListener('open-export-modal', onExport);
      window.removeEventListener('open-workflow-inspector', onInspector);
    };
  }, [onLog]);

  const toggleTheme = () => {
    const next = !isLight;
    const root = document.documentElement;
    root.setAttribute('data-theme', next ? 'light' : 'dark');
    root.classList.toggle('light', next);
    root.classList.toggle('dark', !next);
    setIsLight(next);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 600, background: 'var(--cv-canvas-bg)' }}>
      <ReactFlowProvider>
        <ShowcaseCanvas isLight={isLight} onLog={onLog} />
      </ReactFlowProvider>
      <div
        className="cv-scope"
        data-testid="la-showcase-log"
        style={{
          position: 'absolute', top: 12, right: 12, zIndex: 5, width: 360, padding: 8, fontSize: 11, lineHeight: 1.5,
          border: '1px solid var(--cv-border-light)', borderRadius: 'var(--cv-radius-lg)', background: 'var(--cv-bg)', color: 'var(--cv-text-2)',
        }}
      >
        <button
          type="button"
          onClick={toggleTheme}
          style={{ marginBottom: 6, padding: '2px 8px', border: '1px solid var(--cv-border)', borderRadius: 'var(--cv-radius)', background: 'var(--cv-fill)', color: 'var(--cv-text-1)', cursor: 'pointer' }}
        >
          切换到{isLight ? '深色' : '浅色'}
        </button>
        {log.length ? log.map((l, i) => <div key={i} style={{ wordBreak: 'break-all' }}>{l}</div>) : <div>（宿主回调 / 全局事件日志）</div>}
      </div>
    </div>
  );
}

export default LegacyAShowcase;
