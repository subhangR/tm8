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

function armorBody(body: string): { end: number; complete: boolean } {
  let cursor = 0;
  let end = 0;
  let characters = 0;
  let started = false;
  let separated = false;
  while (cursor < body.length) {
    const start = cursor;
    while (cursor < body.length && body[cursor] !== '\r' && body[cursor] !== '\n') cursor += 1;
    const line = body.slice(start, cursor).trim();
    const lineEnd = cursor;
    if (body[cursor] === '\r') cursor += 1;
    if (body[cursor] === '\n') cursor += 1;
    if (line === '') {
      if (started) separated = true;
      continue;
    }
    // Traditional encrypted PEM and OpenPGP armor allow metadata before the
    // base64 body. Metadata after body data terminates truncated armor.
    if (!started && /^(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):[\t ]*[^\r\n]*$/i.test(line)) continue;
    if (separated || !/^[A-Za-z0-9+/=\t ]+$/.test(line)) return { end: characters >= 16 ? end : 0, complete: false };
    started = true;
    characters += line.replace(/[\t ]/g, '').length;
    end = lineEnd;
    while (end > start && /[\t ]/.test(body[end - 1]!)) end -= 1;
  }
  return { end: characters >= 16 ? end : 0, complete: true };
}

function privateKeys(text: string, add: (kind: PasteKind, start: number, end: number) => void): void {
  const markers = /-----(BEGIN|END) ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g;
  let opening: { start: number; body: number; label: string } | undefined;
  const finish = (stop: number, closing?: RegExpMatchArray) => {
    if (!opening) return;
    // Marker gaps are disjoint, including malformed/repeated BEGINs: no
    // missing END can cause a rescan of the remaining input.
    const body = armorBody(text.slice(opening.body, stop));
    if (body.end > 0) {
      const end = closing && body.complete && opening.label === closing[2]
        ? stop + closing[0].length : opening.body + body.end;
      add('private_key', opening.start, end);
    }
    opening = undefined;
  };
  for (const match of text.matchAll(markers)) {
    finish(match.index, match[1] === 'END' ? match : undefined);
    if (match[1] === 'BEGIN') {
      opening = { start: match.index, body: match.index + match[0].length, label: match[2]! };
    }
  }
  finish(text.length);
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
        else if (parsed.username !== '') {
          const username = decodeURIComponent(parsed.username);
          if (username.length >= 20 && /^[\x21-\x7e]+$/.test(username) && entropy(username) >= 4.2) {
            add('connection_string', match.index, end);
          }
        }
        if (parsed.protocol === 'https:' && (
          ((parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com')
            && /^\/api\/(?:v[0-9]{1,2}\/)?webhooks\/[0-9]{16,20}\/[A-Za-z0-9_-]{20,}\/?$/.test(parsed.pathname))
          || (/^[a-z0-9-]+\.webhook\.office\.com$/.test(parsed.hostname)
            && /^\/webhookb2\/[^/]+(?:\/[^/]+)*\/?$/.test(parsed.pathname))
        )) add('webhook_url', match.index, end);
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

function repeating(token: string): boolean {
  // Only called for 32/64-character hex tokens. Check periods explicitly;
  // entropy alone would accept a repeated, evenly distributed hex alphabet.
  for (let period = 1; period <= token.length / 2; period *= 2) {
    let index = period;
    while (index < token.length && token[index] === token[index % period]) index += 1;
    if (index === token.length) return true;
  }
  return false;
}

const QUERY_SECRET = /^(?:sig|signature|x-amz-signature|x-goog-signature|x-amz-security-token)$/i;

function querySecrets(text: string, add: (kind: PasteKind, start: number, end: number, confidence: 'medium') => void): void {
  const parameters = /[?&](?:sig|signature|x-amz-signature|x-goog-signature|x-amz-security-token)=/gi;
  const value = /[^&#\s"'<>`]+/y;
  let parameter: RegExpExecArray | null;
  while ((parameter = parameters.exec(text)) !== null) {
    const start = parameters.lastIndex;
    value.lastIndex = start;
    if (value.exec(text)) {
      add('generic_secret_assignment', start, value.lastIndex, 'medium');
      parameters.lastIndex = value.lastIndex;
    }
  }
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
        if (/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/i.test(token)) continue;
        if ((token.length === 40 || token.length === 64) && /^[0-9a-f]+$/i.test(token)
          && /commit|sha(?:1|256|512)?|hash|digest/i.test(text.slice(Math.max(0, start - 48), Math.min(text.length, end + 48)))) continue;
        if (/^[0-9a-f]+$/i.test(token)) {
          // Hex tops out at 4 bits/character, below the general 4.2 floor.
          // Retain only secret-sized, sufficiently varied, nonperiodic runs.
          const hex = token.toLowerCase();
          if ((hex.length === 32 || hex.length === 64) && entropy(hex) >= 3 && !repeating(hex)) {
            add('high_entropy', start, end, 'medium');
          }
          continue;
        }
        if (entropy(token) >= 4.2) add('high_entropy', start, end, 'medium');
      }
      const access = findings.filter((finding) => finding.kind === 'aws_access_key').sort((a, b) => a.start - b.start);
      let near = 0;
      for (const match of text.matchAll(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g)) {
        while (access[near] && access[near]!.end < match.index - 256) near += 1;
        if (access[near] && access[near]!.start <= match.index + 296) add('aws_secret_key', match.index, match.index + 40, 'medium');
      }
      querySecrets(text, add);
      const assignments = /(?<![A-Za-z0-9_])["']?([A-Za-z_][A-Za-z0-9_.-]{0,127})["']?[ \t]{0,32}(?:[:=]|\bis\b)[ \t]{0,32}/gi;
      let assignment: RegExpExecArray | null;
      while ((assignment = assignments.exec(text)) !== null) {
        const key = assignment[1]!.toLowerCase();
        const query = text[assignment.index - 1] === '?' || text[assignment.index - 1] === '&';
        if (query && QUERY_SECRET.test(key)) continue;
        const password = /(?:^|[_.-])(?:password|passwd|pwd|passphrase)$/.test(key);
        if (!password && !/(?:^|[_.-])(?:api[_.-]?key|secret|token|access[_.-]?key|private[_.-]?key)(?:$|[_.-])/.test(key)) continue;
        let start = assignments.lastIndex;
        let end = start;
        const quote = text[start] === '"' || text[start] === "'" ? text[start++] : undefined;
        end = start;
        while (end < text.length) {
          const ch = text[end]!;
          if (query && /[&#]/.test(ch)) break;
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
        // Numeric substrings of SHAs, UUIDs and other word tokens are not
        // standalone card numbers, even when their checksum happens to pass.
        if ((match.index > 0 && /[A-Za-z0-9_]/.test(text[match.index - 1]!))
          || (match.index + raw.length < text.length && /[A-Za-z0-9_]/.test(text[match.index + raw.length]!))) continue;
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
