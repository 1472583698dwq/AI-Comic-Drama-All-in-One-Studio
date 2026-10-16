// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 演示页（仅开发 / 自测用，不接入路由，也不从 index.ts 导出）。
 *
 * 一张小画布放齐 9 个换皮节点：灵感简报 → 剧本拆解；样例视频 / 文本 → 扩展节点（示例插件 upscale_ext）/ 代码节点（upscale_demo）；
 * 5 种生成源节点（列真实生成源、可做连通检测）→ 样例生成节点（展示收到的 provider_id / model）。
 * 「最小宿主」按 H1 应做的方式接线：连线 / 产出变化时用 edgeInputPatch / collectDynamicInputs 把上游值落到声明端口，
 * 生成源用 providerPatchFor 透传；execute 直接调后端 /canvas/node/execute（同 CreativeCanvas 的旧分支）。
 * 后端用 VITE_API_ORIGIN（自测为 8001 隔离实例）。右侧面板显示选中节点的 data，便于核对端口 id 上的值。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconFileText, IconMoon, IconMovie, IconPhoto, IconSparkles, IconSun } from '@tabler/icons-react';
import { NodeSkeleton } from '../../../kit/NodeSkeleton';
import { CanvasHostProvider, type CanvasHost } from '../../../kit/hostContext';
import { defineNode, getNodeDef, nodeTypesMap } from '../../../kit/registry';
import { isValidConnectionFactory } from '../../../kit/connection';
import type { PortDef } from '../../../kit/types';
import { listCanvasNodeSpecs, syncCanvasNodeSpecs, type CanvasNodeSpec } from '../../../canvasNodeSpecs';
import { API_BASE_URL, resolveMediaUrl } from '../../../../../utils/devOrigin';
import '../index';
import { collectDynamicInputs, edgeInputPatch, providerPatchFor } from '../inputs';
import { isDynamicPortNodeType, isProviderNodeType } from '../ports';
import { loadCustomNodeList, registerCustomNodeDef } from '../customNodeDefs';
import { UPSCALE_DEMO_CUSTOM, UPSCALE_EXT_SPEC, svgImage } from './samples';

const DEMO_VIDEO = '/storage/vid_1787819039_8ff7a484.mp4';
const DEMO_IMAGE = svgImage('#0f766e', '#7c3aed', '样例图片');

// —— 演示用上游 / 下游节点（类型带 lb-demo- 前缀，不进工具栏）——
const VIDEO_PORTS: PortDef[] = [{ id: 'video', type: 'source', dataType: 'VIDEO', label: '视频输出' }];
function DemoVideoNode(props: NodeProps) {
  const d = props.data as { video_url?: string };
  return (
    <NodeSkeleton node={props} width={240} downloadUrl={d.video_url}>
      {d.video_url
        ? <video className="nodrag" src={resolveMediaUrl(d.video_url)} controls style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} />
        : <div className="cv-media-empty"><IconMovie size={40} stroke={1.25} /></div>}
    </NodeSkeleton>
  );
}
const IMAGE_PORTS: PortDef[] = [{ id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' }];
function DemoImageNode(props: NodeProps) {
  const d = props.data as { image_url?: string };
  return (
    <NodeSkeleton node={props} width={240} downloadUrl={d.image_url}>
      {d.image_url ? <img src={d.image_url} alt="" draggable={false} style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} /> : null}
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
        aria-label="样例文本"
        style={{ width: '100%', minHeight: 64, resize: 'vertical', border: 0, outline: 'none', background: 'transparent', color: 'var(--cv-text-1)', font: 'inherit', fontSize: 13 }}
        value={d.prompt ?? ''}
        onChange={(e) => rf.updateNodeData(props.id, { prompt: e.target.value })}
      />
    </NodeSkeleton>
  );
}
const GEN_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['IMAGE', 'VIDEO', 'AUDIO', 'STRING'], label: '参考 / 生成源输入' },
  { id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' },
];
function DemoGenNode(props: NodeProps) {
  const d = props.data as { provider_id?: string; model?: string };
  return (
    <NodeSkeleton node={props} onFullscreen={null}>
      <div className="cv-lb">
        <div className="cv-lb-hint">（样例下游）生成源连到 in 后收到：</div>
        <div className="cv-lb-row"><span className="cv-lb-label">provider_id</span><span className="cv-lb-tag cv-lb-mono" data-testid="demo-provider">{d.provider_id || '—'}</span></div>
        <div className="cv-lb-row"><span className="cv-lb-label">model</span><span className="cv-lb-tag cv-lb-mono">{d.model || '—'}</span></div>
      </div>
    </NodeSkeleton>
  );
}
defineNode({ type: 'lb-demo-video', label: '样例视频', icon: IconMovie, category: 'video', ports: VIDEO_PORTS, component: DemoVideoNode, inPalette: false });
defineNode({ type: 'lb-demo-image', label: '样例图片', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: DemoImageNode, inPalette: false });
defineNode({ type: 'lb-demo-text', label: '样例文本', icon: IconFileText, category: 'text', ports: TEXT_PORTS, component: DemoTextNode, inPalette: false });
defineNode({ type: 'lb-demo-gen', label: '样例生成节点', icon: IconSparkles, category: 'image', ports: GEN_PORTS, component: DemoGenNode, inPalette: false });

