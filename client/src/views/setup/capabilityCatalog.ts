/**
 * 能力目录 —— 设置中心的唯一事实源。
 *
 * 组织方式：能力（我要做什么） → 通道（谁来做） → 字段（要填什么） → 测试（通没通）
 *
 * 维护约定（2026-09 校对，来源为各家官方文档，见每条通道的 docs 链接）：
 * - 模型名一律填**官方当前在售**的 ID：DeepSeek 用 deepseek-v4-*（chat/reasoner 已于 2026-07-24 弃用）、
 *   MiniMax 文本用 M 系列（abab 已停更）、TTS 用 speech-2.8-*、视频用 MiniMax-H3 / Hailuo；
 * - 域名用官方新域名（MiniMax → api.minimaxi.com / api.minimax.io；可灵 → api-beijing.klingai.com）；
 * - 只有后端真正读取的键才标 required（如 MINIMAX_GROUP_ID 当前代码不读取，标可选）。
 */
export type FieldKind = 'text' | 'secret' | 'url' | 'number' | 'path';

/** apiService.testConfig 支持的目标（与后端 /config/test 对齐） */
export type TestTarget =
  | 'openai' | 'responses_api' | 'minimax' | 'minimax_h3' | 'seedance'
  | 'kling' | 'wan3' | 'comfyui' | 'siliconflow' | 'dashscope' | 'openai_image'
  | 'elevenlabs' | 'cosyvoice' | 'gpt_sovits' | 'indextts' | 'jianyin';

/** 通道对应的后端生成源注册表（用于拉取真实配置状态；LLM 无注册表） */
export type ProviderKind = 'image' | 'video' | 'audio';

export interface CapField {
  key: string;
  label: string;
  kind?: FieldKind;
  placeholder?: string;
  /** 为空时该通道视为「未配置」 */
  required?: boolean;
  hint?: string;
  /** 走后端原生目录选择器（/system/browse-folder），并给出"打开目录"入口 */
  pick?: boolean;
  /** 一键填入的常用值（少而精：域名/端口这类） */
  quickFill?: Array<{ label: string; value: string }>;
  /** 可选项列表（模型名等），输入框会挂 datalist，可点选可手输 */
  choices?: string[];
}

export interface Channel {
  /** 同时是写进 routeKey 的值，必须与后端 provider id 一致 */
  id: string;
  name: string;
  where: 'cloud' | 'local';
  summary: string;
  test?: TestTarget;
  fields: CapField[];
  /** 选中该通道时要一并写入的其它键（如 LLM_API_TYPE） */
  extraOnSelect?: Record<string, string>;
  /** 显眼的风险提示 */
  warn?: string;
  /** 官方文档 / 控制台入口 */
  docs?: string;
  /** 旧版通道（保留兼容，不推荐新项目使用） */
  legacy?: boolean;
  /** 后端注册表，用于读取 is_configured / health 状态 */
  providerKind?: ProviderKind;
}

export interface Capability {
  id: string;
  name: string;
  /** 这个能力是干什么的——用大白话，给不懂的人看 */
  why: string;
  /** 不配会怎样 */
  ifMissing: string;
  /** 缺了它整个流程跑不起来 */
  essential?: boolean;
  /** 默认路由键：没显式指定时走哪个通道 */
  routeKey?: string;
  channels: Channel[];
}

const KEY = (key: string, label: string, extra: Partial<CapField> = {}): CapField => ({
  key, label, kind: 'secret', required: true, ...extra,
});

