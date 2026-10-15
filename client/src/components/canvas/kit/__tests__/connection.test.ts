import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { canConnect, findPort, isTypeCompatible, isValidConnectionFactory } from '../connection';
import { defineNode, getNodeDef, undefineNode } from '../registry';
import type { AnyNodeDef, PortDef } from '../types';

/** REQ-toonflow-canvas design §3：两端类型有交集或含 `*`；接收端 NodeDef.canConnect 追加限制。 */

const Dummy = () => null;
const defs: AnyNodeDef[] = [
  { type: 't-text', label: '文本', icon: Dummy, category: 'text', component: Dummy, ports: [{ id: 'text', type: 'source', dataType: 'STRING' }] },
  { type: 't-image', label: '图片', icon: Dummy, category: 'image', component: Dummy, ports: [{ id: 'image', type: 'source', dataType: 'IMAGE' }] },
  { type: 't-audio', label: '音频', icon: Dummy, category: 'audio', component: Dummy, ports: [{ id: 'audio', type: 'source', dataType: 'AUDIO' }] },
  { type: 't-any', label: '任意', icon: Dummy, category: 'tool', component: Dummy, ports: [{ id: 'out', type: 'source', dataType: '*' }] },
  {
    type: 't-imggen', label: '图片生成', icon: Dummy, category: 'image', component: Dummy,
    ports: [{ id: 'in', type: 'target', dataType: ['IMAGE', 'STRING'] }, { id: 'image', type: 'source', dataType: 'IMAGE' }],
  },
  {
    // 音频生成：图片 + 音频参考合计 ≤1（design §6.1）
    type: 't-audiogen', label: '音频生成', icon: Dummy, category: 'audio', component: Dummy,
    ports: [{ id: 'in', type: 'target', dataType: ['IMAGE', 'AUDIO', 'STRING'] }, { id: 'audio', type: 'source', dataType: 'AUDIO' }],
    canConnect: (src, _dst, ctx) => {
      const media = (p?: PortDef) => !!p && ['IMAGE', 'AUDIO'].some((t) => ([] as string[]).concat(p.dataType).includes(t));
      if (!media(src.port)) return true;
      return ctx.incoming.filter((c) => media(c.port)).length < 1;
    },
  },
  {
    type: 't-dynamic', label: '动态', icon: Dummy, category: 'plugin', component: Dummy, ports: [],
    getPorts: (data: Record<string, unknown>) => ((data.ports as PortDef[]) || []),
  },
];

defs.forEach((d) => defineNode(d));

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });

describe('isTypeCompatible / canConnect', () => {
  it('交集即兼容；数组、逗号写法、`*` 都支持', () => {
    expect(isTypeCompatible('IMAGE', ['IMAGE', 'STRING'])).toBe(true);
    expect(isTypeCompatible('VIDEO', ['IMAGE', 'STRING'])).toBe(false);
    expect(isTypeCompatible('*', 'AUDIO')).toBe(true);
    expect(isTypeCompatible('VIDEO', '*')).toBe(true);
    expect(isTypeCompatible('IMAGE,VIDEO' as never, 'VIDEO')).toBe(true);
    expect(isTypeCompatible([], 'IMAGE')).toBe(false);
  });

  it('方向必须 source → target', () => {
    const src: PortDef = { id: 'a', type: 'source', dataType: 'IMAGE' };
    const dst: PortDef = { id: 'b', type: 'target', dataType: 'IMAGE' };
    expect(canConnect(src, dst)).toBe(true);
    expect(canConnect(dst, src)).toBe(false);
    expect(canConnect(src, { ...dst, dataType: 'AUDIO' })).toBe(false);
    expect(canConnect(undefined, dst)).toBe(false);
  });
});

