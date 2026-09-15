import React, { useEffect, useMemo, useState } from 'react';
import { Boxes, Power, RefreshCw, Trash2, Activity, Search, Puzzle, AlertTriangle, Palette } from 'lucide-react';
import { apiService } from '../../services/api';
import { useProjectStore } from '../../stores/useProjectStore';
import { useThemeStore } from '../../stores/useThemeStore';
import { confirmAsync, toast } from '../../stores/useDialogStore';

const KIND_LABEL_FALLBACK: Record<string, string> = {
  provider: '生成源', skill: '技能', workflow: '工作流', custom_node: '代码节点',
  plugin: '插件包', mcp_tool: 'MCP 工具', storyboard_slot: '分镜槽',
  director_pack: '导演包', exporter: '导出器', theme: '主题', canvas_node: '画布节点',
};

const STATUS_STYLE: Record<string, string> = {
  builtin: 'bg-surface text-gray-500',
  enabled: 'bg-accent-green/20 text-accent-green',
  disabled: 'bg-surface text-gray-500',
};

/**
 * 扩展中心（#14 收口）：把生成源/技能/工作流/节点/插件/分镜槽聚合到一张表，
 * 统一启停（原生 or 覆盖层）+ 卸载 + 插件热重载 + 执行健康（#11）。
 */
