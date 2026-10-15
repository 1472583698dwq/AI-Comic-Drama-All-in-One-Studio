// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas H1 宿主执行路由（CanvasHost.execute 的实现，替代旧 CreativeCanvas.handleNodeExecute）。
 *
 * 节点调用 `useKitNodeActions(id).execute(overrides)`；overrides 只作用于本次执行、不落盘。
 * - `prompt`（文本）：按 `overrides.skill_id`（缺省节点 skill_id → free_generation）路由：
 *     自由生成 / 扩写 / 策划案走流式 `POST /llm/generate/stream`（B1，COORDINATION 14：增量节流追加进正文，
 *     done 写最终全文，error 还原正文并 reject，`overrides.signal` 中止 = 停止生成、保留已生成部分）；
 *     后端还没有流式接口（404/405）时退回一次性接口（/llm/generate、/llm/expand）；剧本拆解 parseScript 不走流式。
 *     结果 text 与 prompt 写同一内容（N1）。
 * - `image` / `video` / `audio`：宿主侧生成（分镜子图自动运行等宿主发起的场景）：按连线组装参考（kit buildRefs +
 *     assembleInputs，与节点面板同口径）→ kit runGeneration（直接生成 / 智能规划、视频轮询、history）。
 * - `director3d`：MCP director_3d_stage_plan，参数写回 + 本地重算运镜提示词（N5）。
 * - `custom`：/custom-nodes/run（nodeAgentExecutor custom 分支，按 input_schema 拆 inputs / params）。
 * - `script-split`：/canvas/node/execute，结果 `{project}` 写进 `result`（N7）。
 * - 其他（ext-node / shot-card / comfy-workflow / export …）：/canvas/node/execute，ext-node 不上传 definition。
 * **失败一律 reject**（旧宿主 alert 后 resolve，节点会把状态记成成功），同时尽量写 agent_state.failed。
 */
import type { Edge, Node } from '@xyflow/react';
import { apiService } from '../../../services/api';
import { API_BASE_URL } from '../../../utils/devOrigin';
import { executeAgentNode } from '../hooks/nodeAgentExecutor';
import { buildRefs } from '../kit/references';
import { ownPromptOf } from '../kit/inputRules';
import { assembleInputs, type AssembledInputs } from '../kit/assembleInputs';
import { runGeneration, type GenKind } from '../kit/useGeneration';
import { loadProviderDefinition } from '../kit/useProviderSources';
import { extractSlotsFromProvider, type DynamicProviderInfo } from '../providerSkills';
import { audioGenerationInputs } from '../nodes2/audio/genInputs';
import { StreamUnavailableError, streamLlmText, type StreamSkill } from './textStream';
import { cameraPromptPatch } from '../nodes2/director3d/model';

type AnyData = Record<string, any>;

export interface ExecuteDeps {
  getNode: (id: string) => Node | undefined;
  getEdges: () => Edge[];
  updateNodeData: (id: string, patch: AnyData) => void;
  projectId: () => string | undefined;
  /** 测试注入（缺省 window.fetch） */
  fetch?: typeof fetch;
}

/** execute 的结果：媒体生成返回产物 url（分镜子图自动运行据此回写分镜，D4）；文本技能返回正文。 */
export interface ExecuteResult {
  url?: string;
  text?: string;
}

/** 流式写回正文的节流间隔（ms） */
export const STREAM_FLUSH_MS = 80;

export const TEXT_SKILLS = ['free_generation', 'prompt_expansion', 'script_generation', 'proposal_generation'] as const;
export type TextSkill = (typeof TEXT_SKILLS)[number];

/** 技能 id 归一：旧 custom_text / 空 → 自由生成。 */
export function normalizeTextSkill(v: unknown): TextSkill {
  const s = typeof v === 'string' ? v.trim() : '';
  return (TEXT_SKILLS as readonly string[]).includes(s) ? (s as TextSkill) : 'free_generation';
}

const TEXT_TOOL: Record<TextSkill, string> = {
  free_generation: 'llm/generate',
  prompt_expansion: 'llm/expand',
  script_generation: 'parseScript',
  proposal_generation: 'llm/generate',
};

const FREE_GEN_SYSTEM = '你是漫剧创作助手。按用户要求生成内容，使用 Markdown 排版；只输出正文，不要多余的解释。';
const PROPOSAL_SYSTEM = '你是一位金牌影视与漫剧总策划。根据用户输入的主题或题材，生成一份高吸引力的策划案，包括世界观、主角人设、核心矛盾与前三集爆点大纲。使用 Markdown 输出。';

