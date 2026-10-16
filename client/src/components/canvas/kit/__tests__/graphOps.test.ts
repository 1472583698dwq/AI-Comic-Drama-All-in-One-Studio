import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  GROUP_PADDING, absolutePosition, arrangeNodes, duplicateNodes, fitGroupBounds, groupNodes, reparentOnDrop, selectionRoots, ungroupNodes,
} from '../graphOps';

/** REQ-toonflow-canvas design §5：成组 / 解组 / 副本 / 整理（对照 Toonflow selectionToolbar / selectionNodes / arrangeSelection）。 */

let k = 0;
const ids = (p: string) => `${p}_${++k}`;
const node = (id: string, x: number, y: number, extra: Partial<Node> = {}): Node => ({
  id, type: 'image', position: { x, y }, data: { label: id }, measured: { width: 200, height: 100 }, ...extra,
});
const byId = (ns: Node[]) => new Map(ns.map((n) => [n.id, n]));

describe('groupNodes / ungroupNodes', () => {
  it('分组包住根节点（左右 24、上 40、下 24），子节点改相对坐标并挂 parentId；分组插在第一个子节点前', () => {
    const nodes = [node('a', 100, 100), node('b', 400, 300), node('c', 0, 0)];
    const r = groupNodes(nodes, ['a', 'b'], { idFactory: ids });
    const g = r.nodes.find((n) => n.id === r.groupId)!;
    expect(g).toMatchObject({ type: 'group', position: { x: 100 - GROUP_PADDING.left, y: 100 - GROUP_PADDING.top }, width: 548, height: 364, data: { label: '分组' } });
    expect(r.nodes.map((n) => n.id)).toEqual([r.groupId, 'a', 'b', 'c']);
    const a = r.nodes.find((n) => n.id === 'a')!;
    expect(a.parentId).toBe(r.groupId);
    expect(a.position).toEqual({ x: 24, y: 40 });
    expect(absolutePosition(a, byId(r.nodes))).toEqual({ x: 100, y: 100 });
    expect(a.extent).toBeUndefined();

    const back = ungroupNodes(r.nodes, [r.groupId!]);
    expect(back.find((n) => n.id === r.groupId)).toBeUndefined();
    expect(back.find((n) => n.id === 'a')).toMatchObject({ position: { x: 100, y: 100 } });
    expect(back.find((n) => n.id === 'a')!.parentId).toBeUndefined();
  });

  it('同一父分组内成组 → 嵌套；解组时子节点回到上一级分组', () => {
    const outer = node('g0', 1000, 1000, { type: 'group', width: 800, height: 600, measured: undefined });
    const nodes = [outer, node('a', 50, 60, { parentId: 'g0' }), node('b', 300, 60, { parentId: 'g0' })];
    const r = groupNodes(nodes, ['a', 'b'], { idFactory: ids });
    const g = r.nodes.find((n) => n.id === r.groupId)!;
    expect(g.parentId).toBe('g0');
    expect(g.position).toEqual({ x: 26, y: 20 });
    const back = ungroupNodes(r.nodes, [r.groupId!]);
    expect(back.find((n) => n.id === 'a')).toMatchObject({ parentId: 'g0', position: { x: 50, y: 60 } });
  });

  it('选中分组及其子节点时只取根', () => {
    const nodes = [node('g', 0, 0, { type: 'group' }), node('a', 10, 10, { parentId: 'g' })];
    expect(selectionRoots(nodes, ['g', 'a']).map((n) => n.id)).toEqual(['g']);
  });
});

describe('duplicateNodes', () => {
  const edges: Edge[] = [{ id: 'e1', source: 'src', sourceHandle: 'image', target: 'a', targetHandle: 'in' }];
  it('创建副本：放在原节点下方 32px（避开同列节点），带入边、标题加「- 副本」', () => {
    const nodes = [node('src', -400, 0), node('a', 0, 0), node('below', 0, 132)];
    const r = duplicateNodes(nodes, edges, ['a'], { withEdges: true, idFactory: ids });
    const copy = r.nodes.find((n) => n.id === r.newIds[0])!;
    expect(copy.position).toEqual({ x: 0, y: 264 });
    expect(copy.data.label).toBe('a - 副本');
    expect(copy.measured).toBeUndefined();
    expect(r.edges).toHaveLength(2);
    expect(r.edges[1]).toMatchObject({ source: 'src', target: copy.id, targetHandle: 'in' });
  });

  it('复制节点：不带连线；分组连同子树一起复制并改 parentId', () => {
    const nodes = [node('g', 0, 0, { type: 'group', width: 300, height: 200 }), node('a', 10, 40, { parentId: 'g' })];
    const r = duplicateNodes(nodes, edges, ['g'], { withEdges: false, idFactory: ids });
    expect(r.edges).toHaveLength(1);
    const gCopy = r.idMap.get('g')!;
    expect(r.nodes.find((n) => n.id === r.idMap.get('a'))!.parentId).toBe(gCopy);
  });
});

describe('arrangeNodes / fitGroupBounds / reparentOnDrop', () => {
  it('水平排列：按 x 排序、间距 80、按行高居中', () => {
    const nodes = [node('b', 500, 50), node('a', 0, 0, { measured: { width: 200, height: 200 } })];
    const r = arrangeNodes(nodes, ['a', 'b'], 'horizontal');
    expect(r.find((n) => n.id === 'a')!.position).toEqual({ x: 0, y: 0 });
    expect(r.find((n) => n.id === 'b')!.position).toEqual({ x: 280, y: 50 });
    const grid = arrangeNodes([node('a', 0, 0), node('b', 0, 0), node('c', 0, 0)], ['a', 'b', 'c'], 'grid');
    expect(grid.map((n) => n.position)).toEqual([{ x: 0, y: 0 }, { x: 280, y: 0 }, { x: 0, y: 180 }]);
  });

  it('分组贴合子节点', () => {
    const nodes = [node('g', 0, 0, { type: 'group', width: 1000, height: 1000 }), node('a', 100, 100, { parentId: 'g' })];
    const r = fitGroupBounds(nodes, ['g']);
    expect(r[0]).toMatchObject({ position: { x: 76, y: 60 }, width: 248, height: 164 });
    expect(r[1].position).toEqual({ x: 24, y: 40 });
  });

  it('拖进分组 → 成为子节点；拖出 → 脱离', () => {
    const g = node('g', 0, 0, { type: 'group', width: 600, height: 400, measured: { width: 600, height: 400 } });
    const inside = reparentOnDrop([g, node('a', 100, 100)], ['a']);
    expect(inside.find((n) => n.id === 'a')!.parentId).toBe('g');
    expect(inside.map((n) => n.id)).toEqual(['g', 'a']);
    const out = reparentOnDrop([g, node('a', 2000, 2000, { parentId: 'g' })], ['a']);
    expect(out.find((n) => n.id === 'a')!.parentId).toBeUndefined();
    expect(out.find((n) => n.id === 'a')!.position).toEqual({ x: 2000, y: 2000 });
  });
});
