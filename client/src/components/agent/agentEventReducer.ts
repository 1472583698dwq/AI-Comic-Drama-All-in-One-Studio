/**
 * Agent 事件归约器 — WS 与 SSE 共用同一份逻辑（旧实现两处各写一遍导致功能漂移）
 * 纯函数：输入消息 + 事件 → 输出新消息 + 副作用清单（画布/生成源/技能刷新等）
 */
import type { AgentEvent, ChatMsg, SideEffect, ToolStep } from './agentTypes';
import { extractArtifact, toStructuredError } from './businessIntents';

let seq = 0;
function stepId() {
  seq += 1;
  return `s${Date.now().toString(36)}_${seq}`;
}

function appendText(text: string, extra: string): string {
  return text ? `${text}\n\n${extra}` : extra;
}

export interface ReduceResult {
  msg: ChatMsg;
  sideEffects: SideEffect[];
}

/**
 * 归约单个事件到指定消息。非消息事件（approval_ack）由调用方处理。
 * 未知事件原样返回。
 */
export function reduceAgentEvent(msg: ChatMsg, ev: AgentEvent): ReduceResult {
  const sideEffects: SideEffect[] = [];
  switch (ev.event) {
    case 'agent_thinking':
      return {
        msg: {
          ...msg,
          isThinkingStreaming: true,
          thinking: (msg.thinking ? `${msg.thinking}\n` : '') + (ev.message || ''),
        },
        sideEffects,
      };
    case 'agent_thinking_start':
      return { msg: { ...msg, isThinkingStreaming: true, thinking: msg.thinking || '' }, sideEffects };
    case 'agent_thinking_chunk':
      return {
        msg: { ...msg, isThinkingStreaming: true, thinking: (msg.thinking || '') + (ev.delta || '') },
        sideEffects,
      };
    case 'agent_thinking_end':
      return { msg: { ...msg, isThinkingStreaming: false }, sideEffects };
    case 'agent_stream_start':
      return { msg: { ...msg, isThinkingStreaming: false, isStreaming: true }, sideEffects };
    case 'agent_stream_chunk':
      return {
        msg: { ...msg, isThinkingStreaming: false, isStreaming: true, text: msg.text + (ev.delta || '') },
        sideEffects,
      };
    case 'tool_progress': {
      // 工具执行中阶段进度（如 register_custom_provider 的 LLM 生成代码阶段）→ 挂到执行中步骤上
      const target = ev.tool_name || ev.tool || '';
      const steps: ToolStep[] = (msg.steps || []).map((s) =>
        s.name === target && s.status === 'executing'
          ? { ...s, note: String(ev.text || ev.message || '').slice(0, 200) }
          : s
      );
      return { msg: { ...msg, steps }, sideEffects };
    }
    case 'tool_calling': {
      const step: ToolStep = {
        id: stepId(),
        name: ev.tool_name || 'tool',
        status: 'executing',
        args: (ev.arguments || ev.args) && typeof (ev.arguments || ev.args) === 'object' ? (ev.arguments || ev.args) : undefined,
        startedAt: Date.now(),
      };
      return { msg: { ...msg, steps: [...(msg.steps || []), step] }, sideEffects };
    }
    case 'tool_result': {
      const steps: ToolStep[] = (msg.steps || []).map((s) =>
        s.name === ev.tool_name && s.status === 'executing'
          ? {
              ...s,
              status: (ev.status === 'success' ? 'completed' : 'error') as ToolStep['status'],
              result: ev.result,
              error: ev.error,
              elapsedMs: s.startedAt ? Date.now() - s.startedAt : undefined,
            }
          : s
      );
      let artifacts = msg.artifacts || [];
      let errors = msg.errors || [];
      let plan = msg.plan;
      try {
        if (ev.status === 'success' && ev.result) {
          const r = ev.result as any;
          const prop = r?.proposal || (r?.proposal_id ? r : null);
          if ((ev.tool_name === 'creator_propose_capability' || String(ev.tool_name || '').startsWith('creator_')) && prop?.proposal_id) {
            plan = { ...(plan as any), creator_proposal: prop } as any;
          } else {
            const a = extractArtifact(ev.tool_name || '', ev.result);
            if (a) artifacts = [...artifacts, { ...a }];
          }
        } else if (ev.status !== 'success') {
          const se = toStructuredError(ev.tool_name || '', ev.error || '执行失败');
          errors = [...errors, { tool: ev.tool_name || '', ...se }];
        }
      } catch {}
      // 与业务联动的刷新副作用（两端统一，旧版只有抽屉发这些事件）
      const name = String(ev.tool_name || '');
      if (name === 'register_custom_provider' && ev.status === 'success') sideEffects.push({ type: 'provider_refresh' });
      if (name === 'creator_finalize') sideEffects.push({ type: 'skill_refresh' });
      if (name.startsWith('canvas_')) {
        sideEffects.push({ type: 'canvas_tool', tool: name, status: ev.status || '', result: ev.result, error: ev.error });
        sideEffects.push({ type: 'canvas_updated', tool: name });
      }
      if (name.startsWith('stage_') && ev.status === 'success' && ((ev.result as any)?.stage_patch || (ev.result as any)?.created_shot)) {
        const r = ev.result as any;
        if (r.stage_patch && Object.keys(r.stage_patch).length > 0) {
          sideEffects.push({ type: 'stage_patch', tool: name, shot_id: r.shot_id, shot_index: r.shot_index, patch: r.stage_patch, project_id: r.project_id });
        }
        if (r.created_shot) {
          sideEffects.push({ type: 'stage_patch', tool: name, shot_id: r.shot_id, shot_index: r.shot_index, patch: {}, created_shot: r.created_shot, project_id: r.project_id });
        }
      }
      if (name === 'split_novel_script' && ev.status === 'success' && (ev.result as any)?.persisted) {
        sideEffects.push({ type: 'project_refresh', tool: name });
      }
      return { msg: { ...msg, steps, artifacts, errors, plan }, sideEffects };
    }
    case 'todo_write': {
      const items = Array.isArray(ev.items) ? ev.items.filter((t: any) => t && typeof t.content === 'string') : [];
      return { msg: { ...msg, todo: items }, sideEffects };
    }
    case 'agent_response':
      return {
        msg: {
          ...msg,
          text: ev.message || msg.text,
          thinking: ev.thinking !== undefined ? (ev.thinking || msg.thinking) : msg.thinking,
          suggested: ev.suggested_actions,
          isThinkingStreaming: false,
          isStreaming: false,
        },
        sideEffects,
      };
    case 'error':
      return {
        msg: { ...msg, isThinkingStreaming: false, isStreaming: false, text: appendText(msg.text, `⚠️ ${ev.message}`) },
        sideEffects,
      };
    default:
      return { msg, sideEffects };
  }
}

