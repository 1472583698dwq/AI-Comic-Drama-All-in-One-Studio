import { useEffect, useRef, useCallback } from 'react';
import { apiService } from '../../../services/api';

export function useCanvasSync(projectId: string | null) {
  const saveTimer = useRef<number | null>(null);
  const lastSnapshot = useRef<string>('');

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
