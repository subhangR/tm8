import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';

// The production plugins and proxy, with all Vite writes inside this checkout.
export default mergeConfig(base, defineConfig({
  cacheDir: '.taskland-cache/vite',
  server: { host: '127.0.0.1', strictPort: true },
}));
