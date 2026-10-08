import { GameMapMemorySchema, GameMapSelectionSchema, GameNavigationSaveSchema, type GameNavigationSave, type GameNavigationView } from '@tm8/contract';
import { freshGameSave, mapKey, parseGameSave, readGameSave, writeGameSave, type GameSave } from './local-save';

export interface GamePersistencePort {
  load(spaceId: string, signal?: AbortSignal): Promise<GameNavigationView>;
  /** Open valid legacy identities before the first save; the server never mints maps during save. */
  prepareMigration?(spaceId: string, save: GameNavigationSave, signal?: AbortSignal): Promise<void>;
  save(spaceId: string, save: GameNavigationSave, expectedRevision: number, options?: { keepalive?: boolean; signal?: AbortSignal }): Promise<GameNavigationView>;
}
export type GameSaveStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'local' | 'conflict';
const REMOTE_SAVE_INTERVAL_MS = 3_000;
const routeKey = (save: GameSave) => JSON.stringify([...save.stack, save.current].map(mapKey));

function rateLimitDelay(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const failure = error as { code?: unknown; status?: unknown; details?: Record<string, unknown> };
  if (failure.code !== 'rate_limited' && failure.code !== 'TM429' && failure.status !== 429 && failure.details?.httpStatus !== 429) return null;
  const retryAfter = failure.details?.retryAfterMs;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.max(REMOTE_SAVE_INTERVAL_MS, Math.min(retryAfter, 2_147_483_647)) : REMOTE_SAVE_INTERVAL_MS;
}

/** Applies server removals only to the snapshot they acknowledge, retaining newer unsent intent too. */
export function mergeGameSaveRepairs(latest: GameSave, sent: GameSave, normalized: GameSave): GameSave {
  const maps = { ...latest.maps };
  for (const key of Object.keys(sent.maps)) {
    if (!Object.prototype.hasOwnProperty.call(normalized.maps, key) && JSON.stringify(maps[key]) === JSON.stringify(sent.maps[key])) delete maps[key];
  }
  const routeChanged = routeKey(latest) === routeKey(sent) && routeKey(sent) !== routeKey(normalized);
  return { ...latest, maps, ...(routeChanged ? { current: normalized.current, stack: normalized.stack } : {}) };
}

function repairLegacySave(save: GameSave): GameNavigationSave {
  const selection = (value: unknown) => {
    const parsed = GameMapSelectionSchema.safeParse(value);
    return parsed.success ? { ...parsed.data, scope: { ...parsed.data.scope, id: parsed.data.scope.id.toLowerCase() } } : null;
  };
  const route: GameNavigationSave['stack'] = [];
  for (const entry of [...save.stack, save.current]) {
    const valid = selection({ type: entry.type, scope: entry.scope });
    if (!valid) break;
    route.push(valid);
  }
  const maps: GameNavigationSave['maps'] = Object.create(null);
  for (const [key, memory] of Object.entries(save.maps)) {
    let parts: unknown;
    try { parts = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parts) || parts.length !== 3) continue;
    const map = selection({ scope: { kind: parts[0], id: parts[1] }, type: parts[2] });
    const parsed = GameMapMemorySchema.safeParse(memory);
    if (map && parsed.success) maps[mapKey(map)] = parsed.data;
  }
  const current = route.pop() ?? freshGameSave(save.spaceId, save.memberId).current;
  return GameNavigationSaveSchema.parse({ ...save, current, stack: route, maps });
}

/** One member/space visit. Reads finish before writes; only one CAS is in flight. */
export class DurableGameSave {
  private revision: number | null = null;
  private pending: { save: GameNavigationSave; keepalive: boolean; immediate: boolean } | null = null;
  private running: Promise<void> | null = null;
  private halted = false;
  private latest: GameSave;
  private retrying: Promise<void> | null = null;
  private readonly lifetime = new AbortController();
  private throttle: ReturnType<typeof setTimeout> | undefined;
  private lastStarted = -Infinity;
  private rateRetryUsed = false;
  private rateRetryUntil = 0;

  constructor(private readonly spaceId: string, private readonly memberId: string,
    private readonly port: GamePersistencePort, private readonly report: (status: GameSaveStatus) => void, identitySignal?: AbortSignal,
    private readonly repaired?: (save: GameSave, sent: GameSave) => void) {
    this.latest = readGameSave(spaceId, memberId);
    this.lifetime.signal.addEventListener('abort', () => clearTimeout(this.throttle), { once: true });
    if (identitySignal?.aborted) this.lifetime.abort();
    else identitySignal?.addEventListener('abort', () => this.lifetime.abort(), { once: true, signal: this.lifetime.signal });
  }

  private accept(view: GameNavigationView): GameSave | null {
    if (view.spaceId !== this.spaceId || view.memberId !== this.memberId) throw new Error('Game identity changed');
    if (!Number.isSafeInteger(view.revision) || view.revision < 0) throw new Error('Invalid Game revision');
    const checked = view.save === null ? null : GameNavigationSaveSchema.parse(view.save);
    const decoded = checked === null ? null : parseGameSave(checked, this.spaceId, this.memberId);
    if (view.save !== null && !decoded) throw new Error('Invalid Game save');
    this.revision = view.revision;
    return decoded;
  }

