import { mergeConfig } from 'vite';
import appConfig from '../vite.config';

/* Builds or serves `phone-doc-harness.html` — see that harness. */
export default mergeConfig(appConfig, {
  optimizeDeps: { entries: ['e2e/phone-doc-harness.html'] },
  build: { rollupOptions: { input: 'e2e/phone-doc-harness.html' } },
});
