import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build. The Electron main process is plain Node ESM (no bundler).
// relative base so the built index.html loads from file:// inside Electron.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
