import { create } from 'zustand';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface PluginThemeInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  mode?: 'all' | 'dark' | 'light';
  vars?: Record<string, string>;
}

interface ThemeState {
  theme: ThemeMode;
  effectiveTheme: 'dark' | 'light';
  /** 插件主题包（themes 扩展点），由 services/themeSpecs 同步进来 */
  pluginThemes: PluginThemeInfo[];
  activePluginThemeId: string;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setPluginThemes: (list: PluginThemeInfo[]) => void;
  /** 应用/取消（传 '' 取消）插件主题；mode=dark/light 时仅对应明暗模式生效 */
  applyPluginTheme: (id: string) => void;
}

const getSystemTheme = (): 'dark' | 'light' => {
  return 'dark';
};

const applyThemeToDOM = (effective: 'dark' | 'light') => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (effective === 'light') {
    root.setAttribute('data-theme', 'light');
    root.classList.add('light');
    root.classList.remove('dark');
  } else {
    root.setAttribute('data-theme', 'dark');
    root.classList.add('dark');
    root.classList.remove('light');
  }
};

// —— 插件主题变量注入（CSS 变量包）——
const _appliedVars = new Set<string>();
const clearPluginVars = () => {
  if (typeof document === 'undefined') return;
  for (const k of _appliedVars) document.documentElement.style.removeProperty(k);
  _appliedVars.clear();
};
const applyPluginVars = (themes: PluginThemeInfo[], id: string, effective: 'dark' | 'light') => {
  if (typeof document === 'undefined') return;
  clearPluginVars();
  if (!id) return;
  const t = (themes || []).find((x) => x.id === id);
  if (!t || !t.vars) return;
  if (t.mode && t.mode !== 'all' && t.mode !== effective) return;
  for (const [k, v] of Object.entries(t.vars)) {
    if (!k.startsWith('--') || typeof v !== 'string') continue;
    document.documentElement.style.setProperty(k, v);
    _appliedVars.add(k);
  }
};

const savedTheme = (typeof localStorage !== 'undefined' ? localStorage.getItem('ai_manju_theme') : null) as ThemeMode | null;
const savedPluginTheme = (typeof localStorage !== 'undefined' ? localStorage.getItem('ai_manju_plugin_theme') : '') || '';
const initialTheme: ThemeMode = savedTheme || 'dark';
const initialEffective: 'dark' | 'light' = initialTheme === 'light' ? 'light' : 'dark';
applyThemeToDOM(initialEffective);

export const useThemeStore = create<ThemeState>((set, get) => {
  // Listen for OS system theme changes
  if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      if (get().theme === 'system') {
        const eff = e.matches ? 'light' : 'dark';
        applyThemeToDOM(eff);
        applyPluginVars(get().pluginThemes, get().activePluginThemeId, eff);
        set({ effectiveTheme: eff });
      }
    });
  }

  return {
    theme: initialTheme,
    effectiveTheme: initialEffective,
    pluginThemes: [],
    activePluginThemeId: savedPluginTheme,
    setTheme: (theme: ThemeMode) => {
      localStorage.setItem('ai_manju_theme', theme);
      const effective = theme === 'system' ? getSystemTheme() : theme;
      applyThemeToDOM(effective);
      applyPluginVars(get().pluginThemes, get().activePluginThemeId, effective);
      set({ theme, effectiveTheme: effective });
    },
    toggleTheme: () => {
      const current = get().effectiveTheme;
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      get().setTheme(nextTheme);
    },
    setPluginThemes: (list: PluginThemeInfo[]) => {
      set({ pluginThemes: list || [] });
      // 列表后到：按当前选择重新应用；若主题已被卸载则安全清空
      applyPluginVars(list || [], get().activePluginThemeId, get().effectiveTheme);
    },
    applyPluginTheme: (id: string) => {
      const next = String(id || '');
      try { localStorage.setItem('ai_manju_plugin_theme', next); } catch { /* ignore */ }
      applyPluginVars(get().pluginThemes, next, get().effectiveTheme);
      set({ activePluginThemeId: next });
    },
  };
});
