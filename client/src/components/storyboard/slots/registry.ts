import type { ModeDef, ProductionMode } from './types';

/**
 * 分镜**制作模式**注册表（P0 保留）。
 *
 * 注意：Tab / Anchor / Action 三类槽的注册表已在 Phase 3 收敛进前端 UIRegistry
 * （`ui-registry/adapters/storyboardSlots.ts`，host = `studio.slot.*`）——
 * 那里才是槽的单一真相源，本文件只留「制作模式」：它是**数据**（caps / 标题 / 排序），
 * 不是可插拔 UI 区域，宿主与批量流程都按 id 直接取，没有槽位渲染语义。
 */

const modeMap = new Map<ProductionMode, ModeDef>();

export function registerMode(def: ModeDef) {
  modeMap.set(def.id, def);
}

export function unregisterMode(id: ProductionMode) {
  modeMap.delete(id);
}

export function getModes(): ModeDef[] {
  return [...modeMap.values()].sort((a, b) => a.order - b.order);
}

export function getMode(id: ProductionMode): ModeDef {
  const m = modeMap.get(id);
  // 未知模式回退图生视频（与重构前“非 motion_comic 即按默认流”一致），避免批量循环中断
  if (!m) {
    const fallback = modeMap.get('image_to_video' as ProductionMode);
    if (!fallback) throw new Error('模式注册表为空');
    return fallback;
  }
  return m;
}
