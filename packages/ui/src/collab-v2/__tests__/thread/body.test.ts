/**
 * The message wire format: tokens in, segments out, and a composer round-trip
 * that survives edit → save → edit again.
 */
import { describe, expect, it } from 'vitest';
import {
  appendEmbed, draftFromMarkup, embedIdsIn, embedToken, markupFromBody,
  parseBody, refToken, stripTokens,
} from '../../subsystems/thread/body';
import type { Mention } from '../../types/contract';

const FORGE: Mention = { entityId: 'tm_forge', kind: 'team_member', display: 'Forge' };
const MIRA: Mention = { entityId: 'mem_mira', kind: 'member', display: 'Mira' };

describe('message body tokens', () => {
  it('splits embeds, refs and mentions out of prose', () => {
    const body = `Hey @Forge, see ${refToken('t_103')} — board: ${embedToken('t_100')}`;
    const segs = parseBody(body, [FORGE]);

    expect(segs.map((s) => s.type)).toEqual(['text', 'mention', 'text', 'ref', 'text', 'embed']);
    expect(segs[1]).toMatchObject({ entityId: 'tm_forge', kind: 'team_member' });
    expect(segs[3]).toMatchObject({ entityId: 't_103' });
    expect(segs[5]).toMatchObject({ entityId: 't_100' });
  });

  it('prefers the longest matching display name', () => {
    const long: Mention = { entityId: 'mem_1', kind: 'member', display: 'Mira Chen' };
    const segs = parseBody('ping @Mira Chen now', [MIRA, long]);
    const mention = segs.find((s) => s.type === 'mention');
    expect(mention).toMatchObject({ entityId: 'mem_1', display: 'Mira Chen' });
  });

  it('leaves prose alone when there are no mentions', () => {
    expect(parseBody('an @unknown handle', [])).toEqual([{ type: 'text', text: 'an @unknown handle' }]);
  });

  it('lists embedded ids and strips tokens for previews', () => {
    const body = `a ${embedToken('t_1')} b ${refToken('d_2')} c ${embedToken('t_3')}`;
    expect(embedIdsIn(body)).toEqual(['t_1', 't_3']);
    expect(stripTokens(body)).toBe('a b c');
  });

  it('appends an embed exactly once', () => {
    const first = appendEmbed('look at this', 't_9');
    expect(first).toBe(`look at this ${embedToken('t_9')}`);
    expect(appendEmbed(first, 't_9')).toBe(first);
    expect(appendEmbed('   ', 't_9')).toBe(embedToken('t_9'));
  });

  it('converts composer markup into a body plus typed mentions', () => {
    const markup = `ok @[Forge](tm_forge) look at #[T-103](t_103) ${embedToken('t_100')}`;
    const { body, mentions } = draftFromMarkup(markup, (id) => (id.startsWith('tm_') ? 'team_member' : 'member'));

    expect(body).toBe(`ok @Forge look at ${refToken('t_103')} ${embedToken('t_100')}`);
    expect(mentions).toEqual([{ entityId: 'tm_forge', kind: 'team_member', display: 'Forge' }]);
  });

  it('round-trips a body back through the composer unchanged', () => {
    const body = `ping @Mira about ${refToken('d_1')} ${embedToken('t_2')}`;
    const markup = markupFromBody(body, [MIRA]);
    expect(markup).toContain('@[Mira](mem_mira)');

    const back = draftFromMarkup(markup, () => 'member');
    expect(back.body).toBe(body);
    expect(back.mentions).toEqual([MIRA]);
  });

  it('does not duplicate a mention repeated in the text', () => {
    const { mentions } = draftFromMarkup('@[Forge](tm_forge) and again @[Forge](tm_forge)');
    expect(mentions).toHaveLength(1);
  });
});
