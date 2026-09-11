import { useState } from 'react';
import type { ShotSlotContext } from './types';
import { apiService } from '../../../services/api';

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

const STORE_ACTIONS: Record<string, { label: string; run: (ctx: ShotSlotContext) => void }> = {
  synthesizeShotPrompt: { label: '全要素合成', run: (ctx) => ctx.synthesizeShotPrompt(ctx.activeShot.id) },
  autoFitShotDuration: { label: '智能吸附时长', run: (ctx) => ctx.autoFitShotDuration(ctx.activeShot.id) },
};

export function useRunSlotAction(ctx: ShotSlotContext) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const run = async (runSpec: any) => {
    if (!runSpec) return;
    if (runSpec.store_action) {
      const fn = STORE_ACTIONS[runSpec.store_action];
      if (!fn) { setResult(`未知 store_action: ${runSpec.store_action}`); return; }
      try { fn.run(ctx); setResult('✓ 已执行'); } catch (e: any) { setResult(`✗ ${e?.message || e}`); }
      return null;
    }
    if (runSpec.extension) {
      setRunning(true);
      setResult(null);
      try {
        const args = substituteTpl(runSpec.args || {}, ctx.activeShot, ctx.project?.id);
        const res: any = await apiService.executeExtension(runSpec.extension, args);
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
