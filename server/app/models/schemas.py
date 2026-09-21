from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime

class Character(BaseModel):
    # extra=allow：保留前端扩展字段（three_views 扩展槽/资产绑定等），保存时不再被 model_dump 丢弃
    model_config = {"extra": "allow"}

    id: str
    name: str
    gender: str = "male" # male, female, other
    age_group: str = "youth" # teen, youth, middle, elder
    role: str = "protagonist" # protagonist, antagonist, supporting, narrator
    description: str = ""
    visual_prompt: str = ""
    voice_id: str = "male-qn-qingse" # MiniMax voice timbre
    voice_name: str = "青涩青年音"
    ref_audio_url: Optional[str] = None # 参考音频绑定（音色克隆用，配音时作为 ref_audio 传给语音源）
    ref_audio_name: str = ""
    emotion_preset: str = "neutral" # neutral, angry, sad, happy, whisper, dramatic
    avatar_url: Optional[str] = None
    three_views: Dict[str, str] = Field(default_factory=dict) # {"front": url, "side": url, "three_quarter": url}

class StoryboardShot(BaseModel):
    # extra=allow：分镜上挂着大量前端扩展字段（character_ids/character_weights/scene_ref_image/
    # previz_url/previz_video_url/stage_cameras/previz_shots/lighting_config/walk_path/history…），
    # 这些字段由导演台与参考装配消费，必须在保存时原样保留（否则重载项目即丢）。
    model_config = {"extra": "allow"}

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
    pose_preset: Optional[str] = None # for 3D director stage
    focal_length_mm: Optional[float] = 35.0
    camera_roll_deg: Optional[float] = 0.0
    cast_layout: Optional[str] = "solo" # solo, duel, ots, surrounded
    props_config: Optional[List[str]] = Field(default_factory=list)

class Scene(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    scene_index: int
    title: str
    location: str
    time_of_day: str = "day" # day, night, dusk, dawn
    atmosphere: str = "mysterious" # epic, tense, peaceful, eerie
    shots: List[StoryboardShot] = Field(default_factory=list)

class Project(BaseModel):
    # extra=allow：项目级扩展字段（拼图/资产/封面等前端字段）保存时不丢
    model_config = {"extra": "allow"}

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
    model_config = {"extra": "allow"}
    prompt: str
    negative_prompt: Optional[str] = None
    aspect_ratio: str = "9:16" # 9:16, 16:9, 1:1
    resolution: Optional[str] = None  # 480p/720p/1080p 独立下拉
    style_preset: Optional[str] = None
    seed: Optional[int] = None
    provider: Optional[str] = None  # comfyui / siliconflow / dashscope / openai_compat
    workflow_id: Optional[str] = None  # 仅ComfyUI工作流模式
    model: Optional[str] = None  # 覆盖默认模型
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    cfg: Optional[float] = None
    fps: Optional[int] = None
    duration: Optional[int] = None
    reference_images: Optional[List[str]] = None
    dynamic_inputs: Optional[Dict[str, Any]] = None  # 外部暴露表单动态输入 (垫图/额外提示词等)

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
    # v2 一键成片
    video_provider: Optional[str] = None
    video_workflow_id: Optional[str] = None
    enable_video: bool = True
    max_videos: int = 6
    gen_roles: bool = True
    max_roles: int = 4

class TTSGenerateRequest(BaseModel):
    text: str
    voice_id: str = ""   # 空 = 由所选语音源自身声明的默认音色兜底
    emotion: str = ""    # 空 = 源默认情绪
    speed: float = 1.0
    pitch: float = 0.0
    provider: Optional[str] = None  # minimax / elevenlabs / cosyvoice / gpt_sovits
    model: Optional[str] = None
    ref_audio_path: Optional[str] = None
    ref_text: Optional[str] = None

class VideoGenerateRequestPayload(BaseModel):
    model_config = {"extra": "allow"}
    shot_id: Optional[str] = None
    prompt: str = ""
    mode: str = "i2v"  # i2v | r2v | t2v
    first_frame_url: Optional[str] = None
    last_frame_url: Optional[str] = None
    reference_images: Optional[List[str]] = None
    reference_videos: Optional[List[str]] = None
    reference_audios: Optional[List[str]] = None
    duration: int = 5
    resolution: str = "720p"
    aspect_ratio: str = "9:16"
    fps: Optional[int] = None
    seed: Optional[int] = None
    provider: Optional[str] = None
    workflow_id: Optional[str] = None
    dynamic_inputs: Optional[Dict[str, Any]] = None
    steps: Optional[int] = None
    cfg: Optional[float] = None

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
