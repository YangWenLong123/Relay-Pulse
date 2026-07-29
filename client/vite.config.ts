import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const extensionBuild = mode === 'extension';

  return {
    base: extensionBuild ? './' : '/',
    plugins: [vue()],
    build: {
      outDir: extensionBuild ? '../extension/dist' : 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/ant-design-vue') || id.includes('node_modules/@ant-design')) return 'antd';
            if (id.includes('node_modules/vue') || id.includes('node_modules/pinia') || id.includes('node_modules/axios')) {
              return 'vendor';
            }
          }
        }
      }
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3100',
          changeOrigin: true
        }
      }
    }
  };
});
