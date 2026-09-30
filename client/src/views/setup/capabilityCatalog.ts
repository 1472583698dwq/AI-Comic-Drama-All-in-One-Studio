/**
 * 能力目录 —— 新设置中心的唯一事实源。
 *
 * 旧设置中心按「厂商 / 键值分组」摆放，同一件事（比如"我要出视频"）的配置
 * 散落在默认路由、基础设施、生成源三个页签里。这里改成按**能力**组织：
 *
 *   能力（我要做什么） → 通道（谁来做） → 字段（要填什么） → 测试（通没通）
 *
 * 新增一家厂商 = 往对应能力的 channels 里加一条，UI 不用动。
 */

export type FieldKind = 'text' | 'secret' | 'url' | 'number' | 'path';

/** apiService.testConfig 支持的目标（与后端 /config/test 对齐） */
export type TestTarget =
  | 'openai' | 'responses_api' | 'minimax' | 'minimax_h3' | 'seedance'
  | 'kling' | 'wan3' | 'comfyui' | 'siliconflow' | 'dashscope'
  | 'openai_image' | 'openai_video'
  | 'elevenlabs' | 'cosyvoice' | 'gpt_sovits' | 'indextts' | 'jianyin' | 'openlist';

export interface CapField {
  key: string;
  label: string;
  kind?: FieldKind;
  placeholder?: string;
  /** 为空时该通道视为「未配置」 */
  required?: boolean;
  hint?: string;
  /** 回退链：这些键任一有值也算「已填」（用于有兼容回退的字段，如生图 Key 可回退文本 Key） */
  altKeys?: string[];
  /** 走后端原生目录选择器（/system/browse-folder），并给出"打开目录"入口 */
  pick?: boolean;
  /** 一键填入的常用值 */
  quickFill?: Array<{ label: string; value: string }>;
  /** 官方可选值：模型名这类输入框带 datalist 候选（仍可自由手填，不被枚举锁死） */
  options?: string[];
  /** 进阶选填：默认收进「选填 / 高级」折叠区，主界面只留 Key / 地址 / 模型 */
  advanced?: boolean;
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
  /** 官方文档：核对模型名 / 接口口径，新窗口打开 */
  docUrl?: string;
  /** 旧版通道：有值即打「旧版」标记并展开说明（不代表不可用，是"官方当前在用哪档"的辨识） */
  legacy?: string;
  /** 由「自定义生成源」动态并入的通道（不在本文件的静态表里） */
  custom?: boolean;
  /** custom 通道对应的生成源 id（prov_xxx），用于单测与就地填 Key */
  providerId?: string;
  /** custom 通道：后端登记了独立 Key 位（CUSTOM_PROVIDER_<id>）；false 通常是 Key 写在代码里 */
  hasKey?: boolean;
  /** custom 通道：该生成源已被停用（选为默认通道也会在生成时被守卫拦下） */
  disabled?: boolean;
}

