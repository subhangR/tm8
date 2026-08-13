/**
 * `credentials.*` — registration, request adaptation, and the human-only guard.
 *
 * ===========================================================================
 * R2 — ALL FOUR OPERATIONS ARE HUMAN-ONLY, `status` INCLUDED
 * ===========================================================================
 *
 * This is the reason this file exists in the shape it does, and it is a
 * MEASURED conclusion (review sub-doc 14, finding C7) rather than a defensive
 * habit:
 *
 *   `issue_agent_auth_session` binds the SPAWNING HUMAN'S account. The
 *   `acting_as_team_member_id` column constrains `internal.resolve_actor` and
 *   NOTHING ELSE — `internal.identity_id()`, `internal.can_act_as`,
 *   `internal.is_space_member` and `internal.entity_readable` all key off
 *   identity. An agent holding `TM8_AGENT_TOKEN` therefore carries its owner's
 *   FULL identity, not a reduced principal.
 *
 * Without a guard, an agent could read its owner's credential status, DELETE
 * their token, and open a login terminal in their name. `status` is included
 * deliberately: least privilege — no agent workflow needs it, and it leaks
 * login and email metadata. If a genuine agent need ever appears ("will my
 * spawn have credentials?"), expose a separate boolean-per-provider operation.
 * Do not open `status`.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE WRAPPER AT REGISTRATION AND NOT FOUR INLINE CHECKS
 * ---------------------------------------------------------------------------
 *
 * `requireHumanSession` is applied by mapping over the registration record, so
 * the guard is a property of the GROUP rather than of each member of it. Four
 * copies would be four places to be correct, and — the failure that actually
 * happens — a fifth operation added later would be born unguarded, looking
 * exactly like its four guarded neighbours. Here a new entry in the object
 * below is guarded by construction, and `registerCredentialHandlers` has no
 * form in which an operation is registered without passing through the wrapper.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE GUARD READS, AND WHAT IT REFUSES TO READ
 * ---------------------------------------------------------------------------
 *
 * `ctx.identity.authKind` ONLY. That field is the verified `auth_sessions.kind`
 * that `resolveBearerIdentity` looked up BY TOKEN HASH — server-resolved, never
 * client-asserted. No header, no body field and no query parameter is consulted,
 * because any of those would let the caller answer the question about itself.
 *
 * It FAILS CLOSED. Anything that is not exactly `browser` or `cli` is refused,
 * including `undefined` — a request whose resolver did not establish a kind is
 * refused rather than admitted. An allowlist rather than `!== 'agent'`, so a
 * `agent_runtime` (and any later kind) is refused instead of silently
 * inheriting credential access.
 *
 * This is layer 1 of two. Layer 2 is `internal.require_human_auth_kind()`
 * inside all four SECURITY DEFINER RPCs, reading the `tm8.auth_kind` claim
 * bound by PR2. Either alone would stop the attack; both are here because this
 * one is the readable one and that one is the one that cannot be bypassed by a
 * future caller who reaches the RPCs another way.
 */
import { CollabError } from '@tm8/contract';
import type {
  CredentialProviderName,
  CredentialsLoginSessionStartInput,
} from '@tm8/contract';
import { OPERATIONS } from '@tm8/contract';
import type { OperationName } from '@tm8/contract';

import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import { DbGitHubCredentialStore } from '../../../credentials/github-credential-store.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import {
  W2CredentialSessionsService,
  type CredentialPrincipal,
} from '../../services/w2/credential-sessions.js';
import { W2CredentialCatalogService } from '../../services/w2/credential-catalog.js';

/**
 * The session kinds that may reach `credentials.*`.
 *
 * `cli` is here on purpose and it is not an oversight: a human at a terminal
 * has exactly the entitlement of a human in the settings screen. What the guard
 * separates is HUMAN from AGENT, not browser from everything else.
 */
const HUMAN_AUTH_KINDS: readonly string[] = ['browser', 'cli'];

/** The typed refusal code. Stable, and asserted by test. */
export const CREDENTIALS_HUMAN_ONLY = 'credentials_human_only';

