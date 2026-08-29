// @vitest-environment jsdom
/**
 * §2.2/§2.4 — actors on the tile ride the PAYLOAD's honesty.
 *
 * The widened contract lets three shapes arrive: a person, a persona resolved
 * THROUGH a session (`via`), and a run with no persona (`kind:
 * 'work_session'`). The law under test: shape is provenance, colour keys on
 * the actor id, and a RUN IS NEVER DRAWN WITH A FACE.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ActorSummary } from '@tm8/contract';
import { ActorRef } from './ActorRef';
import { AvatarStack } from './AvatarStack';
import { renderBadge } from '../panels/list/tile-badges';
import type { EntitySummary } from '@tm8/contract';

const human: ActorSummary = {
  id: 'actor-h',
  kind: 'member',
  displayName: 'Ada',
  avatar: null,
  role: null,
  isAgent: false,
};
const personaViaSession: ActorSummary = {
  id: 'actor-p',
  kind: 'team_member',
  displayName: 'Fable 5 Teammate',
  avatar: null,
  role: null,
  isAgent: true,
  via: { sessionId: 'sess-1' },
};
const run: ActorSummary = {
  id: 'sess-2',
  kind: 'work_session',
  displayName: 'Fix the boot manager',
  avatar: null,
  role: null,
  isAgent: false,
};

describe('ActorRef — payload-driven, no extra fetches', () => {
  it('a person renders an avatar and a name, no via chip', () => {
    const { getByTestId, queryByTestId, container } = render(<ActorRef actor={human} />);
    expect(getByTestId('actor-ref')).toBeTruthy();
    expect(container.querySelector('.kit-avatar')).toBeTruthy();
    expect(queryByTestId('actor-ref-via')).toBeNull();
  });

  it('a persona resolved through a session keeps its avatar and gains the via chip', () => {
    const open = vi.fn();
    const { getByTestId, container } = render(
      <ActorRef actor={personaViaSession} onOpenSession={open} />,
    );
    // The avatar is the PERSONA's — agent-shaped, keyed on the persona id.
    expect(container.querySelector('.kit-avatar--agent')).toBeTruthy();
    fireEvent.click(getByTestId('actor-ref-via'));
    expect(open).toHaveBeenCalledWith('sess-1');
  });

  it('a run renders a session chip and NEVER an avatar', () => {
    const { getByTestId, container } = render(<ActorRef actor={run} />);
    expect(getByTestId('actor-ref-run').textContent).toContain('▸ Fix the boot manager');
    expect(container.querySelector('.kit-avatar')).toBeNull();
  });
});

describe('AvatarStack — up to three faces, honest overflow', () => {
  it('caps at three faces and counts the rest', () => {
    const many = [human, personaViaSession, { ...human, id: 'h2' }, { ...human, id: 'h3' }];
    const { container, getByText } = render(<AvatarStack actors={many} />);
    expect(container.querySelectorAll('.kit-avatar')).toHaveLength(3);
    expect(getByText('+1')).toBeTruthy();
  });

  it('a run is counted but never drawn as a face', () => {
    const { container, getByText } = render(<AvatarStack actors={[human, run]} />);
    expect(container.querySelectorAll('.kit-avatar')).toHaveLength(1);
    expect(getByText('+1')).toBeTruthy();
  });
});

describe('tile workingActors badge — the run treatment', () => {
  const rowWith = (actor: ActorSummary): EntitySummary =>
    ({
      badges: { workingActors: [{ actor, task: null as never, startedAt: '', note: null }] },
      state: { kind: 'task' },
    }) as unknown as EntitySummary;

  it('a persona stays an avatar slot', () => {
    const slot = renderBadge('workingActors', rowWith(personaViaSession));
    expect(slot).toMatchObject({ slot: 'avatar', actorId: 'actor-p', provenance: 'agent' });
  });

  it('a run becomes a session tag, never an avatar slot', () => {
    const slot = renderBadge('workingActors', rowWith(run));
    expect(slot).toMatchObject({ slot: 'tag', label: '▸ Fix the boot manager' });
  });
});
