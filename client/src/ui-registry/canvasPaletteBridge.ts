import { createContext, useContext } from 'react';

/**
 * **创意画布调色板注入给插件节点行的桥接**（设计 §12 规则 1 / 2 的第三个落地样本）。
 *
 * 为什么需要它：`custom_nodes`（自定义代码节点）与 `canvas_nodes`（声明式扩展节点）的「行」
 * 已经条目化，但「往画布加节点」这件事只有宿主（`CreativeCanvas`）能做 —— 它才知道
 * 视口位置（`freePosition` / `screenToFlowPosition`）、节点的本地 state 与选中逻辑。
 * 于是条目只声明「要创建哪种节点 + 带什么数据」，位置与落库由宿主负责。
 *
 * 约定：`type` 与 `data` 就是改造前 `createNode(type, position, data)` 的前后两段，语义不变；
 * 拖拽用的 `dataTransfer` 键（`application/canvas-nodetype` / `application/canvas-nodeid`）
 * 是画布落地契约，由条目自己写（与宿主读的那一侧成对）。
 *
 * 缺省退化为空实现 → 条目在宿主外渲染（含单测）不崩。
 */

/** 调色板行可创建的节点类型（与 `CreativeCanvas` 的 `createNode` 分支一致） */
export type PaletteNodeType = 'custom' | 'ext-node';

export interface CanvasPaletteBridge {
  /** 在当前画布的空闲位置创建节点；`data` 与改造前的第三个入参一致 */
  createNode: (type: PaletteNodeType, data?: Record<string, any>) => void;
}

const NOOP_BRIDGE: CanvasPaletteBridge = {
  createNode: () => { /* 没有宿主 = 不可创建（宿主外渲染不崩） */ },
};

export const CanvasPaletteBridgeContext = createContext<CanvasPaletteBridge>(NOOP_BRIDGE);

/** 条目侧读取宿主注入的桥接（缺省空实现） */
export const useCanvasPalette = (): CanvasPaletteBridge => useContext(CanvasPaletteBridgeContext);
