// REQ-toonflow-canvas N4：Toonflow 音频设置 ↔ 生成源 params_schema 的映射、参数补丁、波形峰值。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORMAT, DEFAULT_LANGUAGE, DEFAULT_SAMPLE_RATE, audioSettingsOf, currentSettingValue, matchSettingValue, paramPatch,
  providerSwitchPatch, schemaDefaults, settingControls, settingLabel, specialParamKeys, toDataValue, voiceParamKey,
} from '../audioSettings';
import { formatPreciseTime, formatTime, getWaveformPeaks, rawPeaks, resamplePeaks } from '../waveform';

const COSY = { params_schema: { properties: { voice_id: { type: 'string' }, emotion: { type: 'string', enum: ['neutral', 'happy'], default: 'neutral' }, speed: { type: 'number', default: 1 } } } };
const RICH = {
  params_schema: {
    properties: {
      text: { type: 'string' },
      voice: { type: 'string', 'x-role': 'voice', default: 'alloy' },
      language: { type: 'string', enum: ['zh', 'en', 'ja'] },
      sample_rate: { type: 'integer', enum: [16000, 24000, 44100], default: 16000 },
      response_format: { type: 'string', enum: ['mp3', 'opus', 'wav'], default: 'mp3' },
      speed: { type: 'number', default: 1 },
    },
  },
  default_params: { speed: 1.1 },
};

describe('Toonflow 音频设置', () => {
  it('缺省值（zh-CN / 24000 / wav）', () => {
    expect([DEFAULT_LANGUAGE, DEFAULT_SAMPLE_RATE, DEFAULT_FORMAT]).toEqual(['zh-CN', 24000, 'wav']);
    expect(audioSettingsOf({})).toEqual({ language: 'zh-CN', sampleRate: 24000, format: 'wav' });
    expect(audioSettingsOf({ language: 'en', sampleRate: '48000', format: 'mp3' })).toEqual({ language: 'en', sampleRate: 48000, format: 'mp3' });
  });

  it('只显示生成源声明了的设置；枚举取源的值', () => {
    expect(settingControls(COSY)).toEqual([]);
    expect(settingControls(null)).toEqual([]);
    const controls = settingControls(RICH);
    expect(controls.map((c) => [c.key, c.paramKey])).toEqual([['language', 'language'], ['sampleRate', 'sample_rate'], ['format', 'response_format']]);
    expect(controls[0].options.map((o) => o.label)).toEqual(['中文', '英文', 'ja']);
    expect(controls[1].options.map((o) => o.label)).toEqual(['16k', '24k', '44.1k']);
    expect(controls[2].options.map((o) => o.label)).toEqual(['MP3', 'Opus', 'WAV']);
    // 没有 enum 时用 Toonflow 选项
    const plain = settingControls({ params_schema: { properties: { format: { type: 'string' } } } });
    expect(plain[0].options.map((o) => o.value)).toEqual(['wav', 'mp3', 'pcm', 'ogg_opus']);
  });

  it('节点数据 ↔ 源选项互相映射', () => {
    const [lang, sr, fmt] = settingControls(RICH);
    expect(matchSettingValue('language', lang.options, 'zh-CN')).toBe('zh');
    expect(matchSettingValue('sampleRate', sr.options, '24000')).toBe(24000);
    expect(matchSettingValue('format', fmt.options, 'ogg_opus')).toBe('opus');
    expect(matchSettingValue('sampleRate', sr.options, 48000)).toBeUndefined();
    expect(currentSettingValue(lang, {}, { language: 'en' }, RICH)).toBe('en');
    expect(currentSettingValue(sr, { sample_rate: 44100 }, {}, RICH)).toBe(44100);
    expect(currentSettingValue(sr, {}, { sampleRate: 48000 }, RICH)).toBe(16000); // 映射不上 → 源默认
    expect(toDataValue('language', 'zh')).toBe('zh-CN');
    expect(toDataValue('format', 'opus')).toBe('ogg_opus');
    expect(toDataValue('sampleRate', '16000')).toBe(16000);
    expect(settingLabel('sampleRate', 8000)).toBe('8k');
  });

  it('台词 / 音色 / 设置键不进 DynamicControl；schema 默认值不含台词', () => {
    expect(voiceParamKey(COSY)).toBe('voice_id');
    expect(voiceParamKey(RICH)).toBe('voice');
    expect([...specialParamKeys(RICH)].sort()).toEqual(['language', 'response_format', 'sample_rate', 'text', 'voice'].sort());
    expect(schemaDefaults(RICH)).toEqual({ voice: 'alloy', sample_rate: 16000, response_format: 'mp3', speed: 1.1 });
  });
});

