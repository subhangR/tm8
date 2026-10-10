# Chat harness foundation: credentials and capabilities

Status: design proposal for coordinator convergence; no implementation in this change.
Baseline: `bad53675b`, including PR1156's shared resolver and PR1158's chat credential picker and claim-time snapshots.
Owner: credentials lane, task `01a1259f-ee8f-7fa6-b551-eb48bf76f6ba`.
Companion lanes: runtime `01a1259f-ecef-7c13-8883-892ba4a68877`; continuity `01a1259f-edda-7eb3-b432-499756c142ff`.

## 1. Decision and existing behavior

tm8 owns the chat's credential intent, the authorization provenance of each claimed turn, and the observable runtime generation. A credential port resolves and rechecks account grants; a capability port resolves the tool/connector/skill surface; the runtime coordinator owns their leases and cleanup. Neither port owns transcript continuity or starts a model process.

The existing [chat resolver](../../packages/server/src/chat/credentials.ts) calls [resolveSessionCredentials](../../packages/execution/src/spawn/credential-resolution.ts) with `modelOnly: true`. Preserve its policy gates, link restrictions, explicit-choice refusal, and automatic ladder: personal space default, connected member credential, space default, node when permitted. An existing but unusable/decryption-failed default refuses; automatic selection does not skip a broken account. Only absence and policy-excluded rungs permit the documented descent.

[Migration 314](../../db/migrations/314_chat_credential_selection.sql) records chat credential intent and captures it when a turn is claimed. The [orchestrator](../../packages/server/src/chat/orchestrator.ts) rechecks environment fingerprints, separates model resolution from MCP minting, and rechecks after asynchronous startup. These are useful protections to retain. Its environment return value does not expose the selected account's durable identity, authorization epoch, or home generation. Its `live` marker is written before adapter startup completes. A native session identifier alone cannot prove that another credential home contains the conversation.

[Current documentation](../credentials/chat-model-credentials.md) explicitly describes context loss when a changed account directory lacks the transcript. Replace that behavior through the continuity port. Keep the selected account and the portable conversation independent. Do not copy entire credential homes or pretend an unavailable native transcript was resumed.

## 2. Non-negotiable invariants

1. Provider and route derive from an admitted `(model, harness)` catalog entry. A client-supplied provider, home path, environment map, or auth kind is never authority.
2. The turn's verified human authorization provenance governs all credential and connector reads. A teammate's owner, the chat creator, or the previous turn's human cannot lend an account to the current turn.
3. Explicit source/pin means that source/pin or a refusal. Automatic resolution alone follows the shared ladder. A source restriction is checked on every relevant resolution and reuse, including inherited intent.
4. Picker, model, harness, skill and connector edits affect the next **claimed** turn. A claimed turn is immutable. Security revocations affect current authorization immediately and never silently migrate an in-flight turn to another account.
5. A runtime becomes effective only after boot, continuity verification and a generation-fenced authorization recheck. Starting is a truthful separate state. No model prompt is sent while it is merely starting.
6. Every replacement generation uses a committed tm8 conversation checkpoint. An empty-history start is valid only for a conversation with no committed prior history. Prior completed side effects are historical context, never calls to execute again.
7. Credential material, account paths and runtime bearer secrets stay out of graph entities, public state, telemetry, transcript, checkpoint payloads and adapter error messages. The adapter necessarily receives its model authentication material inside a trusted process boundary.
8. MCP vendor secrets stay at the connector proxy. MCP runtime grants and model login credentials are independent. A preview/reuse check mints no token and rewrites no live credential home.

## 3. Model-derived provider requirements and stored intent

Distinguish the harness's native authentication provider, the inference backend, and the policy namespace. They may differ. Reuse the existing tool/provider table and model backend routing; do not introduce a second precedence table in chat.

| Admitted route | Native provider | Inference credential | Current policy namespace | Supported sources |
| --- | --- | --- | --- | --- |
| Claude Code, native Anthropic model | anthropic | anthropic | anthropic | auto/member/space/node |
| Claude Code, Kimi backend model | anthropic | kimi | anthropic | auto/member, both resolving the human's Kimi key |
| Codex, native OpenAI model | openai | openai | openai | auto/member/space/node after its chat adapter is admitted |
| Codex, Groq backend model | openai | groq | openai | auto/member after its chat adapter is admitted |
| Unknown harness, incompatible model, unimplemented adapter | none | none | none | refuse before token mint or filesystem mutation |