export const ExtensionsCenterView: React.FC = () => {
  const projectId = useProjectStore((s) => s.project?.id) || undefined;
  const activePluginThemeId = useThemeStore((s) => s.activePluginThemeId);
  const applyPluginTheme = useThemeStore((s) => s.applyPluginTheme);
  const [items, setItems] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [kindsMeta, setKindsMeta] = useState<any>({ labels: KIND_LABEL_FALLBACK, placeholder: [], native_lifecycle: [], overlay_lifecycle: [] });
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [scopeProject, setScopeProject] = useState(false);

  const scope = scopeProject ? projectId : undefined;

  const load = async () => {
    setLoading(true);
    try {
      const [res, h] = await Promise.all([
        apiService.listExtensions({ kind: kind || undefined, q: q || undefined, projectId: scope }),
        apiService.extensionHealth().catch(() => null),
      ]);
      setItems(res.extensions || []);
      setCounts(res.counts || {});
      if (res.kinds) setKindsMeta(res.kinds);
      setHealth(h);
    } catch (e: any) {
      setMsg(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.listExtensions({ projectId: scope });
        if (cancelled) return;
        setItems(res.extensions || []);
        setCounts(res.counts || {});
        if (res.kinds) setKindsMeta(res.kinds);
        const h = await apiService.extensionHealth().catch(() => null);
        if (!cancelled) setHealth(h);
      } catch (e: any) {
        if (!cancelled) setMsg(e?.message || '加载失败');
      }
    })();
    return () => { cancelled = true; };
  }, [scope]);

  const grouped = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const e of items) (g[e.kind] = g[e.kind] || []).push(e);
    return g;
  }, [items]);

  const canToggle = (e: any) => e.status !== 'builtin' && !(e.kind === 'provider' && e.source === 'builtin');
  const canUninstall = (e: any) => e.kind === 'plugin' || (e.kind === 'provider' && e.source !== 'builtin');

  const doToggle = async (e: any) => {
    setBusy(e.id);
    setMsg(null);
    try {
      const r = await apiService.setExtensionEnabled(e.id, e.status !== 'enabled', scope);
      setMsg(`${e.status === 'enabled' ? '已停用' : '已启用'} ${e.id}（${r?.mode || 'native'}${scope ? ' · 项目级' : ''}）`);
      await load();
      // 前端各宿主热刷新（主题/画布节点/导出器/导演包）
      for (const ev of ['theme-list-refresh', 'canvasnode-list-refresh', 'exporter-list-refresh', 'directorpacks-list-refresh']) {
        try { window.dispatchEvent(new CustomEvent(ev)); } catch { /* ignore */ }
      }
    } catch (err: any) {
      setMsg(err?.message || '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const doUninstall = async (e: any) => {
    const ok = await confirmAsync({
      title: '卸载扩展', isDanger: true, confirmText: '确认卸载', cancelText: '取消',
      message: `确定卸载 ${e.id} 吗？将回滚其注册的生成源/技能/工作流/槽等落盘贡献。`,
    });
    if (!ok) return;
    setBusy(e.id);
    try {
      await apiService.uninstallExtension(e.id);
      toast.success(`已卸载 ${e.id}`);
      await load();
    } catch (err: any) {
      toast.error(err?.message || '卸载失败');
    } finally {
      setBusy(null);
    }
  };

  const doReload = async (e: any) => {
    setBusy(e.id);
    try {
      const r = await apiService.reloadPlugin(e.local_id);
      setMsg(`热重载 ${e.local_id}：${r?.enabled ? '已重载并启用' : '已重扫（未启用）'}`);
      await load();
    } catch (err: any) {
      setMsg(err?.message || '热重载失败');
    } finally {
      setBusy(null);
    }
  };

  const kinds = Object.keys(grouped).sort();
  const unhealthy: string[] = health?.unhealthy || [];

  return (
    <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-bold text-white flex items-center gap-2"><Boxes className="w-4 h-4 text-brand-light" />扩展中心</div>
          <div className="text-[11px] text-gray-500 mt-1">全 kind 聚合：{counts.total || items.length} 项 · 统一启停/卸载/热重载 · 执行健康。生成源/技能/工作流/节点/插件/分镜槽一处总览。</div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-gray-400 select-none">
            <input type="checkbox" checked={scopeProject} disabled={!projectId} onChange={(e) => setScopeProject(e.target.checked)} className="accent-brand" />
            项目级作用域{projectId ? '' : '（未打开项目）'}
          </label>
          <button onClick={load} className="px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-gray-300 hover:text-white flex items-center gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
        </div>
      </div>

      {health && (
        <div className="flex items-center gap-4 px-3 py-2 rounded-xl bg-surface-secondary/60 border border-border text-[11px] text-gray-400">
          <span className="flex items-center gap-1 text-gray-300"><Activity className="w-3.5 h-3.5 text-brand-light" />执行健康</span>
          <span>调用 <b className="text-white">{health.calls}</b></span>
          <span>错误 <b className={health.errors ? 'text-red-400' : 'text-white'}>{health.errors}</b></span>
          <span>超时 <b className={health.timeouts ? 'text-amber-400' : 'text-white'}>{health.timeouts}</b></span>
          <span>错误率 <b className="text-white">{Math.round((health.error_rate || 0) * 100)}%</b></span>
          {unhealthy.length > 0 && <span className="text-red-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{unhealthy.slice(0, 3).join(', ')}</span>}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-1.5">
          <Search className="w-3.5 h-3.5 text-gray-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} placeholder="搜索 id / 名称…" className="flex-1 bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none" />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="bg-surface-secondary border border-border rounded-xl px-3 py-1.5 text-xs text-gray-300 focus:outline-none">
          <option value="">全部 kind</option>
          {Object.keys(kindsMeta.labels || KIND_LABEL_FALLBACK).map((k) => (
            <option key={k} value={k}>{kindsMeta.labels?.[k] || k}{counts[k] ? ` (${counts[k]})` : ''}</option>
          ))}
        </select>
        <button onClick={load} disabled={loading} className="px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40">查询</button>
      </div>

      {msg && <div className="text-[11px] text-gray-300 bg-surface-secondary border border-border rounded-xl px-3 py-2">{msg}</div>}

      {(kindsMeta.placeholder || []).length > 0 && (
        <div className="text-[10px] text-amber-400/80 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />占位 kind（未落地执行）：{(kindsMeta.placeholder || []).join('、')}
        </div>
      )}

      {kinds.length === 0 && !loading && (
        <div className="text-xs text-gray-500 border border-dashed border-border rounded-2xl p-6 text-center">无匹配扩展。</div>
      )}

      {kinds.map((k) => (
        <div key={k}>
          <div className="text-xs font-bold text-gray-300 mb-1.5">{kindsMeta.labels?.[k] || KIND_LABEL_FALLBACK[k] || k} <span className="text-gray-600 font-mono">· {grouped[k].length}</span></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {grouped[k].map((e) => {
              const placeholder = (kindsMeta.placeholder || []).includes(e.kind) || e.placeholder;
              return (
                <div key={e.id} className={`p-3 rounded-xl border space-y-1.5 ${e.status === 'enabled' ? 'border-brand/40 bg-brand/5' : e.status === 'builtin' ? 'border-border bg-surface-secondary/50' : 'border-border bg-surface-secondary'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate flex items-center gap-1.5">
                        <Puzzle className="w-3.5 h-3.5 text-gray-500 shrink-0" />{e.name || e.local_id}
                        {e.version && <span className="font-mono text-gray-500 font-normal">v{e.version}</span>}
                      </div>
                      <div className="text-[10px] font-mono text-gray-500 truncate">{e.id}{e.sub_kind ? ` · ${e.sub_kind}` : ''}</div>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0 ${STATUS_STYLE[e.status] || 'bg-surface text-gray-500'}`}>
                      {e.status === 'builtin' ? '内置' : e.status === 'enabled' ? '启用' : '停用'}
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-500 flex items-center gap-2 flex-wrap">
                    <span>来源 {e.source}{e.source_detail ? `/${e.source_detail}` : ''}</span>
                    {e.publisher && <span>· 发布者 {e.publisher}</span>}
                    {e.depends_on?.length > 0 && <span className="text-amber-400">· 依赖 {e.depends_on.join(',')}</span>}
                    {placeholder && <span className="text-amber-400">· 未落地</span>}
                  </div>
                  <div className="flex items-center gap-1.5 pt-0.5">
                    {canToggle(e) && (
                      <button onClick={() => doToggle(e)} disabled={busy === e.id} className="flex-1 py-1 rounded-lg bg-surface border border-border text-[11px] text-gray-200 hover:border-brand disabled:opacity-40 flex items-center justify-center gap-1">
                        <Power className="w-3 h-3" />{e.status === 'enabled' ? '停用' : '启用'}
                      </button>
                    )}
                    {e.kind === 'theme' && (
                      <button
                        onClick={() => applyPluginTheme(activePluginThemeId === e.local_id ? '' : e.local_id)}
                        className={`flex-1 py-1 rounded-lg border text-[11px] flex items-center justify-center gap-1 ${activePluginThemeId === e.local_id ? 'bg-brand/20 border-brand/50 text-brand-light' : 'bg-surface border-border text-gray-200 hover:border-brand'}`}
                        title={activePluginThemeId === e.local_id ? '取消应用（恢复默认变量）' : '应用该主题包（注入 CSS 变量）'}
                      >
                        <Palette className="w-3 h-3" />{activePluginThemeId === e.local_id ? '取消应用' : '应用主题'}
                      </button>
                    )}
                    {e.kind === 'plugin' && (
                      <button onClick={() => doReload(e)} disabled={busy === e.id} className="px-2 py-1 rounded-lg bg-surface border border-border text-[11px] text-gray-300 hover:text-white disabled:opacity-40" title="热重载">
                        <RefreshCw className="w-3 h-3" />
                      </button>
                    )}
                    {canUninstall(e) && (
                      <button onClick={() => doUninstall(e)} disabled={busy === e.id} className="px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 hover:text-white disabled:opacity-40" title="卸载">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};
