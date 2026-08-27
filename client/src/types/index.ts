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
  // P0+: Provider 驱动落盘
  image_provider?: string;
  video_provider?: string;
  audio_provider?: string;
  provider_params?: { image?: Record<string,any>; video?: Record<string,any>; audio?: Record<string,any> };
  dynamic_inputs?: Record<string,any>;
  workflow_id?: string;
  history?: Array<{ image_url?: string; video_url?: string; audio_url?: string; ts: string; provider?: string }>;
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

export type AssetCategory = 'character' | 'scene' | 'prop' | 'background' | 'effect' | 'ui' | 'other';
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