const at = (x: number, y: number) => ({ x, y });
function initialNodes(extData: Record<string, unknown>): Node[] {
  return [
    { id: 'brief', type: 'brief', position: at(0, 0), data: { brief: '雨夜，少年在城门下拔剑，身后追兵的火把连成一线。他回头看了一眼故乡，转身冲进夜色。', style_preset: 'donghua_xianxia', aspect_ratio: '9:16' } },
    { id: 'split', type: 'script-split', position: at(400, 0), data: {} },
    { id: 'vid', type: 'lb-demo-video', position: at(0, 470), data: { label: '样例视频', video_url: DEMO_VIDEO } },
    { id: 'txt', type: 'lb-demo-text', position: at(0, 900), data: { label: '样例文本', prompt: '放大到 2 倍，保留胶片颗粒' } },
    { id: 'img', type: 'lb-demo-image', position: at(0, 1120), data: { label: '样例图片', image_url: DEMO_IMAGE } },
    { id: 'ext', type: 'ext-node', position: at(400, 470), data: extData },
    { id: 'custom', type: 'custom', position: at(800, 470), data: { custom_node_id: 'upscale_demo', params: { scale: 2 } } },
    { id: 'p-image', type: 'provider-image', position: at(1240, 0), data: { kind: 'image' } },
    { id: 'p-video', type: 'provider-video', position: at(1640, 0), data: { kind: 'video' } },
    { id: 'p-audio', type: 'provider-audio', position: at(2040, 0), data: { kind: 'audio' } },
    { id: 'p-llm', type: 'provider-llm', position: at(2440, 0), data: { kind: 'llm' } },
    { id: 'p-any', type: 'provider', position: at(2840, 0), data: {} },
    { id: 'gen', type: 'lb-demo-gen', position: at(1300, 1300), data: { label: '图片生成（样例）' } },
  ];
}
const INITIAL_EDGES: Edge[] = [
  { id: 'e-brief', source: 'brief', sourceHandle: 'brief', target: 'split', targetHandle: 'brief' },
  { id: 'e-vid-ext', source: 'vid', sourceHandle: 'video', target: 'ext', targetHandle: 'video' },
  { id: 'e-txt-ext', source: 'txt', sourceHandle: 'prompt', target: 'ext', targetHandle: 'prompt' },
  { id: 'e-vid-custom', source: 'vid', sourceHandle: 'video', target: 'custom', targetHandle: 'video' },
  { id: 'e-prov-gen', source: 'p-image', sourceHandle: 'provider', target: 'gen', targetHandle: 'in' },
];

