// @vitest-environment jsdom
/**
 * The project git screen, driven through the FIXTURE seam. The fixture's
 * contention answer is built to exercise every honesty rule at once: two
 * readable lanes that OVERLAP on one path, and one lane the node cannot
 * read, reported SKIPPED with its reason. FLOW C's spine lives here as a
 * component truth (topology → lanes → overlap warning → click-through);
 * the browser-level proof is the Playwright journey (e2e/project-git).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CollabError, type SpaceId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { sessionLive } from '../fixtures';
import { ProjectGitScreen } from './ProjectGitScreen';

const SPACE = 'space-fixture' as SpaceId;

describe('ProjectGitScreen — topology, lanes, contention (Surface 3)', () => {
  it('renders branch topology, every lane (skipped one included), and the overlap pair', async () => {
    const seam = createFixtureSeam();
    render(<ProjectGitScreen seam={seam} spaceId={SPACE} />);

    // Topology arrives via the REUSED #74 list, not a fork of it.
    await screen.findByTestId('branch-topology');

    // All three fixture lanes render — including the unreadable one, which
    // carries its skip reason instead of silently vanishing.
    const lanes = await screen.findAllByTestId('project-git-lane');
    expect(lanes).toHaveLength(3);
    expect(screen.getByTestId('project-git-lane-skipped').textContent).toMatch(
      /not readable on this node/,
    );

    // The overlap pair names both branches and the shared path.
    const pairs = screen.getByTestId('project-git-pairs');
    expect(pairs.textContent).toContain('tm8/fixture-lane');
    expect(pairs.textContent).toContain('tm8/sweep-lane');
    expect(pairs.textContent).toContain('packages/server/src/facade/handlers/projects.ts');
  });

  it('clicks through a lane to its owning session', async () => {
    const seam = createFixtureSeam();
    const onOpenEntity = vi.fn();
    render(<ProjectGitScreen seam={seam} spaceId={SPACE} onOpenEntity={onOpenEntity} />);

    const links = await screen.findAllByTestId('project-git-lane-session');
    fireEvent.click(links[0]!);
    expect(onOpenEntity).toHaveBeenCalledWith(sessionLive.id);
  });

  it('says a space with no linked projects has none — never a blank screen', async () => {
    const seam = { ...createFixtureSeam(), projects: async () => [] };
    render(<ProjectGitScreen seam={seam} spaceId={SPACE} />);
    const empty = await screen.findByTestId('project-git-empty');
    expect(empty.textContent).toMatch(/no linked projects/i);
  });

  it('words invalid_input as a fact about the PROJECT — not a git repository', async () => {
    const seam = {
      ...createFixtureSeam(),
      projectBranches: async () => {
        throw new CollabError('invalid_input', 'workingDir is not a git repository');
      },
    };
    render(<ProjectGitScreen seam={seam} spaceId={SPACE} />);
    const err = await screen.findByTestId('project-git-branches-error');
    expect(err.textContent).toMatch(/not a git repository/i);
    // The other read still lands — one dead read must not blank the card.
    await screen.findByTestId('project-git-lanes');
  });

  it('states a failed contention read as such, while topology still renders', async () => {
    const seam = {
      ...createFixtureSeam(),
      projectContention: async () => {
        throw new Error('node unreachable');
      },
    };
    render(<ProjectGitScreen seam={seam} spaceId={SPACE} />);
    const err = await screen.findByTestId('project-git-contention-error');
    expect(err.textContent).toContain('node unreachable');
    await screen.findByTestId('branch-topology');
  });

  it('renders zero lanes and zero pairs as measured claims, not empty divs', async () => {
    const seam = {
      ...createFixtureSeam(),
      projectContention: async () => ({
        projectId: 'proj-tm8ui',
        generatedAt: '2026-08-09T00:00:00.000Z',
        lanes: [],
        pairs: [],
      }),
    };
    render(<ProjectGitScreen seam={seam} spaceId={SPACE} />);
    expect((await screen.findByTestId('project-git-no-lanes')).textContent).toMatch(
      /no active worktrees/i,
    );
    expect(screen.getByTestId('project-git-no-contention').textContent).toMatch(
      /no contention observed/i,
    );
  });
});
