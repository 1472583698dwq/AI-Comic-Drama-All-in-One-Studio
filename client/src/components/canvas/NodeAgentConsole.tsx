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
import { DynamicProviderInfo, extractSlotsFromProvider, AssetSlotDef, getSkillsForKind, describeProviderSlots, paramsSchemaToSpecs } from './providerSkills';
import { CanvasResourcePickerModal } from './CanvasResourcePickerModal';
import { DynamicControl, groupSpecs, CATEGORY_LABEL } from './controls/DynamicControl';

type GenKind = 'image' | 'video' | 'audio';

export const NodeAgentConsole: React.FC<{ nodeId: string; kind: GenKind }> = ({ nodeId, kind }) => {
  const node = useCanvasStore((s) => s.nodes.find((n: any) => n.id === nodeId));
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const d: any = node?.data || {};

  const [providers, setProviders] = useState<DynamicProviderInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [idea, setIdea] = useState<string>(() => d.idea || d.prompt || d.text || '');
  const [showParams, setShowParams] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<AssetSlotDef | null>(null);

  const providerId: string = d.provider_id || d.provider || '';
  const currentProvider = useMemo(() => providers.find((p) => p.id === providerId) || null, [providers, providerId]);
  const slots = useMemo(() => extractSlotsFromProvider(currentProvider, kind), [currentProvider, kind]);
  const paramSpecs = useMemo(() => paramsSchemaToSpecs(currentProvider?.params_schema), [currentProvider]);
  const customParams: Record<string, any> = d.params || d.provider_params || {};
  const agentState: any = d.agent_state;
  // 决策白盒仅当其源与当前绑定一致时显示，陈旧 plan（源已删/已切换）直接隐藏
  const _rawPlan: any = d._last_agent_plan;
  const lastPlan: any = _rawPlan && (!_rawPlan.provider_id || !providerId || _rawPlan.provider_id === providerId) ? _rawPlan : null;
  const executing = agentState?.status === 'running';
  const skills = useMemo(() => getSkillsForKind(kind), [kind]);
  const activeSkill = d.skill_id || lastPlan?.skill_id || skills[0]?.id || '';

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
  }, [nodeId, d.idea, d.prompt, d.text]);

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
    const merged = pid === providerId ? customParams : nextParams;
    // 切源即清幽灵：旧源的决策白盒与排队 task 不得再显示（prov_4dc87988 类残留即此来源）
    const patch: Record<string, any> = pid
      ? { provider_id: pid, provider: pid, params: merged, provider_params: merged, _last_agent_plan: undefined, _taskId: undefined, _polling: false }
      : { provider_id: undefined, provider: undefined, _last_agent_plan: undefined, _taskId: undefined, _polling: false };
    // 切换源时按新源的插槽 maxCount 裁剪已上传文件
    if (found) {
      const newSlots = extractSlotsFromProvider(found, kind);
      for (const s of newSlots) {
        const cur = d[s.key] ?? (s.originalKey ? (d as any)[s.originalKey] : undefined);
        if (Array.isArray(cur) && s.maxCount !== undefined && cur.length > s.maxCount) {
          const trimmed = cur.slice(-s.maxCount);
          patch[s.key] = trimmed;
          if (s.originalKey && s.originalKey !== s.key) (patch as any)[s.originalKey] = trimmed;
        }
      }
    }
    updateNodeData(nodeId, patch);
  };
  const handleParamChange = (key: string, val: any) => {
    const next = { ...customParams, [key]: val };
    updateNodeData(nodeId, { params: next, provider_params: next, [key]: val });
  };
  const selectSkill = (skillId: string) => {
    updateNodeData(nodeId, { skill_id: skillId });
  };
  const isSlotMulti = (s: AssetSlotDef) => !!s.multi || (s.maxCount !== undefined && s.maxCount > 1);
  const handleSlotSelect = (urlOrUrls: string | string[], meta?: any) => {
    if (!pickerSlot) return;
    const max = pickerSlot.maxCount;
    const patch: Record<string, any> = {};
    // 只写插槽声明的键（归一 key + 源属性 originalKey），不做任何别名猜测
    const writeKeys = new Set<string>([pickerSlot.key, pickerSlot.originalKey || pickerSlot.key]);
    if (isSlotMulti(pickerSlot)) {
      const arr = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
      const existing: string[] = Array.isArray(d[pickerSlot.key]) ? d[pickerSlot.key] : [];
      const merged = [...existing];
      for (const u of arr) if (!merged.includes(u)) merged.push(u);
      let limited = merged;
      if (max !== undefined && merged.length > max) {
        limited = merged.slice(-max);
        try { alert(`该插槽最多支持 ${max} 张，已自动保留最新的 ${max} 张`); } catch {}
      }
      writeKeys.forEach(k => { patch[k] = limited; });
    } else {
      const url = Array.isArray(urlOrUrls) ? urlOrUrls[0] : urlOrUrls;
      writeKeys.forEach(k => { patch[k] = url; });
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
    const slot = slots.find(s => s.key === key);
    const patch: Record<string, any> = { [key]: undefined };
    if (slot?.originalKey && slot.originalKey !== key) patch[slot.originalKey] = undefined;
    updateNodeData(nodeId, patch);
  };

  const buildSlotsPayload = (): Record<string, any> => {
    const s: Record<string, any> = {};
    // 完全按当前源 input_schema 声明的插槽组装：归一键 + 源原始键同时注入，其余不做映射
    for (const slot of slots) {
      const raw = d[slot.key] ?? (slot.originalKey ? d[slot.originalKey] : undefined);
      if (raw === undefined || raw === null || raw === '') continue;
      const vals = Array.isArray(raw) ? raw : [raw];
      if (vals.length === 0) continue;
      const value = isSlotMulti(slot) ? vals : vals[0];
      s[slot.key] = value;
      if (slot.originalKey && slot.originalKey !== slot.key) s[slot.originalKey] = value;
    }
    return s;
  };

  const handleExecute = async () => {
    const raw = (idea || d.idea || d.prompt || d.text || '').trim();
    if (!raw) { alert('请先输入你的需求／想法'); return; }
    if ((d.agent_state as any)?.status === 'running') return;
    const slotsPayload = buildSlotsPayload();
    const pid = d.provider_id || d.provider || '';
    const skillId = d.skill_id || activeSkill || '';
    // 收集用户在高级面板改过的所有异构参数，原样透传；枚举合法性由后端 validate_user_params 单点校验
    const paramsOverride: Record<string, any> = {};
    for (const [k, v] of Object.entries(customParams)) {
      if (v === undefined || v === '' || v === null) continue;
      if (['provider','provider_id','provider_params','params'].includes(k)) continue;
      paramsOverride[k] = v;
    }
    updateNodeData(nodeId, { agent_state: { status: 'running', tool: pid ? `provider_${pid}` : 'agent_plan', provider_id: pid || undefined, updated_at: new Date().toISOString() } });
    try {
      const res: any = await apiService.canvasAgentGenerate({ node_type: kind, idea: raw, provider_id: pid, skill_id: skillId, slots: slotsPayload, params: paramsOverride, node_id: nodeId } as any);
      if (res.status === 'error') throw new Error(res.error || '生成失败');
      const plan = res.plan || {}; const result = res.result || {};
      // 异步视频提交即返 task_id：先落盘 task_id（重启可恢复），再轮询状态接口直到出片，不吞结果
      if (kind === 'video' && !result.video_url && result.task_id) {
        updateNodeData(nodeId, { _taskId: result.task_id, _polling: true });
        let url = '';
        let lastErr = '';
        for (let i = 0; i < 140; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const st: any = await apiService.getVideoTaskStatus(result.task_id);
            const s = (st.status || st.state || '').toString().toUpperCase();
            if (s === 'SUCCESS' || s === 'COMPLETED') {
              url = st.video_url || st.videoUrl || st.results?.[0] || st.url || '';
              if (url) break;
            }
            if (s === 'FAILED' || s === 'FAIL' || s === 'ERROR') throw new Error(st.error || st.msg || '视频任务失败');
          } catch (e: any) {
            const msg = e?.message || '';
            if (msg.includes('任务失败') || msg.includes('FAILED')) { lastErr = msg; break; }
          }
        }
        if (!url) throw new Error(lastErr || `视频排队超时 task_id=${result.task_id}，task_id 已保留在节点，可恢复查询`);
        result.video_url = url;
        updateNodeData(nodeId, { _polling: false });
      }
      const patch: Record<string, any> = { _last_agent_plan: plan };
      if (plan.prompt) { patch.prompt = plan.prompt; patch.polished_prompt = plan.prompt; }
      if (plan.skill_id) patch.skill_id = plan.skill_id;
      if (plan.provider_id) { patch.provider_id = plan.provider_id; patch.provider = plan.provider_id; }
      if (plan.model) patch.model = plan.model;
      if (plan.params) { patch.params = { ...customParams, ...plan.params }; patch.provider_params = patch.params; Object.assign(patch, plan.params); }
      if (result.image_url || result.url) { const u = result.image_url || result.url; patch.image_url = u; patch.result_url = u; }
      if (result.video_url) patch.video_url = result.video_url;
      if (result.audio_url) patch.audio_url = result.audio_url;
      if (result.width) patch.width = result.width;
      if (result.height) patch.height = result.height;
      if (result.width && result.height) patch.aspect_ratio = `${result.width}:${result.height}`;
      patch.agent_state = { status: 'completed', tool: `provider_${plan.provider_id || pid}`, provider_id: plan.provider_id || pid, reasoning: plan.reasoning, elapsed_ms: res.elapsed_ms, updated_at: new Date().toISOString() };
      updateNodeData(nodeId, patch);
    } catch (e: any) {
      updateNodeData(nodeId, { agent_state: { status: 'failed', provider_id: providerId || undefined, error: String(e?.message || e).slice(0, 220), updated_at: new Date().toISOString() } });
    }
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
          {paramSpecs.length > 0 && (()=>{ const g=groupSpecs(paramSpecs); return (
            <button onClick={() => setShowParams((v) => !v)} className={`p-1 rounded flex items-center gap-1 ${showParams ? 'bg-violet-600 text-white' : 'text-white/40 hover:text-white hover:bg-white/10'}`} title={`基础${g.basic.length} · 高级${g.advanced.length} · 共${paramSpecs.length}项`}><Settings2 className="w-3 h-3" />{g.advanced.length>0 && <span className="text-[10px] leading-none">{showParams?'收起':'高级'}</span>}</button>
          );})()}
        </div>
      </div>

      {/* Skill 选择：Agent 将按此 skill 润色提示词并选择执行路径 */}
      {skills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {skills.map((s) => (
            <button
              key={s.id}
              onClick={() => selectSkill(s.id)}
              title={s.desc}
              className={`px-2.5 py-1 rounded-full text-[10px] font-medium border transition-all ${activeSkill === s.id ? 'bg-violet-600 text-white border-violet-500' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 源能力摘要：几张图片几段音频 */}
      {currentProvider && (
        <div className="px-2.5 py-2 rounded-xl bg-violet-950/20 border border-violet-500/20 text-[11px] leading-relaxed">
          <div className="flex items-center gap-1.5 text-violet-300 font-bold">
            {kind === 'image' ? <ImageIcon className="w-3 h-3" /> : kind === 'video' ? <Film className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
            该源支持
            <span className="ml-auto text-[10px] font-normal text-white/40">{currentProvider.kind} · {currentProvider.id.slice(0,8)}</span>
          </div>
          <div className="text-white/80 mt-1 font-mono text-[11px]">{describeProviderSlots(currentProvider, kind)}</div>
          {currentProvider.description && <div className="text-white/40 mt-0.5 line-clamp-1 text-[10px]">{currentProvider.description}</div>}
          <div className="text-[10px] text-white/30 mt-1">切换源后下方插槽将自动适配 · 上传后 Agent 将以文件路径调用</div>
        </div>
      )}

      {/* 插槽 */}
      {slots.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {slots.map((slot) => {
            const raw = d[slot.key] ?? (slot.originalKey ? d[slot.originalKey] : undefined);
            const populated = Array.isArray(raw) ? raw.length > 0 : !!raw;
            const count = Array.isArray(raw) ? raw.length : (populated ? 1 : 0);
            const thumb = Array.isArray(raw) ? raw[0] : raw;
            const maxHint = slot.maxCount !== undefined ? ` /${slot.maxCount}` : '';
            const countLabel = count > 0 ? `×${count}${maxHint}` : maxHint ? `0${maxHint}` : '';
            return (
              <div key={slot.key} className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border text-[10px] ${populated ? 'bg-violet-950/30 border-violet-500/40 text-violet-200' : slot.required ? 'bg-red-950/20 border-dashed border-red-500/50 text-red-300' : 'bg-white/[0.02] border-dashed border-white/20 text-white/50'}`} title={`${slot.description || ''} ${slot.required ? '必选' : '可选'} ${slot.maxCount ? `最多${slot.maxCount}张` : ''}`}>
                {populated && thumb ? (<div className="w-5 h-5 rounded bg-black/60 overflow-hidden border border-white/20">{slot.type === 'video' ? <video src={thumb} className="w-full h-full object-cover" /> : slot.type === 'audio' ? <div className="w-full h-full flex items-center justify-center text-[8px]">🎵</div> : <img src={thumb} alt="" className="w-full h-full object-cover" />}</div>) : (<Plus className="w-3 h-3" />)}
                <button onClick={() => setPickerSlot(slot)} className="font-medium hover:text-white">{slot.label}{slot.required && <span className="text-red-400">*</span>} <span className="text-white/40 font-mono text-[9px]">{countLabel}</span></button>
                {populated && <button onClick={() => clearSlot(slot.key)} className="text-white/40 hover:text-red-400" title="清除"><X className="w-2.5 h-2.5" /></button>}
              </div>
            );
          })}
        </div>
      )}

      {/* 参数区：basic 常显，advanced 收进抽屉，hidden 不渲 */}
      {(() => {
        if (paramSpecs.length === 0) return null;
        const { basic, advanced } = groupSpecs(paramSpecs);
        return (
          <>
            {basic.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] font-bold text-white/40 tracking-wider flex items-center gap-1.5">
                  <span className="w-1 h-3 rounded-full bg-emerald-500/60" /> 基础参数 · Agent可自动代填
                </div>
                <div className="grid grid-cols-2 gap-2 p-2 rounded-xl bg-black/40 border border-white/10">
                  {basic.map((spec) => (
                    <DynamicControl key={spec.param_name} spec={spec} value={customParams[spec.param_name] ?? spec.default_value} onChange={(v) => handleParamChange(spec.param_name, v)} />
                  ))}
                </div>
              </div>
            )}
            {advanced.length > 0 && (
              <>
                {showParams ? (
                  <div className="space-y-2 animate-in fade-in slide-in-from-top-1">
                    <div className="text-[10px] font-bold text-white/40 tracking-wider flex items-center gap-1.5">
                      <span className="w-1 h-3 rounded-full bg-amber-500/60" /> 高级参数 · {advanced.filter(s=>s.agent==='suggest').length}项建议 / {advanced.filter(s=>s.agent==='manual').length}项手填
                    </div>
                    {/* 按 category 二级分组 */}
                    {Array.from(new Set(advanced.map(s=> s.category || 'advanced'))).map(cat => (
                      <div key={cat} className="space-y-1.5">
                        <div className="text-[10px] text-white/30 font-medium px-1">{CATEGORY_LABEL[cat] || cat}</div>
                        <div className="grid grid-cols-2 gap-2 p-2 rounded-xl bg-black/30 border border-white/5">
                          {advanced.filter(s=> (s.category||'advanced')===cat).map((spec) => (
                            <DynamicControl key={spec.param_name} spec={spec} value={customParams[spec.param_name] ?? spec.default_value} onChange={(v) => handleParamChange(spec.param_name, v)} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <button onClick={() => setShowParams(true)} className="w-full py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] text-white/60 flex items-center justify-center gap-1">
                    <Settings2 className="w-3 h-3" /> 展开高级参数（{advanced.length}项 · {advanced.filter(s=>s.visibility==='advanced').length}可调）
                  </button>
                )}
              </>
            )}
          </>
        );
      })()}

      {/* 想法输入：用户说人话 */}
      <textarea value={idea} onChange={(e) => handleIdeaChange(e.target.value)} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onPaste={(e) => { e.stopPropagation(); const text = (e.clipboardData as any)?.getData('text/plain') || (e.clipboardData as any)?.getData('text') || ''; if (text) { e.preventDefault(); const t = e.target as HTMLTextAreaElement; const s = t.selectionStart ?? idea.length; const en = t.selectionEnd ?? idea.length; const nv = idea.slice(0, s) + text + idea.slice(en); handleIdeaChange(nv); requestAnimationFrame(() => { try { t.selectionStart = t.selectionEnd = s + text.length; } catch {} }); } }} onCopy={(e) => e.stopPropagation()} onCut={(e) => e.stopPropagation()} placeholder={kind === 'image' ? '用人话说你的画面想法，Agent 会润色成专业画面描述并按所选生成源组参数后调用…  例：生成一个 JK 少女在樱花校园的电影感肖像' : kind === 'video' ? '描述你想要的镜头运动与主体动作，Agent 自动选首尾帧/参考模式并调用…  例：让猫咪向前冲刺，镜头缓慢推入' : '输入台词，Agent 自动选配音源与情绪并调用…'} rows={2} className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-white/40 focus:outline-none focus:border-violet-500 resize-none nodrag select-text" />

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

      {pickerSlot && <CanvasResourcePickerModal isOpen={!!pickerSlot} onClose={() => setPickerSlot(null)} onSelect={handleSlotSelect} slotKey={pickerSlot.key} slotLabel={pickerSlot.label} multiSelect={isSlotMulti(pickerSlot) || (pickerSlot.maxCount !== undefined && pickerSlot.maxCount > 1)} acceptType={pickerSlot.type} />}
    </div>
  );
};
