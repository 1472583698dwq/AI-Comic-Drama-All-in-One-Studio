// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 媒体节点统一生成入口（图片 / 视频 / 音频生成节点共用）。
 *
 * 两条路径：
 * - 直接生成（智能规划关）：走原有 executeAgentNode → MCP provider_<id>（含视频 task 轮询），入参来自 assembleInputs；
 * - 智能规划（开）：走 /canvas/agent/generate（LLM 先规划技能/生成源/参数再生成），同 NodeAgentConsole 旧逻辑。
 *
 * 结果统一回写：image_url / video_url / audio_url + agent_state，并把本次结果追加进 data.history（Toonflow 式历史版本）。
 * 取消：Toonflow 语义——停止等待并丢弃结果（后端任务不保证被终止）。
 */
import { useCallback, useRef, useState } from 'react';
import { apiService } from '../../../services/api';
import { pollVideoTask } from '../../../utils/videoTask';
import { executeAgentNode, type AgentState } from '../hooks/nodeAgentExecutor';
import type { AssembledInputs } from './assembleInputs';

export type GenKind = 'image' | 'video' | 'audio';

export interface GenerationHistoryItem {
  url: string;
  created_at: string;
  provider_id?: string;
  prompt?: string;
  params?: Record<string, unknown>;
}

/** 历史上限（超出丢最旧的） */
export const HISTORY_LIMIT = 20;

const URL_KEY: Record<GenKind, 'image_url' | 'video_url' | 'audio_url'> = {
  image: 'image_url',
  video: 'video_url',
  audio: 'audio_url',
};

export interface RunGenerationOptions {
  nodeId: string;
  /** 节点类型（image / video / audio），用于执行器的结果映射 */
  nodeType: string;
  kind: GenKind;
  /** 节点当前数据 */
  data: Record<string, unknown>;
  /** assembleInputs 结果（按所选生成源的槽位组装） */
  assembled: AssembledInputs;
  providerId?: string;
  /** DynamicControl 收集的生成源参数（params_schema） */
  params?: Record<string, unknown>;
  /** 是否先让 LLM 规划 */
  smartPlan?: boolean;
  /** 智能规划时给 LLM 的原始意图（缺省用组装后的 prompt） */
  intent?: string;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  /** 取消检查：返回 false 时丢弃结果 */
  isCurrent?: () => boolean;
}