/** 工具结果里的产物/错误卡（非流式 REST 兜底路径复用同一口径） */
export function collectFromExecutedTools(executed: any[]): {
  steps: ToolStep[];
  artifacts: ChatMsg['artifacts'];
  errors: ChatMsg['errors'];
} {
  const steps: ToolStep[] = [];
  const artifacts: NonNullable<ChatMsg['artifacts']> = [];
  const errors: NonNullable<ChatMsg['errors']> = [];
  for (const t of executed || []) {
    steps.push({
      id: stepId(),
      name: t.tool_name,
      status: t.status === 'success' ? 'completed' : 'error',
      result: t.result,
      error: t.error,
      args: t.arguments && typeof t.arguments === 'object' ? t.arguments : undefined,
    });
    try {
      if (t.status === 'success' && t.result) {
        const a = extractArtifact(t.tool_name, t.result);
        if (a) artifacts.push({ ...a });
      } else if (t.status !== 'success') {
        const se = toStructuredError(t.tool_name, t.error || '执行失败');
        errors.push({ tool: t.tool_name, ...se });
      }
    } catch {}
  }
  return { steps, artifacts, errors };
}

export function dispatchSideEffects(sideEffects: SideEffect[]) {
  for (const se of sideEffects) {
    try {
      switch (se.type) {
        case 'provider_refresh':
          window.dispatchEvent(new Event('provider-list-refresh'));
          break;
        case 'skill_refresh':
          window.dispatchEvent(new Event('skill-list-refresh'));
          break;
        case 'plugin_refresh':
          window.dispatchEvent(new Event('plugin-list-refresh'));
          break;
        case 'template_refresh':
          window.dispatchEvent(new Event('creator-template-refresh'));
          break;
        case 'canvas_tool':
          window.dispatchEvent(new CustomEvent('agent-canvas-tool', { detail: { tool: se.tool, status: se.status, result: se.result, error: se.error } }));
          break;
        case 'canvas_updated':
          window.dispatchEvent(new CustomEvent('agent-canvas-updated', { detail: { tool: se.tool } }));
          break;
        case 'stage_patch':
          window.dispatchEvent(new CustomEvent('agent-stage-patch', {
            detail: { tool: se.tool, shot_id: se.shot_id, shot_index: se.shot_index, patch: se.patch, created_shot: se.created_shot, project_id: se.project_id },
          }));
          break;
        case 'project_refresh':
          window.dispatchEvent(new CustomEvent('agent-project-refresh', { detail: { tool: se.tool } }));
          break;
      }
    } catch {}
  }
}
