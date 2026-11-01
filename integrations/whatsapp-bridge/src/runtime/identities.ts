// Identity operations never compare the numeric parts across PN and LID domains.
import { bareJid } from './allowlist.js'

export function userJid(raw: string): string | null {
  const jid = bareJid(raw)
  return /^\d{6,20}@(s\.whatsapp\.net|lid)$/.test(jid) ? jid : null
}

export function identityIds(p: { id: string; lid?: string; phoneNumber?: string }): string[] {
  return [...new Set([p.id, p.lid, p.phoneNumber].flatMap(j => j && userJid(j) ? [userJid(j)!] : []))]
}

export function preferredId(ids: string[]): string {
  return ids.find(j => j.endsWith('@s.whatsapp.net')) ?? ids[0]!
}

/** Overlapping authoritative alias sets describe one person; conflicting PN/LID pairs are refused. */
export function mergeIdentities<T extends { ids: string[] }>(rows: T[]): T[] {
  const out: T[] = []
  for (const row of rows) {
    const matches = out.filter(r => r.ids.some(id => row.ids.includes(id)))
    const ids = [...new Set([...row.ids, ...matches.flatMap(r => r.ids)])]
    if (ids.filter(j => j.endsWith('@s.whatsapp.net')).length > 1 || ids.filter(j => j.endsWith('@lid')).length > 1) {
      throw new Error('Conflicting WhatsApp identity aliases; cannot safely resolve group members')
    }
    if (matches.length) {
      const first = matches[0]!
      out[out.indexOf(first)] = { ...row, ...first, ids }
      for (const match of matches.slice(1)) out.splice(out.indexOf(match), 1)
    } else out.push({ ...row, ids })
  }
  return out
}