  async hydrate(signal: AbortSignal): Promise<GameSave> {
    this.report('loading');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    this.lifetime.signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted || this.lifetime.signal.aborted) cancel();
    let timer = setTimeout(cancel, 8_000);
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('Game hydration cancelled', 'AbortError')), { once: true });
      if (controller.signal.aborted) reject(new DOMException('Game hydration cancelled', 'AbortError'));
    });
    try {
      const view = await Promise.race([this.port.load(this.spaceId, controller.signal), expired]);
      if (signal.aborted || this.lifetime.signal.aborted) return this.latest;
      const restored = this.accept(view);
      if (restored === null) {
        this.latest = repairLegacySave(this.latest);
        clearTimeout(timer);
        timer = setTimeout(cancel, 30_000);
        if (this.port.prepareMigration) await Promise.race([this.port.prepareMigration(this.spaceId, this.latest, controller.signal), expired]);
      }
      if (signal.aborted || this.lifetime.signal.aborted) return this.latest;
      this.latest = restored ?? this.latest;
      writeGameSave(this.latest);
      this.report(view.save ? 'saved' : 'ready');
    } catch {
      if (!signal.aborted && !this.lifetime.signal.aborted) { this.halted = true; this.report('local'); }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      this.lifetime.signal.removeEventListener('abort', cancel);
    }
    return this.latest;
  }

  enqueue(save: GameSave, keepalive = false, immediate = true): Promise<void> {
    // Decode also strips display titles and snapshots before they leave the browser.
    const canonical = parseGameSave(save, this.spaceId, this.memberId);
    if (!canonical || this.lifetime.signal.aborted) return Promise.resolve();
    this.latest = canonical;
    writeGameSave(canonical);
    this.pending = { save: canonical, keepalive, immediate: immediate || keepalive };
    if (this.pending.immediate) { clearTimeout(this.throttle); this.throttle = undefined; }
    return this.drain();
  }

  private drain(): Promise<void> {
    if (this.running) return this.running;
    if (this.halted || this.lifetime.signal.aborted || this.revision === null || !this.pending) return Promise.resolve();
    clearTimeout(this.throttle);
    this.throttle = undefined;
    this.running = (async () => {
      while (this.pending && !this.halted && !this.lifetime.signal.aborted && this.revision !== null) {
        const remaining = Math.max(this.rateRetryUntil - Date.now(), this.pending.immediate ? 0 : this.lastStarted + REMOTE_SAVE_INTERVAL_MS - Date.now());
        if (remaining > 0) {
          this.throttle = setTimeout(() => { this.throttle = undefined; void this.drain(); }, remaining);
          break;
        }
        const next = this.pending;
        this.pending = null;
        this.lastStarted = Date.now();
        this.report('saving');
        try {
          const acknowledged = await this.port.save(this.spaceId, next.save, this.revision, { keepalive: next.keepalive, signal: this.lifetime.signal });
          if (this.lifetime.signal.aborted) return;
          const normalized = this.accept(acknowledged);
          if (!normalized) throw new Error('Game save was not acknowledged');
          this.rateRetryUsed = false;
          this.rateRetryUntil = 0;
          this.applyRepairs(next.save, normalized);
          if (!this.pending) this.report('saved');
        } catch (error) {
          if (this.lifetime.signal.aborted) return;
          // Preserve the newest local snapshot. A CAS conflict never silently overwrites a second device.
          this.pending ??= next;
          const delay = rateLimitDelay(error);
          if (delay !== null && !this.rateRetryUsed) {
            this.rateRetryUsed = true;
            this.rateRetryUntil = Date.now() + delay;
            continue;
          }
          this.halted = true;
          this.report(error && typeof error === 'object' && 'code' in error && error.code === 'version_conflict' ? 'conflict' : 'local');
        }
      }
    })().finally(() => {
      this.running = null;
      if (this.pending && this.throttle === undefined && !this.halted && !this.lifetime.signal.aborted) void this.drain();
    });
    return this.running;
  }

  private applyRepairs(sent: GameSave, normalized: GameSave): void {
    const removed = Object.keys(sent.maps).filter(key => !Object.prototype.hasOwnProperty.call(normalized.maps, key));
    if (routeKey(sent) === routeKey(normalized) && !removed.length) return;
    this.latest = mergeGameSaveRepairs(this.latest, sent, normalized);
    if (this.pending) this.pending.save = mergeGameSaveRepairs(this.pending.save, sent, normalized);
    writeGameSave(this.latest);
    if (!this.lifetime.signal.aborted) this.repaired?.(this.latest, sent);
  }

  /** Explicit user choice to save this visit after offline failure or a second-device conflict. */
  retry(): Promise<void> {
    if (this.retrying) return this.retrying;
    if (this.lifetime.signal.aborted) return Promise.resolve();
    this.retrying = (async () => {
      try {
        if (this.running) await this.running;
        const view = await this.port.load(this.spaceId, this.lifetime.signal);
        this.accept(view);
        // An explicit replacement can carry a browser-only legacy visit even when another device has a server save.
        this.latest = repairLegacySave(this.latest);
        if (this.port.prepareMigration) await this.port.prepareMigration(this.spaceId, this.latest, this.lifetime.signal);
        if (this.lifetime.signal.aborted) return;
        this.halted = false;
        this.rateRetryUsed = false;
        this.rateRetryUntil = 0;
        await this.enqueue(this.latest);
      } catch { this.halted = true; this.report('local'); }
    })().finally(() => { this.retrying = null; });
    return this.retrying;
  }
}
