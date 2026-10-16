import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import { buildRefs, inferEdgeDataType, moveKeys, orderRefs, readOutputValue, remapRefTokens } from '../references';
import { useNodeReferences } from '../useNodeReferences';
import { CanvasHostProvider } from '../hostContext';
import { defineNode, undefineNode } from '../registry';
import { docJSONToString, refAtomAttrs, stringToDoc } from '../promptDoc';
import { PromptInput } from '../PromptInput';
import type { NodeReferences } from '../useNodeReferences';
import type { RefItem } from '../types';

/** REQ-toonflow-canvas design §4：有序参考列表（连线顺序 + data.refOrder）与 {{ref N}}。 */

afterEach(cleanup);

const n = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, sourceHandle: string, target = 'gen', targetHandle = 'in'): Edge => ({ id, source, sourceHandle, target, targetHandle });

describe('readOutputValue（同后端 inputs.source_values）', () => {
  it('按数据类型映射：STRING→prompt||text||brief…；IMAGE→image_url||result_url||file_url||thumb_url；VIDEO→video_url；AUDIO→audio_url', () => {
    expect(readOutputValue(n('a', 'prompt', { prompt: 'p', text: 't' }), 'x', 'STRING')).toBe('p');
    expect(readOutputValue(n('a', 'prompt', { text: ' t ' }), 'x', 'STRING')).toBe('t');
    expect(readOutputValue(n('a', 'x', { image_url: 'http://i' }), 'image', 'IMAGE')).toBe('http://i');
    expect(readOutputValue(n('a', 'x', { result_url: 'http://r' }), 'image', 'IMAGE')).toBe('http://r');
    expect(readOutputValue(n('a', 'x', { url: 'any' }), 'image', 'IMAGE')).toBe('any');
    expect(readOutputValue(n('a', 'x', { video_url: '/v.mp4' }), 'video', 'VIDEO')).toBe('/v.mp4');
    expect(readOutputValue(n('a', 'x', { audio_url: '/a.mp3' }), 'audio', 'AUDIO')).toBe('/a.mp3');
    expect(readOutputValue(n('a', 'x', {}), 'audio', 'AUDIO')).toBe('');
    expect(readOutputValue(undefined, 'a', 'AUDIO')).toBe('');
  });

  it('端口同名键优先（媒体只认 URL）；3D 导演机位读 camera_prompt；缺 sourceHandle 按主输出口', () => {
    expect(readOutputValue(n('d', 'director3d', { prompt: '舞台描述', camera_prompt: '[推进]' }), 'camera_prompt', 'STRING')).toBe('[推进]');
    expect(readOutputValue(n('d', 'director3d', { prompt: '舞台描述', camera_prompt: '[推进]' }), null, 'STRING')).toBe('[推进]');
    expect(readOutputValue(n('d', 'director3d', { minimax_camera_prompt: '[拉远]' }), '', 'STRING')).toBe('[拉远]');
    expect(readOutputValue(n('a', 'x', { image: 'image', image_url: 'http://i' }), 'image', 'IMAGE')).toBe('http://i');
    expect(readOutputValue(n('a', 'x', { first_frame: '/storage/f.png' }), 'first_frame', 'IMAGE')).toBe('/storage/f.png');
  });

  it('inferEdgeDataType：sourceHandle → 来源类型 → 产物键 → 注册表端口', () => {
    expect(inferEdgeDataType(n('a', 'load-image', {}), 'image')).toBe('IMAGE');
    expect(inferEdgeDataType(n('a', 'director3d', {}), null)).toBe('STRING');
    expect(inferEdgeDataType(n('a', 'mystery', { audio_url: '/a.mp3' }), 'out')).toBe('AUDIO');
    expect(inferEdgeDataType(n('a', 'mystery', {}), 'out')).toBeUndefined();
  });

  it('NodeDef.outputValue 可覆盖；注册表端口类型兜底', () => {
    const C = () => null;
    defineNode({ type: 'ref-ov', label: 'x', icon: C, category: 'plugin', component: C, ports: [{ id: 'out', type: 'source', dataType: 'VIDEO' }], outputValue: (d) => (d as { result?: string }).result });
    expect(readOutputValue(n('a', 'ref-ov', { result: 'http://custom' }), 'out', 'VIDEO')).toBe('http://custom');
    expect(readOutputValue(n('a', 'ref-ov', { video_url: 'http://v' }), 'out', 'VIDEO')).toBe('http://v');
    expect(inferEdgeDataType(n('a', 'ref-ov', {}), 'out')).toBe('VIDEO');
    undefineNode('ref-ov');
  });
});

