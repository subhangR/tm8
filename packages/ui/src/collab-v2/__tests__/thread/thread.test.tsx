/**
 * The Thread against the seeded world — one component, four surfaces.
 *
 * The seed gives us exactly the shapes we need: #v2-build is a channel feed
 * with an embed, an agent report and a live read-mark, T-104 is a two-deep
 * comment thread, the spec doc has a margin note and Subhang's member wall has
 * a post. If the same component renders all four, the "one component" claim
 * holds. Unread counts are read from the seed, never hard-coded — the mock owns
 * that arithmetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Thread, ThreadGallery, discussionSlot } from '../../subsystems/thread';
import { EntityPanel } from '../../entity';
import type { MockFacade } from '../../mock';
import { createFacade, renderWith, resetStores } from './helpers';

let facade: MockFacade;

beforeEach(() => { resetStores(); facade = createFacade(); });
afterEach(() => { cleanup(); resetStores(); });

const messageRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-cv2-msg]'));

const composerInput = (): HTMLElement => screen.getByRole('textbox');

function typeInto(el: HTMLElement, value: string): void {
  fireEvent.change(el, { target: { value } });
}

async function renderThread(anchorId: string, props: Record<string, unknown> = {}) {
  const view = renderWith(facade, <Thread anchorId={anchorId} {...props} />);
  await waitFor(() => expect(messageRows().length).toBeGreaterThan(0));
  return view;
}

/** No DataTransfer-carrying drop helper exists in fireEvent; build the event. */
function fireDrop(target: HTMLElement, payload: unknown): void {
  const dataTransfer = {
    types: ['application/x-cv2-entity'],
    getData: (type: string) => (type === 'application/x-cv2-entity' ? JSON.stringify(payload) : ''),
    dropEffect: 'none',
  };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe('Thread — one component, four surfaces', () => {
  it('renders the channel feed variant', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });

    expect(await screen.findByText(/Kicking off the V2 build room/)).toBeTruthy();
    const thread = document.querySelector('[data-cv2-thread]') as HTMLElement;
    expect(thread.dataset.variant).toBe('feed');
    expect(messageRows()).toHaveLength(3);
  });

  it('renders task comments with the reply subtree', async () => {
    await renderThread(facade.ids.t104, { variant: 'comments' });

    expect(await screen.findByText(/Panel scaffolding in place/)).toBeTruthy();
    // root + reply + reply-of-reply; comment threads open by default
    await waitFor(() => expect(messageRows()).toHaveLength(3));
    expect(messageRows().map((el) => el.dataset.depth)).toEqual(['0', '1', '2']);
  });

  it('renders a doc margin thread and a member wall from the same component', async () => {
    const { unmount } = await renderThread(facade.ids.docSpec);
    expect(await screen.findByText(/two-signal staleness model/)).toBeTruthy();
    unmount();

    await renderThread(facade.ids.subhang);
    expect(await screen.findByText(/Welcome wall post/)).toBeTruthy();
  });

  it('shows an empty state for an anchor with no messages', async () => {
    renderWith(facade, <Thread anchorId={facade.ids.t101} emptyHint="Nothing here yet." />);
    expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
  });
});

describe('Thread — replies', () => {
  it('collapses and re-expands a reply subtree', async () => {
    await renderThread(facade.ids.t104);
    await waitFor(() => expect(messageRows()).toHaveLength(3));

    // the subtree toggle is the one button on the row that reports expansion
    fireEvent.click(within(messageRows()[0]).getByRole('button', { expanded: true }));
    await waitFor(() => expect(messageRows()).toHaveLength(1));

    fireEvent.click(within(messageRows()[0]).getByRole('button', { expanded: false }));
    await waitFor(() => expect(messageRows()).toHaveLength(3));
  });
});

