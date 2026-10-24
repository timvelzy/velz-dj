import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base: the same dist/ works at a domain root OR under a
  // subpath (e.g. GitHub Pages project sites) without a rebuild.
  base: './',
  plugins: [react(), tailwindcss()],
  worker: {
    format: 'es',
  },
});