describe('findPort', () => {
  it('按 handle id 找；没有 handle id 的旧连线落到该侧第一个端口；动态端口优先', () => {
    const gen = getNodeDef('t-imggen');
    expect(findPort(gen, node('n', 't-imggen'), 'in', 'target')?.id).toBe('in');
    expect(findPort(gen, node('n', 't-imggen'), null, 'target')?.id).toBe('in');
    expect(findPort(gen, node('n', 't-imggen'), 'nope', 'target')).toBeUndefined();
    const dyn = getNodeDef('t-dynamic');
    const n = node('d', 't-dynamic', { ports: [{ id: 'video', type: 'target', dataType: 'VIDEO' }] });
    expect(findPort(dyn, n, 'video', 'target')?.dataType).toBe('VIDEO');
  });
});

describe('isValidConnectionFactory', () => {
  const nodes = [
    node('txt', 't-text'), node('img', 't-image'), node('aud', 't-audio'), node('any', 't-any'),
    node('gen', 't-imggen'), node('agen', 't-audiogen'), node('legacy', 'old-node'),
    node('dyn', 't-dynamic', { ports: [{ id: 'video', type: 'target', dataType: 'VIDEO' }] }),
  ];
  let edges: Edge[] = [];
  const getNode = (id: string) => nodes.find((n) => n.id === id);
  const valid = isValidConnectionFactory(getNode, getNodeDef, { getEdges: () => edges });

  it('类型兼容才能连；自连拒绝', () => {
    expect(valid({ source: 'img', sourceHandle: 'image', target: 'gen', targetHandle: 'in' })).toBe(true);
    expect(valid({ source: 'txt', sourceHandle: 'text', target: 'gen', targetHandle: 'in' })).toBe(true);
    expect(valid({ source: 'aud', sourceHandle: 'audio', target: 'gen', targetHandle: 'in' })).toBe(false);
    expect(valid({ source: 'any', sourceHandle: 'out', target: 'gen', targetHandle: 'in' })).toBe(true);
    expect(valid({ source: 'gen', sourceHandle: 'image', target: 'gen', targetHandle: 'in' })).toBe(false);
  });

  it('端口不存在 → 拒绝；动态端口按 data 声明校验', () => {
    expect(valid({ source: 'img', sourceHandle: 'image', target: 'gen', targetHandle: 'first_frame' })).toBe(false);
    expect(valid({ source: 'img', sourceHandle: 'image', target: 'dyn', targetHandle: 'video' })).toBe(false);
    expect(valid({ source: 'any', sourceHandle: 'out', target: 'dyn', targetHandle: 'video' })).toBe(true);
  });

  it('未注册节点：缺省放行，allowUnknown=false 时拒绝', () => {
    expect(valid({ source: 'legacy', sourceHandle: 'x', target: 'gen', targetHandle: 'in' })).toBe(true);
    const strict = isValidConnectionFactory(getNode, getNodeDef, { allowUnknown: false });
    expect(strict({ source: 'legacy', sourceHandle: 'x', target: 'gen', targetHandle: 'in' })).toBe(false);
  });

  it('接收端 canConnect：音频生成的图片+音频参考合计 ≤1，文本不受限；重连自身那条边时不算入', () => {
    edges = [];
    expect(valid({ source: 'img', sourceHandle: 'image', target: 'agen', targetHandle: 'in' })).toBe(true);
    edges = [{ id: 'e1', source: 'img', sourceHandle: 'image', target: 'agen', targetHandle: 'in' }];
    expect(valid({ source: 'aud', sourceHandle: 'audio', target: 'agen', targetHandle: 'in' })).toBe(false);
    expect(valid({ source: 'txt', sourceHandle: 'text', target: 'agen', targetHandle: 'in' })).toBe(true);
    // 把 e1 改接成音频：排除正在编辑的边自身
    expect(valid({ id: 'e1', source: 'aud', sourceHandle: 'audio', target: 'agen', targetHandle: 'in' } as Edge)).toBe(true);
  });

  it('canConnect 抛错按不可连处理', () => {
    defineNode({ ...getNodeDef('t-imggen')!, type: 't-throw', canConnect: () => { throw new Error('boom'); } });
    nodes.push(node('thr', 't-throw'));
    const err = console.error;
    console.error = () => {};
    try {
      expect(valid({ source: 'img', sourceHandle: 'image', target: 'thr', targetHandle: 'in' })).toBe(false);
    } finally {
      console.error = err;
      undefineNode('t-throw');
    }
  });
});
