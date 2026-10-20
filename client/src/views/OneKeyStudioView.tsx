// -*- coding: utf-8 -*-
/**
 * 成片工作室 —— 一键成片独立页面。
 *
 * 布局：顶栏（任务/历史）→ 左配置栏 / 中生产看板（状态+计划+分镜/集群/日志标签页）/ 右产物廊。
 * 编排：总导演 Agent 自主编排（不写死步骤）；默认剧组 = 资产复用 + 多参考 r2v + 风格锁定 + 产物验收。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Zap, Loader2, CheckCircle2, AlertTriangle, Bot, Users, History,
  PlusCircle, Layers, Download, Palette, Image as ImageIcon, Music, Film,
  Clapperboard, Sparkles, ScrollText, CircleDot, ChevronDown,
  Play, Camera, Aperture, SlidersHorizontal, Wand2, Timer,
  X, CircleCheck, AudioLines, ListChecks,
} from 'lucide-react';
import { apiService } from '../services/api';
import { resolveMediaUrl } from '../utils/devOrigin';
import { useProjectStore } from '../stores/useProjectStore';
import { autoBindShotCharacters } from '../components/storyboard/shotReference';
import { ProviderPicker } from '../components/ui/ProviderPicker';
import { OneKeySwarmBoard } from '../components/agent/OneKeySwarmBoard';
import { loadRoleMetas } from '../components/agent/swarmMeta';

const TERMINAL = new Set(['success', 'partial', 'failed']);

const PANEL = 'rounded-2xl border border-black/[.06] bg-white/60 backdrop-blur-xl dark:border-white/[.08] dark:bg-white/[.025]';
const MUTED = '[color:var(--color-text-muted)]';
const TEXT = '[color:var(--color-text-main)]';

const stageTone = (stage: string) => {
  if (stage === '错误') return 'text-red-400';
  if (stage === '超时' || stage === '警告') return 'text-amber-400';
  if (stage === '子代理集群') return 'text-violet-400';
  if (stage === '导演计划' || stage === '启动') return 'text-emerald-400';
  if (stage === '预检') return MUTED;
  return 'text-amber-400';
};

const statusMeta = (status: string) => {
  if (status === 'success') return { label: '制作完成', tone: 'text-emerald-400', dot: 'bg-emerald-400', ring: 'emerald' as const };
  if (status === 'partial') return { label: '部分完成', tone: 'text-amber-400', dot: 'bg-amber-400', ring: 'amber' as const };
  if (status === 'failed') return { label: '制作失败', tone: 'text-red-400', dot: 'bg-red-400', ring: 'red' as const };
  if (status === 'queued' || status === 'running') return { label: 'Agent 制作中', tone: 'text-amber-400', dot: 'bg-amber-400 animate-pulse', ring: 'amber' as const };
  return { label: '待发起', tone: MUTED, dot: 'bg-[color:var(--color-text-muted)]', ring: 'amber' as const };
};

const fmtClock = (ms?: number): string => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 小型开关（深/浅色主题通用） */
const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; title?: string }> = ({
  checked, onChange, label, hint, title,
}) => (
  <button
    type="button" title={title}
    onClick={() => onChange(!checked)}
    className="group flex w-full items-center justify-between gap-3 py-2 text-left"
  >
    <span className="min-w-0">
      <span className={`block text-[12px] font-medium ${TEXT} transition-colors group-hover:text-amber-500 dark:group-hover:text-amber-300`}>{label}</span>
      {hint && <span className={`mt-0.5 block truncate text-[10px] ${MUTED}`}>{hint}</span>}
    </span>
    <span className={`relative h-[20px] w-[36px] shrink-0 rounded-full border transition-all ${
      checked
        ? 'border-amber-400/40 bg-amber-400/90 shadow-[0_0_14px_rgba(251,191,36,.35)]'
        : 'border-black/10 bg-black/10 dark:border-white/10 dark:bg-white/10'
    }`}>
      <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-all ${checked ? 'left-[19px]' : 'left-[2px]'}`} />
    </span>
  </button>
);

/** 分区面板 */
const Panel: React.FC<{
  title: string; icon?: React.ReactNode; hint?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
}> = ({ title, icon, hint, right, children, className = '' }) => (
  <section className={`${PANEL} p-3.5 ${className}`}>
    <div className="mb-3 flex items-center gap-2">
      {icon && (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-black/[.06] bg-black/[.03] dark:border-white/[.08] dark:bg-white/[.04]">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className={`text-[12px] font-semibold leading-tight ${TEXT}`}>{title}</div>
        {hint && <div className={`mt-0.5 truncate text-[10px] ${MUTED}`}>{hint}</div>}
      </div>
      <span className="flex-1" />
      {right}
    </div>
    <div className="space-y-3">{children}</div>
  </section>
);

/** 分段标签 */
const SegTabs: React.FC<{
  value: string; onChange: (v: string) => void;
  items: Array<{ id: string; label: string; icon?: React.ReactNode; count?: number }>;
  size?: 'sm' | 'md';
}> = ({ value, onChange, items, size = 'md' }) => (
  <div className="inline-flex items-center gap-0.5 rounded-xl border border-black/[.06] bg-black/[.04] p-0.5 dark:border-white/[.08] dark:bg-black/30">
    {items.map((it) => {
      const active = value === it.id;
      return (
        <button
          key={it.id} type="button" onClick={() => onChange(it.id)}
          className={`inline-flex items-center gap-1.5 rounded-[10px] font-medium transition-all ${
            size === 'sm' ? 'h-7 px-2.5 text-[10.5px]' : 'h-8 px-3 text-[11.5px]'
          } ${
            active
              ? `${TEXT} bg-white shadow-sm dark:bg-white/[.10]`
              : `${MUTED} hover:text-[color:var(--color-text-main)] hover:bg-white/50 dark:hover:bg-white/[.05]`
          }`}
        >
          {it.icon}{it.label}
          {typeof it.count === 'number' && it.count > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] ${active ? 'bg-amber-400/15 text-amber-600 dark:text-amber-300' : 'bg-black/[.05] dark:bg-white/[.06]'}`}>{it.count}</span>
          )}
        </button>
      );
    })}
  </div>
);

/** 进度环 */
const ProgressRing: React.FC<{ value: number; tone?: 'amber' | 'emerald' | 'red'; size?: number }> = ({ value, tone = 'amber', size = 66 }) => {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const stroke = tone === 'emerald' ? '#34d399' : tone === 'red' ? '#f87171' : '#fbbf24';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="5" stroke="currentColor" className="text-black/[.06] dark:text-white/[.08]" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={stroke} strokeWidth="5"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`font-mono text-[16px] font-bold leading-none ${TEXT}`}>
          {pct}<span className="ml-0.5 text-[9px] opacity-40">%</span>
        </span>
      </div>
    </div>
  );
};

