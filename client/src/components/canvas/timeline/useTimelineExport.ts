// -*- coding: utf-8 -*-
/**
 * 时间线导出：同一个实现同时服务卡片上的「下载」与全屏编辑器的「导出」菜单。
 *
 * 两条出口：
 * - MP4：`POST /timeline/merge` 提交长任务 → 轮询 `/timeline/tasks/{id}` 拿进度与产物；
 * - 剪映草稿：`POST /timeline/draft` 同步返回草稿目录（ffmpeg 缺失时的降级出口）。
 *
 * 引擎就绪态在挂载时取一次：ffmpeg 不在位时前端直接把「导出为 MP4」置灰并给出安装指
 * 引，而不是让用户点了按钮才看到 503。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiService, type TimelineEngineStatus, type TimelineTask } from '../../../services/api';
import { resolveMediaUrl } from '../../../utils/devOrigin';
import { timelineTotal, type TimelineClip } from '../../../types/timeline';

const POLL_MS = 1200;
const POLL_MAX = 900; // 最多轮询约 18 分钟，覆盖 30 分钟量级成片的极端情况

export interface TimelineExportMp4State {
  status: 'idle' | 'running' | 'success' | 'error';
  task: TimelineTask | null;
  stage: string;
  progress: number;
  error: string | null;
}

export interface TimelineExportDraftState {
  status: 'idle' | 'running' | 'success' | 'error';
  result: any;
  error: string | null;
}

export interface TimelineExportApi {
  engine: TimelineEngineStatus | null;
  engineLoading: boolean;
  refreshEngine: () => void;
  mp4: TimelineExportMp4State;
  draft: TimelineExportDraftState;
  busy: boolean;
  exportMp4: () => Promise<void>;
  exportDraft: () => Promise<void>;
  downloadResult: () => void;
  openResultFolder: () => void;
}

const IDLE_MP4: TimelineExportMp4State = { status: 'idle', task: null, stage: '', progress: 0, error: null };
const IDLE_DRAFT: TimelineExportDraftState = { status: 'idle', result: null, error: null };

function dirnameOf(path?: string): string {
  if (!path) return '';
  const norm = path.replace(/\\/g, '/');
  return norm.slice(0, norm.lastIndexOf('/'));
}

/**
 * 出网前置校验：`blob:`/`data:` 只是浏览器内存地址，后端合成时根本读不到。
 * 素材选择器的本地上传在「落素材库失败」时会退化成 blob 临时地址，这里提前拦下并
 * 说清原因，而不是让用户等到合成阶段才看到「素材不存在」。
 */
function clipPreflight(clips: TimelineClip[]): string | null {
  if (!clips.length) return '时间线为空：请先连入上游视频或添加素材';
  const temp = clips.filter((c) => /^(blob:|data:)/.test(c.url));
  if (temp.length) {
    return `有 ${temp.length} 个本地文件还只是临时地址（未成功存入素材库）：${temp
      .slice(0, 2)
      .map((c) => c.name)
      .join('、')}。请重新添加（需素材库可用）。`;
  }
  return null;
}

