import { createContext, useContext } from 'react';

/**
 * **3D 片场注入给导演包条目的桥接**（设计 §12 规则 1 / 2 的第四个落地样本：
 * `director_packs` 的 `props` / `environments` 两个表面）。
 *
 * 为什么需要它：道具行与环境预设行的「按下之后发生什么」全在舞台里 ——
 *   · 道具：改 `propsConfig`（那段 state 同时驱动场景重建与 `useEffect` 里的 GLB 装配）；
 *   · 环境：改 `packEnvId` + 场景描述（背景底图由 `getDirectorPackEnv(id).background_url` 取）。
 * 这两件事都只有舞台宿主能做（它才持有 three.js 场景与镜头），所以条目只报 id：
 * `toggleProp(id)` / `applyEnvironment(id)`，选中态再用 `isPropOn(id)` /
 * `activeEnvironmentId` 读回去 —— 行 UI 由条目渲染，状态必须一起注入。
 *
 * 缺省退化为空实现 → 条目在宿主外渲染（含单测）不崩。
 *
 * 注：`director_packs.presets`（framing / motion / pose / cast）**有意不进注册表** ——
 * 它们不是「一组行」，而是被 `applyDirectorPackPresets()` 合并进舞台与画布节点共用的
 * 同源数组（`directorPresets`）的数据，属于数据合并而非 UI 挂载点（见 §12.2 表的边界说明）。
 */

export interface DirectorPackBridge {
  /** 切换某个插件道具的启用状态（等价于改造前 `setPropsConfig` 里的 toggle） */
  toggleProp: (id: string) => void;
  /** 该插件道具当前是否启用（行要渲染选中态） */
  isPropOn: (id: string) => boolean;
  /** 切到某个插件环境（等价于改造前 `setPackEnvId(id)` + 场景描述） */
  applyEnvironment: (id: string) => void;
  /** 当前选中的插件环境 id（'' = 没选插件环境） */
  activeEnvironmentId: string;
}

const NOOP_BRIDGE: DirectorPackBridge = {
  toggleProp: () => { /* 没有宿主 = 不可切换 */ },
  isPropOn: () => false,
  applyEnvironment: () => { /* 没有宿主 = 不可切换 */ },
  activeEnvironmentId: '',
};

export const DirectorPackBridgeContext = createContext<DirectorPackBridge>(NOOP_BRIDGE);

/** 条目侧读取宿主注入的桥接（缺省空实现） */
export const useDirectorPackBridge = (): DirectorPackBridge => useContext(DirectorPackBridgeContext);