describe('buildRefs（后端 R1/R2）', () => {
  const nodes = [
    n('img', 'load-image', { label: '角色', image_url: 'http://img' }),
    n('txt', 'prompt', { text: '台词' }),
    n('vid', 'load-video', { video_url: 'http://v', thumb_url: 'http://thumb' }),
    n('dir', 'director3d', { camera_prompt: '[推进]' }),
    n('prov', 'provider-video', { provider_id: 'x' }),
    n('gen', 'video', { refOrder: ['vid|video'], refRoles: { 'img|image': 'first_frame' } }),
  ];
  const get = (id: string) => nodes.find((x) => x.id === id);
  const edges = [
    e('e1', 'img', 'image'), e('e2', 'txt', 'text'), e('e3', 'vid', 'video'), e('e4', 'dir', 'camera_prompt'),
    e('e5', 'txt', 'text', 'gen', 'prompt'), e('dup', 'img', 'image'), e('other', 'img', 'image', 'elsewhere'),
    e('p', 'prov', 'provider', 'gen', 'in'), e('legacy', 'img', 'image2', 'gen', 'unknown_port'),
  ];

  it('in 口（及旧具名口）入边，按连线顺序；data.refOrder 覆盖；data.refRoles 带出 role；同 key 去重；provider 来源排除', () => {
    const refs = buildRefs(edges, get, 'gen');
    expect(refs.map((r) => r.key)).toEqual(['vid|video', 'img|image', 'txt|text', 'dir|camera_prompt']);
    expect(refs[1]).toMatchObject({ dataType: 'IMAGE', value: 'http://img', thumb: 'http://img', label: '角色', role: 'first_frame', edgeId: 'e1' });
    expect(refs[0]).toMatchObject({ dataType: 'VIDEO', thumb: 'http://thumb' });
    expect(refs[2]).toMatchObject({ dataType: 'STRING', value: '台词' });
    expect(refs[3]).toMatchObject({ dataType: 'STRING', value: '[推进]', sourceType: 'director3d' });
  });

  it('旧具名口连线也算参考（未迁移画布），edgeKey 用原始 sourceHandle', () => {
    const refs = buildRefs([e('x', 'txt', 'text', 'gen', 'prompt'), { id: 'y', source: 'dir', target: 'gen' }], get, 'gen', { refOrder: null });
    expect(refs.map((r) => [r.key, r.targetHandle])).toEqual([['txt|text', 'prompt'], ['dir|', undefined]]);
    expect(refs[1].value).toBe('[推进]');
  });

  it('非 in 口节点类型（如 export）只认 in 口；handleId 可指定具体口', () => {
    const nodes2 = [...nodes, n('exp', 'export', {})];
    const get2 = (id: string) => nodes2.find((x) => x.id === id);
    expect(buildRefs([e('a', 'vid', 'video', 'exp', 'video')], get2, 'exp')).toEqual([]);
    expect(buildRefs([e('a', 'vid', 'video', 'exp', 'video')], get2, 'exp', { handleId: 'video' }).map((r) => r.key)).toEqual(['vid|video']);
    expect(buildRefs([e('a', 'vid', 'video', 'exp', 'video'), e('b', 'prov', 'provider', 'exp', 'x')], get2, 'exp', { handleId: null }).map((r) => r.key)).toEqual(['vid|video']);
  });

  it('orderRefs 稳定：不在 refOrder 里的保持原相对顺序排在后面；refOrder 重复键取首次位置', () => {
    const items = ['a', 'b', 'c', 'd'].map((key) => ({ key }));
    expect(orderRefs(items, ['c', 'a', 'c']).map((x) => x.key)).toEqual(['c', 'a', 'b', 'd']);
    expect(orderRefs(items, null)).toBe(items);
  });
});

describe('remapRefTokens / moveKeys', () => {
  it('调整顺序后 {{ref N}} 跟随原参考重新编号；未知编号原样保留', () => {
    const from = ['a', 'b', 'c'];
    const to = moveKeys(from, 0, 2);
    expect(to).toEqual(['b', 'c', 'a']);
    expect(remapRefTokens('{{ref 1}} 看 {{ref 3}}，{{ref 9}}', from, to)).toBe('{{ref 3}} 看 {{ref 2}}，{{ref 9}}');
    expect(remapRefTokens('无引用', from, to)).toBe('无引用');
    expect(moveKeys(from, 0, 5)).toEqual(from);
  });
});