The backend policy column deliberately preserves the shared resolver's existing D5 rule. A Kimi key is governed by the Anthropic tool's member-source policy, and a Groq key by OpenAI's. Moving policy to backend namespaces would be a separate policy migration, never a chat-only reinterpretation. The existing chat resolver adds an explicit backend/node refusal; preserve it in this port even though the session resolver's backend branch currently has looser node wording. Backend routes cannot use an Anthropic/OpenAI space credential pin. Adapter admission is independent of credential availability: an OpenAI account alone does not make Codex chat supported.

Retain the merged picker's single `{ source, credentialId? }` chat selection. Sources express account intent and can be retained across providers; pins are scoped to the **inference credential provider**. A cross-provider model switch with an incompatible pin refuses unless the same atomic configuration write supplies a compatible selection. Never replace the pin with Auto or a different default as a side effect of switching models. A UI may remember choices locally, but must explicitly submit the selected target choice; remembered UI state is not server authority.

Examples: unpinned `member` follows Anthropic→OpenAI and reads the human's OpenAI account. Unpinned `space` resolves the target provider's space default; unpinned `node` retains node intent subject to target policy/route. An Anthropic space pin followed by an OpenAI model-only write returns `requires_choice` with no configuration change. A combined model/selection write can deliberately choose Auto or a compatible OpenAI pin. `node`→Kimi refuses unless that write chooses auto/member. Same-provider model changes retain their pin and still refuse if inaccessible. Auto is re-resolved through the ladder for each claim.

Extend `chat.setModel` to accept optional `reasoningEffort` and optional `credentialSelection` in the same candidate configuration; keep `chat.setCredentials` for selection-only changes. A source-only write never changes the model. Credential option listing accepts a catalog model/harness selection and derives the provider server-side; remove the current Anthropic-only assumption. Responses show the derived target provider, supported sources, saved selection and safe preview. Model/harness changes must not implicitly change personal/space defaults.

Existing `{ source, credentialId? }` stays wire-compatible. Infer a pin's provider from authorized credential metadata and the recorded route, not from a guessed `'anthropic'` fallback. A contradictory or unreadable legacy binding becomes a visible `requires_choice` state; never relabel the secret. Existing turns retain their recorded intent for audit. Auth/home material revisions need migration, but the picker does not require a new multi-provider selection format.

## 4. TypeScript boundary contracts

These are proposed standalone contracts. Identifier brands, catalog entries, permissions and continuity types should converge with the sibling documents before implementation; they are not new public endpoints by themselves. `ResolvedCredentialPlan` and `EffectiveCapabilities` are server-internal metadata; DTOs use the narrower projections in section 9.

