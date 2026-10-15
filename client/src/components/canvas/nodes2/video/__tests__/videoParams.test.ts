// REQ-toonflow-canvas N3：视频生成参数 / 模式 / 入参清理（纯函数）
import { describe, expect, it } from 'vitest';
import {
  carryOverParams, currentRatio, dataForRun, displayRatio, effectiveMode, modeOptions, paramsPatch, paramsSummary, quickParamsOf,
  resolveAutoMode, resolveVideoParams, schemaDefaults,
} from '../videoParams';
import { assembleInputs } from '../../../kit/assembleInputs';
import type { RefItem } from '../../../kit/types';
import type { SlotSpec } from '../../../kit/assembleInputs';

// 真实生成源 params_schema 摘录（server/app/providers/video/seedance.py / kling.py、AutoDL 自定义源）
const SEEDANCE = {
  params_schema: {
    properties: {
      resolution: { type: 'string', enum: ['480p', '720p', '1080p'], default: '720p' },
      ratio: { type: 'string', enum: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], default: 'adaptive' },
      duration: { type: 'integer', default: 5, minimum: 4, maximum: 30 },
      generate_audio: { type: 'boolean', default: true },
      watermark: { type: 'boolean', default: false },
    },
  },
};
const KLING = {
  params_schema: {
    properties: {
      resolution: { type: 'string', enum: ['720P', '1080P'], default: '720P' },
      aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], default: '9:16' },
      duration: { type: 'integer', enum: [5, 10], default: 5 },
      generate_audio: { type: 'boolean', default: false },
    },
  },
};
const AUTODL = {
  params_schema: { properties: { resolution: { type: 'string', enum: ['480p竖', '768p竖'], default: '768p竖' }, duration: { type: 'integer', default: 5, minimum: 3, maximum: 15 }, seed: { type: 'integer' } } },
  default_params: { seed: 7 },
};

const ref = (key: string, dataType: RefItem['dataType'], value = `/storage/${key}.png`): RefItem => ({ key, sourceId: key, sourceHandle: 'image', dataType, value });
const FIRST_LAST: SlotSpec[] = [
  { key: 'first_frame', type: 'image', maxCount: 1 },
  { key: 'last_frame', type: 'image', maxCount: 1 },
];
const REF_ONLY: SlotSpec[] = [{ key: 'reference_images', type: 'image', maxCount: 9, multi: true }];
const FULL: SlotSpec[] = [...FIRST_LAST, ...REF_ONLY];

describe('quickParamsOf', () => {
  it('Seedance：ratio 键 + 通用比例里不支持的置灰、多出的值追加；时长 4..30；分辨率枚举；生成音频开关', () => {
    const q = quickParamsOf(SEEDANCE);
    expect(q.ratioKey).toBe('ratio');
    expect(q.ratioDeclared).toBe(true);
    expect(q.ratioOptions.map((o) => o.value)).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive', '21:9']);
    expect(q.ratioOptions.every((o) => o.supported)).toBe(true);
    expect(q.durationOptions[0]).toBe(4);
    expect(q.durationOptions.at(-1)).toBe(30);
    expect(q.resolutionOptions).toEqual(['480p', '720p', '1080p']);
    expect(q.audioKey).toBe('generate_audio');
  });

  it('Kling：aspect_ratio 枚举外的 4:3 / 3:4 置灰；时长枚举 5/10', () => {
    const q = quickParamsOf(KLING);
    expect(q.ratioKey).toBe('aspect_ratio');
    expect(q.ratioOptions.filter((o) => !o.supported).map((o) => o.value)).toEqual(['4:3', '3:4']);
    expect(q.durationOptions).toEqual([5, 10]);
  });

  it('未选生成源 / 未声明比例：仍给通用比例（以 aspect_ratio 下发），缺省 9:16', () => {
    const q = quickParamsOf(null);
    expect(q.ratioKey).toBe('aspect_ratio');
    expect(q.ratioDeclared).toBe(false);
    expect(q.durationKey).toBeUndefined();
    expect(currentRatio(q, {}, {})).toBe('9:16');
    expect(currentRatio(q, {}, { aspect_ratio: '16:9' })).toBe('16:9');
  });
});

