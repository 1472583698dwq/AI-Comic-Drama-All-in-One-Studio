// -*- coding: utf-8 -*-
/**
 * 统一节点 Agent 执行器 — 节点内 AgentBar / 节点按钮 / 旧调用方 共用唯一路径
 * 所有生成一律走 MCP provider_<id> Tool（含视频 task_id 轮询），结果与 agent_state 回写节点
 */
import { apiService } from '../../../services/api';

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

const POLL_PARAM_KEYS = ['aspect_ratio','resolution','steps','cfg','duration','hasSound','fps','seed','style_preset','negative_prompt','workflow_id','voice_id','emotion','speed','pitch','width','height','mode'];

export function buildAgentArgs(d: any, prompt: string): Record<string, any> {
  const args: Record<string, any> = {
    prompt,
    text: d.text || prompt,
    model: d.model,
    first_frame: d.first_frame || d.first_frame_url,
    last_frame: d.last_frame || d.last_frame_url,
    reference_images: d.reference_images || (d.reference ? [d.reference] : undefined),
    reference: d.reference,
    ref_audio: d.ref_audio || d.ref_audio_path,
    ...(d.params && typeof d.params === 'object' ? d.params : {}),
    ...(d.provider_params && typeof d.provider_params === 'object' ? d.provider_params : {}),
  };
  for (const k of POLL_PARAM_KEYS) {
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
  let lastErr = '';
  for (let i = 0; i < 140; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const st: any = await apiService.getVideoTaskStatus(taskId);
      const s = (st.status || st.state || '').toString().toUpperCase();
      if (s === 'SUCCESS' || s === 'COMPLETED') {
        const url = st.video_url || st.videoUrl || st.results?.[0] || st.url || '';
        if (url) return url;
      }
      if (s === 'FAILED' || s === 'FAIL' || s === 'ERROR') throw new Error(st.error || st.msg || '视频任务失败');
    } catch (e: any) {
      const msg = e?.message || '';
      if (msg.includes('任务失败') || msg.includes('FAILED')) { lastErr = msg; break; }
    }
  }
  throw new Error(lastErr || `视频排队超时 task_id=${taskId}，请稍后重试或查看 /storage/videos/`);
}

export function patchFromPayload(nodeType: string, payload: any): Record<string, any> {
  const patch: Record<string, any> = {};
  if (!payload || typeof payload !== 'object') return patch;
  if (payload.image_url || (payload.url && nodeType === 'image')) {
    const u = payload.image_url || payload.url;
    patch.image_url = u;
    patch.result_url = u;
  }
  if (payload.video_url) patch.video_url = payload.video_url;
  if (payload.audio_url) patch.audio_url = payload.audio_url;
  if (payload.minimax_camera_prompt) patch.minimax_camera_prompt = payload.minimax_camera_prompt;
  if (typeof payload.prompt === 'string' && payload.prompt && payload.prompt !== '__RAW__') patch.prompt = payload.prompt;
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

  if (!providerId) {
    const st: AgentState = { status: 'failed', error: '未绑定生成源，请在节点内选择', updated_at: new Date().toISOString() };
    setState(st);
    throw new Error('请先在节点内选择生成源');
  }

  const args = buildAgentArgs(d, prompt);
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
          dynamic_inputs: args.reference_images ? { reference_images: args.reference_images } : undefined,
        } as any);
      } else if (node.type === 'video') {
        payload = await apiService.generateShotVideo({
          prompt,
          provider: providerId,
          mode: args.mode || (args.first_frame ? 'i2v' : args.reference_images?.length ? 'r2v' : 't2v'),
          first_frame_url: args.first_frame,
          last_frame_url: args.last_frame,
          reference_images: args.reference_images,
          duration: Number(args.duration || 5),
          resolution: args.resolution,
          aspect_ratio: args.aspect_ratio,
        } as any);
      } else if (node.type === 'audio') {
        payload = await apiService.generateTTS(prompt, args.voice_id || 'male-qn-qingse', args.emotion || 'neutral', {
          provider: providerId,
          model: d.model,
          ref_audio_path: args.ref_audio,
          speed: args.speed,
          pitch: args.pitch,
        } as any);
      } else {
        throw mcpErr;
      }
    }

    // 异步视频：轮询 task_id 直到出片（后端 provider_ 分支已轮询，此为双保险）
    if (node.type === 'video' && !payload?.video_url && payload?.task_id) {
      payload = { ...payload, video_url: await pollVideoTask(payload.task_id) };
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