describe('参数补丁', () => {
  it('paramPatch：params + provider_params + 顶层同名键；空值删除', () => {
    expect(paramPatch({ params: { a: 1 } }, 'speed', 1.5)).toEqual({ params: { a: 1, speed: 1.5 }, provider_params: { a: 1, speed: 1.5 }, speed: 1.5 });
    expect(paramPatch({ params: { a: 1, speed: 2 } }, 'speed', '')).toEqual({ params: { a: 1 }, provider_params: { a: 1 }, speed: undefined });
  });

  it('providerSwitchPatch：换源重置为新源默认值，Toonflow 设置映射进参数，音色 / 情绪跟随新源', () => {
    const data = { provider_id: 'cosyvoice', params: { voice_id: '中文女', emotion: 'happy' }, voice_id: '中文女', emotion: 'happy', language: 'en', format: 'ogg_opus' };
    const p = providerSwitchPatch(data, 'rich', RICH);
    expect(p).toMatchObject({ provider_id: 'rich', provider: 'rich', _last_agent_plan: undefined, _polling: false });
    // 节点里的 Toonflow 设置（缺省 24000）在新源支持时优先于新源默认值（16000）
    expect(p.params).toEqual({ voice: 'alloy', sample_rate: 24000, response_format: 'opus', speed: 1.1, language: 'en' });
    expect(p.provider_params).toBe(p.params);
    expect(p.voice).toBe('alloy');
    expect(p.voice_id).toBe('alloy');
    // 同源重选：保留已有参数
    const same = providerSwitchPatch(data, 'cosyvoice', COSY);
    expect(same.params).toEqual({ voice_id: '中文女', emotion: 'happy' });
    expect('voice_id' in same).toBe(false);
    // 清空
    expect(providerSwitchPatch(data, '', null)).toMatchObject({ provider_id: undefined, provider: undefined });
  });
});

describe('波形', () => {
  it('Toonflow getWaveformPeaks：多声道取最大、归一化；极短音频铺满条数', () => {
    const l = new Float32Array([0, 0.5, -1, 0.25]);
    const r = new Float32Array([0.1, -0.2, 0.3, 0.9]);
    expect(getWaveformPeaks([l, r], 2)).toEqual([0.5, 1]);
    expect(getWaveformPeaks([new Float32Array([0.5])], 3)).toEqual([1, 1, 1]);
    expect(getWaveformPeaks([new Float32Array(4)], 2)).toEqual([0, 0]);
    expect(() => rawPeaks([l], 0)).toThrow(RangeError);
  });

  it('resamplePeaks：max-pooling 降采样并归一', () => {
    expect(resamplePeaks([0.1, 0.4, 0.2, 0.8], 2)).toEqual([0.5, 1]);
    expect(resamplePeaks([], 4)).toEqual([]);
    expect(resamplePeaks([0.2, 0.4], 4)).toEqual([0.5, 0.5, 1, 1]);
  });

  it('时间格式', () => {
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatPreciseTime(3.6)).toBe('0:03.60');
    expect(formatPreciseTime(61.234)).toBe('1:01.23');
  });
});