export const CAPABILITIES: Capability[] = [
  // ───────────────────────────── 1. 文本大模型
  {
    id: 'llm',
    name: '文本大模型',
    why: '把整章小说读懂，拆成角色表和一个个镜头（景别、运镜、台词、生图提示词）。AI 导演、提示词润色也都靠它。',
    ifMissing: '导入小说后无法拆分镜，AI 导演不会回话——整个流程的第一步就卡住。',
    essential: true,
    routeKey: 'LLM_PROVIDER',
    channels: [
      {
        id: 'openai_compatible',
        name: 'OpenAI 兼容接口',
        where: 'cloud',
        summary: '最通用的一档。DeepSeek / 通义 / Kimi / 硅基流动 / 自建代理 / 本地 Ollama 都走这条。',
        test: 'openai',
        extraOnSelect: { LLM_API_TYPE: 'chat_completions' },
        fields: [
          KEY('OPENAI_API_KEY', 'API Key', { placeholder: 'sk-...' }),
          KEY('OPENAI_BASE_URL', '接口地址', {
            kind: 'url', required: false, placeholder: 'https://api.deepseek.com/v1',
            hint: '留空默认 DeepSeek。点下面的按钮可一键换成其它厂商',
            quickFill: [
              { label: 'DeepSeek', value: 'https://api.deepseek.com/v1' },
              { label: '阿里百炼', value: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
              { label: '硅基流动', value: 'https://api.siliconflow.cn/v1' },
              { label: 'MiniMax', value: 'https://api.minimaxi.com/v1' },
              { label: '本地 Ollama', value: 'http://127.0.0.1:11434/v1' },
            ],
          }),
          KEY('OPENAI_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'deepseek-v4-flash',
            hint: 'DeepSeek 已于 2026-07-24 弃用 deepseek-chat / deepseek-reasoner：改用 deepseek-v4-pro（强）或 deepseek-v4-flash（快省）',
            choices: ['deepseek-v4-pro', 'deepseek-v4-flash', 'MiniMax-M3', 'MiniMax-M2.5', 'qwen3.7-plus'],
          }),
          KEY('OPENAI_CUSTOM_HEADERS', '自定义请求头', { kind: 'text', required: false, placeholder: '{"X-Foo":"bar"}', hint: 'JSON 格式，接私有网关时才需要' }),
        ],
      },
      {
        id: 'responses_api',
        name: 'OpenAI Responses API',
        where: 'cloud',
        summary: 'OpenAI 的新式 /v1/responses 接口；DeepSeek V4-Flash 也原生支持该格式。',
        test: 'responses_api',
        extraOnSelect: { LLM_API_TYPE: 'responses_api' },
        fields: [
          KEY('RESPONSES_API_KEY', 'API Key', { placeholder: 'sk-...' }),
          KEY('RESPONSES_API_URL', '接口地址', {
            kind: 'url', required: false, placeholder: 'https://api.openai.com/v1/responses',
            quickFill: [
              { label: 'OpenAI', value: 'https://api.openai.com/v1/responses' },
              { label: 'DeepSeek', value: 'https://api.deepseek.com/v1/responses' },
            ],
          }),
          KEY('RESPONSES_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'gpt-5.2',
            choices: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-4.1', 'deepseek-v4-flash'],
          }),
        ],
      },
      {
        id: 'minimax',
        name: 'MiniMax M 系列',
        where: 'cloud',
        summary: '一把 Key 同时供文本、配音、视频三种能力用。',
        test: 'minimax',
        extraOnSelect: { LLM_API_TYPE: 'chat_completions' },
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key'),
          KEY('MINIMAX_GROUP_ID', 'Group ID', { kind: 'text', required: false, hint: '旧版接口需要；当前 M 系列走 OpenAI 兼容，可不填' }),
          KEY('MINIMAX_BASE_URL', '接口地址', {
            kind: 'url', required: false, placeholder: 'https://api.minimaxi.com/v1',
            quickFill: [
              { label: '国内站', value: 'https://api.minimaxi.com/v1' },
              { label: '海外站', value: 'https://api.minimax.io/v1' },
            ],
            hint: '旧域名 api.minimax.chat 已弃用',
          }),
          KEY('LLM_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'MiniMax-M2.5',
            choices: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'],
          }),
        ],
      },
    ],
  },

  // ───────────────────────────── 2. 生图
  {
    id: 'image',
    name: '生图',
    why: '给每个镜头画出画面，也用来生成角色的定妆三视图——后面所有镜头靠它保证"这人长这样"。',
    ifMissing: '分镜有文字没画面，视频那一步也没法开始（图生视频要拿图当首帧）。',
    essential: true,
    routeKey: 'IMAGE_PROVIDER',
    channels: [
      {
        id: 'openai_compat',
        name: 'OpenAI 兼容生图',
        where: 'cloud',
        providerKind: 'image',
        summary: '系统默认生图通道。默认 gpt-image-2.5-flare（2026-09-08 发布），可填任意 OpenAI 兼容网关；Key/地址留空则复用文本大模型那套。',
        test: 'openai_image',
        docs: 'https://developers.openai.com/api/docs/guides/image-generation',
        fields: [
          KEY('OPENAI_IMAGE_API_KEY', 'API Key', {
            required: false, placeholder: 'sk-...',
            hint: '可留空：自动复用上面的 OPENAI_API_KEY（文本大模型那把）',
          }),
          KEY('OPENAI_IMAGE_BASE_URL', '接口地址', {
            kind: 'url', required: false, placeholder: 'https://api.openai.com/v1',
            hint: '可留空：自动复用上面文本大模型的接口地址',
            quickFill: [
              { label: 'OpenAI 官方', value: 'https://api.openai.com/v1' },
              { label: '国内代理示例', value: 'https://api.ofox.ai/v1' },
            ],
          }),
          KEY('OPENAI_IMAGE_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'gpt-image-2.5-flare',
            hint: '2026-09 最新：gpt-image-2.5-flare（快）/ gpt-image-2.5-sunburst（精修）；GPT Image 系列自动按 gpt-image 尺寸出图，dall-e-3 自动走 1792x1024',
            choices: [
              'gpt-image-2.5-flare',
              'gpt-image-2.5-sunburst',
              'gpt-image-2',
              'gpt-image-1.5',
              'gpt-image-1',
              'gpt-image-1-mini',
              'dall-e-3',
            ],
          }),
        ],
      },
      {
        id: 'comfyui',
        name: 'ComfyUI',
        where: 'local',
        providerKind: 'image',
        summary: '本机或自建的 ComfyUI。不花钱、可控性最强，导入的每个工作流还会各自变成一个独立生成源。',
        test: 'comfyui',
        docs: 'https://docs.comfy.org/',
        fields: [
          KEY('COMFYUI_SERVER_URL', '服务地址', {
            kind: 'url', placeholder: 'http://127.0.0.1:8188',
            quickFill: [{ label: '本机', value: 'http://127.0.0.1:8188' }],
          }),
          KEY('COMFYUI_CHECKPOINT', '首选底模', { kind: 'text', required: false, hint: '留空用工作流里自带的' }),
          KEY('COMFYUI_TIMEOUT_SECONDS', '超时（秒）', { kind: 'number', required: false, placeholder: '1200', hint: '本机跑大模型慢就调大，默认 1200' }),
          KEY('COMFYUI_WORKFLOWS_DIR', '工作流目录', {
            kind: 'path', required: false, pick: true,
            hint: '填了可直读本机 ComfyUI 的工作流，不用一个个上传',
          }),
          KEY('COMFYUI_DEFAULT_IMAGE_WORKFLOW', '默认生图工作流', { kind: 'text', required: false, hint: '不指定时用哪个工作流出图；可在下方工作流列表里点「设默认生图」' }),
        ],
      },
      {
        id: 'siliconflow',
        name: '硅基流动 SiliconFlow',
        where: 'cloud',
        providerKind: 'image',
        summary: '国内直连。默认 FLUX.1-schnell（约 ¥0.01/张），也可切 Qwen-Image 等。',
        test: 'siliconflow',
        docs: 'https://docs.siliconflow.cn/cn/api-reference/images/images-generations',
        fields: [
          KEY('SILICONFLOW_API_KEY', 'API Key'),
          KEY('SILICONFLOW_IMAGE_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'black-forest-labs/FLUX.1-schnell',
            choices: [
              'black-forest-labs/FLUX.1-schnell',
              'black-forest-labs/FLUX.1-dev',
              'black-forest-labs/FLUX.1-Kontext-dev',
              'Qwen/Qwen-Image',
              'Kwai-Kolors/Kolors',
            ],
          }),
        ],
      },
      {
        id: 'dashscope',
        name: '阿里通义万相',
        where: 'cloud',
        providerKind: 'image',
        summary: '阿里百炼 DashScope。这把 Key 同时也是视频侧「万相 Wan3.0」要用的。',
        test: 'dashscope',
        docs: 'https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference',
        fields: [
          KEY('DASHSCOPE_API_KEY', 'API Key'),
          KEY('DASHSCOPE_IMAGE_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'wan2.6-t2i',
            hint: '万相 2.5/2.6、千问图像走新版同步接口；wanx2.1 系列走旧接口（已不推荐）',
            choices: [
              'wan2.6-t2i',
              'qwen-image-2.0-pro',
              'qwen-image-max',
              'wan2.5-t2i-preview',
              'wanx2.1-t2i-turbo',
            ],
          }),
        ],
      },
    ],
  },

  // ───────────────────────────── 3. 生视频
  {
    id: 'video',
    name: '生视频',
    why: '把静态画面变成会动的镜头：拿生图的结果当首帧，加上运镜提示词让它动起来。',
    ifMissing: '成片只有静止画面，做不了"漫剧"只能做"漫画"。这一步可以先跳过。',
    routeKey: 'VIDEO_PROVIDER',
    channels: [
      {
        id: 'kling',
        name: '可灵 Kling',
        where: 'cloud',
        providerKind: 'video',
        summary: '快手可灵，默认 kling-v3（支持多镜头叙事 / 音画同出）。',
        test: 'kling',
        docs: 'https://klingai.com/document-api/guides/capability-map/video',
        warn: '可灵 1.x / 2.0 / 2.1 等旧模型已于 2026-09-15 下线，请使用 v3 / 3.0 Turbo / O1 系列。',
        fields: [
          KEY('KLING_API_KEY', 'API Key'),
          KEY('KLING_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api-beijing.klingai.com', required: false, hint: '新系统域名（原 api.klingai.com 已变更）' }),
          KEY('KLING_MODEL', '模型名', {
            kind: 'text', placeholder: 'kling-v3', required: false,
            choices: ['kling-v3', 'kling-3.0-turbo', 'kling-v3-omni', 'kling-video-o1', 'kling-v2-6', 'kling-v2-5-turbo'],
          }),
        ],
      },
      {
        id: 'minimax_h3',
        name: 'MiniMax H3',
        where: 'cloud',
        providerKind: 'video',
        summary: '与 MiniMax 文本/配音共用同一把 Key，768P~2K、4~15 秒，支持参考图/首尾帧。',
        test: 'minimax_h3',
        docs: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-query',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('MINIMAX_H3_MODEL', '模型名', { kind: 'text', placeholder: 'MiniMax-H3', required: false, choices: ['MiniMax-H3'] }),
          KEY('MINIMAX_H3_BASE_URL', '接口地址', {
            kind: 'url', required: false, placeholder: 'https://api.minimaxi.com',
            quickFill: [
              { label: '国内站', value: 'https://api.minimaxi.com' },
              { label: '海外站', value: 'https://api.minimax.io' },
            ],
            hint: '旧域名 api.minimax.chat 已弃用',
          }),
        ],
      },
      {
        id: 'seedance',
        name: 'Seedance（火山引擎）',
        where: 'cloud',
        providerKind: 'video',
        summary: '字节火山方舟 Ark 上的 doubao-seedance 系列，默认 2.0；2.5 支持 1080P / 更长叙事。',
        test: 'seedance',
        docs: 'https://www.volcengine.com/docs/82379/1520757',
        fields: [
          KEY('SEEDANCE_API_KEY', 'API Key'),
          KEY('SEEDANCE_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://ark.cn-beijing.volces.com/api/v3', required: false }),
          KEY('SEEDANCE_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'doubao-seedance-2-0-260128',
            hint: 'fast / mini 最高 720p；2.5（260628）支持 1080P 与 30 秒叙事',
            choices: [
              'doubao-seedance-2-5-260628',
              'doubao-seedance-2-0-260128',
              'doubao-seedance-2-0-fast-260128',
              'doubao-seedance-2-0-mini-260615',
            ],
          }),
        ],
      },
      {
        id: 'wan3',
        name: '万相 Wan3.0',
        where: 'cloud',
        providerKind: 'video',
        summary: '阿里百炼，复用生图那栏的 DASHSCOPE_API_KEY。',
        test: 'wan3',
        docs: 'https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference',
        fields: [
          KEY('DASHSCOPE_API_KEY', 'API Key', { hint: '与「阿里通义万相」生图是同一把' }),
          KEY('WAN3_MODEL', '模型名', { kind: 'text', required: false, choices: ['wan3.0-video', 'wan3.0-video-prime'] }),
          KEY('WAN3_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://dashscope.aliyuncs.com', required: false }),
        ],
      },
      {
        id: 'comfyui_video',
        name: 'ComfyUI 视频',
        where: 'local',
        providerKind: 'video',
        summary: '本机 ComfyUI 跑 SVD / AnimateDiff 一类的视频工作流。',
        warn: '这是系统的出厂默认值，但它有 Mock 兜底：没绑视频工作流、或工作流执行失败时，会把首帧循环成一段 5 秒"视频"当成片返回（没有 ffmpeg 时甚至直接把图片复制成 .mp4）。想要真视频，请绑好工作流，或把默认通道换成上面任一云端源。',
        fields: [
          KEY('COMFYUI_DEFAULT_VIDEO_WORKFLOW', '默认视频工作流 ID', { kind: 'text', required: false, hint: '不绑就会走 Mock 兜底' }),
        ],
      },
      {
        id: 'minimax_video',
        name: 'MiniMax 视频（旧版）',
        where: 'cloud',
        providerKind: 'video',
        legacy: true,
        summary: '旧版 v1 视频通道（video-01 / Hailuo 世代），仅为兼容老配置保留。',
        warn: '旧版通道：可灵回退未实现，模型名与新站不一致。新项目请改用「MiniMax H3」或上面其它云端源。',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('VIDEO_MODEL', '模型名', { kind: 'text', required: false, choices: ['MiniMax-Hailuo-02', 'video-01'] }),
        ],
      },
    ],
  },

  // ───────────────────────────── 4. 配音
  {
    id: 'audio',
    name: '配音',
    why: '把镜头里的台词和旁白读出来，按角色绑定的音色、带情绪标签合成语音。',
    ifMissing: '成片没有人声，只有画面和字幕。这一步可以先跳过。',
    routeKey: 'TTS_PROVIDER',
    channels: [
      {
        id: 'minimax',
        name: 'MiniMax Speech',
        where: 'cloud',
        providerKind: 'audio',
        summary: '超拟人配音，支持怒吼/低语/哭腔等情绪。与文本大模型共用一把 Key。',
        test: 'minimax',
        docs: 'https://platform.minimax.io/docs/api-reference/speech-t2a-http',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('MINIMAX_GROUP_ID', 'Group ID', { kind: 'text', required: false, hint: '旧版接口需要；当前 T2A 接口可不填' }),
          KEY('TTS_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'speech-2.8-turbo',
            choices: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'],
          }),
        ],
      },
      {
        id: 'elevenlabs',
        name: 'ElevenLabs',
        where: 'cloud',
        providerKind: 'audio',
        summary: '多语种音色库最全的一档，v3 支持 70+ 语言与音频标签。',
        test: 'elevenlabs',
        docs: 'https://elevenlabs.io/docs/models',
        fields: [
          KEY('ELEVENLABS_API_KEY', 'API Key'),
          KEY('ELEVENLABS_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'eleven_multilingual_v2',
            choices: ['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5'],
          }),
        ],
      },
      {
        id: 'cosyvoice',
        name: 'CosyVoice',
        where: 'local',
        providerKind: 'audio',
        summary: '本机部署，不花钱不出网。先把服务跑起来再填地址。',
        test: 'cosyvoice',
        fields: [
          KEY('COSYVOICE_URL', '服务地址', {
            kind: 'url', placeholder: 'http://127.0.0.1:9233',
            quickFill: [{ label: '本机', value: 'http://127.0.0.1:9233' }],
          }),
        ],
      },
      {
        id: 'gpt_sovits',
        name: 'GPT-SoVITS',
        where: 'local',
        providerKind: 'audio',
        summary: '本机部署，适合做音色克隆。',
        test: 'gpt_sovits',
        fields: [
          KEY('GPTSOVITS_URL', '服务地址', {
            kind: 'url', placeholder: 'http://127.0.0.1:9880',
            quickFill: [{ label: '本机', value: 'http://127.0.0.1:9880' }],
          }),
        ],
      },
      {
        id: 'indextts',
        name: 'IndexTTS',
        where: 'local',
        summary: '本机 IndexTTS-2.5。零样本克隆——音色不是从列表里挑，而是由你给的一段参考音频决定。',
        test: 'indextts',
        fields: [
          KEY('INDEXTTS_URL', '服务地址', {
            kind: 'url', placeholder: 'http://127.0.0.1:7860',
            quickFill: [{ label: '本机', value: 'http://127.0.0.1:7860' }],
          }),
          KEY('INDEXTTS_REF_AUDIO', '默认参考音频', {
            kind: 'path', required: false, pick: true,
            placeholder: '/Users/you/project/tts/refs/ref.wav',
            hint: '一段 wav，决定默认音色；也可以给单个角色绑别的 wav 路径当它的音色',
          }),
          KEY('INDEXTTS_LANG', '默认语言', { kind: 'text', required: false, placeholder: 'ZH', hint: 'ZH / EN / JA / KO' }),
        ],
      },
    ],
  },

  // ───────────────────────────── 5. 导出
  {
    id: 'export',
    name: '导出到剪映',
    why: '把攒好的画面、视频、配音按时间轴拼成剪映 / CapCut 能直接打开的草稿工程，最后一公里在剪映里精修。',
    ifMissing: '仍然可以导出草稿文件，只是不会自动出现在剪映的草稿列表里，得手动拷。',
    channels: [
      {
        id: 'jianyin',
        name: '剪映 / CapCut',
        where: 'local',
        summary: '填了草稿目录后，导出的工程会自动拷进去，打开剪映就能看到。',
        test: 'jianyin',
        fields: [
          KEY('JIANYIN_DRAFT_PATH', '剪映草稿目录', {
            kind: 'path', required: false, pick: true,
            placeholder: 'C:/Users/xxx/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft',
            hint: 'Windows 会自动探测；macOS 需要手动填，留空则只导到 exports/ 目录',
          }),
        ],
      },
    ],
  },
];

/** 某个通道是否算"已填"（所有 required 字段非空） */
export function channelFilled(ch: Channel, cfg: Record<string, string>): boolean {
  return ch.fields.filter((f) => f.required !== false).every((f) => !!(cfg[f.key] || '').trim());
}

/** 能力当前选中的通道 id（读默认路由键；没有路由键的能力取第一个通道） */
export function currentChannelId(cap: Capability, cfg: Record<string, string>): string {
  if (!cap.routeKey) return cap.channels[0]?.id || '';
  const v = (cfg[cap.routeKey] || '').trim();
  if (v && cap.channels.some((c) => c.id === v)) return v;
  return cap.channels[0]?.id || '';
}

/** 整页涉及的全部键（用于只提交改过的那些） */
export const ALL_CATALOG_KEYS: string[] = Array.from(
  new Set(
    CAPABILITIES.flatMap((c) => [
      ...(c.routeKey ? [c.routeKey] : []),
      ...c.channels.flatMap((ch) => [
        ...ch.fields.map((f) => f.key),
        ...Object.keys(ch.extraOnSelect || {}),
      ]),
    ]),
  ),
);
