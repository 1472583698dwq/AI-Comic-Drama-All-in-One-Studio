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
  Clapperboard, Sparkles, ScrollText, CircleDot, ChevronDown, LayoutGrid,
} from 'lucide-react';
import { apiService } from '../services/api';
import { resolveMediaUrl } from '../utils/devOrigin';
import { useProjectStore } from '../stores/useProjectStore';
import { autoBindShotCharacters } from '../components/storyboard/shotReference';
import { ProviderPicker } from '../components/ui/ProviderPicker';
import { OneKeySwarmBoard } from '../components/agent/OneKeySwarmBoard';
import { loadRoleMetas } from '../components/agent/swarmMeta';

const TERMINAL = new Set(['success', 'partial', 'failed']);

const stageTone = (stage: string) => {
  if (stage === '错误') return 'text-red-400';
  if (stage === '超时') return 'text-amber-300';
  if (stage === '警告') return 'text-amber-300';
  if (stage === '子代理集群') return 'text-accent-purple';
  if (stage === '导演计划' || stage === '启动') return 'text-emerald-300';
  if (stage === '预检') return '[color:var(--color-text-muted)]';
  return 'text-brand-light';
};

const statusMeta = (status: string) => {
  if (status === 'success') return { label: '制作完成', tone: 'text-emerald-400', dot: 'bg-emerald-400' };
  if (status === 'partial') return { label: '部分完成', tone: 'text-amber-300', dot: 'bg-amber-400' };
  if (status === 'failed') return { label: '制作失败', tone: 'text-red-400', dot: 'bg-red-400' };
  if (status === 'queued' || status === 'running') return { label: 'Agent 制作中', tone: 'text-brand-light', dot: 'bg-brand animate-pulse' };
  return { label: '待发起', tone: '[color:var(--color-text-muted)]', dot: 'bg-[color:var(--color-text-muted)]' };
};

/** 小型开关（深/浅色主题通用） */
const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; title?: string }> = ({
  checked, onChange, label, hint, title,
}) => (
  <button
    type="button" title={title}
    onClick={() => onChange(!checked)}
    className="w-full flex items-center justify-between gap-3 py-1 group text-left"
  >
    <span className="min-w-0">
      <span className="block text-[11.5px] [color:var(--color-text-main)] group-hover:text-brand-light transition-colors">{label}</span>
      {hint && <span className="block text-[9.5px] [color:var(--color-text-muted)] truncate">{hint}</span>}
    </span>
    <span className={`w-8 h-[18px] rounded-full relative shrink-0 transition-colors ${checked ? 'bg-brand' : 'bg-surface-hover/80 border border-white/70 dark:border-white/12'}`}>
      <span className={`absolute top-[2px] w-[13px] h-[13px] rounded-full bg-white shadow transition-all ${checked ? 'left-[16px]' : 'left-[2px]'}`} />
    </span>
  </button>
);

