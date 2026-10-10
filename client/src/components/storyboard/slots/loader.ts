import { apiService } from '../../../services/api';
import { registerMode, unregisterMode } from './registry';
import { unregisterSource } from '../../../ui-registry/registry';
import { registerSlotEntry, SLOT_HOST_PREFIX } from '../../../ui-registry/adapters/storyboardSlots';
import type { UISource } from '../../../ui-registry/types';
import { registerDynamicMode, unregisterDynamicModes } from './modes';
import { PluginActionButton, PluginAnchor, PluginTab } from './PluginRender';
import type { ProductionMode, ShotSlotContext } from './types';

/**
 * 插件槽加载器（P1 → Phase 3 收敛后）：拉取后端有效槽聚合，把非 builtin 槽注册进**前端 UIRegistry**。
 *
 * 与收敛前的差别（行为等价、边界变严）：
 *   · 注册目标从 `slots/registry.ts` 的三个私有 Map 换成 UIRegistry 的 `studio.slot.*` 槽位
 *     （适配器 `ui-registry/adapters/storyboardSlots.ts`），与内置槽同一条管线；
 *   · 条目 id 带来源命名空间，**插件槽撞 id 不会再顶掉内置槽**（缺口 §2.5-2）；
 *   · 重载前按「本次登记的**来源**」精确反注册（`unregisterSource`，与后端插件
 *     disable/uninstall 的精确回滚对称 —— 设计 §3.2-1 / §6.4），
 *     内置槽由 builtin.tsx 登记一次、不再被动态清空波及。
 *   · `shot.modes` 仍留在本地模式注册表：它是数据（caps / 标题），不是可插拔 UI 区域。
 */

/**
 * 本次登记的动态条目**来源集合**（重载前按来源精确回滚）。
 * 走注册表的 `unregisterSource(source)` 而不是逐条 undo 函数：条目 id 已带来源命名空间，
 * 「按来源回滚」才是与后端精确回滚对称的那条语义（设计 §3.2-1、§6.4）。
 */
let appliedSources = new Set<UISource>();
let appliedModes: string[] = [];

export function matchSlotWhen(when: any, mode: ProductionMode): boolean {
  if (!when) return true;
  if (Array.isArray(when.mode) && !when.mode.includes(mode)) return false;
  if (Array.isArray(when.not_mode) && when.not_mode.includes(mode)) return false;
  return true;
}

/**
 * 槽来源 → UISource：用于条目 id 命名空间与**按来源批量回滚**（`clearDynamic()` 用它）。
 * 后端槽文档给的是 `source`（builtin/plugin/standalone…）+ `source_detail`（发布者/插件 id），
 * 这里一律归到 `plugin:<detail|source|unknown>`：非内置槽都当「外部贡献」处理，
 * 命名空间只要在提供方之间唯一即可，具体是不是插件包不影响注册表语义。
 *
 * 口径提醒（审查 L4-3）：`UISource` 契约只有 `builtin` / `plugin:<id>` 两种，所以 standalone 槽
 * 也落在 `plugin:` 前缀下 —— 注册表视图与标注里的「**外部来源**」（而非「插件来源」）才是准确说法。
 */
function sourceOf(doc: any): UISource {
  const detail = String(doc?.source_detail || doc?.source || 'unknown');
  return `plugin:${detail}` as UISource;
}

function clearDynamic() {
  // 作用域限定在 `studio.slot.*`（审查 L8）：只回滚本适配器登记的挂载点，
  // 不按来源字符串全局删 —— 否则别的模块用同一个 plugin:<id> 作来源时会被顺带清掉。
  appliedSources.forEach((src) => unregisterSource(src, SLOT_HOST_PREFIX));
  appliedSources = new Set();
  for (const id of appliedModes) unregisterMode(id as ProductionMode);
  unregisterDynamicModes(appliedModes);
  appliedModes = [];
}

export async function syncStoryboardSlots(projectId?: string): Promise<{ total: number; dynamic: number }> {
  const res = await apiService.listStoryboardSlots(projectId);
  const slots: any[] = res?.slots || [];
  clearDynamic();
  let dynamic = 0;
  for (const doc of slots) {
    if (!doc || doc.valid === false) continue;
    if (doc.source === 'builtin') continue; // 内置槽由 builtin.tsx 登记，动态侧不碰
    const id = String(doc.id || '');
    if (!id) continue;
    const src = sourceOf(doc);
    if (doc.slot === 'shot.tabs') {
      registerSlotEntry('tabs', {
        id, order: Number(doc.order ?? 50),
        icon: String(doc.icon || '🧩'), color: String(doc.color || 'text-teal-400'),
        label: () => String(doc.label || id),
        when: (ctx: ShotSlotContext) => matchSlotWhen(doc.when, ctx.productionMode),
        render: (ctx: ShotSlotContext) => PluginTab({ ctx, doc }),
      } as any, src);
      appliedSources.add(src);
      dynamic++;
    } else if (doc.slot === 'shot.anchors') {
      registerSlotEntry('anchors', {
        id, order: Number(doc.order ?? 50),
        when: (ctx: ShotSlotContext) => matchSlotWhen(doc.when, ctx.productionMode),
        render: (ctx: ShotSlotContext) => PluginAnchor({ ctx, doc }),
      } as any, src);
      appliedSources.add(src);
      dynamic++;
    } else if (doc.slot === 'shot.actions') {
      registerSlotEntry('actions', {
        id, order: Number(doc.order ?? 50),
        when: (ctx: ShotSlotContext) => matchSlotWhen(doc.when, ctx.productionMode),
        render: (ctx: ShotSlotContext) => PluginActionButton({ ctx, doc }),
      } as any, src);
      appliedSources.add(src);
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
