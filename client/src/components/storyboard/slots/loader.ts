import { apiService } from '../../../services/api';
import { actionRegistry, anchorRegistry, registerMode, tabRegistry, unregisterMode } from './registry';
import { registerDynamicMode, unregisterDynamicModes } from './modes';
import { PluginActionButton, PluginAnchor, PluginTab } from './PluginRender';
import type { ProductionMode, ShotSlotContext } from './types';

/**
 * 插件槽加载器（P1）：拉取后端有效槽聚合，注册非 builtin 槽。
 * - 内置槽（source=builtin）跳过（builtin.tsx 已注册）；
 * - 插件/裸件槽按 container 注册通用渲染；
 * - modes 同步数据（caps）+ 渲染继承；
 * - 记录本次动态 id，重载前精确卸载（注册即 effect）。
 */

let appliedTabs: string[] = [];
let appliedAnchors: string[] = [];
let appliedActions: string[] = [];
let appliedModes: string[] = [];

export function matchSlotWhen(when: any, mode: ProductionMode): boolean {
  if (!when) return true;
  if (Array.isArray(when.mode) && !when.mode.includes(mode)) return false;
  if (Array.isArray(when.not_mode) && when.not_mode.includes(mode)) return false;
  return true;
}

function clearDynamic() {
  for (const id of appliedTabs) tabRegistry.unregister(id);
  for (const id of appliedAnchors) anchorRegistry.unregister(id);
  for (const id of appliedActions) actionRegistry.unregister(id);
  for (const id of appliedModes) unregisterMode(id as ProductionMode);
  unregisterDynamicModes(appliedModes);
  appliedTabs = [];
  appliedAnchors = [];
  appliedActions = [];
  appliedModes = [];
}

export async function syncStoryboardSlots(projectId?: string): Promise<{ total: number; dynamic: number }> {
  const res = await apiService.listStoryboardSlots(projectId);
  const slots: any[] = res?.slots || [];
  clearDynamic();
  let dynamic = 0;
  for (const doc of slots) {
    if (!doc || doc.valid === false) continue;
    if (doc.source === 'builtin') continue;
    const id = String(doc.id || '');
    if (!id) continue;
    if (doc.slot === 'shot.tabs') {
      tabRegistry.register({
        id, order: Number(doc.order ?? 50),
        icon: String(doc.icon || '🧩'), color: String(doc.color || 'text-teal-400'),
        label: () => String(doc.label || id),
        when: (ctx: ShotSlotContext) => matchSlotWhen(doc.when, ctx.productionMode),
        render: (ctx: ShotSlotContext) => PluginTab({ ctx, doc }),
      } as any);
      appliedTabs.push(id);
      dynamic++;
    } else if (doc.slot === 'shot.anchors') {
      anchorRegistry.register({
        id, order: Number(doc.order ?? 50),
        when: (ctx: ShotSlotContext) => matchSlotWhen(doc.when, ctx.productionMode),
        render: (ctx: ShotSlotContext) => PluginAnchor({ ctx, doc }),
      } as any);
      appliedAnchors.push(id);
      dynamic++;
    } else if (doc.slot === 'shot.actions') {
      actionRegistry.register({
        id, order: Number(doc.order ?? 50),
        when: (ctx: ShotSlotContext) => matchSlotWhen(doc.when, ctx.productionMode),
        render: (ctx: ShotSlotContext) => PluginActionButton({ ctx, doc }),
      } as any);
      appliedActions.push(id);
      dynamic++;
    } else if (doc.slot === 'shot.modes') {
      registerMode({
        id: id as ProductionMode,
        label: String(doc.label || id),
        desc: String(doc.description || ''),
        order: Number(doc.order ?? 50),
        caps: { ...doc.caps },
        inspectorTitle: String(doc.label || id),
      });
      registerDynamicMode(doc);
      appliedModes.push(id);
      dynamic++;
    }
  }
  return { total: slots.length, dynamic };
}
