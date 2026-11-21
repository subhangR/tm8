import { randomUUID } from 'node:crypto';
import { VAULT_MAX_IMPORT_CIPHERTEXT } from '@tm8/contract';
import { memberScope, StoreNotFoundError, VaultError, type HandlersFor, type HandlerContext } from '../../core-types.js';
import { CaptureSealError } from '../../capture/seal.js';
import { CapturePayloadError, parseCapturePayload, type CapturePayload } from '../../capture/payload.js';
import { encryptSecretVersion } from '../../crypto/aead.js';
import { ImportParseError } from '../../import/index.js';
import { SecretMaterial } from '../../secret-material.js';
import type { ImportCandidate, ImportFormat } from '../../types.js';
import { normalizeOrigin, OriginRefusal } from '../../origin/normalize.js';
import { appendAudit, assertOwnerSession, assertPreReviewCapacity, metadataFields, scanItemMetadata, scanMetadata } from './shared.js';

type ImportOp = 'vault.imports.begin' | 'vault.imports.upload' | 'vault.imports.commit' | 'vault.imports.cancel';
interface ImportSession {
  id: string;
  memberId: string;
  spaceId: string;
  kid: string;
  format?: ImportFormat;
  expiresAt: string;
  rows: Map<number, { candidate: ImportCandidate; payload: SecretMaterial }>;
  skipped: { index: number; reason: string }[];
  uploaded: boolean;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** Sessions and exports exist only in memory. Payloads become zeroizable buffers immediately after parsing. */
export function createImportHandlers(): HandlersFor<ImportOp> {
  const sessions = new Map<string, ImportSession>();
  const discard = (session: ImportSession): void => {
    clearTimeout(session.timer);
    for (const row of session.rows.values()) row.payload.dispose();
    session.rows.clear();
    sessions.delete(session.id);
  };
  const enabled = (ctx: HandlerContext, stepUp = false): void => {
    assertOwnerSession(ctx, stepUp);
    if (ctx.config.mode === 'pre_review' || !ctx.config.features.import) throw VaultError.reason('import_disabled');
  };
  const get = (ctx: HandlerContext, id: string): ImportSession => {
    const session = sessions.get(id);
    if (!session || session.memberId !== ctx.caller.memberId || session.spaceId !== ctx.caller.spaceId) throw new StoreNotFoundError();
    if (Date.parse(session.expiresAt) <= ctx.clock.now().getTime()) { discard(session); throw new StoreNotFoundError(); }
    if (session.kid !== ctx.components.captureKeys.kid) { discard(session); throw VaultError.reason('capture_key_rotated'); }
    if (session.busy) throw new VaultError('conflict');
    return session;
  };
  return {
    'vault.imports.begin': async (ctx, { input }) => {
      enabled(ctx);
      for (const session of sessions.values()) if (Date.parse(session.expiresAt) <= ctx.clock.now().getTime()) discard(session);
      if (sessions.size >= 100 || [...sessions.values()].filter((session) => session.memberId === ctx.caller.memberId).length >= 3) throw new VaultError('rate_limited', null, { retryAfterSeconds: 600 });
      const id = randomUUID();
      const expiresAt = new Date(ctx.clock.now().getTime() + 600_000).toISOString();
      await ctx.store.transaction(memberScope(ctx.caller), (tx) => appendAudit(ctx, tx, 'import.begun'));
      const timer = setTimeout(() => { const session = sessions.get(id); if (session && !session.busy) discard(session); }, 600_000);
      timer.unref();
      sessions.set(id, { id, memberId: ctx.caller.memberId, spaceId: ctx.caller.spaceId, kid: ctx.components.captureKeys.kid,
        format: input.format, expiresAt, rows: new Map(), skipped: [], uploaded: false, busy: false, timer });
      return { data: { importId: id, expiresAt, publicKey: ctx.components.captureKeys.publicKey(), maxCiphertextBytes: VAULT_MAX_IMPORT_CIPHERTEXT } };
    },
    'vault.imports.upload': async (ctx, { params, input }) => {
      enabled(ctx);
      const session = get(ctx, params.importId);
      session.busy = true;
      let plaintext: SecretMaterial | null = null;
      const rows: ImportSession['rows'] = new Map();
      let adopted = false;
      try {
        plaintext = SecretMaterial.adopt(ctx.components.captureKeys.open(input.sealed, session.id, VAULT_MAX_IMPORT_CIPHERTEXT));
        const parsed = plaintext.use((bytes) => ctx.components.importParser.parse(bytes, session.format));
        try {
          if (parsed.candidates.length !== parsed.payloads.length) throw new VaultError('invariant_violation');
          parsed.candidates.forEach((candidate, index) => {
            scanMetadata(ctx, [candidate.name, candidate.username, candidate.origin]);
            if (rows.has(candidate.index)) throw new VaultError('invariant_violation');
            rows.set(candidate.index, { candidate: structuredClone(candidate), payload: SecretMaterial.fromUtf8(JSON.stringify(parsed.payloads[index]!)) });
          });
          for (const row of session.rows.values()) row.payload.dispose();
          session.rows = rows;
          session.skipped = structuredClone(parsed.skipped);
          session.format = parsed.format;
          session.uploaded = true;
          adopted = true;
          return { data: { importId: session.id, format: parsed.format, candidates: parsed.candidates.map((candidate) => ({
            index: candidate.index, type: candidate.type, name: candidate.name, origin: candidate.origin, originError: candidate.originError ?? null,
            username: candidate.username, hasPassword: candidate.hasPassword, hasTotp: candidate.hasTotp, duplicateOf: candidate.duplicateOf ?? null,
            warnings: candidate.warnings.slice(),
          })), skipped: structuredClone(parsed.skipped), expiresAt: session.expiresAt } };
        } finally { parsed.payloads.length = 0; }
      } catch (error) {
        if (error instanceof CaptureSealError) {
          if (error.code === 'unknown_kid') throw VaultError.reason('capture_key_rotated');
          throw new VaultError(error.code === 'too_large' ? 'payload_too_large' : 'invalid_input');
        }
        if (error instanceof ImportParseError) throw new VaultError(error.code === 'too_large' ? 'payload_too_large' : 'invalid_input');
        throw error;
      } finally {
        plaintext?.dispose();
        if (!adopted) for (const row of rows.values()) row.payload.dispose();
        session.busy = false;
        if (Date.parse(session.expiresAt) <= ctx.clock.now().getTime()) discard(session);
      }
    },
    'vault.imports.commit': async (ctx, { params, input }) => {
      enabled(ctx, true);
      const session = get(ctx, params.importId);
      if (!session.uploaded) throw new VaultError('invalid_input');
      session.busy = true;
      try {
        const indices = new Set<number>();
        for (const row of input.rows) {
          if (indices.has(row.index) || !session.rows.has(row.index)) throw new VaultError('invalid_input');
          indices.add(row.index);
        }
        return await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
          const created: { index: number; itemId: string; state: 'active' | 'blocked_until_rotated' }[] = [];
          const skipped = structuredClone(session.skipped);
          await assertPreReviewCapacity(ctx, tx, input.rows.filter((row) => row.include).length);
          for (const row of input.rows) {
            if (!row.include) { skipped.push({ index: row.index, reason: 'excluded' }); continue; }
            if (ctx.signal.aborted) throw VaultError.reason('vault_unavailable');
            const entry = session.rows.get(row.index)!;
            let adjusted: SecretMaterial | null = null;
            let parsed: ReturnType<typeof parseCapturePayload> | null = null;
            try {
              const payload = entry.payload.use((bytes) => JSON.parse(bytes.toString('utf8')) as CapturePayload);
              if (row.name !== undefined) payload.name = row.name;
              if (payload.type === 'login') {
                if (entry.candidate.originError && row.originOverride === undefined) throw VaultError.reason('origin_refused');
                payload.origin = normalizeOrigin(row.originOverride ?? payload.origin).origin;
              } else if (row.originOverride !== undefined) throw new VaultError('invalid_input');
              adjusted = SecretMaterial.fromUtf8(JSON.stringify(payload));
              parsed = adjusted.use((bytes) => parseCapturePayload(bytes, entry.candidate.type));
              scanItemMetadata(ctx, parsed.metadata);
              const id = randomUUID();
              const secret = await encryptSecretVersion(ctx.components.kms, parsed.secret, { itemId: id, ownerId: ctx.caller.memberId, version: 1 });
              const state = row.exposureTier === 'a' ? 'blocked_until_rotated' as const : 'active' as const;
              await tx.items.create({ id, ...metadataFields(parsed.metadata), type: parsed.metadata.type, state, exposureTier: row.exposureTier,
                origins: parsed.metadata.origin ? [parsed.metadata.origin] : [], devMode: false, createdBy: { ...ctx.actor, name: null } }, secret);
              await appendAudit(ctx, tx, 'item.imported', id, { type: parsed.metadata.type, exposureTier: row.exposureTier, state });
              created.push({ index: row.index, itemId: id, state });
            } catch (error) {
              if (error instanceof OriginRefusal || (error instanceof CapturePayloadError && error.code === 'origin_refused')) throw VaultError.reason('origin_refused');
              if (error instanceof CapturePayloadError) throw new VaultError('invalid_input');
              throw error;
            } finally { parsed?.secret.dispose(); adjusted?.dispose(); }
          }
          await appendAudit(ctx, tx, 'import.committed', null, { created: created.length, skipped: skipped.length });
          return { data: { importId: session.id, created, skipped, deleteSourceAdvice: true as const } };
        });
      } finally { discard(session); }
    },
    'vault.imports.cancel': async (ctx, { params }) => {
      enabled(ctx);
      const session = get(ctx, params.importId);
      session.busy = true;
      try { await ctx.store.transaction(memberScope(ctx.caller), (tx) => appendAudit(ctx, tx, 'import.cancelled')); }
      finally { discard(session); }
      return { data: { importId: session.id, state: 'cancelled' } };
    },
  };
}
