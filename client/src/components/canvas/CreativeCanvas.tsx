import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, ConnectionLineType, Controls, ControlButton, MiniMap, useNodesState, useEdgesState, addEdge, Connection, Edge, Node, ReactFlowProvider, useReactFlow, reconnectEdge, FinalConnectionState
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, Sparkles, Image as ImageIcon, Film, Box, Boxes, Library, Save, Download, Mic, Type, Plus, Wand2, Layers, PanelLeft, ChevronsUp, ArrowLeftRight, MoreHorizontal, Pencil, Trash2, Keyboard, X, FolderOpen, Clapperboard, FileText } from 'lucide-react';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { useProjectStore, selectSidebarCollapsed } from '../../stores/useProjectStore';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { useFeatureStore } from '../../stores/useFeatureStore';
import { apiService } from '../../services/api';
import { API_ORIGIN, resolveMediaUrl } from '../../utils/devOrigin';
import { confirmAsync, promptAsync, toast } from '../../stores/useDialogStore';
import { useCanvasSync } from './hooks/useCanvasSync';
import { executeAgentNode } from './hooks/nodeAgentExecutor';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';
import { ShotCardNode } from './nodes/ShotCardNode';
import { ComfyWorkflowNode } from './nodes/ComfyWorkflowNode';
import { BriefNode, ScriptSplitNode } from './nodes/BriefNode';
import { AssetNode } from './nodes/AssetNode';
import { VideoNode } from './nodes/VideoNode';
import { TTSNode } from './nodes/TTSNode';
import { TimelineExportNode } from './nodes/TimelineExportNode';
import { ProviderNode, ProviderImageNode, ProviderVideoNode, ProviderAudioNode } from './nodes/ProviderNode';
import { LoadImageNode, LoadImageBatchNode, LoadVideoNode, LoadAudioNode, TextPromptNode } from './nodes/LoaderNodes';
import { PromptNode, ImageNode, VideoGenNode, AudioNode, Director3DMinimalNode, ExportNode } from './nodes/MinimalNodes';
import { TimelineNode } from './nodes/TimelineNode';
import { CustomNode } from './nodes/CustomNode';
import { ExtNode } from './nodes/ExtNode';
import { WorkbenchRow } from './WorkbenchRow';
import { UISlot } from '../../ui-registry/UISlot';
import { CanvasPaletteBridgeContext, type PaletteNodeType } from '../../ui-registry/canvasPaletteBridge';
import { syncCanvasPaletteEntries, clearCanvasPaletteEntries } from '../../ui-registry/adapters/canvasPalette';
import { useUIEntries } from '../../ui-registry/resolveEnabled';
import { CANVAS_PALETTE_HOST } from '../../ui-registry/types';
import { syncCanvasNodeSpecs, listCanvasNodeSpecs, getCanvasNodeSpec } from './canvasNodeSpecs';
import { Rect, rectOf, estimateSize, placeUpstream, placeDownstream, placeNear, placeBlock, findFreeInColumn } from './autoLayout';
import { ATTACH_EVENT, DETACH_EVENT, AttachInputsDetail, DetachInputDetail } from './inputCards';
import { CanvasAgentSidebar } from './CanvasAgentSidebar';
import { NodeAgentConsole } from './NodeAgentConsole';
import { NodeContextMenu, type NodeMenuState } from './NodeContextMenu';
import { getNodeSpec } from './nodeRegistry';
import { CanvasManagerModal } from './CanvasManagerModal';
import { buildShotReferenceInputs } from '../storyboard/shotReference';
import { collectResources, planBinding } from '../storyboard/referenceBinder';
import { extractSlotsFromProvider } from './providerSkills';
import { writeBackToShot } from './shotWriteBack';
import { useCanvasShortcuts } from './hooks/useCanvasShortcuts';
import { useEscapeClose } from '../../hooks/useEscapeClose';

const nodeTypes: any = {
  // 6 核心 Agent 节点
  'prompt': PromptNode,
  'image': ImageNode,
  'video': VideoGenNode,
  'audio': AudioNode,
  'director3d': Director3DMinimalNode,
  'export': ExportNode,
  'timeline': TimelineNode,
  // 兼容旧节点
  'shot-card': ShotCardNode,
  'comfy-workflow': ComfyWorkflowNode,
  'brief': BriefNode,
  'script-split': ScriptSplitNode,
  'asset': AssetNode,
  'video-legacy': VideoNode,
  'tts': TTSNode,
  'timeline-export': TimelineExportNode,
  'provider-image': ProviderImageNode,
  'provider-video': ProviderVideoNode,
  'provider-audio': ProviderAudioNode,
  'provider': ProviderNode,
  'provider-llm': ProviderNode,
  'load-image': LoadImageNode,
  'load-image-batch': LoadImageBatchNode,
  'load-video': LoadVideoNode,
  'load-audio': LoadAudioNode,
  'text-prompt': TextPromptNode,
  'custom': CustomNode,
  'ext-node': ExtNode,
};

let idSeq = 0;
const genId = (p: string) => `${p}_${Date.now()}_${++idSeq}`;

const CORE_LIBRARY = [
  { type: 'prompt', label: '剧本 / Prompt', desc: '剧本拆解与分镜策划', icon: Type, color: 'text-sky-400' },
  { type: 'text-prompt', label: '提示词文本', desc: '纯文本资源 · 拖放/连线自动填充', icon: FileText, color: 'text-sky-400' },
  { type: 'image', label: '生图 Agent', desc: '多引擎文生图与垫图参考', icon: ImageIcon, color: 'text-violet-400' },
  { type: 'video', label: '视频 Agent', desc: '动态视频 / 首尾帧 / 参考生视频', icon: Film, color: 'text-orange-400' },
  { type: 'audio', label: '配音 Agent', desc: '多角色情感 TTS 配音', icon: Mic, color: 'text-pink-400' },
  { type: 'director3d', label: '3D导演台', desc: '机位规划与运镜指令', icon: Box, color: 'text-amber-500' },
  { type: 'export', label: '导出草稿', desc: '一键生成剪映工程', icon: Download, color: 'text-emerald-500' },
  { type: 'timeline', label: '时间线', desc: '多段合片 · 轻剪辑（合视频）', icon: Clapperboard, color: 'text-brand' },
];

const TEMPLATES = [
  { id: 't1', label: '剧本 → 生图 → 视频', desc: '漫剧创作标准链路', nodes: ['prompt', 'image', 'video'] },
  { id: 't2', label: '完整漫剧导演流', desc: '剧本 → 画面 → 视频 → 配音 → 导出', nodes: ['prompt', 'image', 'video', 'audio', 'export'] },
  { id: 't3', label: '连续镜头视频流', desc: '首帧 + 尾帧 → 连续动态视频', nodes: ['image', 'video'] },
];

/** 拖线到空白处可创建的卡片：核心卡片 + 加载类。每项按 nodeRegistry 的端口类型判断能否接上 */
const DROP_CREATE_TYPES: Array<{ type: string; label: string; icon: any; color: string }> = [
  ...CORE_LIBRARY.map(({ type, label, icon, color }) => ({ type, label, icon, color })),
  { type: 'load-image', label: '加载图片', icon: ImageIcon, color: 'text-violet-400' },
  { type: 'load-video', label: '加载视频', icon: Film, color: 'text-orange-400' },
  { type: 'load-audio', label: '加载音频', icon: Mic, color: 'text-pink-400' },
];
// 注册表与实际渲染的句柄 id 不一致处（配音卡的文本口渲染为 prompt）
const renderedHandleId = (type: string, id: string) => (type === 'audio' && id === 'text' ? 'prompt' : id);

type DropMenuState = {
  x: number; y: number;
  flow: { x: number; y: number };
  /** 缺省 = 画布右键：只建卡不连线 */
  from?: { nodeId: string; handleId: string | null; side: 'source' | 'target' };
  items: Array<{ type: string; label: string; icon: any; color: string; handleId?: string }>;
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

/**
 * 操作台条目（参考主流操作台样式）：图标方块 + 名称/说明两行 + 悬停出现的主操作。
 * 整条可点击创建、可拖入画布；不用卡片盒子包裹。
 */
// `WorkbenchRow` 已抽到 ./WorkbenchRow（宿主与「插件节点行条目」共用同一份，设计 §12）

/**
 * 底部「节点操作台」—— 只服务当前选中的生成节点（本地版观感：画布底部无常驻浮层）。
 *
 * ⚠ 适配说明：本地版这里 import 的是 `./NodeControlBar`，但新基线已删除该文件
 * （上游改用 `FloatingAgentPromptBar` 常驻「全局导演 Agent GO + 快速添加」；该文件**已废弃**
 * —— 全局编排入口由画布右侧 `CanvasAgentSidebar` 承担，见其文件头）。
 * 本轮要求「只改点名的文件」，故把本地版 NodeControlBar 的实现**内联**在本文件，
 * 逐行保持本地版的类名/文案/尺寸（682px 实色卡片、左上角节点身份标识、无说明栏、无快速添加条）。
 * 若后续允许新增文件，应把它还原成 `client/src/components/canvas/NodeControlBar.tsx`。
 */
const AGENT_NODE_TYPES = ['image', 'video', 'audio'];

/** 左上角身份标识：当前操作台正在控制哪一类节点 */
const NODE_BAR_KIND_META: Record<string, { label: string; Icon: any; iconCls: string }> = {
  image: { label: '分镜生图 Agent', Icon: ImageIcon, iconCls: 'text-violet-400' },
  video: { label: '动态导演视频 Agent', Icon: Film, iconCls: 'text-orange-400' },
  audio: { label: '配音 / 声音 Agent', Icon: Mic, iconCls: 'text-pink-400' },
};

const NodeControlBar: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const nodes = useCanvasStore((s) => s.nodes);
  const setSelectedNodeId = useCanvasStore((s) => s.setSelectedNodeId);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const isAgentNode = !!selectedNode && AGENT_NODE_TYPES.includes(selectedNode.type || '');
  const close = React.useCallback(() => {
    if (onClose) onClose();
    else setSelectedNodeId(null);
  }, [onClose, setSelectedNodeId]);
  // Esc 关闭：与全站弹窗同一套栈管理（LIFO，不会一次关穿多层）
  useEscapeClose(true, close);
  if (!isAgentNode) return null;

  const kind = selectedNode!.type as 'image' | 'video' | 'audio';
  const meta = NODE_BAR_KIND_META[kind] || NODE_BAR_KIND_META.image;
  const KindIcon = meta.Icon;

  return (
    // 宽度：内层输入框 656px + 左右 p-3(24) + 描边 2 = 682；高度由框内文本区 6 行决定 ≈ 175
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-[682px] flex flex-col items-center gap-2 pointer-events-auto">
      {/* 不用 overflow-hidden：生成源「上拉选择栏」需要越出卡片上沿浮在画布上 */}
      <div className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-[14px] shadow-xl">
        {/* 左上角只标识当前节点；原「节点 Agent 控制台 · 只说人话…」说明栏整条删除 */}
        <div className="h-9 px-3 flex items-center gap-2 border-b border-white/70 dark:border-white/12">
          <span className="w-7 h-7 rounded-md bg-surface/80 border border-white/70 dark:border-white/12 flex items-center justify-center shrink-0">
            <KindIcon className={`w-3.5 h-3.5 ${meta.iconCls}`} strokeWidth={1.7} />
          </span>
          <span className="text-[13px] font-semibold [color:var(--color-text-main)] truncate">{meta.label}</span>
          <span className="font-mono text-[10.5px] [color:var(--color-text-muted)] shrink-0">#{selectedNode!.id.slice(-4).trim()}</span>
          <button
            onClick={close}
            aria-label="收起节点操作台"
            title="收起（也可点画布空白 / Esc）"
            className="ml-auto w-6 h-6 rounded-md flex items-center justify-center [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface/80 transition-colors"
          >
            <X className="w-3.5 h-3.5" strokeWidth={1.7} />
          </button>
        </div>
        <div className="p-3">
          <NodeAgentConsole nodeId={selectedNode!.id} kind={kind} />
        </div>
      </div>
    </div>
  );
};

