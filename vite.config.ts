import { defineConfig } from 'vite';

// relative base: the site works from any sub-path (GitHub Pages serves it at /<repo>/)
export default defineConfig({
  base: './',
  build: {
    rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : undefined) } },
    chunkSizeWarningLimit: 800,
  },
});
