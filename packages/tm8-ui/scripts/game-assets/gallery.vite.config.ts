import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({ root, base:'./', plugins:[react()], resolve:{alias:{'@tm8/contract':resolve(root,'../contract/src/index.ts')}}, server:{host:'127.0.0.1',port:4627,strictPort:true}, build:{outDir:resolve(root,'dist-asset-gallery'),rollupOptions:{input:resolve(root,'asset-catalog-dev.html')}} });