const InnerCanvas: React.FC = () => {
  const { project, toggleSidebar } = useProjectStore();
  const sidebarCollapsed = useProjectStore(selectSidebarCollapsed);
  const { activeProjectId } = useProjectListStore();
  const { effectiveTheme } = useThemeStore();
  const { selectedNodeId, setSelectedNodeId } = useCanvasStore();
  // 以已加载的项目为准：切项目时 list store 会先于内容加载变更，若先取它，旧画布实例会在
  // 重建前短暂挂到新 pid 上，把旧节点写进新项目。两个 store 在 setProject 里同步。
  const pid = project?.id || activeProjectId || null;
  const isLight = effectiveTheme === 'light';
  const { loadCanvas, debouncedSave } = useCanvasSync(pid);
  const { screenToFlowPosition, getViewport, fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [assets, setAssets] = useState<any[]>([]);
  const [assetQuery, setAssetQuery] = useState('');
  /**
   * 页内能力闸（功能开关，设计 §2.3.2 的页内候选拆分）：
   * `canvas_custom_nodes` = 自定义代码节点（沙箱执行，安全敏感）。关掉后画布不给入口，
   * 后端 `/api/v1/custom-nodes` 整族同时 404（同一开关，不做「后端还能跑但不显示」的假闸）。
   *
   * 读法与 `useFeatureStore` 的既定口径一致：未加载 / 拉取失败一律**当作关**（fail-closed）；
   * 出厂默认也是关（features.py 的「默认全关」契约），所以调色板里会明写一行
   *「自定义代码节点已在 设置 → 功能开关 里关闭」，避免用户以为功能坏了。
   */
  const customNodesOn = useFeatureStore((s) => s.loaded && s.values['canvas_custom_nodes'] === true);

  const [customNodes, setCustomNodes] = useState<any[]>([]);
  const refreshCustomNodes = async () => {
    if (!customNodesOn) { setCustomNodes([]); return; }  // 关掉就不拉：没人看的列表不占请求
    try {
      const r: any = await apiService.listCustomNodes();
      setCustomNodes(r.nodes || []);
    } catch {}
  };
  useEffect(() => { refreshCustomNodes(); }, [customNodesOn]);
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
      // 声明只有一份来源：`syncCanvasNodeSpecs` 整体重载全局注册表（第 26 条：原先 ExtNode
      // 另有一份节点侧 defCache、需在此额外清；现两份缓存已合并为注册表一份，重拉即全部生效）
      setExtNodes(listCanvasNodeSpecs());
    } catch {}
  };
  useEffect(() => {
    refreshExtNodes();
    const h = () => refreshExtNodes();
    window.addEventListener('canvasnode-list-refresh', h as any);
    return () => window.removeEventListener('canvasnode-list-refresh', h as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  const [saving, setSaving] = useState(false);
  const [executingNodeIds, setExecutingNodeIds] = useState<Set<string>>(new Set());
  const isGenerating = executingNodeIds.size > 0;
  const [isLoading, setIsLoading] = useState(true);
  // 多画布：隶属画布切换（默认 default；分镜右键可新建/隶属）
  const [canvasId, setCanvasId] = useState<string>('default');
  const [canvasList, setCanvasList] = useState<Array<{ id: string; name: string; updated_at: string; node_count: number }>>([]);
  const [showManager, setShowManager] = useState(false);
  // 左侧工作台：悬浮条 + 下拉面板（不再占用画布宽度）
  // 条上分块 → 点块展开面板并直接滚到该小节；点外部 / Esc / 再点同块收起
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchSection, setWorkbenchSection] = useState<WorkbenchSection>('template');
  const workbenchRef = useRef<HTMLDivElement>(null);
  const workbenchSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  useEffect(() => {
    if (!workbenchOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setWorkbenchOpen(false); };
    const onDown = (e: MouseEvent) => {
      // 注意：本文件从 @xyflow/react 引入了 Node（节点类型），DOM 判断要用 Element
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
  // 展开/切换分块后滚到对应小节（scroll-behavior 由容器 motion-safe:scroll-smooth 决定，
  // prefers-reduced-motion 下自动降级为瞬时跳转）
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
  // 节点右键菜单（添加到会话 / 删除）
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [dropMenu, setDropMenu] = useState<DropMenuState | null>(null);
  const canvasIdRef = useRef<string>('default');
  useEffect(() => { canvasIdRef.current = canvasId; }, [canvasId]);
  // 切换/新建/删除清空时的单次保存抑制，避免空画布写回旧 id 复活已删画布
  const suppressSaveRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  // 当前 pid/画布的内容是否已真正载入：载入完成前 nodes 还是空数组/旧画布，此时绝不能落盘，
  // 否则会用空画布覆盖磁盘上的真实内容
  const hydratedRef = useRef(false);
  const pidRef = useRef<string | null>(null);
  const canvasRef = useRef<string>('default');
  const [isDragging, setIsDragging] = useState(false);

  // open-workflow-inspector 已由 App 全局接管（任何页面可开槽位配置）：
  // 本地版画布内还留着一份监听 + 自渲染弹窗，新基线 App 也渲染全局弹窗 →
  // 同一次事件会弹出两个 WorkflowInspectorModal。此处按新基线收敛，只保留 App 那份。

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
      // 切画布时的单次抑制本为挡住「清空→落盘」；载入前的保存已被 hydratedRef 挡住，这里归零，
      // 免得空画布（snap 为 null 不触发 setNodes）时吞掉用户的第一次编辑
      suppressSaveRef.current = false;
      if (snap && Array.isArray(snap.nodes)) {
        const withHandlers = snap.nodes.map((n: any) => {
          const nd = { ...(n.data || {}) };
          // 重启/重载复位：running 是进程内态，持久化后重载必为幽灵“执行中”；复位 idle 但保留 _taskId 以便恢复查询
          if (nd?.agent_state?.status === 'running') {
            const tid = nd._taskId || nd._last_agent_plan?.task_id || '';
            nd.agent_state = {
              status: 'idle', tool: nd.agent_state?.tool, provider_id: nd.agent_state?.provider_id,
              error: tid ? `服务中断前任务状态未知，task_id=${tid} 已保留，可重新查询` : '服务中断前任务状态未知，已复位为空闲',
              updated_at: new Date().toISOString(),
            };
            nd._polling = false;
          }
          // selected 不还原：开合是纯 UI 态，落盘的 selected:true 重载时会复活选中 → 控制台自动弹出（P2-2）
          return { ...n, selected: false, data: { ...nd, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } };
        });
        setNodes(withHandlers);
        if (Array.isArray(snap.edges)) setEdges(snap.edges);
        // 不在加载时自动选中第一个节点：刷新后控制台自动弹出即由此而来（P2-2）；
        // 用户点哪个节点，控制台才服务哪个节点。
      }
      clearTimeout(timer);
      setIsLoading(false);
      // 分镜导入在画布切换后到达：载入完成再建子图并自动生成
      if (pendingBuildRef.current) {
        setTimeout(() => { try { continuePendingBuildRef.current?.(); } catch {} }, 600);
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
  }, [pid, canvasId]);

  // 800ms 防抖同步（带当前画布 id）
  useEffect(() => {
    if (!pid || !loadedRef.current || !hydratedRef.current) return;
    if (suppressSaveRef.current) { suppressSaveRef.current = false; return; }
    let vp: any = {};
    try { vp = getViewport(); } catch {}
    // 选中态不落盘（纯 UI 态）：否则带着 selected:true 的快照在重载时会复活选中（P2-2）
    const snap = { nodes: nodes.map((n) => ({ ...n, selected: false })), edges, viewport: vp, updated_at: new Date().toISOString(), version: 2 };
    debouncedSave(snap, canvasIdRef.current);
    try { useCanvasStore.getState().setFromFlow(nodes as any, edges as any); } catch {}
  }, [nodes, edges]);

  // 节点更新与下游级联传播（全量 Provider 句柄复用）
  const edgesRef = useRef(edges);
  const nodesRef = useRef(nodes);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // 连线渲染层（只影响显示，不写回 edges 状态 / 不落盘）：
  // · 存量 smoothstep / step 折线统一画成平滑贝塞尔曲线
  // · 选中卡片 → 其整条上游 + 下游链路上的连线高亮并流动（方向即数据流向），其余连线淡化
  const renderedEdges = useMemo(() => {
    const focus = new Set<string>(nodes.filter((n) => n.selected).map((n) => n.id));
    if (selectedNodeId) focus.add(selectedNodeId);
    const related = new Set<string>();
    if (focus.size) {
      const bySource = new Map<string, Edge[]>();
      const byTarget = new Map<string, Edge[]>();
      for (const e of edges) {
        if (!bySource.has(e.source)) bySource.set(e.source, []);
        bySource.get(e.source)!.push(e);
        if (!byTarget.has(e.target)) byTarget.set(e.target, []);
        byTarget.get(e.target)!.push(e);
      }
      const walk = (adj: Map<string, Edge[]>, nextOf: (e: Edge) => string) => {
        const seen = new Set<string>(focus);
        const stack = [...focus];
        while (stack.length) {
          for (const e of adj.get(stack.pop()!) || []) {
            related.add(e.id);
            const nx = nextOf(e);
            if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
          }
        }
      };
      walk(bySource, (e) => e.target); // 下游
      walk(byTarget, (e) => e.source); // 上游
    }
    return edges.map((e) => {
      const hl = related.has(e.id);
      const type = !e.type || e.type === 'smoothstep' || e.type === 'step' || e.type === 'straight' ? 'default' : e.type;
      const cls = hl ? 'canvas-edge-hl' : focus.size ? 'canvas-edge-dim' : '';
      return {
        ...e,
        type,
        animated: hl,
        zIndex: hl ? 1 : 0,
        className: [e.className, cls].filter(Boolean).join(' ') || undefined,
      };
    });
  }, [nodes, edges, selectedNodeId]);
  const handleNodeUpdate = useCallback((nodeId: string, patch: any) => {
    setNodes(nds => {
      let next = nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute } } : n);
      // 产出/输入键变化才向下游传播；键 → 语义一律来自「边上的 targetHandle + 目标节点结构声明」，不再写死别名组
      const OUTPUT_KEYS = ['image_url', 'result_url', 'video_url', 'audio_url', 'prompt', 'text', 'camera_prompt', 'reference_images', 'reference', 'first_frame', 'last_frame', 'ref_audio'];
      const propagatable = OUTPUT_KEYS.some(k => patch[k] !== undefined);
      if (propagatable) {
        const srcData = next.find(n => n.id === nodeId)?.data as any;
        const downstreamEdges = (edgesRef.current || edges).filter((e: any) => e.source === nodeId);
        for (const e of downstreamEdges) {
          const tgtIdx = next.findIndex(n => n.id === e.target);
          if (tgtIdx === -1) continue;
          const tgt = next[tgtIdx];
          const tgtSpec = getNodeSpec(tgt.type || '');
          const th = (e as any).targetHandle || '';
          const inDef = tgtSpec?.inputs.find(h => h.id === th) || (th ? undefined : tgtSpec?.inputs.find(h => ['image','video','audio','text'].includes(h.type)));
          const hType = inDef?.type || '';
          const patchDown: any = { _upstream: { ...((tgt.data as any)._upstream || {}) } };
          const setKey = (k: string, v: any) => { if (v !== undefined && v !== null) { patchDown[k] = v; patchDown._upstream[k] = v; } };
          if (hType === 'image') {
            const img = patch.image_url || patch.result_url || patch.first_frame || patch.reference || (Array.isArray(patch.reference_images) ? patch.reference_images[0] : patch.reference_images) || srcData?.image_url || srcData?.result_url;
            const arr = Array.isArray(patch.reference_images) ? patch.reference_images : undefined;
            const curVal = (tgt.data as any)[inDef!.id];
            if (Array.isArray(curVal) || /reference_images|(^|_)images$/.test(inDef!.id)) {
              // 数组槽（参考集）可由多张卡片共同汇入：只替换本卡上一次贡献的那几项，不能整组覆盖
              const prevSrc: any = nds.find(n => n.id === nodeId)?.data || {};
              const oldVals = [prevSrc.image_url, prevSrc.result_url, prevSrc.image, prevSrc.url,
                ...(Array.isArray(prevSrc.reference_images) ? prevSrc.reference_images : []),
                ...(Array.isArray(prevSrc.images) ? prevSrc.images : [])].filter(Boolean);
              const incoming: string[] = arr || (img ? [img] : []);
              const merged: string[] = (Array.isArray(curVal) ? curVal : (curVal ? [curVal] : [])).filter((u: string) => !oldVals.includes(u));
              for (const u of incoming) if (u && !merged.includes(u)) merged.push(u);
              setKey(inDef!.id, merged);
            } else if (img) setKey(inDef!.id, img);
          } else if (hType === 'video') {
            setKey(inDef!.id, patch.video_url || srcData?.video_url);
          } else if (hType === 'audio') {
            setKey(inDef!.id, patch.audio_url || patch.ref_audio || srcData?.audio_url);
          } else if (hType === 'text') {
            const txt = patch.prompt ?? patch.text ?? patch.camera_prompt ?? srcData?.prompt ?? srcData?.text ?? srcData?.camera_prompt;
            setKey(inDef!.id, typeof txt === 'string' ? txt : undefined);
          }
          // params 类键（源声明的入参）原样透传，不在此层做语义解释
          for (const [k, v] of Object.entries(patch)) {
            if (OUTPUT_KEYS.includes(k) || k === '_upstream') continue;
            if (v !== undefined) { patchDown[k] = v; patchDown._upstream[k] = v; }
          }
          next[tgtIdx] = { ...tgt, data: { ...tgt.data, ...patchDown, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute, _upstream: patchDown._upstream } } as any;
        }
      }
      return next;
    });
  }, [edges]);

  // 执行节点生成 — 统一口径：image/video/audio 走 nodeAgentExecutor（MCP provider_* + 轮询 + agent_state），
  // prompt/director3d/旧节点 走各自通道，彻底消除双轨分叉；按 nodeId 独立异步
  const handleNodeExecute = useCallback(async (nodeId: string, customData?: any) => {
    const curNodes = nodesRef.current || nodes;
    const node = curNodes.find(n => n.id === nodeId);
    if (!node) return;
    setExecutingNodeIds(prev => new Set(prev).add(nodeId));
    try {
      if (node.type === 'prompt') {
        const d: any = { ...node.data, ...(customData || {}) };
        const textToProcess = (d.prompt || d.text || '').trim();
        if (!textToProcess) { handleNodeUpdate(nodeId, { text: '', prompt: '' }); return; }
        const skillId = d.skill_id || '';
        if (skillId === 'script_generation') {
          const res = await apiService.parseScript(textToProcess, d.style_preset || 'donghua_xianxia', d.aspect_ratio || '9:16');
          const scriptText = res?.scenes?.map((s: any) => `【场景 ${s.scene_index}】\n` + s.shots?.map((sh: any) => `镜头 ${sh.shot_index}: [${sh.camera_framing}] ${sh.action_desc}\n台词: ${sh.dialogue || '（无对白）'}`).join('\n\n')).join('\n\n') || textToProcess;
          handleNodeUpdate(nodeId, { text: scriptText, prompt: scriptText, script_data: res, agent_state: { status: 'completed', tool: 'split_novel_script', updated_at: new Date().toISOString() } });
        } else if (skillId === 'proposal_generation') {
          const r: any = await apiService.callMcpTool('split_novel_script', { novel_text: textToProcess, style_preset: d.style_preset || 'donghua_xianxia', aspect_ratio: d.aspect_ratio || '9:16' }).catch(async () => {
            // 降级：直接调 LLM 透传
            const res2 = await fetch(`${API_ORIGIN}/api/v1/agent/chat`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prompt: textToProcess, context: { skill: 'proposal' } })}).then(r=>r.json()).catch(()=>null);
            return { result: res2 };
          });
          const content = r?.result?.content || r?.result?.project || textToProcess;
          handleNodeUpdate(nodeId, { text: typeof content==='string'?content:JSON.stringify(content).slice(0,2000), prompt: typeof content==='string'?content:textToProcess });
        } else if (skillId === 'prompt_expansion') {
          handleNodeUpdate(nodeId, { agent_state: { status: 'running', tool: 'llm/expand', updated_at: new Date().toISOString() } });
          try {
            const expanded = await apiService.expandPrompt(textToProcess, 'image');
            if (!expanded) throw new Error('扩写返回为空');
            handleNodeUpdate(nodeId, { text: expanded, prompt: expanded, agent_state: { status: 'completed', tool: 'llm/expand', updated_at: new Date().toISOString() } });
          } catch (e: any) {
            handleNodeUpdate(nodeId, { agent_state: { status: 'failed', tool: 'llm/expand', error: String(e?.message || e).slice(0, 200), updated_at: new Date().toISOString() } });
            throw e;
          }
        } else {
          handleNodeUpdate(nodeId, { text: textToProcess, prompt: textToProcess });
        }
      } else if (['image', 'video', 'audio'].includes(node.type || '')) {
        await executeAgentNode({ node, override: customData, updateNodeData: handleNodeUpdate });
      } else if (node.type === 'director3d') {
        const d: any = { ...node.data, ...(customData || {}) };
        // 与 3D 舞台 / useDirectorAgent 同口径 8 参数（之前缺 cast_layout/speed 会被后端静默回退）
        const res = await apiService.callMcpTool('director_3d_stage_plan', { framing: d.framing || 'medium', motion: d.motion || 'push_in', pose: d.pose || 'stand', focal_length_mm: d.focal_length_mm || 35, camera_roll_deg: d.camera_roll_deg || 0, cast_layout: d.cast_layout || 'solo', speed: d.speed || '1.0x', ai_directive: d.ai_directive || '' });
        const r = (res as any)?.result || res;
        handleNodeUpdate(nodeId, { minimax_camera_prompt: r.minimax_camera_prompt || JSON.stringify(r).slice(0, 200), ...r });
      } else {
        // 兼容旧节点 + 声明式扩展节点（ext-node）：经由 Canvas DAG 引擎执行（复用 Provider 系统）
        const d: any = { ...node.data, ...(customData || {}) };
        if (node.type === 'ext-node') delete d.definition; // 大字段不上行，引擎按 canvas_node_id 重读声明
        const projectId = (window as any).__activePid || useProjectStore.getState().project?.id || undefined;
        const resp = await fetch(`${API_ORIGIN}/api/v1/canvas/node/execute`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ node: { id: nodeId, type: node.type, data: d }, project_id: projectId }) }).then(r=>r.json());
        if (resp?.result?.status === 'success') {
          const rr = resp.result;
          const patch: any = {};
          if (rr.image_url) { patch.image_url = rr.image_url; patch.result_url = rr.image_url; }
          if (rr.video_url) patch.video_url = rr.video_url;
          if (rr.audio_url) patch.audio_url = rr.audio_url;
          if (rr.prompt) patch.prompt = rr.prompt;
          if (typeof rr.text === 'string' && rr.text) patch.text = rr.text;
          if (rr.outputs && typeof rr.outputs === 'object') patch.outputs = rr.outputs;
          handleNodeUpdate(nodeId, patch);
        } else if (resp?.result?.error || resp?.detail) {
          throw new Error(resp.result?.error || resp.detail);
        }
      }
    } catch (e: any) {
      alert(`生成失败: ${e.message || e}`);
    } finally {
      setExecutingNodeIds(prev => { const n = new Set(prev); n.delete(nodeId); return n; });
    }
  }, [nodes]);

  // 必须 memo：ReactFlow 把 onSelectionChange 放进 effect 依赖，
  // 传内联箭头会每次渲染重订阅→回调→setState→再渲染，直接 Maximum update depth
  const handleSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    setSelectedNodeId(sel.length ? sel[sel.length - 1].id : null);
  }, []);

  // 关闭节点控制台：除清 store 外，同步清掉 React Flow 的节点选中态——
  // 否则残留的 selected 会在下一次选中事件里把控制台拉回来（P2-2）
  const closeNodeConsole = useCallback(() => {
    setSelectedNodeId(null);
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
  }, [setSelectedNodeId, setNodes]);

  // 节点运行时回调：撤销/粘贴还原节点后必须重新挂上，否则卡上的按钮全哑
  const attachHandlers = useCallback(
    (n: Node): Node => ({
      ...n,
      data: { ...(n.data as any), onUpdate: handleNodeUpdate, onExecute: handleNodeExecute },
    }),
    [handleNodeUpdate, handleNodeExecute],
  );

  // 撤销 / 重做 / 复制 / 粘贴 / 删除
  useCanvasShortcuts({
    enabled: !!pid && loadedRef.current,
    nodes, edges, setNodes, setEdges,
    attachHandlers, genId,
    onSelect: setSelectedNodeId,
  });

  // 从已连线的输入点「拎起」的那条线：松手连到别处 = 改接；松在空白 = 断开；被拒（类型不符）= 还原
  const pickedEdge = useRef<{ edge: Edge | null; connected: boolean }>({ edge: null, connected: false });
  const rfWrapRef = useRef<HTMLDivElement>(null);

  const isValidConnection: any = useCallback((connection: any) => {
    const c: Connection = connection;
    const src = nodes.find(n => n.id === c.source);
    const tgt = nodes.find(n => n.id === c.target);
    if (!src || !tgt) return true;
    const srcSpec = getNodeSpec(src.type || '');
    const tgtSpec = getNodeSpec(tgt.type || '');
    if (!srcSpec || !tgtSpec) return true;
    const srcOut = srcSpec.outputs.find(h => h.id === c.sourceHandle) || srcSpec.outputs[0];
    const tgtIn = tgtSpec.inputs.find(h => h.id === c.targetHandle) || tgtSpec.inputs[0];
    if (!srcOut || !tgtIn) return true;
    if (srcOut.type === tgtIn.type) return true;
    if (tgtIn.type === 'text' && srcOut.type === 'text') return true;
    return srcOut.type === tgtIn.type;
  }, [nodes]);

  const onConnect = useCallback((params: Connection) => {
    pickedEdge.current.connected = true;
    if (!isValidConnection(params)) {
      pickedEdge.current.connected = false;
      alert('连线类型不匹配');
      return;
    }
    setEdges(es => addEdge({ ...params, type: 'default' } as any, es as any));
    setTimeout(() => {
      const sourceId = params.source;
      const targetId = params.target;
      if (!sourceId || !targetId) return;
      setNodes(nds => {
        const srcNode = nds.find(n => n.id === sourceId);
        const tgtNode = nds.find(n => n.id === targetId);
        if (!srcNode || !tgtNode) return nds;
        const srcData: any = srcNode.data;
        const tgtHandle = (params.targetHandle || '') as string;
        const patch: any = {};
        const srcType = srcNode.type || '';
        // 目标句柄类型 = 节点结构声明（nodeRegistry），值写回一律按句柄键本身，不做别名镜像
        const tgtSpec = getNodeSpec(tgtNode.type || '');
        const handleTypeOf = (hid: string): string => tgtSpec?.inputs.find(h => h.id === hid)?.type || '';
        const ht = handleTypeOf(tgtHandle);
        if (['prompt', 'text-prompt', 'brief'].includes(srcType)) {
          const txt = srcData.prompt || srcData.text || srcData.brief || '';
          // 文本按目标句柄键写入；无句柄信息时按目标节点声明的首个 text 输入
          const key = tgtHandle || tgtSpec?.inputs.find(h => h.type === 'text')?.id || 'prompt';
          if (txt) patch[key] = txt;
        }
        const srcMedia = srcData.image_url || srcData.result_url || srcData.image || srcData.url || srcData.file_url;
        if (['image', 'shot-card', 'comfy-workflow', 'load-image', 'load-image-batch'].includes(srcType) && srcMedia) {
          if (ht === 'image') {
            const urlArr = Array.isArray(srcData.reference_images) ? srcData.reference_images : (Array.isArray(srcData.images) ? srcData.images : [srcMedia]);
            const existing = Array.isArray((tgtNode.data as any)[tgtHandle]) ? (tgtNode.data as any)[tgtHandle] : [];
            const merged = [...existing, ...urlArr.filter((u: string) => !existing.includes(u))];
            patch[tgtHandle || 'reference_images'] = urlArr.length > 1 || (tgtHandle && Array.isArray((tgtNode.data as any)[tgtHandle])) ? merged : srcMedia;
          } else {
            patch.image_url = srcMedia;
          }
        }
        const srcVideo = srcData.video_url || (srcType === 'load-video' ? (srcData.video || srcData.url) : '');
        if (['video', 'load-video'].includes(srcType) && srcVideo) {
          patch.video_url = srcVideo;
          if (ht === 'video' && tgtHandle && tgtHandle !== 'video_url') patch[tgtHandle] = srcVideo;
        }
        const srcAudio = srcData.audio_url || (srcType === 'load-audio' ? (srcData.audio || srcData.url) : '');
        if (['audio', 'tts', 'load-audio'].includes(srcType) && srcAudio) {
          if (ht === 'audio' && tgtHandle) patch[tgtHandle] = srcAudio;
          else patch.audio_url = srcAudio;
        }
        if (srcType === 'director3d') {
          const cam = srcData.camera_prompt || '';
          if (cam) patch[tgtHandle || 'camera_prompt'] = cam;
        }
        // Provider 节点透传
        if (['provider-image','provider-video','provider-audio','provider','provider-llm'].includes(srcType)) {
          const pid = srcData.provider_id || srcData.providerId || srcData.id;
          if (pid) { patch.provider_id = pid; patch.provider = pid; }
          if (srcData.model) patch.model = srcData.model;
        }
        if (Object.keys(patch).length) {
          return nds.map(n => n.id === targetId ? { ...n, data: { ...n.data, ...patch, _upstream: { ...(n.data as any)._upstream, ...patch } } } : n);
        }
        return nds;
      });
    }, 0);
  }, [isValidConnection]);

  // ── 拖线松手在空白处：弹出「创建可接上的卡片」菜单 ──
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const picked = pickedEdge.current;
    if (picked.edge) {
      const edge = picked.edge;
      pickedEdge.current = { edge: null, connected: false };
      // 松在某个口上但没连成（类型不符/同一个口）→ 还原原线；松在空白 → 即断开，不弹创建菜单
      if (!picked.connected && state.toHandle) setEdges((es) => [...es, edge]);
      return;
    }
    if (state.isValid || state.toNode || !state.fromNode || !state.fromHandle) return;
    const fromNode = state.fromNode;
    const side = state.fromHandle.type; // 'source' = 从输出拖出，'target' = 从输入拖出
    const fromSpec = getNodeSpec(fromNode.type || '');
    const fromList = side === 'source' ? fromSpec?.outputs : fromSpec?.inputs;
    const hid = state.fromHandle.id || null;
    const fromDef = fromList?.find((h) => renderedHandleId(fromNode.type || '', h.id) === hid) || fromList?.[0];
    if (!fromDef) return;
    const items = DROP_CREATE_TYPES.flatMap((c) => {
      const spec = getNodeSpec(c.type);
      const pool = (side === 'source' ? spec?.inputs : spec?.outputs) || [];
      // 同类型端口里优先同名（如 机位→camera_prompt），否则取第一个
      const match = pool.find((h) => h.type === fromDef.type && h.id === fromDef.id) || pool.find((h) => h.type === fromDef.type);
      return match ? [{ ...c, handleId: renderedHandleId(c.type, match.id) }] : [];
    });
    if (!items.length) return;
    const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
    setDropMenu({
      x: pt.clientX, y: pt.clientY,
      flow: screenToFlowPosition({ x: pt.clientX, y: pt.clientY }),
      from: { nodeId: fromNode.id, handleId: hid, side },
      items,
    });
  }, [screenToFlowPosition]);

  const createFromDrop = (item: DropMenuState['items'][number]) => {
    if (!dropMenu) return;
    const { flow, from } = dropMenu;
    const { w, h } = estimateSize(item.type);
    if (!from) {
      // 画布右键：左上角落在右键位置
      const node = createNode(item.type, flow);
      setNodes((nds) => [...nds, node]);
      setSelectedNodeId(node.id);
      setDropMenu(null);
      return;
    }
    // 从输出拖出 → 新卡放在落点右侧；从输入拖出 → 新卡放在落点左侧
    const node = createNode(item.type, { x: from.side === 'source' ? flow.x + 24 : flow.x - w - 24, y: flow.y - h / 2 });
    setNodes((nds) => [...nds, node]);
    setSelectedNodeId(node.id);
    const params: Connection = from.side === 'source'
      ? { source: from.nodeId, sourceHandle: from.handleId, target: node.id, targetHandle: item.handleId ?? null }
      : { source: node.id, sourceHandle: item.handleId ?? null, target: from.nodeId, targetHandle: from.handleId };
    onConnect(params); // 复用连线逻辑：建边 + 把上游数据灌进新卡
    setDropMenu(null);
  };

  // ── 已连线的输入点按下 = 拎起这条线（而不是再拉一条新线）：
  // 删掉原边，在其上游输出点上补发一次 mousedown，让 React Flow 从上游开始一次连线拖拽
  useEffect(() => {
    // 挂在 document 捕获阶段（画布可能晚于本 effect 挂载），只处理画布内的按下
    const onDown = (e: MouseEvent) => {
      const wrap = rfWrapRef.current;
      if (!wrap || e.button !== 0 || (e as any).__picked || !wrap.contains(e.target as any)) return;
      const h = (e.target as HTMLElement).closest?.('.react-flow__handle.target') as HTMLElement | null;
      const nodeId = h?.closest('.react-flow__node')?.getAttribute('data-id');
      if (!h || !nodeId) return;
      const hid = h.getAttribute('data-handleid');
      const edge = (edgesRef.current || []).find((ed) => ed.target === nodeId && (ed.targetHandle ?? null) === (hid ?? null));
      if (!edge) return;
      const srcNodeEl = wrap.querySelector(`.react-flow__node[data-id="${CSS.escape(edge.source)}"]`);
      const srcHandle = (edge.sourceHandle
        ? srcNodeEl?.querySelector(`.react-flow__handle.source[data-handleid="${CSS.escape(edge.sourceHandle)}"]`)
        : srcNodeEl?.querySelector('.react-flow__handle.source')) as HTMLElement | null;
      if (!srcHandle) return; // 上游不在画面里（被虚拟化等）→ 走默认行为
      e.stopPropagation();
      e.preventDefault();
      pickedEdge.current = { edge, connected: false };
      setEdges((es) => es.filter((x) => x.id !== edge.id));
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 0, buttons: 1 });
      (ev as any).__picked = true;
      srcHandle.dispatchEvent(ev);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [setEdges]);

  // ── 拖动已有连线的端点：拖到别的口 = 改接，拖到空白处 = 断开 ──
  const reconnectOk = useRef(true);
  const onReconnectStart = useCallback(() => { reconnectOk.current = false; }, []);
  const onReconnect = useCallback((oldEdge: Edge, conn: Connection) => {
    reconnectOk.current = true;
    if (!isValidConnection(conn)) { alert('连线类型不匹配'); return; }
    setEdges((es) => reconnectEdge(oldEdge, conn, es));
  }, [isValidConnection, setEdges]);
  const onReconnectEnd = useCallback((_: MouseEvent | TouchEvent, edge: Edge) => {
    if (!reconnectOk.current) setEdges((es) => es.filter((e) => e.id !== edge.id));
    reconnectOk.current = true;
  }, [setEdges]);

  // ── 自动放置（规则见 autoLayout.ts）：所有「程序替用户放卡片」的入口都走这几个 helper，保证不重叠 ──
  const occupiedRects = (extra: Node[] = []): Rect[] => [...((nodesRef.current as Node[]) || []), ...extra].map((n) => rectOf(n as any));
  /** 视口中上部（落在用户眼前），作为独立卡的放置锚点 */
  const viewportAnchor = (): { x: number; y: number } => {
    const el = wrapperRef.current;
    if (!el) return { x: 120, y: 120 };
    const r = el.getBoundingClientRect();
    const p = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 });
    return { x: p.x - 180, y: p.y - 120 };
  };
  /** 独立卡：视口锚点所在列向下找空位 */
  const freePosition = (type: string): { x: number; y: number } => {
    const { w, h } = estimateSize(type);
    return placeNear(occupiedRects(), viewportAnchor(), w, h);
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

  const createNode = (type: string, position: { x: number; y: number }, extraData?: Record<string, any>) => {
    const node: Node = {
      id: genId(type),
      type: type as any,
      position,
      data: { onUpdate: handleNodeUpdate, onExecute: handleNodeExecute, ...(extraData || {}) },
    };
    if (type === 'prompt') node.data = { ...node.data, prompt: '' };
    if (type === 'image') node.data = { ...node.data, prompt: '' };
    if (type === 'video') node.data = { ...node.data, prompt: '', duration: 5 };
    if (type === 'audio') node.data = { ...node.data, text: '' };
    if (type === 'director3d') node.data = { ...node.data, framing: 'medium', motion: 'push_in' };
    return node;
  };

  /* ── 插件节点行（custom_nodes / canvas_nodes）的桥接与注册（设计 §12）─────────────────
     宿主注入 `createNode`（视口位置、节点 state、选中逻辑只有宿主知道），条目只声明「创建哪种节点」。
     实现走 ref：`createNode` / `freePosition` 每次渲染都会重建，ref 让 context 值保持稳定，
     调色板里的每一行就不会跟着画布重渲染。 */
  const paletteCreateRef = useRef<(type: PaletteNodeType, data?: Record<string, any>) => void>(() => {});
  useEffect(() => {
    paletteCreateRef.current = (type, data) => {
      const node = createNode(type, freePosition(type), data);
      setNodes((nds) => [...nds, node]);
      setSelectedNodeId(node.id);
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
  // 两张清单任一变化 → 重新把声明送进注册表（行增删立即可见）；画布卸载 → 清空，不留陈旧行
  useEffect(() => { syncCanvasPaletteEntries(customNodes, extNodes); }, [customNodes, extNodes]);
  useEffect(() => () => clearCanvasPaletteEntries(), []);

  const addTemplate = (tpl: any) => {
    // 组内横向排开（列间距同 autoLayout），整组放到现有内容下方，不压已有卡片
    let colX = 0;
    const newNodes: Node[] = placeNewBlock(tpl.nodes.map((t: string) => {
      const n = createNode(t, { x: colX, y: 0 });
      colX += estimateSize(t).w + 120;
      return n;
    }));
    const newEdges: Edge[] = [];
    // 智能模板连线：区分线性链与分支（video/audio 并行汇入 export）
    for (let i = 1; i < newNodes.length; i++) {
      const prev = newNodes[i - 1];
      const cur = newNodes[i];
      // 跳过非法 video(prompt) -> audio(text) 直连，audio 应从 prompt 分支
      if (prev.type === 'video' && cur.type === 'audio') {
        // 改为 prompt 节点分叉到 audio
        const promptNode = newNodes.find(n => n.type === 'prompt');
        if (promptNode) {
          newEdges.push({ id: `e_${promptNode.id}_${cur.id}`, source: promptNode.id, target: cur.id, sourceHandle: 'prompt', targetHandle: 'text', type: 'default' } as any);
        }
        continue;
      }
      let sh = 'prompt', th = 'prompt';
      if (prev.type === 'prompt' && cur.type === 'image') { sh = 'prompt'; th = 'prompt'; }
      else if (prev.type === 'image' && cur.type === 'video') { sh = 'image'; th = 'first_frame'; }
      else if (prev.type === 'audio' && cur.type === 'export') { sh = 'audio'; th = 'audio'; }
      else if (prev.type === 'video' && cur.type === 'export') { sh = 'video'; th = 'video'; }
      else if (prev.type === 'prompt' && cur.type === 'video') { sh = 'prompt'; th = 'prompt'; }
      else if (prev.type === 'prompt' && cur.type === 'audio') { sh = 'prompt'; th = 'text'; }
      else {
        // 兜底：按 Registry 类型匹配，否则跳过
        const ps = getNodeSpec(prev.type || '');
        const ts = getNodeSpec(cur.type || '');
        if (ps && ts && ps.outputs[0] && ts.inputs[0] && ps.outputs[0].type !== ts.inputs[0].type) continue;
      }
      newEdges.push({ id: `e_${prev.id}_${cur.id}`, source: prev.id, target: cur.id, sourceHandle: sh, targetHandle: th, type: 'default' } as any);
    }
    // 完整链路模板收尾：若同时存在 video 与 audio，共同汇入 export
    if (tpl.id === 't2') {
      const videoNode = newNodes.find(n => n.type === 'video');
      const exportNode = newNodes.find(n => n.type === 'export');
      const audioNode = newNodes.find(n => n.type === 'audio');
      if (videoNode && exportNode && !newEdges.some(e => e.source === videoNode.id && e.target === exportNode.id)) {
        newEdges.push({ id: `e_${videoNode.id}_${exportNode.id}`, source: videoNode.id, target: exportNode.id, sourceHandle: 'video', targetHandle: 'video', type: 'default' } as any);
      }
      if (audioNode && exportNode && !newEdges.some(e => e.source === audioNode.id && e.target === exportNode.id)) {
        newEdges.push({ id: `e_${audioNode.id}_${exportNode.id}`, source: audioNode.id, target: exportNode.id, sourceHandle: 'audio', targetHandle: 'audio', type: 'default' } as any);
      }
    }
    setNodes(nds => [...nds, ...newNodes]);
    setEdges(es => [...es, ...newEdges]);
    if (newNodes.length > 0) setSelectedNodeId(newNodes[0].id);
    revealNodes(newNodes.map(n => n.id));
  };

  // Creator 模板（Agent 创造模式产物，storage/canvas_templates）：从模板新建节点链
  const [creatorTemplates, setCreatorTemplates] = useState<any[]>([]);
  const refreshCreatorTemplates = async () => {
    try {
      const r: any = await apiService.listCreatorTemplates();
      setCreatorTemplates(r.templates || []);
    } catch {}
  };
  useEffect(() => {
    refreshCreatorTemplates();
    const h = () => refreshCreatorTemplates();
    window.addEventListener('creator-template-refresh', h as any);
    return () => window.removeEventListener('creator-template-refresh', h as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const addCreatorTemplate = (tpl: any) => {
    const KEY2TYPE: Record<string, string> = {
      image: 'image', video: 'video', audio: 'audio',
      prompt: 'prompt', text: 'prompt',
      director: 'director3d', director3d: 'director3d', export: 'export',
    };
    const idByKey: Record<string, string> = {};
    let newNodes: Node[] = [];
    for (const n of (tpl.nodes || [])) {
      const key = String(n.key || '');
      const type = KEY2TYPE[key];
      if (!type) continue;
      const node = createNode(type, { x: Number(n.x) || 0, y: Number(n.y) || 0 });
      idByKey[key] = node.id;
      newNodes.push(node);
    }
    if (newNodes.length === 0) { alert('该模板无可用节点（未知节点类型已跳过）'); return; }
    // 模板自带相对布局，整组放到现有内容下方
    newNodes = placeNewBlock(newNodes);
    const byId: Record<string, Node> = {};
    newNodes.forEach(n => { byId[n.id] = n; });
    const inferHandles = (prevType: string, curType: string): [string, string] | null => {
      if (prevType === 'video' && curType === 'audio') return null; // 需经 prompt 分叉，调用方处理
      if (prevType === 'prompt' && curType === 'image') return ['prompt', 'prompt'];
      if (prevType === 'image' && curType === 'video') return ['image', 'first_frame'];
      if (prevType === 'audio' && curType === 'export') return ['audio', 'audio'];
      if (prevType === 'video' && curType === 'export') return ['video', 'video'];
      if (prevType === 'prompt' && curType === 'video') return ['prompt', 'prompt'];
      if (prevType === 'prompt' && curType === 'audio') return ['prompt', 'text'];
      const ps = getNodeSpec(prevType || '');
      const ts = getNodeSpec(curType || '');
      if (ps && ts && ps.outputs[0] && ts.inputs[0] && ps.outputs[0].type === ts.inputs[0].type) {
        return [ps.outputs[0].id || 'prompt', ts.inputs[0].id || 'prompt'];
      }
      return null;
    };
    const newEdges: Edge[] = [];
    const promptNode = newNodes.find(n => n.type === 'prompt');
    for (const e of (tpl.edges || [])) {
      const sid = idByKey[String(e.from || '')];
      const tid = idByKey[String(e.to || '')];
      if (!sid || !tid) continue;
      const prev = byId[sid], cur = byId[tid];
      let pair = inferHandles(prev.type as string, cur.type as string);
      if (!pair && prev.type === 'video' && cur.type === 'audio' && promptNode) {
        pair = null;
        newEdges.push({ id: `e_${promptNode.id}_${cur.id}`, source: promptNode.id, target: cur.id, sourceHandle: 'prompt', targetHandle: 'text', type: 'default' } as any);
        continue;
      }
      if (!pair) continue;
      newEdges.push({ id: `e_${sid}_${tid}`, source: sid, target: tid, sourceHandle: pair[0], targetHandle: pair[1], type: 'default' } as any);
    }
    setNodes(nds => [...nds, ...newNodes]);
    setEdges(es => [...es, ...newEdges]);
    setSelectedNodeId(newNodes[0].id);
    revealNodes(newNodes.map(n => n.id));
  };

  // 监听衍生 + 菜单（使用 ref 避免闭包陈旧）
  useEffect(() => {
    const onAdd = (e: any) => {
      const { sourceId, nextType } = e.detail;
      const curNodes = nodesRef.current || [];
      const src = curNodes.find((n: any) => n.id === sourceId);
      // 下游衍生：源卡右侧一列，从源卡顶边向下找空位（连续衍生会竖排，不再叠在同一个位置）
      const { w, h } = estimateSize(nextType);
      // 源卡已有的下游卡：新衍生卡并入它们那一列
      const downstream = src ? (edgesRef.current || []).filter((ed: any) => ed.source === src.id)
        .map((ed: any) => curNodes.find((n: any) => n.id === ed.target)).filter(Boolean).map((n: any) => rectOf(n)) : [];
      const pos = src ? placeDownstream(occupiedRects(), rectOf(src as any), w, h, downstream) : freePosition(nextType);
      const node = createNode(nextType, pos);
      setNodes(nds => [...nds, node]);
      setSelectedNodeId(node.id);
      if (src) {
        const edge: Edge = { id: `e_${sourceId}_${node.id}`, source: sourceId, target: node.id, type: 'default' } as any;
        if (src.type === 'prompt' && nextType === 'image') { (edge as any).sourceHandle = 'prompt'; (edge as any).targetHandle = 'prompt'; }
        if (src.type === 'prompt' && nextType === 'video') { (edge as any).sourceHandle = 'prompt'; (edge as any).targetHandle = 'prompt'; }
        if (src.type === 'prompt' && nextType === 'audio') { (edge as any).sourceHandle = 'prompt'; (edge as any).targetHandle = 'text'; }
        if (src.type === 'image' && nextType === 'video') { (edge as any).sourceHandle = 'image'; (edge as any).targetHandle = 'first_frame'; }
        if (src.type === 'image' && nextType === 'image') { (edge as any).sourceHandle = 'image'; (edge as any).targetHandle = 'reference'; }
        if (src.type === 'video' && nextType === 'export') { (edge as any).sourceHandle = 'video'; (edge as any).targetHandle = 'video'; }
        if (src.type === 'audio' && nextType === 'export') { (edge as any).sourceHandle = 'audio'; (edge as any).targetHandle = 'audio'; }
        setEdges(es => [...es, edge]);
      }
    };
    const onDuplicate = (e: any) => {
      const { nodeId } = e.detail;
      const curNodes = nodesRef.current || [];
      const src = curNodes.find((n: any) => n.id === nodeId);
      if (!src) return;
      // 复制：与源卡同列，放到下方第一个空位
      const sr = rectOf(src as any);
      const newNode = createNode(src.type || 'prompt', findFreeInColumn(occupiedRects(), sr.x, sr.y, sr.w, sr.h));
      newNode.data = { ...(src.data as any), onUpdate: handleNodeUpdate, onExecute: handleNodeExecute };
      setNodes(nds => [...nds, newNode]);
      setSelectedNodeId(newNode.id);
    };
    window.addEventListener('canvas-add-node', onAdd as any);
    window.addEventListener('canvas-duplicate-node', onDuplicate as any);
    return () => {
      window.removeEventListener('canvas-add-node', onAdd as any);
      window.removeEventListener('canvas-duplicate-node', onDuplicate as any);
    };
  }, []);

  // ── 输入卡片：控制台「选参考 / 添加到输入 / 一键绑定」→ 画布上放对应卡片并连到目标句柄 ──
  // 插槽值由控制台照常写入目标节点；这里只负责「看得见」：
  //  · 选的是画布上某卡片的产出 → 直接连那张卡，不重复建卡；
  //  · 其余（素材库/角色库/上传/其他卡的输入）→ 在目标卡左侧一列竖排放「加载图像/视频/音频」卡并连线；
  //  · 单值插槽替换原输入、多值插槽追加；已不在插槽取值里的旧连线（及无人再用的自动输入卡）清理掉。
  useEffect(() => {
    const LOADER_OF: Record<string, string> = { image: 'load-image', video: 'load-video', audio: 'load-audio' };
    const mediaOf = (n: any, type: string): string => {
      const d: any = n?.data || {};
      if (type === 'image') return d.image_url || d.result_url || d.image || d.url || '';
      if (type === 'video') return d.video_url || d.video || d.url || '';
      return d.audio_url || d.audio || d.url || '';
    };
    const loaderData = (type: string, url: string) => (
      type === 'image' ? { image: url, url, image_url: url }
        : type === 'video' ? { video: url, url, video_url: url }
        : { audio: url, url, audio_url: url }
    );
    /** 插槽键 → 目标卡上的真实句柄：同名句柄优先；否则同媒体类型里的参考集 / 参考 / 第一个 */
    const resolveHandle = (tgtType: string, slotKey: string, mediaType: string): string | undefined => {
      const inputs = getNodeSpec(tgtType || '')?.inputs || [];
      if (inputs.some(h => h.id === slotKey)) return slotKey;
      const same = inputs.filter(h => h.type === mediaType);
      return same.find(h => h.id === 'reference_images')?.id || same.find(h => h.id === 'reference')?.id || same[0]?.id;
    };
    /** 进入该句柄的旧连线里，要拆掉的连线 / 连带删除的自动输入卡 */
    const planRemoval = (nds: any[], eds: any[], targetId: string, th: string, mediaType: string, keep: Set<string> | null) => {
      const edgeIds = new Set<string>();
      const nodeIds = new Set<string>();
      for (const ed of eds) {
        if (ed.target !== targetId || (ed.targetHandle || '') !== th) continue;
        const src = nds.find(n => n.id === ed.source);
        if (keep && keep.has(mediaOf(src, mediaType))) continue;
        edgeIds.add(ed.id);
        if ((src?.data as any)?._autoInput && !eds.some(o => o.source === src.id && o.id !== ed.id)) nodeIds.add(src.id);
      }
      return { edgeIds, nodeIds };
    };

    const onAttach = (e: any) => {
      const det: AttachInputsDetail = e?.detail;
      if (!det?.targetId || !det.items?.length) return;
      const nds: any[] = (nodesRef.current as any[]) || [];
      const eds: any[] = (edgesRef.current as any[]) || [];
      const target = nds.find(n => n.id === det.targetId);
      if (!target) return;
      const th = resolveHandle(target.type, det.slotKey, det.mediaType);
      const keep = new Set<string>(det.keep && det.keep.length ? det.keep : det.items.map(i => i.url));
      const { edgeIds, nodeIds } = th ? planRemoval(nds, eds, target.id, th, det.mediaType, keep) : { edgeIds: new Set<string>(), nodeIds: new Set<string>() };
      // 已经连着的（多值插槽里保留的旧输入）不再重复放
      const connected = new Set<string>(
        eds.filter(ed => th && ed.target === target.id && (ed.targetHandle || '') === th && !edgeIds.has(ed.id))
          .map(ed => mediaOf(nds.find(n => n.id === ed.source), det.mediaType)),
      );
      const occupied = nds.filter(n => !nodeIds.has(n.id)).map(n => rectOf(n));
      const tRect = rectOf(target);
      // 目标卡已有的上游卡：新输入卡并入它们那一列
      const upstream: Rect[] = eds.filter(ed => ed.target === target.id && !edgeIds.has(ed.id))
        .map(ed => nds.find(n => n.id === ed.source)).filter((n: any) => n && !nodeIds.has(n.id)).map((n: any) => rectOf(n));
      const addNodes: Node[] = [];
      const addEdges: Edge[] = [];
      for (const it of det.items) {
        if (!it.url || connected.has(it.url)) continue;
        let srcId = '';
        let sh: string | undefined;
        const reuse = it.sourceNodeId && ['image', 'video', 'audio'].includes(it.sourceSlotKey || '')
          ? nds.find(n => n.id === it.sourceNodeId && n.id !== target.id && !nodeIds.has(n.id))
          : undefined;
        if (reuse) {
          srcId = reuse.id;
          sh = getNodeSpec(reuse.type || '')?.outputs.find(h => h.type === det.mediaType)?.id;
        } else {
          const ltype = LOADER_OF[det.mediaType];
          const { w, h } = estimateSize(ltype);
          const pos = placeUpstream(occupied, tRect, w, h, upstream);
          occupied.push({ x: pos.x, y: pos.y, w, h });
          upstream.push({ x: pos.x, y: pos.y, w, h });
          const card = createNode(ltype, pos, { ...loaderData(det.mediaType, it.url), _autoInput: true });
          addNodes.push(card);
          srcId = card.id;
          sh = det.mediaType;
        }
        connected.add(it.url);
        if (th && srcId) {
          addEdges.push({ id: `e_${srcId}_${target.id}_${sh || 'out'}_${th}_${Date.now().toString(36)}${addEdges.length}`, source: srcId, target: target.id, sourceHandle: sh, targetHandle: th, type: 'default' } as any);
        }
      }
      if (!addNodes.length && !addEdges.length && !edgeIds.size) return;
      setNodes(cur => [...cur.filter(n => !nodeIds.has(n.id)), ...addNodes]);
      setEdges(cur => [...cur.filter(ed => !edgeIds.has(ed.id)), ...addEdges]);
      if (addNodes.length) toast.info(`已在画布放置 ${addNodes.length} 张输入卡片`);
    };

    const onDetach = (e: any) => {
      const det: DetachInputDetail = e?.detail;
      if (!det?.targetId) return;
      const nds: any[] = (nodesRef.current as any[]) || [];
      const eds: any[] = (edgesRef.current as any[]) || [];
      const target = nds.find(n => n.id === det.targetId);
      if (!target) return;
      const th = resolveHandle(target.type, det.slotKey, det.mediaType);
      if (!th) return;
      const { edgeIds, nodeIds } = planRemoval(nds, eds, target.id, th, det.mediaType, null);
      if (!edgeIds.size) return;
      setNodes(cur => cur.filter(n => !nodeIds.has(n.id)));
      setEdges(cur => cur.filter(ed => !edgeIds.has(ed.id)));
    };

    window.addEventListener(ATTACH_EVENT, onAttach as any);
    window.addEventListener(DETACH_EVENT, onDetach as any);
    return () => {
      window.removeEventListener(ATTACH_EVENT, onAttach as any);
      window.removeEventListener(DETACH_EVENT, onDetach as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  // Agent 自主编排后刷新（方案 6.2：画布产出后重载）
  useEffect(() => {
    const onAgent = async () => {
      if (!pid) return;
      try {
        const snap: any = await apiService.getProjectCanvas(pid);
        const canvas = snap?.canvas || snap;
        if (canvas && Array.isArray(canvas.nodes)) {
          const withHandlers = canvas.nodes.map((n: any) => ({
            ...n,
            data: { ...n.data, onUpdate: handleNodeUpdate, onExecute: handleNodeExecute },
          }));
          setNodes(withHandlers);
          if (Array.isArray(canvas.edges)) setEdges(canvas.edges);
        }
      } catch {}
    };
    window.addEventListener('agent-canvas-updated', onAgent as any);
    return () => window.removeEventListener('agent-canvas-updated', onAgent as any);
  }, [pid]);

  // 导出分镜
  useEffect(() => {
    const h = async () => {
      if (!pid) { alert('请先打开项目'); return; }
      const gens = nodes.filter(n => ['image', 'video', 'prompt'].includes(n.type as string));
      if (gens.length === 0) { alert('画布为空，无法导出'); return; }
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
        alert(`已导出 ${shots.length} 镜到项目时间线`);
      } catch (e: any) { alert(e.message); }
    };
    window.addEventListener('canvas-export-shots', h as any);
    return () => window.removeEventListener('canvas-export-shots', h as any);
  }, [nodes, pid, project]);

  // 分镜 → 画布：新建画布 / 隶属现有画布 → 装配 prompt/导演/视频子图 → 自动生成视频并回写分镜。
  // 不再是“往当前画布追加一个导演节点”。复杂 ComfyUI 工作流与自定义源在节点内照常换源即用。
  const importedShotNonce = useRef<number>(0);
  const pendingBuildRef = useRef<any>(null);
  const importRunnerRef = useRef<(p: any) => void>(() => {});
  const continuePendingBuildRef = useRef<() => void>(() => {});

  // 分镜绑定 → 画布节点槽位（与分镜台一键绑定同一纯函数；按源声明键双写）
  const providerDefCacheRef = useRef<Map<string, any>>(new Map());
  const loadProviderDef = async (providerId: string): Promise<any> => {
    if (!providerId) return null;
    if (providerDefCacheRef.current.has(providerId)) return providerDefCacheRef.current.get(providerId);
    try {
      const res: any = await apiService.getProvider(providerId);
      const def = res?.provider || res || null;
      providerDefCacheRef.current.set(providerId, def);
      return def;
    } catch { return null; }
  };

  const loadProjectAssetsForCanvas = async (): Promise<any[]> => {
    try {
      const r: any = await apiService.listAssets({ project_id: pid || undefined, page: 1, limit: 100 });
      return r?.assets || [];
    } catch { return []; }
  };

  const buildNodeSlotData = async (
    shot: any, kind: 'image' | 'video', providerId: string,
    shotDynamic: Record<string, any>, projectAssets: any[],
  ): Promise<{ hasDeclared: boolean; data: Record<string, any> }> => {
    const def = await loadProviderDef(providerId);
    if (!def) return { hasDeclared: false, data: {} };
    const slots = extractSlotsFromProvider(def, kind) as any[];
    if (!slots.length) return { hasDeclared: false, data: {} };
    const project: any = useProjectStore.getState().project;
    const includeFirstFrame = kind === 'video' && shot.production_mode !== 'motion_comic';
    const resources = collectResources({ shot, project, projectAssets, kind, includeFirstFrame });
    const plan = planBinding(resources, slots, shotDynamic, { overwrite: false });
    const data: Record<string, any> = { ...plan.patch };
    // 分镜手工值里该源声明的键也随镜迁移（归一键/源真实键双路读取）
    for (const s of slots) {
      for (const k of [s.key, s.originalKey]) {
        if (!k) continue;
        const v = shotDynamic[k];
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
        if (data[k] === undefined) data[k] = v;
      }
    }
    return { hasDeclared: true, data };
  };

  const runShotOnCanvas = async (payload: any, targetCid: string, targetName?: string) => {
    const shot = payload?.shot;
    if (!shot?.id || !pid) return;
    const proj = useProjectStore.getState().project;
    const refs = buildShotReferenceInputs(shot, proj || { characters: [] }, 'video');
    // 分镜侧绑定随镜迁移：手工/一键绑定值 + 资源池（角色三视图/参考音频/场景/道具/白模）
    const shotDynamic: Record<string, any> = { ...(shot.dynamic_inputs || {}) };
    const projectAssets = await loadProjectAssetsForCanvas();
    const vidBind = await buildNodeSlotData(shot, 'video', shot.video_provider || '', shotDynamic, projectAssets);
    const vprompt = shot.video_prompt || shot.action_desc || shot.image_prompt || '';
    const camMatch = /\[(?:Camera|运镜):[^\]]+\]/.exec(vprompt);
    const camPrompt = camMatch ? camMatch[0] : '';
    // 子图内部按「输入列 → 视频列」相对布局（输入竖排不重叠），整组放到现有内容下方（placeNewBlock）
    const inputColGap = estimateSize('image').h + 48;
    const mk = (type: string, dx: number, dy: number, data: any) => {
      const n = createNode(type, { x: dx, y: dy });
      n.data = { ...n.data, ...data };
      return n;
    };
    let newNodes: Node[] = [];
    const newEdges: Edge[] = [];
    const edge = (s: Node, sh: string, t: Node, th: string) => {
      newEdges.push({ id: `e_${s.id}_${t.id}_${sh}_${th}`, source: s.id, target: t.id, sourceHandle: sh, targetHandle: th, type: 'default' } as any);
    };
    const promptNode = mk('prompt', 0, 0, { prompt: vprompt, text: vprompt });
    newNodes.push(promptNode);
    const dirNode = mk('director3d', 0, estimateSize('prompt').h + 48, {
      framing: shot.camera_framing || 'medium',
      motion: shot.camera_motion || 'push_in',
      pose: shot.pose_preset || 'stand',
      focal_length_mm: shot.focal_length_mm || 35,
      camera_roll_deg: shot.camera_roll_deg || 0,
      cast_layout: shot.cast_layout || 'solo',
      speed: shot.motion_speed || '1.0x',
      ai_directive: '',
    });
    newNodes.push(dirNode);
    let imgNode: Node | null = null;
    if (!shot.image_url && shot.image_prompt) {
      const imgBind = await buildNodeSlotData(shot, 'image', shot.image_provider || '', shotDynamic, projectAssets);
      imgNode = mk('image', 0, estimateSize('prompt').h + 48 + inputColGap, {
        prompt: shot.image_prompt,
        provider_id: shot.image_provider || undefined,
        // 分镜归属：节点可随时把结果回写该镜（底部控制台「回写到分镜」）
        shotId: shot.id,
        shotIndex: shot.shot_index,
        ...imgBind.data,
        ...(!imgBind.hasDeclared && refs.reference_images.length ? { reference_images: refs.reference_images } : {}),
        character_ids: shot.character_ids,
        character_weights: shot.character_weights,
        scene_ref_image: shot.scene_ref_image,
        scene_name: shot.scene_name,
        prop_asset_ids: shot.prop_asset_ids,
        ...(shot.provider_params?.image ? { params: shot.provider_params.image, provider_params: shot.provider_params.image } : {}),
      });
      newNodes.push(imgNode);
    }
    const videoNode = mk('video', estimateSize('prompt').w + 120, 0, {
      prompt: vprompt,
      duration: Math.round(shot.duration) || 5,
      provider_id: shot.video_provider || undefined,
      camera_prompt: camPrompt,
      // 分镜归属：节点可随时把结果回写该镜（底部控制台「回写到分镜」）
      shotId: shot.id,
      shotIndex: shot.shot_index,
      // 直出（多参考）不带旧首帧：纯绑定驱动 r2v/t2v；图生才带真首帧
      first_frame: shot.production_mode === 'motion_comic' ? undefined : (shot.image_url || undefined),
      // 分镜绑定随镜迁移：该源声明的槽位（首帧/参考图/参考音频等）按一键绑定同一口径双写
      ...vidBind.data,
      // 无源定义时回退通用参考列表（旧行为）
      ...(!vidBind.hasDeclared && refs.reference_images.length ? { reference_images: refs.reference_images } : {}),
      // 画布内再生成/一键绑定复用该镜的角色·场景·道具绑定
      character_ids: shot.character_ids,
      character_weights: shot.character_weights,
      scene_ref_image: shot.scene_ref_image,
      scene_name: shot.scene_name,
      prop_asset_ids: shot.prop_asset_ids,
      previz_url: shot.previz_url,
      previz_video_url: shot.previz_video_url,
      speaker_name: shot.speaker_name,
      ...(shot.provider_params?.video ? { params: shot.provider_params.video, provider_params: shot.provider_params.video } : {}),
    });
    newNodes.push(videoNode);
    edge(promptNode, 'prompt', videoNode, 'prompt');
    edge(dirNode, 'camera_prompt', videoNode, 'camera_prompt');
    if (imgNode) {
      edge(promptNode, 'prompt', imgNode, 'prompt');
      edge(imgNode, 'image', videoNode, 'first_frame');
    }
    newNodes = placeNewBlock(newNodes);
    setNodes(nds => [...nds, ...newNodes]);
    revealNodes(newNodes.map(n => n.id));
    setEdges(es => [...es, ...newEdges]);
    setSelectedNodeId(videoNode.id);
    // 隶属关系落盘 + 子图即时保存（含画布名）
    try { useProjectStore.getState().updateShot(shot.id, { canvas_id: targetCid }); } catch {}
    try {
      await apiService.saveProjectCanvas(pid, { nodes: [...(nodesRef.current || []), ...newNodes], edges: [...(edgesRef.current || []), ...newEdges], version: 2 }, targetCid, targetName);
      apiService.listProjectCanvases(pid).then(r => setCanvasList(r.canvases || [])).catch(() => {});
    } catch {}
    if (payload.autoRun === false) return;
    // 无视频源不硬跑：子图已建好，提示绑源后手动执行（避免“请选择生成源”报错吓人）
    if (!videoNode.data.provider_id) {
      alert('子图已建好：该分镜未绑定视频源，请在视频节点内选择源后手动执行');
      return;
    }
    // 自动生成：导演机位 → 视频 → 回写分镜
    await new Promise(r => setTimeout(r, 800));
    try { await handleNodeExecute(dirNode.id); } catch {}
    await new Promise(r => setTimeout(r, 400));
    await handleNodeExecute(videoNode.id);
    const vd: any = (nodesRef.current || []).find((n: any) => n.id === videoNode.id)?.data;
    if (vd?.video_url) {
      // 与节点控制台「回写到分镜」同一口径（含历史留存）
      const wb = writeBackToShot({ shotId: shot.id, field: 'video_url', value: vd.video_url });
      if (wb.ok) alert(`分镜 #${shot.shot_index || ''} 视频已生成并回写`);
      else alert(`视频已生成，回写分镜失败：${wb.error || '未知错误'}（可在节点控制台手动回写）`);
    } else {
      alert('已在画布建好子图，视频未自动产出，请手动执行视频节点');
    }
  };

  const processShotImport = (payload: any) => {
    const shot = payload?.shot;
    if (!shot?.id) return;
    const nonce = Number(payload?.nonce || 0);
    if (nonce && nonce === importedShotNonce.current) return;
    if (nonce) importedShotNonce.current = nonce;
    if (!pid) { alert('请先在 项目看板 创建/打开项目'); return; }
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
    const onEvent = (e: any) => { try { importRunnerRef.current(e?.detail); } catch {} };
    window.addEventListener('canvas-import-shot', onEvent as any);
    // 兜底：消费分镜写入的 pending（画布当时未挂载时）
    try {
      const raw = localStorage.getItem('canvas_pending_shot');
      if (raw) {
        const payload = JSON.parse(raw);
        localStorage.removeItem('canvas_pending_shot');
        setTimeout(() => { try { importRunnerRef.current(payload); } catch {} }, 600);
      }
    } catch {}
    return () => window.removeEventListener('canvas-import-shot', onEvent as any);
  }, []);

  // 素材库 → 画布：按素材类型装配节点（人物/场景/道具→参考图，视频→首帧，音频→复刻参考）
  const importedAssetNonce = useRef<number>(0);
  useEffect(() => {
    const buildFromAsset = (payload: any) => {
      const asset = payload?.asset;
      if (!asset || !asset.id) return;
      const nonce = Number(payload?.nonce || 0);
      if (nonce && nonce === importedAssetNonce.current) return;
      if (nonce) importedAssetNonce.current = nonce;
      let abs = asset.file_url || '';
      if (abs && abs.startsWith('/')) abs = resolveMediaUrl(abs);
      // 文本/提示词素材：无文件也要能落画布（此前 if(!abs) 直接吞掉）
      const label0 = asset.visual_prompt || asset.description || asset.name || '';
      if (asset.category === 'text') {
        const txt = String(asset.content || asset.visual_prompt || '');
        const tn = createNode('text-prompt', freePosition('text-prompt'));
        tn.data = { ...tn.data, prompt: txt, text: txt };
        setNodes(nds => [...nds, tn]);
        setSelectedNodeId(tn.id);
        revealNodes([tn.id]);
        return;
      }
      if (!abs) return;
      const isVideo = /\.(mp4|webm|mov)$/i.test(abs);
      const isAudio = /\.(mp3|wav|ogg|m4a|flac)$/i.test(abs);
      const label = label0;
      if (isVideo) {
        // 视频素材：就是一张「加载视频」卡（视频卡的首帧句柄收的是图片，不能再把视频塞进首帧）
        const vn = createNode('load-video', freePosition('load-video'), { video: abs, url: abs, video_url: abs, name: asset.name });
        setNodes(nds => [...nds, vn]);
        setSelectedNodeId(vn.id);
        revealNodes([vn.id]);
        return;
      }
      // 图片/音频素材 →「素材卡 → 生成卡」：素材卡在左列、生成卡在右列并连线，输入了什么一目了然
      const kindOf = isAudio ? 'audio' : 'image';
      const loaderType = isAudio ? 'load-audio' : 'load-image';
      const handleIn = isAudio ? 'ref_audio' : 'reference_images';
      const src = createNode(loaderType, { x: 0, y: 0 }, {
        ...(isAudio ? { audio: abs, url: abs, audio_url: abs } : { image: abs, url: abs, image_url: abs }),
        _autoInput: true, name: asset.name,
      });
      const gen = createNode(kindOf, { x: estimateSize(loaderType).w + 120, y: 0 });
      gen.data = isAudio ? { ...gen.data, text: '', ref_audio: abs } : { ...gen.data, prompt: label, reference_images: [abs] };
      const placed = placeNewBlock([src, gen]);
      setNodes(nds => [...nds, ...placed]);
      setEdges(es => [...es, { id: `e_${src.id}_${gen.id}_${kindOf}_${handleIn}`, source: src.id, target: gen.id, sourceHandle: kindOf, targetHandle: handleIn, type: 'default' } as any]);
      setSelectedNodeId(gen.id);
      revealNodes(placed.map(n => n.id));
    };
    const onEvent = (e: any) => buildFromAsset(e?.detail);
    window.addEventListener('canvas-import-asset', onEvent as any);
    try {
      const raw = localStorage.getItem('canvas_pending_asset');
      if (raw) {
        const payload = JSON.parse(raw);
        localStorage.removeItem('canvas_pending_asset');
        setTimeout(() => buildFromAsset(payload), 600);
      }
    } catch {}
    return () => window.removeEventListener('canvas-import-asset', onEvent as any);
  }, []);

  /** 命中检测：返回指针正下方的节点（自上而下取最上层），用于「拖到节点上直接填充」 */
  const findNodeAt = useCallback((clientX: number, clientY: number): Node | null => {
    const p = screenToFlowPosition({ x: clientX, y: clientY });
    const list: any[] = (nodesRef.current as any[]) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const w = n.measured?.width || n.width || 320;
      const h = n.measured?.height || n.height || 200;
      const x = n.position?.x || 0;
      const y = n.position?.y || 0;
      if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return n as Node;
    }
    return null;
  }, [screenToFlowPosition]);

  /** 文本投放：写入命中节点的首个 text 输入（走 handleNodeUpdate 保留级联传播）；节点无文本输入返回 false */
  const fillNodeWithText = useCallback((nodeId: string, txt: string): boolean => {
    const nds: any[] = (nodesRef.current as any[]) || [];
    const n = nds.find(x => x.id === nodeId);
    if (!n) return false;
    const spec = getNodeSpec(n.type || '');
    const inDef = spec?.inputs.find(h => h.type === 'text');
    if (!inDef) return false;
    const patch: any = { [inDef.id]: txt };
    if ((n.type === 'prompt' || n.type === 'text-prompt') && inDef.id === 'prompt') patch.text = txt;
    handleNodeUpdate(nodeId, patch);
    setSelectedNodeId(nodeId);
    return true;
  }, [handleNodeUpdate]);

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

    // ── 文本投放：文本素材 或 自由文本 → 命中节点即填充，落空则新建「提示词文本」节点 ──
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
      if (txt.trim() && hit && fillNodeWithText(hit.id, txt)) return;
      const node = createNode('text-prompt', position);
      node.data = { ...node.data, prompt: txt, text: txt };
      setNodes(nds => [...nds, node]);
      setSelectedNodeId(node.id);
      return;
    }

    if (assetId) {
      const asset = assets.find(a => a.id === assetId);
      if (!asset) return;
      const node = createNode('image', position);
      const url = asset.thumb_url || asset.file_url;
      const abs = resolveMediaUrl(url);
      node.data = { ...node.data, reference: abs || url, image_url: abs || url };
      setNodes(nds => [...nds, node]);
      setSelectedNodeId(node.id);
      return;
    }
    if (type) {
      const extra = type === 'ext-node' && droppedNodeId
        ? { canvas_node_id: droppedNodeId, definition: getCanvasNodeSpec(droppedNodeId) }
        : undefined;
      const node = createNode(type, position, extra);
      setNodes(nds => [...nds, node]);
      setSelectedNodeId(node.id);
    }
  }, [screenToFlowPosition, assets, findNodeAt, fillNodeWithText]);

  const handleManualSave = async () => {
    if (!pid) { alert('请先在 项目看板 创建/打开项目'); return; }
    setSaving(true);
    try {
      const nm = canvasList.find(c => c.id === canvasIdRef.current)?.name;
      await apiService.saveProjectCanvas(pid, { nodes, edges, version: 2 }, canvasIdRef.current, nm);
      const r = await apiService.listProjectCanvases(pid).catch(() => null);
      if (r) setCanvasList(r.canvases || []);
      alert('画布已保存');
    } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  };

  const currentCanvasName = canvasList.find(c => c.id === canvasId)?.name || (canvasId === 'default' ? '默认画布' : canvasId);

  // 切换画布（先存当前，再载目标；目标已删时跳过保存避免复活）
  const switchCanvas = async (cid: string, skipSave = false) => {
    if (!pid || cid === canvasIdRef.current) return;
    if (!skipSave) {
      try {
        const nm = canvasList.find(c => c.id === canvasIdRef.current)?.name;
        await apiService.saveProjectCanvas(pid, { nodes: nodesRef.current || [], edges: edgesRef.current || [], version: 2 }, canvasIdRef.current, nm);
      } catch {}
    }
    setNodes([]); setEdges([]); setSelectedNodeId(null);
    suppressSaveRef.current = true;
    setCanvasId(cid);
  };

  // 新建画布并切换
  const createCanvas = async (name: string) => {
    if (!pid) { alert('请先在 项目看板 创建/打开项目'); return null; }
    const cid = `cv_${Date.now().toString(36)}`;
    try {
      await apiService.saveProjectCanvas(pid, { nodes: [], edges: [], version: 2 }, cid, name);
      const r = await apiService.listProjectCanvases(pid).catch(() => null);
      if (r) setCanvasList(r.canvases || []);
    } catch (e: any) { alert(e.message); return null; }
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

  /** 右键菜单删除：节点 + 挂在它身上的连线一起删，并把它移出会话关注 */
  const handleDeleteNode = (nodeId: string) => {
    setNodes(nds => nds.filter((n: any) => n.id !== nodeId));
    setEdges(es => es.filter((e: any) => e.source !== nodeId && e.target !== nodeId));
    try { useCanvasStore.getState().removeAgentFocusNode(nodeId); } catch { /* ignore */ }
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
    toast.info('节点已删除');
  };

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
  /** 横向排布：把所有节点排成一行（原顶栏按钮，现并入左下角画布控件竖条） */
  const handleArrangeHorizontally = () => {
    if (!nodes.length) return;
    setNodes(nds => nds.map((n, i) => ({ ...n, position: { x: 120 + i * 400, y: 120 } })));
  };

  return (
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
              <span className="[color:var(--color-text-muted)] truncate">· 点卡片右侧 + 快速衍生 · 点击卡片在底部控制台操作</span>
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

            {/* 完整态：画布级低频操作直接铺开（快捷键提示仅在很宽时出现） */}
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
                    title="Ctrl/⌘+C 复制 · Ctrl/⌘+V 粘贴 · Ctrl/⌘+Z 撤销 · Ctrl/⌘+Y 重做 · Delete 删除；Shift+拖 框选，Ctrl/⌘+点 多选">
                    <Keyboard className="w-3.5 h-3.5 shrink-0" strokeWidth={1.7} />
                    ⌘C/V 复制粘贴 · ⌘Z/Y 撤销重做 · Del 删除
                  </span>
                )}
              </>
            )}

            {/* 精简态：同一批操作收入「更多」，避免窄屏挤压/换行 */}
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

        {/* ── 画布操作台条（左上角，left-3 / top-[52px]）──
              · 第一个按钮 = 系统左侧栏 收起（仅图标）/ 展开（图标 + 文字）
              · 分块（模板 / 我的 / 节点 / 素材）：点块 → 展开操作台并直接滚到该小节 */}
        <div ref={workbenchRef} className="absolute left-3 top-[52px] bottom-3 z-30 flex flex-col items-start gap-2 pointer-events-none">
          {/* 悬浮条 */}
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

          {/* 画布操作台：高度占满画布列可用高度（宽 248px 浮层，不占画布宽度） */}
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
              {/* 一键模板 */}
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

              {/* 我的模板 · Creator */}
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

              {/* 节点：核心 Agent 节点 + 自定义 / 扩展节点 */}
              <section ref={setWorkbenchSectionRef('nodes')} className="scroll-mt-2">
                <WorkbenchGroupTitle>核心 Agent 节点</WorkbenchGroupTitle>
                {CORE_LIBRARY.map(n => (
                  <WorkbenchRow
                    key={n.type}
                    icon={n.icon}
                    iconCls={n.color}
                    label={n.label}
                    desc={n.desc}
                    draggable
                    onDragStart={e => e.dataTransfer.setData('application/canvas-nodetype', n.type)}
                    title="拖入画布，或点击直接创建"
                    onClick={() => {
                      const node = createNode(n.type, freePosition(n.type));
                      setNodes(nds => [...nds, node]);
                      setSelectedNodeId(node.id);
                    }}
                  />
                ))}

                {/* 插件贡献的两类节点行（自定义代码节点 / 扩展节点）已条目化（设计 §12）：
                    宿主注入 createNode，条目只声明「创建哪种节点」。
                    自定义代码节点受 `canvas_custom_nodes` 页内能力闸控制（出厂**默认关** ——
                    契约「feature 出厂全关」，见 server/app/core/features.py 与
                    tests/test_features.py::TestDefaults）；关掉时后端 /custom-nodes 同族 404、
                    MCP/Agent 路径也跑不了（同闸），所以调色板里不给入口，只留一行明示
                    （不提示「去装插件」—— 不是缺少插件）。 */}
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

              {/* 素材库 */}
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

            {/* 底部动作：保存 / 导出 */}
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
                  <p className="text-xs [color:var(--color-text-muted)] mt-1">选择模板一键生成连贯的 Agent 节点链，或从左上角「画布操作台」拖入节点</p>
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
              ref={rfWrapRef}
              /* 画布内不弹浏览器右键菜单；输入框/文本域保留原生菜单，方便复制粘贴 */
              onContextMenu={(e) => { if (!(e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"]')) e.preventDefault(); }}
              nodes={nodes}
              edges={renderedEdges}
              defaultEdgeOptions={{ type: 'default' }}
              connectionLineType={ConnectionLineType.Bezier}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onReconnectStart={onReconnectStart}
              onReconnect={onReconnect}
              onReconnectEnd={onReconnectEnd}
              isValidConnection={isValidConnection}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onNodeContextMenu={(e, node) => {
                e.preventDefault();
                // 右键即选中，与主流编辑器一致：菜单里的「添加到会话」目标不会被误认
                setSelectedNodeId(node.id);
                setNodeMenu({ nodeId: node.id, x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY });
              }}
              onPaneClick={() => { setSelectedNodeId(null); setNodeMenu(null); setDropMenu(null); }}
              onPaneContextMenu={(e) => {
                // 画布空白处右键：拦截浏览器菜单，改为「添加卡片」菜单
                e.preventDefault();
                setNodeMenu(null);
                const pt = e as React.MouseEvent;
                setDropMenu({ x: pt.clientX, y: pt.clientY, flow: screenToFlowPosition({ x: pt.clientX, y: pt.clientY }), items: DROP_CREATE_TYPES });
              }}
              onEdgeContextMenu={(e) => e.preventDefault()}
              onSelectionChange={handleSelectionChange}
              deleteKeyCode={null}  /* 删除交给 useCanvasShortcuts，统一处理节点+连线 */
              fitView
              /* 左下角 Controls 内置按钮的悬停/无障碍文案：库默认是英文，这里覆盖为中文
                 （Partial 会与默认值合并，其余键保持库默认） */
              ariaLabelConfig={{
                'controls.ariaLabel': '画布控制栏',
                'controls.zoomIn.ariaLabel': '放大',
                'controls.zoomOut.ariaLabel': '缩小',
                'controls.fitView.ariaLabel': '适应视图',
                'controls.interactive.ariaLabel': '锁定/解锁画布交互',
              }}
              colorMode={isLight ? 'light' : 'dark'}
              className={isLight ? 'light' : 'dark'}
              style={{ background: isLight ? '#E8ECF1' : '#08080B', cursor: isDragging ? 'grabbing' : 'crosshair' }}
            >
              {/* 淡色网格：细格 24px + 每 5 格一条稍深的主格线；颜色走主题变量（index.css --canvas-grid*） */}
              <Background id="grid-minor" variant={BackgroundVariant.Lines} gap={24} lineWidth={1} color="var(--canvas-grid)" bgColor="var(--canvas-bg)" />
              {/* 叠加层必须透明底：暗色模式下 Background 默认底色 #141414，会盖住下面的细格 */}
              <Background id="grid-major" variant={BackgroundVariant.Lines} gap={120} lineWidth={1} color="var(--canvas-grid-major)" bgColor="transparent" />
              <Controls className="!bg-surface/80 !border-white/70 dark:border-white/12 !rounded-2xl shadow-xl ![color:var(--color-text-main)] [&_button]:!bg-surface/80 [&_button]:!border-white/70 dark:border-white/12 [&_button]:![color:var(--color-text-main)]">
                {/* 横向排布：原顶栏按钮，并入左下角缩放/适应竖条 */}
                <ControlButton onClick={handleArrangeHorizontally} title="横向排布：把所有节点排成一行" aria-label="横向排布">
                  <ArrowLeftRight className="w-3.5 h-3.5" strokeWidth={1.7} />
                </ControlButton>
              </Controls>
              {/* pannable / zoomable 必须显式打开：@xyflow/react 12.11 的 MiniMap 这两个 prop
                  默认是 false，不传就是「鼠标放上去、拖动全都没反应」——小地图只是个静态缩略图。
                  视野框描边：暗色主题下遮罩是 rgba(10,10,12,.8)，框线默认 transparent 看不出来，
                  故给白色描边。maskStrokeWidth 不能省：内部会被 viewScale 乘算，不传时用的是
                  CSS 默认值 1（SVG 用户单位 ≈ 亚像素），传了才是「1 个屏幕像素」的细白线。 */}
              <MiniMap
                className="!bg-surface/80 !border-white/70 dark:border-white/12 !rounded-xl cursor-grab active:cursor-grabbing"
                maskColor={isLight ? 'rgba(15,23,42,0.12)' : 'rgba(10,10,12,0.8)'}
                maskStrokeColor={isLight ? '#7C3AED' : '#ffffff'}
                maskStrokeWidth={1}
                nodeColor={(n: any) => n.type === 'image' ? '#7C3AED' : n.type === 'video' ? '#F97316' : n.type === 'audio' ? '#EC4899' : (n.type === 'prompt' || n.type === 'text-prompt') ? '#06B6D4' : '#3F3F50'}
                pannable
                zoomable
              />
            </ReactFlow>
          )}
        </div>

        {/* 底部：仅在选中「生图 / 视频 / 配音」节点时出现的节点控制块。
            原先常驻的「全局导演 Agent GO + 快速添加」已撤销 —— 全局编排并入右侧 Agent 侧栏，
            快速添加由左侧工作台栏承担，此处只做「选中哪个节点就控制哪个节点」。 */}
        {!isEmpty && <NodeControlBar onClose={closeNodeConsole} />}
      </div>

      {/* 右侧：导演 Agent 侧栏（可收起）—— 画布上唯一的 Agent 入口。
          合并了原先的悬浮胶囊/浮窗与底部全局编排栏，见 CanvasAgentSidebar 文件头注释。 */}
      <CanvasAgentSidebar />

      {/* 拖线到空白处的创建菜单 */}
      {dropMenu && (
        <DropCreateMenu menu={dropMenu} onPick={createFromDrop} onClose={() => setDropMenu(null)} />
      )}

      {/* 节点右键菜单（添加到会话 / 删除） */}
      <NodeContextMenu
        menu={nodeMenu}
        onClose={() => setNodeMenu(null)}
        onDelete={handleDeleteNode}
      />

    </div>
  );
};

/** 拖线松手菜单：只列出能接上这个口的卡片；点外部 / Esc 关闭 */
const DropCreateMenu: React.FC<{
  menu: DropMenuState;
  onPick: (item: DropMenuState['items'][number]) => void;
  onClose: () => void;
}> = ({ menu, onPick, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 捕获阶段监听：画布（d3-zoom）会拦截 mousedown 冒泡
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as any)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // 推迟挂载，避免松手那一下的事件立刻把菜单关掉
    const t = setTimeout(() => { document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key); });
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="fixed z-50 w-48 bg-surface-secondary border border-white/15 rounded-2xl p-1.5 shadow-2xl flex flex-col gap-1 animate-in fade-in zoom-in-95 duration-150"
      style={{ left: Math.min(menu.x + 8, window.innerWidth - 200), top: Math.max(8, Math.min(menu.y - 12, window.innerHeight - 48 - menu.items.length * 32)) }}
    >
      <div className="px-2.5 py-1 text-[10px] font-bold text-white/40 uppercase tracking-wider">
        {!menu.from ? '添加卡片' : menu.from.side === 'source' ? '创建并连接下游' : '创建并连接上游'}
      </div>
      {menu.items.map((it) => (
        <button
          key={it.type}
          onClick={() => onPick(it)}
          className="w-full px-2.5 py-1.5 rounded-xl text-left text-xs text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors"
        >
          <it.icon className={`w-3.5 h-3.5 ${it.color}`} />
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
};

export const CreativeCanvas: React.FC = () => (
  <ReactFlowProvider><InnerCanvas /></ReactFlowProvider>
);
