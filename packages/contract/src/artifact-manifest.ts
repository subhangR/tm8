// @tm8/contract — the web-artifact bundle manifest (TM8-ARTIFACTS-DESIGN §4).
//
// The manifest is the ONLY identity of an artifact bundle revision: identical
// bytes produce an identical hash regardless of who or what produced them
// (§3, the model-agnosticism invariant). A human, any model, a CI build and an
// import all use this identical shape. Nothing about provider/model/agent/
// prompt/generator/storage appears here, and the strict schema + the two
// invariant tests (§4.4) keep it that way.
//
// Hashing note: this module implements SHA-256 in pure TypeScript rather than
// importing `node:crypto`. @tm8/contract is re-exported through index.ts and is
// consumed by the browser UI (`packages/tm8-ui`, bundled by Vite) as well as
// the node CLI and server; a top-level `node:crypto` import would follow the
// index re-export into the browser bundle. Pure TS is portable, synchronous,
// and produces byte-identical digests in every consumer — which is exactly the
// property §3 requires. TextEncoder is a global in node and the browser alike.

import { z } from 'zod';
import type { CommandContext, EntityId, SpaceId } from './contract.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants (§4, §4.3)
// ─────────────────────────────────────────────────────────────────────────────

/** The manifest media type. */
export const ARTIFACT_MANIFEST_MEDIA_TYPE = 'application/vnd.tm8.web-artifact+json';

/** The one manifest schema id this version understands (§4). */
export const ARTIFACT_MANIFEST_SCHEMA_ID = 'tm8.web-artifact/1';

/** The one runtime id this version understands (§4). */
export const ARTIFACT_RUNTIME_ID = 'web-static-v1';

/**
 * Closed, frozen allowlist of per-file media types (§4.2). Types are declared
 * metadata served verbatim beside `nosniff`; a lie about the type cannot
 * upgrade a `.txt` into script. A JavaScript source map is `application/json`
 * (already present), so no distinct `map` type is needed.
 */
export const ARTIFACT_MEDIA_TYPES = Object.freeze([
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/wasm',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'font/woff2',
  'text/plain',
] as const);

export type ArtifactMediaType = (typeof ARTIFACT_MEDIA_TYPES)[number];

/** Bundle limits (§4.3). Node-configurable defaults, never per-request. */
export const ARTIFACT_MAX_FILES = 128;
export const ARTIFACT_MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MiB
export const ARTIFACT_MAX_FILE_BYTES = 8 * 1024 * 1024; //  8 MiB
export const ARTIFACT_MAX_PATH_BYTES = 1024;
export const ARTIFACT_MAX_SEGMENT_BYTES = 255;
/** JCS serialises integers unambiguously only within the safe-integer range. */
export const ARTIFACT_MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtifactManifestFile {
  path: string;
  mediaType: ArtifactMediaType;
  size: number;
  sha256: string;
}

