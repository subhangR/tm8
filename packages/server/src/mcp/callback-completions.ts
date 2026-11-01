import { createHash } from 'node:crypto';
import type { McpCredentialView } from '@tm8/contract';
type Result = McpCredentialView & { returnTo?: string };
/** Share in-flight browser duplicates; completed OAuth states remain single-use. */
export class McpCallbackCompletions {
  private readonly pending = new Map<string, Promise<Result>>();
  complete(identityId: string, input: unknown, run: () => Promise<Result>): Promise<Result> {
    const key = createHash('sha256').update(identityId).update('\0').update(JSON.stringify(input)).digest('hex');
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 256) return run();
    const result = Promise.resolve().then(run);
    this.pending.set(key, result);
    const remove = () => { if (this.pending.get(key) === result) this.pending.delete(key); };
    void result.then(remove, remove);
    return result;
  }
}