export interface Capability {
  id: string;
  /** 一级页签分组：core = 核心能力（生成链路）/ output = 输出与存储 */
  group: 'core' | 'output';
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

/** 能力配置的一级页签（取代旧的单页「能力配置」长滚动） */
export const CAP_GROUPS: Array<{ key: 'core' | 'output'; label: string; sub: string }> = [
  { key: 'core', label: '核心能力', sub: '文本 · 生图 · 生视频 · 配音' },
  { key: 'output', label: '输出与存储', sub: '剪映导出 · 云端同步' },
];

const KEY = (key: string, label: string, extra: Partial<CapField> = {}): CapField => ({
  key, label, kind: 'secret', required: true, ...extra,
});

export const CAPABILITIES: Capability[] = [
  // ───────────────────────────── 1. 文本大模型
  {
    id: 'llm',
    group: 'core',
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
        docUrl: 'https://api-docs.deepseek.com/zh-cn/',
        extraOnSelect: { LLM_API_TYPE: 'chat_completions' },
        fields: [
          KEY('OPENAI_API_KEY', 'API Key', { placeholder: 'sk-...' }),
          KEY('OPENAI_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api.deepseek.com/v1', hint: '留空则用默认的 DeepSeek' , required: false }),
          KEY('OPENAI_MODEL', '模型名', {
            kind: 'text', placeholder: 'deepseek-v4-flash', required: false,
            options: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
            hint: '点输入框可下拉选常见档；中转站的模型名以对方文档为准，可直接手填',
          }),
          KEY('OPENAI_CUSTOM_HEADERS', '自定义请求头', { kind: 'text', required: false, placeholder: '{"X-Foo":"bar"}', hint: 'JSON 格式，接私有网关时才需要', advanced: true }),
        ],
      },
      {
        id: 'responses_api',
        name: 'OpenAI Responses API',
        where: 'cloud',
        summary: 'OpenAI 的新式 /v1/responses 接口，走这条时会自动降级兼容。',
        test: 'responses_api',
        docUrl: 'https://platform.openai.com/docs/api-reference/responses',
        extraOnSelect: { LLM_API_TYPE: 'responses_api' },
        fields: [
          KEY('RESPONSES_API_KEY', 'API Key', { placeholder: 'sk-...' }),
          KEY('RESPONSES_API_URL', '接口地址', { kind: 'url', placeholder: 'https://api.openai.com/v1/responses', required: false }),
          KEY('RESPONSES_MODEL', '模型名', {
            kind: 'text', placeholder: 'gpt-5.2', required: false,
            options: ['gpt-5.2', 'gpt-5', 'gpt-4o'],
          }),
        ],
      },
      {
        id: 'minimax',
        name: 'MiniMax 文本',
        where: 'cloud',
        summary: '一把 Key 同时供文本、配音、视频三种能力用。',
        test: 'minimax',
        docUrl: 'https://platform.minimaxi.com/document',
        extraOnSelect: { LLM_API_TYPE: 'chat_completions' },
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key'),
          KEY('MINIMAX_GROUP_ID', 'Group ID', { kind: 'text' }),
          KEY('MINIMAX_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api.minimax.chat/v1', required: false }),
          KEY('LLM_MODEL', '模型名', {
            kind: 'text', placeholder: 'MiniMax-M2.5', required: false,
            options: ['MiniMax-M2.5', 'abab6.5s-chat'],
            hint: 'abab 系列是旧版文本模型，官方现行档为 MiniMax-M2.5',
          }),
        ],
      },
    ],
  },

  // ───────────────────────────── 2. 生图
  {
    id: 'image',
    group: 'core',
    name: '生图',
    why: '给每个镜头画出画面，也用来生成角色的定妆三视图——后面所有镜头靠它保证"这人长这样"。',
    ifMissing: '分镜有文字没画面，视频那一步也没法开始（图生视频要拿图当首帧）。',
    essential: true,
    routeKey: 'IMAGE_PROVIDER',
    channels: [
      {
        id: 'comfyui',
        name: 'ComfyUI',
        where: 'local',
        summary: '本机或自建的 ComfyUI。不花钱、可控性最强，导入的每个工作流还会各自变成一个独立生成源。',
        test: 'comfyui',
        docUrl: 'https://docs.comfy.org/',
        fields: [
          KEY('COMFYUI_SERVER_URL', '服务地址', {
            kind: 'url', placeholder: 'http://127.0.0.1:8188',
            quickFill: [{ label: '本机', value: 'http://127.0.0.1:8188' }],
          }),
          KEY('COMFYUI_CHECKPOINT', '首选底模', { kind: 'text', required: false, hint: '留空用工作流里自带的' }),
          KEY('COMFYUI_TIMEOUT_SECONDS', '超时（秒）', { kind: 'number', required: false, placeholder: '240', hint: '本机跑大模型慢就调大', advanced: true }),
          KEY('COMFYUI_WORKFLOWS_DIR', '工作流目录', {
            kind: 'path', required: false, pick: true,
            hint: '填了可直读本机 ComfyUI 的工作流，不用一个个上传', advanced: true,
          }),
          KEY('COMFYUI_DEFAULT_IMAGE_WORKFLOW', '默认生图工作流', { kind: 'text', required: false, hint: '不指定时用哪个工作流出图；可在下方工作流列表里点「设默认生图」', advanced: true }),
        ],
      },
      {
        id: 'siliconflow',
        name: '硅基流动 SiliconFlow',
        where: 'cloud',
        summary: '国内直连，默认 FLUX.1-schnell，出图快。',
        test: 'siliconflow',
        docUrl: 'https://docs.siliconflow.cn/',
        fields: [
          KEY('SILICONFLOW_API_KEY', 'API Key'),
          KEY('SILICONFLOW_IMAGE_MODEL', '模型名', {
            kind: 'text', placeholder: 'black-forest-labs/FLUX.1-schnell', required: false,
            options: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev'],
          }),
        ],
      },
      {
        id: 'dashscope',
        name: '阿里通义万相',
        where: 'cloud',
        summary: '阿里百炼 DashScope。这把 Key 同时也是视频侧「万相 Wan3.0」要用的。',
        test: 'dashscope',
        docUrl: 'https://help.aliyun.com/zh/model-studio/',
        fields: [
          KEY('DASHSCOPE_API_KEY', 'API Key'),
          KEY('DASHSCOPE_IMAGE_MODEL', '模型名', {
            kind: 'text', placeholder: 'wan2.6-t2i', required: false,
            options: ['wan2.6-t2i', 'wanx2.1-t2i-turbo'],
            hint: '万相 2.5 及以后走新版同步接口，老版模型名（wanx…）仍兼容',
          }),
        ],
      },
      {
        id: 'openai_compat',
        name: '自定义（OpenAI 兼容）',
        where: 'cloud',
        summary: '接任何实现 OpenAI /v1/images/generations 协议的服务——官方 DALL·E、gpt-image、国内中转站、自建代理都走这条。Key / 地址 / 模型三项都自己填，不跟别人共用。',
        test: 'openai_image',
        docUrl: 'https://platform.openai.com/docs/api-reference/images',
        fields: [
          KEY('OPENAI_IMAGE_API_KEY', 'API Key', {
            placeholder: 'sk-...', altKeys: ['OPENAI_API_KEY'],
            hint: '生图专用 Key（独立计费 / 独立代理）；留空才会回退复用「文本大模型」那把，属于旧配置兼容',
          }),
          KEY('OPENAI_IMAGE_BASE_URL', '接口地址', {
            kind: 'url', required: false, placeholder: 'https://api.openai.com/v1',
            hint: '填到 /v1 为止；留空则沿用文本大模型的地址',
          }),
          KEY('OPENAI_IMAGE_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'gpt-image-2.5-flare',
            options: ['gpt-image-2.5-flare', 'gpt-image-1', 'dall-e-3', 'flux-schnell'],
            hint: '中转站的模型名以对方文档为准；gpt-image 系列返回 b64、不接受 response_format，本通道已兼容',
          }),
        ],
      },
    ],
  },

  // ───────────────────────────── 3. 生视频
  {
    id: 'video',
    group: 'core',
    name: '生视频',
    why: '把静态画面变成会动的镜头：拿生图的结果当首帧，加上运镜提示词让它动起来。',
    ifMissing: '成片只有静止画面，做不了"漫剧"只能做"漫画"。这一步可以先跳过。',
    routeKey: 'VIDEO_PROVIDER',
    channels: [
      {
        id: 'kling',
        name: '可灵 Kling',
        where: 'cloud',
        summary: '快手可灵，默认 kling-v3。',
        test: 'kling',
        docUrl: 'https://app.klingai.com/cn/dev/document-api',
        fields: [
          KEY('KLING_API_KEY', 'API Key'),
          KEY('KLING_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api-beijing.klingai.com', required: false }),
          KEY('KLING_MODEL', '模型名', {
            kind: 'text', placeholder: 'kling-v3', required: false,
            options: ['kling-v3'],
            hint: '下拉只是本版默认档，其它版本按官方文档手填',
          }),
        ],
      },
      {
        id: 'minimax_h3',
        name: 'MiniMax H3',
        where: 'cloud',
        summary: '与 MiniMax 文本/配音共用同一把 Key，768P~2K、4~15 秒。',
        test: 'minimax_h3',
        docUrl: 'https://platform.minimaxi.com/document',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('MINIMAX_H3_MODEL', '模型名', {
            kind: 'text', placeholder: 'MiniMax-H3', required: false,
            options: ['MiniMax-H3'],
          }),
          KEY('MINIMAX_H3_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api.minimaxi.com', required: false }),
        ],
      },
      {
        id: 'seedance',
        name: 'Seedance（火山引擎）',
        where: 'cloud',
        summary: '字节火山方舟 Ark 上的 doubao-seedance 系列。',
        test: 'seedance',
        docUrl: 'https://www.volcengine.com/docs/82379',
        fields: [
          KEY('SEEDANCE_API_KEY', 'API Key'),
          KEY('SEEDANCE_BASE_URL', '接口地址', {
            kind: 'url', placeholder: 'https://ark.cn-beijing.volces.com', required: false,
            hint: '带不带 /api/v3 都行，后端会补齐',
          }),
          KEY('SEEDANCE_MODEL', '模型名 / 接入点 id', {
            kind: 'text', required: false, placeholder: 'doubao-seedance-2-0-260128',
            options: [
              'doubao-seedance-2-5-260628',
              'doubao-seedance-2-0-260128',
              'doubao-seedance-2-0-fast-260128',
              'doubao-seedance-2-0-mini-260615',
            ],
            hint: 'fast / mini 最高 720p；2.5（260628）支持 1080P 与 30 秒叙事；也可以填推理接入点 id（ep-xxxxxxxxxxxxxx-xxxxx）',
          }),
        ],
      },
      {
        id: 'wan3',
        name: '万相 Wan3.0',
        where: 'cloud',
        summary: '阿里万相。注意它通常是账号专属 MaaS 实例，和通用 DashScope 不是一套 —— Key 和地址都要单独填。',
        test: 'wan3',
        docUrl: 'https://help.aliyun.com/zh/model-studio/',
        fields: [
          KEY('WAN_API_KEY', 'API Key', { hint: '留空会回退用生图那栏的 DASHSCOPE_API_KEY，但专属实例通常不通用' }),
          KEY('WAN3_BASE_URL', '接口地址', {
            kind: 'url', required: false,
            placeholder: 'https://ws-xxxxxxxx.us-east-1.maas.aliyuncs.com',
            hint: '专属实例地址，在百炼控制台看；填错会一直提交失败',
          }),
          KEY('WAN3_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'wan3.0-video',
            options: ['wan3.0-video', 'wan3.0-video-prime'],
          }),
        ],
      },
      {
        id: 'openai_video',
        name: '自定义（OpenAI 兼容视频）',
        where: 'cloud',
        summary: '按 OpenAI 官方的 /v1/videos 协议（Sora 系）对接任何中转站或自建网关。Key 单独一把，不和文本、生图共用。',
        test: 'openai_video',
        docUrl: 'https://platform.openai.com/docs/api-reference',
        fields: [
          KEY('OPENAI_VIDEO_API_KEY', 'API Key', {
            placeholder: 'sk-...',
            hint: '生视频专用 Key，与文本大模型 / 生图完全独立；不填就只走别的通道',
          }),
          KEY('OPENAI_VIDEO_BASE_URL', '接口地址', {
            kind: 'url', required: false, placeholder: 'https://api.openai.com/v1',
            hint: '填到 /v1 为止；可指向任何实现了该协议的中转站',
          }),
          KEY('OPENAI_VIDEO_MODEL', '模型名', {
            kind: 'text', required: false, placeholder: 'sora-2',
            options: ['sora-2', 'sora-2-pro'],
            hint: '下拉只是常见档；中转站自定的模型名直接手填',
          }),
        ],
      },
      {
        id: 'minimax_video',
        name: 'MiniMax Video（通用）',
        where: 'cloud',
        summary: 'MiniMax 的通用云端视频通道。',
        docUrl: 'https://platform.minimaxi.com/document',
        legacy: '旧版通用视频通道：官方现行档是 MiniMax-Hailuo-02 / H3，Key 与「MiniMax H3」那条完全相同。除非对接旧账号，优先用 H3。',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('VIDEO_MODEL', '模型名', {
            kind: 'text', placeholder: 'MiniMax-Hailuo-02', required: false,
            options: ['MiniMax-Hailuo-02', 'video-01'],
            hint: 'video-01 是旧档，本版默认已改为 MiniMax-Hailuo-02',
          }),
        ],
      },
      {
        id: 'comfyui_video',
        name: 'ComfyUI 视频',
        where: 'local',
        summary: '本机 ComfyUI 跑 SVD / AnimateDiff 一类的视频工作流。',
        docUrl: 'https://docs.comfy.org/',
        legacy: '出厂占位通道：不绑工作流时会走 Mock 兜底（详见下方风险提示），接了云端源后建议把默认通道换掉。',
        warn: '这是系统的出厂默认值，但它有 Mock 兜底：没绑视频工作流、或工作流执行失败时，会把首帧循环成一段 5 秒"视频"当成片返回（没有 ffmpeg 时甚至直接把图片复制成 .mp4）。想要真视频，请绑好工作流，或把默认通道换成上面任一云端源。',
        fields: [
          KEY('COMFYUI_DEFAULT_VIDEO_WORKFLOW', '默认视频工作流 ID', { kind: 'text', required: false, hint: '不绑就会走 Mock 兜底' }),
        ],
      },
    ],
  },

  // ───────────────────────────── 4. 配音
  {
    id: 'audio',
    group: 'core',
    name: '配音',
    why: '把镜头里的台词和旁白读出来，按角色绑定的音色、带情绪标签合成语音。',
    ifMissing: '成片没有人声，只有画面和字幕。这一步可以先跳过。',
    routeKey: 'TTS_PROVIDER',
    channels: [
      {
        id: 'minimax',
        name: 'MiniMax 语音',
        where: 'cloud',
        summary: '超拟人配音，支持怒吼/低语/哭腔等情绪。与文本大模型共用一把 Key。',
        test: 'minimax',
        docUrl: 'https://platform.minimaxi.com/document',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('MINIMAX_GROUP_ID', 'Group ID', { kind: 'text' }),
          KEY('TTS_MODEL', '模型名', {
            kind: 'text', placeholder: 'speech-2.8-turbo', required: false,
            options: ['speech-2.8-turbo', 'speech-01-turbo'],
            hint: 'speech-01 系列是旧档，本版默认已改为 speech-2.8-turbo',
          }),
        ],
      },
      {
        id: 'elevenlabs',
        name: 'ElevenLabs',
        where: 'cloud',
        summary: '多语种音色库最全的一档。',
        test: 'elevenlabs',
        docUrl: 'https://elevenlabs.io/docs/api-reference',
        fields: [
          KEY('ELEVENLABS_API_KEY', 'API Key'),
          KEY('ELEVENLABS_MODEL', '模型名', {
            kind: 'text', placeholder: 'eleven_multilingual_v2', required: false,
            options: ['eleven_multilingual_v2'],
          }),
        ],
      },
      {
        id: 'cosyvoice',
        name: 'CosyVoice',
        where: 'local',
        summary: '本机部署，不花钱不出网。先把服务跑起来再填地址。',
        test: 'cosyvoice',
        docUrl: 'https://github.com/FunAudioLLM/CosyVoice',
        fields: [KEY('COSYVOICE_URL', '服务地址', { kind: 'url', placeholder: 'http://127.0.0.1:9233' })],
      },
      {
        id: 'gpt_sovits',
        name: 'GPT-SoVITS',
        where: 'local',
        summary: '本机部署，适合做音色克隆。',
        test: 'gpt_sovits',
        docUrl: 'https://github.com/RVC-Boss/GPT-SoVITS',
        fields: [KEY('GPTSOVITS_URL', '服务地址', { kind: 'url', placeholder: 'http://127.0.0.1:9880' })],
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
          KEY('INDEXTTS_LANG', '默认语言', { kind: 'text', required: false, placeholder: 'ZH', hint: 'ZH / EN / JA / KO', advanced: true }),
        ],
      },
    ],
  },

  // ───────────────────────────── 5. 导出
  {
    id: 'export',
    group: 'output',
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
        docUrl: 'https://www.capcut.cn/',
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

  // ───────────────────────────── 6. 云端同步
  {
    id: 'storage',
    group: 'output',
    name: '素材与工程云端同步',
    why: '把本机 storage 里的素材、工程异步同步到你自己的 OpenList。换一台电脑打开，项目列表和素材都还在——素材是页面真要看它时才回拉，不会一上来就下一堆。',
    ifMissing: '所有东西只存在这台机器上，换台电脑就是空的。',
    channels: [
      {
        id: 'openlist',
        name: 'OpenList',
        where: 'cloud',
        summary: '自建的 OpenList（AList 系）。只同步素材与工程，API Key 那些配置永远留在本机。',
        test: 'openlist',
        docUrl: 'https://doc.oplist.org/',
        warn: '底层若是 HalalCloud / IPFS 这类内容寻址存储，文件是明文存的；敏感内容别往里放。',
        fields: [
          KEY('OPENLIST_SYNC_ENABLED', '开启同步', {
            kind: 'text', required: false, placeholder: '0',
            hint: '填 1 开启、0 关闭。改完要重启服务才生效',
            quickFill: [{ label: '开', value: '1' }, { label: '关', value: '0' }],
          }),
          KEY('OPENLIST_BASE_URL', '服务地址', {
            kind: 'url', placeholder: 'http://127.0.0.1:5244',
            hint: '同机跑就填本地端口，最快；填公网域名也行',
          }),
          KEY('OPENLIST_USERNAME', '用户名', { kind: 'text' }),
          KEY('OPENLIST_PASSWORD', '密码'),
          KEY('OPENLIST_ROOT', '远端根目录', {
            kind: 'text', required: false, placeholder: '/comic-studio',
            hint: '必须落在 OpenList 已挂载的存储路径下，否则写不进去。点测试会当场验它可不可写', advanced: true,
          }),
        ],
      },
    ],
  },
];

