import { create } from 'zustand';

export type ThemeMode = 'dark' | 'light' | 'system';

interface ThemeState {
  theme: ThemeMode;
  effectiveTheme: 'dark' | 'light';
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const getSystemTheme = (): 'dark' | 'light' => {
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
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

const savedTheme = (typeof localStorage !== 'undefined' ? localStorage.getItem('ai_manju_theme') : null) as ThemeMode | null;
const initialTheme: ThemeMode = savedTheme || 'dark';
const initialEffective = initialTheme === 'system' ? getSystemTheme() : initialTheme;
applyThemeToDOM(initialEffective);

export const useThemeStore = create<ThemeState>((set, get) => {
  // Listen for OS system theme changes
  if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      if (get().theme === 'system') {
        const eff = e.matches ? 'light' : 'dark';
        applyThemeToDOM(eff);
        set({ effectiveTheme: eff });
      }
    });
  }

  return {
    theme: initialTheme,
    effectiveTheme: initialEffective,
    setTheme: (theme: ThemeMode) => {
      localStorage.setItem('ai_manju_theme', theme);
      const effective = theme === 'system' ? getSystemTheme() : theme;
      applyThemeToDOM(effective);
      set({ theme, effectiveTheme: effective });
    },
    toggleTheme: () => {
      const current = get().effectiveTheme;
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      get().setTheme(nextTheme);
    }
  };
});
