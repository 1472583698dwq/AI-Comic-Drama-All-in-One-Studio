import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, ConnectionLineType, Controls, ControlButton, PanOnScrollMode,
  useNodesState, useEdgesState, addEdge, ReactFlowProvider, useReactFlow,
  type Connection, type DefaultEdgeOptions, type Edge, type Node, type FinalConnectionState, type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Sparkles, Image as ImageIcon, Boxes, Library, Save, Download, Plus, Wand2, Layers, PanelLeft, ChevronsUp, ArrowLeftRight, MoreHorizontal, Pencil, Trash2, Keyboard, X, FolderOpen } from 'lucide-react';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { useProjectStore, selectSidebarCollapsed } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { useFeatureStore } from '../../stores/useFeatureStore';
import { apiService } from '../../services/api';
import { backupCanvas } from '../../services/mediaOps';
import { resolveMediaUrl } from '../../utils/devOrigin';
import { confirmAsync, promptAsync, toast } from '../../stores/useDialogStore';
import { useCanvasSync } from './hooks/useCanvasSync';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';
import { WorkbenchRow } from './WorkbenchRow';
import { UISlot } from '../../ui-registry/UISlot';
import { CanvasPaletteBridgeContext, type PaletteNodeType } from '../../ui-registry/canvasPaletteBridge';
import { syncCanvasPaletteEntries, clearCanvasPaletteEntries } from '../../ui-registry/adapters/canvasPalette';
import { useUIEntries } from '../../ui-registry/resolveEnabled';
import { CANVAS_PALETTE_HOST } from '../../ui-registry/types';
import { syncCanvasNodeSpecs, listCanvasNodeSpecs, getCanvasNodeSpec } from './canvasNodeSpecs';
import { rectOf, estimateSize, placeNear, placeBlock } from './autoLayout';
import { CanvasAgentSidebar } from './CanvasAgentSidebar';
import { CanvasManagerModal } from './CanvasManagerModal';
import { extractSlotsFromProvider, type DynamicProviderInfo } from './providerSkills';
import { writeBackToShot } from './shotWriteBack';
import { useCanvasShortcuts } from './hooks/useCanvasShortcuts';
// REQ-toonflow-canvas H1：新节点框架（kit）+ 全部新节点注册（nodes2/index.ts）
import './nodes2';
import {
  CanvasHostProvider, SelectionToolbar, defsAcceptingFrom, defsProvidingTo, findCompatiblePort, getNodeDef, isValidConnectionFactory,
  paletteDefs, registryVersion, subscribeRegistry, reparentOnDrop, arrangeNodes, selectionRoots, loadProviderDefinition,
  type AnyNodeDef, type PortDef,
} from './kit';
import { findPort } from './kit/connection';
import { resolveDynamicPorts } from './nodes2/legacy-b/ports';
import { registerCustomNodeDefs } from './nodes2/legacy-b/customNodeDefs';
import { prepareLoadedCanvas, buildSaveSnapshot, createBackupGate, resolveOverlaps } from './host/canvasLoad';
import { measuredSizeKey, useSettledRun } from './host/settleLayout';
import { applyPatches, downstreamPatches } from './host/propagation';
import { newNodeData } from './host/createNodes';
import { TEMPLATES, buildTemplate, buildCreatorTemplate, linkNodes, type CanvasTemplate } from './host/templates';
import { buildShotSubgraph } from './host/shotSubgraph';
import { autoRunShotSubgraph } from './host/shotAutoRun';
import { useCanvasHostController } from './host/useCanvasHost';
import { useCanvasNodeTypes } from './host/nodeTypes';
import { AutoHideMiniMap } from './host/AutoHideMiniMap';
import {
  EdgeDisconnectButton, FullscreenViewer, NodeAddMenu, ShotWriteBackDialog, useRenderedEdges,
  type EdgeDisconnectState, type NodeMenuItem, type NodeMenuState,
} from './host/canvasChrome';

let idSeq = 0;
const genId = (p: string) => `${p}_${Date.now()}_${++idSeq}`;

/** 注册表分类 → 工作台图标色（沿用旧画布的配色语义） */
const CATEGORY_COLOR: Record<string, string> = {
  text: 'text-sky-400', image: 'text-violet-400', video: 'text-orange-400', audio: 'text-pink-400',
  '3d': 'text-amber-500', output: 'text-emerald-500', tool: 'text-brand', plugin: 'text-teal-400',
};

/** 工作台分块：悬浮条上的小块，点块即展开面板并定位到该小节 */
type WorkbenchSection = 'template' | 'mine' | 'nodes' | 'assets';

const WORKBENCH_TABS: Array<{ id: WorkbenchSection; label: string; icon: any }> = [
  { id: 'template', label: '模板', icon: Wand2 },
  { id: 'mine', label: '我的', icon: Sparkles },
  { id: 'nodes', label: '节点', icon: Boxes },
  { id: 'assets', label: '素材', icon: Library },
];

/** 顶部工具条「更多」菜单项样式（精简态使用） */
const TOOLBAR_MENU_ITEM =
  'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[11.5px] ' +
  '[color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-surface/80 transition-colors';

/** 操作台小节标题 */
const WorkbenchGroupTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-3 pt-3 pb-1 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wider [color:var(--color-text-muted)]">
    {children}
  </div>
);

/** 模块常量：传给 ReactFlow 的对象 / 数组每次渲染都新建的话，React Flow 每次都要同步进 store（FX-2）。 */
const DEFAULT_EDGE_OPTIONS: DefaultEdgeOptions = { type: 'simplebezier' };
const SNAP_GRID: [number, number] = [16, 16];

