/**
 * 画布自动放置：所有「程序替用户放卡片」的入口统一走这里，保证不与已有卡片重叠。
 *
 * 规则（与上下游数据流方向一致）：
 * - 输入卡（参考图/首帧/参考音频…）：放在目标卡左侧一列，从目标卡顶边起向下找第一个空位竖排；
 * - 衍生卡（「+」快速衍生、复制）：放在源卡右侧一列，从源卡顶边起向下找第一个空位竖排；
 * - 成组卡（模板、分镜子图）：整组平移到现有内容下方，组内相对布局不变；
 * - 独立卡（工作台点选、素材导入）：从给定锚点（通常是视口中心）所在列向下找空位。
 *
 * 尺寸优先取 React Flow 实测的 measured，新卡片尚未测量时按类型估算（宁大勿小，留出间距）。
 */

export interface LayoutNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  width?: number;
  height?: number;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** 列间距 / 同列卡片间距 */
export const GAP_X = 120;
export const GAP_Y = 48;

const EST: Record<string, [number, number]> = {
  prompt: [360, 280],
  image: [360, 440],
  video: [360, 440],
  audio: [360, 340],
  director3d: [360, 440],
  export: [360, 280],
  timeline: [520, 380],
  'text-prompt': [300, 200],
  'load-image': [260, 320],
  'load-image-batch': [300, 280],
  'load-video': [260, 300],
  'load-audio': [260, 200],
  custom: [340, 380],
  'ext-node': [340, 380],
};

export function estimateSize(type?: string): { w: number; h: number } {
  const [w, h] = EST[type || ''] || [360, 360];
  return { w, h };
}

export function rectOf(n: LayoutNode): Rect {
  const est = estimateSize(n.type);
  return {
    x: n.position?.x ?? 0,
    y: n.position?.y ?? 0,
    w: n.measured?.width || n.width || est.w,
    h: n.measured?.height || n.height || est.h,
  };
}

const overlaps = (a: Rect, b: Rect, pad: number) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/**
 * 在 x 固定的一列里，从 startY 向下找第一个不与 occupied 冲突的 y。
 * 命中冲突就跳到冲突卡片底边之下继续找，天然形成「竖列依次排开」。
 */
export function findFreeInColumn(occupied: Rect[], x: number, startY: number, w: number, h: number, pad = GAP_Y / 2): { x: number; y: number } {
  let y = startY;
  for (let guard = 0; guard < 500; guard++) {
    const cand: Rect = { x, y, w, h };
    const hit = occupied.filter((r) => overlaps(cand, r, pad));
    if (!hit.length) return { x, y };
    y = Math.max(...hit.map((r) => r.y + r.h)) + GAP_Y;
  }
  return { x, y };
}

/**
 * 目标卡左侧一列（上游输入）。
 * existingUpstream：已经连进目标卡的上游卡 —— 有的话就并入它们那一列（右边缘对齐离目标最近的那张），
 * 否则新开一列（目标左边 GAP_X）。
 */
export function placeUpstream(occupied: Rect[], target: Rect, w: number, h: number, existingUpstream: Rect[] = []) {
  const left = existingUpstream.filter((r) => r.x + r.w <= target.x);
  const right = left.length ? Math.max(...left.map((r) => r.x + r.w)) : target.x - GAP_X;
  return findFreeInColumn(occupied, right - w, target.y, w, h);
}

/**
 * 源卡右侧一列（下游衍生）。existingDownstream：源卡已有的下游卡 —— 有的话并入它们那一列（左边缘对齐最近的那张）。
 */
export function placeDownstream(occupied: Rect[], source: Rect, w: number, h: number, existingDownstream: Rect[] = []) {
  const right = existingDownstream.filter((r) => r.x >= source.x + source.w);
  const x = right.length ? Math.min(...right.map((r) => r.x)) : source.x + source.w + GAP_X;
  return findFreeInColumn(occupied, x, source.y, w, h);
}

/** 独立卡：锚点所在列向下找空位 */
export function placeNear(occupied: Rect[], anchor: { x: number; y: number }, w: number, h: number) {
  return findFreeInColumn(occupied, anchor.x, anchor.y, w, h);
}

/**
 * 成组卡：返回整组平移量。空画布放在 (baseX, baseY)；否则整组放到现有内容下方、与最左侧对齐。
 * blockRects 为组内卡片（以 0,0 为组原点的相对坐标）。
 */
export function placeBlock(occupied: Rect[], blockRects: Rect[], baseX = 120, baseY = 80): { dx: number; dy: number } {
  const minBX = Math.min(...blockRects.map((r) => r.x));
  const minBY = Math.min(...blockRects.map((r) => r.y));
  if (!occupied.length) return { dx: baseX - minBX, dy: baseY - minBY };
  const left = Math.min(...occupied.map((r) => r.x));
  const bottom = Math.max(...occupied.map((r) => r.y + r.h));
  return { dx: left - minBX, dy: bottom + GAP_Y * 2 - minBY };
}
