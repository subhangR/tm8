// @vitest-environment jsdom
/**
 * THE STATES A SHARED LINK CREATES THAT AN IN-APP PROMOTE NEVER DOES.
 *
 * A promote always has a loaded entity — the viewer was already looking at it.
 * A pasted link has nothing: the entity may be loading, may never have existed,
 * or may be one this viewer is not allowed to read. Those three were
 * unrepresentable before this component; `e/{id}` landed on the unbuilt-view
 * card (`GateApp.tsx:1585`) whatever was behind it.
 *
 * The assertions that matter here are mostly about what is NOT said and NOT
 * drawn: no reason on a refusal (R4), no control that cannot perform, no push
 * where a replace is required (R15), and no second Space.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EntityId, EntityKind } from '@tm8/contract';
import { createFixtureSeam } from '../../data';
import { EntityFullView, companionOf } from './index';
import type { EntityFullPort, EntityResolution } from './index';

afterEach(() => cleanup());

const ENTITY = 'task-guide-lines' as EntityId;

function portOf(resolution: EntityResolution): EntityFullPort {
  return { lookup: () => resolution };
}

/** A stand-in for 1C's `EntityUnavailableRefusal`, which lands on its own branch.
    Deliberately minimal: this suite must not assert THEIR copy, only that the
    slot is offered and wired. */
function placeholderUnavailable({ onRecover }: { onRecover?: () => void }) {
  return (
    <div data-testid="stub-unavailable">
      <span>This linked entity is unavailable.</span>
      {onRecover && (
        <button type="button" onClick={onRecover}>
          Open the Space
        </button>
      )}
    </div>
  );
}

const panel = <div data-testid="stub-panel">the wired panel</div>;

describe('the three states, and which one a link can be in', () => {
  it('hands off to the panel inside the Z4 host once the entity is there', () => {
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="link"
        origin={{ slug: 'tasks', mode: null }}
        port={portOf({ status: 'ready', kind: 'task' as EntityKind })}
        panel={panel}
      />,
    );

    /* Placement is the EXISTING host — not a second frame invented here. */
    const host = screen.getByTestId('z4-host');
    expect(host.getAttribute('data-entity-id')).toBe(ENTITY);
    expect(screen.getByTestId('stub-panel')).toBeTruthy();
  });

  it('says it is opening, and does not draw a panel skeleton it cannot honour', () => {
    render(
      <EntityFullView entityId={ENTITY} arrival="link" port={portOf({ status: 'resolving' })} panel={panel} />,
    );

    expect(screen.getByTestId('entity-full-view-resolving')).toBeTruthy();
    /* The panel's own LoadingBody would promise an entity that, on a dead
       link, is never coming. We have not decided to draw a panel yet. */
    expect(screen.queryByTestId('stub-panel')).toBeNull();
  });

  it('renders the injected unavailable card instead of the panel', () => {
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="link"
        port={portOf({ status: 'unavailable' })}
        panel={panel}
        renderUnavailable={placeholderUnavailable}
      />,
    );

    expect(screen.getByTestId('entity-full-view-unavailable')).toBeTruthy();
    expect(screen.getByTestId('stub-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('stub-panel')).toBeNull();
  });
});

describe('R4 — a refusal to a link holder discloses nothing', () => {
  /**
   * THE TWO CARDS IN THIS TREE ARE DIFFERENT ON PURPOSE, and someone will
   * eventually try to merge them. `space-refusal-card.test.tsx` pins the
   * OPPOSITE requirement for the ordinary boot: the node's own words survive the
   * trip, because a viewer whose boot restores a Space they were removed from
   * already knew it existed. A stranger holding a URL did not. Same refusal, two
   * audiences, and the distinguishing fact is whether the viewer arrived BY
   * ADDRESS or BY MEMORY.
   */
  it('cannot express why, because the port has nowhere to put a reason', () => {
    /* The type is the enforcement; this asserts the value shape agrees, so a
       later widening of `EntityResolution` fails here rather than in the UI. */
    const refused: EntityResolution = { status: 'unavailable' };
    expect(Object.keys(refused)).toEqual(['status']);
  });

  it('names no Space, no membership and no cause on screen', () => {
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="link"
        port={portOf({ status: 'unavailable' })}
        panel={panel}
        renderUnavailable={placeholderUnavailable}
      />,
    );

    const card = screen.getByTestId('entity-full-view-unavailable');
    expect(card.textContent).not.toMatch(/not a member|forbidden|refused|does not exist|no such/i);
  });
});