describe('参数写入', () => {
  it('schemaDefaults = schema default + default_params', () => {
    expect(schemaDefaults(AUTODL)).toEqual({ resolution: '768p竖', duration: 5, seed: 7 });
  });

  it('切源：沿用对新源仍合法的比例 / 时长，不合法的回到新源缺省', () => {
    const next = carryOverParams({ ratio: '4:3', duration: 12, resolution: '1080p', generate_audio: false }, KLING);
    expect(next.aspect_ratio).toBe('9:16'); // 4:3 Kling 不支持 → 缺省
    expect(next.duration).toBe(5); // 12 不在 5/10
    expect(next.resolution).toBe('720P');
    expect(next.generate_audio).toBe(false); // 布尔沿用
    const back = carryOverParams({ aspect_ratio: '16:9', duration: 10 }, SEEDANCE);
    expect(back.ratio).toBe('16:9');
    expect(back.duration).toBe(10);
  });

  it('paramsPatch：params 与 provider_params 同写、engine 顶层键同步（含删除）、比例镜像 aspect_ratio', () => {
    const q = quickParamsOf(SEEDANCE);
    const p = paramsPatch({ ratio: '16:9', duration: 8, resolution: '720p' }, q, { duration: 5, seed: 3 });
    expect(p.params).toEqual({ ratio: '16:9', duration: 8, resolution: '720p' });
    expect(p.provider_params).toBe(p.params);
    expect(p.duration).toBe(8);
    expect(p.resolution).toBe('720p');
    expect('seed' in p && p.seed === undefined).toBe(true); // 旧顶层 seed 清掉
    expect(p.aspect_ratio).toBe('16:9');
  });

  it('参数摘要：比例 · 分辨率 · 时长', () => {
    expect(paramsSummary(quickParamsOf(KLING), { aspect_ratio: '16:9', resolution: '1080P', duration: 10 })).toBe('16:9 · 1080P · 10秒');
  });
});

describe('参考模式', () => {
  it('旧值 i2v / r2v / t2v 显示为新模式名（kit normalizeVideoMode），显式模式原样交给 assembleInputs', () => {
    const refs = [ref('a', 'IMAGE')];
    expect(effectiveMode('i2v', refs, null)).toMatchObject({ mode: 'singleImage', auto: false, assembleMode: 'i2v' });
    expect(effectiveMode('r2v', refs, null)).toMatchObject({ mode: 'multiReference', auto: false });
    expect(effectiveMode('t2v', refs, null)).toMatchObject({ mode: 'text', auto: false });
    // i2v + 首尾帧 → kit 记为 startEnd
    const two = [ref('a', 'IMAGE'), ref('b', 'IMAGE')];
    const a = assembleInputs({ refs: two, targetType: 'video', prompt: 'x', mode: effectiveMode('i2v', two, null).assembleMode, refRoles: { a: 'first_frame', b: 'last_frame' } });
    expect(a.mode).toBe('startEnd');
    expect(a.providerMode).toBe('i2v');
  });

  it('自动：与 kit 一致时 assembleMode 为空（0 图文生、1 图单图、≥2 图多参考）', () => {
    expect(effectiveMode('', [], FULL)).toMatchObject({ mode: 'text', auto: true, assembleMode: '' });
    expect(effectiveMode('', [ref('a', 'IMAGE')], FULL)).toMatchObject({ mode: 'singleImage', assembleMode: '' });
    expect(effectiveMode(undefined, [ref('a', 'IMAGE'), ref('b', 'IMAGE')], FULL)).toMatchObject({ mode: 'multiReference', assembleMode: '' });
  });

  it('自动按生成源能力兜底（Toonflow 模式自动匹配）：只有首尾帧槽 → 首尾帧；只有参考图槽的单图 → 多参考；不收图 → 文生', () => {
    const two = [ref('a', 'IMAGE'), ref('b', 'IMAGE')];
    expect(resolveAutoMode(two, FIRST_LAST)).toBe('startEnd');
    const em = effectiveMode('', two, FIRST_LAST);
    expect(em).toMatchObject({ mode: 'startEnd', auto: true, assembleMode: 'startEnd' });
    const a = assembleInputs({ refs: two, targetType: 'video', prompt: 'x', mode: em.assembleMode, slots: FIRST_LAST });
    expect(a.args).toMatchObject({ first_frame: '/storage/a.png', last_frame: '/storage/b.png' });
    expect(a.warnings).toEqual([]);
    expect(resolveAutoMode([ref('a', 'IMAGE')], REF_ONLY)).toBe('multiReference');
    expect(resolveAutoMode([ref('a', 'IMAGE')], [])).toBe('text');
  });

  it('模式下拉：生成源支持的模式；显式值不受支持时也列出（标不支持）', () => {
    expect(modeOptions(REF_ONLY, '').map((o) => o.value)).toEqual(['text', 'singleImage', 'multiReference']);
    expect(modeOptions(REF_ONLY, 'startEnd').at(-1)).toEqual({ value: 'startEnd', supported: false });
    expect(modeOptions(null, '').length).toBe(4);
  });
});