describe('promptDoc（{{ref N}} ⇄ 引用标签）', () => {
  const refs: RefItem[] = [
    { key: 'a|image', sourceId: 'a', sourceHandle: 'image', dataType: 'IMAGE', value: 'http://a', thumb: 'http://a', label: '角色' },
    { key: 'b|text', sourceId: 'b', sourceHandle: 'text', dataType: 'STRING', value: '台词' },
  ];
  it('字符串 → 文档 → 字符串 往返不变（含多行、空行、未连接编号）', () => {
    for (const s of ['', 'abc', '看 {{ref 1}} 和 {{ref 2}}\n\n第二段{{ref 3}}', '{{ref 1}}{{ref 1}}']) {
      expect(docJSONToString(stringToDoc(s, refs))).toBe(s);
    }
    const doc = stringToDoc('看 {{ref 1}}', refs);
    expect(doc.content?.[0].content?.[1]).toMatchObject({ type: 'refAtom', attrs: { index: 1, refKey: 'a|image', thumb: 'http://a', missing: false } });
    expect(refAtomAttrs(3, refs)).toMatchObject({ index: 3, refKey: null, missing: true });
    expect(refAtomAttrs(1, refs, 'b|text')).toMatchObject({ index: 2, refKey: 'b|text' });
  });
});

describe('useNodeReferences（React Flow store）', () => {
  const nodes = [
    n('img', 'load-image', { image_url: 'http://img' }),
    n('txt', 'prompt', { text: '台词' }),
    n('gen', 'video', { prompt: '{{ref 1}} 说 {{ref 2}}' }),
  ];
  const edges = [e('e1', 'img', 'image'), e('e2', 'txt', 'text')];

  function Probe({ onRefs }: { onRefs: (r: NodeReferences) => void }) {
    onRefs(useNodeReferences('gen'));
    return null;
  }

  it('读入边产出有序参考；moveRef 写 refOrder 并改写提示词编号；setRefRole 写 refRoles；removeRef 删边', () => {
    let api!: NodeReferences;
    const updateNodeData = vi.fn();
    const removeEdge = vi.fn();
    render(
      <ReactFlowProvider initialNodes={nodes} initialEdges={edges}>
        <CanvasHostProvider value={{ updateNodeData, removeEdge }}>
          <Probe onRefs={(r) => { api = r; }} />
        </CanvasHostProvider>
      </ReactFlowProvider>,
    );
    expect(api.refs.map((r) => r.key)).toEqual(['img|image', 'txt|text']);
    act(() => api.moveRef(0, 1));
    expect(updateNodeData).toHaveBeenCalledWith('gen', { refOrder: ['txt|text', 'img|image'], prompt: '{{ref 2}} 说 {{ref 1}}' });
    act(() => api.moveRef(0, 0));
    expect(updateNodeData).toHaveBeenCalledTimes(1);
    act(() => api.setRefRole('img|image', 'last_frame'));
    expect(updateNodeData).toHaveBeenLastCalledWith('gen', { refRoles: { 'img|image': 'last_frame' } });
    act(() => api.removeRef(api.refs[1]));
    expect(removeEdge).toHaveBeenCalledWith('e2');
  });
});

describe('PromptInput（tiptap）', () => {
  const A: RefItem = { key: 'a|image', sourceId: 'a', sourceHandle: 'image', dataType: 'IMAGE', value: 'http://a', thumb: 'http://a' };
  const B: RefItem = { key: 'b|text', sourceId: 'b', sourceHandle: 'text', dataType: 'STRING', value: '台词' };

  it('{{ref N}} 渲染为引用标签；参考重排后标签跟随并回写新编号；参考断开后移除标签', async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<PromptInput value="看 {{ref 1}} 和 {{ref 2}}" onChange={onChange} refs={[A, B]} />);
    await act(async () => {});
    const chips = () => Array.from(container.querySelectorAll('.cv-ref-chip')).map((c) => c.textContent);
    expect(chips()).toEqual(['参考 1', '参考 2']);
    expect(container.querySelector('.cv-ref-chip img')?.getAttribute('src')).toBe('http://a');

    rerender(<PromptInput value="看 {{ref 1}} 和 {{ref 2}}" onChange={onChange} refs={[B, A]} />);
    await act(async () => {});
    expect(onChange).toHaveBeenLastCalledWith('看 {{ref 2}} 和 {{ref 1}}');
    expect(chips()).toEqual(['参考 2', '参考 1']);

    rerender(<PromptInput value="看 {{ref 2}} 和 {{ref 1}}" onChange={onChange} refs={[A]} />);
    await act(async () => {});
    expect(onChange).toHaveBeenLastCalledWith('看 {{ref 1}} 和 ');
  });

  it('外部改值（Agent 写入）重建内容', async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<PromptInput value="" onChange={onChange} refs={[A]} />);
    await act(async () => {});
    rerender(<PromptInput value="新的 {{ref 1}}" onChange={onChange} refs={[A]} />);
    await act(async () => {});
    expect(container.querySelector('.ProseMirror')?.textContent).toBe('新的 参考 1');
    expect(onChange).not.toHaveBeenCalled();
  });
});