/** KPI 卡 */
const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: React.ReactNode; total?: React.ReactNode; accent: string }> = ({
  icon, label, value, total, accent,
}) => (
  <div className="flex items-center gap-2.5 rounded-xl border border-black/[.05] bg-white/50 px-3 py-2 dark:border-white/[.06] dark:bg-white/[.03]">
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${accent}`}>{icon}</span>
    <div className="min-w-0">
      <div className={`font-mono text-[13px] font-bold leading-none ${TEXT}`}>
        {value}{total !== undefined && <span className="text-[10px] font-normal opacity-40">/{total}</span>}
      </div>
      <div className={`mt-1 text-[9.5px] ${MUTED}`}>{label}</div>
    </div>
  </div>
);

/** 分镜缩略卡 */
const ShotCard: React.FC<{ shot: any; onOpen: () => void }> = ({ shot, onOpen }) => {
  const video = !!shot?.video_url;
  const image = shot?.image_url || '';
  const audio = !!shot?.audio_url;
  const dur = Number(shot?.duration || 0);
  return (
    <button
      type="button" onClick={onOpen}
      className="group relative aspect-[3/4] overflow-hidden rounded-xl border border-black/[.07] bg-black/[.03] text-left transition-all hover:border-amber-400/50 hover:shadow-[0_12px_30px_-12px_rgba(251,191,36,.35)] dark:border-white/[.08] dark:bg-white/[.03]"
    >
      {video ? (
        <video src={resolveMediaUrl(shot.video_url)} muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]" />
      ) : image ? (
        <img src={resolveMediaUrl(image)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]" />
      ) : (
        <span className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 ${MUTED}`}>
          <Film className="h-5 w-5 opacity-40" />
          <span className="text-[9px]">待生成</span>
        </span>
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
      <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white/90 backdrop-blur-sm">
        #{shot?.shot_index ?? '—'}
      </span>
      <span className={`absolute right-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[8.5px] font-semibold backdrop-blur-sm ${
        video ? 'bg-emerald-500/85 text-white' : image ? 'bg-sky-500/85 text-white' : 'bg-black/45 text-white/60'
      }`}>
        {video ? '成片' : image ? '画面' : '待生成'}
      </span>
      {video && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white opacity-0 backdrop-blur-md transition-all duration-300 group-hover:opacity-100">
            <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
          </span>
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 p-2">
        <span className="line-clamp-2 text-[9.5px] leading-snug text-white/85">{shot?.action_desc || shot?.video_prompt || '待生成画面'}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {dur > 0 && <span className="inline-flex items-center gap-0.5 rounded bg-white/10 px-1 py-0.5 text-[8px] text-white/75"><Timer className="h-2 w-2" />{dur}s</span>}
          {audio && <span className="inline-flex items-center gap-0.5 rounded bg-pink-500/25 px-1 py-0.5 text-[8px] text-pink-100"><Music className="h-2 w-2" />配音</span>}
        </span>
      </span>
    </button>
  );
};

