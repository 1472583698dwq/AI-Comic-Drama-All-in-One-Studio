import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { getNodeDef } from '../../../kit/registry';
import { isValidConnectionFactory, resolvePorts } from '../../../kit/connection';
import { clearCanvasNodeSpecs, registerCanvasNodeSpec } from '../../../canvasNodeSpecs';
import { NODE_SPECS } from '../../../__tests__/fixtures/legacyNodeSpecs';
import '../index';
import {
  BRIEF_PORTS, SCRIPT_SPLIT_PORTS, customNodePorts, extNodePorts, extSpecOf, findInputPort, providerKindOf, providerNodePorts,
  resolveDynamicPorts,
} from '../ports';
import { clearCustomNodeDefs, registerCustomNodeDef } from '../customNodeDefs';
import { COMFY_IMAGE_PROVIDER, MULTI_REF_CUSTOM, UPSCALE_DEMO_CUSTOM, UPSCALE_EXT_SPEC } from '../__dev__/samples';

/** REQ-toonflow-canvas N7：动态端口按声明生成（ext-node / custom / provider*），注册表 getPorts 与渲染同源。 */

const brief = (ports: { id: string; type: string; dataType: unknown }[]) => ports.map((p) => `${p.type}:${p.id}:${String(p.dataType)}`);

beforeEach(() => {
  clearCanvasNodeSpecs();
  clearCustomNodeDefs();
});
afterEach(() => {
  clearCanvasNodeSpecs();
  clearCustomNodeDefs();
});

describe('ext-node：端口 = 插件声明 inputs / outputs', () => {
  it('upscale_ext：输入 video(VIDEO, 必填) + prompt(STRING)，输出 video(VIDEO, from=video_url)', () => {
    const ports = extNodePorts({ canvas_node_id: 'upscale_ext', definition: UPSCALE_EXT_SPEC });
    expect(brief(ports)).toEqual(['target:video:VIDEO', 'target:prompt:STRING', 'source:video:VIDEO']);
    expect(ports[0]).toMatchObject({ label: '输入视频', required: true });
    expect(ports[2]).toMatchObject({ from: 'video_url', label: '视频' });
  });

  it('全局注册表（宿主按项目同步的最新声明）优先于 data.definition 快照；都没有 → 无端口', () => {
    expect(extNodePorts({ canvas_node_id: 'upscale_ext' })).toEqual([]);
    const newer = { ...UPSCALE_EXT_SPEC, inputs: [...UPSCALE_EXT_SPEC.inputs!, { id: 'mask', label: '遮罩', type: 'image' as const }] };
    registerCanvasNodeSpec(newer);
    const ports = extNodePorts({ canvas_node_id: 'upscale_ext', definition: UPSCALE_EXT_SPEC });
    expect(ports.map((p) => p.id)).toEqual(['video', 'prompt', 'mask', 'video']);
    expect(extSpecOf({ canvas_node_id: 'upscale_ext', definition: UPSCALE_EXT_SPEC })).toBe(newer);
  });

  it('any 类型映射为 *；快照 id 与 canvas_node_id 不一致时不采用', () => {
    const anySpec = { ...UPSCALE_EXT_SPEC, id: 'anything', inputs: [{ id: 'x', type: 'any' as const }], outputs: [] };
    expect(brief(extNodePorts({ canvas_node_id: 'anything', definition: anySpec }))).toEqual(['target:x:*']);
    expect(extNodePorts({ canvas_node_id: 'other', definition: anySpec })).toEqual([]);
  });

  it('注册表 getPorts 与 resolveDynamicPorts、kit.resolvePorts 结果一致', () => {
    const node = { type: 'ext-node', data: { canvas_node_id: 'upscale_ext', definition: UPSCALE_EXT_SPEC } };
    const def = getNodeDef('ext-node');
    expect(def?.inPalette).toBe(false);
    expect(brief(resolvePorts(def, node))).toEqual(brief(resolveDynamicPorts(node)));
  });
});

