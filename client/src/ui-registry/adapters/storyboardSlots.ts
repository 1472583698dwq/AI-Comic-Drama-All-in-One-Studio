import { useEffect } from 'react';
import { register } from '../registry';
import { useUIEntries } from '../resolveEnabled';
import type { UIEntry, UISource } from '../types';
import type {
  ActionDef, AnchorDef, ShotSlotContext, TabDef,
} from '../../components/storyboard/slots/types';

/**
 * **分镜槽 DSL → UIRegistry 适配器**（设计 §4 Phase 3：插件 DSL 槽与内置条目收敛到同一条渲染管线）。
 *
 * 收敛前：内置槽在 `slots/builtin.tsx` 里注册进 `slots/registry.ts` 的三个私有 Map，
 * 插件槽由 `slots/loader.ts` 往同一批 Map 写 —— 于是「插件槽与内置槽」共用一套注册表，
 * **但没有 id 命名空间隔离**：插件用同 id 会直接顶掉内置槽（缺口 §2.5-2，
 * 且 `clearDynamic()` 卸载时会把被顶掉的内置槽一起带走，永久消失）。
 *
 * 收敛后：
 *   · 内置槽与插件槽都注册成 **UIEntry**（host = `studio.slot.tabs|anchors|actions`）；
 *   · 条目 id 分命名空间（`slot.<kind>.builtin.<id>` / `slot.<kind>.plugin:<pid>.<id>`），
 *     插件槽再怎么撞 id 也顶不掉内置槽 —— 缺口 §2.5-2 由此修掉；
 *   · **同 localId 去重（审查 M2）**：命名空间只加在 `entry.id` 上，而宿主是按槽自己的 `id`
 *     （localId）渲染与做 React key 的 —— 光有命名空间会变成「两条都渲染 + 同一个 React key
 *     出现两次」。这里定稿为**内置优先**：插件撞内置 localId 的那条被丢弃并告警（见
 *     `pickSlotDefs` / `warnSlotConflict`），于是「同 kind 内 localId 唯一」重新成立，
 *     宿主的 `key={def.id}` 与「按 localId 存的状态」（如 `inspectorTab`）都不再歧义。
 *     插件要覆盖内置槽应走设计 §2.4-2 的「同 id 替换实现」，不是靠撞号；
 *   · 宿主不再认识任何具体槽，改用 `useSlotDefs()` 从注册表取**文档**再按 ctx 渲染
 *     （槽的渲染必须带 ctx，而槽位是 ctx 驱动的，所以不做成 UISlot 挂载的组件，
 *      只把「注册 / 排序 / 可见性来源 / 按 source 回滚」这几件事统一到注册表）。
 *
 * 条目自身的 `render` 只是个占位（`DSL_NO_RENDER`）：槽内容由宿主用文档里的 `render(ctx)` 渲染。
 */

export const SLOT_HOSTS = {
  tabs: 'studio.slot.tabs',
  anchors: 'studio.slot.anchors',
  actions: 'studio.slot.actions',
} as const;

/**
 * 三类槽 host 的公共前缀：`unregisterSource(source, hostPrefix)` 的**作用域**参数用它
 * （审查 L8）—— 插件槽重载时只回滚本适配器登记的这几个挂载点，不再「按来源字符串全局删」，
 * 免得将来别的模块也用 `plugin:<id>` 作来源时被顺手清掉。
 */
export const SLOT_HOST_PREFIX = 'studio.slot.';

export type SlotKind = keyof typeof SLOT_HOSTS;
export type AnySlotDef = TabDef | AnchorDef | ActionDef;

/** 槽条目的 id 命名空间：内置与插件互不覆盖 */
export const slotEntryId = (kind: SlotKind, source: UISource, localId: string): string =>
  source === 'builtin'
    ? `slot.${kind}.builtin.${localId}`
    : `slot.${kind}.${source}.${localId}`;

/** 占位组件：DSL 条目不通过 UISlot 挂载（见文件头说明） */
const DSL_NO_RENDER = () => null;

/** 注册一条槽（返回反注册函数）；同 id 重复注册 = 替换（与 UIRegistry 语义一致） */
export function registerSlotEntry(kind: SlotKind, def: AnySlotDef, source: UISource): () => void {
  return register({
    id: slotEntryId(kind, source, def.id),
    kind: 'panel',
    host: SLOT_HOSTS[kind],
    order: def.order ?? 50,
    source,
    render: DSL_NO_RENDER,
    meta: { slot: def },
  });
}

