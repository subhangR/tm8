import { resolve } from 'node:path';
import { mergeConfig } from 'vite';
import production from '../vite.config';

// Isolate this rig's dependency scan from unrelated development HTML fixtures.
// Prebundle lazy renderer imports before the browser's equality assertions.
export default mergeConfig(production, {
  cacheDir: resolve(process.env.GAME_STORAGE_RUN_DIR ?? '/tmp/tm8-storage-acceptance', 'vite-cache'),
  optimizeDeps: {
    entries: ['e2e/game-storage-harness.html'],
    include: [
      'react', 'react-dom/client', '@react-three/fiber', '@react-three/drei',
      'three', 'three/addons/postprocessing/EffectComposer.js',
      'three/addons/postprocessing/RenderPass.js', 'three/addons/postprocessing/ShaderPass.js',
      'three/addons/postprocessing/OutputPass.js', 'three/examples/jsm/utils/SkeletonUtils.js',
      'three/examples/jsm/loaders/GLTFLoader.js', 'three/examples/jsm/libs/meshopt_decoder.module.js',
    ],
  },
});
