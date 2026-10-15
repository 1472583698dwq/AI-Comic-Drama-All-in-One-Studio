// -*- coding: utf-8 -*-
/**
 * 统一节点 Agent 执行器 — 节点内 AgentBar / 节点按钮 / 旧调用方 共用唯一路径
 * 所有生成一律走 MCP provider_<id> Tool（含视频 task_id 轮询），结果与 agent_state 回写节点
 */
import { apiService } from '../../../services/api';
import { pollVideoTask } from '../../../utils/videoTask';

export interface AgentState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  tool?: string;
  provider_id?: string;
  error?: string;
  elapsed_ms?: number;
  updated_at?: string;
}

export interface ExecuteAgentNodeOpts {
  node: any;
  override?: Record<string, any>;
  updateNodeData: (id: string, patch: Record<string, any>) => void;
  onStateChange?: (state: AgentState) => void;
}

// 节点内部键（存储/UI/结果），永远不作为生成参数出网
const INTERNAL_NODE_KEYS = new Set([
  'onUpdate', 'onExecute', 'definition', '_upstream', '_last_agent_plan', 'agent_state',
  'image_url', 'video_url', 'audio_url', 'result_url', 'url', 'width', 'height',
  'polished_prompt', 'idea', 'skill_id', 'provider', 'provider_id', 'provider_params', 'params',
  'skill', 'model', 'status', 'render_status', 'render_error', 'error', 'label', 'name',
]);

/**
 * REQ-toonflow-canvas H1：旧 nodeRegistry 删除后，原「节点结构句柄键」改为常量（旧画布节点顶层可能还存着这些槽位值；
 * kit useGeneration 直接生成时已用 stripStaleSlotKeys 去掉，这里只为其他调用方保持旧行为）。
 */
export const LEGACY_HANDLE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  image: ['prompt', 'reference', 'reference_images', 'camera_prompt'],
  video: ['prompt', 'first_frame', 'last_frame', 'reference_images', 'camera_prompt', 'ref_audio'],
  audio: ['text', 'ref_audio'],
});

/** 不需要提示词就能执行的节点类型（C5：执行前不做「提示词为空」拦截）。 */
export const PROMPT_OPTIONAL_TYPES: ReadonlySet<string> = new Set([
  'custom', 'ext-node', 'export', 'timeline', 'timeline-export', 'director3d', 'script-split', 'brief', 'shot-card', 'comfy-workflow',
]);

/** 自定义代码节点按 input_schema / params_schema 的 required 校验必填项，返回缺失项的显示名。 */
export function missingRequiredInputs(def: any, inputs: Record<string, any>, params: Record<string, any>): string[] {
  const missing: string[] = [];
  const empty = (v: any) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  for (const [schema, values] of [[def?.input_schema, inputs], [def?.params_schema, params]] as const) {
    const req = Array.isArray(schema?.required) ? (schema.required as unknown[]) : [];
    for (const k of req) {
      if (typeof k !== 'string' || !empty(values[k])) continue;
      const title = schema?.properties?.[k]?.title;
      missing.push(typeof title === 'string' && title ? `${title}（${k}）` : k);
    }
  }
  return missing;
}

// provider definition 缓存（同一源只拉一次，接口即映射）
const _defCache = new Map<string, any>();
async function getProviderDefinition(providerId: string): Promise<any> {
  if (_defCache.has(providerId)) return _defCache.get(providerId);
  try {
    const res: any = await apiService.getProvider(providerId);
    const def = res?.provider || res;
    _defCache.set(providerId, def);
    return def;
  } catch {
    return null;
  }
}

/**
 * 按该生成源接口声明（input_schema + params_schema 的属性键）从节点数据收集参数。
 * 键名不再硬编码：源声明什么，节点存什么、就传什么（normalized key 与 originalKey 均已写入节点数据）。
 */
function declaredInputKeys(def: any): string[] {
  const props = {
    ...((def?.input_schema?.properties) || {}),
    ...((def?.params_schema?.properties) || {}),
  };
  return Object.keys(props);
}

