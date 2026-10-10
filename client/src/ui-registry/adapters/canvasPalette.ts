import { createElement, type ComponentType } from 'react';
import { register, unregisterSource } from '../registry';
import { CANVAS_PALETTE_HOST } from '../types';
import { CustomNodeRow, ExtNodeRow } from '../entries/canvasPaletteRow';

/**
 * **画布插件节点 → UIRegistry 适配器**（设计 §12 桥接的第三个落地样本：
 * `custom_nodes` + `canvas_nodes` 两个扩展点在「画布操作台」里的行）。
 *
 * 收敛前：`CreativeCanvas` 自己把 `customNodes` / `extNodes` 两个数组 map 成行，点击时直接
 * `createNode(type, freePosition(type), data)` —— 插件增删只能靠「重挂画布 / 事件重拉后重渲染」。
 *
 * 收敛后：
 *   · 每个插件节点是 `host = canvas.palette` 的一条条目（`meta` 留原始声明）；
 *   · 「加节点」由宿主经 `CanvasPaletteBridgeContext` 注入（位置、节点 state、选中只有宿主知道）；
 *   · 宿主每次重拉（`customnode-list-refresh` / `canvasnode-list-refresh`）后调一次
 *     `syncCanvasPaletteEntries()` 即可 —— 行的增删立即可见，不必重挂画布。
 *
 * 内置模板 / 核心 Agent 节点是**宿主 chrome**（不是插件贡献），留在 `CreativeCanvas` 里。
 * 本文件只导出函数（Fast-refresh 约定）：桥接在 `ui-registry/canvasPaletteBridge.ts`、
 * 行组件在 `ui-registry/entries/canvasPaletteRow.tsx`。
 */

/** 每个节点一个**稳定**的组件类型（同一个声明只创建一次，避免重注册时整棵重建） */
const makeRow = (Row: ComponentType<{ spec: any }>, spec: any, name: string): ComponentType => {
  const Bound: ComponentType = () => createElement(Row, { spec });
  Bound.displayName = `${name}(${spec?.id ?? '?'})`;
  return Bound;
};

/**
 * **来源命名空间**：两个扩展点都来自插件包（内置节点不走这里）→ 统一的外部贡献命名空间。
 * 回滚走注册表的 `unregisterSource(source, hostPrefix)`（未完成清单第 9 条）。
 */
const CANVAS_PALETTE_SOURCE = 'plugin:canvas' as const;

/** 回滚**作用域**（审查 L8）：只清 `canvas.palette` 这个挂载点 */
const CANVAS_PALETTE_HOST_PREFIX = CANVAS_PALETTE_HOST;

/**
 * 用最新的两张清单**替换**调色板里的插件节点行。
 * 顺序与改造前一致：先自定义代码节点（order 100+），再扩展节点（order 200+）。
 */
export function syncCanvasPaletteEntries(customNodes: any[], extNodes: any[]): void {
  clearCanvasPaletteEntries();
  const entries = [
    ...(customNodes || []).map((spec, i) => ({
      id: `canvas.palette.custom.${spec.id}`,
      order: 100 + i,
      meta: { customNode: spec },
      render: makeRow(CustomNodeRow, spec, 'CustomNodeRow'),
    })),
    ...(extNodes || []).map((spec, i) => ({
      id: `canvas.palette.ext.${spec.id}`,
      order: 200 + i,
      meta: { canvasNodeSpec: spec },
      render: makeRow(ExtNodeRow, spec, 'ExtNodeRow'),
    })),
  ];
  entries.forEach((e) => register({
    id: e.id,
    kind: 'panel',
    host: CANVAS_PALETTE_HOST,
    order: e.order,
    source: CANVAS_PALETTE_SOURCE,
    meta: e.meta,
    render: e.render,
  }));
}

/** 清空调色板插件节点行（画布卸载时调用，别在注册表里留下陈旧行） */
export function clearCanvasPaletteEntries(): void {
  unregisterSource(CANVAS_PALETTE_SOURCE, CANVAS_PALETTE_HOST_PREFIX);
}
