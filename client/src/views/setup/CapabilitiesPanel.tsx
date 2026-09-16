import React, { useMemo, useState } from 'react';
import {
  Check, AlertTriangle, Loader2, Eye, EyeOff, Cloud, HardDrive,
  CircleDot, Plug, ChevronRight,
} from 'lucide-react';
import { apiService } from '../../services/api';
import {
  CAPABILITIES, channelFilled, currentChannelId,
  type Capability, type Channel, type CapField,
} from './capabilityCatalog';

type TestState = { running?: boolean; ok?: boolean; detail?: string };

interface Props {
  cfg: Record<string, string>;
  draft: Record<string, string>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  loading: boolean;
}

/** 值优先取草稿，回落到已保存配置 */
const val = (draft: Record<string, string>, cfg: Record<string, string>, k: string) =>
  draft[k] !== undefined ? draft[k] : (cfg[k] || '');

export const CapabilitiesPanel: React.FC<Props> = ({ cfg, draft, setDraft, loading }) => {
  const merged = useMemo(() => ({ ...cfg, ...draft }), [cfg, draft]);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const readyOf = (cap: Capability) => {
    const ch = cap.channels.find((c) => c.id === currentChannelId(cap, merged));
    return !!ch && channelFilled(ch, merged);
  };
  const readyCount = CAPABILITIES.filter(readyOf).length;
  const essentialMissing = CAPABILITIES.filter((c) => c.essential && !readyOf(c));

  const pickChannel = (cap: Capability, ch: Channel) => {
    setDraft((d) => {
      const next = { ...d };
      if (cap.routeKey) next[cap.routeKey] = ch.id;
      Object.entries(ch.extraOnSelect || {}).forEach(([k, v]) => { next[k] = v; });
      return next;
    });
    setTests((t) => ({ ...t, [cap.id]: {} }));
  };

  const runTest = async (cap: Capability, ch: Channel) => {
    if (!ch.test) return;
    setTests((t) => ({ ...t, [cap.id]: { running: true } }));
    try {
      // 把当前草稿一并带上，这样不保存也能先测
      const res = await apiService.testConfig(ch.test as any, merged);
      setTests((t) => ({ ...t, [cap.id]: { ok: !!res?.ok, detail: res?.detail || '' } }));
    } catch (e: any) {
      setTests((t) => ({ ...t, [cap.id]: { ok: false, detail: e?.message || '测试失败' } }));
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-gray-500 gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> 读取当前配置…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── 就绪度总览 ── */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-[color:var(--color-text-main)]">配置进度</h2>
            <p className="text-[11.5px] text-gray-400 mt-0.5">
              下面 5 项能力各自独立，<b className="text-[color:var(--color-text-main)]">只有前两项是必须的</b>。
              进度条统计的是「必填项已填」，填了不等于通——每张卡还要点一次<b className="text-[color:var(--color-text-main)]">测试连通</b>。
            </p>
          </div>
          <div className="font-mono text-xs text-gray-400">
            <span className="text-2xl font-bold text-brand-light">{readyCount}</span>
            <span className="mx-1">/</span>{CAPABILITIES.length}
          </div>
        </div>

        <div className="mt-3 flex gap-1.5">
          {CAPABILITIES.map((c) => {
            const ok = readyOf(c);
            return (
              <div key={c.id} className="flex-1 space-y-1">
                <div className={`h-1.5 rounded-full ${ok ? 'bg-emerald-400' : c.essential ? 'bg-amber-400/40' : 'bg-surface-tertiary'}`} />
                <div className={`text-[10px] truncate ${ok ? 'text-emerald-400' : 'text-gray-500'}`}>{c.name}</div>
              </div>
            );
          })}
        </div>

        {essentialMissing.length > 0 && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-amber-200 leading-relaxed">
              还差 <b>{essentialMissing.map((c) => c.name).join(' / ')}</b> 没配 ——
              {essentialMissing.length > 1 ? '这两项' : '这项'}缺了，导入小说后就走不到出画面那一步。
            </div>
          </div>
        )}
        {essentialMissing.length === 0 && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
            <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-emerald-200 leading-relaxed">
              必需项都填了。接下来两步：右上角<b>保存</b> → 每张卡点一次<b>测试连通</b>。
              没测通的生成源不会出现在画布和分镜台的下拉里，这是故意的。
            </div>
          </div>
        )}
      </div>

      {/* ── 能力卡 ── */}
      {CAPABILITIES.map((cap) => {
        const chId = currentChannelId(cap, merged);
        const ch = cap.channels.find((c) => c.id === chId) || cap.channels[0];
        const filled = ch ? channelFilled(ch, merged) : false;
        const t = tests[cap.id] || {};

        return (
          <section key={cap.id} className="rounded-2xl border border-border bg-surface overflow-hidden">
            {/* 卡头 */}
            <div className="px-5 pt-4 pb-3 border-b border-border/70">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">{cap.name}</h3>
                {cap.essential
                  ? <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-brand/20 border border-brand/40 text-brand-light font-bold">必需</span>
                  : <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-surface-tertiary border border-border text-gray-400">可选</span>}
                <span className="ml-auto">
                  {t.running
                    ? <span className="text-[10.5px] text-gray-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />测试中</span>
                    : t.ok === true
                      ? <span className="text-[10.5px] text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" />已测通</span>
                      : filled
                        ? <span className="text-[10.5px] text-amber-300 flex items-center gap-1"><CircleDot className="w-3 h-3" />已填，待测试</span>
                        : <span className="text-[10.5px] text-gray-500 flex items-center gap-1"><CircleDot className="w-3 h-3" />未配置</span>}
                </span>
              </div>
              <p className="text-[12px] text-gray-400 leading-relaxed mt-1.5">{cap.why}</p>
              <p className="text-[11px] text-gray-500 leading-relaxed mt-1">
                <span className="text-gray-600">不配会怎样：</span>{cap.ifMissing}
              </p>
            </div>

            {/* 通道选择 */}
            <div className="px-5 py-3.5">
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-gray-500 mb-2">
                {cap.routeKey ? '选一个通道（同时就是默认通道）' : '通道'}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cap.channels.map((c) => {
                  const active = c.id === chId;
                  const done = channelFilled(c, merged);
                  return (
                    <button
                      key={c.id}
                      onClick={() => pickChannel(cap, c)}
                      title={c.summary}
                      className={`px-3 py-1.5 rounded-xl text-[11.5px] font-medium border transition-all flex items-center gap-1.5 ${
                        active
                          ? 'bg-brand/15 border-brand/50 text-[color:var(--color-text-main)] ring-1 ring-brand/30'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-[color:var(--color-text-main)] hover:border-brand/40'
                      }`}
                    >
                      {c.where === 'local'
                        ? <HardDrive className="w-3 h-3 text-emerald-400" />
                        : <Cloud className="w-3 h-3 text-sky-400" />}
                      <span>{c.name}</span>
                      {done && <Check className="w-3 h-3 text-emerald-400" />}
                    </button>
                  );
                })}
              </div>

              {ch && (
                <>
                  <p className="text-[11.5px] text-gray-400 leading-relaxed mt-3">{ch.summary}</p>

                  {ch.warn && (
                    <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-amber-200 leading-relaxed">{ch.warn}</div>
                    </div>
                  )}

                  {/* 字段 */}
                  <div className="mt-3.5 space-y-2.5">
                    {ch.fields.map((f) => (
                      <FieldRow
                        key={`${ch.id}:${f.key}`}
                        field={f}
                        value={val(draft, cfg, f.key)}
                        revealed={!!revealed[f.key]}
                        onReveal={() => setRevealed((r) => ({ ...r, [f.key]: !r[f.key] }))}
                        onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                      />
                    ))}
                  </div>

                  {/* 操作 */}
                  <div className="mt-3.5 flex items-center gap-2 flex-wrap">
                    {ch.test ? (
                      <button
                        onClick={() => runTest(cap, ch)}
                        disabled={t.running}
                        className="px-3.5 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5"
                      >
                        {t.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                        测试连通
                      </button>
                    ) : (
                      <span className="text-[11px] text-gray-500">该通道无独立连通测试，保存后在生成源里验证</span>
                    )}

                    {t.detail && (
                      <span className={`text-[11px] flex items-center gap-1 ${t.ok ? 'text-emerald-400' : 'text-red-300'}`}>
                        {t.ok ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                        {t.detail}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>
        );
      })}

      <div className="rounded-2xl border border-border bg-surface-secondary/60 p-4 flex items-start gap-2.5">
        <ChevronRight className="w-4 h-4 text-brand-light shrink-0 mt-0.5" />
        <div className="text-[11.5px] text-gray-400 leading-relaxed">
          <b className="text-[color:var(--color-text-main)]">想接的厂商不在上面？</b>
          去「扩展」页新建一个自定义生成源——写一段 Python/JavaScript 协程就能接任意 API，
          或者导入一个 ComfyUI 工作流，它本身就会变成一个独立生成源。
        </div>
      </div>
    </div>
  );
};

const FieldRow: React.FC<{
  field: CapField;
  value: string;
  revealed: boolean;
  onReveal: () => void;
  onChange: (v: string) => void;
}> = ({ field, value, revealed, onReveal, onChange }) => {
  const secret = field.kind === 'secret';
  return (
    <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] md:items-center gap-1.5 md:gap-3">
      <label className="text-[11.5px] text-gray-400 flex items-center gap-1.5">
        {field.label}
        {field.required !== false && <span className="text-amber-400">*</span>}
      </label>
      <div className="space-y-1">
        <div className="relative">
          <input
            type={secret && !revealed ? 'password' : 'text'}
            value={value}
            placeholder={field.placeholder || ''}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-[12px] font-mono text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60 transition-colors pr-9"
          />
          {secret && (
            <button
              onClick={onReveal}
              type="button"
              title={revealed ? '隐藏' : '显示'}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-500 hover:text-[color:var(--color-text-main)]"
            >
              {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
        {field.hint && <div className="text-[10.5px] text-gray-500 leading-relaxed">{field.hint}</div>}
        <div className="text-[9.5px] font-mono text-gray-600">{field.key}</div>
      </div>
    </div>
  );
};
