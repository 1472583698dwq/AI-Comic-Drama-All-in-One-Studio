import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Package, Power, RefreshCw, Trash2, Search, Upload, Loader2,
  Plug, Workflow, Puzzle, Boxes, Sparkles, Cpu, Palette, Eye, EyeOff,
  Edit3, Plug2, FileCode2, Copy, Check, FileSearch, PackagePlus, Users,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { toast, confirmAsync } from '../../stores/useDialogStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { WorkflowInspectorModal } from '../../components/workflow/WorkflowInspectorModal';
import { ExtensionDetailDrawer } from './ExtensionDetailDrawer';
import { PluginScaffoldModal } from './PluginScaffoldModal';

/** 13 类扩展的中文名与一句话解释（与后端 ExtensionKind 对齐） */
const KIND_META: Record<string, { label: string; desc: string }> = {
  provider:        { label: '生成源',    desc: '一次生成调用的执行方：内置厂商 / 你写的代码 / 一个 ComfyUI 工作流' },
  skill:           { label: '技能',      desc: '带 YAML 头的 SKILL.md，提示词润色与固定工具链' },
  custom_node:     { label: '代码节点',  desc: '一段 Python / JavaScript，可在画布上作为节点运行' },
  mcp_tool:        { label: 'MCP 工具',  desc: 'AI 导演能调用的工具，也对外开放给别的 AI' },
  workflow:        { label: '工作流',    desc: '导入的 ComfyUI 工作流与它的槽位映射' },
  canvas_node:     { label: '画布节点',  desc: '声明式节点：端口 + 参数 + 指向某个可执行扩展' },
  storyboard_slot: { label: '分镜槽',    desc: '往分镜台插页签 / 锚点 / 按钮 / 制作模式' },
  theme:           { label: '主题',      desc: '一包 CSS 变量，换整套配色' },
  exporter:        { label: '导出器',    desc: '声明式导出目标，如 SRT / 第三方草稿' },
  director_pack:   { label: '导演包',    desc: '3D 片场的机位预设 / 环境底图 / GLB 道具' },
  agent_profile:   { label: '导演组成员', desc: '自定义专家子代理角色：系统提示 + 工具白名单，可被总导演委派' },
  agent_team:      { label: '导演组',    desc: '一键成片的成员名单 + 总导演编排脚本（playbook）与质检门' },
  plugin:          { label: '插件包',    desc: '容器：一个 zip 一次带进上面 12 类' },
};

const DOMAIN_ORDER = ['capability', 'canvas', 'workspace', 'agent'] as const;
const DOMAIN_META: Record<string, { label: string; desc: string; icon: any; cls: string }> = {
  capability: { label: '能力', desc: '生成源 / 工作流 / MCP 工具', icon: Sparkles, cls: 'text-brand-light' },
  canvas: { label: '画布', desc: '声明式节点 / 代码节点', icon: Boxes, cls: 'text-teal-400' },
  workspace: { label: '工作台', desc: '分镜槽 / 主题 / 导出器 / 导演包', icon: Workflow, cls: 'text-violet-400' },
  agent: { label: '智能体', desc: '技能 / 角色 / 导演组', icon: Users, cls: 'text-amber-400' },
};
const KIND_DOMAIN: Record<string, string> = {
  provider: 'capability', workflow: 'capability', mcp_tool: 'capability',
  custom_node: 'canvas', canvas_node: 'canvas',
  storyboard_slot: 'workspace', theme: 'workspace', exporter: 'workspace', director_pack: 'workspace',
  skill: 'agent', agent_profile: 'agent', agent_team: 'agent',
};

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  builtin:    { label: '内置',     cls: 'text-gray-400 border-white/70 dark:border-white/12 bg-surface-hover/80' },
  standalone: { label: '自建',     cls: 'text-sky-300 border-sky-500/40 bg-sky-500/10' },
  plugin:     { label: '来自插件', cls: 'text-violet-300 border-violet-500/40 bg-violet-500/10' },
};