describe('Thread — realtime', () => {
  it('appends a message that arrives on the event stream', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const before = messageRows().length;

    // someone else posts while we are watching
    await facade.postMessage({
      anchorId: facade.ids.chBuild,
      body: 'Scout here — review queue is clear.',
      actorId: facade.ids.scout,
    });

    await waitFor(() => expect(messageRows()).toHaveLength(before + 1));
    expect(screen.getByText(/review queue is clear/)).toBeTruthy();
  });

  it('reflects an edit made elsewhere without a refetch', async () => {
    await renderThread(facade.ids.docSpec);
    const note = await screen.findByText(/two-signal staleness model/);
    expect(note).toBeTruthy();

    const page = await facade.getMessages(facade.ids.docSpec);
    await facade.patchMessage(page.items[0].id, {
      body: 'Margin note rewritten in another tab.',
      actorId: facade.ids.mira,
    });

    expect(await screen.findByText('Margin note rewritten in another tab.')).toBeTruthy();
    expect(screen.queryByText(/two-signal staleness model/)).toBeNull();
  });
});

describe('Thread — entity-aware message bodies', () => {
  it('renders an {{embed:…}} token as a live Z2 card', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });

    const embed = await waitFor(() => {
      const el = document.querySelector('[data-embed-id]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // the id resolves through the entity layer into a real card, not a stub
    await waitFor(() => expect(embed.querySelector('.cv2-card')).not.toBeNull());
  });

  it('renders @mentions as chips even when not inline in the prose', async () => {
    await renderThread(facade.ids.t104);
    const mention = await waitFor(() => {
      const el = document.querySelector(`[data-mention-id="${facade.ids.forge}"]`);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await waitFor(() => expect(mention.textContent).toContain('Forge'));
  });

  it('renders attachments as entity chips', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const row = await screen.findByLabelText('Attachments');
    await waitFor(() => expect(row.textContent).toMatch(/wireframes/i));
  });

  it('badges agent messages but keeps them in flow', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const agentRows = messageRows().filter((el) => el.dataset.agent === 'true');
    expect(agentRows).toHaveLength(1);
    expect(within(agentRows[0]).getByText('AGENT')).toBeTruthy();
    // same parent chain as every other message: one list, no ghetto
    expect(agentRows[0].closest('.cv2-vlist')).toBe(messageRows()[0].closest('.cv2-vlist'));
  });
});

