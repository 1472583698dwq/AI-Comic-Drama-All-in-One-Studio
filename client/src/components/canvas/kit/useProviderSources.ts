// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 生成源列表（PromptPanel 的「模型」下拉换成 MiniMax 生成源）。
 * 按 kind 拉一次并缓存；definition（input_schema / params_schema）按需拉取并缓存，
 * 供 extractSlotsFromProvider / paramsSchemaToSpecs 使用。
 */
import { useEffect, useState } from 'react';
import { apiService } from '../../../services/api';

export type SourceKind = 'image' | 'video' | 'audio' | 'llm';

export interface ProviderSource {
  id: string;
  name: string;
  kind: SourceKind;
  /** 原始列表项（含 health / builtin 等字段），按需取用 */
  raw: Record<string, unknown>;
}

const listCache = new Map<SourceKind, Promise<ProviderSource[]>>();
const defCache = new Map<string, Promise<Record<string, unknown> | null>>();

function toSource(p: any, kind: SourceKind): ProviderSource | null {
  const id = String(p?.id ?? p?.provider_id ?? '');
  if (!id) return null;
  return { id, name: String(p?.name ?? p?.display_name ?? id), kind, raw: p ?? {} };
}

/** 拉取某类生成源（已缓存）；失败返回空数组，不抛错。 */
export function loadProviderSources(kind: SourceKind, opts: { refresh?: boolean } = {}): Promise<ProviderSource[]> {
  if (opts.refresh) listCache.delete(kind);
  let p = listCache.get(kind);
  if (!p) {
    p = apiService
      .listProviders({ kind, include_builtin: true, production_only: true })
      .then((res) => (res?.providers ?? []).map((x: any) => toSource(x, kind)).filter(Boolean) as ProviderSource[])
      .catch(() => [] as ProviderSource[]);
    listCache.set(kind, p);
  }
  return p;
}

/** 生成源完整定义（含 input_schema / params_schema），已缓存。 */
export function loadProviderDefinition(providerId: string): Promise<Record<string, unknown> | null> {
  if (!providerId) return Promise.resolve(null);
  let p = defCache.get(providerId);
  if (!p) {
    p = apiService
      .getProvider(providerId)
      .then((res: any) => (res?.provider ?? res ?? null) as Record<string, unknown> | null)
      .catch(() => null);
    defCache.set(providerId, p);
  }
  return p;
}

/** 插件热插拔后清缓存（宿主收到 *-list-refresh 事件时调用）。 */
export function invalidateProviderSources(): void {
  listCache.clear();
  defCache.clear();
}

export function useProviderSources(kind: SourceKind): { sources: ProviderSource[]; loading: boolean } {
  const [sources, setSources] = useState<ProviderSource[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadProviderSources(kind).then((list) => {
      if (!alive) return;
      setSources(list);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [kind]);
  return { sources, loading };
}

export function useProviderDefinition(providerId: string | undefined): Record<string, unknown> | null {
  const [def, setDef] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let alive = true;
    if (!providerId) {
      setDef(null);
      return;
    }
    loadProviderDefinition(providerId).then((d) => {
      if (alive) setDef(d);
    });
    return () => {
      alive = false;
    };
  }, [providerId]);
  return def;
}
