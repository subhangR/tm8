/**
 * THE CHAT SLOT in the route (entity chat design 01a0da4e §3.1): `ca`/`ct` on
 * the wire, `PanelState.chat` in the codec, `openChat`/`setChatThread`/
 * `closeChat` in the store — and the history rule that is the point of it:
 * opening PUSHES, switching and `new`→created REPLACE, so one Back always
 * returns to the entity.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { build, normalize, parse, createMemoryTarget, defaultRoute } from './index';
import { attachRouter, navStore, resetNav, routeOf, selectChatSlot } from '../stores/navStore';

const SPACE = 'sp-1';
const TASK = '01a0aaaa-0000-7000-8000-000000000001';
const CHAT1 = '01a0aaaa-0000-7000-8000-000000000011';
const CHAT2 = '01a0aaaa-0000-7000-8000-000000000012';
const OTHER = '01a0aaaa-0000-7000-8000-000000000002';

describe('the chat slot on the wire', () => {
  it('round-trips an existing chat as ca + ct', () => {
    const route = { ...defaultRoute(SPACE), panels: { ...defaultRoute(SPACE).panels, chat: { about: TASK, thread: CHAT1 } } };
    const { hash, dropped } = build(route);
    expect(dropped).toEqual([]);
    expect(hash).toContain(`ca=${TASK}`);
    expect(hash).toContain(`ct=${CHAT1}`);
    const parsed = parse(hash);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.route?.panels.chat).toEqual({ about: TASK, thread: CHAT1 });
  });

  it('writes `new` by OMITTING ct, and reads an omitted ct back as `new`', () => {
    const route = { ...defaultRoute(SPACE), panels: { ...defaultRoute(SPACE).panels, chat: { about: TASK, thread: 'new' as const } } };
    const { hash } = build(route);
    expect(hash).toContain(`ca=${TASK}`);
    expect(hash).not.toContain('ct=');
    expect(parse(hash).route?.panels.chat).toEqual({ about: TASK, thread: 'new' });
  });

  it('a link with no slot parses to `chat: null` and builds no ca/ct', () => {
    const parsed = parse(`#/s/${SPACE}/home?p=${TASK}`);
    expect(parsed.route?.panels.chat).toBeNull();
    const { hash } = build(parsed.route!);
    expect(hash).not.toMatch(/[?&]c[at]=/);
  });

  it('a ct with no subject is not a slot — it drops under its own class', () => {
    const parsed = parse(`#/s/${SPACE}/home?ct=${CHAT1}`);
    expect(parsed.route?.panels.chat).toBeNull();
    expect(parsed.dropped).toEqual(['chat']);
  });

  it('survives normalize untouched, independent of the stack (pinned to its subject)', () => {
    const parsed = parse(`#/s/${SPACE}/workspace?p=${OTHER}&ca=${TASK}&ct=${CHAT1}`)!.route!;
    const once = normalize(parsed);
    expect(once.panels.chat).toEqual({ about: TASK, thread: CHAT1 });
    expect(normalize(once)).toEqual(once);
  });
});

describe('the chat slot in the store', () => {
  beforeEach(() => resetNav(SPACE));

  it('opens, moves within, and closes — and every Trail verb leaves it alone', () => {
    const s = navStore.getState();
    s.openCenter(OTHER);
    s.openChat({ about: TASK, thread: CHAT1 });
    expect(selectChatSlot(navStore.getState())).toEqual({ about: TASK, thread: CHAT1 });
    navStore.getState().trailPush(TASK);
    navStore.getState().openCenter(OTHER);
    navStore.getState().clearStack();
    expect(navStore.getState().chat).toEqual({ about: TASK, thread: CHAT1 });
    navStore.getState().setChatThread('new');
    expect(navStore.getState().chat).toEqual({ about: TASK, thread: 'new' });
    expect(routeOf(navStore.getState()).panels.chat).toEqual({ about: TASK, thread: 'new' });
    navStore.getState().closeChat();
    expect(navStore.getState().chat).toBeNull();
  });

  it('setChatThread is a no-op with no slot open', () => {
    const before = navStore.getState().revision;
    navStore.getState().setChatThread(CHAT1);
    expect(navStore.getState().chat).toBeNull();
    expect(navStore.getState().revision).toBe(before);
  });

  it('can land on another view in the SAME transition', () => {
    navStore.getState().openChat({ about: TASK, thread: 'new' }, { view: 'workspace' });
    expect(navStore.getState().view).toEqual({ view: 'workspace' });
    expect(navStore.getState().history).toBe('push');
  });
});

describe('the chat slot in history (§3.1)', () => {
  beforeEach(() => resetNav(''));
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('open PUSHES; switching and new→created REPLACE; one Back returns to the entity', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/home?p=${TASK}`);
    const detach = attachRouter(target, { replaceDebounceMs: 0 });
    expect(target.entries).toHaveLength(1);

    navStore.getState().openChat({ about: TASK, thread: 'new' });
    await flush();
    expect(target.entries).toHaveLength(2);
    expect(target.getHash()).toContain(`ca=${TASK}`);

    // The composer's first send created the chat: REPLACE.
    navStore.getState().setChatThread(CHAT1);
    await flush();
    // The switcher: REPLACE again.
    navStore.getState().setChatThread(CHAT2);
    await flush();
    expect(target.entries).toHaveLength(2);
    expect(target.getHash()).toContain(`ct=${CHAT2}`);

    // Re-opening the same slot writes no second entry.
    navStore.getState().openChat({ about: TASK, thread: CHAT2 });
    await flush();
    expect(target.entries).toHaveLength(2);

    target.back();
    await flush();
    expect(navStore.getState().chat).toBeNull();
    expect(navStore.getState().stack).toEqual([TASK]);
    detach();
  });
});