export interface RunGenerationResult {
  url?: string;
  /** 已回写节点的补丁 */
  patch: Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pickUrl(kind: GenKind, payload: Record<string, any> | null | undefined): string | undefined {
  if (!payload) return undefined;
  const v = kind === 'image' ? payload.image_url || payload.url || payload.result_url : payload[URL_KEY[kind]];
  return typeof v === 'string' && v ? v : undefined;
}

/** 把一次结果追加进历史（同 url 去重，新的在前）。 */
export function appendHistory(
  history: unknown,
  item: GenerationHistoryItem,
  limit = HISTORY_LIMIT,
): GenerationHistoryItem[] {
  const prev = Array.isArray(history) ? (history as GenerationHistoryItem[]).filter((h) => h && h.url) : [];
  return [item, ...prev.filter((h) => h.url !== item.url)].slice(0, limit);
}

/** 入参里去掉 prompt / camera_prompt，剩下的就是槽位（智能规划的 slots） */
function slotsOf(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'prompt' || k === 'camera_prompt') continue;
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

function cleanParams(params?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (['provider', 'provider_id', 'provider_params', 'params'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 执行一次生成（无 React 依赖，宿主 / Agent 回放也可直接调用）。 */
export async function runGeneration(o: RunGenerationOptions): Promise<RunGenerationResult> {
  const { nodeId, nodeType, kind, data, assembled, updateNodeData } = o;
  const isCurrent = o.isCurrent ?? (() => true);
  const providerId = o.providerId || String(data.provider_id || data.provider || '');
  const params = cleanParams(o.params);
  const startedAt = Date.now();

  const write = (patch: Record<string, unknown>) => {
    if (isCurrent()) updateNodeData(nodeId, patch);
  };

  let url: string | undefined;
  let patch: Record<string, unknown> = {};

  if (o.smartPlan) {
    const intent = (o.intent || assembled.prompt || '').trim();
    if (!intent) throw new Error('提示词为空');
    write({
      agent_state: {
        status: 'running',
        tool: providerId ? `provider_${providerId}` : 'agent_plan',
        provider_id: providerId || undefined,
        updated_at: nowIso(),
      } satisfies AgentState,
    });
    try {
      const res: any = await apiService.canvasAgentGenerate({
        node_type: kind,
        idea: intent,
        provider_id: providerId || undefined,
        skill_id: (data.skill_id as string) || undefined,
        slots: slotsOf(assembled.args),
        params: params,
        node_id: nodeId,
      });
      if (res?.status === 'error') throw new Error(res.error || '生成失败');
      const plan = res?.plan || {};
      const result = res?.result || {};
      if (kind === 'video' && !result.video_url && result.task_id) {
        write({ _taskId: result.task_id, _polling: true });
        result.video_url = await pollVideoTask(result.task_id);
        write({ _polling: false });
      }
      url = pickUrl(kind, result);
      patch = { _last_agent_plan: plan };
      if (plan.prompt) patch.polished_prompt = plan.prompt;
      if (plan.skill_id) patch.skill_id = plan.skill_id;
      if (plan.provider_id) {
        patch.provider_id = plan.provider_id;
        patch.provider = plan.provider_id;
      }
      if (plan.model) patch.model = plan.model;
      if (plan.params) {
        patch.params = { ...params, ...plan.params };
        patch.provider_params = patch.params;
      }
      if (result.width) patch.width = result.width;
      if (result.height) patch.height = result.height;
      if (!url) throw new Error('生成未返回结果');
      patch[URL_KEY[kind]] = url;
      if (kind === 'image') patch.result_url = url;
      patch.agent_state = {
        status: 'completed',
        tool: `provider_${plan.provider_id || providerId}`,
        provider_id: plan.provider_id || providerId,
        elapsed_ms: res?.elapsed_ms ?? Date.now() - startedAt,
        updated_at: nowIso(),
      } satisfies AgentState;
    } catch (e: any) {
      write({
        agent_state: {
          status: 'failed',
          provider_id: providerId || undefined,
          error: String(e?.message || e).slice(0, 220),
          updated_at: nowIso(),
        } satisfies AgentState,
      });
      throw e;
    }
  } else {
    // 直接生成：入参 = 组装结果（含 prompt / 槽位）+ 生成源参数；视频额外下发 providerMode
    const override: Record<string, unknown> = {
      ...assembled.args,
      ...params,
      prompt: assembled.prompt,
      provider_id: providerId,
      provider: providerId,
    };
    if (assembled.camera_prompt) override.camera_prompt = assembled.camera_prompt;
    if (kind === 'video' && assembled.providerMode) override.mode = assembled.providerMode;
    const payload: any = await executeAgentNode({
      node: { id: nodeId, type: nodeType, data },
      override,
      updateNodeData: (id, p) => {
        if (isCurrent()) updateNodeData(id, p);
      },
    });
    url = pickUrl(kind, payload);
    if (!url) throw new Error('生成未返回结果');
  }

  if (!isCurrent()) return { url, patch: {} };

  patch.history = appendHistory(data.history, {
    url,
    created_at: nowIso(),
    provider_id: (patch.provider_id as string) || providerId || undefined,
    prompt: assembled.prompt,
    params: Object.keys(params).length ? params : undefined,
  });
  patch[URL_KEY[kind]] = url;
  updateNodeData(nodeId, patch);
  return { url, patch };
}

export interface UseGeneration {
  running: boolean;
  error: string | null;
  run: (opts: Omit<RunGenerationOptions, 'updateNodeData' | 'isCurrent' | 'nodeId'>) => Promise<RunGenerationResult | null>;
  /** 停止等待并丢弃结果 */
  cancel: () => void;
}

/** 节点内使用：带运行态与取消。updateNodeData 用 useKitNodeActions(nodeId).update 传入。 */
export function useGeneration(nodeId: string, updateNodeData: (id: string, patch: Record<string, unknown>) => void): UseGeneration {
  const tokenRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback<UseGeneration['run']>(
    async (opts) => {
      const token = ++tokenRef.current;
      setRunning(true);
      setError(null);
      try {
        return await runGeneration({ ...opts, nodeId, updateNodeData, isCurrent: () => tokenRef.current === token });
      } catch (e: any) {
        if (tokenRef.current === token) setError(String(e?.message || e));
        return null;
      } finally {
        if (tokenRef.current === token) setRunning(false);
      }
    },
    [nodeId, updateNodeData],
  );

  const cancel = useCallback(() => {
    tokenRef.current += 1;
    setRunning(false);
    updateNodeData(nodeId, {
      agent_state: { status: 'idle', updated_at: nowIso() } satisfies AgentState,
      _polling: false,
    });
  }, [nodeId, updateNodeData]);

  return { running, error, run, cancel };
}