/** 角色卡 */
const CharacterCard: React.FC<{ c: any; onOpen: () => void }> = ({ c, onOpen }) => {
  const img = c?.three_views?.front || c?.three_views?.three_quarter || c?.three_views?.side || c?.avatar_url || '';
  return (
    <button
      type="button" onClick={onOpen}
      className="group relative aspect-[3/4] overflow-hidden rounded-xl border border-black/[.07] bg-black/[.03] text-left transition-all hover:border-amber-400/50 hover:shadow-[0_10px_28px_-12px_rgba(251,191,36,.4)] dark:border-white/[.08] dark:bg-white/[.03]"
    >
      {img ? (
        <img src={resolveMediaUrl(img)} alt={c?.name || ''} loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-violet-500/10 to-amber-500/10">
          <span className="text-lg font-bold text-white/25">{(c?.name || '?').slice(0, 1)}</span>
        </span>
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/5 to-transparent" />
      {img && <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/90 text-white"><CheckCircle2 className="h-2.5 w-2.5" /></span>}
      <span className="absolute inset-x-0 bottom-0 p-2">
        <span className="block truncate text-[10.5px] font-semibold text-white">{c?.name || '未命名'}</span>
        <span className="block truncate text-[8.5px] text-white/55">{c?.role || '角色'}</span>
      </span>
    </button>
  );
};

/** 场景卡 */
const SceneCard: React.FC<{ s: any; onOpen: () => void }> = ({ s, onOpen }) => {
  const img = s?.ref_image_url || '';
  return (
    <button
      type="button" onClick={onOpen}
      className="group relative aspect-[4/3] overflow-hidden rounded-xl border border-black/[.07] bg-black/[.03] text-left transition-all hover:border-sky-400/50 hover:shadow-[0_10px_28px_-12px_rgba(56,189,248,.35)] dark:border-white/[.08] dark:bg-white/[.03]"
    >
      {img ? (
        <img src={resolveMediaUrl(img)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]" />
      ) : (
        <span className={`absolute inset-0 flex items-center justify-center ${MUTED}`}><Camera className="h-5 w-5 opacity-30" /></span>
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/5 to-transparent" />
      <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[8.5px] text-white/85">#{s?.scene_index ?? '—'}</span>
      <span className="absolute inset-x-0 bottom-0 p-2">
        <span className="block truncate text-[10px] font-semibold text-white">{s?.title || s?.location || '未命名场景'}</span>
      </span>
    </button>
  );
};

/** 空状态（中部） */
const EmptyStage: React.FC<{ running: boolean }> = ({ running }) => (
  <div className="relative overflow-hidden rounded-2xl border border-black/[.06] bg-gradient-to-br from-amber-400/[.07] via-transparent to-violet-500/[.06] px-8 py-14 text-center dark:border-white/[.08]">
    <div className="pointer-events-none absolute inset-x-0 top-0 h-5 bg-[repeating-linear-gradient(90deg,transparent_0_16px,rgba(0,0,0,.10)_16px_24px)] opacity-40 dark:bg-[repeating-linear-gradient(90deg,transparent_0_16px,rgba(255,255,255,.10)_16px_24px)]" />
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-[repeating-linear-gradient(90deg,transparent_0_16px,rgba(0,0,0,.10)_16px_24px)] opacity-40 dark:bg-[repeating-linear-gradient(90deg,transparent_0_16px,rgba(255,255,255,.10)_16px_24px)]" />
    <div className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-400/25 bg-gradient-to-br from-amber-300/20 to-orange-500/10">
      {running ? <Loader2 className="h-6 w-6 animate-spin text-amber-400" /> : <Clapperboard className="h-6 w-6 text-amber-400" />}
    </div>
    <h3 className={`mt-4 text-[15px] font-bold ${TEXT}`}>{running ? '总导演正在拆解剧本' : '从一段文字，到一部成片'}</h3>
    <p className={`mx-auto mt-1.5 max-w-[420px] text-[11px] leading-relaxed ${MUTED}`}>
      {running ? '分镜与角色资产生成后会实时出现在这里' : '粘贴小说章节或故事梗概，总导演 Agent 会自主拆解、定妆、生片、配音并导出剪映草稿。'}
    </p>
    {!running && (
      <div className="mx-auto mt-5 grid max-w-[520px] grid-cols-3 gap-2 text-left">
        {[
          ['01', '拆解', '剧本 → 角色 / 场景 / 分镜'],
          ['02', '生成', '多参考直出 · 角色一致性'],
          ['03', '成片', '自动验收 · 导出剪映'],
        ].map(([n, t, d]) => (
          <div key={n} className="rounded-xl border border-black/[.05] bg-white/40 px-2.5 py-2 dark:border-white/[.06] dark:bg-white/[.03]">
            <div className="font-mono text-[9px] text-amber-500 dark:text-amber-300/80">{n}</div>
            <div className={`mt-0.5 text-[10.5px] font-semibold ${TEXT}`}>{t}</div>
            <div className={`mt-0.5 text-[9px] leading-snug ${MUTED}`}>{d}</div>
          </div>
        ))}
      </div>
    )}
  </div>
);

/** 空状态（右侧） */
const EmptyPanel: React.FC<{ running: boolean; text: string }> = ({ running, text }) => (
  <div className="flex min-h-[200px] items-center justify-center px-6">
    <div className="text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-black/[.06] bg-black/[.03] dark:border-white/[.08] dark:bg-white/[.03]">
        {running ? <Loader2 className="h-5 w-5 animate-spin text-amber-400" /> : <ImageIcon className="h-5 w-5 opacity-40 [color:var(--color-text-muted)]" />}
      </div>
      <p className={`mt-3 max-w-[240px] text-[10.5px] leading-relaxed ${MUTED}`}>{text}</p>
    </div>
  </div>
);

export const OneKeyStudioView: React.FC = () => {
  // ── 配置 ──
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [aspect, setAspect] = useState('9:16');
  const [maxShots, setMaxShots] = useState(12);
  const [imageProvider, setImageProvider] = useState('');
  const [imageEditProvider, setImageEditProvider] = useState('');
  const [videoProvider, setVideoProvider] = useState('');
  const [audioProvider, setAudioProvider] = useState('');
  const [enableVideo, setEnableVideo] = useState(true);
  const [genRoles, setGenRoles] = useState(true);
  const [keyframeMode, setKeyframeMode] = useState(false);
  const [teams, setTeams] = useState<any[]>([]);
  const [teamId, setTeamId] = useState('studio-default');
  const [skills, setSkills] = useState<any[]>([]);
  const [promptSkill, setPromptSkill] = useState('');

  // ── 任务状态 ──
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('idle');
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<any[]>([]);
  const [subagentMap, setSubagentMap] = useState<Record<string, any>>({});
  const [todos, setTodos] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ranTeamName, setRanTeamName] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [preview, setPreview] = useState<{ kind: 'image' | 'video' | 'audio'; url: string; title: string } | null>(null);
  const [centerTab, setCenterTab] = useState<'shots' | 'swarm' | 'logs'>('shots');
  const [assetTab, setAssetTab] = useState<'characters' | 'scenes' | 'shots'>('characters');
  const logRef = useRef<HTMLDivElement>(null);

  const refreshHistory = () => {
    apiService.onekeyList(20).then((r) => setHistory(r?.tasks || [])).catch(() => setHistory([]));
  };

  useEffect(() => {
    loadRoleMetas();
    apiService.listAgentTeams()
      .then((r) => setTeams(r?.teams || []))
      .catch(() => setTeams([]));
    apiService.listSkills()
      .then((r) => setSkills((r as any[]) || []))
      .catch(() => setSkills([]));
    refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 轮询 ──
  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async (): Promise<string | undefined> => {
      try {
        const t = await apiService.onekeyStatus(taskId);
        if (stop) return t.status;
        setStatus(t.status);
        setProgress(t.progress || 0);
        setLogs(t.logs || []);
        setSubagentMap(t.subagents || {});
        setTodos(t.todos || []);
        if (t.team_name) setRanTeamName(t.team_name);
        if (t.result) setResult(t.result);            // 运行中也实时刷新（中间产物可见）
        if (t.status === 'failed') setError(t.error || '任务失败');
        return t.status;
      } catch (e: any) {
        if (!stop) setError(e?.message || '轮询失败');
        return undefined;
      }
    };
    const tick = async () => {
      const s = await poll();
      if (s && TERMINAL.has(s) && timer) { clearInterval(timer); timer = null; refreshHistory(); }
    };
    tick();
    timer = setInterval(tick, 3000);
    return () => { stop = true; if (timer) clearInterval(timer); };
  }, [taskId]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logs.length]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  const applyTeam = (tid: string) => {
    setTeamId(tid);
    const t = teams.find((x) => x?.id === tid);
    const d = t?.defaults || {};
    if (typeof d.gen_roles === 'boolean') setGenRoles(d.gen_roles);
    if (typeof d.enable_video === 'boolean') setEnableVideo(d.enable_video);
    if (typeof d.max_images === 'number') setMaxShots(Math.max(1, Math.min(30, d.max_images)));
  };

  const running = status === 'queued' || status === 'running';
  const done = status === 'success' || status === 'partial';
  const summary = result?.summary || {};
  const sm = statusMeta(status);

  const handleRun = async () => {
    if (text.trim().length < 20) { setError('文本太短（至少20字），请粘贴小说章节或故事梗概'); return; }
    setError(null); setResult(null); setLogs([]); setProgress(0); setStatus('queued'); setSubagentMap({});
    setRanTeamName(teams.find((t) => t?.id === teamId)?.name || '');
    setCenterTab('shots');
    try {
      const r = await apiService.onekeyRun({
        title: title.trim() || '一键成片',
        text: text.trim(),
        aspect_ratio: aspect,
        max_images: maxShots,
        image_provider: imageProvider || undefined,
        image_edit_provider: imageEditProvider || undefined,
        video_provider: videoProvider || undefined,
        audio_provider: audioProvider || undefined,
        enable_video: enableVideo,
        max_videos: Math.min(maxShots, 12),
        gen_roles: genRoles,
        team_id: teamId,
        keyframe_mode: keyframeMode,
        prompt_skill: promptSkill,
      });
      setTaskId(r.task_id);
      if (r?.team_name) setRanTeamName(r.team_name);
      refreshHistory();
    } catch (e: any) {
      setError(e?.message || '提交失败');
      setStatus('idle');
    }
  };

  const handleOpenProject = async (_tab: 'canvas' | 'studio') => {
    const proj = result?.project;
    if (!proj) return;
    setSaving(true);
    try {
      const created = await apiService.createProject({
        title: title.trim() || proj.title || '一键成片',
        style_preset: proj.style_preset || 'donghua_xianxia',
        aspect_ratio: proj.aspect_ratio || aspect,
      });
      const pid = created?.project?.id || created?.id;
      if (!pid) throw new Error('项目创建失败');
      try { autoBindShotCharacters(proj as any); } catch { /* ignore */ }
      await apiService.saveProjectContent(pid, { ...proj, id: pid });
      await useProjectStore.getState().loadActiveProject(pid);
      useProjectStore.getState().leaveEpisode();
    } catch (e: any) {
      setError(e?.message || '落盘失败');
    } finally {
      setSaving(false);
    }
  };

  const shots: any[] = useMemo(() => {
    const scenes = result?.project?.scenes || [];
    return scenes.flatMap((s: any) => s.shots || []);
  }, [result]);

  const characters: any[] = useMemo(() => result?.project?.characters || [], [result]);
  const sceneList: any[] = useMemo(() => result?.project?.scenes || [], [result]);
  const openPreview = (kind: 'image' | 'video' | 'audio', url?: string, title?: string) => {
    if (url) setPreview({ kind, url, title: title || '' });
  };

  const stageList = useMemo(() => {
    const seen: Array<{ stage: string; msg: string }> = [];
    for (const l of logs) {
      const s = String(l.stage || '');
      if (!s || s === '子代理集群' || s === '导演计划') continue;
      if (!seen.some((x) => x.stage === s)) seen.push({ stage: s, msg: l.message || '' });
    }
    return seen;
  }, [logs]);

  const todoCounts = useMemo(() => {
    const doneN = todos.filter((t) => t?.status === 'completed').length;
    const active = todos.filter((t) => t?.status === 'in_progress').length;
    return { total: todos.length, done: doneN, active };
  }, [todos]);

  const videoDone = shots.filter((s: any) => s?.video_url).length;
  const sceneReady = sceneList.filter((s: any) => s?.ref_image_url).length;
  const charReady = characters.filter((c: any) => c?.three_views?.front || c?.avatar_url).length;

return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-background">
      {/* 环境光 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-48 h-[520px] w-[520px] rounded-full bg-amber-400/[.07] blur-[130px]" />
        <div className="absolute -right-32 top-1/3 h-[460px] w-[460px] rounded-full bg-violet-500/[.08] blur-[130px]" />
        <div className="absolute bottom-0 left-1/3 h-[360px] w-[360px] rounded-full bg-brand/[.06] blur-[120px]" />
        <div className="absolute inset-0 opacity-[.035] [background-image:radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] [background-size:26px_26px]" />
      </div>

      {/* ══ 顶栏 ══ */}
      <header className="relative z-20 flex h-16 shrink-0 items-center gap-3 border-b border-black/[.06] bg-white/55 px-5 backdrop-blur-2xl dark:border-white/[.08] dark:bg-black/25">
        <div className="relative shrink-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-300 via-amber-400 to-orange-500 shadow-lg shadow-amber-500/25">
            <Clapperboard className="h-5 w-5 text-black/80" />
          </div>
          <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white dark:border-[#0b0b10] ${taskId ? sm.dot : 'bg-emerald-400'}`} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className={`truncate text-[15px] font-bold tracking-tight ${TEXT}`}>成片工作室</h1>
            <span className="hidden rounded-full border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[8.5px] font-semibold uppercase tracking-[.16em] text-amber-600 sm:inline dark:text-amber-300">
              One-take Studio
            </span>
          </div>
          <p className={`truncate text-[10px] ${MUTED}`}>总导演 Agent 自主编排 · 子代理集群 · 产物验收</p>
        </div>

        <div className="flex-1" />

        {taskId && (
          <div className={`hidden items-center gap-2 rounded-full border border-black/[.06] bg-white/60 px-3 py-1.5 md:flex dark:border-white/[.08] dark:bg-white/[.04]`}>
            <span className={`h-1.5 w-1.5 rounded-full ${sm.dot}`} />
            <span className={`text-[10.5px] font-medium ${TEXT}`}>{sm.label}</span>
            <span className={`font-mono text-[10px] ${MUTED}`}>{progress}%</span>
          </div>
        )}

        <div className="relative">
          <button
            onClick={() => { setShowHistory((v) => !v); refreshHistory(); }}
            className={`inline-flex h-9 items-center gap-1.5 rounded-xl border border-black/[.07] bg-white/60 px-3 text-[11.5px] font-medium ${TEXT} transition-colors hover:border-amber-400/40 hover:bg-white/80 dark:border-white/[.08] dark:bg-white/[.04] dark:hover:bg-white/[.07]`}
          >
            <History className="h-3.5 w-3.5" />历史
            <span className={`rounded-full bg-black/[.05] px-1.5 py-0.5 font-mono text-[9px] ${MUTED} dark:bg-white/[.06]`}>{history.length}</span>
            <ChevronDown className={`h-3 w-3 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
          </button>
          {showHistory && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShowHistory(false)} />
              <div className={`absolute right-0 top-[calc(100%+8px)] z-40 max-h-[420px] w-[380px] overflow-y-auto rounded-2xl border border-black/[.06] bg-white/95 p-1.5 shadow-2xl backdrop-blur-2xl custom-scrollbar dark:border-white/[.08] dark:bg-[#121218]/95`}>
                <div className={`flex items-center justify-between px-2.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-wider ${MUTED}`}>
                  <span>历史任务</span><span>{history.length}</span>
                </div>
                {history.length === 0 && <div className={`px-3 py-8 text-center text-[11px] ${MUTED}`}>暂无历史任务</div>}
                {history.map((t) => {
                  const hm = statusMeta(t.status || '');
                  const pct = Math.max(0, Math.min(100, Number(t.progress || 0)));
                  return (
                    <button
                      key={t.task_id}
                      onClick={() => {
                        setTaskId(t.task_id); setShowHistory(false);
                        setTitle(t.title || ''); setResult(null); setError(null);
                        setStatus(t.status || 'running'); setProgress(t.progress || 0);
                        setTodos([]); setCenterTab('shots');
                      }}
                      className={`mb-0.5 w-full rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.05] ${taskId === t.task_id ? 'bg-amber-400/10' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${hm.dot}`} />
                        <span className={`min-w-0 flex-1 truncate text-[11.5px] font-medium ${TEXT}`}>{t.title || t.task_id}</span>
                        <span className={`font-mono text-[9.5px] ${MUTED}`}>{pct}%</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 pl-3.5">
                        <span className={`truncate text-[9.5px] ${MUTED}`}>{t.team_name || '默认简化剧组'} · {t.created_at || ''}</span>
                      </div>
                      <div className="mt-1.5 ml-3.5 h-0.5 overflow-hidden rounded-full bg-black/[.06] dark:bg-white/[.07]">
                        <div className={`h-full rounded-full ${hm.dot}`} style={{ width: `${pct}%` }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => { setTaskId(null); setResult(null); setError(null); setStatus('idle'); setLogs([]); setProgress(0); setSubagentMap({}); setTodos([]); refreshHistory(); }}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-black/[.07] bg-white/60 px-3 text-[11.5px] font-medium transition-colors hover:border-amber-400/40 hover:bg-white/80 dark:border-white/[.08] dark:bg-white/[.04] dark:hover:bg-white/[.07]"
        >
          <PlusCircle className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" /><span className={TEXT}>新建任务</span>
        </button>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 gap-3 p-3">
        {/* ══ 左：创作配置 ══ */}
        <aside className={`flex w-[320px] shrink-0 flex-col overflow-hidden xl:w-[336px] ${PANEL}`}>
          <div className="flex-1 space-y-3 overflow-y-auto p-3 custom-scrollbar">
            <Panel title="剧本" icon={<ScrollText className="h-3.5 w-3.5 text-amber-400" />} hint="整章粘贴效果最好">
              <input
                value={title} onChange={(e) => setTitle(e.target.value)} placeholder="成片标题（可选）"
                className={`h-9 w-full rounded-xl border border-black/[.07] bg-white/60 px-3 text-[12px] ${TEXT} placeholder-[color:var(--color-text-muted)] outline-none transition-colors focus:border-amber-400/60 focus:ring-2 focus:ring-amber-400/10 dark:border-white/[.08] dark:bg-black/20`}
              />
              <textarea
                value={text} onChange={(e) => setText(e.target.value)} rows={9}
                placeholder="粘贴小说章节 / 故事梗概（≥20字）。总导演会先写下 todolist 计划，再自主编排全流程。"
                className={`min-h-[190px] w-full resize-y rounded-xl border border-black/[.07] bg-white/60 p-3 text-[11.5px] leading-relaxed ${TEXT} placeholder-[color:var(--color-text-muted)] outline-none transition-colors focus:border-amber-400/60 focus:ring-2 focus:ring-amber-400/10 custom-scrollbar dark:border-white/[.08] dark:bg-black/20`}
              />
              <div className={`flex items-center justify-between text-[9.5px] ${MUTED}`}>
                <span>支持整章小说 / 分集梗概</span>
                <span className={text.length >= 20 ? 'text-emerald-500 dark:text-emerald-400' : ''}>{text.length} 字</span>
              </div>
            </Panel>

            <Panel title="制作规格" icon={<SlidersHorizontal className="h-3.5 w-3.5 text-sky-400" />}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10.5px] ${MUTED}`}>画幅</span>
                <div className="inline-flex rounded-lg border border-black/[.06] bg-black/[.04] p-0.5 dark:border-white/[.08] dark:bg-black/25">
                  {[['9:16', '竖屏'], ['16:9', '横屏'], ['1:1', '方形']].map(([v, label]) => (
                    <button
                      key={v} type="button" onClick={() => setAspect(v)}
                      className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-all ${
                        aspect === v ? 'bg-white text-amber-600 shadow-sm dark:bg-white/[.10] dark:text-amber-300' : `${MUTED} hover:text-[color:var(--color-text-main)]`
                      }`}
                    >{label}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`shrink-0 text-[10.5px] ${MUTED}`}>最多分镜</span>
                <input
                  type="range" min={1} max={30} value={maxShots}
                  onChange={(e) => setMaxShots(Math.max(1, Math.min(30, parseInt(e.target.value) || 12)))}
                  className="h-1 flex-1 accent-amber-400"
                />
                <span className="w-6 text-center font-mono text-[11px] font-semibold text-amber-500 dark:text-amber-300">{maxShots}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`shrink-0 text-[10.5px] ${MUTED}`}>提示词技能</span>
                <select
                  value={promptSkill} onChange={(e) => setPromptSkill(e.target.value)}
                  title="指定模型写提示词时使用的技能：视频首选 minimax-h3-prompt，通用兜底 prompt-basics"
                  className={`h-8 min-w-0 flex-1 rounded-lg border border-black/[.07] bg-white/60 px-2 text-[10.5px] ${TEXT} outline-none focus:border-amber-400/60 dark:border-white/[.08] dark:bg-black/20`}
                >
                  <option value="">自动（导演自选 · 六要素兜底）</option>
                  {[
                    ...skills.filter((s: any) => ['minimax-h3-prompt', 'prompt-basics'].includes(s?.name)),
                    ...skills.filter((s: any) => !['minimax-h3-prompt', 'prompt-basics'].includes(s?.name)),
                  ].map((s: any) => (
                    <option key={s?.name} value={s?.name}>
                      {s?.name}{s?.category ? ` · ${s.category}` : ''}{['minimax-h3-prompt', 'prompt-basics'].includes(s?.name) ? '（推荐）' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className={`text-[9px] leading-relaxed ${MUTED}`}>
                {promptSkill ? `已指定「${promptSkill}」：写/改提示词前会先读该技能` : '不指定时按「主体+动作+环境+光线+运镜+风格」组装兜底提示词'}
              </div>
            </Panel>

            <Panel title="生成源" icon={<Zap className="h-3.5 w-3.5 text-amber-400" />} hint="生图 / 编辑 / 视频 / 配音">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`flex w-[86px] shrink-0 items-center gap-1.5 text-[10px] ${MUTED}`}><Aperture className="h-3 w-3" />生图源</span>
                  <div className="min-w-0 flex-1"><ProviderPicker kind="image" value={imageProvider} onChange={setImageProvider} compact placeholder="— 自动 —" /></div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`flex w-[86px] shrink-0 items-center gap-1.5 text-[10px] ${MUTED}`}><Sparkles className="h-3 w-3" />编辑源</span>
                  <div className="min-w-0 flex-1"><ProviderPicker kind="image" value={imageEditProvider} onChange={setImageEditProvider} compact placeholder="— 同生图 —" capability="i2i" /></div>
                </div>
                <div className="grid grid-cols-[1fr_1fr] gap-2">
                  <div className="min-w-0">
                    <div className={`mb-1 flex items-center gap-1 text-[10px] ${MUTED}`}><Film className="h-3 w-3" />视频源</div>
                    <ProviderPicker kind="video" value={videoProvider} onChange={setVideoProvider} compact placeholder="— 自动 —" capability="i2v" />
                  </div>
                  <div className="min-w-0">
                    <div className={`mb-1 flex items-center gap-1 text-[10px] ${MUTED}`}><AudioLines className="h-3 w-3" />配音源</div>
                    <ProviderPicker kind="audio" value={audioProvider} onChange={setAudioProvider} compact placeholder="— 自动 —" />
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/[.07] px-2 py-1.5 text-[9px] leading-relaxed text-amber-700 dark:text-amber-200/90">
                <Sparkles className="mt-[1px] h-2.5 w-2.5 shrink-0" />
                <span>三视图 / 场景空镜走生图源；多图合成分镜走编辑源（不配则同生图源）。</span>
              </div>
            </Panel>

            <Panel title="导演组" icon={<Users className="h-3.5 w-3.5 text-violet-400" />}>
              <select
                value={teamId} onChange={(e) => applyTeam(e.target.value)}
                className={`h-9 w-full rounded-xl border border-black/[.07] bg-white/60 px-2.5 text-[11.5px] ${TEXT} outline-none focus:border-amber-400/60 dark:border-white/[.08] dark:bg-black/20`}
              >
                <option value="studio-default">默认简化剧组（资产复用 + 多参考 + 风格锁定 + 产物验收）</option>
                {teams.filter((t) => t.id !== 'studio-default').map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.qa_gate ? ' · 质检门' : ''}</option>
                ))}
              </select>
              <div className={`line-clamp-3 text-[9.5px] leading-relaxed ${MUTED}`}>
                {teams.find((t) => t?.id === teamId)?.description
                  || '无固定流程：总导演 Agent 用 todolist 自主制定计划并执行。'}
              </div>
            </Panel>

            <Panel title="高级选项" icon={<Wand2 className="h-3.5 w-3.5 text-emerald-400" />}>
              <div className="divide-y divide-black/[.05] dark:divide-white/[.05]">
                <Switch checked={genRoles} onChange={setGenRoles} label="补齐角色资产" hint="已有三视图 / 形象自动复用" />
                <Switch checked={enableVideo} onChange={setEnableVideo} label="视频生成" hint="逐镜参考生视频（成片核心）" />
                <Switch checked={keyframeMode} onChange={setKeyframeMode} label="先生成分镜画面" hint="默认关：多参考 r2v 直出" title="默认关=跳过分镜合成，直接多参考生视频（r2v）；开启后先合成分镜画面再首帧 i2v" />
              </div>
            </Panel>

            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/[.08] px-3 py-2 text-[10.5px] leading-relaxed text-red-600 dark:text-red-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-black/[.06] bg-white/40 p-3 dark:border-white/[.08] dark:bg-black/20">
            <button
              onClick={() => void handleRun()}
              disabled={running}
              className="group relative flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-amber-400 via-amber-500 to-orange-500 text-[12.5px] font-bold text-black shadow-lg shadow-amber-500/25 transition-all hover:brightness-105 disabled:opacity-50"
            >
              <span className="absolute inset-0 bg-[linear-gradient(110deg,transparent,rgba(255,255,255,.35),transparent)] opacity-0 transition-opacity group-hover:opacity-100" />
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              {running ? 'Agent 制作中…' : done || status === 'failed' ? '再次发起成片' : '开始成片'}
            </button>
            <div className={`mt-1.5 text-center text-[9px] ${MUTED}`}>计划与进度来自导演 todolist · 流程不写死</div>
          </div>
        </aside>

        {/* ══ 中：生产看板 ══ */}
        <main className={`flex min-w-0 flex-1 flex-col overflow-hidden ${PANEL}`}>
          <div className="shrink-0 space-y-2.5 p-3.5 pb-3">
            <div className={`relative overflow-hidden rounded-2xl border border-black/[.05] bg-gradient-to-br p-4 dark:border-white/[.07] ${
              running ? 'from-amber-400/[.12] via-amber-400/[.03] to-transparent'
                : done ? 'from-emerald-400/[.10] via-emerald-400/[.02] to-transparent'
                  : status === 'failed' ? 'from-red-500/[.10] via-red-500/[.02] to-transparent'
                    : 'from-violet-500/[.07] via-transparent to-amber-400/[.05]'
            }`}>
              <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-amber-400/[.08] blur-3xl" />
              <div className="relative flex items-start gap-3.5">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
                  running ? 'border-amber-400/30 bg-amber-400/15' : done ? 'border-emerald-400/30 bg-emerald-400/15' : status === 'failed' ? 'border-red-400/30 bg-red-400/15' : 'border-black/[.06] bg-black/[.03] dark:border-white/[.08] dark:bg-white/[.04]'
                }`}>
                  {running && <Loader2 className="h-5 w-5 animate-spin text-amber-400" />}
                  {done && <CheckCircle2 className="h-5 w-5 text-emerald-400" />}
                  {status === 'failed' && <AlertTriangle className="h-5 w-5 text-red-400" />}
                  {!running && !done && status !== 'failed' && <Clapperboard className="h-5 w-5 opacity-40 [color:var(--color-text-muted)]" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[14px] font-bold ${TEXT}`}>{sm.label}</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-0.5 text-[9px] font-medium text-violet-600 dark:text-violet-300">
                      <Bot className="h-2.5 w-2.5" />{ranTeamName ? `导演组 · ${ranTeamName}` : '默认简化剧组'}
                    </span>
                  </div>
                  <div className={`mt-1 truncate text-[10.5px] ${MUTED}`}>
                    {running
                      ? (todos.find((t) => t?.status === 'in_progress')?.content || 'Agent 正在自主编排…')
                      : done
                        ? `角色 ${charReady}/${characters.length} · 场景 ${sceneReady}/${sceneList.length} · 成片 ${videoDone}/${shots.length}`
                        : '粘贴文本后点击「开始成片」，总导演 Agent 将自主编排全流程'}
                  </div>
                </div>
                <ProgressRing value={progress} tone={sm.ring} />
              </div>
              <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Kpi icon={<Users className="h-3.5 w-3.5 text-violet-400" />} label="角色资产" value={charReady} total={characters.length} accent="bg-violet-400/10" />
                <Kpi icon={<Camera className="h-3.5 w-3.5 text-sky-400" />} label="场景空镜" value={sceneReady} total={sceneList.length} accent="bg-sky-400/10" />
                <Kpi icon={<Film className="h-3.5 w-3.5 text-emerald-400" />} label="分镜成片" value={videoDone} total={shots.length} accent="bg-emerald-400/10" />
                <Kpi icon={<AudioLines className="h-3.5 w-3.5 text-pink-400" />} label="配音" value={shots.filter((s: any) => s?.audio_url).length} total={summary.voice_needed ?? '—'} accent="bg-pink-400/10" />
              </div>
            </div>

            {(todos.length > 0 || (stageList.length > 0 && running)) && (
              <div className={`flex items-start gap-2.5 rounded-2xl border border-black/[.05] bg-white/45 px-3.5 py-2.5 dark:border-white/[.06] dark:bg-white/[.02]`}>
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                  <ListChecks className="h-3 w-3" />导演计划
                  {todos.length > 0 && <span className={`font-mono text-[9px] ${MUTED}`}>{todoCounts.done}/{todoCounts.total}</span>}
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
                  {todos.length > 0 ? todos.map((t: any, i: number) => (
                    <span key={i} className="inline-flex max-w-full items-center gap-1 text-[10px]">
                      {t.status === 'completed'
                        ? <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                        : t.status === 'in_progress'
                          ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-400" />
                          : <CircleDot className={`h-3 w-3 shrink-0 ${MUTED}`} />}
                      <span className={`truncate ${
                        t.status === 'completed' ? `${MUTED} line-through` : t.status === 'in_progress' ? 'text-amber-600 dark:text-amber-300' : MUTED
                      }`}>{t.content}</span>
                    </span>
                  )) : stageList.slice(-10).map((s) => (
                    <span key={s.stage} className={`rounded-full border border-black/[.05] bg-black/[.02] px-2 py-0.5 text-[9.5px] ${MUTED} dark:border-white/[.06] dark:bg-white/[.03]`}>{s.stage}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-b border-black/[.06] px-3.5 pb-2 dark:border-white/[.07]">
            <SegTabs
              value={centerTab} onChange={(v) => setCenterTab(v as any)}
              items={[
                { id: 'shots', label: '分镜', icon: <Film className="h-3.5 w-3.5" />, count: shots.length },
                { id: 'swarm', label: '子代理集群', icon: <Bot className="h-3.5 w-3.5" />, count: Object.keys(subagentMap).length },
                { id: 'logs', label: '实时日志', icon: <ScrollText className="h-3.5 w-3.5" />, count: logs.length },
              ]}
            />
            <span className="flex-1" />
            {centerTab === 'shots' && shots.length > 0 && (
              <span className={`hidden items-center gap-2 text-[9px] lg:flex ${MUTED}`}>
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />成片</span>
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-sky-400" />画面</span>
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-white/25" />待生成</span>
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3.5 custom-scrollbar">
            {centerTab === 'shots' && (
              shots.length > 0 ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-7">
                    {shots.map((s: any) => (
                      <ShotCard
                        key={s.id || s.shot_index}
                        shot={s}
                        onOpen={() => {
                          if (s.video_url) openPreview('video', s.video_url, `分镜 #${s.shot_index} 成片`);
                          else if (s.image_url) openPreview('image', s.image_url, `分镜 #${s.shot_index} 成图`);
                        }}
                      />
                    ))}
                  </div>
                  {videoDone < shots.length && (
                    <div className={`flex items-center gap-1.5 text-[10px] ${MUTED}`}>
                      <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
                      成片 {videoDone}/{shots.length} —— 异步视频生成中，完成后自动回写
                    </div>
                  )}
                  {Array.isArray(result?.video_errors) && result.video_errors.length > 0 && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/[.06] p-2.5 text-[10px] leading-relaxed text-red-600 dark:text-red-300">
                      {result.video_errors.slice(0, 3).map((e: any, i: number) => (
                        <div key={i}>✗ 分镜 #{e?.shot_index ?? '?'}：{String(e?.error || e?.message || '生成失败').slice(0, 160)}</div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <EmptyStage running={running} />
              )
            )}

            {centerTab === 'swarm' && <OneKeySwarmBoard subagents={subagentMap} />}

            {centerTab === 'logs' && (
              <div className="overflow-hidden rounded-2xl border border-black/[.06] bg-white/50 dark:border-white/[.08] dark:bg-black/30">
                <div className="flex items-center gap-2 border-b border-black/[.05] px-3 py-2 dark:border-white/[.06]">
                  <span className="h-2 w-2 rounded-full bg-red-400/80" />
                  <span className="h-2 w-2 rounded-full bg-amber-400/80" />
                  <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
                  <span className={`ml-2 font-mono text-[9.5px] ${MUTED}`}>director.log</span>
                  <span className="flex-1" />
                  <span className={`font-mono text-[9px] ${MUTED}`}>{logs.length} 行</span>
                </div>
                <div ref={logRef} className="max-h-[calc(100vh-360px)] min-h-[300px] space-y-0.5 overflow-y-auto p-3 font-mono custom-scrollbar">
                  {logs.length === 0 && <div className={`py-6 text-center font-sans text-[11px] ${MUTED}`}>等待 Agent 上报进度…</div>}
                  {logs.map((l: any, i: number) => (
                    <div key={i} className="flex items-start gap-2 rounded px-1 py-0.5 text-[10.5px] leading-relaxed hover:bg-black/[.03] dark:hover:bg-white/[.03]">
                      <span className={`shrink-0 font-mono text-[9px] tabular-nums ${MUTED}`}>{fmtClock(l.time_ms)}</span>
                      <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold ${stageTone(String(l.stage || ''))}`}>{l.stage}</span>
                      <span className={`min-w-0 break-all ${TEXT}`}>{l.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>

        {/* ══ 右：产物廊 ══ */}
        <aside className={`flex w-[330px] shrink-0 flex-col overflow-hidden xl:w-[356px] ${PANEL}`}>
          <div className="shrink-0 p-3.5 pb-2">
            <div className="flex items-center justify-between">
              <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold ${TEXT}`}>
                <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-black/[.06] bg-black/[.03] dark:border-white/[.08] dark:bg-white/[.04]">
                  <Palette className="h-3.5 w-3.5 text-amber-400" />
                </span>
                产物廊
              </span>
              {result?.jianyin_draft && Object.keys(result.jianyin_draft).length > 0 && (
                <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-300">剪映已导出</span>
              )}
            </div>
            {result && (
              <div className="mt-2.5 grid grid-cols-4 gap-1.5">
                {[
                  ['角色', `${charReady}`, 'text-violet-500 dark:text-violet-300'],
                  ['场景', `${sceneReady}`, 'text-sky-500 dark:text-sky-300'],
                  ['成片', `${videoDone}`, 'text-emerald-500 dark:text-emerald-300'],
                  ['配音', `${shots.filter((s: any) => s?.audio_url).length}`, 'text-pink-500 dark:text-pink-300'],
                ].map(([k, v, tone]) => (
                  <div key={k} className="rounded-xl border border-black/[.05] bg-white/45 py-1.5 text-center dark:border-white/[.06] dark:bg-white/[.03]">
                    <div className={`font-mono text-[13px] font-bold ${tone}`}>{v}</div>
                    <div className={`text-[8.5px] ${MUTED}`}>{k}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!result ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyPanel running={running} text={running ? '产物正在生成，角色 / 场景 / 成片会实时出现在这里' : '发起任务后，这里实时展示角色资产 · 场景空镜 · 分镜成片'} />
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b border-black/[.06] px-3.5 pb-2 dark:border-white/[.07]">
                <SegTabs
                  size="sm" value={assetTab} onChange={(v) => setAssetTab(v as any)}
                  items={[
                    { id: 'characters', label: '角色', count: characters.length },
                    { id: 'scenes', label: '场景', count: sceneList.length },
                    { id: 'shots', label: '成片', count: shots.length },
                  ]}
                />
                <span className="flex-1" />
                <span className={`text-[9px] ${MUTED}`}>点击预览</span>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 custom-scrollbar">
                {assetTab === 'characters' && (
                  characters.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {characters.map((c: any, i: number) => {
                        const img = c?.three_views?.front || c?.three_views?.three_quarter
                          || c?.three_views?.side || c?.avatar_url || '';
                        return (
                          <CharacterCard
                            key={c?.id || c?.name || i}
                            c={c}
                            onOpen={() => openPreview('image', img, `角色资产 · ${c?.name || ''}`)}
                          />
                        );
                      })}
                    </div>
                  ) : <EmptyPanel running={running} text="还没有角色资产" />
                )}

                {assetTab === 'scenes' && (
                  sceneList.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {sceneList.map((s: any, i: number) => (
                        <SceneCard
                          key={s?.id || s?.scene_index || i}
                          s={s}
                          onOpen={() => openPreview('image', s?.ref_image_url, `场景 #${s?.scene_index ?? i + 1} · ${s?.title || ''}`)}
                        />
                      ))}
                    </div>
                  ) : <EmptyPanel running={running} text="还没有场景空镜" />
                )}

                {assetTab === 'shots' && (
                  shots.length > 0 ? (
                    <div className="space-y-1.5">
                      {shots.map((s: any, i: number) => {
                        const has = !!(s?.video_url || s?.image_url);
                        return (
                          <div key={s?.id || s?.shot_index || i} className="flex items-center gap-2.5 rounded-xl border border-black/[.05] bg-white/45 p-2 transition-colors hover:border-amber-400/30 dark:border-white/[.06] dark:bg-white/[.03]">
                            <button
                              type="button"
                              title={s?.video_url ? '播放成片' : s?.image_url ? '预览成图' : '待生成'}
                              onClick={() => {
                                if (s?.video_url) openPreview('video', s.video_url, `分镜 #${s.shot_index} 成片`);
                                else if (s?.image_url) openPreview('image', s.image_url, `分镜 #${s.shot_index} 成图`);
                              }}
                              className={`relative h-11 w-[62px] shrink-0 overflow-hidden rounded-lg border ${
                                s?.video_url ? 'border-emerald-500/40' : has ? 'border-black/[.07] dark:border-white/[.08]' : 'border-dashed border-black/10 bg-black/[.03] dark:border-white/10 dark:bg-white/[.03]'
                              }`}
                            >
                              {s?.video_url ? (
                                <video src={resolveMediaUrl(s.video_url)} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                              ) : s?.image_url ? (
                                <img src={resolveMediaUrl(s.image_url)} alt="" loading="lazy" className="h-full w-full object-cover" />
                              ) : (
                                <span className={`absolute inset-0 flex items-center justify-center text-[8px] ${MUTED}`}>待生成</span>
                              )}
                              {s?.video_url && (
                                <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                                  <Play className="ml-0.5 h-3 w-3 fill-current text-white/90" />
                                </span>
                              )}
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className={`truncate text-[10.5px] ${TEXT}`}>
                                <span className="mr-1.5 font-mono text-amber-500 dark:text-amber-300">#{s?.shot_index}</span>
                                {s?.action_desc || s?.video_prompt || '—'}
                              </div>
                              <div className="mt-1 flex items-center gap-1.5">
                                {s?.video_url
                                  ? <span className="text-[9px] text-emerald-500 dark:text-emerald-300">✓ 成片</span>
                                  : <span className={`text-[9px] ${MUTED}`}>○ 待成片</span>}
                                {s?.audio_url && <span className="inline-flex items-center gap-0.5 text-[9px] text-pink-500 dark:text-pink-300"><Music className="h-2.5 w-2.5" />配音</span>}
                              </div>
                            </div>
                            {s?.audio_url && (
                              <button
                                type="button" title="试听配音"
                                onClick={() => openPreview('audio', s.audio_url, `分镜 #${s.shot_index} 配音`)}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-black/[.06] bg-white/60 hover:border-pink-400/50 dark:border-white/[.08] dark:bg-white/[.04]"
                              >
                                <Music className="h-3 w-3 text-pink-500 dark:text-pink-300" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : <EmptyPanel running={running} text="还没有分镜产物" />
                )}

                {summary.style_locked ? (
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-300/90">
                    <Wand2 className="h-3 w-3" />全片风格已由大模型锁定，自动附加到所有生成
                  </div>
                ) : null}
                {summary.assets_reused > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-300/90">
                    <CircleCheck className="h-3 w-3" />复用 {summary.assets_reused} 个已有角色资产（未重复定妆）
                  </div>
                )}
                {Array.isArray(result?.ref_warnings) && result.ref_warnings.length > 0 && (
                  <div className="space-y-1 rounded-xl border border-amber-500/25 bg-amber-500/[.07] p-2.5 text-[9.5px] leading-relaxed text-amber-700 dark:text-amber-200/90">
                    {result.ref_warnings.map((w: string, i: number) => <div key={i}>⚠️ {w}</div>)}
                  </div>
                )}
                {!!result?.jianyin_draft && Object.keys(result.jianyin_draft).length > 0 && (
                  <div className="break-all text-[9.5px] leading-relaxed text-emerald-600 dark:text-emerald-300">
                    ✓ 剪映草稿：{result.jianyin_draft.draft_path || result.jianyin_draft.path || '见导出目录'}
                  </div>
                )}
              </div>

              {result?.project && (
                <div className="shrink-0 space-y-1.5 border-t border-black/[.06] bg-white/40 p-3 dark:border-white/[.08] dark:bg-black/20">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => void handleOpenProject('studio')}
                      disabled={saving}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-[11px] font-bold text-black shadow-md shadow-amber-500/20 transition-all hover:brightness-105 disabled:opacity-50"
                    >
                      <Layers className="h-3.5 w-3.5" />分镜台精修
                    </button>
                    <button
                      onClick={() => void handleOpenProject('canvas')}
                      disabled={saving}
                      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-black/[.07] bg-white/60 text-[11px] font-semibold ${TEXT} transition-colors hover:border-amber-400/40 dark:border-white/[.08] dark:bg-white/[.04] disabled:opacity-50`}
                    >
                      <ImageIcon className="h-3.5 w-3.5" />画布编辑
                    </button>
                  </div>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('open-export-modal'))}
                    className={`inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-black/[.06] bg-white/40 text-[10.5px] font-medium ${MUTED} transition-colors hover:text-[color:var(--color-text-main)] dark:border-white/[.07] dark:bg-white/[.03]`}
                  >
                    <Download className="h-3 w-3" />再导出剪映
                  </button>
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {/* ══ 媒体预览 ══ */}
      {preview && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md"
          onClick={() => setPreview(null)}
        >
          <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-3 rounded-full bg-white/10 px-4 py-1.5 text-[11px] text-white/80 backdrop-blur-xl" onClick={(e) => e.stopPropagation()}>
            <span className="max-w-[50vw] truncate">{preview.title}</span>
            <button className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20" onClick={() => setPreview(null)}>
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="max-h-[88vh] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
            {preview.kind === 'video' && (
              <video src={resolveMediaUrl(preview.url)} controls autoPlay className="max-h-[88vh] max-w-[92vw] rounded-2xl shadow-2xl" />
            )}
            {preview.kind === 'image' && (
              <img src={resolveMediaUrl(preview.url)} alt={preview.title} className="max-h-[88vh] max-w-[92vw] rounded-2xl object-contain shadow-2xl" />
            )}
            {preview.kind === 'audio' && (
              <div className="rounded-2xl bg-white/10 p-4 backdrop-blur-xl">
                <audio src={resolveMediaUrl(preview.url)} controls autoPlay className="w-[420px] max-w-[80vw]" />
              </div>
            )}
          </div>
          <div className="absolute bottom-4 text-[10px] text-white/40">点击空白处或按 Esc 关闭</div>
        </div>
      )}
    </div>
  );
};
