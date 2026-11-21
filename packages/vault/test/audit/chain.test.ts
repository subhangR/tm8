import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  AuditChainError,
  auditBodyText,
  auditEntryHash,
  checkpointSigningInput,
  sealAuditEvent,
  verifyAuditRun,
  type AuditBody,
  type AuditEventRecord,
} from '../../src/index.js';
import { OWNER_ID, SPACE_A, T0 } from '../support/kit.js';

/**
 * The golden vectors were computed OUTSIDE this codebase, by Python's
 * hashlib and json.dumps(sort_keys=True, separators=(',', ':'),
 * ensure_ascii=False) applied to the documented formula. The Postgres append
 * must reproduce them byte for byte: if one changes, every stored chain breaks.
 */
const ITEM = '11111111-1111-4111-8111-111111111111';
const AGENT_SESSION = '22222222-2222-4222-8222-222222222222';
const AT_2 = '2026-11-20T12:00:01.250Z';

const BODY_1: AuditBody = {
  action: 'item.captured',
  actor: { kind: 'member', memberId: OWNER_ID, sessionId: null, name: 'Zoë Test' },
  itemId: ITEM,
  subjectMemberId: OWNER_ID,
  spaceId: SPACE_A,
  params: { type: 'login', fieldNames: ['username', 'password'], count: 2, devMode: false, note: null, ratio: 0.5 },
};
const TEXT_1 = '{"action":"item.captured","actor":{"kind":"member","memberId":"00000000-0000-4000-8000-0000000000a1","name":"Zoë Test","sessionId":null},"itemId":"11111111-1111-4111-8111-111111111111","params":{"count":2,"devMode":false,"fieldNames":["username","password"],"note":null,"ratio":0.5,"type":"login"},"spaceId":"0a000000-0000-4000-8000-00000000000a","subjectMemberId":"00000000-0000-4000-8000-0000000000a1"}';
const HASH_1 = 'eb3423d9681229df7da55989d2b82ddd32423ce4c2b4aeb52c40096b6ccb9ee5';

// A quote, a newline, a control character and an astral-plane character in one name.
const BODY_2: AuditBody = {
  action: 'fill.started',
  actor: { kind: 'agent', memberId: OWNER_ID, sessionId: AGENT_SESSION, name: 'Agent "q"\n\u0007 \u{1F6E1}' },
  itemId: ITEM,
  subjectMemberId: OWNER_ID,
  spaceId: SPACE_A,
  params: {},
};
const TEXT_2 = "{\"action\":\"fill.started\",\"actor\":{\"kind\":\"agent\",\"memberId\":\"00000000-0000-4000-8000-0000000000a1\",\"name\":\"Agent \\\"q\\\"\\n\\u0007 🛡\",\"sessionId\":\"22222222-2222-4222-8222-222222222222\"},\"itemId\":\"11111111-1111-4111-8111-111111111111\",\"params\":{},\"spaceId\":\"0a000000-0000-4000-8000-00000000000a\",\"subjectMemberId\":\"00000000-0000-4000-8000-0000000000a1\"}";
const HASH_2 = '4d5361f261c02655c7b8de4867809404b3378f98e81d435fa72d5f9de2da2abd';

const GENESIS = { seq: 0, hash: AUDIT_GENESIS_HASH } as const;

function body(n: number): AuditBody {
  return { action: 'session.refreshed', actor: { kind: 'member', memberId: OWNER_ID, sessionId: null, name: null }, itemId: null, subjectMemberId: OWNER_ID, spaceId: SPACE_A, params: { n } };
}

function chain(length: number): AuditEventRecord[] {
  const events: AuditEventRecord[] = [];
  for (let seq = 1; seq <= length; seq += 1) {
    const at = new Date(Date.parse(T0) + seq * 1000).toISOString();
    events.push(sealAuditEvent(body(seq), seq, events.at(-1)?.entryHash ?? AUDIT_GENESIS_HASH, at));
  }
  return events;
}