/** 某个字段是否算"已填"：本键有值，或任一回退键（altKeys）有值 */
function fieldFilled(f: CapField, cfg: Record<string, string>): boolean {
  if (!!(cfg[f.key] || '').trim()) return true;
  return (f.altKeys || []).some((k) => !!(cfg[k] || '').trim());
}

/** 某个通道是否算"已填"（所有 required 字段非空） */
export function channelFilled(ch: Channel, cfg: Record<string, string>): boolean {
  return ch.fields.filter((f) => f.required !== false).every((f) => fieldFilled(f, cfg));
}

// ───────────────────────────── 自定义生成源并入通道表 ─────────────────────────────
//
// 静态表只写内置厂商；用户自己接的代码源（AutoDL / RunningHub / 中转站…）在
// /providers 里，按 kind 折成通道并进对应能力卡——否则会出现"实际在用自定义源，
// 页面却高亮第一个内置通道（并显示未配置）"的误导，保存时还会把默认通道顶掉。

/** 自定义生成源的 kind → 能力 id（llm 无独立注册表，不并入） */
const KIND_TO_CAPABILITY: Record<string, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

/** 该自定义生成源属于哪个能力；不归属时返回空串 */
export function capabilityIdForKind(kind: string): string {
  return KIND_TO_CAPABILITY[String(kind || '').toLowerCase()] || '';
}

