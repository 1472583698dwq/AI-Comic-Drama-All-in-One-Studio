// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点 `prompt`：技能下拉（替换 Toonflow textNode 的「模型」下拉）与一次执行的入参组装。
 *
 * 数据键（design §2 只追加不改名）：
 * - `text` / `prompt`：正文（Markdown）。编辑时两键同时写；读取以 `prompt` 优先——下游 kit readOutputValue 与后端
 *   inputs.source_values 都先读 `prompt`，节点上显示的就是流向下游的内容（存量画布 8/20 个文本节点只有 `prompt`）。
 * - `gen_prompt`：底部提示词面板的生成指令，可含 `{{ref N}}`（新增键；`prompt` 已被正文占用）。
 * - `skill_id`：技能下拉的选择（宿主 / 后端执行器沿用此键按技能分发）。
 *
 * 执行：节点调用 `useKitNodeActions(id).execute(overrides)`，宿主按 `overrides.skill_id` 路由到原有分支
 * （剧本拆解 parseScript、策划案与自由生成走通用 LLM /llm/generate、扩写 /llm/expand），把结果写回 `text` + `prompt`。
 * overrides 只作用于本次执行、不落盘（同旧 data.onExecute 的 customData），键名见 TextExecuteOverrides。
 */
import { REF_TOKEN_RE, assembleInputs, refName, type RefItem } from '../../kit';

export type TextSkillId = 'free_generation' | 'prompt_expansion' | 'script_generation' | 'proposal_generation';

export interface TextSkill {
  id: TextSkillId;
  /** 下拉显示名 */
  label: string;
  group: string;
  description: string;
  /** 提示词输入框占位 */
  placeholder: string;
  /** 提示词与文本参考都为空时，是否改用当前正文作为输入（扩写 / 拆解 / 策划案可以；自由生成不行，避免误把正文整段替换掉） */
  documentFallback: boolean;
  /** 只处理文本：连了图片 / 视频参考时提示「不会使用」 */
  textOnly: boolean;
}

// REQ-toonflow-canvas 技能 id 与宿主 handleNodeExecute / 后端 engine.execute_node 的 prompt 分支一致；free_generation 为新增（H1 实现）
export const TEXT_SKILLS: readonly TextSkill[] = [
  {
    id: 'free_generation',
    label: '自由生成',
    group: 'LLM',
    description: 'LLM 按提示词自由生成 Markdown 文本',
    placeholder: '描述要生成的文本，输入 @ 引用参考',
    documentFallback: false,
    textOnly: false,
  },
  {
    id: 'prompt_expansion',
    label: '扩写',
    group: '技能',
    description: '把简短构思扩写为影视级提示词（/llm/expand）',
    placeholder: '输入简短构思扩写为影视级提示词，输入 @ 引用参考；留空则扩写上游文本或当前正文',
    documentFallback: true,
    textOnly: true,
  },
  {
    id: 'script_generation',
    label: '剧本拆解',
    group: '技能',
    description: '把故事梗概 / 小说段落拆解为场景、镜头与台词（parseScript）',
    placeholder: '输入故事或小说段落，拆解为分镜与台词，输入 @ 引用参考；留空则拆解上游文本或当前正文',
    documentFallback: true,
    textOnly: true,
  },
  {
    id: 'proposal_generation',
    label: '策划案',
    group: '技能',
    description: '生成世界观、主角人设与前三集爆点大纲',
    placeholder: '输入漫剧题材或核心梗生成策划案，输入 @ 引用参考；留空则基于上游文本或当前正文',
    documentFallback: true,
    textOnly: true,
  },
];

export const DEFAULT_TEXT_SKILL: TextSkillId = 'free_generation';

/** 宿主走流式生成（可「停止生成」）的技能；剧本拆解不流式（COORDINATION 14）。 */
export const STREAMING_SKILLS: ReadonlySet<TextSkillId> = new Set<TextSkillId>(['free_generation', 'prompt_expansion', 'proposal_generation']);

