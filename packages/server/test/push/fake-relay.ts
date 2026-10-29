/**
 * The relay every push test uses (ac4: no lane and no test sends a real push).
 *
 * It records each `send` and `receipts` call and answers from a script: by
 * default every message is accepted with a fresh ticket id, a token listed in
 * `dead` answers DeviceNotRegistered, and `failNext` makes the next send throw.
 */
import {
  RelayRejectedError,
  RelayUnavailableError,
  type PushRelay,
  type RelayErrorCode,
  type RelayMessage,
  type RelayReceipt,
  type RelayTicket,
} from '../../src/push/types.js';

export class FakePushRelay implements PushRelay {
  readonly name = 'fake';
  readonly sends: RelayMessage[][] = [];
  readonly receiptCalls: string[][] = [];
  /** Tokens whose next send answers this error code. */
  readonly ticketErrors = new Map<string, RelayErrorCode>();
  /** Tokens the relay knows to be dead: DeviceNotRegistered in tickets. */
  readonly dead = new Set<string>();
  /** Receipts by ticket id; a ticket with none is still pending. */
  readonly receiptAnswers = new Map<string, RelayReceipt>();
  /** Ticket id → the token it was issued for. */
  readonly ticketTokens = new Map<string, string>();
  private failure: Error | null = null;
  private failReceipts: Error | null = null;
  private next = 0;

  constructor(readonly maxBatch = 100) {}

  failNext(kind: 'unavailable' | 'rejected', retryAfterMs?: number): void {
    this.failure = kind === 'unavailable'
      ? new RelayUnavailableError('fake relay unavailable', retryAfterMs)
      : new RelayRejectedError('fake relay refused the request: 400 (VALIDATION_ERROR)');
  }

  failNextReceipts(): void {
    this.failReceipts = new RelayUnavailableError('fake relay unavailable');
  }

  get messages(): RelayMessage[] {
    return this.sends.flat();
  }

  async send(messages: readonly RelayMessage[]): Promise<RelayTicket[]> {
    if (messages.length > this.maxBatch) throw new RangeError('over the fake relay batch');
    this.sends.push([...messages]);
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
    return messages.map((message) => {
      if (this.dead.has(message.to)) return { status: 'error', error: 'DeviceNotRegistered' } as const;
      const scripted = this.ticketErrors.get(message.to);
      if (scripted) return { status: 'error', error: scripted } as const;
      this.next += 1;
      const id = `fake-ticket-${this.next}`;
      this.ticketTokens.set(id, message.to);
      return { status: 'ok', id } as const;
    });
  }

  async receipts(ticketIds: readonly string[]): Promise<ReadonlyMap<string, RelayReceipt>> {
    this.receiptCalls.push([...ticketIds]);
    if (this.failReceipts) {
      const failure = this.failReceipts;
      this.failReceipts = null;
      throw failure;
    }
    const out = new Map<string, RelayReceipt>();
    for (const id of ticketIds) {
      const answer = this.receiptAnswers.get(id);
      if (answer) out.set(id, answer);
    }
    return out;
  }
}