describe('Thread — unread', () => {
  it('draws the unread line before the first unread message', async () => {
    const channel = await facade.getEntity(facade.ids.chBuild);
    const seeded = (channel.state as { unreadCount: number }).unreadCount;
    expect(seeded).toBeGreaterThan(0);

    await renderThread(facade.ids.chBuild, { variant: 'feed', markReadOnView: false });

    const divider = await waitFor(() => {
      const el = document.querySelector('[data-cv2-unread]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(divider.textContent).toContain(`${seeded} new`);
    expect(screen.getByRole('button', { name: /jump to unread/i })).toBeTruthy();

    const rows = Array.from(document.querySelectorAll('[data-cv2-unread],[data-cv2-msg]'));
    const at = rows.indexOf(divider);
    expect((rows[at + 1] as HTMLElement).dataset.unread).toBe('true');
  });

  it('marks the anchor read on demand', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed', markReadOnView: false });
    await screen.findByRole('button', { name: /jump to unread/i });

    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(async () => {
      const channel = await facade.getEntity(facade.ids.chBuild);
      expect((channel.state as { unreadCount: number }).unreadCount).toBe(0);
    });
  });
});

describe('Thread — composing', () => {
  it('shows a pending row, then reconciles it into a real message', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const before = messageRows().length;

    typeInto(composerInput(), 'shipping the thread');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(messageRows()).toHaveLength(before + 1));
    expect(document.querySelector('[data-cv2-pending]')).toBeNull();
    expect(screen.getByText('shipping the thread')).toBeTruthy();
  });

  it('keeps a failed send on screen with its error code and a retry', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });

    facade.failNextWith(new Error('offline'));
    typeInto(composerInput(), 'this one fails');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const pending = await waitFor(() => {
      const el = document.querySelector('[data-cv2-pending]') as HTMLElement;
      expect(el?.dataset.failed).toBeTruthy();
      return el;
    });
    expect(within(pending).getByRole('alert').textContent).toContain('offline');

    fireEvent.click(within(pending).getByRole('button', { name: 'Retry sending' }));
    await waitFor(() => expect(document.querySelector('[data-cv2-pending]')).toBeNull());
    expect(screen.getByText('this one fails')).toBeTruthy();
  });

  it('drops an entity chip into the composer as a live embed', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const before = messageRows().length;

    typeInto(composerInput(), 'look at this');
    fireDrop(document.querySelector('[data-cv2-composer]') as HTMLElement, {
      entityId: facade.ids.t105, kind: 'task', title: 'T-105',
    });
    await waitFor(() => expect((composerInput() as HTMLTextAreaElement).value)
      .toContain(`{{embed:${facade.ids.t105}}}`));

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(messageRows()).toHaveLength(before + 1));

    const posted = messageRows()[messageRows().length - 1];
    await waitFor(() => expect(posted.querySelector(`[data-embed-id="${facade.ids.t105}"]`)).not.toBeNull());
  });

  it('stages a dropped file as an attachment rather than an embed', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });

    fireDrop(document.querySelector('[data-cv2-composer]') as HTMLElement, {
      entityId: facade.ids.fileWireframes, kind: 'file', title: 'panel-wireframes.png',
    });

    const staged = await screen.findByLabelText('Staged attachments');
    expect(staged).toBeTruthy();
    expect((composerInput() as HTMLTextAreaElement).value).not.toContain('{{embed:');
  });

  it('discovers any workspace entity and adds it as a live card without requiring prose', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const before = messageRows().length;

    fireEvent.click(screen.getByRole('button', { name: /add entity/i }));
    const picker = await screen.findByRole('dialog', { name: /add an entity/i });
    fireEvent.change(within(picker).getByRole('searchbox', { name: /find an entity/i }), {
      target: { value: 'T-105' },
    });
    const option = await waitFor(() => {
      const row = within(picker).getAllByRole('listitem')
        .find((item) => item.textContent?.includes('T-105'));
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    fireEvent.click(within(option).getByRole('button', { name: 'Add card' }));

    expect(await screen.findByLabelText('Staged entities')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(messageRows()).toHaveLength(before + 1));
    const posted = messageRows()[messageRows().length - 1];
    expect(posted.querySelector(`[data-embed-id="${facade.ids.t105}"] .cv2-card`)).not.toBeNull();
  });

  it('adds an entity as an inline reference from the same picker', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const before = messageRows().length;

    fireEvent.click(screen.getByRole('button', { name: /add entity/i }));
    const picker = await screen.findByRole('dialog', { name: /add an entity/i });
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'T-105' } });
    const option = await waitFor(() => within(picker).getAllByRole('listitem')
      .find((item) => item.textContent?.includes('T-105')) as HTMLElement);
    fireEvent.click(within(option).getByRole('button', { name: 'Reference' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(messageRows()).toHaveLength(before + 1));
    const posted = messageRows()[messageRows().length - 1];
    expect(posted.querySelector(`[data-ref-id="${facade.ids.t105}"]`)).not.toBeNull();
  });

  it('uploads a native image, attaches it to the channel, and stages the returned file entity', async () => {
    const uploadFile = vi.fn(async () => facade.getEntity(facade.ids.fileWireframes));
    Object.assign(facade, {
      uploadFile,
      fileDownloadUrl: (id: string) => `/v2/files/${id}/download`,
    });
    await renderThread(facade.ids.chBuild, { variant: 'feed' });

    const image = new File(['pixels'], 'proof.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose files to attach'), { target: { files: [image] } });

    const staged = await screen.findByLabelText('Staged attachments');
    expect(staged.textContent).toMatch(/wireframes/i);
    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: expect.any(String),
      file: image,
      targetIds: [facade.ids.chBuild],
    }));
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
  });

  it('posts a reply into the right subtree', async () => {
    await renderThread(facade.ids.t104);
    await waitFor(() => expect(messageRows()).toHaveLength(3));

    fireEvent.click(within(messageRows()[0]).getByRole('button', { name: 'Reply' }));
    expect(await screen.findByText(/Replying to Forge/)).toBeTruthy();

    typeInto(composerInput(), 'noted, thanks');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(messageRows()).toHaveLength(4));
    const added = messageRows().find((el) => el.textContent?.includes('noted, thanks'))!;
    expect(added.dataset.depth).toBe('1');
  });
});

