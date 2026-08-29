/**
 * P1 source-boot entry. This "test" never completes on success — it boots the real
 * tm8 server composition root (`bootstrap()` from `packages/server/src/main.ts`, via
 * the `@tm8/server-src-main` alias in ./vitest.config.ts) on a REAL port against the
 * shared dev sidecar, then blocks forever so the process stays alive for other lanes
 * (browser terminal, delivery worker) to connect to.
 *
 * Never `tm8_dev`-scratch, never ephemeral: this IS the dev node, intentionally, per
 * the P1 task brief. Env (TM8_DATABASE_URL, TM8_DELIVERY_DATABASE_URL, TM8_PORT,
 * TM8_AGENT_CMD, etc.) comes from the process environment set by run-server.sh —
 * nothing is hardcoded here so the same file works for the "fast path" (TM8_AGENT_CMD
 * unset -> claude default) and the codex bring-up (TM8_AGENT_CMD=codex) runs alike.
 */
import { bootstrap } from '@tm8/server-src-main';
import { loadConfig } from '@tm8/server-src-config';

test('boot tm8 server from source and hold it open', async () => {
  const config = loadConfig(process.env);
  const server = await bootstrap({ config });
  // eslint-disable-next-line no-console
  console.log(`[p1-boot] LISTENING ${server.url}`);
  // eslint-disable-next-line no-console
  console.log(`[p1-boot] PID ${String(process.pid)}`);
  // eslint-disable-next-line no-console
  console.log(`[p1-boot] DATABASE ${config.databaseUrl ?? '(none)'}`);
  await new Promise(() => {
    // Never resolves. The process stays up until externally killed (SIGTERM/SIGINT),
    // which is how run-server.sh's callers are expected to stop it.
  });
});