```ts
type Id = string;
type Revision = number;
type Provider = 'anthropic' | 'openai' | 'kimi' | 'groq';
type HarnessId = string; // validated against the admitted adapter registry
type Source = 'member' | 'space' | 'node';
type UnpinnedChoice = Readonly<{
  source: 'auto' | Source; credentialId?: never;
}>;
type CredentialChoice = UnpinnedChoice | Readonly<{
  source: 'space'; credentialId: Id;
}>;

type CredentialIntent = CredentialChoice;

interface ModelCredentialRequirement {
  readonly catalogRevision: Revision;
  readonly modelId: string;
  readonly harnessId: HarnessId;
  readonly nativeProvider: 'anthropic' | 'openai';
  readonly inferenceProvider: Provider;
  readonly policyProvider: 'anthropic' | 'openai';
  readonly routeId: string; // server-owned endpoint/protocol identity
  readonly allowedChoices: readonly ('auto' | Source)[];
}

interface TurnAuthorizer {
  readonly identityId: Id;
  readonly authKind: string; // verified, persisted provenance; never client text
  readonly authoritySessionId: Id;
  readonly viaLinkId: Id | null;
  readonly authorityRevision: Revision;
}

interface ClaimedChatConfig {
  readonly chatId: Id;
  readonly spaceId: Id;
  readonly turnId: Id;
  readonly desiredRevision: Revision;
  readonly claimFence: string;
  readonly authorizer: TurnAuthorizer;
  readonly requirement: ModelCredentialRequirement;
  readonly credentialIntent: CredentialIntent;
  readonly capabilities: CapabilityIntent;
  readonly chatMode: string;
  readonly reasoningEffort: string | null;
}

interface AuthorizationStamp {
  readonly membershipRevision: Revision;
  readonly authorityRevision: Revision;
  readonly spacePolicyRevision: Revision;
  readonly nodePolicyRevision: Revision;
  readonly credentialAccessRevision: Revision;
}

interface ResolvedCredentialPlan {
  readonly planId: string; // short-lived server record, bound to this claim
  readonly requirement: ModelCredentialRequirement;
  readonly requestedChoice: CredentialChoice;
  readonly effectiveSource: Source;
  readonly resolutionReason:
    | 'personal_default' | 'member' | 'space_default' | 'node' | 'pinned';
  readonly credentialRef: Readonly<{
    provider: Provider;
    credentialId: Id | null; // space credential only
    accountScopeId: string; // opaque member/node account binding, no path
    accountGeneration: Revision;
    materialRevision: Revision;
    homeScopeId: string;
    homeGeneration: Revision;
  }>;
  readonly authorization: AuthorizationStamp;
  readonly reuseKey: string; // digest of nonsensitive, canonical metadata
  readonly expiresAt: string;
}

interface RuntimeGeneration {
  readonly chatId: Id;
  readonly generation: number;
  readonly ownerLeaseId: string;
  readonly claimFence: string;
}

interface ModelCredentialLease {
  readonly leaseId: string;
  readonly owner: RuntimeGeneration;
  readonly planId: string;
  readonly loadedMaterialRevision: Revision;
  // Native resume is compatible only inside this opaque namespace.
  readonly nativeStorageScopeId: string;
  readonly nativeStorageGeneration: Revision;
}

type Revalidation =
  | Readonly<{ kind: 'valid'; stamp: AuthorizationStamp }>
  | Readonly<{ kind: 'replace'; reason: 'account_changed' | 'material_changed'
      | 'home_changed' | 'capabilities_changed' }>
  | Readonly<{ kind: 'refused'; code: 'forbidden' | 'unavailable' | 'revoked' }>;

interface ChatCredentialPort {
  resolve(config: ClaimedChatConfig): Promise<ResolvedCredentialPlan>;
  revalidate(plan: ResolvedCredentialPlan, owner?: RuntimeGeneration):
    Promise<Revalidation>;
  acquire(plan: ResolvedCredentialPlan, owner: RuntimeGeneration):
    Promise<ModelCredentialLease>;
  release(lease: ModelCredentialLease): Promise<void>; // idempotent, exact owner
}

interface ConnectorChoice {
  readonly connectorId: Id;
  readonly credentialId?: Id; // mandatory for an authenticated connector
  readonly required: boolean;
}
interface CapabilityIntent {
  readonly toolIds: readonly string[]; // stable semantic ids, not adapter argv
  readonly connectors: readonly ConnectorChoice[];
  readonly skills: readonly Readonly<{ skillId: Id; required: boolean }>[];
}
interface EffectiveCapabilities {
  readonly planId: string;
  readonly digest: string;
  readonly surfaceRevision: Revision;
  readonly exposedToolIds: readonly string[];
  readonly preapprovedToolIds: readonly string[];
  readonly connectors: readonly Readonly<{
    connectorId: Id; credentialId?: Id; definitionRevision: Revision;
    accountGeneration: Revision; accessRevision: Revision;
  }>[];
  readonly skills: readonly Readonly<{
    skillId: Id; contentRevision: Revision;
    delivery: 'native' | 'indexed'; contentHash: string;
  }>[];
  readonly unavailable: readonly Readonly<{
    refId: string; reason: 'unsupported' | 'unavailable' | 'forbidden';
  }>[];
}
interface ChatCapabilityPort {
  resolve(config: ClaimedChatConfig, model: ResolvedCredentialPlan):
    Promise<EffectiveCapabilities>;
  revalidate(plan: EffectiveCapabilities, owner: RuntimeGeneration):
    Promise<Revalidation>;
}

interface RuntimeGrantLease {
  readonly grantId: Id; // not the bearer value
  readonly owner: RuntimeGeneration;
  readonly authoritySessionId: Id;
  readonly expiresAt: string;
  readonly capabilityDigest: string;
}
interface ChatRuntimeGrantPort {
  acquire(config: ClaimedChatConfig, owner: RuntimeGeneration,
    capabilities: EffectiveCapabilities): Promise<RuntimeGrantLease>;
  activate(lease: RuntimeGrantLease): Promise<void>; // generation CAS
  revoke(lease: RuntimeGrantLease): Promise<void>; // generation-scoped
}

interface CredentialBootResources {
  readonly modelLease: ModelCredentialLease;
  readonly runtimeGrant: RuntimeGrantLease;
  readonly capabilities: EffectiveCapabilities;
}
interface RuntimeBinding {
  readonly bindingId: string;
  readonly revision: Revision;
  readonly credentialPlanId: string;
  readonly compatibilityFingerprint: string;
  readonly capabilityDigest: string;
  readonly storageNamespace: Readonly<{ scopeId: string; generation: Revision }>;
}
declare const preparedLaunchTag: unique symbol;
interface PreparedLaunch {
  readonly [preparedLaunchTag]: true; // opaque, node-local, never durable
  readonly handleId: string;
  readonly owner: RuntimeGeneration;
  readonly binding: RuntimeBinding; // only this metadata is durable
}
// Implementation-only bridge. Never serialize its handles/output to a DTO.
interface TrustedCredentialBootBridge {
  prepare(resources: CredentialBootResources): Promise<PreparedLaunch>;
  withAdapterResources<T>(launch: PreparedLaunch,
    run: (input: Readonly<{
      env: Readonly<Record<string, string>>;
      modelConfigDir: string;
      mcpConfigPath: string;
    }>) => Promise<T>): Promise<T>;
}
```

