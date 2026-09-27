// -*- coding: utf-8 -*-
/**
 * 底部「节点操作台」—— 只服务当前选中的生成节点。
 *
 * 布局语义（2026-09-20 画布重构）：
 * - 画布上的导演 Agent 只保留**一处**入口：右侧可收起的 Agent 侧栏
 *   （`CanvasAgentSidebar`，会话 + 一句话编排 GO 都收在那里）。
 * - 原先底部那条「全局导演 Agent GO / 快速添加」不再承担全局编排，
 *   本组件只在选中「生图 / 视频 / 配音」节点时出现，做该节点的操作台
 *   （用户只说人话 → Agent 选 skill / 选源 / 润色 / 组参 / 调 API）。
 * - 未选中生成节点时渲染 `null`：画布底部保持干净，不再有常驻浮层。
 *
 * 2026-09-27 精简（基线 §5.5）：
 * - 顶部说明栏整条删除，只在左上角标识「当前控制的是哪个节点」（图标 + 名称 + #id）。
 * - 宽 460px（原 768px），实色面 + 单层阴影（毛玻璃全页只保留顶栏一处）。
 * - 参数等高级设置全部移入二级参数弹窗，本组件只做外壳。
 *
 * 节点类型闸门与旧实现一致（image / video / audio），未扩大支持面。
 */
import React from 'react';
import { X, Image as ImageIcon, Film, Mic } from 'lucide-react';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { NodeAgentConsole } from './NodeAgentConsole';

const AGENT_NODE_TYPES = ['image', 'video', 'audio'];

/** 左上角身份标识：当前操作台正在控制哪一类节点 */
const KIND_META: Record<string, { label: string; Icon: any; iconCls: string }> = {
  image: { label: '分镜生图 Agent', Icon: ImageIcon, iconCls: 'text-violet-400' },
  video: { label: '动态导演视频 Agent', Icon: Film, iconCls: 'text-orange-400' },
  audio: { label: '配音 / 声音 Agent', Icon: Mic, iconCls: 'text-pink-400' },
};

export const NodeControlBar: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
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
  const meta = KIND_META[kind] || KIND_META.image;
  const KindIcon = meta.Icon;

  return (
    // 宽度：内层输入框 656px + 左右 p-3(24) + 描边 2 = 682；高度由框内文本区 6 行决定 ≈ 175
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-[682px] flex flex-col items-center gap-2 pointer-events-auto">
      {/* 不用 overflow-hidden：生成源「上拉选择栏」需要越出卡片上沿浮在画布上 */}
      <div className="w-full bg-surface border border-border rounded-[14px] shadow-xl">
        {/* 左上角只标识当前节点；原「节点 Agent 控制台 · 只说人话…」说明栏整条删除 */}
        <div className="h-9 px-3 flex items-center gap-2 border-b border-border">
          <span className="w-7 h-7 rounded-md bg-surface-secondary border border-border flex items-center justify-center shrink-0">
            <KindIcon className={`w-3.5 h-3.5 ${meta.iconCls}`} strokeWidth={1.7} />
          </span>
          <span className="text-[13px] font-semibold [color:var(--color-text-main)] truncate">{meta.label}</span>
          <span className="font-mono text-[10.5px] [color:var(--color-text-muted)] shrink-0">#{selectedNode!.id.slice(-4).trim()}</span>
          <button
            onClick={close}
            aria-label="收起节点操作台"
            title="收起（也可点画布空白 / Esc）"
            className="ml-auto w-6 h-6 rounded-md flex items-center justify-center [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-secondary transition-colors"
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
