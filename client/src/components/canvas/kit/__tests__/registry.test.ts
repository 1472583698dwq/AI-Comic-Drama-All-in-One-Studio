import { afterEach, describe, expect, it } from 'vitest';
import {
  allNodeDefs, createNodeData, defineNode, defsAcceptingFrom, defsProvidingTo, findCompatiblePort, getNodeDef,
  nodeTypesMap, paletteDefs, registryVersion, resolvePorts, subscribeRegistry, undefineNode,
} from '../registry';
import { groupNodeDef } from '../GroupNode';
import type { AnyNodeDef } from '../types';

/** REQ-toonflow-canvas design §3：nodeTypes / 工具栏 / 拖线菜单都从注册表生成；重复 define 幂等（HMR）。 */

const A = () => null;
const B = () => null;
const mk = (type: string, extra: Partial<AnyNodeDef> = {}): AnyNodeDef => ({
  type, label: type, icon: A, category: 'tool', component: A, ports: [], ...extra,
});

const created: string[] = [];
const def = (d: AnyNodeDef) => { created.push(d.type); return defineNode(d); };
afterEach(() => { created.splice(0).forEach(undefineNode); });

describe('defineNode / getNodeDef', () => {
  it('注册后可查；同 type 再 define 覆盖（HMR 安全），同一对象重复 define 不改版本号', () => {
    const d1 = def(mk('r-a'));
    expect(getNodeDef('r-a')).toBe(d1);
    const v = registryVersion();
    defineNode(d1);
    expect(registryVersion()).toBe(v);
    const d2 = def(mk('r-a', { label: '新标题', component: B }));
    expect(getNodeDef('r-a')).toBe(d2);
    expect(allNodeDefs().filter((d) => d.type === 'r-a')).toHaveLength(1);
    expect(getNodeDef(undefined)).toBeUndefined();
    expect(() => defineNode(mk(''))).toThrow();
  });

  it('subscribeRegistry 在变化时回调', () => {
    let n = 0;
    const off = subscribeRegistry(() => { n++; });
    def(mk('r-sub'));
    off();
    def(mk('r-sub2'));
    expect(n).toBe(1);
  });
});

describe('nodeTypesMap', () => {
  it('注册表不变时返回同一引用；变化后重建', () => {
    def(mk('r-nt', { component: A }));
    const m1 = nodeTypesMap();
    expect(nodeTypesMap()).toBe(m1);
    expect(m1['r-nt']).toBe(A);
    def(mk('r-nt', { component: B }));
    const m2 = nodeTypesMap();
    expect(m2).not.toBe(m1);
    expect(m2['r-nt']).toBe(B);
  });

  it('kit 自带 group 节点', () => {
    expect(getNodeDef('group')).toBe(groupNodeDef);
    expect(nodeTypesMap().group).toBe(groupNodeDef.component);
  });
});

describe('palette / 拖线菜单过滤', () => {
  it('inPalette:false 不进工具栏（group 默认不进）', () => {
    def(mk('r-hidden', { inPalette: false }));
    def(mk('r-shown'));
    const types = paletteDefs().map((d) => d.type);
    expect(types).toContain('r-shown');
    expect(types).not.toContain('r-hidden');
    expect(types).not.toContain('group');
  });

  it('defsAcceptingFrom：能接收该类型的节点；defsProvidingTo：能提供该类型的节点', () => {
    def(mk('r-imggen', { ports: [{ id: 'in', type: 'target', dataType: ['IMAGE', 'STRING'] }, { id: 'image', type: 'source', dataType: 'IMAGE' }] }));
    def(mk('r-video', { ports: [{ id: 'in', type: 'target', dataType: ['IMAGE', 'VIDEO', 'AUDIO', 'STRING'] }, { id: 'video', type: 'source', dataType: 'VIDEO' }] }));
    def(mk('r-loadaudio', { ports: [{ id: 'audio', type: 'source', dataType: 'AUDIO' }] }));
    def(mk('r-hidden-img', { inPalette: false, ports: [{ id: 'in', type: 'target', dataType: 'IMAGE' }] }));
    const acceptImage = defsAcceptingFrom('IMAGE').map((d) => d.type);
    expect(acceptImage).toEqual(expect.arrayContaining(['r-imggen', 'r-video']));
    expect(acceptImage).not.toContain('r-loadaudio');
    expect(acceptImage).not.toContain('r-hidden-img');
    const acceptAudio = defsAcceptingFrom('AUDIO').map((d) => d.type);
    expect(acceptAudio).toContain('r-video');
    expect(acceptAudio).not.toContain('r-imggen');
    const provideAudio = defsProvidingTo(['IMAGE', 'AUDIO', 'STRING']).map((d) => d.type);
    expect(provideAudio).toEqual(expect.arrayContaining(['r-imggen', 'r-loadaudio']));
    expect(provideAudio).not.toContain('r-video');
    expect(findCompatiblePort(getNodeDef('r-video')!, 'IMAGE', 'target')?.id).toBe('in');
  });
});

describe('resolvePorts / createNodeData', () => {
  it('getPorts 优先；抛错回落静态端口', () => {
    const d = def(mk('r-dyn', {
      ports: [{ id: 'static', type: 'source', dataType: 'STRING' }],
      getPorts: (data: Record<string, unknown>) => {
        if (data.bad) throw new Error('bad');
        return [{ id: 'dyn', type: 'target', dataType: 'VIDEO' }];
      },
    }));
    expect(resolvePorts(d, { data: {} }).map((p) => p.id)).toEqual(['dyn']);
    const err = console.error;
    console.error = () => {};
    expect(resolvePorts(d, { data: { bad: true } }).map((p) => p.id)).toEqual(['static']);
    console.error = err;
    expect(resolvePorts(d, null).map((p) => p.id)).toEqual(['static']);
    expect(resolvePorts(undefined, null)).toEqual([]);
  });

  it('createNodeData = label + defaultData()', () => {
    def(mk('r-data', { label: '图片生成', defaultData: () => ({ prompt: '', mode: '' }) }));
    expect(createNodeData('r-data')).toEqual({ label: '图片生成', prompt: '', mode: '' });
    expect(createNodeData('r-missing')).toEqual({});
  });
});
