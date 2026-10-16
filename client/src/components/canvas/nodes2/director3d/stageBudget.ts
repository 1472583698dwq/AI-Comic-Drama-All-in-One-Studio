// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N5 · 画布上同时存活的 3D 舞台数量预算（每个舞台占一个 WebGL 上下文，浏览器上限约 16，
 * 导出时还会临时再开一个离屏上下文）。
 *
 * 规则：
 * - 最多 MAX_LIVE_STAGES 个舞台同时挂载；超出时淘汰「最久没用过且未被选中」的那个（被淘汰的节点冻结成最后一帧截图）；
 * - 选中的节点（pinned）可以突破软上限，但总数不超过 HARD_MAX_LIVE_STAGES；
 * - 拿不到名额返回 null（节点显示「舞台过多」占位，点它 / 选中它再试）。
 * 纯模块级状态，与 React 无关，方便单测。
 */

export const MAX_LIVE_STAGES = 6;
export const HARD_MAX_LIVE_STAGES = 10;

interface SlotEntry {
  lastActive: number;
  isPinned: () => boolean;
  evict: () => void;
}

const slots = new Map<string, SlotEntry>();
let clock = 0;

export interface AcquireOptions {
  /** 是否被选中（选中的不会被淘汰，可突破软上限） */
  isPinned: () => boolean;
  /** 被别的节点挤掉时调用：节点应卸载舞台（名额已先行收回） */
  evict: () => void;
}

/** 申请一个舞台名额；返回释放函数，拿不到返回 null。同一节点重复申请只刷新活跃时间。 */
export function acquireStageSlot(id: string, opts: AcquireOptions): (() => void) | null {
  const existing = slots.get(id);
  if (existing) {
    existing.lastActive = ++clock;
    existing.isPinned = opts.isPinned;
    existing.evict = opts.evict;
    return () => { if (slots.get(id) === existing) slots.delete(id); };
  }
  while (slots.size >= MAX_LIVE_STAGES) {
    let victim: [string, SlotEntry] | null = null;
    for (const entry of slots) {
      if (entry[1].isPinned()) continue;
      if (!victim || entry[1].lastActive < victim[1].lastActive) victim = entry;
    }
    if (!victim) break;
    slots.delete(victim[0]);
    try { victim[1].evict(); } catch (e) { console.error('[director3d] 淘汰舞台失败', e); }
  }
  if (slots.size >= HARD_MAX_LIVE_STAGES) return null;
  if (slots.size >= MAX_LIVE_STAGES && !opts.isPinned()) return null;
  const entry: SlotEntry = { lastActive: ++clock, isPinned: opts.isPinned, evict: opts.evict };
  slots.set(id, entry);
  return () => { if (slots.get(id) === entry) slots.delete(id); };
}

/** 节点有交互时刷新活跃时间（越近越不容易被淘汰） */
export function touchStageSlot(id: string): void {
  const entry = slots.get(id);
  if (entry) entry.lastActive = ++clock;
}

export function liveStageCount(): number {
  return slots.size;
}

export function hasStageSlot(id: string): boolean {
  return slots.has(id);
}

/** 仅测试用 */
export function resetStageSlots(): void {
  slots.clear();
  clock = 0;
}
