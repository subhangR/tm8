import { randomBytes, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  VAULT_REFRESH_FAMILY_TTL_SECONDS, VAULT_SESSION_TTL_SECONDS, VAULT_STEP_UP_CHALLENGE_TTL_SECONDS,
  VaultWebAuthnCreationOptionsSchema, VaultWebAuthnRequestOptionsSchema,
  type VaultPasskeyView, type VaultSessionView,
} from '@tm8/contract';
import {
  StoreDuplicateError, VaultError, VAULT_COOKIE_NAMES, memberScope,
  type HandlerContext, type HandlersFor, type OwnerAuthOp, type OwnerSession,
  type PasskeyRecord, type VaultSessionRecord, type VaultSetCookie, type VaultTx,
} from '../core-types.js';
import { bindingHash, matchesChallenge, verifyAssertion } from './auth.js';
import { findCode, newCodeBatch } from './codes.js';
import { audit, expiresAfter, liveSession, randomToken, sha256, validToken } from './primitives.js';

function owner(ctx: HandlerContext): OwnerSession {
  if (!ctx.ownerSession || ctx.ownerSession.memberId !== ctx.caller.memberId) throw VaultError.reason('vault_session_required');
  return ctx.ownerSession;
}

function passkeyView(row: PasskeyRecord): VaultPasskeyView {
  return { id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
    backedUp: row.backedUp, transports: row.transports, revokedAt: row.revokedAt };
}

function sessionView(row: VaultSessionRecord, current: string | null): VaultSessionView {
  return { id: row.id, passkeyId: row.passkeyId, deviceLabel: row.deviceLabel, createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt, expiresAt: row.expiresAt, refreshExpiresAt: row.refreshExpiresAt,
    current: row.id === current, revokedAt: row.revokedAt };
}

function clearCookies(): VaultSetCookie[] {
  return [{ name: VAULT_COOKIE_NAMES.session, value: null, maxAgeSeconds: 0 }, { name: VAULT_COOKIE_NAMES.refresh, value: null, maxAgeSeconds: 0 }];
}

function cookiesFor(row: VaultSessionRecord, session: string, refresh: string, now: string): VaultSetCookie[] {
  const remaining = (at: string) => Math.max(0, Math.floor((Date.parse(at) - Date.parse(now)) / 1000));
  return [{ name: VAULT_COOKIE_NAMES.session, value: session, maxAgeSeconds: remaining(row.expiresAt) },
    { name: VAULT_COOKIE_NAMES.refresh, value: refresh, maxAgeSeconds: remaining(row.refreshExpiresAt) }];
}

async function revokeSessionsAudit(tx: VaultTx, ctx: HandlerContext, rows: VaultSessionRecord[]): Promise<void> {
  for (const _row of rows) await audit(tx, ctx.caller, 'session.revoked', { code: 'recovery' });
}

async function registrationSessionLive(tx: VaultTx, session: OwnerSession | null, sessionId: string | null): Promise<boolean> {
  if (!session || session.sessionId !== sessionId) return false;
  const current = await tx.sessions.get(session.sessionId);
  if (!current || !liveSession(current, tx.now)) return false;
  const key = await tx.passkeys.get(current.passkeyId);
  return key !== null && key.revokedAt === null;
}

