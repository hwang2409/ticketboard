import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env.VITE_PORT ?? 4317);
const hmrPort = process.env.TICKETBOARD_VITE_HMR_PORT
  ? Number(process.env.TICKETBOARD_VITE_HMR_PORT)
  : undefined;

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) {
            return undefined;
          }
          if (id.includes('/lucide-react/')) {
            return 'icons';
          }
          if (id.includes('/react-markdown/') || id.includes('/remark-gfm/')) {
            return 'markdown';
          }
          return 'vendor';
        },
      },
    },
  },
  server: {
    port,
    hmr: hmrPort ? { port: hmrPort } : undefined,
  },
});
