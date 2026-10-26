/**
 * Which GitHub client polls which space, and which provider budgets are spent.
 *
 * 306 (P0e) made the tracking jobs span every space, which turned two
 * node-wide assumptions into bugs:
 *
 *   * ONE CREDENTIAL FOR EVERYTHING. Owner ruling, 6 Oct: no node-wide token
 *     on prod. A space that holds a GitHub token credential (its DEFAULT,
 *     active, token-shaped row) has its OWN pull requests read with it, and
 *     nothing else's. A space without one is read with the node's env token if
 *     an operator set one, otherwise unauthenticated.
 *   * ONE RATE LIMIT FOR EVERYTHING. A space's token has its own budget; the
 *     env token and the anonymous budget are each shared by every space that
 *     falls back to them. So a rate limit stops only the targets that spend
 *     THAT budget, and it is remembered across ticks until the provider's
 *     reset — rather than the next tick spending a request to be told again.
 *
 * One instance lives for the life of the job, so the backoff survives between
 * ticks; tokens are resolved again every tick (`beginTick`), so a revoked or
 * rotated credential takes effect within one interval.
 */

import { GithubClient, resolveGithubToken } from './github.js';

/** Resolves a space's tracking token, or undefined when it has none. */
export type TrackingTokenResolver = (spaceId: string) => Promise<string | undefined>;

export interface SpaceClient {
  client: GithubClient;
  /** The provider budget this client spends: `space:<id>`, `env` or `anonymous`. */
  budget: string;
}

export interface TrackingClientsOptions {
  /** Tests: one client for every space, under one budget. */
  client?: GithubClient;
  resolveToken?: TrackingTokenResolver;
  /** The node fallback. Defaults to the environment (`resolveGithubToken`). */
  fallbackToken?: string | undefined;
  fetchImpl?: typeof fetch;
  /** When no retry time came with a rate limit. */
  defaultBackoffMs?: number;
  now?: () => number;
  /** A resolver failure is reported, not thrown: one space must not stop the tick. */
  onResolveError?: (spaceId: string, error: unknown) => void;
}

export class TrackingClients {
  private readonly options: TrackingClientsOptions;
  private readonly fallback: SpaceClient;
  private readonly limitedUntil = new Map<string, number>();
  private perTick = new Map<string, Promise<SpaceClient>>();

  constructor(options: TrackingClientsOptions = {}) {
    this.options = options;
    if (options.client) {
      this.fallback = { client: options.client, budget: options.client.authenticated ? 'env' : 'anonymous' };
    } else {
      const token = 'fallbackToken' in options ? options.fallbackToken : resolveGithubToken();
      this.fallback = {
        client: new GithubClient({ token, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
        budget: token ? 'env' : 'anonymous',
      };
    }
  }

  /** Forget last tick's token resolutions. Backoff state is kept. */
  beginTick(): void {
    this.perTick = new Map();
  }

  forSpace(spaceId: string): Promise<SpaceClient> {
    if (this.options.client || !this.options.resolveToken) return Promise.resolve(this.fallback);
    let pending = this.perTick.get(spaceId);
    if (!pending) {
      pending = this.resolve(spaceId);
      this.perTick.set(spaceId, pending);
    }
    return pending;
  }

  private async resolve(spaceId: string): Promise<SpaceClient> {
    let token: string | undefined;
    try {
      token = (await this.options.resolveToken?.(spaceId))?.trim() || undefined;
    } catch (error) {
      this.options.onResolveError?.(spaceId, error);
      token = undefined;
    }
    if (!token) return this.fallback;
    return {
      client: new GithubClient({ token, ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}) }),
      budget: `space:${spaceId}`,
    };
  }

  isLimited(budget: string): boolean {
    const until = this.limitedUntil.get(budget);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.limitedUntil.delete(budget);
      return false;
    }
    return true;
  }

  markLimited(budget: string, retryAtMs?: number): void {
    const floor = this.now() + (this.options.defaultBackoffMs ?? 5 * 60_000);
    this.limitedUntil.set(budget, retryAtMs !== undefined && retryAtMs > this.now() ? retryAtMs : floor);
  }

  /** Budgets currently backed off, for a tick's detail. */
  limitedBudgets(): string[] {
    return [...this.limitedUntil.keys()].filter((b) => this.isLimited(b));
  }

  /** True when the node fallback (used by every space without a credential) has a token. */
  get fallbackAuthenticated(): boolean {
    return this.fallback.client.authenticated;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
