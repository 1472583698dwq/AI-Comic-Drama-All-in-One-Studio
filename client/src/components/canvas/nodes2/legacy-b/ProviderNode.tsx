// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N7 换皮：生成源节点 `provider` / `provider-image` / `provider-video` / `provider-audio` / `provider-llm`
 * （原 nodes/ProviderNode.tsx）。选源、模型、参数（DynamicControl，保留 x-agent 徽标）、保存参数到生成源、API Key、
 * 连通检测、删除自定义源、就地新建源（贴文档 / 写代码 / 工作流，建好自动选中）全部保留；
 * 右侧 `provider` 输出口把生成源 id / 模型交给下游（宿主用 inputs.providerPatchFor 透传）。
 * 数据键沿用：provider_id / provider / kind / definition / model / params / default_params。
 *
 * 与旧组件的差异（都是修 bug）：provider-llm 列 LLM 源（旧的落成生图源）；重新拉列表不再把用户调过的参数重置成默认值；
 * 新建源只选中到发起的那个节点（旧的会让画布上所有生成源节点都选中）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import {
  IconActivityHeartbeat, IconAdjustmentsHorizontal, IconDeviceFloppy, IconEye, IconEyeOff, IconKey, IconPlug, IconPlus, IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { useKitNodeActions } from '../../kit/hostContext';
import { invalidateProviderSources } from '../../kit/useProviderSources';
import { apiService } from '../../../../services/api';
import { confirmAsync, toast } from '../../../../stores/useDialogStore';
import { paramsSchemaToSpecs } from '../../providerSkills';
import { providerDefOf, providerIdOf, providerKindOf, providerNodePorts } from './ports';
import { PROVIDER_KIND_META } from './model';
import { LbAlert, LbButton, LbDot, LbField, LbInput, LbSelect, LbTag, ParamsSection } from './ui';

type AnyData = Record<string, any>;

const MANUAL_MODEL = '__manual__';

function sameJson(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** 列表 / 详情接口的生成源对象（provider 字段或本身）。 */
function unwrapProvider(res: any): AnyData | null {
  const p = res?.provider ?? res;
  return p && typeof p === 'object' && p.id ? (p as AnyData) : null;
}

const EMPTY: AnyData = {};

export function ProviderNode(props: NodeProps) {
  const d = (props.data || EMPTY) as AnyData;
  const actions = useKitNodeActions(props.id);
  const kind = providerKindOf(props.type, d);
  const meta = PROVIDER_KIND_META[kind];
  const selectedId = providerIdOf(d);
  const dataDef = providerDefOf(d);

  // —— 生成源列表（不限 production_ready：这里是「管理」节点，自定义 / 未验证的源也要能选）——
  const [providers, setProviders] = useState<AnyData[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const fetchProviders = useCallback(async (): Promise<AnyData[]> => {
    setListLoading(true);
    try {
      const res = await apiService.listProviders({ kind, include_builtin: true });
      const list = Array.isArray(res?.providers) ? res.providers : [];
      setProviders(list);
      return list;
    } catch {
      // 旧组件的兜底：生图源退回旧接口，只显示已验证源
      if (kind === 'image') {
        const alt: any = await apiService.listImageProviders().catch(() => null);
        const list = Array.isArray(alt?.providers) ? alt.providers.filter((p: AnyData) => p.production_ready === true) : [];
        setProviders(list);
        return list;
      }
      setProviders([]);
      return [];
    } finally {
      setListLoading(false);
    }
  }, [kind]);
  useEffect(() => { void fetchProviders(); }, [fetchProviders]);
  useEffect(() => {
    const h = () => void fetchProviders();
    window.addEventListener('provider-list-refresh', h);
    return () => window.removeEventListener('provider-list-refresh', h);
  }, [fetchProviders]);

  // —— 选中的定义：列表里的最新定义同步回 data.definition（端口 / 引擎都读它），不动用户参数 ——
  const listDef = useMemo(() => providers.find((p) => p.id === selectedId) ?? null, [providers, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    if (listDef) {
      if (!sameJson(listDef, dataDef)) actions.update({ definition: listDef, ...(d.kind ? {} : { kind }) });
      return;
    }
    if (dataDef?.id === selectedId || listLoading) return;
    let alive = true;
    apiService.getProvider(selectedId).then((res) => {
      const got = unwrapProvider(res);
      if (alive && got) actions.update({ definition: got });
    }).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listDef, selectedId, listLoading]);
  const def: AnyData | null = listDef ?? (dataDef?.id === selectedId ? dataDef : null);
  const isBuiltin = !!def?.builtin;

  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; detail?: string } | null>(null);

  const select = useCallback((pid: string, list: AnyData[] = providers, fallback?: AnyData | null) => {
    if (!pid) {
      actions.update({ provider_id: '', provider: '', definition: null, model: '', ...(d.providerId ? { providerId: '' } : {}) });
      return;
    }
    const found = list.find((p) => p.id === pid) ?? fallback ?? null;
    const m = found?.default_model || found?.models?.[0] || '';
    const dp = (found?.default_params && typeof found.default_params === 'object') ? found.default_params : {};
    // 用户换源：参数回到该源的默认值（同旧组件）
    actions.update({ provider_id: pid, provider: pid, kind, definition: found, model: m, default_params: dp, params: dp });
    setHealth(null);
  }, [providers, actions, kind, d.providerId]);

  // 新建自定义源成功且由本节点发起 → 自动选用新源
  useEffect(() => {
    const h = async (e: Event) => {
      const det = ((e as CustomEvent).detail || {}) as AnyData;
      if (!det.select || det.source !== `provider-node:${props.id}` || !det.provider?.id) return;
      const list = await fetchProviders();
      select(det.provider.id, list, det.provider);
      toast.success(`已选用新生成源：${det.provider.display_name || det.provider.name || det.provider.id}`);
    };
    window.addEventListener('provider-created', h);
    return () => window.removeEventListener('provider-created', h);
  }, [props.id, fetchProviders, select]);

  // —— 模型 ——
  const model: string = (typeof d.model === 'string' && d.model) || def?.default_model || def?.models?.[0] || '';
  const models: string[] = Array.isArray(def?.models) ? def!.models.filter((m: unknown) => typeof m === 'string') : [];
  const [manualModel, setManualModel] = useState(false);
  const setModel = (m: string) => actions.update({ model: m, provider_id: selectedId, kind });

  // —— 参数 ——
  const paramSpecs = useMemo(() => paramsSchemaToSpecs(def?.params_schema), [def]);
  const paramValues: AnyData = useMemo(() => {
    const own = (d.params && typeof d.params === 'object' ? d.params : d.default_params && typeof d.default_params === 'object' ? d.default_params : null) as AnyData | null;
    return { ...(def?.default_params || {}), ...(own || {}) };
  }, [d.params, d.default_params, def]);
  const setParam = (name: string, v: unknown) => {
    const next = { ...paramValues, [name]: v };
    actions.update({ default_params: next, params: next });
  };
  const [savingParams, setSavingParams] = useState(false);
  const saveParams = async () => {
    if (!selectedId || isBuiltin) return;
    setSavingParams(true);
    try {
      const res: any = await apiService.updateProvider(selectedId, { default_params: paramValues, default_model: model });
      if (res?.status === 'success' || res?.provider) {
        toast.success('✓ 参数已保存');
        const nextDef = unwrapProvider(res) ?? { ...def, default_params: paramValues, default_model: model };
        actions.update({ definition: nextDef, default_params: paramValues, params: paramValues, model });
        invalidateProviderSources();
        window.dispatchEvent(new Event('provider-list-refresh'));
      } else {
        toast.error(`保存失败: ${JSON.stringify(res).slice(0, 300)}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingParams(false);
    }
  };

  // —— API Key ——
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const saveKey = async () => {
    if (!selectedId || !apiKeyInput.trim()) { toast.error('请输入 API Key'); return; }
    setSavingKey(true);
    try {
      const res: any = await apiService.setProviderApiKey(selectedId, apiKeyInput.trim());
      if (res?.status === 'success' || res?.has_key) {
        toast.success('✓ API Key 已保存');
        setApiKeyInput('');
        void fetchProviders();
      } else {
        toast.error(JSON.stringify(res));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(false);
    }
  };

  // —— 连通检测（不真调上游，不耗额度）——
  const test = async () => {
    if (!selectedId || testing) return;
    setTesting(true);
    try {
      const res: any = await apiService.testProvider(selectedId);
      setHealth({ ok: !!res?.ok, detail: res?.detail });
      if (res?.ok) toast.success('✓ 连通正常');
      else toast.error(`✗ 检测结果: ${res?.detail || JSON.stringify(res)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHealth({ ok: false, detail: msg });
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  };

  // —— 删除自定义源 ——
  const remove = async () => {
    if (!selectedId || isBuiltin) return;
    const ok = await confirmAsync({ title: '删除生成源', message: `确定要删除生成源 ${selectedId} 吗？`, isDanger: true, confirmText: '确认删除', cancelText: '取消' });
    if (!ok) return;
    try {
      const r: any = await apiService.deleteProvider(selectedId);
      if (r?.status === 'deleted') {
        toast.success(`生成源 ${selectedId} 已删除`);
        select('');
        void fetchProviders();
        invalidateProviderSources();
        window.dispatchEvent(new Event('provider-list-refresh'));
      } else {
        toast.error(JSON.stringify(r));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const openCreate = (tab: 'doc' | 'code' | 'comfy') => {
    window.dispatchEvent(new CustomEvent('open-provider-create', {
      detail: { tab, kind, select: true, source: `provider-node:${props.id}` },
    }));
  };

  const ports = useMemo(() => providerNodePorts(props.type, d), [props.type, d]);
  const name = def?.display_name || def?.name || selectedId;
  const dot = !def
    ? null
    : def.enabled === false
      ? { tone: 'idle' as const, title: '已停用' }
      : health
        ? { tone: health.ok ? ('ok' as const) : ('error' as const), title: health.detail || (health.ok ? '连通正常' : '检测未通过') }
        : { tone: isBuiltin ? ('primary' as const) : ('idle' as const), title: isBuiltin ? '内置' : '自定义（未检测）' };
  // 通用 provider 没写 kind 时标题叫「生成源」（同注册表默认标题）
  const label = (typeof d.label === 'string' && d.label) || (props.type === 'provider' && !d.kind ? '生成源' : meta.label);

  return (
    <NodeSkeleton
      node={props}
      label={label}
      icon={props.type === 'provider' && !d.kind ? IconPlug : meta.icon}
      ports={ports}
      width={320}
      toolbar={(
        <>
          <ToolbarButton icon={IconActivityHeartbeat} title="测试连通" loading={testing} disabled={!selectedId} onClick={() => void test()}>测试连通</ToolbarButton>
          <ToolbarButton icon={IconRefresh} title="刷新生成源列表" loading={listLoading} onClick={() => void fetchProviders()}>刷新</ToolbarButton>
        </>
      )}
      onFullscreen={null}
    >
      <div className="cv-lb">
        <div className="cv-lb-row">
          {dot && <LbDot tone={dot.tone} title={dot.title} />}
          <span className={name ? 'cv-lb-ellipsis cv-lb-strong' : 'cv-lb-ellipsis cv-lb-hint'} title={name || undefined}>{name || '未绑定生成源'}</span>
          <span className="cv-lb-push"><LbTag tone={def ? (isBuiltin ? 'primary' : 'default') : 'default'}>{isBuiltin ? '内置' : def ? '自定义' : '未绑定'}</LbTag></span>
        </div>

        <LbField
          label="选择生成源"
          extra={<LbButton variant="text" icon={IconRefresh} loading={listLoading} onClick={() => void fetchProviders()}>刷新</LbButton>}
          hint={!providers.length && !listLoading ? '暂无可用源，内置源加载中或请创建' : undefined}
        >
          <LbSelect aria-label="选择生成源" value={selectedId} onChange={(e) => select(e.target.value)}>
            <option value="">— 请选择 —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name || p.name || p.id} {p.builtin ? '· 内置' : '· 自定义'} {p.kind ? `· ${p.kind}` : ''}
              </option>
            ))}
            {selectedId && !providers.some((p) => p.id === selectedId) && <option value={selectedId}>{name}</option>}
          </LbSelect>
        </LbField>

        {def && (
          <section className="cv-lb-section" aria-label="生成源详情">
            <div className="cv-lb-row cv-lb-row--between">
              <span className="cv-lb-strong cv-lb-ellipsis" title={name}>{name}</span>
              <LbTag mono title={def.id}>{def.id}</LbTag>
            </div>
            {def.description && <div className="cv-lb-desc" title={def.description}>{def.description}</div>}
            <div className="cv-lb-row cv-lb-hint">
              <span>类型</span><LbTag>{def.kind || kind}</LbTag>
              <span className="cv-lb-push">来源</span><LbTag>{def.provider_type || (isBuiltin ? 'builtin' : 'http')}</LbTag>
            </div>
            {def.transport?.url && <div className="cv-lb-hint cv-lb-mono cv-lb-ellipsis" title={def.transport.url}>URL: {def.transport.url}</div>}

            <LbField label="模型">
              {models.length && !manualModel ? (
                <LbSelect
                  aria-label="模型"
                  value={model}
                  onChange={(e) => {
                    if (e.target.value === MANUAL_MODEL) { setManualModel(true); return; }
                    setModel(e.target.value);
                  }}
                >
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  {model && !models.includes(model) && <option value={model}>{model} (自定义)</option>}
                  <option value={MANUAL_MODEL}>— 手动输入 —</option>
                </LbSelect>
              ) : (
                <div className="cv-lb-row">
                  <LbInput
                    className="cv-lb-mono"
                    aria-label="模型名"
                    value={model}
                    placeholder={def.default_model || '输入模型名，如 FLUX.1-schnell'}
                    onChange={(e) => setModel(e.target.value)}
                  />
                  {models.length > 0 && <LbButton variant="text" onClick={() => setManualModel(false)}>选择</LbButton>}
                </div>
              )}
            </LbField>

            <ParamsSection
              specs={paramSpecs}
              values={paramValues}
              onChange={setParam}
              icon={IconAdjustmentsHorizontal}
              collapsible
              footer={(
                <>
                  <LbButton variant="primary" block icon={IconDeviceFloppy} loading={savingParams} disabled={isBuiltin} onClick={() => void saveParams()}>
                    {savingParams ? '保存中...' : '保存参数到 Provider'}
                  </LbButton>
                  {isBuiltin && <div className="cv-lb-hint">内置源参数仅本地生效（连线时透传），如需持久化请复制为自定义源</div>}
                </>
              )}
            />

            {!isBuiltin && (
              <LbField label={<><IconKey size={14} aria-hidden />API Key</>}>
                <div className="cv-lb-row">
                  <LbInput
                    className="cv-lb-mono"
                    type={showKey ? 'text' : 'password'}
                    aria-label="API Key"
                    autoComplete="off"
                    value={apiKeyInput}
                    placeholder={def.auth?.has_key ? '已配置（输入新 Key 覆盖）' : '输入 API Key'}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                  />
                  <LbButton icon={showKey ? IconEyeOff : IconEye} title={showKey ? '隐藏' : '显示'} aria-label={showKey ? '隐藏 Key' : '显示 Key'} onClick={() => setShowKey((v) => !v)} />
                </div>
                <LbButton block icon={IconKey} loading={savingKey} onClick={() => void saveKey()}>保存 Key</LbButton>
              </LbField>
            )}

            <div className="cv-lb-row">
              <LbButton className="cv-lb-grow" icon={IconActivityHeartbeat} loading={testing} disabled={!selectedId} onClick={() => void test()}>
                {testing ? '检测中…' : '测试连通'}
              </LbButton>
              {!isBuiltin && <LbButton variant="danger" icon={IconTrash} onClick={() => void remove()}>删</LbButton>}
            </div>
            {health && <LbAlert tone={health.ok ? 'primary' : 'danger'}>{health.detail || (health.ok ? '正常' : '异常')}</LbAlert>}
          </section>
        )}

        {kind !== 'llm' && (
          <section className="cv-lb-section cv-lb-section--dashed" aria-label="扩展新生成源">
            <span className="cv-lb-label cv-lb-accent"><IconPlus size={14} aria-hidden />扩展新生成源</span>
            <div className="cv-lb-hint">粘贴 API 文档让导演自动写代码接入，或手写代码 / 导入 ComfyUI 工作流。创建成功自动选用。</div>
            <div className="cv-lb-row">
              <LbButton variant="primary" className="cv-lb-grow" onClick={() => openCreate('doc')}>贴文档创建</LbButton>
              <LbButton onClick={() => openCreate('code')}>写代码</LbButton>
              <LbButton onClick={() => openCreate('comfy')}>工作流</LbButton>
            </div>
          </section>
        )}

        <div className="cv-lb-hint cv-lb-center">
          把右侧「生成源」输出口连到 分镜卡 / 图片生成 / 视频生成 / 音频生成，下游将使用此源生成
        </div>
      </div>
    </NodeSkeleton>
  );
}
