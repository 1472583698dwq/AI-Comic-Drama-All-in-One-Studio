import { create } from 'zustand';
import { Project, StoryboardShot, Character, AspectRatio, StylePreset } from '../types';
import { apiService } from '../services/api';

interface ProjectState {
  project: Project | null;
  activeShotId: string | null;
  activeTab: 'studio' | 'director3d' | 'timeline' | 'characters' | 'assets' | 'mcp' | 'config';
  platformMode: 'desktop' | 'mobile';
  isPlaying: boolean;
  currentTime: number; // in seconds
  totalDuration: number;
  isLoading: boolean;
  loadingMessage: string;
  apiError: string | null;

  // Actions
  setProject: (project: Project) => void;
  setActiveShotId: (shotId: string | null) => void;
  setActiveTab: (tab: 'studio' | 'director3d' | 'timeline' | 'characters' | 'assets' | 'mcp' | 'config') => void;
  setPlatformMode: (mode: 'desktop' | 'mobile') => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setCurrentTime: (time: number) => void;
  clearApiError: () => void;

  // Script & Generation
  importNovelScript: (text: string, style?: StylePreset, ratio?: AspectRatio) => Promise<void>;
  updateShot: (shotId: string, updates: Partial<StoryboardShot>) => void;
  updateCharacter: (charId: string, updates: Partial<Character>) => void;
  addShot: (sceneIndex: number, afterShotId?: string) => void;
  deleteShot: (shotId: string) => void;
  reorderShots: (sourceIndex: number, destIndex: number) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  activeShotId: null,
  activeTab: 'studio',
  platformMode: 'desktop',
  isPlaying: false,
  currentTime: 0,
  totalDuration: 0,
  isLoading: false,
  loadingMessage: '',
  apiError: null,

  setProject: (project) => {
    const total = project.scenes.flatMap((s) => s.shots).reduce((sum, sh) => sum + sh.duration, 0);
    const firstShotId = project.scenes[0]?.shots[0]?.id || null;
    set({ project, totalDuration: total, activeShotId: firstShotId, apiError: null });
  },

  setActiveShotId: (shotId) => set({ activeShotId: shotId }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setPlatformMode: (platformMode) => set({ platformMode }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  clearApiError: () => set({ apiError: null }),

  importNovelScript: async (text, style = 'donghua_xianxia', ratio = '9:16') => {
    set({ isLoading: true, loadingMessage: '正在调用 MiniMax LLM 拆解小说剧情与角色关系...', apiError: null });
    try {
      const proj = await apiService.parseScript(text, style, ratio);
      get().setProject(proj);
    } catch (e: any) {
      set({ apiError: e?.message || '小说拆解失败' });
      throw e;
    } finally {
      set({ isLoading: false, loadingMessage: '' });
    }
  },

  updateShot: (shotId, updates) => {
    const proj = get().project;
    if (!proj) return;

    const newScenes = proj.scenes.map((sc) => ({
      ...sc,
      shots: sc.shots.map((sh) => (sh.id === shotId ? { ...sh, ...updates } : sh)),
    }));

    const total = newScenes.flatMap((s) => s.shots).reduce((sum, sh) => sum + sh.duration, 0);
    set({ project: { ...proj, scenes: newScenes }, totalDuration: total });
  },

  updateCharacter: (charId, updates) => {
    const proj = get().project;
    if (!proj) return;

    const newChars = proj.characters.map((c) => (c.id === charId ? { ...c, ...updates } : c));
    set({ project: { ...proj, characters: newChars } });
  },

  addShot: (sceneIndex = 1, afterShotId) => {
    const proj = get().project;
    if (!proj) return;

    const newShot: StoryboardShot = {
      id: 'shot-' + Date.now(),
      shot_index: 99,
      scene_index: sceneIndex,
      camera_framing: 'medium',
      camera_motion: 'push_in',
      action_desc: '新分镜描述...',
      emotion: 'neutral',
      image_prompt: 'Cinematic anime shot, high quality lighting, masterpiece',
      duration: 3.5,
      subtitle_text: '新台词',
      status: 'ready',
    };

    const newScenes = proj.scenes.map((sc) => {
      if (sc.scene_index === sceneIndex) {
        const list = [...sc.shots];
        if (afterShotId) {
          const idx = list.findIndex((s) => s.id === afterShotId);
          list.splice(idx + 1, 0, newShot);
        } else {
          list.push(newShot);
        }
        return {
          ...sc,
          shots: list.map((s, i) => ({ ...s, shot_index: i + 1 })),
        };
      }
      return sc;
    });

    const total = newScenes.flatMap((s) => s.shots).reduce((sum, sh) => sum + sh.duration, 0);
    set({ project: { ...proj, scenes: newScenes }, totalDuration: total, activeShotId: newShot.id });
  },

  deleteShot: (shotId) => {
    const proj = get().project;
    if (!proj) return;

    const newScenes = proj.scenes.map((sc) => ({
      ...sc,
      shots: sc.shots.filter((s) => s.id !== shotId).map((s, i) => ({ ...s, shot_index: i + 1 })),
    }));

    const remainingShots = newScenes.flatMap((s) => s.shots);
    const total = remainingShots.reduce((sum, sh) => sum + sh.duration, 0);
    set({
      project: { ...proj, scenes: newScenes },
      totalDuration: total,
      activeShotId: remainingShots[0]?.id || null,
    });
  },

  reorderShots: (sourceIndex, destIndex) => {
    const proj = get().project;
    if (!proj || !proj.scenes[0]) return;

    const shots = [...proj.scenes[0].shots];
    const [removed] = shots.splice(sourceIndex, 1);
    shots.splice(destIndex, 0, removed);

    const updatedShots = shots.map((s, i) => ({ ...s, shot_index: i + 1 }));
    const newScenes = [{ ...proj.scenes[0], shots: updatedShots }];
    set({ project: { ...proj, scenes: newScenes } });
  },
}));
