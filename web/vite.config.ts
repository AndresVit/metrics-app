import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      // Allows web code to import pure engine modules without deep relative paths.
      // e.g. import { buildStripes } from '@time-patterns/stripeEngine'
      '@time-patterns': path.resolve(__dirname, '../src/time-patterns'),
    },
  },
})
