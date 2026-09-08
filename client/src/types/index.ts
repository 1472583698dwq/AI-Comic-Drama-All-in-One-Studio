export type AspectRatio = '9:16' | '16:9' | '1:1';

export type StylePreset = 
  | 'donghua_xianxia' 
  | 'japanese_anime' 
  | 'modern_webtoon' 
  | 'cinematic_3d' 
  | 'dark_comic'
  | 'pure_white_aesthetic'
  | 'white_minimalist';

export type CameraFraming = 
  | 'extreme_close_up'
  | 'close_up'
  | 'medium'
  | 'full'
  | 'long'
  | 'bird_eye'
  | 'low_angle'
  | 'over_shoulder'
  | 'dutch_angle'
  | 'high_angle';

export type CameraMotion = 
  | 'static'
  | 'push_in'
  | 'pull_out'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'orbit'
  | 'orbit_ccw'
  | 'truck_left'
  | 'truck_right'
  | 'boom_up'
  | 'boom_down'
  | 'roll_left'
  | 'roll_right'
  | 'tracking'
  | 'shake'
  | 'dolly_zoom'
  | 'orbit_boom_up'
  | 'pan_left_crane_down'
  | 'fast_push_shake'
  | 'low_angle_truck_right';

export type PosePreset = 
  | 'stand' 
  | 'fight' 
  | 'look_back' 
  | 'run' 
  | 'cast_spell' 
  | 'kneel' 
  | 'defend' 
  | 'fly' 
  | 'injured';

export type CastLayout = 'solo' | 'duel' | 'ots' | 'surrounded';

export type StagePropType = 'sword' | 'shield' | 'magic_circle' | 'spirit_particles' | 'chair' | 'helmet' | 'camera' | 'avocado' | 'boombox';

export type StageEnvironment = 'cyber_studio' | 'xianxia_cloud' | 'desert_battle' | 'neon_city';

export type EmotionType = 
  | 'neutral'
  | 'intense'
  | 'sorrow'
  | 'excited'
  | 'fearful'
  | 'whispering';

export interface Character {
  id: string;
  name: string;
  gender: 'male' | 'female' | 'other';
  age_group: 'teen' | 'youth' | 'middle' | 'elder';
  role: 'protagonist' | 'antagonist' | 'supporting' | 'narrator';
  description: string;
  visual_prompt: string;
  voice_id: string;
  voice_name: string;
  emotion_preset: EmotionType;
  avatar_url?: string;
  three_views?: {
    front?: string;
    side?: string;
    three_quarter?: string;
  };
}

