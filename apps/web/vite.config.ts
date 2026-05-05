import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy /api in dev so the SPA always uses relative URLs and the same
    // request paths work in prod (where nginx terminates TLS and routes
    // /api/* to the api container). Includes SSE — http-proxy-middleware
    // handles streaming responses without buffering.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
