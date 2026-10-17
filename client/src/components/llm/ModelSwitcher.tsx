/**
 * AI 对话输入框上的模型切换。选项来自模型广场，选中后下一轮对话走该供应商的该模型。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronUp, Cpu } from 'lucide-react';
import { toast } from '../../stores/useDialogStore';
import { useLlmPlazaStore } from './plazaStore';

export const ModelSwitcher: React.FC = () => {
  const suppliers = useLlmPlazaStore((s) => s.suppliers);
  const active = useLlmPlazaStore((s) => s.active);
  const loaded = useLlmPlazaStore((s) => s.loaded);
  const load = useLlmPlazaStore((s) => s.load);
  const setActive = useLlmPlazaStore((s) => s.setActive);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!loaded) load(); }, [loaded, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = suppliers.find((s) => s.id === active.supplier_id);
  const label = active.model
    ? (current ? `${active.model} · ${current.name}` : active.model)
    : '默认通道';

  const pick = async (supplierId: string, model: string) => {
    setOpen(false);
    try {
      await setActive(supplierId, model);
    } catch (e: any) {
      toast.error(e?.message || '切换模型失败');
    }
  };

  const choices = suppliers.flatMap((s) =>
    (s.models || []).map((m) => ({ supplierId: s.id, supplier: s.name, model: m.id })),
  );

  return (
    <div ref={ref} className="relative shrink-0 max-w-[42%]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={current ? `${current.name} · ${label}` : '使用设置里的默认文本通道'}
        className="h-7 max-w-full px-2 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 text-[11px] [color:var(--color-text-main)] hover:border-brand/50 flex items-center gap-1"
      >
        <Cpu className="w-3 h-3 shrink-0 text-brand-light" />
        <span className="truncate">{label}</span>
        <ChevronUp className={`w-3 h-3 shrink-0 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-50 w-72 max-h-72 overflow-y-auto bg-surface border border-border rounded-xl p-1">
          <button
            type="button"
            onClick={() => pick('', '')}
            className="w-full px-2 py-1.5 rounded-lg text-left text-[11px] hover:bg-surface-hover flex items-center gap-2"
          >
            <span className="flex-1 [color:var(--color-text-main)]">跟随设置里的默认通道</span>
            {!active.model && <Check className="w-3.5 h-3.5 text-brand shrink-0" />}
          </button>
          {choices.length === 0 && (
            <div className="px-2 py-2 text-[10.5px] text-gray-500 leading-relaxed">
              广场里还没有模型。到「设置 → 核心能力 → 文本大模型」添加供应商并拉取。
            </div>
          )}
          {suppliers.map((s) => (
            s.models.length === 0 ? null : (
              <div key={s.id} className="mt-1">
                <div className="px-2 pt-1 pb-0.5 text-[9.5px] uppercase tracking-wider text-gray-500">{s.name}</div>
                {s.models.map((m) => {
                  const on = active.supplier_id === s.id && active.model === m.id;
                  return (
                    <button
                      key={`${s.id}:${m.id}`}
                      type="button"
                      onClick={() => pick(s.id, m.id)}
                      className={`w-full px-2 py-1.5 rounded-lg text-left text-[11px] hover:bg-surface-hover flex items-center gap-2 ${on ? 'bg-surface-tertiary' : ''}`}
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block truncate [color:var(--color-text-main)]">{m.display && m.display !== m.id ? m.display : m.id}</span>
                        <span className="block truncate text-[10px] text-gray-500">{s.name}</span>
                      </span>
                      {on && <Check className="w-3.5 h-3.5 text-brand shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
};
