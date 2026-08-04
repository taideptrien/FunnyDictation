import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode, command }) => {
  // Load .env from the frontend directory
  const env = loadEnv(mode, '.', '');

  const apiTarget = env.VITE_API_URL || 'http://localhost:5001';

  // Set base path: process.env.VITE_BASE_PATH (e.g. '/FunnyDictation/' for GitHub Pages), else '/'
  const base = process.env.VITE_BASE_PATH || '/';

  return {
    base,
    plugins: [react()],
    server: {
      port: 3000,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true
        }
      }
    }
  };
});
