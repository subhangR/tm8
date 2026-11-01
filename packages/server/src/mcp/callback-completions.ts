import { createHash } from 'node:crypto';
import type { McpCredentialView } from '@tm8/contract';
type Result = McpCredentialView & { returnTo?: string };
/** Coalesce duplicate browser deliveries; exchange stays single-use and only public account metadata is cached. */
export class McpCallbackCompletions {
  private readonly pending = new Map<string, { result: Promise<Result>; expiresAt: number }>();
  constructor(private readonly now = Date.now) {}
  complete(identityId: string, input: unknown, run: () => Promise<Result>): Promise<Result> {
    for (const [key, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(key);
    const key = createHash('sha256').update(identityId).update('\0').update(JSON.stringify(input)).digest('hex');
    const existing = this.pending.get(key);
    if (existing) return existing.result;
    if (this.pending.size >= 256) return run();
    const entry = { result: Promise.resolve().then(run), expiresAt: Infinity };
    this.pending.set(key, entry);
    void entry.result.then(() => { entry.expiresAt = this.now() + 5000; }, () => { this.pending.delete(key); });
    return entry.result;
  }
}
