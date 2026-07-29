// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EntityDetail, SpaceId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import type { Seam } from '../data/seam';
import { FIXTURE_SPACE_ID } from '../fixtures';
import {
  AuthoringHost,
  InlineTitleEditor,
  NewTaskControl,
  SaveControls,
  placeholderTitleFor,
  useNewTask,
  useTaskSave,
  type AuthoringCommands,
} from './index';

/**
 * THE TEST THAT LIVES IN THE GAP (D57.1).
 *
 * Everything above this file is testable on one side of the seam: the port is
 * a shape, the components take a scripted executor, the fixture seam has its
 * own suite. All three can be green while the feature is dead — that is
 * exactly what happened with `rowsFor`, where four correct links and a
 * signature that promised acceptance rendered four sessions as twelve.
 *
 * So this file crosses it: the REAL fixture seam, the REAL components, driven
 * through the REAL call path. The assertions are about the DATASET after the
 * click, not about a mock having been invoked.
 *
 * Note what makes this possible without touching `src/data/**` (read-only to
 * this lane): the port is a STRUCTURAL SUBSET of `Seam['commands']`, so the
 * real object is handed over with no adapter and no cast. If bridge ever
 * changed either signature, the assignment on line ~50 stops compiling — the
 * assignment IS the compile-time half of the crossing assertion.
 */

afterEach(cleanup);

const SPACE = FIXTURE_SPACE_ID as SpaceId;

function seamOf(): { seam: Seam; commands: AuthoringCommands } {
  const seam = createFixtureSeam();
  // THE CROSSING, at the type level: no adapter, no cast, no optional chain.
  const commands: AuthoringCommands = seam.commands;
  return { seam, commands };
}

describe('the port is the real seam, structurally', () => {
  it('accepts seam.commands with neither adapter nor cast, and both members are live', () => {
    const { commands } = seamOf();
    expect(typeof commands.createTask).toBe('function');
    expect(typeof commands.patchTask).toBe('function');
  });
});

describe('create → open → rename, end to end through the fixture seam', () => {
  function Flow({ seam, commands }: { seam: Seam; commands: AuthoringCommands }) {
    const [detail, setDetail] = useState<EntityDetail | null>(null);
    const create = useNewTask({
      spaceId: SPACE,
      placeholderTitle: placeholderTitleFor('Task'),
      commands,
      onCreated: (id) => {
        // What the coordinator's wiring does: open the panel on the new id.
        void seam.entity(id).then(setDetail);
      },
    });
    const save = useTaskSave({ detail, commands, onReload: setDetail });
    return (
      <AuthoringHost save={save}>
        <NewTaskControl flow={create} label="+ New" />
        {detail ? (
          <div data-testid="opened-panel">
            <InlineTitleEditor
              value={detail.title}
              editable={detail.capabilities.canEdit && detail.deletedAt === null}
              onCommit={(title) => void save.commitNow({ title }).then(() => seam.entity(detail.id).then(setDetail))}
            />
            <SaveControls save={save} />
          </div>
        ) : null}
      </AuthoringHost>
    );
  }

  it('the created task EXISTS in the dataset, titled by the oracle placeholder', async () => {
    const { seam, commands } = seamOf();
    await seam.openSpace(SPACE);
    render(<Flow seam={seam} commands={commands} />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /new/i })); });
    await act(async () => {});

    const panel = screen.getByTestId('opened-panel');
    expect(panel.textContent).toContain('Untitled task');

    // Assert against the SEAM, not the screen: the row is really there.
    const result = await seam.query({ spaceId: SPACE, kinds: ['task'] } as never);
    const created = result.page.items.find((row) => row.title === 'Untitled task');
    expect(created, 'the placeholder row must exist in the dataset').toBeTruthy();
    expect(created?.version).toBe(1);
  });

  it('Enter renames it FOR REAL — the seam read comes back with the new title', async () => {
    const { seam, commands } = seamOf();
    await seam.openSpace(SPACE);
    render(<Flow seam={seam} commands={commands} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /new/i })); });
    await act(async () => {});

    fireEvent.click(screen.getByTestId('authoring-title'));
    const input = screen.getByRole('textbox', { name: /title/i });
    fireEvent.change(input, { target: { value: 'Named by the flow' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    await act(async () => {});

    const rows = await seam.query({ spaceId: SPACE, kinds: ['task'] } as never);
    const renamed = rows.page.items.find((row) => row.title === 'Named by the flow');
    expect(renamed, 'the rename must be in the dataset, not only on screen').toBeTruthy();
    // patchTask bumps the version; the next edit must expect THIS one.
    expect(renamed?.version).toBe(2);
    expect(rows.page.items.some((row) => row.title === 'Untitled task')).toBe(false);
  });
});

describe('the executor really refuses a stale expectedVersion', () => {
  it('a patch at a superseded version is REFUSED and renders the conflict state', async () => {
    /**
     * The half a mocked conflict cannot prove: that the thing executing the
     * command actually enforces expectedVersion. D57's rule — a contract
     * declaration is a promise, an executor's implementation is the fact.
     */
    const { seam, commands } = seamOf();
    await seam.openSpace(SPACE);
    const created = await commands.createTask({
      spaceId: SPACE,
      title: 'contested',
      clientMutationId: 'seam-test-1',
    });
    const id = (created.entity ?? created.patches[0]).id;

    function Editor({ detail }: { detail: EntityDetail }) {
      const save = useTaskSave({ detail, commands });
      return (
        <AuthoringHost save={save}>
          <SaveControls save={save} />
          <button type="button" onClick={() => save.edit({ description: 'mine' })}>
            stage
          </button>
        </AuthoringHost>
      );
    }

    const detail = await seam.entity(id);
    render(<Editor detail={detail} />);
    fireEvent.click(screen.getByRole('button', { name: 'stage' }));

    // Someone else writes, THROUGH THE SAME EXECUTOR, while the draft is open.
    await commands.patchTask(id, {
      expectedVersion: detail.version,
      title: 'theirs',
      clientMutationId: 'seam-test-2',
    });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });

    const card = screen.getByTestId('authoring-conflict');
    expect(card.textContent).toMatch(/nothing was saved/i);
    // The fixture seam attaches `current: EntityDetail` to a version_conflict,
    // so the honest overwrite path is reachable rather than disabled.
    expect(card.textContent).toContain(`v${detail.version + 1}`);

    // And the other writer's value survived — no silent overwrite happened.
    const after = await seam.entity(id);
    expect(after.title).toBe('theirs');
  });

  it('overwrite, once CHOSEN, lands at the current version', async () => {
    const { seam, commands } = seamOf();
    await seam.openSpace(SPACE);
    const created = await commands.createTask({
      spaceId: SPACE,
      title: 'contested-2',
      clientMutationId: 'seam-test-3',
    });
    const id = (created.entity ?? created.patches[0]).id;
    const detail = await seam.entity(id);

    function Editor() {
      const save = useTaskSave({ detail, commands });
      return (
        <AuthoringHost save={save}>
          <SaveControls save={save} />
          <button type="button" onClick={() => save.edit({ title: 'mine wins' })}>
            stage
          </button>
        </AuthoringHost>
      );
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'stage' }));
    await commands.patchTask(id, {
      expectedVersion: detail.version,
      title: 'theirs',
      clientMutationId: 'seam-test-4',
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /overwrite/i })); });

    const after = await seam.entity(id);
    expect(after.title).toBe('mine wins');
    expect(screen.queryByTestId('authoring-conflict')).toBeNull();
  });
});