/** Factory has no captured broker state: every operation uses its HandlerContext. */
export function createOwnerAuthHandlers(): HandlersFor<OwnerAuthOp> {
  return {
    'vault.webauthn.challenge': async (ctx, { input }) => {
      let hash: string | null = null;
      if (input.purpose === 'step_up') {
        const session = await ctx.auth.resolveSession(ctx.caller, ctx.cookies);
        if (!session) throw VaultError.reason('vault_session_required');
        try { hash = bindingHash({ action: input.action, pathParams: input.pathParams, body: input.body }); }
        catch { throw new VaultError('invalid_input'); }
      }
      const bytes = hash ? Buffer.concat([randomBytes(32), Buffer.from(hash, 'hex')]) : randomBytes(32);
      const challenge = bytes.toString('base64url');
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const passkeys = (await tx.passkeys.listForMember()).filter((key) => key.revokedAt === null);
        if (passkeys.length === 0) throw VaultError.reason('passkey_required');
        const publicKey = VaultWebAuthnRequestOptionsSchema.parse(await generateAuthenticationOptions({
          rpID: ctx.config.webauthn.rpId, challenge: new Uint8Array(bytes), userVerification: 'required',
          timeout: VAULT_STEP_UP_CHALLENGE_TTL_SECONDS * 1000,
          allowCredentials: passkeys.slice(0, 32).map((key) => ({ id: key.credentialId, transports: key.transports })),
        }));
        const row = await tx.challenges.create({ id: randomUUID(), purpose: input.purpose,
          action: input.purpose === 'step_up' ? input.action : null, intentHash: hash,
          challenge: sha256(challenge), registration: null,
          expiresAt: expiresAfter(tx.now, VAULT_STEP_UP_CHALLENGE_TTL_SECONDS) });
        return { data: { challengeId: row.id, purpose: input.purpose, action: row.action, intentHash: hash, expiresAt: row.expiresAt, publicKey } };
      });
    },

    'vault.session.begin': async (ctx, { input }) => {
      const { passkey } = await verifyAssertion({ store: ctx.store, config: ctx.config, clock: ctx.clock }, ctx.caller,
        { challengeId: input.challengeId, assertion: input.assertion }, 'sign_in');
      const session = randomToken();
      const refresh = randomToken();
      const row = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const row = await tx.sessions.create({ id: randomUUID(), passkeyId: passkey.id, deviceLabel: input.deviceLabel ?? null,
          tokenHash: sha256(session), refreshHash: sha256(refresh),
          expiresAt: expiresAfter(tx.now, VAULT_SESSION_TTL_SECONDS),
          refreshExpiresAt: expiresAfter(tx.now, VAULT_REFRESH_FAMILY_TTL_SECONDS),
          familyExpiresAt: expiresAfter(tx.now, VAULT_REFRESH_FAMILY_TTL_SECONDS) });
        await audit(tx, ctx.caller, 'session.signed_in');
        return row;
      });
      return { data: sessionView(row, row.id), setCookies: cookiesFor(row, session, refresh, ctx.clock.now().toISOString()) };
    },

    'vault.session.refresh': async (ctx) => {
      if (!validToken(ctx.cookies.refresh)) throw VaultError.reason('vault_session_required');
      const token = randomToken();
      const refresh = randomToken();
      const outcome = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const rotation = await tx.sessions.rotateRefresh({ refreshHash: sha256(ctx.cookies.refresh!),
          newTokenHash: sha256(token), newRefreshHash: sha256(refresh),
          expiresAt: expiresAfter(tx.now, VAULT_SESSION_TTL_SECONDS),
          refreshExpiresAt: expiresAfter(tx.now, VAULT_REFRESH_FAMILY_TTL_SECONDS) });
        if (rotation.result === 'reused') {
          await audit(tx, ctx.caller, 'session.refresh_reuse_detected');
          return rotation;
        }
        if (rotation.result !== 'rotated') return rotation;
        const key = await tx.passkeys.get(rotation.session.passkeyId);
        if (!key || key.revokedAt !== null) {
          const ended = await tx.sessions.revoke(rotation.session.id, 'passkey_revoked');
          await audit(tx, ctx.caller, 'session.revoked', { code: 'passkey_revoked' });
          return { result: 'ended', session: ended } as const;
        }
        await audit(tx, ctx.caller, 'session.refreshed');
        return rotation;
      });
      if (outcome.result === 'reused') ctx.components.alerts.raise({ kind: 'refresh_reuse_detected', memberId: ctx.caller.memberId,
        spaceId: ctx.caller.spaceId, itemId: null, params: {}, at: ctx.clock.now().toISOString() });
      if (outcome.result !== 'rotated') throw VaultError.reason('vault_session_required');
      return { data: sessionView(outcome.session, outcome.session.id),
        setCookies: cookiesFor(outcome.session, token, refresh, ctx.clock.now().toISOString()) };
    },

    'vault.session.end': async (ctx) => {
      const reuse = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        let row = validToken(ctx.cookies.session) ? await tx.sessions.getByTokenHash(sha256(ctx.cookies.session)) : null;
        if (!row && validToken(ctx.cookies.refresh)) {
          // Access cookies expire first. Resolve and end the refresh family even without one.
          const rotation = await tx.sessions.rotateRefresh({ refreshHash: sha256(ctx.cookies.refresh),
            newTokenHash: sha256(randomToken()), newRefreshHash: sha256(randomToken()),
            expiresAt: tx.now, refreshExpiresAt: tx.now });
          if (rotation.result === 'reused') {
            await audit(tx, ctx.caller, 'session.refresh_reuse_detected');
            return true;
          }
          if (rotation.result === 'rotated' || rotation.result === 'ended') row = rotation.session;
        }
        if (row && row.revokedAt === null) {
          await tx.sessions.revoke(row.id, 'ended');
          await audit(tx, ctx.caller, 'session.ended');
        }
        return false;
      });
      if (reuse) ctx.components.alerts.raise({ kind: 'refresh_reuse_detected', memberId: ctx.caller.memberId,
        spaceId: ctx.caller.spaceId, itemId: null, params: {}, at: ctx.clock.now().toISOString() });
      return { data: { ended: true }, setCookies: clearCookies() };
    },

    'vault.passkeys.registerBegin': async (ctx, { input }) => {
      if ([input.enrollmentCode, input.recoveryCode, input.stepUp].filter((value) => value !== undefined).length !== 1) {
        throw new VaultError('invalid_input');
      }
      const via = input.enrollmentCode !== undefined ? 'enrollment_code' : input.recoveryCode !== undefined ? 'recovery_code' : 'step_up';
      let authorizedSession: OwnerSession | null = null;
      if (via === 'step_up') {
        authorizedSession = await ctx.auth.resolveSession(ctx.caller, ctx.cookies);
        if (!authorizedSession) throw VaultError.reason('vault_session_required');
        await ctx.auth.verifyStepUp(ctx.caller, authorizedSession, input.stepUp,
          { action: 'vault.passkeys.registerBegin', pathParams: {}, body: input });
      }
      const row = via === 'step_up' ? null : await ctx.store.transaction(memberScope(ctx.caller), (tx) =>
        via === 'enrollment_code' ? tx.enrollmentCodes.listUsable() : tx.recoveryCodes.listUnused());
      const code = via === 'step_up' ? null : await findCode(row!, (input.enrollmentCode ?? input.recoveryCode)!);
      if (via !== 'step_up' && !code) throw VaultError.reason('code_invalid');
      const challenge = randomToken();
      const userHandle = randomToken();
      const result = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        if (via === 'enrollment_code') {
          if (await tx.passkeys.countActive() !== 0 || !(await tx.enrollmentCodes.listUsable()).some((row) => row.id === code!.id)) throw VaultError.reason('code_invalid');
        } else if (via === 'recovery_code') {
          if (!(await tx.recoveryCodes.listUnused()).some((row) => row.id === code!.id)) throw VaultError.reason('code_invalid');
        } else {
          const session = await tx.sessions.get(authorizedSession!.sessionId);
          if (!session || !liveSession(session, tx.now)) throw VaultError.reason('vault_session_required');
        }
        const existing = await tx.passkeys.listForMember();
        const publicKey = VaultWebAuthnCreationOptionsSchema.parse(await generateRegistrationOptions({
          rpID: ctx.config.webauthn.rpId, rpName: ctx.config.webauthn.rpName,
          userID: new Uint8Array(Buffer.from(userHandle, 'base64url')), userName: 'Vault owner', userDisplayName: 'Vault owner',
          challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
          timeout: VAULT_STEP_UP_CHALLENGE_TTL_SECONDS * 1000, attestationType: 'none',
          supportedAlgorithmIDs: [-7, -257, -8],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          excludeCredentials: existing.slice(0, 32).map((key) => ({ id: key.credentialId, transports: key.transports })),
        }));
        const registration = await tx.challenges.create({ id: randomUUID(), purpose: 'registration', action: null, intentHash: null,
          challenge: sha256(challenge), registration: { name: input.name, via, codeId: code?.id ?? authorizedSession!.sessionId, userHandle },
          expiresAt: expiresAfter(tx.now, VAULT_STEP_UP_CHALLENGE_TTL_SECONDS) });
        return { data: { registrationId: registration.id, expiresAt: registration.expiresAt, publicKey } };
      });
      return result;
    },

    'vault.passkeys.registerFinish': async (ctx, { params, input }) => {
      const finishingSession = await ctx.auth.resolveSession(ctx.caller, ctx.cookies);
      const verification = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const row = await tx.challenges.consume(params.registrationId, 'registration');
        if (row?.registration?.via === 'step_up' && !await registrationSessionLive(tx, finishingSession, row.registration.codeId)) {
          await audit(tx, ctx.caller, 'step_up.failed', { purpose: 'registration', code: 'assertion_invalid' });
          return null;
        }
        let result;
        try {
          if (!row?.registration) throw VaultError.reason('step_up_invalid');
          const { authenticatorAttachment, ...rest } = input.credential;
          const response: RegistrationResponseJSON = { ...rest, ...(authenticatorAttachment ? { authenticatorAttachment } : {}) };
          // Registration verification in the library does not check these client-data fields.
          const client = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as { crossOrigin?: unknown; topOrigin?: unknown };
          if ((client.crossOrigin !== undefined && client.crossOrigin !== false) || client.topOrigin !== undefined) throw VaultError.reason('step_up_invalid');
          result = await verifyRegistrationResponse({ response, expectedChallenge: (candidate) => matchesChallenge(row, candidate),
            expectedOrigin: ctx.config.webauthn.origins, expectedRPID: ctx.config.webauthn.rpId,
            requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7, -257, -8] });
        } catch {
          await audit(tx, ctx.caller, 'step_up.failed', { purpose: 'registration', code: 'assertion_invalid' });
          return null;
        }
        if (!result.verified || !result.registrationInfo.userVerified || result.registrationInfo.fmt !== 'none') {
          await audit(tx, ctx.caller, 'step_up.failed', { purpose: 'registration', code: 'assertion_invalid' });
          return null;
        }
        await audit(tx, ctx.caller, 'step_up.verified', { purpose: 'registration' });
        return { row: row!, info: result.registrationInfo };
      });
      if (!verification) throw VaultError.reason('step_up_invalid');
      const row = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const authorization = verification.row.registration!;
        // The code compare-and-set and passkey insertion share this transaction.
        if (authorization.via === 'enrollment_code') {
          if (await tx.passkeys.countActive() !== 0 || !await tx.enrollmentCodes.markUsed(authorization.codeId!)) throw VaultError.reason('code_invalid');
        } else if (authorization.via === 'recovery_code') {
          if (!await tx.recoveryCodes.markUsed(authorization.codeId!)) throw VaultError.reason('code_invalid');
        } else if (!await registrationSessionLive(tx, finishingSession, authorization.codeId)) {
          await audit(tx, ctx.caller, 'step_up.failed', { purpose: 'registration', code: 'assertion_invalid' });
          return null;
        }
        const { info } = verification;
        let key;
        try {
          key = await tx.passkeys.create({ id: randomUUID(), credentialId: info.credential.id,
            publicKey: Buffer.from(info.credential.publicKey).toString('base64url'), counter: info.credential.counter,
            transports: info.credential.transports ?? [], backedUp: info.credentialBackedUp,
            deviceType: info.credentialDeviceType, aaguid: info.aaguid, name: verification.row.registration!.name });
        } catch (error) {
          if (!(error instanceof StoreDuplicateError)) throw error;
          // Roll back code consumption as well as the failed insert.
          throw VaultError.reason('step_up_invalid');
        }
        if (authorization.via === 'recovery_code') {
          await revokeSessionsAudit(tx, ctx, await tx.sessions.revokeAllForMember('recovery'));
          await audit(tx, ctx.caller, 'recovery.code_used', { codeId: authorization.codeId });
        }
        await audit(tx, ctx.caller, 'passkey.registered', authorization.via === 'step_up'
          ? { via: authorization.via } : { via: authorization.via, codeId: authorization.codeId });
        await audit(tx, ctx.caller, 'passkey.new_device');
        return key;
      });
      if (!row) throw VaultError.reason('step_up_invalid');
      if (verification.row.registration!.via === 'recovery_code') ctx.components.alerts.raise({ kind: 'recovery_code_used', memberId: ctx.caller.memberId,
        spaceId: ctx.caller.spaceId, itemId: null, params: {}, at: ctx.clock.now().toISOString() });
      ctx.components.alerts.raise({ kind: 'passkey_new_device', memberId: ctx.caller.memberId,
        spaceId: ctx.caller.spaceId, itemId: null, params: {}, at: ctx.clock.now().toISOString() });
      return { data: passkeyView(row) };
    },

    'vault.passkeys.list': async (ctx) => {
      owner(ctx);
      return { data: { passkeys: await ctx.store.transaction(memberScope(ctx.caller), async (tx) => (await tx.passkeys.listForMember()).map(passkeyView)) } };
    },

    'vault.passkeys.revoke': async (ctx, { params, input }) => {
      const session = owner(ctx);
      const row = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const key = await tx.passkeys.get(params.passkeyId);
        if (!key) throw new VaultError('not_found');
        if (key.revokedAt === null && await tx.passkeys.countActive() === 1 && !input.confirmLast) throw VaultError.reason('last_passkey');
        const revoked = await tx.passkeys.revoke(key.id);
        const sessions = await tx.sessions.revokeForPasskey(key.id);
        for (const _ended of sessions) await audit(tx, ctx.caller, 'session.revoked', { code: 'passkey_revoked' });
        await audit(tx, ctx.caller, 'passkey.revoked');
        return revoked;
      });
      return { data: passkeyView(row), ...(row.id === session.passkeyId ? { setCookies: clearCookies() } : {}) };
    },

    'vault.sessions.list': async (ctx) => {
      const session = owner(ctx);
      return { data: { sessions: await ctx.store.transaction(memberScope(ctx.caller), async (tx) =>
        (await tx.sessions.listForMember()).map((row) => sessionView(row, session.sessionId))) } };
    },

    'vault.sessions.revoke': async (ctx, { params }) => {
      const session = owner(ctx);
      const row = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        if (!await tx.sessions.get(params.sessionId)) throw new VaultError('not_found');
        const row = await tx.sessions.revoke(params.sessionId, 'revoked');
        await audit(tx, ctx.caller, 'session.revoked');
        return row;
      });
      return { data: sessionView(row, session.sessionId), ...(row.id === session.sessionId ? { setCookies: clearCookies() } : {}) };
    },

    'vault.recovery.codes.create': async (ctx) => {
      owner(ctx);
      if (!ctx.stepUp) throw VaultError.reason('step_up_required');
      // Sequential hashing bounds peak memory at 64 MiB per request.
      const fresh = await newCodeBatch(10);
      const createdAt = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        await tx.recoveryCodes.replaceAll(fresh.map(({ id, hash }) => ({ id, hash })));
        await audit(tx, ctx.caller, 'recovery.codes_created');
        return tx.now;
      });
      return { data: { codes: fresh.map(({ code }) => code), createdAt } };
    },
  };
}
