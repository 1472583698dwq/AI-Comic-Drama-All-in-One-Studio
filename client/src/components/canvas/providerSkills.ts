// -*- coding: utf-8 -*-
/**
 * Dynamic Provider & Skill Adapter for Agentic Infinite Canvas
 * 与后端动态生成源系统 (ProviderDefinition) 深度打通
 */

import { ControlSpec } from './controls/DynamicControl';

export interface AssetSlotDef {
  key: string;
  label: string;
  type: 'image' | 'video' | 'audio';
  required?: boolean;
  handleType?: string;
  description?: string;
  maxCount?: number;
  minCount?: number;
  originalKey?: string;
  multi?: boolean;
  /** 语义角色：character_ref / scene_ref / pose_ref / first_frame / last_frame / reference_images ... */
  role?: string;
  /** true 表示这是跨节点的聚合句柄（如 reference_images 数组），源若已提供逐节点独立槽时优先用后者 */
  aggregate?: boolean;
}

export interface DynamicProviderInfo {
  id: string;
  name: string;
  display_name?: string;
  kind: 'image' | 'video' | 'audio' | 'llm';
  provider_type?: 'http' | 'comfyui' | 'code' | 'local';
  description?: string;
  icon?: string;
  models: string[];
  default_model?: string;
  params_schema?: Record<string, any>;
  default_params?: Record<string, any>;
  input_schema?: Record<string, any>;
  output_schema?: Record<string, any>;
  builtin?: boolean;
  enabled?: boolean;
}

// handle 类型归一：只认接口声明的 x-handle，未知 uri 统一按 image
const HANDLE_MEDIA: Record<string, AssetSlotDef['type']> = {
  image: 'image', images: 'image', reference_images: 'image',
  audio: 'audio', audios: 'audio', reference_audios: 'audio',
  video: 'video', videos: 'video', reference_videos: 'video',
};

/**
 * 插槽 = input_schema 中声明了媒体 x-handle（或 format:uri）的属性，一一对应，零猜测。
 * key 取 x-slot（归一插槽键，缺省用属性名本身），originalKey 恒为属性名（provider 真实入参键）。
 * 不再有任何按 kind 的写死兜底：源没声明 = 没有插槽。
 */
export function extractSlotsFromProvider(provider: DynamicProviderInfo | null, _nodeKind?: string): AssetSlotDef[] {
  const props = provider?.input_schema?.properties || {};
  const requiredKeys: string[] = Array.isArray(provider?.input_schema?.required) ? provider!.input_schema!.required : [];
  const slots: AssetSlotDef[] = [];
  const seen = new Set<string>();

  for (const [key, def] of Object.entries<any>(props)) {
    const xHandle = String(def?.['x-handle'] || '').toLowerCase();
    const type = HANDLE_MEDIA[xHandle];
    const isArray = def?.type === 'array';
    const isUri = def?.format === 'uri' || (isArray && def?.items?.format === 'uri');
    if (!type && !isUri) continue;
    const mediaType: AssetSlotDef['type'] = type || 'image';
    const slotKey: string = def['x-slot'] || key;
    if (seen.has(slotKey)) continue;
    seen.add(slotKey);
    const isRequired = requiredKeys.includes(key);
    let maxCount: number | undefined;
    let minCount: number | undefined;
    if (isArray) {
      maxCount = typeof def.maxItems === 'number' ? def.maxItems : (typeof def.items?.maxItems === 'number' ? def.items.maxItems : undefined);
      minCount = typeof def.minItems === 'number' ? def.minItems : (typeof def.items?.minItems === 'number' ? def.items.minItems : undefined);
      if (minCount === undefined) minCount = isRequired ? 1 : 0;
    } else {
      maxCount = 1;
      minCount = isRequired ? 1 : 0;
    }
    slots.push({
      key: slotKey,
      label: def.description || def.title || slotKey,
      type: mediaType,
      required: isRequired,
      description: def.description || '',
      maxCount,
      minCount,
      originalKey: key,
      multi: isArray && (maxCount === undefined || maxCount > 1),
      role: def['x-role'] || undefined,
      aggregate: def['x-aggregate'] === true,
    });
  }
  return slots;
}

/**
 * params_schema → ControlSpec 全系统唯一映射（画布 + 分镜共用）。
 * 分组/暴露级别/人机分工/排序只读 x-*（后端 resolve_params_schema 单点补全），前端零参数名硬编码。
 */