const MEDIA_LOADER: Record<'image' | 'video' | 'audio', string> = { image: 'load-image', video: 'load-video', audio: 'load-audio' };
const isVideoUrl = (u: string) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(u);
const isAudioUrl = (u: string) => /\.(mp3|wav|ogg|m4a|flac|aac)(\?|#|$)/i.test(u);
const mediaKindOfUrl = (u: string): 'image' | 'video' | 'audio' => (isVideoUrl(u) ? 'video' : isAudioUrl(u) ? 'audio' : 'image');
const loaderData = (kind: 'image' | 'video' | 'audio', url: string, extra: Record<string, unknown> = {}) => (
  kind === 'image' ? { image_url: url, image: url, url, ...extra }
    : kind === 'video' ? { video_url: url, video: url, url, ...extra }
      : { audio_url: url, audio: url, url, ...extra }
);
/** 素材库地址：本机后端回源的绝对地址还原成 /storage/...（节点 / 后端都按相对地址存，N2/N3） */
const storedUrl = (u: string) => {
  const m = /^https?:\/\/[^/]+(\/(?:storage|exports)\/.*)$/i.exec(u || '');
  return m ? m[1] : u;
};

/** 文本投放到节点上时写哪几个键（N1–N5 各节点自身文本键）；返回 null = 该节点不收文本 */
function textPatchFor(type: string | undefined, txt: string): Record<string, unknown> | null {
  switch (type) {
    case 'prompt': return { prompt: txt, text: txt };
    case 'image': return { prompt: txt };
    case 'video': return { prompt: txt, text: txt };
    case 'audio': return { text: txt, prompt: txt };
    case 'director3d': return { ai_directive: txt };
    case 'brief': return { brief: txt };
    case 'comfy-workflow': return { prompt: txt };
    case 'shot-card': return { image_prompt: txt };
    default: return null;
  }
}

const InnerCanvas: React.FC = () => {
  const { project, toggleSidebar } = useProjectStore();
  const sidebarCollapsed = useProjectStore(selectSidebarCollapsed);
  const { activeProjectId } = useProjectListStore();
  const { effectiveTheme } = useThemeStore();
  const setSelectedNodeId = useCanvasStore((s) => s.setSelectedNodeId);
  // 以已加载的项目为准：切项目时 list store 会先于内容加载变更，若先取它，旧画布实例会在
  // 重建前短暂挂到新 pid 上，把旧节点写进新项目。两个 store 在 setProject 里同步。
  const pid = project?.id || activeProjectId || null;
  const isLight = effectiveTheme === 'light';

  // REQ-toonflow-canvas H1：迁移过的旧画布第一次保存前先备份原 JSON（每张画布每次会话最多一次，design §7）
  const backupGate = useMemo(() => createBackupGate(backupCanvas), []);
  const waitBackup = useCallback((cid?: string) => backupGate.wait(pid, cid), [backupGate, pid]);
  const { loadCanvas, debouncedSave } = useCanvasSync(pid, { beforeSave: waitBackup });
  /** 显式保存（手动保存 / 切画布 / 分镜子图）也要等备份 */
  const persistCanvas = useCallback(async (snapshot: Record<string, unknown>, cid: string, name?: string) => {
    if (!pid) return;
    await waitBackup(cid);
    return apiService.saveProjectCanvas(pid, snapshot, cid, name);
  }, [pid, waitBackup]);

  const rf = useReactFlow();
  const { screenToFlowPosition, getViewport, fitView } = rf;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // 最新 nodes / edges：渲染期同步，宿主能力（execute / createNodes / 传播）读它
  const nodesRef = useRef<Node[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const controller = useCanvasHostController({ pid, nodesRef, edgesRef, setNodes, setEdges, setSelectedNodeId });
  const { host, execute, removeNodes, viewer, setViewer, writeBack, setWriteBack } = controller;

  const [assets, setAssets] = useState<any[]>([]);
  /**
   * 页内能力闸（功能开关，设计 §2.3.2 的页内候选拆分）：
   * `canvas_custom_nodes` = 自定义代码节点（沙箱执行，安全敏感）。关掉后画布不给入口，
   * 后端 `/api/v1/custom-nodes` 整族同时 404（同一开关，不做「后端还能跑但不显示」的假闸）。
   * 读法与 `useFeatureStore` 的既定口径一致：未加载 / 拉取失败一律**当作关**（fail-closed）。
   */
  const customNodesOn = useFeatureStore((s) => s.loaded && s.values['canvas_custom_nodes'] === true);

  const [customNodes, setCustomNodes] = useState<any[]>([]);
  const refreshCustomNodes = async () => {
    if (!customNodesOn) { setCustomNodes([]); return; }  // 关掉就不拉：没人看的列表不占请求
    try {
      const r: any = await apiService.listCustomNodes();
      const list = r.nodes || [];
      setCustomNodes(list);
      // N7：custom 节点的 getPorts 同步读这份缓存（input_schema 决定端口）
      try { registerCustomNodeDefs(list); } catch { /* ignore */ }
    } catch { /* ignore */ }
  };
  useEffect(() => { refreshCustomNodes(); }, [customNodesOn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = () => refreshCustomNodes();
    window.addEventListener('customnode-list-refresh', h as any);
    return () => window.removeEventListener('customnode-list-refresh', h as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customNodesOn]);
  // 声明式扩展节点（canvas_nodes）：插件前端扩展点，spec 驱动通用渲染
  const [extNodes, setExtNodes] = useState<any[]>([]);
  const refreshExtNodes = async () => {
    try {
      await syncCanvasNodeSpecs(pid || undefined);
      setExtNodes(listCanvasNodeSpecs());
    } catch { /* ignore */ }
  };
  useEffect(() => {
    refreshExtNodes();
    const h = () => refreshExtNodes();
    window.addEventListener('canvasnode-list-refresh', h as any);
    return () => window.removeEventListener('canvasnode-list-refresh', h as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  const [saving, setSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // 多画布：隶属画布切换（默认 default；分镜右键可新建/隶属）
  const [canvasId, setCanvasId] = useState<string>('default');
  const activeEpisodeId = useProjectStore((s) => s.activeEpisodeId);
  useEffect(() => {
    const scoped = activeEpisodeId && activeEpisodeId !== 'none' && activeEpisodeId !== 'all' ? `ep_${activeEpisodeId}` : 'default';
    setCanvasId(scoped);
  }, [activeEpisodeId]);
  const [canvasList, setCanvasList] = useState<Array<{ id: string; name: string; updated_at: string; node_count: number }>>([]);
  const [showManager, setShowManager] = useState(false);
  // 左侧工作台：悬浮条 + 下拉面板（不再占用画布宽度）
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchSection, setWorkbenchSection] = useState<WorkbenchSection>('template');
  const workbenchRef = useRef<HTMLDivElement>(null);
  const workbenchSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    if (!workbenchOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setWorkbenchOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && !workbenchRef.current?.contains(t)) setWorkbenchOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [workbenchOpen]);
  useEffect(() => {
    if (!workbenchOpen) return;
    const el = workbenchSectionRefs.current[workbenchSection];
    if (!el) return;
    const t = window.setTimeout(() => el.scrollIntoView({ block: 'start' }), 20);
    return () => window.clearTimeout(t);
  }, [workbenchOpen, workbenchSection]);
  // 画布顶部工具条：按自身可用宽度切「完整 / 精简」两态（低频动作在精简态收入「更多」）
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarMenuRef = useRef<HTMLDivElement>(null);
  const [toolbarLevel, setToolbarLevel] = useState<'compact' | 'normal' | 'wide'>('normal');
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.clientWidth;
      setToolbarLevel(w >= 1280 ? 'wide' : w >= 1000 ? 'normal' : 'compact');
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pid]);
  useEffect(() => {
    if (!toolbarMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setToolbarMenuOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && !toolbarMenuRef.current?.contains(t)) setToolbarMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [toolbarMenuOpen]);
  // REQ-toonflow-canvas H1：添加节点菜单（拖线到空白 / 画布右键 / 双击空白）与连线「断开」按钮
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [edgeDisconnect, setEdgeDisconnect] = useState<EdgeDisconnectState | null>(null);
  const canvasIdRef = useRef<string>('default');
  useEffect(() => { canvasIdRef.current = canvasId; }, [canvasId]);
  // 切换/新建/删除清空时的单次保存抑制，避免空画布写回旧 id 复活已删画布
  const suppressSaveRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  // 当前 pid/画布的内容是否已真正载入：载入完成前 nodes 还是空数组/旧画布，此时绝不能落盘
  const hydratedRef = useRef(false);
  const pidRef = useRef<string | null>(null);
  const canvasRef = useRef<string>('default');
  const [isDragging, setIsDragging] = useState(false);

  /**
   * REQ-toonflow-canvas H1：载入画布 = migrateCanvas（旧类型 / 具名口 → 新模型）+ 父子顺序 + 运行态复位（视频保留轮询）
   * + 动态端口 / 生成源重算；迁移改动了内容就立刻开始备份原 JSON，保存前等备份完成。
   */
  const hydrateCanvas = useCallback((raw: any, cid: string) => {
    const prepared = prepareLoadedCanvas(raw);
    if (prepared.changed && pid && backupGate.ensure(pid, cid, raw)) {
      const { converted, rewiredEdges, unknownTypes } = prepared.report;
      console.info('[Canvas] 旧画布已迁移，先备份原 JSON', { canvas: cid, converted, rewiredEdges, unknownTypes });
    }
    return prepared;
  }, [pid, backupGate]);

  // 加载画布（项目/画布切换时重载）
  useEffect(() => {
    if (!pid) { setIsLoading(false); return; }
    if (pidRef.current !== pid || canvasRef.current !== canvasId) {
      pidRef.current = pid;
      canvasRef.current = canvasId;
      loadedRef.current = false;
      hydratedRef.current = false;
      setIsLoading(true);
      apiService.listProjectCanvases(pid).then(r => setCanvasList(r.canvases || [])).catch(() => {});
    }
    if (loadedRef.current) { setIsLoading(false); return; }
    loadedRef.current = true;
    setIsLoading(true);
    const timer = setTimeout(() => setIsLoading(false), 3000);
    const reqPid = pid, reqCanvas = canvasId;
    loadCanvas(canvasId).then(snap => {
      // 已切到别的项目/画布：过期结果丢弃，不能覆盖当前画布
      if (pidRef.current !== reqPid || canvasRef.current !== reqCanvas) return;
      hydratedRef.current = true;
      suppressSaveRef.current = false;
      if (snap && Array.isArray(snap.nodes)) {
        const prepared = hydrateCanvas(snap, reqCanvas);
        fitPendingRef.current = true;
        deoverlapPendingRef.current = prepared.changed;
        setDeoverlapArmed(false);
        setNodes(prepared.nodes);
        setEdges(prepared.edges);
      }
      clearTimeout(timer);
      setIsLoading(false);
      // 分镜导入在画布切换后到达：载入完成再建子图并自动生成
      if (pendingBuildRef.current) {
        setTimeout(() => { try { continuePendingBuildRef.current?.(); } catch { /* ignore */ } }, 600);
      }
    }).catch((e) => {
      console.warn('[Canvas] load failed', e);
      clearTimeout(timer);
      setIsLoading(false);
    });

    apiService.listAssets({ project_id: pid || undefined, limit: 24 }).then(r => setAssets(r.assets || [])).catch(() => {});
    const onAssetRefresh = () => apiService.listAssets({ project_id: pid || undefined, limit: 24 }).then(r => setAssets(r.assets || [])).catch(() => {});
    window.addEventListener('asset-refresh', onAssetRefresh as any);
    return () => { clearTimeout(timer); window.removeEventListener('asset-refresh', onAssetRefresh as any); };
  }, [pid, canvasId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 画布下拉里当前画布的节点数跟着画布实时变（原先只在载入 / 切画布时拉一次列表，要切走再切回才刷新）
  useEffect(() => {
    if (!hydratedRef.current) return;
    const cid = canvasIdRef.current;
    const count = nodes.length;
    setCanvasList((list) => (list.some((c) => c.id === cid && c.node_count !== count)
      ? list.map((c) => (c.id === cid ? { ...c, node_count: count } : c))
      : list));
  }, [nodes.length, canvasList.length]);

  // 800ms 防抖同步（带当前画布 id）；快照带 schema_version 2
  useEffect(() => {
    if (!pid || !loadedRef.current || !hydratedRef.current) return;
    if (suppressSaveRef.current) { suppressSaveRef.current = false; return; }
    let vp: any;
    try { vp = getViewport(); } catch { /* ignore */ }
    debouncedSave(buildSaveSnapshot(nodes, edges, vp), canvasIdRef.current);
    try { useCanvasStore.getState().setFromFlow(nodes as any, edges as any); } catch { /* ignore */ }
  }, [nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  // 载入后等全部节点测量完再适应视图一次（kit 节点含懒加载媒体 / 3D 舞台，挂载即 fitView 只会对准先测到的那几个）；
  // 缩放上限放到 8 后，初次适应不放大超过 100%（旧画布 maxZoom 缺省 2 时 fitView 自然受限）
  // 用宿主自己的 nodes 判断（React Flow store 在画布为空、组件卸载期间不更新，useNodesInitialized 会拿到上一张画布的旧值）
  const nodesInitialized = nodes.length > 0 && nodes.every((n) => n.hidden || (n.measured?.width && n.measured?.height));
  const fitPendingRef = useRef(false);
  /** 刚迁移过的旧画布：测量完后做一次去重叠（新卡片尺寸与旧位置不匹配，见 resolveOverlaps） */
  const deoverlapPendingRef = useRef(false);
  const [deoverlapArmed, setDeoverlapArmed] = useState(false);
  useEffect(() => {
    if (!nodesInitialized || !fitPendingRef.current || !nodes.length) return;
    fitPendingRef.current = false;
    if (deoverlapPendingRef.current) {
      deoverlapPendingRef.current = false;
      // 去重叠要等媒体尺寸确定（图片 / 视频加载后卡片才长高），见 host/settleLayout.ts
      setDeoverlapArmed(true);
    }
    const t = window.setTimeout(() => { try { fitView({ padding: 0.15, maxZoom: 1 }); } catch { /* ignore */ } }, 80);
    return () => window.clearTimeout(t);
  }, [nodesInitialized, nodes.length, fitView, setNodes]);
  useSettledRun(
    deoverlapArmed,
    () => {
      setDeoverlapArmed(false);
      if (resolveOverlaps(nodesRef.current) === nodesRef.current) return;
      setNodes((nds) => resolveOverlaps(nds));
      window.setTimeout(() => { try { fitView({ padding: 0.15, maxZoom: 1, duration: 200 }); } catch { /* ignore */ } }, 80);
    },
    () => measuredSizeKey(nodesRef.current),
    () => wrapperRef.current?.querySelector('.react-flow__nodes'),
  );

  // 连线显示层：平滑贝塞尔 + 与选中 / 拖动节点相连的边高亮（cv-edge-active）
  const renderedEdges = useRenderedEdges(nodes, edges);

  // 节点类型：注册表 + 不认识的类型（含无类型）→「不支持的节点」卡片（数据原样保留）。
  // FX-2：引用只随注册表版本变（与画布里有哪些未知类型无关），React Flow 不再报 nodeTypes 变更（error002）
  const regVersion = useSyncExternalStore(subscribeRegistry, registryVersion, registryVersion);
  const nodeTypes = useCanvasNodeTypes();

  // 必须 memo：ReactFlow 把 onSelectionChange 放进 effect 依赖
  const handleSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    setSelectedNodeId(sel.length ? sel[sel.length - 1].id : null);
  }, [setSelectedNodeId]);

  const identity = useCallback((n: Node) => n, []);
  // 撤销 / 重做 / 复制 / 粘贴 / 删除
  useCanvasShortcuts({
    enabled: !!pid && loadedRef.current,
    nodes, edges, setNodes, setEdges,
    attachHandlers: identity, genId,
    onSelect: setSelectedNodeId,
    onRemoveNodes: (ids) => removeNodes(ids),
  });

  // REQ-toonflow-canvas H1：连线类型校验走 kit（端口 dataType + 接收端 canConnect；动态端口节点由 NodeDef.getPorts 解析）
  const isValidConnection = useMemo(
    () => isValidConnectionFactory((id) => rf.getNode(id), getNodeDef, { getEdges: () => rf.getEdges() }),
    [rf],
  );

  /** 新连线 + 只为这条边算一次下游补丁（动态端口落值 / 生成源透传 / 旧具名口节点） */
  const connectEdge = useCallback((params: Connection): boolean => {
    if (!params.source || !params.target) return false;
    if (!isValidConnection(params)) { toast.warning('连线类型不匹配'); return false; }
    const edge: Edge = {
      ...params,
      id: `e_${params.source}_${params.sourceHandle || ''}_${params.target}_${params.targetHandle || ''}_${Date.now().toString(36)}`,
    } as Edge;
    const nextEdges = addEdge(edge, edgesRef.current);
    if (nextEdges.length === edgesRef.current.length) return false; // 已存在同一条
    edgesRef.current = nextEdges;
    setEdges(nextEdges);
    setNodes((nds) => applyPatches(nds, downstreamPatches(nds, nextEdges, params.source!, { edgeIds: [edge.id] })));
    return true;
  }, [isValidConnection, setEdges, setNodes]);

  const onConnect = useCallback((params: Connection) => { connectEdge(params); }, [connectEdge]);

  // ── 自动放置（规则见 autoLayout.ts）──
  const occupiedRects = (extra: Node[] = []) => [...(nodesRef.current || []), ...extra].filter((n) => !n.parentId).map((n) => rectOf(n as any));
  /** 视口中上部（落在用户眼前），作为独立卡的放置锚点 */
  const viewportAnchor = (): { x: number; y: number } => {
    const el = wrapperRef.current;
    if (!el) return { x: 120, y: 120 };
    const r = el.getBoundingClientRect();
    const p = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 });
    return { x: p.x - 180, y: p.y - 120 };
  };
  const widthOf = (type: string) => getNodeDef(type)?.width ?? estimateSize(type).w;
  /** 独立卡：视口锚点所在列向下找空位 */
  const freePosition = (type: string): { x: number; y: number } => {
    const { h } = estimateSize(type);
    return placeNear(occupiedRects(), viewportAnchor(), widthOf(type), h);
  };
  /** 成组卡：保持组内相对布局，整组放到现有内容下方 */
  const placeNewBlock = (block: Node[]): Node[] => {
    if (!block.length) return block;
    const { dx, dy } = placeBlock(occupiedRects(), block.map((n) => rectOf(n as any)));
    return block.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
  };
  /** 新放下的卡片可能在视口外：平移镜头让用户看到 */
  const revealNodes = (ids: string[]) => {
    if (!ids.length) return;
    window.setTimeout(() => {
      try { fitView({ nodes: ids.map((id) => ({ id })), padding: 0.25, duration: 300, maxZoom: 1 }); } catch { /* ignore */ }
    }, 80);
  };

  /** REQ-toonflow-canvas H1：新节点数据来自注册表 defaultData（custom / ext-node 标题现算，不写死 label） */
  const createNode = (type: string, position: { x: number; y: number }, extraData?: Record<string, any>): Node => ({
    id: genId(type),
    type,
    position,
    data: newNodeData(type, extraData),
  });
  /** 追加节点并选中第一个（其余取消选中） */
  const addNodesSelected = (list: Node[], selectId?: string) => {
    const sel = selectId ?? list[0]?.id;
    setNodes((nds) => [...nds.map((n) => (n.selected ? { ...n, selected: false } : n)), ...list.map((n) => ({ ...n, selected: n.id === sel }))]);
    if (sel) setSelectedNodeId(sel);
  };

  // ── 拖线松手在空白处：弹出「创建可接上的节点」菜单（只列能接上该端口类型的注册表节点）──
  const portOf = (nodeId: string, handleId: string | null, side: 'source' | 'target'): PortDef | undefined => {
    const node = nodesRef.current.find((n) => n.id === nodeId) || rf.getNode(nodeId);
    if (!node) return undefined;
    // N7：动态端口节点（ext-node / custom / provider*）按声明解析，其余走注册表
    const dyn = resolveDynamicPorts(node).filter((p) => p.type === side);
    if (dyn.length) return handleId ? dyn.find((p) => p.id === handleId) : dyn[0];
    return findPort(getNodeDef(node.type), node, handleId, side);
  };
  const onConnectEnd: OnConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || state.toHandle || !state.fromNode || !state.fromHandle) return;
    const side = state.fromHandle.type;
    const hid = state.fromHandle.id ?? null;
    const port = portOf(state.fromNode.id, hid, side);
    if (!port) return;
    const defs: AnyNodeDef[] = side === 'source' ? defsAcceptingFrom(port.dataType) : defsProvidingTo(port.dataType);
    const items: NodeMenuItem[] = defs.flatMap((d) => {
      const p = findCompatiblePort(d, port.dataType, side === 'source' ? 'target' : 'source');
      return p ? [{ type: d.type, label: d.label, icon: d.icon, handleId: p.id }] : [];
    });
    const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
    setEdgeDisconnect(null);
    setNodeMenu({
      x: pt.clientX, y: pt.clientY,
      flow: screenToFlowPosition({ x: pt.clientX, y: pt.clientY }),
      from: { nodeId: state.fromNode.id, handleId: hid, side },
      items,
    });
  }, [screenToFlowPosition]); // eslint-disable-line react-hooks/exhaustive-deps

  const paletteMenuItems = (): NodeMenuItem[] => paletteDefs().map((d) => ({ type: d.type, label: d.label, icon: d.icon }));
  const openPaneMenu = (clientX: number, clientY: number) => {
    setEdgeDisconnect(null);
    setNodeMenu({ x: clientX, y: clientY, flow: screenToFlowPosition({ x: clientX, y: clientY }), items: paletteMenuItems() });
  };

  const createFromMenu = (item: NodeMenuItem) => {
    const menu = nodeMenu;
    setNodeMenu(null);
    if (!menu) return;
    const { flow, from } = menu;
    const w = widthOf(item.type);
    const h = estimateSize(item.type).h;
    if (!from) {
      const node = createNode(item.type, flow);
      addNodesSelected([node]);
      return;
    }
    // 从输出拖出 → 新节点放在落点右侧；从输入拖出 → 放在落点左侧（垂直居中于落点）
    const node = createNode(item.type, { x: from.side === 'source' ? flow.x + 24 : flow.x - w - 24, y: flow.y - h / 2 });
    addNodesSelected([node]);
    const params: Connection = from.side === 'source'
      ? { source: from.nodeId, sourceHandle: from.handleId, target: node.id, targetHandle: item.handleId ?? null }
      : { source: node.id, sourceHandle: item.handleId ?? null, target: from.nodeId, targetHandle: from.handleId };
    // 新节点要先进 React Flow store，isValidConnection 才拿得到它
    window.setTimeout(() => { connectEdge(params); }, 0);
  };

  /* ── 插件节点行（custom_nodes / canvas_nodes）的桥接与注册（设计 §12）── */
  const paletteCreateRef = useRef<(type: PaletteNodeType, data?: Record<string, any>) => void>(() => {});
  useEffect(() => {
    paletteCreateRef.current = (type, data) => {
      const node = createNode(type, freePosition(type), data);
      addNodesSelected([node]);
    };
  });
  const paletteBridge = useMemo(
    () => ({
      createNode: (type: PaletteNodeType, data?: Record<string, any>) => paletteCreateRef.current(type, data),
    }),
    [],
  );
  /** 当前插件节点行（宿主据此决定「去插件中心安装」空态是否显示） */
  const paletteEntries = useUIEntries(CANVAS_PALETTE_HOST);
  useEffect(() => { syncCanvasPaletteEntries(customNodes, extNodes); }, [customNodes, extNodes]);
  useEffect(() => () => clearCanvasPaletteEntries(), []);

  /** 工具栏节点（注册表 paletteDefs，Toonflow 同款：节点即注册） */
  const coreLibrary = useMemo(() => paletteDefs(), [regVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTemplate = (tpl: CanvasTemplate) => {
    const built = buildTemplate(tpl, createNode, widthOf);
    const placed = placeNewBlock(built.nodes);
    addNodesSelected(placed);
    setEdges((es) => [...es, ...built.edges]);
    revealNodes(placed.map((n) => n.id));
  };

  // Creator 模板（Agent 创造模式产物，storage/canvas_templates）：从模板新建节点链
  const [creatorTemplates, setCreatorTemplates] = useState<any[]>([]);
  const refreshCreatorTemplates = async () => {
    try {
      const r: any = await apiService.listCreatorTemplates();
      setCreatorTemplates(r.templates || []);
    } catch { /* ignore */ }
  };
  useEffect(() => {
    refreshCreatorTemplates();
    const h = () => refreshCreatorTemplates();
    window.addEventListener('creator-template-refresh', h as any);
    return () => window.removeEventListener('creator-template-refresh', h as any);
  }, []);
  const addCreatorTemplate = (tpl: any) => {
    const built = buildCreatorTemplate(tpl, createNode);
    if (!built.nodes.length) { toast.warning('该模板无可用节点（未知节点类型已跳过）'); return; }
    const placed = placeNewBlock(built.nodes);
    addNodesSelected(placed);
    setEdges((es) => [...es, ...built.edges]);
    revealNodes(placed.map((n) => n.id));
  };

  // Agent 自主编排后刷新（画布 MCP 在服务端改了画布 → 重载当前画布，同样走迁移 + 备份）
  useEffect(() => {
    const onAgent = async () => {
      if (!pid) return;
      const cid = canvasIdRef.current;
      try {
        const snap: any = await loadCanvas(cid);
        if (!snap || !Array.isArray(snap.nodes) || canvasIdRef.current !== cid) return;
        const prepared = hydrateCanvas(snap, cid);
        setNodes(prepared.nodes);
        setEdges(prepared.edges);
      } catch { /* ignore */ }
    };
    window.addEventListener('agent-canvas-updated', onAgent as any);
    return () => window.removeEventListener('agent-canvas-updated', onAgent as any);
  }, [pid, loadCanvas, hydrateCanvas, setNodes, setEdges]);

  // 导出分镜
  useEffect(() => {
    const h = async () => {
      if (!pid) { toast.warning('请先打开项目'); return; }
      const gens = nodes.filter(n => ['image', 'video', 'prompt'].includes(n.type as string));
      if (gens.length === 0) { toast.warning('画布为空，无法导出'); return; }
      const sorted = [...gens].sort((a, b) => a.position.x - b.position.x);
      const shots = sorted.filter(n => n.type === 'image' || n.type === 'video').map((n, i) => {
        const d: any = n.data;
        return {
          id: `shot-${Date.now()}-${i}`, shot_index: i + 1, scene_index: 1,
          camera_framing: 'medium', camera_motion: 'push_in',
          action_desc: d.prompt || d.image_prompt || '', dialogue: d.text || '',
          image_prompt: d.prompt || '', image_url: d.image_url || d.result_url, video_url: d.video_url,
          duration: d.duration || 5, subtitle_text: d.prompt || '', status: 'ready',
        };
      });
      if (shots.length === 0) shots.push({ id: `shot-${Date.now()}`, shot_index: 1, scene_index: 1, camera_framing: 'medium', camera_motion: 'push_in', action_desc: '空', dialogue: '', image_prompt: '', duration: 5, subtitle_text: '', status: 'ready' } as any);
      const projContent: any = { id: pid, title: project?.title || '画布项目', original_novel: '', style_preset: project?.style_preset || 'donghua_xianxia', aspect_ratio: '9:16', characters: project?.characters || [], scenes: [{ id: 'scene-1', scene_index: 1, title: '场景1', location: '', time_of_day: 'day', atmosphere: 'epic', shots }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      try {
        await apiService.saveProjectContent(pid, projContent);
        useProjectStore.getState().setProject(projContent);
        toast.success(`已导出 ${shots.length} 镜到项目时间线`);
      } catch (e: any) { toast.error(e.message); }
    };
    window.addEventListener('canvas-export-shots', h as any);
    return () => window.removeEventListener('canvas-export-shots', h as any);
  }, [nodes, pid, project]);

  // 分镜 → 画布：新建画布 / 隶属现有画布 → 装配新模型子图 → 自动生成视频并回写分镜。
  const importedShotNonce = useRef<number>(0);
  const pendingBuildRef = useRef<any>(null);
  const importRunnerRef = useRef<(p: any) => void>(() => {});
  const continuePendingBuildRef = useRef<() => void>(() => {});

  const loadProjectAssetsForCanvas = async (): Promise<any[]> => {
    try {
      const r: any = await apiService.listAssets({ project_id: pid || undefined, page: 1, limit: 100 });
      return r?.assets || [];
    } catch { return []; }
  };
  const providerSlots = async (providerId: string, kind: 'image' | 'video') => {
    if (!providerId) return null;
    const def = await loadProviderDefinition(providerId);
    if (!def) return null;
    const slots = extractSlotsFromProvider(def as unknown as DynamicProviderInfo, kind);
    return slots.length ? slots : null;
  };

  /**
   * REQ-toonflow-canvas H1：分镜「在画布中运行」→ 新模型子图（文本 / 3D 导演 / 图片生成 / 绑定资源加载节点 → 视频 in + refRoles，
   * 见 host/shotSubgraph.ts）；自动运行：3D 导演规划 → 视频生成 → 回写分镜（shotWriteBack 同一口径）。
   */
  const runShotOnCanvas = async (payload: any, targetCid: string, targetName?: string) => {
    const shot = payload?.shot;
    if (!shot?.id || !pid) return;
    const proj = useProjectStore.getState().project;
    const [projectAssets, videoSlots, imageSlots] = await Promise.all([
      loadProjectAssetsForCanvas(),
      providerSlots(shot.video_provider || '', 'video'),
      providerSlots(shot.image_provider || '', 'image'),
    ]);
    const sub = buildShotSubgraph({ shot, project: proj, projectAssets, videoSlots, imageSlots, makeNode: createNode });
    const placed = placeNewBlock(sub.nodes);
    addNodesSelected(placed, sub.videoNodeId);
    setEdges((es) => [...es, ...sub.edges]);
    revealNodes(placed.map((n) => n.id));
    // 隶属关系落盘 + 子图即时保存（含画布名）
    try { useProjectStore.getState().updateShot(shot.id, { canvas_id: targetCid } as any); } catch { /* ignore */ }
    try {
      let vp: any;
      try { vp = getViewport(); } catch { /* ignore */ }
      await persistCanvas(buildSaveSnapshot([...(nodesRef.current || []), ...placed], [...(edgesRef.current || []), ...sub.edges], vp), targetCid, targetName);
      apiService.listProjectCanvases(pid).then(r => setCanvasList(r.canvases || [])).catch(() => {});
    } catch { /* ignore */ }
    if (payload.autoRun === false) return;
    if (!shot.video_provider) {
      toast.info('子图已建好：该分镜未绑定视频源，请在视频节点内选择生成源后手动生成');
      return;
    }
    // 自动生成：导演机位 → 视频 → 回写分镜（D4：视频 url 取 execute 返回值，见 host/shotAutoRun.ts）
    await autoRunShotSubgraph(
      { shotId: shot.id, shotIndex: shot.shot_index || '', directorNodeId: sub.directorNodeId, videoNodeId: sub.videoNodeId },
      {
        execute,
        readNodeData: (id) => (nodesRef.current || []).find((n) => n.id === id)?.data as Record<string, unknown> | undefined,
        writeBack: (o) => writeBackToShot(o),
        notify: (level, msg) => toast[level](msg),
      },
    );
  };

  const processShotImport = (payload: any) => {
    const shot = payload?.shot;
    if (!shot?.id) return;
    const nonce = Number(payload?.nonce || 0);
    if (nonce && nonce === importedShotNonce.current) return;
    if (nonce) importedShotNonce.current = nonce;
    if (!pid) { toast.warning('请先在 项目看板 创建/打开项目'); return; }
    const mode = payload?.mode || 'existing';
    if (mode === 'new') {
      const cname = payload?.canvas_name || `分镜#${shot.shot_index || ''}画布`;
      const cid = `cv_${Date.now().toString(36)}`;
      pendingBuildRef.current = { payload, cid, cname };
      suppressSaveRef.current = true;
      setNodes([]); setEdges([]); setSelectedNodeId(null);
      setCanvasId(cid);
    } else {
      const cid = payload?.canvas_id || canvasIdRef.current;
      if (cid !== canvasIdRef.current) {
        pendingBuildRef.current = { payload, cid };
        switchCanvas(cid);
      } else {
        runShotOnCanvas(payload, cid);
      }
    }
  };
  importRunnerRef.current = processShotImport;
  continuePendingBuildRef.current = () => {
    const pb = pendingBuildRef.current;
    pendingBuildRef.current = null;
    if (!pb) return;
    runShotOnCanvas(pb.payload, pb.cid, pb.cname);
  };

  useEffect(() => {
    const onEvent = (e: any) => { try { importRunnerRef.current(e?.detail); } catch { /* ignore */ } };
    window.addEventListener('canvas-import-shot', onEvent as any);
    // 兜底：消费分镜写入的 pending（画布当时未挂载时）
    try {
      const raw = localStorage.getItem('canvas_pending_shot');
      if (raw) {
        const payload = JSON.parse(raw);
        localStorage.removeItem('canvas_pending_shot');
        setTimeout(() => { try { importRunnerRef.current(payload); } catch { /* ignore */ } }, 600);
      }
    } catch { /* ignore */ }
    return () => window.removeEventListener('canvas-import-shot', onEvent as any);
  }, []);

  // 素材库 → 画布：文本 → 文本节点；视频 → 视频节点；图片 / 音频 →「素材节点 → 生成节点」（连到 in，参考自动落位）
  const importedAssetNonce = useRef<number>(0);
  const assetImportRef = useRef<(payload: any) => void>(() => {});
  assetImportRef.current = (payload: any) => {
    const asset = payload?.asset;
    if (!asset || !asset.id) return;
    const nonce = Number(payload?.nonce || 0);
    if (nonce && nonce === importedAssetNonce.current) return;
    if (nonce) importedAssetNonce.current = nonce;
    const label = String(asset.visual_prompt || asset.description || asset.name || '');
    if (asset.category === 'text') {
      const txt = String(asset.content || asset.visual_prompt || '');
      const tn = createNode('prompt', freePosition('prompt'), { prompt: txt, text: txt, ...(asset.name ? { label: String(asset.name).slice(0, 40) } : {}) });
      addNodesSelected([tn]);
      revealNodes([tn.id]);
      return;
    }
    const url = storedUrl(String(asset.file_url || ''));
    if (!url) return;
    const kind = mediaKindOfUrl(url);
    const src = createNode(MEDIA_LOADER[kind], { x: 0, y: 0 }, loaderData(kind, url, { asset_id: asset.id, label: asset.name || undefined }));
    if (kind === 'video') {
      src.position = freePosition('load-video');
      addNodesSelected([src]);
      revealNodes([src.id]);
      return;
    }
    const genType = kind === 'audio' ? 'audio' : 'image';
    const gen = createNode(genType, { x: widthOf(src.type!) + 120, y: 0 }, kind === 'audio' ? {} : { prompt: label });
    const edgesNew = linkNodes([src, gen], [[src.id, gen.id]]);
    const placed = placeNewBlock([src, gen]);
    addNodesSelected(placed, gen.id);
    setEdges((es) => [...es, ...edgesNew]);
    revealNodes(placed.map((n) => n.id));
  };
  useEffect(() => {
    const onEvent = (e: any) => assetImportRef.current(e?.detail);
    window.addEventListener('canvas-import-asset', onEvent as any);
    try {
      const raw = localStorage.getItem('canvas_pending_asset');
      if (raw) {
        const payload = JSON.parse(raw);
        localStorage.removeItem('canvas_pending_asset');
        setTimeout(() => assetImportRef.current(payload), 600);
      }
    } catch { /* ignore */ }
    return () => window.removeEventListener('canvas-import-asset', onEvent as any);
  }, []);

  /** 命中检测：指针正下方最上层的非分组节点（用于「文本拖到节点上直接填充」） */
  const findNodeAt = useCallback((clientX: number, clientY: number): Node | null => {
    const p = screenToFlowPosition({ x: clientX, y: clientY });
    const hits = rf.getIntersectingNodes({ x: p.x, y: p.y, width: 1, height: 1 }).filter((n) => n.type !== 'group');
    return hits.length ? hits[hits.length - 1] : null;
  }, [screenToFlowPosition, rf]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/canvas-nodetype');
    const droppedNodeId = e.dataTransfer.getData('application/canvas-nodeid');
    const assetId = e.dataTransfer.getData('application/canvas-assetid');
    const assetKind = e.dataTransfer.getData('application/canvas-assetkind');
    const dragText = e.dataTransfer.getData('application/canvas-text');
    const plain = e.dataTransfer.getData('text/plain');
    if (!type && !assetId && !dragText && !plain) return;
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });

    // ── 文本投放：文本素材 或 自由文本 → 命中节点即填充，落空则新建「文本」节点 ──
    let textContent: string | null = null;
    if (dragText) textContent = dragText;
    else if (assetKind === 'text') {
      const a: any = assets.find(x => x.id === assetId);
      textContent = String(a?.content || a?.visual_prompt || '');
    } else if (!type && !assetId && plain && !/^https?:\/\//i.test(plain.trim()) && !plain.trim().startsWith('/storage/')) {
      textContent = plain;
    }
    if (textContent !== null && !type) {
      const txt = textContent;
      const hit = findNodeAt(e.clientX, e.clientY);
      const patch = hit ? textPatchFor(hit.type, txt) : null;
      if (txt.trim() && hit && patch) {
        controller.updateNodeData(hit.id, patch);
        setSelectedNodeId(hit.id);
        return;
      }
      addNodesSelected([createNode('prompt', position, { prompt: txt, text: txt })]);
      return;
    }

    if (assetId) {
      // REQ-toonflow-canvas H1（N2）：素材拖到空白处建「素材节点」（load-image / load-video / load-audio），三键同写 + asset_id
      const asset = assets.find(a => a.id === assetId);
      const raw = String(asset?.file_url || asset?.thumb_url || plain || '');
      const url = storedUrl(raw);
      if (!url) return;
      const kind = mediaKindOfUrl(url);
      addNodesSelected([createNode(MEDIA_LOADER[kind], position, loaderData(kind, url, { asset_id: assetId, ...(asset?.name ? { label: asset.name } : {}) }))]);
      return;
    }
    if (type) {
      const extra = type === 'ext-node' && droppedNodeId
        ? { canvas_node_id: droppedNodeId, definition: getCanvasNodeSpec(droppedNodeId) }
        : type === 'custom' && droppedNodeId ? { custom_node_id: droppedNodeId } : undefined;
      addNodesSelected([createNode(type, position, extra)]);
    }
  }, [screenToFlowPosition, assets, findNodeAt, controller, setSelectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleManualSave = async () => {
    if (!pid) { toast.warning('请先在 项目看板 创建/打开项目'); return; }
    setSaving(true);
    try {
      const nm = canvasList.find(c => c.id === canvasIdRef.current)?.name;
      let vp: any;
      try { vp = getViewport(); } catch { /* ignore */ }
      await persistCanvas(buildSaveSnapshot(nodes, edges, vp), canvasIdRef.current, nm);
      const r = await apiService.listProjectCanvases(pid).catch(() => null);
      if (r) setCanvasList(r.canvases || []);
      toast.success('画布已保存');
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  };

  const currentCanvasName = canvasList.find(c => c.id === canvasId)?.name || (canvasId === 'default' ? '默认画布' : canvasId);

  // 切换画布（先存当前，再载目标；目标已删时跳过保存避免复活）
  const switchCanvas = async (cid: string, skipSave = false) => {
    if (!pid || cid === canvasIdRef.current) return;
    if (!skipSave && hydratedRef.current) {
      try {
        const nm = canvasList.find(c => c.id === canvasIdRef.current)?.name;
        let vp: any;
        try { vp = getViewport(); } catch { /* ignore */ }
        await persistCanvas(buildSaveSnapshot(nodesRef.current || [], edgesRef.current || [], vp), canvasIdRef.current, nm);
      } catch { /* ignore */ }
    }
    setNodes([]); setEdges([]); setSelectedNodeId(null);
    suppressSaveRef.current = true;
    setCanvasId(cid);
  };

  // 新建画布并切换
  const createCanvas = async (name: string) => {
    if (!pid) { toast.warning('请先在 项目看板 创建/打开项目'); return null; }
    const cid = `cv_${Date.now().toString(36)}`;
    try {
      await apiService.saveProjectCanvas(pid, buildSaveSnapshot([], []), cid, name);
      const r = await apiService.listProjectCanvases(pid).catch(() => null);
      if (r) setCanvasList(r.canvases || []);
    } catch (e: any) { toast.error(e.message); return null; }
    suppressSaveRef.current = true;
    setNodes([]); setEdges([]); setSelectedNodeId(null);
    setCanvasId(cid);
    return cid;
  };

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };

  useEffect(() => {
    const onDown = () => setIsDragging(true);
    const onUp = () => setIsDragging(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('mouseup', onUp); };
  }, []);

  // 拖动结束：Toonflow 式拖入 / 拖出分组（reparentOnDrop 同时贴合受影响的分组框）
  const onNodeDragStop = useCallback((_: unknown, _node: Node, dragged: Node[]) => {
    const ids = (dragged && dragged.length ? dragged : [_node]).map((n) => n.id);
    setNodes((nds) => reparentOnDrop(nds, ids));
  }, [setNodes]);

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.stopPropagation();
    setNodeMenu(null);
    setEdgeDisconnect({ id: edge.id, x: event.clientX, y: event.clientY });
  }, []);

  if (!pid) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3" style={{ background: isLight ? '#E8ECF1' : '#08080B' }}>
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand to-accent-pink flex items-center justify-center shadow-lg shadow-brand/20">
          <FolderOpen className="w-5 h-5 text-white" strokeWidth={1.7} />
        </div>
        <p className="text-sm [color:var(--color-text-main)] font-semibold">请先在「漫剧制作 → 项目看板」创建或打开项目</p>
        <p className="text-xs text-gray-400">画布按项目隔离持久化</p>
        <button onClick={() => useProjectStore.getState().setActiveTab('projects')} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold hover:bg-brand-light shadow-md">前往项目看板</button>
      </div>
    );
  }

  const isEmpty = nodes.length === 0;

  /** 工作台分块：点块 → 展开面板并定位到该小节；再点同一块收起 */
  const openWorkbench = (section: WorkbenchSection) => {
    if (workbenchOpen && workbenchSection === section) { setWorkbenchOpen(false); return; }
    setWorkbenchSection(section);
    setWorkbenchOpen(true);
  };
  const setWorkbenchSectionRef = (id: WorkbenchSection) => (el: HTMLElement | null) => {
    workbenchSectionRefs.current[id] = el;
  };
  /** 自定义 / 扩展节点入口：设置 → 插件中心 */
  const goPluginCenter = () => {
    try { localStorage.setItem('config_pending_tab', 'plugins'); } catch { /* ignore */ }
    useProjectStore.getState().setActiveTab('config');
  };
  /** 新建画布并切换（顶部工具条完整/精简两态共用） */
  const handleCreateCanvas = async () => {
    const n = canvasList.length + 1;
    const cid = await createCanvas(`画布${n}`);
    if (cid) toast.success(`已新建画布${n}并切换`);
  };
  /** 重命名当前画布 */
  const handleRenameCanvas = async () => {
    if (!pid) return;
    const cur = canvasList.find(c => c.id === canvasIdRef.current);
    const nv = await promptAsync({
      title: '重命名画布',
      message: '请输入新的画布名称：',
      defaultValue: cur?.name || currentCanvasName,
      placeholder: '画布名称'
    });
    if (!nv || !nv.trim()) return;
    try {
      await apiService.renameProjectCanvas(pid, canvasIdRef.current, nv.trim());
      const r = await apiService.listProjectCanvases(pid).catch(() => null);
      if (r) setCanvasList(r.canvases || []);
      toast.success(`画布已更名为「${nv.trim()}」`);
    } catch (e: any) { toast.error(e.message || '重命名失败'); }
  };
  /** 删除当前画布 */
  const handleDeleteCanvas = async () => {
    if (!pid) return;
    if (canvasList.length <= 1) { toast.warning('至少保留一个画布'); return; }
    const cur = canvasList.find(c => c.id === canvasIdRef.current)?.name || currentCanvasName;
    const confirmed = await confirmAsync({
      title: '删除画布',
      message: `确定要删除画布「${cur}」吗？\n画布内的所有节点与编排数据将丢失且无法撤销。`,
      isDanger: true,
      confirmText: '确认删除',
      cancelText: '取消'
    });
    if (!confirmed) return;
    try {
      const r: any = await apiService.deleteProjectCanvas(pid, canvasIdRef.current);
      const list = await apiService.listProjectCanvases(pid).catch(() => null);
      if (list) setCanvasList(list.canvases || []);
      const next = r?.active_canvas_id || 'default';
      suppressSaveRef.current = true;
      setNodes([]); setEdges([]); setSelectedNodeId(null);
      setCanvasId(next);
      toast.success(`已删除画布「${cur}」`);
    } catch (e: any) { toast.error(e.message || '删除失败'); }
  };
  /** 清空当前画布 */
  const handleClearCanvas = async () => {
    const ok = await confirmAsync({
      title: '清空画布',
      message: '确定要清空当前画布上的所有节点和连线吗？',
      isDanger: true,
      confirmText: '确认清空',
      cancelText: '取消'
    });
    if (ok) { setNodes([]); setEdges([]); setSelectedNodeId(null); toast.info('画布已清空'); }
  };
  /** 横向排布：顶层节点排成一行（分组整体移动，组内相对位置不变；kit arrangeNodes） */
  const handleArrangeHorizontally = () => {
    if (!nodes.length) return;
    const roots = selectionRoots(nodes, nodes.map((n) => n.id)).map((n) => n.id);
    setNodes((nds) => arrangeNodes(nds, roots, 'horizontal'));
  };

  return (
    <CanvasHostProvider value={host}>
    <div className="flex-1 flex overflow-hidden" style={{ background: isLight ? '#E8ECF1' : '#08080B', cursor: 'default' }}>
      {/* 中间无限画布 */}
      <div ref={wrapperRef} className="flex-1 relative flex flex-col min-w-0" style={{ background: isLight ? '#E8ECF1' : '#08080B' }} onDrop={onDrop} onDragOver={onDragOver}>
        {/* 画布顶部工具条：完整态（wide/normal）与精简态（compact，窄屏时低频操作收入「更多」） */}
        <div ref={toolbarRef} className="h-11 px-4 border-b border-white/70 dark:border-white/12 bg-surface/80 flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow shadow-emerald-500/30 shrink-0" />
            <span className="[color:var(--color-text-secondary)] shrink-0">项目</span>
            <span className="font-mono [color:var(--color-text-main)] font-bold shrink-0">{pid.slice(0, 8)}</span>
            {toolbarLevel === 'wide' && (
              <span className="[color:var(--color-text-muted)] truncate">· 从端口拖线到空白处快速创建 · 选中节点在下方面板生成</span>
            )}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2 shrink-0">
            <select value={canvasId} onChange={e=>switchCanvas(e.target.value)} title="隶属画布：分镜视频在此画布生成" className={`px-2 py-1 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-xs [color:var(--color-text-main)] focus:outline-none ${toolbarLevel === 'compact' ? 'max-w-[104px]' : 'max-w-[160px]'}`}>
              {canvasList.length === 0 && <option value={canvasId}>{currentCanvasName}</option>}
              {canvasList.map(c=> <option key={c.id} value={c.id}>{c.name}（{c.node_count}节点）</option>)}
            </select>
            <button onClick={() => setShowManager(true)} className="px-3 py-1 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-xs font-medium [color:var(--color-text-main)] hover:bg-surface-hover/80 transition-colors" title="查看全部画布：新建/打开/改名/删除/隶属分镜">管理</button>
            <CanvasManagerModal
              isOpen={showManager}
              onClose={() => setShowManager(false)}
              projectId={pid}
              currentId={canvasId}
              onSwitch={(cid, opts) => switchCanvas(cid, opts?.skipSave)}
              onChanged={() => { if (pid) apiService.listProjectCanvases(pid).then(r => setCanvasList(r.canvases || [])).catch(() => {}); }}
            />

            {toolbarLevel !== 'compact' && (
              <>
                <button onClick={handleCreateCanvas} className="px-3 py-1 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-xs font-medium [color:var(--color-text-main)] hover:bg-surface-hover/80 transition-colors">+ 新画布</button>
                <button onClick={handleRenameCanvas} aria-label="重命名当前画布" title="重命名当前画布" className="w-7 h-7 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] flex items-center justify-center transition-colors">
                  <Pencil className="w-3.5 h-3.5" strokeWidth={1.7} />
                </button>
                <button onClick={handleDeleteCanvas} aria-label="删除当前画布" title="删除当前画布" className="w-7 h-7 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 [color:var(--color-text-muted)] hover:text-red-400 flex items-center justify-center transition-colors">
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.7} />
                </button>
                {toolbarLevel === 'wide' && (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 text-[10px] [color:var(--color-text-muted)] whitespace-nowrap"
                    title="Ctrl/⌘+C 复制 · Ctrl/⌘+V 粘贴 · Ctrl/⌘+Z 撤销 · Ctrl/⌘+Y 重做 · Delete 删除；滚轮平移、Ctrl/⌘+滚轮缩放；Shift+拖 框选">
                    <Keyboard className="w-3.5 h-3.5 shrink-0" strokeWidth={1.7} />
                    ⌘C/V 复制粘贴 · ⌘Z/Y 撤销重做 · Del 删除
                  </span>
                )}
              </>
            )}

            {toolbarLevel === 'compact' && (
              <div className="relative" ref={toolbarMenuRef}>
                <button
                  onClick={() => setToolbarMenuOpen(v => !v)}
                  aria-haspopup="menu"
                  aria-expanded={toolbarMenuOpen}
                  aria-label="更多画布操作"
                  title="更多画布操作"
                  className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${
                    toolbarMenuOpen
                      ? 'bg-brand/15 text-brand border-brand/40'
                      : 'bg-surface/80 border-white/70 dark:border-white/12 [color:var(--color-text-muted)] hover:[color:var(--color-text-main)]'
                  }`}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.7} />
                </button>
                <div
                  role="menu"
                  aria-label="更多画布操作"
                  aria-hidden={!toolbarMenuOpen}
                  className={`absolute right-0 top-[calc(100%+6px)] w-[200px] p-1 rounded-[14px] bg-surface/80 border border-white/70 dark:border-white/12 shadow-xl z-40 origin-top-right transition-all duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
                    toolbarMenuOpen
                      ? 'opacity-100 scale-100 visible pointer-events-auto'
                      : 'opacity-0 scale-[.98] invisible pointer-events-none'
                  }`}
                >
                  <button role="menuitem" className={TOOLBAR_MENU_ITEM} onClick={() => { setToolbarMenuOpen(false); handleCreateCanvas(); }}>
                    <Plus className="w-4 h-4 shrink-0" strokeWidth={1.7} />新建画布
                  </button>
                  <button role="menuitem" className={TOOLBAR_MENU_ITEM} onClick={() => { setToolbarMenuOpen(false); handleRenameCanvas(); }}>
                    <Pencil className="w-4 h-4 shrink-0" strokeWidth={1.7} />重命名画布
                  </button>
                  <button role="menuitem" className={`${TOOLBAR_MENU_ITEM} hover:text-red-400 hover:bg-red-500/10`} onClick={() => { setToolbarMenuOpen(false); handleDeleteCanvas(); }}>
                    <Trash2 className="w-4 h-4 shrink-0" strokeWidth={1.7} />删除画布
                  </button>
                  <div className="h-px bg-border-subtle mx-1 my-1" />
                  <div className="px-2.5 py-1 text-[10.5px] leading-relaxed [color:var(--color-text-muted)]">
                    ⌘C/V 复制粘贴 · ⌘Z/Y 撤销重做 · Del 删除
                  </div>
                </div>
              </div>
            )}

            <button onClick={handleClearCanvas} aria-label="清空画布" title="清空画布" className="w-7 h-7 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 [color:var(--color-text-muted)] hover:text-red-400 flex items-center justify-center transition-colors">
              <X className="w-3.5 h-3.5" strokeWidth={1.7} />
            </button>
          </div>
        </div>

        {/* ── 画布操作台条（左上角）── */}
        <div ref={workbenchRef} className="absolute left-3 top-[52px] bottom-3 z-30 flex flex-col items-start gap-2 pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-0.5 p-1 rounded-md bg-surface/80 border border-white/70 dark:border-white/12 shadow-md select-none">
            <button
              onClick={toggleSidebar}
              aria-pressed={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? '展开系统左侧栏' : '收起系统左侧栏'}
              title={sidebarCollapsed ? '展开系统左侧栏（显示文字）' : '收起系统左侧栏（只显示图标）'}
              className={`w-7 h-7 inline-flex items-center justify-center rounded-md transition-colors ${
                !sidebarCollapsed
                  ? 'bg-brand/15 text-brand'
                  : '[color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface/80'
              }`}
            >
              <PanelLeft className="w-4 h-4" strokeWidth={1.7} />
            </button>
            <span className="w-px h-4 bg-border-subtle mx-0.5 shrink-0" />
            {WORKBENCH_TABS.map((t) => {
              const on = workbenchOpen && workbenchSection === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => openWorkbench(t.id)}
                  aria-current={on ? 'true' : undefined}
                  title={`${t.label}：展开画布操作台并定位到该分区`}
                  className={`h-7 px-2 inline-flex items-center gap-1 rounded-md text-[11.5px] font-medium transition-colors ${
                    on
                      ? 'bg-brand/15 text-brand'
                      : '[color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-surface/80'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" strokeWidth={1.7} />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div
            role="dialog"
            aria-label="画布操作台"
            aria-hidden={!workbenchOpen}
            className={`w-[248px] flex-1 min-h-0 flex flex-col rounded-[18px] bg-surface/80 border border-white/70 dark:border-white/12 shadow-xl overflow-hidden origin-top-left transition-all duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none ${
              workbenchOpen
                ? 'opacity-100 scale-100 visible pointer-events-auto'
                : 'opacity-0 scale-[.98] invisible pointer-events-none'
            }`}
          >
            <div className="h-9 px-2.5 flex items-center gap-2 border-b border-white/70 dark:border-white/12 shrink-0">
              <Layers className="w-3.5 h-3.5 text-brand shrink-0" strokeWidth={1.7} />
              <span className="text-[13px] font-semibold [color:var(--color-text-main)]">画布操作台</span>
              <button
                onClick={() => setWorkbenchOpen(false)}
                aria-label="收起画布操作台"
                title="收起画布操作台（向上折叠）"
                className="ml-auto w-6 h-6 inline-flex items-center justify-center rounded-md [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface/80 transition-colors"
              >
                <ChevronsUp className="w-3.5 h-3.5" strokeWidth={1.7} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-1.5 py-1.5 motion-safe:scroll-smooth">
              <section ref={setWorkbenchSectionRef('template')} className="scroll-mt-2">
                <WorkbenchGroupTitle>一键模板</WorkbenchGroupTitle>
                {TEMPLATES.map(t => (
                  <WorkbenchRow
                    key={t.id}
                    icon={Wand2}
                    iconCls="text-violet-400"
                    label={t.label}
                    desc={t.desc}
                    title="点击：把该模板链路生成到当前画布"
                    onClick={() => addTemplate(t)}
                  />
                ))}
              </section>

              <section ref={setWorkbenchSectionRef('mine')} className="scroll-mt-2">
                <WorkbenchGroupTitle>
                  我的模板 · Creator
                  <button
                    onClick={refreshCreatorTemplates}
                    title="刷新模板列表"
                    className="ml-auto px-1.5 py-0.5 rounded-full text-[10px] font-normal text-violet-300 bg-violet-500/10 border border-violet-500/30 hover:bg-violet-500/20 transition-colors"
                  >刷新</button>
                </WorkbenchGroupTitle>
                {creatorTemplates.length === 0 ? (
                  <div className="px-3 py-1 text-[10.5px] leading-relaxed [color:var(--color-text-muted)]">
                    暂无。在 Agent 创造模式沉淀模板后出现在这里。
                  </div>
                ) : (
                  creatorTemplates.map((t: any) => (
                    <WorkbenchRow
                      key={t.id}
                      icon={Sparkles}
                      iconCls="text-violet-400"
                      label={t.name || t.id}
                      desc={`${(t.nodes || []).length} 节点`}
                      title="点击：从模板新建节点链到当前画布"
                      onClick={() => addCreatorTemplate(t)}
                    />
                  ))
                )}
              </section>

              {/* 节点：注册表工具栏节点 + 自定义 / 扩展节点（插件条目） */}
              <section ref={setWorkbenchSectionRef('nodes')} className="scroll-mt-2">
                <WorkbenchGroupTitle>节点</WorkbenchGroupTitle>
                {coreLibrary.map(d => (
                  <WorkbenchRow
                    key={d.type}
                    icon={d.icon}
                    iconCls={CATEGORY_COLOR[d.category] || undefined}
                    label={d.label}
                    desc={d.description}
                    draggable
                    onDragStart={e => e.dataTransfer.setData('application/canvas-nodetype', d.type)}
                    title="拖入画布，或点击直接创建"
                    onClick={() => addNodesSelected([createNode(d.type, freePosition(d.type))])}
                  />
                ))}

                <CanvasPaletteBridgeContext.Provider value={paletteBridge}>
                  <UISlot host={CANVAS_PALETTE_HOST} />
                </CanvasPaletteBridgeContext.Provider>

                {!customNodesOn && (
                  <div className="px-3 py-1.5 text-[10.5px] [color:var(--color-text-muted)]">
                    自定义代码节点已在 设置 → 功能开关 里关闭
                  </div>
                )}
                {customNodesOn && paletteEntries.length === 0 && (
                  <button
                    onClick={goPluginCenter}
                    title="去设置 → 插件中心安装插件包"
                    className="w-full text-left px-3 py-2 rounded-lg text-[10.5px] [color:var(--color-text-muted)] hover:bg-surface/80 transition-colors"
                  >
                    自定义 / 扩展节点：去设置 → 插件中心安装插件包
                  </button>
                )}
              </section>

              <section ref={setWorkbenchSectionRef('assets')} className="scroll-mt-2">
                <WorkbenchGroupTitle>
                  素材库
                  <span className="ml-auto font-normal">{assets.length} 个</span>
                </WorkbenchGroupTitle>
                <div className="grid grid-cols-3 gap-2 px-2.5 pb-1">
                  {assets.map((a: any) => {
                    const url = a.thumb_url || a.file_url;
                    const abs = resolveMediaUrl(url);
                    return (
                      <div
                        key={a.id}
                        draggable
                        onDragStart={e => {
                          e.dataTransfer.setData('application/canvas-assetid', a.id);
                          e.dataTransfer.setData('text/plain', abs || url);
                        }}
                        title={`拖入画布：${a.name}`}
                        className="aspect-square rounded-md overflow-hidden border border-white/70 dark:border-white/12 bg-surface/80 cursor-grab hover:border-brand/40 transition-colors"
                      >
                        {abs ? (
                          <AutoRatioMedia src={abs} fallbackAspect="1/1" className="w-full h-full" mediaClassName="group-hover:scale-[1.03] transition-transform" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"><ImageIcon className="w-4 h-4 text-gray-500" /></div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {assets.length === 0 && (
                  <div className="px-3 py-1 text-[10.5px] [color:var(--color-text-muted)]">暂无素材，先去素材库上传</div>
                )}
              </section>
            </div>

            <div className="p-2.5 border-t border-white/70 dark:border-white/12 flex items-center gap-2 shrink-0">
              <button
                onClick={handleManualSave}
                disabled={saving}
                className="flex-1 h-8 rounded-md bg-brand text-white text-[11.5px] font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40 hover:bg-brand-light transition-colors"
              >
                <Save className="w-3.5 h-3.5" strokeWidth={1.7} />{saving ? '保存中' : '保存画布'}
              </button>
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('canvas-export-shots'))}
                title="导出为分镜工程"
                className="h-8 px-2.5 rounded-md bg-surface/80 border border-white/70 dark:border-white/12 inline-flex items-center justify-center gap-1.5 text-[11.5px] font-medium [color:var(--color-text-main)] hover:bg-surface-hover/80 transition-colors"
              >
                <Download className="w-3.5 h-3.5" strokeWidth={1.7} />导出
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 relative">
          {isLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 gap-4" style={{ background: isLight ? '#E8ECF1' : '#08080B' }}>
              <div className="w-8 h-8 border-2 border-zinc-600 border-t-brand rounded-full animate-spin" />
              <div className="text-xs [color:var(--color-text-secondary)]">智能体画布加载中…</div>
            </div>
          ) : isEmpty ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 gap-6 overflow-y-auto" style={{ background: isLight ? '#E8ECF1' : '#08080B' }}>
              <div className="w-full max-w-[700px] bg-surface/80 border border-white/70 dark:border-white/12 rounded-3xl shadow-2xl p-6 text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-brand/10 border border-brand/20 text-brand flex items-center justify-center mx-auto shadow-lg">
                  <Wand2 className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold [color:var(--color-text-main)]">从一个想法开始漫剧创作</h3>
                  <p className="text-xs [color:var(--color-text-muted)] mt-1">选择模板一键生成连贯的节点链，或从左上角「画布操作台」拖入节点</p>
                </div>
                <div className="grid grid-cols-3 gap-3 pt-2">
                  {TEMPLATES.map(t => (
                    <button key={t.id} onClick={() => addTemplate(t)} className="p-4 rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 hover:border-brand/40 hover:bg-surface-hover/80 text-left transition-all group">
                      <div className="text-xs font-bold [color:var(--color-text-main)] group-hover:text-brand">{t.label}</div>
                      <div className="text-[11px] [color:var(--color-text-muted)] mt-1">{t.desc}</div>
                    </button>
                  ))}
                  {creatorTemplates.map((t: any) => (
                    <button key={t.id} onClick={() => addCreatorTemplate(t)} className="p-4 rounded-2xl border border-violet-500/25 bg-violet-500/5 hover:border-violet-500/50 hover:bg-violet-500/10 text-left transition-all group">
                      <div className="text-xs font-bold [color:var(--color-text-main)] group-hover:text-violet-300">{t.name || t.id}</div>
                      <div className="text-[11px] [color:var(--color-text-muted)] mt-1">Creator 模板 · {(t.nodes || []).length} 节点</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <ReactFlow
              /* 画布内不弹浏览器右键菜单；输入框/文本域保留原生菜单，方便复制粘贴 */
              onContextMenu={(e) => { if (!(e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) e.preventDefault(); }}
              /* 双击空白处：添加节点菜单（Toonflow） */
              onDoubleClick={(e) => { if ((e.target as HTMLElement).classList?.contains('react-flow__pane')) openPaneMenu(e.clientX, e.clientY); }}
              nodes={nodes}
              edges={renderedEdges}
              nodeTypes={nodeTypes}
              defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
              connectionLineType={ConnectionLineType.SimpleBezier}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              edgesReconnectable={false}
              edgesFocusable={false}
              onEdgeClick={onEdgeClick}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => { setSelectedNodeId(null); setNodeMenu(null); setEdgeDisconnect(null); }}
              onMoveStart={() => setEdgeDisconnect(null)}
              onPaneContextMenu={(e) => {
                // 画布空白处右键：拦截浏览器菜单，改为「添加节点」菜单
                e.preventDefault();
                const pt = e as React.MouseEvent;
                openPaneMenu(pt.clientX, pt.clientY);
              }}
              onEdgeContextMenu={(e) => e.preventDefault()}
              onSelectionChange={handleSelectionChange}
              deleteKeyCode={null}  /* 删除交给 useCanvasShortcuts，统一处理节点+连线 */
              /* REQ-toonflow-canvas H1：Toonflow 画布手感 —— 16 格吸附、缩放 0.2–8、滚轮平移、Ctrl/⌘+滚轮或双指捏合缩放 */
              snapToGrid
              snapGrid={SNAP_GRID}
              minZoom={0.2}
              maxZoom={8}
              zoomOnScroll={false}
              panOnScroll
              panOnScrollMode={PanOnScrollMode.Free}
              zoomOnPinch
              zoomOnDoubleClick={false}
              ariaLabelConfig={{
                'controls.ariaLabel': '画布控制栏',
                'controls.zoomIn.ariaLabel': '放大',
                'controls.zoomOut.ariaLabel': '缩小',
                'controls.fitView.ariaLabel': '适应视图',
                'controls.interactive.ariaLabel': '锁定/解锁画布交互',
              }}
              colorMode={isLight ? 'light' : 'dark'}
              className={`cv-canvas ${isLight ? 'light' : 'dark'}`}
              style={{ cursor: isDragging ? 'grabbing' : 'crosshair' }}
            >
              {/* 点阵背景（间距 16，颜色 --cv-border，底色 --cv-canvas-bg） */}
              <Background id="cv-dots" variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--cv-border)" bgColor="var(--cv-canvas-bg)" />
              {/* 框选 ≥2 个节点：排列 / 创建副本 / 成组 / 解组 */}
              <SelectionToolbar apply={(next) => { setNodes(next.nodes); setEdges(next.edges); }} idFactory={genId} />
              <Controls className="!bg-surface/80 !border-white/70 dark:border-white/12 !rounded-2xl shadow-xl ![color:var(--color-text-main)] [&_button]:!bg-surface/80 [&_button]:!border-white/70 dark:border-white/12 [&_button]:![color:var(--color-text-main)]">
                <ControlButton onClick={handleArrangeHorizontally} title="横向排布：把顶层节点排成一行" aria-label="横向排布">
                  <ArrowLeftRight className="w-3.5 h-3.5" strokeWidth={1.7} />
                </ControlButton>
              </Controls>
              {/* pannable / zoomable 必须显式打开（@xyflow/react 12 的 MiniMap 默认 false） */}
              <AutoHideMiniMap
                className="!bg-surface/80 !border-white/70 dark:border-white/12 !rounded-xl cursor-grab active:cursor-grabbing"
                maskColor={isLight ? 'rgba(15,23,42,0.12)' : 'rgba(10,10,12,0.8)'}
                maskStrokeColor={isLight ? '#7C3AED' : '#ffffff'}
                maskStrokeWidth={1}
                nodeColor={(n: any) => n.type === 'group' ? 'transparent' : n.type === 'image' || n.type === 'load-image' ? '#7C3AED' : n.type === 'video' || n.type === 'load-video' ? '#F97316' : n.type === 'audio' || n.type === 'load-audio' ? '#EC4899' : n.type === 'prompt' ? '#06B6D4' : '#3F3F50'}
                pannable
                zoomable
              />
            </ReactFlow>
          )}
        </div>
      </div>

      {/* 右侧：导演 Agent 侧栏（可收起）—— 画布上唯一的 Agent 入口 */}
      <CanvasAgentSidebar />

      <NodeAddMenu menu={nodeMenu} onPick={createFromMenu} onClose={() => setNodeMenu(null)} />
      <EdgeDisconnectButton
        state={edgeDisconnect && edges.some((e) => e.id === edgeDisconnect.id) ? edgeDisconnect : null}
        onDisconnect={(id) => setEdges((es) => es.filter((e) => e.id !== id))}
        onDismiss={() => setEdgeDisconnect(null)}
      />
      <FullscreenViewer state={viewer} onClose={() => setViewer(null)} />
      <ShotWriteBackDialog
        state={writeBack}
        data={writeBack ? (nodes.find((n) => n.id === writeBack.nodeId)?.data as Record<string, unknown> | undefined) : undefined}
        onClose={() => setWriteBack(null)}
      />
    </div>
    </CanvasHostProvider>
  );
};

export const CreativeCanvas: React.FC = () => (
  <ReactFlowProvider><InnerCanvas /></ReactFlowProvider>
);
