/**
 * Agent 导演台统一类型 — 页面与抽屉的唯一数据模型
 * 旧实现里页面用 ToolStep{steps}、抽屉用 ToolCallItem{toolCalls}，两边字段/行为漂移；
 * 此文件为唯一口径，历史会话（steps/artifacts/errors/plan）与之兼容。
 */
export type AgentMode = 'chat' | 'execute';
export type RunMode = 'approve' | 'auto' | 'create' | 'plan';
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
