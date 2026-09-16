import React, { useEffect, useMemo, useState } from 'react';
import {
  Sliders, Boxes, Cog, Loader2, Save, RotateCcw, Check, AlertTriangle,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { CapabilitiesPanel } from './CapabilitiesPanel';
import { ExtensionsPanel } from './ExtensionsPanel';
import { SystemPanel } from './SystemPanel';

type TabKey = 'capabilities' | 'extensions' | 'system';

const TABS: Array<{ key: TabKey; label: string; sub: string; icon: any }> = [
  { key: 'capabilities', label: '能力配置', sub: '要做什么 · 谁来做 · 填什么', icon: Sliders },
  { key: 'extensions',   label: '扩展',     sub: '装插件 · 管全部扩展',        icon: Boxes },
  { key: 'system',       label: '系统',     sub: '安全 · 内核参数 · 诊断',     icon: Cog },
];

/**
 * 设置中心（重构版）。
 *
 * 旧版 7 个页签按「对象」分：概览 / 生成源 / 扩展中心 / 插件 / 默认路由 / 基础设施 / 系统诊断，
 * 同一件事的配置散在三处。这里收敛成 3 个，按「任务」分：
 *   能力配置 —— 我要做什么，选谁做，填什么（默认路由内嵌进选择动作，不再是独立页）
 *   扩展     —— 装包和管颗粒本是一件事的两头，合并
 *   系统     —— 与厂商无关的本机路径、安全闸、诊断、数据位置
 */
export const SetupView: React.FC = () => {
  const { setActiveTab, project } = useProjectStore();
  const [tab, setTab] = useState<TabKey>(() => {
    try {
      const pending = localStorage.getItem('config_pending_tab');
      if (pending) {
        localStorage.removeItem('config_pending_tab');
        // 兼容旧入口：plugins / extensions 都落到「扩展」
        if (pending === 'plugins' || pending === 'extensions') return 'extensions';
        if (pending === 'infra' || pending === 'system') return 'system';
      }
    } catch { /* ignore */ }
    return 'capabilities';
  });

  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [envFile, setEnvFile] = useState('');
  const [jsonFile, setJsonFile] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiService.getConfig();
      setCfg(res.config || {});
      setEnvFile(res.env_file || '');
      setJsonFile(res.json_backup_file || '');
      setDraft({});
    } catch (e: any) {
      toast.error(e?.message || '读取配置失败，确认后端已启动');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  /** 只提交真正改动过的键 */
  const changed = useMemo(
    () => Object.keys(draft).filter((k) => (draft[k] ?? '') !== (cfg[k] ?? '')),
    [draft, cfg],
  );
  const dirty = changed.length > 0;

  useEscapeClose(!dirty, () => setActiveTab(project ? 'studio' : 'projects'));

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      changed.forEach((k) => { payload[k] = draft[k] ?? ''; });
      await apiService.saveConfig(payload);
      toast.success(`已保存 ${changed.length} 项并热重载`);
      // 生成源的可用性可能随之变化，通知各宿主重拉
      try { window.dispatchEvent(new CustomEvent('provider-list-refresh')); } catch { /* ignore */ }
      await load();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* ── 顶栏 ── */}
      <div className="h-12 shrink-0 bg-surface border-b border-border px-5 flex items-center gap-3">
        {/* 左侧主导航常驻，这里不再放重复的返回入口 */}
        <span className="text-[12.5px] font-bold text-[color:var(--color-text-main)]">设置</span>

        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <span className="text-[11px] text-amber-300 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />{changed.length} 项未保存
            </span>
          )}
          {dirty && (
            <button onClick={() => setDraft({})}
              className="px-2.5 py-1 rounded-lg text-[11px] text-gray-400 hover:text-white flex items-center gap-1">
              <RotateCcw className="w-3 h-3" />放弃
            </button>
          )}
          <button
            onClick={save} disabled={!dirty || saving}
            className={`px-4 py-1.5 rounded-xl text-[11.5px] font-bold flex items-center gap-1.5 transition-colors ${
              dirty ? 'bg-brand text-white hover:bg-brand-light' : 'bg-surface-secondary border border-border text-gray-500 cursor-default'
            } disabled:opacity-60`}
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : dirty ? <Save className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
            {saving ? '写入中…' : dirty ? '保存' : '已保存'}
          </button>
        </div>
      </div>

      {/* ── 页签 ── */}
      <div className="shrink-0 bg-surface border-b border-border px-5">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3.5 py-2.5 flex items-center gap-2 border-b-2 transition-colors whitespace-nowrap ${
                  active ? 'border-brand text-[color:var(--color-text-main)]' : 'border-transparent text-gray-400 hover:text-[color:var(--color-text-main)]'
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? 'text-brand-light' : ''}`} />
                <span className="text-[12.5px] font-bold">{t.label}</span>
                <span className="text-[10.5px] text-gray-500 hidden md:inline">{t.sub}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 内容 ── */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-[900px] mx-auto px-5 py-6">
          {tab === 'capabilities' && (
            <CapabilitiesPanel cfg={cfg} draft={draft} setDraft={setDraft} loading={loading} />
          )}
          {tab === 'extensions' && <ExtensionsPanel />}
          {tab === 'system' && (
            <SystemPanel cfg={cfg} draft={draft} setDraft={setDraft} envFile={envFile} jsonFile={jsonFile} />
          )}
        </div>
      </div>

      {/* ── 底部常驻保存条（有改动时才出现，免得翻到顶） ── */}
      {dirty && (
        <div className="shrink-0 border-t border-brand/30 bg-brand/[0.06] px-5 py-2.5 flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-[11.5px] text-[color:var(--color-text-main)]">
            有 <b>{changed.length}</b> 项改动还没写进 <code className="font-mono text-[10.5px]">.env</code>
          </span>
          <span className="text-[10.5px] font-mono text-gray-500 truncate hidden md:inline">
            {changed.slice(0, 6).join(' · ')}{changed.length > 6 ? ` …+${changed.length - 6}` : ''}
          </span>
          <button onClick={save} disabled={saving}
            className="ml-auto px-4 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-60 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}保存并热重载
          </button>
        </div>
      )}
    </div>
  );
};
