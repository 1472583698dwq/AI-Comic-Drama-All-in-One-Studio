// -*- coding: utf-8 -*-
/**
 * 统一导演 Agent Hook — 单一调度入口
 * 所有导演能力（3D 舞台/节点/全局 Agent）均走此 Hook，底层唯一 MCP：director_3d_stage_plan
 * 输入：ai_directive + framing/motion/pose 等显式参数
 * 输出：minimax_camera_prompt / camera 结构化数据
 */
import { useState, useCallback } from 'react';
import { apiService } from '../../../services/api';

export interface DirectorAgentInput {
  ai_directive?: string;
  framing?: string;
  motion?: string;
  pose?: string;
  focal_length_mm?: number;
  camera_roll_deg?: number;
  cast_layout?: string;
  speed?: string;
}

export interface DirectorAgentResult {
  minimax_camera_prompt?: string;
  framing?: string;
  motion?: string;
  [k: string]: any;
}

export function useDirectorAgent() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DirectorAgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (input: DirectorAgentInput): Promise<DirectorAgentResult> => {
    setLoading(true);
    setError(null);
    try {
      const res: any = await apiService.callMcpTool('director_3d_stage_plan', {
        ai_directive: input.ai_directive || '',
        framing: input.framing || 'medium',
        motion: input.motion || 'push_in',
        pose: input.pose || 'stand',
        focal_length_mm: input.focal_length_mm ?? 35,
        camera_roll_deg: input.camera_roll_deg ?? 0,
        cast_layout: input.cast_layout || 'solo',
        speed: input.speed || '1.0x',
      });
      const r = (res as any)?.result || res;
      if (r?.error) throw new Error(r.error);
      const out: DirectorAgentResult = {
        minimax_camera_prompt: r.minimax_camera_prompt || r.camera_prompt || JSON.stringify(r).slice(0, 300),
        ...r,
      };
      setResult(out);
      return out;
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  return { execute, loading, result, error, setResult };
}
