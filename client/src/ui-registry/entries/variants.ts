import { DEFAULT_VARIANT } from '../types';

/**
 * 前端版本元数据（设计 §2.4.1）。
 *
 * `default` = **测试初期版本（保底）**：即当前这一版前端，重构期间随时可切回；
 * `next`    = 重构新版占位：本轮只登记条目、渲染「待接入」占位。
 *
 * 版本不进开关层（不是第 5 类开关）：它只是注册表条目的标签 + 一条 prefs 单选偏好。
 * 加新版本 = 在这里加一行 + 在 `entries/pages.tsx` 为需要的页面登记对应 variant 的条目。
 */
export interface VariantMeta {
  id: string;
  label: string;
  description: string;
}

/** `next` 变体标识（逐页接入中的重构新版）；`entries/pages.tsx` 用它决定是否套 `nextView` */
export const NEXT_VARIANT = 'next';

export const VARIANT_META: VariantMeta[] = [
  {
    id: DEFAULT_VARIANT,
    label: '测试初期版本（保底）',
    description: '当前这一版前端，行为与既有一致；重构期间出问题可逐页切回',
  },
  {
    id: NEXT_VARIANT,
    label: '重构新版（逐页接入中）',
    description: '重构目标版本：已接入的页直接渲染新版实现，未接入的仍是「待接入」占位',
  },
];

const BY_ID = new Map(VARIANT_META.map((m) => [m.id, m]));

/** 面板展示顺序（也用于版本列表排序） */
export const VARIANT_ORDER: string[] = VARIANT_META.map((m) => m.id);

export const variantLabel = (id: string): string => BY_ID.get(id)?.label || id;
export const variantDescription = (id: string): string => BY_ID.get(id)?.description || '';
