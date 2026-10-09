import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import stylex from '@stylexjs/unplugin';

export default defineConfig({
  root: 'web',
  plugins: [stylex.vite({ useCSSLayers: true }), react(), babel({ presets: [reactCompilerPreset()] })],
  publicDir: false,
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8800',
      '/ws': { target: 'ws://127.0.0.1:8800', ws: true },
      '/icons': 'http://127.0.0.1:8800',
      '/vendor': 'http://127.0.0.1:8800'
    }
  }
});
