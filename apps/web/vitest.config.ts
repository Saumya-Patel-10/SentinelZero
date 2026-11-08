import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// The react-three ecosystem mostly ships no "exports" map, so Node loads their CJS builds, which
// require three.cjs while app code imports three.module.js: two Three.js instances under test only.
// Inlining them and preferring the "module" entry keeps a single ESM copy, as in the Vite build.
const THREE_ECOSYSTEM = [
  /@react-three/,
  /@react-spring/,
  /three-stdlib/,
  /three-mesh-bvh/,
  /troika-three/,
  /maath/,
  /meshline/,
  /camera-controls/,
  /stats-gl/,
  /@monogrid/,
];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    server: {
      deps: {
        inline: THREE_ECOSYSTEM,
      },
    },
  },
  resolve: {
    mainFields: ['module', 'jsnext:main', 'jsnext', 'main'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
