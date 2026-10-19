/**
 * 文本模型（模型广场）——唯一真源：供应商 → 模型 → 默认模型。
 *
 * 对标 Cherry Studio 的思路，把原来「广场供应商」和「拆剧本直连通道」两套并存的概念收成一套：
 *   1. 默认模型（拆剧本 / 润色 / 一键成片 / AI 对话都用它）
 *   2. 供应商列表：每家 = 地址 + Key + 自定义请求头；展开挑模型，点星号设为默认
 *   3. 添加供应商：预设画廊一键带出常用厂商（DeepSeek / OpenAI / 硅基流动 / …）；支持编辑
 * 旧的直连通道（OPENAI_* / RESPONSES_*）作为兼容项收进 CapabilitiesPanel 的「高级」折叠里，
 * 只有没设默认模型时才回退使用。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Cpu, Loader2, Pencil, Plus, RefreshCw, Star, Store, Trash2 } from 'lucide-react';
import { confirmAsync, toast } from '../../stores/useDialogStore';
import { CustomHeadersEditor } from '../provider/CustomHeadersEditor';
import { useLlmPlazaStore, type PlazaSupplier } from './plazaStore';

/** 常用厂商预设：一键带出地址与协议，只用再填 Key */
const PROVIDER_PRESETS: Array<{
  key: string;
  name: string;
  protocol: 'openai' | 'claude';
  base_url: string;
  note: string;
  headers?: Record<string, string>;
}> = [
  { key: 'deepseek', name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', note: '官方直连 · 便宜稳定' },
  { key: 'openai', name: 'OpenAI', protocol: 'openai', base_url: 'https://api.openai.com/v1', note: '官方' },
  { key: 'siliconflow', name: '硅基流动', protocol: 'openai', base_url: 'https://api.siliconflow.cn/v1', note: '国内直连 · 多模型' },
  { key: 'minimax', name: 'MiniMax', protocol: 'openai', base_url: 'https://api.minimaxi.com/v1', note: '与配音共用一把 Key' },
  { key: 'kimi', name: 'Kimi (Moonshot)', protocol: 'openai', base_url: 'https://api.moonshot.cn/v1', note: '长文本见长' },
  { key: 'dashscope', name: '通义千问', protocol: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', note: '阿里百炼兼容模式' },
  { key: 'openrouter', name: 'OpenRouter', protocol: 'openai', base_url: 'https://openrouter.ai/api/v1', note: '聚合网关' },
  { key: 'opencode', name: 'OpenCode Zen', protocol: 'openai', base_url: 'https://opencode.ai/zen/go/v1', note: '需会话头（已预置）' },
  { key: 'custom', name: '自定义', protocol: 'openai', base_url: '', note: '任意 OpenAI 兼容 / Anthropic 网关' },
];

const modelKey = (supplierId: string, model: string) => `${supplierId}::${model}`;

type PlazaProtocolUi = 'openai' | 'claude' | 'responses';

const PROTOCOL_META: Record<PlazaProtocolUi, { label: string; cls: string; hint: string; placeholder: string }> = {
  openai: {
    label: 'OpenAI',
    cls: 'bg-sky-500/15 text-sky-300',
    hint: 'OpenAI 兼容用 Bearer 拉 /v1/models，对话走 /chat/completions。',
    placeholder: 'https://api.example.com/v1',
  },
  responses: {
    label: 'Responses',
    cls: 'bg-violet-500/15 text-violet-300',
    hint: 'OpenAI Responses API：对话走 /v1/responses，工具调用等不支持时自动降级同站点 /chat/completions。',
    placeholder: 'https://api.openai.com/v1',
  },
  claude: {
    label: 'Claude',
    cls: 'bg-amber-500/15 text-amber-300',
    hint: 'Claude 用 x-api-key 拉 /v1/models，对话走 /v1/messages。',
    placeholder: 'https://api.anthropic.com',
  },
};

const protocolUi = (p?: string): PlazaProtocolUi =>
  p === 'claude' ? 'claude' : p === 'responses' ? 'responses' : 'openai';

export const ModelPlaza: React.FC = () => {
  const suppliers = useLlmPlazaStore((s) => s.suppliers);
  const defaultPick = useLlmPlazaStore((s) => s.default);
  const active = useLlmPlazaStore((s) => s.active);
  const loading = useLlmPlazaStore((s) => s.loading);
  const error = useLlmPlazaStore((s) => s.error);
  const load = useLlmPlazaStore((s) => s.load);
  const add = useLlmPlazaStore((s) => s.add);
  const update = useLlmPlazaStore((s) => s.update);
  const remove = useLlmPlazaStore((s) => s.remove);
  const refresh = useLlmPlazaStore((s) => s.refresh);
  const setActive = useLlmPlazaStore((s) => s.setActive);
  const setDefault = useLlmPlazaStore((s) => s.setDefault);

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<PlazaProtocolUi>('openai');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [advOpen, setAdvOpen] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => { load(); }, [load]);

  const headerCount = Object.keys(headers).length;
  const defaultSupplier = useMemo(
    () => suppliers.find((s) => s.id === defaultPick.supplier_id),
    [suppliers, defaultPick.supplier_id],
  );
  const defaultReady = !!(defaultPick.supplier_id && defaultPick.model);

  const resetForm = () => {
    setEditId(null);
    setName('');
    setBaseUrl('');
    setApiKey('');
    setProtocol('openai');
    setHeaders({});
    setAdvOpen(false);
  };

  const toggleForm = () => {
    if (open) { setOpen(false); resetForm(); }
    else { resetForm(); setOpen(true); }
  };

  const applyPreset = (p: typeof PROVIDER_PRESETS[number]) => {
    setEditId(null);
    setName(p.key === 'custom' ? '' : p.name);
    setProtocol(p.protocol);
    setBaseUrl(p.base_url);
    setApiKey('');
    setHeaders(p.headers || {});
    setAdvOpen(!!p.headers);
    setOpen(true);
  };

  const openEdit = (s: PlazaSupplier) => {
    setEditId(s.id);
    setName(s.name);
    setProtocol(protocolUi(s.protocol));
    setBaseUrl(s.base_url);
    setApiKey('');
    setHeaders(s.headers || {});
    setAdvOpen(Object.keys(s.headers || {}).length > 0);
    setOpen(true);
  };

  const submit = async () => {
    setBusy('add');
    try {
      const sup = editId
        ? await update(editId, {
            name: name.trim(),
            base_url: baseUrl.trim(),
            protocol,
            api_key: apiKey.trim() || undefined,
            headers,
          })
        : await add({ name: name.trim(), base_url: baseUrl.trim(), api_key: apiKey.trim(), protocol, headers });
      const label = sup?.name || name.trim();
      if (sup?.error) {
        toast.warning(`${editId ? '已保存修改' : '已添加'}「${label}」，但拉取模型失败：${sup.error}`);
      } else {
        toast.success(`${editId ? '已保存' : '已添加'}「${label}」，拉到 ${sup?.models?.length || 0} 个模型`);
      }
      if (sup?.id) setExpanded((e) => ({ ...e, [sup.id]: true }));
      setOpen(false);
      resetForm();
    } catch (e: any) {
      toast.error(e?.message || (editId ? '保存失败' : '添加失败'));
    } finally {
      setBusy('');
    }
  };

  const onRefresh = async (s: PlazaSupplier) => {
    setBusy(s.id);
    try {
      const latest = await refresh(s.id);
      if (latest?.error) toast.error(latest.error);
      else toast.success(`已拉取 ${latest?.models?.length || 0} 个模型`);
    } catch (e: any) {
      toast.error(e?.message || '拉取失败');
    } finally {
      setBusy('');
    }
  };

  const onDelete = async (s: PlazaSupplier) => {
    const isDefault = defaultPick.supplier_id === s.id;
    const ok = await confirmAsync({
      title: '删除供应商',
      message: `确定删除「${s.name}」吗？广场上它的模型会一起消失${isDefault ? '；它现在是默认模型，删掉后拆剧本会回退到旧版直连通道' : ''}。`,
      isDanger: true,
      confirmText: '确认删除',
      cancelText: '取消',
    });
    if (!ok) return;
    setBusy(s.id);
    try {
      await remove(s.id);
      if (editId === s.id) { setOpen(false); resetForm(); }
      toast.success(`已删除「${s.name}」`);
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    } finally {
      setBusy('');
    }
  };

  const pickDefault = async (supplierId: string, model: string) => {
    setBusy(`def:${modelKey(supplierId, model)}`);
    try {
      await setDefault(supplierId, model);
      toast.success(`默认模型已设为「${model}」（拆剧本 / 润色 / 对话都用它）`);
    } catch (e: any) {
      toast.error(e?.message || '设置默认模型失败');
    } finally {
      setBusy('');
    }
  };

  const pickChat = async (supplierId: string, model: string) => {
    setBusy(`pick:${modelKey(supplierId, model)}`);
    try {
      await setActive(supplierId, model);
      toast.success(`本次对话已切换到「${model}」`);
    } catch (e: any) {
      toast.error(e?.message || '切换失败');
    } finally {
      setBusy('');
    }
  };

  /** 测试默认模型：重拉该供应商，确认模型还在 */
  const testDefault = async () => {
    if (!defaultSupplier) return;
    setBusy('test-default');
    try {
      const latest = await refresh(defaultSupplier.id);
      if (latest?.error) {
        toast.error(`默认模型连通失败：${latest.error}`);
      } else if ((latest?.models || []).some((m) => m.id === defaultPick.model)) {
        toast.success(`默认模型连通正常（${defaultPick.model}）`);
      } else {
        toast.warning(`供应商可连接，但模型列表里没有「${defaultPick.model}」了，请重新选择`);
      }
    } catch (e: any) {
      toast.error(e?.message || '测试失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-white/70 dark:border-white/12 bg-surface/60 overflow-hidden">
      {/* ── 默认模型 ── */}
      <div className="px-4 py-3 border-b border-white/60 dark:border-white/12">
        <div className="flex items-center gap-2 flex-wrap">
          <Cpu className="w-4 h-4 text-brand-light" />
          <div className="min-w-0">
            <div className="text-[12.5px] font-bold text-[color:var(--color-text-main)]">默认模型</div>
            <div className="text-[10.5px] text-gray-500">拆剧本、润色、一键成片、AI 对话都用它；对话里可临时换别的模型。</div>
          </div>
          <span className="ml-auto flex items-center gap-1.5">
            {defaultReady ? (
              <>
                <span className="px-2.5 py-1 rounded-xl bg-brand/15 border border-brand/40 text-[11.5px] font-bold text-[color:var(--color-text-main)] flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  {defaultSupplier?.name || '供应商'} · <span className="font-mono">{defaultPick.model}</span>
                </span>
                <button
                  type="button"
                  onClick={testDefault}
                  disabled={busy === 'test-default'}
                  className="px-2.5 py-1 rounded-xl border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white hover:border-brand/50 disabled:opacity-40 flex items-center gap-1"
                >
                  {busy === 'test-default' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  测试
                </button>
              </>
            ) : (
              <span className="px-2.5 py-1 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200">
                未设置 —— 先在下面添加供应商，再点模型旁的星标
              </span>
            )}
          </span>
        </div>
      </div>

      {/* ── 供应商 ── */}
      <div className="px-4 py-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2">
        <Store className="w-4 h-4 text-brand-light" />
        <div className="min-w-0">
          <div className="text-[12.5px] font-bold text-[color:var(--color-text-main)]">供应商</div>
          <div className="text-[10.5px] text-gray-500">每家 = 一个地址 + 一把 Key（+ 可选请求头）。同名模型按供应商分开，互不影响。</div>
        </div>
        <button
          type="button"
          onClick={toggleForm}
          className="ml-auto px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />{open ? '收起' : '添加供应商'}
        </button>
      </div>

      {open && (
        <div className="px-4 py-3 border-b border-white/60 dark:border-white/12 space-y-2.5">
          {/* 预设画廊：没在编辑时展示，一点即带出地址 */}
          {!editId && (
            <div>
              <div className="text-[10.5px] text-gray-500 mb-1.5">常用厂商（点一下自动填好地址，只需补 Key）：</div>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    title={p.note}
                    onClick={() => applyPreset(p)}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] transition-all ${
                      baseUrl === p.base_url && p.base_url
                        ? 'bg-brand/20 border-brand/50 text-[color:var(--color-text-main)]'
                        : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-300 hover:border-brand/40'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {editId && (
            <div className="text-[10.5px] text-brand-light flex items-center gap-1.5">
              <Pencil className="w-3 h-3" />正在编辑「{name || '未命名'}」：API Key 留空不改动已保存的 Key。
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名称（如 DeepSeek），用来区分同名模型"
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)]"
            />
            <select
              value={protocol}
              onChange={(e) => setProtocol(protocolUi(e.target.value))}
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)]"
            >
              <option value="openai">OpenAI 兼容（/chat/completions）</option>
              <option value="responses">OpenAI Responses API（/v1/responses）</option>
              <option value="claude">Claude / Anthropic</option>
            </select>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={editId ? 'API Key（留空不改动）' : 'API Key'}
              type="password"
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)]"
            />
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={PROTOCOL_META[protocol].placeholder}
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)] sm:col-span-3"
            />
          </div>

          {/* 高级：自定义请求头 */}
          <div>
            <button
              type="button"
              onClick={() => setAdvOpen((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-[color:var(--color-text-main)]"
            >
              {advOpen ? '▾' : '▸'} 高级 · 自定义请求头{headerCount ? `（${headerCount} 项）` : '（可选）'}
            </button>
            {advOpen && (
              <div className="mt-2">
                <CustomHeadersEditor headers={headers} onChange={setHeaders} />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy === 'add' || !name.trim() || !baseUrl.trim()}
              onClick={submit}
              className="px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {editId ? '保存修改并重拉模型' : '添加并拉取模型'}
            </button>
            {editId && (
              <button
                type="button"
                onClick={() => { setOpen(false); resetForm(); }}
                className="px-3 py-1.5 rounded-xl border border-white/70 dark:border-white/12 text-gray-300 text-[11.5px] hover:text-white"
              >
                取消编辑
              </button>
            )}
            <span className="text-[10.5px] text-gray-500">{PROTOCOL_META[protocol].hint}</span>
          </div>
        </div>
      )}

      {/* ── 供应商列表 ── */}
      <div className="p-4 space-y-2">
        {loading && suppliers.length === 0 && (
          <div className="text-[11.5px] text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />读取中…</div>
        )}
        {error && <div className="text-[11.5px] text-red-300">{error}</div>}
        {!loading && suppliers.length === 0 && !error && (
          <div className="text-[11.5px] text-gray-500">还没有供应商。点右上角「添加供应商」开始（已配置过的旧通道会在这里自动出现）。</div>
        )}
        {suppliers.map((s) => {
          const isOpen = !!expanded[s.id];
          const isDefaultSupplier = defaultPick.supplier_id === s.id;
          const hCount = Object.keys(s.headers || {}).length;
          return (
            <div key={s.id} className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80">
              <div className="px-3 py-2 flex items-center gap-2 flex-wrap text-[11px]">
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [s.id]: !isOpen }))}
                  className="flex items-center gap-1.5 min-w-0 text-left"
                  title={isOpen ? '收起模型列表' : '展开模型列表'}
                >
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                  <span className="font-bold text-[color:var(--color-text-main)]">{s.name}</span>
                </button>
                <span className={`px-1 rounded ${PROTOCOL_META[protocolUi(s.protocol)].cls}`}>
                  {PROTOCOL_META[protocolUi(s.protocol)].label}
                </span>
                <span className="font-mono text-gray-500 truncate max-w-[240px]" title={s.base_url}>{s.base_url}</span>
                {s.api_key_hint && <span className="text-gray-500">{s.api_key_hint}</span>}
                {hCount > 0 && <span className="text-gray-500" title={Object.keys(s.headers || {}).join(', ')}>请求头 {hCount}</span>}
                {!s.has_key && <span className="text-amber-300">未填 Key</span>}
                {s.models.length > 0 && <span className="text-gray-500">{s.models.length} 模型</span>}
                {isDefaultSupplier && defaultPick.model && (
                  <span className="px-1.5 rounded bg-brand/20 text-brand-light font-bold">含默认模型</span>
                )}
                {s.error && <span className="text-red-300 truncate max-w-[220px]" title={s.error}>{s.error}</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => openEdit(s)}
                    className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 text-gray-200 hover:border-brand disabled:opacity-40 flex items-center gap-1"
                  >
                    <Pencil className="w-3 h-3" />编辑
                  </button>
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => onRefresh(s)}
                    className="px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 text-gray-200 hover:border-brand disabled:opacity-40 flex items-center gap-1"
                  >
                    {busy === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    拉取
                  </button>
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => onDelete(s)}
                    className="px-2 py-1 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 hover:text-white disabled:opacity-40 flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />删除
                  </button>
                </span>
              </div>

              {isOpen && (
                <div className="px-3 pb-3">
                  {s.models.length === 0 && (
                    <div className="text-[10.5px] text-gray-500">
                      {s.error ? '模型没拉下来：先点「编辑」修 Key / 地址 / 请求头，再点「拉取」。' : '还没拉过模型，点上面的「拉取」。'}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {s.models.map((m) => {
                      const isDefault = isDefaultSupplier && defaultPick.model === m.id;
                      const isChat = active.supplier_id === s.id && active.model === m.id;
                      const key = modelKey(s.id, m.id);
                      return (
                        <span
                          key={m.id}
                          className={`inline-flex items-center rounded-lg border text-[11px] overflow-hidden ${
                            isDefault ? 'bg-brand/15 border-brand/50' : 'bg-surface/80 border-white/70 dark:border-white/12'
                          }`}
                          title={m.display && m.display !== m.id ? `${m.display}（${m.id}）` : m.id}
                        >
                          <button
                            type="button"
                            disabled={busy === `def:${key}`}
                            onClick={() => pickDefault(s.id, m.id)}
                            className={`px-2 py-1 flex items-center gap-1 ${isDefault ? 'text-brand-light' : 'text-gray-300 hover:text-white'}`}
                            title="设为默认模型（拆剧本 / 润色 / 对话都用它）"
                          >
                            {busy === `def:${key}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Star className={`w-3 h-3 ${isDefault ? 'fill-current' : ''}`} />}
                            <span className="font-mono">{m.display && m.display !== m.id ? m.display : m.id}</span>
                          </button>
                          <button
                            type="button"
                            disabled={busy === `pick:${key}`}
                            onClick={() => pickChat(s.id, m.id)}
                            className={`px-2 py-1 border-l border-white/20 text-[10px] ${isChat ? 'text-brand-light' : 'text-gray-500 hover:text-white'}`}
                            title="只把本次对话切到这个模型（不动默认模型）"
                          >
                            {isChat ? '对话中' : '对话用'}
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
