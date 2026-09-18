// -*- coding: utf-8 -*-
/**
 * 统一节点 Agent 执行器 — 节点内 AgentBar / 节点按钮 / 旧调用方 共用唯一路径
 * 所有生成一律走 MCP provider_<id> Tool（含视频 task_id 轮询），结果与 agent_state 回写节点
 */
import { apiService } from '../../../services/api';
import { getNodeSpec } from '../nodeRegistry';

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

export function buildAgentArgs(d: any, prompt: string, extraKeys: string[] = []): Record<string, any> {
  const args: Record<string, any> = {
    prompt,
    text: d.text || prompt,
    model: d.model,
    ...(d.params && typeof d.params === 'object' ? d.params : {}),
    ...(d.provider_params && typeof d.provider_params === 'object' ? d.provider_params : {}),
  };
  // 声明键 + 已连线句柄键：从节点顶层数据取值
  for (const k of extraKeys) {
    if (INTERNAL_NODE_KEYS.has(k)) continue;
    if (d[k] !== undefined && args[k] === undefined) args[k] = d[k];
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

async function pollVideoTask(taskId: string): Promise<string> {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let st: any;
    try {
      st = await apiService.getVideoTaskStatus(taskId);
    } catch {
      continue; // 状态接口网络抖动：继续轮询，不误杀任务
    }
    const s = (st.status || st.state || '').toString().toUpperCase();
    if (s === 'SUCCESS' || s === 'COMPLETED') {
      const url = st.video_url || st.videoUrl || st.results?.[0] || st.url || '';
      if (url) return url;
      continue;
    }
    // 终态失败：把后端真实错误上抛（含 last_error 兜底），不再静默轮询
    if (s === 'FAILED' || s === 'FAIL' || s === 'ERROR' || s === 'TIMEOUT' || s === 'CANCELLED' || s === 'CANCELED') {
      throw new Error(st.error || st.msg || st.last_error || '视频任务失败');
    }
  }
  throw new Error(`视频排队超时 task_id=${taskId}，请稍后重试或查看 /storage/videos/`);
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
  if (payload.width && payload.height) patch.aspect_ratio = `${payload.width}:${payload.height}`;
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
  if (!prompt && node.type !== 'director3d' && node.type !== 'export') throw new Error('提示词为空');
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
        if (d[k] !== undefined && d[k] !== '' && params[k] === undefined) params[k] = d[k];
      }
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
  const declaredKeys = [...declaredInputKeys(def), ...(getNodeSpec(node.type || '')?.inputs.map(h => h.id) || [])];
  const args = buildAgentArgs(d, prompt, declaredKeys);
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
