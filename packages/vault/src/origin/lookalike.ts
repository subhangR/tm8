import { domainToUnicode } from 'node:url';

/**
 * Lookalike and confusable detection for NEW origin requests (acceptance test 4).
 *
 * Fill never needs this: it is exact-match only, so `githhub.com` simply has no
 * binding. This module protects the step where a binding is ADDED. An
 * agent-initiated `origins.request_add` with any finding is refused outright.
 * An owner adding the origin from the UI sees both exact origins and must type
 * the new one to confirm (see the approvals UI).
 *
 * Checks, all against the owner's existing bindings:
 * - confusable: the candidate's skeleton (TR39-style, compact table below)
 *   equals an existing host's skeleton while the strings differ, or a label
 *   mixes scripts, e.g. Latin with Cyrillic or Greek;
 * - lookalike: the registrable part is within Damerau-Levenshtein distance 2 of
 *   an existing one (`githhub.com`, `gtihub.com`), or embeds an existing brand
 *   label in a different site (`github-login.com`, `github.com.evil.io`).
 */
export type LookalikeKind = 'confusable' | 'mixed_script' | 'edit_distance' | 'brand_embedding';

export interface LookalikeFinding {
  kind: LookalikeKind;
  /** The existing bound origin it resembles. Absent for `mixed_script`, which needs no comparison. */
  similarTo?: string;
  distance?: number;
}

// Compact confusable table: characters that render like ASCII letters or digits.
const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'һ': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'ӏ': 'l', 'м': 'm', 'н': 'h',
  'о': 'o', 'р': 'p', 'с': 'c', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ү': 'y', 'ɡ': 'g',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  // Latin extended and fullwidth that commonly pass IDNA
  'ı': 'i', 'ȷ': 'j', 'ℓ': 'l', 'ß': 'ss', 'à': 'a', 'á': 'a', 'â': 'a', 'ä': 'a', 'å': 'a', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o', 'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
  'ñ': 'n', 'ç': 'c', 'ÿ': 'y', 'ý': 'y',
};

// ASCII sequences that read alike in common fonts. Applied after the table above.
const ASCII_SKELETON: [RegExp, string][] = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
  [/cl/g, 'd'],
  [/0/g, 'o'],
  [/[1|]/g, 'l'],
  [/i/g, 'l'],
  [/5/g, 's'],
];

const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in', 'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'com.cn', 'com.mx', 'co.nz', 'co.za', 'com.sg', 'com.tr', 'co.kr', 'com.hk', 'com.tw',
]);

/** Best-effort registrable domain without a full public suffix list. */
export function siteOf(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

function scriptOf(char: string): 'latin' | 'cyrillic' | 'greek' | 'other' | 'common' {
  if (/[a-z0-9-]/.test(char)) return char === '-' || /[0-9]/.test(char) ? 'common' : 'latin';
  if (/\p{Script=Latin}/u.test(char)) return 'latin';
  if (/\p{Script=Cyrillic}/u.test(char)) return 'cyrillic';
  if (/\p{Script=Greek}/u.test(char)) return 'greek';
  return 'other';
}

export function hasMixedScriptLabel(asciiHost: string): boolean {
  const unicode = domainToUnicode(asciiHost) || asciiHost;
  return unicode.split('.').some((label) => {
    const scripts = new Set([...label].map(scriptOf).filter((s) => s !== 'common'));
    return scripts.size > 1;
  });
}

export function skeleton(asciiHost: string): string {
  const unicode = (domainToUnicode(asciiHost) || asciiHost).normalize('NFKC').toLowerCase();
  let out = [...unicode].map((char) => CONFUSABLE[char] ?? char).join('');
  for (const [pattern, replacement] of ASCII_SKELETON) out = out.replace(pattern, replacement);
  return out;
}

/** Optimal-string-alignment Damerau-Levenshtein distance, capped for speed. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      let best = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = best;
    }
  }
  return Math.min((d[rows - 1] as number[])[cols - 1] as number, cap + 1);
}

function hostOfOrigin(origin: string): string {
  return new URL(origin).hostname;
}

/**
 * Compares a normalized candidate origin with the owner's existing bound
 * origins. An empty result means no resemblance was found. It does NOT mean
 * the origin is safe; the owner still approves it.
 */
export function assessLookalike(candidateOrigin: string, boundOrigins: readonly string[]): LookalikeFinding[] {
  const host = hostOfOrigin(candidateOrigin);
  const site = siteOf(host);
  const findings: LookalikeFinding[] = [];
  if (hasMixedScriptLabel(host)) {
    findings.push({ kind: 'mixed_script' });
  }
  const candidateSkeleton = skeleton(site);
  for (const bound of boundOrigins) {
    if (bound === candidateOrigin) continue;
    const boundHost = hostOfOrigin(bound);
    const boundSite = siteOf(boundHost);
    if (boundSite === site) continue; // same site, different subdomain: exact-origin rules already apply
    if (skeleton(boundSite) === candidateSkeleton) {
      findings.push({ kind: 'confusable', similarTo: bound });
      continue;
    }
    const distance = editDistance(boundSite, site, 2);
    if (distance <= 2 && Math.min(boundSite.length, site.length) >= 5) {
      findings.push({ kind: 'edit_distance', similarTo: bound, distance });
      continue;
    }
    const brand = boundSite.split('.')[0] ?? '';
    if (brand.length >= 4 && host.split(/[.-]/).includes(brand)) {
      findings.push({ kind: 'brand_embedding', similarTo: bound });
    }
  }
  return findings;
}