describe('custom：端口统一以 input_schema 为准', () => {
  it('upscale_demo：输入 video(VIDEO) + prompt(STRING)，kind=video 只有 video 输出', () => {
    registerCustomNodeDef(UPSCALE_DEMO_CUSTOM);
    const ports = customNodePorts({ custom_node_id: 'upscale_demo' });
    expect(brief(ports)).toEqual(['target:video:VIDEO', 'target:prompt:STRING', 'source:video:VIDEO']);
  });

  it('不再沿用 nodeRegistry 写死的端口（first_frame / ref_audio 等不存在于 schema 时不出现）', () => {
    registerCustomNodeDef(UPSCALE_DEMO_CUSTOM);
    const ids = customNodePorts({ custom_node_id: 'upscale_demo' }).filter((p) => p.type === 'target').map((p) => p.id);
    const legacyStatic = NODE_SPECS.custom.inputs.map((h) => h.id);
    expect(legacyStatic).toContain('first_frame');
    expect(ids).not.toContain('first_frame');
    expect(ids).not.toContain('ref_audio');
  });

  it('数组属性是多值端口；uri 属性按键名判媒体；required 标记；utility 给 4 个输出口', () => {
    registerCustomNodeDef(MULTI_REF_CUSTOM);
    const ports = customNodePorts({ custom_node_id: 'style_mix_demo' });
    expect(brief(ports)).toEqual([
      'target:reference_images:IMAGE', 'target:ref_audio:AUDIO', 'target:text:STRING',
      'source:image:IMAGE', 'source:video:VIDEO', 'source:audio:AUDIO', 'source:text:STRING',
    ]);
    expect(ports[0]).toMatchObject({ multi: true, required: true });
  });

  it('未选节点 / 定义未到：兜底端口与旧卡片一致；定义到达后同一节点 data 的端口随之变化', () => {
    const data = { custom_node_id: 'upscale_demo' };
    expect(brief(customNodePorts(data)).slice(0, 3)).toEqual(['target:prompt:STRING', 'target:video:VIDEO', 'target:reference_images:IMAGE']);
    registerCustomNodeDef(UPSCALE_DEMO_CUSTOM);
    expect(brief(customNodePorts(data))).toEqual(['target:video:VIDEO', 'target:prompt:STRING', 'source:video:VIDEO']);
    // data.definition 快照也能用（缓存被清空时）
    clearCustomNodeDefs();
    expect(customNodePorts({ custom_node_id: 'upscale_demo', definition: UPSCALE_DEMO_CUSTOM }).length).toBe(3);
  });
});

describe('provider*：端口按所选生成源的 schema', () => {
  it('ComfyUI 工作流源：prompt / reference_images(多值) / img_5 输入；provider + image_url 输出', () => {
    const ports = providerNodePorts('provider-image', { provider_id: COMFY_IMAGE_PROVIDER.id, definition: COMFY_IMAGE_PROVIDER });
    expect(brief(ports)).toEqual([
      'target:prompt:STRING', 'target:reference_images:IMAGE', 'target:img_5:IMAGE',
      'source:provider:IMAGE', 'source:image_url:IMAGE',
    ]);
    expect(ports[1]).toMatchObject({ multi: true });
    expect(ports[0]).toMatchObject({ required: true });
  });

  it('未选源：prompt 输入 + provider + 按种类的输出口（同旧组件）', () => {
    expect(brief(providerNodePorts('provider-video', {}))).toEqual(['target:prompt:STRING', 'source:provider:VIDEO', 'source:video:VIDEO']);
    expect(brief(providerNodePorts('provider-audio', {}))).toEqual(['target:prompt:STRING', 'source:provider:AUDIO', 'source:audio:AUDIO']);
    expect(brief(providerNodePorts('provider-llm', {}))).toEqual(['target:prompt:STRING', 'source:provider:STRING', 'source:output:STRING']);
    expect(brief(providerNodePorts('provider', { kind: 'video' }))).toEqual(['target:prompt:STRING', 'source:provider:VIDEO', 'source:video:VIDEO']);
  });

  it('种类：带种类的类型强制，通用 provider 读 data.kind（缺省 image）', () => {
    expect(providerKindOf('provider-llm', { kind: 'image' })).toBe('llm');
    expect(providerKindOf('provider-image', { kind: 'video' })).toBe('image');
    expect(providerKindOf('provider', { kind: 'audio' })).toBe('audio');
    expect(providerKindOf('provider', {})).toBe('image');
  });

  it('每个 provider 类型都已注册，且 getPorts 与 resolveDynamicPorts 一致', () => {
    for (const t of ['provider', 'provider-image', 'provider-video', 'provider-audio', 'provider-llm']) {
      const def = getNodeDef(t);
      expect(def, t).toBeTruthy();
      expect(def?.inPalette).toBe(false);
      const node = { type: t, data: { definition: COMFY_IMAGE_PROVIDER, provider_id: COMFY_IMAGE_PROVIDER.id } };
      expect(brief(resolvePorts(def, node))).toEqual(brief(resolveDynamicPorts(node)));
    }
  });
});

