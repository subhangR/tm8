/**
 * The bridges watchdog (BRIDGE-ENTITY-DESIGN D19, §6, §7.3 item 6): a server
 * scheduler job over connections, `message_origins` and turns, never in the
 * runtime (the server owns derived truth, T-L12).
 *
 * Each tick runs `internal.bridge_watchdog_tick()` (migration 398): a runtime
 * silent for three heartbeats marks its connections offline, so every bridge
 * on them derives `degraded`, and raises ONE `fyi` attention per connection to
 * its owner, cleared when heartbeats return; a routed message whose turn
 * failed or stalled gets ⚠️ on the provider through the outbox and one `fyi`
 * on its bridge; dispatches a dead socket swallowed return to retry. Then it
 * calls the command executor's `sweep()` (B1b-4), which re-runs commands left
 * unsettled.
 */
import type { Db } from '../../db/types.js';
import { bridgesWorkerClaims } from '../../bridges/outbox.js';
import type { BridgeCommandHook } from '../../bridges/runtime/command-hook.js';
import type { ScheduledJob } from '../types.js';

export const BRIDGE_WATCHDOG_INTERVAL_MS = 30_000;

interface TickResult { runtimeDown: number; runtimeBack: number; warned: number; requeued: number }

export function bridgeWatchdogJob(deps: {
  db: Db;
  commands?: () => BridgeCommandHook | undefined;
  /** 402 §4: media fetches a restart interrupted, or that wait for a retry. */
  media?: { kick(): Promise<number> };
  /** After a tick that changed something, the hub pushes and dispatches at once. */
  onChanged?: () => void;
}): ScheduledJob {
  return {
    name: 'bridges.watchdog',
    intervalMs: BRIDGE_WATCHDOG_INTERVAL_MS,
    jitterRatio: 0.1,
    runOnStart: true,
    quietSkips: true,
    timeoutMs: 60_000,
    async run() {
      const tick = await deps.db.rpc<TickResult>(bridgesWorkerClaims('bridges.watchdog'), 'internal.bridge_watchdog_tick', []);
      const swept = (await deps.commands?.()?.sweep()) ?? 0;
      const media = (await deps.media?.kick()) ?? 0;
      const affected = tick.runtimeDown + tick.runtimeBack + tick.warned + tick.requeued + swept + media;
      if (affected === 0) return { skipped: true, reason: 'nothing to watch' };
      deps.onChanged?.();
      return { affected, detail: { ...tick, commandsSwept: swept, mediaAttached: media } };
    },
  };
}