function nowIso(): string {
  return new Date().toISOString();
}

function errText(e: unknown): string {
  return String((e as Error)?.message || e || '执行失败').slice(0, 220);
}

async function postJson(f: typeof fetch, path: string, body: AnyData): Promise<AnyData> {
  const res = await f(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = json?.detail;
    throw new Error(typeof detail === 'string' ? detail : detail?.message || `请求失败（${res.status}）`);
  }
  return json || {};
}

/** 剧本拆解结果 → 逐行文本（与旧宿主 / 后端 engine 同格式）。 */
export function formatScript(res: AnyData | null | undefined): string {
  const scenes = Array.isArray(res?.scenes) ? res!.scenes : [];
  return scenes
    .map((s: AnyData) => `【场景 ${s.scene_index}】\n` + (Array.isArray(s.shots) ? s.shots : [])
      .map((sh: AnyData) => `镜头 ${sh.shot_index}: [${sh.camera_framing}] ${sh.action_desc}\n台词: ${sh.dialogue || '（无对白）'}`)
      .join('\n\n'))
    .join('\n\n');
}

/** 通用 LLM 生成（后端 POST /llm/generate，H1 新增）。 */
export async function generateText(f: typeof fetch, prompt: string, opts: { system?: string; images?: string[] } = {}): Promise<string> {
  const r = await postJson(f, '/llm/generate', { prompt, system: opts.system, images: opts.images?.length ? opts.images : undefined });
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text) throw new Error('LLM 返回为空');
  return text;
}

const STREAM_SKILLS: ReadonlySet<TextSkill> = new Set<TextSkill>(['free_generation', 'prompt_expansion', 'proposal_generation']);

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (e as Error)?.name === 'AbortError';
}

/** 一次性接口（流式不可用时的退路，与流式前的行为一致） */
async function runTextOnce(f: typeof fetch, skill: TextSkill, input: string, images: string[]): Promise<string> {
  if (skill === 'proposal_generation') return generateText(f, input, { system: PROPOSAL_SYSTEM });
  if (skill === 'prompt_expansion') {
    const out = await apiService.expandPrompt(input, 'image');
    if (!out) throw new Error('扩写返回为空');
    return out;
  }
  return generateText(f, input, { system: FREE_GEN_SYSTEM, images });
}

async function runTextSkill(deps: ExecuteDeps, node: Node, overrides: AnyData, signal?: AbortSignal): Promise<ExecuteResult> {
  const f = deps.fetch ?? fetch;
  const data = (node.data || {}) as AnyData;
  const d = { ...data, ...overrides };
  const skill = normalizeTextSkill(overrides.skill_id ?? data.skill_id);
  const input = String(overrides.prompt ?? data.prompt ?? data.text ?? '').trim();
  if (!input) throw new Error(skill === 'free_generation' ? '请先输入生成指令' : '没有可处理的文本');
  const streaming = STREAM_SKILLS.has(skill);
  const tool = streaming ? `llm/generate/stream:${skill}` : TEXT_TOOL[skill];
  const startedAt = nowIso();
  deps.updateNodeData(node.id, { agent_state: { status: 'running', tool, updated_at: startedAt } });

  // —— 流式写回：增量节流追加进正文（text / prompt 同写），首个增量时标记 streaming（节点据此显示正文而不是整块转圈）——
  const original = { text: data.text, prompt: data.prompt };
  let acc = '';
  let wrote = false;
  let lastFlush = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    lastFlush = Date.now();
    const patch: AnyData = { text: acc, prompt: acc };
    if (!wrote) patch.agent_state = { status: 'running', tool, streaming: true, updated_at: startedAt };
    wrote = true;
    deps.updateNodeData(node.id, patch);
  };
  const stopTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const onDelta = (_delta: string, all: string) => {
    acc = all;
    const wait = STREAM_FLUSH_MS - (Date.now() - lastFlush);
    if (wait <= 0) { stopTimer(); flush(); } else if (timer === undefined) timer = setTimeout(flush, wait);
  };

  try {
    let out = '';
    const extra: AnyData = {};
    const images = Array.isArray(overrides.reference_images) ? overrides.reference_images.filter((u: unknown) => typeof u === 'string' && u) : [];
    if (skill === 'script_generation') {
      const res: AnyData = await apiService.parseScript(input, d.style_preset || 'donghua_xianxia', d.aspect_ratio || '9:16');
      out = formatScript(res) || input;
      extra.script_data = res;
    } else {
      // REQ-toonflow-canvas 策划案：与后端 text_skills.PROPOSAL_GENERATION 一致（策划案系统提示走通用 LLM），
      // 不调 MCP split_novel_script（它返回分场 / 分镜拆解，不是策划案，带项目上下文时还会写入项目）
      try {
        out = await streamLlmText(
          { prompt: input, skill: skill as StreamSkill, images: skill === 'free_generation' && images.length ? images : undefined },
          { onDelta, signal, fetch: f },
        );
      } catch (e) {
        if (!(e instanceof StreamUnavailableError)) throw e;
        out = await runTextOnce(f, skill, input, images);
      }
      stopTimer();
      out = out.trim();
      if (!out) throw new Error(skill === 'prompt_expansion' ? '扩写返回为空' : 'LLM 返回为空');
    }
    // N1：text 与 prompt 写同一内容
    deps.updateNodeData(node.id, { text: out, prompt: out, ...extra, agent_state: { status: 'completed', tool, updated_at: nowIso() } });
    return { text: out };
  } catch (e) {
    stopTimer();
    if (isAbort(e, signal)) {
      // 停止生成：保留已生成的部分（Toonflow 同款），状态复位为 idle，不算失败
      const patch: AnyData = { agent_state: { status: 'idle', tool, updated_at: nowIso() } };
      if (acc) { patch.text = acc; patch.prompt = acc; }
      deps.updateNodeData(node.id, patch);
      return { text: acc || undefined };
    }
    // 失败：流式已改写过正文的，还原成执行前的正文（undefined = 删键，即原本就没有）
    const fail: AnyData = { agent_state: { status: 'failed', tool, error: errText(e), updated_at: nowIso() } };
    if (wrote) { fail.text = original.text; fail.prompt = original.prompt; }
    deps.updateNodeData(node.id, fail);
    throw e;
  }
}

