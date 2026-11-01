import type { GroupMemberIdentity } from '@tm8/contract';
import type { PersonRef } from './parse.js';

export interface RosterRow { external_id: string; alt_external_ids: string[]; display_name: string | null; muted: boolean; self?: boolean }

/** Normalize devices while retaining the identity domain. A LID is never a phone number. */
export function userJid(raw: string): string | null {
  const m = /^(\d{6,20})(?::\d+)?@(s\.whatsapp\.net|lid|c\.us)$/.exec(raw);
  return m ? `${m[1]}@${m[2] === 'c.us' ? 's.whatsapp.net' : m[2]}` : null;
}
export const idsOf = (r: RosterRow): string[] => [r.external_id, ...r.alt_external_ids].flatMap(j => userJid(j) ? [userJid(j)!] : []);
export const addressOf = (r: RosterRow): string => idsOf(r).find(j => j.endsWith('@s.whatsapp.net')) ?? r.external_id;
export const nameOf = (r: RosterRow): string => r.display_name || `…${r.external_id.replace(/@.*$/, '').slice(-4)}`;

/** Live metadata defines membership and aliases. Stored speakers supply labels and muted flags only. */
export function groupRoster(members: GroupMemberIdentity[], stored: RosterRow[], self: string[]): RosterRow[] {
  const rows: RosterRow[] = [];
  const own = self.flatMap(j => userJid(j) ? [userJid(j)!] : []);
  for (const member of [...members, { ids: own, name: null }]) {
    const ids = [...new Set(member.ids.flatMap(j => userJid(j) ? [userJid(j)!] : []))];
    if (!ids.length) continue;
    const overlaps = rows.filter(r => idsOf(r).some(j => ids.includes(j)));
    const all = [...new Set([...ids, ...overlaps.flatMap(idsOf)])];
    if (all.filter(j => j.endsWith('@s.whatsapp.net')).length > 1 || all.filter(j => j.endsWith('@lid')).length > 1) {
      throw new Error('Conflicting WhatsApp identity aliases; cannot safely resolve group members');
    }
    const known = stored.filter(r => idsOf(r).some(j => all.includes(j)));
    const address = all.find(j => j.endsWith('@s.whatsapp.net')) ?? all[0]!;
    for (const overlap of overlaps) rows.splice(rows.indexOf(overlap), 1);
    rows.push({ external_id: address, alt_external_ids: all.filter(j => j !== address),
      display_name: known.find(r => r.display_name)?.display_name ?? member.name ?? overlaps.find(r => r.display_name)?.display_name ?? null,
      muted: known.some(r => r.muted) || overlaps.some(r => r.muted), self: all.some(j => own.includes(j)) });
  }
  return rows;
}

export function resolveGroupPeople(roster: RosterRow[], refs: PersonRef[], mentions: string[] = []) {
  const jids = new Map<string, string>();
  const unknown: string[] = [];
  const add = (r: RosterRow) => { if (!r.self) jids.set(addressOf(r), nameOf(r)); };
  for (const ref of refs) {
    if (ref.kind === 'everyone') {
      roster.filter(r => !r.muted).forEach(add);
      continue;
    }
    let hits: RosterRow[];
    let label: string;
    if (ref.kind === 'phone') {
      const jid = `${ref.digits}@s.whatsapp.net`;
      hits = roster.filter(r => idsOf(r).includes(jid));
      if (!hits.length && ref.digits.length <= 15) { jids.set(jid, `+${ref.digits}`); continue; }
      label = `+${ref.digits}`;
    } else if (ref.kind === 'mention') {
      const native = [...new Set(mentions.flatMap(j => userJid(j) ? [userJid(j)!] : []))].filter(j => j.split('@')[0] === ref.digits);
      hits = roster.filter(r => idsOf(r).some(j => native.length ? native.includes(j) : j.split('@')[0] === ref.digits));
      label = `@${ref.digits}`;
    } else {
      const want = ref.text.toLowerCase();
      const exact = roster.filter(r => (r.display_name ?? '').toLowerCase() === want);
      hits = exact.length ? exact : roster.filter(r => (r.display_name ?? '').toLowerCase().startsWith(want));
      label = `"${ref.text}"`;
    }
    if (hits.length === 1) add(hits[0]!);
    else unknown.push(hits.length > 1 ? `${label} (several people)` : label);
  }
  return { jids, unknown };
}