/**
 * 视频生成源的 `mode`（COORDINATION 15）：只取本次 override（kit 组装的 providerMode：t2v / i2v / r2v），
 * 节点 data.mode 是界面模式名（singleImage / startEnd / multiReference / text，或旧画布的 i2v / r2v / t2v），不从节点数据补。
 * 界面模式名按 COORDINATION 3 映射回生成源模式，无法识别的 override 值不放行。
 */
const VIDEO_PROVIDER_MODES: Readonly<Record<string, 't2v' | 'i2v' | 'r2v'>> = Object.freeze({
  t2v: 't2v', i2v: 'i2v', r2v: 'r2v',
  text: 't2v', singleImage: 'i2v', startEnd: 'i2v', multiReference: 'r2v',
});

export function videoProviderMode(v: unknown): 't2v' | 'i2v' | 'r2v' | undefined {
  return typeof v === 'string' ? VIDEO_PROVIDER_MODES[v.trim()] : undefined;
}

export interface BuildAgentArgsOptions {
  /** 节点类型：`video` 时放行 override.mode（REQ-toonflow-canvas B8） */
  nodeType?: string;
}

export function buildAgentArgs(
  d: any,
  prompt: string,
  extraKeys: string[] = [],
  override?: Record<string, any> | null,
  opts: BuildAgentArgsOptions = {},
): Record<string, any> {
  const args: Record<string, any> = {
    prompt,
    text: d.text || prompt,
    model: d.model,
    ...(d.params && typeof d.params === 'object' ? d.params : {}),
    ...(d.provider_params && typeof d.provider_params === 'object' ? d.provider_params : {}),
  };
  // REQ-toonflow-canvas H1：本次执行传入的参数优先于节点里保存的 params / provider_params
  // （原先保存的参数会盖掉本次 override，例如面板刚改的比例下发的还是旧值，N2）
  if (override && typeof override === 'object') {
    for (const src of [override.params, override.provider_params]) {
      if (src && typeof src === 'object') Object.assign(args, src);
    }
    // 只覆盖本来就会下发的键（已在 args 里的参数 / 生成源声明键 / 旧句柄键），不额外多发未声明的键
    const allowed = new Set<string>([...extraKeys, 'prompt', 'text']);
    for (const [k, v] of Object.entries(override)) {
      if (v === undefined || k === 'params' || k === 'provider_params' || INTERNAL_NODE_KEYS.has(k)) continue;
      if (k in args || allowed.has(k)) args[k] = v;
    }
  }
  // 声明键 + 已连线句柄键：从节点顶层数据取值
  for (const k of extraKeys) {
    if (INTERNAL_NODE_KEYS.has(k)) continue;
    if (d[k] !== undefined && args[k] === undefined) args[k] = d[k];
  }
  // REQ-toonflow-canvas B8：视频节点放行本次 mode（多参考 → r2v）。生成源 schema 多半不声明 mode，
  // 原先被上面的「只覆盖已声明键」规则丢掉，后端缺省按 i2v 要首帧，多参考必定失败
  if (opts.nodeType === 'video') {
    const mode = videoProviderMode(override?.mode);
    if (mode) args.mode = mode;
  }
  if (Array.isArray(args.reference_images)) {
    args.reference_images = args.reference_images.filter((u: any) => typeof u === 'string' && u.trim());
  }
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete args[k];
  }
  return args;
}

const _customDefCache = new Map<string, any>();
async function getCustomNodeDefinition(customNodeId: string): Promise<any> {
  if (_customDefCache.has(customNodeId)) return _customDefCache.get(customNodeId);
  try {
    const res: any = await apiService.getCustomNode(customNodeId);
    const def = res?.node || res;
    _customDefCache.set(customNodeId, def);
    return def;
  } catch {
    return null;
  }
}

