import { mergeConfig } from 'vite';
import appConfig from '../vite.config';

/* A static build of the Projects UI harness, for screenshots on a busy host. */
export default mergeConfig(appConfig, {
  build: {
    outDir: '/tmp/pui-dist',
    emptyOutDir: true,
    rollupOptions: { input: 'e2e/projects-ui-harness.html' },
  },
});
