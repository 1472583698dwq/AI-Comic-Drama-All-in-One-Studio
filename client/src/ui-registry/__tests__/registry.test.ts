import { afterEach, describe, expect, it } from 'vitest';
import { allEntries, register, unregisterSource } from '../registry';
import { pickSlotDefs, SLOT_HOST_PREFIX } from '../adapters/storyboardSlots';
import type { UIEntry } from '../types';

/**
 * 注册表契约 + 分镜槽适配器的两条定稿规则：
 *   · M2：同 localId 撞号 → **内置优先**，被丢弃的那条只告警、不重复渲染（也不再有重复 React key）；
 *   · L8：`unregisterSource(source, hostPrefix)` 的作用域语义（不带作用域时保持旧的全量语义）。
 *
 * 这两条原先只有静态审查，这里做成可复跑的断言。
 */

const undos: Array<() => void> = [];
afterEach(() => {
  undos.splice(0).forEach((fn) => fn());
});

const entry = (
  id: string,
  host: string,
  order: number,
  source: UIEntry['source'] = 'builtin',
  extra: Partial<UIEntry> = {},
): UIEntry => ({ id, kind: 'panel', host, order, source, render: () => null, ...extra });

/** 造一条「分镜槽」条目：entry.id 带命名空间，meta.slot.id 是宿主要用的 localId */
const slotEntry = (
  localId: string,
  source: UIEntry['source'],
  order: number,
  host = 'studio.slot.tabs',
): UIEntry => entry(
  `${host}.${source}.${localId}`,
  host,
  order,
  source,
  { meta: { slot: { id: localId, order, render: () => null } } },
);

describe('注册表基础（§3.2-1 注册 / 幂等替换）', () => {
  it('同 id 重复注册 = 替换而非追加（兼容热重载 / 严格模式双调用）', () => {
    const a = entry('test.same', 'test.host', 10, 'builtin', { render: () => null });
    const b = entry('test.same', 'test.host', 20, 'builtin', { render: () => null });
    undos.push(register(a), register(b));
    const hit = allEntries().filter((e) => e.id === 'test.same');
    expect(hit).toHaveLength(1);
    expect(hit[0].order).toBe(20);
  });

  it('反注册函数只删「仍是自己」的那条（不误删后来者）', () => {
    const a = entry('test.swap', 'test.host', 10);
    const b = entry('test.swap', 'test.host', 20);
    const undoA = register(a);
    undos.push(register(b));
    undoA(); // a 已被 b 顶掉 → 不该删掉 b
    expect(allEntries().some((e) => e.id === 'test.swap')).toBe(true);
  });

  it('按 order 排序（同 order 按 id）', () => {
    undos.push(register(entry('test.z', 'test.order', 10)));
    undos.push(register(entry('test.a', 'test.order', 10)));
    undos.push(register(entry('test.first', 'test.order', 1)));
    const list = allEntries().filter((e) => e.host === 'test.order').map((e) => e.id);
    expect(list).toEqual(['test.first', 'test.a', 'test.z']);
  });
});

describe('M2：分镜槽同 localId 去重（内置优先）', () => {
  it('插件先注册（order 更小）→ 内置仍胜出，插件那条被丢弃并计入冲突', () => {
    const builtin = slotEntry('visual', 'builtin', 10);
    const plugin = slotEntry('visual', 'plugin:p', 5);
    const r = pickSlotDefs([plugin, builtin], 'tabs');
    expect(r.winners.size).toBe(1);
    expect(r.winners.has(builtin)).toBe(true);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].localId).toBe('visual');
  });

  it('内置先注册 → 内置胜出', () => {
    const builtin = slotEntry('visual', 'builtin', 10);
    const plugin = slotEntry('visual', 'plugin:p', 5);
    const r = pickSlotDefs([builtin, plugin], 'tabs');
    expect(r.winners.size).toBe(1);
    expect(r.winners.has(builtin)).toBe(true);
    expect(r.conflicts).toHaveLength(1);
  });

  it('两个插件撞号 → 只保留先到的一条（不再重复渲染 / 重复 key）', () => {
    const p1 = slotEntry('visual', 'plugin:p', 5);
    const p2 = slotEntry('visual', 'plugin:q', 1);
    const r = pickSlotDefs([p1, p2], 'tabs');
    expect(r.winners.size).toBe(1);
    expect(r.winners.has(p1)).toBe(true);
    expect(r.conflicts).toHaveLength(1);
  });

  it('无撞号 → 全保留、零冲突', () => {
    const r = pickSlotDefs([slotEntry('visual', 'builtin', 10), slotEntry('dialogue', 'builtin', 20)], 'tabs');
    expect(r.winners.size).toBe(2);
    expect(r.conflicts).toHaveLength(0);
  });

  it('非槽条目（无 meta.slot）被安全忽略，不参与去重也不报冲突', () => {
    const stray = entry('test.stray', 'studio.slot.tabs', 1);
    const r = pickSlotDefs([stray, slotEntry('visual', 'builtin', 10)], 'tabs');
    expect(r.winners.size).toBe(1);
    expect(r.conflicts).toHaveLength(0);
    expect(r.winners.has(stray)).toBe(false);
  });

  it('去重后同一 kind 内 localId 唯一（宿主 key={def.id} 因此安全）', () => {
    const r = pickSlotDefs(
      [slotEntry('visual', 'builtin', 10), slotEntry('visual', 'plugin:p', 5), slotEntry('dialogue', 'plugin:p', 2)],
      'tabs',
    );
    const localIds = [...r.winners].map((e) => (e.meta!.slot as any).id);
    expect(localIds).toHaveLength(new Set(localIds).size);
    expect(localIds.sort()).toEqual(['dialogue', 'visual']);
  });
});

describe('L8：unregisterSource 的作用域', () => {
  it('带 hostPrefix：只回滚该作用域内的同来源条目，别处同来源条目不受影响', () => {
    undos.push(register(slotEntry('s1', 'plugin:p', 10)));
    undos.push(register(entry('demo.other.p1', 'demo.other', 10, 'plugin:p')));
    unregisterSource('plugin:p', SLOT_HOST_PREFIX);
    const rest = allEntries().filter((e) => e.source === 'plugin:p');
    expect(rest).toHaveLength(1);
    expect(rest[0].host).toBe('demo.other');
  });

  it('不带 hostPrefix：保持旧语义（同来源全量回滚）', () => {
    undos.push(register(slotEntry('s2', 'plugin:p', 10)));
    undos.push(register(entry('demo.other.p2', 'demo.other', 10, 'plugin:p')));
    unregisterSource('plugin:p');
    expect(allEntries().filter((e) => e.source === 'plugin:p')).toHaveLength(0);
  });

  it('只回滚指定来源（不误伤内置与别的插件）', () => {
    undos.push(register(slotEntry('s3', 'plugin:p', 10)));
    undos.push(register(slotEntry('s4', 'plugin:q', 10, 'studio.slot.anchors')));
    undos.push(register(slotEntry('s5', 'builtin', 10, 'studio.slot.actions')));
    unregisterSource('plugin:p', SLOT_HOST_PREFIX);
    const left = allEntries().filter((e) => e.host.startsWith(SLOT_HOST_PREFIX));
    expect(left.map((e) => e.id).sort()).toEqual([
      'studio.slot.actions.builtin.s5',
      'studio.slot.anchors.plugin:q.s4',
    ]);
  });
});
