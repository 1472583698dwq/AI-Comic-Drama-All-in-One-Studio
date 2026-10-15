// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 视频任务重启恢复（沿用 MiniMax 的 `_taskId` / `_polling` 落盘约定）。
 *
 * 生成时 nodeAgentExecutor / useGeneration 在拿到 task_id 后先写 `{_taskId, _polling: true}` 再轮询；
 * 页面刷新 / 重启后节点挂载时若仍是 `_polling && _taskId`，自动接着 pollVideoTask，出片后写回
 * `video_url` + 历史 + agent_state（同旧逻辑的回写键）。宿主若在加载时把 `_polling` 复位成 false（旧 CreativeCanvas 行为），
 * 节点仍保留 `_taskId`，可点「重新查询任务」手动恢复。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pollVideoTask } from '../../../../utils/videoTask';
import { appendHistory } from '../../kit/useGeneration';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 节点上保留的视频任务 id（`_taskId`，旧数据回落 `_last_agent_plan.task_id`）。 */
export function taskIdOf(data: Record<string, unknown> | null | undefined): string {
  const d = data || {};
  const plan = d._last_agent_plan as Record<string, unknown> | undefined;
  return str(d._taskId) || str(plan?.task_id);
}

/** 挂载时是否应自动恢复轮询。 */
export function shouldResume(data: Record<string, unknown> | null | undefined): boolean {
  return !!data && data._polling === true && !!taskIdOf(data);
}

export interface TaskRecovery {
  recovering: boolean;
  resume: (taskId?: string) => void;
  stop: () => void;
}

export function useVideoTaskRecovery(
  nodeId: string,
  data: Record<string, unknown>,
  update: (patch: Record<string, unknown>) => void,
): TaskRecovery {
  const [recovering, setRecovering] = useState(false);
  const tokenRef = useRef(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const updateRef = useRef(update);
  updateRef.current = update;

  const resume = useCallback((taskIdArg?: string) => {
    const d0 = dataRef.current;
    const taskId = taskIdArg || taskIdOf(d0);
    if (!taskId) return;
    const token = ++tokenRef.current;
    const providerId = str(d0.provider_id) || str(d0.provider) || str((d0.agent_state as Record<string, unknown> | undefined)?.provider_id) || undefined;
    const at = () => new Date().toISOString();
    setRecovering(true);
    updateRef.current({
      _taskId: taskId,
      _polling: true,
      agent_state: { status: 'running', tool: 'video_task', provider_id: providerId, updated_at: at() },
    });
    pollVideoTask(taskId)
      .then((url) => {
        if (token !== tokenRef.current) return;
        const d = dataRef.current;
        updateRef.current({
          video_url: url,
          _polling: false,
          history: appendHistory(d.history, { url, created_at: at(), provider_id: providerId, prompt: str(d.polished_prompt) || str(d.prompt) || undefined }),
          agent_state: { status: 'completed', tool: 'video_task', provider_id: providerId, updated_at: at() },
        });
      })
      .catch((e: unknown) => {
        if (token !== tokenRef.current) return;
        updateRef.current({
          _polling: false,
          agent_state: { status: 'failed', tool: 'video_task', provider_id: providerId, error: String((e as Error)?.message || e).slice(0, 220), updated_at: at() },
        });
      })
      .finally(() => {
        if (token === tokenRef.current) setRecovering(false);
      });
  }, []);

  const stop = useCallback(() => {
    tokenRef.current++;
    setRecovering(false);
  }, []);

  // 挂载即恢复（节点 id 变化视为新节点）；卸载时丢弃结果
  useEffect(() => {
    if (shouldResume(dataRef.current)) resume();
    return () => { tokenRef.current++; };
  }, [nodeId, resume]);

  return { recovering, resume, stop };
}