export function paramsSchemaToSpecs(schema?: Record<string, any>): ControlSpec[] {
  if (!schema?.properties) return [];
  const requiredArr: string[] = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries<any>(schema.properties).map(([key, def]) => {
    const hasEnum = Array.isArray(def.enum) && def.enum.length > 0;
    let type: ControlSpec['type'] = 'text';
    if (hasEnum) type = 'combo';
    else if (def.type === 'integer' || def.type === 'number') type = 'number';
    else if (def.type === 'boolean') type = 'boolean';
    else if (def.type === 'string' && def.format === 'uri') type = HANDLE_MEDIA[String(def['x-handle'] || '').toLowerCase()] || 'image';
    // x-control 仅允许覆盖到已知控件，未知值保持类型推断结果
    const xc = def['x-control'];
    if (xc === 'slider' || xc === 'select' || xc === 'toggle' || xc === 'input') {
      if (xc === 'slider') type = 'number';
      else if (xc === 'select') type = 'combo';
      else if (xc === 'toggle') type = 'boolean';
      else type = 'text';
    }
    return {
      id: key,
      param_name: key,
      label: def.title || key,
      type,
      description: def.description || '',
      role: def['x-role'],
      options: hasEnum ? def.enum.map((v: any) => String(v)) : undefined,
      default_value: def.default,
      required: requiredArr.includes(key) || !!def.required,
      min: def.minimum ?? def.min,
      max: def.maximum ?? def.max,
      step: def.step,
      category: def['x-category'] || 'advanced',
      visibility: def['x-visibility'] || 'advanced',
      agent: def['x-agent'] || 'suggest',
      priority: def['x-priority'] ?? 50,
    } as ControlSpec;
  });
}

/**
 * 生成人类可读的源能力摘要：几张图片/几段音频
 */
export function describeProviderSlots(provider: DynamicProviderInfo | null, kind: string): string {
  const slots = extractSlotsFromProvider(provider, kind);
  if (slots.length === 0) return '无需外部素材';
  const parts = slots.map(s => {
    const u = s.type === 'audio' ? '段音频' : s.type === 'video' ? '段视频' : '张图片';
    const range = s.maxCount === undefined ? `多${u}` : s.maxCount === 1 ? `1${u}` : `${s.minCount ?? 0}-${s.maxCount}${u}`;
    return `${s.label}${s.required ? '' : '（可选）'}：${range}`;
  });
  return parts.join('，');
}

/**
 * 预设的高阶 Agentic 技能（如剧本拆解、3D导演机位规划等）
 */
export interface AgentHighLevelSkill {
  id: string;
  name: string;
  desc: string;
  category: 'text' | 'image' | 'video' | 'audio' | 'director3d';
  iconName: string;
  guidePrompt: string;
}

export const HIGH_LEVEL_AGENT_SKILLS: AgentHighLevelSkill[] = [
  {
    id: 'script_generation',
    name: '剧本拆解',
    desc: '基于故事梗概一键拆解漫剧分镜与角色台词',
    category: 'text',
    iconName: 'Clapperboard',
    guidePrompt: '输入你想讲的故事、场景或小说段落，AI 将自动拆解为场景与镜头对白…',
  },
  {
    id: 'proposal_generation',
    name: '策划案生成',
    desc: '生成漫剧世界观设定、主角人设与前三集爆点大纲',
    category: 'text',
    iconName: 'FileText',
    guidePrompt: '输入漫剧题材或核心梗（如都市修仙、赛博悬疑），AI 自动生成完整策划案…',
  },
  {
    id: 'prompt_expansion',
    name: '电影级提示词扩写',
    desc: '将简短画面描述扩写为细节丰富、光影构图专业的影视级提示词',
    category: 'text',
    iconName: 'Sparkles',
    guidePrompt: '输入简单构思（如“雨夜刺客”），AI 自动补充镜头景别、光线氛围与胶片质感…',
  },
  {
    id: 'custom_text',
    name: '自由编写',
    desc: '直接编写剧本台词或自定义提示词',
    category: 'text',
    iconName: 'Edit3',
    guidePrompt: '在此输入或粘贴自定义剧本、台词与镜头描述…',
  },
];