describe('Thread — editing and deletion', () => {
  it('edits the viewer own message in place', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });

    const mine = messageRows().find((el) => el.textContent?.includes('Milestone board is live'))!;
    fireEvent.click(within(mine).getByRole('button', { name: 'Edit' }));

    typeInto(within(mine).getByLabelText('Edit message'), 'Milestone board moved to the graph view');
    fireEvent.click(within(mine).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Milestone board moved to the graph view/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.cv2-thread__edited')).not.toBeNull());
  });

  it('leaves a tombstone when a message with replies is deleted', async () => {
    await renderThread(facade.ids.t104);
    await waitFor(() => expect(messageRows()).toHaveLength(3));

    // the middle message is the viewer's, and a reply hangs off it
    const mine = messageRows().find((el) => el.textContent?.includes('keep the tab order identical'))!;
    fireEvent.click(within(mine).getByRole('button', { name: 'Delete' }));

    const tomb = await waitFor(() => {
      const el = document.querySelector('.cv2-thread__msg--tombstone');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(tomb.textContent).toMatch(/deleted/i);
    // history shape survives: the reply underneath is still readable
    expect(screen.getByText(/Ack — tab order stays universal/)).toBeTruthy();
  });

  it('offers no edit or delete on someone else message', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    const theirs = messageRows().find((el) => el.textContent?.includes('Kicking off the V2 build room'))!;
    expect(within(theirs).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(theirs).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(theirs).getByRole('button', { name: 'Reply' })).toBeTruthy();
  });
});

describe('Thread — reactions slot', () => {
  it('falls back to a counter readout and yields to an injected bar', async () => {
    await renderThread(facade.ids.chBuild, { variant: 'feed' });
    expect(document.querySelector('[data-slot="reactions"]')).not.toBeNull();
    cleanup();

    renderWith(facade, (
      <Thread anchorId={facade.ids.chBuild} variant="feed"
        reactionsSlot={(m) => <span data-test-bar={m.id}>bar</span>} />
    ));
    await waitFor(() => expect(document.querySelector('[data-test-bar]')).not.toBeNull());
    expect(document.querySelector('[data-slot="reactions"]')).toBeNull();
  });
});

describe('ThreadGallery — drivable standalone', () => {
  it('renders all four surfaces from one component against the mock', async () => {
    render(<div className="cv2-root"><ThreadGallery facade={facade} /></div>);

    for (const title of ['Channel feed', 'Task comments', 'Doc margin thread', 'Member wall']) {
      expect(await screen.findByText(title)).toBeTruthy();
    }
    await waitFor(() => expect(document.querySelectorAll('[data-cv2-thread]')).toHaveLength(4));
    const variants = Array.from(document.querySelectorAll<HTMLElement>('[data-cv2-thread]'))
      .map((el) => el.dataset.variant);
    expect(variants).toEqual(['feed', 'comments', 'comments', 'comments']);

    // every pane actually has content from the seed
    expect(await screen.findByText(/Kicking off the V2 build room/)).toBeTruthy();
    expect(await screen.findByText(/Panel scaffolding in place/)).toBeTruthy();
    expect(await screen.findByText(/two-signal staleness model/)).toBeTruthy();
    expect(await screen.findByText(/Welcome wall post/)).toBeTruthy();
  });
});

describe('Thread — panel Discussion slot', () => {
  it('fills the EntityPanel Discussion tab with comments for a task', async () => {
    const detail = await facade.getEntity(facade.ids.t104);
    renderWith(facade, (
      <EntityPanel entityId={detail.id} detail={detail} slots={{ discussion: discussionSlot() }} />
    ));

    fireEvent.click(screen.getByRole('tab', { name: 'Discussion' }));
    expect(await screen.findByText(/Panel scaffolding in place/)).toBeTruthy();
    expect((document.querySelector('[data-cv2-thread]') as HTMLElement).dataset.variant).toBe('comments');
  });

  it('gives a channel anchor the feed variant', async () => {
    const detail = await facade.getEntity(facade.ids.chBuild);
    renderWith(facade, (
      <EntityPanel entityId={detail.id} detail={detail} slots={{ discussion: discussionSlot() }} />
    ));

    fireEvent.click(screen.getByRole('tab', { name: 'Discussion' }));
    await waitFor(() => expect(document.querySelector('[data-cv2-thread]')).not.toBeNull());
    expect((document.querySelector('[data-cv2-thread]') as HTMLElement).dataset.variant).toBe('feed');
  });
});
