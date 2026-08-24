from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime

class Character(BaseModel):
    id: str
    name: str
    gender: str = "male" # male, female, other
    age_group: str = "youth" # teen, youth, middle, elder
    role: str = "protagonist" # protagonist, antagonist, supporting, narrator
    description: str = ""
    visual_prompt: str = ""
    voice_id: str = "male-qn-qingse" # MiniMax voice timbre
    voice_name: str = "青涩青年音"
    emotion_preset: str = "neutral" # neutral, angry, sad, happy, whisper, dramatic
    avatar_url: Optional[str] = None
    three_views: Dict[str, str] = Field(default_factory=dict) # {"front": url, "side": url, "three_quarter": url}

class StoryboardShot(BaseModel):
    id: str
    shot_index: int
    scene_index: int = 1
    camera_framing: str = "medium" # close_up, extreme_close_up, medium, full, long, bird_eye, low_angle
    camera_motion: str = "push_in" # static, push_in, pull_out, pan_left, pan_right, tilt_up, tilt_down, orbit, shake
    action_desc: str
    speaker_id: Optional[str] = None
    speaker_name: Optional[str] = None
    dialogue: str = ""
    voiceover: str = "" # 旁白
    emotion: str = "neutral" # neutral, intense, sorrow, excited, fearful, whispering
    image_prompt: str
    video_prompt: str = ""
    image_url: Optional[str] = None
    video_url: Optional[str] = None
    audio_url: Optional[str] = None
    duration: float = 3.5 # in seconds
    subtitle_text: str = ""
    status: str = "ready" # idle, generating_image, generating_video, generating_audio, completed, error
    depth_map_url: Optional[str] = None
    pose_preset: Optional[str] = None # for 3D director stage (stand, fight, run, look_back)

class Scene(BaseModel):
    id: str
    scene_index: int
    title: str
    location: str
    time_of_day: str = "day" # day, night, dusk, dawn
    atmosphere: str = "mysterious" # epic, tense, peaceful, eerie
    shots: List[StoryboardShot] = Field(default_factory=list)

class Project(BaseModel):
    id: str
    title: str
    original_novel: str = ""
    style_preset: str = "donghua_xianxia" # donghua_xianxia, japanese_anime, modern_webtoon, cinematic_3d, dark_comic
    aspect_ratio: str = "9:16" # 9:16 (mobile vertical), 16:9 (desktop horizontal), 1:1
    characters: List[Character] = Field(default_factory=list)
    scenes: List[Scene] = Field(default_factory=list)
    bgm_name: Optional[str] = "Epic_Battle_Orchestra.mp3"
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    engine: Optional[str] = None # 拆解引擎标识: minimax-llm / local-rule-fallback

class ScriptParseRequest(BaseModel):
    text: str
    style_preset: str = "donghua_xianxia"
    aspect_ratio: str = "9:16"
    custom_instructions: Optional[str] = None

class ImageGenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    aspect_ratio: str = "9:16" # 9:16, 16:9, 1:1
    style_preset: Optional[str] = None
    seed: Optional[int] = None
    provider: Optional[str] = None  # comfyui / siliconflow / dashscope / openai_compat
    workflow_id: Optional[str] = None  # 仅ComfyUI工作流模式
    model: Optional[str] = None  # 覆盖默认模型
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    cfg: Optional[float] = None

class Character3ViewsRequest(BaseModel):
    name: str
    visual_prompt: str = ""
    description: str = ""
    style_preset: str = "donghua_xianxia"

class PipelineRunRequest(BaseModel):
    text: str
    style_preset: str = "donghua_xianxia"
    aspect_ratio: str = "9:16"
    custom_instructions: Optional[str] = None
    max_images: int = 12
    image_provider: Optional[str] = None
    image_workflow_id: Optional[str] = None
    audio_provider: Optional[str] = None

class TTSGenerateRequest(BaseModel):
    text: str
    voice_id: str = "male-qn-qingse"
    emotion: str = "neutral"
    speed: float = 1.0
    pitch: float = 0.0
    provider: Optional[str] = None  # minimax / elevenlabs / cosyvoice / gpt_sovits
    model: Optional[str] = None
    ref_audio_path: Optional[str] = None
    ref_text: Optional[str] = None

class MCPToolDefinition(BaseModel):
    name: str
    description: str
    category: str # "ai_generation", "workflow", "export", "audio", "utility"
    icon: str
    author: str = "Official"
    is_enabled: bool = True
    input_schema: Dict[str, Any]

class MCPToolCallRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any]

class MCPToolCallResponse(BaseModel):
    tool_name: str
    status: str # "success", "error"
    result: Any
    error: Optional[str] = None
    execution_time_ms: int = 0
