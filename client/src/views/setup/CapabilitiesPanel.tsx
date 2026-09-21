import React, { useEffect, useMemo, useState } from 'react';
import {
  Check, AlertTriangle, Loader2, Eye, EyeOff, Cloud, HardDrive,
  CircleDot, Plug, ChevronRight, FolderOpen, FolderSearch, Activity,
  ExternalLink, History,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';
import { ComfyWorkflowList } from './ComfyWorkflowList';
import {
  CAPABILITIES, channelFilled, currentChannelId,
  type Capability, type Channel, type CapField,
} from './capabilityCatalog';

type TestState = { running?: boolean; ok?: boolean; detail?: string };
type BackendState = { configured?: boolean; ok?: boolean };

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
  const [backend, setBackend] = useState<Record<string, BackendState>>({});
  const [testingAll, setTestingAll] = useState(false);

  /** 从后端注册表拉真实状态：通道 id 与 provider id 一致（如 image:comfyui / video:kling / audio:minimax） */
  useEffect(() => {
    let alive = true;
    const put = (kind: string, list: any[]) => {
      if (!alive || !Array.isArray(list)) return;
      setBackend((prev) => {
        const next = { ...prev };
        list.forEach((p) => {
          if (!p?.id) return;
          next[`${kind}:${p.id}`] = {
            configured: !!(p.is_configured ?? p.production_ready),
            ok: p.health?.ok,
          };
        });
        return next;
      });
    };
    Promise.allSettled([
      apiService.listImageProviders().then((r) => put('image', r?.providers)),
      apiService.listVideoProviders().then((r) => put('video', Array.isArray(r) ? r : r?.providers)),
      apiService.listTtsProviders().then((r) => put('audio', r?.providers)),
    ]).catch(() => { /* 后端未起时静默 */ });
    return () => { alive = false; };
  }, [cfg]);

  const testKey = (cap: Capability, ch: Channel) => `${cap.id}:${ch.id}`;

  const readyOf = (cap: Capability) => {
    const ch = cap.channels.find((c) => c.id === currentChannelId(cap, merged));
    return !!ch && channelFilled(ch, merged);
  };
  const readyCount = CAPABILITIES.filter(readyOf).length;
  const essentialMissing = CAPABILITIES.filter((c) => c.essential && !readyOf(c));
  const testable = useMemo(
    () => CAPABILITIES.flatMap((c) => c.channels.filter((ch) => ch.test).map((ch) => ({ cap: c, ch }))),
    [],
  );
  const testedCount = testable.filter(({ cap, ch }) => tests[testKey(cap, ch)]?.ok === true).length;

  const pickChannel = (cap: Capability, ch: Channel) => {
    setDraft((d) => {
      const next = { ...d };
      if (cap.routeKey) next[cap.routeKey] = ch.id;
      Object.entries(ch.extraOnSelect || {}).forEach(([k, v]) => { next[k] = v; });
      return next;
    });
    setTests((t) => ({ ...t, [testKey(cap, ch)]: {} }));
  };

  const runTest = async (cap: Capability, ch: Channel) => {
    if (!ch.test) return;
    const k = testKey(cap, ch);
    setTests((t) => ({ ...t, [k]: { running: true } }));
    try {
      // 把当前草稿一并带上，这样不保存也能先测
      const res = await apiService.testConfig(ch.test as any, merged);
      setTests((t) => ({ ...t, [k]: { ok: !!res?.ok, detail: res?.detail || '' } }));
    } catch (e: any) {
      setTests((t) => ({ ...t, [k]: { ok: false, detail: e?.message || '测试失败' } }));
    }
  };

  const runAllTests = async () => {
    setTestingAll(true);
    setTests((t) => {
      const next = { ...t };
      testable.forEach(({ cap, ch }) => { next[testKey(cap, ch)] = { running: true }; });
      return next;
    });
    for (const { cap, ch } of testable) {
      // 串行：避免同一时刻打爆各家限流，也能逐个看到进度
      // eslint-disable-next-line no-await-in-loop
      await runTest(cap, ch);
    }
    setTestingAll(false);
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
              进度条统计的是「必填项已填」，填了不等于通——点一次<b className="text-[color:var(--color-text-main)]">测试连通</b>才算数。
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

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <button
            onClick={runAllTests}
            disabled={testingAll}
            className="px-3.5 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5"
          >
            {testingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            {testingAll ? '逐个测试中…' : '一键测试全部通道'}
          </button>
          <span className="text-[11px] text-gray-500">
            共 {testable.length} 条可测通道{testedCount > 0 ? ` · 本次已测通 ${testedCount}` : ''}
          </span>
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
              必需项都填了。接下来两步：右上角<b>保存</b> → 点<b>一键测试全部通道</b>确认真的通。
              未配置 Key 的内置源不会出现在画布和分镜台的下拉里；自定义源接入即显示。
            </div>
          </div>
        )}
      </div>

      {/* ── 能力卡 ── */}
      {CAPABILITIES.map((cap) => {
        const chId = currentChannelId(cap, merged);
        const ch = cap.channels.find((c) => c.id === chId) || cap.channels[0];
        const filled = ch ? channelFilled(ch, merged) : false;
        const t = ch ? (tests[testKey(cap, ch)] || {}) : {};
        const bk = ch?.providerKind ? backend[`${ch.providerKind}:${ch.id}`] : undefined;

        return (
          <section key={cap.id} className="rounded-2xl border border-border bg-surface overflow-hidden">
            {/* 卡头 */}
            <div className="px-5 pt-4 pb-3 border-b border-border/70">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">{cap.name}</h3>
                {cap.essential
                  ? <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-brand/20 border border-brand/40 text-brand-light font-bold">必需</span>
                  : <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-surface-tertiary border border-border text-gray-400">可选</span>}
                {ch?.legacy && (
                  <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-gray-500/15 border border-gray-500/40 text-gray-400 font-bold flex items-center gap-1">
                    <History className="w-2.5 h-2.5" />旧版
                  </span>
                )}
                <span className="ml-auto">
                  {t.running
                    ? <span className="text-[10.5px] text-gray-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />测试中</span>
                    : t.ok === true
                      ? <span className="text-[10.5px] text-emerald-400 flex items-center gap-1"><Check className="w-3 h-3" />已测通</span>
                      : bk?.configured
                        ? <span className="text-[10.5px] text-sky-300 flex items-center gap-1"><CircleDot className="w-3 h-3" />后端已就绪{bk.ok === false ? '（探测未通）' : ''}</span>
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
                  const cb = c.providerKind ? backend[`${c.providerKind}:${c.id}`] : undefined;
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
                      {c.legacy && <span className="text-[9px] text-gray-500">旧</span>}
                      {done && <Check className="w-3 h-3 text-emerald-400" />}
                      {!done && cb?.configured && <span className="w-1.5 h-1.5 rounded-full bg-sky-400" title="后端已就绪" />}
                    </button>
                  );
                })}
              </div>

              {ch && (
                <>
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    <p className="text-[11.5px] text-gray-400 leading-relaxed flex-1 min-w-[240px]">{ch.summary}</p>
                    {ch.docs && (
                      <a href={ch.docs} target="_blank" rel="noreferrer"
                        className="text-[10.5px] text-brand-light hover:text-white flex items-center gap-1 shrink-0">
                        <ExternalLink className="w-3 h-3" />官方文档
                      </a>
                    )}
                  </div>

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

                  {/* ComfyUI 通道：工作流列表就近管理，不用再去别的页 */}
                  {ch.id === 'comfyui' && (
                    <ComfyWorkflowList
                      defaultImage={val(draft, cfg, 'COMFYUI_DEFAULT_IMAGE_WORKFLOW')}
                      defaultVideo={val(draft, cfg, 'COMFYUI_DEFAULT_VIDEO_WORKFLOW')}
                      onSetDefault={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
                    />
                  )}

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
  const listId = `dl_${field.key.replace(/[^A-Za-z0-9_]/g, '_')}`;

  const pickDir = async () => {
    try {
      const r = await apiService.browseFolder({ initialDir: value || undefined, title: `选择${field.label}` });
      if (r?.selected_path) onChange(r.selected_path);
    } catch (e: any) {
      toast.error(e?.message || '打不开系统目录选择器，请手动填路径');
    }
  };
  const openDir = async () => {
    try { await apiService.openFolder(value); }
    catch (e: any) { toast.error(e?.message || '打开目录失败'); }
  };
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
            list={field.choices?.length ? listId : undefined}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-[12px] font-mono text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60 transition-colors pr-9"
          />
          {field.choices?.length ? (
            <datalist id={listId}>
              {field.choices.map((c) => <option key={c} value={c} />)}
            </datalist>
          ) : null}
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
        <div className="flex items-center gap-1.5 flex-wrap">
          {field.pick && (
            <>
              <button type="button" onClick={pickDir}
                className="px-2 py-0.5 rounded-lg bg-brand/15 border border-brand/35 text-[10.5px] text-brand-light hover:bg-brand/25 flex items-center gap-1">
                <FolderSearch className="w-3 h-3" />选择目录
              </button>
              <button type="button" onClick={openDir} disabled={!value}
                className="px-2 py-0.5 rounded-lg bg-surface-secondary border border-border text-[10.5px] text-gray-400 hover:text-white disabled:opacity-40 flex items-center gap-1">
                <FolderOpen className="w-3 h-3" />打开
              </button>
            </>
          )}
          {(field.quickFill || []).map((q) => (
            <button key={q.value} type="button" onClick={() => onChange(q.value)}
              className="px-2 py-0.5 rounded-lg bg-surface-secondary border border-border text-[10.5px] text-gray-400 hover:text-white">
              {q.label}
            </button>
          ))}
        </div>
        {field.hint && <div className="text-[10.5px] text-gray-500 leading-relaxed">{field.hint}</div>}
        <div className="text-[9.5px] font-mono text-gray-600">{field.key}</div>
      </div>
    </div>
  );
};
