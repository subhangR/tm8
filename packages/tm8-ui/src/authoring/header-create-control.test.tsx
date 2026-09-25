// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isCollabError, type CommandResult, type CreateEntityInput, type SpaceId } from '@tm8/contract';
import { getKind } from '../domain';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { FIXTURE_SPACE_ID, docLayoutSpec } from '../fixtures';
import { EntityCreateControl } from './EntityCreateControl';
import type { AuthoringCommands } from './commands';
import type { NewTaskHandle } from './useNewTask';

/**
 * I9a — the doc create offers "with header…" BESIDE the immediate ＋, and
 * sends the header on the same `entities.create`.
 */

afterEach(cleanup);

const SPACE = FIXTURE_SPACE_ID as SpaceId;

function immediate(): NewTaskHandle {
  return {
    state: { phase: 'idle' },
    unavailable: null,
    unavailableFor: () => null,
    create: vi.fn(async () => undefined),
    dismiss: vi.fn(),
  };
}

function commandsWith(createEntity: (input: CreateEntityInput) => Promise<CommandResult>) {
  return { createEntity: vi.fn(createEntity), patchEntity: vi.fn(), patchTask: vi.fn() } as unknown as AuthoringCommands & {
    createEntity: ReturnType<typeof vi.fn>;
  };
}

const created: CommandResult = { patches: [{ id: 'doc-new' } as never] };

function mount(commands: AuthoringCommands, flow = immediate(), onCreated = vi.fn()) {
  render(
    <div className="cv2-root">
      <EntityCreateControl
        config={getKind('doc')}
        immediate={flow}
        spaceId={SPACE}
        commands={commands}
        files={{} as never}
        onCreated={onCreated}
      />
    </div>,
  );
  return { flow, onCreated };
}

describe('create with a header', () => {
  it('keeps the immediate ＋ exactly as it was', () => {
    const commands = commandsWith(async () => created);
    const { flow } = mount(commands);
    fireEvent.click(screen.getByRole('button', { name: 'New doc' }));
    expect(flow.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('header-create-dialog')).toBeNull();
  });

  it('sends both answers as `header` on the same create call, and opens the new doc', async () => {
    const commands = commandsWith(async () => created);
    const { flow, onCreated } = mount(commands);
    fireEvent.click(screen.getByTestId('header-create-open'));
    fireEvent.change(screen.getByTestId('header-create-title'), { target: { value: 'Grid spec' } });
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: 'When touching the grid' } });
    fireEvent.change(screen.getByTestId('header-input-summary'), { target: { value: 'The layout formula' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create doc' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('doc-new', created));
    expect(commands.createEntity).toHaveBeenCalledTimes(1);
    const input = commands.createEntity.mock.calls[0]![0] as CreateEntityInput;
    expect(input).toMatchObject({
      spaceId: SPACE,
      kind: 'doc',
      title: 'Grid spec',
      header: { whenToUse: 'When touching the grid', summary: 'The layout formula', keywords: [] },
    });
    expect(input.clientMutationId).toMatch(/^au-/);
    expect(flow.create).not.toHaveBeenCalled();
    expect(screen.queryByTestId('header-create-dialog')).toBeNull();
  });

  it('both fields blank: the create goes WITHOUT a header, under the placeholder title', async () => {
    const commands = commandsWith(async () => created);
    mount(commands);
    fireEvent.click(screen.getByTestId('header-create-open'));
    fireEvent.click(screen.getByRole('button', { name: 'Create doc' }));
    await waitFor(() => expect(commands.createEntity).toHaveBeenCalledTimes(1));
    const input = commands.createEntity.mock.calls[0]![0] as CreateEntityInput;
    expect(input.title).toBe('Untitled doc');
    expect('header' in input).toBe(false);
  });

  it('keywords alone still go as `header` — a keywords-only header is one (migration 223)', async () => {
    const commands = commandsWith(async () => created);
    mount(commands);
    fireEvent.click(screen.getByTestId('header-create-open'));
    fireEvent.change(screen.getByTestId('header-input-keywords'), { target: { value: 'grid, layout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create doc' }));
    await waitFor(() => expect(commands.createEntity).toHaveBeenCalledTimes(1));
    const input = commands.createEntity.mock.calls[0]![0] as CreateEntityInput;
    expect(input.header).toEqual({ whenToUse: null, summary: null, keywords: ['grid', 'layout'] });
  });

  it('LENIENT: long answers never disable Create; a refusal is shown in the node\'s words', async () => {
    const commands = commandsWith(async () => {
      throw Object.assign(new Error('whenToUse must be at most 400 characters'), {});
    });
    mount(commands);
    fireEvent.click(screen.getByTestId('header-create-open'));
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: 'z'.repeat(900) } });
    const submit = screen.getByRole('button', { name: 'Create doc' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await screen.findByText(/whenToUse must be at most 400 characters/);
    // The form and its text survive the refusal.
    expect((screen.getByTestId('header-input-when') as HTMLTextAreaElement).value).toBe('z'.repeat(900));
  });

  it('a kind that does not declare it gets no "with header…"', () => {
    render(
      <div className="cv2-root">
        <EntityCreateControl config={getKind('channel')} immediate={immediate()} spaceId={SPACE} commands={commandsWith(async () => created)} files={{} as never} />
      </div>,
    );
    expect(screen.queryByTestId('header-create-open')).toBeNull();
  });
});

