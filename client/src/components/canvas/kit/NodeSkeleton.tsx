// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 统一节点外壳（照搬 Toonflow nodeSkeleton.vue 的结构与交互，design §5）：
 *   标题栏在卡片外上方（16px 图标 + 单行标题，双击改名，可拖动节点；悬停出现 24×24 刷新 / 删除）
 *   卡片（12px 圆角、1px 边框、无阴影、内边距 8、最小高度 max(100,(端口数+1)×44)，选中边框混主色）
 *   卡片上方浮动工具栏（选中时出现）、下方浮动提示词面板（选中且 panelOpen 时出现）
 *   右键菜单：保存到素材库 / 复制节点 / 创建副本 / 删除节点（+ menuItems）
 * 宿主能力通过 CanvasHostContext 注入（见 hostContext.tsx），缺省回落 React Flow。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { useReactFlow, useStore, useUpdateNodeInternals, type NodeProps, type ReactFlowState } from '@xyflow/react';
import { IconBox, IconCopy, IconCopyPlus, IconFolderPlus, IconLoader2, IconRefresh, IconTrash, IconX } from '@tabler/icons-react';
import { getNodeDef } from './registry';
import { resolvePorts } from './connection';
import { NodeHandles, cardMinHeight } from './NodeHandles';
import { FloatingToolbar, ToolbarButton } from './FloatingToolbar';
import { useKitNodeActions } from './hostContext';
import { MenuList, Popover, type MenuItemSpec } from './ui/Popover';
import type { KitIcon, PortDef } from './types';

export type SkeletonNodeProps = Pick<NodeProps, 'id'> & Partial<Pick<NodeProps, 'selected' | 'dragging' | 'type' | 'data' | 'isConnectable'>>;

export interface NodeSkeletonProps {
  /** React Flow 传给节点组件的 props（取 id / selected / dragging / type / data）。 */
  node: SkeletonNodeProps;
  /** 标题；缺省 data.label → NodeDef.label → 「未命名节点」。 */
  label?: string;
  /** 缺省 NodeDef.icon → IconBox。 */
  icon?: KitIcon;
  /** 缺省按注册表解析（含动态端口）。 */
  ports?: readonly PortDef[];
  /** 节点宽度；缺省 NodeDef.width → 220。媒体节点按宽高比自行计算后传入。 */
  width?: number | string;
  /** 卡片最小高度；缺省 max(100,(端口数+1)×44)。 */
  minHeight?: number;
  loading?: boolean;
  children?: ReactNode;

  /** 上方工具栏左侧动作（Toonflow #topActions）。 */
  toolbar?: ReactNode;
  /** 上方工具栏分隔线右侧动作（Toonflow #topRightActions）。 */
  toolbarRight?: ReactNode;
  /** 整个替换上方浮层（Toonflow #top，如图片标记工具条）。 */
  topSlot?: ReactNode;
  /** 是否显示上方浮层；缺省 true（选中时出现），false 关闭。 */
  showToolbar?: boolean;
  topWidth?: number | string;
  downloadUrl?: string;
  downloadName?: string;
  /** 见 FloatingToolbar.showDownload（缺省：有 downloadUrl 才显示下载按钮）。 */
  showDownload?: boolean;
  /** 全屏按钮回调；缺省调用宿主 openFullscreen(downloadUrl)。传 null 隐藏全屏按钮。 */
  onFullscreen?: (() => void) | null;
  fullscreenDisabled?: boolean;

  /** 下方浮动面板（PromptPanel）。 */
  panel?: ReactNode;
  /** 缺省 true；为 false 时即使选中也不显示 panel。 */
  panelOpen?: boolean;
  /** 缺省 660（design §3）。 */
  panelWidth?: number | string;

  /** 改名回调；缺省宿主 rename → updateNodeData({label})。 */
  onRename?: (label: string) => void;
  /** 标题栏刷新；缺省宿主 refresh，都没有则置灰。 */
  onRefresh?: () => void | Promise<void>;
  /** 标题栏删除；缺省宿主 remove → deleteElements。 */
  onRemove?: () => void | Promise<void>;
  /** 右键菜单附加项（排在默认项后面）。 */
  menuItems?: MenuItemSpec[];
  /** 关闭右键菜单（交给宿主的菜单）。缺省 true。 */
  contextMenu?: boolean;
  /** 双击卡片把节点（含浮层）缩放到视口中央；缺省 true。 */
  focusOnDoubleClick?: boolean;

  className?: string;
  style?: CSSProperties;
  cardClassName?: string;
  cardStyle?: CSSProperties;
}

const EMPTY_DATA: Record<string, unknown> = {};
const stopProp = (e: SyntheticEvent) => e.stopPropagation();
/** 浮层 / 输入框上拦截的事件：避免拖动节点、触发双击聚焦、右键菜单与画布快捷键（Toonflow @pointerdown.stop 等）。 */
const slotGuards = {
  onPointerDown: stopProp,
  onMouseDown: stopProp,
  onDoubleClick: stopProp,
  onKeyDown: stopProp,
  onContextMenu: stopProp,
};

