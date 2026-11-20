import type { PasteDetector, PasteFinding, PasteKind, TokenSpanScanner } from '../types.js';

// Bounded provider patterns run in overlapping UTF-16 windows. The overlap is
// larger than the longest provider match. Unbounded lexical runs and PEM blocks
// have separate forward-only passes, so window edges never truncate a finding.
// Even all three-byte UTF-8 code units fit below the 1 MiB input threshold.
const WINDOW = 256 * 1024;
const OVERLAP = 4096;
const WORD = '[A-Za-z0-9_-]';
const PROVIDERS: readonly [PasteKind, string][] = [
  ['github_token', '(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})'],
  ['gitlab_token', 'glpat-[A-Za-z0-9_-]{20,64}'],
  ['anthropic_key', 'sk-ant-[A-Za-z0-9_-]{20,256}'],
  ['openai_key', 'sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,256}'],
  ['aws_access_key', '(?:AKIA|ASIA)[A-Z0-9]{16}'],
  ['google_api_key', 'AIza[A-Za-z0-9_-]{35}'],
  ['slack_token', 'xox[abpsr]-[A-Za-z0-9-]{10,256}'],
  ['slack_token', 'https://hooks\\.slack\\.com/services/[A-Za-z0-9]{8,32}/[A-Za-z0-9]{8,32}/[A-Za-z0-9]{16,64}'],
  ['stripe_key', '(?:sk_live_|rk_live_|sk_test_)[A-Za-z0-9]{24,128}'],
  ['twilio_key', 'SK[0-9a-fA-F]{32}'],
  // identity/crypto.ts: random 32-byte base64url secret; ids minted as UUIDs.
  ['tm8_token', 'tm8[sm]_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.[A-Za-z0-9_-]{43}'],
  // identity/pg-auth.ts: node-claim tokens use the same secret generator.
  ['tm8_token', 'tm8c_[A-Za-z0-9_-]{43}'],
];

function providers(text: string, add: (kind: PasteKind, start: number, end: number, confidence?: 'high' | 'medium') => void): void {
  for (let offset = 0; offset < text.length; offset += WINDOW - OVERLAP) {
    const end = Math.min(offset + WINDOW, text.length);
    const part = text.slice(offset, end);
    for (const [kind, source] of PROVIDERS) {
      const pattern = new RegExp(`(?<!${WORD})${source}(?!${WORD})`, 'g');
      for (const match of part.matchAll(pattern)) {
        const start = offset + match.index;
        const stop = start + match[0].length;
        // Check the original input too: a window boundary is not a delimiter.
        if (start > 0 && /[A-Za-z0-9_-]/.test(text[start - 1]!)) continue;
        if (stop < text.length && /[A-Za-z0-9_-]/.test(text[stop]!)) continue;
        add(kind, start, stop);
      }
    }
    if (end === text.length) break;
  }
}

function privateKeys(text: string, add: (kind: PasteKind, start: number, end: number) => void): void {
  const markers = /-----(BEGIN|END) ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----/g;
  let opening: { start: number; body: number; label: string } | undefined;
  for (const match of text.matchAll(markers)) {
    if (match[1] === 'BEGIN') {
      opening = { start: match.index, body: match.index + match[0].length, label: match[2]! };
    } else if (opening && opening.label === match[2]) {
      const body = text.slice(opening.body, match.index);
      if (body.replace(/\s/g, '').length >= 16 && /^[A-Za-z0-9+/=\r\n\t ]+$/.test(body)) {
        add('private_key', opening.start, match.index + match[0].length);
      }
      opening = undefined;
    }
  }
}

interface Span { start: number; end: number }

function urls(text: string, add: (kind: PasteKind, start: number, end: number) => void): Span[] {
  const excluded: Span[] = [];
  const starts = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/|data:/gi;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(text)) !== null) {
    const rest = /[^\s"'<>`]+/y;
    rest.lastIndex = starts.lastIndex;
    const tail = rest.exec(text);
    const end = tail ? rest.lastIndex : starts.lastIndex;
    const raw = text.slice(match.index, end);
    if (!raw.toLowerCase().startsWith('data:')) {
      try {
        const parsed = new URL(raw);
        if (parsed.username !== '' && parsed.password !== '') add('connection_string', match.index, end);
      } catch { /* Unparseable URLs still are not entropy evidence. */ }
    }
    excluded.push({ start: match.index, end });
    starts.lastIndex = end;
  }
  return excluded;
}

function isJwt(token: string): boolean {
  const first = token.indexOf('.');
  if (first < 2 || first > 4096) return false;
  const second = token.indexOf('.', first + 1);
  if (second <= first + 1 || second === token.length - 1 || token.indexOf('.', second + 1) !== -1) return false;
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) return false;
  try {
    const encoded = token.slice(0, first);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return false;
    const header: unknown = JSON.parse(bytes.toString('utf8'));
    return header !== null && typeof header === 'object' && !Array.isArray(header) && Object.hasOwn(header, 'alg');
  } catch { return false; }
}

function entropy(token: string): number {
  const counts = new Uint32Array(128);
  for (let i = 0; i < token.length; i += 1) counts[token.charCodeAt(i)]! += 1;
  let result = 0;
  for (const count of counts) {
    if (count !== 0) {
      const probability = count / token.length;
      result -= probability * Math.log2(probability);
    }
  }
  return result;
}

