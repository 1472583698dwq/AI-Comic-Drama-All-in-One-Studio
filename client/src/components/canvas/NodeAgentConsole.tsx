// -*- coding: utf-8 -*-
/**
 * 节点 Agent 控制台（底部栏形态）— 用户只说人话，Agent 负责：
 * ①理解意图→选 skill ②选/用生成源 ③润色 prompt ④按该源异构 schema 组参数 ⑤调 API ⑥结果回节点
 * 点任何 生图/视频/配音 节点时，底部全局导演栏自动切换为此控制台。
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, RefreshCw, Plus, X, Loader2, AlertTriangle, Image as ImageIcon, Film, Mic, Settings2, Link2, RotateCcw, ArrowUp, SlidersHorizontal, ChevronUp, Check, FolderOpen } from 'lucide-react';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';
import { apiService } from '../../services/api';
import { ShotWriteBackControls } from './nodes/ShotWriteBackControl';
import { DynamicProviderInfo, extractSlotsFromProvider, AssetSlotDef, getSkillsForKind, describeProviderSlots, paramsSchemaToSpecs } from './providerSkills';
import { collectResources, planBinding } from '../storyboard/referenceBinder';
import { CanvasResourcePickerModal } from './CanvasResourcePickerModal';
import { emitAttachInputs, emitDetachInput, toInputItems } from './inputCards';
import { DynamicControl, groupSpecs, CATEGORY_LABEL, ControlSpec } from './controls/DynamicControl';
import { pollVideoTask } from '../../utils/videoTask';

type GenKind = 'image' | 'video' | 'audio';

/** 二级弹窗里的胶囊按钮（执行路径等单选） */
const chipCls = (on: boolean) =>
  'px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-colors ' +
  (on
    ? 'bg-brand/15 text-brand border-brand/40'
    : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)]');

/** 生成源上拉选择栏的一行（主流「选模型」样式：图标 + 名称/说明 + 选中勾） */
const SourceOption: React.FC<{
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  desc?: string;
  hint?: string;
  onClick: () => void;
}> = ({ selected, icon, title, desc, hint, onClick }) => (
  <button
    role="option"
    aria-selected={selected}
    onClick={onClick}
    title={hint || title}
    className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left hover:bg-white/55 dark:bg-white/[.06] transition-colors"
  >
    <span className="w-6 h-6 rounded-md bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 flex items-center justify-center shrink-0">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className={`block text-[13px] truncate ${selected ? 'font-semibold [color:var(--color-text-main)]' : '[color:var(--color-text-secondary)]'}`}>{title}</span>
      {desc && <span className="block text-[10.5px] [color:var(--color-text-muted)] truncate">{desc}</span>}
    </span>
    {selected && <Check className="w-4 h-4 text-brand shrink-0" strokeWidth={1.7} />}
  </button>
);

