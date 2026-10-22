import { useCallback, useEffect, useRef, useState } from 'react';
import { apiService, type TimelineEngineStatus, type TimelineTask } from '../../services/api';
import { resolveMediaUrl } from '../../utils/devOrigin';
import type { Project, StoryboardShot } from '../../types';
import { buildProjectExportPayload, projectExportPreflight } from './projectExport';

const POLL_MS = 1200;
const POLL_MAX = 900;

export interface ProjectExportMp4State {
  status: 'idle' | 'running' | 'success' | 'error';
  task: TimelineTask | null;
  stage: string;
  progress: number;
  error: string | null;
}

const IDLE_MP4: ProjectExportMp4State = { status: 'idle', task: null, stage: '', progress: 0, error: null };

function dirnameOf(path?: string): string {
  if (!path) return '';
  const norm = path.replace(/\\/g, '/');
  return norm.slice(0, norm.lastIndexOf('/'));
}

export interface ProjectExportApi {
  engine: TimelineEngineStatus | null;
  engineLoading: boolean;
  refreshEngine: () => void;
  mp4: ProjectExportMp4State;
  busy: boolean;
  exportMp4: () => Promise<void>;
  downloadResult: () => void;
  openResultFolder: () => void;
}

export function useProjectExport(params: {
  project: Project | null;
  shots: StoryboardShot[];
  title?: string;
  subtitles?: boolean;
}): ProjectExportApi {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [engine, setEngine] = useState<TimelineEngineStatus | null>(null);
  const [engineLoading, setEngineLoading] = useState(true);
  const [mp4, setMp4] = useState<ProjectExportMp4State>(IDLE_MP4);
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
      .then((status) => setEngine(status))
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
    [stopPoll],
  );

  const exportMp4 = useCallback(async () => {
    const { project, shots, title, subtitles } = paramsRef.current;
    const blocked = projectExportPreflight(project, shots);
    if (blocked || !project) {
      setMp4({ ...IDLE_MP4, status: 'error', error: blocked || '请先打开项目' });
      return;
    }
    if (engine && !engine.available) {
      setMp4({ ...IDLE_MP4, status: 'error', error: `${engine.ffmpeg_hint} ${engine.draft_hint}`.trim() });
      return;
    }
    setMp4({ ...IDLE_MP4, status: 'running', stage: '提交任务', progress: 3 });
    try {
      const res = await apiService.exportProjectTimeline(
        buildProjectExportPayload(project, shots, { title, subtitles }),
      );
      setMp4({ status: 'running', task: null, stage: '合成', progress: 8, error: null });
      pollTask(res.task_id);
    } catch (e: any) {
      const message = e?.message || String(e);
      setMp4({ status: 'error', task: null, stage: '失败', progress: 100, error: message });
      if (/ffmpeg/i.test(message)) refreshEngine();
    }
  }, [engine, pollTask, refreshEngine]);

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
    busy: mp4.status === 'running',
    exportMp4,
    downloadResult,
    openResultFolder,
  };
}