export interface StoryboardShot {
  id: string;
  shot_index: number;
  scene_index: number;
  camera_framing: CameraFraming;
  camera_motion: CameraMotion;
  action_desc: string;
  speaker_id?: string;
  speaker_name?: string;
  dialogue?: string;
  voiceover?: string;
  emotion: EmotionType;
  image_prompt: string;
  video_prompt?: string;
  image_url?: string;
  video_url?: string;
  audio_url?: string;
  duration: number; // in seconds
  subtitle_text: string;
  status: 'ready' | 'generating_image' | 'generating_video' | 'generating_audio' | 'completed' | 'error';
  pose_preset?: PosePreset;
  depth_map_url?: string;
  focal_length_mm?: number;
  camera_roll_deg?: number;
  cast_layout?: CastLayout;
  props_config?: StagePropType[];
  // 3D 导演台预演落盘（与 AI 首帧 image_url / 成片 video_url 解耦，避免互相覆盖）
  previz_url?: string; // 白模截图（PNG dataURL 或资产 URL），供分镜参考与白模约束生成
  previz_video_url?: string; // 动态预演录制（webm），走位+运镜同节奏
  motion_speed?: '0.5x' | '1.0x' | '1.5x' | '2.0x'; // 运镜模拟速度
  walk_path?: Array<{ x: number; z: number }>; // 主角地面走位路径点
  canvas_id?: string; // 隶属画布（分镜右键 → 新画布/隶属画布，视频在该画布生成后回写）
  stage_layout?: Record<string, { p: [number, number, number]; r: [number, number, number]; s: number }>; // 3D导演台物体摆位（entity名 → 位姿），对标小云雀/updream可视化摆放持久化
  lighting_config?: { // 基础三点光（环境氛围光由影棚预设叠加，不在此）
    keyIntensity: number; keyAzimuth: number; keyTemp: 'neon' | 'cold' | 'warm' | 'moon';
    rimIntensity: number; ambientIntensity: number; exposure: number;
  };
  // P0+: Provider 驱动落盘
  image_provider?: string;
  video_provider?: string;
  audio_provider?: string;
  provider_params?: { image?: Record<string,any>; video?: Record<string,any>; audio?: Record<string,any> };
  dynamic_inputs?: Record<string,any>;
  workflow_id?: string;
  history?: Array<{ image_url?: string; video_url?: string; audio_url?: string; ts: string; provider?: string }>;
  // 2026 片场三大制作模式 (漫画制作 | 漫剧直出 | 图生视频结合)
  production_mode?: 'comic' | 'motion_comic' | 'image_to_video';
  candidates?: string[]; // 1 镜多抽候选列表 (如 4 抽)
  selected_candidate_index?: number;
  character_ids?: string[]; // 绑定的出场角色资产 ID
  character_weights?: Record<string, number>; // 角色参考图/IP-Adapter 权重 (0.0~1.0)
  scene_asset_id?: string; // 绑定的场景素材 ID
  scene_name?: string; // 场景名称
  scene_ref_image?: string; // 场景参考底图 URL
  scene_prompt?: string; // 场景环境与光影提示词
  prop_asset_ids?: string[]; // 绑定的道具/特效素材 ID 列表
  prop_prompts?: string; // 道具与法宝描述词
  audio_duration?: number; // 实际 TTS 配音真实时长 (秒)
  render_status?: 'idle' | 'queued' | 'rendering' | 'done' | 'error';
  render_error?: string;
}

export interface Scene {
  id: string;
  scene_index: number;
  title: string;
  location: string;
  time_of_day: 'day' | 'night' | 'dusk' | 'dawn';
  atmosphere: 'epic' | 'tense' | 'peaceful' | 'eerie';
  shots: StoryboardShot[];
}

export interface Project {
  id: string;
  title: string;
  original_novel: string;
  style_preset: StylePreset;
  aspect_ratio: AspectRatio;
  characters: Character[];
  scenes: Scene[];
  bgm_name?: string;
  created_at: string;
  updated_at: string;
  engine?: string;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  category: 'ai_generation' | 'workflow' | 'export' | 'audio' | 'utility';
  icon: string;
  author: string;
  is_enabled: boolean;
  input_schema: Record<string, any>;
}

export interface MCPToolLog {
  id: string;
  tool_name: string;
  timestamp: string;
  status: 'success' | 'executing' | 'error';
  arguments: Record<string, any>;
  result?: any;
  duration_ms?: number;
}

export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  tools: string[];
  instructions: string;
  is_active?: boolean;
}

export interface SkillExecutionResult {
  skill_name: string;
  status: 'success' | 'error';
  execution_time_ms: number;
  tool_calls: Array<{
    tool: string;
    status: string;
    result?: any;
  }>;
  result_message: string;
  modified_data?: Record<string, any>;
}

export type AssetCategory = 'character' | 'scene' | 'prop' | 'background' | 'effect' | 'ui' | 'previz' | 'other';
export type AssetStatus = 'draft' | 'approved' | 'archived';

export interface Asset {
  id: string;
  project_id?: string;
  name: string;
  category: AssetCategory;
  subcategory?: string;
  status: AssetStatus;
  description: string;
  tags: string[];
  visual_prompt: string;
  negative_prompt?: string;
  style_preset?: string;
  file_url?: string;
  thumb_url?: string;
  file_path?: string;
  width?: number;
  height?: number;
  style_anchor_id?: string;
  lora_trigger?: string;
  ip_adapter_refs?: string[];
  checkpoint?: string;
  seed?: number;
  workflow_id?: string;
  voice_id?: string;
  voice_name?: string;
  three_views?: { front?: string; side?: string; three_quarter?: string };
  source: string;
  extra?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

