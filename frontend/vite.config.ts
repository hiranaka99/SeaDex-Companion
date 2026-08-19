import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Build straight into the server's `static/` folder so the Node backend serves the
// compiled React app. `emptyOutDir` wipes the old vanilla files (index.html,
// app.js, style.css) and the favicon is re-emitted from `public/`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
  server: {
    // For `npm run dev`: proxy API calls to the TypeScript backend.
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
