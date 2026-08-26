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
