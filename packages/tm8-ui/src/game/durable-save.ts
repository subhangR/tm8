import { GameNavigationSaveSchema, type GameNavigationSave, type GameNavigationView } from '@tm8/contract';
import { mapKey, parseGameSave, readGameSave, writeGameSave, type GameSave } from './local-save';

export interface GamePersistencePort {
  load(spaceId: string, signal?: AbortSignal): Promise<GameNavigationView>;
  /** Open valid legacy identities before the first save; the server never mints maps during save. */
  prepareMigration?(spaceId: string, save: GameNavigationSave, signal?: AbortSignal): Promise<void>;
  save(spaceId: string, save: GameNavigationSave, expectedRevision: number, options?: { keepalive?: boolean; signal?: AbortSignal }): Promise<GameNavigationView>;
}
export type GameSaveStatus = 'loading' | 'saving' | 'saved' | 'local' | 'conflict';

/** One member/space visit. Reads finish before writes; only one CAS is in flight. */
export class DurableGameSave {
  private revision: number | null = null;
  private pending: { save: GameNavigationSave; keepalive: boolean } | null = null;
  private running: Promise<void> | null = null;
  private halted = false;
  private latest: GameSave;
  private retrying: Promise<void> | null = null;
  private readonly lifetime = new AbortController();

  constructor(private readonly spaceId: string, private readonly memberId: string,
    private readonly port: GamePersistencePort, private readonly report: (status: GameSaveStatus) => void, identitySignal?: AbortSignal,
    private readonly repaired?: (save: GameSave) => void) {
    this.latest = readGameSave(spaceId, memberId);
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
    const timer = setTimeout(cancel, 30_000);
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('Game hydration cancelled', 'AbortError')), { once: true });
      if (controller.signal.aborted) reject(new DOMException('Game hydration cancelled', 'AbortError'));
    });
    try {
      const view = await Promise.race([this.port.load(this.spaceId, controller.signal), expired]);
      if (signal.aborted || this.lifetime.signal.aborted) return this.latest;
      const restored = this.accept(view);
      if (restored === null && this.port.prepareMigration) {
        await Promise.race([this.port.prepareMigration(this.spaceId, this.latest, controller.signal), expired]);
      }
      this.latest = restored ?? this.latest;
      writeGameSave(this.latest);
      this.report(view.save ? 'saved' : 'local');
    } catch {
      if (!signal.aborted && !this.lifetime.signal.aborted) { this.halted = true; this.report('local'); }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      this.lifetime.signal.removeEventListener('abort', cancel);
    }
    return this.latest;
  }

  enqueue(save: GameSave, keepalive = false): Promise<void> {
    // Decode also strips display titles and snapshots before they leave the browser.
    const canonical = parseGameSave(save, this.spaceId, this.memberId);
    if (!canonical || this.lifetime.signal.aborted) return Promise.resolve();
    this.latest = canonical;
    writeGameSave(canonical);
    this.pending = { save: canonical, keepalive };
    return this.drain();
  }

  private drain(): Promise<void> {
    if (this.running) return this.running;
    if (this.halted || this.lifetime.signal.aborted || this.revision === null || !this.pending) return Promise.resolve();
    this.running = (async () => {
      while (this.pending && !this.halted && !this.lifetime.signal.aborted && this.revision !== null) {
        const next = this.pending;
        this.pending = null;
        this.report('saving');
        try {
          const acknowledged = await this.port.save(this.spaceId, next.save, this.revision, { keepalive: next.keepalive, signal: this.lifetime.signal });
          const normalized = this.accept(acknowledged);
          if (!normalized) throw new Error('Game save was not acknowledged');
          this.applyRepairs(next.save, normalized);
          if (!this.pending) this.report('saved');
        } catch (error) {
          // Preserve the newest local snapshot. A CAS conflict never silently overwrites a second device.
          this.pending ??= next;
          this.halted = true;
          this.report(error && typeof error === 'object' && 'code' in error && error.code === 'version_conflict' ? 'conflict' : 'local');
        }
      }
    })().finally(() => { this.running = null; if (this.pending && !this.halted && !this.lifetime.signal.aborted) void this.drain(); });
    return this.running;
  }

  private applyRepairs(sent: GameSave, normalized: GameSave): void {
    const route = (save: GameSave) => JSON.stringify([...save.stack, save.current].map(mapKey));
    const removed = Object.keys(sent.maps).filter(key => !Object.prototype.hasOwnProperty.call(normalized.maps, key));
    if (route(sent) === route(normalized) && !removed.length) return;
    const merge = (latest: GameSave): GameSave => {
      const maps = { ...latest.maps };
      for (const key of removed) {
        // A newly visited pose reported after this write began remains newer intent.
        if (JSON.stringify(maps[key]) === JSON.stringify(sent.maps[key])) delete maps[key];
      }
      return { ...latest, maps, ...(route(latest) === route(sent) ? { current: normalized.current, stack: normalized.stack } : {}) };
    };
    this.latest = merge(this.latest);
    if (this.pending) this.pending.save = merge(this.pending.save);
    writeGameSave(this.latest);
    if (!this.lifetime.signal.aborted) this.repaired?.(this.latest);
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
        if (view.save === null && this.port.prepareMigration) await this.port.prepareMigration(this.spaceId, this.latest, this.lifetime.signal);
        if (this.lifetime.signal.aborted) return;
        this.halted = false;
        await this.enqueue(this.latest);
      } catch { this.halted = true; this.report('local'); }
    })().finally(() => { this.retrying = null; });
    return this.retrying;
  }
}
