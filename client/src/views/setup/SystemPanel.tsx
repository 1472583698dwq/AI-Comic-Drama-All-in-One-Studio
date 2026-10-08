import React, { useEffect, useState } from 'react';
import {
  ShieldAlert, Activity, Copy, Check, Loader2, FolderOpen,
  Terminal, Lock, RefreshCw,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';
import { API_ORIGIN } from '../../utils/devOrigin';
import { resetContextTips } from '../../utils/guideFlags';
import { LogViewer } from './LogViewer';

/** 只能改 .env 的 Agent / 任务中心参数：界面里改不了，但至少别再是黑盒 */
const ENV_ONLY: Array<{ key: string; def: string; desc: string }> = [
  { key: 'AGENT_ENGINE',             def: 'v2',    desc: '导演 Agent 内核。出问题可设 v1 回退旧 LangChain 引擎' },
  { key: 'AGENT_MAX_ITERATIONS',     def: '200',   desc: '单次任务的轮次安全上限，防死循环' },
  { key: 'AGENT_LLM_TIMEOUT',        def: '600',   desc: '单次模型调用超时（秒）' },
  { key: 'AGENT_LLM_RETRIES',        def: '2',     desc: '模型调用失败重试次数' },
  { key: 'AGENT_MAX_TOKENS',         def: '32768', desc: '单次回复最大输出 token（含思考 tokens，长思考被截断就调大）' },
  { key: 'AGENT_TOOL_TIMEOUT_S',     def: '900',   desc: '单个工具执行超时（秒），视频类固定 1800' },
  { key: 'AGENT_APPROVAL_TIMEOUT',   def: '120',   desc: '破坏性工具等你点头的超时（秒），超时按拒绝' },
  { key: 'AGENT_CONTEXT_WINDOW',     def: '800000', desc: '上下文窗口（token）；达到窗口 80%（默认约 64 万 token）才触发压缩' },
  { key: 'AGENT_COMPACT_KEEP_RATIO', def: '0.2',   desc: '压缩时保留的比例' },
  { key: 'AGENT_MAX_JOBS',           def: '4',     desc: '后台任务并发上限' },
  { key: 'AGENT_SUBAGENT_MAX_DEPTH', def: '1',     desc: '子代理委派深度' },
  { key: 'AGENT_SUBAGENT_TIMEOUT',   def: '600',   desc: '子代理超时（秒）' },
  { key: 'AGENT_VIDEO_WAIT_S',       def: '1200',  desc: '视频工具默认阻塞等成片的时长（秒）' },
  { key: 'STUDIO_TASK_POLL_INTERVAL', def: '5',    desc: '异步任务轮询间隔（秒）' },
  { key: 'STUDIO_TASK_TIMEOUT',      def: '1500',  desc: '异步任务总超时（秒）' },
];

/** 与后端 /config/test 支持的 target 对齐 */
const TEST_TARGETS: Array<{ k: string; label: string }> = [
  { k: 'openai', label: '文本大模型' },
  { k: 'responses_api', label: 'Responses API' },
  { k: 'minimax', label: 'MiniMax' },
  { k: 'comfyui', label: 'ComfyUI' },
  { k: 'siliconflow', label: '硅基流动' },
  { k: 'dashscope', label: '通义万相' },
  { k: 'openai_image', label: 'OpenAI 生图' },
  { k: 'kling', label: '可灵 Kling' },
  { k: 'minimax_h3', label: 'MiniMax H3' },
  { k: 'seedance', label: 'Seedance' },
  { k: 'wan3', label: '万相 Wan3.0' },
  { k: 'elevenlabs', label: 'ElevenLabs' },
  { k: 'cosyvoice', label: 'CosyVoice' },
  { k: 'gpt_sovits', label: 'GPT-SoVITS' },
  { k: 'indextts', label: 'IndexTTS' },
  { k: 'jianyin', label: '剪映目录' },
];

interface Props {
  cfg: Record<string, string>;
  draft: Record<string, string>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  envFile: string;
  jsonFile: string;
}

const val = (draft: Record<string, string>, cfg: Record<string, string>, k: string) =>
  draft[k] !== undefined ? draft[k] : (cfg[k] || '');

export const SystemPanel: React.FC<Props> = ({ cfg, draft, setDraft, envFile, jsonFile }) => {
  const [health, setHealth] = useState<any>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedHealth, setCopiedHealth] = useState(false);
  const [allTests, setAllTests] = useState<Record<string, { running?: boolean; ok?: boolean; detail?: string }>>({});
  const [testingAll, setTestingAll] = useState(false);

  const merged = { ...cfg, ...draft };

  /** 逐个跑一遍所有通道的连通测试，一眼看出哪条通、哪条没通 */
  const runAllTests = async () => {
    setTestingAll(true);
    setAllTests(Object.fromEntries(TEST_TARGETS.map((t) => [t.k, { running: true }])));
    for (const t of TEST_TARGETS) {
      try {
        const r = await apiService.testConfig(t.k as any, merged);
        setAllTests((s0) => ({ ...s0, [t.k]: { ok: !!r?.ok, detail: r?.detail || '' } }));
      } catch (e: any) {
        setAllTests((s0) => ({ ...s0, [t.k]: { ok: false, detail: e?.message || '失败' } }));
      }
    }
    setTestingAll(false);
  };

  const copyText = async (text: string, mark: (v: boolean) => void) => {
    try { await navigator.clipboard.writeText(text); mark(true); setTimeout(() => mark(false), 1800); }
    catch { toast.error('复制失败，请手动选中'); }
  };

  const trusted = ['1', 'true', 'yes', 'on'].includes(String(val(draft, cfg, 'STUDIO_TRUSTED_MODE')).toLowerCase());

  const fetchHealth = async () => {
    setLoadingHealth(true);
    try {
      const r = await fetch(`${API_ORIGIN}/api/v1/health`).then((x) => x.json());
      setHealth(r);
    } catch (e: any) {
      setHealth({ status: 'error', error: e?.message });
    } finally { setLoadingHealth(false); }
  };
  useEffect(() => { fetchHealth(); }, []);

  const copyEnvBlock = async () => {
    const text = ENV_ONLY.map((e) => `${e.key}=${e.def}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { toast.error('复制失败，请手动选中'); }
  };

  return (
    <div className="space-y-5">
      {/* ── 安全总闸 ── */}
      <section className={`rounded-2xl border overflow-hidden ${trusted ? 'border-red-500/50 bg-red-500/[0.04]' : 'border-white/70 dark:border-white/12 bg-surface/80'}`}>
        <div className="px-5 pt-4 pb-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2">
          <ShieldAlert className={`w-4 h-4 ${trusted ? 'text-red-400' : 'text-amber-400'}`} />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">可信模式总闸</h3>
          <span className="ml-auto text-[10.5px] font-mono text-gray-500">STUDIO_TRUSTED_MODE</span>
        </div>
        <div className="p-5 pt-4">
          <div className="flex items-start gap-3">
            <button
              onClick={() => setDraft((d) => ({ ...d, STUDIO_TRUSTED_MODE: trusted ? '0' : '1' }))}
              className={`shrink-0 w-11 h-6 rounded-full border transition-colors relative ${
                trusted ? 'bg-red-500/70 border-red-400' : 'bg-surface-hover/80 border-white/70 dark:border-white/12'
              }`}
              role="switch" aria-checked={trusted}
            >
              <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full bg-white transition-all ${trusted ? 'left-[22px]' : 'left-0.5'}`}
                style={{ width: 18, height: 18 }} />
            </button>
            <div className="text-[11.5px] leading-relaxed">
              <div className="text-[color:var(--color-text-main)] font-semibold mb-1">
                {trusted ? '已开启 —— 自定义代码可以跳出沙箱' : '已关闭（推荐）'}
              </div>
              <p className="text-gray-400">
                开启后，标了 <code className="font-mono text-[10.5px]">trusted</code> 的自定义生成源会跳出受限沙箱，
                AI 导演的 <code className="font-mono text-[10.5px]">shell_exec</code> / <code className="font-mono text-[10.5px]">fs_file</code> 两个工具同时生效
                —— 等于允许在你这台机器上执行任意代码。
              </p>
              <p className="text-amber-300 mt-1.5">
                开之前先把要用的自定义源代码读一遍，尤其是从插件包带进来的。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Agent 内核：只读 ── */}
      <section className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2 flex-wrap">
          <Terminal className="w-4 h-4 text-sky-400" />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">Agent 与任务中心参数</h3>
          <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 font-bold flex items-center gap-1">
            <Lock className="w-2.5 h-2.5" />只能改 .env
          </span>
          <button onClick={copyEnvBlock}
            className="ml-auto px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? '已复制' : '复制默认值'}
          </button>
        </div>
        <div className="p-5 pt-3.5">
          <p className="text-[11.5px] text-gray-400 leading-relaxed mb-3">
            这 15 个参数<b className="text-[color:var(--color-text-main)]">不走配置中心</b>，只读环境变量，
            改完必须<b className="text-[color:var(--color-text-main)]">重启后端</b>才生效。
            下面列的是代码里的默认值——没在 <code className="font-mono text-[10.5px]">.env</code> 里写就是这些。
          </p>
          <div className="rounded-xl border border-white/70 dark:border-white/12 overflow-hidden">
            {ENV_ONLY.map((e, i) => (
              <div key={e.key} className={`px-3.5 py-2 flex items-baseline gap-3 flex-wrap ${i % 2 ? 'bg-surface/80' : 'bg-surface-secondary/20'}`}>
                <code className="font-mono text-[11px] text-[color:var(--color-text-main)] shrink-0">{e.key}</code>
                <code className="font-mono text-[11px] text-brand-light shrink-0">{e.def}</code>
                <span className="text-[11px] text-gray-500 flex-1 min-w-[160px]">{e.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 诊断 ── */}
      <section className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">运行状态</h3>
          <button onClick={fetchHealth} disabled={loadingHealth}
            className="ml-auto px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white flex items-center gap-1 disabled:opacity-40">
            {loadingHealth ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}刷新
          </button>
        </div>
        <div className="p-5 pt-4 space-y-2.5">
          <KV label="后端" value={health?.status === 'healthy' ? '正常' : (health?.status || '读取中…')}
            ok={health?.status === 'healthy'} />
          <KV label="文本大模型" value={health?.openai_configured ? '已配置' : '未配置'} ok={!!health?.openai_configured} />
          <KV label="ComfyUI" value={health?.comfyui_online ? '在线' : '未连接（用云端源时可忽略）'} ok={!!health?.comfyui_online} neutral={!health?.comfyui_online} />
          <KV label="已注册生成源"
            value={`图 ${health?.providers?.image_count ?? '—'} · 视 ${health?.providers?.video_count ?? '—'} · 音 ${health?.providers?.audio_count ?? '—'}`} neutral />
          <div className="pt-1.5">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <button onClick={runAllTests} disabled={testingAll}
                className="px-3 py-1.5 rounded-xl bg-brand text-white text-[11px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5">
                {testingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                {testingAll ? '逐个测试中…' : '一键测试全部通道'}
              </button>
              <button onClick={() => copyText(JSON.stringify(health, null, 2), setCopiedHealth)}
                className="px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white flex items-center gap-1">
                {copiedHealth ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copiedHealth ? '已复制' : '复制健康 JSON'}
              </button>
            </div>
            {Object.keys(allTests).length > 0 && (
              <div className="rounded-xl border border-white/70 dark:border-white/12 overflow-hidden mb-2">
                {TEST_TARGETS.map((t) => {
                  const r = allTests[t.k];
                  if (!r) return null;
                  return (
                    <div key={t.k} className="px-3 py-1.5 flex items-baseline gap-2 border-b border-white/50 dark:border-white/10 last:border-b-0">
                      <span className="text-[11px] text-gray-300 w-24 shrink-0">{t.label}</span>
                      <span className={`text-[11px] shrink-0 ${r.running ? 'text-gray-500' : r.ok ? 'text-emerald-400' : 'text-amber-300'}`}>
                        {r.running ? '测试中' : r.ok ? '通' : '未通'}
                      </span>
                      <span className="text-[10.5px] text-gray-500 flex-1 min-w-0 truncate">{r.detail || ''}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="pt-1 flex flex-wrap gap-2">
            <a href={`${API_ORIGIN}/docs`} target="_blank" rel="noreferrer"
              className="px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white">
              打开接口文档 /docs
            </a>
            <button onClick={() => window.dispatchEvent(new Event('open-first-run-wizard'))}
              className="px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-brand-light hover:text-white">
              重新运行安装向导
            </button>
            <button onClick={() => { resetContextTips(); toast.success('已重置：下次进入画布 / 分镜台会重新显示新手提示'); }}
              className="px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] text-gray-300 hover:text-white">
              重置新手提示
            </button>
          </div>
        </div>
      </section>

      {/* ── 数据位置 ── */}
      <section className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-white/60 dark:border-white/12 flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-bold text-[color:var(--color-text-main)]">配置与数据存在哪</h3>
        </div>
        <div className="p-5 pt-4 space-y-2">
          <FileRow label="配置正本" path={envFile || '（尚未写入）'} />
          <FileRow label="配置热备份" path={jsonFile || 'storage/config_store.json'} />
          <FileRow label="项目 / 素材 / 生成结果" path="storage/" />
          <FileRow label="导出的剪映草稿" path="exports/" />

          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-[11px] text-amber-200 leading-relaxed">
              <b>API Key 是明文双写的。</b>你在这里填的每个 Key 会同时写进上面两个文件，
              而且 <code className="font-mono">.env</code> 是「探测到几个路径就写几份」。
              拷贝或分享这个目录前，先把这两处清掉。
            </div>
          </div>
        </div>
      </section>

      {/* 日志（调试）：实时尾部 / 级别切换 / 下载 / 前端错误回传 */}
      <LogViewer />
    </div>
  );
};

const KV: React.FC<{ label: string; value: string; ok?: boolean; neutral?: boolean }> = ({ label, value, ok, neutral }) => (
  <div className="flex items-center gap-3 text-[11.5px]">
    <span className="text-gray-500 w-28 shrink-0">{label}</span>
    <span className={neutral ? 'text-gray-400' : ok ? 'text-emerald-400' : 'text-amber-300'}>{value}</span>
  </div>
);

const FileRow: React.FC<{ label: string; path: string }> = ({ label, path }) => (
  <div className="flex items-baseline gap-3 text-[11.5px] flex-wrap">
    <span className="text-gray-500 w-32 shrink-0">{label}</span>
    <code className="font-mono text-[11px] text-gray-300 break-all">{path}</code>
  </div>
);
