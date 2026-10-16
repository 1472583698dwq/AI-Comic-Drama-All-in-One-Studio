import { describe, expect, it } from 'vitest';
import { coerceParamValue, materializeParams } from '../paramDefaults';

/** REQ-toonflow-canvas FX-2：直接生成时把面板显示的缺省参数补进请求（只补生成源声明的键）。 */

const DEF = {
  params_schema: {
    properties: {
      aspect_ratio: { type: 'string', enum: ['9:16', '16:9'], default: '9:16' },
      steps: { type: 'integer', default: 20 },
      seed: { type: 'integer' },
      hd: { type: 'boolean' },
      audio: { type: 'boolean', default: true },
      style: { type: 'string', default: 'anime', 'x-visibility': 'hidden' },
      prompt: { type: 'string', default: 'x' },
      ref: { type: 'string', format: 'uri', default: '/a.png' },
    },
  },
  default_params: { steps: 28 },
};

describe('materializeParams', () => {
  it('已存 → 顶层旧值 → default_params → schema default → 开关缺省关；隐藏 / 提示词 / 媒体不补；不改入参', () => {
    const saved = { seed: 7, extra: 'keep' };
    expect(materializeParams(DEF, saved, {})).toEqual({ seed: 7, extra: 'keep', aspect_ratio: '9:16', steps: 28, hd: false, audio: true });
    expect(saved).toEqual({ seed: 7, extra: 'keep' });
    // 顶层旧值：类型对得上才认（顶层 audio 是旧传播拷来的音频地址，不是开关）
    expect(materializeParams(DEF, {}, { steps: '12', aspect_ratio: '16:9', audio: '/storage/a.wav', hd: true })).toMatchObject({ steps: 12, aspect_ratio: '16:9', audio: true, hd: true });
  });

  it('skip 的键不补；没有 params_schema 时原样返回', () => {
    expect(materializeParams(DEF, {}, {}, { skip: ['aspect_ratio', 'hd'] })).toEqual({ steps: 28, audio: true });
    expect(materializeParams({}, { a: 1 })).toEqual({ a: 1 });
    expect(materializeParams(null, null)).toEqual({});
  });
});

describe('coerceParamValue', () => {
  it('枚举取枚举项、数值认有限数、布尔只认布尔、字符串只认字符串', () => {
    expect(coerceParamValue({ enum: [16, 24] }, '24')).toBe(24);
    expect(coerceParamValue({ enum: ['a'] }, 'b')).toBeUndefined();
    expect(coerceParamValue({ type: 'number' }, '1.5')).toBe(1.5);
    expect(coerceParamValue({ type: 'integer' }, true)).toBeUndefined();
    expect(coerceParamValue({ type: 'boolean' }, 'true')).toBeUndefined();
    expect(coerceParamValue({ type: 'string' }, 3)).toBeUndefined();
    expect(coerceParamValue({ type: 'string' }, { a: 1 })).toBeUndefined();
  });
});