describe('R15 — the history discipline is carried, not guessed', () => {
  it('a COLD LINK replaces, so Back cannot restore the address that failed', () => {
    const onLeave = vi.fn();
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="link"
        port={portOf({ status: 'unavailable' })}
        panel={panel}
        onLeave={onLeave}
        renderUnavailable={placeholderUnavailable}
      />,
    );

    fireEvent.click(screen.getByText('Open the Space'));

    /* If this pushed, Back would return to the broken entity and the viewer
       would be trapped in a two-item loop with no exit — on the exact entry
       path a shared link creates. */
    expect(onLeave).toHaveBeenCalledWith({ destination: null, history: 'replace' });
  });

  it('a PROMOTE pushes, because it arrived by a push with a stack behind it', () => {
    const onLeave = vi.fn();
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="promote"
        origin={null}
        knownKind={'task' as EntityKind}
        port={portOf({ status: 'resolving' })}
        panel={panel}
        onLeave={onLeave}
      />,
    );

    fireEvent.click(screen.getByLabelText('Collapse full view'));
    expect(onLeave).toHaveBeenCalledWith({ destination: { slug: 'tasks' }, history: 'push' });
  });
});

describe('promote does not pay the cold path’s costs', () => {
  it('skips the read entirely when the caller already knows the kind', () => {
    const lookup = vi.fn(() => ({ status: 'resolving' }) as EntityResolution);
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="promote"
        knownKind={'task' as EntityKind}
        port={{ lookup }}
        panel={panel}
      />,
    );

    /* A round trip here would also be a visible loading flash on a purely
       local action — the entity was on screen a moment ago. */
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByTestId('stub-panel')).toBeTruthy();
  });
});

describe('no control that cannot perform', () => {
  it('draws no collapse affordance when there is nowhere to collapse to', () => {
    /* `message` is the 'anchored' strategy: slug null, no k/ view BY DESIGN
       (WLT §2.1, and the registry row says so in as many words). Nowhere to go
       is a fact about the kind, NOT a broken link. */
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="promote"
        origin={null}
        knownKind={'message' as EntityKind}
        port={portOf({ status: 'resolving' })}
        panel={panel}
        onLeave={() => {}}
      />,
    );

    expect(screen.getByTestId('stub-panel')).toBeTruthy();
    expect(screen.queryByLabelText('Collapse full view')).toBeNull();
  });

  it('draws no collapse affordance when no handler is wired at all', () => {
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="link"
        origin={{ slug: 'tasks', mode: null }}
        port={portOf({ status: 'ready', kind: 'task' as EntityKind })}
        panel={panel}
      />,
    );

    expect(screen.queryByLabelText('Collapse full view')).toBeNull();
  });

  it('offers no recovery button when the unavailable state has no safe action', () => {
    render(
      <EntityFullView
        entityId={ENTITY}
        arrival="link"
        port={portOf({ status: 'unavailable' })}
        panel={panel}
        renderUnavailable={placeholderUnavailable}
      />,
    );

    expect(screen.queryByText('Open the Space')).toBeNull();
  });
});

describe('the canonical-reload rule, which is why this is not a pure function of the route', () => {
  it('takes the companion from origin when the link carried one', () => {
    expect(companionOf({ slug: 'sessions', mode: 'tree' }, null)).toEqual({ slug: 'sessions', mode: 'tree' });
  });

  it('resolves it from the KIND when there is no origin — the promote case', () => {
    /* `landingOfRoute` correctly returns null here (nav-targets.ts:247): the
       resolution needs a READ, so a pure route mapping cannot do it. This
       component is that caller. */
    expect(companionOf(null, 'task' as EntityKind)).toEqual({ slug: 'tasks' });
  });

  it('returns no companion for a kind that genuinely has no collection screen', () => {
    expect(companionOf(null, 'message' as EntityKind)).toBeNull();
  });

  it('returns no companion while the kind is still unknown', () => {
    expect(companionOf(null, null)).toBeNull();
  });
});

describe('the port is satisfiable from the real seam', () => {
  /**
   * The adapter is Phase 2's to write (`views/channel-feed-port.ts` is the
   * idiom). This proves the narrow shape this directory declared can actually
   * be produced from the seam's own reads — so the contract cannot be one the
   * host is unable to honour, which is the failure that only shows up at mount.
   */
  it('maps a real entity read onto a resolution, and a miss onto unavailable', async () => {
    const seam = createFixtureSeam();

    const resolve = async (id: EntityId): Promise<EntityResolution> => {
      try {
        const detail = await seam.entity(id);
        return { status: 'ready', kind: detail.kind };
      } catch {
        /* EVERY failure collapses to one answer. The seam distinguishes
           not_found from forbidden; this adapter deliberately does not carry
           that across, which is where R4 is actually enforced. */
        return { status: 'unavailable' };
      }
    };

    expect(await resolve(ENTITY)).toEqual({ status: 'ready', kind: 'task' });
    expect(await resolve('no-such-entity' as EntityId)).toEqual({ status: 'unavailable' });
  });
});