export function patchFromPayload(nodeType: string, payload: any): Record<string, any> {
  const patch: Record<string, any> = {};
  if (!payload || typeof payload !== 'object') return patch;
  if (nodeType === 'custom' && typeof payload.text === 'string' && payload.text) patch.text = payload.text;
  if (payload.image_url || (payload.url && (nodeType === 'image' || nodeType === 'custom'))) {
    const u = payload.image_url || payload.url;
    patch.image_url = u;
    patch.result_url = u;
  }
  if (payload.video_url) patch.video_url = payload.video_url;
  if (payload.audio_url) patch.audio_url = payload.audio_url;
  if (payload.minimax_camera_prompt) patch.minimax_camera_prompt = payload.minimax_camera_prompt;
  if (typeof payload.prompt === 'string' && payload.prompt && payload.prompt !== '__RAW__') patch.prompt = payload.prompt;
  if (payload.width) patch.width = payload.width;
  if (payload.height) patch.height = payload.height;
  // REQ-toonflow-canvas H1：产物像素比单独存 result_aspect，不覆盖用户选的 aspect_ratio
  // （原先写成 "832:1216"，后端执行器随后又先读顶层 aspect_ratio，下次生成带非法比例，N2）
  if (payload.width && payload.height) patch.result_aspect = `${payload.width}:${payload.height}`;
  return patch;
}

/**
 * 核心入口：执行单个生成节点的 Agent 调度。
 * 抛错前已将 agent_state.failed 回写节点，调用方 catch 即可（勿再吞错）。
 */
