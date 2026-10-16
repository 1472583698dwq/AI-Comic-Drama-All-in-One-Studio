// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N2 自测样例（仅开发 / 评审用，不接路由、不从 nodes2/image/index.ts 导出）。
 * 一张小画布：文本（样例）+ 两张图片 → 「图片生成」；外加一个空图片节点用于上传。
 * 宿主只实现最小能力：createNodes 走 kit 缺省（createNodesLocal）、全屏用页内查看层、保存到素材库真打 POST /assets。
 * URL 参数：?project=<项目 id>（角色一致性读该项目角色，缺省 proj_55f08230；另附一个用本地素材图拼的样例角色）、?theme=light|dark。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, ConnectionLineType, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { IconFileText } from '@tabler/icons-react';
import { CanvasHostProvider, createNodesLocal, type CanvasHost } from '../../../kit/hostContext';
import { NodeSkeleton } from '../../../kit/NodeSkeleton';
import { SelectionToolbar } from '../../../kit/SelectionToolbar';
import { defineNode, getNodeDef, nodeTypesMap } from '../../../kit/registry';
import { isValidConnectionFactory } from '../../../kit/connection';
import type { PortDef } from '../../../kit/types';
import { apiService } from '../../../../../services/api';
import { resolveMediaUrl } from '../../../../../utils/devOrigin';
import { useProjectStore } from '../../../../../stores/useProjectStore';
import { toast } from '../../../../../stores/useDialogStore';
import { imageUrlOf } from '../media';
import '../index';

// —— 样例文本节点（输出口 id 为 `prompt`，COORDINATION.md 第 1 条）——
const TEXT_PORTS: PortDef[] = [{ id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' }];
function DemoTextNode(props: NodeProps) {
  const d = props.data as { prompt?: string };
  const rf = useReactFlow();
  return (
    <NodeSkeleton node={props} onFullscreen={null}>
      <textarea
        className="nodrag nopan nowheel"
        aria-label="样例文本"
        style={{ width: '100%', minHeight: 84, resize: 'vertical', border: 0, outline: 'none', background: 'transparent', color: 'var(--cv-text-1)', font: 'inherit', fontSize: 13 }}
        value={d.prompt ?? ''}
        placeholder="写点什么…"
        onChange={(e) => rf.updateNodeData(props.id, { prompt: e.target.value })}
      />
    </NodeSkeleton>
  );
}
defineNode({ type: 'n2-demo-text', label: '文本（样例）', icon: IconFileText, category: 'text', ports: TEXT_PORTS, component: DemoTextNode, inPalette: false });

/** 竖图（落日街景 832×1216）与横图（角色四视图设定 1344×768），都是 worktree storage 里现成的素材。 */
const PORTRAIT = '/storage/assets/ast_74a584c1/original.png';
const SCENE = '/storage/assets/ast_010f9996/original.png';
/** 样例角色：三视图用 worktree 里现成的素材图（真实项目角色的图可能不在本地 storage）。 */
const DEMO_CHARACTER = {
  id: 'n2-demo-char',
  name: '样例角色',
  three_views: {
    front: '/storage/assets/ast_74a584c1/original.png',
    three_quarter: '/storage/assets/ast_0dd14584/original.png',
    side: '/storage/assets/ast_c307696d/original.png',
  },
};

const initialNodes: Node[] = [
  { id: 'txt', type: 'n2-demo-text', position: { x: 0, y: 0 }, data: { label: '剧情', prompt: '雨夜，主角撑伞走过霓虹街道，回眸一笑。电影感，胶片颗粒。' } },
  { id: 'img1', type: 'load-image', position: { x: 0, y: 220 }, data: { label: '落日街景', image_url: PORTRAIT, image: PORTRAIT, url: PORTRAIT } },
  { id: 'img2', type: 'load-image', position: { x: 0, y: 560 }, data: { label: '角色设定', image_url: SCENE, image: SCENE, url: SCENE } },
  { id: 'empty', type: 'load-image', position: { x: -440, y: 560 }, data: { label: '上传图片' } },
  {
    id: 'gen',
    type: 'image',
    position: { x: 560, y: 220 },
    data: { label: '图片生成', prompt: '{{ref 3}} 里的角色站在 {{ref 2}} 的街道上，按 {{ref 1}} 的剧情表演', refOrder: [], refRoles: {}, smart_plan: false },
  },
];
const initialEdges: Edge[] = [
  { id: 'e1', source: 'txt', sourceHandle: 'prompt', target: 'gen', targetHandle: 'in' },
  { id: 'e2', source: 'img1', sourceHandle: 'image', target: 'gen', targetHandle: 'in' },
  { id: 'e3', source: 'img2', sourceHandle: 'image', target: 'gen', targetHandle: 'in' },
];

declare global {
  interface Window {
    __n2?: { getNodes: () => Node[]; getEdges: () => Edge[]; createdAssets: string[]; setTheme: (t: 'light' | 'dark') => void };
  }
}

function applyTheme(t: 'light' | 'dark') {
  const root = document.documentElement;
  root.setAttribute('data-theme', t);
  root.classList.toggle('light', t === 'light');
  root.classList.toggle('dark', t === 'dark');
}

function ShowcaseCanvas({ theme, projectId }: { theme: 'light' | 'dark'; projectId: string }) {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const rf = useReactFlow();
  const [viewer, setViewer] = useState<string | null>(null);
  const [createdAssets] = useState<string[]>(() => []);
  const isValidConnection = useMemo(() => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }), [rf]);
  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge(c, es)), [setEdges]);
  const active = new Set(nodes.filter((n) => n.selected || n.dragging).map((n) => n.id));
  const viewEdges = edges.map((e) => (active.has(e.source) || active.has(e.target) ? { ...e, className: 'cv-edge-active' } : e));

  useEffect(() => {
    window.__n2 = { getNodes: () => rf.getNodes(), getEdges: () => rf.getEdges(), createdAssets, setTheme: applyTheme };
  }, [rf, createdAssets]);

  const host = useMemo<CanvasHost>(() => ({
    projectId,
    createNodes: (specs, opts) => createNodesLocal(rf, specs, opts),
    openFullscreen: ({ url }) => setViewer(url),
    canSaveToAssets: (id) => !!imageUrlOf(rf.getNode(id)?.type ?? '', rf.getNode(id)?.data as Record<string, unknown>),
    saveToAssets: async (id) => {
      const n = rf.getNode(id);
      const url = imageUrlOf(n?.type ?? '', n?.data as Record<string, unknown>);
      if (!url) return;
      const fd = new FormData();
      fd.append('name', String((n?.data as { label?: string })?.label || '画布图片'));
      fd.append('category', 'other');
      fd.append('file_url', url);
      fd.append('project_id', projectId);
      const res: any = await apiService.createAsset(fd);
      if (res?.id) createdAssets.push(String(res.id));
      toast.success(`已保存到素材库：${res?.id ?? ''}`);
    },
  }), [rf, projectId, createdAssets]);

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
        defaultViewport={{ x: 380, y: 140, zoom: 0.8 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
        <SelectionToolbar />
      </ReactFlow>
      {viewer && (
        <div
          role="dialog"
          aria-label="全屏预览"
          data-testid="n2-viewer"
          onClick={() => setViewer(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--cv-canvas-bg) 88%, transparent)', cursor: 'zoom-out' }}
        >
          <img src={viewer} alt="全屏预览" style={{ maxWidth: '92vw', maxHeight: '92vh', objectFit: 'contain' }} />
        </div>
      )}
    </CanvasHostProvider>
  );
}