function knownIin(digits: string): boolean {
  const length = digits.length;
  const two = Number(digits.slice(0, 2));
  const three = Number(digits.slice(0, 3));
  const four = Number(digits.slice(0, 4));
  const six = Number(digits.slice(0, 6));
  return (digits[0] === '4' && [13, 16, 19].includes(length))
    || (length === 16 && ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)))
    || (length === 15 && (two === 34 || two === 37))
    || ([16, 19].includes(length) && (four === 6011 || two === 65 || (three >= 644 && three <= 649) || (six >= 622126 && six <= 622925)))
    || (length >= 16 && length <= 19 && four >= 3528 && four <= 3589)
    || (length === 14 && ((three >= 300 && three <= 305) || [36, 38, 39].includes(two)))
    || (length >= 16 && length <= 19 && two === 62);
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 1, position = 0; i >= 0; i -= 1, position += 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (position % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

function merge(findings: PasteFinding[]): PasteFinding[] {
  findings.sort((a, b) => a.start - b.start || b.end - a.end
    || Number(a.kind === 'high_entropy') - Number(b.kind === 'high_entropy'));
  const merged: PasteFinding[] = [];
  let current: PasteFinding | undefined;
  let winner: PasteFinding | undefined;
  for (const next of findings) {
    if (!current || next.start >= current.end) {
      current = { ...next };
      winner = next;
      merged.push(current);
    } else {
      if ((winner!.confidence === 'medium' && next.confidence === 'high')
        || (winner!.confidence === next.confidence && next.end - next.start > winner!.end - winner!.start)) winner = next;
      current.end = Math.max(current.end, next.end);
      current.kind = winner!.kind;
      current.confidence = winner!.confidence;
    }
  }
  return merged;
}

export function createPasteDetector(): PasteDetector {
  return {
    scan(text) {
      const findings: PasteFinding[] = [];
      const add = (kind: PasteKind, start: number, end: number, confidence: 'high' | 'medium' = 'high') => {
        findings.push({ kind, start, end, confidence });
      };
      providers(text, add);
      privateKeys(text, add);
      const excluded = urls(text, add);
      for (const match of text.matchAll(/[A-Za-z0-9_.-]+/g)) {
        let first = 0;
        let last = match[0].length;
        while (first < last && match[0][first] === '.') first += 1;
        while (last > first && match[0][last - 1] === '.') last -= 1;
        if (isJwt(match[0].slice(first, last))) add('jwt', match.index + first, match.index + last);
      }
      let exclusion = 0;
      for (const match of text.matchAll(/[A-Za-z0-9_+/\-]+={0,2}/g)) {
        const token = match[0];
        const start = match.index;
        const end = start + token.length;
        if (token.length < 20) continue;
        while (excluded[exclusion] && excluded[exclusion]!.end <= start) exclusion += 1;
        if (excluded[exclusion] && excluded[exclusion]!.start < end) continue;
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) continue;
        if ((token.length === 40 || token.length === 64) && /^[0-9a-f]+$/i.test(token)
          && /commit|sha(?:1|256|512)?|hash|digest/i.test(text.slice(Math.max(0, start - 48), Math.min(text.length, end + 48)))) continue;
        if (entropy(token) >= 4.2) add('high_entropy', start, end, 'medium');
      }
      const access = findings.filter((finding) => finding.kind === 'aws_access_key').sort((a, b) => a.start - b.start);
      let near = 0;
      for (const match of text.matchAll(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g)) {
        while (access[near] && access[near]!.end < match.index - 256) near += 1;
        if (access[near] && access[near]!.start <= match.index + 296) add('aws_secret_key', match.index, match.index + 40, 'medium');
      }
      const assignments = /(?<![A-Za-z0-9_])["']?([A-Za-z_][A-Za-z0-9_.-]{0,127})["']?[ \t]{0,32}(?:[:=]|\bis\b)[ \t]{0,32}/gi;
      let assignment: RegExpExecArray | null;
      while ((assignment = assignments.exec(text)) !== null) {
        const key = assignment[1]!.toLowerCase();
        const password = /(?:^|[_.-])(?:password|passwd|pwd|passphrase)$/.test(key);
        if (!password && !/(?:^|[_.-])(?:api[_.-]?key|secret|token|access[_.-]?key|private[_.-]?key)(?:$|[_.-])/.test(key)) continue;
        let start = assignments.lastIndex;
        let end = start;
        const quote = text[start] === '"' || text[start] === "'" ? text[start++] : undefined;
        end = start;
        while (end < text.length) {
          const ch = text[end]!;
          if (quote ? ch === quote || ch === '\n' || ch === '\r' : /[\s,;"'<>`]/.test(ch)) break;
          if (quote && ch === '\\' && end + 1 < text.length) end += 1;
          end += 1;
        }
        if (end > start) add(password ? 'password_assignment' : 'generic_secret_assignment', start, end, 'medium');
        assignments.lastIndex = Math.max(assignments.lastIndex, end + (quote && text[end] === quote ? 1 : 0));
      }
      for (const match of text.matchAll(/[0-9][0-9 -]*/g)) {
        let length = match[0].length;
        while (length > 0 && (match[0][length - 1] === ' ' || match[0][length - 1] === '-')) length -= 1;
        const raw = match[0].slice(0, length);
        if (raw.length > 64) continue;
        const digits = raw.replace(/[ -]/g, '');
        if (knownIin(digits) && luhn(digits)) add('card_number', match.index, match.index + raw.length);
      }
      const merged = merge(findings);
      const parts: string[] = [];
      let cursor = 0;
      for (const finding of merged) {
        parts.push(text.slice(cursor, finding.start), `[redacted:${finding.kind}]`);
        cursor = finding.end;
      }
      parts.push(text.slice(cursor));
      return { findings: merged, redacted: parts.join('') };
    },
  };
}

export function tokenSpanScanner(detector: PasteDetector): TokenSpanScanner {
  return (text) => detector.scan(text).findings
    .filter((finding) => finding.confidence === 'high')
    .map(({ start, end }) => ({ start, end }));
}
