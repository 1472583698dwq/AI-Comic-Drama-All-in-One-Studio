// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 产物节点摆放（纯函数，照 Toonflow imageGridSplit.vue）：宫格切分、角色参考。
 * 单个产物（标记结果）不在这里算坐标，交给宿主 createNodes 的 Toonflow 摆放。
 *
 * 坐标系：画布绝对坐标（flow 坐标系）。REQ-toonflow-canvas F1：K1 (h) 约定 `NewNodeSpec.position` 是绝对坐标，
 * 锚点在分组里时由宿主 / kit createNodesLocal 让新节点继承锚点 parentId 并换算成相对坐标；
 * 所以 siblingRects 先把锚点与同层节点换算成绝对矩形，下面的版式函数直接产出绝对坐标。
 */
import type { Node } from '@xyflow/react';
import { absolutePosition } from '../../kit/graphOps';
import { CARD_EXTRA, MEDIA_HEIGHT, mediaNodeWidth } from './media';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Toonflow：产物放在锚点右侧 80px。 */
export const SIDE_GAP = 80;
/** 避让时与上方节点的竖向间距。 */
export const STACK_GAP = 40;
/** 宫格切分：列间距 40、行距 320（240 预览 + 标题与卡片外扩）。 */
export const GRID_GAP_X = 40;
export const GRID_ROW_PITCH = 320;
/** 尺寸未知的节点按 220×(240+标题) 估算。 */
export const DEFAULT_NODE_WIDTH = 220;
export const DEFAULT_NODE_HEIGHT = MEDIA_HEIGHT + CARD_EXTRA + 28;

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Toonflow 避让：从锚点 y 开始，按 y 升序扫一遍其他节点，压到目标矩形就挪到它下方 40px。
 * 返回目标矩形最终的 y。
 */
export function freeY(target: Rect, others: readonly Rect[], gap = STACK_GAP): number {
  let y = target.y;
  for (const o of [...others].sort((a, b) => a.y - b.y)) {
    if (overlaps({ ...target, y }, o)) y = o.y + o.height + gap;
  }
  return y;
}

/** 宫格切块节点的估算宽度（Toonflow：块宽/块高 × 240 + 18）。 */
export function tileNodeWidth(tileWidth: number, tileHeight: number): number {
  return mediaNodeWidth({ width: tileWidth, height: tileHeight }) ?? DEFAULT_NODE_WIDTH;
}

export interface GridLayoutOptions {
  anchor: Rect;
  rows: number;
  cols: number;
  /** 切块节点宽（tileNodeWidth）。 */
  tileWidth: number;
  others: readonly Rect[];
}

/**
 * 宫格切分的 N 个节点位置（行优先，index = row*cols + col），照 Toonflow：
 * 整块网格放在锚点右侧 80px；网格矩形压到已有节点就整体下移；块间距 40、行距 320。
 */
export function gridSplitPositions({ anchor, rows, cols, tileWidth, others }: GridLayoutOptions): Point[] {
  const gridWidth = cols * (tileWidth + GRID_GAP_X) - GRID_GAP_X;
  const gridHeight = rows * GRID_ROW_PITCH - 20;
  const x = anchor.x + anchor.width + SIDE_GAP;
  const y = freeY({ x, y: anchor.y, width: gridWidth, height: gridHeight }, others);
  const out: Point[] = [];
  for (let i = 0; i < rows * cols; i++) {
    out.push({ x: x + (i % cols) * (tileWidth + GRID_GAP_X), y: y + Math.floor(i / cols) * GRID_ROW_PITCH });
  }
  return out;
}

/**
 * 参考素材（角色三视图等）放到锚点左侧，从锚点 y 起竖向排列，逐个避让。
 * 返回每个节点的左上角。
 */
export function stackLeftOf(anchor: Rect, count: number, others: readonly Rect[], size = { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT }): Point[] {
  const x = anchor.x - SIDE_GAP - size.width;
  const placed: Rect[] = [];
  const out: Point[] = [];
  let y = anchor.y;
  for (let i = 0; i < count; i++) {
    y = freeY({ x, y, width: size.width, height: size.height }, [...others, ...placed]);
    out.push({ x, y });
    placed.push({ x, y, width: size.width, height: size.height });
    y += size.height + STACK_GAP;
  }
  return out;
}

/** React Flow 节点 → 矩形（node.position 所在坐标系；尺寸优先用测量值）。 */
export function nodeRect(n: Pick<Node, 'position' | 'measured' | 'width' | 'height'>): Rect {
  return {
    x: n.position.x,
    y: n.position.y,
    width: n.measured?.width ?? n.width ?? DEFAULT_NODE_WIDTH,
    height: n.measured?.height ?? n.height ?? DEFAULT_NODE_HEIGHT,
  };
}

/**
 * 锚点与同一父级的其他节点矩形，**画布绝对坐标**（REQ-toonflow-canvas F1）。
 * 同层节点共用父级原点：父级绝对坐标 = 锚点绝对坐标 − 锚点 position（沿 parentId 链累加，带环保护）。
 */
export function siblingRects(nodes: readonly Node[], anchorId: string): { anchor: Rect | null; others: Rect[] } {
  const anchorNode = nodes.find((n) => n.id === anchorId);
  if (!anchorNode) return { anchor: null, others: [] };
  const abs = absolutePosition(anchorNode, new Map(nodes.map((n) => [n.id, n])));
  const dx = abs.x - anchorNode.position.x;
  const dy = abs.y - anchorNode.position.y;
  const absRect = (n: Node): Rect => {
    const r = nodeRect(n);
    return { ...r, x: r.x + dx, y: r.y + dy };
  };
  const parent = anchorNode.parentId ?? null;
  const others = nodes
    .filter((n) => n.id !== anchorId && (n.parentId ?? null) === parent && !n.hidden)
    .map(absRect);
  return { anchor: absRect(anchorNode), others };
}