/**
 * Refuse a caller whose auth session kind is not human.
 *
 * Exported so a registration-shape test can prove that every `credentials.*`
 * handler on the registry is this function's return value, rather than proving
 * it four times by behaviour and missing the fifth operation somebody adds.
 */
export function requireHumanSession(handler: OperationHandler): OperationHandler {
  return async (ctx) => {
    const kind = ctx.identity.authKind;
    if (kind === undefined || !HUMAN_AUTH_KINDS.includes(kind)) {
      throw new CollabError(
        'forbidden',
        'credential operations are available to human sessions only',
        { details: { reason: CREDENTIALS_HUMAN_ONLY } },
      );
    }
    return handler(ctx);
  };
}

/**
 * Build the principal the credential services take.
 *
 * BOTH FIELDS ARE SERVER-RESOLVED. `claimsFor` derives the claims envelope from
 * the resolved bearer (or the loopback owner), and it carries the `authKind`
 * claim PR2 binds — which is what makes layer 2 work. The identity id is read
 * from the same resolved principal.
 *
 * NO `actorId` IS EVER PASSED, and that is finding D2: `internal.resolve_actor`
 * exists so a caller can act AS a teammate, and a credential operation is the
 * one thing that must never happen on someone else's behalf. The DTOs do not
 * declare the field, the strict schemas refuse it on the wire, and
 * `W2CredentialSessionsService.start` throws if it arrives in the envelope
 * anyway. Three independent layers, because "we simply do not set it" is
 * invisible to a reviewer and to a future edit.
 */
async function principalFor(
  deps: FacadeDeps,
  ctx: RequestContext,
): Promise<CredentialPrincipal> {
  const owner = await deps.owner();
  const claims = claimsFor(owner, ctx);
  const identityId = claims.identityId;
  if (!identityId) {
    throw new CollabError('unauthenticated', 'no identity resolved for this request');
  }
  return { claims, identityId };
}

/** Read `:provider` off the path and check it before it names a directory. */
function providerParam(ctx: RequestContext): CredentialProviderName {
  const raw = ctx.params.provider;
  if (raw !== 'anthropic' && raw !== 'openai' && raw !== 'github') {
    throw new CollabError('invalid_input', `unsupported credential provider: ${String(raw)}`);
  }
  return raw;
}

export interface CredentialHandlerDeps {
  /** Starts the login PTY. Built in the composition root; see `facade/index.ts`. */
  launcher: W2CredentialSessionsServiceLauncher;
  /** Node data root; the per-identity credential home hangs off it. */
  dataDir: string;
}

/** Structural alias so this module does not import `@tm8/execution` for a type. */
type W2CredentialSessionsServiceLauncher =
  ConstructorParameters<typeof W2CredentialSessionsService>[0]['launcher'];

/**
 * Mount the four credential operations, every one of them guarded.
 *
 * ===========================================================================
 * WHY THE GUARD IS SPELLED FOUR TIMES AND NOT MAPPED OVER THE RECORD
 * ===========================================================================
 *
 * R2 asks for "one wrapper around all four registrations, not four inline
 * checks a fifth op could forget", and the first implementation of this
 * function did exactly that — built a plain record and looped
 * `requireHumanSession` over it before calling `registerAll`.
 *
 * IT IS NOT ALLOWED, and the thing that refuses it is worth more than the
 * convenience it costs. `tools/conformance/src/foundations/source-inventory.ts`
 * PARSES THIS FILE and requires `registry.registerAll` to receive an object
 * LITERAL with literal keys (`:74`, `:82`). It builds the mounted-operation
 * inventory by reading source rather than by running the server, so a computed
 * record makes the operations this seam mounts invisible to conformance —
 * which is the same class of dishonesty the guard exists to prevent.
 *
 * So the literal stays, and R2's actual concern — that a fifth operation is
 * born unguarded — is met by the mechanism R2 itself names as the accepted
 * floor: **a registration-shape test asserting every `credentials.*` operation
 * passes through the guard**. That test derives its list from the CATALOG, not
 * from a hand-maintained constant, so adding a fifth `credentials.*` row makes
 * it fail until the row is registered here and guarded. A human forgetting is
 * caught by a machine, which is strictly better than a loop no one can audit.
 *
 * There is still exactly ONE guard function. What is repeated is its
 * application, in an auditable literal, beside the operation name it protects.
 */
