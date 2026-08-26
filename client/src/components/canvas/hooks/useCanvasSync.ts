import { useEffect, useRef, useCallback } from 'react';
import { apiService } from '../../../services/api';

export function useCanvasSync(projectId: string | null) {
  const saveTimer = useRef<number | null>(null);
  const lastSnapshot = useRef<string>('');

  const loadCanvas = useCallback(async () => {
    if (!projectId) return null;
    try {
      const data = await apiService.getProjectCanvas(projectId);
      return data?.canvas || null;
    } catch {
      return null;
    }
  }, [projectId]);

  const saveCanvas = useCallback(async (snapshot: any) => {
    if (!projectId) return;
    const str = JSON.stringify(snapshot);
    if (str === lastSnapshot.current) return;
    lastSnapshot.current = str;
    try {
      await apiService.saveProjectCanvas(projectId, snapshot);
    } catch (e) {
      console.warn('[CanvasSync] save failed', e);
    }
  }, [projectId]);

  const debouncedSave = useCallback((snapshot: any) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveCanvas(snapshot), 800) as any;
  }, [saveCanvas]);

  useEffect(() => {
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, []);

  return { loadCanvas, saveCanvas, debouncedSave };
}
