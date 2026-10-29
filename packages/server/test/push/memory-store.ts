/**
 * An in-memory PushStore with 393's settle semantics, for the dispatcher's
 * unit tests: a dead device is deleted only while it still holds the token
 * hash that was sent to, tickets are kept for the receipt pass, and a settled
 * row is settled once. The SQL itself is proven in push-dispatch.pg.test.ts.
 */
import type {
  ClaimedPush,
  PushClaimBatch,
  PushDevice,
  PushNotification,
  PushSettlement,
  PushStore,
  PushTicketRef,
} from '../../src/push/types.js';

export class MemoryPushStore implements PushStore {
  readonly queue: ClaimedPush[] = [];
  readonly notifications = new Map<string, PushNotification | null>();
  readonly settlements: Array<{ outboxId: string; settlement: PushSettlement }> = [];
  /** deviceId → the token hash the device row holds now. */
  readonly devices = new Map<string, string>();
  readonly tickets = new Map<string, PushTicketRef>();
  readonly deletedDevices: string[] = [];
  failNotificationRead = false;

  add(item: ClaimedPush, notification: PushNotification | null): void {
    this.queue.push(item);
    this.notifications.set(item.notificationId, notification);
    for (const device of item.devices) this.devices.set(device.deviceId, device.sealed.tokenHash);
  }

  /** The phone rotated its token (devices.update): the row now holds another hash. */
  rotate(device: PushDevice, newHash: string): void {
    this.devices.set(device.deviceId, newHash);
  }

  async claim(limit: number): Promise<PushClaimBatch> {
    const items = this.queue.splice(0, limit);
    return { items, enqueued: items.length, skippedRead: 0, skippedNoDevice: 0, expired: 0 };
  }

  async notification(item: ClaimedPush): Promise<PushNotification | null> {
    if (this.failNotificationRead) throw new Error('connection reset');
    return this.notifications.get(item.notificationId) ?? null;
  }

  private deleteDevice(deviceId: string, tokenHash: string): boolean {
    if (this.devices.get(deviceId) !== tokenHash) return false;
    this.devices.delete(deviceId);
    this.deletedDevices.push(deviceId);
    return true;
  }

  async settle(outboxId: string, settlement: PushSettlement): Promise<{ readonly devicesDeleted: number }> {
    if (this.settlements.some((s) => s.outboxId === outboxId && s.settlement.outcome !== 'retry')) {
      throw new Error(`row ${outboxId} settled twice`);
    }
    this.settlements.push({ outboxId, settlement });
    let devicesDeleted = 0;
    if (settlement.outcome === 'sent') {
      for (const dead of settlement.dead) if (this.deleteDevice(dead.deviceId, dead.tokenHash)) devicesDeleted += 1;
      for (const ticket of settlement.tickets) this.tickets.set(ticket.ticketId, ticket);
    }
    return { devicesDeleted };
  }

  async claimReceipts(limit: number): Promise<{ readonly ticketIds: readonly string[]; readonly expired: number }> {
    return { ticketIds: [...this.tickets.keys()].slice(0, limit), expired: 0 };
  }

  async settleReceipts(
    done: readonly string[],
    dead: readonly string[],
  ): Promise<{ readonly devicesDeleted: number; readonly forgotten: number }> {
    let devicesDeleted = 0;
    let forgotten = 0;
    for (const id of dead) {
      const ticket = this.tickets.get(id);
      if (ticket && this.deleteDevice(ticket.deviceId, ticket.tokenHash)) devicesDeleted += 1;
    }
    for (const id of [...done, ...dead]) if (this.tickets.delete(id)) forgotten += 1;
    return { devicesDeleted, forgotten };
  }

  settlementOf(outboxId: string): PushSettlement | undefined {
    return this.settlements.filter((s) => s.outboxId === outboxId).at(-1)?.settlement;
  }
}
