// @vitest-environment jsdom
/**
 * THE FEED'S HALF OF THE SAME FIX.
 *
 * This surface DID render a message's attachments — as a name-and-mime chip
 * and nothing else, so an uploaded screenshot was never a picture here either.
 * Both chat surfaces now draw one shared component (`files/MessageAttachments`),
 * which is the point of these cases: if the feed ever forks its own copy
 * again, the thumbnail lands on one surface and not the other, and that is
 * precisely the split this replaced.
 *
 * The no-resolver case is the load-bearing one for THIS surface. A host with
 * no files seam (and every test in this directory) passes no `downloadHref`,
 * and must keep rendering exactly the chip it always did — never an `<img>`
 * whose src the component invented.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { FeedItem, FileAttachment, MessageView } from '@tm8/contract';
import { FeedRowGroup, type FeedRowHandlers } from './FeedRow';

const ANCHOR = 'ent-channel';
const PNG: FileAttachment = {
  fileEntityId: 'ent-file-png' as FileAttachment['fileEntityId'],
  name: 'screenshot.png',
  mime: 'image/png',
};
const PDF: FileAttachment = {
  fileEntityId: 'ent-file-pdf' as FileAttachment['fileEntityId'],
  name: 'spec.pdf',
  mime: 'application/pdf',
};
/* An SVG is a script-bearing document; the node refuses to serve one inline
   (`server/src/.../files.ts` Content-Disposition rule) and so must never reach
   an `<img src>` from the app origin. See `files/AttachmentStrip`'s header. */
const SVG: FileAttachment = {
  fileEntityId: 'ent-file-svg' as FileAttachment['fileEntityId'],
  name: 'diagram.svg',
  mime: 'image/svg+xml',
};

function msg(attachments: FileAttachment[]): MessageView {
  return {
    id: 'msg-1',
    kind: 'message',
    title: '',
    spaceId: 'sp-1',
    parentId: null,
    createdAt: '2026-08-07T11:24:00.000Z',
    updatedAt: '2026-08-07T11:24:00.000Z',
    deletedAt: null,
    version: 1,
    createdBy: { id: 'act-1', displayName: 'alex', isAgent: false },
    state: {
      kind: 'message',
      anchorId: ANCHOR,
      author: { id: 'act-1', displayName: 'alex', isAgent: false },
      messageBatchId: null,
    },
    content: { kind: 'message', body: 'have a look', mentions: [], attachments },
    replyCount: 0,
  } as unknown as MessageView;
}

function renderRow(attachments: FileAttachment[], handlers: FeedRowHandlers = {}) {
  const item = {
    itemId: 'feed-msg-1',
    createdAt: '2026-08-07T11:24:00.000Z',
    sortId: '2026-08-07T11:24:00.000Z#msg-1',
    via: ['anchored'],
    actor: null,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message: msg(attachments),
    delivery: [],
  } as unknown as FeedItem;
  return render(
    <ul>
      <FeedRowGroup group={{ kind: 'single', item }} anchorId={ANCHOR} handlers={handlers} />
    </ul>,
  );
}

const href = (id: string) => `/v2/files/${id}/download`;

describe('feed message attachments', () => {
  it('renders an image inline once the host supplies a bytes resolver', () => {
    const view = renderRow([PNG, PDF], { downloadHref: href });
    const row = view.getByTestId('chs-message-attachments');
    const image = row.querySelector('img');
    expect(image?.getAttribute('src')).toBe(href('ent-file-png'));
    expect(image?.getAttribute('alt')).toBe('screenshot.png');
    expect(image?.getAttribute('loading')).toBe('lazy');
    // The PDF is still a chip: one image on the row, not one per attachment.
    expect(row.querySelectorAll('img')).toHaveLength(1);
    expect(row.textContent).toContain('spec.pdf');
  });

  it('never puts an SVG in an <img>, resolver or not', () => {
    const row = renderRow([SVG], { downloadHref: href }).getByTestId('chs-message-attachments');
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('diagram.svg');
  });

  it('keeps the chip a host with no files seam always drew', () => {
    const row = renderRow([PNG, PDF]).getByTestId('chs-message-attachments');
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('screenshot.png');
    expect(row.textContent).toContain('image/png');
  });

  it('opens the file entity from either face', () => {
    const onOpenEntity = vi.fn();
    const row = renderRow([PNG, PDF], { downloadHref: href, onOpenEntity })
      .getByTestId('chs-message-attachments');
    (row.querySelector('button[aria-label="Open attachment screenshot.png"]') as HTMLButtonElement).click();
    (row.querySelector('button[aria-label="Open attachment spec.pdf"]') as HTMLButtonElement).click();
    expect(onOpenEntity.mock.calls.map(([id]) => id)).toEqual(['ent-file-png', 'ent-file-pdf']);
  });

  it('draws nothing at all for a message with no attachments', () => {
    expect(renderRow([]).queryByTestId('chs-message-attachments')).toBeNull();
  });
});