describe('dataForRun', () => {
  it('去掉组装结果里没有的旧槽位键 / 生成源输入键 / text，保留 history、params 等', () => {
    const data = {
      prompt: '新提示词', text: '旧文本', first_frame: '/storage/old.png', reference_images: ['/storage/x.png'], camera_prompt: '旧机位',
      image: '/storage/old2.png', history: [{ url: '/storage/v.mp4', created_at: '' }], params: { duration: 5 }, skill_id: 'k', custom_in: 'z',
    };
    const def = { input_schema: { properties: { prompt: {}, first_frame: {}, custom_in: {} } } };
    const out = dataForRun(data, def, { prompt: '新提示词', reference_images: ['/storage/a.png'] });
    expect(out).not.toHaveProperty('first_frame');
    expect(out).not.toHaveProperty('text');
    expect(out).not.toHaveProperty('camera_prompt');
    expect(out).not.toHaveProperty('image');
    expect(out).not.toHaveProperty('custom_in');
    expect(out.reference_images).toEqual(['/storage/x.png']); // 本次组装里有，交给 override 覆盖
    expect(out).toMatchObject({ prompt: '新提示词', params: { duration: 5 }, skill_id: 'k' });
    expect(out.history).toBe(data.history);
    expect(data).toHaveProperty('first_frame'); // 不改原对象
  });
});

// FX-2：面板显示什么，直接生成就发什么（真实 comfyui_video params_schema，server 8001 /providers/comfyui_video 摘录）
const COMFYUI_VIDEO = {
  params_schema: {
    properties: {
      aspect_ratio: { type: 'string', title: '画面比例', enum: ['9:16', '16:9', '1:1'], default: '9:16', 'x-visibility': 'basic' },
      resolution: { type: 'string', title: '分辨率', enum: ['480p', '720p', '1080p'], default: '720p', 'x-visibility': 'basic' },
      duration: { type: 'integer', title: '时长', default: 5, minimum: 3, maximum: 15, 'x-visibility': 'basic' },
      fps: { type: 'integer', title: '帧率', enum: [16, 24, 30], default: 24, 'x-visibility': 'basic' },
    },
  },
  input_schema: { properties: { prompt: { type: 'string' }, first_frame: { type: 'string', format: 'uri', 'x-handle': 'image', 'x-slot': 'first_frame' } } },
};

