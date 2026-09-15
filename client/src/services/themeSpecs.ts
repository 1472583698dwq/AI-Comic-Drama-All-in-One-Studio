// -*- coding: utf-8 -*-
/**
 * 插件主题包同步器（themes 扩展点）：拉取有效主题 → 写入 useThemeStore。
 * 应用/取消由 useThemeStore.applyPluginTheme 完成（CSS 变量注入）。
 */
import { apiService } from './api';
import { useThemeStore, type PluginThemeInfo } from '../stores/useThemeStore';

export async function syncPluginThemes(projectId?: string): Promise<PluginThemeInfo[]> {
  const res: any = await apiService.listThemes(projectId);
  const themes: PluginThemeInfo[] = res?.themes || [];
  useThemeStore.getState().setPluginThemes(themes);
  return themes;
}