/**
 * 宿主侧媒体生成：与节点面板同口径（buildRefs → assembleInputs → runGeneration）。
 * 节点自己的发送按钮走 kit useGeneration；这里服务宿主发起的生成（分镜子图自动运行、Agent 回放等）。
 */
export async function runHostGeneration(deps: ExecuteDeps, node: Node, overrides: AnyData = {}): Promise<{ url?: string }> {
  const type = node.type as GenKind;
  const data = { ...((node.data || {}) as AnyData), ...overrides };
  const providerId = String(data.provider_id || data.provider || '');
  const def = providerId ? await loadProviderDefinition(providerId) : null;
  // 与节点面板同口径：图片传 'image'，视频 / 音频不传 nodeKind（N4：避免给只收 text 的源兜底出参考音频槽）
  const slots = def ? extractSlotsFromProvider(def as unknown as DynamicProviderInfo, type === 'image' ? 'image' : undefined) : null;
  const refs = buildRefs(deps.getEdges(), (id) => deps.getNode(id), node.id);
  let assembled: AssembledInputs = assembleInputs({
    refs, targetType: type, prompt: ownPromptOf(type, data), mode: data.mode, refRoles: data.refRoles, slots,
  });
  if (type === 'audio') assembled = audioGenerationInputs(assembled);
  const params = (data.params && typeof data.params === 'object' ? data.params : undefined) as AnyData | undefined;
  const r = await runGeneration({
    nodeId: node.id,
    nodeType: type,
    kind: type,
    data,
    assembled,
    providerId,
    params,
    smartPlan: !!data.smart_plan,
    intent: assembled.prompt,
    updateNodeData: deps.updateNodeData,
    inputKeys: slots ? slots.flatMap((s) => [s.key, s.originalKey].filter(Boolean) as string[]) : undefined,
  });
  return { url: r.url };
}

const DIRECTOR_PARAM_KEYS = ['framing', 'motion', 'pose', 'focal_length_mm', 'camera_roll_deg', 'cast_layout', 'speed', 'parse_mode'];

async function runDirectorPlan(deps: ExecuteDeps, node: Node, overrides: AnyData): Promise<void> {
  const d = { ...((node.data || {}) as AnyData), ...overrides };
  // 与 3D 片场 / useDirectorAgent 同口径 8 参数
  const res: AnyData = await apiService.callMcpTool('director_3d_stage_plan', {
    framing: d.framing || 'medium', motion: d.motion || 'push_in', pose: d.pose || 'stand',
    focal_length_mm: d.focal_length_mm || 35, camera_roll_deg: d.camera_roll_deg || 0,
    cast_layout: d.cast_layout || 'solo', speed: d.speed || '1.0x', ai_directive: d.ai_directive || '',
  });
  if (!res || res.status === 'error') throw new Error(String(res?.error || res?.detail || '3D 导演规划失败'));
  const r = (res.result || res) as AnyData;
  const patch: AnyData = {};
  for (const k of DIRECTOR_PARAM_KEYS) if (r[k] !== undefined && r[k] !== null && r[k] !== '') patch[k] = r[k];
  if (!Object.keys(patch).length) throw new Error('3D 导演规划没有返回参数');
  // N5：运镜提示词按参数本地重算（与 3D 片场 LIVE PROMPT 逐字一致），两键写同一值
  const merged = { ...((node.data || {}) as AnyData), ...patch };
  Object.assign(patch, cameraPromptPatch(merged) || {});
  deps.updateNodeData(node.id, patch);
}