The bridge is deliberately separate from serializable plans. `acquire` creates generation-owned, least-privilege material, and the bridge makes it available only to the trusted adapter. Passing a lease ID over a client endpoint does not confer access: the owning claim, generation, node and verified server identity must match. All expiry decisions use server time.

`resolve` is side-effect-free with respect to runtime resources: no home rewrite, token mint, connector process or vendor refresh. It may check decryptability server-side and return a safe refusal, but cannot return plaintext or an unsanitized crypto failure. Public preview uses the same authorized resolution logic and does not acquire a plan for arbitrary client-selected identities.

## 5. Validation and authorization ownership

The chat configuration writer accepts only intent, catalog model/harness IDs, a mutation ID and an expected configuration revision. Strict schemas reject unknown fields, unknown provider keys, malformed IDs, duplicate connector/skill IDs, and pins under sources other than space. Bounded list sizes follow existing MCP/skill contract limits. Validate model/harness/credential/capability changes as one candidate configuration and commit atomically. Do not persist a model change then discover that its explicit credential was incompatible.

Human-gated settings operations remain human-gated. A model may request a configuration change through an exposed action, but cannot manufacture a human auth kind or connect/share credentials. Verify configured-by authority and membership at configuration write; verify the actual turn authorizer at claim, resolution and runtime publication. A settings preview by human A is advisory for human B's later turn. B's claim resolves against B's authority and receives a refusal if an A-private pin or connector account is unavailable.

Carry the server-verified `requestedBy` chain used by the current orchestrator when a turn originates through delegation. The final human provenance must remain verifiable and currently authorized. A missing legacy auth kind/session is a fail-closed reauthorization requirement, not a claim guessed from the chat creator. Teammate identity determines persona and graph actor only. It does not determine credential owner.

Authorization dimensions are separate: permission to read the chat/history; membership in the current space; model source policy; account use/share grant; runtime capability grant; tool-specific permission at invocation. A readable connector definition does not imply an account-use grant. A named source does not imply ownership. An account-use grant does not imply credential write/share access. An equipped skill conveys content, not permission to call tools.

Preserve link-bound restrictions: no local member-model rung, no borrowed GitHub login and no connector lending. Read verified `viaLinkId`, not a client boolean. Backend member-key routes consequently refuse a link-bound turn. The tm8 grant still stays constrained to its permitted space/link authority; it must not broaden access because an adapter changed.

For a rejected pin, return the authorized caller's safe repair guidance. To an unauthorized caller, do not distinguish a private credential from a missing one or reveal its label, owner, route or filesystem path. Public catalog options contain only choices the caller may discover/use; availability is advisory, never a launch authorization cache.

## 6. Capability selection and least authority

Resolve capabilities against the claimed mode, user intent, current graph equipment, admitted adapter support, space/node policy, connector definitions and explicit account bindings. Keep semantic tool IDs in tm8; translate to Claude or Codex native tool names in the adapter. Requested exposure and auto-approval are distinct. A hidden tool is absent, a visible tool may require approval, and an approved tool is still subject to live server authorization.

Connector bindings follow [ADR0297](../adr/0297-mcp-credential-boundary.md): explicit connector/account references, sealed server-side vendor secrets, launcher-bound grants, live checks per proxy request, and refresh serialization/CAS where revocation wins. Authenticated connectors never get an automatic default account. An unauthenticated connector omits `credentialId`; providing a credential for the wrong connector, space, issuer/resource binding or definition revision refuses. No raw MCP command/env can enter from ordinary chat settings. Administratively trusted stdio definitions retain their explicit code-trust boundary.

Optional unavailable skills/connectors may be omitted with an explicit `unavailable` projection. A required choice refuses the candidate/turn. A previously selected authenticated connector whose grant was revoked refuses subsequent calls immediately; whether the model turn can continue without that connector depends on its required flag and the runtime's ability to remove the surface safely. If it cannot remove a frozen surface, stop the generation. Do not silently select another account.

Compute skill delivery after the actual model home and workspace scope are known, using the existing [effective-skills](../../packages/execution/src/spawn/effective-skills.ts) semantics. Native versus indexed delivery can change on a credential-home/harness switch. Content revision, loader compatibility, path scope, plugin enablement and collisions all participate. A portable indexed skill must be readable under this authorizer and have a usable pointer; do not advertise a native slash command merely because an equipped graph row exists. Capability selection includes skill content hashes, not secret files from the account directory.