describe('the fixture seam keeps the header on its own version', () => {
  it('create with a header → the detail carries it; the entity version is untouched by later writes', async () => {
    const seam = createFixtureSeam();
    const result = await seam.commands.createEntity({
      spaceId: SPACE, kind: 'doc', title: 'H', clientMutationId: 'fx-1',
      header: { whenToUse: 'when', summary: null, keywords: ['a'] },
    });
    const id = result.entity!.id;
    expect(result.entity!.header).toMatchObject({ whenToUse: 'when', summary: null, keywords: ['a'], version: 1, source: 'authored' });
    const entityVersion = result.entity!.version;

    const set = await seam.commands.setEntityHeader(id, { summary: 'what', expectedVersion: 1 });
    expect(set.header).toMatchObject({ whenToUse: null, summary: 'what', version: 2, pinnedVersion: entityVersion, stale: false });
    expect((await seam.entity(id)).version).toBe(entityVersion);

    const conflict = await seam.commands.setEntityHeader(id, { summary: 'x', expectedVersion: 1 }).catch((e: unknown) => e);
    expect(isCollabError(conflict) && conflict.code).toBe('version_conflict');

    const cleared = await seam.commands.clearEntityHeader(id, { expectedVersion: 2 });
    expect(cleared.header?.version).toBe(0);
    expect((await seam.entity(id)).header).toBeUndefined();
    // The default read stays header-less; the opt-in read answers the fallback.
    expect(await seam.commands.resolvedHeader(id)).toMatchObject({ version: 0, source: 'derived' });
  });

  it('LENIENT: a kind with no header, or an empty header, is a no-op with a warning — never a refusal', async () => {
    const seam = createFixtureSeam();
    const channel = (await seam.commands.createEntity({ spaceId: SPACE, kind: 'channel', title: 'c', clientMutationId: 'fx-2' })).entity!;
    const notStored = await seam.commands.setEntityHeader(channel.id, { summary: 's' });
    expect(notStored.header).toBeUndefined();
    expect(notStored.warnings?.map((w) => w.code)).toEqual(['header_not_stored']);

    const empty = await seam.commands.setEntityHeader(docLayoutSpec.id, { whenToUse: '   ', keywords: [' '], expectedVersion: 0 });
    expect(empty.warnings?.map((w) => w.code)).toEqual(['header_empty']);
    expect(empty.header?.version).toBe(0);

    await expect(seam.commands.setEntityHeader(docLayoutSpec.id, { summary: 's', expectedVersion: 0 })).resolves.toMatchObject({ header: { version: 1 } });
  });
});
