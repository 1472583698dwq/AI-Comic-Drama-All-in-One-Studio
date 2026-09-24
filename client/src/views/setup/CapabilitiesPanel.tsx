import React, { useEffect, useMemo, useState } from 'react';
import {
  Check, AlertTriangle, Loader2, Eye, EyeOff, Cloud, HardDrive,
  CircleDot, Plug, ChevronRight, FolderOpen, FolderSearch,
  ExternalLink, History, FlaskConical, KeyRound, Landmark,
  FileCode2, ArrowRight,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { toast, confirmAsync } from '../../stores/useDialogStore';
import { ComfyWorkflowList } from './ComfyWorkflowList';
import {
  CAPABILITIES, channelFilled, currentChannelId, channelsOf, unmatchedRoute,
  capabilityIdForKind, customChannelFrom,
  type Capability, type Channel, type CapField,
} from './capabilityCatalog';

/** 单通道测试结果。skipped = 该通道没有可一键跑的连通测试（不是失败） */
type TestState = { running?: boolean; ok?: boolean; detail?: string; skipped?: boolean };

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
  /** 自定义生成源按能力分组（它们只存在于 /providers，不在静态目录里） */
  const [customsByCap, setCustomsByCap] = useState<Record<string, Channel[]>>({});
  /** 自定义源是否已拉过一次：首帧未拉到时不要急着报「默认通道不在列表里」 */
  const [customsReady, setCustomsReady] = useState(false);
  /** 就地填 Key：源 id → 输入中的值 */
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState('');
  const [bulk, setBulk] = useState<{ running: boolean; done: number; total: number }>({
    running: false, done: 0, total: 0,
  });

  const loadCustoms = async () => {
    try {
      const res = await apiService.listProviders({ include_builtin: false });
      const grouped: Record<string, Channel[]> = {};
      (res?.providers || []).forEach((p: any) => {
        // 只并入代码型自定义源；ComfyUI 工作流源已由「ComfyUI」通道的工作流列表就近管理
        if (String(p?.provider_type || '') !== 'code') return;
        const capId = capabilityIdForKind(p?.kind);
        if (!capId) return;
        (grouped[capId] ||= []).push(customChannelFrom(p));
      });
      setCustomsByCap(grouped);
    } catch {
      // 后端未起 / 接口不可用时退化成纯内置目录，不因此挡住配置
      setCustomsByCap({});
    } finally {
      setCustomsReady(true);
    }
  };
  useEffect(() => { loadCustoms(); }, []);
  useEffect(() => {
    const h = () => loadCustoms();
    window.addEventListener('provider-list-refresh', h);
    return () => window.removeEventListener('provider-list-refresh', h);
  }, []);

  const customsOf = (cap: Capability) => customsByCap[cap.id] || [];
  const channelsFor = (cap: Capability) => channelsOf(cap, customsOf(cap));
  const activeOf = (cap: Capability): Channel | undefined => {
    const list = channelsFor(cap);
    return list.find((c) => c.id === currentChannelId(cap, merged, customsOf(cap))) || list[0];
  };

  const readyOf = (cap: Capability) => {
    const ch = activeOf(cap);
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

  /** 单通道连通测试：内置走 /config/test，自定义源走 /providers/{id}/test */
  const runTest = async (cap: Capability, ch: Channel): Promise<TestState> => {
    if (!ch.test && !ch.providerId) {
      const st: TestState = { skipped: true, detail: '该通道无独立连通测试' };
      setTests((t) => ({ ...t, [cap.id]: st }));
      return st;
    }
    setTests((t) => ({ ...t, [cap.id]: { running: true } }));
    let st: TestState;
    try {
      if (ch.providerId) {
        const res = await apiService.testProvider(ch.providerId);
        const ok = res?.status === 'success' || res?.ok === true;
        st = { ok, detail: res?.detail || res?.error || (ok ? '连通正常' : '未通过') };
      } else {
        // 把当前草稿一并带上，这样不保存也能先测
        const res = await apiService.testConfig(ch.test as any, merged);
        st = { ok: !!res?.ok, detail: res?.detail || '' };
      }
    } catch (e: any) {
      st = { ok: false, detail: e?.message || '测试失败' };
    }
    setTests((t) => ({ ...t, [cap.id]: st }));
    return st;
  };

  /** 一键测试全部：测每项能力「当前选中的通道」，内置与自定义一视同仁 */
  const runAllTests = async () => {
    if (bulk.running) return;
    const jobs = CAPABILITIES
      .map((cap) => ({ cap, ch: activeOf(cap) }))
      .filter((j) => !!j.ch) as Array<{ cap: Capability; ch: Channel }>;
    setBulk({ running: true, done: 0, total: jobs.length });
    let done = 0;
    const results: Array<{ cap: Capability; st: TestState }> = [];
    const queue = [...jobs];
    // 并发 3：早点出结果，也不至于同时打爆一堆外部接口
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        const st = await runTest(job.cap, job.ch);
        results.push({ cap: job.cap, st });
        done += 1;
        setBulk((b) => ({ ...b, done }));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setBulk({ running: false, done, total: jobs.length });
    const okCount = results.filter((r) => r.st.ok === true).length;
    const skipped = results.filter((r) => r.st.skipped);
    const failed = results.filter((r) => r.st.ok !== true && !r.st.skipped);
    if (failed.length === 0) {
      toast.success(
        `全部测通 ${okCount} 项${skipped.length ? `（另有 ${skipped.length} 项无独立测试）` : ''}`,
      );
    } else {
      toast.error(`测通 ${okCount} / ${results.length}：未通过 ${failed.map((f) => f.cap.name).join('、')}`);
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
              进度条统计的是「必填项已填」，填了不等于通——点右边的
              <b className="text-[color:var(--color-text-main)]">一键测试全部</b>，
              或每张卡单独点一次<b className="text-[color:var(--color-text-main)]">测试连通</b>。
              <span className="block mt-0.5 text-gray-500">
                一键测试跑的是每项能力「当前选中的通道」；云端源会真实打一次接口（可能消耗一次配额），本地源只探地址。
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={runAllTests}
              disabled={bulk.running || loading}
              className="px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-[11.5px] font-bold text-[color:var(--color-text-main)] hover:border-brand/50 disabled:opacity-40 flex items-center gap-1.5"
            >
              {bulk.running
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <FlaskConical className="w-3.5 h-3.5 text-brand-light" />}
              {bulk.running ? `测试中 ${bulk.done}/${bulk.total}` : '一键测试全部'}
            </button>
            <div className="font-mono text-xs text-gray-400">
              <span className="text-2xl font-bold text-brand-light">{readyCount}</span>
              <span className="mx-1">/</span>{CAPABILITIES.length}
            </div>
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
              未配置 Key 的内置源不会出现在画布和分镜台的下拉里；自定义源接入即显示。
            </div>
          </div>
        )}
      </div>

      {/* ── 能力卡 ── */}
      {CAPABILITIES.map((cap) => {
        const chs = channelsFor(cap);
        const chId = currentChannelId(cap, merged, customsOf(cap));
        const ch = chs.find((c) => c.id === chId) || chs[0];
        const orphan = customsReady ? unmatchedRoute(cap, merged, customsOf(cap)) : '';
        const customCount = customsOf(cap).length;
        const filled = ch ? channelFilled(ch, merged) : false;
        const t = tests[cap.id] || {};

        return (
          <section key={cap.id} className="rounded-2xl border border-border bg-surface overflow-hidden">
            {/* 卡头 */}
            <div className="px-5 pt-4 pb-3 border-b border-border/70">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">{cap.name}</h3>
                {cap.essential
                  ? <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-brand/20 text-brand-light font-bold">必需</span>
                  : <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-surface-tertiary text-gray-400">可选</span>}
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
                {customCount > 0 && (
                  <span className="ml-2 font-normal normal-case tracking-normal text-gray-500">
                    · 已并入 {customCount} 个自定义源，选中即写默认通道
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {chs.map((c) => {
                  const active = c.id === chId;
                  const done = channelFilled(c, merged);
                  return (
                    <button
                      key={c.id}
                      onClick={() => pickChannel(cap, c)}
                      title={c.legacy ? `${c.summary}\n旧版通道：${c.legacy}` : c.summary}
                      className={`px-3 py-1.5 rounded-xl text-[11.5px] font-medium border transition-all flex items-center gap-1.5 ${
                        active
                          ? 'bg-brand/15 border-brand/50 text-[color:var(--color-text-main)] ring-1 ring-brand/30'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-[color:var(--color-text-main)] hover:border-brand/40'
                      }`}
                    >
                      {c.custom
                        ? <Landmark className="w-3 h-3 text-amber-300" />
                        : c.where === 'local'
                          ? <HardDrive className="w-3 h-3 text-emerald-400" />
                          : <Cloud className="w-3 h-3 text-sky-400" />}
                      <span>{c.name}</span>
                      {c.custom && (
                        <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-300">
                          自定义
                        </span>
                      )}
                      {c.disabled && (
                        <span className="text-[9px] px-1 rounded bg-surface-tertiary text-gray-400">
                          已停用
                        </span>
                      )}
                      {c.legacy && (
                        <span className="text-[9px] px-1 rounded bg-surface-tertiary text-gray-400 flex items-center gap-0.5">
                          <History className="w-2.5 h-2.5" />旧版
                        </span>
                      )}
                      {done && <Check className="w-3 h-3 text-emerald-400" />}
                    </button>
                  );
                })}
              </div>

              {orphan && (
                <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-amber-200 leading-relaxed">
                    当前默认通道 <code className="font-mono">{orphan}</code> 不在可选列表里（对应的源可能已被删除或停用），
                    下面显示的是第一个可用通道。<b>不改通道就不会写这条默认值</b>，点了任意通道并保存才会改写。
                  </div>
                </div>
              )}

              {ch && (
                <>
                  <p className="text-[11.5px] text-gray-400 leading-relaxed mt-3">{ch.summary}</p>

                  {ch.docUrl && (
                    <a
                      href={ch.docUrl} target="_blank" rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-[11px] text-brand-light hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />官方文档（核对模型名 / 参数口径）
                    </a>
                  )}

                  {ch.legacy && (
                    <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-border bg-surface-secondary px-3 py-2">
                      <History className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-gray-400 leading-relaxed">
                        <b className="text-gray-300">旧版通道</b> · {ch.legacy}
                      </div>
                    </div>
                  )}

                  {ch.disabled && (
                    <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-amber-200 leading-relaxed">
                        这个生成源在「扩展」页被停用了。即使选成默认通道，生成时也会被守卫拦下
                        ——先去「扩展」页把它启用。
                      </div>
                    </div>
                  )}

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
                        listId={`${ch.id}:${f.key}`}
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

                  {/* 自定义源：Key 不走 .env，就地写 CUSTOM_PROVIDER_<id> */}
                  {ch.custom && ch.providerId && (
                    <CustomSourceBox
                      channel={ch}
                      value={keyDraft[ch.providerId] ?? ''}
                      busy={keyBusy === ch.providerId}
                      onChange={(v) => {
                        const pid = ch.providerId as string;
                        setKeyDraft((k) => ({ ...k, [pid]: v }));
                      }}
                      onSave={async () => {
                        const pid = ch.providerId as string;
                        const key = (keyDraft[pid] || '').trim();
                        if (!key) { toast.error('先填 Key 再保存'); return; }
                        setKeyBusy(pid);
                        try {
                          await apiService.setProviderApiKey(pid, key);
                          toast.success(`已保存「${ch.name}」的 Key`);
                          setKeyDraft((k) => ({ ...k, [pid]: '' }));
                          await loadCustoms();
                        } catch (e: any) {
                          toast.error(e?.message || '保存 Key 失败');
                        } finally {
                          setKeyBusy('');
                        }
                      }}
                      onMigrated={async () => {
                        await loadCustoms();
                      }}
                    />
                  )}

                  {/* 操作 */}
                  <div className="mt-3.5 flex items-center gap-2 flex-wrap">
                    {(ch.test || ch.providerId) ? (
                      <button
                        onClick={() => runTest(cap, ch)}
                        disabled={t.running}
                        className="px-3.5 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5"
                      >
                        {t.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                        {ch.providerId ? '测试这个源' : '测试连通'}
                      </button>
                    ) : (
                      <span className="text-[11px] text-gray-500">该通道无独立连通测试，保存后在生成源里验证</span>
                    )}

                    {t.detail && (
                      <span className={`text-[11px] flex items-center gap-1 ${
                        t.skipped ? 'text-gray-500' : t.ok ? 'text-emerald-400' : 'text-red-300'
                      }`}>
                        {t.skipped
                          ? <CircleDot className="w-3.5 h-3.5" />
                          : t.ok ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
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
          新建的代码源（生图 / 生视频 / 配音）会自动并入本页对应能力的通道行，可在这里选为默认通道并就地填 Key。
        </div>
      </div>
    </div>
  );
};

/** 自定义源的生效配置：Key 从哪来 + 代码里写死了什么（把隐式配置摊到设置页） */
const CustomSourceBox: React.FC<{
  channel: Channel;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onMigrated: () => void;
}> = ({ channel, value, busy, onChange, onSave, onMigrated }) => {
  const pid = channel.providerId as string;
  const [eff, setEff] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);
  const [migrating, setMigrating] = useState(false);

  const load = async () => {
    try {
      const r = await apiService.getProviderEffectiveConfig(pid);
      setEff(r?.effective || null);
    } catch {
      setEff(null); // 接口不可用时不挡填 Key
    }
  };
  useEffect(() => { load(); }, [pid]);

  const migrate = async (rewrite: boolean) => {
    const ok = await confirmAsync({
      title: '迁移内联 Key',
      confirmText: '开始迁移',
      cancelText: '取消',
      message: rewrite
        ? `把代码里的内联 Key 写入 ${eff?.env_name || '配置存储'}，并改写代码让它运行时从配置读：\n· 常量字面量置空\n· generate 入口注入 global 恢复语句（配置优先，字面量仅作兜底）\n\n迁移后请重新测一次这个源。`
        : `只把代码里的内联 Key 复制到 ${eff?.env_name || '配置存储'}，不改代码。\n若代码没有读 ctx.get("api_key")，运行时仍然是代码里那一句生效。`,
    });
    if (!ok) return;
    setMigrating(true);
    try {
      const r = await apiService.migrateProviderInlineKey(pid, rewrite);
      const notes: string[] = r?.notes || [];
      toast.success(`已写入 ${r?.env_name || '配置存储'}${notes.length ? `（${notes.join('；')}）` : ''}`);
      await load();
      onMigrated();
    } catch (e: any) {
      toast.error(e?.message || '迁移失败');
    } finally {
      setMigrating(false);
    }
  };

  const badge = eff?.key_source === 'stored'
    ? { text: 'Key 来自配置存储', cls: 'bg-emerald-500/15 text-emerald-300' }
    : eff?.key_source === 'inline'
      ? { text: 'Key 写在代码里', cls: 'bg-amber-500/15 text-amber-300' }
      : { text: '未找到 Key', cls: 'bg-surface-tertiary text-gray-400' };

  // 这块只列两类"写死的配置"：接口地址 + 密钥（其余常量如工作流 ID 不展示，保持一屏可读）
  const allRows: any[] = [
    ...(eff?.constants || []),
    ...(eff?.ctx_fallbacks || []),
    ...(eff?.loose_literals || []),
  ];
  const urlRows: any[] = (eff?.constants || []).filter((c: any) => c.kind === 'url');
  const keyHit = eff?.inline_key ? allRows.find((c: any) => c.value === eff.inline_key) : null;
  const keyRow = eff?.inline_key
    ? {
        name: eff.inline_key_name || (eff.inline_key_origin === 'ctx_fallback' ? 'ctx 兜底链' : '表达式内字面量'),
        value: eff.inline_key as string,
        masked: eff.inline_key_masked as string,
        line: keyHit?.line as number | undefined,
      }
    : null;
  const hasImplicit = urlRows.length > 0 || !!keyRow;

  return (
    <div className="mt-3.5 rounded-xl border border-border bg-surface-secondary/60 px-3 py-2.5">
      {/* ── Key：配置存储这一侧 ── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <KeyRound className="w-3.5 h-3.5 text-brand-light" />
        <span className="text-[11.5px] font-bold text-[color:var(--color-text-main)]">这个自定义源的 API Key</span>
        <span className={`text-[9.5px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="password" value={value} autoComplete="off" spellCheck={false}
          placeholder="留空不动已保存的 Key；填新值即覆盖"
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-surface border border-border rounded-xl px-3 py-1.5 text-[11.5px] font-mono text-[color:var(--color-text-main)] placeholder-gray-600 focus:outline-none focus:border-brand/60"
        />
        <button
          onClick={onSave} disabled={busy}
          className="px-3 py-1.5 rounded-xl bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}保存 Key
        </button>
      </div>
      <div className="mt-1.5 text-[10.5px] text-gray-500 leading-relaxed">
        存到 <code className="font-mono">CUSTOM_PROVIDER_{channel.providerId}</code>，源码里用
        <code className="font-mono"> api.get("api_key")</code> / <code className="font-mono">ctx.get("api_key")</code> 取。
        {eff?.stored_key ? <> 当前配置存储里已有值：<code className="font-mono">{revealed ? eff.stored_key : eff.stored_masked}</code>。</> : null}
      </div>

      {/* ── 隐式配置：代码里写死的那一侧（只列 接口地址 + API Key） ── */}
      {hasImplicit && (
        <div className="mt-3 border-t border-border/70 pt-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <FileCode2 className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[11.5px] font-bold text-[color:var(--color-text-main)]">代码里写死的配置</span>
            <span className="text-[10px] text-gray-500">识别自源码，只读</span>
            {keyRow && (
              <button
                onClick={() => setRevealed((v) => !v)}
                className="px-2 py-0.5 rounded-lg bg-surface text-[10.5px] text-gray-400 hover:text-white"
              >
                {revealed ? '隐藏密钥' : '显示密钥'}
              </button>
            )}
            {eff?.inline_key && (
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => migrate(false)} disabled={migrating}
                  className="px-2 py-0.5 rounded-lg bg-surface text-[10.5px] text-gray-300 hover:text-white disabled:opacity-40"
                >
                  只写入配置存储
                </button>
                <button
                  onClick={() => migrate(true)} disabled={migrating}
                  className="px-2 py-0.5 rounded-lg bg-brand/15 text-[10.5px] text-brand-light hover:bg-brand/25 disabled:opacity-40 flex items-center gap-1"
                >
                  {migrating ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
                  迁移并改写代码
                </button>
              </span>
            )}
          </div>

          <div className="mt-2 space-y-1">
            {urlRows.map((c, i) => (
              <div key={`url-${i}`} className="flex items-center gap-2 flex-wrap text-[11px]">
                <span className="text-gray-500 w-[58px] shrink-0">接口地址</span>
                <code className="font-mono break-all text-sky-300">{c.value}</code>
                <span className="text-[9.5px] text-gray-600">{c.name} · 第 {c.line} 行</span>
              </div>
            ))}
            {keyRow && (
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                <span className="text-gray-500 w-[58px] shrink-0">API Key</span>
                <code className="font-mono break-all text-amber-300">{revealed ? keyRow.value : keyRow.masked}</code>
                <span className="text-[9.5px] text-gray-600">
                  {keyRow.name}{keyRow.line ? ` · 第 ${keyRow.line} 行` : ''}
                </span>
              </div>
            )}
          </div>

          {eff?.inline_key && (eff?.reads_ctx_key ? (
            <div className="mt-2 text-[10.5px] text-emerald-300/90 leading-relaxed">
              代码会读注入的 Key（<code className="font-mono">ctx["api_key"]</code> /
              <code className="font-mono">api.get("get_api_key")</code>）——
              在设置页填的 Key <b>即刻生效</b>，代码里那句仅是兜底。
            </div>
          ) : (
            <div className="mt-2 flex items-start gap-1.5 text-[10.5px] text-amber-200 leading-relaxed">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" />
              <span>
                代码没读注入的 Key（<code className="font-mono">ctx["api_key"]</code> /
                <code className="font-mono">api.get("get_api_key")</code>），只认自己写死的那句 ——
                <b>在设置页填的 Key 不会生效</b>，当前仍用代码里那句明文。要换 Key 请点「迁移并改写代码」。
              </span>
            </div>
          ))}

        </div>
      )}

      {!eff && (
        <div className="mt-2 text-[10.5px] text-gray-500">
          没读到源码里的隐式配置（接口不可用，或该源确实没把 Key / 地址写死在代码里）。
        </div>
      )}
    </div>
  );
};

const FieldRow: React.FC<{
  field: CapField;
  /** datalist 的 id 前缀（必须全页唯一，用 通道id:键名） */
  listId: string;
  value: string;
  revealed: boolean;
  onReveal: () => void;
  onChange: (v: string) => void;
}> = ({ field, listId, value, revealed, onReveal, onChange }) => {
  const secret = field.kind === 'secret';
  const opts = field.options || [];

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
            list={opts.length ? `${listId}__opts` : undefined}
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
          {opts.length > 0 && (
            <datalist id={`${listId}__opts`}>
              {opts.map((o) => <option key={o} value={o} />)}
            </datalist>
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
          {opts.length > 0 && (
            <>
              <span className="text-[10px] text-gray-600">官方档</span>
              {opts.map((o) => (
                <button
                  key={o} type="button" onClick={() => onChange(o)} title="点一下填入这个模型名"
                  className={`px-2 py-0.5 rounded-lg border text-[10.5px] font-mono ${
                    value === o
                      ? 'bg-brand/20 border-brand/50 text-brand-light'
                      : 'bg-surface-secondary border-border text-gray-400 hover:text-white'
                  }`}
                >
                  {o}
                </button>
              ))}
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
