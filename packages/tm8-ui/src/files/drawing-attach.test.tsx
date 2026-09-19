// @vitest-environment jsdom
/**
 * "Create a drawing and attach it to this task" — the whole path, from the ＋
 * menu down to the command the seam receives.
 *
 * THE ASSERTION THAT EARNS ITS KEEP is that the create carries
 * `attachTo: { edgeType: 'attached_to' }` and NOT `parentId`. Using the task as
 * the drawing's parent is the obvious implementation, it reads correctly, and
 * the DATABASE REFUSES IT: `validate_entity_parent` requires parent.kind =
 * child.kind, with one ruled exception (chat -> work_session) that is not this
 * one. A fixture seam will happily accept `parentId` and render a perfectly
 * convincing green test, so nothing but an explicit assertion keeps this from
 * drifting back into a shape that fails only against a real node.
 *
 * The port is the REAL `attachmentsPortFromSeam` over a REAL fixture seam, the
 * same law `AttachmentStrip.test.tsx` states: a green run means the call went
 * through the actual port, not that a spy saw a function.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { CreateEntityInput } from '@tm8/contract';

import { AttachmentStrip } from './AttachmentStrip';
import { attachmentsPortFromSeam } from './port';
import { createFixtureSeam, FIXTURE_SPACE_ID } from '../data';

const ANCHOR = 'task-anchor-1';

function stripWith(createDrawing?: () => void | Promise<void>) {
  return render(
    <AttachmentStrip
      anchorId={ANCHOR}
      files={[]}
      {...(createDrawing ? { createDrawing } : {})}
      startUpload={(() => ({ }) as never)}
      projectFolder={{ projects: async () => [], list: async () => ({ } as never), attach: async () => {} }}
    />,
  );
}

describe('creating a drawing attached to a task', () => {
  it('the port asks for a DRAWING attached by edge — never as a child', async () => {
    const seam = createFixtureSeam();
    const seen: CreateEntityInput[] = [];
    const spied = {
      ...seam,
      commands: {
        ...seam.commands,
        createEntity: async (input: CreateEntityInput) => {
          seen.push(input);
          return seam.commands.createEntity(input);
        },
      },
    };

    const port = attachmentsPortFromSeam(spied as never, FIXTURE_SPACE_ID);
    const id = await port.createDrawing!(ANCHOR as never, 'Login wireframe');

    expect(seen).toHaveLength(1);
    const input = seen[0]!;
    expect(input.kind).toBe('drawing');
    expect(input.title).toBe('Login wireframe');
    // THE POINT: an edge, not hierarchy. `parentId` is refused by the node.
    expect(input.attachTo).toEqual({ entityId: ANCHOR, edgeType: 'attached_to' });
    expect(input.parentId ?? null).toBeNull();
    // A create with no mutation id is refused by the server outright.
    expect(input.clientMutationId).toBeTruthy();
    // The id comes back so the caller can open what it just made.
    expect(id).toBeTruthy();
  });

  it('the created drawing carries a real, EMPTY scene — a new canvas is blank', async () => {
    const seam = createFixtureSeam();
    const port = attachmentsPortFromSeam(seam as never, FIXTURE_SPACE_ID);
    const id = await port.createDrawing!(ANCHOR as never, 'Untitled drawing');

    const detail = await seam.entity(id as never);
    expect(detail?.kind).toBe('drawing');
    expect(detail?.content).toMatchObject({ kind: 'drawing', format: 'excalidraw', elements: [] });
    expect(detail?.state).toMatchObject({ kind: 'drawing', elementCount: 0 });
  });

  it('the ＋ menu offers New drawing, and clicking it creates once', async () => {
    const createDrawing = vi.fn().mockResolvedValue(undefined);
    stripWith(createDrawing);

    fireEvent.click(screen.getByTestId('attachment-add'));
    const item = await screen.findByTestId('attachment-new-drawing');
    fireEvent.click(item);

    await waitFor(() => expect(createDrawing).toHaveBeenCalledTimes(1));
    // The menu closes: leaving it open over a canvas that just opened would
    // hang a dead menu over the new entity.
    await waitFor(() => expect(screen.queryByTestId('attachment-new-drawing')).toBeNull());
  });

  it('draws NO New drawing item when the host cannot create one', async () => {
    // Same rule `startUpload` follows: a control that appears to create
    // something and cannot is worse than no control.
    stripWith(undefined);
    fireEvent.click(screen.getByTestId('attachment-add'));
    await waitFor(() => expect(screen.queryByTestId('attachment-file-input')).toBeTruthy());
    expect(screen.queryByTestId('attachment-new-drawing')).toBeNull();
  });
});
