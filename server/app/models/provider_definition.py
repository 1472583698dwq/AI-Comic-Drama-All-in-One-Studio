"""
ProviderDefinition - 生成源定义（解耦：每个生成源为独立节点）
支持 ComfyUI 本地 + 任意 HTTP API 扩展（由导演自动生成）
"""
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, model_validator
from datetime import datetime
import uuid


def normalize_headers(headers: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """
    遵循 OpenCode 与 RFC HTTP 规范进行大小写不敏感清洗去重。
    保留最后写入的键值对，并剔除空键与非字符串值。
    """
    if not headers or not isinstance(headers, dict):
        return {}
    normalized: Dict[str, str] = {}
    lower_map: Dict[str, str] = {}
    for k, v in headers.items():
        if k is None or v is None:
            continue
        key_str = str(k).strip()
        if not key_str:
            continue
        lower_key = key_str.lower()
        val_str = str(v)
        if lower_key in lower_map:
            old_orig_key = lower_map[lower_key]
            if old_orig_key in normalized and old_orig_key != key_str:
                del normalized[old_orig_key]
        lower_map[lower_key] = key_str
        normalized[key_str] = val_str
    return normalized


ProviderKind = Literal['image', 'video', 'audio', 'llm']
ProviderType = Literal['comfyui', 'http', 'local', 'code']
ProviderScope = Literal['global', 'project']
AuthType = Literal['none', 'bearer', 'apikey_header', 'apikey_query', 'basic']


class ProviderAuthConfig(BaseModel):
    type: AuthType = "none"
    header_name: Optional[str] = "Authorization"  # for apikey_header
    query_name: Optional[str] = "api_key"  # for apikey_query
    # key 值不直接存明文在 definition.json？存引用，实际从 config_store / env 读取
    # 这里存占位，真实 key 通过 provider_id 映射到 storage
    key_env: Optional[str] = None  # 例如 CUSTOM_PROVIDER_SK_xxx
    prefix: Optional[str] = "Bearer "  # for bearer


class ProviderTransport(BaseModel):
    method: str = "POST"
    url: str = ""  # e.g. https://api.xxx.com/v1/images/generations
    headers: Dict[str, str] = Field(default_factory=dict)  # 支持 {{api_key}} 模板
    query: Dict[str, str] = Field(default_factory=dict)
    timeout: int = 1200


class ProviderMapping(BaseModel):
    # 请求映射：模板字符串，使用 {prompt} {negative_prompt} {width} {height} {seed} {model} 等占位
    # 若为 None 则使用默认映射
    request_template: Optional[Dict[str, Any]] = None
    # 响应提取：JSONPath 简化版，例如 "data[0].url" 或 "images[0].url" 或 "audio"
    response_mappings: Dict[str, str] = Field(default_factory=dict)
    # 例如 {"image_url": "data[0].url", "video_url": "data.video_url"}


class ProviderHealthCheck(BaseModel):
    url: Optional[str] = None
    method: str = "GET"
    expect_status: int = 200
    test_payload: Optional[Dict[str, Any]] = None


# === 代码生成源（取代 JSON 模板） ===
CodeLanguage = Literal['python', 'javascript']


class ProviderCodeConfig(BaseModel):
    language: CodeLanguage = "python"  # python | javascript
    code: str = ""  # 完整携程源码，需导出 async def generate(ctx, api) 或 module.exports
    entry: str = "generate"  # 入口函数名
    timeout: int = 1200  # 单次执行超时秒（至少20分钟）


class ProviderDefinition(BaseModel):
    id: str = Field(default_factory=lambda: f"prov_{uuid.uuid4().hex[:8]}")
    name: str = ""  # 展示名，如 硅基流动 FLUX
    display_name: Optional[str] = None
    kind: ProviderKind = "image"  # image/video/audio/llm
    provider_type: ProviderType = "http"  # comfyui/http/code
    description: str = ""
    icon: str = "Zap"
    scope: ProviderScope = "global"
    project_id: Optional[str] = None
    builtin: bool = False  # 内置不可删
    enabled: bool = True

    # === 代码生成源（唯一执行方式，JSON 模板已废弃） ===
    language: CodeLanguage = "python"
    code: Optional[str] = None  # 完整源码
    # 插件包写法：代码放真实文件（相对 plugin.json 的包内路径），启用时由插件管理器读入 code。
    # 与 code 同时存在时 inline code 优先；裸件/UI 创建仍用 code。
    code_file: Optional[str] = None
    code_entry: str = "generate"
    code_timeout: int = 1200
    # === 可信模式（A档最小闭环）：trusted=True 时跳出受限沙箱，可执行任意代码 ===
    # 需同时满足全局开关 STUDIO_TRUSTED_MODE=1，否则回落沙箱并报错提示。
    trusted: bool = False

    # 兼容：旧 JSON 模板（已废弃，仅用于存量迁移，创建新源时忽略）
    transport: ProviderTransport = Field(default_factory=ProviderTransport)
    auth: ProviderAuthConfig = Field(default_factory=ProviderAuthConfig)
    mapping: ProviderMapping = Field(default_factory=ProviderMapping)
    health_check: ProviderHealthCheck = Field(default_factory=ProviderHealthCheck)
    # 废弃标记
    legacy_json_mode: bool = False

    # 自定义请求头 (Custom Headers) - 对齐 OpenCode 规范，用于 AI Gateway、反代、认证等
    headers: Dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _sync_headers_compat(cls, data: Any) -> Any:
        if isinstance(data, dict):
            hdrs = data.get("headers")
            if hdrs is None:
                hdrs = data.get("custom_headers")
            if not hdrs and isinstance(data.get("transport"), dict):
                hdrs = data["transport"].get("headers")
            if hdrs and isinstance(hdrs, dict):
                cleaned = normalize_headers(hdrs)
                data["headers"] = cleaned
                if "transport" not in data or not isinstance(data["transport"], dict):
                    data["transport"] = {}
                data["transport"]["headers"] = {**data["transport"].get("headers", {}), **cleaned}
        return data


    # 模型与参数 Schema（驱动前端动态表单）
    models: List[str] = Field(default_factory=list)
    default_model: Optional[str] = None
    # JSON Schema 形式的额外参数（steps/cfg/width等），前端自动渲染
    params_schema: Optional[Dict[str, Any]] = None
    # 默认参数值
    default_params: Dict[str, Any] = Field(default_factory=dict)
    # 输入输出 Schema（驱动画布句柄，含 x-handle 标注）
    input_schema: Optional[Dict[str, Any]] = None
    output_schema: Optional[Dict[str, Any]] = None
    # ComfyUI 工作流绑定：每条工作流独立抽象为生成源（仅内部导出工作流）
    workflow_id: Optional[str] = None  # 关联 storage/workflows/<workflow_id>.json
    workflow_hash: Optional[str] = None  # 工作流内容 hash，用于变更检测
    workflow_exposed: Optional[List[Dict[str, Any]]] = None  # 工作流暴露输入清单，用于标准→具体映射
    schema_version: Optional[int] = None  # 工作流→Schema 生成规则版本，不一致时触发重建（启动 fast path 依据）
    # 能力细分（创建/导入时勾选，空则前端按 input_schema 插槽推断）：
    # image: t2i 文生图 / i2i 图生图 / reference 参考生图
    # video: t2v 文生视频 / i2v 图生视频(首帧) / r2v 参考生视频 / start_end 首尾帧
    # audio: tts 文本配音 / clone 声音复刻
    # llm: chat 对话生成
    capabilities: List[str] = Field(default_factory=list)

    # 额外元信息
    doc_url: Optional[str] = None
    doc_text: Optional[str] = None
    # 创建/更新时间
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())

    # 兼容：原始 API 文档（保存供导演二次解析）
    raw_api_doc: Optional[str] = None

    def touch(self):
        self.updated_at = datetime.now().isoformat()
        return self

    def get_display_name(self) -> str:
        return self.display_name or self.name or self.id

    def to_provider_info(self, include_code: bool = True) -> Dict[str, Any]:
        info: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "display_name": self.get_display_name(),
            "kind": self.kind,
            "provider_type": self.provider_type,
            # 能力声明：前端据此决定 工作流选择 是否对该源生效（接口映射，不写死 id 名单）
            "supports_workflow": self.provider_type == "comfyui",
            "description": self.description,
            "icon": self.icon,
            "scope": self.scope,
            "project_id": self.project_id,
            "builtin": self.builtin,
            "enabled": self.enabled,
            "models": self.models,
            "default_model": self.default_model,
            "params_schema": self.params_schema,
            "default_params": self.default_params,
            "input_schema": self.input_schema,
            "output_schema": self.output_schema,
            "workflow_id": self.workflow_id,
            "workflow_hash": self.workflow_hash,
            "workflow_exposed": self.workflow_exposed,
            "schema_version": self.schema_version,
            "capabilities": list(self.capabilities or []),
            "transport": self.transport.model_dump(),
            "headers": self.headers or (self.transport.headers if self.transport else {}) or {},
            "custom_headers": self.headers or (self.transport.headers if self.transport else {}) or {},
            "auth": {**self.auth.model_dump(), "has_key": bool(self.auth.key_env)},
            "health_check": self.health_check.model_dump(),
            "doc_url": self.doc_url,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "language": self.language,
            "code_entry": self.code_entry,
            "code_timeout": self.code_timeout,
            "trusted": bool(getattr(self, "trusted", False)),
            "legacy_json_mode": self.legacy_json_mode,
            "has_code": bool(self.code),
        }
        if include_code:
            info["code"] = self.code or ""
        else:
            info["code_preview"] = (self.code[:500] + "...") if self.code and len(self.code) > 500 else (self.code or "")
        return info
