import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { readOutputValue } from '../../../kit/references';
import { clearCanvasNodeSpecs } from '../../../canvasNodeSpecs';
import '../index';
import {
  collectDynamicInputs, dynamicInputStates, edgeInputPatch, kindForPort, providerKindMatches, providerPatchFor,
} from '../inputs';
import { clearCustomNodeDefs, registerCustomNodeDef } from '../customNodeDefs';
import { COMFY_IMAGE_PROVIDER, MULTI_REF_CUSTOM, UPSCALE_DEMO_CUSTOM, UPSCALE_EXT_SPEC } from '../__dev__/samples';

/**
 * REQ-toonflow-canvas N7 修复验证（design §6.2 ①）：上游媒体落到 ext-node 声明的端口 id
 * （后端 engine.py ext-node 分支按 `spec.inputs[].id` 取输入），不再写成 image_url / video_url。
 */

beforeEach(() => { clearCanvasNodeSpecs(); clearCustomNodeDefs(); });
afterEach(() => { clearCanvasNodeSpecs(); clearCustomNodeDefs(); });

const video: Node = { id: 'v1', type: 'load-video', position: { x: 0, y: 0 }, data: { video_url: '/storage/videos/in.mp4', video: '/storage/videos/in.mp4' } };
const video2: Node = { id: 'v2', type: 'video', position: { x: 0, y: 0 }, data: { video_url: '/storage/videos/gen.mp4', prompt: '奔跑' } };
const text: Node = { id: 't1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: '放大到 4K，保留颗粒' } };
const img1: Node = { id: 'i1', type: 'load-image', position: { x: 0, y: 0 }, data: { image_url: '/storage/a.png' } };
const img2: Node = { id: 'i2', type: 'image', position: { x: 0, y: 0 }, data: { image_url: '/storage/b.png', prompt: '角色' } };
const prov: Node = { id: 'p1', type: 'provider-image', position: { x: 0, y: 0 }, data: { provider_id: 'comfyui_wf_3d96b356', model: 'krea2', definition: COMFY_IMAGE_PROVIDER } };
const ext = (data: Record<string, unknown> = {}): Node => ({
  id: 'ext', type: 'ext-node', position: { x: 0, y: 0 }, data: { canvas_node_id: 'upscale_ext', definition: UPSCALE_EXT_SPEC, ...data },
});

describe('ext-node：媒体值落到声明的端口 id', () => {
  it('视频连到 upscale_ext.video → { video: url }，不写 video_url', () => {
    const patch = edgeInputPatch({ source: 'v1', sourceHandle: 'video', target: 'ext', targetHandle: 'video' }, video, ext());
    expect(patch).toEqual({ video: '/storage/videos/in.mp4' });
    expect(patch).not.toHaveProperty('video_url');
  });

  it('文本连到 prompt 口 → { prompt }；没有 handle id 的旧连线落到第一个输入口 video', () => {
    expect(edgeInputPatch({ source: 't1', sourceHandle: 'prompt', target: 'ext', targetHandle: 'prompt' }, text, ext()))
      .toEqual({ prompt: '放大到 4K，保留颗粒' });
    expect(edgeInputPatch({ source: 'v2', sourceHandle: null, target: 'ext', targetHandle: null }, video2, ext()))
      .toEqual({ video: '/storage/videos/gen.mp4' });
  });

  it('全部入边重算：单值口取最后连上的那条有值的边；上游暂无产出的不写', () => {
    const empty: Node = { id: 'v3', type: 'video', position: { x: 0, y: 0 }, data: { prompt: '还没生成' } };
    const nodes = [video, video2, text, empty, ext()];
    const edges: Edge[] = [
      { id: 'a', source: 'v1', sourceHandle: 'video', target: 'ext', targetHandle: 'video' },
      { id: 'b', source: 't1', sourceHandle: 'prompt', target: 'ext', targetHandle: 'prompt' },
      { id: 'c', source: 'v2', sourceHandle: 'video', target: 'ext', targetHandle: 'video' },
      { id: 'd', source: 'v3', sourceHandle: 'video', target: 'ext', targetHandle: 'video' },
      { id: 'x', source: 'v1', sourceHandle: 'video', target: 'other', targetHandle: 'video' },
    ];
    const got = collectDynamicInputs(nodes[4], edges, (id) => nodes.find((n) => n.id === id));
    expect(got).toEqual({ video: '/storage/videos/gen.mp4', prompt: '放大到 4K，保留颗粒' });
    const states = dynamicInputStates(nodes[4], edges, (id) => nodes.find((n) => n.id === id));
    expect(states.video).toEqual({ connected: 3, value: '/storage/videos/gen.mp4' });
    expect(states.prompt).toEqual({ connected: 1, value: '放大到 4K，保留颗粒' });
  });

  it('生成源节点连进来不落值（走 providerPatchFor）；目标不是动态端口节点 → null', () => {
    expect(edgeInputPatch({ source: 'p1', sourceHandle: 'provider', target: 'ext', targetHandle: 'video' }, prov, ext())).toBeNull();
    expect(edgeInputPatch({ source: 'v1', sourceHandle: 'video', target: 'x', targetHandle: 'in' }, video, { id: 'x', type: 'video', data: {} })).toBeNull();
  });

  it('ext-node 作为上游：输出口读 outputs[端口]，不会把同名输入口 data.video 当成产出', () => {
    const before = ext({ video: '/storage/videos/in.mp4' });
    expect(readOutputValue(before, 'video', 'VIDEO')).toBe('');
    const after = ext({ video: '/storage/videos/in.mp4', video_url: '/storage/videos/out.mp4', outputs: { video: '/storage/videos/out.mp4' } });
    expect(readOutputValue(after, 'video', 'VIDEO')).toBe('/storage/videos/out.mp4');
    // 只有 video_url（宿主没存 outputs 时）也能读到
    expect(readOutputValue(ext({ video: '/in.mp4', video_url: '/out.mp4' }), 'video', 'VIDEO')).toBe('/out.mp4');
  });
});

describe('custom / provider 的多值口与取值', () => {
  it('custom 数组口按连线顺序去重合并；单条 onConnect 补丁在现有数组上追加', () => {
    registerCustomNodeDef(MULTI_REF_CUSTOM);
    const target: Node = { id: 'c', type: 'custom', position: { x: 0, y: 0 }, data: { custom_node_id: 'style_mix_demo', reference_images: ['/storage/a.png'] } };
    const nodes = [img1, img2, target];
    const edges: Edge[] = [
      { id: '1', source: 'i1', sourceHandle: 'image', target: 'c', targetHandle: 'reference_images' },
      { id: '2', source: 'i2', sourceHandle: 'image', target: 'c', targetHandle: 'reference_images' },
      { id: '3', source: 'i1', sourceHandle: 'image', target: 'c', targetHandle: 'reference_images' },
    ];
    expect(collectDynamicInputs(target, edges, (id) => nodes.find((n) => n.id === id))).toEqual({ reference_images: ['/storage/a.png', '/storage/b.png'] });
    expect(edgeInputPatch(edges[1], img2, target)).toEqual({ reference_images: ['/storage/a.png', '/storage/b.png'] });
    expect(edgeInputPatch(edges[0], img1, target)).toEqual({ reference_images: ['/storage/a.png'] });
  });

  it('custom 作为上游：video 口读 video_url（结果），不读同名输入 data.video', () => {
    registerCustomNodeDef(UPSCALE_DEMO_CUSTOM);
    const node = { id: 'c', type: 'custom', data: { custom_node_id: 'upscale_demo', video: '/in.mp4' } };
    expect(readOutputValue(node, 'video', 'VIDEO')).toBe('');
    expect(readOutputValue({ ...node, data: { ...node.data, video_url: '/out.mp4' } }, 'video', 'VIDEO')).toBe('/out.mp4');
  });

  it('生成源节点的数据口：img_5 收单张图，reference_images 收数组', () => {
    const target: Node = { id: 'p', type: 'provider-image', position: { x: 0, y: 0 }, data: { provider_id: COMFY_IMAGE_PROVIDER.id, definition: COMFY_IMAGE_PROVIDER } };
    expect(edgeInputPatch({ source: 'i1', sourceHandle: 'image', target: 'p', targetHandle: 'img_5' }, img1, target)).toEqual({ img_5: '/storage/a.png' });
    expect(edgeInputPatch({ source: 'i1', sourceHandle: 'image', target: 'p', targetHandle: 'reference_images' }, img1, target)).toEqual({ reference_images: ['/storage/a.png'] });
  });

  it('kindForPort：单一类型直接用，* 口按上游推断', () => {
    expect(kindForPort({ dataType: 'VIDEO' }, img1, 'image')).toBe('VIDEO');
    expect(kindForPort({ dataType: '*' }, img1, 'image')).toBe('IMAGE');
    expect(kindForPort({ dataType: ['IMAGE', 'STRING'] }, text, 'prompt')).toBe('STRING');
  });
});

describe('生成源透传（provider 口 → 下游 provider_id / provider / model）', () => {
  it('providerPatchFor：选了源才透传；definition.id 兜底', () => {
    expect(providerPatchFor(prov)).toEqual({ provider_id: 'comfyui_wf_3d96b356', provider: 'comfyui_wf_3d96b356', model: 'krea2' });
    expect(providerPatchFor({ id: 'p', type: 'provider-video', data: { definition: { id: 'kling' } } })).toEqual({ provider_id: 'kling', provider: 'kling' });
    expect(providerPatchFor({ id: 'p', type: 'provider-video', data: {} })).toBeNull();
    expect(providerPatchFor(video)).toBeNull();
    expect(readOutputValue(prov, 'provider', 'IMAGE')).toBe('comfyui_wf_3d96b356');
  });

  it('providerKindMatches：生图源 → 图片生成可，→ 视频生成不可；未知下游放行', () => {
    expect(providerKindMatches(prov, 'image')).toBe(true);
    expect(providerKindMatches(prov, 'video')).toBe(false);
    expect(providerKindMatches({ id: 'p', type: 'provider', data: { kind: 'video' } }, 'video')).toBe(true);
    expect(providerKindMatches(prov, 'timeline')).toBe(true);
    expect(providerKindMatches(video, 'image')).toBe(false);
  });
});
