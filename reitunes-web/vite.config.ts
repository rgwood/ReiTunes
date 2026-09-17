import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'local-tagging-experiment',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/tagging-experiment.json', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('{"error":"Read only"}');
          return;
        }
        try {
          res.end(await readFile(new URL('../target/tagging/experiment.json', import.meta.url)));
        } catch {
          res.statusCode = 404;
          res.end('{"error":"No local tagging experiment prepared"}');
        }
      });
    },
  }],
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
    rollupOptions: {
      input: { main: 'index.html', tagging: 'tagging.html' },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
})
