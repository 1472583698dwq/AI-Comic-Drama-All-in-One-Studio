import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 前端自动化验收（《UI开关热插拔设计》§7 / 未完成清单第 12 条）。
 *
 * 只跑 `src/**\/*.test.ts(x)`，jsdom 环境；**不连后端**：
 *   · 前端可测的：注册表契约、开关放行、槽渲染 / 错误隔离 / 版本回落、卸载清理、
 *     事件广播过滤、归一页签；
 *   · 后端契约行为（关页 → 接口 404、feature 闸）由 `server/tests` 的 pytest 覆盖，
 *     这里不重复（也不 mock 出「假后端」）。
 *
 * `globals: true` 只为让 @testing-library/react 的自动 cleanup 生效（它读全局 `afterEach`）；
 * 用例里仍显式 `import { ... } from 'vitest'`，类型上不依赖全局声明。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
