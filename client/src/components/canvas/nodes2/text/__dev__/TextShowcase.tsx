// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点开发样例（仅开发 / 评审用，不接路由，也不从 nodes2/text/index.ts 导出）。
 * 一张小画布：故事文本 + 定妆图 → 「分镜脚本」文本节点（预览 / 编辑、参考列表、{{ref N}} 提示词、技能下拉、工具栏）→ 下游消费节点；
 * 宿主是假的：execute 按 skill_id 模拟各技能（约 1.2 秒后整段替换正文；提示词含「失败」时模拟报错），右上角显示最近一次 overrides。
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, Panel, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconArrowRight, IconMoon, IconPhoto, IconSun } from '@tabler/icons-react';
import {
  CanvasHostProvider, NodeSkeleton, defineNode, getNodeDef, isValidConnectionFactory, nodeTypesMap, useNodeReferences,
  type CanvasHost, type PortDef,
} from '../../../kit';
import { documentPatch, type TextExecuteOverrides } from '../skills';
import '../index';

const svgImage = (from: string, to: string, text: string) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="160" y="98" font-size="22" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${text}</text></svg>`,
)}`;

// —— 演示用上游图片 / 下游消费节点（类型带 n1-demo- 前缀，不进工具栏）——
const IMAGE_PORTS: PortDef[] = [{ id: 'image', type: 'source', dataType: 'IMAGE', label: '图片输出' }];
function DemoImageNode(props: NodeProps) {
  const d = props.data as { image_url?: string };
  return (
    <NodeSkeleton node={props} width={278} downloadUrl={d.image_url} downloadName="demo.svg">
      {d.image_url
        ? <img src={d.image_url} alt="" style={{ display: 'block', width: '100%', borderRadius: 'var(--cv-radius)' }} draggable={false} />
        : <div className="cv-media-empty"><IconPhoto size={48} stroke={1.25} /></div>}
    </NodeSkeleton>
  );
}

const CONSUMER_PORTS: PortDef[] = [{ id: 'in', type: 'target', dataType: ['STRING'], label: '文本输入' }];
function DemoConsumerNode(props: NodeProps) {
  const { refs } = useNodeReferences(props.id, { handleId: 'in' });
  const value = refs[0]?.value ?? '';
  return (
    <NodeSkeleton node={props} showToolbar={false}>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--cv-text-2)' }}>
        <div style={{ color: 'var(--cv-text-3)', marginBottom: 4 }}>下游读到的文本（端口 prompt → data.prompt）</div>
        <div className="nowheel" style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', color: 'var(--cv-text-1)' }}>{value || '（空）'}</div>
      </div>
    </NodeSkeleton>
  );
}

defineNode({ type: 'n1-demo-image', label: '图片（样例）', icon: IconPhoto, category: 'image', ports: IMAGE_PORTS, component: DemoImageNode, inPalette: false });
defineNode({ type: 'n1-demo-consumer', label: '下游（样例）', icon: IconArrowRight, category: 'tool', ports: CONSUMER_PORTS, component: DemoConsumerNode, inPalette: false, width: 260 });

const STORY = '雨夜，林夕撑着透明伞走过霓虹街道。\n路口的全息广告闪烁，她回头望向巷口——那个跟踪她三天的人终于现身。';
const SCRIPT_DOC = [
  '## 第一场 · 雨夜街头',
  '',
  '- **镜头 1**：[远景] 霓虹街道，雨丝斜落',
  '- **镜头 2**：[中景] 林夕撑伞前行，3~5 秒',
  '- **镜头 3**：[特写] 回眸，眼神警惕',
  '',
  '> 旁白：这座城市从不睡眠。',
  '',
  '| 角色 | 台词 |',
  '| --- | --- |',
  '| 林夕 | 谁在那里？ |',
  '',
  '```',
  'camera: push_in, speed 1.0x',
  '```',
].join('\n');
const PROMPT_DOC = 'cinematic still, 1girl_solo, [中景], neon rain street, <lora:cyberpunk:0.8>, 3~5 秒推镜, a & b';

const initialNodes: Node[] = [
  { id: 'story', type: 'prompt', position: { x: 0, y: 0 }, data: { label: '故事梗概', prompt: STORY, text: STORY } },
  { id: 'img', type: 'n1-demo-image', position: { x: -40, y: 300 }, data: { label: '定妆照', image_url: svgImage('#7C3AED', '#06B6D4', '林夕 · 定妆') } },
  {
    id: 'main', type: 'prompt', position: { x: 400, y: 120 }, selected: true,
    data: { label: '分镜脚本', prompt: SCRIPT_DOC, text: SCRIPT_DOC, gen_prompt: '把 {{ref 1}} 拆成 3 个镜头，画面风格参考 {{ref 2}}', skill_id: 'script_generation' },
  },
  { id: 'out', type: 'n1-demo-consumer', position: { x: 912, y: 112 }, data: { label: '视频生成（下游样例）' } },
  { id: 'raw', type: 'prompt', position: { x: 912, y: 400 }, data: { label: '提示词（原样保留）', prompt: PROMPT_DOC, text: PROMPT_DOC } },
  { id: 'empty', type: 'prompt', position: { x: 1200, y: 400 }, data: { label: '空文本', text: '', prompt: '' } },
];
const initialEdges: Edge[] = [
  { id: 'e1', source: 'story', sourceHandle: 'prompt', target: 'main', targetHandle: 'in' },
  { id: 'e2', source: 'img', sourceHandle: 'image', target: 'main', targetHandle: 'in' },
  { id: 'e3', source: 'main', sourceHandle: 'prompt', target: 'out', targetHandle: 'in' },
];

