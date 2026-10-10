import { createContext, useContext } from 'react';

/**
 * **导出中心（`ExportModal`）注入给导出器条目的桥接**（设计 §12 规则 1 / 2 的落地样本）。
 *
 * 为什么需要它：导出器行「运行导出」的能力只有宿主知道（project 装配、忙碌态、结果回填），
 * 而条目是注册表渲染的、拿不到宿主的局部 state。于是宿主用 context 注入：
 *   · 条目只报 `runExport(id)` —— 注册表**不认识**这个回调的类型，只保证条目在不在；
 *   · `busyId` / `results` 一并注入，因为**行 UI 由条目渲染**（宿主只管数据与回调）；
 *   · 缺省退化为空实现 → 宿主外渲染（含单测）不崩。
 *
 * 与 `toolbarContext.ts` 同一套约定：**每个宿主一个具体 context**，不搞通用 DI 容器。
 * 独立成文件的原因：`adapters/*` 与 `entries/*` 是「只导出组件」的文件，context / 类型放这里两边都干净。
 */

export interface ExportBridge {
  /** 运行某个导出器（宿主侧实现：装配 project → 调 `/exporters/{id}/run` → 记录结果） */
  runExport: (id: string) => void;
  /** 正在运行的导出器 id（'' = 空闲） */
  busyId: string;
  /** 每个导出器的最近一次结果（含 `error`） */
  results: Record<string, any>;
}

const NOOP_BRIDGE: ExportBridge = {
  runExport: () => { /* 没有宿主 = 不可导出（宿主外渲染不崩） */ },
  busyId: '',
  results: {},
};

export const ExportBridgeContext = createContext<ExportBridge>(NOOP_BRIDGE);

/** 条目侧读取宿主注入的桥接（缺省空实现） */
export const useExportBridge = (): ExportBridge => useContext(ExportBridgeContext);