export const NodeAgentConsole: React.FC<{ nodeId: string; kind: GenKind }> = ({ nodeId, kind }) => {
  const node = useCanvasStore((s) => s.nodes.find((n: any) => n.id === nodeId));
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const d: any = node?.data || {};

  const [providers, setProviders] = useState<DynamicProviderInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [idea, setIdea] = useState<string>(() => d.idea || d.prompt || d.text || '');
  // 二级参数弹窗：生成源 / 执行路径 / 输入槽位 / 参数 / 上次规划 全部集中在这里（基线 §5.5）
  const [paramsOpen, setParamsOpen] = useState(false);
  const [draftParams, setDraftParams] = useState<Record<string, any>>({});
  const paramsSectionRef = useRef<HTMLElement | null>(null);
  // 生成源：独立的上拉选择栏（主流「选模型」样式），不与参数弹窗共用
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const sourcePickerRef = useRef<HTMLDivElement>(null);
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
      const res: any = await apiService.listProviders({ kind, include_builtin: true, production_only: true } as any).catch(() => null);
      setProviders(res?.providers || []);
    } finally { setLoadingProviders(false); }
  }, [kind]);

  useEffect(() => {
    fetchProviders();
    // 全站创建/删除生成源统一派发 provider-list-refresh（原 provider-refresh 无人派发，导致下拉从不自动刷新）
    const h = () => fetchProviders();
    window.addEventListener('provider-list-refresh', h as any);
    // 新建成功且由本操作台发起时，自动把新源选中到当前节点
    const onCreated = (e: any) => {
      const d = e?.detail || {};
      if (d.select && (!d.source || d.source === 'node-console') && d.provider?.id) {
        selectProvider(d.provider.id);
        toast.success(`已选用新生成源：${d.provider.display_name || d.provider.name || d.provider.id}`);
      }
    };
    window.addEventListener('provider-created', onCreated as any);
    return () => {
      window.removeEventListener('provider-list-refresh', h as any);
      window.removeEventListener('provider-created', onCreated as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProviders]);
  useEffect(() => {
    const v = d.idea || d.prompt || d.text || '';
    if (v !== idea) setIdea(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, d.idea, d.prompt, d.text]);

  // Esc 关闭参数弹窗（全站弹窗同一套 LIFO 栈：先关弹窗，不会连带把操作台一起关掉）
  useEscapeClose(paramsOpen, () => setParamsOpen(false));
  // 生成源上拉选择栏：Esc / 点外部关闭（同样走 LIFO 栈）
  useEscapeClose(sourcePickerOpen, () => setSourcePickerOpen(false));
  useEffect(() => {
    if (!sourcePickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && !sourcePickerRef.current?.contains(t)) setSourcePickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sourcePickerOpen]);
  // 参数弹窗打开后滚到参数区
  useEffect(() => {
    if (!paramsOpen) return;
    const el = paramsSectionRef.current;
    if (!el) return;
    const t = window.setTimeout(() => el.scrollIntoView({ block: 'start' }), 20);
    return () => window.clearTimeout(t);
  }, [paramsOpen]);

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
  // ── 二级弹窗：参数改动先在草稿里，点「应用」才写回节点（可取消/恢复默认）──
  const openParams = () => {
    // 每次打开都以节点当前值为基准，避免上次未应用的草稿残留
    const base: Record<string, any> = {};
    for (const s of paramSpecs) base[s.param_name] = customParams[s.param_name] ?? s.default_value;
    setDraftParams(base);
    setParamsOpen(true);
  };
  const applyDraftParams = () => {
    // 未选源时没有 schema，草稿为空 —— 直接关窗，避免把节点参数写成空对象
    if (paramSpecs.length > 0) {
      updateNodeData(nodeId, { ...draftParams, params: draftParams, provider_params: draftParams });
    }
    setParamsOpen(false);
  };
  const resetDraftToDefaults = () => {
    const next: Record<string, any> = {};
    for (const s of paramSpecs) next[s.param_name] = s.default_value;
    setDraftParams(next);
  };
  const changeDraft = (key: string, val: any) => setDraftParams((prev) => ({ ...prev, [key]: val }));
  /** 当前配置摘要：首项 = 生成源（源胶囊只显示它），其余 = 执行路径/比例/数量（挂在「参数」按钮上） */
  const summaryParts = useMemo(() => {
    const parts: string[] = [currentProvider?.display_name || 'Agent 自动选源'];
    const sk = skills.find((s) => s.id === activeSkill);
    if (sk) parts.push(sk.name);
    const p = customParams || {};
    const ratio = p.aspect_ratio || p.ratio || p.aspect;
    if (ratio) parts.push(String(ratio));
    const count = p.count ?? p.n ?? p.num_images ?? p.batch_size ?? p.num_frames;
    if (count !== undefined && count !== null && count !== '') parts.push(String(count));
    const dur = p.duration ?? p.video_duration;
    if (dur !== undefined && dur !== null && dur !== '') parts.push(`${dur}s`);
    return parts;
  }, [currentProvider, skills, activeSkill, customParams]);
  const sourceLabel = summaryParts[0] || 'Agent 自动选源';
  const configHint = summaryParts.slice(1).join(' · ');

  // 一键绑定：项目角色/素材 → 该源声明插槽（仅填空槽；画布无镜头级绑定，缺省用全项目角色）
  const handleOneClickBind = async () => {
    if (!currentProvider || !slots.length) { toast.info('该源未声明参考插槽，无需绑定'); return; }
    const project: any = useProjectStore.getState().project;
    let projectAssets: any[] = [];
    try {
      const r: any = await apiService.listAssets({ project_id: project?.id, page: 1, limit: 100 });
      projectAssets = r?.assets || [];
    } catch { /* 素材可缺省 */ }
    const charIds: string[] = Array.isArray(d.character_ids) && d.character_ids.length
      ? d.character_ids
      : (project?.characters || []).map((c: any) => c.id);
    const pseudoShot: any = {
      id: nodeId,
      character_ids: charIds,
      character_weights: d.character_weights,
      scene_ref_image: d.scene_ref_image,
      scene_name: d.scene_name,
      prop_asset_ids: d.prop_asset_ids,
      previz_url: d.previz_url,
      previz_video_url: d.previz_video_url,
      image_url: d.first_frame || d.first_frame_url || d.image_url || d._upstream?.image_url,
      speaker_name: d.speaker_name,
    };
    const current: Record<string, any> = {};
    for (const s of slots) for (const k of [s.key, s.originalKey]) if (k && d[k] !== undefined) current[k] = d[k];
    const resources = collectResources({ shot: pseudoShot, project, projectAssets, kind, includeFirstFrame: kind === 'video' });
    const plan = planBinding(resources, slots, current, { overwrite: false });
    if (!Object.keys(plan.patch).length) {
      toast.info(plan.gaps.length ? '没有可绑定资源，必填槽仍有缺口（先在项目里创建角色/素材）' : '没有可绑定资源：先在项目里创建角色/素材');
      return;
    }
    updateNodeData(nodeId, plan.patch);
    // 绑定进来的每个插槽都在画布上放输入卡片
    for (const s of slots) {
      if (s.type !== 'image' && s.type !== 'video' && s.type !== 'audio') continue;
      const v = plan.patch[s.key] ?? (s.originalKey ? plan.patch[s.originalKey] : undefined);
      const vals: string[] = (Array.isArray(v) ? v : [v]).filter((u: any) => typeof u === 'string' && u);
      if (!vals.length) continue;
      emitAttachInputs({ targetId: nodeId, slotKey: s.key, mediaType: s.type, multi: isSlotMulti(s), items: toInputItems(vals), keep: vals });
    }
    const n = plan.filled.filter((f) => !f.kept).length;
    toast.success(`已绑定 ${n} 项参考${plan.gaps.length ? `，${plan.gaps.length} 个必填缺口` : ''}`);
  };
  const selectSkill = (skillId: string) => {
    updateNodeData(nodeId, { skill_id: skillId });
  };
  const isSlotMulti = (s: AssetSlotDef) => !!s.multi || (s.maxCount !== undefined && s.maxCount > 1);
  const handleSlotSelect = (urlOrUrls: string | string[], meta?: any, metas?: Record<string, any>) => {
    if (!pickerSlot) return;
    // 参数模式：只落「参数草稿」（与参数弹窗的点「应用」流程一致，不直接写节点）
    if (pickerSlot.asParam === true) {
      const v = isSlotMulti(pickerSlot)
        ? (Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls])
        : (Array.isArray(urlOrUrls) ? urlOrUrls[0] : urlOrUrls);
      setDraftParams(prev => ({ ...prev, [pickerSlot.key]: v }));
      setPickerSlot(null);
      return;
    }
    const max = pickerSlot.maxCount;
    const patch: Record<string, any> = {};
    // 只写插槽声明的键（归一 key + 源属性 originalKey），不做任何别名猜测
    const writeKeys = new Set<string>([pickerSlot.key, pickerSlot.originalKey || pickerSlot.key]);
    const picked = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    let finalValues: string[] = [];
    if (isSlotMulti(pickerSlot)) {
      const arr = picked;
      const existing: string[] = Array.isArray(d[pickerSlot.key]) ? d[pickerSlot.key] : [];
      const merged = [...existing];
      for (const u of arr) if (!merged.includes(u)) merged.push(u);
      let limited = merged;
      if (max !== undefined && merged.length > max) {
        limited = merged.slice(-max);
        try { toast.info(`该插槽最多支持 ${max} 张，已自动保留最新的 ${max} 张`); } catch {}
      }
      writeKeys.forEach(k => { patch[k] = limited; });
      if (pickerSlot.key === 'reference_images') {
        patch.reference_images = limited;
      }
      finalValues = limited;
    } else {
      const url = picked[0];
      writeKeys.forEach(k => { patch[k] = url; });
      if (pickerSlot.type === 'image' && pickerSlot.key.startsWith('img_')) {
        const curRefs = Array.isArray(d.reference_images) ? [...d.reference_images] : [];
        if (!curRefs.includes(url)) curRefs.push(url);
        patch.reference_images = curRefs;
      }
      finalValues = url ? [url] : [];
    }
    if (meta?.visual_prompt && !(idea || '').includes(meta.visual_prompt)) {
      const nextIdea = idea ? `${idea}, ${meta.visual_prompt}` : meta.visual_prompt;
      setIdea(nextIdea); patch.idea = nextIdea; patch.prompt = nextIdea; patch.text = nextIdea;
    }
    if (meta?.voice_id && kind === 'audio') patch.voice_id = meta.voice_id;
    updateNodeData(nodeId, patch);
    // 画布上放对应的输入卡片（或直接连到来源卡片），让输入了什么一眼可见
    if (pickerSlot.type === 'image' || pickerSlot.type === 'video' || pickerSlot.type === 'audio') {
      emitAttachInputs({
        targetId: nodeId, slotKey: pickerSlot.key, mediaType: pickerSlot.type,
        multi: isSlotMulti(pickerSlot), items: toInputItems(picked.filter(u => finalValues.includes(u)), metas), keep: finalValues,
      });
    }
    setPickerSlot(null);
  };
  const clearSlot = (key: string) => {
    const slot = slots.find(s => s.key === key);
    const patch: Record<string, any> = { [key]: undefined };
    if (slot?.originalKey && slot.originalKey !== key) patch[slot.originalKey] = undefined;
    if (key === 'reference_images') patch.reference_images = [];
    updateNodeData(nodeId, patch);
    if (slot && (slot.type === 'image' || slot.type === 'video' || slot.type === 'audio')) {
      emitDetachInput({ targetId: nodeId, slotKey: key, mediaType: slot.type });
    }
  };

  /** 媒体类参数补「从画布 / 素材库添加」：打开统一资源选择器，选中后落参数草稿（与「应用」流程一致） */
  const renderPickFromCanvas = (spec: ControlSpec) =>
    (['image', 'video', 'audio'] as string[]).includes(spec.type) ? (
      <button
        type="button"
        onClick={() => setPickerSlot({ key: spec.param_name, label: spec.label, type: spec.type as any, maxCount: 1, originalKey: spec.param_name, asParam: true })}
        title="从画布产出 / 角色库 / 素材库选择并填入该参数（点「应用」后生效）"
        className="w-full h-6 rounded-md border border-dashed border-white/70 dark:border-white/12 bg-white/60 dark:bg-white/[.05] hover:border-brand/50 text-[10.5px] [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] flex items-center justify-center gap-1 transition-colors"
      >
        <FolderOpen className="w-3 h-3" strokeWidth={1.7} />从画布 / 素材库添加
      </button>
    ) : null;

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
    // 兜底保留通用参考媒体
    if (d.reference_images && Array.isArray(d.reference_images) && d.reference_images.length > 0 && !s.reference_images) {
      s.reference_images = d.reference_images;
    }
    if (d.first_frame && !s.first_frame) {
      s.first_frame = d.first_frame;
    }
    if (d.last_frame && !s.last_frame) {
      s.last_frame = d.last_frame;
    }
    return s;
  };

  const handleExecute = async () => {
    const raw = (idea || d.idea || d.prompt || d.text || '').trim();
    if (!raw) { toast.error('请先输入你的需求／想法'); return; }
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
      // 异步视频提交即返 task_id：先落盘 task_id（重启可恢复），再统一轮询直到出片
      if (kind === 'video' && !result.video_url && result.task_id) {
        updateNodeData(nodeId, { _taskId: result.task_id, _polling: true });
        result.video_url = await pollVideoTask(result.task_id);
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
      {/* 主流 chat 风格 Composer：输入区与「源 / 参数 / 发送」同在一个圆角框内，
          聚焦时整框描边（focus-within），操作台内不再有任何常驻参数控件 */}
      <div className="rounded-[18px] bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 transition-colors focus-within:border-brand">
        <textarea value={idea} onChange={(e) => handleIdeaChange(e.target.value)} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onPaste={(e) => { e.stopPropagation(); const text = (e.clipboardData as any)?.getData('text/plain') || (e.clipboardData as any)?.getData('text') || ''; if (text) { e.preventDefault(); const t = e.target as HTMLTextAreaElement; const s = t.selectionStart ?? idea.length; const en = t.selectionEnd ?? idea.length; const nv = idea.slice(0, s) + text + idea.slice(en); handleIdeaChange(nv); requestAnimationFrame(() => { try { t.selectionStart = t.selectionEnd = s + text.length; } catch {} }); } }} onCopy={(e) => e.stopPropagation()} onCut={(e) => e.stopPropagation()} placeholder={kind === 'image' ? '用人话说你的画面想法，Agent 会润色成专业描述并按所选生成源组参数后调用…  例：JK 少女在樱花校园的电影感肖像' : kind === 'video' ? '描述镜头运动与主体动作，Agent 自动选首尾帧/参考模式并调用…  例：猫咪向前冲刺，镜头缓慢推入' : '输入台词，Agent 自动选配音源与情绪并调用…  例：她压低声音说，别回头'} rows={6} className="w-full bg-transparent border-0 rounded-[18px] px-3 pt-2 pb-1 text-[13px] leading-relaxed [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none resize-none nodrag select-text" />

        {/* 框内底部工具行：源 · 参数 —— 发送 */}
        <div className="px-2 pb-2 flex items-center gap-1">
          <div className="relative min-w-0 max-w-[56%]" ref={sourcePickerRef}>
            <button
              onClick={() => setSourcePickerOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={sourcePickerOpen}
              title={`生成源：${sourceLabel}（点击选择）`}
              className={`h-7 w-full px-2 rounded-full border flex items-center gap-1.5 transition-colors ${
                sourcePickerOpen
                  ? 'bg-white/65 dark:bg-white/[.09] border-white/80 dark:border-white/20'
                  : 'bg-white/60 dark:bg-white/[.05] border-white/70 dark:border-white/12 hover:[color:var(--color-text-main)]'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${providerId ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="truncate text-[11.5px] [color:var(--color-text-secondary)]">{sourceLabel}</span>
              <ChevronUp className={`w-3 h-3 shrink-0 [color:var(--color-text-muted)] transition-transform ${sourcePickerOpen ? 'rotate-180' : ''}`} strokeWidth={1.7} />
            </button>

            {/* 生成源 · 上拉选择栏（主流「选模型」样式）：只选源，不带任何参数 */}
            {sourcePickerOpen && (
              <div
                role="listbox"
                aria-label="选择生成源"
                className="absolute left-0 bottom-[calc(100%+8px)] w-[300px] max-w-[86vw] max-h-[320px] flex flex-col rounded-[14px] bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 shadow-xl overflow-hidden z-30"
              >
                <div className="h-9 px-2.5 flex items-center gap-2 border-b border-white/70 dark:border-white/12 shrink-0">
                  <span className="text-[10.5px] font-semibold tracking-wider [color:var(--color-text-muted)]">生成源</span>
                  <button
                    onClick={fetchProviders}
                    disabled={loadingProviders}
                    className="ml-auto flex items-center gap-1 text-[10.5px] [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] disabled:opacity-50 transition-colors"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingProviders ? 'animate-spin' : ''}`} strokeWidth={1.7} />刷新
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
                  <SourceOption
                    selected={!providerId}
                    icon={<Sparkles className="w-4 h-4 text-brand" strokeWidth={1.7} />}
                    title={loadingProviders ? '加载中…' : 'Agent 自动选源'}
                    desc="按你的意图自动挑最优源"
                    onClick={() => { selectProvider(''); setSourcePickerOpen(false); }}
                  />
                  {providers.map((p) => (
                    <SourceOption
                      key={p.id}
                      selected={providerId === p.id}
                      icon={kindIcon}
                      title={p.display_name || p.name}
                      desc={`${p.provider_type === 'comfyui' ? 'ComfyUI' : p.kind} · ${(p.models || []).length} 模型`}
                      hint={`${p.display_name || p.name}（${p.id}）${p.description ? ' · ' + p.description : ''}`}
                      onClick={() => { selectProvider(p.id); setSourcePickerOpen(false); }}
                    />
                  ))}
                  {/* 就地添加自定义源：贴文档/写代码/工作流 → 创建成功自动选中到本节点 */}
                  <button
                    onClick={() => {
                      setSourcePickerOpen(false);
                      window.dispatchEvent(new CustomEvent('open-provider-create', {
                        detail: { tab: 'doc', kind, select: true, source: 'node-console' },
                      }));
                    }}
                    title="粘贴 API 文档 / 写代码 / ComfyUI 工作流，创建成功后自动选用"
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-dashed border-brand/40 bg-brand/5 text-left hover:bg-brand/10 transition-colors"
                  >
                    <span className="w-6 h-6 rounded-md bg-brand/10 border border-brand/30 flex items-center justify-center shrink-0">
                      <Plus className="w-3.5 h-3.5 text-brand" strokeWidth={2} />
                    </span>
                    <span className="text-[11.5px] font-semibold text-brand">添加自定义源</span>
                    <span className="ml-auto text-[9.5px] [color:var(--color-text-muted)]">贴文档 / 代码 / 工作流</span>
                  </button>
                </div>

                {currentProvider && (
                  <div className="px-2.5 py-1.5 border-t border-white/70 dark:border-white/12 shrink-0 text-[10.5px] [color:var(--color-text-muted)] truncate" title={describeProviderSlots(currentProvider, kind)}>
                    该源支持：{describeProviderSlots(currentProvider, kind)}
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            onClick={openParams}
            title={`参数设置（共 ${paramSpecs.length} 项）${configHint ? `：${configHint}` : ''}`}
            className="h-7 px-2 rounded-full flex items-center gap-1 min-w-0 transition-colors [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-white/65 dark:bg-white/[.09]"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" strokeWidth={1.7} />
            <span className="text-[11.5px] font-medium shrink-0">参数</span>
            <span className="text-[10.5px] tabular-nums [color:var(--color-text-muted)] truncate">
              {configHint || (paramSpecs.length > 0 ? `${paramSpecs.length} 项` : '')}
            </span>
          </button>
          <div className="flex-1" />
          {/* 发送（= 让 Agent 执行）：主流 chat 的圆形实心按钮，空输入/执行中禁用 */}
          <button
            onClick={handleExecute}
            disabled={executing || !idea.trim()}
            aria-label={executing ? 'Agent 执行中' : '让 Agent 执行'}
            title={executing ? 'Agent 执行中…' : '让 Agent 执行'}
            className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              executing
                ? 'bg-white/65 dark:bg-white/[.09] [color:var(--color-text-muted)] cursor-progress'
                : 'bg-brand text-white hover:bg-brand-light shadow-sm shadow-brand/25 disabled:bg-white/65 dark:bg-white/[.09] disabled:[color:var(--color-text-muted)] disabled:shadow-none disabled:cursor-not-allowed'
            }`}
          >
            {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" strokeWidth={1.7} />}
          </button>
        </div>
      </div>

      {agentState?.status === 'running' && <div className="text-[11px] text-violet-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin shrink-0" /> <span className="truncate">Agent 规划并调用 {agentState.tool}…</span><span className="[color:var(--color-text-muted)] shrink-0">（LLM 润色最长 30s，超时自动降级规则规划）</span></div>}
      {agentState?.status === 'failed' && <div className="text-[11px] text-red-400 flex items-center gap-1" title={agentState.error}><AlertTriangle className="w-3 h-3 shrink-0" /> <span className="truncate">{agentState.error}</span></div>}

      {/* 结果回写分镜：画布结果 → 分镜字段（图片/首帧、视频、配音），覆盖前确认，历史自动留存 */}
      <ShotWriteBackControls nodeId={nodeId} nodeType={node?.type || kind} data={d} />

      {/* ── 二级：参数设置弹窗（基线 §5.5）——
           生成源 / 执行路径 / 输入槽位 / 参数 / 上次规划 全部集中在这里；
           参数改动先落草稿，点「应用」才写回节点（可取消 / 恢复默认）。
           Portal 到 body：操作台外壳带 translate 变换，fixed 会被它当成包含块。── */}
      {paramsOpen && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60" onClick={() => setParamsOpen(false)}>
          <div
            role="dialog"
            aria-label="节点参数设置"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[520px] max-h-[82vh] flex flex-col rounded-[18px] bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 shadow-2xl overflow-hidden"
          >
            <div className="h-11 px-3.5 flex items-center gap-2 border-b border-white/70 dark:border-white/12 shrink-0">
              <Settings2 className="w-4 h-4 text-brand shrink-0" strokeWidth={1.7} />
              <span className="text-[13px] font-semibold [color:var(--color-text-main)]">参数设置</span>
              <span className="flex items-center gap-1.5 min-w-0 text-[10.5px] [color:var(--color-text-muted)] truncate">{kindIcon}{kindLabel} · #{nodeId.slice(-4).trim()}</span>
              <button
                onClick={() => setParamsOpen(false)}
                aria-label="关闭参数设置"
                title="关闭（Esc）"
                className="ml-auto w-7 h-7 rounded-md flex items-center justify-center [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-white/55 dark:bg-white/[.06] transition-colors shrink-0"
              >
                <X className="w-4 h-4" strokeWidth={1.7} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-3.5 py-3 space-y-4 motion-safe:scroll-smooth">
              {/* 执行路径（skill）：生成源不在此处 —— 它由输入框内的上拉选择栏单独负责 */}
              {skills.length > 0 && (
                <section className="space-y-2">
                  <div className="text-[10.5px] font-semibold tracking-wider [color:var(--color-text-muted)]">执行路径 · Agent 按此润色并选路</div>
                  <div className="flex flex-wrap gap-1.5">
                    {skills.map((s) => (
                      <button key={s.id} onClick={() => selectSkill(s.id)} title={s.desc} className={chipCls(activeSkill === s.id)}>{s.name}</button>
                    ))}
                  </div>
                </section>
              )}

              {/* 输入槽位 */}
              {slots.length > 0 && (
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10.5px] font-semibold tracking-wider [color:var(--color-text-muted)]">输入槽位 · 按该源声明</span>
                    <button
                      onClick={handleOneClickBind}
                      title="把项目角色（三视图/立绘 + 参考音频）、素材与上游产物按该源声明的插槽一键填入（仅补空缺）"
                      className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[10.5px] font-medium hover:bg-emerald-500/20 transition-colors"
                    >
                      <Link2 className="w-3 h-3" strokeWidth={1.7} />一键绑定
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {slots.map((slot) => {
                      const raw = d[slot.key] ?? (slot.originalKey ? d[slot.originalKey] : undefined);
                      const populated = Array.isArray(raw) ? raw.length > 0 : !!raw;
                      const count = Array.isArray(raw) ? raw.length : (populated ? 1 : 0);
                      const thumb = Array.isArray(raw) ? raw[0] : raw;
                      const maxHint = slot.maxCount !== undefined ? ` /${slot.maxCount}` : '';
                      const countLabel = count > 0 ? `×${count}${maxHint}` : maxHint ? `0${maxHint}` : '';
                      return (
                        <div
                          key={slot.key}
                          title={`${slot.description || ''} ${slot.required ? '必选' : '可选'} ${slot.maxCount ? `最多${slot.maxCount}张` : ''}`}
                          className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border text-[10.5px] ${
                            populated
                              ? 'bg-brand/10 border-brand/40 [color:var(--color-text-main)]'
                              : slot.required
                                ? 'bg-red-500/10 border-dashed border-red-500/50 text-red-400'
                                : 'bg-white/55 dark:bg-white/[.06] border-dashed border-white/70 dark:border-white/12 [color:var(--color-text-muted)]'
                          }`}
                        >
                          {populated && thumb ? (
                            <div className="w-5 h-5 rounded overflow-hidden border border-white/70 dark:border-white/12 shrink-0 bg-white/55 dark:bg-white/[.06]">
                              {slot.type === 'video'
                                ? <video src={thumb} className="w-full h-full object-cover" />
                                : slot.type === 'audio'
                                  ? <div className="w-full h-full flex items-center justify-center"><Mic className="w-2.5 h-2.5" strokeWidth={1.7} /></div>
                                  : <img src={thumb} alt="" className="w-full h-full object-cover" />}
                            </div>
                          ) : (<Plus className="w-3 h-3 shrink-0" strokeWidth={1.7} />)}
                          <button onClick={() => setPickerSlot(slot)} className="font-medium">
                            {slot.label}{slot.required && <span className="text-red-400">*</span>}
                            <span className="[color:var(--color-text-muted)] font-mono ml-1">{countLabel}</span>
                          </button>
                          {populated && (
                            <button onClick={() => clearSlot(slot.key)} aria-label="清除该槽位" title="清除" className="[color:var(--color-text-muted)] hover:text-red-400 transition-colors">
                              <X className="w-3 h-3" strokeWidth={1.7} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* 参数：basic 常显，advanced 按 category 分组（草稿值，应用后生效） */}
              {paramSpecs.length > 0 && (() => {
                const { basic, advanced } = groupSpecs(paramSpecs);
                return (
                  <section ref={paramsSectionRef} className="scroll-mt-3 space-y-3">
                    <div className="text-[10.5px] font-semibold tracking-wider [color:var(--color-text-muted)]">参数 · 改完点「应用」生效</div>
                    {basic.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[10.5px] [color:var(--color-text-muted)]">基础 · Agent 可自动代填</div>
                        <div className="grid grid-cols-2 gap-2 p-2 rounded-[10px] bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12">
                          {basic.map((spec) => (
                            <div key={spec.param_name} className="space-y-1 min-w-0">
                              <DynamicControl spec={spec} value={draftParams[spec.param_name] ?? spec.default_value} onChange={(v) => changeDraft(spec.param_name, v)} />
                              {renderPickFromCanvas(spec)}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {advanced.length > 0 && Array.from(new Set(advanced.map(s => s.category || 'advanced'))).map(cat => (
                      <div key={cat} className="space-y-1.5">
                        <div className="text-[10.5px] [color:var(--color-text-muted)]">{CATEGORY_LABEL[cat] || cat}</div>
                        <div className="grid grid-cols-2 gap-2 p-2 rounded-[10px] bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12">
                          {advanced.filter(s => (s.category || 'advanced') === cat).map((spec) => (
                            <div key={spec.param_name} className="space-y-1 min-w-0">
                              <DynamicControl spec={spec} value={draftParams[spec.param_name] ?? spec.default_value} onChange={(v) => changeDraft(spec.param_name, v)} />
                              {renderPickFromCanvas(spec)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </section>
                );
              })()}

              {/* 上次规划（原「Agent 决策白盒」，从操作台搬进来，降低操作台噪音） */}
              {lastPlan && (
                <section className="space-y-1.5">
                  <div className="text-[10.5px] font-semibold tracking-wider [color:var(--color-text-muted)]">上次规划</div>
                  <div className="px-2.5 py-2 rounded-[10px] bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[10.5px] leading-relaxed [color:var(--color-text-secondary)]">
                    <div className="flex items-center gap-1.5"><Sparkles className="w-3 h-3 shrink-0 text-violet-400" strokeWidth={1.7} /><span className="truncate">skill {lastPlan.skill_id} · 源 {(providers.find((p) => p.id === lastPlan.provider_id)?.display_name) || lastPlan.provider_id} · 模型 {lastPlan.model || '默认'}</span></div>
                    {lastPlan.reasoning && <div className="[color:var(--color-text-muted)] mt-0.5">{lastPlan.reasoning}</div>}
                    {lastPlan.plan_source === 'rule' && <div className="text-amber-400 mt-0.5">规则规划结果（LLM 不可用/超时自动降级）</div>}
                    {lastPlan.prompt && <div className="[color:var(--color-text-muted)] mt-1 line-clamp-3">润色后 prompt：{lastPlan.prompt}</div>}
                    {lastPlan.params && Object.keys(lastPlan.params).length > 0 && <div className="[color:var(--color-text-muted)] mt-0.5 font-mono break-all">参数 {JSON.stringify(lastPlan.params)}</div>}
                  </div>
                </section>
              )}
            </div>

            <div className="p-2.5 border-t border-white/70 dark:border-white/12 flex items-center gap-2 shrink-0">
              <button
                onClick={resetDraftToDefaults}
                disabled={paramSpecs.length === 0}
                title="把参数恢复到各生成源的默认值（仍需点「应用」）"
                className="h-8 px-2.5 rounded-md bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[11.5px] font-medium [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-white/65 dark:bg-white/[.09] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.7} />恢复默认
              </button>
              <div className="flex-1" />
              <button onClick={() => setParamsOpen(false)} className="h-8 px-3 rounded-md bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[11.5px] font-medium [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] hover:bg-white/65 dark:bg-white/[.09] transition-colors">取消</button>
              <button
                onClick={applyDraftParams}
                disabled={paramSpecs.length === 0}
                title={paramSpecs.length === 0 ? '该节点未指定生成源，参数由 Agent 自动决定' : '写回节点参数'}
                className="h-8 px-4 rounded-md bg-brand text-white text-[11.5px] font-semibold hover:bg-brand-light shadow-sm shadow-brand/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >应用</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {pickerSlot && <CanvasResourcePickerModal isOpen={!!pickerSlot} onClose={() => setPickerSlot(null)} onSelect={handleSlotSelect} slotKey={pickerSlot.key} slotLabel={pickerSlot.label} multiSelect={isSlotMulti(pickerSlot) || (pickerSlot.maxCount !== undefined && pickerSlot.maxCount > 1)} acceptType={pickerSlot.type} />}
    </div>
  );
};
