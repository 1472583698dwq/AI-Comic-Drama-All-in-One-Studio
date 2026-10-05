import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    // master 工作副本固定 5173（与 multi_ai_simpleuse 的 5174 并存）
    // 端口必须留在 51xx 段：`src/utils/devOrigin.ts` 用 /^51\d\d$/ 判定「是否 dev 前端」，
    // 不在该段时 /storage、/assets 等相对产物 URL 不会回源到后端，预览/缩略图全 404。
    // 本机 5173 空闲；被占时 strictPort 会明确报错而不是悄悄漂移，届时再改端口即可。
    port: 5173,
    strictPort: true,
  },
  build: {
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        // 精简链路：移动端卡片流入口（mobile.html / src/mobile-main.tsx）已随
        // 「分镜工作台 → 移动卡片流」这条链路一起下线，只保留主应用单入口。
        main: `${import.meta.dirname}/index.html`,
      },
      output: {
        manualChunks: (id: string) => {
          if (id.includes('node_modules/@xyflow')) return 'xyflow';
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/framer-motion')) return 'motion';
          if (id.includes('node_modules/react') || id.includes('node_modules/zustand')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
})