/** 选中节点数 ≤1 时才显示浮层（多选只操作节点，同 Toonflow）。 */
function selectedCountSelector(s: ReactFlowState): number {
  let n = 0;
  for (const node of s.nodes) if (node.selected) n++;
  return n;
}
const userSelectionSelector = (s: ReactFlowState) => s.userSelectionActive;

/**
 * REQ-toonflow-canvas K1：事件是否真的发生在节点自己的 DOM 子树里。
 * React 合成事件会沿组件树冒泡——节点 portal 到 body 的弹层（全屏编辑器、弹窗…）里的右键 / 双击也会冒到这里，
 * 这类事件的 target 不在 currentTarget 的 DOM 子树内，要忽略。
 */
function fromOwnDom(e: ReactMouseEvent): boolean {
  const target = e.target as globalThis.Node | null;
  return !!target && (e.currentTarget as HTMLElement).contains(target);
}

export function NodeSkeleton(props: NodeSkeletonProps) {
  const { node, children, loading } = props;
  const def = getNodeDef(node.type);
  const data = (node.data || EMPTY_DATA) as Record<string, unknown>;
  const label = props.label ?? (typeof data.label === 'string' && data.label ? data.label : def?.label ?? '未命名节点');
  const Icon = props.icon ?? def?.icon ?? IconBox;
  const ports = useMemo(() => props.ports ?? resolvePorts(def, { data }), [props.ports, def, data]);
  const width = props.width ?? def?.width ?? 220;
  const minHeight = props.minHeight ?? cardMinHeight(ports);
  const selected = !!node.selected;

  const rf = useReactFlow();
  const actions = useKitNodeActions(node.id);
  const rootRef = useRef<HTMLDivElement>(null);

  // —— 浮层可见性：选中、未拖动、未框选、且只选中了自己 ——
  const selectedCount = useStore(useCallback((s: ReactFlowState) => (selected ? selectedCountSelector(s) : 0), [selected]));
  const userSelecting = useStore(userSelectionSelector);
  const slotsVisible = selected && !node.dragging && !userSelecting && selectedCount <= 1;

  // —— 端口变化后让 React Flow 重新测量 handle 位置 ——
  const updateNodeInternals = useUpdateNodeInternals();
  const portsSig = ports.map((p) => `${p.type}:${p.id}`).join(',');
  useEffect(() => { updateNodeInternals(node.id); }, [portsSig, node.id, updateNodeInternals]);

  // —— 改名 ——
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const startEdit = useCallback(() => {
    setDraft(label);
    setEditing(true);
  }, [label]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  const saveLabel = useCallback(() => {
    if (!editing) return;
    const v = draft.trim();
    setEditing(false);
    if (!v || v === label) return;
    if (props.onRename) props.onRename(v);
    else actions.rename(v);
  }, [editing, draft, label, props, actions]);
  const onLabelKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); saveLabel(); }
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
  };

  // —— 标题栏动作 ——
  const [busy, setBusy] = useState<'refresh' | 'remove' | null>(null);
  const refresh = props.onRefresh ?? actions.refresh;
  const remove = props.onRemove ?? actions.remove;
  const run = async (kind: 'refresh' | 'remove', fn?: () => void | Promise<void>) => {
    if (!fn || busy) return;
    setBusy(kind);
    try { await fn(); } catch (e) { console.error(`[kit] 节点${kind === 'refresh' ? '刷新' : '删除'}失败`, e); } finally { setBusy(null); }
  };

  // —— 右键菜单 ——
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: ReactMouseEvent) => {
    if (props.contextMenu === false) return;
    // 来自 portal 弹层的冒泡、或子元素已自行处理（preventDefault）的右键：不弹节点菜单
    if (e.defaultPrevented || !fromOwnDom(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };
  const menuItems: MenuItemSpec[] = [
    ...(actions.saveToAssets ? [{ key: 'saveAsset', label: '保存到素材库', icon: <IconFolderPlus size={16} aria-hidden />, disabled: !actions.canSaveToAssets, onSelect: () => void actions.saveToAssets?.() }] : []),
    { key: 'copy', label: '复制节点', icon: <IconCopy size={16} aria-hidden />, divided: !!actions.saveToAssets, onSelect: actions.copy },
    { key: 'duplicate', label: '创建副本', icon: <IconCopyPlus size={16} aria-hidden />, onSelect: actions.duplicate },
    { key: 'delete', label: '删除节点', icon: <IconTrash size={16} aria-hidden />, danger: true, onSelect: () => void run('remove', remove) },
    ...(props.menuItems || []).map((it, i) => (i === 0 ? { ...it, divided: true } : it)),
  ];

  // —— 双击聚焦：把节点和浮层一起缩放到视口中央（Toonflow focusNode）——
  const onDoubleClick = (e: ReactMouseEvent) => {
    if (props.focusOnDoubleClick === false || !fromOwnDom(e)) return;
    const el = rootRef.current;
    if (!el || (e.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) return;
    const rects = [el, ...Array.from(el.querySelectorAll<HTMLElement>(':scope > .cv-node__slot'))]
      .filter((x) => x.getClientRects().length)
      .map((x) => x.getBoundingClientRect());
    if (!rects.length) return;
    const tl = rf.screenToFlowPosition({ x: Math.min(...rects.map((r) => r.left)), y: Math.min(...rects.map((r) => r.top)) });
    const br = rf.screenToFlowPosition({ x: Math.max(...rects.map((r) => r.right)), y: Math.max(...rects.map((r) => r.bottom)) });
    void rf.fitBounds({ x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }, { padding: 0.2, duration: 300 });
  };

  // —— 上方浮层 ——
  const fullscreen = props.onFullscreen === null
    ? undefined
    : props.onFullscreen ?? (props.downloadUrl ? () => actions.openFullscreen(props.downloadUrl!) : undefined);
  const showTop = (props.showToolbar ?? true) && slotsVisible;
  const top = props.topSlot ?? (
    <FloatingToolbar
      left={props.toolbar}
      right={props.toolbarRight}
      onSaveToAssets={actions.saveToAssets ? () => void actions.saveToAssets?.() : undefined}
      saveDisabled={!actions.canSaveToAssets}
      downloadUrl={props.downloadUrl}
      downloadName={props.downloadName}
      showDownload={props.showDownload}
      onFullscreen={fullscreen}
      fullscreenDisabled={props.fullscreenDisabled}
    />
  );
  const showBottom = !!props.panel && (props.panelOpen ?? true) && slotsVisible;
  const px = (v: number | string | undefined) => (typeof v === 'number' ? `${v}px` : v);

  return (
    <div
      ref={rootRef}
      className={['cv-node', selected ? 'is-selected' : '', props.className].filter(Boolean).join(' ')}
      style={{ width: px(width), ...props.style }}
      data-node-type={node.type}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {showTop && (
        <div className="cv-node__slot cv-node__slot--top nodrag nopan nowheel" style={{ width: px(props.topWidth ?? 'max-content') }} {...slotGuards}>
          {top}
        </div>
      )}
      {showBottom && (
        <div className="cv-node__slot cv-node__slot--bottom nodrag nopan nowheel" style={{ width: px(props.panelWidth ?? 660) }} {...slotGuards}>
          {props.panel}
        </div>
      )}

      <div className="cv-node__title">
        <Icon className="cv-node__title-icon" size={16} aria-hidden />
        {editing ? (
          <input
            ref={inputRef}
            className="cv-node__label-input nodrag nopan"
            aria-label="节点名称"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onLabelKey}
            onBlur={saveLabel}
            onPointerDown={stopProp}
            onMouseDown={stopProp}
            onDoubleClick={stopProp}
          />
        ) : (
          <span
            className="cv-node__label"
            tabIndex={0}
            title={`${label}（双击编辑名称）`}
            onDoubleClick={(e) => { e.stopPropagation(); startEdit(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); startEdit(); } }}
          >
            {label}
          </span>
        )}
        <div className="cv-node__actions nodrag nopan" onPointerDown={stopProp} onMouseDown={stopProp} onDoubleClick={stopProp}>
          <ToolbarButton
            icon={IconRefresh}
            title="刷新节点"
            iconOnly
            loading={busy === 'refresh' || !!loading}
            disabled={!!loading || !refresh}
            onClick={() => void run('refresh', refresh)}
          />
          <ToolbarButton icon={IconX} title="移除节点" iconOnly loading={busy === 'remove'} onClick={() => void run('remove', remove)} />
        </div>
      </div>

      <div className="cv-node__card-wrap">
        <div
          className={['cv-card cv-node__card', selected ? 'is-selected' : '', props.cardClassName].filter(Boolean).join(' ')}
          style={{ minHeight, ...props.cardStyle }}
        >
          {loading ? (
            <div className="cv-node__loading" role="status" aria-label="节点加载中">
              <IconLoader2 className="cv-spin" size={24} aria-hidden />
              <span>加载中...</span>
            </div>
          ) : children}
        </div>
        <NodeHandles ports={ports} nodeId={node.id} connectable={!loading && node.isConnectable !== false} />
      </div>

      <Popover open={!!menuAt} anchor={menuAt} onClose={() => setMenuAt(null)} role="menu" aria-label="节点菜单">
        <MenuList items={menuItems} onClose={() => setMenuAt(null)} />
      </Popover>
    </div>
  );
}