export function registerCredentialHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  credentials: CredentialHandlerDeps,
): void {
  const gitHubStore = new DbGitHubCredentialStore({
    db: deps.db,
    dataDir: credentials.dataDir,
  });
  const sessions = new W2CredentialSessionsService({
    db: deps.db,
    launcher: credentials.launcher,
    dataDir: credentials.dataDir,
    storeGitCredential: ({ claims, login, token }) =>
      gitHubStore.store(claims, { login, token }),
  });
  const catalog = new W2CredentialCatalogService({
    db: deps.db,
    terminals: credentials.launcher,
    dataDir: credentials.dataDir,
    revokeGitCredential: ({ principal }) => gitHubStore.delete(principal.claims),
  });

  // The node's own registry sweep (R10 element 1): expired or PTY-less login
  // terminals are finished without waiting for the member to come back.
  sessions.startSweep();

  const status: OperationHandler = async (ctx) => catalog.status(await principalFor(deps, ctx));

  const disconnect: OperationHandler = async (ctx) =>
    catalog.delete(providerParam(ctx), await principalFor(deps, ctx));

  const startLogin: OperationHandler = async (ctx) => {
    const body = ctx.body as CredentialsLoginSessionStartInput;
    return sessions.start(
      {
        spaceId: body.spaceId,
        provider: body.provider,
        ...(body.cols === undefined ? {} : { cols: body.cols }),
        ...(body.rows === undefined ? {} : { rows: body.rows }),
      },
      await principalFor(deps, ctx),
    );
  };

  const finishLogin: OperationHandler = async (ctx) => {
    const workSessionId = ctx.params.id;
    if (!workSessionId) {
      throw new CollabError('invalid_input', 'a work session id is required');
    }
    const finished = await sessions.finish({ workSessionId }, await principalFor(deps, ctx));
    // `connected` and `stored` are flattened out of the probe deliberately: the
    // wire contract states them as two separate facts, because a verified
    // GitHub login on this line is `connected: true, stored: false`.
    return {
      workSessionId: finished.workSessionId,
      provider: finished.provider,
      connected: finished.probe.connected,
      login: finished.probe.login,
      authMethod: finished.probe.authMethod,
      status: finished.probe.status,
      stored: finished.stored,
      terminated: finished.terminated,
    };
  };

  // EVERY VALUE HERE IS `requireHumanSession(...)`. An entry that is not is a
  // credential operation reachable by an agent holding its owner's identity.
  // `credentials-registration` in the test suite asserts this over the catalog,
  // so a fifth row cannot be added unguarded without something going red.
  registry.registerAll({
    'credentials.status': requireHumanSession(status),
    'credentials.delete': requireHumanSession(disconnect),
    'credentials.loginSessions.start': requireHumanSession(startLogin),
    'credentials.loginSessions.finish': requireHumanSession(finishLogin),
  });
}

/**
 * Every `credentials.*` operation IN THE CATALOG — derived, never listed.
 *
 * This is the load-bearing half of the "a fifth operation cannot be born
 * unguarded" guarantee. A hand-written constant would have to be updated by the
 * same person who forgot to guard the new operation, so it would agree with the
 * mistake. Deriving it from `OPERATIONS` means adding a `credentials.*` row to
 * the catalog immediately puts it in front of the guard test, and the test
 * fails until it is registered here — wrapped, because the registration above
 * has no unwrapped form.
 */
export const CREDENTIAL_OPERATIONS: readonly OperationName[] = OPERATIONS
  .map((op) => op.name)
  .filter((name): name is OperationName => name.startsWith('credentials.'));
