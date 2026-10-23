import React, { useMemo, useState } from 'react';
import { X, Loader2, PackagePlus, Boxes, Sparkles, Workflow, Users } from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';

const DOMAINS = [
  { key: 'capability', label: '能力', icon: Sparkles, desc: '生成源、工作流、MCP 工具', cls: 'text-brand-light' },
  { key: 'canvas', label: '画布', icon: Boxes, desc: '声明式节点、代码节点', cls: 'text-teal-400' },
  { key: 'workspace', label: '工作台', icon: Workflow, desc: '分镜槽、主题、导出器、导演包', cls: 'text-violet-400' },
  { key: 'agent', label: '智能体', icon: Users, desc: '技能、角色、导演组', cls: 'text-amber-400' },
];

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export const PluginScaffoldModal: React.FC<Props> = ({ onClose, onCreated }) => {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('capability');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [saving, setSaving] = useState(false);

  useEscapeClose(!saving, onClose);

  const idOk = useMemo(() => /^[a-z0-9][a-z0-9-]{1,63}$/.test(id.trim()), [id]);
  const canSubmit = idOk && name.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const r = await apiService.scaffoldPlugin({
        id: id.trim(), name: name.trim(), domain, description: description.trim(), author: author.trim(),
      });
      toast.success(`已生成插件骨架 ${r?.id || id.trim()}，下一步补贡献文件后启用`);
      onCreated();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || '生成失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-surface/95 rounded-2xl border border-white/70 dark:border-white/12 overflow-hidden">
        <div className="h-12 px-4 border-b border-white/70 dark:border-white/12 flex items-center gap-2">
          <PackagePlus className="w-4 h-4 text-brand-light" />
          <span className="text-sm font-bold text-[color:var(--color-text-main)]">新建插件脚手架</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover/80 border border-white/70 dark:border-white/12 text-gray-400">v2 四域</span>
          <button onClick={onClose} disabled={saving} className="ml-auto p-1 rounded hover:bg-surface-hover/80 disabled:opacity-40">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto custom-scrollbar">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <Field label="插件 id" hint="小写字母、数字、中划线">
              <input
                value={id} onChange={(e) => setId(e.target.value)}
                placeholder="my-drama-pack"
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-[12px] font-mono text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60"
              />
              {id && !idOk && <div className="text-[10.5px] text-red-300 mt-1">id 格式不合法</div>}
            </Field>
            <Field label="展示名">
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="我的漫剧扩展包"
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-[12px] text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60"
              />
            </Field>
          </div>

          <Field label="主域">
            <div className="grid grid-cols-2 gap-2">
              {DOMAINS.map((d) => {
                const Icon = d.icon;
                const active = domain === d.key;
                return (
                  <button key={d.key} type="button" onClick={() => setDomain(d.key)}
                    className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                      active
                        ? 'border-brand/60 bg-brand/10'
                        : 'border-white/70 dark:border-white/12 bg-surface/80 hover:border-brand/40'
                    }`}>
                    <div className="flex items-center gap-1.5 text-[12px] font-bold text-[color:var(--color-text-main)]">
                      <Icon className={`w-3.5 h-3.5 ${d.cls}`} />{d.label}
                    </div>
                    <div className="text-[10.5px] text-gray-500 mt-0.5 leading-relaxed">{d.desc}</div>
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="一句话说明">
            <input
              value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="这个插件带来什么"
              className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-[12px] text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60"
            />
          </Field>
          <Field label="作者（可选）">
            <input
              value={author} onChange={(e) => setAuthor(e.target.value)}
              placeholder="you"
              className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-[12px] text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60"
            />
          </Field>

          <div className="rounded-xl border border-white/70 dark:border-white/12 bg-surface/70 px-3 py-2.5 text-[10.5px] text-gray-500 leading-relaxed">
            会生成 <code className="font-mono">plugin.json</code>、<code className="font-mono">README.md</code> 和
            所选域的 <code className="font-mono">examples/&lt;domain&gt;.md</code>。
            不会自动启用，也不会执行任何代码；补完贡献文件后再回插件中心启用。
          </div>
        </div>

        <div className="h-12 px-4 border-t border-white/70 dark:border-white/12 flex items-center gap-2">
          <button onClick={onClose} disabled={saving}
            className="ml-auto px-3 py-1.5 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11.5px] text-gray-300 hover:text-white disabled:opacity-40">
            取消
          </button>
          <button onClick={submit} disabled={!canSubmit}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PackagePlus className="w-3.5 h-3.5" />}
            生成骨架
          </button>
        </div>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <div className="flex items-center gap-1.5 mb-1">
      <span className="text-[11px] text-gray-500">{label}</span>
      {hint && <span className="text-[10px] text-gray-600">{hint}</span>}
    </div>
    {children}
  </div>
);
