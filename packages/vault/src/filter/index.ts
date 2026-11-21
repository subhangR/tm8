import { TextDecoder } from 'node:util';
import type { ApiResponseBody, ApiResponseOutcome, ResponseFilter, TokenSpanScanner } from '../types.js';
import { headerMatches } from '../canary/index.js';
import { DECODINGS, compileMatcher, decodedView, decodingApplies, encodedPatterns, mergeSpans, sourceSpan, type Span } from '../canary/encodings.js';

const ALLOWED_HEADERS = new Set([
  'content-type', 'content-language', 'etag', 'last-modified', 'cache-control',
  'expires', 'date', 'retry-after', 'link', 'x-request-id', 'request-id', 'x-github-request-id',
]);

function allowedHeader(name: string): boolean {
  return ALLOWED_HEADERS.has(name) || /^(?:x-ratelimit-|ratelimit-)[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name);
}

function textType(contentType: string | null): { text: boolean; json: boolean } {
  const mime = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  const subtype = mime.split('/')[1] ?? '';
  const json = subtype === 'json' || subtype.endsWith('+json');
  return { json, text: mime.startsWith('text/') || json || subtype === 'xml' || subtype.endsWith('+xml') ||
    mime === 'application/x-www-form-urlencoded' || /^application\/(?:x-)?(?:java|ecma)script$/.test(mime) };
}

function basicSpans(text: string, key: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]+={0,2}/g)) {
    const bytes = Buffer.from(match[0], 'base64');
    try {
      const decoded = bytes.toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0 && decoded.slice(colon + 1) === key) spans.push({ start: match.index, end: match.index + match[0].length });
    } finally { bytes.fill(0); }
  }
  return spans;
}

function redactor(key: string, scanner?: TokenSpanScanner) {
  const matcher = compileMatcher(encodedPatterns(key));
  const rawMatcher = compileMatcher([{ text: key }]);
  return (text: string): { value: string; count: number } => {
    const decodedSpans: Span[] = [];
    for (const encoding of DECODINGS) {
      if (!decodingApplies(text, encoding)) continue;
      const view = decodedView(text, encoding);
      decodedSpans.push(...rawMatcher.occurrences(view.text).map((span) => sourceSpan(view, span)));
    }
    const spans = mergeSpans([
      ...matcher.occurrences(text), ...decodedSpans, ...basicSpans(text, key), ...(scanner?.(text) ?? []),
    ], text.length);
    const chunks: string[] = [];
    let offset = 0;
    for (const { start, end } of spans) { chunks.push(text.slice(offset, start), '[redacted]'); offset = end; }
    chunks.push(text.slice(offset));
    return { value: chunks.join(''), count: spans.length };
  };
}

/** Pure, fail-closed on malformed content or a failed external scanner. */
export function createResponseFilter(): ResponseFilter {
  return (input): ApiResponseOutcome => {
    const withheld = (reason: 'too_large' | 'binary' | 'canary'): ApiResponseOutcome => ({
      status: input.status, headers: {}, body: { kind: 'withheld', reason }, redactions: 0,
    });
    if (input.body.byteLength > input.maxBytes) return withheld('too_large');
    try {
      const type = textType(input.contentType);
      if (input.body.length && (!type.text || input.body.includes(0))) return withheld('binary');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.body);
      if (input.canaries.matches(input.body) || input.canaries.matches(text)) return withheld('canary');
      const material: unknown = input.key.use((bytes) => JSON.parse(bytes.toString('utf8')));
      if (!material || typeof material !== 'object' || !('key' in material) || typeof material.key !== 'string' || !material.key) {
        return withheld('binary');
      }
      const redact = redactor(material.key, input.scanTokens);
      const headers: Record<string, string> = {};
      let redactions = 0;
      for (const [rawName, value] of Object.entries(input.headers)) {
        const name = rawName.toLowerCase();
        if (!allowedHeader(name)) continue;
        if (headerMatches(input.canaries, value)) return withheld('canary');
        const result = redact(value);
        // Node read the header's bytes as Latin-1; the agent can read the same bytes as UTF-8. A key
        // found only that way takes the whole value (review F02 follow-up, task 01a1fe78).
        const utf8 = /[^\x00-\x7f]/.test(result.value) && redact(Buffer.from(result.value, 'latin1').toString('utf8')).count > 0;
        headers[name] = utf8 ? '[redacted]' : result.value; redactions += result.count + (utf8 ? 1 : 0);
      }
      if (!text.length) return { status: input.status, headers, body: { kind: 'empty' }, redactions };
      const result = redact(text);
      let body: ApiResponseBody = { kind: 'text', value: result.value };
      if (type.json) {
        try { body = { kind: 'json', value: JSON.parse(result.value) }; } catch { /* redacted numbers can stop being JSON */ }
      }
      return { status: input.status, headers, body, redactions: redactions + result.count };
    } catch { return withheld('binary'); }
  };
}
