import { mergeConfig } from 'vite';
import base from '../vite.config';
export default mergeConfig(base,{optimizeDeps:{entries:['e2e/game-live-real-harness.html']}});