Native tools outside the tm8 proxy still need an admitted adapter policy: exact visible/preapproved surface, approvals and any sandbox restrictions appropriate to the claimed mode. The MCP token cannot constrain an unrestricted native shell. If an adapter cannot enforce a required denial or approval, reject that capability/mode combination. No policy revocation can recall a native command already accepted; termination and mediation reduce future exposure but are not rollback.

## 7. Fingerprints, generation and home lifecycle

Use monotonic revisions maintained by credential mutation writers, not hashes of secrets or only filesystem mtimes. A credential binding has an account generation, access revision, exported-material revision and home generation. Member reconnect, space key rotation, node login/config mutation and home relocation need events/revisions. A material revision advances when authentication delivered to the model changes; background same-account refresh handling may keep it stable only when the adapter proves it consumes refreshes safely. If that fact is unknown, replace the runtime on refresh-material change. Node ambient authentication must be wrapped in a versioned node account binding; arbitrary unseen server-home mutations make a claimed reuse unverified.

The runtime reuse key is a canonical, server-internal digest over chat/space scope, verified authorizer identity/auth kind/session/link provenance, route/catalog/adapter version, workspace scope, selected provider/source/account generation/material revision, home and native-storage scope/generation, and effective capability surface. Include model/effort when they are frozen at startup. An admitted adapter may instead prove native per-turn model/effort overrides: apply those within the generation only when route, credential requirement, capability surface and history eligibility remain compatible, and record the actual override on the turn receipt. The credential port's reuse key covers credentials/route; the runtime adds its adapter/options compatibility rules. Never hash plaintext keys, bearer tokens, ciphertext nonces or full environment strings to establish identity. A cosmetic account label change does not force a restart. A different account with byte-identical environment paths does.

Store authorization stamps separately from the reuse key. A policy epoch change requires revalidation, not an automatic restart if the same binding and surface remain permitted. A connector OAuth access-token refresh affects proxy credential revision, but does not change its account generation or restart the model solely because ciphertext changed. Changes to connector account, scopes, definition or exposed tools do change the capability digest.

Each runtime gets an increasing generation and a durable owner lease. All state changes, incoming output, token operations, material cleanup and claim completion carry `(chatId, generation, ownerLeaseId, claimFence)`. The graph version alone is not a runtime fence. A stale owner cannot mark its successor stopped, revoke its grant, delete its files or publish output as its successor. A single-active-generation CAS plus expiring owner lease prevents two nodes from running the same claimed turn.

Materialized API-key homes use a generation namespace such as `credentials/chat/<chatId>/<generation>/`; runtime MCP files use the same ownership namespace. The exact paths remain server-internal. Do not overwrite the current chat-level directory during a preview or while an old process may read it. Directly mounted member OAuth homes are shared login resources and must never be deleted by chat cleanup. Prefer minimal generation-owned login material where the adapter can refresh it correctly; otherwise retain an explicit shared-home lease and access revision.

Directories are 0700; secret files are 0600; writes are atomic and resist symlink/path traversal. An adapter must not inherit ambient credentials for another provider/account. Build the child environment from an allowlist, suppress native-provider and backend precedence variables first, then inject only the selected route's material. Endpoint/base-URL overrides are server-owned route facts. Do not merge an arbitrary parent environment after injection. These rules cover Anthropic auth-token precedence, OpenAI API-key/base URL, and relocated config-dir variables.

Cleanup revokes the exact runtime grant first, waits for adapter close/confirmed owner termination, then deletes only owned material. If close fails, mark stopping/failed with the cleanup pending; do not claim the subprocess has stopped or erase a home it can still use. A generation-aware sweeper finishes orphan cleanup after verified process death/lease expiry. Server restart never revives a bearer merely because its generation directory exists.

## 8. Claim/start/turn/switch protocol

