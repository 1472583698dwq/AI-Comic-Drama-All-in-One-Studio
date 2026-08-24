export type AspectRatio = '9:16' | '16:9' | '1:1';

export type StylePreset = 
  | 'donghua_xianxia' 
  | 'japanese_anime' 
  | 'modern_webtoon' 
  | 'cinematic_3d' 
  | 'dark_comic';

export type CameraFraming = 
  | 'extreme_close_up'
  | 'close_up'
  | 'medium'
  | 'full'
  | 'long'
  | 'bird_eye'
  | 'low_angle';

export type CameraMotion = 
  | 'static'
  | 'push_in'
  | 'pull_out'
  | 'pan_left'
  | 'pan_right'
  | 'tilt_up'
  | 'tilt_down'
  | 'orbit'
  | 'shake';

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
  pose_preset?: 'stand' | 'fight' | 'look_back' | 'run';
  depth_map_url?: string;
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

