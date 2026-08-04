import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, open: true },
  build: {
    target: 'es2020',
    // Three.js alone is ~565 kB minified and can't usefully be split further.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Three.js and the charting library change far less often than app code,
        // so keeping them in their own chunks keeps reloads cheap.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three'
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3')) return 'charts'
          return undefined
        },
      },
    },
  },
})