1. Atomically claim the next turn and snapshot the latest desired configuration revision, target requirement, capability intent and verified authorizer. Queued turns unclaimed at a settings edit receive the new configuration when claimed. An already claimed turn retains its snapshot.
2. Resolve credential and capability metadata without acquiring resources. Revalidate chat/history access and the current account/policy grants. A runtime currently executing a prior turn is not retargeted by a picker edit.
3. If an existing generation matches the target reuse key, is ready, and both ports revalidate it, retain its MCP grant and model lease. Recheck grant expiry and capability compatibility. Refresh/replace an expiring grant through a generation-fenced operation at a safe boundary; never mint as an incidental resolver side effect.
4. For replacement, commit the prior turn's terminal/partial outcome and tool effects, quiesce its runtime, reserve generation `g`, and write `starting`. Obtain model material, effective skill delivery and a **staged** runtime grant. Do not publish `live` yet. Side-effect-free boot discovery may use a tightly restricted staging grant; it cannot invoke mutating tm8/connector/native tools or submit a user prompt.
5. Ask the continuity port to prepare the committed checkpoint for the target adapter and `nativeStorageScopeId/generation`. Same harness/account/home may use verified native resume. Another harness/home uses verified import/portable hydration. A native-not-found response is a failed resume that must be repaired through portable history or surfaced as `continuity_unavailable`, never silently treated as an empty conversation.
6. Start the adapter with the exact resources and continuity bootstrap. The adapter reports a boot receipt and continuity acknowledgement. Revalidate credential access/material, capability grants, authorizer and ownership after all asynchronous boot awaits. A changed desired revision alone does not cancel the immutable claimed turn. A revoked authority or changed loaded material does.
7. In one fenced publication transaction, check relevant authorization revisions under locks against mutation writers, activate the staged grant and record ready/effective generation/config/checkpoint. Compare the claim/lease/generation, not the latest desired revision. Authorization changes committed first must prevent activation. Changes committed afterwards fence the now-live generation through the invalidation path. `startThread` completion alone never marks a chat live.
8. Before dispatch, check the active generation and turn dispatch state again. Send the new user prompt once. Persist every tool receipt/outcome and terminal result to tm8. Late output is accepted only for its originating turn and valid generation; post-revocation late content cannot masquerade as a fresh effective response.

Credential/capability plan IDs expire quickly and are bound to the claim. Acquisition rechecks them. If a safe race changes material during boot, discard resources and replan for the same unsent claim with a bounded retry. Explicit intent remains explicit. Once a prompt/tool request might have been accepted, do not automatically replay it: persist an interrupted or unknown-outcome receipt and let continuity include that fact. A lost acknowledgement is not evidence of non-execution.

At ordinary next-turn switches, resolve Auto anew. During a running turn, revalidate its **selected binding**, not Auto against newly changed defaults; changing a default does not invalidate an otherwise authorized in-flight account. Revocation or source-policy denial fences the old binding, even when Auto could select something else next turn. The next turn may choose another Auto account only after its own fresh claim and continuity bootstrap.

Cross-harness/model switches preserve tm8 turn IDs, message history, attachments, workspace ownership and tool effect receipts. Native session IDs belong to generation/checkpoint metadata, not the logical chat ID. Do not transfer account config or native credentials as a continuity payload. History access is checked under the new human; a shared conversation does not grant its old human's private connector/material access.

## 9. Durable/API/UI state

Keep these records distinct:

| Record | Meaning | Write boundary |
| --- | --- | --- |
| desired config + revision | User's saved next-turn model/effort/credential/capability intent | Atomic config CAS |
| claimed config | Immutable model/harness/intent/mode/authorizer for a turn | Claim transaction |
| resolved selection | Account and capability metadata selected under current grants | Resolve/acquire and turn audit |
| runtime generation | Starting/ready/running/stopping/stopped/failed, boot receipt and ownership | Runtime publication/observation CAS |
| turn effective receipt | Actual dispatched generation/account/capabilities/checkpoint | Dispatch and terminal transactions |

Persist a secret-free account reference, resolution reason, authorization revisions, capability digest and continuity checkpoint in each turn's effective receipt. Keep private member/node account scope identifiers internal. A stopped runtime's last-used account remains historical; it is not a claim that the account is currently usable. Observed liveness includes a heartbeat/lease freshness stamp. After node restart or observation expiry, show unknown/recovering until reconciled, never ready inferred from the desired selection.

Proposed public projection:

```ts
interface CredentialDisplay {
  readonly provider: Provider;
  readonly source: Source;
  readonly credentialId?: Id; // only when this viewer may discover it
  readonly label?: string; // authorized safe label, no private owner/address
  readonly resolutionReason: ResolvedCredentialPlan['resolutionReason'];
}
interface ChatEffectiveState {
  readonly desiredRevision: Revision;
  readonly desiredCredential: Readonly<
    { status: 'visible'; selection: CredentialIntent }
    | { status: 'redacted'; source: 'space' }
  >;
  readonly preview: Readonly<{
    status: 'ready' | 'requires_choice' | 'forbidden' | 'unavailable';
    checkedAt: string;
    credential?: CredentialDisplay;
  }>;
  readonly activeTurn: Readonly<{
    turnId: Id; claimedRevision: Revision;
    status: 'claimed' | 'preparing' | 'running' | 'interrupted' | 'failed';
    generation: number | null;
    credential?: CredentialDisplay; // only after effective publication
  }> | null;
  readonly runtime: Readonly<{
    generation: number | null;
    phase: 'starting' | 'ready' | 'running' | 'stopping' | 'stopped'
      | 'failed' | 'unknown';
    observedAt: string | null;
    continuity: 'native_verified' | 'portable_verified' | 'pending' | 'unavailable';
  }>;
  readonly pendingForNextClaim: boolean;
}
```

