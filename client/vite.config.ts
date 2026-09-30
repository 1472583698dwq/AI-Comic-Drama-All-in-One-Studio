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
    // 端口必须留在 51xx 段：`src/utils/devOrigin.ts` 用 /^51\d\d$/ 判定「是否 dev 前端」，
    // 不在该段时 /storage、/assets 等相对产物 URL 不会回源到后端，预览/缩略图全 404。
    // 5173 常被其它项目占用（本机实测被别的 vite 占），默认改到 5188；被占时 vite 会自动 +1，
    // 仍落在 51xx 段内，因此不加 strictPort。
    port: 5188,
  },
  build: {
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: `${import.meta.dirname}/index.html`,
        mobile: `${import.meta.dirname}/mobile.html`,
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
