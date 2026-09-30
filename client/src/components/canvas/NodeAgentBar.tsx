// -*- coding: utf-8 -*-
/**
 * NodeAgentBar — 真正 Per-Node Agent 的嵌入式控制台
 * 节点内完成：选生成源(provider_*) / 模型 / 插槽挂载 / Prompt 输入 / 动态参数 / 一键生成 / agent_state 可视
 * 写穿透 useCanvasStore，不持有本地副本，杜绝与全局 Bar 的状态竞态
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { RefreshCw, Plus, Trash2, Settings2, Sparkles, X, Loader2, AlertTriangle } from 'lucide-react';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { apiService } from '../../services/api';
import { DynamicProviderInfo, extractSlotsFromProvider, AssetSlotDef, getSkillsForKind, getSkillPreset, paramsSchemaToSpecs } from './providerSkills';
import { CanvasResourcePickerModal } from './CanvasResourcePickerModal';
import { emitAttachInputs, emitDetachInput, toInputItems } from './inputCards';
import { DynamicControl } from './controls/DynamicControl';
import { useNodeExecution } from './hooks/useNodeExecution';
import { AiPolishButton } from '../ui/AiPolishButton';

type GenKind = 'image' | 'video' | 'audio';

export const NodeAgentBar: React.FC<{ nodeId: string; kind: GenKind }> = ({ nodeId, kind }) => {
  const node = useCanvasStore((s) => s.nodes.find((n: any) => n.id === nodeId));
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const d: any = node?.data || {};

  const [providers, setProviders] = useState<DynamicProviderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<AssetSlotDef | null>(null);
  const { execute, executing, agentState } = useNodeExecution(nodeId);

  const providerId: string = d.provider_id || d.provider || '';
  const currentProvider = useMemo(() => providers.find((p) => p.id === providerId) || null, [providers, providerId]);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await apiService.listProviders({ kind, include_builtin: true, production_only: true } as any).catch(() => null);
      setProviders(res?.providers || []);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    fetchProviders();
    const h = () => fetchProviders();
    window.addEventListener('provider-refresh', h as any);
    return () => window.removeEventListener('provider-refresh', h as any);
  }, [fetchProviders]);

  // 技能预设（必需插槽 / 默认参数）
  const preset = getSkillPreset(d.skill_id);
  const skillSlots = useMemo(() => {
    let slots = extractSlotsFromProvider(currentProvider, kind);
    if (preset?.requiredSlots?.length) {
      slots = slots.map((s) => (preset.requiredSlots.includes(s.key) ? { ...s, required: true } : s));
    }
    if (preset?.dimSlots?.length) {
      slots = slots.filter((s) => !preset.dimSlots!.includes(s.key) || !!d[s.key] || preset.requiredSlots?.includes(s.key));
    }
    return slots;
  }, [currentProvider, kind, preset, d]);

  const paramSpecs = useMemo(() => paramsSchemaToSpecs(currentProvider?.params_schema).filter(s => s.visibility !== 'hidden'), [currentProvider]);
  const customParams: Record<string, any> = d.params || d.provider_params || {};

  const selectProvider = (pid: string) => {
    const found = providers.find((p) => p.id === pid) || null;
    const m = found?.default_model || found?.models?.[0] || '';
    const schemaDefaults: Record<string, any> = {};
    if (found?.params_schema?.properties) {
      for (const [k, v] of Object.entries<any>(found.params_schema.properties)) {
        if (v.default !== undefined) schemaDefaults[k] = v.default;
      }
    }
    const nextParams = { ...schemaDefaults, ...(found?.default_params || {}), ...(preset?.defaultParams || {}) };
    updateNodeData(nodeId, {
      provider_id: pid, provider: pid, model: m, definition: found,
      params: nextParams, provider_params: nextParams,
    });
  };

  const selectSkill = (skillId: string) => {
    const sp = getSkillPreset(skillId);
    const nextParams = { ...customParams, ...(sp?.defaultParams || {}) };
    updateNodeData(nodeId, { skill_id: skillId, ...(Object.keys(nextParams).length ? { params: nextParams, provider_params: nextParams } : {}) });
  };

  const isSlotMulti = (slot: AssetSlotDef) => !!slot.multi || (slot.maxCount !== undefined && slot.maxCount > 1);

  const handleSlotSelect = (urlOrUrls: string | string[], meta?: any, metas?: Record<string, any>) => {
    if (!pickerSlot) return;
    const patch: Record<string, any> = {};
    // 仅写接口声明的键：归一 key + 源属性 originalKey，无别名猜测
    const writeKeys = new Set<string>([pickerSlot.key, pickerSlot.originalKey || pickerSlot.key]);
    const picked = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    let finalValues: string[] = [];
    if (isSlotMulti(pickerSlot)) {
      const existing: string[] = Array.isArray(d[pickerSlot.key]) ? d[pickerSlot.key] : [];
      const merged = [...existing];
      for (const u of picked) if (!merged.includes(u)) merged.push(u);
      const max = pickerSlot.maxCount;
      const limited = max !== undefined && merged.length > max ? merged.slice(-max) : merged;
      writeKeys.forEach(k => { patch[k] = limited; });
      finalValues = limited;
    } else {
      const url = picked[0];
      writeKeys.forEach(k => { patch[k] = url; });
      finalValues = url ? [url] : [];
    }
    if (meta?.visual_prompt && !(d.prompt || '').includes(meta.visual_prompt)) {
      const cur = (d.prompt || d.text || '') as string;
      const nextPrompt = cur ? `${cur}, ${meta.visual_prompt}` : meta.visual_prompt;
      patch.prompt = nextPrompt;
      patch.text = nextPrompt;
    }
    if (meta?.voice_id && kind === 'audio') patch.voice_id = meta.voice_id;
    updateNodeData(nodeId, patch);
    if (pickerSlot.type === 'image' || pickerSlot.type === 'video' || pickerSlot.type === 'audio') {
      emitAttachInputs({
        targetId: nodeId, slotKey: pickerSlot.key, mediaType: pickerSlot.type,
        multi: isSlotMulti(pickerSlot), items: toInputItems(picked.filter(u => finalValues.includes(u)), metas), keep: finalValues,
      });
    }
    setPickerSlot(null);
  };

  const clearSlot = (key: string) => {
    const slot = skillSlots.find(s => s.key === key);
    const patch: Record<string, any> = { [key]: undefined };
    if (slot?.originalKey && slot.originalKey !== key) patch[slot.originalKey] = undefined;
    updateNodeData(nodeId, patch);
    if (slot && (slot.type === 'image' || slot.type === 'video' || slot.type === 'audio')) {
      emitDetachInput({ targetId: nodeId, slotKey: key, mediaType: slot.type });
    }
  };

  const skills = getSkillsForKind(kind);
  const activeSkill = d.skill_id || skills[0]?.id;

  return (
    <div className="w-full flex flex-col gap-2 mt-2 pt-2 border-t border-white/10" onClick={(e) => e.stopPropagation()}>
      {/* 技能 Tab */}
      {skills.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {skills.map((s) => (
            <button key={s.id} onClick={() => selectSkill(s.id)}
              className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all ${activeSkill === s.id ? 'bg-violet-600 text-white border-violet-500' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`}>
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 源 + 模型 */}
      <div className="flex items-center gap-1.5">
        <select value={providerId} onChange={(e) => selectProvider(e.target.value)}
          className="flex-1 min-w-0 bg-white/55 dark:bg-white/[.06] border border-white/15 rounded-lg px-2 py-1 text-[11px] text-white/90 focus:outline-none focus:border-violet-500">
          <option value="">{loading ? '加载生成源…' : providers.length ? '选择生成源…' : '无可用源'}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.display_name || p.name}{p.provider_type === 'comfyui' ? ' ·ComfyUI' : p.builtin ? ' ·内置' : ''}</option>
          ))}
        </select>
        {currentProvider && currentProvider.models?.length > 0 && (
          <select value={d.model || currentProvider.default_model || currentProvider.models[0] || ''}
            onChange={(e) => updateNodeData(nodeId, { model: e.target.value })}
            className="max-w-[110px] bg-white/55 dark:bg-white/[.06] border border-white/15 rounded-lg px-1.5 py-1 text-[10px] text-violet-300 font-mono focus:outline-none focus:border-violet-500">
            {currentProvider.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <button onClick={fetchProviders} disabled={loading} className="p-1 rounded text-white/40 hover:text-white hover:bg-white/10" title="刷新源列表">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
        {paramSpecs.length > 0 && (
          <button onClick={() => setShowParams((v) => !v)}
            className={`p-1 rounded ${showParams ? 'bg-violet-600 text-white' : 'text-white/40 hover:text-white hover:bg-white/10'}`} title={`${paramSpecs.length} 项参数`}>
            <Settings2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* 插槽 */}
      {skillSlots.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {skillSlots.map((slot) => {
            const raw = d[slot.key] ?? (slot.originalKey ? d[slot.originalKey] : undefined);
            const isPopulated = Array.isArray(raw) ? raw.length > 0 : !!raw;
            const thumb = Array.isArray(raw) ? raw[0] : raw;
            return (
              <div key={slot.key}
                className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border text-[10px] ${isPopulated ? 'bg-violet-950/30 border-violet-500/40 text-violet-200' : slot.required ? 'bg-red-950/20 border-dashed border-red-500/50 text-red-300' : 'bg-white/[0.02] border-dashed border-white/20 text-white/50 hover:border-white/40'}`}>
                {isPopulated && thumb ? (
                  <div className="w-5 h-5 rounded bg-white/55 dark:bg-white/[.06] overflow-hidden border border-white/20">
                    {slot.type === 'video' ? <video src={thumb} className="w-full h-full object-cover" /> : slot.type === 'audio' ? <div className="w-full h-full flex items-center justify-center text-[8px]">🎵</div> : <img src={thumb} alt="" className="w-full h-full object-cover" />}
                  </div>
                ) : (
                  <Plus className="w-3 h-3" />
                )}
                <button onClick={() => setPickerSlot(slot)} className="font-medium hover:text-white">
                  {slot.label}{slot.required && <span className="text-red-400">*</span>}
                  {isPopulated && Array.isArray(raw) && raw.length > 1 ? ` ×${raw.length}` : ''}
                </button>
                {isPopulated && (
                  <button onClick={() => clearSlot(slot.key)} className="text-white/40 hover:text-red-400" title="清除">
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 参数抽屉 */}
      {showParams && paramSpecs.length > 0 && (
        <div className="grid grid-cols-2 gap-2 p-2 rounded-xl bg-white/55 dark:bg-white/[.06] border border-white/10 max-h-[180px] overflow-y-auto">
          {paramSpecs.map((spec) => (
            <DynamicControl key={spec.param_name} spec={spec}
              value={customParams[spec.param_name] ?? spec.default_value}
              onChange={(v) => {
                const next = { ...customParams, [spec.param_name]: v };
                updateNodeData(nodeId, { params: next, provider_params: next, [spec.param_name]: v });
              }} />
          ))}
        </div>
      )}

      {/* Prompt 输入 */}
      <textarea
        value={d.prompt || d.text || ''}
        onChange={(e) => updateNodeData(nodeId, { prompt: e.target.value, text: e.target.value, image_prompt: e.target.value, video_prompt: e.target.value })}
        placeholder={skills.find((s) => s.id === activeSkill)?.guidePrompt || (kind === 'audio' ? '输入台词…' : '描述画面/运动…')}
        rows={2}
        className="w-full bg-white/55 dark:bg-white/[.06] border border-white/10 rounded-xl px-2.5 py-2 text-[11px] text-white placeholder-white/40 focus:outline-none focus:border-violet-500 resize-none"
      />

      {/* 字段级 AI 润色：显式按钮（整段按技能重写）；只改一句/一个词走选中文字后的浮标 */}
      <div className="flex items-center justify-end">
        <AiPolishButton
          value={d.prompt || d.text || ''}
          onPolish={(v: any) => updateNodeData(nodeId, { prompt: v, text: v, image_prompt: v, video_prompt: v })}
          contextType={kind === 'audio' ? 'dialogue' : 'prompt'}
          size="xs"
        />
      </div>

      {/* agent_state + 执行 */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 text-[10px] truncate">
          {executing || agentState?.status === 'running' ? (
            <span className="text-violet-300 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Agent 调度 {agentState?.tool || `provider_${providerId}`}…</span>
          ) : agentState?.status === 'failed' ? (
            <span className="text-red-400 flex items-center gap-1" title={agentState.error}><AlertTriangle className="w-3 h-3" /> {agentState.error || '失败'}</span>
          ) : agentState?.status === 'completed' ? (
            <span className="text-emerald-400">{`✓ ${((agentState.elapsed_ms || 0) / 1000).toFixed(1)}s`}</span>
          ) : (
            <span className="text-white/30">{providerId ? '就绪' : '选择生成源后可直接在本卡片生成'}</span>
          )}
        </div>
        <button
          onClick={() => { execute().catch(() => {}); }}
          disabled={executing || !providerId || !(d.prompt || d.text)}
          className={`px-3 py-1.5 rounded-xl text-[11px] font-bold text-white transition-colors ${executing ? 'bg-white/10 text-white/50' : providerId ? 'bg-violet-600 hover:bg-violet-500' : 'bg-white/10 text-white/40'}`}
        >
          {executing ? '生成中…' : '生成 ↑'}
        </button>
      </div>

      {pickerSlot && (
        <CanvasResourcePickerModal
          isOpen={!!pickerSlot}
          onClose={() => setPickerSlot(null)}
          onSelect={handleSlotSelect}
          slotKey={pickerSlot.key}
          slotLabel={pickerSlot.label}
          multiSelect={isSlotMulti(pickerSlot)}
          acceptType={pickerSlot.type}
        />
      )}
    </div>
  );
};