/** 分区卡片 */
const Card: React.FC<{ title: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> = ({
  title, icon, right, children,
}) => (
  <div className="rounded-2xl border border-white/70 dark:border-white/12 bg-surface-hover/80 dark:bg-black/40 p-3.5 space-y-2.5">
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="text-[11px] font-bold [color:var(--color-text-main)]">{title}</span>
      <span className="flex-1" />
      {right}
    </div>
    {children}
  </div>
);

/** 标签按钮 */
const TabBtn: React.FC<{ active: boolean; onClick: () => void; icon?: React.ReactNode; label: string; count?: number }> = ({
  active, onClick, icon, label, count,
}) => (
  <button
    type="button" onClick={onClick}
    className={`px-3 h-8 rounded-lg text-[11.5px] font-medium inline-flex items-center gap-1.5 transition-colors ${
      active
        ? 'bg-surface/80 text-brand-light border border-brand/30 shadow-sm'
        : 'border border-transparent [color:var(--color-text-muted)] hover:bg-surface/80'
    }`}
  >
    {icon}{label}
    {typeof count === 'number' && count > 0 && (
      <span className={`text-[9.5px] px-1.5 rounded-full ${active ? 'bg-brand/15 text-brand-light' : 'bg-surface-hover/80'}`}>{count}</span>
    )}
  </button>
);

/** 缩略图格 */
const Thumb: React.FC<{
  url?: string; badge?: string; sub?: string; tone?: 'video' | 'image' | 'pending' | 'plain';
  onClick?: () => void; title?: string;
}> = ({ url, badge, sub, tone = 'plain', onClick, title }) => (
  <button
    type="button" title={title} onClick={onClick}
    className={`relative aspect-square rounded-xl overflow-hidden border transition-all cursor-pointer group ${
      tone === 'video' ? 'border-emerald-500/45 hover:border-emerald-400'
        : tone === 'image' ? 'border-sky-500/35 hover:border-sky-400'
          : 'border-white/70 dark:border-white/12 hover:border-brand/50'
    } bg-surface/80 hover:ring-2 hover:ring-brand/25`}
  >
    {url
      ? <img src={resolveMediaUrl(url)} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-300" />
      : <span className="absolute inset-0 flex items-center justify-center text-[9px] [color:var(--color-text-muted)]">{sub || '待生成'}</span>}
    {badge && (
      <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/75 to-transparent text-white text-[9px] px-1.5 pt-3 pb-0.5 truncate text-left">
        {badge}
      </span>
    )}
  </button>
);

export const OneKeyStudioView: React.FC = () => {
  // ── 配置 ──
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [aspect, setAspect] = useState('9:16');
  const [maxShots, setMaxShots] = useState(12);
  const [imageProvider, setImageProvider] = useState('');
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
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* ══ 顶栏 ══ */}
      <header className="h-14 px-4 border-b border-white/70 dark:border-white/12 bg-surface/80 dark:bg-black/45 backdrop-blur flex items-center gap-3 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-brand flex items-center justify-center shadow-lg shadow-amber-500/20 shrink-0">
          <Clapperboard className="w-4.5 h-4.5 text-white" />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-bold [color:var(--color-text-main)] flex items-center gap-2 leading-tight">
            成片工作室
            <span className="text-[9.5px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25 font-medium">
              Agent 集群
            </span>
          </div>
          <div className="text-[10px] [color:var(--color-text-muted)]">总导演自主编排 · todolist 实时计划 · 子代理集群 · 产物验收</div>
        </div>
        <div className="flex-1" />
        {taskId && (
          <span className={`text-[10.5px] px-2.5 py-1 rounded-full border border-white/70 dark:border-white/12 bg-surface/80 inline-flex items-center gap-1.5 ${sm.tone}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} />{sm.label} · {progress}%
          </span>
        )}
        <div className="relative">
          <button
            onClick={() => { setShowHistory((v) => !v); refreshHistory(); }}
            className="h-8 px-3 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11.5px] font-medium [color:var(--color-text-main)] hover:bg-surface-hover/80 inline-flex items-center gap-1.5"
          >
            <History className="w-3.5 h-3.5" />历史
            <span className="text-[10px] [color:var(--color-text-muted)]">{history.length}</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
          </button>
          {showHistory && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShowHistory(false)} />
              <div className="absolute right-0 top-[calc(100%+8px)] w-[340px] max-h-[380px] overflow-y-auto custom-scrollbar z-40 bg-surface/80 border border-white/70 dark:border-white/12 rounded-2xl shadow-2xl p-2">
                {history.length === 0 && <div className="px-3 py-6 text-[11px] text-center [color:var(--color-text-muted)]">暂无历史任务</div>}
                {history.map((t) => {
                  const hm = statusMeta(t.status || '');
                  return (
                    <button
                      key={t.task_id}
                      onClick={() => {
                        setTaskId(t.task_id); setShowHistory(false);
                        setTitle(t.title || ''); setResult(null); setError(null);
                        setStatus(t.status || 'running'); setProgress(t.progress || 0);
                        setTodos([]); setCenterTab('shots');
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-xl hover:bg-surface/80 flex items-center gap-2.5 ${taskId === t.task_id ? 'bg-brand/10' : ''}`}
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${hm.dot}`} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-[11.5px] [color:var(--color-text-main)] truncate">{t.title || t.task_id}</span>
                        <span className="block text-[10px] [color:var(--color-text-muted)] truncate">
                          {t.team_name || '默认简化剧组'} · {t.progress || 0}% · {t.created_at || ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => { setTaskId(null); setResult(null); setError(null); setStatus('idle'); setLogs([]); setProgress(0); setSubagentMap({}); setTodos([]); refreshHistory(); }}
          className="h-8 px-3 rounded-lg bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light inline-flex items-center gap-1.5 shadow-lg shadow-brand/20"
        >
          <PlusCircle className="w-3.5 h-3.5" />新建任务
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* ══ 左：创作配置 ══ */}
        <aside className="w-[300px] shrink-0 border-r border-white/70 dark:border-white/12 bg-surface/80 dark:bg-black/30 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 space-y-3">
            <Card title="故事" icon={<Sparkles className="w-3.5 h-3.5 text-amber-400" />}>
              <input
                value={title} onChange={(e) => setTitle(e.target.value)} placeholder="成片标题（可选）"
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs [color:var(--color-text-main)] placeholder-[color:var(--color-text-muted)] focus:outline-none focus:border-brand/60"
              />
              <textarea
                value={text} onChange={(e) => setText(e.target.value)} rows={9}
                placeholder="粘贴小说章节 / 故事梗概（≥20字）。总导演 Agent 会先写下 todolist 计划，然后自主编排全流程（流程不写死，计划实时可见）。"
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-3 text-xs leading-relaxed [color:var(--color-text-main)] placeholder-[color:var(--color-text-muted)] focus:outline-none focus:border-brand/60 resize-y custom-scrollbar"
              />
              <div className="flex justify-between text-[9.5px] [color:var(--color-text-muted)]">
                <span>整章粘贴效果最好</span>
                <span className={text.length >= 20 ? 'text-emerald-400' : ''}>{text.length} 字</span>
              </div>
            </Card>

            <Card title="生成源" icon={<Zap className="w-3.5 h-3.5 text-brand-light" />}>
              <div>
                <div className="text-[10.5px] [color:var(--color-text-muted)] mb-1">生图源<span className="ml-1 opacity-70">（角色表 / 场景空镜）</span></div>
                <ProviderPicker kind="image" value={imageProvider} onChange={setImageProvider} compact placeholder="— 自动 —" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10.5px] [color:var(--color-text-muted)] mb-1">视频源</div>
                  <ProviderPicker kind="video" value={videoProvider} onChange={setVideoProvider} compact placeholder="— 自动 —" capability="i2v" />
                </div>
                <div>
                  <div className="text-[10.5px] [color:var(--color-text-muted)] mb-1">配音源</div>
                  <ProviderPicker kind="audio" value={audioProvider} onChange={setAudioProvider} compact placeholder="— 自动 —" />
                </div>
              </div>
              <div className="text-[9.5px] leading-relaxed text-amber-300/85 bg-amber-500/8 border border-amber-500/20 rounded-lg px-2 py-1.5">
                视频源需支持参考图（角色多视图 + 场景参考）；生视频工具会自动抽帧，便于 Agent 自查成片。
              </div>
            </Card>

            <Card title="导演组" icon={<Users className="w-3.5 h-3.5 text-accent-purple" />}>
              <select
                value={teamId} onChange={(e) => applyTeam(e.target.value)}
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl px-2.5 py-2 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand/60"
              >
                <option value="studio-default">默认简化剧组（资产复用 + 多参考 + 风格锁定 + 产物验收）</option>
                {teams.filter((t) => t.id !== 'studio-default').map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.qa_gate ? ' · 质检门' : ''}</option>
                ))}
              </select>
              <div className="text-[9.5px] leading-relaxed [color:var(--color-text-muted)] line-clamp-3">
                {teams.find((t) => t?.id === teamId)?.description
                  || '无固定流程：总导演 Agent 用 todolist 自主制定计划并执行（工具与成员均可自由调度）。'}
              </div>
            </Card>

            <Card title="成片选项" icon={<LayoutGrid className="w-3.5 h-3.5 text-brand-light" />}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] [color:var(--color-text-muted)]">画幅</span>
                <div className="inline-flex rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 p-0.5">
                  {[['9:16', '竖屏'], ['16:9', '横屏'], ['1:1', '方形']].map(([v, label]) => (
                    <button
                      key={v} type="button" onClick={() => setAspect(v)}
                      className={`px-2.5 py-1 rounded-md text-[10.5px] font-medium transition-colors ${
                        aspect === v ? 'bg-surface/80 text-brand-light shadow-sm' : '[color:var(--color-text-muted)] hover:text-[color:var(--color-text-main)]'
                      }`}
                    >{label}</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10.5px] [color:var(--color-text-muted)] shrink-0">最多分镜</span>
                <input
                  type="range" min={1} max={30} value={maxShots}
                  onChange={(e) => setMaxShots(Math.max(1, Math.min(30, parseInt(e.target.value) || 12)))}
                  className="flex-1 accent-brand h-1"
                />
                <span className="w-7 text-center text-[11px] font-mono text-brand-light">{maxShots}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] [color:var(--color-text-muted)] shrink-0">提示词技能</span>
                <select
                  value={promptSkill} onChange={(e) => setPromptSkill(e.target.value)}
                  title="指定模型写提示词时使用的技能：视频首选 minimax-h3-prompt（H3 三字段），通用兜底 prompt-basics（六要素）；不指定则由导演自选"
                  className="flex-1 min-w-0 bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-1 text-[10.5px] [color:var(--color-text-main)] focus:outline-none focus:border-brand/60"
                >
                  <option value="">自动（导演自选，六要素兜底）</option>
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
              <div className="text-[9px] leading-relaxed [color:var(--color-text-muted)]">
                {promptSkill
                  ? `已指定「${promptSkill}」：写/改提示词前 Agent 会先读取该技能并按结构产出`
                  : '不指定技能时，工具会按「主体+动作+环境+光线+运镜+风格」六要素组装兜底提示词'}
              </div>
              <div className="border-t border-white/50 dark:border-white/10 pt-1.5 space-y-0.5">
                <Switch checked={genRoles} onChange={setGenRoles} label="补齐角色资产" hint="已有三视图/形象自动复用" />
                <Switch checked={enableVideo} onChange={setEnableVideo} label="视频生成" hint="逐镜参考生视频（成片核心）" />
                <Switch checked={keyframeMode} onChange={setKeyframeMode} label="先生成分镜画面" hint="默认关；开启后走首帧 i2v" title="默认关：直接用资产参考生视频（r2v）" />
              </div>
            </Card>

            {error && (
              <div className="text-[10.5px] text-red-300 leading-relaxed bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                ⚠️ {error}
              </div>
            )}
          </div>

          {/* 发起按钮（吸底） */}
          <div className="p-3 border-t border-white/70 dark:border-white/12 bg-surface/80 dark:bg-black/45 shrink-0">
            <button
              onClick={() => void handleRun()}
              disabled={running}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-amber-500 to-brand text-white text-[13px] font-bold shadow-lg shadow-brand/25 inline-flex items-center justify-center gap-2 disabled:opacity-50 hover:brightness-110 transition-all"
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {running ? 'Agent 制作中…' : done || status === 'failed' ? '再次发起成片' : '开始成片'}
            </button>
            <div className="text-[9.5px] [color:var(--color-text-muted)] text-center mt-1.5">
              计划与进度来自导演的 todolist · 流程不写死，由 Agent 自主决定
            </div>
          </div>
        </aside>

        {/* ══ 中：生产看板 ══ */}
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* 状态卡 */}
          <div className="px-4 pt-4 pb-3 shrink-0">
            <div className="rounded-2xl border border-white/70 dark:border-white/12 bg-gradient-to-r from-brand/12 via-amber-500/6 to-transparent p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                  running ? 'bg-brand/15 border-brand/30' : done ? 'bg-emerald-500/15 border-emerald-500/30' : status === 'failed' ? 'bg-red-500/15 border-red-500/30' : 'bg-surface/80 border-white/70 dark:border-white/12'
                }`}>
                  {running && <Loader2 className="w-5 h-5 text-brand-light animate-spin" />}
                  {done && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                  {status === 'failed' && <AlertTriangle className="w-5 h-5 text-red-400" />}
                  {!running && !done && status !== 'failed' && <Clapperboard className="w-5 h-5 [color:var(--color-text-muted)]" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-bold [color:var(--color-text-main)]">{sm.label}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full border font-medium flex items-center gap-1 bg-brand/10 text-brand-light border-brand/25">
                      <Bot className="w-3 h-3" />{ranTeamName ? `导演组 · ${ranTeamName}` : '默认简化剧组'}
                    </span>
                  </div>
                  <div className="text-[10px] [color:var(--color-text-muted)] mt-0.5 truncate">
                    {running
                      ? (todos.find((t) => t?.status === 'in_progress')?.content || 'Agent 正在自主编排…')
                      : done
                        ? `角色 ${charReady}/${characters.length} · 场景 ${sceneReady}/${sceneList.length} · 成片 ${videoDone}/${shots.length}`
                        : '粘贴文本后点击「开始成片」，总导演 Agent 将自主编排全流程'}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-xl font-bold font-mono ${running ? 'text-brand-light' : done ? 'text-emerald-400' : '[color:var(--color-text-main)]'}`}>{progress}<span className="text-[11px] opacity-60">%</span></div>
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-surface/80 overflow-hidden mt-3">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${done ? 'bg-emerald-400' : 'bg-gradient-to-r from-brand to-amber-400'}`}
                  style={{ width: `${progress}%` }}
                />
              </div>
              {(characters.length > 0 || shots.length > 0) && (
                <div className="grid grid-cols-4 gap-2 mt-3">
                  {[
                    ['角色资产', charReady, characters.length],
                    ['场景空镜', sceneReady, sceneList.length],
                    ['分镜成片', videoDone, shots.length],
                    ['配音', shots.filter((s: any) => s?.audio_url).length, summary.voice_needed ?? '—'],
                  ].map(([label, a, b]) => (
                    <div key={String(label)} className="rounded-xl bg-surface-hover/80 dark:bg-black/40 border border-white/50 dark:border-white/10 px-2.5 py-1.5">
                      <div className="text-[12px] font-bold font-mono [color:var(--color-text-main)]">
                        {a}<span className="text-[10px] opacity-50">/{b}</span>
                      </div>
                      <div className="text-[9px] [color:var(--color-text-muted)]">{label}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 导演计划 / 工具活动 */}
            {(todos.length > 0 || (stageList.length > 0 && running)) && (
              <div className="mt-2.5 rounded-2xl border border-white/70 dark:border-white/12 bg-surface/80 dark:bg-black/35 px-3.5 py-2.5">
                {todos.length > 0 ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-bold text-brand-light flex items-center gap-1 shrink-0">
                      <Bot className="w-3 h-3" />导演计划 {todoCounts.done}/{todoCounts.total}
                    </span>
                    <div className="flex-1 flex flex-wrap gap-x-3 gap-y-1 min-w-0">
                      {todos.map((t: any, i: number) => (
                        <span key={i} className="text-[10px] inline-flex items-center gap-1 max-w-full">
                          {t.status === 'completed'
                            ? <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                            : t.status === 'in_progress'
                              ? <Loader2 className="w-3 h-3 text-brand-light animate-spin shrink-0" />
                              : <CircleDot className="w-3 h-3 [color:var(--color-text-muted)] shrink-0" />}
                          <span className={`truncate ${t.status === 'completed' ? '[color:var(--color-text-muted)] line-through' : t.status === 'in_progress' ? 'text-brand-light' : '[color:var(--color-text-muted)]'}`}>
                            {t.content}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-bold text-brand-light flex items-center gap-1 shrink-0">
                      <Loader2 className="w-3 h-3 animate-spin" />进行中
                    </span>
                    {stageList.slice(-8).map((s) => (
                      <span key={s.stage} className="text-[10px] px-2 py-0.5 rounded-full bg-surface/80 border border-white/70 dark:border-white/12 [color:var(--color-text-muted)]">
                        {s.stage}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 中部标签页 */}
          <div className="px-4 flex items-center gap-1 border-b border-white/70 dark:border-white/12 shrink-0">
            <TabBtn active={centerTab === 'shots'} onClick={() => setCenterTab('shots')} icon={<Film className="w-3.5 h-3.5" />} label="分镜" count={shots.length} />
            <TabBtn active={centerTab === 'swarm'} onClick={() => setCenterTab('swarm')} icon={<Bot className="w-3.5 h-3.5" />} label="子代理集群" count={Object.keys(subagentMap).length} />
            <TabBtn active={centerTab === 'logs'} onClick={() => setCenterTab('logs')} icon={<ScrollText className="w-3.5 h-3.5" />} label="实时日志" count={logs.length} />
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
            {centerTab === 'shots' && (
              shots.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] [color:var(--color-text-muted)]">点击缩略图预览 · 绿=成片 · 蓝=成图 · 灰=待生成 · 粉标=有配音</span>
                  </div>
                  <div className="grid grid-cols-5 md:grid-cols-7 xl:grid-cols-9 gap-2">
                    {shots.map((s: any) => (
                      <Thumb
                        key={s.id || s.shot_index}
                        url={s.image_url}
                        tone={s.video_url ? 'video' : s.image_url ? 'image' : 'pending'}
                        badge={`#${s.shot_index}`}
                        title={`#${s.shot_index} ${s.action_desc || ''}`}
                        onClick={() => {
                          if (s.video_url) openPreview('video', s.video_url, `分镜 #${s.shot_index} 成片`);
                          else if (s.image_url) openPreview('image', s.image_url, `分镜 #${s.shot_index} 成图`);
                        }}
                      />
                    ))}
                  </div>
                  {videoDone < shots.length && (
                    <div className="flex items-center gap-1.5 text-[10px] [color:var(--color-text-muted)]">
                      <Loader2 className="w-3 h-3 animate-spin text-brand-light" />
                      成片 {videoDone}/{shots.length} —— 异步视频生成中，完成后自动回写
                    </div>
                  )}
                </div>
              ) : (
                <EmptyState running={running} text={running ? 'Agent 正在拆解剧本，分镜生成后会出现在这里' : '发起任务后，这里会实时展示每一镜的成图/成片进度'} />
              )
            )}

            {centerTab === 'swarm' && <OneKeySwarmBoard subagents={subagentMap} />}

            {centerTab === 'logs' && (
              <div ref={logRef} className="h-full min-h-[300px] max-h-full overflow-y-auto rounded-2xl bg-surface/80 border border-white/70 dark:border-white/12 p-3.5 space-y-1 custom-scrollbar font-mono">
                {logs.length === 0 && <div className="text-[11px] [color:var(--color-text-muted)] font-sans">等待 Agent 上报进度…</div>}
                {logs.map((l: any, i: number) => (
                  <div key={i} className="text-[10.5px] leading-relaxed flex gap-2">
                    <span className={`font-bold shrink-0 ${stageTone(String(l.stage || ''))}`}>[{l.stage}]</span>
                    <span className="[color:var(--color-text-main)] break-all">{l.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>

        {/* ══ 右：产物廊 ══ */}
        <aside className="w-[340px] shrink-0 border-l border-white/70 dark:border-white/12 bg-surface/80 dark:bg-black/30 flex flex-col overflow-hidden">
          <div className="p-3.5 pb-2 shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold [color:var(--color-text-main)] flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5 text-brand" />产物廊
              </span>
              {result?.jianyin_draft && Object.keys(result.jianyin_draft).length > 0 && (
                <span className="text-[9.5px] px-2 py-0.5 rounded-full bg-emerald-500/12 border border-emerald-500/30 text-emerald-300">剪映已导出</span>
              )}
            </div>
            {/* 统计条 */}
            {result && (
              <div className="grid grid-cols-4 gap-1.5 mt-2.5">
                {[
                  ['角色', `${charReady}`],
                  ['场景', `${sceneReady}`],
                  ['成片', `${videoDone}`],
                  ['配音', `${shots.filter((s: any) => s?.audio_url).length}`],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-surface/80 border border-white/50 dark:border-white/10 py-1.5 text-center">
                    <div className="text-[13px] font-bold font-mono [color:var(--color-text-main)]">{v}</div>
                    <div className="text-[9px] [color:var(--color-text-muted)]">{k}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!result ? (
            <div className="flex-1 flex items-center justify-center px-8">
              <div className="text-center space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-surface/80 border border-white/70 dark:border-white/12 flex items-center justify-center mx-auto">
                  <ImageIcon className="w-6 h-6 [color:var(--color-text-muted)]" />
                </div>
                <div className="text-[11px] leading-relaxed [color:var(--color-text-muted)]">
                  发起任务后，这里实时展示<br />角色资产 · 场景空镜 · 分镜成片
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* 产物分类标签 */}
              <div className="px-3.5 flex items-center gap-1 border-b border-white/70 dark:border-white/12 shrink-0">
                <TabBtn active={assetTab === 'characters'} onClick={() => setAssetTab('characters')} icon={<Users className="w-3.5 h-3.5" />} label="角色" count={characters.length} />
                <TabBtn active={assetTab === 'scenes'} onClick={() => setAssetTab('scenes')} icon={<LayoutGrid className="w-3.5 h-3.5" />} label="场景" count={sceneList.length} />
                <TabBtn active={assetTab === 'shots'} onClick={() => setAssetTab('shots')} icon={<Film className="w-3.5 h-3.5" />} label="成片" count={shots.length} />
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 space-y-3">
                {assetTab === 'characters' && (
                  characters.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2">
                      {characters.map((c: any, i: number) => {
                        const img = c?.three_views?.front || c?.three_views?.three_quarter
                          || c?.three_views?.side || c?.avatar_url || '';
                        return (
                          <Thumb
                            key={c?.id || c?.name || i}
                            url={img}
                            badge={c?.name || ''}
                            sub="待生成"
                            title={`${c?.name || ''}${img ? '（点击预览）' : '（待生成）'}`}
                            onClick={() => openPreview('image', img, `角色资产 · ${c?.name || ''}`)}
                          />
                        );
                      })}
                    </div>
                  ) : <EmptyState running={running} text="还没有角色资产" />
                )}

                {assetTab === 'scenes' && (
                  sceneList.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2">
                      {sceneList.map((s: any, i: number) => (
                        <Thumb
                          key={s?.id || s?.scene_index || i}
                          url={s?.ref_image_url}
                          badge={`#${s?.scene_index ?? i + 1} ${s?.title || ''}`}
                          sub="待生成"
                          title={`场景 #${s?.scene_index ?? i + 1} ${s?.title || ''}`}
                          onClick={() => openPreview('image', s?.ref_image_url, `场景 #${s?.scene_index ?? i + 1} · ${s?.title || ''}`)}
                        />
                      ))}
                    </div>
                  ) : <EmptyState running={running} text="还没有场景空镜" />
                )}

                {assetTab === 'shots' && (
                  shots.length > 0 ? (
                    <div className="space-y-2">
                      {shots.map((s: any, i: number) => {
                        const has = !!(s?.video_url || s?.image_url);
                        return (
                          <div key={s?.id || s?.shot_index || i} className="flex items-center gap-2.5 rounded-xl border border-white/70 dark:border-white/12 bg-surface-hover/80 dark:bg-black/40 p-2">
                            <button
                              type="button"
                              title={s?.video_url ? '播放成片' : s?.image_url ? '预览成图' : '待生成'}
                              onClick={() => {
                                if (s?.video_url) openPreview('video', s.video_url, `分镜 #${s.shot_index} 成片`);
                                else if (s?.image_url) openPreview('image', s.image_url, `分镜 #${s.shot_index} 成图`);
                              }}
                              className={`relative w-16 h-10 rounded-lg overflow-hidden border shrink-0 cursor-pointer ${
                                s?.video_url ? 'border-emerald-500/45' : has ? 'border-white/70 dark:border-white/12' : 'border-white/70 dark:border-white/12 bg-surface/80'
                              }`}
                            >
                              {s?.image_url
                                ? <img src={resolveMediaUrl(s.image_url)} alt="" loading="lazy" className="w-full h-full object-cover" />
                                : <span className="absolute inset-0 flex items-center justify-center text-[8.5px] [color:var(--color-text-muted)]">{has ? '成片' : '待生成'}</span>}
                              {s?.video_url && (
                                <span className="absolute inset-0 bg-black/25 flex items-center justify-center">
                                  <Film className="w-3.5 h-3.5 text-white/90" />
                                </span>
                              )}
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className="text-[10.5px] [color:var(--color-text-main)] truncate">
                                <span className="font-mono text-brand-light mr-1.5">#{s?.shot_index}</span>
                                {s?.action_desc || s?.video_prompt || '—'}
                              </div>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                {s?.video_url
                                  ? <span className="text-[9px] text-emerald-300">✓ 成片</span>
                                  : <span className="text-[9px] [color:var(--color-text-muted)]">○ 待成片</span>}
                                {s?.audio_url && <span className="text-[9px] text-pink-400 inline-flex items-center gap-0.5"><Music className="w-2.5 h-2.5" />配音</span>}
                              </div>
                            </div>
                            {s?.audio_url && (
                              <button
                                type="button" title="试听配音"
                                onClick={() => openPreview('audio', s.audio_url, `分镜 #${s.shot_index} 配音`)}
                                className="w-7 h-7 rounded-lg border border-white/70 dark:border-white/12 bg-surface/80 hover:border-pink-400/50 flex items-center justify-center shrink-0"
                              >
                                <Music className="w-3 h-3 text-pink-400" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : <EmptyState running={running} text="还没有分镜产物" />
                )}

                {/* 风格 / 复用 / 告警 */}
                {summary.style_locked ? (
                  <div className="text-[10px] text-emerald-300/90 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" />全片风格已由大模型锁定，自动附加到所有生成
                  </div>
                ) : null}
                {summary.assets_reused > 0 && (
                  <div className="text-[10px] text-emerald-300/90">✓ 复用 {summary.assets_reused} 个已有角色资产（未重复定妆）</div>
                )}
                {Array.isArray(result?.ref_warnings) && result.ref_warnings.length > 0 && (
                  <div className="text-[10px] leading-relaxed text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl p-2.5 space-y-1">
                    {result.ref_warnings.map((w: string, i: number) => <div key={i}>⚠️ {w}</div>)}
                  </div>
                )}
                {!!result?.jianyin_draft && Object.keys(result.jianyin_draft).length > 0 && (
                  <div className="text-[10px] leading-relaxed text-emerald-300 break-all">
                    ✓ 剪映草稿：{result.jianyin_draft.draft_path || result.jianyin_draft.path || '见导出目录'}
                  </div>
                )}
              </div>

              {/* 底部动作 */}
              {result?.project && (
                <div className="p-3 border-t border-white/70 dark:border-white/12 bg-surface/80 dark:bg-black/45 shrink-0 space-y-1.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => void handleOpenProject('studio')}
                      disabled={saving}
                      className="h-9 rounded-xl bg-brand text-white text-[11px] font-bold inline-flex items-center justify-center gap-1.5 hover:bg-brand-light disabled:opacity-50"
                    >
                      <Layers className="w-3.5 h-3.5" />分镜台精修
                    </button>
                    <button
                      onClick={() => void handleOpenProject('canvas')}
                      disabled={saving}
                      className="h-9 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] font-bold [color:var(--color-text-main)] inline-flex items-center justify-center gap-1.5 hover:bg-surface/80 disabled:opacity-50"
                    >
                      <ImageIcon className="w-3.5 h-3.5" />画布编辑
                    </button>
                  </div>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('open-export-modal'))}
                    className="w-full h-9 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] font-bold [color:var(--color-text-main)] inline-flex items-center justify-center gap-1.5 hover:bg-surface/80"
                  >
                    <Download className="w-3.5 h-3.5" />再导出剪映
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
          className="fixed inset-0 z-[120] bg-black/85 backdrop-blur-sm flex items-center justify-center p-8"
          onClick={() => setPreview(null)}
        >
          <div className="absolute top-4 right-5 flex items-center gap-3 text-white/80 text-xs" onClick={(e) => e.stopPropagation()}>
            <span className="max-w-[50vw] truncate">{preview.title}</span>
            <button
              className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20"
              onClick={() => setPreview(null)}
            >关闭 ✕</button>
          </div>
          <div className="max-w-[92vw] max-h-[88vh]" onClick={(e) => e.stopPropagation()}>
            {preview.kind === 'video' && (
              <video src={resolveMediaUrl(preview.url)} controls autoPlay className="max-w-[92vw] max-h-[88vh] rounded-xl" />
            )}
            {preview.kind === 'image' && (
              <img src={resolveMediaUrl(preview.url)} alt={preview.title} className="max-w-[92vw] max-h-[88vh] object-contain rounded-xl" />
            )}
            {preview.kind === 'audio' && (
              <div className="bg-surface/80 rounded-xl p-4">
                <audio src={resolveMediaUrl(preview.url)} controls autoPlay className="w-[420px] max-w-[80vw]" />
              </div>
            )}
          </div>
          <div className="absolute bottom-4 text-[11px] text-white/50">点击空白处或按 Esc 关闭</div>
        </div>
      )}
    </div>
  );
};

/** 空状态 */
const EmptyState: React.FC<{ running: boolean; text: string }> = ({ running, text }) => (
  <div className="h-full min-h-[220px] flex items-center justify-center">
    <div className="text-center space-y-3">
      <div className="w-12 h-12 rounded-2xl bg-surface/80 border border-white/70 dark:border-white/12 flex items-center justify-center mx-auto">
        {running ? <Loader2 className="w-5 h-5 text-brand-light animate-spin" /> : <Clapperboard className="w-5 h-5 [color:var(--color-text-muted)]" />}
      </div>
      <div className="text-[11px] [color:var(--color-text-muted)] max-w-[280px] leading-relaxed">{text}</div>
    </div>
  </div>
);
