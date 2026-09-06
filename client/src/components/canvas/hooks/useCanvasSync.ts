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

  const debouncedSave = useCallback((snapshot: any, canvasId?: string, name?: string) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveCanvas(snapshot, canvasId, name), 800) as any;
  }, [saveCanvas]);

  useEffect(() => {
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, []);

  return { loadCanvas, saveCanvas, debouncedSave };
}
