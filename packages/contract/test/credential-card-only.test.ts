/**
 * W10d a4 — export copies the credential CARD only.
 *
 * Every export path (entity get / context / feed, and anything built on them)
 * reads a credential through EntityState and EntityContent, and both share one
 * strict allow-list: provider, shape, visibility, status, owner. Nothing from
 * the side table — the sealed secret, its nonce or key version, the key hint,
 * the vendor login, the default flags — can pass either schema. A new field is
 * a deliberate edit to this pin, never a silent widening.
 */
import { describe, expect, it } from 'vitest';
import { EntityContentSchema, EntityStateSchema } from '../src/index.js';

const CARD = {
  kind: 'credential',
  provider: 'github',
  shape: 'token',
  visibility: 'private',
  status: 'active',
  ownerAccountId: 'acct-1',
} as const;

// The side-table columns (camel and snake) an export must never carry.
const SIDE_TABLE_FIELDS = [
  'secret', 'sealedSecret', 'sealed_secret', 'nonce', 'keyVersion', 'key_version',
  'keyHint', 'key_hint', 'displayLogin', 'display_login', 'isDefault', 'is_default',
  'mayBeSpaceDefault', 'may_be_space_default', 'spaceOwnedChosen', 'space_owned_chosen',
  'createdByAccountId', 'lastProbeAt', 'loginFile', 'oauth',
];

describe('W10d a4: a credential entity is its card only', () => {
  for (const [name, schema] of [['state', EntityStateSchema], ['content', EntityContentSchema]] as const) {
    it(`${name}: the card parses, and its keys are exactly the allow-list`, () => {
      const parsed = schema.parse(CARD) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(['kind', 'ownerAccountId', 'provider', 'shape', 'status', 'visibility']);
    });

    it(`${name}: every side-table field is refused`, () => {
      for (const field of SIDE_TABLE_FIELDS) {
        expect(schema.safeParse({ ...CARD, [field]: 'x' }).success, field).toBe(false);
      }
    });
  }
});
