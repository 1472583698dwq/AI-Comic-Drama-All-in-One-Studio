import { useEffect, useRef, useCallback } from 'react';
import { apiService } from '../../../services/api';

export interface CanvasSyncOptions {
  /**
   * REQ-toonflow-canvas H1：每次落盘前先等它（迁移过的旧画布要先备份原 JSON 再保存，design §7）。
   * 抛错不阻止保存（备份失败只告警，不能让画布永远存不上）。
   */
  beforeSave?: (canvasId?: string) => Promise<void> | void;
}

export function useCanvasSync(projectId: string | null, opts: CanvasSyncOptions = {}) {
  const saveTimer = useRef<number | null>(null);
  const lastSnapshot = useRef<string>('');
  const beforeSaveRef = useRef(opts.beforeSave);
  beforeSaveRef.current = opts.beforeSave;

  const loadCanvas = useCallback(async (canvasId?: string) => {
    if (!projectId) return null;
    try {
      const data = await apiService.getProjectCanvas(projectId, canvasId);
      return data?.canvas || null;
    } catch {
      return null;
    }
  }, [projectId]);

  const saveCanvas = useCallback(async (snapshot: any, canvasId?: string, name?: string) => {
    if (!projectId) return;
    const str = JSON.stringify(snapshot);
    if (str === lastSnapshot.current) return;
    lastSnapshot.current = str;
    try {
      try { await beforeSaveRef.current?.(canvasId); } catch (e) { console.warn('[CanvasSync] beforeSave failed', e); }
      await apiService.saveProjectCanvas(projectId, snapshot, canvasId, name);
    } catch (e) {
      console.warn('[CanvasSync] save failed', e);
    }
  }, [projectId]);

  // 未落盘的最近一次快照：卸载（切项目/切页签）时立即补存，不能随定时器一起丢掉
  const pending = useRef<{ run: () => void } | null>(null);

  const debouncedSave = useCallback((snapshot: any, canvasId?: string, name?: string) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const run = () => { pending.current = null; saveCanvas(snapshot, canvasId, name); };
    pending.current = { run };
    saveTimer.current = window.setTimeout(run, 800) as any;
  }, [saveCanvas]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      pending.current?.run();
    };
  }, []);

  return { loadCanvas, saveCanvas, debouncedSave };
}
