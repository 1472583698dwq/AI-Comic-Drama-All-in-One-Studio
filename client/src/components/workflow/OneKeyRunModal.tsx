// -*- coding: utf-8 -*-
/**
 * 一键成片 Agent Modal（桌面端）
 * 长文本 → 后台编排（经典 6 阶段流水线 / 智能体集群），3s 轮询进度，
 * agent 模式展示子代理花名册（角色/批次/状态/耗时），完成后落盘为正式项目并跳转分镜台。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Zap, Loader2, CheckCircle2, AlertTriangle, Clapperboard, Bot, Cog } from 'lucide-react';
import { apiService } from '../../services/api';
import { useProjectStore } from '../../stores/useProjectStore';
import { autoBindShotCharacters } from '../storyboard/shotReference';
import { ProviderPicker } from '../ui/ProviderPicker';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { AgentSwarmPanel } from '../agent/AgentSwarmPanel';
import type { SubAgentInfo } from '../agent/agentTypes';

interface Props { isOpen: boolean; onClose: () => void; }

export const OneKeyRunModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [aspect, setAspect] = useState('9:16');
  const [maxShots, setMaxShots] = useState(12);
  const [imageProvider, setImageProvider] = useState('');
  const [videoProvider, setVideoProvider] = useState('');
  const [audioProvider, setAudioProvider] = useState('');
  const [enableVideo, setEnableVideo] = useState(true);
  const [genRoles, setGenRoles] = useState(true);
  const [engine, setEngine] = useState<'agent' | 'pipeline'>('agent');
  const [ranEngine, setRanEngine] = useState<'agent' | 'pipeline'>('agent');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('idle');
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<any[]>([]);
  const [subagentMap, setSubagentMap] = useState<Record<string, any>>({});
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const TERMINAL = new Set(['success', 'partial', 'failed']);
    const poll = async (): Promise<string | undefined> => {
      try {
        const t = await apiService.onekeyStatus(taskId);
        if (stop) return t.status;
        setStatus(t.status);
        setProgress(t.progress || 0);
        setLogs(t.logs || []);
        setSubagentMap(t.subagents || {});
        if (t.status === 'success' || t.status === 'partial') {
          setResult(t.result);
        } else if (t.status === 'failed') {
          setError(t.error || '任务失败');
        }
        return t.status;
      } catch (e: any) {
        if (!stop) setError(e?.message || '轮询失败');
        return undefined;
      }
    };
    const tick = async () => {
      const s = await poll();
      if (s && TERMINAL.has(s) && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    tick();
    timer = setInterval(tick, 3000);
    return () => { stop = true; if (timer) clearInterval(timer); };
  }, [taskId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  // 任务花名册 → 共享集群面板数据模型（角色图标/批次分组复用）
  const swarmList = useMemo<Record<string, SubAgentInfo>>(() => {
    const out: Record<string, SubAgentInfo> = {};
    for (const [id, s] of Object.entries(subagentMap || {})) {
      const rec = s as any;
      out[id] = {
        id,
        agent: rec.agent || '',
        task: rec.task || '',
        status: rec.status || 'running',
        tool: rec.tool || '',
        elapsedMs: rec.elapsed_ms || 0,
        batchId: rec.batch_id || '',
        error: rec.error || '',
        startedAt: rec.started_at ? rec.started_at * 1000 : undefined,
      };
    }
    return out;
  }, [subagentMap]);

  const stageTone = (stage: string) => {
    if (stage.startsWith('Stage')) return 'text-brand-light';
    if (stage === '子代理集群') return 'text-accent-purple';
    if (stage === '错误') return 'text-red-400';
    if (stage === '超时') return 'text-amber-300';
    return 'text-gray-400';
  };

  useEscapeClose(isOpen, onClose);
  if (!isOpen) return null;
  const running = status === 'queued' || status === 'running';
  const done = status === 'success' || status === 'partial';

  const handleRun = async () => {
    if (text.trim().length < 20) { setError('文本太短（至少20字），请粘贴小说章节或故事梗概'); return; }
    setError(null); setResult(null); setLogs([]); setProgress(0); setStatus('queued');
    setSubagentMap({}); setRanEngine(engine);
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
        engine,
      });
      setTaskId(r.task_id);
    } catch (e: any) {
      setError(e?.message || '提交失败');
      setStatus('idle');
    }
  };

  const handleOpenProject = async () => {
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
      // 落盘前自动绑定人物（说话人 + 正文提及），免逐镜手绑
      try { autoBindShotCharacters(proj as any); } catch {}
      await apiService.saveProjectContent(pid, { ...proj, id: pid });
      await useProjectStore.getState().loadActiveProject(pid);
      useProjectStore.getState().setActiveTab('studio' as any);
      onClose();
    } catch (e: any) {
      setError(e?.message || '落盘失败');
    } finally {
      setSaving(false);
    }
  };

  const summary = result?.summary || {};

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[88vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl">
        <div className="h-13 px-5 py-3 border-b border-border flex items-center justify-between bg-surface-secondary/50 shrink-0">
          <span className="text-sm font-bold text-white flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" /> 一键成片 Agent
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">拆解→角色→生图→视频→配音→导出</span>
          </span>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
          {!taskId && (
            <>
              <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="成片标题（可选）" className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
              <textarea value={text} onChange={e=>setText(e.target.value)} rows={8} placeholder="粘贴小说章节 / 故事梗概（≥20字）。Agent 将自动拆解角色分镜、定妆、生图、转视频、配音并导出剪映草稿…" className="w-full bg-surface-secondary border border-border rounded-xl p-3 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-y" />
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[11px] text-gray-400 mb-1">生图源</div>
                  <ProviderPicker kind="image" value={imageProvider} onChange={(pid)=>setImageProvider(pid)} compact placeholder="— 自动 —" />
                </div>
                <div>
                  <div className="text-[11px] text-gray-400 mb-1">视频源</div>
                  <ProviderPicker kind="video" value={videoProvider} onChange={(pid)=>setVideoProvider(pid)} compact placeholder="— 自动 —" capability="i2v" />
                </div>
                <div>
                  <div className="text-[11px] text-gray-400 mb-1">配音源</div>
                  <ProviderPicker kind="audio" value={audioProvider} onChange={(pid)=>setAudioProvider(pid)} compact placeholder="— 自动 —" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[11px] text-gray-400">编排引擎</span>
                <div className="flex items-center rounded-xl bg-surface-secondary border border-border p-0.5">
                  <button
                    onClick={() => setEngine('agent')}
                    title="总导演 Agent + 专家子代理集群：同质任务批量并行，失败不阻塞整体"
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${engine === 'agent' ? 'bg-brand/20 text-brand-light' : 'text-gray-500 hover:text-white'}`}
                  >🤖 智能体集群</button>
                  <button
                    onClick={() => setEngine('pipeline')}
                    title="固定 6 阶段确定性流水线（稳定串行）"
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${engine === 'pipeline' ? 'bg-gray-500/25 text-white' : 'text-gray-500 hover:text-white'}`}
                  >⚙️ 经典流水线</button>
                </div>
                <span className="text-[10px] text-gray-500">
                  {engine === 'agent'
                    ? '总导演规划 + 子代理并行（拆解→定妆→生图→视频→配音→导出），单点失败不阻塞全片'
                    : '固定 6 阶段顺序执行（无并行调度与自愈）'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-300">
                <label className="flex items-center gap-1.5">画幅
                  <select value={aspect} onChange={e=>setAspect(e.target.value)} className="bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs text-white"><option value="9:16">竖屏 9:16</option><option value="16:9">横屏 16:9</option><option value="1:1">方形 1:1</option></select>
                </label>
                <label className="flex items-center gap-1.5">最多分镜
                  <input type="number" min={1} max={30} value={maxShots} onChange={e=>setMaxShots(Math.max(1, Math.min(30, parseInt(e.target.value) || 12)))} className="w-16 bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs text-white" />
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={genRoles} onChange={e=>setGenRoles(e.target.checked)} className="accent-brand" /> 角色定妆</label>
                <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={enableVideo} onChange={e=>setEnableVideo(e.target.checked)} className="accent-brand" /> 图生视频</label>
              </div>
            </>
          )}

          {taskId && (
            <>
              <div>
                <div className="flex items-center justify-between text-xs text-gray-300 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    {running && <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-light" />}
                    {done && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                    {status === 'failed' && <AlertTriangle className="w-3.5 h-3.5 text-red-400" />}
                    <span className="font-bold">{running ? 'Agent 制作中…' : done ? '制作完成' : status === 'failed' ? '制作失败' : status}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-bold flex items-center gap-1 ${ranEngine === 'agent' ? 'bg-brand/10 text-brand-light border-brand/30' : 'bg-surface-tertiary text-gray-300 border-border'}`}>
                      {ranEngine === 'agent' ? <Bot className="w-3 h-3" /> : <Cog className="w-3 h-3" />}
                      {ranEngine === 'agent' ? '智能体集群' : '经典流水线'}
                    </span>
                  </span>
                  <span className="font-mono text-brand-light">{progress}%</span>
                </div>
                <div className="h-2 rounded-full bg-surface-secondary overflow-hidden"><div className="h-full bg-gradient-to-r from-brand to-amber-400 transition-all" style={{ width: `${progress}%` }} /></div>
              </div>
              {ranEngine === 'agent' && Object.keys(swarmList).length > 0 && (
                <AgentSwarmPanel subagents={swarmList} />
              )}
              <div ref={logRef} className="h-48 overflow-y-auto rounded-xl bg-surface-secondary border border-border p-3 space-y-1 custom-scrollbar">
                {logs.length === 0 && <div className="text-[11px] text-gray-500">等待 Agent 上报进度…</div>}
                {logs.map((l: any, i: number) => (
                  <div key={i} className="text-[11px] leading-relaxed">
                    <span className={`font-bold ${stageTone(String(l.stage || ''))}`}>[{l.stage}]</span>{' '}
                    <span className="text-gray-300">{l.message}</span>
                  </div>
                ))}
              </div>
              {done && (
                <div className="grid grid-cols-4 gap-2 text-center">
                  {[
                    ['角色', summary.characters ?? '—'],
                    ['分镜', summary.total_shots ?? '—'],
                    ['成图', `${summary.images_generated ?? 0}`],
                    ['成片', `${summary.videos_generated ?? 0}${summary.videos_pending ? `(+${summary.videos_pending}异步)` : ''}`],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-xl bg-surface-secondary border border-border p-2.5"><div className="text-lg font-bold text-white">{v}</div><div className="text-[10px] text-gray-500">{k}</div></div>
                  ))}
                </div>
              )}
            </>
          )}

          {error && <div className="px-3 py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-300">{error}</div>}
        </div>

        <div className="p-4 border-t border-border flex justify-end gap-2 shrink-0">
          {!taskId
            ? (<>
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white">取消</button>
              <button onClick={handleRun} className="px-5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-brand text-white text-xs font-bold flex items-center gap-1.5"><Clapperboard className="w-3.5 h-3.5" /> 开始一键成片</button>
            </>)
            : (<>
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-surface-secondary border border-border text-xs text-white">{done ? '稍后查看' : '后台运行并关闭'}</button>
              {done && <button onClick={handleOpenProject} disabled={saving} className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold disabled:opacity-50">{saving ? '正在落盘…' : '打开到分镜台'}</button>}
            </>)}
        </div>
      </div>
    </div>
  );
};
