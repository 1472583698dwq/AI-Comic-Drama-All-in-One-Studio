import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RefreshCw, Save, Trash2, Wand2, X } from 'lucide-react';
import { apiService } from '../../../services/api';
import { useEscapeClose } from '../../../hooks/useEscapeClose';

const CONTAINER_LABEL: Record<string, string> = {
  'shot.modes': '制作模式',
  'shot.tabs': '检查器 Tab',
  'shot.anchors': '锚点',
  'shot.actions': '批量操作',
};

/**
 * 分镜槽管理：有效槽一览（内置/插件/裸件）+ 项目级禁用排序 +
 * 创造模式造新槽（提案 → Start → 持久化/丢弃）。
 */
export const SlotManagerModal: React.FC<{
  projectId?: string;
  onClose: () => void;
  onChanged: () => void;
}> = ({ projectId, onClose, onChanged }) => {
  useEscapeClose(true, onClose);
  const [slots, setSlots] = useState<any[]>([]);
  const [overrides, setOverrides] = useState<{ disabled: string[]; order: Record<string, number> }>({ disabled: [], order: {} });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // 本地编辑态（未保存不生效）
  const [disabled, setDisabled] = useState<string[]>([]);
  const [order, setOrder] = useState<Record<string, number>>({});
  // 造槽流
  const [goal, setGoal] = useState('');
  const [proposal, setProposal] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await apiService.listStoryboardSlots(projectId);
      setSlots(res.slots || []);
      const ov = res.overrides || { disabled: [], order: {} };
      setOverrides(ov);
      setDisabled(ov.disabled || []);
      setOrder(ov.order || {});
    } catch (e: any) {
      setMsg(`加载失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.listStoryboardSlots(projectId);
        if (cancelled) return;
        setSlots(res.slots || []);
        const ov = res.overrides || { disabled: [], order: {} };
        setOverrides(ov);
        setDisabled(ov.disabled || []);
        setOrder(ov.order || {});
      } catch (e: any) {
        if (!cancelled) setMsg(`加载失败: ${e?.message || e}`);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const grouped = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const s of slots) {
      const arr = g[s.slot] || (g[s.slot] = []);
      arr.push(s);
    }
    for (const k of Object.keys(g)) {
      g[k].sort((a, b) => {
        const oa = order[a.key] ?? a.order ?? 50;
        const ob = order[b.key] ?? b.order ?? 50;
        return oa - ob;
      });
    }
    return g;
  }, [slots, order]);

  const toggleDisabled = (key: string) => {
    setDisabled((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const moveOrder = (key: string, dir: -1 | 1) => {
    const cur = order[key] ?? slots.find((s) => s.key === key)?.order ?? 50;
    setOrder((prev) => ({ ...prev, [key]: cur + dir * 5 }));
  };

  const handleSave = async () => {
    if (!projectId) { setMsg('请先打开项目（项目级覆盖需 project_id）'); return; }
    setSaving(true);
    try {
      await apiService.saveStoryboardOverrides(projectId, disabled, order);
      setMsg('✓ 已保存并生效（当前项目）');
      onChanged();
      await load();
    } catch (e: any) {
      setMsg(`保存失败: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCustom = async (slot: string, sid: string) => {
    if (!window.confirm(`删除裸件槽 ${slot}:${sid}？（内置/插件槽不受影响）`)) return;
    try {
      await apiService.deleteCustomStoryboardSlot(slot, sid);
      setMsg('✓ 已删除');
      onChanged();
      await load();
    } catch (e: any) {
      setMsg(`删除失败: ${e?.message || e}`);
    }
  };

  const handlePropose = async () => {
    if (!goal.trim()) return;
    setCreating(true);
    setProposal(null);
    setReport(null);
    try {
      const res: any = await apiService.creatorPropose(goal.trim(), { project_id: projectId });
      setProposal(res);
    } catch (e: any) {
      setMsg(`提案失败: ${e?.message || e}`);
    } finally {
      setCreating(false);
    }
  };

  const handleStart = async () => {
    if (!proposal?.proposal_id) return;
    setCreating(true);
    try {
      const res: any = await apiService.creatorStart(proposal.proposal_id);
      setProposal(res.proposal || proposal);
      setReport(res.report || null);
    } catch (e: any) {
      setMsg(`试跑失败: ${e?.message || e}`);
    } finally {
      setCreating(false);
    }
  };

  const handleFinalize = async (action: 'persist' | 'discard' | 'rollback') => {
    if (!proposal?.proposal_id) return;
    setCreating(true);
    try {
      const res: any = await apiService.creatorFinalize(proposal.proposal_id, action);
      setProposal((p: any) => ({ ...(p || {}), status: res.status }));
      setMsg(`✓ ${action} 完成: ${res.status}`);
      if (action === 'persist') {
        onChanged();
        await load();
      }
    } catch (e: any) {
      setMsg(`失败: ${e?.message || e}`);
    } finally {
      setCreating(false);
    }
  };

  const dirty = JSON.stringify({ disabled, order }) !== JSON.stringify({ disabled: overrides.disabled || [], order: overrides.order || {} });

  return (
    <div className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="h-12 px-4 border-b border-border flex items-center justify-between shrink-0 bg-surface-secondary">
          <span className="text-sm font-bold text-white">🧩 分镜槽管理 <span className="text-xs font-normal text-zinc-500">· {slots.length} 槽生效中</span></span>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="p-1.5 rounded-lg hover:bg-surface-secondary text-zinc-400"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
            <button onClick={onClose}><X className="w-4 h-4 text-zinc-400" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {msg && <div className="text-xs px-3 py-2 rounded-xl bg-surface border border-border text-gray-300">{msg}</div>}

          {Object.keys(CONTAINER_LABEL).map((container) => (
            <div key={container}>
              <div className="text-xs font-bold text-zinc-300 mb-1.5">{CONTAINER_LABEL[container]}</div>
              <div className="space-y-1.5">
                {(grouped[container] || []).map((s: any) => {
                  const off = disabled.includes(s.key);
                  return (
                    <div key={s.key} className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs ${off ? 'opacity-40 bg-surface border-border' : 'bg-surface-secondary border-border'} ${s.valid === false ? 'border-red-500/40' : ''}`}>
                      <input type="checkbox" checked={!off} onChange={() => toggleDisabled(s.key)} title={off ? '已禁用（保存后生效）' : '启用中'} className="w-3.5 h-3.5 accent-brand shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-white font-semibold truncate">{s.label || s.id} <span className="font-mono font-normal text-zinc-500">{s.slot}:{s.id}</span></div>
                        {s.valid === false && <div className="text-[10px] text-red-400 truncate">无效：{s.error}</div>}
                        {s.source !== 'builtin' && <div className="text-[10px] text-zinc-500">来源：{s.source}{s.source_detail ? `/${s.source_detail}` : ''}</div>}
                      </div>
                      <span className="text-[10px] font-mono text-zinc-500 shrink-0">{order[s.key] ?? s.order ?? 50}</span>
                      <button onClick={() => moveOrder(s.key, -1)} className="p-1 rounded hover:bg-surface-secondary text-zinc-400" title="前移"><ArrowUp className="w-3 h-3" /></button>
                      <button onClick={() => moveOrder(s.key, 1)} className="p-1 rounded hover:bg-surface-secondary text-zinc-400" title="后移"><ArrowDown className="w-3 h-3" /></button>
                      {s.source === 'standalone' && (
                        <button onClick={() => handleDeleteCustom(s.slot, s.id)} className="p-1 rounded hover:bg-red-500/20 text-red-400" title="删除裸件槽"><Trash2 className="w-3 h-3" /></button>
                      )}
                    </div>
                  );
                })}
                {(grouped[container] || []).length === 0 && <div className="text-[11px] text-zinc-600">（空）</div>}
              </div>
            </div>
          ))}

          {/* 创造模式：自然语言造新槽 */}
          <div className="p-3 rounded-2xl bg-brand/5 border border-brand/20 space-y-2.5">
            <div className="text-xs font-bold text-white flex items-center gap-1.5"><Wand2 className="w-3.5 h-3.5 text-brand-light" /> 让导演造新槽 <span className="text-[10px] font-normal text-zinc-500">提案 → Start 试跑 → 持久化</span></div>
            <div className="flex gap-1.5">
              <input
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePropose(); }}
                placeholder="如：分镜加个批注Tab / 加个灯光锚点 / 加个一键合成按钮"
                className="flex-1 bg-surface-secondary border border-border-active rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-brand"
              />
              <button onClick={handlePropose} disabled={creating || !goal.trim()} className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-40">提案</button>
            </div>
            {proposal && (
              <div className="p-2.5 rounded-xl bg-surface-secondary border border-border text-xs space-y-1.5">
                <div className="text-white font-bold">{proposal.title} <span className="font-mono font-normal text-zinc-500">· {proposal.kind} · {proposal.status}</span></div>
                <div className="text-zinc-400">{proposal.diff_preview}</div>
                {(proposal.test_plan || []).length > 0 && <div className="text-zinc-500">试跑：{(proposal.test_plan || []).join(' → ')}</div>}
                {proposal.slot_spec?.doc && (
                  <pre className="text-[10px] font-mono text-zinc-500 bg-surface-secondary rounded-lg p-2 overflow-x-auto max-h-28 overflow-y-auto">{JSON.stringify(proposal.slot_spec.doc, null, 1)}</pre>
                )}
                {report && (
                  <div className="space-y-0.5">
                    {(report.checks || []).map((c: any, i: number) => (
                      <div key={i} className={`text-[11px] ${c.ok ? 'text-emerald-400' : 'text-red-400'}`}>{c.ok ? '✓' : '✗'} {c.name}：{c.detail}</div>
                    ))}
                  </div>
                )}
                <div className="flex gap-1.5 pt-1">
                  {proposal.status === 'proposed' && <button onClick={handleStart} disabled={creating} className="px-3 py-1.5 rounded-lg bg-brand/20 border border-brand/30 text-brand-light text-[11px] font-bold disabled:opacity-40">Start 试跑</button>}
                  {proposal.status === 'tested' && <button onClick={() => handleFinalize('persist')} disabled={creating} className="px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[11px] font-bold disabled:opacity-40">持久化</button>}
                  {proposal.status === 'persisted' && <button onClick={() => handleFinalize('rollback')} disabled={creating} className="px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 text-[11px] font-bold disabled:opacity-40">回滚</button>}
                  {['proposed', 'tested', 'test_failed'].includes(proposal.status) && <button onClick={() => handleFinalize('discard')} disabled={creating} className="px-3 py-1.5 rounded-lg bg-surface-secondary border border-border-active text-zinc-300 text-[11px] disabled:opacity-40">丢弃</button>}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="p-3 border-t border-border flex items-center justify-between shrink-0 bg-surface-secondary">
          <span className="text-[11px] text-zinc-500">{projectId ? `项目级覆盖 · ${projectId.slice(0, 8)}` : '未打开项目（覆盖需 project_id）'}{dirty ? ' · 有未保存更改' : ''}</span>
          <div className="flex gap-2">
            <button onClick={() => { setGoal(''); setProposal(null); setReport(null); onClose(); }} className="px-4 py-1.5 rounded-xl bg-surface-secondary border border-border-active text-xs text-white">关闭</button>
            <button onClick={handleSave} disabled={saving || !dirty} className="px-4 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1 disabled:opacity-40"><Save className="w-3.5 h-3.5" />{saving ? '保存中…' : '保存覆盖'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const SlotManagerButton: React.FC<{ onOpen: () => void }> = ({ onOpen }) => (
  <button onClick={onOpen} className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-white" title="分镜槽管理：启停/排序/造新槽">
    <Plus className="w-3 h-3" /> 槽管理
  </button>
);
