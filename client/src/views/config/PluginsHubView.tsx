import React, { useEffect, useRef, useState } from 'react';
import { Puzzle, Upload, Power, Trash2, RefreshCw, FileJson } from 'lucide-react';
import { apiService } from '../../services/api';
import { confirmAsync, toast } from '../../stores/useDialogStore';

export const PluginsHubView: React.FC = () => {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiService.listPlugins();
      setPlugins(res.plugins || []);
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
        const res = await apiService.listPlugins();
        if (!cancelled) setPlugins(res.plugins || []);
      } catch (e: any) {
        if (!cancelled) setMsg(e?.message || '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const doToggle = async (p: any) => {
    setBusy(p.id);
    setMsg(null);
    try {
      const r = await apiService.setPluginEnabled(p.id, !p.enabled);
      setMsg(r?.note || ((r?.warnings || []).join('；') || (p.enabled ? '已禁用' : '已启用')));
      await load();
    } catch (e: any) {
      setMsg(e?.message || '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const doUninstall = async (p: any) => {
    const confirmed = await confirmAsync({
      title: '卸载插件',
      message: `确定要卸载插件 ${p.id} 吗？\n系统将自动回滚其注册的生成源、技能及工作流落盘文件。`,
      isDanger: true,
      confirmText: '确认卸载',
      cancelText: '取消'
    });
    if (!confirmed) return;
    setBusy(p.id);
    try {
      await apiService.uninstallPlugin(p.id);
      toast.success(`插件 ${p.id} 已卸载`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || '卸载失败');
    } finally {
      setBusy(null);
    }
  };

  const doUpload = async (f: File | undefined) => {
    if (!f) return;
    setBusy('upload');
    setMsg(null);
    try {
      const r = await apiService.installPlugin(f);
      setMsg(`已安装 ${r.id}@${r.version}，点启用生效`);
      await load();
    } catch (e: any) {
      setMsg(e?.message || '安装失败');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-bold text-white flex items-center gap-2"><Puzzle className="w-4 h-4 text-brand-light" />插件中心 <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/20 text-brand-light font-mono">P0</span></div>
          <div className="text-[11px] text-gray-500 mt-1">支持 providers / skills / workflows（自动sync成源）/ mcp_tools（查壳函数，需可信模式执行）/ custom_nodes（一段代码即画布节点）/ storyboard_slots（分镜槽）；canvas_nodes / director_packs / exporters / themes 为未落地占位。包格式见服务端 GET /plugins/spec，开发指南见 docs/plugin-dev.md。</div>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".zip" hidden onChange={(e) => doUpload(e.target.files?.[0])} />
          <button onClick={() => fileRef.current?.click()} disabled={busy === 'upload'} className="px-3 py-1.5 rounded-xl bg-brand text-white text-xs font-bold hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"><Upload className="w-3.5 h-3.5" />安装zip包</button>
          <button onClick={load} className="px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-gray-300 hover:text-white flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" />刷新</button>
        </div>
      </div>
      {msg && <div className="text-[11px] text-gray-300 bg-surface-secondary border border-border rounded-xl px-3 py-2">{msg}</div>}
      {loading ? <div className="text-xs text-gray-500">加载中…</div> : plugins.length === 0 ? (
        <div className="text-xs text-gray-500 border border-dashed border-border rounded-2xl p-6 text-center">暂无插件。仓库自带示例包 <span className="font-mono text-gray-300">plugins/example-drama-pack</span>（1个打磨技能），打zip后在此安装验证全链路。</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {plugins.map((p) => (
            <div key={p.id} className={`p-4 rounded-2xl border ${p.enabled ? 'border-brand/50 bg-brand/5' : 'border-border bg-surface-secondary'} space-y-2`}>
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-white truncate">{p.name || p.id} <span className="font-mono text-gray-500">v{p.version}</span></div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${p.enabled ? 'bg-accent-green/20 text-accent-green' : 'bg-surface text-gray-500'}`}>{p.enabled ? '已启用' : '未启用'}</span>
              </div>
              {p.error ? <div className="text-[11px] text-red-400">{p.error}</div> : <div className="text-[11px] text-gray-400 leading-4">{p.description || '—'}</div>}
              <div className="text-[10px] font-mono text-gray-500">
                源:{(p.contributions?.providers || []).length} · 技能:{(p.contributions?.skills || []).length} · 流:{(p.contributions?.workflows || []).length} · 工具:{(p.contributions?.mcp_tools || []).length} · 节点:{(p.contributions?.custom_nodes || []).length} · 槽:{(p.contributions?.storyboard_slots || []).length}
                {p.dependsOn && Object.keys(p.dependsOn).length > 0 && <span className="text-amber-400"> · 依赖:{Object.keys(p.dependsOn).join(',')}</span>}
                {p.deferred && Object.keys(p.deferred).length > 0 && <span className="text-amber-400"> · 未落地:{Object.keys(p.deferred).join(',')}</span>}
              </div>
              {!p.error && (
                <div className="flex items-center gap-2 pt-1">
                  <button onClick={() => doToggle(p)} disabled={busy === p.id} className="flex-1 py-1.5 rounded-lg bg-surface border border-border text-[11px] text-gray-200 hover:border-brand disabled:opacity-40 flex items-center justify-center gap-1"><Power className="w-3 h-3" />{p.enabled ? '禁用' : '启用'}</button>
                  <button onClick={() => doUninstall(p)} disabled={busy === p.id} className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 hover:text-white disabled:opacity-40"><Trash2 className="w-3 h-3" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="text-[10px] text-gray-600 flex items-center gap-1"><FileJson className="w-3 h-3" />manifest规范：id小写中划线 + semver + extensionPoints相对路径；单文件≤1MB/包≤20MB；provider走沙箱体检，skill通用分支零代码。</div>
    </div>
  );
};
