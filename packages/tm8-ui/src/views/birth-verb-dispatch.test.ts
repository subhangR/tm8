/**
 * EVERY KIND'S BIRTH VERB HAS SOMETHING THAT PERFORMS IT.
 *
 * `ListRootHeader`'s ＋ half asks the registry how a kind is born
 * (`list.quickStart`) and the HOST dispatches the verb it names. The hosts
 * compose their dispatchers — `useSessionStart` and `useChatAbout` — and gate
 * the control on the composed `wiredActions`, so a verb nothing performs
 * renders an honest refusal instead of a button.
 *
 * THE DEFECT THIS EXISTS TO CATCH, which shipped: both hosts reached past the
 * composition into `sessionStart.onAction` and asked only whether THAT hook
 * was wired. Its dispatch is a switch — `start-terminal`, then
 * `default: return` — so `chat`'s `quickStart` of `chat-about` passed the
 * gate, drew an enabled ＋ on the Chats row, and did nothing at all on click.
 * No refusal, no navigation, no error: the enabled-inert control all three
 * dispatcher hooks say in their own docblocks that they exist to end.
 *
 * A REGISTRY-VS-DISPATCHER COVERAGE TEST, deliberately, rather than a render
 * test per host. The failure is not visual and it is not per-screen — it is a
 * kind naming a verb no executor knows — so this asserts exactly that, once,
 * and it fires for the NEXT kind that declares a birth verb without wiring
 * one. A render test would have to be duplicated per host and would still miss
 * the kind nobody thought to render.
 */
import { describe, expect, it, vi } from 'vitest';
import { collectionKinds } from '../domain';
import { rootBirthAction, rootBirthDispatch } from '../panels/ListRootHeader';
import { SESSION_START_ACTIONS } from './useSessionStart';
import { CHAT_ABOUT_ACTIONS } from './useChatAbout';

/** The union the hosts compose. Named here from the same two constants the
 *  hooks export, so a hook that gains a verb widens this with it. */
const DISPATCHABLE = new Set<string>([...SESSION_START_ACTIONS, ...CHAT_ABOUT_ACTIONS]);

describe('birth verbs and the dispatchers behind them', () => {
  it('names a quickStart only where a dispatcher can perform it', () => {
    const declared = collectionKinds()
      .map((config) => [config.kind, rootBirthAction(config.kind)] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== undefined);

    // NOT VACUOUS: a comparison over an empty set reports success, and this
    // one would if `quickStart` were ever renamed out from under
    // `rootBirthAction`. Two kinds declare one today — work_session and chat.
    expect(declared.length).toBeGreaterThanOrEqual(2);

    const unperformable = declared.filter(([, action]) => !DISPATCHABLE.has(action));
    expect(unperformable).toEqual([]);
  });

  it('covers `chat` specifically — the kind whose ＋ was inert', () => {
    // The premise, guarded: if `chat` ever stops declaring a birth verb this
    // test must say so rather than pass because there is nothing to check.
    expect(rootBirthAction('chat')).toBe('chat-about');
    expect(CHAT_ABOUT_ACTIONS).toContain('chat-about');
    // And the hook that does NOT perform it, which is what the hosts used to
    // ask. This is the whole bug in one line.
    expect(SESSION_START_ACTIONS).not.toContain('chat-about');
  });

  it('still covers `work_session`, whose ＋ always worked', () => {
    expect(rootBirthAction('work_session')).toBe('start-terminal');
    expect(SESSION_START_ACTIONS).toContain('start-terminal');
  });
});

describe('rootBirthDispatch — the arm both hosts share', () => {
  /** A composed dispatcher, exactly the shape `composeListActions` returns. */
  const dispatcherFor = (wiredActions: readonly string[]) => ({
    onAction: vi.fn(),
    wiredActions: wiredActions as readonly import('../domain').ActionRef[],
  });

  it('performs the verb through the dispatcher that names it', () => {
    const composed = dispatcherFor(['start-terminal', 'chat-about']);
    const verb = rootBirthDispatch('chat', composed);
    expect(verb?.refusal).toBeNull();
    verb?.perform();
    expect(composed.onAction).toHaveBeenCalledWith('chat-about', '');
  });

  it('REFUSES rather than clicking into nothing when no part performs the verb', () => {
    /*
     * THE SHIPPED DEFECT, stated as a test. A dispatcher wired only for
     * `start-terminal` is exactly what `useSessionStart` alone is, and it is
     * what both hosts used to consult. Handing it `chat-about` produced an
     * ENABLED control (`refusal: null`) whose `perform` reached a `default:
     * return`. The two assertions below are one claim: the failure must be
     * VISIBLE, never silent.
     */
    const sessionOnly = dispatcherFor(['start-terminal']);
    const verb = rootBirthDispatch('chat', sessionOnly);
    expect(verb?.refusal).not.toBeNull();
    verb?.perform();
    expect(sessionOnly.onAction).not.toHaveBeenCalled();
  });

  it('still performs `work_session` through a session-only dispatcher — the negative control', () => {
    // Without this, refusing everything would pass the case above.
    const sessionOnly = dispatcherFor(['start-terminal']);
    const verb = rootBirthDispatch('work_session', sessionOnly);
    expect(verb?.refusal).toBeNull();
    verb?.perform();
    expect(sessionOnly.onAction).toHaveBeenCalledWith('start-terminal', '');
  });

  it('returns null for a kind with no birth verb, so the caller falls through to generic create', () => {
    expect(rootBirthAction('task')).toBeUndefined();
    expect(rootBirthDispatch('task', dispatcherFor(['start-terminal', 'chat-about']))).toBeNull();
  });
});
