import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Package, Power, RefreshCw, Trash2, Search, Upload, Loader2,
  Plug, Workflow, Puzzle, Info, Boxes,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { toast, confirmAsync } from '../../stores/useDialogStore';

/** 11 类扩展的中文名与一句话解释（与后端 ExtensionKind 对齐） */
const KIND_META: Record<string, { label: string; desc: string }> = {
  provider:        { label: '生成源',    desc: '一次生成调用的执行方：内置厂商 / 你写的代码 / 一个 ComfyUI 工作流' },
  skill:           { label: '技能',      desc: '带 YAML 头的 SKILL.md，提示词润色与固定工具链' },
  custom_node:     { label: '代码节点',  desc: '一段 Python / JavaScript，可在画布上作为节点运行' },
  mcp_tool:        { label: 'MCP 工具',  desc: 'AI 导演能调用的工具，也对外开放给别的 AI' },
  workflow:        { label: '工作流',    desc: '导入的 ComfyUI 工作流与它的槽位映射' },
  canvas_node:     { label: '画布节点',  desc: '声明式节点：端口 + 参数 + 指向某个可执行扩展' },
  storyboard_slot: { label: '分镜槽',    desc: '往分镜工作台插页签 / 锚点 / 按钮 / 制作模式' },
  theme:           { label: '主题',      desc: '一包 CSS 变量，换整套配色' },
  exporter:        { label: '导出器',    desc: '声明式导出目标，如 SRT / 第三方草稿' },
  director_pack:   { label: '导演包',    desc: '3D 片场的机位预设 / 环境底图 / GLB 道具' },
  plugin:          { label: '插件包',    desc: '容器：一个 zip 一次带进上面 10 类' },
};

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  builtin:    { label: '内置',   cls: 'text-gray-400 border-border bg-surface-tertiary' },
  standalone: { label: '自建',   cls: 'text-sky-300 border-sky-500/40 bg-sky-500/10' },
  plugin:     { label: '来自插件', cls: 'text-violet-300 border-violet-500/40 bg-violet-500/10' },
};

