import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import '../../nodes2';
import { applyDataPatch, applyPatches, downstreamPatches, recomputeDerivedInputs, NEVER_PROPAGATE_KEYS } from '../propagation';

/** REQ-toonflow-canvas H1：下游传播收窄（H1-INPUTS「最高优先」）。 */

const n = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (source: string, sourceHandle: string | null, target: string, targetHandle: string | null, id = `${source}-${target}-${targetHandle}`): Edge => ({ id, source, sourceHandle, target, targetHandle });

const UPSCALE_SPEC = {
  id: 'upscale_ext', name: '视频超分',
  inputs: [{ id: 'video', type: 'video' }, { id: 'prompt', type: 'text' }],
  outputs: [{ id: 'video', type: 'video' }],
};

describe('applyDataPatch', () => {
  it('合并补丁，undefined 删键，不改原对象', () => {
    const base = { a: 1, b: 2 };
    const out = applyDataPatch(base, { b: undefined, c: 3 });
    expect(out).toEqual({ a: 1, c: 3 });
    expect(base).toEqual({ a: 1, b: 2 });
  });
  it('空补丁返回原对象', () => {
    const base = { a: 1 };
    expect(applyDataPatch(base, {})).toBe(base);
  });
});

describe('downstreamPatches：只传源端口产出值', () => {
  it('下游是单输入口节点（in）时什么都不写——参考列表实时读上游', () => {
    const nodes = [
      n('img', 'image', { image_url: '/a.png', history: [{ url: '/a.png' }], params: { steps: 9 }, refRoles: { x: 'first_frame' }, agent_state: { status: 'completed' } }),
      n('vid', 'video', { prompt: '' }),
      n('txt', 'prompt', { prompt: '你好', script_data: { scenes: [] }, agent_state: { status: 'completed' } }),
      n('aud', 'audio', {}),
    ];
    const edges = [e('img', 'image', 'vid', 'in'), e('txt', 'prompt', 'aud', 'in')];
    expect(downstreamPatches(nodes, edges, 'img').size).toBe(0);
    expect(downstreamPatches(nodes, edges, 'txt').size).toBe(0);
  });

  it('扩展节点：只写声明端口 id（不写 video_url / history / params / agent_state）', () => {
    const nodes = [
      n('lv', 'load-video', { video_url: '/v.mp4', video: '/v.mp4', url: '/v.mp4', history: [{ url: '/v.mp4' }], params: { a: 1 }, agent_state: { status: 'completed' } }),
      n('ext', 'ext-node', { canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC }),
    ];
    const p = downstreamPatches(nodes, [e('lv', 'video', 'ext', 'video')], 'lv');
    expect(p.get('ext')).toEqual({ video: '/v.mp4' });
    for (const k of NEVER_PROPAGATE_KEYS) expect(p.get('ext')).not.toHaveProperty(k);
  });

  it('值没变不写（不会自激）', () => {
    const nodes = [
      n('lv', 'load-video', { video_url: '/v.mp4' }),
      n('ext', 'ext-node', { canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC, video: '/v.mp4' }),
    ];
    expect(downstreamPatches(nodes, [e('lv', 'video', 'ext', 'video')], 'lv').size).toBe(0);
  });

  it('类型不符的边不落值（图片 → 视频口）', () => {
    const nodes = [n('li', 'load-image', { image_url: '/a.png' }), n('ext', 'ext-node', { canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC })];
    expect(downstreamPatches(nodes, [e('li', 'image', 'ext', 'video')], 'li').size).toBe(0);
  });

  it('生成源节点 → 生成节点：只透传 provider_id / provider / model；种类不符不写', () => {
    const nodes = [
      n('pi', 'provider-image', { kind: 'image', provider_id: 'comfy_x', model: 'sdxl', params: { steps: 3 }, definition: { id: 'comfy_x' } }),
      n('img', 'image', {}),
      n('vid', 'video', {}),
      n('shot', 'shot-card', {}),
    ];
    const edges = [e('pi', 'provider', 'img', 'in'), e('pi', 'provider', 'vid', 'in'), e('pi', 'provider', 'shot', 'provider')];
    const p = downstreamPatches(nodes, edges, 'pi');
    expect(p.get('img')).toEqual({ provider_id: 'comfy_x', provider: 'comfy_x', model: 'sdxl' });
    expect(p.has('vid')).toBe(false);
    // N6：生成源连到分镜卡继续写 provider_id / provider / model
    expect(p.get('shot')).toEqual({ provider_id: 'comfy_x', provider: 'comfy_x', model: 'sdxl' });
  });

  it('旧具名口节点（分镜卡 / ComfyUI）：只写目标端口同名键 + _upstream', () => {
    const nodes = [
      n('txt', 'prompt', { prompt: '镜头推进', text: '镜头推进', agent_state: { status: 'completed' }, script_data: {} }),
      n('shot', 'shot-card', { _upstream: { reference: '/r.png' } }),
      n('cw', 'comfy-workflow', {}),
    ];
    const p = downstreamPatches(nodes, [e('txt', 'prompt', 'shot', 'prompt'), e('txt', 'prompt', 'cw', 'prompt')], 'txt');
    expect(p.get('shot')).toEqual({ prompt: '镜头推进', _upstream: { reference: '/r.png', prompt: '镜头推进' } });
    expect(p.get('cw')).toEqual({ prompt: '镜头推进', _upstream: { prompt: '镜头推进' } });
  });

  it('时间线 / 导出 / 分组不写（它们按连线自取上游）', () => {
    const nodes = [n('v', 'video', { video_url: '/v.mp4' }), n('tl', 'timeline', {}), n('ex', 'export', {})];
    expect(downstreamPatches(nodes, [e('v', 'video', 'tl', 'video'), e('v', 'video', 'ex', 'video')], 'v').size).toBe(0);
  });

  it('edgeIds 只算指定边', () => {
    const nodes = [
      n('lv', 'load-video', { video_url: '/v.mp4' }),
      n('ext', 'ext-node', { canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC }),
      n('ext2', 'ext-node', { canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC }),
    ];
    const edges = [e('lv', 'video', 'ext', 'video', 'e1'), e('lv', 'video', 'ext2', 'video', 'e2')];
    const p = downstreamPatches(nodes, edges, 'lv', { edgeIds: ['e2'] });
    expect([...p.keys()]).toEqual(['ext2']);
  });

  it('applyPatches 只替换被改的节点', () => {
    const a = n('a', 'image');
    const b = n('b', 'image');
    const out = applyPatches([a, b], new Map([['b', { x: 1 }]]));
    expect(out[0]).toBe(a);
    expect(out[1].data).toEqual({ x: 1 });
  });
});

describe('recomputeDerivedInputs（加载 / Agent 改画布后）', () => {
  it('动态端口落值 + 生成源透传；旧具名口节点不重写', () => {
    const nodes = [
      n('lv', 'load-video', { video_url: '/v.mp4' }),
      n('ext', 'ext-node', { canvas_node_id: 'upscale_ext', definition: UPSCALE_SPEC, video: '/old.mp4' }),
      n('pv', 'provider-video', { kind: 'video', provider_id: 'kling' }),
      n('vid', 'video', {}),
      n('txt', 'prompt', { prompt: 'new' }),
      n('shot', 'shot-card', { prompt: 'old' }),
    ];
    const edges = [e('lv', 'video', 'ext', 'video'), e('pv', 'provider', 'vid', 'in'), e('txt', 'prompt', 'shot', 'prompt')];
    const out = recomputeDerivedInputs(nodes, edges);
    const by = (id: string) => out.find((x) => x.id === id)!.data as Record<string, unknown>;
    expect(by('ext').video).toBe('/v.mp4');
    expect(by('vid').provider_id).toBe('kling');
    expect(by('shot').prompt).toBe('old');
    expect(out.find((x) => x.id === 'lv')).toBe(nodes[0]);
  });
});
