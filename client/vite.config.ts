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
    rollupOptions: {
      input: {
        main: `${import.meta.dirname}/index.html`,
        mobile: `${import.meta.dirname}/mobile.html`,
      },
    },
  },
})
