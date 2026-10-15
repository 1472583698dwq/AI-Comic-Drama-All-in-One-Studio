// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 生成源列表（PromptPanel 的「模型」下拉换成 MiniMax 生成源）。
 * 按 kind 拉一次并缓存；definition（input_schema / params_schema）按需拉取并缓存，
 * 供 extractSlotsFromProvider / paramsSchemaToSpecs 使用。
 * K1：invalidateProviderSources() 或应用广播 `provider-list-refresh`（插件热插拔 / 生成源增删改，见 services/extensionsStream.ts）
 * 后，已挂载的 useProviderSources / useProviderDefinition 自动重拉。
 */
import { useCallback, useEffect, useState } from 'react';
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

// —— K1：缓存失效订阅（已挂载的 hook 重拉）——
/** 应用里「生成源列表变了」的广播事件（extensionsStream 重播 / 生成源管理弹窗 / Agent 建源都会发）。 */
export const PROVIDER_REFRESH_EVENT = 'provider-list-refresh';
const subscribers = new Set<() => void>();
let generation = 0;
let notifyPending = false;
let windowListening = false;

function scheduleNotify(): void {
  if (notifyPending) return;
  notifyPending = true;
  // 同一轮里多次失效（如节点先 invalidate 再派发 provider-list-refresh）只重拉一次
  queueMicrotask(() => {
    notifyPending = false;
    subscribers.forEach((fn) => fn());
  });
}

function onRefreshEvent(): void {
  invalidateProviderSources();
}

function subscribeInvalidation(fn: () => void): () => void {
  subscribers.add(fn);
  if (!windowListening && typeof window !== 'undefined') {
    window.addEventListener(PROVIDER_REFRESH_EVENT, onRefreshEvent);
    windowListening = true;
  }
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && windowListening && typeof window !== 'undefined') {
      window.removeEventListener(PROVIDER_REFRESH_EVENT, onRefreshEvent);
      windowListening = false;
    }
  };
}

/** 失效计数（每次 invalidateProviderSources +1），可作依赖。 */
export function providerSourcesGeneration(): number {
  return generation;
}

/** 插件热插拔 / 生成源变更后清缓存，并让已挂载的 useProviderSources / useProviderDefinition 重拉。 */
export function invalidateProviderSources(): void {
  listCache.clear();
  defCache.clear();
  generation++;
  scheduleNotify();
}

/** 订阅失效：返回当前失效计数（变化时组件重渲染）。 */
function useInvalidationGeneration(): number {
  const [gen, setGen] = useState(generation);
  useEffect(() => {
    const sync = () => setGen(generation);
    sync(); // 首次渲染到订阅之间若已失效过，对齐一次（值相同时 React 不会重渲染）
    return subscribeInvalidation(sync);
  }, []);
  return gen;
}

export function useProviderSources(kind: SourceKind): { sources: ProviderSource[]; loading: boolean; reload: () => void } {
  const [sources, setSources] = useState<ProviderSource[]>([]);
  const [loading, setLoading] = useState(true);
  const gen = useInvalidationGeneration();
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
  }, [kind, gen]);
  /** K1：强制重拉（清掉全部生成源缓存，所有已挂载的 hook 都会更新）。 */
  const reload = useCallback(() => invalidateProviderSources(), []);
  return { sources, loading, reload };
}

export function useProviderDefinition(providerId: string | undefined): Record<string, unknown> | null {
  // K1：按 id 存定义，换 id 时不再返回上一个生成源的定义（加载期间为 null）；失效重拉期间保留当前定义不闪烁
  const [state, setState] = useState<{ id: string; def: Record<string, unknown> | null } | null>(null);
  const gen = useInvalidationGeneration();
  useEffect(() => {
    let alive = true;
    if (!providerId) {
      setState(null);
      return;
    }
    loadProviderDefinition(providerId).then((d) => {
      if (alive) setState({ id: providerId, def: d });
    });
    return () => {
      alive = false;
    };
  }, [providerId, gen]);
  return providerId && state?.id === providerId ? state.def : null;
}