describe('brief / script-split 静态端口与旧连线兼容', () => {
  it('端口 id 不变；没有 handle id 的旧连线落到第一个口', () => {
    expect(BRIEF_PORTS.map((p) => p.id)).toEqual(['brief']);
    expect(SCRIPT_SPLIT_PORTS.map((p) => `${p.type}:${p.id}`)).toEqual(['target:brief', 'source:characters', 'source:shots']);
    expect(findInputPort({ type: 'script-split', data: {} }, null)?.id).toBe('brief');
    expect(resolveDynamicPorts({ type: 'brief', data: {} }).map((p) => p.id)).toEqual(['brief']);
  });
});

describe('连线类型校验（kit isValidConnectionFactory + 本目录注册的 getPorts / canConnect）', () => {
  const nodes: Node[] = [
    { id: 'v', type: 'load-video', position: { x: 0, y: 0 }, data: { video_url: '/storage/a.mp4' } },
    { id: 'img', type: 'load-image', position: { x: 0, y: 0 }, data: { image_url: '/storage/a.png' } },
    { id: 'txt', type: 'brief', position: { x: 0, y: 0 }, data: { brief: '雨夜' } },
    { id: 'prov', type: 'provider-video', position: { x: 0, y: 0 }, data: { provider_id: 'kling' } },
    { id: 'ext', type: 'ext-node', position: { x: 0, y: 0 }, data: { canvas_node_id: 'upscale_ext', definition: UPSCALE_EXT_SPEC } },
    { id: 'cus', type: 'custom', position: { x: 0, y: 0 }, data: { custom_node_id: 'upscale_demo' } },
  ];
  // load-video / load-image 是 N2/N3 的节点：测试里给一个最小声明，避免依赖并行任务
  const stubDefs: Record<string, any> = {
    'load-video': { type: 'load-video', ports: [{ id: 'video', type: 'source', dataType: 'VIDEO' }] },
    'load-image': { type: 'load-image', ports: [{ id: 'image', type: 'source', dataType: 'IMAGE' }] },
  };
  const getNode = (id: string) => nodes.find((n) => n.id === id);
  const getDef = (t?: string | null) => (t && stubDefs[t]) || getNodeDef(t);
  const edges: Edge[] = [];
  const valid = isValidConnectionFactory(getNode, getDef, { getEdges: () => edges, allowUnknown: false });
  const conn = (source: string, sourceHandle: string | null, target: string, targetHandle: string | null) =>
    valid({ source, sourceHandle, target, targetHandle });

  it('ext-node：视频 → video 可连；图片 → video 不可连；文本 → prompt 可连；未声明的口不可连', () => {
    expect(conn('v', 'video', 'ext', 'video')).toBe(true);
    expect(conn('img', 'image', 'ext', 'video')).toBe(false);
    expect(conn('txt', 'brief', 'ext', 'prompt')).toBe(true);
    expect(conn('v', 'video', 'ext', 'image_url')).toBe(false);
  });

  it('生成源节点的 provider 口不能喂给扩展 / 代码节点（接收端 canConnect）', () => {
    expect(conn('prov', 'provider', 'ext', 'video')).toBe(false);
    expect(conn('prov', 'provider', 'cus', 'video')).toBe(false);
  });

  it('custom：定义到达后按 input_schema 校验（旧静态列表里的 first_frame 不再可连）', () => {
    registerCustomNodeDef(UPSCALE_DEMO_CUSTOM);
    expect(conn('v', 'video', 'cus', 'video')).toBe(true);
    expect(conn('img', 'image', 'cus', 'first_frame')).toBe(false);
    expect(conn('txt', 'brief', 'cus', 'prompt')).toBe(true);
  });
});
