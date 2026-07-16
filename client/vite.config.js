import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `npm run dev` in client/ proxies the API and socket to a locally
    // running server, so HMR dev works end-to-end.
    proxy: {
      '/api': { target: 'http://localhost:3000' },
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
