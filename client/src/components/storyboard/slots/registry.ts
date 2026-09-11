import type {
  ActionDef,
  AnchorDef,
  ModeDef,
  ProductionMode,
  ShotSlotContext,
  TabDef,
} from './types';

/**
 * 分镜 Slot 本地注册表（P0）。
 * - order 排序，when 过滤，render 渲染；宿主只调 get*，不认识具体 Slot。
 * - P1 时 register* 的调用方从 builtin.tsx 换成插件 slots/*.json 加载器，
 *   注册表 API 不变（dsh"注册即 effect" 的降配版：unregister 供 disable 精确卸载）。
 */

function createRegistry<T extends { id: string; order: number }>() {
  const items = new Map<string, T>();
  return {
    register(def: T) {
      items.set(def.id, def);
    },
    unregister(id: string) {
      items.delete(id);
    },
    all(): T[] {
      return [...items.values()].sort((a, b) => a.order - b.order);
    },
    clear() {
      items.clear();
    },
  };
}

export const tabRegistry = createRegistry<TabDef>();
export const anchorRegistry = createRegistry<AnchorDef>();
export const actionRegistry = createRegistry<ActionDef>();

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

export function getVisibleTabs(ctx: ShotSlotContext): TabDef[] {
  return tabRegistry.all().filter((t) => !t.when || t.when(ctx));
}

export function getVisibleAnchors(ctx: ShotSlotContext): AnchorDef[] {
  return anchorRegistry.all().filter((a) => !a.when || a.when(ctx));
}

export function getVisibleActions(ctx: ShotSlotContext): ActionDef[] {
  return actionRegistry.all().filter((a) => !a.when || a.when(ctx));
}
