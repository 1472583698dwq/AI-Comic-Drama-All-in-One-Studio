import { createContext, useContext } from 'react';

/**
 * 宿主（顶栏）注入给 toolbar 动作条目的回调（「声明进注册表、回调由宿主注入」的最小形态）。
 *
 * 背景：工具动作条目化后，条目组件拿不到 `Header` 的局部 `moreOpen` state，而
 * 「点动作 → 先收起『更多』菜单 → 再执行动作」是改造前就有的行为，必须保持不变。
 * 于是由宿主提供一个 context：条目执行动作前调 `closeMenu()`。
 *
 * 与 `modalIntents` 的分工：动作要打开的弹窗走 `modalIntents`（全局意图 store），
 * 这里只管**宿主自己的 chrome**（菜单开合）—— 两者都不新增后端契约。
 */
export interface ToolbarChrome {
  /** 收起「更多」菜单（无菜单的宿主传空实现） */
  closeMenu: () => void;
}

const NOOP: ToolbarChrome = { closeMenu: () => { /* 无宿主菜单时什么也不做 */ } };

export const ToolbarChromeContext = createContext<ToolbarChrome>(NOOP);

/** 条目侧读取宿主注入的 chrome 回调（缺省空实现，宿主外渲染也不会崩） */
export const useToolbarChrome = (): ToolbarChrome => useContext(ToolbarChromeContext);
