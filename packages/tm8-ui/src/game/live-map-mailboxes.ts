import type { MapInput } from '../story/game/map-model';
import { applyGameMailboxCounts, type GameMailboxReader } from '../data/game-mailboxes';
import type { GameMapEvents } from './types';

interface Options {
  spaceId: string; reader: GameMailboxReader; events?: GameMapEvents;
  current(): MapInput | null; update(input: MapInput): void;
}
const mailboxKinds = new Set(['task', 'work_session', 'story']);
/** Count-only refresh belongs to the current map visit, never to a captured input. */
export function createLiveMailboxController(options: Options) {
  let closed = false, epoch = 0, lastSeq = -1, anchorKey = '';
  let queued: ReturnType<typeof setTimeout> | undefined;
  let cadence: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | null = null;
  const subscriptions: (() => void)[] = [];
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const anchors = () => (options.current()?.entities ?? []).filter(row => mailboxKinds.has(row.kind) && (!row.spaceId || row.spaceId === options.spaceId));
  const admitted = (id: string) => anchors().some(row => row.id === id);
  const suspend = () => {
    clearTimeout(queued); queued = undefined; clearTimeout(cadence); cadence = undefined;
    epoch++; abort?.abort(); abort = null;
  };
  const read = async () => {
    queued = undefined;
    if (closed || !visible() || !anchors().length) return;
    const controller = new AbortController(), request = ++epoch;
    abort = controller;
    try {
      const counts = await options.reader(controller.signal);
      if (closed || controller.signal.aborted || request !== epoch) return;
      const current = options.current();
      if (current) options.update(applyGameMailboxCounts(current, counts, options.spaceId));
    } catch (error) {
      if (!closed && !controller.signal.aborted && request === epoch) {
        const current = options.current();
        if (current) options.update(applyGameMailboxCounts(current, null, options.spaceId));
      }
    } finally { if (abort === controller) abort = null; }
  };
  const refresh = (immediate = false) => {
    if (closed || !visible() || !anchors().length || queued !== undefined) return;
    epoch++; abort?.abort(); abort = null;
    if (immediate) void read();
    else queued = setTimeout(() => { void read(); }, 0);
  };
  const startCadence = () => {
    if (closed || !visible() || !anchors().length || cadence !== undefined) return;
    cadence = setTimeout(() => { cadence = undefined; refresh(true); startCadence(); }, 15_000);
  };
  const sync = () => {
    if (closed) return;
    const rows = anchors();
    if (!visible() || !rows.length) { suspend(); anchorKey = ''; return; }
    const key = rows.map(row => row.id).sort().join('\0');
    if (key !== anchorKey) {
      anchorKey = key;
      // The production loader already performs the initial authorized count read.
      if (rows.some(row => row.mailbox?.basis !== 'unread')) refresh();
    }
    startCadence();
  };
  const resume = () => { if (visible()) { sync(); refresh(); } else suspend(); };
  const attach = () => {
    if (options.reader.onInvalidated) subscriptions.push(options.reader.onInvalidated(id => { if (admitted(id)) refresh(); }));
    if (options.events) subscriptions.push(options.events.onEvent(event => {
      if (closed || event.spaceId !== options.spaceId || event.seq <= lastSeq) return;
      lastSeq = event.seq;
      if ((event.type === 'message.created' || event.type === 'message.updated' || event.type === 'message.deleted') && admitted(event.anchorId)) refresh();
      else if (event.type === 'counter.changed' && admitted(event.entityId)) refresh();
      else if (event.type === 'notification.read') refresh();
    }));
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', resume);
      subscriptions.push(() => document.removeEventListener('visibilitychange', resume));
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', resume);
      subscriptions.push(() => window.removeEventListener('focus', resume));
    }
    sync();
  };
  const dispose = () => { if (closed) return; closed = true; suspend(); subscriptions.splice(0).forEach(remove => remove()); };
  return { attach, sync, refresh, dispose };
}
