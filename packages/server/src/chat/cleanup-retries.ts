/** Retries private, owner-fenced cleanup closures for this server's lifetime. */
export class ChatCleanupRetryQueue {
  private readonly pending = new Map<() => Promise<void>, { delay: number; timer?: ReturnType<typeof setTimeout> }>();
  private stopped = false;

  schedule = (retry: () => Promise<void>): void => {
    if (this.stopped || this.pending.has(retry)) return;
    const entry = { delay: 500 };
    this.pending.set(retry, entry);
    this.arm(retry, entry);
  };

  stop(): void {
    this.stopped = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private arm(retry: () => Promise<void>, entry: { delay: number; timer?: ReturnType<typeof setTimeout> }): void {
    entry.timer = setTimeout(async () => {
      try {
        await retry();
        this.pending.delete(retry);
      } catch {
        // The closure retains its original grant and owner; errors stay private.
        if (!this.stopped) {
          entry.delay = Math.min(entry.delay * 2, 30_000);
          this.arm(retry, entry);
        }
      }
    }, entry.delay);
    entry.timer.unref();
  }
}