describe('resolveVideoParams（FX-2）', () => {
  it('comfyui_video 节点 params 为空：补齐面板显示的比例 9:16 / 720p / 5 秒 / 24fps；不改入参', () => {
    const saved = {};
    const r = resolveVideoParams(COMFYUI_VIDEO, saved, {});
    expect(r).toEqual({ aspect_ratio: '9:16', resolution: '720p', duration: 5, fps: 24 });
    expect(saved).toEqual({});
    // 面板显示同一份
    const q = quickParamsOf(COMFYUI_VIDEO);
    expect(displayRatio(q, r, {}, true)).toBe('9:16');
    expect(paramsSummary(q, r, {}, displayRatio(q, r, {}, true))).toBe('9:16 · 720p · 5秒');
  });

  it('已存值优先；比例缺省按生成源缺省（Seedance 的 ratio=adaptive，不是 Toonflow 的 9:16）；开关缺省照发', () => {
    expect(resolveVideoParams(COMFYUI_VIDEO, { aspect_ratio: '16:9', duration: 8 }, {})).toEqual({ aspect_ratio: '16:9', resolution: '720p', duration: 8, fps: 24 });
    const r = resolveVideoParams(SEEDANCE, {}, {});
    expect(r).toEqual({ ratio: 'adaptive', resolution: '720p', duration: 5, generate_audio: true, watermark: false });
    expect(displayRatio(quickParamsOf(SEEDANCE), r, {}, true)).toBe('adaptive');
  });

  it('没有缺省的开关按「关」下发（面板开关只显示开 / 关）；没有缺省的数值不补（面板显示「默认」）', () => {
    const def = { params_schema: { properties: { generate_audio: { type: 'boolean' }, duration: { type: 'integer', enum: [5, 10] } } } };
    expect(resolveVideoParams(def, {}, {})).toEqual({ generate_audio: false });
  });

  it('旧画布顶层值（engine 镜像键）优先于缺省，类型 / 枚举对不上的不认', () => {
    expect(resolveVideoParams(AUTODL, {}, { duration: 8, resolution: '768p竖' })).toEqual({ resolution: '768p竖', duration: 8, seed: 7 });
    expect(resolveVideoParams(AUTODL, {}, { resolution: '1080p', duration: 'abc' })).toEqual({ resolution: '768p竖', duration: 5, seed: 7 });
    // 比例：顶层 aspect_ratio 是生成源支持的值才用，否则回到生成源缺省
    expect(resolveVideoParams(KLING, {}, { aspect_ratio: '16:9' }).aspect_ratio).toBe('16:9');
    expect(resolveVideoParams(KLING, {}, { aspect_ratio: '4:3' }).aspect_ratio).toBe('9:16');
    // Seedance 的比例键是 ratio：旧镜像的顶层 aspect_ratio 映射过去
    expect(resolveVideoParams(SEEDANCE, {}, { aspect_ratio: '1:1' }).ratio).toBe('1:1');
  });

  it('生成源没声明比例：不补比例、面板不选中任何比例；手动选过的照发', () => {
    const q = quickParamsOf(AUTODL);
    const r = resolveVideoParams(AUTODL, {}, { aspect_ratio: '16:9' });
    expect(r.aspect_ratio).toBeUndefined();
    expect(displayRatio(q, r, { aspect_ratio: '16:9' }, true)).toBe('');
    expect(paramsSummary(q, r, {}, displayRatio(q, r, {}, true))).toBe('768p竖 · 5秒');
    const manual = resolveVideoParams(AUTODL, { aspect_ratio: '1:1' }, {});
    expect(manual.aspect_ratio).toBe('1:1');
    expect(displayRatio(q, manual, {}, true)).toBe('1:1');
  });

  it('未选生成源：原样返回（没有声明可映射）；面板仍显示 Toonflow 缺省 9:16（智能规划由 Agent 定比例）', () => {
    expect(resolveVideoParams(null, { duration: 5 }, {})).toEqual({ duration: 5 });
    expect(displayRatio(quickParamsOf(null), {}, {}, false)).toBe('9:16');
  });

  it('提示词 / 媒体 / 隐藏参数不补', () => {
    const def = { params_schema: { properties: {
      text: { type: 'string', default: '旧台词' },
      negative: { type: 'string', 'x-role': 'prompt', default: 'x' },
      mask: { type: 'string', format: 'uri', default: '/m.png' },
      internal: { type: 'string', default: 'k', 'x-visibility': 'hidden' },
      steps: { type: 'integer', default: 20 },
    } } };
    expect(resolveVideoParams(def, {}, { text: '镜像提示词' })).toEqual({ steps: 20 });
  });
});
