// -*- coding: utf-8 -*-
/**
 * 声明式扩展节点卡片（canvas_nodes 插件前端扩展点）。
 * 插件只声明 inputs/outputs/params_schema/run，本组件负责通用渲染：
 * - 输入/输出句柄按声明生成；
 * - 参数走 params_schema + DynamicControl；
 * - 运行经全局 onExecute（CreativeCanvas → 画布引擎 ext-node 分支 → 统一执行口）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Play, Loader2, Cpu, Wand2 } from 'lucide-react';
import { useCanvasStore } from '../../../stores/useCanvasStore';
import { apiService } from '../../../services/api';
import { paramsSchemaToSpecs } from '../providerSkills';
import { DynamicControl } from '../controls/DynamicControl';
import { ShotWriteBackControls } from './ShotWriteBackControl';
import { getCanvasNodeSpec, registerCanvasNodeSpec, type CanvasNodeSpec } from '../canvasNodeSpecs';

const TYPE_TOP: Record<string, string> = {
  image: 'image', images: 'image',
  video: 'video', videos: 'video',
  audio: 'audio', audios: 'audio',
};
const normalizeType = (t?: string): 'image' | 'video' | 'audio' | 'text' => {
  const k = String(t || 'text').toLowerCase();
  if (TYPE_TOP[k]) return TYPE_TOP[k] as any;
  return 'text';
};
const INPUT_HANDLE_CLASS: Record<string, string> = {
  image: '!bg-violet-400', video: '!bg-orange-400', audio: '!bg-pink-400', text: '!bg-sky-400',
};

const defCache = new Map<string, CanvasNodeSpec>();

export const ExtNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data || {};
  const { updateNodeData } = useCanvasStore();
  const [spec, setSpec] = useState<CanvasNodeSpec | null>(d.definition || getCanvasNodeSpec(d.canvas_node_id) || defCache.get(d.canvas_node_id) || null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let stop = false;
    const cid = d.canvas_node_id;
    if (!cid) return;
    const cached = getCanvasNodeSpec(cid) || defCache.get(cid);
    if (cached) { setSpec(cached); return; }
    (async () => {
      try {
        const res: any = await apiService.getCanvasNode(cid);
        const got: CanvasNodeSpec = res?.node || res;
        if (!got?.id) return;
        defCache.set(cid, got);
        registerCanvasNodeSpec(got);
        if (!stop) setSpec(got);
      } catch { /* 节点可能已被插件禁用/卸载 */ }
    })();
    return () => { stop = true; };
  }, [d.canvas_node_id]);

  const inputs = useMemo(
    () => (spec?.inputs || []).map((p) => ({ ...p, type: normalizeType(p.type) })),
    [spec],
  );
  const outputs = useMemo(
    () => (spec?.outputs || []).map((p) => ({ ...p, type: normalizeType(p.type) })),
    [spec],
  );
  const paramSpecs = useMemo(() => paramsSchemaToSpecs(spec?.params_schema), [spec]);
  const params = d.params && typeof d.params === 'object' ? d.params : {};
  const hasTextInput = inputs.some((p) => p.type === 'text');

  const run = async () => {
    if (running || !(d.onExecute as any)) return;
    setRunning(true);
    try { await (d.onExecute as any)(id); } catch (e: any) { alert(e?.message || '执行失败'); } finally { setRunning(false); }
  };

  const st = d.agent_state || {};
  const resultUrl = d.video_url || d.image_url || d.audio_url || '';
  const resultKind = d.video_url ? 'video' : d.image_url ? 'image' : d.audio_url ? 'audio' : '';

  return (
    <div className={`w-[340px] bg-[#141419] rounded-3xl border-2 transition-all relative select-none shadow-xl ${selected ? 'border-cyan-500 ring-4 ring-cyan-500/20' : 'border-white/10 hover:border-cyan-500/40'}`}>
      <div className="px-4 py-3 flex items-center gap-2.5 border-b border-white/10">
        <div className="w-6 h-6 rounded-lg bg-cyan-500/15 flex items-center justify-center text-cyan-300"><Wand2 className="w-3.5 h-3.5" /></div>
        <span className="text-xs font-bold text-white/95 truncate">{spec?.name || '扩展节点'}</span>
        {spec?.kind && <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 font-mono">{spec.kind}</span>}
        <span className="ml-auto text-[10px] font-mono text-white/40">#{id.slice(-4)}</span>
      </div>

      {/* 输入句柄（左） */}
      {inputs.map((s, i) => (
        <Handle key={`in-${s.id}`} type="target" position={Position.Left} id={s.id}
          className={`!w-3 !h-3 !border-2 !border-surface ${INPUT_HANDLE_CLASS[s.type] || '!bg-sky-400'}`}
          style={{ top: `${22 + i * 13}%` }} title={`${s.label || s.id} (${s.id})`} />
      ))}
      {/* 输出句柄（右） */}
      {outputs.map((o, i) => (
        <Handle key={`out-${o.id}`} type="source" position={Position.Right} id={o.id}
          className="!w-3 !h-3 !border-2 !border-surface !bg-emerald-400"
          style={{ top: `${22 + i * 13}%` }} title={`${o.label || o.id} (${o.id})`} />
      ))}

      <div className="p-3.5 space-y-2.5">
        {!spec && (
          <div className="text-[11px] text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded-xl px-2.5 py-2">
            节点声明不存在（插件可能未启用或已卸载）
          </div>
        )}
        {spec?.description && <div className="text-[10px] text-white/40 leading-4">{spec.description}</div>}
        {spec?.run?.extension && <div className="text-[10px] font-mono text-white/30 truncate" title={spec.run.extension}>→ {spec.run.extension}</div>}

        {(hasTextInput || d.prompt !== undefined) && (
          <textarea
            value={d.prompt || d.text || ''}
            onChange={(e) => updateNodeData(id, { prompt: e.target.value, text: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="文本输入（连线优先）…"
            rows={2}
            className="w-full bg-black/50 border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white placeholder-white/25 focus:outline-none focus:border-cyan-500 resize-none"
          />
        )}

        {paramSpecs.length > 0 && (
          <div className="space-y-2 rounded-xl bg-black/30 border border-white/10 p-2.5">
            <div className="text-[10px] font-bold text-white/50 flex items-center gap-1"><Cpu className="w-3 h-3" />参数</div>
            {paramSpecs.filter((s: any) => s.visibility !== 'hidden').map((s: any) => (
              <DynamicControl key={s.id} spec={s} compact
                value={params[s.param_name] ?? s.default_value}
                onChange={(v) => updateNodeData(id, { params: { ...params, [s.param_name]: v } })} />
            ))}
          </div>
        )}

        {resultUrl ? (
          <div className="rounded-xl overflow-hidden border border-white/10 bg-black/50">
            {resultKind === 'video' ? <video src={resultUrl} controls className="w-full max-h-40" />
              : resultKind === 'image' ? <img src={resultUrl} alt="" className="w-full max-h-40 object-cover" />
              : <audio src={resultUrl} controls className="w-full" />}
          </div>
        ) : (d.text && !d.prompt) ? (
          <div className="text-[11px] text-white/70 bg-black/40 rounded-xl p-2 whitespace-pre-wrap max-h-24 overflow-y-auto">{d.text}</div>
        ) : null}
        {st.status === 'failed' && st.error && <div className="text-[10px] text-red-400">❌ {st.error}</div>}

        <ShotWriteBackControls nodeId={id} nodeType="ext-node" data={d} />

        <div className="flex gap-2">
          <button onClick={run} disabled={running || !d.canvas_node_id}
            className="flex-1 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{running ? '运行中' : '运行节点'}
          </button>
        </div>
      </div>
    </div>
  );
};
