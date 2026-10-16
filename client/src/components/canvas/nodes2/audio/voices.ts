// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 语音源音色库（沿用 TTSNode：音色列表 = 后端 /tts/voices，按语音源取）。
 * 用 `/tts/voices/{provider}`：同时带回 is_configured / health，参数弹层据此提示语音源是否可用。
 * 代码生成源（如「MiniMax H3 音频生成」）自己不报音色时，名字里带 MiniMax 的回落到 MiniMax 预设音色。
 */
import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../../../../utils/devOrigin';

export interface VoiceOption {
  id: string;
  name: string;
  gender?: string;
  tags?: string[];
}

export interface VoiceCatalog {
  voices: VoiceOption[];
  /** 后端 is_configured（未知为 undefined） */
  configured?: boolean;
  /** 后端健康检查（未知为 undefined） */
  healthy?: boolean;
  /** 音色借用自哪个语音源（如 minimax） */
  borrowedFrom?: string;
}

const cache = new Map<string, Promise<VoiceCatalog>>();

async function fetchCatalog(providerId: string): Promise<VoiceCatalog> {
  const res = await fetch(`${API_BASE_URL}/tts/voices/${encodeURIComponent(providerId)}`);
  if (!res.ok) return { voices: [] };
  const body: any = await res.json().catch(() => null);
  const voices: VoiceOption[] = (Array.isArray(body?.voices) ? body.voices : [])
    .map((v: any) => ({
      id: String(v?.voice_id ?? v?.id ?? ''),
      name: String(v?.voice_name ?? v?.name ?? v?.voice_id ?? v?.id ?? ''),
      gender: v?.gender ? String(v.gender) : undefined,
      tags: Array.isArray(v?.tags) ? v.tags.map(String) : undefined,
    }))
    // 「未配置参考音频」这类 id 为空的占位项不是可选音色
    .filter((v: VoiceOption) => !!v.id);
  return {
    voices,
    configured: typeof body?.is_configured === 'boolean' ? body.is_configured : undefined,
    healthy: typeof body?.health === 'boolean' ? body.health : undefined,
  };
}

/** 拉取某语音源的音色（按语音源缓存；失败返回空列表，不抛错）。 */
export function loadVoices(providerId: string, providerName = ''): Promise<VoiceCatalog> {
  if (!providerId) return Promise.resolve({ voices: [] });
  const key = `${providerId}\u0000${providerName}`;
  let job = cache.get(key);
  if (!job) {
    job = (async () => {
      const own = await fetchCatalog(providerId);
      if (own.voices.length || providerId === 'minimax' || !/minimax/i.test(`${providerId} ${providerName}`)) return own;
      const mm = await fetchCatalog('minimax').catch(() => ({ voices: [] as VoiceOption[] }));
      return mm.voices.length ? { ...own, voices: mm.voices, borrowedFrom: 'minimax' } : own;
    })().catch(() => ({ voices: [] }));
    cache.set(key, job);
  }
  return job;
}

/** 仅测试用。 */
export function clearVoiceCache(): void {
  cache.clear();
}

export function useVoices(providerId: string | undefined, providerName?: string): { catalog: VoiceCatalog | null; loading: boolean } {
  const [state, setState] = useState<{ id: string; catalog: VoiceCatalog | null }>({ id: '', catalog: null });
  useEffect(() => {
    let alive = true;
    if (!providerId) return;
    loadVoices(providerId, providerName).then((catalog) => {
      if (alive) setState({ id: providerId, catalog });
    });
    return () => {
      alive = false;
    };
  }, [providerId, providerName]);
  const ready = !!providerId && state.id === providerId;
  return { catalog: ready ? state.catalog : null, loading: !!providerId && !ready };
}
