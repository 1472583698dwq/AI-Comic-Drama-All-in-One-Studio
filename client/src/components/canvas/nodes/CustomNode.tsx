// -*- coding: utf-8 -*-
/**
 * 自定义代码节点卡片 — 一段代码即一节点（视频超分/风格迁移/慢动作…）
 * 输入输出按其 input_schema 动态渲染，参数走 params_schema + DynamicControl，
 * 运行经全局 onExecute（nodeAgentExecutor custom 分支）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Boxes, Play, Loader2, Cpu } from 'lucide-react';
import { useCanvasStore } from '../../../stores/useCanvasStore';
import { apiService } from '../../../services/api';
import { paramsSchemaToSpecs } from '../providerSkills';
import { DynamicControl } from '../controls/DynamicControl';
import { ShotWriteBackControls } from './ShotWriteBackControl';

const HANDLE_MEDIA: Record<string, 'image' | 'video' | 'audio'> = {
  image: 'image', images: 'image', video: 'video', videos: 'video', audio: 'audio', audios: 'audio',
};

function slotType(key: string, def: any): 'image' | 'video' | 'audio' | 'text' {
  const h = String(def?.['x-handle'] || '').toLowerCase();
  if (HANDLE_MEDIA[h]) return HANDLE_MEDIA[h];
  if (def?.format === 'uri' || def?.items?.format === 'uri') {
    if (/audio/.test(key)) return 'audio';
    if (/video/.test(key)) return 'video';
    return 'image';
  }
  return 'text';
}

const defCache = new Map<string, any>();

export const CustomNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d: any = data || {};
  const { updateNodeData } = useCanvasStore();
  const [def, setDef] = useState<any>(d.definition || defCache.get(d.custom_node_id) || null);
  const [options, setOptions] = useState<any[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const res: any = await apiService.listCustomNodes();
        if (!stop) setOptions(res.nodes || []);
      } catch {}
      const cid = (useCanvasStore.getState as any)?.().nodes?.find?.((n: any) => n.id === id)?.data?.custom_node_id || d.custom_node_id;
      if (cid && !defCache.has(cid)) {
        try {
          const r: any = await apiService.getCustomNode(cid);
          const got = r?.node || r;
          defCache.set(cid, got);
          if (!stop) setDef(got);
        } catch {}
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.custom_node_id]);

  const inProps = def?.input_schema?.properties || {};
  const slots = useMemo(() => {
    const entries = Object.entries<any>(inProps);
    if (!entries.length) {
      return [
        { key: 'prompt', label: '提示词/文本', type: 'text' },
        { key: 'video', label: '视频', type: 'video' },
        { key: 'reference_images', label: '参考集', type: 'image' },
      ];
    }
    return entries.map(([k, v]) => ({ key: k, label: v.description || v.title || k, type: slotType(k, v) }));
  }, [def]);

  const paramSpecs = useMemo(() => paramsSchemaToSpecs(def?.params_schema), [def]);
  const params = d.params && typeof d.params === 'object' ? d.params : {};
  const outputs: Array<{ key: string; type: 'image' | 'video' | 'audio' | 'text'; label: string }> = useMemo(() => {
    const kind = def?.kind || 'utility';
    if (kind === 'image') return [{ key: 'image', type: 'image', label: '图像' }];
    if (kind === 'video') return [{ key: 'video', type: 'video', label: '视频' }];
    if (kind === 'audio') return [{ key: 'audio', type: 'audio', label: '音频' }];
    return [
      { key: 'image', type: 'image', label: '图像' },
      { key: 'video', type: 'video', label: '视频' },
      { key: 'audio', type: 'audio', label: '音频' },
      { key: 'text', type: 'text', label: '文本' },
    ];
  }, [def]);

  const run = async () => {
    if (running || !(d.onExecute as any)) return;
    setRunning(true);
    try { await (d.onExecute as any)(id); } catch (e: any) { alert(e?.message || '执行失败'); } finally { setRunning(false); }
  };

  const st = d.agent_state || {};
  const resultUrl = d.video_url || d.image_url || d.audio_url || '';
  const resultKind = d.video_url ? 'video' : d.image_url ? 'image' : d.audio_url ? 'audio' : '';

  return (
    <div className={`w-[340px] bg-surface rounded-3xl border-2 transition-all relative select-none shadow-xl ${selected ? 'border-teal-500 ring-4 ring-teal-500/20' : 'border-white/10 hover:border-teal-500/40'}`}>
      <div className="px-4 py-3 flex items-center gap-2.5 border-b border-white/10">
        <div className="w-6 h-6 rounded-lg bg-teal-500/15 flex items-center justify-center text-teal-300"><Boxes className="w-3.5 h-3.5" /></div>
        <span className="text-xs font-bold text-white/95 truncate">{def?.name || '自定义节点'}</span>
        {def?.kind && <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-500/15 border border-teal-500/30 text-teal-300 font-mono">{def.kind}</span>}
        <span className="ml-auto text-[10px] font-mono text-white/40">#{id.slice(-4)}</span>
      </div>

      {/* 输入句柄（左） */}
      {slots.map((s: any, i: number) => (
        <Handle key={`in-${s.key}`} type="target" position={Position.Left} id={s.key}
          className="!w-3 !h-3 !border-2 !border-surface !bg-teal-400" style={{ top: `${22 + i * 13}%` }} title={`${s.label} (${s.key})`} />
      ))}
      {/* 输出句柄（右） */}
      {outputs.map((o, i: number) => (
        <Handle key={`out-${o.key}`} type="source" position={Position.Right} id={o.key}
          className="!w-3 !h-3 !border-2 !border-surface !bg-emerald-400" style={{ top: `${22 + i * 13}%` }} title={`${o.label} (${o.key})`} />
      ))}

      <div className="p-3.5 space-y-2.5">
        <select
          value={d.custom_node_id || ''}
          onChange={(e) => updateNodeData(id, { custom_node_id: e.target.value, definition: undefined })}
          className="w-full bg-surface-secondary border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white focus:outline-none focus:border-teal-500"
        >
          <option value="">选择自定义节点…</option>
          {options.map((o: any) => <option key={o.id} value={o.id}>{o.name}（{o.kind}/{o.language}）</option>)}
        </select>
        {def?.description && <div className="text-[10px] text-white/40 leading-4">{def.description}</div>}

        {(d.prompt !== undefined || slots.some((s: any) => s.type === 'text')) && (
          <textarea
            value={d.prompt || d.text || ''}
            onChange={(e) => updateNodeData(id, { prompt: e.target.value, text: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="文本输入（连线优先）…"
            rows={2}
            className="w-full bg-surface-secondary border border-white/10 rounded-xl px-2.5 py-2 text-xs text-white placeholder-white/25 focus:outline-none focus:border-teal-500 resize-none"
          />
        )}

        {paramSpecs.length > 0 && (
          <div className="space-y-2 rounded-xl bg-surface-secondary border border-white/10 p-2.5">
            <div className="text-[10px] font-bold text-white/50 flex items-center gap-1"><Cpu className="w-3 h-3" />参数</div>
            {paramSpecs.filter((s) => s.visibility !== 'hidden').map((s) => (
              <DynamicControl key={s.id} spec={s} compact
                value={params[s.param_name] ?? s.default_value}
                onChange={(v) => updateNodeData(id, { params: { ...params, [s.param_name]: v } })} />
            ))}
          </div>
        )}

        {resultUrl ? (
          <div className="rounded-xl overflow-hidden border border-white/10 bg-surface-secondary">
            {resultKind === 'video' ? <video src={resultUrl} controls className="w-full max-h-40" />
              : resultKind === 'image' ? <img src={resultUrl} alt="" className="w-full max-h-40 object-cover" />
              : <audio src={resultUrl} controls className="w-full" />}
          </div>
        ) : d.text && !d.prompt ? (
          <div className="text-[11px] text-white/70 bg-surface-secondary rounded-xl p-2 whitespace-pre-wrap max-h-24 overflow-y-auto">{d.text}</div>
        ) : null}
        {st.status === 'failed' && st.error && <div className="text-[10px] text-red-400">❌ {st.error}</div>}

        <ShotWriteBackControls nodeId={id} nodeType="custom" data={d} />

        <div className="flex gap-2">
          <button onClick={run} disabled={running || !d.custom_node_id}
            className="flex-1 py-2 rounded-xl bg-teal-500 hover:bg-teal-400 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{running ? '运行中' : '运行节点'}
          </button>
        </div>
      </div>
    </div>
  );
};
