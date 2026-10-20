import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // changeOrigin rewrites Host to the API's own address, which the API requires.
    proxy: { '/api': { target: 'http://127.0.0.1:4477', changeOrigin: true } },
  },
});
