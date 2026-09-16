import React, { useEffect, useMemo, useState } from 'react';
import {
  Plug, ArrowUpCircle, Edit3, Plug2, Loader2, RefreshCw,
  FileCode2, Copy, Check, Trash2,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { toast, confirmAsync } from '../../stores/useDialogStore';

const KIND_LABEL: Record<string, string> = { image: '生图', video: '视频', audio: '语音', llm: '文本' };

type TestState = Record<string, { running?: boolean; ok?: boolean; detail?: string }>;

/**
 * 自定义生成源的维护动作。
 * 这些能力原先只在旧「生成源中枢」页有：单独改 Key、旧 JSON 源升级到代码模式、
 * 取代码模板；ProviderManagerModal 只能新建/改代码/测试/删除。
 */
export const ProviderToolsSection: React.FC = () => {
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<TestState>({});
  const [tplOpen, setTplOpen] = useState(false);
  const [tplLang, setTplLang] = useState('python');
  const [tplKind, setTplKind] = useState('image');
  const [tpl, setTpl] = useState('');
  const [tplLoading, setTplLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiService.listProviders({ include_builtin: true });
      setProviders(r?.providers || []);
    } catch { /* 静默：下面会显示空态 */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const h = () => load();
    window.addEventListener('provider-list-refresh', h);
    return () => window.removeEventListener('provider-list-refresh', h);
  }, []);

  /** 只管自建的：内置源改不了也删不了 */
  const custom = useMemo(
    () => providers.filter((p) => !p.builtin && p.source !== 'builtin'),
    [providers],
  );

  const upgrade = async (p: any) => {
    const ok = await confirmAsync({
      title: '升级为代码模式',
      message: `把「${p.display_name || p.name || p.id}」的旧 JSON 模板转成 Python 代码沙盒，转完可以自由改逻辑（轮询、签名、重试）。原定义会被替换。`,
      confirmText: '确认升级', cancelText: '取消',
    });
    if (!ok) return;
    setBusy(p.id);
    try {
      await apiService.upgradeProviderToCode(p.id, 'python');
      toast.success('已升级为代码模式');
      await load();
      window.dispatchEvent(new Event('provider-list-refresh'));
    } catch (e: any) { toast.error(e?.message || '升级失败'); } finally { setBusy(null); }
  };

  const test = async (p: any) => {
    setTests((t) => ({ ...t, [p.id]: { running: true } }));
    try {
      const r = await apiService.testProvider(p.id);
      const ok = r?.status === 'success' || r?.ok === true;
      setTests((t) => ({ ...t, [p.id]: { ok, detail: r?.detail || r?.error || (ok ? '连通正常' : '未通过') } }));
      if (ok) window.dispatchEvent(new Event('provider-list-refresh'));
    } catch (e: any) {
      setTests((t) => ({ ...t, [p.id]: { ok: false, detail: e?.message || '测试失败' } }));
    }
  };

  const remove = async (p: any) => {
    const ok = await confirmAsync({
      title: '删除生成源', isDanger: true, confirmText: '确认删除', cancelText: '取消',
      message: `删除「${p.display_name || p.name || p.id}」后，画布和分镜台上引用它的节点会失效。`,
    });
    if (!ok) return;
    setBusy(p.id);
    try {
      await apiService.deleteProvider(p.id);
      toast.success('已删除');
      await load();
      window.dispatchEvent(new Event('provider-list-refresh'));
    } catch (e: any) { toast.error(e?.message || '删除失败'); } finally { setBusy(null); }
  };

  const loadTemplate = async (lang: string, kind: string) => {
    setTplLoading(true);
    try {
      const r = await apiService.getCodeTemplate(lang, kind);
      setTpl(r?.template || '');
    } catch (e: any) {
      setTpl(`// 取模板失败：${e?.message || ''}`);
    } finally { setTplLoading(false); }
  };

  const copyTpl = async () => {
    try {
      await navigator.clipboard.writeText(tpl);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { toast.error('复制失败，请手动选中'); }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-border/70 flex items-center gap-2 flex-wrap">
        <Plug className="w-4 h-4 text-brand-light" />
        <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">自建生成源</h3>
        <span className="text-[11px] text-gray-500">{custom.length} 个</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => { const next = !tplOpen; setTplOpen(next); if (next && !tpl) loadTemplate(tplLang, tplKind); }}
            className="px-2.5 py-1 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white flex items-center gap-1"
          >
            <FileCode2 className="w-3 h-3" />代码模板
          </button>
          <button onClick={load} className="px-2.5 py-1 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
            <RefreshCw className="w-3 h-3" />刷新
          </button>
        </div>
      </div>

      {/* 代码模板 */}
      {tplOpen && (
        <div className="px-5 py-3.5 border-b border-border/70 bg-surface-secondary/40">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <select value={tplLang} onChange={(e) => { setTplLang(e.target.value); loadTemplate(e.target.value, tplKind); }}
              className="bg-surface border border-border rounded-lg px-2 py-1 text-[11.5px] text-[color:var(--color-text-main)]">
              <option value="python">python</option>
              <option value="javascript">javascript</option>
            </select>
            <select value={tplKind} onChange={(e) => { setTplKind(e.target.value); loadTemplate(tplLang, e.target.value); }}
              className="bg-surface border border-border rounded-lg px-2 py-1 text-[11.5px] text-[color:var(--color-text-main)]">
              <option value="image">生图</option>
              <option value="video">视频</option>
              <option value="audio">语音</option>
            </select>
            <button onClick={copyTpl} disabled={!tpl}
              className="ml-auto px-2.5 py-1 rounded-lg bg-brand text-white text-[11px] font-bold disabled:opacity-40 flex items-center gap-1">
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre className="max-h-56 overflow-auto rounded-xl bg-surface border border-border p-3 text-[11px] font-mono text-gray-300 leading-relaxed">
            {tplLoading ? '取模板中…' : (tpl || '（空）')}
          </pre>
          <div className="mt-2 text-[10.5px] text-gray-500 leading-relaxed">
            <code className="font-mono">ctx.api_key</code> 自动注入，不用写死；
            <code className="font-mono">await api.download(url)</code> 把远程结果落盘；
            轮询、签名、重试都在这段代码里自己做。
          </div>
        </div>
      )}

      <div className="p-5 pt-3.5">
        {loading ? (
          <div className="text-[11.5px] text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />加载中…</div>
        ) : custom.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
            <div className="text-[12px] text-gray-400">还没有自建的生成源</div>
            <div className="text-[11px] text-gray-500 mt-1">用上面的「新建自定义生成源」或「导入 ComfyUI 工作流」加一个</div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {custom.map((p) => {
              const isLegacy = p.provider_type && p.provider_type !== 'code' && p.provider_type !== 'comfyui';
              // 接口没有 requires_api_key/has_api_key 字段，用 is_configured 判断"还缺东西"
              const needKey = p.is_configured === false;
              const t = tests[p.id] || {};
              return (
                <div key={p.id} className="rounded-xl border border-border bg-surface-secondary px-3.5 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] font-bold text-[color:var(--color-text-main)] truncate">
                      {p.display_name || p.name || p.id}
                    </span>
                    <span className="text-[9.5px] px-1.5 py-0.5 rounded border border-border bg-surface-tertiary text-gray-400">
                      {KIND_LABEL[p.kind] || p.kind}
                    </span>
                    <span className="text-[9.5px] px-1.5 py-0.5 rounded border border-border bg-surface-tertiary text-gray-400 font-mono">
                      {p.provider_type || 'code'}
                    </span>
                    {needKey && (
                      <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">未配置</span>
                    )}
                    {p.verified && (
                      <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">已测通</span>
                    )}
                    {t.detail && (
                      <span className={`text-[10.5px] ${t.ok ? 'text-emerald-400' : 'text-red-300'}`}>{t.detail}</span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-gray-600 mt-0.5 truncate">{p.id}</div>

                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    {isLegacy && (
                      <Act onClick={() => upgrade(p)} disabled={busy === p.id}
                        icon={ArrowUpCircle} label="升级为代码模式" accent="amber" />
                    )}
                    <Act onClick={() => window.dispatchEvent(new CustomEvent('open-provider-manager', { detail: { providerId: p.id } }))}
                      icon={Edit3} label="编辑" />
                    <Act onClick={() => test(p)} disabled={t.running}
                      icon={t.running ? Loader2 : Plug2} label={t.running ? '测试中' : '测试'} spin={t.running} />
                    <Act onClick={() => remove(p)} disabled={busy === p.id}
                      icon={Trash2} label="删除" accent="red" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};

const Act: React.FC<{
  onClick: () => void; icon: any; label: string;
  disabled?: boolean; accent?: 'amber' | 'red'; spin?: boolean;
}> = ({ onClick, icon: Icon, label, disabled, accent, spin }) => {
  const cls = accent === 'red'
    ? 'bg-red-500/10 border-red-500/30 text-red-300 hover:text-white'
    : accent === 'amber'
      ? 'bg-amber-500/15 border-amber-500/35 text-amber-300 hover:text-white'
      : 'bg-surface border-border text-gray-200 hover:border-brand';
  return (
    <button onClick={onClick} disabled={disabled}
      className={`px-2.5 py-1 rounded-lg border text-[11px] flex items-center gap-1 disabled:opacity-40 transition-colors ${cls}`}>
      <Icon className={`w-3 h-3 ${spin ? 'animate-spin' : ''}`} />{label}
    </button>
  );
};
