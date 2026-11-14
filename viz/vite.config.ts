import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// fs.allow: the sample logs live in ../tests/fixtures and ../logs/runs, outside this folder.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { fs: { allow: ['..'] } },
});
