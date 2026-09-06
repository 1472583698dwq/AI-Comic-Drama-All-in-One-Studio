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

  loadActiveProject: (projectId?: string) => Promise<void>;
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
  addCharacter: (character: Character) => void;
  deleteCharacter: (charId: string) => void;
  addShot: (sceneIndex: number, afterShotId?: string) => void;
  duplicateShot: (shotId: string) => void;
  deleteShot: (shotId: string) => void;
  reorderShots: (sourceIndex: number, destIndex: number) => void;
  // 2026 片场与全链路资产联动增强 Actions
  bindCharacterToShot: (shotId: string, charId: string) => void;
  unbindCharacterFromShot: (shotId: string, charId: string) => void;
  setCharacterWeight: (shotId: string, charId: string, weight: number) => void;
  bindSceneToShot: (shotId: string, sceneAsset: { id: string; name: string; url?: string; visual_prompt?: string }) => void;
  unbindSceneFromShot: (shotId: string) => void;
  bindPropToShot: (shotId: string, propAsset: { id: string; name: string; url?: string; visual_prompt?: string }) => void;
  unbindPropFromShot: (shotId: string, propAssetId: string) => void;
  synthesizeShotPrompt: (shotId: string) => void;
  selectCandidate: (shotId: string, candidateIndex: number) => void;
  autoFitShotDuration: (shotId: string, padding?: number) => void;
  autoFitAllDurations: (padding?: number) => void;
}