describe('audit chain', () => {
  it('starts from 64 zeros', () => {
    expect(AUDIT_GENESIS_HASH).toBe('0'.repeat(64));
  });

  it('reproduces the externally computed golden vectors exactly', () => {
    const first = sealAuditEvent(BODY_1, 1, AUDIT_GENESIS_HASH, T0);
    expect(first.bodyText).toBe(TEXT_1);
    expect(first.entryHash).toBe(HASH_1);
    expect(first).toMatchObject({ ...BODY_1, seq: 1, at: T0, prevHash: AUDIT_GENESIS_HASH });
    const second = sealAuditEvent(BODY_2, 2, HASH_1, AT_2);
    expect(second.bodyText).toBe(TEXT_2);
    expect(second.entryHash).toBe(HASH_2);
    expect(verifyAuditRun(GENESIS, [first, second])).toEqual({ ok: true, head: { seq: 2, hash: HASH_2 } });
  });

  it('matches the documented formula, computed here independently', () => {
    const text = auditBodyText(BODY_1);
    const expected = createHash('sha256').update(`tm8-vault-audit|v1|7|${HASH_2}|${AT_2}|${text}`, 'utf8').digest('hex');
    expect(auditEntryHash(7, HASH_2, AT_2, text)).toBe(expected);
  });

  it('hashes exactly the six body fields, in canonical order, whatever else the object carries', () => {
    const noisy = {
      params: BODY_1.params, spaceId: SPACE_A, subjectMemberId: OWNER_ID, itemId: ITEM,
      actor: { name: 'Zoë Test', sessionId: null, memberId: OWNER_ID, kind: 'member', extra: 'must-not-be-hashed' },
      action: 'item.captured', seq: 99, entryHash: 'f'.repeat(64), secretValue: 'must-not-be-hashed',
    } as unknown as AuditBody;
    expect(auditBodyText(noisy)).toBe(TEXT_1);
    const sealed = sealAuditEvent(noisy, 1, AUDIT_GENESIS_HASH, T0);
    expect(sealed.entryHash).toBe(HASH_1);
    expect(Object.keys(sealed).sort()).toEqual(['action', 'actor', 'at', 'bodyText', 'entryHash', 'itemId', 'params', 'prevHash', 'seq', 'spaceId', 'subjectMemberId']);
    expect(JSON.stringify(sealed)).not.toContain('must-not-be-hashed');
  });

  it('refuses a malformed seq, previous hash or time with its own error type', () => {
    for (const seq of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => auditEntryHash(seq, AUDIT_GENESIS_HASH, T0, '{}')).toThrow(AuditChainError);
    }
    for (const prev of ['0'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), '']) {
      expect(() => auditEntryHash(1, prev, T0, '{}')).toThrow(AuditChainError);
    }
    // 2026-13-01 matches the pattern but is an invalid Date: it must not escape as a RangeError.
    for (const at of ['2026-11-20T12:00:00Z', '2026-11-20T12:00:00.000+00:00', '2026-11-20 12:00:00.000Z', '2026-02-30T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-11-20T12:00:60.000Z']) {
      expect(() => sealAuditEvent(BODY_1, 1, AUDIT_GENESIS_HASH, at)).toThrow(AuditChainError);
    }
  });

  it('verifies a whole chain, a suffix from a cursor, and an empty run', () => {
    const events = chain(5);
    expect(verifyAuditRun(GENESIS, events)).toEqual({ ok: true, head: { seq: 5, hash: events[4]!.entryHash } });
    expect(verifyAuditRun({ seq: 2, hash: events[1]!.entryHash }, events.slice(2))).toEqual({ ok: true, head: { seq: 5, hash: events[4]!.entryHash } });
    expect(verifyAuditRun({ seq: 2, hash: events[0]!.entryHash }, events.slice(2))).toEqual({ ok: false, firstBrokenSeq: 3, head: { seq: 2, hash: events[0]!.entryHash } });
    expect(verifyAuditRun({ seq: 3, hash: events[2]!.entryHash }, [])).toEqual({ ok: true, head: { seq: 3, hash: events[2]!.entryHash } });
  });

  describe('finds every kind of edit at the first broken entry', () => {
    const cases: [string, (events: AuditEventRecord[]) => AuditEventRecord[], number][] = [
      ['an edited bodyText', (e) => replace(e, 2, { bodyText: e[2]!.bodyText.replace('"n":3', '"n":4') }), 3],
      ['an edited structured column', (e) => replace(e, 2, { params: { n: 4 } }), 3],
      ['an edited actor', (e) => replace(e, 1, { actor: { ...e[1]!.actor, kind: 'system' } }), 2],
      ['an edited time', (e) => replace(e, 3, { at: '2026-11-20T12:00:04.001Z' }), 4],
      ['an edited entry hash', (e) => replace(e, 3, { entryHash: 'f'.repeat(64) }), 4],
      ['a broken back-link', (e) => replace(e, 4, { prevHash: e[2]!.entryHash }), 5],
      ['a deleted entry', (e) => [...e.slice(0, 2), ...e.slice(3)], 3],
      ['two entries swapped', (e) => [e[0]!, e[2]!, e[1]!, e[3]!, e[4]!], 2],
      ['a renumbered entry', (e) => replace(e, 0, { seq: 2 }), 1],
    ];
    for (const [name, edit, broken] of cases) {
      it(name, () => {
        const events = chain(5);
        const result = verifyAuditRun(GENESIS, edit(events));
        expect(result).toEqual({ ok: false, firstBrokenSeq: broken, head: broken === 1 ? GENESIS : { seq: broken - 1, hash: events[broken - 2]!.entryHash } });
      });
    }
  });

  it('a forger who re-seals everything after an edit changes the head, so an anchored checkpoint still catches it', () => {
    const honest = chain(5);
    const forged = honest.slice(0, 2);
    for (let seq = 3; seq <= 5; seq += 1) {
      const original = honest[seq - 1]!;
      forged.push(sealAuditEvent(seq === 3 ? body(333) : original, seq, forged.at(-1)!.entryHash, original.at));
    }
    const result = verifyAuditRun(GENESIS, forged);
    expect(result.ok).toBe(true);
    expect(result.head.hash).not.toBe(honest[4]!.entryHash);
  });

  describe('checkpoint signing input', () => {
    it('is the exact documented bytes', () => {
      const input = checkpointSigningInput({ seq: 2, headHash: HASH_2, at: '2026-11-20T12:05:00.000Z', keyId: 'local-dev:audit-1' });
      expect(input.toString('utf8')).toBe(`tm8-vault-checkpoint|v1|2|${HASH_2}|2026-11-20T12:05:00.000Z|local-dev:audit-1`);
      expect(checkpointSigningInput({ seq: 0, headHash: AUDIT_GENESIS_HASH, at: T0, keyId: 'k' }).toString('utf8'))
        .toBe(`tm8-vault-checkpoint|v1|0|${AUDIT_GENESIS_HASH}|${T0}|k`);
    });

    it('refuses anything that could make two checkpoints share a signing input', () => {
      const ok = { seq: 1, headHash: HASH_1, at: T0, keyId: 'local-dev:audit-1' };
      for (const bad of [
        { seq: -1 }, { seq: 1.5 }, { seq: Number.NaN },
        { keyId: '' }, { keyId: 'a|b' }, { keyId: 'has space' }, { keyId: 'k'.repeat(201) }, { keyId: 'clé' },
        { headHash: 'F'.repeat(64) }, { at: '2026-13-01T00:00:00.000Z' }, { at: '2026-11-20T12:00:00Z' },
      ]) {
        expect(() => checkpointSigningInput({ ...ok, ...bad })).toThrow(AuditChainError);
      }
      expect(() => checkpointSigningInput({ ...ok, keyId: 'k'.repeat(200) })).not.toThrow();
    });
  });
});

function replace(events: AuditEventRecord[], index: number, patch: Partial<AuditEventRecord>): AuditEventRecord[] {
  return events.map((event, at) => (at === index ? { ...event, ...patch } : event));
}
