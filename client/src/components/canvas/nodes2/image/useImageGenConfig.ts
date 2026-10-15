// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 图片生成源与参数（PromptPanel 的「生成源」下拉 + 参数弹层共用，图片生成节点与图片节点的局部重绘都用）。
 * - 列表：kit useProviderSources('image')，下拉展开时强制刷新一次（Toonflow 展开即 loadModels）；
 * - 首项「Agent 自动选源」（provider_id 为空，只能配合智能规划使用，同旧 NodeAgentConsole）；
 * - 定义：useProviderDefinition → input_schema 槽位（extractSlotsFromProvider）+ params_schema 控件（paramsSchemaToSpecs）；
 * - 切源：参数重置为新源默认值（params_schema default + default_params），同旧 selectProvider。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { GenSourceOption } from '../../kit/PromptPanel';
import { loadProviderDefinition, loadProviderSources, useProviderDefinition, useProviderSources, type ProviderSource } from '../../kit/useProviderSources';
import { extractSlotsFromProvider, type AssetSlotDef, type DynamicProviderInfo } from '../../providerSkills';
import type { ControlSpec } from '../../controls/DynamicControl';
import { detectQuickParams, paramsSummary, providerDefaultParams, type QuickParams } from './imageParams';

export const AUTO_SOURCE_ID = '';
export const AUTO_SOURCE: GenSourceOption = {
  id: AUTO_SOURCE_ID,
  label: 'Agent 自动选源',
  description: '开启智能规划后由 Agent 按意图挑选生成源；直接生成需要先选定生成源',
};

function groupOf(raw: Record<string, unknown>): string {
  if (raw.provider_type === 'comfyui') return 'ComfyUI 工作流';
  if (raw.provider_type === 'code') return '代码源';
  if (raw.builtin) return '内置';
  return '自定义';
}

export function toSourceOption(s: ProviderSource): GenSourceOption {
  const raw = s.raw || {};
  const label = String(raw.display_name || s.name || s.id);
  const desc = typeof raw.description === 'string' && raw.description ? raw.description : undefined;
  return { id: s.id, label, group: groupOf(raw), description: desc ? `${label} · ${desc}` : `${label}（${s.id}）`, disabled: raw.enabled === false };
}

export interface ImageGenConfig {
  sourceOptions: GenSourceOption[];
  sourcesLoading: boolean;
  refreshSources: () => void;
  def: Record<string, unknown> | null;
  /** 所选生成源的媒体槽位；未选源 / 定义未到时为 null（assembleInputs 视为未知能力）。 */
  slots: AssetSlotDef[] | null;
  quick: QuickParams;
  /** 生成源有多个模型时的「模型」控件（写 data.model）。 */
  modelSpec?: ControlSpec;
  summary: { text: string; ratio?: string };
  /** 选源：异步拉定义算默认参数后回调。 */
  selectProvider: (id: string, apply: (id: string, defaults: Record<string, unknown>, def: Record<string, unknown> | null) => void) => void;
}

export function useImageGenConfig(providerId: string, params: Record<string, unknown> | null | undefined): ImageGenConfig {
  const { sources, loading } = useProviderSources('image');
  const [fresh, setFresh] = useState<ProviderSource[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const lastRefresh = useRef(0);
  const refreshSources = useCallback(() => {
    const now = Date.now();
    if (now - lastRefresh.current < 3000) return;
    lastRefresh.current = now;
    setRefreshing(true);
    loadProviderSources('image', { refresh: true }).then((list) => {
      setFresh(list);
      setRefreshing(false);
    });
  }, []);
  const list = fresh ?? sources;
  const sourceOptions = useMemo(() => [AUTO_SOURCE, ...list.map(toSourceOption)], [list]);

  const def = useProviderDefinition(providerId || undefined);
  const slots = useMemo(() => (providerId && def ? extractSlotsFromProvider(def as unknown as DynamicProviderInfo, 'image') : null), [providerId, def]);
  const quick = useMemo(() => detectQuickParams(def?.params_schema), [def]);
  const modelSpec = useMemo<ControlSpec | undefined>(() => {
    const models = Array.isArray(def?.models) ? (def!.models as unknown[]).map(String).filter(Boolean) : [];
    if (models.length < 2) return undefined;
    return {
      id: 'model', param_name: 'model', label: '模型', type: 'combo', options: models,
      default_value: typeof def?.default_model === 'string' && def.default_model ? def.default_model : models[0],
      visibility: 'basic', agent: 'suggest', category: 'advanced',
    };
  }, [def]);
  const summary = useMemo(() => paramsSummary(params, quick), [params, quick]);

  const pending = useRef(0);
  const selectProvider = useCallback<ImageGenConfig['selectProvider']>((id, apply) => {
    const token = ++pending.current;
    if (!id) { apply(id, {}, null); return; }
    const fallback = list.find((s) => s.id === id)?.raw ?? null;
    loadProviderDefinition(id).then((d) => {
      if (token !== pending.current) return;
      const got = d ?? fallback;
      apply(id, providerDefaultParams(got), got);
    });
  }, [list]);

  return { sourceOptions, sourcesLoading: loading || refreshing, refreshSources, def, slots, quick, modelSpec, summary, selectProvider };
}
