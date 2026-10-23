import React, { useEffect, useState } from 'react';
import { Check, Loader2, ShieldCheck, X } from 'lucide-react';

import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';

type Policy = {
  execution_mode: 'plan' | 'auto' | 'create';
  permissions: Record<string, 'allow' | 'ask' | 'deny'>;
  model?: Record<string, any>;
  creator?: { enabled?: boolean; scopes?: string[]; require_change_set?: boolean };
};

const GROUPS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'read', label: '读取', hint: '项目 / 分镜 / 画布 / 素材 / Provider 列表' },
  { key: 'generate', label: '生成', hint: '生图 / 生视频 / 配音 / LLM 生成' },
  { key: 'write_project', label: '写项目', hint: '改分镜、画布、舞台、导出' },
  { key: 'write_assets', label: '写素材', hint: '新建 / 修改 / 发布素材' },
  { key: 'admin', label: '管理', hint: '生成源 / 插件 / Creator 变更' },
  { key: 'delegate', label: '委派', hint: '子代理、导演组、批量任务' },
  { key: 'settings', label: '设置', hint: '项目选项与模式切换' },
  { key: 'system', label: '系统', hint: 'shell / 读写本地文件（高风险）' },
];

const SCOPES: Array<{ key: string; label: string }> = [
  { key: 'capability', label: '能力（Provider / 工作流 / 工具）' },
  { key: 'canvas', label: '画布节点' },
  { key: 'workspace', label: '分镜槽 / 主题 / 导出器 / 导演包' },
  { key: 'agent', label: '技能 / 专家角色 / 导演组' },
];

const MODES: Array<{ key: Policy['execution_mode']; label: string; hint: string }> = [
  { key: 'plan', label: '计划', hint: '只读侦察，不生成不写盘' },
  { key: 'auto', label: '自动', hint: '按项目权限自动执行；ask 仍会确认' },
  { key: 'create', label: '创造', hint: '可提出系统变更；写入需用户批准' },
];

export const ProjectPolicyModal: React.FC<{
  open: boolean;
  projectId?: string | null;
  onClose: () => void;
  onSaved?: (policy: Policy) => void;
}> = ({ open, projectId, onClose, onSaved }) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);

  useEffect(() => {
    if (!open || !projectId) return;
    setLoading(true);
    apiService.getProjectAgentPolicy(projectId)
      .then((p) => setPolicy(p))
      .catch((e) => toast.error(`读取项目权限失败: ${e?.message || '未知错误'}`))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  if (!open) return null;

  const setPermission = (key: string, value: 'allow' | 'ask' | 'deny') => {
    setPolicy((p) => p ? { ...p, permissions: { ...p.permissions, [key]: value } } : p);
  };

  const toggleScope = (key: string) => {
    setPolicy((p) => {
      if (!p) return p;
      const scopes = new Set(p.creator?.scopes || []);
      if (scopes.has(key)) scopes.delete(key); else scopes.add(key);
      return { ...p, creator: { ...(p.creator || {}), scopes: [...scopes] } };
    });
  };

  const save = async () => {
    if (!projectId || !policy) return;
    setSaving(true);
    try {
      const next = await apiService.saveProjectAgentPolicy(projectId, policy);
      setPolicy(next);
      onSaved?.(next);
      toast.success('项目权限已保存');
      onClose();
    } catch (e: any) {
      toast.error(`保存失败: ${e?.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-2xl max-h-[86vh] overflow-hidden rounded-2xl border border-white/15 bg-surface shadow-2xl flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/10 flex items-center gap-2 shrink-0">
          <ShieldCheck className="w-4 h-4 text-brand" />
          <div className="flex-1">
            <div className="text-sm font-bold [color:var(--color-text-main)]">项目模型与权限</div>
            <div className="text-[10px] [color:var(--color-text-muted)]">只影响当前项目；模式决定自动程度，权限决定能碰什么</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-hover [color:var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-5">
          {loading || !policy ? (
            <div className="flex items-center justify-center py-10 text-xs [color:var(--color-text-muted)]">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />加载中…
            </div>
          ) : (
            <>
              <section>
                <div className="text-xs font-bold [color:var(--color-text-main)] mb-2">执行模式</div>
                <div className="grid grid-cols-3 gap-2">
                  {MODES.map((m) => {
                    const on = policy.execution_mode === m.key;
                    return (
                      <button
                        key={m.key}
                        onClick={() => setPolicy({ ...policy, execution_mode: m.key })}
                        className={`rounded-xl border p-2.5 text-left transition-colors ${
                          on ? 'border-brand/60 bg-brand/10' : 'border-white/70 dark:border-white/12 hover:border-brand/30'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 text-xs font-bold [color:var(--color-text-main)]">
                          {m.label}{on && <Check className="w-3 h-3 text-brand" />}
                        </div>
                        <div className="mt-1 text-[10px] leading-4 [color:var(--color-text-muted)]">{m.hint}</div>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="text-xs font-bold [color:var(--color-text-main)] mb-2">工具权限</div>
                <div className="space-y-1.5">
                  {GROUPS.map((g) => (
                    <div key={g.key} className="flex items-center gap-3 rounded-xl border border-white/60 dark:border-white/10 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-semibold [color:var(--color-text-main)]">{g.label}</div>
                        <div className="text-[10px] [color:var(--color-text-muted)] truncate">{g.hint}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {(['allow', 'ask', 'deny'] as const).map((v) => (
                          <button
                            key={v}
                            onClick={() => setPermission(g.key, v)}
                            className={`px-2 py-1 rounded-lg border text-[10px] font-bold transition-colors ${
                              policy.permissions[g.key] === v
                                ? v === 'allow' ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400'
                                  : v === 'ask' ? 'border-amber-500/50 bg-amber-500/15 text-amber-400'
                                    : 'border-red-500/50 bg-red-500/15 text-red-400'
                                : 'border-white/60 dark:border-white/10 [color:var(--color-text-muted)]'
                            }`}
                          >
                            {v === 'allow' ? '允许' : v === 'ask' ? '确认' : '禁止'}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="text-xs font-bold [color:var(--color-text-main)] mb-2">创造模式可改范围</div>
                <div className="grid sm:grid-cols-2 gap-1.5">
                  {SCOPES.map((s) => {
                    const on = (policy.creator?.scopes || []).includes(s.key);
                    return (
                      <button
                        key={s.key}
                        onClick={() => toggleScope(s.key)}
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[10.5px] ${
                          on ? 'border-violet-500/40 bg-violet-500/10' : 'border-white/60 dark:border-white/10'
                        }`}
                      >
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${on ? 'border-violet-400 bg-violet-500 text-white' : 'border-white/40'}`}>
                          {on && <Check className="w-2.5 h-2.5" />}
                        </span>
                        <span className="[color:var(--color-text-main)]">{s.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10px] leading-4 text-amber-500/90">
                  创造模式只产生变更提案；真正写入仍需用户批准，权限/密钥/安全设置始终不开放。
                </p>
              </section>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex items-center justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[11px] [color:var(--color-text-muted)] hover:bg-surface-hover">取消</button>
          <button
            onClick={() => void save()}
            disabled={saving || loading || !policy}
            className="px-3.5 py-1.5 rounded-lg bg-brand text-white text-[11px] font-bold disabled:opacity-50 flex items-center gap-1"
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}保存
          </button>
        </div>
      </div>
    </div>
  );
};
