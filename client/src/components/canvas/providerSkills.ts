// -*- coding: utf-8 -*-
/**
 * Dynamic Provider & Skill Adapter for Agentic Infinite Canvas
 * 与后端动态生成源系统 (ProviderDefinition) 深度打通
 */

export interface AssetSlotDef {
  key: string;
  label: string;
  type: 'image' | 'video' | 'audio';
  required?: boolean;
  handleType?: string;
  description?: string;
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

/**
 * 从 Provider 的 input_schema 中解析出所需的资产插槽
 */
export function extractSlotsFromProvider(provider: DynamicProviderInfo | null, nodeKind: string): AssetSlotDef[] {
  if (!provider) {
    // 默认兜底插槽
    if (nodeKind === 'video') {
      return [
        { key: 'first_frame', label: '首帧', type: 'image', required: false, description: '视频起始画面' },
        { key: 'last_frame', label: '尾帧', type: 'image', required: false, description: '视频结束画面' },
        { key: 'reference_images', label: '参考图', type: 'image', required: false, description: '主体/角色参考' },
      ];
    }
    if (nodeKind === 'image') {
      return [
        { key: 'reference', label: '参考图/垫图', type: 'image', required: false, description: '垫图或风格参考' },
      ];
    }
    if (nodeKind === 'audio') {
      return [
        { key: 'ref_audio', label: '参考音频', type: 'audio', required: false, description: '音色克隆/参考音频' },
      ];
    }
    return [];
  }

  const props = provider.input_schema?.properties || {};
  const requiredKeys: string[] = Array.isArray(provider.input_schema?.required) ? provider.input_schema.required : [];
  const slots: AssetSlotDef[] = [];
  const seen = new Set<string>();

  const pushSlot = (key: string, label: string, type: AssetSlotDef['type'], desc: string, srcKey: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const isRequired = requiredKeys.includes(srcKey);
    slots.push({ key, label, type, required: isRequired, description: desc });
  };

  for (const [key, def] of Object.entries(props)) {
    const d: any = def;
    const xHandle = (d['x-handle'] || '').toString().toLowerCase();
    const desc = d.description || '';
    const isArray = d.type === 'array';
    const itemsFormat = isArray ? (d.items?.format || '') : '';
    const isUri = d.format === 'uri' || itemsFormat === 'uri';
    // 仅 uri 类型的输入才视为资产插槽（prompt/text 为 string 非 uri，跳过）
    if (!isUri) continue;

    const lowerKey = key.toLowerCase();

    // 1) 首帧：key 优先，其次 x-handle 精确，其次泛型 image + key 含 first
    if (key === 'first_frame' || key === 'first_frame_url' || lowerKey === 'first_frame' || xHandle === 'first_frame' || (xHandle === 'image' && lowerKey.includes('first_frame')) || (xHandle === 'image' && lowerKey === 'firstframe')) {
      pushSlot('first_frame', '首帧', 'image', desc || '视频起始画面', key);
      continue;
    }
    if (key === 'last_frame' || key === 'last_frame_url' || xHandle === 'last_frame' || (xHandle === 'image' && lowerKey.includes('last_frame'))) {
      pushSlot('last_frame', '尾帧', 'image', desc || '视频结束画面', key);
      continue;
    }
    // 2) 参考图组：key 命中最优先
    if (key === 'reference_images' || key === 'reference_image' || key === 'reference' || xHandle === 'reference_images' || xHandle === 'reference' || xHandle === 'images' || (isUri && lowerKey.includes('reference'))) {
      // 统一归一到 reference_images（多图）与 reference（单图）兼容：优先用 reference_images
      const targetKey = lowerKey.includes('reference_images') || xHandle === 'reference_images' || lowerKey === 'reference_images' ? 'reference_images' : (lowerKey === 'reference' ? 'reference' : 'reference_images');
      const label = targetKey === 'reference' ? '参考图' : '参考图';
      pushSlot(targetKey, label, 'image', desc || '角色/主体参考图', key);
      continue;
    }
    // 3) 音频参考：需 uri 且含 audio
    if (xHandle === 'audio' || lowerKey.includes('ref_audio') || lowerKey.includes('reference_audio') || (isUri && lowerKey.includes('audio'))) {
      pushSlot('ref_audio', '参考音频', 'audio', desc || '音色参考', key);
      continue;
    }
    // 4) 视频参考
    if (xHandle === 'video' || xHandle === 'reference_video' || (isUri && lowerKey.includes('video'))) {
      pushSlot('reference_video', '参考视频', 'video', desc || '动作/视频参考', key);
      continue;
    }
    // 5) 兜底：泛型 image 插槽按 key 语义回落
    if (xHandle === 'image' && isUri) {
      if (lowerKey.includes('first')) pushSlot('first_frame', '首帧', 'image', desc || '视频起始画面', key);
      else if (lowerKey.includes('last')) pushSlot('last_frame', '尾帧', 'image', desc || '视频结束画面', key);
      else pushSlot('reference_images', '参考图', 'image', desc || '参考图', key);
    }
  }

  if (slots.length === 0) {
    if (provider.kind === 'video') {
      slots.push(
        { key: 'first_frame', label: '首帧', type: 'image', required: false },
        { key: 'last_frame', label: '尾帧', type: 'image', required: false },
        { key: 'reference_images', label: '参考图', type: 'image', required: false }
      );
    } else if (provider.kind === 'image') {
      slots.push({ key: 'reference', label: '参考图', type: 'image', required: false });
    } else if (provider.kind === 'audio') {
      slots.push({ key: 'ref_audio', label: '参考音频', type: 'audio', required: false, description: '音色克隆参考' });
    }
  }

  return slots;
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

/**
 * 依据已装载插槽自动推荐技能（节点 Agent 自主选技能用）
 */
export function inferSkillForKind(kind: string, d: any): string {
  if (kind === 'image') {
    const hasRef = !!(d.reference || (Array.isArray(d.reference_images) && d.reference_images.length) || d.first_frame);
    return hasRef ? 'image_reference' : 'text_to_image';
  }
  if (kind === 'video') {
    const hasFirst = !!(d.first_frame || d.first_frame_url);
    const hasLast = !!(d.last_frame || d.last_frame_url);
    const hasRefs = Array.isArray(d.reference_images) && d.reference_images.length > 0;
    if (hasFirst && hasLast) return 'first_last_frame';
    if (hasRefs && !hasFirst) return 'all_round_reference';
    if (hasFirst) return 'first_last_frame';
    return 'text_to_video';
  }
  if (kind === 'audio') return d.ref_audio || d.ref_audio_path ? 'audio_clone' : 'tts_voice';
  if (kind === 'director3d') return 'camera_plan';
  return 'custom_text';
}