export async function executeAgentNode(opts: ExecuteAgentNodeOpts): Promise<Record<string, any>> {
  const { node, override, updateNodeData, onStateChange } = opts;
  if (!node) throw new Error('节点不存在');
  const d: any = { ...(node.data || {}), ...(override || {}) };
  const prompt = (d.prompt ?? d.text ?? '').toString().trim();
  // REQ-toonflow-canvas C5：只有媒体生成节点必须有提示词；custom / ext-node / export / timeline / director3d 等
  // 本来就不靠提示词（custom 的必填项由其 input_schema.required 决定，见下方 custom 分支）
  if (!prompt && !PROMPT_OPTIONAL_TYPES.has(node.type || '')) throw new Error('提示词为空');
  const providerId: string = d.provider_id || d.provider || '';
  const toolName = providerId ? `provider_${providerId}` : '';

  const setState = (s: AgentState) => {
    updateNodeData(node.id, { agent_state: s });
    onStateChange?.(s);
  };

  // 自定义代码节点：按其 input_schema/params_schema 声明键收集，直调 /custom-nodes/run
  if (node.type === 'custom') {
    const cid: string = d.custom_node_id || '';
    if (!cid) {
      const st: AgentState = { status: 'failed', error: '未绑定自定义节点', updated_at: new Date().toISOString() };
      setState(st);
      throw new Error('请先在节点内选择自定义节点');
    }
    const start = Date.now();
    setState({ status: 'running', tool: `customnode_${cid}`, updated_at: new Date().toISOString() });
    try {
      const def = await getCustomNodeDefinition(cid);
      const inKeys = Object.keys(def?.input_schema?.properties || {});
      const paramKeys = Object.keys(def?.params_schema?.properties || {});
      const inputs: Record<string, any> = {};
      for (const k of [...inKeys, 'prompt', 'text', 'video', 'video_url', 'image', 'image_url', 'reference_images', 'first_frame', 'audio', 'audio_url', 'ref_audio']) {
        if (d[k] !== undefined && d[k] !== '' && !(Array.isArray(d[k]) && !d[k].length)) inputs[k] = d[k];
      }
      const params: Record<string, any> = { ...(d.params && typeof d.params === 'object' ? d.params : {}) };
      for (const k of paramKeys) {
        // REQ-toonflow-canvas H1：本次 override 的参数值优先于保存的 params
        const ov = override?.[k];
        if (ov !== undefined && ov !== '') { params[k] = ov; continue; }
        if (d[k] !== undefined && d[k] !== '' && params[k] === undefined) params[k] = d[k];
      }
      // C5：是否必填由代码节点自己的 schema 决定（未声明 required 的端口 / 参数都可空）
      const missing = missingRequiredInputs(def, inputs, params);
      if (missing.length) throw new Error(`缺少必填输入：${missing.join('、')}`);
      const payload: any = await apiService.runCustomNode({ custom_node_id: cid, inputs, params });
      if (payload?.status === 'error') throw new Error(String(payload?.error || '自定义节点执行失败'));
      const patch = patchFromPayload('custom', payload);
      if (!Object.keys(patch).length) throw new Error(payload?.detail || '自定义节点未返回结果');
      updateNodeData(node.id, patch);
      setState({ status: 'completed', tool: `customnode_${cid}`, elapsed_ms: Date.now() - start, updated_at: new Date().toISOString() });
      return payload;
    } catch (e: any) {
      setState({ status: 'failed', tool: `customnode_${cid}`, error: String(e?.message || e).slice(0, 200), elapsed_ms: Date.now() - start, updated_at: new Date().toISOString() });
      throw e;
    }
  }

  if (!providerId) {
    const st: AgentState = { status: 'failed', error: '未绑定生成源，请在节点内选择', updated_at: new Date().toISOString() };
    setState(st);
    throw new Error('请先在节点内选择生成源');
  }

  // 接口映射：拉取该源声明的入参键（input_schema + params_schema）+ 节点结构句柄键，从节点数据按键收集
  const def = await getProviderDefinition(providerId);
  const declaredKeys = [...declaredInputKeys(def), ...(LEGACY_HANDLE_KEYS[node.type || ''] || [])];
  const args = buildAgentArgs(d, prompt, declaredKeys, override, { nodeType: node.type });
  const start = Date.now();
  setState({ status: 'running', tool: toolName, provider_id: providerId, updated_at: new Date().toISOString() });

  try {
    let payload: any;
    try {
      const res: any = await apiService.callMcpTool(toolName, args);
      if (res?.status === 'error') throw new Error(String(res?.error || 'MCP 执行失败'));
      payload = res?.result || res;
    } catch (mcpErr: any) {
      const msg = String(mcpErr?.message || mcpErr || '');
      // 仅当 Tool 未注册（not found）时降级旧 HTTP 通道，其余错误直接上抛
      if (!/not found/i.test(msg)) throw mcpErr;
      console.warn(`[NodeAgent] ${toolName} 未注册，降级 HTTP 通道`, msg);
      if (node.type === 'image') {
        payload = await apiService.generateShotImage({
          prompt,
          provider: providerId,
          model: d.model,
          aspect_ratio: args.aspect_ratio,
          dynamic_inputs: Object.fromEntries(Object.entries(args).filter(([k]) => !['prompt','text','model','aspect_ratio'].includes(k))),
        } as any);
      } else if (node.type === 'video') {
        payload = await apiService.generateShotVideo({
          prompt,
          provider: providerId,
          mode: args.mode || (args.first_frame ? 'i2v' : args.reference_images?.length ? 'r2v' : 't2v'),
          first_frame_url: args.first_frame || args.first_frame_url,
          last_frame_url: args.last_frame || args.last_frame_url,
          reference_images: args.reference_images,
          duration: Number(args.duration || 5),
          resolution: args.resolution,
          aspect_ratio: args.aspect_ratio,
        } as any);
      } else if (node.type === 'audio') {
        payload = await apiService.generateTTS(prompt, args.voice_id, args.emotion, {
          provider: providerId,
          model: d.model,
          ref_audio_path: args.ref_audio || args.ref_audio_path,
          speed: args.speed,
          pitch: args.pitch,
        } as any);
      } else {
        throw mcpErr;
      }
    }

    // 异步视频：task_id 先落盘（重启可恢复），再轮询 task_id 直到出片（后端 provider_ 分支已轮询，此为双保险）
    if (node.type === 'video' && !payload?.video_url && payload?.task_id) {
      updateNodeData(node.id, { _taskId: payload.task_id, _polling: true });
      try {
        payload = { ...payload, video_url: await pollVideoTask(payload.task_id) };
      } finally {
        updateNodeData(node.id, { _polling: false });
      }
    }

    const patch = patchFromPayload(node.type, payload);
    if (!Object.keys(patch).length) {
      throw new Error(payload?.error || payload?.detail || `${node.type === 'video' ? '视频' : node.type === 'audio' ? '音频' : '图像'}生成未返回结果`);
    }
    updateNodeData(node.id, patch);
    setState({ status: 'completed', tool: toolName, provider_id: providerId, elapsed_ms: Date.now() - start, updated_at: new Date().toISOString() });
    return payload;
  } catch (e: any) {
    setState({ status: 'failed', tool: toolName, provider_id: providerId, error: String(e?.message || e).slice(0, 200), elapsed_ms: Date.now() - start, updated_at: new Date().toISOString() });
    throw e;
  }
}