/** 开发样例：放进任意有高度的容器，或直接整页挂载。 */
export function ImageShowcase() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const projectId = params.get('project') || 'proj_55f08230';
  const [theme, setTheme] = useState<'light' | 'dark'>(params.get('theme') === 'light' ? 'light' : 'dark');
  useEffect(() => { applyTheme(theme); }, [theme]);
  // 只把项目角色塞进 store（不调 setProject，避免触发项目自动保存）
  useEffect(() => {
    const put = (chars: unknown[]) => useProjectStore.setState({ project: { id: projectId, characters: [DEMO_CHARACTER, ...chars] } as any });
    put([]);
    apiService.getProject(projectId).then((p: any) => {
      const content = p?.content ?? p?.project ?? p;
      put(Array.isArray(content?.characters) ? content.characters : []);
    }).catch(() => {});
  }, [projectId]);
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--cv-canvas-bg)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--cv-border-light)', color: 'var(--cv-text-2)', fontSize: 12 }}>
        <strong style={{ color: 'var(--cv-text-1)' }}>N2 图片节点样例</strong>
        <span>项目 {projectId}</span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="cv-btn cv-btn--sm" data-testid="theme-dark" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>深色</button>
        <button type="button" className="cv-btn cv-btn--sm" data-testid="theme-light" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>浅色</button>
        <a className="cv-btn cv-btn--sm" href={resolveMediaUrl(PORTRAIT)} target="_blank" rel="noreferrer">样例图</a>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlowProvider>
          <ShowcaseCanvas theme={theme} projectId={projectId} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

export default ImageShowcase;
