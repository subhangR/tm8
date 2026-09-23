// @vitest-environment jsdom
/**
 * "CHAT ABOUT THIS" — the row-cluster verb, its address, and the reason it is
 * a navigation rather than a command.
 *
 * `chat.start` needs a teammate, a model and a mode. A tile's action cluster
 * is a row of 16px icons; a list header is one line. Neither can ask for three
 * choices, and choosing them silently would break the same rule
 * `launch-session` follows — a spawn's configuration must be visible at the
 * moment it is committed. So the verb binds the subject into the ADDRESS and
 * the composer is where the human commits.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { allKinds, getKind, resolveAction } from '../domain';
import { chatAboutTarget, composeListActions, useChatAbout } from './useChatAbout';

const SUBJECT = '019f0000-0000-7000-8000-0000000000a1' as EntityId;

describe('the verb is derived onto every kind that can be a subject', () => {
  it('reaches every row EXCEPT the two that structurally cannot have one', () => {
    /*
     * `about` is registered with `dst_kinds = array['*']` (migration 056), so
     * every kind is a legal subject and no per-kind list belongs in this
     * package. The two exclusions are structural, not editorial:
     *   · `message` is `strategy: 'anchored'` with `slug: null` — no collection
     *     surface, so no tile for the verb to sit on;
     *   · `chat` OPENS one, and a chat about a chat is a nesting nobody asked
     *     for. Its list gets the HEADER verb instead.
     */
    const without = allKinds()
      .filter((row) => !(row.list.rowActions ?? []).includes('chat-about'))
      .map((row) => row.kind)
      .sort();
    // `c:*` is NOT here: the custom-kind fallback row is a real registry row
    // and every custom kind lands on it, so a verb every kind has is a verb it
    // has too. Only the two exclusions above are absent.
    expect(without).toEqual(['chat', 'message']);
  });

  it('the Chats list offers it on the HEADER, where there is no row', () => {
    // `quickStart`, not `quickLaunch`: the two are not interchangeable —
    // `quickLaunch` carries `flow: 'launch'` and expands the spawn config, and
    // declaring this verb there would open a five-section execution card for a
    // chat. This one commits on click (it navigates).
    expect(getKind('chat').list.quickStart).toBe('chat-about');
    expect(getKind('chat').list.quickLaunch).toBeUndefined();
    expect(getKind('chat').list.quickCreate).toBe(false);
  });

  it('refuses only on the operation, never on a capability of the subject', () => {
    const def = resolveAction('chat-about');
    // `about` is an edge FROM the new chat, and the chat does not exist yet —
    // so `canEdit` on the SUBJECT is the wrong question. Requiring it would
    // refuse the verb on every row a viewer can read and not write.
    expect(def.availability({ spaceId: 'space-1', entityId: SUBJECT }).kind).toBe('available');
    expect(def.availability({ spaceId: 'space-1' }).kind).toBe('available');
    expect(
      def.availability({
        spaceId: 'space-1',
        entityId: SUBJECT,
        opUnavailable: { 'chat.start': 'this node has no chat runtime' },
      }),
    ).toEqual({ kind: 'disabled', reason: 'this node has no chat runtime' });
    // NOT a launch flow: a chat is configured in its own composer.
    expect(def.flow).toBeUndefined();
  });
});

describe('the address it lands on', () => {
  it('names the composer AND the subject', () => {
    expect(chatAboutTarget(SUBJECT)).toEqual({
      view: 'home',
      // `threadId: null` IS the composer — nothing is open, and this is what
      // the next conversation is about.
      root: { type: 'chats', threadId: null, aboutId: SUBJECT },
    });
  });

  it('carries no subject from the header, where there is no row', () => {
    expect(chatAboutTarget(null)).toEqual({
      view: 'home',
      root: { type: 'chats', threadId: null },
    });
  });
});

describe('the dispatcher', () => {
  it('routes the row id through, and the empty header id as no subject', () => {
    const open = vi.fn();
    const { result } = renderHook(() => useChatAbout({ open }));
    act(() => result.current.onAction!('chat-about', SUBJECT));
    expect(open).toHaveBeenCalledWith(SUBJECT);
    act(() => result.current.onAction!('chat-about', ''));
    expect(open).toHaveBeenLastCalledWith(null);
  });

  it('performs NOTHING it does not name — an unhandled verb is unreachable', () => {
    const open = vi.fn();
    const { result } = renderHook(() => useChatAbout({ open }));
    act(() => result.current.onAction!('terminate', SUBJECT));
    expect(open).not.toHaveBeenCalled();
    expect(result.current.wiredActions).toEqual(['chat-about']);
  });

  it('is UNDEFINED without a host verb, so the control refuses out loud', () => {
    // The enabled-inert failure mode this hook exists to end: a surface with
    // no route verb must draw the button disabled-with-reason, which the panel
    // does exactly when `onAction` is absent.
    const { result } = renderHook(() => useChatAbout({}));
    expect(result.current.onAction).toBeUndefined();
    expect(result.current.forEntity('x')).toBeUndefined();
  });
});

describe('composeListActions', () => {
  it('routes each verb to the FIRST part that names it, carrying the row id', () => {
    const start = vi.fn();
    const about = vi.fn();
    const composed = composeListActions([
      { onAction: start, wiredActions: ['start-terminal'] },
      { onAction: about, wiredActions: ['chat-about'] },
    ]);
    composed.onAction('chat-about', SUBJECT);
    expect(about).toHaveBeenCalledWith('chat-about', SUBJECT);
    expect(start).not.toHaveBeenCalled();
    // The union is what the surface DRAWS, so a verb behind neither part keeps
    // its honest refusal rather than lighting up inert.
    expect(composed.wiredActions).toEqual(['start-terminal', 'chat-about']);
  });

  it('drops a part with no dispatcher rather than swallowing its verbs', () => {
    const about = vi.fn();
    const composed = composeListActions([
      { onAction: undefined, wiredActions: ['start-terminal'] },
      { onAction: about, wiredActions: ['chat-about'] },
    ]);
    expect(composed.wiredActions).toEqual(['chat-about']);
  });
});
