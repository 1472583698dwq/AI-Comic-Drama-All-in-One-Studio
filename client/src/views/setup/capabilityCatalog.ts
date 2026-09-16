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
  | 'elevenlabs' | 'cosyvoice' | 'gpt_sovits' | 'jianyin';

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
  /** 一键填入的常用值 */
  quickFill?: Array<{ label: string; value: string }>;
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
          KEY('OPENAI_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api.deepseek.com/v1', hint: '留空则用默认的 DeepSeek' , required: false }),
          KEY('OPENAI_MODEL', '模型名', { kind: 'text', placeholder: 'deepseek-chat', required: false }),
          KEY('OPENAI_CUSTOM_HEADERS', '自定义请求头', { kind: 'text', required: false, placeholder: '{"X-Foo":"bar"}', hint: 'JSON 格式，接私有网关时才需要' }),
        ],
      },
      {
        id: 'responses_api',
        name: 'OpenAI Responses API',
        where: 'cloud',
        summary: 'OpenAI 的新式 /v1/responses 接口，走这条时会自动降级兼容。',
        test: 'responses_api',
        extraOnSelect: { LLM_API_TYPE: 'responses_api' },
        fields: [
          KEY('RESPONSES_API_KEY', 'API Key', { placeholder: 'sk-...' }),
          KEY('RESPONSES_API_URL', '接口地址', { kind: 'url', placeholder: 'https://api.openai.com/v1/responses', required: false }),
          KEY('RESPONSES_MODEL', '模型名', { kind: 'text', placeholder: 'gpt-4o', required: false }),
        ],
      },
      {
        id: 'minimax',
        name: 'MiniMax abab',
        where: 'cloud',
        summary: '一把 Key 同时供文本、配音、视频三种能力用。',
        test: 'minimax',
        extraOnSelect: { LLM_API_TYPE: 'chat_completions' },
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key'),
          KEY('MINIMAX_GROUP_ID', 'Group ID', { kind: 'text' }),
          KEY('MINIMAX_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api.minimax.chat/v1', required: false }),
          KEY('LLM_MODEL', '模型名', { kind: 'text', placeholder: 'abab6.5s-chat', required: false }),
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
        id: 'comfyui',
        name: 'ComfyUI',
        where: 'local',
        summary: '本机或自建的 ComfyUI。不花钱、可控性最强，导入的每个工作流还会各自变成一个独立生成源。',
        test: 'comfyui',
        fields: [
          KEY('COMFYUI_SERVER_URL', '服务地址', {
            kind: 'url', placeholder: 'http://127.0.0.1:8188',
            quickFill: [{ label: '本机', value: 'http://127.0.0.1:8188' }],
          }),
          KEY('COMFYUI_CHECKPOINT', '首选底模', { kind: 'text', required: false, hint: '留空用工作流里自带的' }),
          KEY('COMFYUI_TIMEOUT_SECONDS', '超时（秒）', { kind: 'number', required: false, placeholder: '240', hint: '本机跑大模型慢就调大' }),
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
        summary: '国内直连，默认 FLUX.1-schnell，出图快。',
        test: 'siliconflow',
        fields: [
          KEY('SILICONFLOW_API_KEY', 'API Key'),
          KEY('SILICONFLOW_IMAGE_MODEL', '模型名', { kind: 'text', placeholder: 'black-forest-labs/FLUX.1-schnell', required: false }),
        ],
      },
      {
        id: 'dashscope',
        name: '阿里通义万相',
        where: 'cloud',
        summary: '阿里百炼 DashScope。这把 Key 同时也是视频侧「万相 Wan3.0」要用的。',
        test: 'dashscope',
        fields: [
          KEY('DASHSCOPE_API_KEY', 'API Key'),
          KEY('DASHSCOPE_IMAGE_MODEL', '模型名', { kind: 'text', placeholder: 'wanx2.1-t2i-turbo', required: false }),
        ],
      },
      {
        id: 'openai_compat',
        name: 'OpenAI 兼容生图',
        where: 'cloud',
        summary: '复用上面文本那把 OPENAI_API_KEY，默认打到 DALL·E 3；也可指向任何兼容的代理。',
        fields: [
          KEY('OPENAI_IMAGE_MODEL', '模型名', { kind: 'text', placeholder: 'dall-e-3', required: false }),
          KEY('OPENAI_IMAGE_BASE_URL', '接口地址', { kind: 'url', required: false, hint: '留空则复用文本大模型的地址' }),
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
        summary: '快手可灵，默认 kling-v3。',
        test: 'kling',
        fields: [
          KEY('KLING_API_KEY', 'API Key'),
          KEY('KLING_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api-beijing.klingai.com', required: false }),
          KEY('KLING_MODEL', '模型名', { kind: 'text', placeholder: 'kling-v3', required: false }),
        ],
      },
      {
        id: 'minimax_h3',
        name: 'MiniMax H3',
        where: 'cloud',
        summary: '与 MiniMax 文本/配音共用同一把 Key，768P~2K、4~15 秒。',
        test: 'minimax_h3',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('MINIMAX_H3_MODEL', '模型名', { kind: 'text', placeholder: 'MiniMax-H3', required: false }),
          KEY('MINIMAX_H3_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://api.minimax.chat', required: false }),
        ],
      },
      {
        id: 'seedance',
        name: 'Seedance（火山引擎）',
        where: 'cloud',
        summary: '字节火山方舟 Ark 上的 doubao-seedance 系列。',
        test: 'seedance',
        fields: [
          KEY('SEEDANCE_API_KEY', 'API Key'),
          KEY('SEEDANCE_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://ark.cn-beijing.volces.com/api/v3', required: false }),
          KEY('SEEDANCE_MODEL', '模型名', { kind: 'text', required: false }),
        ],
      },
      {
        id: 'wan3',
        name: '万相 Wan3.0',
        where: 'cloud',
        summary: '阿里百炼，复用生图那栏的 DASHSCOPE_API_KEY。',
        test: 'wan3',
        fields: [
          KEY('DASHSCOPE_API_KEY', 'API Key', { hint: '与「阿里通义万相」生图是同一把' }),
          KEY('WAN3_MODEL', '模型名', { kind: 'text', required: false }),
          KEY('WAN3_BASE_URL', '接口地址', { kind: 'url', placeholder: 'https://dashscope.aliyuncs.com', required: false }),
        ],
      },
      {
        id: 'minimax_video',
        name: 'MiniMax Video',
        where: 'cloud',
        summary: 'MiniMax 的通用云端视频通道。',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('VIDEO_MODEL', '模型名', { kind: 'text', placeholder: 'video-01', required: false }),
        ],
      },
      {
        id: 'comfyui_video',
        name: 'ComfyUI 视频',
        where: 'local',
        summary: '本机 ComfyUI 跑 SVD / AnimateDiff 一类的视频工作流。',
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
    name: '配音',
    why: '把镜头里的台词和旁白读出来，按角色绑定的音色、带情绪标签合成语音。',
    ifMissing: '成片没有人声，只有画面和字幕。这一步可以先跳过。',
    routeKey: 'TTS_PROVIDER',
    channels: [
      {
        id: 'minimax',
        name: 'MiniMax Speech-01',
        where: 'cloud',
        summary: '超拟人配音，支持怒吼/低语/哭腔等情绪。与文本大模型共用一把 Key。',
        test: 'minimax',
        fields: [
          KEY('MINIMAX_API_KEY', 'API Key', { hint: '与文本大模型那栏是同一把' }),
          KEY('MINIMAX_GROUP_ID', 'Group ID', { kind: 'text' }),
          KEY('TTS_MODEL', '模型名', { kind: 'text', placeholder: 'speech-01-turbo', required: false }),
        ],
      },
      {
        id: 'elevenlabs',
        name: 'ElevenLabs',
        where: 'cloud',
        summary: '多语种音色库最全的一档。',
        test: 'elevenlabs',
        fields: [
          KEY('ELEVENLABS_API_KEY', 'API Key'),
          KEY('ELEVENLABS_MODEL', '模型名', { kind: 'text', placeholder: 'eleven_multilingual_v2', required: false }),
        ],
      },
      {
        id: 'cosyvoice',
        name: 'CosyVoice',
        where: 'local',
        summary: '本机部署，不花钱不出网。先把服务跑起来再填地址。',
        test: 'cosyvoice',
        fields: [KEY('COSYVOICE_URL', '服务地址', { kind: 'url', placeholder: 'http://127.0.0.1:9233' })],
      },
      {
        id: 'gpt_sovits',
        name: 'GPT-SoVITS',
        where: 'local',
        summary: '本机部署，适合做音色克隆。',
        test: 'gpt_sovits',
        fields: [KEY('GPTSOVITS_URL', '服务地址', { kind: 'url', placeholder: 'http://127.0.0.1:9880' })],
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
