// REQ-toonflow-canvas N4：音频生成节点「图片 + 音频参考合计 ≤1、文本不限」（Toonflow audioGenerationNode canConnect）。
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';

vi.mock('../../../../../services/api', () => ({ apiService: {} }));

import '../index';
import { defineNode, getNodeDef } from '../../../kit/registry';
import { isValidConnectionFactory } from '../../../kit/connection';
import { audioGenCanConnect, countMediaRefs, isLimitedMediaRef, MEDIA_REF_LIMIT } from '../connect';

const C = () => null;
beforeAll(() => {
  // 测试用上游（正式的图片 / 文本 / 视频节点在别的目录注册）
  defineNode({ type: 'n4t-image', label: '图片', icon: C, category: 'image', component: C, ports: [{ id: 'image', type: 'source', dataType: 'IMAGE' }], inPalette: false });
  defineNode({ type: 'n4t-text', label: '文本', icon: C, category: 'text', component: C, ports: [{ id: 'prompt', type: 'source', dataType: 'STRING' }], inPalette: false });
  defineNode({ type: 'n4t-video', label: '视频', icon: C, category: 'video', component: C, ports: [{ id: 'video', type: 'source', dataType: 'VIDEO' }], inPalette: false });
  defineNode({ type: 'n4t-any', label: '任意', icon: C, category: 'plugin', component: C, ports: [{ id: 'out', type: 'source', dataType: '*' }], inPalette: false });
});

const n = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });

function flow(nodes: Node[], edges: Edge[]) {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  return isValidConnectionFactory((id) => byId.get(id), getNodeDef, { getEdges: () => edges });
}
const conn = (source: string, sourceHandle: string, target = 'gen', targetHandle = 'in') => ({ source, sourceHandle, target, targetHandle });
const edge = (id: string, source: string, sourceHandle: string, target = 'gen', targetHandle = 'in'): Edge => ({ id, source, sourceHandle, target, targetHandle });

const nodes = [
  n('gen', 'audio'),
  n('a1', 'load-audio', { audio_url: '/a.mp3' }),
  n('a2', 'load-audio'), // 还没内容：按声明类型占位
  n('img', 'n4t-image'),
  n('t1', 'n4t-text', { prompt: '台词一' }),
  n('t2', 'n4t-text', { prompt: '台词二' }),
  n('v', 'n4t-video'),
  n('any', 'n4t-any'),
  n('g2', 'audio', { audio_url: '/g.mp3' }),
];

describe('audio canConnect', () => {
  it('空节点：图片 / 音频 / 文本都能连；视频类型不兼容', () => {
    const ok = flow(nodes, []);
    expect(ok(conn('a1', 'audio'))).toBe(true);
    expect(ok(conn('img', 'image'))).toBe(true);
    expect(ok(conn('t1', 'prompt'))).toBe(true);
    expect(ok(conn('g2', 'audio'))).toBe(true);
    expect(ok(conn('v', 'video'))).toBe(false);
  });

  it('已有 1 个音频参考：再连音频 / 图片被拒，文本不限', () => {
    const edges = [edge('e1', 'a1', 'audio'), edge('e2', 't1', 'prompt')];
    const ok = flow(nodes, edges);
    expect(ok(conn('a2', 'audio'))).toBe(false);
    expect(ok(conn('g2', 'audio'))).toBe(false);
    expect(ok(conn('img', 'image'))).toBe(false);
    expect(ok(conn('t2', 'prompt'))).toBe(true);
  });

  it('已有 1 个图片参考：音频被拒；未产出内容的音频节点也按声明类型计数', () => {
    expect(flow(nodes, [edge('e1', 'img', 'image')])(conn('a1', 'audio'))).toBe(false);
    expect(flow(nodes, [edge('e1', 'a2', 'audio')])(conn('img', 'image'))).toBe(false);
  });

  it('同一来源输出口重复连 / 重连已有边不重复计数', () => {
    const edges = [edge('e1', 'a1', 'audio')];
    const ok = flow(nodes, edges);
    expect(ok(conn('a1', 'audio'))).toBe(true);
    expect(ok({ ...edge('e1', 'a1', 'audio') })).toBe(true);
  });

  it('只算 in 口参考：provider 来源 / 其他节点的边不计；类型判断不出的 * 端口不算媒体', () => {
    const others: Edge[] = [edge('x', 'a1', 'audio', 'g2'), { id: 'p', source: 'img', sourceHandle: 'image', target: 'gen', targetHandle: 'provider' }];
    const ok = flow(nodes, others);
    expect(ok(conn('a2', 'audio'))).toBe(true);
    expect(isLimitedMediaRef(n('any', 'n4t-any'), 'out', { id: 'out', type: 'source', dataType: '*' })).toBe(false);
    expect(flow(nodes, [edge('e1', 'any', 'out')])(conn('a1', 'audio'))).toBe(true);
  });

  it('直接调用：非 in 口不限制；countMediaRefs', () => {
    const target = n('gen', 'audio');
    expect(audioGenCanConnect({ node: n('a1', 'load-audio'), port: { id: 'audio', type: 'source', dataType: 'AUDIO' } }, { id: 'other', type: 'target', dataType: 'AUDIO' }, { target, incoming: [], getNode: () => undefined })).toBe(true);
    expect(MEDIA_REF_LIMIT).toBe(1);
    expect(countMediaRefs([{ dataType: 'AUDIO' }, { dataType: 'STRING' }, { dataType: 'IMAGE' }])).toBe(2);
  });
});
