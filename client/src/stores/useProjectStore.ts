import { create } from 'zustand';
import { Project, StoryboardShot, Character, AspectRatio, StylePreset } from '../types';
import { apiService } from '../services/api';

interface ProjectState {
  project: Project | null;
  activeProjectId: string | null; // P0: 关联 ProjectMeta
  activeShotId: string | null;
  activeTab: 'projects' | 'studio' | 'director3d' | 'timeline' | 'characters' | 'assets' | 'mcp' | 'config' | 'canvas';
  workspace: 'production' | 'creative'; // P0: 双工作台
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
  setActiveTab: (tab: 'projects' | 'studio' | 'director3d' | 'timeline' | 'characters' | 'assets' | 'mcp' | 'config' | 'canvas') => void;
  setWorkspace: (w: 'production'|'creative') => void;
  setPlatformMode: (mode: 'desktop' | 'mobile') => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setCurrentTime: (time: number) => void;
  clearApiError: () => void;

  // Script & Generation
  importNovelScript: (text: string, style?: StylePreset, ratio?: AspectRatio) => Promise<void>;
  generateShotVideo: (shotId: string, options?: { mode?: 'i2v' | 'r2v' | 't2v'; prompt?: string; duration?: number; provider?: string; workflow_id?: string; dynamic_inputs?: Record<string, any> }) => Promise<void>;
  updateShot: (shotId: string, updates: Partial<StoryboardShot>) => void;
  updateCharacter: (charId: string, updates: Partial<Character>) => void;
  addShot: (sceneIndex: number, afterShotId?: string) => void;
  deleteShot: (shotId: string) => void;
  reorderShots: (sourceIndex: number, destIndex: number) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  activeProjectId: localStorage.getItem('activeProjectId') || null,
  activeShotId: null,
  activeTab: 'projects',
  workspace: 'production',
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
    // 同步 activeProjectId
    if (project?.id) {
      localStorage.setItem('activeProjectId', project.id);
      set({ project, totalDuration: total, activeShotId: firstShotId, apiError: null, activeProjectId: project.id });
    } else {
      set({ project, totalDuration: total, activeShotId: firstShotId, apiError: null });
    }
    // 自动保存到后端（若有 activeProjectId）
    const pid = project?.id || get().activeProjectId;
    if (pid && project) {
      apiService.saveProjectContent(pid, project).catch(()=>{});
    }
  },

  setActiveShotId: (shotId) => set({ activeShotId: shotId }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setWorkspace: (workspace) => set({ workspace }),
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
      shots: sc.shots.map((sh) => {
        if (sh.id !== shotId) return sh;
        const merged: any = { ...sh, ...updates };
        // 历史：image_url/video_url 变更时追加
        if ((updates as any).image_url && (updates as any).image_url !== sh.image_url) {
          const hist = [...(sh.history || [])];
          if (sh.image_url) hist.push({ image_url: sh.image_url, ts: new Date().toISOString(), provider: (sh as any).image_provider });
          if (hist.length > 5) hist.shift();
          merged.history = [...hist, { image_url: (updates as any).image_url, ts: new Date().toISOString(), provider: (updates as any).image_provider || (sh as any).image_provider }];
          if (merged.history.length > 6) merged.history = merged.history.slice(-6);
        }
        if ((updates as any).video_url && (updates as any).video_url !== sh.video_url) {
          const hist = [...(merged.history || sh.history || [])];
          hist.push({ video_url: (updates as any).video_url, ts: new Date().toISOString(), provider: (updates as any).video_provider || (sh as any).video_provider });
          if (hist.length > 6) hist.splice(0, hist.length - 6);
          merged.history = hist;
        }
        return merged;
      }),
    }));

    const total = newScenes.flatMap((s) => s.shots).reduce((sum, sh) => sum + sh.duration, 0);
    const nextProj = { ...proj, scenes: newScenes };
    set({ project: nextProj, totalDuration: total });
    // 自动持久化
    const pid = nextProj.id || get().activeProjectId;
    if (pid) apiService.saveProjectContent(pid, nextProj).catch(()=>{});
  },

  generateShotVideo: async (shotId: string, options) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) return;

    get().updateShot(shotId, { status: 'generating_video' });
    try {
      const mode = options?.mode || (shot.image_url ? 'i2v' : 't2v');
      const prompt = options?.prompt || shot.video_prompt || shot.action_desc || shot.image_prompt || 'Cinematic dramatic dynamic anime video';
      const duration = options?.duration || Math.round(shot.duration) || 5;

      const res: any = await apiService.generateShotVideo({
        prompt,
        mode,
        first_frame_url: shot.image_url || undefined,
        reference_images: shot.image_url ? [shot.image_url] : undefined,
        duration,
        aspect_ratio: proj.aspect_ratio || '9:16',
        provider: options?.provider,
        workflow_id: options?.workflow_id,
        dynamic_inputs: options?.dynamic_inputs,
        shot_id: shotId,
      });

      // 同步成功（直接返回 video_url）
      if (res.video_url) {
        get().updateShot(shotId, {
          video_url: res.video_url,
          video_prompt: prompt,
          duration: res.duration || shot.duration,
          status: 'completed',
        });
        return;
      }
      // 异步排队（AutoDL 等返回 task_id，需轮询）
      const taskId = res.task_id || res.taskId || (res.raw && (res.raw.task_id || res.raw.taskId));
      if (taskId) {
        // 保持 generating 状态，前端可显示排队中
        get().updateShot(shotId, { video_prompt: prompt, status: 'generating_video' } as any);
        const maxAttempts = 120; // 最多轮询 6 分钟
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const st: any = await apiService.getVideoTaskStatus(taskId);
            const status = (st.status || st.state || "").toString().toUpperCase();
            if (status === "SUCCESS" || status === "COMPLETED") {
              const vurl = st.video_url || st.videoUrl || (st.results && st.results[0]) || st.url;
              if (vurl) {
                get().updateShot(shotId, {
                  video_url: vurl,
                  video_prompt: prompt,
                  duration: st.duration || res.duration || shot.duration,
                  status: 'completed',
                });
                return;
              }
            } else if (status === "FAILED" || status === "FAIL" || status === "ERROR") {
              throw new Error(st.error || st.msg || "视频生成任务失败");
            }
            // 否则继续排队/运行中
          } catch (e: any) {
            // 若 getVideoTaskStatus 本身抛错，视为可重试，继续
            if (e?.message && e.message.includes("not_found")) {
              // 任务可能尚未注册，继续
            }
          }
        }
        throw new Error("视频生成排队超时（6分钟），请稍后在任务列表或历史中查看，或重试");
      }
      // 兜底：无 video_url 也无 task_id，视为失败
      if (!res.video_url) throw new Error(res.detail || "视频生成未返回视频地址");
      get().updateShot(shotId, {
        video_url: res.video_url,
        video_prompt: prompt,
        duration: res.duration || shot.duration,
        status: 'completed',
      });
    } catch (e: any) {
      get().updateShot(shotId, { status: 'error' });
      throw e;
    }
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
