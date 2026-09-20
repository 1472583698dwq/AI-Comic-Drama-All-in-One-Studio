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
    port: 5173,
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
