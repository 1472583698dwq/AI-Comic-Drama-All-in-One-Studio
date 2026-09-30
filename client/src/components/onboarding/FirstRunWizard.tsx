import React, { useEffect, useState } from 'react';
import { Rocket, Cpu, Image as ImageIcon, Mic, Video, Check, X, Loader2, Sparkles, ChevronRight, ShieldCheck } from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';

type Step = 'welcome' | 'llm' | 'image' | 'extra' | 'done';

interface Field { key: string; label: string; password?: boolean; placeholder?: string; default?: string }
interface Preset { id: string; label: string; hint?: string; fields: Field[]; set: Record<string, string>; testTarget?: any; testProvider?: string }

const LLM_PRESETS: Preset[] = [
  {
    id: 'minimax', label: 'MiniMax（推荐 · 一个 Key 通吃 文本/配音/视频）',
    hint: '填 MiniMax 按量 Key，文本理解之外还能启用配音与视频',
    fields: [{ key: 'MINIMAX_API_KEY', label: 'MINIMAX_API_KEY', password: true, placeholder: 'MiniMax 按量 API Key' }],
    set: { LLM_PROVIDER: 'minimax' }, testTarget: 'minimax',
  },
  {
    id: 'deepseek', label: 'DeepSeek',
    fields: [
      { key: 'OPENAI_API_KEY', label: 'API Key', password: true, placeholder: 'sk-...' },
      { key: 'OPENAI_BASE_URL', label: '接口地址', default: 'https://api.deepseek.com/v1' },
      { key: 'OPENAI_MODEL', label: '模型', default: 'deepseek-chat' },
    ],
    set: { LLM_PROVIDER: 'openai_compatible' }, testTarget: 'deepseek',
  },
  {
    id: 'qwen', label: '通义千问（DashScope）',
    fields: [
      { key: 'OPENAI_API_KEY', label: 'DashScope Key', password: true, placeholder: 'sk-...' },
      { key: 'OPENAI_BASE_URL', label: '接口地址', default: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { key: 'OPENAI_MODEL', label: '模型', default: 'qwen-plus' },
    ],
    set: { LLM_PROVIDER: 'openai_compatible' }, testTarget: 'qwen',
  },
  {
    id: 'siliconflow', label: '硅基流动（文本+图像同 Key）',
    fields: [
      { key: 'OPENAI_API_KEY', label: 'SiliconFlow Key', password: true, placeholder: 'sk-...' },
      { key: 'OPENAI_BASE_URL', label: '接口地址', default: 'https://api.siliconflow.cn/v1' },
      { key: 'OPENAI_MODEL', label: '模型', default: 'Qwen/Qwen2.5-7B-Instruct' },
    ],
    set: { LLM_PROVIDER: 'openai_compatible' }, testTarget: 'openai',
  },
];

const IMAGE_PRESETS: Preset[] = [
  {
    id: 'siliconflow', label: '硅基流动 SiliconFlow',
    fields: [{ key: 'SILICONFLOW_API_KEY', label: 'SiliconFlow API Key', password: true, placeholder: 'sk-...' }],
    set: { IMAGE_PROVIDER: 'siliconflow' }, testProvider: 'siliconflow',
  },
  {
    id: 'dashscope', label: '通义万相 DashScope',
    fields: [{ key: 'DASHSCOPE_API_KEY', label: 'DashScope API Key', password: true, placeholder: 'sk-...' }],
    set: { IMAGE_PROVIDER: 'dashscope' }, testProvider: 'dashscope',
  },
];

const EXTRA_PRESETS: Array<Preset & { kind: 'video' | 'audio' }> = [
  {
    id: 'minimax', kind: 'audio', label: 'MiniMax 配音',
    fields: [{ key: 'MINIMAX_API_KEY', label: 'MINIMAX_API_KEY', password: true, placeholder: '复用第 1 步的 MiniMax Key' }],
    set: { TTS_PROVIDER: 'minimax' }, testProvider: 'minimax',
  },
  {
    id: 'minimax_h3', kind: 'video', label: 'MiniMax H3 视频',
    fields: [{ key: 'MINIMAX_API_KEY', label: 'MINIMAX_API_KEY', password: true, placeholder: '复用第 1 步的 MiniMax Key' }],
    set: { VIDEO_PROVIDER: 'minimax_h3' }, testProvider: 'minimax_h3',
  },
  {
    id: 'kling', kind: 'video', label: '可灵 Kling 视频',
    fields: [{ key: 'KLING_API_KEY', label: 'KLING_API_KEY', password: true, placeholder: 'Kling Bearer Key' }],
    set: { VIDEO_PROVIDER: 'kling' }, testProvider: 'kling',
  },
  {
    id: 'elevenlabs', kind: 'audio', label: 'ElevenLabs 配音',
    fields: [{ key: 'ELEVENLABS_API_KEY', label: 'ELEVENLABS_API_KEY', password: true, placeholder: 'xi-...' }],
    set: { TTS_PROVIDER: 'elevenlabs' }, testProvider: 'elevenlabs',
  },
];

const STEP_TITLES: Record<Step, string> = {
  welcome: '欢迎使用 AI 漫剧 Studio',
  llm: '第 1 步 · 文本理解（拆解小说 → 分镜）',
  image: '第 2 步 · 图像生成（生成分镜画面）',
  extra: '第 3 步 · 配音与视频（可选，建议开启）',
  done: '完成',
};

/**
 * 首次启动安装向导：引导填写关键 Key 并测试联通，完成后即可拥有完整功能。
 * 通过 window 事件 'open-first-run-wizard' 可随时重新打开。
 */
export const FirstRunWizard: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('welcome');
  const [status, setStatus] = useState<any>(null);
  const [presetId, setPresetId] = useState<string>('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const refreshStatus = async () => {
    try { setStatus(await apiService.setupStatus()); } catch { /* ignore */ }
  };

  const openWizard = () => { setStep('welcome'); setResult(null); setPresetId(''); setValues({}); setOpen(true); };

  useEffect(() => {
    // 事件入口：设置 → 系统 随时重开
    const h = () => openWizard();
    window.addEventListener('open-first-run-wizard', h as any);
    // 首启自动弹出：仅当「未完成引导 + 基础能力未就绪」（已就绪/已跳过均不打扰，且同会话只弹一次）
    (async () => {
      try {
        const s = await apiService.setupStatus();
        setStatus(s);
        if (!s?.onboarding_done && !s?.minimal_ready && !sessionStorage.getItem('wizard_auto_shown')) {
          sessionStorage.setItem('wizard_auto_shown', '1');
          openWizard();
        }
      } catch { /* 后端未起则静默，不挡启动 */ }
    })();
    return () => window.removeEventListener('open-first-run-wizard', h as any);
  }, []);

  // 每次打开都拉取真实就绪状态（此前只在保存成功后拉，导致头部 chips 恒为未就绪）
  useEffect(() => { if (open) refreshStatus(); }, [open]);

  // Esc / 点遮罩 / 点 X = 跳过：标记已完成，之后不再自动打扰（设置里可随时重开）
  const skip = async () => {
    try { await apiService.setupComplete(true); } catch { /* ignore */ }
    setOpen(false);
    toast.info('已跳过 · 可在 设置 → 系统 随时重新打开向导');
  };
  useEscapeClose(open, skip);
  if (!open) return null;

  const currentList = step === 'llm' ? LLM_PRESETS : step === 'image' ? IMAGE_PRESETS : step === 'extra' ? (EXTRA_PRESETS as any) : [];
  const preset: Preset | undefined = currentList.find((p: Preset) => p.id === presetId);

  const pickPreset = (p: Preset) => {
    setPresetId(p.id);
    const init: Record<string, string> = {};
    for (const f of p.fields) { const v = values[f.key]; init[f.key] = v ?? f.default ?? ''; }
    setValues((prev) => ({ ...prev, ...init }));
    setResult(null);
  };

  const setVal = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));

  const saveAndTest = async () => {
    if (!preset) return;
    // 校验必填（未给 default 的字段）
    const missing = preset.fields.filter((f) => !f.default && !String(values[f.key] ?? '').trim());
    if (missing.length) { setResult({ ok: false, detail: `请填写：${missing.map((m) => m.label).join('、')}` }); return; }
    setBusy(true); setResult(null);
    try {
      await apiService.saveConfig({ ...values, ...preset.set });
      let r: any;
      if (preset.testProvider) {
        r = await apiService.testProvider(preset.testProvider);
        window.dispatchEvent(new Event('provider-list-refresh'));
      } else {
        r = await apiService.testConfig(preset.testTarget, values);
      }
      const ok = !!r?.ok;
      setResult({ ok, detail: r?.detail || (ok ? '连通正常' : '测试未通过') });
      if (ok) {
        toast.success(`${preset.label} 已就绪`);
        await refreshStatus();
      }
    } catch (e: any) {
      setResult({ ok: false, detail: e?.message || '保存/测试失败' });
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    try { await apiService.setupComplete(true); } catch { /* ignore */ }
    setOpen(false);
    toast.success('初始化完成，开始创作吧！');
  };

  const goStep = (s: Step) => {
    setStep(s); setResult(null);
    if (s === 'welcome' || s === 'done') {
      setPresetId('');
    } else if (s === 'llm' && !presetId) {
      // 首次进入第 1 步才预选推荐项：MiniMax 一个 Key 打通 文本/配音/视频（来回切换不重置已选厂商）
      setPresetId('minimax');
      const init: Record<string, string> = {};
      for (const f of LLM_PRESETS[0].fields) init[f.key] = values[f.key] ?? f.default ?? '';
      setValues((prev) => ({ ...prev, ...init }));
    }
    if (s === 'done') refreshStatus(); // 完成页展示的是此刻真实状态
  };

  const renderField = (f: Field) => (
    <label key={f.key} className="block">
      <span className="text-[11px] text-gray-400">{f.label}</span>
      <input
        type={f.password ? 'password' : 'text'}
        value={values[f.key] ?? f.default ?? ''}
        onChange={(e) => setVal(f.key, e.target.value)}
        placeholder={f.placeholder || ''}
        className="mt-1 w-full bg-white/55 dark:bg-white/[.06] border border-white/80 dark:border-white/20 rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-brand"
      />
    </label>
  );

  const statusChip = (label: string, ready: boolean) => (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${ready ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 text-gray-500'}`}>
      {ready ? '✓ ' : '○ '}{label}
    </span>
  );

  // 主按钮动态标签：本步测通过 = 下一步；没配 = 明示可跳过（跳过不藏在心里）
  const stepTested = !!(preset && result?.ok);
  const nextLabel = stepTested
    ? (step === 'extra' ? '完成' : '下一步')
    : (step === 'extra' ? '完成（跳过本步）' : '下一步（跳过本步）');

  return (
    <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={skip}>
      <div className="w-full max-w-2xl max-h-[88vh] bg-white/60 dark:bg-white/[.05] rounded-2xl border border-white/70 dark:border-white/12 flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="h-12 px-4 border-b border-white/70 dark:border-white/12 flex items-center justify-between shrink-0 bg-white/55 dark:bg-white/[.06]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-brand to-brand-blue flex items-center justify-center"><Rocket className="w-4 h-4 text-white" /></div>
            <span className="text-sm font-bold text-white">安装向导</span>
            {status && <span className="text-[10px] text-gray-500">· {status.llm?.ready ? '文本✓' : '文本○'} {status.image?.ready ? '图像✓' : '图像○'} {status.video?.ready ? '视频✓' : '视频○'} {status.audio?.ready ? '配音✓' : '配音○'}</span>}
          </div>
          <button onClick={skip} title="跳过（可随时在 设置 → 系统 重开）" className="p-1 rounded hover:bg-white/55 dark:bg-white/[.06]"><X className="w-4 h-4 text-zinc-400" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="text-xs font-bold text-white">{STEP_TITLES[step]}</div>

          {step === 'welcome' && (
            <div className="space-y-3">
              <div className="text-[12.5px] text-gray-300 leading-5">
                <b className="text-white">AI 漫剧 Studio</b>：粘贴小说章节 → AI 拆分镜 → 生成画面 / 配音 / 视频 → 一键导出剪映成片。
              </div>
              <div className="text-[12px] text-gray-400 leading-5">
                开工前只需 2 分钟：填好 Key 并<b className="text-gray-200">测试联通</b>。没配通的能力不会出现在工作台，避免你点了却报错。
                <span className="text-emerald-300/90"> 推荐 MiniMax：一个 Key 打通 文本 + 配音 + 视频，第 1 步已为你选好。</span>
              </div>
              {status && (
                <div className="flex flex-wrap gap-1.5">
                  {statusChip('文本理解', !!status.llm?.ready)}
                  {statusChip('图像生成', !!status.image?.ready)}
                  {statusChip('视频', !!status.video?.ready)}
                  {statusChip('配音', !!status.audio?.ready)}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  { icon: Cpu, t: '文本理解', d: '把小说拆成分镜（必需）' },
                  { icon: ImageIcon, t: '图像生成', d: '生成分镜画面（必需）' },
                  { icon: Mic, t: '配音', d: '角色台词配音（可选）' },
                  { icon: Video, t: '视频', d: '图生视频 / 运镜（可选）' },
                ].map((c) => { const I = c.icon; return (
                  <div key={c.t} className="flex items-center gap-2.5 p-3 rounded-xl bg-white/55 dark:bg-white/[.05] border border-white/70 dark:border-white/12">
                    <div className="w-8 h-8 rounded-lg bg-brand/15 border border-brand/30 flex items-center justify-center"><I className="w-4 h-4 text-brand-light" /></div>
                    <div><div className="text-xs font-bold text-white">{c.t}</div><div className="text-[10px] text-gray-500">{c.d}</div></div>
                  </div>
                ); })}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-500"><ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />仅保存在本机 .env，不会上传。</div>
            </div>
          )}

          {(step === 'llm' || step === 'image' || step === 'extra') && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {currentList.map((p: Preset) => (
                  <button key={p.id} onClick={() => pickPreset(p)}
                    className={`text-left p-3 rounded-xl border transition-all ${presetId === p.id ? 'bg-brand/15 border-brand ring-1 ring-brand/30' : 'bg-white/55 dark:bg-white/[.06] border-white/70 dark:border-white/12 hover:border-brand/50'}`}>
                    <div className="text-xs font-bold text-white">{p.label}</div>
                    {p.hint && <div className="text-[10px] text-gray-500 mt-0.5">{p.hint}</div>}
                  </button>
                ))}
              </div>
              {preset && (
                <div className="p-3 rounded-xl bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 space-y-2.5">
                  {preset.fields.map(renderField)}
                  {result && (
                    <div className={`text-[11px] px-2.5 py-1.5 rounded-lg border ${result.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
                      {result.ok ? '✓ ' : '✗ '}{result.detail}
                    </div>
                  )}
                  <button onClick={saveAndTest} disabled={busy}
                    className="w-full py-2 rounded-xl bg-brand hover:opacity-90 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5">
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    {busy ? '保存并测试中…' : '保存并测试联通'}
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {status && <>
                  {statusChip('文本理解', !!status.llm?.ready)}
                  {statusChip('图像生成', !!status.image?.ready)}
                  {statusChip('视频', !!status.video?.ready)}
                  {statusChip('配音', !!status.audio?.ready)}
                </>}
              </div>
              <div className="text-[12px] text-gray-400 leading-5">
                {status?.minimal_ready
                  ? '基础能力已就绪，可以开始拆解小说并生成分镜了。'
                  : '还缺「文本理解」或「图像生成」——暂时出不了画面，可先完成，稍后到 设置 → 能力配置 补齐。'}
                {status?.full_ready ? ' 视频与配音也已开启，功能完整。' : ' 视频/配音未开启时可随时在 设置 → 生成源 里配置。'}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-white/70 dark:border-white/12 flex items-center justify-between shrink-0 bg-white/55 dark:bg-white/[.06]">
          <button onClick={skip} title="跳过配置，之后可在 设置 → 系统 重新打开" className="px-3 py-1.5 rounded-xl text-xs text-gray-400 hover:text-white">稍后再说</button>
          <div className="flex items-center gap-2">
            {step !== 'welcome' && step !== 'done' && (
              <button onClick={() => goStep(step === 'extra' ? 'done' : step === 'image' ? 'extra' : 'image')} className="px-3 py-1.5 rounded-xl bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-xs text-gray-300">上一步</button>
            )}
            {step !== 'welcome' && step !== 'done' && (
              <button onClick={() => goStep(step === 'extra' ? 'done' : step === 'image' ? 'extra' : 'image')}
                className="px-4 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1">
                {nextLabel} <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
            {step === 'welcome' && <button onClick={() => goStep('llm')} className="px-4 py-1.5 rounded-xl bg-brand text-white text-xs font-bold flex items-center gap-1">开始配置 <ChevronRight className="w-3.5 h-3.5" /></button>}
            {step === 'done' && <button onClick={finish} className="px-5 py-1.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue text-white text-xs font-bold flex items-center gap-1.5"><Check className="w-3.5 h-3.5" />完成并进入工作台</button>}
          </div>
        </div>
      </div>
    </div>
  );
};
