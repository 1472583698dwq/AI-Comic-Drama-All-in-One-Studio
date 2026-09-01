// -*- coding: utf-8 -*-
/**
 * 节点 Agent 控制台（底部栏形态）— 用户只说人话，Agent 负责：
 * ①理解意图→选 skill ②选/用生成源 ③润色 prompt ④按该源异构 schema 组参数 ⑤调 API ⑥结果回节点
 * 点任何 生图/视频/配音 节点时，底部全局导演栏自动切换为此控制台。
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Sparkles, RefreshCw, Plus, X, Loader2, AlertTriangle, Image as ImageIcon, Film, Mic, Settings2 } from 'lucide-react';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { apiService } from '../../services/api';
import { DynamicProviderInfo, extractSlotsFromProvider, AssetSlotDef } from './providerSkills';
import { CanvasResourcePickerModal } from './CanvasResourcePickerModal';
import { DynamicControl, ControlSpec } from './controls/DynamicControl';

function paramsSchemaToSpecs(schema?: Record<string, any>): ControlSpec[] {
  if (!schema?.properties) return [];
  const requiredArr: string[] = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties).map(([key, def]: any) => {
    const hasEnum = Array.isArray(def.enum) && def.enum.length > 0;
    let type: ControlSpec['type'] = 'text';
    if (hasEnum) type = 'combo';
    else if (def.type === 'integer' || def.type === 'number') type = 'number';
    else if (def.type === 'boolean') type = 'boolean';
    else if (def.type === 'string' && def.format === 'uri') type = 'image';
    return {
      id: key,
      param_name: key,
      label: def.title || key,
      type,
      description: def.description || '',
      options: hasEnum ? def.enum.map((v: any) => String(v)) : undefined,
      default_value: def.default,
      required: requiredArr.includes(key) || !!def.required,
      min: def.minimum ?? def.min,
      max: def.maximum ?? def.max,
      step: def.step,
    };
  });
}

type GenKind = 'image' | 'video' | 'audio';

export const NodeAgentConsole: React.FC<{ nodeId: string; kind: GenKind }> = ({ nodeId, kind }) => {
  const node = useCanvasStore((s) => s.nodes.find((n: any) => n.id === nodeId));
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const d: any = node?.data || {};

  const [providers, setProviders] = useState<DynamicProviderInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [idea, setIdea] = useState<string>(() => d.idea || d.prompt || d.text || '');
  const [executing, setExecuting] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<AssetSlotDef | null>(null);

  const providerId: string = d.provider_id || d.provider || '';
  const currentProvider = useMemo(() => providers.find((p) => p.id === providerId) || null, [providers, providerId]);
  const slots = useMemo(() => extractSlotsFromProvider(currentProvider, kind), [currentProvider, kind]);
  const paramSpecs = useMemo(() => paramsSchemaToSpecs(currentProvider?.params_schema), [currentProvider]);
  const customParams: Record<string, any> = d.params || d.provider_params || {};
  const agentState: any = d.agent_state;
  const lastPlan: any = d._last_agent_plan;

  const fetchProviders = useCallback(async () => {
    setLoadingProviders(true);
    try {
      const res: any = await apiService.listProviders({ kind, include_builtin: true } as any).catch(() => null);
      setProviders(res?.providers || []);
    } finally { setLoadingProviders(false); }
  }, [kind]);

  useEffect(() => { fetchProviders(); const h = () => fetchProviders(); window.addEventListener('provider-refresh', h as any); return () => window.removeEventListener('provider-refresh', h as any); }, [fetchProviders]);
  useEffect(() => {
    const v = d.idea || d.prompt || d.text || '';
    if (v !== idea) setIdea(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const handleIdeaChange = (v: string) => { setIdea(v); updateNodeData(nodeId, { idea: v, prompt: v, text: v }); };
  const selectProvider = (pid: string) => {
    const found = providers.find((p) => p.id === pid) || null;
    const schemaDefaults: Record<string, any> = {};
    if (found?.params_schema?.properties) {
      for (const [k, v] of Object.entries<any>(found.params_schema.properties)) {
        if (v.default !== undefined) schemaDefaults[k] = v.default;
      }
    }
    const nextParams = { ...schemaDefaults, ...(found?.default_params || {}) };
    // 保留已有的用户覆写（若切回同一源）
    const merged = pid === providerId ? customParams : nextParams;
    updateNodeData(nodeId, pid ? { provider_id: pid, provider: pid, params: merged, provider_params: merged } : { provider_id: undefined, provider: undefined });
  };
  const handleParamChange = (key: string, val: any) => {
    const next = { ...customParams, [key]: val };
    updateNodeData(nodeId, { params: next, provider_params: next, [key]: val });
  };
  const isSlotMulti = (s: AssetSlotDef) => s.key === 'reference_images' || s.key === 'reference_video';
  const handleSlotSelect = (urlOrUrls: string | string[], meta?: any) => {
    if (!pickerSlot) return;
    const patch: Record<string, any> = {};
    if (isSlotMulti(pickerSlot)) {
      const arr = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
      const existing: string[] = Array.isArray(d[pickerSlot.key]) ? d[pickerSlot.key] : [];
      const merged = [...existing]; for (const u of arr) if (!merged.includes(u)) merged.push(u);
      patch[pickerSlot.key] = merged;
      if (pickerSlot.key === 'reference_images') patch.reference = merged[0];
    } else {
      const url = Array.isArray(urlOrUrls) ? urlOrUrls[0] : urlOrUrls;
      patch[pickerSlot.key] = url;
      if (pickerSlot.key === 'first_frame') patch.first_frame_url = url;
      if (pickerSlot.key === 'last_frame') patch.last_frame_url = url;
      if (pickerSlot.key === 'reference') patch.reference_images = [url];
      if (pickerSlot.key === 'ref_audio') patch.ref_audio_path = url;
    }
    if (meta?.visual_prompt && !(idea || '').includes(meta.visual_prompt)) {
      const nextIdea = idea ? `${idea}, ${meta.visual_prompt}` : meta.visual_prompt;
      setIdea(nextIdea); patch.idea = nextIdea; patch.prompt = nextIdea; patch.text = nextIdea;
    }
    if (meta?.voice_id && kind === 'audio') patch.voice_id = meta.voice_id;
    updateNodeData(nodeId, patch);
    setPickerSlot(null);
  };
  const clearSlot = (key: string) => {
    const patch: Record<string, any> = { [key]: undefined };
    if (key === 'first_frame') patch.first_frame_url = undefined;
    if (key === 'last_frame') patch.last_frame_url = undefined;
    if (key === 'reference' || key === 'reference_images') { patch.reference = undefined; patch.reference_images = undefined; }
    if (key === 'ref_audio') patch.ref_audio_path = undefined;
    updateNodeData(nodeId, patch);
  };

  const buildSlotsPayload = (): Record<string, any> => {
    const s: Record<string, any> = {};
    const ff = d.first_frame || d.first_frame_url; if (ff) s.first_frame = ff;
    const lf = d.last_frame || d.last_frame_url; if (lf) s.last_frame = lf;
    const refs: string[] = []; if (Array.isArray(d.reference_images)) refs.push(...d.reference_images); if (d.reference && !refs.includes(d.reference)) refs.push(d.reference);
    if (refs.length) { s.reference_images = refs; s.reference = refs[0]; }
    const ra = d.ref_audio || d.ref_audio_path; if (ra) s.ref_audio = ra;
    return s;
  };

  const handleExecute = async () => {
    const raw = (idea || d.idea || d.prompt || d.text || '').trim();
    if (!raw) { alert('请先输入你的需求／想法'); return; }
    const slotsPayload = buildSlotsPayload();
    const pid = d.provider_id || d.provider || '';
    // 当前面板上的参数覆写（用户显式改过的比例/分辨率等），合并进 Agent 调用
    const paramsOverride: Record<string, any> = {};
    for (const spec of paramSpecs) {
      const v = customParams[spec.param_name];
      if (v !== undefined && v !== '' && v !== null) paramsOverride[spec.param_name] = v;
    }
    setExecuting(true);
    updateNodeData(nodeId, { agent_state: { status: 'running', tool: pid ? `provider_${pid}` : 'agent_plan', provider_id: pid || undefined, updated_at: new Date().toISOString() } });
    try {
      const res: any = await apiService.canvasAgentGenerate({ node_type: kind, idea: raw, provider_id: pid, slots: slotsPayload, params: paramsOverride } as any);
      if (res.status === 'error') throw new Error(res.error || '生成失败');
      const plan = res.plan || {}; const result = res.result || {};
      const patch: Record<string, any> = { _last_agent_plan: plan };
      if (plan.prompt) { patch.prompt = plan.prompt; patch.polished_prompt = plan.prompt; }
      if (plan.skill_id) patch.skill_id = plan.skill_id;
      if (plan.provider_id) { patch.provider_id = plan.provider_id; patch.provider = plan.provider_id; }
      if (plan.model) patch.model = plan.model;
      if (result.image_url || result.url) { const u = result.image_url || result.url; patch.image_url = u; patch.result_url = u; }
      if (result.video_url) patch.video_url = result.video_url;
      if (result.audio_url) patch.audio_url = result.audio_url;
      patch.agent_state = { status: 'completed', tool: `provider_${plan.provider_id || pid}`, provider_id: plan.provider_id || pid, reasoning: plan.reasoning, elapsed_ms: res.elapsed_ms, updated_at: new Date().toISOString() };
      updateNodeData(nodeId, patch);
    } catch (e: any) {
      updateNodeData(nodeId, { agent_state: { status: 'failed', provider_id: providerId || undefined, error: String(e?.message || e).slice(0, 220), updated_at: new Date().toISOString() } });
    } finally { setExecuting(false); }
  };

  const kindIcon = kind === 'image' ? <ImageIcon className="w-3.5 h-3.5 text-violet-400" /> : kind === 'video' ? <Film className="w-3.5 h-3.5 text-orange-400" /> : <Mic className="w-3.5 h-3.5 text-pink-400" />;
  const kindLabel = kind === 'image' ? '分镜生图 Agent' : kind === 'video' ? '动态导演视频 Agent' : '配音 / 声音 Agent';

  return (
    <div className="w-full flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      {/* 头部：节点身份 + 源选择 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/40 border border-white/10 text-white/90 text-xs font-bold">{kindIcon}{kindLabel}<span className="font-mono text-[10px] text-white/40">#{nodeId.slice(-4)}</span></span>
        {lastPlan?.skill_id && <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-600 text-white font-mono">{lastPlan.skill_id}</span>}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[11px] text-white/40">生成源</span>
          <select value={providerId} onChange={(e) => selectProvider(e.target.value)} className="bg-black/50 border border-white/15 rounded-lg px-2 py-1 text-xs text-white/90 focus:outline-none focus:border-violet-500 max-w-[180px] truncate">
            <option value="">{loadingProviders ? '加载中…' : 'Agent 自动选源'}</option>
            {providers.map((p) => (<option key={p.id} value={p.id}>{p.display_name || p.name}{p.provider_type === 'comfyui' ? ' ·ComfyUI' : ''}</option>))}
          </select>
          <button onClick={fetchProviders} disabled={loadingProviders} className="p-1 rounded text-white/40 hover:text-white hover:bg-white/10" title="刷新源"><RefreshCw className={`w-3 h-3 ${loadingProviders ? 'animate-spin' : ''}`} /></button>
          {paramSpecs.length > 0 && (
            <button onClick={() => setShowParams((v) => !v)} className={`p-1 rounded ${showParams ? 'bg-violet-600 text-white' : 'text-white/40 hover:text-white hover:bg-white/10'}`} title={`${paramSpecs.length} 项参数`}><Settings2 className="w-3 h-3" /></button>
          )}
        </div>
      </div>

      {/* 插槽 */}
      {slots.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {slots.map((slot) => {
            const raw = d[slot.key] ?? (slot.key === 'first_frame' ? d.first_frame_url : slot.key === 'last_frame' ? d.last_frame_url : slot.key === 'ref_audio' ? d.ref_audio || d.ref_audio_path : slot.key === 'reference_images' ? (Array.isArray(d.reference_images) ? d.reference_images : d.reference ? [d.reference] : undefined) : undefined);
            const populated = Array.isArray(raw) ? raw.length > 0 : !!raw;
            const thumb = Array.isArray(raw) ? raw[0] : raw;
            return (
              <div key={slot.key} className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border text-[10px] ${populated ? 'bg-violet-950/30 border-violet-500/40 text-violet-200' : slot.required ? 'bg-red-950/20 border-dashed border-red-500/50 text-red-300' : 'bg-white/[0.02] border-dashed border-white/20 text-white/50'}`}>
                {populated && thumb ? (<div className="w-5 h-5 rounded bg-black/60 overflow-hidden border border-white/20">{slot.type === 'video' ? <video src={thumb} className="w-full h-full object-cover" /> : slot.type === 'audio' ? <div className="w-full h-full flex items-center justify-center text-[8px]">🎵</div> : <img src={thumb} alt="" className="w-full h-full object-cover" />}</div>) : (<Plus className="w-3 h-3" />)}
                <button onClick={() => setPickerSlot(slot)} className="font-medium hover:text-white">{slot.label}{slot.required && <span className="text-red-400">*</span>}{populated && Array.isArray(raw) && raw.length > 1 ? ` ×${raw.length}` : ''}</button>
                {populated && <button onClick={() => clearSlot(slot.key)} className="text-white/40 hover:text-red-400" title="清除"><X className="w-2.5 h-2.5" /></button>}
              </div>
            );
          })}
        </div>
      )}

      {/* 高级参数（Agent 已填初值，用户可改；如比例/分辨率/步数等） */}
      {showParams && paramSpecs.length > 0 && (
        <div className="grid grid-cols-2 gap-2 p-2 rounded-xl bg-black/40 border border-white/10 max-h-[180px] overflow-y-auto">
          {paramSpecs.map((spec) => (
            <DynamicControl key={spec.param_name} spec={spec} value={customParams[spec.param_name] ?? spec.default_value} onChange={(v) => handleParamChange(spec.param_name, v)} />
          ))}
        </div>
      )}

      {/* 想法输入：用户说人话 */}
      <textarea value={idea} onChange={(e) => handleIdeaChange(e.target.value)} placeholder={kind === 'image' ? '用人话说你的画面想法，Agent 会润色成专业画面描述并按所选生成源组参数后调用…  例：生成一个 JK 少女在樱花校园的电影感肖像' : kind === 'video' ? '描述你想要的镜头运动与主体动作，Agent 自动选首尾帧/参考模式并调用…  例：让猫咪向前冲刺，镜头缓慢推入' : '输入台词，Agent 自动选配音源与情绪并调用…'} rows={2} className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-white/40 focus:outline-none focus:border-violet-500 resize-none" />

      {/* Agent 决策白盒 */}
      {lastPlan && (
        <div className="px-2.5 py-2 rounded-xl bg-black/40 border border-white/10 text-[11px] leading-relaxed">
          <div className="flex items-center gap-1.5 text-violet-300 font-bold"><Sparkles className="w-3 h-3" /> Agent 决策</div>
          <div className="text-white/70 mt-1"><span className="text-white/40">skill</span> {lastPlan.skill_id} · <span className="text-white/40">源</span> {(providers.find((p) => p.id === lastPlan.provider_id)?.display_name) || lastPlan.provider_id} · <span className="text-white/40">模型</span> {lastPlan.model || '默认'}</div>
          {lastPlan.reasoning && <div className="text-white/50 mt-0.5">{lastPlan.reasoning}</div>}
          {lastPlan.prompt && <div className="text-white/60 mt-1 line-clamp-2">润色后 prompt：{lastPlan.prompt}</div>}
          {lastPlan.params && Object.keys(lastPlan.params).length > 0 && <div className="text-white/40 mt-0.5 font-mono text-[10px]">参数 {JSON.stringify(lastPlan.params)}</div>}
        </div>
      )}
      {agentState?.status === 'running' && <div className="text-[11px] text-violet-300 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Agent 规划并调用 {agentState.tool}…</div>}
      {agentState?.status === 'failed' && <div className="text-[11px] text-red-400 flex items-center gap-1" title={agentState.error}><AlertTriangle className="w-3 h-3" /> {agentState.error}</div>}

      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 text-[10px] text-white/30 truncate">{providerId ? `就绪 · ${currentProvider?.display_name || providerId}` : 'Agent 将自动选择最优生成源'}</span>
        <button onClick={handleExecute} disabled={executing || !idea.trim()} className={`px-5 py-2 rounded-xl text-xs font-bold text-white flex items-center gap-1.5 ${executing ? 'bg-white/10 text-white/40' : 'bg-violet-600 hover:bg-violet-500 shadow-lg shadow-violet-600/30'}`}>
          {executing ? (<><Loader2 className="w-3.5 h-3.5 animate-spin" /> Agent 执行中…</>) : (<><Sparkles className="w-3.5 h-3.5" /> 让 Agent 执行</>)}
        </button>
      </div>

      {pickerSlot && <CanvasResourcePickerModal isOpen={!!pickerSlot} onClose={() => setPickerSlot(null)} onSelect={handleSlotSelect} slotKey={pickerSlot.key} slotLabel={pickerSlot.label} multiSelect={isSlotMulti(pickerSlot)} acceptType={pickerSlot.type} />}
    </div>
  );
};
