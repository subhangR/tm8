// @vitest-environment jsdom
/**
 * MESSAGE BODIES ARE MARKDOWN — the defect these pin.
 *
 * The feed drew every body as one plain paragraph, so an agent's report came
 * out as literal `##`, literal `**`, a table as a row of pipes and a code
 * fence as a run-on line. The body was markdown the whole time; only the
 * renderer disagreed.
 *
 * Two halves are tested here because the fix has two halves: the pure source
 * preparation (`chatMarkdownSource`, which owns mentions and line breaks) and
 * the rendered row (which must keep the mention CONTROL that the old
 * hand-rolled slicer gave us, and must not gain raw HTML on the way in).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FeedItem, Mention, MessageView } from '@tm8/contract';
import { FeedRowGroup } from './FeedRow';
import { chatMarkdownSource } from './feed-model';

const ANCHOR = 'ent-channel';

function msg(body: string, mentions: Mention[] = []): MessageView {
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
    content: { kind: 'message', body, mentions, attachments: [] },
    replyCount: 0,
  } as unknown as MessageView;
}

function renderBody(message: MessageView, onOpenEntity?: (id: string) => void) {
  const item = {
    itemId: `feed-${message.id}`,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['anchored'],
    actor: null,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
  } as unknown as FeedItem;
  return render(
    <ul>
      <FeedRowGroup
        group={{ kind: 'single', item }}
        anchorId={ANCHOR}
        handlers={onOpenEntity ? { onOpenEntity } : {}}
      />
    </ul>,
  );
}

const HAIKU: Mention = { entityId: 'ent-haiku', kind: 'team_member', display: 'Haiku 4.5' };

describe('chatMarkdownSource', () => {
  it('a canonical mention becomes a link carrying its entity id, and is reported inlined', () => {
    const { source, inlined } = chatMarkdownSource('ping @Haiku 4.5 please', [HAIKU]);
    expect(source).toBe('ping [@Haiku 4.5](#tm8-mention-ent-haiku) please  ');
    expect(inlined.has('team_member:ent-haiku')).toBe(true);
  });

  it('a mention the body never names is NOT inlined — it is left for the trailing chips', () => {
    const { source, inlined } = chatMarkdownSource('no token here', [HAIKU]);
    expect(source).toBe('no token here  ');
    expect(inlined.size).toBe(0);
  });

  it('a display name is a NAME — its markdown characters are escaped, never obeyed', () => {
    const under: Mention = { entityId: 'ent-x', kind: 'member', display: 'a_b_c' };
    const { source } = chatMarkdownSource('hi @a_b_c', [under]);
    expect(source).toContain('[@a\\_b\\_c](#tm8-mention-ent-x)');
  });

  it('inside a fenced block an @name is CODE — the fence keeps its bytes exactly', () => {
    const body = ['run it:', '```sh', 'ssh @Haiku 4.5   ', '```'].join('\n');
    const { source, inlined } = chatMarkdownSource(body, [HAIKU]);
    expect(source.split('\n')).toEqual(['run it:  ', '```sh', 'ssh @Haiku 4.5   ', '```']);
    expect(inlined.size).toBe(0);
  });

  it('a lone newline is a LINE BREAK — chat is written with Enter, not two spaces', () => {
    expect(chatMarkdownSource('one\ntwo', []).source).toBe('one  \ntwo  ');
    // A blank line stays blank: a hard break on nothing would be a stray break.
    expect(chatMarkdownSource('one\n\ntwo', []).source).toBe('one  \n\ntwo  ');
  });
});

describe('the feed renders a message body as markdown', () => {
  it('bold, a heading and a list are DRAWN, not printed as their source', () => {
    const { container } = renderBody(msg('## Status\n\n**done** and:\n\n- one\n- two'));
    expect(container.querySelector('.chs-text h2')?.textContent).toBe('Status');
    expect(container.querySelector('.chs-text strong')?.textContent).toBe('done');
    expect(container.querySelectorAll('.chs-text li')).toHaveLength(2);
    expect(container.textContent).not.toContain('**done**');
  });

  it('a fenced block renders as a real code box with its language named', () => {
    const { container } = renderBody(msg('```sql\nselect 1;\n```'));
    const fence = container.querySelector('.chs-text .md-fence');
    expect(fence?.getAttribute('data-lang')).toBe('sql');
    expect(fence?.querySelector('code')?.textContent).toBe('select 1;');
  });

  it('a GFM table becomes a table', () => {
    const { container } = renderBody(msg('| a | b |\n| --- | --- |\n| 1 | 2 |'));
    expect(container.querySelectorAll('.chs-text .md-table th')).toHaveLength(2);
  });

  it('RAW HTML IS NOT RENDERED — a message body is untrusted text other members read', () => {
    const { container } = renderBody(msg('hi <img src=x onerror="alert(1)"> there'));
    expect(container.querySelector('.chs-text img')).toBeNull();
    expect(container.textContent).toContain('onerror');
  });

  it('a mention survives as a CONTROL in place, and opens the entity', () => {
    const onOpenEntity = vi.fn();
    renderBody(msg('ping @Haiku 4.5 now', [HAIKU]), onOpenEntity);
    const button = screen.getByRole('button', { name: 'Open mention Haiku 4.5' });
    expect(button.className).toBe('chs-mention-inline');
    button.click();
    expect(onOpenEntity).toHaveBeenCalledWith('ent-haiku');
    // Inlined means inlined: no chip repeating the same mention underneath.
    expect(screen.queryByLabelText('Mentions')).toBeNull();
  });

  /**
   * WHY MENTIONS ARE RESOLVED IN THE SOURCE AND NOT IN THE OUTPUT.
   *
   * The obvious implementation slices the raw body at each mention's offsets
   * into a `ReactNode[]` and wraps the pieces — and it SEVERS every span that
   * straddles a mention, so `**bold @x more**` loses its emphasis and prints
   * its asterisks. Rewriting the mention into a markdown link before parsing
   * has no such seam: the link is an inline node inside the `strong`, and the
   * parser never sees a boundary at all. This pins that difference, because
   * the two approaches are indistinguishable on every body without one.
   */
  it('a mention INSIDE emphasis keeps both — the body is never cut at its offsets', () => {
    const { container } = renderBody(msg('**bold @Haiku 4.5 more**', [HAIKU]), vi.fn());
    const strong = container.querySelector('.chs-text strong');
    expect(strong?.querySelector('.chs-mention-inline')?.textContent).toBe('@Haiku 4.5');
    expect(strong?.textContent).toBe('bold @Haiku 4.5 more');
    expect(container.textContent).not.toContain('**');
  });

  it('a hand-written link that only LOOKS like a mention stays an ordinary link', () => {
    const { container } = renderBody(msg('[x](#tm8-mention-ent-nobody)', []));
    const link = container.querySelector('.chs-text a');
    expect(link?.className).toBe('md-link');
    expect(container.querySelector('.chs-mention-inline')).toBeNull();
  });
});