/** 把一条自定义生成源（GET /providers 的条目）折算成通道 */
export function customChannelFrom(p: {
  id: string; name?: string; display_name?: string; description?: string;
  auth?: { has_key?: boolean } | null; enabled?: boolean;
}): Channel {
  return {
    id: p.id,
    name: p.display_name || p.name || p.id,
    where: 'cloud',
    summary: p.description || '你自己接入的自定义生成源（代码协程 / HTTP 模板）。',
    // 参数与代码在「扩展」页编辑；这里只做"选为默认通道 + 填 Key + 单测"三件事
    fields: [],
    custom: true,
    providerId: p.id,
    hasKey: !!p.auth?.has_key,
    disabled: p.enabled === false,
  };
}

/** 能力当前完整的通道表 = 静态内置表 + 动态并入的自定义源 */
export function channelsOf(cap: Capability, customs: Channel[] = []): Channel[] {
  return [...cap.channels, ...customs.filter((c) => c.custom)];
}

/** 能力当前选中的通道 id（读默认路由键；没有路由键的能力取第一个通道） */
export function currentChannelId(cap: Capability, cfg: Record<string, string>, customs: Channel[] = []): string {
  const list = channelsOf(cap, customs);
  if (!cap.routeKey) return list[0]?.id || '';
  const v = (cfg[cap.routeKey] || '').trim();
  if (v && list.some((c) => c.id === v)) return v;
  return list[0]?.id || '';
}

/**
 * 默认路由键指向的通道不在可选表里时返回那个 id（源被删/停用），否则空串。
 * 用于把"当前默认通道已失效"明说出来，而不是静默显示第一个通道。
 */
export function unmatchedRoute(cap: Capability, cfg: Record<string, string>, customs: Channel[] = []): string {
  if (!cap.routeKey) return '';
  const v = (cfg[cap.routeKey] || '').trim();
  if (!v) return '';
  return channelsOf(cap, customs).some((c) => c.id === v) ? '' : v;
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
