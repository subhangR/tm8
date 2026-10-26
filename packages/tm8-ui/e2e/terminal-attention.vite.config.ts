import { mergeConfig } from 'vite';
import appConfig from '../vite.config';
export default mergeConfig(appConfig, { optimizeDeps: { entries: ['e2e/terminal-attention-harness.html'] } });