/** 哪些 kind 有编辑入口 */
const EDITABLE_KINDS = new Set(['provider', 'workflow', 'skill']);
/** 没有写接口、只能看的 kind */
const PREVIEW_KINDS = new Set(['mcp_tool']);
/** 哪些 kind 能单独跑连通测试 */
const TESTABLE_KINDS = new Set(['provider']);
/** 哪些 kind 有删除接口 */
const DELETABLE_KINDS = new Set([
  'provider', 'workflow', 'skill', 'canvas_node', 'theme', 'exporter', 'director_pack', 'plugin',
]);

export const ExtensionsPanel: React.FC = () => {
  const [exts, setExts] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [plugins, setPlugins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [domain, setDomain] = useState('');
  const [q, setQ] = useState('');
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [showScaffold, setShowScaffold] = useState(false);
  const [tests, setTests] = useState<Record<string, { running?: boolean; ok?: boolean; detail?: string }>>({});
  const [inspectWfId, setInspectWfId] = useState('');
  const [detailExt, setDetailExt] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const activePluginThemeId = useThemeStore((st) => st.activePluginThemeId);
  const applyPluginTheme = useThemeStore((st) => st.applyPluginTheme);

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

  /** 已应用「内置显隐 + 搜索」但不含 kind 过滤：各 kind 的计数以此为基准，互不影响 */
  const base = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return exts.filter((e) => {
      if (!showBuiltin && (e.source === 'builtin' || e.status === 'builtin')) return false;
      if (!ql) return true;
      return [e.id, e.name, e.local_id, e.description].some((s) => (s || '').toLowerCase().includes(ql));
    });
  }, [exts, q, showBuiltin]);

  const shown = useMemo(
    () => base.filter((e) => (!domain || KIND_DOMAIN[e.kind] === domain) && (!kind || e.kind === kind)),
    [base, domain, kind],
  );

  const allDomainCounts = useMemo(() => {
    const m: Record<string, number> = {};
    exts.forEach((e) => {
      const d = KIND_DOMAIN[e.kind];
      if (d) m[d] = (m[d] || 0) + 1;
    });
    return m;
  }, [exts]);

  const domainCounts = useMemo(() => {
    const m: Record<string, number> = {};
    base.forEach((e) => {
      const d = KIND_DOMAIN[e.kind];
      if (d) m[d] = (m[d] || 0) + 1;
    });
    return m;
  }, [base]);

  /** 筛选条上的数字 = 点进去真能看到几条，和「全部 N」同一口径 */
  const viewCounts = useMemo(() => {
    const m: Record<string, number> = {};
    base.filter((e) => !domain || KIND_DOMAIN[e.kind] === domain)
      .forEach((e) => { m[e.kind] = (m[e.kind] || 0) + 1; });
    return m;
  }, [base, domain]);

  const hiddenBuiltin = useMemo(
    () => (showBuiltin ? 0 : exts.filter((e) => e.source === 'builtin' || e.status === 'builtin').length),
    [exts, showBuiltin],
  );

  const kindsPresent = useMemo(() => {
    const set = new Set(exts.map((e) => e.kind));
    return Object.keys(KIND_META).filter((k) => set.has(k) && (!domain || KIND_DOMAIN[k] === domain));
  }, [exts, domain]);

  // ── 插件 ──
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

  // ── 扩展行内动作 ──
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
      message: `确定卸载「${e.name || e.local_id}」吗？会回滚它注册的落盘内容。`,
    });
    if (!ok) return;
    setBusy(e.id);
    try { await apiService.uninstallExtension(e.id); toast.success('已卸载'); await load(); }
    catch (err: any) { toast.error(err?.message || '卸载失败'); } finally { setBusy(null); }
  };

  /** 编辑：先取完整定义再开弹窗，避免弹窗先出空壳再填充 */
  const editExt = async (e: any) => {
    if (e.kind === 'workflow') { setInspectWfId(e.local_id); return; }
    if (e.kind === 'skill' || PREVIEW_KINDS.has(e.kind)) { setDetailExt(e); return; }
    if (e.kind !== 'provider') return;
    setBusy(e.id);
    try {
      const r = await apiService.getProvider(e.local_id);
      const full = { ...(r?.provider || {}), code: (r?.provider?.code ?? r?.raw?.code ?? '') };
      window.dispatchEvent(new CustomEvent('open-provider-manager', { detail: { provider: full } }));
    } catch (err: any) {
      toast.error(err?.message || '读取定义失败');
    } finally { setBusy(null); }
  };

  /** 整卡点击：有编辑入口的进编辑，其余一律进预览，不做成死点 */
  const openPrimary = (e: any) => {
    if (EDITABLE_KINDS.has(e.kind) && !(e.source === 'builtin' || e.status === 'builtin')) {
      editExt(e);
      return;
    }
    setDetailExt(e);
  };

  const testExt = async (e: any) => {
    setTests((t) => ({ ...t, [e.id]: { running: true } }));
    try {
      const r = await apiService.testProvider(e.local_id);
      const ok = r?.status === 'success' || r?.ok === true;
      setTests((t) => ({ ...t, [e.id]: { ok, detail: r?.detail || r?.error || (ok ? '连通正常' : '未通过') } }));
      if (ok) window.dispatchEvent(new Event('provider-list-refresh'));
    } catch (err: any) {
      setTests((t) => ({ ...t, [e.id]: { ok: false, detail: err?.message || '测试失败' } }));
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-surface/80 rounded-2xl overflow-hidden border border-white/70 dark:border-white/12">
          <Stat label="扩展总数" value={counts.total ?? exts.length} />
          {DOMAIN_ORDER.map((d) => (
            <Stat key={d} label={DOMAIN_META[d].label} value={allDomainCounts[d] ?? 0}
              active={domain === d} onClick={() => { setDomain(domain === d ? '' : d); setKind(''); }} />
          ))}
        </div>
        <div className="mt-1.5 text-[10.5px] text-gray-500">系统全量（含内置）；点四域卡片筛选，下面列表按筛选条件展示</div>
      </div>

      {/* ── 插件包 ── */}
      <section className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2">
          <Package className="w-4 h-4 text-violet-400" />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">插件包</h3>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setShowScaffold(true)}
              className="px-3 py-1.5 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-[11.5px] text-gray-200 hover:border-brand/60 flex items-center gap-1.5"
            >
              <PackagePlus className="w-3.5 h-3.5" />新建插件
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy === 'install'}
              className="px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5"
            >
            {busy === 'install' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              安装 zip 包
            </button>
          </div>
          <input
            ref={fileRef} type="file" accept=".zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) installPlugin(f); }}
          />
        </div>

        <div className="p-5 pt-3.5">
          {plugins.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/70 dark:border-white/12 px-4 py-6 text-center">
              <div className="text-[12px] text-gray-400">还没有装任何插件</div>
              <div className="text-[11px] text-gray-500 mt-1">选一个 zip 包安装</div>
            </div>
          ) : (
            <div className="space-y-2">
              {plugins.map((p) => (
                <div key={p.id} className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-4 py-3 flex items-center gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-bold text-[color:var(--color-text-main)] truncate">{p.name}</span>
                      <span className="text-[10px] font-mono text-gray-500">v{p.version}</span>
                      {(p.domains || []).map((d: string) => (
                        <span key={d} className="text-[9.5px] px-1.5 py-0.5 rounded border border-brand/40 bg-brand/10 text-brand-light">
                          {DOMAIN_META[d]?.label || d}
                        </span>
                      ))}
                      {p.enabled
                        ? <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">已启用</span>
                        : <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-surface-hover/80 border border-white/70 dark:border-white/12 text-gray-400">已停用</span>}
                    </div>
                    {p.description && <div className="text-[11px] text-gray-500 mt-0.5 truncate">{p.description}</div>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Act onClick={() => togglePlugin(p)} disabled={busy === p.id} icon={Power} label={p.enabled ? '停用' : '启用'} />
                    <Act onClick={async () => { setBusy(p.id); try { await apiService.reloadPlugin(p.id); toast.success('已热重载'); await load(); } catch (e: any) { toast.error(e?.message || '重载失败'); } finally { setBusy(null); } }}
                      disabled={busy === p.id} icon={RefreshCw} label="热重载" />
                    <Act onClick={() => removePlugin(p)} disabled={busy === p.id} icon={Trash2} label="卸载" accent="red" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 自己造一个 ── */}
      <section className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Puzzle className="w-4 h-4 text-brand-light" />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">自己造一个</h3>
          <CodeTemplateButton />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          <EntryCard icon={PackagePlus} iconCls="text-violet-400" title="新建插件脚手架"
            desc="按四域生成 plugin.json + README + 示例，补完贡献文件后直接启用"
            onClick={() => setShowScaffold(true)} />
          <EntryCard icon={Plug} iconCls="text-brand-light" title="新建自定义生成源"
            desc="贴 API 文档自动写代码接入，或手写 Python / JavaScript 协程、导入 ComfyUI 工作流"
            onClick={() => window.dispatchEvent(new CustomEvent('open-provider-create', { detail: { tab: 'doc' } }))} />
          <EntryCard icon={Workflow} iconCls="text-emerald-400" title="导入 ComfyUI 工作流"
            desc="导入后自动解析出可填槽位，这个工作流本身就变成一个独立生成源"
            onClick={() => window.dispatchEvent(new CustomEvent('open-workflow-import'))} />
          <EntryCard icon={Sparkles} iconCls="text-amber-400" title="技能工坊"
            desc="导入 / 删除 / 试跑技能，看版本 diff"
            onClick={() => window.dispatchEvent(new CustomEvent('open-skill-studio'))} />
          <EntryCard icon={Cpu} iconCls="text-emerald-400" title="MCP 工具"
            desc="查看工具清单、单独调用、看调用日志"
            onClick={() => window.dispatchEvent(new CustomEvent('open-mcp-tools'))} />
        </div>
      </section>

      {/* ── 全部扩展 ── */}
      <section className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-white/60 dark:border-white/12">
          <div className="flex items-center gap-2 flex-wrap">
            <Boxes className="w-4 h-4 text-brand-light" />
            <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">全部扩展</h3>
            <button onClick={load} className="ml-auto px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
              <RefreshCw className="w-3 h-3" />刷新
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / id"
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl pl-8 pr-3 py-1.5 text-[11.5px] text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60"
              />
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip active={!domain} onClick={() => { setDomain(''); setKind(''); }} label={`全部域 ${base.length}`} />
            {DOMAIN_ORDER.map((d) => (
              <Chip key={d} active={domain === d}
                onClick={() => { setDomain(domain === d ? '' : d); setKind(''); }}
                label={`${DOMAIN_META[d].label} ${domainCounts[d] ?? 0}`} title={DOMAIN_META[d].desc} />
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip active={!kind} onClick={() => setKind('')} label={`全部 ${shown.length}`} />
            {kindsPresent.map((k) => (
              <Chip key={k} active={kind === k} onClick={() => setKind(k)}
                label={`${KIND_META[k].label} ${viewCounts[k] ?? 0}`} title={KIND_META[k].desc} />
            ))}
            <button onClick={() => setShowBuiltin((v) => !v)}
              className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors flex items-center gap-1 ${
                showBuiltin ? 'bg-brand/15 border-brand/50 text-[color:var(--color-text-main)]' : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-400 hover:text-[color:var(--color-text-main)]'
              }`}>
              {showBuiltin ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}内置
            </button>
          </div>
          {kind && <div className="mt-2 text-[11px] text-gray-500 leading-relaxed">{KIND_META[kind].desc}</div>}
          {!showBuiltin && hiddenBuiltin > 0 && (
            <div className="mt-2 text-[11px] text-gray-500 leading-relaxed">
              已隐藏 {hiddenBuiltin} 个程序自带的内置项（不可删除，但可以停用/启用；生成源的 Key 在「核心能力」页填）。点「内置」可展开。
            </div>
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
                const t = tests[e.id] || {};
                return (
                  <div
                    key={e.id}
                    role="button" tabIndex={0}
                    onClick={() => openPrimary(e)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPrimary(e); } }}
                    title={EDITABLE_KINDS.has(e.kind) && !isBuiltin ? '点击编辑' : '点击预览'}
                    className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 px-3.5 py-2.5 cursor-pointer hover:border-brand/45 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[12px] font-bold text-[color:var(--color-text-main)] truncate">{e.name || e.local_id}</span>
                      <span className="text-[9.5px] px-1.5 py-0.5 rounded border border-white/70 dark:border-white/12 bg-surface-hover/80 text-gray-400">
                        {KIND_META[e.kind]?.label || e.kind}
                      </span>
                      <span className={`text-[9.5px] px-1.5 py-0.5 rounded border ${src.cls}`}
                        title={e.source === 'plugin' && e.source_detail ? `来自插件 ${e.source_detail}` : undefined}>
                        {src.label}
                      </span>
                      {e.status === 'disabled' && (
                        <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300">已停用</span>
                      )}
                      {t.detail && (
                        <span className={`text-[10.5px] ${t.ok ? 'text-emerald-400' : 'text-red-300'}`}>{t.detail}</span>
                      )}
                    </div>
                    {e.description && (
                      <div className="text-[11px] text-gray-500 mt-0.5 truncate" title={e.description}>
                        {e.description}
                      </div>
                    )}

                    <div className="mt-2 flex items-center gap-1.5 flex-wrap" onClick={(ev) => ev.stopPropagation()}>
                      {EDITABLE_KINDS.has(e.kind) && !isBuiltin && (
                        <Act onClick={() => editExt(e)} disabled={busy === e.id}
                          icon={busy === e.id ? Loader2 : Edit3} spin={busy === e.id} label="编辑" />
                      )}
                      {PREVIEW_KINDS.has(e.kind) && (
                        <Act onClick={() => setDetailExt(e)} icon={FileSearch} label="预览" />
                      )}
                      {TESTABLE_KINDS.has(e.kind) && (
                        <Act onClick={() => testExt(e)} disabled={t.running}
                          icon={t.running ? Loader2 : Plug2} spin={t.running} label={t.running ? '测试中' : '测试'} />
                      )}
                      {e.kind === 'theme' && (
                        <Act onClick={() => applyPluginTheme(activePluginThemeId === e.local_id ? '' : e.local_id)}
                          icon={Palette} label={activePluginThemeId === e.local_id ? '取消应用' : '应用主题'}
                          accent={activePluginThemeId === e.local_id ? 'brand' : undefined} />
                      )}
                      {e.kind === 'plugin' && (
                        <Act onClick={async () => { setBusy(e.id); try { await apiService.reloadPlugin(e.local_id); toast.success('已热重载'); await load(); } catch (err: any) { toast.error(err?.message || '重载失败'); } finally { setBusy(null); } }}
                          disabled={busy === e.id} icon={RefreshCw} label="热重载" />
                      )}
                      {isBuiltin && e.kind !== 'provider' ? (
                        <span className="text-[10.5px] text-gray-600 px-1">内置常驻，不可停用/删除</span>
                      ) : (
                        <>
                          <Act onClick={() => toggleExt(e)} disabled={busy === e.id}
                            icon={Power} label={e.status === 'enabled' || e.status === 'builtin' ? '停用' : '启用'}
                            title={isBuiltin ? '内置生成源：软停用（守卫拦下生成，可随时恢复）；不可删除' : '停用后不进下拉与执行链；定义保留'} />
                          {!isBuiltin && DELETABLE_KINDS.has(e.kind) && (
                            <Act onClick={() => removeExt(e)} disabled={busy === e.id} icon={Trash2} label="删除" accent="red" />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {showScaffold && (
        <PluginScaffoldModal
          onClose={() => setShowScaffold(false)}
          onCreated={() => { load(); window.dispatchEvent(new Event('plugin-list-refresh')); }}
        />
      )}

      {detailExt && (
        <ExtensionDetailDrawer
          ext={detailExt}
          onClose={() => setDetailExt(null)}
          onSaved={load}
        />
      )}

      {inspectWfId && (
        <WorkflowInspectorModal
          workflowId={inspectWfId} isOpen={!!inspectWfId}
          onClose={() => setInspectWfId('')}
          onSaved={() => { load(); window.dispatchEvent(new Event('provider-list-refresh')); }}
        />
      )}
    </div>
  );
};

/** 新建代码源时的起手模板 */
const CodeTemplateButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState('python');
  const [k, setK] = useState('image');
  const [tpl, setTpl] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchTpl = async (l: string, kk: string) => {
    setLoading(true);
    try { const r = await apiService.getCodeTemplate(l, kk); setTpl(r?.template || ''); }
    catch (e: any) { setTpl(`// 取模板失败：${e?.message || ''}`); }
    finally { setLoading(false); }
  };

  return (
    <>
      <button onClick={() => { const n = !open; setOpen(n); if (n && !tpl) fetchTpl(lang, k); }}
        className="ml-auto px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
        <FileCode2 className="w-3 h-3" />代码模板
      </button>
      {open && (
        <div className="w-full mt-2 rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 p-3">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <select value={lang} onChange={(e) => { setLang(e.target.value); fetchTpl(e.target.value, k); }}
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1 text-[11.5px] text-[color:var(--color-text-main)]">
              <option value="python">python</option>
              <option value="javascript">javascript</option>
            </select>
            <select value={k} onChange={(e) => { setK(e.target.value); fetchTpl(lang, e.target.value); }}
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1 text-[11.5px] text-[color:var(--color-text-main)]">
              <option value="image">生图</option>
              <option value="video">视频</option>
              <option value="audio">语音</option>
            </select>
            <button disabled={!tpl}
              onClick={async () => { try { await navigator.clipboard.writeText(tpl); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { toast.error('复制失败'); } }}
              className="ml-auto px-2.5 py-1 rounded-lg bg-brand text-white text-[11px] font-bold disabled:opacity-40 flex items-center gap-1">
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}{copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre className="max-h-52 overflow-auto rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 p-3 text-[11px] font-mono text-gray-300 leading-relaxed">
            {loading ? '取模板中…' : (tpl || '（空）')}
          </pre>
          <div className="mt-2 text-[10.5px] text-gray-500 leading-relaxed">
            <code className="font-mono">ctx.api_key</code> 自动注入，不用写死；
            <code className="font-mono">await api.download(url)</code> 把远程结果落盘。
          </div>
        </div>
      )}
    </>
  );
};

const EntryCard: React.FC<{ icon: any; iconCls: string; title: string; desc: string; onClick: () => void }> =
({ icon: Icon, iconCls, title, desc, onClick }) => (
  <button onClick={onClick}
    className="text-left rounded-xl border border-white/70 dark:border-white/12 bg-surface/80 hover:border-brand/50 transition-colors px-4 py-3">
    <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-[color:var(--color-text-main)]">
      <Icon className={`w-3.5 h-3.5 ${iconCls}`} />{title}
    </div>
    <div className="text-[11px] text-gray-500 mt-1 leading-relaxed">{desc}</div>
  </button>
);

const Act: React.FC<{
  onClick: () => void; icon: any; label: string;
  disabled?: boolean; accent?: 'red' | 'brand'; spin?: boolean; title?: string;
}> = ({ onClick, icon: Icon, label, disabled, accent, spin, title }) => {
  const cls = accent === 'red'
    ? 'bg-red-500/10 border-red-500/30 text-red-300 hover:text-white'
    : accent === 'brand'
      ? 'bg-brand/20 border-brand/50 text-brand-light'
      : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-200 hover:border-brand';
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`px-2.5 py-1 rounded-lg border text-[11px] flex items-center gap-1 disabled:opacity-40 transition-colors ${cls}`}>
      <Icon className={`w-3 h-3 ${spin ? 'animate-spin' : ''}`} />{label}
    </button>
  );
};

const Stat: React.FC<{ label: string; value: number; active?: boolean; onClick?: () => void }> =
({ label, value, active, onClick }) => (
  <button type="button" onClick={onClick}
    className={`text-left bg-surface/80 px-4 py-3 transition-colors ${onClick ? 'hover:bg-surface-hover/80' : ''} ${active ? 'bg-brand/10' : ''}`}>
    <div className={`text-xl font-bold font-mono leading-tight ${active ? 'text-white' : 'text-brand-light'}`}>{value}</div>
    <div className="text-[10.5px] text-gray-500">{label}</div>
  </button>
);

const Chip: React.FC<{ active: boolean; onClick: () => void; label: string; title?: string }> = ({ active, onClick, label, title }) => (
  <button onClick={onClick} title={title}
    className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
      active ? 'bg-brand/15 border-brand/50 text-[color:var(--color-text-main)]' : 'bg-surface/80 border-white/70 dark:border-white/12 text-gray-400 hover:text-[color:var(--color-text-main)]'
    }`}>
    {label}
  </button>
);
