import { create } from 'zustand';

/**
 * 壳级状态：**只放「最小形态锁定壳」自己需要、又不属于任何 store 的东西**。
 *
 * 目前只有一项：启动时 MCP 工具拉取失败的错误文案（原先是 App 的局部 state）。
 * 壳条目搬进注册表槽位后读不到 App 的局部 state，状态载体换成这个小 store，
 * 触发时机与展示位置都不变（App 启动 effect 里写入，顶栏壳的横幅条目读它）。
 *
 * 至于 `apiError`：它本来就是 `useProjectStore` 的状态，壳条目直接读那个 store，
 * 不在这里重复一份（避免两个真相源）。
 */
interface ShellStatusState {
  mcpError: string | null;
  setMcpError: (msg: string | null) => void;
}

export const useShellStatusStore = create<ShellStatusState>((set) => ({
  mcpError: null,
  setMcpError: (msg) => set({ mcpError: msg }),
}));
