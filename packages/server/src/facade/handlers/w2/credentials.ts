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
import {
  CollabError,
  CredentialProviderNameSchema,
  CredentialsServiceKeyPutInputSchema,
  CredentialsSpaceCreateInputSchema,
  CredentialsSpaceDefaultConsentInputSchema,
  CredentialsSpacePolicySetInputSchema,
  CredentialsSpaceRekeyInputSchema,
  CredentialsSpaceRenameInputSchema,
  CredentialsSpaceSetVisibilityInputSchema,
  NodeCredentialsPolicySetInputSchema,
  ServiceKeyProviderNameSchema,
  SpaceCredentialProviderNameSchema,
} from '@tm8/contract';
import type {
  CredentialProviderName,
  CredentialsLoginSessionStartInput,
  CredentialsServiceKeyDeleteResult,
  CredentialsServiceKeysStatusView,
  ServiceKeyProviderName,
  ServiceKeyView,
  SpaceCredentialProviderName,
} from '@tm8/contract';
import { OPERATIONS } from '@tm8/contract';
import type { OperationName } from '@tm8/contract';

import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import { DbGitHubCredentialStore } from '../../../credentials/github-credential-store.js';
import {
  DbServiceKeyStore,
  SERVICE_KEY_PROVIDERS,
  SERVICE_KEY_PROVIDER_NAMES,
} from '../../../credentials/service-key-store.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import {
  W2CredentialSessionsService,
  type CredentialPrincipal,
} from '../../services/w2/credential-sessions.js';
import { W2CredentialCatalogService } from '../../services/w2/credential-catalog.js';
import { DbSpaceCredentialStore } from '../../../credentials/space-credential-store.js';
import type { AgentSessionContainmentPort } from '../../../credentials/agent-session-containment.js';
import {
  createVendorProbe,
  type SpaceCredentialProbe,
} from '../../../credentials/space-credential-probe.js';
import {
  SpaceCredentialCatalogService,
  type CredentialStreamClosePort,
  spaceCredentialViewOf,
} from '../../services/w2/space-credential-catalog.js';
import { assertSpaceLoginProvider, SpaceLoginHomes } from '../../../credentials/space-credential-home.js';

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

/**
 * Read `:provider` off the path and check it before it names a directory.
 *
 * Validated against the CONTRACT SCHEMA rather than a literal list. This
 * function held its own restatement of the provider set, and when the set grew
 * to five that restatement silently kept rejecting the two new ones — a 400 on
 * a provider the credentials screen was already offering a card for. The schema
 * is the one place the set is stated, so it is the one place it can grow.
 */
function providerParam(ctx: RequestContext): CredentialProviderName {
  const parsed = CredentialProviderNameSchema.safeParse(ctx.params.provider);
  if (!parsed.success) {
    throw new CollabError(
      'invalid_input',
      `unsupported credential provider: ${String(ctx.params.provider)}`,
    );
  }
  return parsed.data;
}

/** `:provider` for the space and node credential operations. */
function spaceProviderParam(ctx: RequestContext): SpaceCredentialProviderName {
  const parsed = SpaceCredentialProviderNameSchema.safeParse(ctx.params.provider);
  if (!parsed.success) {
    throw new CollabError(
      'invalid_input',
      `unsupported space credential provider: ${String(ctx.params.provider)}`,
    );
  }
  return parsed.data;
}

/** A required path id. Its shape is the RPC's to refuse (22023). */
function pathParam(ctx: RequestContext, name: 'spaceId' | 'credentialId'): string {
  const value = ctx.params[name];
  if (!value) throw new CollabError('invalid_input', `${name} is required`);
  return value;
}

/**
 * The node-admin gate for `node.credentials.*`, layer 1: the bearer's
 * server-resolved `nodeAdmin`. Layer 2 is `internal.require_node_admin()`
 * inside `set_node_credential_policy`.
 */
function requireNodeAdmin(claims: { nodeAdmin?: boolean | undefined }): void {
  if (claims.nodeAdmin !== true) {
    throw new CollabError('forbidden', 'node credential settings are available to node admins only', {
      details: { reason: 'node_admin_required' },
    });
  }
}

