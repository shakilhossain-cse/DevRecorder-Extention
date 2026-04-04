import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { build as viteBuild } from 'vite';

// Content scripts that must be plain IIFE (no imports)
const contentScripts = {
  'content/content': resolve(__dirname, 'src/content/content.ts'),
  'content/page-agent': resolve(__dirname, 'src/content/page-agent.ts'),
  'content/drawing-overlay': resolve(__dirname, 'src/content/drawing-overlay.ts'),
  'content/region-selector': resolve(__dirname, 'src/content/region-selector.ts'),
  'content/auth-detector': resolve(__dirname, 'src/content/auth-detector.ts'),
};

// Plugin to build content scripts separately as IIFE after the main build
function contentScriptPlugin() {
  return {
    name: 'build-content-scripts',
    closeBundle: async () => {
      for (const [name, entry] of Object.entries(contentScripts)) {
        await viteBuild({
          configFile: false,
          build: {
            outDir: 'dist',
            emptyOutDir: false,
            minify: false,
            lib: {
              entry,
              name: name.replace(/\//g, '_'),
              formats: ['iife'],
              fileName: () => `${name}.js`,
            },
            rollupOptions: {
              output: {
                extend: true,
              },
            },
          },
          resolve: {
            alias: {
              '@shared': resolve(__dirname, 'src/shared'),
            },
          },
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), contentScriptPlugin()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        viewer: resolve(__dirname, 'viewer.html'),
        offscreen: resolve(__dirname, 'offscreen.html'),
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
