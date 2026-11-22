// Test-only host: production CLI never accepts the sandbox escape hatch.
import { startFillWorker } from '../../dist/browser/worker-main.js';

const worker = await startFillWorker({
  socketPath: process.argv[2],
  runtimeDirectory: process.argv[3],
  timeoutMs: Number(process.argv[4]),
  testOnlyDisableSandbox: true,
});
process.stdout.write('worker-ready\n');
process.once('SIGTERM', () => { void worker.close(); });