/** `:provider` for the service-key operations — its own set, never an agent provider. */
function serviceKeyProviderParam(ctx: RequestContext): ServiceKeyProviderName {
  const parsed = ServiceKeyProviderNameSchema.safeParse(ctx.params.provider);
  if (!parsed.success) {
    throw new CollabError(
      'invalid_input',
      `unsupported service key provider: ${String(ctx.params.provider)}`,
    );
  }
  return parsed.data;
}

export interface CredentialHandlerDeps {
  /** Starts the login PTY. Built in the composition root; see `facade/index.ts`. */
  launcher: W2CredentialSessionsServiceLauncher;
  /**
   * Stops an AGENT session a credential containment takes away (the member
   * Disconnect, SC-3's delete) and records its ending: the runtime's
   * `SpawnService`. Login terminals stay on `launcher`.
   */
  agentSessions: AgentSessionContainmentPort;
  /** Node data root; the per-identity credential home hangs off it. */
  dataDir: string;
  /**
   * The server environment, read for ONE boolean per service key: whether the
   * node has a fallback key (`TYPESAFE_API_KEY`). Never forwarded. Defaults to
   * `process.env`.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** The vendor probe for pasted space keys (I6). Defaults to the real vendors. */
  probeSpaceCredential?: SpaceCredentialProbe;
  /**
   * R9: W10c's closer for attach/watch streams a credential no longer
   * permits, called after a switch to private and a revoke. Optional.
   */
  streams?: CredentialStreamClosePort;
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
  // One instance for the login service and delete, so a promote and a home
  // removal are serialised by the same per-credential lock (M6).
  const spaceHomes = new SpaceLoginHomes({ dataDir: credentials.dataDir });
  const spaceStore = new DbSpaceCredentialStore({ db: deps.db, dataDir: credentials.dataDir });
  const sessions = new W2CredentialSessionsService({
    db: deps.db,
    launcher: credentials.launcher,
    dataDir: credentials.dataDir,
    spaceStore,
    spaceHomes,
    storeGitCredential: ({ claims, login, token }) =>
      gitHubStore.store(claims, { login, token }),
  });
  const catalog = new W2CredentialCatalogService({
    db: deps.db,
    terminals: credentials.launcher,
    agentSessions: credentials.agentSessions,
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
        ...(body.spaceCredential === undefined ? {} : { spaceCredential: body.spaceCredential }),
      },
      await principalFor(deps, ctx),
    ).then(({ spaceCredential, ...started }) => ({
      ...started,
      ...(spaceCredential ? { spaceCredential: spaceCredentialViewOf(spaceCredential) } : {}),
    }));
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
      ...(finished.spaceCredential ? { spaceCredential: spaceCredentialViewOf(finished.spaceCredential) } : {}),
    };
  };

  // -- service keys (Lane K): keys tm8 uses server-side, never agent credentials.
  const serviceKeys = new DbServiceKeyStore({ db: deps.db, dataDir: credentials.dataDir });
  const env = credentials.env ?? process.env;
  const nodeFallback = (provider: ServiceKeyProviderName): boolean =>
    Boolean(env[SERVICE_KEY_PROVIDERS[provider].nodeEnvVar]?.trim());
  const viewOf = (
    provider: ServiceKeyProviderName,
    stored: { keyHint: string; updatedAt: string } | undefined,
  ): ServiceKeyView => ({
    provider,
    connected: stored !== undefined,
    keyHint: stored?.keyHint ?? null,
    updatedAt: stored?.updatedAt ?? null,
    nodeFallback: nodeFallback(provider),
  });

  const serviceKeyStatus: OperationHandler = async (ctx): Promise<CredentialsServiceKeysStatusView> => {
    const { claims } = await principalFor(deps, ctx);
    const present = await serviceKeys.present(claims);
    const rows = present ? await serviceKeys.status(claims) : [];
    return {
      keys: SERVICE_KEY_PROVIDER_NAMES.map((provider) =>
        viewOf(provider, rows.find((row) => row.provider === provider))),
      store: present ? 'present' : 'absent',
    };
  };

  const serviceKeyPut: OperationHandler = async (ctx): Promise<ServiceKeyView> => {
    const provider = serviceKeyProviderParam(ctx);
    // Re-parsed here for the TRIMMED key; the facade has already refused a bad
    // body. The key is never echoed — only its last four characters return.
    const { apiKey } = CredentialsServiceKeyPutInputSchema.parse(ctx.body);
    const { claims } = await principalFor(deps, ctx);
    return viewOf(provider, await serviceKeys.put(claims, provider, apiKey));
  };

  const serviceKeyDelete: OperationHandler = async (ctx): Promise<CredentialsServiceKeyDeleteResult> => {
    const provider = serviceKeyProviderParam(ctx);
    const { claims } = await principalFor(deps, ctx);
    // Idempotent: an absent key is already the state asked for. No session is
    // killed — no session ever held this key.
    await serviceKeys.delete(claims, provider);
    return { provider, revoked: true };
  };

  // -- space credentials (SC-3): shared by a space, managed per D11 in SQL.
  const spaceCatalog = new SpaceCredentialCatalogService({
    db: deps.db,
    store: spaceStore,
    probe: credentials.probeSpaceCredential ?? createVendorProbe(),
    terminals: credentials.launcher,
    // A login terminal is closed through the login registry — killed, then
    // stamped — and its home removed under the promote lock (SC-4).
    closeLogin: (claims, workSessionId) => sessions.closeSpaceLogin(claims, workSessionId),
    removeLoginHome: (home) => spaceHomes.remove(home),
    scrubForeignLaunches: (home, launches) => {
      assertSpaceLoginProvider(home.provider);
      return spaceHomes.scrubForeignLaunches({ ...home, provider: home.provider }, launches);
    },
    agentSessions: credentials.agentSessions,
    env,
    ...(credentials.streams ? { streams: credentials.streams } : {}),
  });
  const claimsOf = async (ctx: RequestContext) => (await principalFor(deps, ctx)).claims;

  const spaceList: OperationHandler = async (ctx) =>
    spaceCatalog.list(await claimsOf(ctx), pathParam(ctx, 'spaceId'));

  const spaceCreate: OperationHandler = async (ctx) => {
    // Re-parsed for the TRIMMED secret and label; the facade already refused a bad body.
    const { provider, shape, label, secret, visibility, spaceOwned, mayBeSpaceDefault } =
      CredentialsSpaceCreateInputSchema.parse(ctx.body);
    return spaceCatalog.create(await claimsOf(ctx), pathParam(ctx, 'spaceId'), {
      provider,
      shape,
      label,
      secret,
      ...(visibility !== undefined ? { visibility } : {}),
      ...(spaceOwned !== undefined ? { spaceOwned } : {}),
      ...(mayBeSpaceDefault !== undefined ? { mayBeSpaceDefault } : {}),
    });
  };

  const spaceRekey: OperationHandler = async (ctx) => {
    const { secret } = CredentialsSpaceRekeyInputSchema.parse(ctx.body);
    return spaceCatalog.rekey(await claimsOf(ctx), pathParam(ctx, 'credentialId'), secret);
  };

  const spaceSetDefault: OperationHandler = async (ctx) =>
    spaceCatalog.setDefault(await claimsOf(ctx), pathParam(ctx, 'credentialId'));

  const spaceRename: OperationHandler = async (ctx) => {
    const { label } = CredentialsSpaceRenameInputSchema.parse(ctx.body);
    return spaceCatalog.rename(await claimsOf(ctx), pathParam(ctx, 'credentialId'), label);
  };

  const spaceDelete: OperationHandler = async (ctx) =>
    spaceCatalog.delete(await claimsOf(ctx), pathParam(ctx, 'credentialId'));

  // -- W10b: ownership and visibility (doc 13 §8). Every rule is in SQL.
  const spaceSetVisibility: OperationHandler = async (ctx) => {
    const { visibility } = CredentialsSpaceSetVisibilityInputSchema.parse(ctx.body);
    return spaceCatalog.setVisibility(await claimsOf(ctx), pathParam(ctx, 'credentialId'), visibility);
  };

  const spaceDefaultConsent: OperationHandler = async (ctx) => {
    const { allowed } = CredentialsSpaceDefaultConsentInputSchema.parse(ctx.body);
    return spaceCatalog.setSpaceDefaultConsent(await claimsOf(ctx), pathParam(ctx, 'credentialId'), allowed);
  };

  const spaceClaim: OperationHandler = async (ctx) =>
    spaceCatalog.claim(await claimsOf(ctx), pathParam(ctx, 'credentialId'));

  const spaceMyDefaultSet: OperationHandler = async (ctx) =>
    spaceCatalog.setMyDefault(await claimsOf(ctx), pathParam(ctx, 'credentialId'));

  const spaceMyDefaultClear: OperationHandler = async (ctx) =>
    spaceCatalog.clearMyDefault(await claimsOf(ctx), pathParam(ctx, 'spaceId'), spaceProviderParam(ctx));

  const spaceUsage: OperationHandler = async (ctx) =>
    spaceCatalog.usage(await claimsOf(ctx), pathParam(ctx, 'credentialId'));

  const spacePolicyGet: OperationHandler = async (ctx) =>
    spaceCatalog.policy(await claimsOf(ctx), pathParam(ctx, 'spaceId'));

  const spacePolicySet: OperationHandler = async (ctx) => {
    const { allowedSources } = CredentialsSpacePolicySetInputSchema.parse(ctx.body);
    return spaceCatalog.setPolicy(
      await claimsOf(ctx),
      pathParam(ctx, 'spaceId'),
      spaceProviderParam(ctx),
      allowedSources,
    );
  };

  const nodeStatus: OperationHandler = async (ctx) => {
    const claims = await claimsOf(ctx);
    requireNodeAdmin(claims);
    return spaceCatalog.nodeStatus(claims);
  };

  const nodePolicySet: OperationHandler = async (ctx) => {
    const provider = spaceProviderParam(ctx);
    const { allowNode } = NodeCredentialsPolicySetInputSchema.parse(ctx.body);
    const claims = await claimsOf(ctx);
    requireNodeAdmin(claims);
    return spaceCatalog.setNodePolicy(claims, provider, allowNode);
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
    'credentials.serviceKeys.status': requireHumanSession(serviceKeyStatus),
    'credentials.serviceKeys.put': requireHumanSession(serviceKeyPut),
    'credentials.serviceKeys.delete': requireHumanSession(serviceKeyDelete),
    'credentials.space.list': requireHumanSession(spaceList),
    'credentials.space.create': requireHumanSession(spaceCreate),
    'credentials.space.rekey': requireHumanSession(spaceRekey),
    'credentials.space.setDefault': requireHumanSession(spaceSetDefault),
    'credentials.space.rename': requireHumanSession(spaceRename),
    'credentials.space.delete': requireHumanSession(spaceDelete),
    'credentials.space.setVisibility': requireHumanSession(spaceSetVisibility),
    'credentials.space.spaceDefaultConsent': requireHumanSession(spaceDefaultConsent),
    'credentials.space.claim': requireHumanSession(spaceClaim),
    'credentials.space.myDefault.set': requireHumanSession(spaceMyDefaultSet),
    'credentials.space.myDefault.clear': requireHumanSession(spaceMyDefaultClear),
    'credentials.space.usage': requireHumanSession(spaceUsage),
    'credentials.space.policy.get': requireHumanSession(spacePolicyGet),
    'credentials.space.policy.set': requireHumanSession(spacePolicySet),
    'node.credentials.status': requireHumanSession(nodeStatus),
    'node.credentials.policy.set': requireHumanSession(nodePolicySet),
  });
}

/**
 * Every `credentials.*` and `node.credentials.*` operation IN THE CATALOG —
 * derived, never listed.
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
  .filter((name): name is OperationName =>
    name.startsWith('credentials.') || name.startsWith('node.credentials.'));
