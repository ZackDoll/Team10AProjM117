import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { runApi } from './server/runApi.ts';

// fs.allow: the sample logs live in ../tests/fixtures, outside this folder.
// watch.ignored: runs write to ../logs and ../.cache while the page is open; reloading on those
// writes would wipe the page mid-run. New logs reach the page through /api instead.
export default defineConfig({
  base: './',
  plugins: [react(), runApi()],
  server: {
    fs: { allow: ['..'] },
    watch: { ignored: ['**/logs/**', '**/.cache/**', '**/.venv/**', '**/__pycache__/**'] },
  },
});