/** 旧技能 id 兼容：`custom_text`（旧「自由编写」）归到自由生成。 */
const SKILL_ALIASES: Readonly<Record<string, TextSkillId>> = Object.freeze({ custom_text: 'free_generation' });

export function normalizeSkillId(v: unknown): TextSkillId {
  if (typeof v !== 'string') return DEFAULT_TEXT_SKILL;
  const s = v.trim();
  if (TEXT_SKILLS.some((k) => k.id === s)) return s as TextSkillId;
  return SKILL_ALIASES[s] ?? DEFAULT_TEXT_SKILL;
}

export function skillOf(v: unknown): TextSkill {
  const id = normalizeSkillId(v);
  return TEXT_SKILLS.find((k) => k.id === id)!;
}

/** 生成指令所在的 data 键（useNodeReferences 重排参考时改写其中的 `{{ref N}}`）。 */
export const GEN_PROMPT_KEY = 'gen_prompt';

export interface TextNodeData extends Record<string, unknown> {
  label?: string;
  text?: string;
  prompt?: string;
  gen_prompt?: string;
  skill_id?: string;
  /** streaming：宿主流式写回正文中（B1），节点显示正在增长的正文而不是整块转圈 */
  agent_state?: { status?: string; error?: string; tool?: string; updated_at?: string; streaming?: boolean } | null;
  refRoles?: Record<string, string>;
  refOrder?: string[];
}

/** 正文：`prompt` 优先（= 流向下游的值），空白时回落 `text`；都空白时原样返回（编辑中只敲了空格 / 换行不会被吞掉）。 */
export function documentOf(data: Record<string, unknown> | null | undefined): string {
  const d = data || {};
  const p = typeof d.prompt === 'string' ? d.prompt : undefined;
  const t = typeof d.text === 'string' ? d.text : undefined;
  if (p?.trim()) return p;
  if (t?.trim()) return t;
  return p ?? t ?? '';
}

/** 正文写回补丁：两键同步（后端非音频节点读 prompt 优先，旧代码读 text）。 */
export function documentPatch(markdown: string): { text: string; prompt: string } {
  return { text: markdown, prompt: markdown };
}

/** 一条参考的精简快照（随 overrides 下发，宿主可按序取用，如给多模态 LLM 传图）。 */
export interface TextRefSnapshot {
  n: number;
  key: string;
  source_id: string;
  source_type?: string;
  type: RefItem['dataType'];
  value: string;
  label?: string;
}

/**
 * `execute(overrides)` 的键（REQ-toonflow-canvas H1 按此路由；也记在 progress/N1.md）。
 * - skill_id：技能；
 * - prompt：本次要处理的文本（已组装：指令中的 `{{ref N}}` → 「参考 N」，文本参考按 `参考 N：…` 附后；
 *   指令与文本参考都空时为当前正文）——宿主原分支读 `d.prompt || d.text`，无需改动即可工作；
 * - gen_prompt：原始指令（含 `{{ref N}}`）；source_text：执行前的正文；input_source：prompt 的来源；
 * - reference_images / reference_videos：图片 / 视频参考 URL（按参考顺序）；refs：完整参考快照。
 */
export interface TextExecuteOverrides extends Record<string, unknown> {
  skill_id: TextSkillId;
  prompt: string;
  gen_prompt: string;
  source_text: string;
  input_source: 'instruction' | 'refs' | 'document';
  reference_images: string[];
  reference_videos: string[];
  refs: TextRefSnapshot[];
}

export interface SkillRequestInput {
  skillId: unknown;
  /** data.gen_prompt */
  instruction: string;
  /** 当前正文 */
  document: string;
  refs: readonly RefItem[];
  refRoles?: Record<string, string> | null;
}

export interface SkillRequest {
  ok: boolean;
  /** 不能发送的原因（ok=false 时给发送按钮的提示） */
  reason?: string;
  skill: TextSkill;
  overrides: TextExecuteOverrides;
  /** 面板提示（空参考跳过、媒体参考不会使用、引用编号不存在…） */
  warnings: string[];
}