`desiredCredential` is a viewer projection: an unreadable pin needs a redacted placeholder/state rather than an invented usable choice; never submit that projection back as a replacement config. Config setters return desired revision, safe preview and `appliesTo: next_claim`, not a successful-runtime claim. Send state events with generation and config revision; the UI drops stale events. If a running response used credential A and the picker now names B, render “Current answer: A; next turn: B”. Auto shows its resolved provider/source and reason, not a false promise to use the same account indefinitely.

A denied pending choice remains visible with an actionable safe reason. Do not erase it, change defaults or show “connected” from directory existence. Failure diagnostics distinguish unavailable credential, forbidden policy, unsupported adapter, continuity unavailable, startup failure and interrupted/unknown dispatch. Graph/transcript audit receives codes and references only; raw adapter stderr and secret environment stay in a restricted redacted diagnostics boundary.

## 10. Revocation and race linearization

Credential deletion/revocation, sharing removal, membership loss, human authority-session revocation, node/space source-policy tightening and connector trust/scope changes increment durable access revisions and emit invalidations in the same transaction. Event delivery is an optimization; publication, turn dispatch and proxy requests always read live durable authorization. Multi-node consumers fence affected grants before asynchronously closing model processes. A periodic sweep detects missed events, but is not the authorization boundary.

Generation publication and revocation writers lock the same authorization rows/versioned epoch records in deterministic order. Model dispatch has a durable generation/authority permit check immediately before sending. A provider request already admitted before revocation can complete afterwards; an external provider cannot participate in tm8's transaction. Record the admission and outcome honestly, deny subsequent sends and mediated calls, and close the process. Do not claim instantaneous recall or rollback of vendor/native operations.

A mutation of ordinary selection/defaults emits desired-state invalidation but does not masquerade as revocation. A runtime whose actual account remains allowed finishes its claimed turn. A mutation of authentication material invalidates matching loaded-material leases; the coordinator stops/replaces those at a safe boundary and records interruption if mid-turn continuation cannot be authenticated safely.

## 11. Test matrix and verification obligations

These are implementation acceptance tests to assign after convergence. This document-only change does not claim that the behavior already exists.