async function runCanvasNodeExecute(deps: ExecuteDeps, node: Node, overrides: AnyData): Promise<void> {
  const f = deps.fetch ?? fetch;
  const d: AnyData = { ...((node.data || {}) as AnyData), ...overrides };
  if (node.type === 'ext-node') delete d.definition; // 大字段不上行，引擎按 canvas_node_id 重读声明
  const trackState = node.type === 'ext-node';
  const tool = node.type === 'ext-node' ? `canvas_node_${d.canvas_node_id || ''}` : `canvas_${node.type}`;
  if (trackState) deps.updateNodeData(node.id, { agent_state: { status: 'running', tool, updated_at: nowIso() } });
  try {
    const resp = await postJson(f, '/canvas/node/execute', { node: { id: node.id, type: node.type, data: d }, project_id: deps.projectId() });
    const rr: AnyData = resp?.result || {};
    if (rr.status !== 'success') throw new Error(String(rr.error || resp?.detail || '执行失败'));
    const patch: AnyData = {};
    if (rr.image_url) { patch.image_url = rr.image_url; patch.result_url = rr.image_url; }
    if (rr.video_url) patch.video_url = rr.video_url;
    if (rr.audio_url) patch.audio_url = rr.audio_url;
    if (typeof rr.prompt === 'string' && rr.prompt) patch.prompt = rr.prompt;
    if (typeof rr.text === 'string' && rr.text) patch.text = rr.text;
    if (rr.outputs && typeof rr.outputs === 'object') patch.outputs = rr.outputs;
    // N7：剧本拆解的引擎结果是 {project}，节点读 data.result
    if (node.type === 'script-split') {
      if (!rr.project) throw new Error('剧本拆解没有返回结果');
      patch.result = rr.project;
      patch.error = undefined;
    }
    if (trackState) patch.agent_state = { status: 'completed', tool, updated_at: nowIso() };
    deps.updateNodeData(node.id, patch);
  } catch (e) {
    const fail: AnyData = {};
    if (trackState) fail.agent_state = { status: 'failed', tool, error: errText(e), updated_at: nowIso() };
    if (node.type === 'script-split') fail.error = errText(e);
    if (Object.keys(fail).length) deps.updateNodeData(node.id, fail);
    throw e;
  }
}

/** CanvasHost.execute 实现。 */
/**
 * CanvasHost.execute 实现。
 * `overrides.signal`（AbortSignal）只给文本流式技能用于「停止生成」，不进任何请求体。
 * 返回 ExecuteResult：媒体生成带产物 url（调用方不必再从 nodesRef 读，nodesRef 要等下一次渲染才更新，D4）。
 */
export function createExecuteRouter(deps: ExecuteDeps) {
  return async function execute(nodeId: string, overrides?: Record<string, unknown>): Promise<ExecuteResult> {
    const node = deps.getNode(nodeId);
    if (!node) throw new Error('节点不存在');
    const { signal: rawSignal, ...rest } = (overrides || {}) as AnyData;
    const signal = rawSignal && typeof (rawSignal as AbortSignal).aborted === 'boolean' ? (rawSignal as AbortSignal) : undefined;
    const ov = rest as AnyData;
    switch (node.type) {
      case 'prompt':
        return runTextSkill(deps, node, ov, signal);
      case 'image':
      case 'video':
      case 'audio':
        return runHostGeneration(deps, node, ov);
      case 'director3d':
        await runDirectorPlan(deps, node, ov);
        return {};
      case 'custom': {
        // /custom-nodes/run：overrides = N7 collectDynamicInputs（声明端口 id → 上游值），执行器按 input_schema 拆 inputs / params
        const payload: AnyData = await executeAgentNode({ node: { id: node.id, type: node.type, data: node.data }, override: ov, updateNodeData: deps.updateNodeData });
        return { url: payload?.image_url || payload?.video_url || payload?.audio_url || payload?.url || undefined };
      }
      default:
        await runCanvasNodeExecute(deps, node, ov);
        return {};
    }
  };
}