/** 执行：照 CreativeCanvas 旧分支调 /canvas/node/execute，结果按旧口径回写（另把 script-split 的 project 写进 result）。 */
async function executeOnBackend(node: Node, overrides?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const d: Record<string, unknown> = { ...(node.data as Record<string, unknown>), ...(overrides || {}) };
  if (node.type === 'ext-node') delete d.definition;
  const resp = await fetch(`${API_BASE_URL}/canvas/node/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node: { id: node.id, type: node.type, data: d } }),
  }).then((r) => r.json());
  const rr = resp?.result;
  if (rr?.status !== 'success') throw new Error(rr?.error || resp?.detail || '执行失败');
  const patch: Record<string, unknown> = {};
  if (rr.image_url) { patch.image_url = rr.image_url; patch.result_url = rr.image_url; }
  if (rr.video_url) patch.video_url = rr.video_url;
  if (rr.audio_url) patch.audio_url = rr.audio_url;
  if (typeof rr.text === 'string' && rr.text) patch.text = rr.text;
  if (rr.outputs && typeof rr.outputs === 'object') patch.outputs = rr.outputs;
  if (node.type === 'script-split' && rr.project) patch.result = rr.project;
  return patch;
}

function ShowcaseCanvas({ extData, notes, theme }: { extData: Record<string, unknown>; notes: string[]; theme: 'dark' | 'light' }) {
  const [nodes, , onNodesChange] = useNodesState(initialNodes(extData));
  const [edges, setEdges, onEdgesChange] = useEdgesState(INITIAL_EDGES);
  const rf = useReactFlow();
  const nodeTypes = nodeTypesMap();
  const isValidConnection = useMemo(
    () => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges(), allowUnknown: false }),
    [rf],
  );

  // H1 应做的传播：某节点产出 / 选源变化 → 下游动态端口节点重算声明端口上的值；生成源 → 透传 provider_id / model
  const propagateFrom = useCallback((sourceId: string) => {
    const src = rf.getNode(sourceId);
    if (!src) return;
    const all = rf.getEdges();
    for (const e of all.filter((x) => x.source === sourceId)) {
      const tgt = rf.getNode(e.target);
      if (!tgt) continue;
      if (isProviderNodeType(src.type)) {
        const p = providerPatchFor(src);
        if (p) rf.updateNodeData(tgt.id, p);
      } else if (isDynamicPortNodeType(tgt.type)) {
        const p = collectDynamicInputs(tgt, all, (id) => rf.getNode(id));
        if (Object.keys(p).length) rf.updateNodeData(tgt.id, p);
      }
    }
  }, [rf]);

  // 初次加载：把已有连线的值落一遍（H1 加载画布后同理）
  useEffect(() => {
    const t = window.setTimeout(() => { for (const n of rf.getNodes()) propagateFrom(n.id); }, 0);
    return () => window.clearTimeout(t);
  }, [rf, propagateFrom]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge(c, es));
    const src = rf.getNode(c.source);
    const tgt = rf.getNode(c.target);
    const patch = isProviderNodeType(src?.type) ? providerPatchFor(src) : edgeInputPatch(c, src, tgt);
    if (patch && tgt) rf.updateNodeData(tgt.id, patch);
  }, [rf, setEdges]);

  const host = useMemo<CanvasHost>(() => ({
    updateNodeData: (id, patch) => {
      rf.updateNodeData(id, patch);
      window.setTimeout(() => propagateFrom(id), 0);
    },
    execute: async (id, overrides) => {
      const node = rf.getNode(id);
      if (!node) return;
      rf.updateNodeData(id, { agent_state: { status: 'running', updated_at: new Date().toISOString() } });
      try {
        const patch = await executeOnBackend(node, overrides);
        rf.updateNodeData(id, { ...patch, error: undefined, agent_state: { status: 'completed', updated_at: new Date().toISOString() } });
        window.setTimeout(() => propagateFrom(id), 0);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rf.updateNodeData(id, { ...(node.type === 'script-split' ? { error: msg } : {}), agent_state: { status: 'failed', error: msg, updated_at: new Date().toISOString() } });
        throw e;
      }
    },
    openFullscreen: ({ url }) => window.open(resolveMediaUrl(url) || url, '_blank', 'noopener'),
  }), [rf, propagateFrom]);

  const isLight = theme === 'light';
  const selected = nodes.find((n) => n.selected);
  const selectedData = selected ? { ...(selected.data as Record<string, unknown>), definition: (selected.data as Record<string, unknown>).definition ? '(省略)' : undefined } : null;
  return (
    <CanvasHostProvider value={host}>
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <ReactFlow
            className={`cv-canvas ${isLight ? 'light' : 'dark'}`}
            colorMode={isLight ? 'light' : 'dark'}
            nodes={nodes}
            edges={edges}
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
            defaultViewport={{ x: 40, y: 60, zoom: 0.62 }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
          </ReactFlow>
          {notes.length > 0 && (
            <div className="cv-scope cv-card" style={{ position: 'absolute', left: 12, bottom: 12, padding: '6px 10px', fontSize: 12, color: 'var(--cv-text-2)', maxWidth: 520 }}>
              {notes.map((n) => <div key={n}>{n}</div>)}
            </div>
          )}
        </div>
        <aside className="cv-scope" style={{ width: 300, borderLeft: '1px solid var(--cv-border-light)', background: 'var(--cv-bg)', color: 'var(--cv-text-1)', padding: 12, overflow: 'auto', fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>选中节点 data</div>
          <pre data-testid="selected-data" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--cv-text-2)', fontSize: 11 }}>
            {selected ? `${selected.type} · ${selected.id}\n${JSON.stringify(selectedData, null, 2)}` : '（点一个节点）'}
          </pre>
        </aside>
      </div>
    </CanvasHostProvider>
  );
}

/** 演示页：放进任意有高度的容器即可，如 `<div style={{height: '100vh'}}><LegacyBShowcase /></div>`。 */
export function LegacyBShowcase() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'));
  const [ready, setReady] = useState<{ extData: Record<string, unknown>; notes: string[] } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // 扩展节点用真实插件声明（/api/v1/canvas-nodes）；没装示例插件时回落样例声明；代码节点同理
  useEffect(() => {
    let alive = true;
    (async () => {
      const notes: string[] = [];
      let specs: CanvasNodeSpec[] = [];
      try {
        await syncCanvasNodeSpecs();
        specs = listCanvasNodeSpecs();
      } catch (e) {
        notes.push(`读取 /canvas-nodes 失败：${e instanceof Error ? e.message : String(e)}`);
      }
      const real = specs.find((s) => s.id === 'upscale_ext');
      notes.push(real
        ? `扩展节点：使用 /api/v1/canvas-nodes 返回的真实声明（共 ${specs.length} 个：${specs.map((s) => s.id).join('、')}）`
        : `扩展节点：/api/v1/canvas-nodes 里没有 upscale_ext（共 ${specs.length} 个），使用内置样例声明`);
      try {
        const list = await loadCustomNodeList();
        notes.push(`代码节点：/api/v1/custom-nodes 返回 ${list.length} 个`);
        if (!list.some((n) => n.id === 'upscale_demo')) registerCustomNodeDef(UPSCALE_DEMO_CUSTOM);
      } catch {
        registerCustomNodeDef(UPSCALE_DEMO_CUSTOM);
        notes.push('代码节点：/api/v1/custom-nodes 不可用（功能开关关闭），端口用样例定义');
      }
      if (alive) setReady({ extData: real ? { canvas_node_id: 'upscale_ext' } : { canvas_node_id: 'upscale_ext', definition: UPSCALE_EXT_SPEC }, notes });
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 600, background: 'var(--cv-canvas-bg)' }}>
      <div className="cv-scope" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--cv-border-light)', background: 'var(--cv-bg)', color: 'var(--cv-text-1)', fontSize: 13 }}>
        <strong>N7 独有节点换皮 B · 演示</strong>
        <span style={{ color: 'var(--cv-text-3)' }}>brief · script-split · custom · ext-node · provider ×5</span>
        <button
          type="button"
          className="cv-btn"
          style={{ marginLeft: 'auto' }}
          aria-label="切换深浅色"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? <IconSun size={16} aria-hidden /> : <IconMoon size={16} aria-hidden />}
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <ReactFlowProvider>
            <ShowcaseCanvas theme={theme} extData={ready.extData} notes={ready.notes} />
          </ReactFlowProvider>
        ) : (
          <div className="cv-scope" style={{ padding: 24, color: 'var(--cv-text-2)' }}>读取插件声明…</div>
        )}
      </div>
    </div>
  );
}

export default LegacyBShowcase;
