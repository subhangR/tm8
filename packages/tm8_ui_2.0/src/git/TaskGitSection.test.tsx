// @vitest-environment jsdom
/**
 * The task detail's git section, driven through the FIXTURE seam — proving
 * both sides at once, like SessionGitBody.test: the section's honesty rules
 * AND the fixture's tracks/created_in graph.
 *
 * CHIP CONSUMPTION IS PINNED HERE: the PR rows must render through Lane B's
 * `linked-pr-chips` testids — the day this section grows its own chip markup
 * is the day two greens mean different things, and this file goes red.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture.js';
import type { Seam } from '../data/seam.js';
import { TaskGitSection } from './TaskGitSection.js';

const TASK = 'task-4f8c2a9e' as EntityId; // tracks PR #212 (open) + commit-a0
const BARE_TASK = 'task-guide-lines' as EntityId; // tracks nothing in the detail graph

function mount(over: { taskId?: EntityId; gate?: 'none' | 'pr_merged'; onOpen?: (id: string) => void } = {}) {
  const seam: Seam = createFixtureSeam();
  render(
    <TaskGitSection
      seam={seam}
      taskId={over.taskId ?? TASK}
      completionGate={over.gate}
      onOpenEntity={over.onOpen}
    />,
  );
  return seam;
}

describe('tracked artifacts', () => {
  it('renders the PR through Lane B chips (consumed, not forked) and the commit with provenance', async () => {
    mount();
    // The PR row is Lane B's component — its testids are the proof of reuse.
    const chips = await screen.findByTestId('linked-pr-chips');
    expect(chips.getAttribute('data-placement')).toBe('detail');
    expect(screen.getByTestId('linked-pr').getAttribute('data-pr-number')).toBe('212');

    // The commit lists sha + message, and the `created_in` session beside it.
    const commits = screen.getByTestId('task-git-commits');
    expect(commits.textContent).toContain('9b1c2d3e4f');
    expect(commits.textContent).toContain('A0 foundation');
    expect(commits.textContent).toContain('forge · tm8-ui kit');
    // The distinct worked-by trail names the session once.
    expect(screen.getByTestId('task-git-sessions').textContent).toContain('forge · tm8-ui kit');
  });

  it('click-through opens the owning session', async () => {
    const opened: string[] = [];
    mount({ onOpen: (id) => opened.push(id) });
    await screen.findByTestId('task-git-commits');
    fireEvent.click(screen.getByTitle('produced by forge · tm8-ui kit'));
    expect(opened).toContain('019f0000-0000-7000-8000-000000000031');
  });

  it('a task tracking nothing renders the explained empty, never a blank section', async () => {
    mount({ taskId: BARE_TASK });
    const empty = await screen.findByTestId('task-git-empty');
    expect(empty.textContent).toContain('link-pr');
  });
});

describe('completion-gate honesty', () => {
  it('gate pr_merged + an OPEN tracked PR states the refusal BEFORE the click', async () => {
    mount({ gate: 'pr_merged' });
    const gate = await screen.findByTestId('task-git-gate');
    expect(gate.textContent).toContain('REFUSE');
    expect(gate.textContent).toContain('PR #212 is open');
  });

  it('gate pr_merged with NO tracked PR is also a stated refusal', async () => {
    mount({ taskId: BARE_TASK, gate: 'pr_merged' });
    const gate = await screen.findByTestId('task-git-gate');
    expect(gate.textContent).toContain('no tracked pull request');
  });

  it('no gate ⇒ no gate claim at all', async () => {
    mount();
    await screen.findByTestId('task-git-section');
    expect(screen.queryByTestId('task-git-gate')).toBeNull();
  });
});
