import { mergeConfig } from 'vite';
import base from '../vite.config';
export default mergeConfig(base,{
 define:{__GAME_VERIFIER_HEAD__:JSON.stringify(process.env.GAME_EXACT_HEAD??'development')},
 optimizeDeps:{entries:['e2e/game-live-real-harness.html']},
 build:{outDir:'dist-game-live',emptyOutDir:true,rollupOptions:{input:'e2e/game-live-real-harness.html'}},
 preview:{host:'127.0.0.1',port:18533,strictPort:true,proxy:{'/v2':{target:process.env.TM8_SERVER_ORIGIN??'http://127.0.0.1:18531',changeOrigin:false,ws:true}}},
});
