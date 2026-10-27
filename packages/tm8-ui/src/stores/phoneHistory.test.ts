import { beforeEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import type { NavView } from '../routes/types';
import {
  PHONE_STACK_CAP,
  backStepOf,
  destKeyOf,
  isDirectlyBelow,
  phoneHistory,
  recordInbound,
  recordPush,
  recordReplace,
  resetPhoneHistory,
  resetToChatFloor,
  saveTopPlace,
  topEntry,
} from './phoneHistory';

const ent = (id: string): NavView => ({ view: 'entity', entityId: id as EntityId, origin: { slug: 'tasks', mode: null } });
const list = (slug: string): NavView => ({ view: 'kind', slug, mode: null, q: null });
const dests = () => phoneHistory.getState().entries.map((e) => e.dest);
const step = () => backStepOf(phoneHistory.getState());

beforeEach(() => resetPhoneHistory());

describe('phoneHistory — the projection the phone ‹ reads (CONTRACT §5)', () => {
  it('keys a destination by what it shows, not by its query', () => {
    expect(destKeyOf(list('tasks'))).toBe(destKeyOf({ view: 'kind', slug: 'tasks', mode: 'board', q: { v: 1, sortBy: 'updated' } as never }));
    expect(destKeyOf(ent('A'))).toBe(destKeyOf({ view: 'entity', entityId: 'A' as EntityId, origin: null }));
  });

  it('a cold arrival has nothing below: ‹ is Up (ruling 4)', () => {
    recordInbound(ent('A'));
    expect(dests()).toEqual(['e:A']);
    expect(step()).toBe('up');
  });

  it('pushes stack, and Back (an inbound address equal to the entry below) pops with its place intact', () => {
    recordInbound(list('tasks'));
    saveTopPlace({ scrolls: [{ path: [0], top: 480 }], drafts: [] });
    recordPush(ent('A'));
    recordPush(ent('B'));
    expect(dests()).toEqual(['k:tasks', 'e:A', 'e:B']);
    expect(step()).toBe('back');
    recordInbound(ent('A'));
    recordInbound(list('tasks'));
    expect(dests()).toEqual(['k:tasks']);
    expect(phoneHistory.getState().lastOp).toBe('pop');
    expect(topEntry()?.place?.scrolls[0]?.top).toBe(480);
  });

  it('Forward re-finds the entry Back walked past, place and all', () => {
    recordInbound(list('tasks'));
    recordPush(ent('A'));
    saveTopPlace({ scrolls: [], drafts: [{ path: [1, 2], value: 'half a thought' }] });
    recordInbound(list('tasks'));
    recordInbound(ent('A'));
    expect(dests()).toEqual(['k:tasks', 'e:A']);
    expect(topEntry()?.place?.drafts[0]?.value).toBe('half a thought');
  });

  it('a link to a page deeper in the stack still pushes (ruling 6); only the entry directly below is Back', () => {
    recordInbound(ent('A'));
    recordPush(ent('B'));
    recordPush(ent('C'));
    expect(isDirectlyBelow(ent('B'))).toBe(true);
    expect(isDirectlyBelow(ent('A'))).toBe(false);
    recordPush(ent('A'));
    expect(dests()).toEqual(['e:A', 'e:B', 'e:C', 'e:A']);
  });

  it(`caps at ${PHONE_STACK_CAP} entries and drops the oldest (ruling 5)`, () => {
    recordInbound(list('tasks'));
    for (let i = 0; i < 20; i++) recordPush(ent(`E${i}`));
    expect(dests()).toHaveLength(PHONE_STACK_CAP);
    expect(dests()[0]).toBe('e:E8');
    expect(dests().at(-1)).toBe('e:E19');
  });

  it('a replace swaps the top without growing the stack, and is a new visit with no place', () => {
    recordInbound(ent('A'));
    saveTopPlace({ scrolls: [{ path: [], top: 10 }], drafts: [] });
    recordReplace(list('tasks'));
    expect(dests()).toEqual(['k:tasks']);
    expect(topEntry()?.place).toBeNull();
  });

  it('the drawer resets to [Chat, destination]: ‹ from the destination is "chat" (ruling 3)', () => {
    recordInbound(list('tasks'));
    recordPush(ent('A'));
    resetToChatFloor();
    recordPush(list('docs'));
    expect(dests()).toEqual(['k:docs']);
    expect(step()).toBe('chat');
    recordPush(ent('D'));
    expect(step()).toBe('back');
  });

  it('an address that is neither Back nor Forward starts over (a paste mid-session)', () => {
    recordInbound(list('tasks'));
    recordPush(ent('A'));
    recordInbound(ent('Z'));
    expect(dests()).toEqual(['e:Z']);
    expect(step()).toBe('up');
  });
});
