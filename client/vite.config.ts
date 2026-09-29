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
    port: 5173,
    strictPort: true,
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
