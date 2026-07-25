// Standalone stub runner: `bun run stub` (or node dist/stub-main.js).
// Listens on TM8_CONFORMANCE_STUB_PORT (default 4610).
import { startStubServer } from './stub-server.js';

const port = Number(process.env.TM8_CONFORMANCE_STUB_PORT ?? 4610);
startStubServer(port).then(() => {
  console.log(`tm8 conformance stub listening on http://127.0.0.1:${port}`);
}).catch((e) => {
  console.error('stub failed to start:', e);
  process.exit(1);
});
