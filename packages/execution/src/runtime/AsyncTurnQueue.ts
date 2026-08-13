import type { TurnItem } from './types.js';

interface PendingRead {
  resolve(result: IteratorResult<TurnItem>): void;
}

/** Minimal one-producer/one-consumer async queue for a single model turn. */
export class AsyncTurnQueue implements AsyncIterable<TurnItem> {
  private readonly buffered: TurnItem[] = [];
  private readonly readers: PendingRead[] = [];
  private ended = false;
  private iteratorClaimed = false;

  push(item: TurnItem): void {
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ value: item, done: false });
      return;
    }
    this.buffered.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers.splice(0)) {
      reader.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TurnItem> {
    if (this.iteratorClaimed) {
      throw new Error('a turn stream can only be consumed once');
    }
    this.iteratorClaimed = true;
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<TurnItem>> {
    const item = this.buffered.shift();
    if (item) return Promise.resolve({ value: item, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.readers.push({ resolve }));
  }
}