export interface ArtifactManifest {
  schema: typeof ARTIFACT_MANIFEST_SCHEMA_ID;
  runtime: typeof ARTIFACT_RUNTIME_ID;
  entrypoint: string;
  files: ArtifactManifestFile[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Path rules (§4.2)
// ─────────────────────────────────────────────────────────────────────────────

const UTF8 = new TextEncoder();
const utf8Len = (s: string): number => UTF8.encode(s).length;

/**
 * Returns a human-readable reason a path is invalid, or `null` when it is
 * acceptable. Non-NFC paths are REJECTED, never rewritten (§4.1): rewriting
 * would make the client-computed hash disagree with the server's.
 */
export function artifactPathError(path: string): string | null {
  if (path.length === 0) return 'path is empty';
  if (utf8Len(path) > ARTIFACT_MAX_PATH_BYTES) {
    return `path exceeds ${ARTIFACT_MAX_PATH_BYTES} UTF-8 bytes`;
  }
  if (path.normalize('NFC') !== path) return 'path is not Unicode NFC';
  if (path.includes('\\')) return 'path contains a backslash';
  if (path.startsWith('/')) return 'path is absolute';
  if (/^[A-Za-z]:/.test(path)) return 'path is a Windows drive path';
  for (const ch of path) {
    const c = ch.codePointAt(0)!;
    // NUL, C0 controls (incl. DEL 0x7f) and C1 controls.
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return 'path contains a control character';
  }
  for (const seg of path.split('/')) {
    if (seg.length === 0) return 'path has an empty segment';
    if (seg === '.' || seg === '..') return 'path has a "." or ".." segment';
    if (seg.startsWith('.')) return 'path has a segment beginning with "."';
    if (utf8Len(seg) > ARTIFACT_MAX_SEGMENT_BYTES) {
      return `path has a segment over ${ARTIFACT_MAX_SEGMENT_BYTES} bytes`;
    }
  }
  return null;
}

/** ASCII-only case fold (A-Z → a-z); used for the case-fold duplicate check. */
const asciiFold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function compareUtf8(a: string, b: string): number {
  const x = UTF8.encode(a);
  const y = UTF8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const xi = x[i]!;
    const yi = y[i]!;
    if (xi !== yi) return xi - yi;
  }
  return x.length - y.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strict schema (§4). Any unknown key at any level is invalid.
// ─────────────────────────────────────────────────────────────────────────────

const ArtifactManifestFileSchema = z
  .object({
    path: z.string(),
    mediaType: z.enum(ARTIFACT_MEDIA_TYPES as unknown as [ArtifactMediaType, ...ArtifactMediaType[]]),
    size: z.number().int().min(0).max(ARTIFACT_MAX_FILE_SIZE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex chars'),
  })
  .strict();

export const ArtifactManifestSchema: z.ZodType<ArtifactManifest> = z
  .object({
    schema: z.literal(ARTIFACT_MANIFEST_SCHEMA_ID),
    runtime: z.literal(ARTIFACT_RUNTIME_ID),
    entrypoint: z.string(),
    files: z.array(ArtifactManifestFileSchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const files = manifest.files;

    if (files.length < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'a bundle needs at least one file' });
    }
    if (files.length > ARTIFACT_MAX_FILES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['files'],
        message: `limit_exceeded: at most ${ARTIFACT_MAX_FILES} files per bundle`,
      });
    }

    let total = 0;
    const seenExact = new Set<string>();
    const seenFolded = new Set<string>();

    files.forEach((file, i) => {
      const reason = artifactPathError(file.path);
      if (reason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', i, 'path'], message: reason });
      }

      if (file.size > ARTIFACT_MAX_FILE_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['files', i, 'size'],
          message: `limit_exceeded: file exceeds ${ARTIFACT_MAX_FILE_BYTES} bytes`,
        });
      }
      total += file.size;

      // Duplicate after NFC (paths are required NFC, so the string itself) AND
      // after NFC + ASCII case-fold — the latter because export-to-zip lands on
      // case-insensitive filesystems where `A.js` and `a.js` collide (§4.2).
      if (seenExact.has(file.path)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', i, 'path'], message: 'duplicate path' });
      }
      seenExact.add(file.path);
      const folded = asciiFold(file.path);
      if (seenFolded.has(folded)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['files', i, 'path'],
          message: 'path duplicates another after ASCII case-folding',
        });
      }
      seenFolded.add(folded);

      // `files` must ARRIVE sorted ascending by UTF-8 bytes of `path` — never
      // re-sorted, or the client-computed hash would disagree (§4.1).
      if (i > 0 && compareUtf8(files[i - 1]!.path, file.path) >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['files', i, 'path'],
          message: 'files must be sorted ascending by the UTF-8 byte sequence of path',
        });
      }
    });

    if (total > ARTIFACT_MAX_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['files'],
        message: `limit_exceeded: total size exceeds ${ARTIFACT_MAX_TOTAL_BYTES} bytes`,
      });
    }

    if (!files.some((f) => f.path === manifest.entrypoint)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['entrypoint'],
        message: 'entrypoint must be one of the file paths',
      });
    }
  }) as z.ZodType<ArtifactManifest>;