// 图像 Agent 技能（绑定 Provider image + MCP comfyui_render_node / generate_image）
export const IMAGE_AGENT_SKILLS: AgentHighLevelSkill[] = [
  { id: 'text_to_image', name: '文生图', desc: '纯文本生成概念分镜', category: 'image', iconName: 'Image', guidePrompt: '描述画面主体、风格与光影，一键生成 9:16 分镜…' },
  { id: 'image_reference', name: '参考生图', desc: '基于角色/场景参考图保持一致性', category: 'image', iconName: 'Copy', guidePrompt: '已挂载参考图，描述新姿态与场景，Agent 自动保持角色一致性…' },
  { id: 'character_consistency', name: '角色一致性', desc: '绑定角色卡三视图 + 场景资产', category: 'image', iconName: 'Users', guidePrompt: '选择角色与场景资产，生成该角色在新场景的定妆照…' },
];

// 视频 Agent 技能（绑定 Provider video + generate_video）
export const VIDEO_AGENT_SKILLS: AgentHighLevelSkill[] = [
  { id: 'first_last_frame', name: '首尾帧', desc: '首帧→尾帧连续镜头', category: 'video', iconName: 'Film', guidePrompt: '已挂载首/尾帧，描述运镜与动作，生成连贯 5s 镜头…' },
  { id: 'all_round_reference', name: '全能参考', desc: '多参考图驱动的 R2V', category: 'video', iconName: 'Layers', guidePrompt: '已挂载多张参考图，描述镜头运动，R2V 生成…' },
  { id: 'text_to_video', name: '文生视频', desc: '纯文本运镜生成', category: 'video', iconName: 'Video', guidePrompt: '描述主体动作与镜头轨迹（推/拉/环绕），T2V 生成…' },
];

// 音频 Agent 技能
export const AUDIO_AGENT_SKILLS: AgentHighLevelSkill[] = [
  { id: 'tts_voice', name: '角色配音', desc: '文本→角色情感配音', category: 'audio', iconName: 'Mic', guidePrompt: '输入台词，Agent 自动匹配角色 VoiceID 与情绪…' },
  { id: 'audio_clone', name: '音色克隆', desc: '参考音频克隆', category: 'audio', iconName: 'Copy', guidePrompt: '已挂载参考音频，输入新台词克隆该音色…' },
];

// 3D 导演技能
export const DIRECTOR_AGENT_SKILLS: AgentHighLevelSkill[] = [
  { id: 'camera_plan', name: '机位规划', desc: '景别+运镜一键计算', category: 'director3d', iconName: 'Box', guidePrompt: '选择景别与运镜，生成 MiniMax 相机 Prompt…' },
];

// 按节点类型取技能
export function getSkillsForKind(kind: string): AgentHighLevelSkill[] {
  if (kind === 'prompt') return HIGH_LEVEL_AGENT_SKILLS;
  if (kind === 'image') return IMAGE_AGENT_SKILLS;
  if (kind === 'video') return VIDEO_AGENT_SKILLS;
  if (kind === 'audio') return AUDIO_AGENT_SKILLS;
  if (kind === 'director3d') return DIRECTOR_AGENT_SKILLS;
  return [];
}

/**
 * 技能行为预设：切技能时约束插槽必挂 + 注入默认参数（Phase3 技能行为化）
 */
export interface SkillPreset {
  requiredSlots: string[];
  dimSlots?: string[];
  defaultParams?: Record<string, any>;
  forceMode?: string;
}

export const SKILL_PRESETS: Record<string, SkillPreset> = {
  text_to_image: { requiredSlots: [], dimSlots: ['reference', 'reference_images'] },
  image_reference: { requiredSlots: ['reference_images'], defaultParams: {} },
  character_consistency: { requiredSlots: ['reference_images'] },
  first_last_frame: { requiredSlots: ['first_frame', 'last_frame'], forceMode: 'i2v' },
  all_round_reference: { requiredSlots: ['reference_images'], forceMode: 'r2v' },
  text_to_video: { requiredSlots: [], dimSlots: ['first_frame', 'last_frame', 'reference_images'], forceMode: 't2v' },
  tts_voice: { requiredSlots: [], dimSlots: ['ref_audio'] },
  audio_clone: { requiredSlots: ['ref_audio'] },
};

export function getSkillPreset(skillId?: string): SkillPreset | undefined {
  return skillId ? SKILL_PRESETS[skillId] : undefined;
}

