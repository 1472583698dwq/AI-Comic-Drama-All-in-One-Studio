// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas（E2E-3 发现 4）：迁移后的一次性去重叠（canvasLoad.resolveOverlaps）要在**媒体尺寸确定之后**做。
 *
 * 节点第一次测量完时，图片 / 视频卡片多半还是占位高度；媒体加载出来后卡片才长高，提前去重叠排好的位置
 * 又会被盖住（视频生成卡片压住下面的节点）。这里等到：画布里的 <img> / <video> 都拿到尺寸（或出错）
 * 且节点测量尺寸连续 quietMs 没再变化，再执行；最长等 maxWaitMs（媒体一直加载不出来也照做）。
 */
import { useEffect, useRef } from 'react';
import type { Node } from '@xyflow/react';

export interface SettleOptions {
  /** 尺寸连续不变多久算稳定（ms） */
  quietMs?: number;
  /** 最长等待（ms），到点无论如何都执行 */
  maxWaitMs?: number;
  /** 轮询间隔（ms） */
  intervalMs?: number;
}

const DEFAULTS: Required<SettleOptions> = { quietMs: 400, maxWaitMs: 6000, intervalMs: 100 };

/** 顶层节点的测量尺寸签名（分组 / 子节点不参与去重叠） */
export function measuredSizeKey(nodes: readonly Pick<Node, 'id' | 'type' | 'parentId' | 'measured' | 'hidden'>[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.parentId || n.hidden || n.type === 'group') continue;
    parts.push(`${n.id}:${Math.round(n.measured?.width ?? 0)}x${Math.round(n.measured?.height ?? 0)}`);
  }
  return parts.join('|');
}

/** 容器里的媒体都已知尺寸（图片加载完 / 视频拿到元数据；出错、没地址的也算完） */
export function mediaSettled(root: ParentNode | null | undefined): boolean {
  if (!root) return true;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.getAttribute('src') && !img.complete) return false;
  }
  for (const v of Array.from(root.querySelectorAll('video'))) {
    const hasSrc = !!(v.currentSrc || v.getAttribute('src') || v.querySelector('source[src]'));
    if (hasSrc && !v.error && v.readyState < 1) return false;
  }
  return true;
}

/** 纯逻辑：每次 tick 判断是否到了执行时机（测试注入 now） */
export function createSettleGate(getKey: () => string, isReady: () => boolean, opts: SettleOptions = {}, now: () => number = Date.now) {
  const { quietMs, maxWaitMs } = { ...DEFAULTS, ...opts };
  const start = now();
  let last = getKey();
  let since = start;
  return {
    tick(): boolean {
      const t = now();
      const k = getKey();
      if (k !== last) { last = k; since = t; }
      return (isReady() && t - since >= quietMs) || t - start >= maxWaitMs;
    },
  };
}

/**
 * armed 变 true 后开始等，时机到了调用一次 run（之后需重新 armed 才会再跑）。
 * getKey / getRoot 每次 tick 现取（读 ref），run 也取最新的引用。
 */
export function useSettledRun(armed: boolean, run: () => void, getKey: () => string, getRoot: () => ParentNode | null | undefined, opts: SettleOptions = {}): void {
  const latest = useRef({ run, getKey, getRoot });
  latest.current = { run, getKey, getRoot };
  const { intervalMs } = { ...DEFAULTS, ...opts };
  const optsKey = JSON.stringify(opts);
  useEffect(() => {
    if (!armed) return;
    const gate = createSettleGate(() => latest.current.getKey(), () => mediaSettled(latest.current.getRoot()), JSON.parse(optsKey) as SettleOptions);
    const id = window.setInterval(() => {
      if (!gate.tick()) return;
      window.clearInterval(id);
      latest.current.run();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [armed, intervalMs, optsKey]);
}
