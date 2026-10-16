// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 样例数据（仅开发演示页与单测使用，不从 index.ts 导出）。
 * ext-node / custom 的声明逐字照搬示例插件 `plugins/example-drama-pack`
 * （canvas_nodes/upscale_ext.json、custom_nodes/upscale_demo.json）；生成源定义取自 8001 实例里的真实 ComfyUI 工作流源。
 */
import type { CanvasNodeSpec } from '../../../canvasNodeSpecs';
import type { CustomNodeDefinition } from '../customNodeDefs';

/** plugins/example-drama-pack/canvas_nodes/upscale_ext.json */
export const UPSCALE_EXT_SPEC: CanvasNodeSpec = {
  id: 'upscale_ext',
  name: '超分扩展节点',
  description: '示例：声明式画布节点包装同包代码节点（无需前端代码，自动出现在画布工具栏）',
  icon: 'Wand2',
  color: 'text-cyan-400',
  kind: 'video',
  inputs: [
    { id: 'video', label: '输入视频', type: 'video', required: true },
    { id: 'prompt', label: '提示词', type: 'text' },
  ],
  outputs: [
    { id: 'video', label: '视频', type: 'video', from: 'video_url' },
  ],
  params_schema: {
    type: 'object',
    properties: {
      scale: { type: 'integer', default: 2, description: '放大倍数' },
    },
  },
  run: {
    extension: 'custom_node:upscale_demo',
    entry: 'generate',
    map: { video: '$in.video', prompt: '$in.prompt', scale: '$param.scale' },
  },
};

/** plugins/example-drama-pack/custom_nodes/upscale_demo.json（列表接口返回的同形对象） */
export const UPSCALE_DEMO_CUSTOM: CustomNodeDefinition = {
  id: 'upscale_demo',
  name: '视频超分演示',
  kind: 'video',
  description: '示例代码节点：真实代码文件在 code/upscale_demo.py（透传输入视频并标注倍数）',
  icon: 'Boxes',
  enabled: true,
  language: 'python',
  input_schema: {
    type: 'object',
    properties: {
      video: { type: 'string', format: 'uri', 'x-handle': 'video', description: '输入视频' },
      prompt: { type: 'string', 'x-handle': 'text', description: '文本输入' },
    },
  },
  params_schema: {
    type: 'object',
    properties: {
      scale: { type: 'integer', default: 2, description: '放大倍数' },
    },
  },
  default_params: { scale: 2 },
};

/** 一个声明了多值参考图口的工具类代码节点（测多值端口 / kind=utility 的 4 个输出口）。 */
export const MULTI_REF_CUSTOM: CustomNodeDefinition = {
  id: 'style_mix_demo',
  name: '风格混合演示',
  kind: 'utility',
  language: 'python',
  input_schema: {
    type: 'object',
    properties: {
      reference_images: { type: 'array', items: { type: 'string', format: 'uri' }, 'x-handle': 'images', description: '参考图' },
      ref_audio: { type: 'string', format: 'uri', description: '参考音频' },
      text: { type: 'string', description: '说明文字' },
    },
    required: ['reference_images'],
  },
  params_schema: { type: 'object', properties: { strength: { type: 'number', default: 0.6, minimum: 0, maximum: 1, 'x-agent': 'auto' } } },
};

/** 8001 实例里的 ComfyUI 工作流生图源（comfyui_wf_3d96b356，节选）：prompt + 参考图数组 + 单张垫图口，输出 image_url。 */
export const COMFY_IMAGE_PROVIDER: Record<string, any> = {
  id: 'comfyui_wf_3d96b356',
  display_name: 'ComfyUI·四试图生成',
  kind: 'image',
  builtin: false,
  provider_type: 'comfyui',
  enabled: true,
  models: ['krea2_turbo_fp8_scaled.safetensors'],
  default_model: 'krea2_turbo_fp8_scaled.safetensors',
  default_params: {},
  auth: { type: 'none', has_key: false },
  transport: { method: 'POST', url: '', timeout: 1200 },
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '提示词/触发词', 'x-handle': 'text', 'x-role': 'prompt', title: '提示词/触发词' },
      reference_images: { type: 'array', items: { type: 'string', format: 'uri' }, description: '参考图/垫图', 'x-handle': 'image', 'x-slot': 'reference_images', 'x-aggregate': true },
      img_5: { type: 'string', format: 'uri', title: '参考垫图 (Body Reference)', description: '参考垫图 (Body Reference)', 'x-handle': 'image', 'x-slot': 'img_5' },
    },
    required: ['prompt'],
  },
  output_schema: { type: 'object', properties: { image_url: { type: 'string', format: 'uri', 'x-handle': 'image' } }, required: ['image_url'] },
  params_schema: {
    type: 'object',
    properties: {
      exp_4_width: { type: 'integer', title: '宽', default: 1536, 'x-category': 'layout', 'x-visibility': 'basic', 'x-agent': 'auto', 'x-priority': 21 },
      exp_4_height: { type: 'integer', title: '高', default: 1024, 'x-category': 'layout', 'x-visibility': 'basic', 'x-agent': 'auto', 'x-priority': 22 },
      seed: { type: 'integer', title: '种子', default: -1, 'x-agent': 'manual' },
      sampler: { type: 'string', title: '采样器', enum: ['euler', 'dpmpp_2m'], default: 'euler', 'x-agent': 'suggest' },
    },
  },
};

/** 小样例媒体（data URI，演示页离线可用）。 */
export const svgImage = (from: string, to: string, text: string) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="160" y="98" font-size="22" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${text}</text></svg>`,
)}`;