export const ExtensionsPanel: React.FC = () => {
  const [exts, setExts] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [plugins, setPlugins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [e, p] = await Promise.all([
        apiService.listExtensions({}).catch(() => ({ extensions: [], counts: {} })),
        apiService.listPlugins().catch(() => ({ plugins: [], total: 0 })),
      ]);
      setExts(e?.extensions || []);
      setCounts(e?.counts || {});
      setPlugins(p?.plugins || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const h = () => load();
    window.addEventListener('provider-list-refresh', h);
    window.addEventListener('plugin-list-refresh', h);
    return () => {
      window.removeEventListener('provider-list-refresh', h);
      window.removeEventListener('plugin-list-refresh', h);
    };
  }, []);

  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return exts.filter((e) => {
      if (kind && e.kind !== kind) return false;
      if (!ql) return true;
      return [e.id, e.name, e.local_id, e.description].some((s) => (s || '').toLowerCase().includes(ql));
    });
  }, [exts, kind, q]);

  const kindsPresent = useMemo(() => {
    const set = new Set(exts.map((e) => e.kind));
    return Object.keys(KIND_META).filter((k) => set.has(k));
  }, [exts]);

  // ── 插件操作 ──
  const installPlugin = async (f: File) => {
    setBusy('install');
    try {
      const r = await apiService.installPlugin(f);
      toast.success(`已安装 ${r?.plugin?.name || f.name}`);
      await load();
      ['theme-list-refresh', 'canvasnode-list-refresh', 'exporter-list-refresh', 'directorpacks-list-refresh']
        .forEach((ev) => { try { window.dispatchEvent(new CustomEvent(ev)); } catch { /* ignore */ } });
    } catch (e: any) {
      toast.error(e?.message || '安装失败');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const togglePlugin = async (p: any) => {
    setBusy(p.id);
    try {
      await apiService.setPluginEnabled(p.id, !p.enabled);
      toast.success(p.enabled ? `已禁用 ${p.name}` : `已启用 ${p.name}`);
      await load();
    } catch (e: any) { toast.error(e?.message || '操作失败'); } finally { setBusy(null); }
  };

  const removePlugin = async (p: any) => {
    const ok = await confirmAsync({
      title: '卸载插件', isDanger: true, confirmText: '确认卸载', cancelText: '取消',
      message: `确定卸载「${p.name}」吗？它注册的生成源 / 技能 / 工作流 / 主题等会一并回滚（只删这个包带进来的，不碰同名的自建件）。`,
    });
    if (!ok) return;
    setBusy(p.id);
    try { await apiService.uninstallPlugin(p.id); toast.success(`已卸载 ${p.name}`); await load(); }
    catch (e: any) { toast.error(e?.message || '卸载失败'); } finally { setBusy(null); }
  };

  // ── 扩展操作 ──
  const toggleExt = async (e: any) => {
    setBusy(e.id);
    try {
      await apiService.setExtensionEnabled(e.id, e.status !== 'enabled');
      await load();
    } catch (err: any) { toast.error(err?.message || '操作失败'); } finally { setBusy(null); }
  };

  const removeExt = async (e: any) => {
    const ok = await confirmAsync({
      title: '卸载扩展', isDanger: true, confirmText: '确认卸载', cancelText: '取消',
      message: `确定卸载 ${e.id} 吗？会回滚它注册的落盘内容。`,
    });
    if (!ok) return;
    setBusy(e.id);
    try { await apiService.uninstallExtension(e.id); toast.success(`已卸载 ${e.id}`); await load(); }
    catch (err: any) { toast.error(err?.message || '卸载失败'); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-5">
      {/* ── 概念说明：这一页为什么把两件事放一起 ── */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-start gap-2.5">
          <Info className="w-4 h-4 text-brand-light shrink-0 mt-0.5" />
          <div className="text-[12px] text-gray-400 leading-relaxed">
            <b className="text-[color:var(--color-text-main)]">插件是包，扩展是颗粒。</b>
            装一个插件 = 一次性往下面的扩展表里塞进去一批；卸载它 = 把这批精确撤回。
            所以「安装」和「管理」本来就是一件事的两头，这一页合在一起。
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden border border-border">
          <Stat label="扩展总数" value={counts.total ?? exts.length} />
          <Stat label="生成源" value={counts.provider ?? 0} />
          <Stat label="技能" value={counts.skill ?? 0} />
          <Stat label="已装插件" value={plugins.length} />
        </div>
      </div>

      {/* ── 安装插件 ── */}
      <section className="rounded-2xl border border-border bg-surface overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-border/70 flex items-center gap-2">
          <Package className="w-4 h-4 text-violet-400" />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">插件包</h3>
          <span className="text-[11px] text-gray-500">一个 zip 能同时带进 10 类扩展</span>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy === 'install'}
            className="ml-auto px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy === 'install' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            安装 zip 包
          </button>
          <input
            ref={fileRef} type="file" accept=".zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) installPlugin(f); }}
          />
        </div>

        <div className="p-5 pt-3.5">
          {plugins.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
              <div className="text-[12px] text-gray-400">还没有装任何插件</div>
              <div className="text-[11px] text-gray-500 mt-1">
                仓库里有个示例包 <code className="font-mono text-[10.5px]">plugins/example-drama-pack</code>，
                打成 zip 传上来就能看到整条链路
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {plugins.map((p) => (
                <div key={p.id} className="rounded-xl border border-border bg-surface-secondary px-4 py-3 flex items-center gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-bold text-[color:var(--color-text-main)] truncate">{p.name}</span>
                      <span className="text-[10px] font-mono text-gray-500">v{p.version}</span>
                      {p.enabled
                        ? <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">已启用</span>
                        : <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-surface-tertiary border border-border text-gray-400">已停用</span>}
                    </div>
                    {p.description && <div className="text-[11px] text-gray-500 mt-0.5 truncate">{p.description}</div>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => togglePlugin(p)} disabled={busy === p.id}
                      className="px-2.5 py-1 rounded-lg bg-surface border border-border text-[11px] text-gray-200 hover:border-brand disabled:opacity-40 flex items-center gap-1">
                      <Power className="w-3 h-3" />{p.enabled ? '停用' : '启用'}
                    </button>
                    <button onClick={async () => { setBusy(p.id); try { await apiService.reloadPlugin(p.id); toast.success('已热重载'); await load(); } catch (e: any) { toast.error(e?.message || '重载失败'); } finally { setBusy(null); } }}
                      disabled={busy === p.id} title="热重载"
                      className="px-2 py-1 rounded-lg bg-surface border border-border text-gray-300 hover:text-white disabled:opacity-40">
                      <RefreshCw className="w-3 h-3" />
                    </button>
                    <button onClick={() => removePlugin(p)} disabled={busy === p.id} title="卸载"
                      className="px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:text-white disabled:opacity-40">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 自己造 ── */}
      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2 mb-1">
          <Puzzle className="w-4 h-4 text-brand-light" />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">自己造一个</h3>
        </div>
        <p className="text-[11.5px] text-gray-400 leading-relaxed mb-3">
          不装包也能加能力。下面两条是最常用的入口——加出来的东西会以「自建」身份出现在扩展表里。
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-provider-manager'))}
            className="text-left rounded-xl border border-border bg-surface-secondary hover:border-brand/50 transition-colors px-4 py-3"
          >
            <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-[color:var(--color-text-main)]">
              <Plug className="w-3.5 h-3.5 text-brand-light" />新建自定义生成源
            </div>
            <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">
              写一段 Python / JavaScript 协程接任意厂商 API，自己做签名、轮询、重试
            </div>
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-workflow-inspector'))}
            className="text-left rounded-xl border border-border bg-surface-secondary hover:border-brand/50 transition-colors px-4 py-3"
          >
            <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-[color:var(--color-text-main)]">
              <Workflow className="w-3.5 h-3.5 text-emerald-400" />导入 ComfyUI 工作流
            </div>
            <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">
              导入后自动解析出可填槽位，<b>这个工作流本身就变成一个独立生成源</b>
            </div>
          </button>
        </div>
      </section>

      {/* ── 全部扩展 ── */}
      <section className="rounded-2xl border border-border bg-surface overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-border/70">
          <div className="flex items-center gap-2 flex-wrap">
            <Boxes className="w-4 h-4 text-brand-light" />
            <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">全部扩展</h3>
            <span className="text-[11px] text-gray-500">内置 · 自建 · 来自插件，全都在这里逐个启停</span>
            <button onClick={load} className="ml-auto px-2.5 py-1 rounded-lg bg-surface-secondary border border-border text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />刷新
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / id"
                className="w-full bg-surface-secondary border border-border rounded-xl pl-8 pr-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60"
              />
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip active={!kind} onClick={() => setKind('')} label={`全部 ${exts.length}`} />
            {kindsPresent.map((k) => (
              <Chip key={k} active={kind === k} onClick={() => setKind(k)}
                label={`${KIND_META[k].label} ${counts[k] ?? 0}`} title={KIND_META[k].desc} />
            ))}
          </div>
          {kind && (
            <div className="mt-2 text-[11px] text-gray-500 leading-relaxed">{KIND_META[kind].desc}</div>
          )}
        </div>

        <div className="p-5 pt-3.5">
          {loading ? (
            <div className="text-[11.5px] text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />加载中…</div>
          ) : shown.length === 0 ? (
            <div className="text-[11.5px] text-gray-500">没有匹配的扩展</div>
          ) : (
            <div className="space-y-1.5">
              {shown.map((e) => {
                const src = SOURCE_META[e.source] || SOURCE_META.builtin;
                const isBuiltin = e.source === 'builtin' || e.status === 'builtin';
                return (
                  <div key={e.id} className="rounded-xl border border-border bg-surface-secondary px-3.5 py-2.5 flex items-center gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12px] font-bold text-[color:var(--color-text-main)] truncate">{e.name || e.local_id}</span>
                        <span className="text-[9.5px] px-1.5 py-0.5 rounded border border-border bg-surface-tertiary text-gray-400">
                          {KIND_META[e.kind]?.label || e.kind}
                        </span>
                        <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${src.cls}`}>
                          {src.label}{e.source === 'plugin' && e.source_detail ? ` · ${e.source_detail}` : ''}
                        </span>
                        {e.status === 'disabled' && (
                          <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">已停用</span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-gray-600 mt-0.5 truncate">{e.id}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isBuiltin ? (
                        <span className="text-[10.5px] text-gray-600 px-2">内置常驻</span>
                      ) : (
                        <button onClick={() => toggleExt(e)} disabled={busy === e.id}
                          className="px-2.5 py-1 rounded-lg bg-surface border border-border text-[11px] text-gray-200 hover:border-brand disabled:opacity-40 flex items-center gap-1">
                          <Power className="w-3 h-3" />{e.status === 'enabled' ? '停用' : '启用'}
                        </button>
                      )}
                      {e.source !== 'builtin' && (
                        <button onClick={() => removeExt(e)} disabled={busy === e.id} title="卸载"
                          className="px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 hover:text-white disabled:opacity-40">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="bg-surface px-4 py-3">
    <div className="text-xl font-bold font-mono text-brand-light leading-tight">{value}</div>
    <div className="text-[10.5px] text-gray-500">{label}</div>
  </div>
);

const Chip: React.FC<{ active: boolean; onClick: () => void; label: string; title?: string }> = ({ active, onClick, label, title }) => (
  <button onClick={onClick} title={title}
    className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
      active ? 'bg-brand/15 border-brand/50 text-[color:var(--color-text-main)]' : 'bg-surface-secondary border-border text-gray-400 hover:text-[color:var(--color-text-main)]'
    }`}>
    {label}
  </button>
);
