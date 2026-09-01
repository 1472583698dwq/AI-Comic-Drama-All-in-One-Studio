// -*- coding: utf-8 -*-
/**
 * Per-Node Agent 执行器 Hook — 与 nodeAgentExecutor 统一口径
 * 节点内按钮 / AgentBar 生成按钮 / 外部调用 全部经 MCP provider_xxx（含视频轮询与 agent_state 回写）
 */
import { useState, useCallback } from 'react';
import { useCanvasStore } from '../../../stores/useCanvasStore';
import { executeAgentNode, AgentState } from './nodeAgentExecutor';

export function useNodeExecution(nodeId: string) {
  const [executing, setExecuting] = useState<boolean>(
    () => (useCanvasStore.getState().nodes.find((n: any) => n.id === nodeId)?.data as any)?.agent_state?.status === 'running'
  );
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
  const agentState: AgentState | undefined = (node?.data as any)?.agent_state;

  const execute = useCallback(async (overridePrompt?: string) => {
    const cur = useCanvasStore.getState().nodes.find((n: any) => n.id === nodeId) as any;
    if (!cur) return;
    const override: Record<string, any> = {};
    if (overridePrompt !== undefined) { override.prompt = overridePrompt; override.text = overridePrompt; }
    setExecuting(true);
    try {
      return await executeAgentNode({ node: cur, override, updateNodeData });
    } finally {
      setExecuting(false);
    }
  }, [nodeId, updateNodeData]);

  return {
    execute,
    executing,
    agentState,
    hasProvider: !!((node?.data as any)?.provider_id || (node?.data as any)?.provider),
  };
}
