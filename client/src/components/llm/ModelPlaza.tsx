/**
 * 文本模型广场：添加供应商后，按它的 base URL 拉出全部模型，点一张卡片即设为对话当前模型。
 */
import React, { useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Store, Trash2 } from 'lucide-react';
import { confirmAsync, toast } from '../../stores/useDialogStore';
import { useLlmPlazaStore, type PlazaSupplier } from './plazaStore';

export const ModelPlaza: React.FC = () => {
  const suppliers = useLlmPlazaStore((s) => s.suppliers);
  const active = useLlmPlazaStore((s) => s.active);
  const loading = useLlmPlazaStore((s) => s.loading);
  const error = useLlmPlazaStore((s) => s.error);
  const load = useLlmPlazaStore((s) => s.load);
  const add = useLlmPlazaStore((s) => s.add);
  const remove = useLlmPlazaStore((s) => s.remove);
  const refresh = useLlmPlazaStore((s) => s.refresh);
  const setActive = useLlmPlazaStore((s) => s.setActive);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<'openai' | 'claude'>('openai');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setBusy('add');
    try {
      await add({ name: name.trim(), base_url: baseUrl.trim(), api_key: apiKey.trim(), protocol });
      const latest = useLlmPlazaStore.getState().suppliers.find((s) => s.name === name.trim());
      if (latest?.error) toast.error(latest.error);
      else toast.success(`已添加「${name.trim()}」，拉到 ${latest?.models?.length || 0} 个模型`);
      setOpen(false);
      setName('');
      setBaseUrl('');
      setApiKey('');
    } catch (e: any) {
      toast.error(e?.message || '添加失败');
    } finally {
      setBusy('');
    }
  };

  const onRefresh = async (s: PlazaSupplier) => {
    setBusy(s.id);
    try {
      await refresh(s.id);
      const latest = useLlmPlazaStore.getState().suppliers.find((x) => x.id === s.id);
      if (latest?.error) toast.error(latest.error);
      else toast.success(`已拉取 ${latest?.models?.length || 0} 个模型`);
    } catch (e: any) {
      toast.error(e?.message || '拉取失败');
    } finally {
      setBusy('');
    }
  };

  const onDelete = async (s: PlazaSupplier) => {
    const ok = await confirmAsync({
      title: '删除供应商',
      message: `确定删除「${s.name}」吗？广场上它的模型会一起消失，对话里如果正用着它会回到默认通道。`,
      isDanger: true,
      confirmText: '确认删除',
      cancelText: '取消',
    });
    if (!ok) return;
    setBusy(s.id);
    try {
      await remove(s.id);
      toast.success(`已删除「${s.name}」`);
    } catch (e: any) {
      toast.error(e?.message || '删除失败');
    } finally {
      setBusy('');
    }
  };

  const pick = async (supplierId: string, model: string) => {
    setBusy(`pick:${supplierId}:${model}`);
    try {
      await setActive(supplierId, model);
    } catch (e: any) {
      toast.error(e?.message || '切换失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-white/70 dark:border-white/12 bg-surface/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2">
        <Store className="w-4 h-4 text-brand-light" />
        <div className="min-w-0">
          <div className="text-[12.5px] font-bold text-[color:var(--color-text-main)]">模型广场</div>
          <div className="text-[10.5px] text-gray-500">每张卡片是「一家供应商的一个模型」。同名模型会按供应商名称分开。</div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />添加供应商
        </button>
      </div>

      {open && (
        <div className="px-4 py-3 border-b border-white/60 dark:border-white/12 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="供应商名称，用来区分同名模型"
            className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)]"
          />
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value === 'claude' ? 'claude' : 'openai')}
            className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)]"
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="claude">Claude / Anthropic</option>
          </select>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={protocol === 'claude' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'}
            className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)] sm:col-span-3"
          />
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API Key"
            type="password"
            className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)]"
          />
          <div className="sm:col-span-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy === 'add' || !name.trim() || !baseUrl.trim()}
              onClick={submit}
              className="px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              添加并拉取模型
            </button>
            <span className="text-[10.5px] text-gray-500">
              {protocol === 'claude'
                ? 'Claude 用 x-api-key 拉 /v1/models，对话走 /v1/messages。'
                : 'OpenAI 兼容用 Bearer 拉 /v1/models，对话走 /chat/completions。'}
            </span>
          </div>
        </div>
      )}

      <div className="p-4 space-y-3">
        {loading && suppliers.length === 0 && (
          <div className="text-[11.5px] text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />读取中…</div>
        )}
        {error && <div className="text-[11.5px] text-red-300">{error}</div>}
        {!loading && suppliers.length === 0 && !error && (
          <div className="text-[11.5px] text-gray-500">还没有供应商。已配置的文本通道会在第一次打开时自动出现；也可以自己添加。</div>
        )}
        {suppliers.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setFilter('')}
              className={`px-2 py-1 rounded-lg border text-[11px] ${filter ? 'border-white/70 dark:border-white/12 text-gray-400' : 'bg-brand/15 border-brand/50 text-[color:var(--color-text-main)]'}`}
            >
              全部
            </button>
            {suppliers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setFilter(s.id)}
                className={`px-2 py-1 rounded-lg border text-[11px] ${filter === s.id ? 'bg-brand/15 border-brand/50 text-[color:var(--color-text-main)]' : 'border-white/70 dark:border-white/12 text-gray-400'}`}
              >
                {s.name}
                <span className="ml-1 text-[9px] opacity-70">{s.protocol === 'claude' ? 'Claude' : 'OpenAI'}</span>
              </button>
            ))}
          </div>
        )}
        {suppliers.filter((s) => !filter || s.id === filter).map((s) => (
          <div key={s.id} className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="font-bold text-[color:var(--color-text-main)]">{s.name}</span>
            <span className={`px-1 rounded ${s.protocol === 'claude' ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'}`}>
              {s.protocol === 'claude' ? 'Claude' : 'OpenAI'}
            </span>
            <span className="font-mono text-gray-500 truncate max-w-[240px]" title={s.base_url}>{s.base_url}</span>
            {s.api_key_hint && <span className="text-gray-500">{s.api_key_hint}</span>}
            {!s.has_key && <span className="text-amber-300">未填 Key</span>}
            {s.error && <span className="text-red-300 truncate max-w-[220px]" title={s.error}>{s.error}</span>}
            <button
              type="button"
              disabled={busy === s.id}
              onClick={() => onRefresh(s)}
              className="ml-auto px-2 py-1 rounded-lg border border-white/70 dark:border-white/12 text-gray-200 hover:border-brand disabled:opacity-40 flex items-center gap-1"
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
          </div>
        ))}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {suppliers.filter((s) => !filter || s.id === filter).flatMap((s) => s.models.map((m) => {
            const on = active.supplier_id === s.id && active.model === m.id;
            const title = m.display && m.display !== m.id ? m.display : m.id;
            return (
              <button
                key={`${s.id}:${m.id}`}
                type="button"
                title={`${s.name} · ${m.id}`}
                disabled={busy === `pick:${s.id}:${m.id}`}
                onClick={() => pick(s.id, m.id)}
                className={`text-left rounded-xl border px-3 py-2.5 min-h-[72px] ${
                  on
                    ? 'bg-brand/15 border-brand/50'
                    : 'bg-surface/80 border-white/70 dark:border-white/12 hover:border-brand/40'
                }`}
              >
                <div className="text-[12px] font-bold text-[color:var(--color-text-main)] truncate">{title}</div>
                {title !== m.id && <div className="text-[10px] font-mono text-gray-500 truncate">{m.id}</div>}
                <div className="mt-1 text-[10.5px] text-gray-400 truncate">{s.name}</div>
                <div className="text-[9.5px] text-gray-500">{s.protocol === 'claude' ? 'Claude' : 'OpenAI'}{on ? ' · 当前' : ''}</div>
              </button>
            );
          }))}
        </div>
      </div>
    </div>
  );
};
