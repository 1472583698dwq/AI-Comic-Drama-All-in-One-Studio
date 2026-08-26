import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Film, Download, Clock, AlertCircle } from 'lucide-react';
import { apiService } from '../../../services/api';
import { useProjectStore } from '../../../stores/useProjectStore';
import { useProjectListStore } from '../../../stores/useProjectListStore';

export const TimelineExportNode: React.FC<NodeProps> = ({ data, id }) => {
  const d: any = data;
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<any>(d.lastResult || null);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    const { project } = useProjectStore.getState();
    const { activeProjectId } = useProjectListStore.getState();
    // 优先用画布上游聚合的分镜，其次用当前项目
    let proj: any = project;
    // 若上游有 project（来自 script-split 全量），优先
    const upProj = d._upstream?.project || d._upstream?.content;
    if (upProj && upProj.scenes) proj = upProj;
    if (!proj || !proj.scenes?.length) {
      setError('无项目分镜数据：请先通过 简报→拆解→分镜卡 流程生成，或在画布中导出为分镜后重试');
      return;
    }
    // 若画布中有 shot-card 结果，覆盖 project 里的对应分镜媒体
    try {
      const canvasNodes: any[] = (window as any).__canvasNodes || [];
      // 尝试从 window 暴露的节点取最新 image/video（备用）
    } catch {}

    setExporting(true); setError(null);
    try {
      const res = await apiService.exportJianYingDraft(proj);
      setResult(res);
      (d.onUpdate as any)?.(id, { lastResult: res });
    } catch (e:any) { setError(e.message); } finally { setExporting(false); }
  };

  const handleCollectFromCanvas = () => {
    // 一键把画布中所有 shot-card 的 image/video 收集为临时 Project 并导出
    try {
      const flowNodes: any[] = (useProjectStore.getState() as any).__canvasNodes || [];
    } catch {}
    // 简化：直接触发画布的导出为分镜逻辑，再导出
    handleExport();
  };

  return (
    <div className="w-[360px] bg-surface border-2 border-brand/40 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-brand to-violet-600 border-b border-brand/30 flex items-center gap-1.5">
        <Film className="w-3.5 h-3.5 text-white"/><span className="text-xs font-bold text-white">时间线 / 剪映导出</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-white">Jianying Draft</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-brand !w-2 !h-2"/>
      <Handle type="target" position={Position.Top} id="shots" className="!bg-accent-pink !w-2 !h-2" style={{left:'30%'}}/>
      <div className="p-3 space-y-2">
        <p className="text-[11px] text-gray-400 leading-relaxed">聚合上游分镜的 <b>画面/视频</b>、<b>配音</b>、<b>字幕</b> 一键生成剪映官方草稿（pyJianYingDraft 多轨）。</p>
        {error && <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2 flex gap-1.5"><AlertCircle className="w-3.5 h-3.5 shrink-0"/>{error}</div>}
        {result && (
          <div className="bg-accent-green/10 border border-accent-green/30 rounded-xl p-2.5 space-y-1 text-xs">
            <div className="text-accent-green font-bold flex items-center gap-1"><Clock className="w-3 h-3"/> 导出成功 · {result.total_shots} 镜 · {result.duration_seconds}s</div>
            <div className="text-gray-300">草稿目录：<span className="font-mono text-[11px] break-all">{result.export_dir}</span></div>
            {result.jianyin_native_path && <div className="text-accent-green">已同步至剪映本地：{result.jianyin_native_path}</div>}
            {result.warnings?.length>0 && <div className="text-amber-300 text-[11px]">⚠️ {result.warnings.slice(0,2).join('； ')}</div>}
          </div>
        )}
        <button onClick={handleExport} disabled={exporting} className="w-full py-2 rounded-xl bg-gradient-to-r from-brand to-violet-600 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40">
          {exporting ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 导出中…</> : <><Download className="w-3.5 h-3.5"/> 一键导出剪映草稿</>}
        </button>
        <p className="text-[10px] text-gray-500 text-center">需已配置剪映草稿目录（设置→JIANYIN_DRAFT_PATH）才可在剪映客户端直接打开</p>
      </div>
    </div>
  );
};