/* ───────────────── 同 localId 去重（审查 M2）：内置优先 + 冲突告警 ───────────────── */

export interface SlotConflict {
  kind: SlotKind;
  /** 撞号的槽 id（localId，不是命名空间后的 entry id） */
  localId: string;
  winner: UIEntry;
  loser: UIEntry;
}

/**
 * 纯函数：把同一 kind 下的条目按 `localId` 去重，**内置优先**。
 *
 * 返回 `winners`（保留的条目，供渲染）与 `conflicts`（被丢弃的冲突，供告警）。
 * 之所以是纯函数：去重规则是这份适配器的核心契约，尽量可单测（批次 D 的回归用例直接调它）。
 */
export function pickSlotDefs(
  entries: UIEntry[],
  kind: SlotKind,
): { winners: Set<UIEntry>; conflicts: SlotConflict[] } {
  const claimed = new Map<string, UIEntry>();
  const conflicts: SlotConflict[] = [];
  entries.forEach((e) => {
    const def = e.meta?.slot as AnySlotDef | undefined;
    if (!def) return;
    const prev = claimed.get(def.id);
    if (!prev) { claimed.set(def.id, e); return; }
    const prevBuiltin = (prev.source || 'builtin') === 'builtin';
    const curBuiltin = (e.source || 'builtin') === 'builtin';
    if (curBuiltin && !prevBuiltin) {
      // 内置后来居上：先到的是插件那条，换内置胜出
      claimed.set(def.id, e);
      conflicts.push({ kind, localId: def.id, winner: e, loser: prev });
      return;
    }
    // 其余情况（内置已在 / 两个同源条目）：保留先到的那条
    conflicts.push({ kind, localId: def.id, winner: prev, loser: e });
  });
  return { winners: new Set(claimed.values()), conflicts };
}

/** 同 kind + localId 只告警一次（每次渲染都会重算 conflicts，不设闸会刷屏） */
const warnedSlotConflicts = new Set<string>();

function warnSlotConflict(c: SlotConflict): void {
  const key = `${c.kind}:${c.localId}`;
  if (warnedSlotConflicts.has(key)) return;
  warnedSlotConflicts.add(key);
  console.warn(
    `[ui-registry] 分镜槽 ${c.kind}/${c.localId} 有多个来源：保留 ${c.winner.source || 'builtin'}（${c.winner.id}），`
    + `忽略 ${c.loser.source || 'builtin'}（${c.loser.id}）。内置优先 —— 插件要覆盖内置槽请用`
    + '「同 id 替换实现」（设计 §2.4-2），不要靠撞号。',
  );
}

/**
 * 宿主取「当前应渲染的槽文档」：注册表（含开关/版本/来源判定）→ **同 localId 去重** →
 * `when(ctx)` 过滤。
 * 不做 memo：`when` 读的是当次 ctx（内置槽读 productionMode，插件槽读 when.mode），
 * 条目列表本身是 memo 过的，重建数组只有个位数元素，成本可忽略。
 */
export function useSlotDefs<T extends AnySlotDef>(kind: SlotKind, ctx: ShotSlotContext): T[] {
  const entries = useUIEntries(SLOT_HOSTS[kind]);
  const { winners, conflicts } = pickSlotDefs(entries, kind);

  // 冲突只在「渲染之外」告警一次（纯函数里不写副作用，避免渲染期副作用 + 便于单测）
  useEffect(() => { conflicts.forEach(warnSlotConflict); }, [conflicts]);

  const out: T[] = [];
  entries.forEach((e) => {
    if (!winners.has(e)) return; // 撞号被丢弃的那条
    const def = e.meta?.slot as T | undefined;
    if (!def) return;
    if (def.when && !def.when(ctx)) return;
    out.push(def);
  });
  return out;
}

/* 三个类型化的便捷入口：宿主里写 `useTabDefs(ctx)` 比 `useSlotDefs<TabDef>('tabs', ctx)` 更不容易写错 */

export const useTabDefs = (ctx: ShotSlotContext): TabDef[] => useSlotDefs<TabDef>('tabs', ctx);
export const useAnchorDefs = (ctx: ShotSlotContext): AnchorDef[] => useSlotDefs<AnchorDef>('anchors', ctx);
export const useActionDefs = (ctx: ShotSlotContext): ActionDef[] => useSlotDefs<ActionDef>('actions', ctx);
