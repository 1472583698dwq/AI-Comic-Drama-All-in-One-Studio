import { createElement, type ComponentType } from 'react';
import { register, unregisterSource } from '../registry';
import { EXPORTER_ROWS_HOST } from '../types';
import { ExporterRow } from '../entries/exporterRow';
import type { ExporterInfo } from '../../services/exporterSpecs';

/**
 * **导出器（`exporters` 扩展点）→ UIRegistry 适配器**（设计 §12「声明进注册表、回调由宿主注入」的第二个落地样本）。
 *
 * 收敛前：`ExportModal` 自己 `listExporterSpecs()`，把列表 map 成卡片，按钮直接调 `apiService.runExporter` ——
 * 插件增删只能靠「重开弹窗时重同步」。
 *
 * 收敛后：
 *   · 每个导出器是 `host = modal.export` 的一条 `UIEntry`（`meta.exporter` 留原始声明）；
 *   · 条目只渲染「一行」（`entries/exporterRow.tsx`），运行导出的能力由宿主经 `ExportBridgeContext` 注入
 *     （它才知道 project、忙碌态与结果）；宿主外渲染退化为空实现，条目因此可单测、不崩；
 *   · 插件增删只需宿主重跑一次 `syncExporterEntries()`，列表立即跟着变（不必重挂弹窗）。
 *
 * 与分镜槽适配器的差别：槽的渲染要 `ctx`（宿主按 ctx 渲染文档），这里没有 ctx ——
 * 条目靠 context 拿回调，所以 `render` 是**真实组件**（不是占位），`meta` 只作声明留档。
 *
 * 本文件只导出函数（Fast-refresh 约定）：桥接在 `ui-registry/exportBridge.ts`、行组件在 `entries/exporterRow.tsx`。
 */

/** 每个导出器一个**稳定**的组件类型（同一个 spec 只创建一次，避免重注册时整棵重建） */
const makeExporterRow = (spec: ExporterInfo): ComponentType => {
  // 用 createElement 而不是 JSX：本文件保持 `.ts`（只导出函数，Fast-refresh 约定见文件头）
  const Row: ComponentType = () => createElement(ExporterRow, { spec });
  Row.displayName = `ExporterRow(${spec.id})`;
  return Row;
};

/**
 * **来源命名空间**：`ExporterInfo` 没有发布者字段，导出器统一归到「外部贡献」。
 * 回滚走注册表的 `unregisterSource(source, hostPrefix)`（未完成清单第 9 条）——
 * 与分镜槽 loader 同一条路径，不再自建逐条 undo 账。
 */
const EXPORTER_SOURCE = 'plugin:exporter' as const;

/** 回滚**作用域**（审查 L8）：只清本适配器登记的挂载点，不按来源字符串全局删 */
const EXPORTER_HOST_PREFIX = EXPORTER_ROWS_HOST;

/**
 * 用最新的导出器列表**替换**注册表里的导出器条目（宿主每次 `listExporterSpecs()` 之后调用）。
 * 先按来源撤旧的再注册新的：与后端 `/exporters` 的返回保持一致，不留陈旧行。
 */
export function syncExporterEntries(specs: ExporterInfo[]): void {
  clearExporterEntries();
  specs.forEach((spec, i) => register({
    id: `exporter.${spec.id}`,
    kind: 'panel',
    host: EXPORTER_ROWS_HOST,
    order: 100 + i,
    source: EXPORTER_SOURCE,
    meta: { exporter: spec },
    render: makeExporterRow(spec),
  }));
}

/** 清空导出器条目（宿主关闭 / 卸载时调用，避免注册表里留下「上次打开时」的陈旧列表） */
export function clearExporterEntries(): void {
  unregisterSource(EXPORTER_SOURCE, EXPORTER_HOST_PREFIX);
}
