import { create } from 'zustand';
import { apiService } from '../services/api';

export interface ProjectMeta {
  id: string;
  title: string;
  cover_url?: string | null;
  style_preset: string;
  aspect_ratio: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
  stats: { shots: number; duration: number; characters: number };
  source: string;
  description?: string;
}

interface ProjectListState {
  projects: ProjectMeta[];
  activeProjectId: string | null;
  isLoading: boolean;
  error: string | null;
  fetchProjects: (opts?: { q?: string; status?: string; sort?: string }) => Promise<void>;
  createBlank: (params: { title: string; style_preset?: string; aspect_ratio?: string; description?: string }) => Promise<ProjectMeta>;
  importProjectFile: (file: File) => Promise<ProjectMeta>;
  openProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<ProjectMeta>;
  setActiveProjectId: (id: string | null) => void;
}

export const useProjectListStore = create<ProjectListState>((set, get) => ({
  projects: [],
  activeProjectId: localStorage.getItem('activeProjectId') || null,
  isLoading: false,
  error: null,

  fetchProjects: async (opts) => {
    set({ isLoading: true, error: null });
    try {
      const res = await apiService.listProjects(opts);
      set({ projects: res.projects || [], isLoading: false });
    } catch (e: any) {
      set({ error: e?.message || '加载项目列表失败', isLoading: false });
    }
  },

  createBlank: async (params) => {
    const meta = await apiService.createProject(params);
    await get().fetchProjects();
    get().setActiveProjectId(meta.id);
    return meta;
  },

  importProjectFile: async (file) => {
    const res = await apiService.importProjectFile(file);
    const meta = res.project;
    await get().fetchProjects();
    get().setActiveProjectId(meta.id);
    return meta;
  },

  openProject: async (id) => {
    try {
      await apiService.openProject(id);
    } catch { /* ignore */ }
    get().setActiveProjectId(id);
  },

  deleteProject: async (id) => {
    await apiService.deleteProject(id);
    await get().fetchProjects();
    const { activeProjectId } = get();
    if (activeProjectId === id) get().setActiveProjectId(null);
  },

  duplicateProject: async (id) => {
    const meta = await apiService.duplicateProject(id);
    await get().fetchProjects();
    return meta;
  },

  setActiveProjectId: (id) => {
    if (id) localStorage.setItem('activeProjectId', id);
    else localStorage.removeItem('activeProjectId');
    set({ activeProjectId: id });
  },
}));