function names(ns: number[]): string {
  return ns.map((n) => refName(n)).join('、');
}

/** 组装一次技能执行（纯函数：节点、测试、宿主回放共用）。 */
export function buildSkillRequest(input: SkillRequestInput): SkillRequest {
  const skill = skillOf(input.skillId);
  const instruction = typeof input.instruction === 'string' ? input.instruction : '';
  const document = typeof input.document === 'string' ? input.document : '';
  const refs = input.refs;

  // REQ-toonflow-canvas 文本节点里所有文本参考（含 3D 导演机位）都进提示词，不分进 camera_prompt
  const roles: Record<string, string> = { ...(input.refRoles || {}) };
  for (const r of refs) if (r.dataType === 'STRING') roles[r.key] = 'prompt';
  const assembled = assembleInputs({ refs, targetType: 'prompt', prompt: instruction, refRoles: roles });

  const mentioned = [...new Set([...instruction.matchAll(REF_TOKEN_RE)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const missing = mentioned.filter((n) => n >= 1 && n <= refs.length && !refs[n - 1].value.trim());
  // 被指令引用却没内容的参考会阻止发送（同 Toonflow），不再重复显示 kit 的「已跳过」提示
  const warnings = assembled.warnings.filter((w) => !missing.some((n) => w.startsWith(`${refName(n)} 暂无内容`)));
  const dangling = mentioned.filter((n) => n < 1 || n > refs.length);
  if (dangling.length) warnings.push(`${names(dangling)} 不存在，请重新引用`);
  if (skill.textOnly) {
    const media = refs.map((r, i) => ({ r, n: i + 1 })).filter(({ r }) => r.dataType !== 'STRING' && r.value.trim()).map(({ n }) => n);
    if (media.length) warnings.push(`「${skill.label}」只处理文本，${names(media)} 不会使用`);
  }

  let prompt = assembled.prompt.trim() ? assembled.prompt : '';
  let source: TextExecuteOverrides['input_source'] = instruction.trim() ? 'instruction' : 'refs';
  if (!prompt && skill.documentFallback && document.trim()) {
    prompt = document;
    source = 'document';
  }

  let reason: string | undefined;
  if (missing.length) reason = `${names(missing)} 暂无内容，请先补充引用内容`;
  else if (!prompt) reason = skill.documentFallback ? '请输入提示词，或连接文本参考 / 先写正文' : '请输入提示词，或连接文本参考';
  if (missing.length) warnings.push(reason!);

  const overrides: TextExecuteOverrides = {
    skill_id: skill.id,
    prompt,
    gen_prompt: instruction,
    source_text: document,
    input_source: source,
    reference_images: [...assembled.reference_images],
    reference_videos: [...assembled.reference_video],
    refs: refs.map((r, i) => ({
      n: i + 1,
      key: r.key,
      source_id: r.sourceId,
      ...(r.sourceType ? { source_type: r.sourceType } : {}),
      type: r.dataType,
      value: r.value,
      ...(r.label ? { label: r.label } : {}),
    })),
  };
  return { ok: !reason, reason, skill, overrides, warnings: [...new Set(warnings)] };
}

/** agent_state 视为「运行中」：status=running 且 10 分钟内更新过（防止刷新页面后残留的 running 永远转圈）。 */
export const RUNNING_STALE_MS = 10 * 60 * 1000;

export function isRunningState(state: TextNodeData['agent_state'], now = Date.now()): boolean {
  if (!state || state.status !== 'running') return false;
  const at = state.updated_at ? Date.parse(state.updated_at) : NaN;
  return Number.isNaN(at) || now - at < RUNNING_STALE_MS;
}

/** 下载文件名：节点标题去掉非法字符。 */
export function markdownFileName(label: unknown): string {
  const printable = Array.from(typeof label === 'string' ? label : '', (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('');
  const base = printable.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || '文本'}.md`;
}