/** 假宿主的技能结果（真实环境由 H1 路由到 parseScript / split_novel_script / llm/expand / LLM）。 */
function fakeResult(o: TextExecuteOverrides): string {
  const src = o.prompt.split('\n')[0].slice(0, 40);
  if (o.skill_id === 'script_generation') {
    return ['## 分镜（模拟剧本拆解）', '', '【场景 1】', '镜头 1: [远景] 雨夜霓虹街道', '台词: （无对白）', '', '镜头 2: [中景] 林夕撑伞回眸', '台词: 谁在那里？', '', `> 输入：${src}…`].join('\n');
  }
  if (o.skill_id === 'prompt_expansion') return `cinematic wide shot, ${src}, volumetric neon light, rain reflections, 35mm film grain, shallow depth of field`;
  if (o.skill_id === 'proposal_generation') return ['# 策划案（模拟）', '', '## 世界观', '赛博都市，永夜不眠。', '', '## 主角', '- 林夕：失忆的赏金猎人', '', '## 前三集爆点', '1. 雨夜被跟踪', '2. 记忆芯片', '3. 真相反转'].join('\n');
  return `**自由生成（模拟）**\n\n${o.prompt}`;
}

function ShowcaseCanvas({ isLight, onToggleTheme }: { isLight: boolean; onToggleTheme: () => void }) {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const rf = useReactFlow();
  const [lastCall, setLastCall] = useState<TextExecuteOverrides | null>(null);
  const [toast, setToast] = useState('');
  const isValidConnection = useMemo(() => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }), [rf]);
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge(c, es)), [setEdges]);
  const active = new Set(nodes.filter((n) => n.selected || n.dragging).map((n) => n.id));
  const viewEdges = edges.map((e) => (active.has(e.source) || active.has(e.target) ? { ...e, className: 'cv-edge-active' } : e));

  const host = useMemo<CanvasHost>(() => ({
    execute: async (nodeId, overrides) => {
      const o = overrides as TextExecuteOverrides;
      setLastCall(o);
      await new Promise((r) => setTimeout(r, 1200));
      if (o.prompt.includes('失败')) throw new Error('模拟失败：LLM 超时（提示词里含「失败」）');
      rf.updateNodeData(nodeId, { ...documentPatch(fakeResult(o)), agent_state: { status: 'completed', tool: `text/${o.skill_id}`, updated_at: new Date().toISOString() } });
    },
    saveToAssets: (id) => { setToast(`已保存到素材库：${id}`); window.setTimeout(() => setToast(''), 1600); },
    openFullscreen: ({ url }) => window.open(url, '_blank', 'noopener'),
  }), [rf]);

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
        defaultViewport={{ x: 140, y: 240, zoom: 0.85 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
        <Panel position="top-right">
          <div className="cv-card" style={{ width: 300, padding: 10, fontSize: 12, color: 'var(--cv-text-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ color: 'var(--cv-text-1)' }}>N1 文本节点样例</span>
              <button type="button" className="cv-btn cv-btn--sm" onClick={onToggleTheme} aria-label="切换深浅色">
                {isLight ? <IconMoon size={16} /> : <IconSun size={16} />}{isLight ? '深色' : '浅色'}
              </button>
            </div>
            <div style={{ color: 'var(--cv-text-3)', marginBottom: 4 }}>最近一次 execute(overrides)：</div>
            <pre className="nowheel" style={{ margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 10, lineHeight: 1.4, color: 'var(--cv-text-1)' }}>
              {lastCall ? JSON.stringify({ ...lastCall, refs: lastCall.refs.map((r) => `${r.n}:${r.type}:${r.value.slice(0, 18)}`) }, null, 1) : '（还没发送）'}
            </pre>
            {toast && <div role="status" style={{ marginTop: 6, color: 'var(--cv-primary)' }}>{toast}</div>}
          </div>
        </Panel>
      </ReactFlow>
    </CanvasHostProvider>
  );
}

/** 开发样例：放进任意有高度的容器，如 `<div style={{height: '100vh'}}><TextShowcase /></div>`。 */
export function TextShowcase() {
  const [isLight, setIsLight] = useState(() => typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light');
  const toggle = () => {
    const next = !isLight;
    document.documentElement.setAttribute('data-theme', next ? 'light' : 'dark');
    setIsLight(next);
  };
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 600 }}>
      <ReactFlowProvider>
        <ShowcaseCanvas isLight={isLight} onToggleTheme={toggle} />
      </ReactFlowProvider>
    </div>
  );
}

export default TextShowcase;
