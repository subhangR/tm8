import { describe, expect, it } from 'vitest';
import { groupRoster, resolveGroupPeople } from '../../src/bridges/commands/people.js';
import { parsePeople } from '../../src/bridges/commands/parse.js';

const pn = '919000000001@s.whatsapp.net', lid = '188888888888881@lid';
const self = '919000000999@s.whatsapp.net', selfLid = '188888888888899@lid';
const quiet = '188888888888882@lid';
const resolve = (text: string, mentions: string[] = []) => resolveGroupPeople(groupRoster([
  { ids: [pn, lid], name: 'Maya' }, { ids: [quiet], name: 'Quiet' }, { ids: [self, selfLid], name: 'tm8' },
], [], [self, selfLid]), parsePeople(text), mentions);

describe('group identity resolution', () => {
  it('preserves a native LID for a member who never spoke', () => {
    expect([...resolve('@188888888888882', [quiet]).jids]).toEqual([[quiet, 'Quiet']]);
  });
  it('resolves aliases once and excludes both own identities', () => {
    expect([...resolve('@188888888888881, +919000000001, everyone, @188888888888899, +919000000999').jids.keys()]).toEqual([pn, quiet]);
  });
  it('refuses an unresolved mention and never fabricates a phone', () => {
    expect(resolve('@199999999999999', ['199999999999999@lid'])).toMatchObject({ unknown: ['@199999999999999'], jids: new Map() });
  });
  it('keeps explicit phones distinct from equal LID digits', () => {
    expect([...resolve('+188888888888882').jids.keys()]).toEqual(['188888888888882@s.whatsapp.net']);
  });
  it('uses native domains to disambiguate equal digits, refusing an ambiguous text mention', () => {
    const roster = groupRoster([{ ids: ['919000000001@lid'], name: 'LID' }, { ids: [pn], name: 'PN' }], [], []);
    expect(resolveGroupPeople(roster, parsePeople('@919000000001')).unknown).toEqual(['@919000000001 (several people)']);
    expect([...resolveGroupPeople(roster, parsePeople('@919000000001'), ['919000000001@lid']).jids.keys()]).toEqual(['919000000001@lid']);
  });
  it('requires exact native identity presence and does not fall back to an equal phone', () => {
    const roster = groupRoster([{ ids: [pn], name: 'PN' }], [], []);
    expect(resolveGroupPeople(roster, parsePeople('@919000000001'), ['919000000001@lid']).unknown).toEqual(['@919000000001']);
  });
  it('normalizes device aliases and preserves muted labels without trusting stale membership', () => {
    const roster = groupRoster([{ ids: [pn, '188888888888881:4@lid'], name: null }, { ids: [quiet], name: null }], [
      { external_id: lid, alt_external_ids: [pn], display_name: 'Maya', muted: true },
      { external_id: '919000000007@s.whatsapp.net', alt_external_ids: [], display_name: 'Left', muted: false },
    ], []);
    expect([...resolveGroupPeople(roster, parsePeople('everyone')).jids.keys()]).toEqual([quiet]);
    expect([...resolveGroupPeople(roster, parsePeople('Maya')).jids]).toEqual([[pn, 'Maya']]);
    expect(resolveGroupPeople(roster, parsePeople('Left')).unknown).toEqual(['"Left"']);
  });
  it('refuses conflicting authoritative PN/LID mappings', () => {
    expect(() => groupRoster([{ ids: [pn, lid], name: null }, { ids: ['919000000002@s.whatsapp.net', lid], name: null }], [], [])).toThrow(/Conflicting/);
  });
});
