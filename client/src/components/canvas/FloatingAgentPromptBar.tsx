// -*- coding: utf-8 -*-
/**
 * 双态底部控制台 — 无选中=全局导演 Agent GO；选中生图/视频/配音节点=该节点的 Agent 控制台
 * 设计：每个节点是"用户需求→Agent(选skill/选源/润色/组参/调API)→结果"；用户只说人话
 */
import React, { useState } from 'react';
import {
  ArrowUp,
  Clapperboard,
  Sparkles,
  FolderOpen,
  Globe,
  Video as VideoIcon,
  Mic,
  Loader2,
  X,
} from 'lucide-react';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { useProjectListStore } from '../../stores/useProjectListStore';
import { apiService } from '../../services/api';
import { NodeAgentConsole } from './NodeAgentConsole';

interface Props {
  onAddNode: (type: string) => void;
  onOpenAssetLibrary: () => void;
  onExport: () => void;
}

export const FloatingAgentPromptBar: React.FC<Props> = ({ onAddNode, onOpenAssetLibrary, onExport }) => {
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const nodes = useCanvasStore((s) => s.nodes);
  const setSelectedNodeId = useCanvasStore((s) => s.setSelectedNodeId);
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const isAgentNode = !!selectedNode && ['image', 'video', 'audio'].includes(selectedNode.type || '');

  const [goText, setGoText] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [lastReply, setLastReply] = useState<string>('');

  const handleGlobalGo = async () => {
    const text = goText.trim();
    if (!text || dispatching) return;
    const pid = (useProjectListStore.getState().activeProjectId || useProjectStore.getState().project?.id || '') as string;
    setDispatching(true);
    setLastReply('');
    try {
      const res: any = await apiService.agentChat(
        `【无限画布编排指令】请在当前项目画布上完成以下目标（需要产出节点与生成结果）：${text}`,
        { source: 'canvas', project_id: pid || undefined, canvas_summary: { nodes: nodes.length } }
      );
      const reply = res?.reply || res?.message || '';
      const tools = (res?.executed_tools || []).map((t: any) => t.tool_name || t.tool).filter(Boolean);
      setLastReply(reply ? `${reply}${tools.length ? ` · 已执行 ${tools.length} 个工具` : ''}` : tools.length ? `已编排 ${tools.length} 步` : 'Agent 无产出，请换个说法');
      // Agent 已通过 canvas_* 工具持久化画布 → 通知前端重载
      window.dispatchEvent(new CustomEvent('agent-canvas-updated'));
      setGoText('');
    } catch (e: any) {
      setLastReply(`调度失败: ${e?.message || e}`);
    } finally {
      setDispatching(false);
    }
  };

  // 选中 Agent 节点：底部直接切换为该节点的 Agent 控制台（人话需求→Agent选skill/源/参→调API）
  if (isAgentNode) {
    const kind = selectedNode!.type as 'image' | 'video' | 'audio';
    return (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-3xl flex flex-col items-center gap-2 pointer-events-auto">
        <div className="w-full bg-[#18191c]/95 backdrop-blur-2xl border border-white/15 rounded-2xl shadow-2xl overflow-hidden">
          <div className="px-4 py-2 bg-white/[0.03] border-b border-white/10 flex items-center gap-2 text-xs">
            <span className="text-[11px] font-bold text-violet-300">节点 Agent 控制台</span>
            <span className="text-[11px] text-white/40">· 点画布空白返回全局</span>
            <button onClick={() => setSelectedNodeId(null)} className="ml-auto p-1 rounded hover:bg-white/10 text-white/40 hover:text-white" title="返回全局"><X className="w-3.5 h-3.5" /></button>
          </div>
          <div className="p-3">
            <NodeAgentConsole nodeId={selectedNode!.id} kind={kind} />
          </div>
          <div className="px-4 py-2 bg-black/40 border-t border-white/10 flex items-center gap-2 text-xs overflow-x-auto">
            <span className="text-white/40 text-[11px] whitespace-nowrap">快速添加:</span>
            <button onClick={() => onAddNode('prompt')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 flex items-center gap-1.5 border border-white/10 whitespace-nowrap"><Clapperboard className="w-3.5 h-3.5 text-cyan-400" /><span>剧本</span></button>
            <button onClick={() => onAddNode('image')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 flex items-center gap-1.5 border border-white/10 whitespace-nowrap"><Globe className="w-3.5 h-3.5 text-violet-400" /><span>生图 Agent</span></button>
            <button onClick={() => onAddNode('video')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 flex items-center gap-1.5 border border-white/10 whitespace-nowrap"><VideoIcon className="w-3.5 h-3.5 text-orange-400" /><span>视频 Agent</span></button>
            <button onClick={() => onAddNode('audio')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 flex items-center gap-1.5 border border-white/10 whitespace-nowrap"><Mic className="w-3.5 h-3.5 text-pink-400" /><span>配音</span></button>
            <div className="w-[1px] h-4 bg-white/15 mx-1 shrink-0" />
            <button onClick={onOpenAssetLibrary} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 flex items-center gap-1.5 border border-white/10 whitespace-nowrap"><FolderOpen className="w-3.5 h-3.5 text-amber-400" /><span>素材库</span></button>
            <button onClick={onExport} className="px-3 py-1.5 rounded-xl bg-violet-600/20 border border-violet-500/40 text-violet-200 hover:bg-violet-600 hover:text-white flex items-center gap-1.5 whitespace-nowrap"><Sparkles className="w-3.5 h-3.5 text-violet-400" /><span>导出剪映</span></button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 w-[92vw] max-w-3xl flex flex-col items-center gap-2 pointer-events-auto">
      <div className="w-full bg-[#18191c]/95 backdrop-blur-2xl border border-white/15 rounded-2xl shadow-2xl overflow-hidden">
        {/* 头部：全局编排定位 */}
        <div className="px-4 py-2 bg-white/[0.03] border-b border-white/10 flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/40 border border-white/10 text-white/90">
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            <span className="font-bold">全局导演 Agent</span>
          </div>
          <span className="text-[11px] text-white/40 hidden md:inline">一句话拆解需求 · 自动选源建节点连线执行 · 点节点进入该节点的 Agent 控制台</span>
          <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/40">
            {nodes.length} 节点
          </span>
        </div>

        {/* 全局自然语言 GO */}
        <div className="p-3">
          <div className="relative">
            <textarea
              value={goText}
              onChange={(e) => setGoText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGlobalGo(); } }}
              placeholder="例：根据李逍遥角色卡，生成他在客栈门口拔剑的三格分镜首帧，并合成一段 5 秒冲刺视频 + 怒吼配音…"
              rows={2}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-white/40 focus:outline-none focus:border-violet-500 transition-all resize-none pr-24"
            />
            <button
              onClick={handleGlobalGo}
              disabled={dispatching || !goText.trim()}
              className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-white text-xs font-bold shadow-lg disabled:opacity-40 disabled:pointer-events-none transition-all bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 shadow-violet-600/30"
            >
              {dispatching ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>Agent 编排中…</span></>
              ) : (
                <><span>GO</span><ArrowUp className="w-3.5 h-3.5 stroke-[2.5]" /></>
              )}
            </button>
          </div>
          {(dispatching || lastReply) && (
            <div className={`mt-2 text-[11px] leading-relaxed line-clamp-2 ${lastReply.includes('失败') ? 'text-red-400' : 'text-violet-300'}`}>
              {dispatching ? '导演 Agent 正在感知画布 → 选择生成源 → 建节点连线 → 执行…（完成后画布自动刷新）' : lastReply}
            </div>
          )}
        </div>

        {/* 快速建节点 + 素材 + 导出 */}
        <div className="px-4 py-2.5 bg-black/40 border-t border-white/10 flex items-center gap-2 text-xs overflow-x-auto">
          <span className="text-white/40 text-[11px] whitespace-nowrap">快速添加:</span>
          <button onClick={() => onAddNode('prompt')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 hover:text-white flex items-center gap-1.5 transition-all border border-white/10 whitespace-nowrap">
            <Clapperboard className="w-3.5 h-3.5 text-cyan-400" />
            <span>剧本/Prompt</span>
          </button>
          <button onClick={() => onAddNode('image')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 hover:text-white flex items-center gap-1.5 transition-all border border-white/10 whitespace-nowrap">
            <Globe className="w-3.5 h-3.5 text-violet-400" />
            <span>生图 Agent</span>
          </button>
          <button onClick={() => onAddNode('video')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 hover:text-white flex items-center gap-1.5 transition-all border border-white/10 whitespace-nowrap">
            <VideoIcon className="w-3.5 h-3.5 text-orange-400" />
            <span>视频 Agent</span>
          </button>
          <button onClick={() => onAddNode('audio')} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 hover:text-white flex items-center gap-1.5 transition-all border border-white/10 whitespace-nowrap">
            <Mic className="w-3.5 h-3.5 text-pink-400" />
            <span>配音 Agent</span>
          </button>
          <div className="w-[1px] h-4 bg-white/15 mx-1 shrink-0" />
          <button onClick={onOpenAssetLibrary} className="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 hover:text-white flex items-center gap-1.5 transition-all border border-white/10 whitespace-nowrap">
            <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
            <span>素材库</span>
          </button>
          <button onClick={onExport} className="px-3 py-1.5 rounded-xl bg-violet-600/20 border border-violet-500/40 text-violet-200 hover:bg-violet-600 hover:text-white flex items-center gap-1.5 transition-all whitespace-nowrap">
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            <span>导出剪映工程</span>
          </button>
        </div>
      </div>
    </div>
  );
};
