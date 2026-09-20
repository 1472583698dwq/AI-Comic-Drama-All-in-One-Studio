// -*- coding: utf-8 -*-
/**
 * 底部「节点控制块」—— 只服务当前选中的生成节点。
 *
 * 布局语义（2026-09-20 画布重构）：
 * - 画布上的导演 Agent 只保留**一处**入口：右侧可收起的 Agent 侧栏
 *   （`CanvasAgentSidebar`，会话 + 一句话编排 GO 都收在那里）。
 * - 原先底部那条「全局导演 Agent GO / 快速添加」不再承担全局编排，
 *   本组件只在选中「生图 / 视频 / 配音」节点时出现，做该节点的 Agent 控制台
 *   （用户只说人话 → Agent 选 skill / 选源 / 润色 / 组参 / 调 API）。
 * - 未选中生成节点时渲染 `null`：画布底部保持干净，不再有常驻浮层。
 *
 * 节点类型闸门与旧实现一致（image / video / audio），未扩大支持面。
 */
import React from 'react';
import { X } from 'lucide-react';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { NodeAgentConsole } from './NodeAgentConsole';

const AGENT_NODE_TYPES = ['image', 'video', 'audio'];

export const NodeControlBar: React.FC = () => {
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const nodes = useCanvasStore((s) => s.nodes);
  const setSelectedNodeId = useCanvasStore((s) => s.setSelectedNodeId);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const isAgentNode = !!selectedNode && AGENT_NODE_TYPES.includes(selectedNode.type || '');
  if (!isAgentNode) return null;

  const kind = selectedNode!.type as 'image' | 'video' | 'audio';

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-3xl flex flex-col items-center gap-2 pointer-events-auto">
      <div className="w-full bg-surface/95 backdrop-blur-2xl border border-white/15 rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-4 py-2 bg-white/[0.03] border-b border-white/10 flex items-center gap-2 text-xs">
          <span className="text-[11px] font-bold text-violet-300">节点 Agent 控制台</span>
          <span className="text-[11px] text-white/40 hidden sm:inline">· 只说人话，Agent 选源 / 润色 / 组参 / 调 API</span>
          <button
            onClick={() => setSelectedNodeId(null)}
            className="ml-auto p-1 rounded hover:bg-white/10 text-white/40 hover:text-white"
            title="收起（也可点画布空白）"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="p-3">
          <NodeAgentConsole nodeId={selectedNode!.id} kind={kind} />
        </div>
      </div>
    </div>
  );
};
