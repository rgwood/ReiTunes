import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/upload': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        // Don't buffer the request body for file uploads
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Forward the original content-type header exactly
            if (req.headers['content-type']) {
              proxyReq.setHeader('content-type', req.headers['content-type']);
            }
          });
        },
      },
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/ui': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/login': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/updates': {
        target: 'ws://localhost:5000',
        ws: true,
      },
      '/music': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
