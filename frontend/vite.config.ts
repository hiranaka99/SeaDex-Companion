import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build straight into the Flask `static/` folder so `app.py` serves the
// compiled React app. `emptyOutDir` wipes the old vanilla files (index.html,
// app.js, style.css) and the favicon is re-emitted from `public/`.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
  server: {
    // For `npm run dev`: proxy API calls to the Flask backend.
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})