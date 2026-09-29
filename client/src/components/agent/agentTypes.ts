/**
 * Agent 导演台统一类型 — 页面与抽屉的唯一数据模型
 * 旧实现里页面用 ToolStep{steps}、抽屉用 ToolCallItem{toolCalls}，两边字段/行为漂移；
 * 此文件为唯一口径，历史会话（steps/artifacts/errors/plan）与之兼容。
 */
export type AgentMode = 'chat' | 'execute';
/** 行为模式：能干什么（standard 标准 / create 创造 / plan 计划-只读），与执行方式正交 */
export type BehaviorMode = 'standard' | 'create' | 'plan';
/** 执行方式：要不要逐项人审（approve 审批 / auto 自动执行） */
export type ExecutionMode = 'approve' | 'auto';
/** 组合后的运行模式 token（wire 与持久化口径；plan 只读，plan_auto 与 plan 等价仅为往返） */
export type RunMode = 'approve' | 'auto' | 'create' | 'create_auto' | 'plan' | 'plan_auto';

export function behaviorOfRunMode(r?: RunMode | string): BehaviorMode {
  const s = String(r || 'approve').trim().toLowerCase();
  if (s.startsWith('plan') || s.startsWith('planning') || s.startsWith('readonly')) return 'plan';
  if (s.startsWith('create') || s.startsWith('creator') || s.startsWith('creation') || s.startsWith('creative')) return 'create';
  return 'standard';
}

export function executionOfRunMode(r?: RunMode | string): ExecutionMode {
  const s = String(r || 'approve').trim().toLowerCase();
  return s.endsWith('auto') || s === 'yolo' || s === 'never' || s === 'automation' || s === 'automatic'
    ? 'auto'
    : 'approve';
}

export function composeRunMode(b: BehaviorMode, e: ExecutionMode): RunMode {
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
  /** 调用参数（tool_calling 事件携带，用于行内卡展开查看） */
  args?: Record<string, any>;
  /** 调用开始时间戳（ms） */
  startedAt?: number;
  /** 耗时（ms，tool_result 回填） */
  elapsedMs?: number;
  /** 工具执行中的阶段进度（tool_progress 事件透出，如「正在调用 LLM 生成源代码…」） */
  note?: string;
}

export interface AgentTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 子代理集群：父会话可见的并行子代理状态（subagent_* 事件驱动，Kimi 式 roster） */
export interface SubAgentInfo {
  id: string;
  /** 角色名（generalist/screenwriter/character_designer/...） */
  agent: string;
  /** 子任务描述（截断展示） */
  task: string;
  /** queued | running | success | error | cancelled */
  status: string;
  startedAt?: number;
  elapsedMs?: number;
  /** 最近一次工具调用名（进度闪烁） */
  tool?: string;
  /** 批次 ID（同批并行的子代理归为一组展示） */
  batchId?: string;
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
  /** 待办清单（todo_write 事件实时更新） */
  todo?: AgentTodoItem[];
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
  /** 审批请求到达时间戳（ms），用于 120s 自动拒绝倒计时 */
  createdAt?: number;
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
