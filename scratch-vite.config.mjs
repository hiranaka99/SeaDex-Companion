import baseConfig from './frontend/vite.config.ts'
export default {
  ...baseConfig,
  root: 'frontend',
  server: { ...baseConfig.server, port: 5173, proxy: { '/api': 'http://127.0.0.1:8123' } },
}