/** Convenience: parse+validate, throwing a ZodError on any violation. */
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  return ArtifactManifestSchema.parse(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// JCS (RFC 8785) canonicalisation and hashing (§4.1)
// ─────────────────────────────────────────────────────────────────────────────

/** JSON string escaping per RFC 8785 §3.2.2.2 (JCS). */
function jcsString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s.charAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * RFC 8785 canonical JSON for the manifest shape (strings, non-negative safe
 * integers, arrays, objects). Object keys are sorted by UTF-16 code units;
 * integers are emitted as plain decimal with no exponent or fraction.
 */
function jcs(value: unknown): string {
  if (typeof value === 'string') return jcsString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error('canonicalManifestBytes: only integer numbers are supported in this shape');
    }
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + keys.map((k) => jcsString(k) + ':' + jcs((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  throw new Error('canonicalManifestBytes: unsupported value in manifest');
}

/**
 * JCS (RFC 8785) canonical serialisation of a VALIDATED manifest. Callers must
 * validate first; this function assumes the strict shape.
 */
export function canonicalManifestBytes(manifest: ArtifactManifest): Uint8Array {
  return UTF8.encode(jcs(manifest));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure-TS SHA-256 (see the module header for why this is not node:crypto)
// ─────────────────────────────────────────────────────────────────────────────

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Hex(bytes: Uint8Array): string {
  // Working state as scalars (not a typed array) so strict indexed-access rules
  // never see a `number | undefined`; the message schedule reads assert bounds.
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const l = bytes.length;
  const bitLenHi = Math.floor(l / 0x20000000); // (l * 8) >> 32  == l / 2^29
  const bitLenLo = (l << 3) >>> 0;
  const withOne = l + 1;
  const pad = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + pad + 8;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, bitLenHi);
  dv.setUint32(total - 4, bitLenLo);

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!, w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
  }

  const toHex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Lowercase-hex SHA-256 of the manifest's JCS bytes (§4.1). The hash is NEVER a
 * field of the manifest — self-referential hashing is a canonicalisation bug,
 * excluded by construction. Callers must validate the manifest first.
 */
export function manifestSha256(manifest: ArtifactManifest): string {
  return sha256Hex(canonicalManifestBytes(manifest));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command input types (§8.1). Co-located here because they embed ArtifactManifest;
// their zod schemas live in schemas.ts. Exported through index.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline bundle bytes riding a create/publish call. `path` must name a
 * manifest entry; the decoded bytes must hash to that entry's `sha256` and
 * match its `size` — the server verifies, never trusts. Bounded by the
 * request body cap (default 8 MiB), which is deliberately tighter than the
 * 25 MiB bundle cap: larger bundles use the upload-grant seam (Phase 2
 * batch grants). This is the Phase-1 way bytes reach `stored_blobs` at all.
 */
export interface ArtifactInlineFile {
  path: string;
  contentBase64: string;
}

/** POST /v2/artifacts — create the artifact with its first bundle revision. */
export interface ArtifactsCreateInput extends CommandContext {
  clientMutationId: string;
  spaceId: SpaceId;
  name: string;
  description?: string;
  manifest: ArtifactManifest;
  /** Bytes for manifest entries not already registered in the space's blob store. */
  files?: ArtifactInlineFile[];
  sourceWorkSessionId?: EntityId | null;
  parentId?: EntityId | null;
  position?: number;
}

/** POST /v2/artifacts/:artifactId/revisions — publish a further revision. */
export interface ArtifactsPublishInput extends CommandContext {
  clientMutationId: string;
  expectedVersion: number;
  manifest: ArtifactManifest;
  /** Bytes for manifest entries not already registered in the space's blob store. */
  files?: ArtifactInlineFile[];
  sourceWorkSessionId?: EntityId | null;
}

/** POST /v2/artifacts/:artifactId/preview-sessions — mint a viewer-bound preview. */
export interface ArtifactsPreviewStartInput extends CommandContext {
  clientMutationId: string;
  /** Defaults to the latest revision when omitted. */
  revisionNumber?: number;
}

/** POST /v2/artifacts/:artifactId/commands/restore-revision — publish an old revision anew. */
export interface ArtifactsRestoreInput extends CommandContext {
  clientMutationId: string;
  expectedVersion: number;
  revisionNumber: number;
}

/**
 * What `artifacts.preview.start` answers: a short-lived, viewer-bound
 * capability (design §9.5). `previewUrl` is present only on a node whose
 * preview listener is configured (the second origin, §9.2/§9.3); on a node
 * without one the capability is minted but there is nowhere to spend it, and
 * the URL is honestly absent rather than fabricated.
 */
export interface ArtifactPreviewSession {
  previewSessionId: string;
  /** The raw capability. Never stored server-side — only its sha256 is. */
  token: string;
  revisionNumber: number;
  expiresAt: string;
  previewUrl?: string;
}
