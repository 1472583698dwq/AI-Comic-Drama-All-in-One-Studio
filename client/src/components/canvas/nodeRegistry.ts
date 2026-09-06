import { HandleDef } from './utils/dynamicHandles';

export type NodeKind = 'image'|'video'|'audio'|'text'|'character'|'shot';
export interface NodeSpec {
  type: string;
  label: string;
  desc: string;
  color: string;
  inputs: HandleDef[];
  outputs: HandleDef[];
  paramsSchema?: any;
  providerKind?: 'image'|'video'|'audio'|'llm';
  icon?: string;
  isCore?: boolean;
}

const H = (id:string, label:string, type:HandleDef['type'], required?:boolean): HandleDef => ({id, label, type, required});

// 6 核心线性节点 + 兼容老节点（迁移用，不在工具栏展示）
export const NODE_SPECS: Record<string, NodeSpec> = {
  // ====== 新 6 核心（极简） ======
  'prompt': {
    type:'prompt', label:'提示词', desc:'文本/描述', color:'text-sky-500',
    inputs: [], outputs: [H('prompt','提示词','text',true)],
    isCore: true,
  },
  'image': {
    type:'image', label:'生成图片', desc:'文生图 / 垫图', color:'text-violet-500',
    inputs: [
      H('prompt','提示词','text'),
      H('reference','参考图','image'),
      H('reference_images','参考集','image'),
      H('camera_prompt','机位','text'),
    ],
    outputs: [H('image','图像','image',true)],
    providerKind:'image',
    isCore: true,
  },
  'video': {
    type:'video', label:'生成视频', desc:'I2V/R2V/T2V', color:'text-orange-500',
    inputs: [
      H('prompt','运动描述','text'),
      H('first_frame','首帧','image'),
      H('last_frame','尾帧','image'),
      H('reference_images','参考集','image'),
      H('camera_prompt','机位','text'),
    ],
    outputs: [H('video','视频','video',true)],
    providerKind:'video',
    paramsSchema: { type:'object', properties: {
      mode: { type:'string', enum:['i2v','r2v','t2v'], default:'i2v' },
      duration: { type:'integer', default:5 },
    }},
    isCore: true,
  },
  'audio': {
    type:'audio', label:'生成音频', desc:'TTS 配音', color:'text-pink-500',
    inputs: [H('text','文本','text',true), H('ref_audio','参考音频','audio')],
    outputs: [H('audio','音频','audio',true)],
    providerKind:'audio',
    isCore: true,
  },
  'director3d': {
    type:'director3d', label:'3D导演台', desc:'机位/运镜', color:'text-amber-600',
    inputs: [H('prompt','提示词','text')],
    outputs: [H('camera_prompt','机位','text')],
    isCore: true,
  },
  'export': {
    type:'export', label:'导出', desc:'剪映/成片', color:'text-emerald-600',
    inputs: [H('video','视频','video'), H('audio','音频','audio')],
    outputs: [],
    isCore: true,
  },
  // ====== 兼容老类型（用于旧画布自动迁移，不在工具栏展示） ======
  'brief': {
    type:'brief', label:'灵感简报', desc:'兼容', color:'text-amber-400',
    inputs: [], outputs: [H('brief','简报','text',true)],
  },
  'script-split': {
    type:'script-split', label:'剧本拆解', desc:'兼容', color:'text-brand',
    inputs: [H('brief','简报','text',true)], outputs: [H('characters','角色','text'), H('shots','分镜','text')],
  },
  'shot-card': {
    type:'shot-card', label:'分镜卡', desc:'兼容', color:'text-violet-400',
    inputs: [H('provider','生图源','image'), H('reference','参考图','image'), H('prompt','提示词','text'), H('character','角色','text')],
    outputs: [H('image','首帧','image'), H('video','视频','video'), H('shot','分镜','text')],
  },
  'comfy-workflow': {
    type:'comfy-workflow', label:'ComfyUI工作流', desc:'兼容', color:'text-violet-400',
    inputs: [], outputs: [H('image','图像','image'), H('video','视频','video')],
  },
  'provider-image': { type:'provider-image', label:'生图源', desc:'兼容', color:'text-violet-400', inputs: [], outputs: [H('provider','生图源','image',true)], providerKind:'image' },
  'provider-video': { type:'provider-video', label:'视频源', desc:'兼容', color:'text-orange-400', inputs: [], outputs: [H('provider','视频源','video',true)], providerKind:'video' },
  'provider-audio': { type:'provider-audio', label:'语音源', desc:'兼容', color:'text-pink-400', inputs: [], outputs: [H('provider','语音源','audio',true)], providerKind:'audio' },
  'provider': { type:'provider', label:'生成源', desc:'兼容', color:'text-brand', inputs: [], outputs: [H('provider','源','text')] },
  'provider-llm': { type:'provider-llm', label:'LLM源', desc:'兼容', color:'text-cyan-400', inputs: [], outputs: [H('provider','LLM','text')], providerKind:'llm' },
  'tts': { type:'tts', label:'TTS配音', desc:'兼容', color:'text-pink-400', inputs: [H('text','文本','text',true), H('reference_audio','参考音频','audio'), H('provider','语音源','audio')], outputs: [H('audio','音频','audio')], providerKind:'audio' },
  'timeline-export': { type:'timeline-export', label:'剪映导出', desc:'兼容', color:'text-brand', inputs: [H('shots','分镜','text'), H('videos','视频','video'), H('audios','音频','audio')], outputs: [] },
  'asset': { type:'asset', label:'素材节点', desc:'兼容', color:'text-pink-400', inputs: [], outputs: [H('image','图像','image'), H('video','视频','video'), H('audio','音频','audio')] },
  'load-image': { type:'load-image', label:'加载图像', desc:'兼容', color:'text-violet-400', inputs: [], outputs: [H('image','图像','image',true)] },
  'load-image-batch': { type:'load-image-batch', label:'批量加载图像', desc:'兼容', color:'text-violet-400', inputs: [], outputs: [H('images','图像集','image',true)] },
  'load-video': { type:'load-video', label:'加载视频', desc:'兼容', color:'text-orange-400', inputs: [], outputs: [H('video','视频','video',true)] },
  'load-audio': { type:'load-audio', label:'加载音频', desc:'兼容', color:'text-pink-400', inputs: [], outputs: [H('audio','音频','audio',true)] },
  'text-prompt': { type:'text-prompt', label:'文本提示词', desc:'兼容', color:'text-sky-400', inputs: [], outputs: [H('prompt','提示词','text',true)] },
};

export function getNodeSpec(type:string): NodeSpec | undefined {
  return NODE_SPECS[type];
}
export function allNodeSpecs(): NodeSpec[] { return Object.values(NODE_SPECS); }
export function coreNodeSpecs(): NodeSpec[] { return Object.values(NODE_SPECS).filter(s=> s.isCore); }
