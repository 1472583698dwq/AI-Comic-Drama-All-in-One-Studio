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
}

// 统一 Handle 定义
const H = (id:string, label:string, type:HandleDef['type'], required?:boolean): HandleDef => ({id, label, type, required});

// 全节点 I/O 规范（P0）
export const NODE_SPECS: Record<string, NodeSpec> = {
  'brief': {
    type:'brief', label:'灵感简报', desc:'粘贴小说/策划', color:'text-amber-400',
    inputs: [], outputs: [H('brief','简报','text',true), H('style_preset','风格','text'), H('aspect_ratio','画幅','text')],
  },
  'script-split': {
    type:'script-split', label:'剧本拆解', desc:'MiniMax LLM', color:'text-brand',
    inputs: [H('brief','简报','text',true)], outputs: [H('characters','角色','text'), H('shots','分镜','text')],
  },
  'shot-card': {
    type:'shot-card', label:'分镜卡', desc:'首帧+视频', color:'text-violet-400',
    inputs: [
      H('provider','生图源','image'),
      H('reference','参考图','image'),
      H('prompt','提示词','text'),
      H('character','角色','text'),
    ],
    outputs: [H('image','首帧','image'), H('video','视频','video'), H('shot','分镜','text')],
  },
  'comfy-workflow': {
    type:'comfy-workflow', label:'ComfyUI工作流', desc:'本地强控', color:'text-violet-400',
    inputs: [], // 运行时由 exposed_inputs 动态填充
    outputs: [H('image','图像','image'), H('video','视频','video')],
  },
  'provider-image': {
    type:'provider-image', label:'生图源', desc:'多源解耦', color:'text-violet-400',
    inputs: [], outputs: [H('provider','生图源','image',true)], providerKind:'image',
  },
  'provider-video': {
    type:'provider-video', label:'视频源', desc:'多源解耦', color:'text-orange-400',
    inputs: [], outputs: [H('provider','视频源','video',true)], providerKind:'video',
  },
  'provider-audio': {
    type:'provider-audio', label:'语音源', desc:'多源解耦', color:'text-pink-400',
    inputs: [], outputs: [H('provider','语音源','audio',true)], providerKind:'audio',
  },
  'provider': {
    type:'provider', label:'生成源', desc:'通用', color:'text-brand',
    inputs: [], outputs: [H('provider','源','text')],
  },
  'provider-llm': {
    type:'provider-llm', label:'LLM源', desc:'通用', color:'text-cyan-400',
    inputs: [], outputs: [H('provider','LLM','text')], providerKind:'llm',
  },
  'video': {
    type:'video', label:'生视频', desc:'I2V/R2V/T2V', color:'text-orange-400',
    inputs: [
      H('prompt','运动描述','text',true),
      H('first_frame','首帧','image'),
      H('reference_images','参考图集','image'),
      H('provider','视频源','video'),
    ],
    outputs: [H('video','视频','video')],
    paramsSchema: { type:'object', properties: {
      mode: { type:'string', enum:['i2v','r2v','t2v'], default:'i2v', description:'模式' },
      duration: { type:'integer', default:5, description:'时长秒' },
      resolution: { type:'string', enum:['720p','1080p'], default:'720p' },
    }},
  },
  'tts': {
    type:'tts', label:'TTS配音', desc:'文本→语音', color:'text-pink-400',
    inputs: [H('text','文本','text',true), H('reference_audio','参考音频','audio'), H('provider','语音源','audio')],
    outputs: [H('audio','音频','audio')],
    paramsSchema: { type:'object', properties: {
      voice_id: { type:'string', default:'male-qn-qingse' },
      emotion: { type:'string', enum:['neutral','intense','sorrow','excited','whispering'], default:'neutral' },
      speed: { type:'number', default:1.0 },
    }},
  },
  'director3d': {
    type:'director3d', label:'3D导演台', desc:'机位计算', color:'text-orange-400',
    inputs: [H('pose','姿态','text'), H('character','角色','text')],
    outputs: [H('camera_prompt','机位提示词','text')],
  },
  'timeline-export': {
    type:'timeline-export', label:'剪映导出', desc:'多轨草稿', color:'text-brand',
    inputs: [H('shots','分镜','text'), H('videos','视频','video'), H('audios','音频','audio')],
    outputs: [],
  },
  'asset': {
    type:'asset', label:'素材节点', desc:'从资产库拖入', color:'text-pink-400',
    inputs: [], outputs: [H('image','图像','image'), H('video','视频','video'), H('audio','音频','audio')],
  },
  // P1 新增加载节点
  'load-image': {
    type:'load-image', label:'加载图像', desc:'参考图', color:'text-violet-400',
    inputs: [], outputs: [H('image','图像','image',true)],
  },
  'load-image-batch': {
    type:'load-image-batch', label:'批量加载图像', desc:'多参考', color:'text-violet-400',
    inputs: [], outputs: [H('images','图像集','image',true)],
  },
  'load-video': {
    type:'load-video', label:'加载视频', desc:'参考视频', color:'text-orange-400',
    inputs: [], outputs: [H('video','视频','video',true)],
  },
  'load-audio': {
    type:'load-audio', label:'加载音频', desc:'参考音频', color:'text-pink-400',
    inputs: [], outputs: [H('audio','音频','audio',true)],
  },
  'text-prompt': {
    type:'text-prompt', label:'文本提示词', desc:'提示词', color:'text-sky-400',
    inputs: [], outputs: [H('prompt','提示词','text',true)],
    paramsSchema: { type:'object', properties: { prompt:{ type:'string', description:'提示词', default:'' } } },
  },
};

export function getNodeSpec(type:string): NodeSpec | undefined {
  return NODE_SPECS[type];
}
export function allNodeSpecs(): NodeSpec[] { return Object.values(NODE_SPECS); }
