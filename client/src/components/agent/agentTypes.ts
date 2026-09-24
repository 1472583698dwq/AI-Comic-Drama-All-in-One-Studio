/**
 * Agent 导演台统一类型 — 页面与抽屉的唯一数据模型
 * 旧实现里页面用 ToolStep{steps}、抽屉用 ToolCallItem{toolCalls}，两边字段/行为漂移；
 * 此文件为唯一口径，历史会话（steps/artifacts/errors/plan）与之兼容。
 */
export type AgentMode = 'chat' | 'execute';
/** 组合 token：行为 × 执行，wire/持久化的唯一口径（与后端 app/agent/mode_policy.py 一一对应） */
export type RunMode = 'approve' | 'auto' | 'create' | 'create_auto' | 'plan' | 'plan_auto';
/** 行为维：能干什么（standard 标准 / create 创造 / plan 计划只读），代码硬门控 */
export type BehaviorMode = 'standard' | 'create' | 'plan';
/** 执行维：要不要逐项人审（approve 审批 / auto 自动） */
export type ExecutionMode = 'approve' | 'auto';

export const RUN_MODES: RunMode[] = ['approve', 'auto', 'create', 'create_auto', 'plan', 'plan_auto'];

/** 旧值 / 口语值 → 组合 token（与后端 normalize_run_mode 的别名表同口径） */
const RUN_MODE_ALIASES: Record<string, RunMode> = {
  supervisor: 'approve', approval: 'approve', ask: 'approve',
  standard: 'approve', normal: 'approve', default: 'approve',
  automation: 'auto', automatic: 'auto', never: 'auto', yolo: 'auto',
  creator: 'create', creation: 'create', creative: 'create',
  planning: 'plan', plan_mode: 'plan', readonly: 'plan',
  'create-auto': 'create_auto', 'create+auto': 'create_auto', 'create:auto': 'create_auto',
  createauto: 'create_auto', creator_auto: 'create_auto', auto_create: 'create_auto',
  'plan-auto': 'plan_auto', 'plan+auto': 'plan_auto', 'plan:auto': 'plan_auto',
  planauto: 'plan_auto', auto_plan: 'plan_auto',
};

export function normalizeRunMode(value?: string | null): RunMode {
  const s = String(value ?? '').trim().toLowerCase() || 'approve';
  const t = (RUN_MODE_ALIASES[s] || s) as RunMode;
  return RUN_MODES.includes(t) ? t : 'approve';
}

/** 行为维：standard / create / plan */
export function behaviorOfRunMode(value?: string | null): BehaviorMode {
  const m = normalizeRunMode(value);
  if (m.startsWith('plan')) return 'plan';
  if (m.startsWith('create')) return 'create';
  return 'standard';
}

/** 执行维：approve / auto */
export function executionOfRunMode(value?: string | null): ExecutionMode {
  return normalizeRunMode(value).endsWith('auto') ? 'auto' : 'approve';
}

/** 行为 × 执行 → 组合 token（UI 两个选择器的唯一合成口径） */
export function composeRunMode(behavior?: string | null, execution?: string | null): RunMode {
  const b = behavior === 'plan' || behavior === 'create' ? behavior : 'standard';
  const e = execution === 'auto' ? 'auto' : 'approve';
  if (b === 'plan') return e === 'auto' ? 'plan_auto' : 'plan';
  if (b === 'create') return e === 'auto' ? 'create_auto' : 'create';
  return e === 'auto' ? 'auto' : 'approve';
}
export type ToolStatus = 'executing' | 'completed' | 'error';
export type SideEffect =
  | { type: 'provider_refresh' }
  | { type: 'skill_refresh' }
  | { type: 'plugin_refresh' }
  | { type: 'template_refresh' }
  | { type: 'canvas_tool'; tool: string; status: string; result?: any; error?: string }
  | { type: 'canvas_updated'; tool: string };

export interface ToolStep {
  id: string;
  name: string;
  status: ToolStatus;
  result?: any;
  error?: string;
}

export interface AgentArtifact {
  kind: 'image' | 'video' | 'audio';
  url: string;
  tool: string;
  label: string;
  applied?: boolean;
}

export interface AgentErrorCard {
  tool: string;
  what: string;
  why: string;
  next: string;
}

export interface ChatMsg {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  thinking?: string;
  isThinkingStreaming?: boolean;
  isStreaming?: boolean;
  steps?: ToolStep[];
  suggested?: string[];
  mode?: AgentMode;
  time: string;
  plan?: PlanPreview | null;
  planConfirmed?: boolean;
  /** 该消息来自 Plan Mode 规划运行（只读侦察产出 markdown 计划） */
  planMode?: boolean;
  /** 该计划已批准并进入执行 */
  planExecuted?: boolean;
  artifacts?: AgentArtifact[];
  errors?: AgentErrorCard[];
}

export interface AgentSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMsg[];
  mode?: AgentMode;
  run_mode?: RunMode;
}

/** 后端 WS/SSE 事件（字段因事件而异，统一收口） */
export interface AgentEvent {
  event: string;
  message?: string;
  delta?: string;
  tool_name?: string;
  status?: string;
  result?: any;
  error?: string;
  approval_id?: string;
  approved?: boolean;
  arguments?: Record<string, any>;
  thinking?: string | null;
  suggested_actions?: string[];
  [k: string]: any;
}

export interface ApprovalInfo {
  tool_name: string;
  args: Record<string, any>;
  decided?: boolean;
}

export type WsStatus = 'connecting' | 'open' | 'closed';

// ── 执行计划 / Creator 提案（AgentCards 复用同一口径） ──
export interface PlanStep {
  id: string;
  title: string;
  tool: string;
  args_preview?: Record<string, any>;
  risk: string;
  est_s: number;
  target?: string;
}

export interface CreatorProposal {
  proposal_id: string;
  kind: string;
  title: string;
  goal?: string;
  diff_preview: string;
  test_plan: string[];
  risk: string;
  reversible: string;
  status: string;
}

export interface PlanPreview {
  intent: string;
  label: string;
  confidence: string;
  risk: string;
  reason?: string;
  steps: PlanStep[];
  needs_confirm: boolean;
  est_total_s: number;
  autonomy_hint?: string;
  run_mode?: string;
  creator_proposal?: CreatorProposal;
}
