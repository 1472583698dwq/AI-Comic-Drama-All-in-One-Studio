import React, { useEffect, useMemo, useState } from 'react';
import {
  Sparkles, Boxes, Cog, Loader2, Save, RotateCcw, Check, AlertTriangle, HardDriveDownload,
  Power,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { resolveTab } from '../../stores/usePageStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { CapabilitiesArea } from './CapabilitiesPanel';
import { ExtensionsPanel } from './ExtensionsPanel';
import { FeaturesPanel } from './FeaturesPanel';
import { SystemPanel } from './SystemPanel';

type TabKey = 'core' | 'output' | 'features' | 'extensions' | 'system';

const TABS: Array<{ key: TabKey; label: string; sub: string; icon: any }> = [
  { key: 'core',       label: '核心能力',   sub: '文本 · 生图 · 生视频 · 配音', icon: Sparkles },
  { key: 'output',     label: '输出与存储', sub: '剪映导出 · 云端同步',        icon: HardDriveDownload },
  { key: 'features',   label: '功能开关',   sub: '页面 / 能力两层 · 开停即生效', icon: Power },
  { key: 'extensions', label: '扩展',       sub: '装插件 · 管全部扩展',        icon: Boxes },
  { key: 'system',     label: '系统',       sub: '安全 · 内核参数 · 诊断',     icon: Cog },
];

/**
 * 设置中心（能力配置拆分版）。
 *
 * 旧版 3 个页签里「能力配置」把 6 个能力 × 22 个通道平铺成一页长滚动。
 * 现在按生产链路拆成 5 个一级页签：
 *   核心能力   —— 文本 / 生图 / 生视频 / 配音 + 配置进度总览（左侧子导航切换）
 *   输出与存储 —— 剪映导出 / 云端同步
 *   功能开关   —— 页面开关 / 功能级开关两层（开停即生效，无需重启）
 *   扩展       —— 装包和管颗粒本是一件事的两头，合并
 *   系统       —— 与厂商无关的本机路径、安全闸、诊断、数据位置
 * 单个能力内部用「通道列表 + 字段面板」的 Master-Detail，右侧只显示选中通道的字段。
 */
export const SetupView: React.FC = () => {
  const { setActiveTab, project } = useProjectStore();
  const [tab, setTab] = useState<TabKey>(() => {
    try {
      const pending = localStorage.getItem('config_pending_tab');
      if (pending) {
        localStorage.removeItem('config_pending_tab');
        // 兼容旧入口：capabilities → 核心能力；features / pages → 功能开关；
        // plugins / extensions → 扩展；infra / system → 系统
        if (pending === 'capabilities') return 'core';
        if (pending === 'features' || pending === 'pages') return 'features';
        if (pending === 'plugins' || pending === 'extensions') return 'extensions';
        if (pending === 'infra' || pending === 'system') return 'system';
      }
    } catch { /* ignore */ }
    return 'core';
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

  // 退出设置：回落创意画布（原回落分镜工作台，该页签已下线）。
  // 但画布 / 看板都可能已在「功能开关」里被关掉，所以一律经 resolveTab 取一个确实开启的页，
  // 一个可用页都没有时兜底到首页（绝不硬跳一个被关掉的页）。
  useEscapeClose(!dirty, () => {
    const back = resolveTab(project ? 'canvas' : 'projects');
    setActiveTab((back || 'home') as any);
  });

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
      {/* ── 顶栏（唯一的保存入口） ── */}
      <div className="h-12 shrink-0 bg-white/60 dark:bg-white/[.05] border-b border-white/70 dark:border-white/12 px-5 flex items-center gap-3">
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
              dirty ? 'bg-brand text-white hover:bg-brand-light' : 'bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-gray-500 cursor-default'
            } disabled:opacity-60`}
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : dirty ? <Save className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
            {saving ? '写入中…' : dirty ? '保存' : '已保存'}
          </button>
        </div>
      </div>

      {/* ── 一级页签 ── */}
      <div className="shrink-0 bg-white/60 dark:bg-white/[.05] border-b border-white/70 dark:border-white/12 px-5">
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
      {(tab === 'core' || tab === 'output') ? (
        // 能力配置：左侧能力子导航 + 右侧内容，各自滚动
        <CapabilitiesArea tab={tab} cfg={cfg} draft={draft} setDraft={setDraft} loading={loading} />
      ) : (
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-[900px] mx-auto px-5 py-6">
            {tab === 'features' && <FeaturesPanel />}
            {tab === 'extensions' && <ExtensionsPanel />}
            {tab === 'system' && (
              <SystemPanel cfg={cfg} draft={draft} setDraft={setDraft} envFile={envFile} jsonFile={jsonFile} />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
