// -*- coding: utf-8 -*-
/**
 * 导演包注册表（director_packs 扩展点）— 3D 导演台前端扩展点。
 * - presets 合并进 directorPresets 的同源数组（舞台与画布节点自动同步）；
 * - environments / props 供舞台渲染面板与场景重建消费。
 *
 * **与 UIRegistry 的分工（设计 §12.4-4 定稿后的边界）**：
 *   · `props` / `environments` 是「一组行」→ 已条目化（`ui-registry/adapters/directorPackEntries.ts`，
 *     宿主 `director3d.props` / `director3d.environments`，按下后的行为由舞台经
 *     `DirectorPackBridgeContext` 注入）；舞台不再自己 map 这两个数组渲染。
 *   · `presets`（framing / motion / pose / cast）**有意不条目化**：它不是独立 UI 挂载点，
 *     而是被 `applyDirectorPackPresets()` 合并进 `directorPresets` 的**同源数组**，
 *     舞台与画布节点都直接读那份数组（两处显示必须一致）；条目化会把这个共享契约拆散。
 *   · `listDirectorPackProps()` 仍然保留：场景重建时要用它反查 `glb_url`（数据用途，与渲染无关）。
 */
import { apiService } from '../../services/api';
import { FRAMING_PRESETS, MOTION_PRESETS, POSE_PRESETS, CAST_LAYOUTS } from './directorPresets';

export interface DirectorPackPreset {
  id: string;
  label: string;
  desc?: string;
  icon?: string;
  fl?: number;
  category?: string;
  minimaxCode?: string;
}

export interface DirectorPackEnv {
  id: string;
  label: string;
  desc?: string;
  icon?: string;
  background_url?: string;
}

export interface DirectorPackProp {
  id: string;
  label: string;
  icon?: string;
  glb_url: string;
  scale?: number;
}

export interface DirectorPack {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  presets?: Record<string, DirectorPackPreset[]>;
  environments?: DirectorPackEnv[];
  props?: DirectorPackProp[];
  enabled?: boolean;
}

const _packs = new Map<string, DirectorPack>();

// 基线长度：重载时 splice 回基线，避免重复累积
const _baseLens = {
  framing: FRAMING_PRESETS.length,
  motion: MOTION_PRESETS.length,
  pose: POSE_PRESETS.length,
  cast: CAST_LAYOUTS.length,
};

function _resetPresets() {
  FRAMING_PRESETS.splice(_baseLens.framing);
  MOTION_PRESETS.splice(_baseLens.motion);
  POSE_PRESETS.splice(_baseLens.pose);
  CAST_LAYOUTS.splice(_baseLens.cast);
}

/** 把已注册导演包的预设追加到同源数组（插件自定义 id 走 as any，后端仅作展示/传给 MCP）。 */
export function applyDirectorPackPresets(): void {
  _resetPresets();
  for (const pack of _packs.values()) {
    const p = pack.presets || {};
    for (const item of p.framing || []) {
      FRAMING_PRESETS.push({ id: item.id as any, label: item.label, fl: item.fl ?? 35, desc: item.desc || '插件导演包' });
    }
    for (const item of p.motion || []) {
      MOTION_PRESETS.push({
        id: item.id as any,
        label: item.label,
        category: item.category === 'combo' ? 'combo' : 'single',
        desc: item.desc || '插件导演包',
        minimaxCode: item.minimaxCode || item.label,
      });
    }
    for (const item of p.pose || []) {
      POSE_PRESETS.push({ id: item.id as any, label: item.label, icon: item.icon || '🧩' });
    }
    for (const item of p.cast || []) {
      CAST_LAYOUTS.push({ id: item.id as any, label: item.label, desc: item.desc || '插件导演包' });
    }
  }
}

export function listDirectorPacks(): DirectorPack[] {
  return [..._packs.values()];
}

export function listDirectorPackProps(): DirectorPackProp[] {
  const out: DirectorPackProp[] = [];
  for (const p of _packs.values()) {
    for (const prop of p.props || []) {
      if (prop?.id && prop?.glb_url) out.push(prop);
    }
  }
  return out;
}

export function listDirectorPackEnvironments(): DirectorPackEnv[] {
  const out: DirectorPackEnv[] = [];
  for (const p of _packs.values()) {
    for (const env of p.environments || []) {
      if (env?.id) out.push(env);
    }
  }
  return out;
}

export function getDirectorPackEnv(id?: string): DirectorPackEnv | undefined {
  if (!id) return undefined;
  return listDirectorPackEnvironments().find((e) => e.id === id);
}

export async function syncDirectorPacks(projectId?: string): Promise<number> {
  const res: any = await apiService.listDirectorPacks(projectId);
  const packs: DirectorPack[] = res?.packs || [];
  _packs.clear();
  for (const p of packs) {
    if (p?.id && p.enabled !== false) _packs.set(p.id, p);
  }
  applyDirectorPackPresets();
  return _packs.size;
}