export function useTimelineExport(params: {
  clips: TimelineClip[];
  title: string;
  aspectRatio?: string;
  projectId?: string;
}): TimelineExportApi {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [engine, setEngine] = useState<TimelineEngineStatus | null>(null);
  const [engineLoading, setEngineLoading] = useState(true);
  const [mp4, setMp4] = useState<TimelineExportMp4State>(IDLE_MP4);
  const [draft, setDraft] = useState<TimelineExportDraftState>(IDLE_DRAFT);
  const pollTimer = useRef<number | null>(null);
  const pollCount = useRef(0);

  const stopPoll = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const refreshEngine = useCallback(() => {
    setEngineLoading(true);
    apiService
      .timelineEngine()
      .then((st) => setEngine(st))
      .catch((e) => {
        console.error('[Timeline] 引擎自检失败', e);
        setEngine(null);
      })
      .finally(() => setEngineLoading(false));
  }, []);

  useEffect(() => {
    refreshEngine();
    return stopPoll;
  }, [refreshEngine, stopPoll]);

  /**
   * 成片落盘后**直接打开导出文件夹**：不在页面里播放、也不自动触发浏览器下载
   * ——成片是给剪映/播放器用的，用户要的就是「在文件夹里看到它」。
   * 用 ref 记账，保证同一个 task 只弹一次资源管理器窗口。
   */
  const autoOpenedTask = useRef<string | null>(null);
  const openFolderOf = useCallback((task?: TimelineTask | null) => {
    const dir = dirnameOf(task?.output_path);
    if (!dir) return;
    apiService.openFolder(dir).catch((e) => console.error('[Timeline] 打开导出目录失败', e));
  }, []);

  const pollTask = useCallback(
    (taskId: string) => {
      stopPoll();
      pollCount.current = 0;
      pollTimer.current = window.setInterval(() => {
        pollCount.current += 1;
        apiService
          .getTimelineTask(taskId)
          .then((task) => {
            setMp4({ status: 'running', task, stage: task.stage || '合成', progress: task.progress || 0, error: null });
            if (task.status === 'success') {
              stopPoll();
              setMp4({ status: 'success', task, stage: '完成', progress: 100, error: null });
              if (autoOpenedTask.current !== task.task_id) {
                autoOpenedTask.current = task.task_id;
                openFolderOf(task);
              }
            } else if (task.status === 'error') {
              stopPoll();
              setMp4({ status: 'error', task, stage: '失败', progress: 100, error: task.error || '合成失败' });
            }
          })
          .catch((e) => {
            stopPoll();
            setMp4({ status: 'error', task: null, stage: '失败', progress: 100, error: e?.message || String(e) });
          });
        if (pollCount.current > POLL_MAX) {
          stopPoll();
          setMp4((prev) => ({ ...prev, status: 'error', error: '任务轮询超时，请查看导出目录确认结果' }));
        }
      }, POLL_MS);
    },
    [stopPoll, openFolderOf],
  );

  const exportMp4 = useCallback(async () => {
    const { clips, title, aspectRatio, projectId } = paramsRef.current;
    const blocked = clipPreflight(clips);
    if (blocked) {
      setMp4({ ...IDLE_MP4, status: 'error', error: blocked });
      return;
    }
    if (engine && !engine.available) {
      setMp4({ ...IDLE_MP4, status: 'error', error: `${engine.ffmpeg_hint} ${engine.draft_hint}`.trim() });
      return;
    }
    setMp4({ ...IDLE_MP4, status: 'running', stage: '提交任务', progress: 3 });
    try {
      const res = await apiService.mergeTimeline({
        clips,
        title,
        project_id: projectId,
        aspect_ratio: aspectRatio,
      });
      setMp4({ status: 'running', task: null, stage: '合成', progress: 8, error: null });
      pollTask(res.task_id);
    } catch (e: any) {
      const message = e?.message || String(e);
      setMp4({ status: 'error', task: null, stage: '失败', progress: 100, error: message });
      // ffmpeg 中途被卸载/未就绪：顺带刷新引擎态，让导出项立刻降级
      if (/ffmpeg/i.test(message)) refreshEngine();
    }
  }, [engine, pollTask, refreshEngine]);

  const exportDraft = useCallback(async () => {
    const { clips, title, aspectRatio, projectId } = paramsRef.current;
    const blocked = clipPreflight(clips);
    if (blocked) {
      setDraft({ status: 'error', result: null, error: blocked });
      return;
    }
    setDraft({ status: 'running', result: null, error: null });
    try {
      const result = await apiService.exportTimelineDraft({
        clips,
        title,
        project_id: projectId,
        aspect_ratio: aspectRatio,
      });
      setDraft({ status: 'success', result, error: null });
    } catch (e: any) {
      setDraft({ status: 'error', result: null, error: e?.message || String(e) });
    }
  }, []);

  const downloadResult = useCallback(() => {
    const url = mp4.task?.output_url;
    if (!url) return;
    const a = document.createElement('a');
    a.href = resolveMediaUrl(url);
    a.download = url.split('/').pop() || 'timeline.mp4';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [mp4.task]);

  const openResultFolder = useCallback(() => {
    openFolderOf(mp4.task);
  }, [openFolderOf, mp4.task]);

  return {
    engine,
    engineLoading,
    refreshEngine,
    mp4,
    draft,
    busy: mp4.status === 'running' || draft.status === 'running',
    exportMp4,
    exportDraft,
    downloadResult,
    openResultFolder,
  };
}

/** 成片默认文件名：项目/节点名 + 总时长，和截图里的「xxx_10s完整成片时间轴」同口径 */
export function defaultExportTitle(name: string, clips: TimelineClip[]): string {
  const total = timelineTotal(clips);
  const secs = total >= 60 ? `${Math.round(total)}s` : `${Math.round(total * 10) / 10}s`;
  return `${name || '时间线'}_${secs}成片`;
}
