import { useState } from 'react';
import type { ShotSlotContext } from './types';
import { apiService } from '../../../services/api';
import { useProjectStore } from '../../../stores/useProjectStore';

/**
 * 插件槽运行辅助（非组件，SlotOutlet/通用渲染器消费）。
 * 模板变量：{{shot.<字段>}}、{{project.id}}；
 * 执行走 /extensions/execute 或白名单 store_action。
 */

export function substituteTpl(tpl: any, shot: any, projectId?: string): any {
  if (typeof tpl === 'string') {
    return tpl
      .replace(/\{\{\s*project\.id\s*\}\}/g, projectId || '')
      .replace(/\{\{\s*shot\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, f) => {
        const v = shot?.[f];
        if (v === null || v === undefined) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      });
  }
  if (Array.isArray(tpl)) return tpl.map((x) => substituteTpl(x, shot, projectId));
  if (tpl && typeof tpl === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = substituteTpl(v, shot, projectId);
    return out;
  }
  return tpl;
}

const STORE_ACTIONS: Record<string, { label: string; run: (ctx: ShotSlotContext, args: Record<string, any>) => void }> = {
  synthesizeShotPrompt: { label: '合成提示词', run: (ctx) => ctx.synthesizeShotPrompt(ctx.activeShot.id) },
  autoFitShotDuration: {
    label: '智能吸附时长',
    run: (ctx, args) => {
      const p = Number(args?.padding);
      ctx.autoFitShotDuration(ctx.activeShot.id, Number.isFinite(p) ? p : undefined);
    },
  },
  autoFitAllDurations: {
    label: '全局吸附时长',
    run: (_ctx, args) => {
      const p = Number(args?.padding);
      useProjectStore.getState().autoFitAllDurations(Number.isFinite(p) ? p : undefined);
    },
  },
  selectCandidate: {
    label: '选定候选',
    run: (ctx, args) => {
      const idx = Number(args?.candidate_index);
      if (!Number.isFinite(idx) || idx < 0) {
        throw new Error('selectCandidate 需 args.candidate_index（候选序号，从 0 起）');
      }
      ctx.selectCandidate(ctx.activeShot.id, idx);
    },
  },
};

export function useRunSlotAction(ctx: ShotSlotContext) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const run = async (runSpec: any) => {
    if (!runSpec) return;
    if (runSpec.store_action) {
      const fn = STORE_ACTIONS[runSpec.store_action];
      if (!fn) { setResult(`未知 store_action: ${runSpec.store_action}`); return; }
      try {
        fn.run(ctx, substituteTpl(runSpec.args || {}, ctx.activeShot, ctx.project?.id));
        setResult('✓ 已执行');
      } catch (e: any) { setResult(`✗ ${e?.message || e}`); }
      return null;
    }
    if (runSpec.extension) {
      setRunning(true);
      setResult(null);
      try {
        const args = substituteTpl(runSpec.args || {}, ctx.activeShot, ctx.project?.id);
        // 携带项目作用域：项目级停用/审计在统一执行口与引擎级 guard 一并生效
        const res: any = await apiService.executeExtension(runSpec.extension, args, undefined, ctx.project?.id);
        setResult(null);
        return res;
      } catch (e: any) {
        setResult(`✗ ${e?.message || e}`);
        return null;
      } finally {
        setRunning(false);
      }
    }
    return null;
  };
  return { running, result, setResult, run };
}