| Area | Cases | Required assertion |
| --- | --- | --- |
| Provider derivation | Anthropic→OpenAI; native Claude→Kimi; Codex→Groq; model/tool mismatch; unknown tool | Correct native/inference/policy tuple; unavailable adapter refuses before secret/token/file work; no Anthropic default guess |
| Intent switching | Auto/Mine/Space/Node across providers; same-provider pin; wrong-provider pin; node→Kimi; atomic new selection | Unpinned source retained/revalidated; incompatible pin/source refuses without partial write; only explicitly submitted compatible selection replaces it |
| Auto ladder | Personal default/member/space/node present/absent and policy-excluded combinations | Same ordered resolver behavior; broken/unreadable selected default refuses; link callers skip forbidden rungs |
| Explicit security | Missing/stale/revoked/private pin; wrong space/provider; decrypt failure; policy-read failure | Fail closed; no fallback, no secret/private-account discovery through errors |
| Backend policy | Kimi/Groq member policy denied; explicit space/node; link-bound route | Preserve native-provider policy gate and chat member-only restriction; never inject native vendor account |
| Authorizer | Human A configures, B claims; delegated turn; legacy null auth kind; source session revoked | B/root verified authority used; no teammate/chat-owner loan; missing provenance refuses |
| Next claimed turn | Change intent/model/capabilities during streaming; queue before edit but claim after | Current receipt unchanged; next claim gets new desired revision; one atomic snapshot includes harness, mode and capabilities |
| Pure preview | Repeated previews, rejected candidate, resolver reuse checks | No token mint/revoke, credential-home rewrite, connector process or live process interruption |
| Account identity | Same paths but reconnect to another account; same API key under different binding | Account generation changes; no reuse based on path/env equality |
| Reuse | Identical account/material/route/surface; cosmetic label; allowed policy epoch change | Revalidate; keep same generation/token if compatible; irrelevant labels/epochs do not churn |
| Turn overrides | Adapter supports/does not support model/effort override; same route; changed backend | Supported compatible override retains generation with truthful receipt; incompatible/unsupported override replaces through continuity |
| Home/material | Member-home relocation; space key rotation; node key change; model OAuth refresh | Generation-owned home protects old process; changed loaded material replaces; no shared-login deletion |
| Capabilities | Unsupported required/optional connector or skill; native/indexed switch; changed skill content; duplicate IDs | Required refuses, optional explicitly unavailable; correct delivery/digest; skill content grants no tool permission |
| Connector accounts | Wrong connector/account/space; hidden private account; connector readable but no grant | Exact binding and discovery authorization; no connector default account and no vendor secret injection |
| Proxy refresh/revoke | Concurrent OAuth refresh and revoke/rotate; scopes/definition change | CAS/lock prevents resurrection; live authorization before each send; model generation not restarted for token-only refresh |
| Start races | Revoke after resolve, acquire, grant mint, adapter boot, continuity ack, just before publication | Staged generation never dispatches unauthorized prompt; new grant/resources revoked/cleaned; effective remains unreported |
| Config boot race | Picker edit while old claimed configuration boots | Claimed revision stays valid; new desired shown pending; publication CAS cannot overwrite desired |
| In-flight revoke | Membership/source policy/account/share/session revoked during model stream | Grant fence immediate for subsequent mediated calls; process closed; partial/unknown outcomes preserved; no Auto retarget/replay |
| Ownership race | Two nodes claim/start; old close finishes after successor; late old output | One active owner; stale close/revoke/delete/state/output cannot affect successor |
| MCP lifecycle | Reuse, ordinary switch, failed boot, expiry, server crash and reconnect | Exact generation token ownership; previews never rotate; orphan/revoked grants cannot authorize tools |
| Continuity | Credential-home or harness switch; native transcript missing; portable history too large/unreadable | Verified committed checkpoint or visible continuity failure; prior history retained; no empty native session or old tool-call execution |
| Dispatch uncertainty | Prompt accepted then socket lost; tool side effect succeeds then acknowledgement lost | Interrupted/unknown receipt; no automatic resubmit of possible execution; checkpoint records uncertainty |
| Secret handling | Sentinel keys/token in env, config, provider stderr, tool results and bootstrap errors | No sentinel in DTOs/graph/logs/traces/checkpoints; 0600/0700 files; redaction and approved environment ordering |
| Filesystem isolation | Symlink/path traversal; concurrent generation acquire/release; stale sweeper | Owned root containment; no overwrite/delete of live successor or shared member homes |
| UI state | Current A/next B; offline reconnect; out-of-order events; stale preview; inaccessible saved pin | Separate desired/claimed/effective state; generation ordering; safe redaction; no false ready/live claim |

Unit-test requirement derivation, intent migration/selection, canonical nonsensitive reuse keys and pure validation. Port contract tests use fake credential/capability/grant/continuity adapters with controllable barriers at every boot await. PostgreSQL tests cover config/claim atomicity, epoch locking, generation CAS, owner fencing and proxy grants. Adapter integration tests verify environment precedence, denied native tools, native-storage verification and portable hydration. UI tests cover effective-state wording and event ordering. Sentinel-secret assertions and fault injection belong in the focused tests, not only manual review.

## 12. Implementation seams and convergence decisions

Keep `resolveSessionCredentials` as the shared credential policy implementation. Refactor its selection result into secret-free grant metadata plus separately acquired material; retaining the existing function as a compatibility wrapper avoids a second ladder. Add binding/revision facts through credential stores and member/node home ports rather than reading process.env as identity. Replace `ResolveChatCredentialEnv` with the metadata/lease bridge in stages.

Extend claim snapshots to include harness, requirement/catalog revision, mode, capabilities and desired revision. Introduce generation/owner state, access epochs and generation-scoped MCP grants before introducing new adapters. The present chat-id-only runtime token replacement and per-chat files cannot support safe staged replacement/cleanup. Keep legacy readers and queued turns compatible through an explicit migration/recovery path; reauthorize legacy rows that cannot prove a runtime source.

Converge these points with runtime/continuity before implementation:

- One runtime generation/claim fence vocabulary and the transaction owner for activation, failure and cleanup.
- Continuity's checkpoint/boot acknowledgement shape and native-storage compatibility proof; credential plans provide opaque storage scope, never transcript paths/secrets.
- Capability surface digest includes actual skill delivery and connector account/definition bindings; portable context includes readable skill references and historic effects, not grants.
- Generation-scoped token mint/activation and read-only boot discovery replace the current early `live` marker.
- Provider intent UX retains merged selection shape and atomic model/effort/selection writes; wrong-provider pins require explicit replacement. Kimi/Groq source restrictions and native-policy namespaces remain compatible.

No unresolved product choice permits silent fallback, forged human authority, unverified liveness, empty-context replacement or side-effect replay. Once contracts converge, implementation tasks can stage schema/ports, generation orchestration, adapter continuity and UI projection with the matrix above as their review gates.
