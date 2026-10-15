// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N4 音频节点注册：
 *   load-audio「音频」（上传 / 素材库拖入 / 波形播放 / 截取 / 变速）
 *   audio「音频生成」（台词 + 语音源 + 音色情绪 / 语种采样率格式 + 智能规划；图片 + 音频参考合计 ≤1）
 * 类型 id 与输出口沿用旧画布（COORDINATION 第 1 条：load-audio→audio，audio→audio，输入口 in）。
 */
import { IconMusic, IconMusicBolt } from '@tabler/icons-react';
import { defineNode } from '../../kit/registry';
import type { PortDef } from '../../kit/types';
import { LoadAudioNode } from './LoadAudioNode';
import { AudioGenNode } from './AudioGenNode';
import { audioGenCanConnect } from './connect';
import { DEFAULT_FORMAT, DEFAULT_LANGUAGE, DEFAULT_SAMPLE_RATE } from './audioSettings';

export const LOAD_AUDIO_PORTS: PortDef[] = [
  { id: 'audio', type: 'source', dataType: 'AUDIO', label: '音频输出' },
];

export const AUDIO_GEN_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['IMAGE', 'AUDIO', 'STRING'], label: '图片或音频限 1 个，文本不限' },
  { id: 'audio', type: 'source', dataType: 'AUDIO', label: '音频输出' },
];

export const loadAudioNodeDef = defineNode({
  type: 'load-audio',
  label: '音频',
  icon: IconMusic,
  category: 'audio',
  ports: LOAD_AUDIO_PORTS,
  component: LoadAudioNode,
  width: 360,
  description: '上传或从素材库拖入音频：波形播放、截取片段、变速',
});

export const audioGenNodeDef = defineNode({
  type: 'audio',
  label: '音频生成',
  icon: IconMusicBolt,
  category: 'audio',
  ports: AUDIO_GEN_PORTS,
  component: AudioGenNode,
  width: 360,
  canConnect: audioGenCanConnect,
  defaultData: () => ({
    text: '',
    prompt: '',
    language: DEFAULT_LANGUAGE,
    sampleRate: DEFAULT_SAMPLE_RATE,
    format: DEFAULT_FORMAT,
    refOrder: [],
    refRoles: {},
  }),
  description: '台词配音 / 音频生成：选语音源、音色与情绪，可连参考音频克隆音色',
});

export { LoadAudioNode, type LoadAudioData } from './LoadAudioNode';
export { AudioGenNode, type AudioGenData } from './AudioGenNode';
export { audioGenerationInputs, audioPromptValue, legacyRefAudioOf, declaresAudioSlot } from './genInputs';
export { AudioPlayer, WaveformCanvas, useWaveform, type AudioPlayerHandle, type AudioPlayerProps } from './AudioPlayer';
export { AudioTrimDialog } from './AudioTrimDialog';
export { AudioSpeedPanel } from './AudioSpeedPanel';
export { AudioHistoryDialog, historyItems } from './AudioHistoryDialog';
export { AudioParamsPanel } from './AudioParamsPanel';
export { useAudioProcessing, derivedLabel, isValidSpeed, isValidTrim, SPEED_MIN, SPEED_MAX, MIN_TRIM_SPAN, type AudioActionMode } from './useAudioProcessing';
export { audioGenCanConnect, countMediaRefs, isLimitedMediaRef, MEDIA_REF_LIMIT } from './connect';
export { uploadAudioFile, resolveDroppedAudioUrl, readDropPayload, loadAudioPatch, loadAudioUrlOf, toStoredUrl, fileNameOf, isAudioFile, looksLikeAudioUrl } from './media';
export { loadVoices, useVoices, type VoiceCatalog, type VoiceOption } from './voices';
export * from './audioSettings';
export { getWaveformPeaks, resamplePeaks, decodeWaveform, formatTime, formatPreciseTime } from './waveform';