let saveTimer: any = null;
const persistProject = (proj: Project | null, activePid: string | null) => {
  if (!proj) return;
  const pid = proj.id || activePid;
  if (!pid) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    apiService.saveProjectContent(pid, proj).catch((err) => {
      console.warn('Auto-save project failed:', err);
    });
  }, 250);
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  activeProjectId: localStorage.getItem('activeProjectId') || null,
  activeShotId: null,
  activeTab: (localStorage.getItem('app_active_tab') as any) || 'projects',
  workspace: (localStorage.getItem('app_workspace') as any) || 'production',
  platformMode: (localStorage.getItem('app_platform_mode') as any) || 'desktop',
  isPlaying: false,
  currentTime: 0,
  totalDuration: 0,
  isLoading: false,
  loadingMessage: '',
  apiError: null,

  loadActiveProject: async (projectId?: string) => {
    const pid = projectId || get().activeProjectId || localStorage.getItem('activeProjectId');
    if (!pid) return;
    set({ isLoading: true, loadingMessage: '正在同步项目状态...' });
    try {
      const res = await apiService.openProject(pid);
      if (res && res.project) {
        get().setProject(res.project);
      } else if (res && res.scenes) {
        get().setProject(res as any);
      } else {
        const p = await apiService.getProject(pid);
        if (p) get().setProject(p as any);
      }
    } catch (e: any) {
      console.warn('Failed to auto-load active project:', e);
    } finally {
      set({ isLoading: false, loadingMessage: '' });
    }
  },

  setProject: (project) => {
    const total = project.scenes.flatMap((s) => s.shots).reduce((sum, sh) => sum + sh.duration, 0);
    const savedShotId = localStorage.getItem('active_shot_id_' + project.id);
    const allShots = project.scenes.flatMap((s) => s.shots);
    const foundSaved = allShots.find(s => s.id === savedShotId);
    const firstShotId = foundSaved?.id || allShots[0]?.id || null;

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
      persistProject(project, pid);
    }
  },

  setActiveShotId: (shotId) => {
    const pid = get().project?.id || get().activeProjectId;
    if (pid && shotId) localStorage.setItem('active_shot_id_' + pid, shotId);
    set({ activeShotId: shotId });
  },
  setActiveTab: (tab) => {
    localStorage.setItem('app_active_tab', tab);
    set({ activeTab: tab });
  },
  setWorkspace: (workspace) => {
    localStorage.setItem('app_workspace', workspace);
    set({ workspace });
  },
  setPlatformMode: (platformMode) => {
    localStorage.setItem('app_platform_mode', platformMode);
    set({ platformMode });
  },
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
    persistProject(nextProj, pid);
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

      // 首帧只放真首帧；参考图只透传调用方 dynamic_inputs 里装配好的
      // （shotReference 唯一口径），不再把首帧重复塞进参考槽污染约束
      const diRefs = (options?.dynamic_inputs as any)?.reference_images ?? (options?.dynamic_inputs as any)?.reference_image;
      const res: any = await apiService.generateShotVideo({
        prompt,
        mode,
        first_frame_url: shot.image_url || undefined,
        reference_images: Array.isArray(diRefs) ? diRefs : (diRefs ? [diRefs] : undefined),
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
    const nextProj = { ...proj, characters: newChars };
    set({ project: nextProj });
    const pid = nextProj.id || get().activeProjectId;
    persistProject(nextProj, pid);
  },

  addCharacter: (character) => {
    const proj = get().project;
    if (!proj) return;
    const newChars = [...proj.characters, character];
    const nextProj = { ...proj, characters: newChars };
    set({ project: nextProj });
    const pid = nextProj.id || get().activeProjectId;
    persistProject(nextProj, pid);
  },

  deleteCharacter: (charId) => {
    const proj = get().project;
    if (!proj) return;
    const newChars = proj.characters.filter((c) => c.id !== charId);
    const nextProj = { ...proj, characters: newChars };
    set({ project: nextProj });
    const pid = nextProj.id || get().activeProjectId;
    persistProject(nextProj, pid);
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
    const nextProj = { ...proj, scenes: newScenes };
    set({ project: nextProj, totalDuration: total, activeShotId: newShot.id });
    const pid = nextProj.id || get().activeProjectId;
    persistProject(nextProj, pid);
  },

  duplicateShot: (shotId) => {
    const proj = get().project;
    if (!proj) return;

    let targetShot: StoryboardShot | null = null;
    let targetSceneIndex = 1;

    for (const sc of proj.scenes) {
      const found = sc.shots.find(s => s.id === shotId);
      if (found) {
        targetShot = found;
        targetSceneIndex = sc.scene_index;
        break;
      }
    }

    if (!targetShot) return;

    const clonedShot: StoryboardShot = {
      ...targetShot,
      id: 'shot-' + Date.now(),
      shot_index: targetShot.shot_index + 1,
      status: 'ready',
    };

    const newScenes = proj.scenes.map((sc) => {
      if (sc.scene_index === targetSceneIndex) {
        const list = [...sc.shots];
        const idx = list.findIndex(s => s.id === shotId);
        list.splice(idx + 1, 0, clonedShot);
        return {
          ...sc,
          shots: list.map((s, i) => ({ ...s, shot_index: i + 1 })),
        };
      }
      return sc;
    });

    const total = newScenes.flatMap((s) => s.shots).reduce((sum, sh) => sum + sh.duration, 0);
    const nextProj = { ...proj, scenes: newScenes };
    set({ project: nextProj, totalDuration: total, activeShotId: clonedShot.id });
    const pid = nextProj.id || get().activeProjectId;
    persistProject(nextProj, pid);
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
    const nextProj = { ...proj, scenes: newScenes };
    set({
      project: nextProj,
      totalDuration: total,
      activeShotId: remainingShots[0]?.id || null,
    });
    const pid = nextProj.id || get().activeProjectId;
    persistProject(nextProj, pid);
  },

  reorderShots: (sourceIndex, destIndex) => {
    const proj = get().project;
    if (!proj || !proj.scenes[0]) return;

    const shots = [...proj.scenes[0].shots];
    const [removed] = shots.splice(sourceIndex, 1);
    shots.splice(destIndex, 0, removed);

    const updatedShots = shots.map((s, i) => ({ ...s, shot_index: i + 1 }));
    const newScenes = [{ ...proj.scenes[0], shots: updatedShots }];
    const nextProj = { ...proj, scenes: newScenes };
    set({ project: nextProj });
    const pid = nextProj.id || get().activeProjectId;
    persistProject(nextProj, pid);
  },

  // 2026 片场增强 Actions
  bindCharacterToShot: (shotId, charId) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot) return;
    const existing = shot.character_ids || [];
    if (!existing.includes(charId)) {
      const nextCharIds = [...existing, charId];
      const nextWeights = { ...(shot.character_weights || {}), [charId]: 0.8 };
      get().updateShot(shotId, { character_ids: nextCharIds, character_weights: nextWeights });
    }
  },

  unbindCharacterFromShot: (shotId, charId) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot) return;
    const nextCharIds = (shot.character_ids || []).filter(id => id !== charId);
    const nextWeights = { ...(shot.character_weights || {}) };
    delete nextWeights[charId];
    get().updateShot(shotId, { character_ids: nextCharIds, character_weights: nextWeights });
  },

  setCharacterWeight: (shotId, charId, weight) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot) return;
    const nextWeights = { ...(shot.character_weights || {}), [charId]: weight };
    get().updateShot(shotId, { character_weights: nextWeights });
  },

  bindSceneToShot: (shotId, sceneAsset) => {
    get().updateShot(shotId, {
      scene_asset_id: sceneAsset.id,
      scene_name: sceneAsset.name,
      scene_ref_image: sceneAsset.url,
      scene_prompt: sceneAsset.visual_prompt || sceneAsset.name,
    });
  },

  unbindSceneFromShot: (shotId) => {
    get().updateShot(shotId, {
      scene_asset_id: undefined,
      scene_name: undefined,
      scene_ref_image: undefined,
      scene_prompt: undefined,
    });
  },

  bindPropToShot: (shotId, propAsset) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot) return;
    const existing = shot.prop_asset_ids || [];
    if (!existing.includes(propAsset.id)) {
      const nextProps = [...existing, propAsset.id];
      const desc = propAsset.visual_prompt || propAsset.name;
      const combinedPrompts = shot.prop_prompts ? `${shot.prop_prompts}, ${desc}` : desc;
      get().updateShot(shotId, {
        prop_asset_ids: nextProps,
        prop_prompts: combinedPrompts,
      });
    }
  },

  unbindPropFromShot: (shotId, propAssetId) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot) return;
    const nextProps = (shot.prop_asset_ids || []).filter(id => id !== propAssetId);
    get().updateShot(shotId, { prop_asset_ids: nextProps });
  },

  synthesizeShotPrompt: (shotId) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot) return;

    const parts: string[] = [];

    // 1. Character Tags
    if (shot.character_ids && shot.character_ids.length > 0) {
      const boundChars = proj.characters.filter(c => shot.character_ids!.includes(c.id));
      if (boundChars.length > 0) {
        const charTags = boundChars.map(c => `[角色: ${c.name}, ${c.visual_prompt || c.description}]`).join(' ');
        parts.push(charTags);
      }
    }

    // 2. Scene Environment
    if (shot.scene_prompt || shot.scene_name) {
      parts.push(`[场景环境: ${shot.scene_prompt || shot.scene_name}]`);
    }

    // 3. Props / Artifacts
    if (shot.prop_prompts) {
      parts.push(`[道具法宝: ${shot.prop_prompts}]`);
    }

    // 4. Camera & Composition
    const framingMap: Record<string, string> = {
      extreme_close_up: '大特写 85mm镜头 眼神微表情细节',
      close_up: '特写 50mm镜头 面部清晰',
      medium: '中景 35mm镜头 半身构图',
      full: '全景 28mm镜头 全身动态',
      long: '远景 24mm镜头 宏大空间感',
      bird_eye: '鸟瞰俯拍 纵览全局',
      low_angle: '低角度仰拍 威严压迫感',
    };
    const motionMap: Record<string, string> = {
      static: '固定镜头',
      push_in: '缓慢推镜 聚焦情绪',
      pull_out: '缓缓拉远 展现全景',
      orbit: '360度环绕运镜',
      shake: '剧烈震颤 战斗冲击波',
    };
    const framingDesc = framingMap[shot.camera_framing] || '中景';
    const motionDesc = motionMap[shot.camera_motion] || '推镜';
    parts.push(`[机位构图: ${framingDesc}, ${motionDesc}]`);

    // 5. Action and Emotion
    if (shot.action_desc) {
      parts.push(`[动作剧情: ${shot.action_desc}]`);
    }
    if (shot.emotion && shot.emotion !== 'neutral') {
      const emotionMap: Record<string, string> = {
        intense: '激烈决绝',
        sorrow: '悲怆凄美',
        excited: '热血激昂',
        fearful: '惊骇戒备',
        whispering: '低语轻吟',
      };
      parts.push(`[情绪氛围: ${emotionMap[shot.emotion] || shot.emotion}]`);
    }

    // 6. Project Style Preset
    const stylePreset = proj.style_preset || 'donghua_xianxia';
    const styleMap: Record<string, string> = {
      donghua_xianxia: 'masterpiece, best quality, 3D donghua animation style, cinematic lighting, volumetric light, unreal engine 5 render, octan render, 8k resolution, photorealistic fantasy',
      japanese_anime: 'masterpiece, best quality, modern anime style, ufotable aesthetic, vibrant colors, detailed lineart, cinematic anime screencap',
      cyberpunk_3d: 'masterpiece, best quality, cyberpunk neon lighting, volumetric fog, ray tracing, futuristic sci-fi aesthetic, 8k resolution',
      korean_manhwa: 'masterpiece, best quality, webtoon manhwa style, dynamic lighting, dramatic angle, crisp digital illustration',
    };
    parts.push(styleMap[stylePreset] || 'masterpiece, best quality, high resolution, cinematic anime');

    const fullPrompt = parts.join(', ');
    get().updateShot(shotId, { image_prompt: fullPrompt });
  },

  selectCandidate: (shotId, candidateIndex) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot || !shot.candidates || !shot.candidates[candidateIndex]) return;
    const chosenUrl = shot.candidates[candidateIndex];
    get().updateShot(shotId, {
      image_url: chosenUrl,
      selected_candidate_index: candidateIndex,
      status: 'completed',
    });
  },

  autoFitShotDuration: (shotId, padding = 0.4) => {
    const proj = get().project;
    if (!proj) return;
    const shot = proj.scenes.flatMap(s => s.shots).find(s => s.id === shotId);
    if (!shot) return;
    let targetSec = shot.duration;
    if (shot.audio_duration && shot.audio_duration > 0) {
      targetSec = Math.max(1.5, Math.round((shot.audio_duration + padding) * 10) / 10);
    } else if (shot.subtitle_text || shot.dialogue) {
      const len = (shot.subtitle_text || shot.dialogue || '').length;
      targetSec = Math.max(2.0, Math.round((len * 0.26 + 0.6) * 10) / 10);
    }
    get().updateShot(shotId, { duration: targetSec });
  },

  autoFitAllDurations: (padding = 0.4) => {
    const proj = get().project;
    if (!proj) return;
    const shots = proj.scenes.flatMap(s => s.shots);
    for (const sh of shots) {
      get().autoFitShotDuration(sh.id, padding);
    }
  },
}));
