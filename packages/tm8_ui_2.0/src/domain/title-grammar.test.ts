import { describe, expect, it } from 'vitest';
import { allKinds } from './registry';
import { placeholderNameFor, slugifyTitle, titleNormalizerFor } from './title-grammar';
import { placeholderTitleFor } from '../authoring/commands';

/**
 * THE ORACLE IS THE DATABASE, restated here as the one thing this lane may not
 * get wrong: `channels.name`'s check constraint, `001_core_graph.sql:503` and
 * `053_voice_channels.sql:61`, byte for byte.
 *
 * It is duplicated rather than imported because nothing exports it — the
 * grammar lives in SQL, and the whole defect this file guards was the server
 * comment at `facade/handlers/entities.ts:555` ASSUMING what the SQL did
 * ("lowercases and trims … so the title travels through as-is") instead of
 * checking. A copy that is asserted against is honest; an assumption is not.
 */
const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;

describe('slugifyTitle', () => {
  it('turns the names a person actually types into legal ones', () => {
    expect(slugifyTitle('Design Review')).toBe('design-review');
    expect(slugifyTitle('Untitled channel')).toBe('untitled-channel');
  });

  /**
   * THE CASE THAT SHIPPED THE BUG. `create_channel` does `lower(btrim(p_name))`
   * — case and edges, never the interior space. Every title below is one the
   * old path sent straight to Postgres and got an opaque `invariant_violation`
   * for, which the user experienced as "I press save and nothing happens".
   */
  it.each([
    'Design Review',
    'Untitled channel',
    '  leading and trailing  ',
    'Q3 Planning!!',
    '#general',
    '...dots first',
    'Ünïcödé room',
    'a'.repeat(200),
  ])('coerces %j into the grammar the server enforces', (raw) => {
    expect(slugifyTitle(raw)).toMatch(CHANNEL_NAME);
  });

  it('does not fight the typist mid-word — a trailing dash is legal', () => {
    // "design " on the way to "design review": the caret must not jump and the
    // partial must still be a legal name, or every keystroke is a refusal.
    expect(slugifyTitle('design ')).toBe('design-');
    expect(slugifyTitle('design ')).toMatch(CHANNEL_NAME);
  });

  it('drops leading punctuation rather than turning it into a dash to delete', () => {
    expect(slugifyTitle('#general')).toBe('general');
  });
});

describe('titleNormalizerFor', () => {
  it('leaves free-text kinds exactly as typed', () => {
    const asTyped = titleNormalizerFor({ titleGrammar: undefined });
    expect(asTyped('Ship the Q3 plan')).toBe('Ship the Q3 plan');
  });

  /**
   * PARAMETERISED BY THE THING THAT VARIES, which is the lesson the previous
   * fix was written to record: the authoring suite only ever stood on `task`,
   * so the kind it sent was accidentally right in the tests and wrong in the
   * product. Driving this off `allKinds()` means a kind added with
   * `titleGrammar: 'slug'` tomorrow is covered without anyone remembering to.
   */
  const slugKinds = allKinds().filter((config) => config.titleGrammar === 'slug');

  it('finds the slug kinds at all — an empty filter would pass every case below', () => {
    expect(slugKinds.length).toBeGreaterThan(0);
  });

  it.each(slugKinds.map((config) => [config.kind, config] as const))(
    'the create placeholder for %s is a name the server will accept',
    (_kind, config) => {
      const placeholder = placeholderNameFor(config, placeholderTitleFor(config.label));
      expect(placeholder).toMatch(CHANNEL_NAME);
    },
  );

  /**
   * `channels_space_id_name_key`. The oracle commits a placeholder BEFORE the
   * user types, so a repeated placeholder means the second `＋ New channel` in
   * a space is refused as a duplicate key — the original symptom, returning by
   * a different door. Asserted over many draws rather than two, because a
   * collision is the kind of thing one lucky pair of samples hides.
   */
  it.each(slugKinds.map((config) => [config.kind, config] as const))(
    'the create placeholder for %s is unique per press',
    (_kind, config) => {
      const drawn = new Set(
        Array.from({ length: 200 }, () =>
          placeholderNameFor(config, placeholderTitleFor(config.label)),
        ),
      );
      expect(drawn.size).toBe(200);
    },
  );

  it('leaves a free-text kind placeholder alone — no suffix where none is needed', () => {
    const task = allKinds().find((config) => config.titleGrammar === undefined);
    expect(task).toBeDefined();
    expect(placeholderNameFor(task!, placeholderTitleFor(task!.label))).toBe(
      placeholderTitleFor(task!.label),
    );
  });

  it('keeps a disambiguated placeholder inside the 80-character limit', () => {
    const long = { titleGrammar: 'slug' as const };
    expect(placeholderNameFor(long, 'x'.repeat(200))).toMatch(CHANNEL_NAME);
  });
});
