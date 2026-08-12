/**
 * The CLI-owned `OperationDiscovery` projection — harness §7.1.
 *
 * One row per catalog operation, TOTAL over all 107 including internal and
 * reserved. Everything the CLI knows about a command — its noun, its verb, its
 * exposure, its side effect, whether it needs a mutation id or a version guard,
 * and whether this node can actually run it — is derived from here, so help,
 * completion, and search are three renderings of ONE table rather than three
 * hand-maintained lists that drift.
 *
 * WHERE THIS SHOULD EVENTUALLY LIVE. §7.1 calls this table "contract data", and
 * it belongs in `@tm8/contract` beside the catalog it projects. It is here
 * because `packages/contract` is frozen for this wave; relocation is a
 * post-gate item and NOT a licence to fork the catalog. Note the direction of
 * the dependency: this file derives from `OPERATIONS` and adds nothing the
 * catalog could have answered itself.
 *
 * EXHAUSTIVENESS IS A TYPE, NOT A TEST. `ROWS` is `Record<OperationName, Row>`,
 * so a row added to `@tm8/contract` fails THIS build rather than silently
 * having no CLI disposition. The runtime sweep in the test proves the same
 * thing for the fields a type cannot check (prose, command paths).
 *
 * HONESTY RULES ENCODED HERE, each of them a gate item:
 *  - `execution.prompt` is internal, names `messages.post` as its public
 *    composite, and has NO command — it must never render invocation syntax.
 *  - the two reserved rows are handled ASYMMETRICALLY on purpose:
 *    `search.query` gets a command that answers honestly, `bridge.fetchBlob`
 *    gets no command at all yet stays fully discoverable by exact lookup.
 *  - `events.subscribe` describes the contract's client→server control protocol
 *    and makes no claim about what THIS node currently serves — that is the
 *    `availability` axis, which is measured rather than narrated.
 *  - `commands.undo` is not universally applicable, and redeeming the
 *    `messages.delete`-inverse token REDACTS a message rather than restoring one.
 *
 * NOTES ASSERT CONTRACT FACTS, NEVER THE STATE OF THE WORLD. Two notes here
 * shipped false because their subject was fixed underneath them, which is the
 * "assertion whose subject gets fixed" class living in prose — and prose has
 * nothing that goes red. Anything phrased "not yet", "until X lands", or "still
 * only Y" is a roadmap, and a shipped roadmap becomes a lie the moment the
 * roadmap moves. Help, completion and search are three renderings of this one
 * table, so every string here is operator-facing text an agent reads in a PTY.
 *
 * Sources, all frozen: TM8-CLI-GRAMMAR-REDESIGN §4 (syntax) and §8 (the 81-row
 * disposition table), and TM8-W0-CONSISTENCY-MATRICES §3 (the CLI column,
 * including A01-A20). Where the two agree they agree exactly; nothing here is
 * invented.
 */
import { OPERATIONS, getOperation, isOperationName, type OperationName } from '@tm8/contract';
import {
  ledger,
  resolveAvailability,
  type Availability,
  type AvailabilityLedger,
  type AvailabilityReason,
  type AvailabilitySource,
} from './availability.js';

// The availability vocabulary is part of this projection's public surface —
// every row carries it — so it is re-exported here rather than making each
// consumer import from two modules to describe one row.
export type { Availability, AvailabilityReason, AvailabilitySource, AvailabilityLedger };

export const EXPOSURES = ['public', 'composite', 'internal', 'reserved'] as const;
export type Exposure = (typeof EXPOSURES)[number];

export const SIDE_EFFECTS = ['none', 'local', 'durable', 'execution'] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

export const AUTHZ_TARGETS = ['server', 'space', 'project', 'entity', 'session'] as const;
export type AuthzTarget = (typeof AUTHZ_TARGETS)[number];

export const IDEMPOTENCIES = ['none', 'optional', 'required'] as const;
export type Idempotency = (typeof IDEMPOTENCIES)[number];

export const VERSIONINGS = ['none', 'expectedVersion'] as const;
export type Versioning = (typeof VERSIONINGS)[number];

/** §7.1, plus the CLI-projection fields the doc's own examples require. */
export interface OperationDiscovery {
  operation: OperationName;
  noun: string;
  verb: string;
  exposure: Exposure;
  summary: string;
  intentTags: readonly string[];
  /** Null when the operation carries no request payload at all. */
  inputSchemaRef: string | null;
  outputSchemaRef: string;
  sideEffect: SideEffect;
  authzTarget: AuthzTarget;
  idempotency: Idempotency;
  versioning: Versioning;
  helpRef: string;

  /** The CLI command path, or NULL when no public invocation exists. */
  command: readonly string[] | null;
  /** Exact syntax. Null exactly when `command` is null — never a fabricated form. */
  syntax: string | null;
  /**
   * False when the operation takes a request body but has no frozen input
   * schema binding yet (the W0 matrix's `unbound`). Saying so is the point:
   * `inputSchemaRef` naming a slot nobody has filled would be a promise.
   */
  inputSchemaBound: boolean;
  notes: readonly string[];
  /** Why there is no public invocation, in the Server's own reason vocabulary. */
  reason: string | null;
  /** The public composite or lifecycle that owns this operation, when one does. */
  publicComposite: OperationName | null;
  examples: readonly string[];

  availability: Availability;
  availabilityReason: AvailabilityReason;
  availabilitySource: AvailabilitySource;
}

interface Row {
  /** null = deliberately no public CLI invocation. */
  cmd: readonly string[] | null;
  /** Exact §4 syntax. Omitted only when `cmd` is null. */
  syn?: string;
  sum: string;
  authz: AuthzTarget;
  /** `none` = no request payload; `unbound` = payload, no frozen schema; `bound` = frozen schema. */
  input: 'none' | 'unbound' | 'bound';
  side?: SideEffect;
  ver?: Versioning;
  tags?: readonly string[];
  notes?: readonly string[];
  reason?: string;
  composite?: OperationName;
  examples?: readonly string[];
}

/**
 * THE UNBOUND FACT — one source, two renderings, and they may not disagree.
 *
 * A row with `input: 'unbound'` carries a request body and has no frozen input
 * schema. That is a CONTRACT FACT: true, checkable, and stable. Both of these
 * strings used to end in "yet", which is not a fact but a PREDICTION — it
 * promised a binding that may never land, and on a reserved row it promised one
 * that certainly never will.
 *
 * `UNBOUND_MARKER` is exported because `src/commands/help.ts` renders the same
 * fact on the `input:` schema line. It USED to hold its own hand-written
 * literal, so the two could drift apart silently — one author fixing the note
 * and not the marker would leave help contradicting itself on adjacent lines.
 * There is now one constant and two consumers of it, and the pin in
 * `test/discovery-operations.test.ts` fails if a second literal reappears.
 */
export const UNBOUND_MARKER = '(not bound)';
export const UNBOUND_NOTE =
  'this operation carries a request body and has no frozen input schema binding';

/**
 * The disposition table. Exhaustive by type over `OperationName`.
 *
 * `authz` answers "what does the Server authorize this against?", which is the
 * question an agent actually has before it calls: a `space`-targeted operation
 * needs a Space in context, an `entity`-targeted one needs a readable/writable
 * target, and a `server`-targeted one is about the caller themself.
 */
const ROWS: Record<OperationName, Row> = {
  // ── identity & spaces ────────────────────────────────────────────────────
  'identity.get': {
    cmd: ['identity', 'get'],
    syn: 'tm8 identity get',
    sum: 'Read who this process is calling as, and the actor identity the Server resolved',
    authz: 'server',
    input: 'none',
    tags: ['whoami', 'me', 'actor', 'principal'],
  },
  'identity.profile.update': {
    cmd: ['identity', 'profile', 'set'],
    syn: 'tm8 identity profile set [--display-name <name>] [--avatar <url>] [--email <email>] [--global-id <issuer:subject>] [--mutation-id <id>]',
    sum: 'Write the caller\'s own display profile — name, avatar, email, and the cross-server global id',
    authz: 'server',
    input: 'bound',
    tags: ['profile', 'display-name', 'avatar', 'global-id', 'me'],
    notes: [
      'writes only the caller\'s own profile: there is no flag naming another identity, and --as is refused',
      'the global id is a display claim in issuer:subject shape, never an authorization input',
    ],
  },
  // ── auth (Identity v2 Stage 1: local accounts) ───────────────────────────
  'auth.signup': {
    cmd: ['auth', 'signup'],
    syn: 'tm8 auth signup <username> --password <password> [--display-name <name>] [--email <email>] [--node-admin]',
    sum: 'Create a local account on this Server (node-admin only; never open self-registration)',
    authz: 'server',
    input: 'bound',
    tags: ['account', 'signup', 'provision', 'user', 'admin'],
    notes: [
      'the caller must be a node admin; the guard is enforced inside Postgres, not in the CLI',
      'the password travels in the request body — a real deployment needs TLS before using this',
    ],
  },
  'auth.login': {
    cmd: ['auth', 'login'],
    syn: 'tm8 auth login <username> --password <password> [--kind browser|cli] [--label <label>] [--print-token]',
    sum: 'Exchange a username and password for a tm8s_… bearer session with this Server',
    authz: 'server',
    input: 'bound',
    tags: ['login', 'token', 'session', 'bearer', 'password', 'credential'],
    notes: [
      'the credential is stored per Server origin — macOS keychain, else a 0600 file — and later commands against that Server authenticate automatically',
      'with --print-token (or in an agent session) nothing is stored: export the printed token as TM8_AGENT_TOKEN',
      'the failure message never distinguishes an unknown username from a wrong password',
    ],
  },
  'auth.logout': {
    cmd: ['auth', 'logout'],
    syn: 'tm8 auth logout [--session-id <id>]',
    sum: 'Revoke the presented bearer session, or a named one you own (node admins: any)',
    authz: 'server',
    input: 'bound',
    tags: ['logout', 'revoke', 'session', 'token'],
    notes: [
      'revoking this shell\'s own session also removes the matching stored credential for this Server origin',
    ],
  },
  'auth.session.get': {
    cmd: ['auth', 'session'],
    syn: 'tm8 auth session',
    sum: 'Show the authenticated account and session behind the current credentials',
    authz: 'server',
    input: 'none',
    tags: ['whoami', 'session', 'token', 'me'],
  },
  // ── credentials (Tier B per-member vendor credentials) ───────────────────
  //
  // ALL FOUR HAVE NO CLI COMMAND, AND THE REASON IS NOT THAT THEY ARE FORBIDDEN
  // TO THE CLI. Read this before adding one.
  //
  // The Server refuses these to a caller whose `auth_sessions.kind` is `agent`
  // (R2) — and `browser` AND `cli` both pass. A human at a terminal is exactly
  // as entitled here as a human in the settings screen. So the door is left
  // OPEN, not welded: a later lane can add commands with no security change at
  // all. What stops it being done in THIS change is scope, not policy —
  // `discovery-commands.test.ts` fails a published command path with no
  // registry handler, so a `cmd` here obliges four command implementations in
  // the same commit.
  //
  // Why an agent is refused even READ access, which is the surprising half:
  // `TM8_AGENT_TOKEN` carries its owner's FULL identity rather than a reduced
  // principal (review finding C7). `acting_as_team_member_id` constrains
  // `internal.resolve_actor` alone, while `identity_id()`, `can_act_as`,
  // `is_space_member` and `entity_readable` all key off identity. An agent
  // calling `credentials.status` would therefore read its OWNER'S login
  // metadata, and `credentials.delete` would revoke their token.
  'credentials.status': {
    cmd: null,
    sum: 'Read which vendor accounts this member has connected — human sessions only',
    authz: 'server',
    input: 'none',
    tags: ['credential', 'connection', 'vendor', 'anthropic', 'openai', 'github', 'settings'],
    reason: 'human_settings_only',
    notes: [
      'refused to an agent session with `credentials_human_only`: an agent token carries its owner\'s full identity, so this would read their credentials, not its own',
      'a `cli`-kind human session is admitted by the same guard, so a CLI form of this operation would need no security change',
      'the github entry reports the string-shaped credential store as absent rather than claiming a connection it cannot see',
    ],
  },
  'credentials.delete': {
    cmd: null,
    sum: 'Disconnect one vendor account, terminating the sessions that carry it — human sessions only',
    authz: 'server',
    input: 'bound',
    side: 'execution',
    tags: ['credential', 'disconnect', 'revoke', 'logout', 'settings'],
    reason: 'human_settings_only',
    notes: [
      'revokes FIRST, then kills the login terminal for that provider, then the account\'s live agent sessions carrying it — so no spawn can pick the credential up mid-operation',
      'best-effort and honest: a kill that fails is reported and never undoes the revoke',
      'termination is containment, not revocation — a process that already read the secret still holds it, and only rotating at the vendor invalidates it',
    ],
  },
  'credentials.loginSessions.start': {
    cmd: null,
    sum: 'Open a short-lived terminal in which this member completes a vendor login — human sessions only',
    authz: 'space',
    input: 'bound',
    side: 'execution',
    tags: ['credential', 'connect', 'login', 'oauth', 'terminal', 'settings'],
    reason: 'human_settings_only',
    notes: [
      'the command it runs comes from a fixed server-side table keyed by provider; the request has no command, args or flags field, and that absence is the control',
      'the terminal\'s time to live is deliberately shorter than the vendor\'s device-code lifetime, so an abandoned login dies before its code does',
    ],
  },
  'credentials.loginSessions.finish': {
    cmd: null,
    sum: 'Close a login terminal and record what the verification probe established — human sessions only',
    authz: 'session',
    input: 'bound',
    side: 'execution',
    tags: ['credential', 'connect', 'verify', 'probe', 'settings'],
    reason: 'human_settings_only',
    notes: [
      'success is never inferred from the terminal\'s exit code: a member who reads the device code and closes the tab exits 0 having captured nothing',
      '`connected` and `stored` are separate answers — a verified GitHub login reports stored=false where its string-shaped store is not present',
    ],
  },
  'serverConnections.list': {
    cmd: ['server', 'list'],
    syn: 'tm8 server list',
    sum: 'List named routes to other tm8 Servers stored on this local node',
    authz: 'server',
    input: 'none',
    tags: ['remote', 'connection', 'target'],
  },
  'serverConnections.create': {
    cmd: ['server', 'add'],
    syn: 'tm8 server add <name> --url <base-url> [--username <username>] [--mutation-id <id>]',
    sum: 'Register a named route to another tm8 Server after checking its health endpoint',
    authz: 'server',
    input: 'bound',
    tags: ['remote', 'connection', 'target'],
  },
  'serverConnections.get': {
    cmd: ['server', 'get'],
    syn: 'tm8 server get <name>',
    sum: 'Read one named Server route',
    authz: 'server',
    input: 'none',
    tags: ['remote', 'connection', 'target'],
  },
  'serverConnections.delete': {
    cmd: ['server', 'remove'],
    syn: 'tm8 server remove <name> --yes [--mutation-id <id>]',
    sum: 'Remove a named Server route from this local node',
    authz: 'server',
    input: 'bound',
    tags: ['remote', 'connection', 'target'],
  },
  'spaces.list': {
    cmd: ['space', 'list'],
    syn: 'tm8 space list [--limit <count>] [--cursor <cursor>]',
    sum: 'List the Spaces this actor can see',
    authz: 'server',
    input: 'none',
  },
  'spaces.create': {
    cmd: ['space', 'create'],
    syn: 'tm8 space create <name> [--description <text-source>] [--visibility private|public] [--mutation-id <id>]',
    sum: 'Create a Space — the authorization and event boundary everything else lives in',
    authz: 'server',
    input: 'bound',
  },
  'spaces.get': {
    cmd: ['space', 'get'],
    syn: 'tm8 space get [<space-id>]',
    sum: 'Read one Space',
    authz: 'space',
    input: 'none',
  },
  'spaces.update': {
    cmd: ['space', 'update'],
    syn: 'tm8 space update [<space-id>] [--name <name>] [--description <text-source>] [--github-repo <url|none>] [--mutation-id <id>]',
    sum: 'Change a Space name, description, or deprecated repository field',
    authz: 'space',
    input: 'bound',
    notes: ['`--github-repo` is deprecated in favour of linked ProjectResources'],
  },
  'spaces.navigation': {
    cmd: ['space', 'navigation', 'get'],
    syn: 'tm8 space navigation get [<space-id>]',
    sum: 'Read the navigation projection for a Space',
    authz: 'space',
    input: 'none',
  },
  'spaces.home': {
    cmd: ['space', 'home', 'get'],
    syn: 'tm8 space home get [<space-id>]',
    sum: 'Read the Space home projection',
    authz: 'space',
    input: 'none',
  },
  'spaces.counts': {
    cmd: ['space', 'counts', 'get'],
    syn: 'tm8 space counts get [<space-id>]',
    sum: 'Read per-kind entity counts for a Space (total and unseen-by-you)',
    authz: 'space',
    input: 'none',
    tags: ['counts', 'unseen', 'badges'],
  },
  'spaces.settings': {
    cmd: ['space', 'settings', 'get'],
    syn: 'tm8 space settings get [<space-id>]',
    sum: 'Read the settings projection for a Space',
    authz: 'space',
    input: 'none',
  },
  'spaces.members.list': {
    cmd: ['space', 'member', 'list'],
    syn: 'tm8 space member list [<space-id>] [--limit <count>] [--cursor <cursor>]',
    sum: 'List the human Members of a Space',
    authz: 'space',
    input: 'none',
  },
  'spaces.invites.list': {
    cmd: ['space', 'invite', 'list'],
    syn: 'tm8 space invite list [<space-id>] [--limit <count>] [--cursor <cursor>]',
    sum: 'List outstanding invitations to a Space',
    authz: 'space',
    input: 'none',
  },
  'spaces.invites.create': {
    cmd: ['space', 'invite', 'create'],
    syn: 'tm8 space invite create [<space-id>] [--max-uses <count>] [--expires-at <iso-time|none>] [--mutation-id <id>]',
    sum: 'Mint an invitation code for a Space',
    authz: 'space',
    input: 'unbound',
  },
  'spaces.invites.revoke': {
    cmd: ['space', 'invite', 'revoke'],
    syn: 'tm8 space invite revoke <invite-id> [--space <space-id>] --yes [--mutation-id <id>]',
    sum: 'Revoke an outstanding Space invitation',
    authz: 'space',
    input: 'unbound',
  },
  'spaces.invites.redeem': {
    cmd: ['space', 'invite', 'redeem'],
    syn: 'tm8 space invite redeem <code> [--mutation-id <id>]',
    sum: 'Redeem an invitation code and join its Space',
    authz: 'server',
    input: 'unbound',
    tags: ['join', 'accept'],
  },
  'spaces.taskAxes.list': {
    cmd: ['space', 'task-axis', 'list'],
    syn: 'tm8 space task-axis list [<space-id>]',
    sum: 'List the task axes a Space classifies work along',
    authz: 'space',
    input: 'none',
  },
  'spaces.taskAxes.create': {
    cmd: ['space', 'task-axis', 'create'],
    syn: 'tm8 space task-axis create <name> [--space <space-id>] --value <value>... --kind default|manual --position <n> [--mutation-id <id>]',
    sum: 'Add a task axis to a Space',
    authz: 'space',
    input: 'bound',
  },
  'spaces.taskAxes.update': {
    cmd: ['space', 'task-axis', 'update'],
    syn: 'tm8 space task-axis update <axis-id> [--space <space-id>] --name <name> --value <value>... --kind default|manual --position <n> [--mutation-id <id>]',
    sum: 'Redefine a task axis',
    authz: 'space',
    input: 'bound',
  },
  'spaces.taskAxes.delete': {
    cmd: ['space', 'task-axis', 'delete'],
    syn: 'tm8 space task-axis delete <axis-id> [--space <space-id>] --yes [--mutation-id <id>]',
    sum: 'Remove a task axis from a Space',
    authz: 'space',
    input: 'unbound',
  },
  'spaces.leaderboard': {
    cmd: ['space', 'leaderboard', 'get'],
    syn: 'tm8 space leaderboard get [<space-id>] [--limit <count>] [--cursor <cursor>]',
    sum: 'Read the points leaderboard for a Space',
    authz: 'space',
    input: 'none',
  },
  'spaces.awards': {
    cmd: ['space', 'award', 'list'],
    syn: 'tm8 space award list [<space-id>] [--limit <count>] [--cursor <cursor>]',
    sum: 'List awards granted in a Space',
    authz: 'space',
    input: 'none',
  },

  // ── universal entities ───────────────────────────────────────────────────
  'entities.get': {
    cmd: ['entity', 'get'],
    syn: 'tm8 entity get <entity-id>',
    sum: 'Read one entity of any kind, with its current version',
    authz: 'entity',
    input: 'none',
    tags: ['read', 'show', 'task', 'doc', 'session'],
    notes: [
      'returns the full entity unbounded — no limit or projection flags exist; for orientation prefer entity context (bounded, cursors)',
    ],
  },
  'entities.create': {
    cmd: ['entity', 'create'],
    syn: 'tm8 entity create <kind> <title> [--space <space-id>] [--parent <entity-id|none>] [--position <n>] [--content <json-source>] [--attach-to <entity-id>...] [--relate-to <entity-id>...] [--connect <edge-type>=<target-entity-id>...] [--mutation-id <id>]',
    sum: 'Create an entity of any unrestricted kind, optionally with its initial edges',
    authz: 'space',
    input: 'bound',
    tags: ['new', 'add', 'task', 'doc'],
    notes: [
      'restricted kinds (project, interaction_profile) refuse generic creation and use their named writers',
      'hierarchy is homogeneous: a parent and its direct children share one kind and one Space',
      'task content shape: {description, acceptanceCriteria: [{id, done, text}], pointsEstimate}',
      "doc content shape: {kind: 'doc', body, format: 'markdown'}",
    ],
    examples: [
      'tm8 entity create task "<title>" --space <space-id> --parent <entity-id>',
      'tm8 entity create doc "<title>" --space <space-id> --content \'{"kind":"doc","body":"…","format":"markdown"}\'',
    ],
  },
  'entities.patch': {
    cmd: ['entity', 'update'],
    syn: 'tm8 entity update <entity-id> --expect-version <n> [--title <title>] [--content <json-source>] [--mutation-id <id>]',
    sum: 'Change an entity title or content under an optimistic version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['edit', 'rename', 'patch'],
  },
  'attentionRequests.create': {
    cmd: ['entity', 'attention'],
    syn: 'tm8 entity attention <entity-id> --reason <text> --points <1-100> [--mutation-id <id>]',
    sum: 'Request scored attention for any entity',
    authz: 'entity',
    input: 'bound',
    tags: ['attention', 'needs-attention', 'triage'],
    examples: ['tm8 entity attention <entity-id> --reason "Need a decision" --points 80'],
  },
  'attentionRequests.list': {
    cmd: ['attention', 'list'],
    syn: 'tm8 attention list [--entity <entity-id>] [--status <status>] [--min-points <1-100>] [--limit <count>] [--cursor <cursor>]',
    sum: 'List the generic attention queue, highest score first',
    authz: 'space', input: 'none', tags: ['attention', 'queue', 'dashboard'],
  },
  'attentionRequests.update': {
    cmd: ['attention', 'update'],
    syn: 'tm8 attention update <request-id> --expect-version <n> [--reason <text>] [--points <1-100>] [--status <status>] [--note <text>] [--mutation-id <id>]',
    sum: 'Edit, acknowledge, resolve, or dismiss one attention request',
    authz: 'entity', input: 'bound', ver: 'expectedVersion', tags: ['attention', 'update', 'resolve'],
  },
  'attentionRequests.resolveEntity': {
    cmd: ['attention', 'resolve-entity'],
    syn: 'tm8 attention resolve-entity <entity-id> [--note <text>] [--mutation-id <id>]',
    sum: 'Resolve every pending attention request for one entity',
    authz: 'entity', input: 'bound', tags: ['attention', 'resolve', 'clear'],
  },
  'entities.move': {
    cmd: ['entity', 'move'],
    syn: 'tm8 entity move <entity-id> --parent <entity-id|none> --position <n> --expect-version <n> [--mutation-id <id>]',
    sum: 'Reparent or reorder an entity within its homogeneous hierarchy',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['reparent', 'reorder', 'position'],
  },
  'entities.delete': {
    cmd: ['entity', 'delete'],
    syn: 'tm8 entity delete <entity-id> --yes [--mutation-id <id>]',
    sum: 'Soft-delete an entity; `entity restore` is its inverse',
    authz: 'entity',
    input: 'unbound',
    tags: ['remove', 'trash'],
  },
  'entities.restore': {
    cmd: ['entity', 'restore'],
    syn: 'tm8 entity restore <entity-id> [--mutation-id <id>]',
    sum: 'Restore a soft-deleted entity',
    authz: 'entity',
    input: 'unbound',
    tags: ['undelete', 'recover'],
  },
  'entities.children': {
    cmd: ['entity', 'children'],
    syn: 'tm8 entity children <entity-id> [--limit <count>] [--cursor <cursor>]',
    sum: 'Page the direct children of an entity',
    authz: 'entity',
    input: 'none',
    notes: ['there is no `--kind` filter: children always share the parent kind'],
  },
  'entities.hierarchy': {
    cmd: ['entity', 'hierarchy'],
    syn: 'tm8 entity hierarchy <entity-id> [--depth <n>]',
    sum: 'Read the ancestor/descendant hierarchy around an entity',
    authz: 'entity',
    input: 'none',
    tags: ['tree', 'ancestors', 'subtree'],
  },
  'entities.connections': {
    cmd: ['entity', 'connections'],
    syn: 'tm8 entity connections <entity-id> [--type <edge-type>...] [--direction incoming|outgoing|both] [--peer <entity-id>...] [--limit <count>] [--cursor <cursor>]',
    sum: 'Page the edges attached to an entity',
    authz: 'entity',
    input: 'none',
    tags: ['edges', 'links', 'related'],
    notes: ['the flat filter/sort/page shape is amendment-dependent; the frozen row still returns grouped connections'],
  },
  'entities.versions': {
    cmd: ['entity', 'versions'],
    syn: 'tm8 entity versions <entity-id> [--limit <count>] [--cursor <cursor>]',
    sum: 'Page the version history of an entity',
    authz: 'entity',
    input: 'none',
    tags: ['history', 'revisions'],
  },
  'entities.activity': {
    cmd: ['entity', 'activity'],
    syn: 'tm8 entity activity <entity-id> [--limit <count>] [--cursor <cursor>]',
    sum: 'Page the activity record for an entity',
    authz: 'entity',
    input: 'none',
    tags: ['audit', 'log', 'events'],
  },
  'entities.react': {
    cmd: ['entity', 'react'],
    syn: 'tm8 entity react <entity-id> like|dislike|star [--off] [--mutation-id <id>]',
    sum: 'Set or clear this actor reaction on an entity',
    authz: 'entity',
    input: 'bound',
    tags: ['like', 'star', 'emoji'],
  },
  'entities.points.add': {
    cmd: ['entity', 'point', 'grant'],
    syn: 'tm8 entity point grant <entity-id> <amount> --reason grant|award|seed [--reference <entity-id>] [--mutation-id <id>]',
    sum: 'Grant points to an entity',
    authz: 'entity',
    input: 'bound',
    tags: ['score', 'award', 'reward'],
  },

  // ── closed kind-command namespace ────────────────────────────────────────
  'entities.commands.complete': {
    cmd: ['task', 'complete'],
    syn: 'tm8 task complete <task-id> --expect-version <n> --by <actor-id>... [--mutation-id <id>]',
    sum: 'Complete a task — the ONLY operation that may write status done',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['done', 'finish', 'close'],
    notes: [
      'it alone checks acceptance criteria and writes completer relationships, activity, and awards',
      '`task transition <id> done` is refused with invariant_violation / use_complete_command',
    ],
    examples: ['tm8 task complete <task-id> --expect-version <n> --by <actor-id>'],
  },
  'entities.commands.work': {
    cmd: ['task', 'transition'],
    syn: 'tm8 task transition <task-id> open|pulled|working|in_review|blocked|cancelled [--mutation-id <id>]',
    sum: 'Move a task through its work lifecycle, short of completion',
    authz: 'entity',
    input: 'bound',
    tags: ['status', 'working', 'blocked', 'progress', 'start'],
    notes: [
      'enum values use their exact contract spelling, including `in_review`',
      'transition time is Server-owned; a client cannot backdate lifecycle history',
    ],
  },
  'entities.commands.pull': {
    cmd: ['entity', 'pull'],
    syn: 'tm8 entity pull <entity-id> --pinned-version <n> [--local-id <id|none>] [--mutation-id <id>]',
    sum: 'Pin an entity version into a local working copy',
    authz: 'entity',
    input: 'bound',
    tags: ['claim', 'checkout', 'pin'],
  },
  'entities.commands.linkPr': {
    cmd: ['task', 'link-pr'],
    syn: 'tm8 task link-pr <task-id> <url> [--project <project-resource-id>] [--mutation-id <id>]',
    sum: 'Link a pull request to a task',
    authz: 'entity',
    input: 'bound',
    tags: ['pr', 'pull-request', 'github'],
  },
  'entities.commands.linkCommit': {
    cmd: ['task', 'link-commit'],
    syn: 'tm8 task link-commit <task-id> <url> [--project <project-resource-id>] [--mutation-id <id>]',
    sum: 'Link a commit to a task',
    authz: 'entity',
    input: 'bound',
    tags: ['commit', 'sha', 'git'],
  },
  'entities.commands.gate': {
    cmd: ['task', 'gate'],
    syn: 'tm8 task gate <task-id> <none|pr_merged> --expect-version <n> [--mutation-id <id>]',
    sum: 'Set the opt-in completion gate on a task — pr_merged refuses completion while a tracked PR is unmerged or CI-red',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['gate', 'pr', 'ci', 'complete'],
  },
  'tracking.refresh': {
    cmd: ['tracking', 'refresh'],
    syn: 'tm8 tracking refresh [<pull-request-or-commit-entity-id>...] [--mutation-id <id>]',
    sum: 'Re-poll external tracking state for linked pull requests and commits',
    authz: 'space',
    input: 'bound',
    tags: ['sync', 'github', 'poll'],
  },

  // ── edges ────────────────────────────────────────────────────────────────
  'edges.list': {
    cmd: ['edge', 'list'],
    syn: 'tm8 edge list [--source <entity-id>] [--target <entity-id>] [--type <edge-type>] [--direction incoming|outgoing] [--limit <count>] [--cursor <cursor>]',
    sum: 'Page edges by source, target, type, or direction',
    authz: 'space',
    input: 'none',
    tags: ['links', 'relationships'],
  },
  'edges.create': {
    cmd: ['edge', 'create'],
    syn: 'tm8 edge create <source-entity-id> <edge-type> <target-entity-id> [--props <json-source>] [--mutation-id <id>]',
    sum: 'Create one registered edge between two entities',
    authz: 'entity',
    input: 'bound',
    tags: ['link', 'relate', 'connect'],
    notes: ['`props.origin` is Server-owned and never accepted from a client'],
  },
  'edges.patch': {
    cmd: ['edge', 'update'],
    syn: 'tm8 edge update <edge-id> --props <json-source> [--mutation-id <id>]',
    sum: 'Change the properties of an edge',
    authz: 'entity',
    input: 'bound',
  },
  'edges.delete': {
    cmd: ['edge', 'delete'],
    syn: 'tm8 edge delete <edge-id> --yes [--mutation-id <id>]',
    sum: 'Delete an edge',
    authz: 'entity',
    input: 'unbound',
    notes: [
      'message-owned attachment edges and materialized profile edges refuse generic edge mutation; use their owner commands',
    ],
  },
  'edgeTypes.list': {
    cmd: ['edge', 'type', 'list'],
    syn: 'tm8 edge type list',
    sum: 'List the registered edge types and their endpoint rules',
    authz: 'server',
    input: 'none',
    tags: ['schema', 'registry', 'relationships'],
  },

  // ── messages ─────────────────────────────────────────────────────────────
  'messages.list': {
    cmd: ['message', 'list'],
    syn: 'tm8 message list <anchor-entity-id> [--root <message-id>] [--order oldest|newest] [--limit <count>] [--cursor <cursor>]',
    sum: 'Page the durable messages anchored to an entity',
    authz: 'entity',
    input: 'none',
    tags: ['read', 'thread', 'chat', 'conversation', 'inbox'],
    notes: [
      'pass --limit; unbounded listings measured several times larger',
      'the anchor id is positional — there is no --to/--for/--entity/--anchor flag here; --to belongs to message send',
    ],
  },
  'messages.post': {
    cmd: ['message', 'send'],
    syn: 'tm8 message send --to <anchor-entity-id> [--to <anchor-entity-id>...] [--conversation <origin-anchor-id>] [--reply-to <parent-message-id>] [<body>|-] [--body <text-source>] [--mention <actor-id>...] [--attach <file-entity-id>...] [--wait stored|settled] [--mutation-id <message-batch-id>]',
    sum: 'Create one durable message per anchor and attempt delivery',
    authz: 'entity',
    input: 'bound',
    // `session` and `work-session` are deliberate: addressing a live session is
    // what this operation IS, and an agent reaching for the retired `session
    // prompt` must land here rather than on a generic entity read.
    tags: [
      'reply', 'say', 'tell', 'notify', 'communicate', 'report', 'progress',
      'prompt', 'ask', 'session', 'work-session', 'coordinator',
    ],
    notes: [
      'this is the ONLY public communication action for text; there is no prompt, report, or progress command',
      'a work session is addressed like any other anchor — the message is stored first and delivered second',
      'reply with the exact target from an incoming envelope: `--to <anchor-id> --reply-to <message-id>`',
      '`--wait settled` never changes persistence: exit 11 means stored-but-unsettled, not failed',
      'body is limited to 10,000 characters (messages.post input schema, schemas.ts:1292); split longer reports into numbered messages on the same anchor',
    ],
    examples: [
      "tm8 message send --to <anchor-entity-id> '<body>' --mutation-id <uuid>",
      "tm8 message send --to <anchor-entity-id> --reply-to <message-id> '<body>' --mutation-id <uuid>",
    ],
  },
  'messages.edit': {
    cmd: ['message', 'update'],
    syn: 'tm8 message update <message-id> [<body>|-] [--body <text-source>] [--mention <actor-id>...] --expect-version <n> [--mutation-id <id>]',
    sum: 'Edit a stored message body or mentions under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
  },
  'messages.delete': {
    cmd: ['message', 'delete'],
    syn: 'tm8 message delete <message-id> --expect-version <n> --yes [--mutation-id <id>]',
    sum: 'Redact a stored message: the body becomes [redacted] and the row remains in the thread',
    authz: 'entity',
    // `bound`, not `unbound`: `DeleteMessageInput` is a real frozen DTO
    // (clientMutationId + required expectedVersion) and the Server binds it
    // 1:1. Matrices row 47 marks it amended-with-`expectedVersion`; row 51
    // (`commands.undo`) is what an actually-unbound row looks like. Claiming
    // `unbound` here also auto-appended a note saying no frozen binding
    // existed, which was simply false.
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['remove', 'redact', 'retract'],
    notes: [
      'this is a REDACTION and a state transition, not a row deletion: mentions and attachments are cleared, redacted_at is set, and pending deliveries are cancelled',
      'thread history survives — replies, ordering, and cursors are unaffected',
    ],
  },

  // ── collections / graph / placements / undo ──────────────────────────────
  'collections.query': {
    cmd: ['entity', 'query'],
    syn: 'tm8 entity query [--space <space-id>] [--kind <kind>...] [--subtree <entity-id>] [--work-status <status>...] [--assignee <actor-id>...] [--ready] [--limit <count>] [--cursor <cursor>]',
    sum: 'Query entities across a Space by kind, hierarchy, status, axis, assignee, or edge',
    authz: 'space',
    input: 'bound',
    tags: ['search', 'find', 'list', 'filter', 'tasks', 'my-work'],
    examples: ['tm8 entity query --kind task --assignee <actor-id> --work-status working'],
  },
  'graph.query': {
    cmd: ['graph', 'query'],
    syn: 'tm8 graph query [--space <space-id>] [--focus <entity-id>] [--hops <n>] [--edge-type <type>...] [--mode free|dependency] [--limit <count>] [--cursor <cursor>]',
    sum: 'Traverse the entity graph outward from a focus entity',
    authz: 'space',
    input: 'bound',
    tags: ['traverse', 'neighbours', 'dependencies'],
  },
  'placements.apply': {
    cmd: ['placement', 'apply'],
    syn: 'tm8 placement apply <source-entity-id> attach|assign|depend|subtask|embed|reparent <target-entity-id> [--mutation-id <id>]',
    sum: 'Apply one intent-level placement between two entities',
    authz: 'entity',
    input: 'bound',
    tags: ['drop', 'assign', 'attach', 'depend'],
  },
  'commands.undo': {
    cmd: ['undo', 'apply'],
    syn: 'tm8 undo apply <undo-token> [--mutation-id <id>]',
    sum: 'Redeem an undo token that a previous mutation returned',
    authz: 'space',
    input: 'unbound',
    tags: ['revert', 'rollback'],
    // The third note was INVERTED and is corrected here. Traced to source:
    // `undo_tokens.operation` (004:168) is the INVERSE to run, not the operation
    // that issued the token — `edges.create` issues one whose operation is
    // `edges.delete`, labelled "Undo link". The only issuer of a
    // `messages.delete`-inverse token is `placements.apply` with intent `embed`
    // (018:387, "Undo embed"); redemption dispatches it to
    // `w2_tombstone_message` (020:128), which sets body='[redacted]' (019:627).
    // The old text said redemption "restores a REDACTED message to visible" —
    // backwards, and it told an operator that history was recoverable when
    // redemption destroys more of it, inviting a destructive recovery against
    // data that was never lost.
    notes: [
      UNBOUND_NOTE,
      'not every mutation is undoable: a token is redeemable only when the operation that returned one issued it, and only while it is unspent',
      'a token names the INVERSE it will run, not the operation that issued it — the `messages.delete` inverse is the token an `embed` placement returns, and redeeming it REDACTS the message that placement posted',
      'no registered inverse un-redacts a message, and `message delete` returns no undo token at all: a redaction is not recovered by undoing anything',
    ],
  },

  // ── search — reserved ────────────────────────────────────────────────────
  'search.query': {
    cmd: ['search', 'query'],
    syn: 'tm8 search query <text> [--space <space-id>] [--kind <kind>...] [--limit <count>] [--cursor <cursor>]',
    sum: 'Full-text search across a Space — RESERVED in the frozen catalog and unavailable on every node',
    authz: 'space',
    input: 'none',
    tags: ['find', 'lookup', 'text'],
    reason: 'not_implemented',
    composite: 'collections.query',
    // The second note used to open "until it is built", which contradicted the
    // row it describes: this is one of the two PERMANENTLY reserved rows,
    // resolved by the `contract` source in the availability precedence and never
    // by observation. It is reserved rather than pending, so a roadmap here was
    // never a fact about anything. The alternatives stay — naming them is
    // genuinely useful and is not a roadmap — but they are what exists INSTEAD,
    // not what to use MEANWHILE.
    notes: [
      'the command exists so the capability is discoverable and answers honestly; it is never silently absent',
      'this row is reserved in the frozen catalog, not pending: `entity query` and `graph query` are the structural alternatives that exist instead',
    ],
  },

  // ── projects ─────────────────────────────────────────────────────────────
  'projects.list': {
    cmd: ['project', 'list'],
    syn: 'tm8 project list [--limit <count>] [--cursor <cursor>]',
    sum: 'List ProjectResources — the configuration truth behind working directories',
    authz: 'server',
    input: 'none',
    tags: ['repo', 'workdir'],
  },
  'projects.create': {
    cmd: ['project', 'create'],
    syn: 'tm8 project create <name> --working-dir <absolute-path> [--repo-url <url|none>] [--trust trusted|untrusted] [--default-model <name|none>] [--default-agent-tool <name|none>] [--default-mode worker|coordinator|coordinated-worker|coordinated-coordinator|dispatcher|none] [--mutation-id <id>]',
    sum: 'Register a ProjectResource',
    authz: 'server',
    input: 'bound',
  },
  'projects.directories.list': {
    cmd: null,
    sum: 'Browse allowed node-local directories for Space project onboarding',
    authz: 'server',
    input: 'none',
    tags: ['folder', 'directory', 'browse', 'workdir', 'local'],
    reason: 'ui_onboarding_only',
    notes: [
      'the browser onboarding flow invokes this root-confined read; tm8 CLI exposes no general filesystem browser',
    ],
  },
  'projects.get': {
    cmd: ['project', 'get'],
    syn: 'tm8 project get <project-resource-id>',
    sum: 'Read one ProjectResource',
    authz: 'project',
    input: 'none',
  },
  'projects.contention': {
    cmd: ['project', 'contention'],
    syn: 'tm8 project contention <project-resource-id>',
    sum: 'Report overlapping touched paths across the project\'s active worktree lanes',
    authz: 'project',
    input: 'none',
    tags: ['worktree', 'conflict', 'overlap', 'git'],
  },
  'projects.branches.list': {
    cmd: ['project', 'branches'],
    syn: 'tm8 project branches <project-resource-id> [--stale-after-days <days>] [--limit <count>]',
    sum: 'List local branches in a project working directory with ahead/behind and stale',
    authz: 'project',
    input: 'none',
    tags: ['git', 'branch', 'repo', 'workdir', 'stale', 'ahead', 'behind'],
    notes: [
      'a READ — git is invoked argv-only and nothing is checked out, fetched or written',
      'ahead/behind are measured against the default branch, whose SOURCE travels with the answer: main is a convention, not a rule',
    ],
  },
  'projects.update': {
    cmd: ['project', 'update'],
    syn: 'tm8 project update <project-resource-id> [--name <name>] [--working-dir <absolute-path>] [--trust trusted|untrusted] [--yes] [--mutation-id <id>]',
    sum: 'Change ProjectResource configuration',
    authz: 'project',
    input: 'bound',
  },
  'projects.link': {
    cmd: ['project', 'link'],
    syn: 'tm8 project link <project-resource-id> [--space <space-id>] [--mutation-id <id>]',
    sum: 'Link a ProjectResource into a Space and materialize its restricted projection',
    authz: 'space',
    input: 'bound',
    notes: [
      'the result carries BOTH identities: the ProjectResource id and the per-Space projection entity id — they are never interchangeable',
    ],
  },
  'projects.unlink': {
    cmd: ['project', 'unlink'],
    syn: 'tm8 project unlink <project-resource-id> [--space <space-id>] --yes [--mutation-id <id>]',
    sum: 'Unlink a ProjectResource from a Space',
    authz: 'space',
    input: 'unbound',
  },
  'projects.files.list': {
    cmd: null,
    sum: 'Browse files and folders inside one connected project working directory',
    authz: 'project',
    input: 'none',
    tags: ['file', 'folder', 'browse', 'local', 'attach'],
    reason: 'ui_project_browser_only',
    notes: [
      'confined to the project working directory AND to TM8_PROJECT_ROOTS; symlink rows are omitted rather than followed',
      'a CLI caller already holds the node filesystem and reaches these bytes with shell tools',
    ],
  },
  'projects.files.attach': {
    cmd: null,
    sum: 'Attach one file read from a connected project folder, without a browser byte transfer',
    authz: 'project',
    input: 'bound',
    tags: ['file', 'attach', 'local', 'folder'],
    reason: 'use_file_upload',
    notes: [
      'the browser cannot name an absolute node path, so a connected folder is readable only by the node holding it',
      '`tm8 file upload <path> --attach-to` is the CLI surface for the same outcome and carries the same ledger',
    ],
  },
  'projects.files.read': {
    cmd: null,
    sum: 'Read one file content inside a connected project working directory',
    authz: 'project',
    input: 'none',
    tags: ['file', 'view', 'read', 'local', 'browse'],
    reason: 'ui_project_browser_only',
    notes: [
      'confined to the project working directory AND to TM8_PROJECT_ROOTS; symlinks are refused rather than followed',
      'a CLI caller already holds the node filesystem and reaches these bytes with shell tools',
    ],
  },
  'projects.folderUploads.init': {
    cmd: null,
    sum: 'Freeze a browser folder-upload manifest and issue per-file byte grants',
    authz: 'space',
    input: 'bound',
    tags: ['file', 'folder', 'upload', 'project', 'import'],
    reason: 'ui_project_browser_only',
    notes: [
      'the browser-originated half of R7 folder import; a CLI caller already holds the node filesystem and links a directory as a project directly',
    ],
  },
  'projects.folderUploads.complete': {
    cmd: null,
    sum: 'Materialize a staged folder upload as a project working directory and link it to the Space',
    authz: 'space',
    input: 'bound',
    tags: ['file', 'folder', 'upload', 'project', 'import'],
    reason: 'ui_project_browser_only',
    notes: [
      "mode 'merge' replaces matching paths in place and reports replacedCount (R8); 'create' reserves a new root exclusively",
    ],
  },
  'projects.folderUploads.abort': {
    cmd: null,
    sum: 'Abort a pending folder upload and release its staged bytes',
    authz: 'space',
    input: 'bound',
    tags: ['file', 'folder', 'upload', 'project', 'import'],
    reason: 'ui_project_browser_only',
    notes: [
      'staged blobs and the frozen manifest are removed; nothing was materialized yet',
    ],
  },

  // ── files ────────────────────────────────────────────────────────────────
  // ── files ────────────────────────────────────────────────────────────────
  'files.uploadInit': {
    cmd: ['file', 'upload'],
    syn: 'tm8 file upload <path|-> [--space <space-id>] [--name <name>] [--mime <mime-type>] [--attach-to <entity-id>...] [--size <bytes>] [--sha256 <lowercase-hex>] [--mutation-id <id>]',
    sum: 'Begin a blob upload — the first stage of the `file upload` composition',
    authz: 'space',
    input: 'bound',
    tags: ['attach', 'blob'],
    notes: [
      '`file upload` is an explicit composition over init, transfer, and complete; each stage derives its OWN mutation id from the caller root',
    ],
  },
  'files.uploadComplete': {
    cmd: ['file', 'upload'],
    syn: 'tm8 file upload <path|-> [--attach-to <entity-id>...] [--mutation-id <id>]',
    sum: 'Finalize a blob upload and atomically create its requested attachment edges',
    authz: 'space',
    input: 'bound',
  },
  'files.uploadAbort': {
    cmd: ['file', 'upload', 'abort'],
    syn: 'tm8 file upload abort <upload-id> --yes [--mutation-id <id>]',
    sum: 'Abandon an in-flight upload; also invoked automatically on recoverable failure',
    authz: 'space',
    input: 'bound',
    tags: ['cancel', 'cleanup'],
  },
  'files.download': {
    cmd: ['file', 'download'],
    syn: 'tm8 file download <file-entity-id> --output <path|-> [--overwrite]',
    sum: 'Download file bytes',
    authz: 'entity',
    input: 'none',
    tags: ['fetch', 'blob', 'get'],
    notes: ['answers with raw bytes, so it is mutually exclusive with structured output'],
  },
  'bridge.fetchBlob': {
    cmd: null,
    sum: 'Cross-node blob fetch over the asymmetric Phase-2 bridge — RESERVED, and deliberately never a public command',
    authz: 'entity',
    input: 'none',
    tags: ['blob', 'bridge', 'remote', 'phase2'],
    reason: 'not_implemented',
    notes: [
      'this row has NO CLI command and will not grow one: it is an internal Server-to-Server path, not a caller-facing capability',
      'it stays in the catalog, and in this help, so it is discoverable rather than hidden',
      'the caller-facing way to read file bytes is `file download`',
    ],
    composite: 'files.download',
  },

  // ── per-member read state ────────────────────────────────────────────────
  'inbox.list': {
    cmd: ['inbox', 'list'],
    syn: 'tm8 inbox list [--for <team-member-id>] [--space <space-id>] [--unread] [--limit <count>] [--cursor <cursor>]',
    sum: 'Page this actor notifications',
    authz: 'server',
    input: 'none',
    tags: ['notifications', 'unread', 'mentions'],
    notes: ['a Member personal inbox excludes rows owned by their Teammates; `--for` inspects a Teammate feed separately'],
  },
  'inbox.markRead': {
    cmd: ['inbox', 'mark-read'],
    syn: 'tm8 inbox mark-read <notification-id> [--mutation-id <id>]',
    sum: 'Mark one notification read',
    authz: 'server',
    input: 'unbound',
    notes: ['`inbox mark-read` owns notification state; `message mark-read` owns an anchor read cursor'],
  },
  'readMarks.upsert': {
    cmd: ['message', 'mark-read'],
    syn: 'tm8 message mark-read <anchor-entity-id> --through <message-id> [--mutation-id <id>]',
    sum: 'Advance the read cursor on a message anchor',
    authz: 'entity',
    input: 'unbound',
    tags: ['seen', 'read-through', 'cursor'],
  },

  // ── saved views ──────────────────────────────────────────────────────────
  'savedViews.list': {
    cmd: ['saved-view', 'list'],
    syn: 'tm8 saved-view list [--space <space-id>]',
    sum: 'List every saved query in a Space, unpaginated',
    authz: 'space',
    input: 'none',
    tags: ['views', 'filters', 'bookmarks'],
    notes: [
      'this list is NOT paginated: the frozen contract defines no cursor and no limit for it, and the read returns a bare array rather than a page',
    ],
  },
  'savedViews.create': {
    cmd: ['saved-view', 'create'],
    syn: 'tm8 saved-view create <name> [--space <space-id>] --share private|space --query <json-source> [--graph-layout <json-source>] [--mutation-id <id>]',
    sum: 'Save a query as a reusable view',
    authz: 'space',
    input: 'bound',
  },
  'savedViews.update': {
    cmd: ['saved-view', 'update'],
    syn: 'tm8 saved-view update <saved-view-id> --name <name> --share private|space --query <json-source> [--graph-layout <json-source>] [--mutation-id <id>]',
    sum: 'Replace the name, sharing, and query of a saved view',
    authz: 'entity',
    input: 'bound',
    // NO version guard, at any layer: `SavedViewInput` is `.strict()` with no
    // `expectedVersion`, and the `SavedView` read DTO publishes no version a
    // caller could guard against even if it had one. Advertising the flag made
    // the CLI demand a value the Server would reject.
  },
  'savedViews.delete': {
    cmd: ['saved-view', 'delete'],
    syn: 'tm8 saved-view delete <saved-view-id> --yes [--mutation-id <id>]',
    sum: 'Delete a saved view',
    authz: 'entity',
    input: 'unbound',
  },

  // ── capability discovery ─────────────────────────────────────────────────
  'actions.list': {
    cmd: ['action', 'list'],
    syn: 'tm8 action list [--for <entity-id>]',
    sum: 'Ask what THIS actor may actually do on a target right now',
    authz: 'entity',
    input: 'none',
    tags: ['permissions', 'can-i', 'allowed', 'capabilities', 'palette'],
    notes: [
      'static help answers "what can tm8 express?"; this answers "what may I do here now?" — they are different questions',
      'results are bound to an actor, a Space, a target version, and a capabilityEpoch, and go stale in 30 seconds',
    ],
  },

  // ── events & presence ────────────────────────────────────────────────────
  'events.subscribe': {
    cmd: ['event', 'watch'],
    syn: 'tm8 event watch [--space <space-id>] [--after <space-seq>] [--type <event-type>...] [--entity <entity-id>...] [--presence] [--until-match]',
    sum: 'Stream Space events over the WebSocket — or, with --until-match, block until one matches',
    authz: 'space',
    input: 'none',
    side: 'none',
    tags: ['stream', 'follow', 'tail', 'live', 'realtime', 'wait', 'block', 'until'],
    // These notes state CONTRACT facts, not the state of this node. The row
    // previously said the socket was "an upgrade SKELETON … do not depend on it
    // for durable ordering yet", which was true when it was written and stopped
    // being true when `WorkspaceControlFrame`/`WorkspaceControlAck` landed. That
    // is the whole hazard: prose asserting a CURRENT state of the world has
    // nothing that goes red when the world moves. Whether THIS node serves the
    // socket is the `availability` axis's question, and it is measured, not
    // narrated; whether a roadmap lands is nobody's question here.
    notes: [
      'the contract defines a client→server control protocol on this socket: `subscribe`/`unsubscribe` are fan-out membership, `resume` is replay, `presence`/`presence.set` are the ephemeral channel, and a refused frame answers `control.refused` rather than going quiet',
      'a gap is repaired by re-watching with `--after <space-seq>`, which sends a `resume` frame replaying stored events over the socket; `event list` is the repair when no socket can be opened at all',
      'presence signals never advance the durable cursor',
      'with `--until-match` the watch becomes a bounded blocking wait: the first event matching --type/--entity is printed and the process exits — 0 matched on the stream, 14 matched via the events.poll fallback after the socket was lost, 13 nothing matched before the timeout; the global --timeout <seconds> is required and capped at 300 — longer waits belong to a scheduler re-invoking this command',
    ],
  },
  'events.poll': {
    cmd: ['event', 'list'],
    syn: 'tm8 event list [--space <space-id>] [--after <space-seq>] [--limit <count>]',
    // NOT "the reconnect stage" any more: `resume` repairs a gap over a socket
    // that is up, so the definite article claimed an exclusivity this row lost.
    // It is still exactly right for the socket-down case, which is why the
    // fix narrows the claim rather than dropping it.
    sum: 'Page durable Space events after a sequence — also the socket-down catch-up path for `event watch`',
    authz: 'space',
    input: 'none',
    tags: ['catch-up', 'replay', 'seq'],
  },
  'presence.get': {
    cmd: ['presence', 'get'],
    syn: 'tm8 presence get <entity-id>',
    sum: 'Read who is present on an entity',
    authz: 'entity',
    input: 'none',
    tags: ['online', 'who', 'typing'],
  },

  // ── execution ────────────────────────────────────────────────────────────
  'execution.spawn': {
    cmd: ['session', 'spawn'],
    syn: 'tm8 session spawn [--space <space-id>] --teammate <team-member-id> [--task <task-id>...] [--memory <memory-id>...] [--launch-project <project-resource-id>] [--workdir project|scratch|worktree] [--base-ref <ref>] [--mode worker|coordinator|coordinated-worker|coordinated-coordinator|dispatcher] [--access-mode safe|acceptEdits|auto|plan|fullAccess] [--interaction-profile <active-profile-id>] [--context <text-source>] [--confirm-untrusted] [--force-new-task] [--mutation-id <id>]',
    sum: 'Start a server-hosted work session for a Teammate',
    authz: 'space',
    input: 'bound',
    side: 'execution',
    tags: ['launch', 'start', 'agent', 'delegate', 'pty', 'terminal'],
    notes: [
      'the server-hosted PTY is the only spawn path; cwd is always Server-computed',
      '`--context` is launch-manifest context, NOT a runtime prompt',
      '`--memory` appends memory entities to the persona’s injected working set for THIS session only; nothing is written to the graph',
      'memories a `--task` task `remembers` are auto-injected after the persona’s working set (D9)',
      'omit `--access-mode` and a session spawned BY a session inherits its spawner’s posture',
      'worktree is not advertised until the node can create and clean one up safely',
    ],
  },
  'execution.terminal.start': {
    // NO CLI COMMAND, and it is a SCOPE DECISION rather than a refusal — the
    // same shape `credentials.*` takes above, and the same reasoning.
    //
    // 100 delivered this operation for the UI: "starting a shell session with
    // no agent FROM THE UI". Advertising `session terminal` in the grammar
    // without wiring a handler would break a real invariant, not just a count
    // — `discovery-commands.test.ts` asserts that EVERY command in the frozen
    // grammar is registered, and it has been empty-by-construction until now.
    // Documented-but-unwired is a state `run.ts` still models (exit 8), and
    // that test records out loud that no live example exists; manufacturing
    // one to save a row here would be the wrong way to spend that property.
    //
    // A CLI form would need no security change — a `cli`-kind human session is
    // the same principal a browser one is. It is simply not this task's scope,
    // and the row stays here so the operation is still DISCOVERABLE by exact
    // lookup and by tag.
    cmd: null,
    sum: 'Open a vanilla terminal — a shell session with no agent attached',
    authz: 'space',
    input: 'bound',
    side: 'execution',
    tags: ['terminal', 'shell', 'pty', 'vanilla', 'console'],
    notes: [
      'NO CLI COMMAND — a scope decision, not a refusal; 100 delivered this for the UI. A `cli` human session is the same principal a browser one is, so a CLI form would need no security change',
      'no Teammate, no model, no persona: this is the shell you get without `claude-code` or `codex` in front of it',
      'the shell is resolved Server-side and CANNOT be named by the caller — there is no command, args or flags input',
      'the cwd is the project ROOT when a project is named, never a provisioned worktree; with no project it is a Server-owned scratch directory and the row records `workdir_mode = scratch`',
      'NO CLIENT NAMES A PROJECT TODAY — the UI header has no project picker and there is no CLI command, so every terminal a human can start is currently projectless',
      'its own concurrency ceiling (`TM8_TERMINAL_CAP`, default 4), disjoint from the agent and credential caps',
      'attach to it exactly like any other session — `execution.streams.attach` asks no questions about session kind',
    ],
  },
  'execution.dispatch': {
    cmd: ['session', 'dispatch'],
    syn: 'tm8 session dispatch <subject-entity-id> [--space <space-id>] [--note <text>] [--force-new-task] [--mutation-id <id>]',
    sum: 'Hand an entity to the space’s dispatcher, which picks the teammate and spawns',
    authz: 'space',
    input: 'bound',
    side: 'execution',
    tags: ['dispatch', 'route', 'delegate', 'launch', 'triage'],
    notes: [
      'you do NOT name a teammate — choosing one is the dispatcher’s whole job; use `session spawn` when you already know who should do it',
      'any launchable entity works as the subject; it is derived to a task Server-side (064) exactly as `--task` is',
      'if no dispatcher session is alive the Server spawns one first and waits for it to settle, so the first dispatch in a space is the slow one',
      'liveness is probed, never read off `work_sessions.status` — `idle` is a legal live status and a crashed session keeps its last status forever',
      'the request reaches the dispatcher session id as a trusted envelope AND is stored on the task, so a missed delivery is still recoverable',
    ],
  },
  'execution.prompt': {
    cmd: null,
    sum: 'INTERNAL: the audited Server-side delivery of an already-stored message into a live session',
    authz: 'session',
    input: 'bound',
    side: 'execution',
    tags: ['delivery', 'internal'],
    reason: 'use_message_send',
    composite: 'messages.post',
    notes: [
      'there is no caller-facing form of this operation, and no flag, alias, or debug path enables one',
      'only the audited Server delivery principal may invoke it, and only for a delivery already reserved against a stored message',
      'to reach a live session, store a durable message addressed to it — persistence first, delivery second',
    ],
  },
  'execution.resume': {
    cmd: ['session', 'resume'],
    syn: 'tm8 session resume <work-session-id> [--mutation-id <id>]',
    sum: 'Resume an exited or failed work session — its agent relaunches with the full prior conversation restored',
    authz: 'session',
    input: 'bound',
    side: 'execution',
    tags: ['resume', 'restart', 'continue', 'revive', 'restore'],
    notes: [
      'exact-conversation resume via the provider-native session id the Server recorded; never a fresh restart presented as a resume',
      'refused for sessions whose agent tool has no resume-by-id contract, and for Codex sessions whose rollout cannot be located',
      'persona, project, tasks, model and cwd are re-read from the graph — the caller supplies nothing but the session id',
    ],
  },
  'execution.terminate': {
    cmd: ['session', 'terminate'],
    syn: 'tm8 session terminate <work-session-id> [--force] --yes [--mutation-id <id>]',
    sum: 'End a work session; `--force` requests hard process termination after the same checks',
    authz: 'session',
    input: 'bound',
    side: 'execution',
    tags: ['kill', 'stop', 'end'],
    notes: ['`--force` never broadens WHO may terminate a session; it only changes how the process is stopped'],
  },
  'execution.streams.attach': {
    cmd: ['session', 'attach'],
    syn: 'tm8 session attach <work-session-id> --mode view|drive [--grant-only] [--mutation-id <id>]',
    sum: 'Attach to a work session terminal stream in view or drive mode',
    authz: 'session',
    input: 'bound',
    side: 'execution',
    tags: ['terminal', 'pty', 'watch', 'drive'],
    notes: ['`--format json` implies `--grant-only`: interactive terminal bytes are not DTO output'],
  },
  'execution.journal': {
    cmd: ['session', 'journal'],
    syn: 'tm8 session journal <work-session-id> [--limit <count>] [--before <line-index>]',
    sum: "Read a session's own tm8 CLI command journal: what it ran, what it printed, and an estimate of the tokens each way",
    authz: 'entity',
    input: 'none',
    tags: ['journal', 'commands', 'history', 'tokens', 'audit', 'debug', 'usage'],
    notes: [
      'the journal records ONLY `tm8` commands — anything else the agent ran in its shell is not here, so this is not a shell history',
      'token counts are BYTE-DERIVED ESTIMATES of text crossing the CLI boundary, not the model provider’s reported usage, and never the session’s token spend',
      'character counts are exact; the estimate is derived from them by the named estimator',
      'a session spawned before this feature, or one launched without journaling, answers `available: false` rather than an empty journal',
    ],
  },
  'execution.launch': {
    cmd: ['session', 'launch'],
    syn: 'tm8 session launch <work-session-id>',
    sum: "Read what a session was TOLD at spawn: its system prompt, its first task prompt, and the manifest it was launched with",
    authz: 'entity',
    input: 'none',
    tags: ['manifest', 'prompt', 'spawn', 'config', 'teammate', 'debug', 'launch'],
    notes: [
      'the prompts are the BYTES that were sent to the agent, read back from storage — they are never recomposed from the manifest, so they cannot silently drift from what the agent actually received',
      'environment variable NAMES are recorded; VALUES are structurally absent and cannot be recovered here',
      'a session launched before prompt capture answers `prompts.unavailableReason: not_recorded` rather than an empty prompt',
      'the manifest is returned as-written, unvalidated, so a document from an older or newer build still renders instead of failing closed',
    ],
  },
  'execution.transcript': {
    cmd: ['session', 'transcript'],
    syn: 'tm8 session transcript <work-session-id> [--last <count>]',
    sum: "Read what a session's agent SAID: the newest turns of its own native transcript, plus tool and token totals",
    authz: 'entity',
    input: 'none',
    tags: ['transcript', 'history', 'output', 'agent', 'debug', 'stuck', 'tokens'],
    notes: [
      'these are the agent’s OWN turns, read from the transcript the agent itself writes — not the terminal, whose bytes are ANSI repaints, and not the CLI journal, which holds no model output at all',
      'the tail of the transcript is read, so `stats` describes the RETURNED WINDOW and not the session’s lifetime; `stats.partial` says which one you are looking at',
      'tool ARGUMENTS and tool OUTPUT are never returned — only that a tool was called and its name — because tool bodies are where file contents and secrets travel',
      'a session whose agent has not written a transcript yet answers `available: false` with a reason, never an empty conversation',
      '`stuck` is a HEURISTIC over tool calls without prose, not a liveness signal; `session liveness` is the authority on whether anything is running',
    ],
  },
  'execution.liveness': {
    cmd: ['session', 'liveness'],
    syn: 'tm8 session liveness [--space <space-id>]',
    sum: 'Read which work sessions in a Space have a live PTY on this server process right now',
    authz: 'space',
    input: 'none',
    tags: ['alive', 'live', 'pty', 'terminal', 'ghost', 'running'],
    notes: [
      'this is a point-in-time node observation, not a durable work-session status',
      '`nodeBootId` changes when the server process restarts, so snapshots from different boots are not directly comparable',
    ],
  },

  // ── custom entity kinds ──────────────────────────────────────────────────
  'entityKinds.list': {
    cmd: ['kind', 'list'],
    syn: 'tm8 kind list [--space <space-id>]',
    sum: 'List the entity kinds registered in a Space, core and custom',
    authz: 'space',
    input: 'none',
    tags: ['schema', 'types', 'registry', 'custom'],
  },
  'entityKinds.create': {
    cmd: ['kind', 'create'],
    syn: 'tm8 kind create <c:name> [--space <space-id>] --schema <json-source> [--icon <value|none>] [--capabilities <json-source>] [--mutation-id <id>]',
    sum: 'Register a custom entity kind in the `c:` namespace',
    authz: 'space',
    input: 'bound',
    tags: ['schema', 'custom', 'define'],
    notes: ['custom kinds are scalar-only and always live under the literal `c:` prefix'],
  },
  'entityKinds.update': {
    cmd: ['kind', 'update'],
    syn: 'tm8 kind update <c:name> [--space <space-id>] [--schema <json-source>] [--icon <value|none>] [--capabilities <json-source>] [--allow-tightening] [--yes] [--mutation-id <id>]',
    sum: 'Change a custom entity kind schema, icon, or capabilities',
    authz: 'space',
    input: 'bound',
    tags: ['schema', 'custom', 'migrate'],
    notes: [
      'a tightening change can invalidate existing rows, so it requires `--allow-tightening`',
      'there is deliberately no custom-kind delete command',
    ],
  },

  // ── W0 adopted additive rows A01-A20 ─────────────────────────────────────
  'spaces.menu.get': {
    cmd: ['space', 'menu', 'get'],
    syn: 'tm8 space menu get [<space-id>]',
    sum: 'Read the configured Space menu',
    authz: 'space',
    input: 'none',
    tags: ['navigation', 'sidebar'],
  },
  'spaces.menu.update': {
    cmd: ['space', 'menu', 'update'],
    syn: 'tm8 space menu update [<space-id>] --expect-revision <n> --data <json-source> [--mutation-id <id>]',
    sum: 'Replace the Space menu under a revision guard',
    authz: 'space',
    input: 'bound',
    ver: 'expectedVersion',
    notes: ['the guard is spelled `--expect-revision` here because the menu carries a revision, not an entity version'],
  },
  'spaces.defaultChannel.set': {
    cmd: ['space', 'default-channel', 'set'],
    syn: 'tm8 space default-channel set <channel-id|none> [--space <space-id>] --expect-revision <n> [--mutation-id <id>]',
    sum: 'Choose the channel a Space opens into, under a revision guard',
    authz: 'space',
    input: 'bound',
    ver: 'expectedVersion',
    notes: [
      'the guard is spelled `--expect-revision` here because it guards the Space settings revision, not an entity version',
    ],
  },
  'projects.associations.correct': {
    cmd: ['project', 'association', 'correct'],
    syn: 'tm8 project association correct <artifact-entity-id> --project <project-resource-id|none> --expect-version <n> [--mutation-id <id>]',
    sum: 'Correct the ProjectResource a pull request or commit was attributed to, under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['reattribute', 'fix', 'pr', 'commit'],
    notes: [
      'the guard is spelled `--expect-version` per the dossier grammar; it carries the DTO field `expectedArtifactVersion`, which guards the ARTIFACT version, not the ProjectResource',
    ],
  },
  'handoffs.send': {
    cmd: ['handoff', 'send'],
    syn: 'tm8 handoff send <work-session-id> --entity <source-entity-id> [--mutation-id <handoff-id>]',
    sum: 'Project a bounded entity snapshot into a work session',
    authz: 'session',
    input: 'bound',
    tags: ['share', 'context', 'projection'],
    notes: [
      'entity projection is a handoff, NOT a message attachment',
      'the envelope is capped at exactly 32,768 bytes',
    ],
    // The `[--expect-source-version <n>]` this row used to advertise appears in
    // the grammar doc §4 but in neither higher authority: `SendHandoffInput` is
    // `{clientMutationId, sourceEntityId}` in the dossier §4 AND in the frozen
    // `.strict()` schema, and dossier §7 spells the command without it. The
    // snapshot is taken as-of send; there is no moved-target refusal to opt in
    // to, so the note promising one has gone with the flag.
  },
  'handoffs.list': {
    cmd: ['handoff', 'list'],
    syn: 'tm8 handoff list <work-session-id> [--limit <count>] [--cursor <cursor>]',
    sum: 'Page the handoffs sent into a work session',
    authz: 'session',
    input: 'none',
  },
  'handoffs.withdraw': {
    cmd: ['handoff', 'withdraw'],
    syn: 'tm8 handoff withdraw <handoff-id> [--reason <text-source>] --expect-record-version <n> --yes [--mutation-id <id>]',
    sum: 'Withdraw a handoff that has not been consumed, under a record-version guard',
    authz: 'session',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['revoke', 'cancel'],
    notes: [
      'the guard is spelled `--expect-record-version` because `WithdrawHandoffInput` requires `expectedRecordVersion` — it guards the HANDOFF RECORD, not the projected entity',
    ],
  },
  'messages.attachments.add': {
    cmd: ['message', 'attachment', 'add'],
    syn: 'tm8 message attachment add <message-id> <file-entity-id>... --expect-version <n> [--mutation-id <id>]',
    sum: 'Attach finalized files to a stored message under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    notes: [
      'message-owned attachment edges have no generic edge surface: this command and its remove twin are their only mutation path',
      'each target audience must be a subset of the file audience, or the Server refuses with attachment_audience_widening',
    ],
  },
  'messages.attachments.remove': {
    cmd: ['message', 'attachment', 'remove'],
    syn: 'tm8 message attachment remove <message-id> <file-entity-id>... --expect-version <n> [--mutation-id <id>]',
    sum: 'Detach files from a stored message under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
  },
  'messages.delivery.get': {
    cmd: ['message', 'delivery'],
    syn: 'tm8 message delivery <message-id>',
    sum: 'Read the delivery outcome of a stored message',
    authz: 'entity',
    input: 'none',
    tags: ['status', 'delivered', 'pending', 'settled'],
    notes: ['storage and delivery are different facts: a stored message with a pending delivery was NOT lost'],
  },
  'entities.feed': {
    cmd: ['entity', 'feed'],
    syn: 'tm8 entity feed <entity-id> [--scope direct_v1|session_chat_v1] [--order newest|oldest] [--around <feed-item-ref>] [--limit <count>] [--cursor <cursor>]',
    sum: 'Page one merged message-and-activity timeline for an entity',
    authz: 'entity',
    input: 'none',
    tags: ['timeline', 'history', 'chat', 'activity'],
    notes: [
      'unbounded calls return the whole merged timeline; pass --limit and continue with --cursor',
    ],
  },
  'entities.context': {
    cmd: ['entity', 'context'],
    syn: 'tm8 entity context <entity-id> [--sections <summary|hierarchy|connections|messages|activity|actions>[,...]] [--total-bytes <1024..32768>] [--section-bytes <512..8192>]',
    sum: 'Read a bounded snapshot of an entity with its parents, children, edges, recent messages, and available actions',
    authz: 'entity',
    input: 'none',
    tags: ['snapshot', 'around', 'brief', 'orient'],
    notes: [
      'exactly three flags bind — --sections, --total-bytes, --section-bytes (EntityContextQuery); --depth/--messages/--children/--edge-type never bound and are gone',
      'bounded by design: defaults are 16 KiB total and 4 KiB per section (service source); hard caps 32 KiB and 8 KiB (frozen schema)',
      'returned cursors.messages/.activity continue in `entity feed --cursor` (--order newest); cursors.children has no consumer in this grammar',
      '--sections summary,actions is a precise pre-mutation capability + version check for a few hundred tokens',
    ],
    examples: ['tm8 entity context <entity-id> --sections summary,actions'],
  },
  'interactionProfiles.propose': {
    cmd: ['interaction-profile', 'propose'],
    syn: 'tm8 interaction-profile propose --data <json-source> [--mutation-id <id>]',
    sum: 'Propose a draft Interaction Profile',
    authz: 'space',
    input: 'bound',
    tags: ['profile', 'policy', 'draft'],
  },
  'interactionProfiles.updateDraft': {
    cmd: ['interaction-profile', 'update'],
    syn: 'tm8 interaction-profile update <id> --expect-version <n> --data <json-source> [--mutation-id <id>]',
    sum: 'Edit an Interaction Profile draft',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    notes: ['a Teammate may edit only a draft it proposed; a human Space owner or admin may edit any accessible draft'],
  },
  'interactionProfiles.validate': {
    cmd: ['interaction-profile', 'validate'],
    syn: 'tm8 interaction-profile validate <id> --expect-version <n> [--mutation-id <id>]',
    sum: 'Validate a draft and record the validated artifact and its hash',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
  },
  'interactionProfiles.preview': {
    cmd: ['interaction-profile', 'preview'],
    syn: 'tm8 interaction-profile preview <id> --version <n>',
    sum: 'Preview the sanitized effect of a profile version',
    authz: 'entity',
    input: 'bound',
    notes: ['preview is a READ and deliberately takes no mutation id'],
  },
  'interactionProfiles.activate': {
    cmd: ['interaction-profile', 'activate'],
    syn: 'tm8 interaction-profile activate <id> --validated-version <n> --validation-hash <hash> --yes [--mutation-id <id>]',
    sum: 'Activate an exact validated profile version',
    authz: 'entity',
    input: 'bound',
    notes: [
      '`--validated-version` selects the recorded validated artifact; it is NOT an optimistic guard on the latest draft',
      'activation cannot set a default — a separate human default-setting command is required',
      'an agent token or `--as <team-member-id>` is refused here',
    ],
  },
  'interactionProfiles.retire': {
    cmd: ['interaction-profile', 'retire'],
    syn: 'tm8 interaction-profile retire <id> --expect-version <n> --yes [--mutation-id <id>]',
    sum: 'Retire an Interaction Profile, under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    notes: ['refused while any Teammate or Space default still targets it (profile_default_in_use)'],
  },
  'teamMembers.interactionProfile.setDefault': {
    cmd: ['teammate', 'interaction-profile', 'set-default'],
    syn: 'tm8 teammate interaction-profile set-default <team-member-id> <interaction-profile-id|none> --expect-version <n> --yes [--mutation-id <id>]',
    sum: 'Set the default Interaction Profile for a Teammate, under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
  },
  'spaces.interactionProfile.setDefault': {
    cmd: ['space', 'interaction-profile', 'set-default'],
    syn: 'tm8 space interaction-profile set-default <interaction-profile-id|none> [--space <space-id>] --expect-settings-revision <n> --yes [--mutation-id <id>]',
    sum: 'Set the default Interaction Profile for a Space, under a settings-revision guard',
    authz: 'space',
    input: 'bound',
    ver: 'expectedVersion',
    notes: [
      'requires an authenticated human Member with the Space owner/admin capability',
      'the guard is spelled `--expect-settings-revision` because `SetSpaceProfileDefaultInput` requires `expectedSettingsRevision` — the Space settings row carries the revision',
    ],
  },

  // ── voice channels (LiveKit) ─────────────────────────────────────────────
  'voice.token.create': {
    cmd: ['voice', 'token'],
    syn: 'tm8 voice token <voice-channel-id> [--mutation-id <id>]',
    sum: 'Mint a room-join grant for a voice_channel — a LiveKit access token, never audio bytes',
    authz: 'entity',
    input: 'bound',
    tags: ['livekit', 'audio', 'join', 'webrtc'],
    notes: [
      'audio never touches tm8-server — the browser connects directly to LiveKit with this grant',
      'the grant expires in 10 minutes; call again to reconnect',
    ],
  },

  // ── artifacts (versioned, viewable static-web bundles) ────────────────────
  // `artifact publish` is a COMPOSED command over two catalog rows exactly as
  // `file upload` composes uploadInit/uploadComplete: create for a new artifact,
  // publish for a further revision under a version guard. Both map to the ONE
  // command path `artifact publish`; the command index uses the head (create)
  // row's syntax, so the two syntaxes are kept identical to avoid drift.
  'artifacts.create': {
    cmd: ['artifact', 'publish'],
    // NO `--expect-version` here: creating a new artifact has no prior version to
    // guard against, and the guard-honesty invariant (a row advertises a guard
    // flag IFF its `ver:` is `expectedVersion`) turns a stray one red. The
    // revision-mode flags live on the `artifacts.publish` row's syntax and are
    // named in the note below so the shared command help still documents them.
    syn: 'tm8 artifact publish <dir> [--space <space-id>] [--name <name>] [--description <text>] [--entrypoint <path>] [--mutation-id <id>]',
    sum: 'Publish a directory of HTML/JS/CSS as a NEW artifact with its first immutable bundle revision',
    authz: 'space',
    input: 'bound',
    tags: ['artifact', 'bundle', 'web', 'html', 'publish', 'deploy'],
    notes: [
      '`artifact publish` is a composition: it walks the directory, builds and hashes the strict model-agnostic manifest, then calls artifacts.create (or artifacts.publish with --artifact + --expect-version)',
      'to publish a FURTHER revision of an existing artifact instead of creating a new one, pass `--artifact <artifact-id>` and `--expect-version <n>` together',
      'blob upload wiring is Phase-1-incomplete: the Server may answer unknown_blob (invalid_input) because a referenced blob is not yet stored; that refusal is surfaced honestly rather than pre-swallowed',
    ],
    examples: ['tm8 artifact publish ./site --name "My App" --space <space-id>'],
  },
  'artifacts.publish': {
    cmd: ['artifact', 'publish'],
    syn: 'tm8 artifact publish <dir> --artifact <artifact-id> --expect-version <n> [--entrypoint <path>] [--mutation-id <id>]',
    sum: 'Publish a further immutable revision of an existing artifact, under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['artifact', 'revision', 'republish'],
  },
  'artifacts.revisions.list': {
    cmd: ['artifact', 'revisions'],
    syn: 'tm8 artifact revisions <artifact-id>',
    sum: 'List the immutable bundle revisions of an artifact, newest first',
    authz: 'entity',
    input: 'none',
    tags: ['artifact', 'revisions', 'history'],
  },
  'artifacts.preview.start': {
    cmd: ['artifact', 'preview'],
    syn: 'tm8 artifact preview <artifact-id> [--revision <n>] [--mutation-id <id>]',
    sum: 'Mint a viewer-bound, expiring preview session for a revision and PRINT what the Server returns — opens no browser',
    authz: 'entity',
    input: 'bound',
    tags: ['artifact', 'preview', 'view', 'run'],
    notes: [
      'this prints exactly what the Server returns (session id, token, expiry); it never opens a browser',
      'a usable preview URL does not exist until the preview-origin isolation decision lands (design §9.1-§9.3); until then only the session fields are returned',
    ],
  },
  'artifacts.export': {
    cmd: ['artifact', 'export'],
    syn: 'tm8 artifact export <artifact-id> [--revision <n>] [--out <path>]',
    sum: 'Download one revision as a deterministic application/zip bundle',
    authz: 'entity',
    input: 'none',
    tags: ['artifact', 'export', 'zip', 'download'],
    notes: [
      'answers with raw zip bytes, so it is mutually exclusive with structured output',
      '`--revision` defaults to the artifact current revision, resolved with one `entity get`',
    ],
  },
  'artifacts.restore': {
    cmd: ['artifact', 'restore'],
    syn: 'tm8 artifact restore <artifact-id> --revision <n> --expect-version <n> [--mutation-id <id>]',
    sum: 'Publish an older revision anew as the latest revision, under a version guard',
    authz: 'entity',
    input: 'bound',
    ver: 'expectedVersion',
    tags: ['artifact', 'restore', 'revert', 'revision'],
    notes: [
      'restore is append-only: it creates a NEW revision whose provenance records the source revision, never mutating history',
    ],
  },
};

/**
 * Operation family → noun. Identical to the conformance generator's mapping by
 * construction: the cross-check test asserts agreement row by row, so a
 * divergence here is a test failure rather than a silent second vocabulary.
 *
 * The family noun is NOT always the command noun. `collections.query` is family
 * `collection` and command `entity query`; `entities.commands.complete` is
 * family `entity` and command `task complete`. Both are indexed, so `tm8 help
 * collection` and `tm8 help task` both resolve.
 */
const NOUN_BY_FAMILY: Record<string, string> = {
  identity: 'identity',
  auth: 'auth',
  serverConnections: 'server',
  spaces: 'space',
  entities: 'entity',
  attentionRequests: 'attention',
  tracking: 'tracking',
  edges: 'edge',
  edgeTypes: 'edge-type',
  messages: 'message',
  collections: 'collection',
  graph: 'graph',
  placements: 'placement',
  commands: 'undo',
  search: 'search',
  projects: 'project',
  files: 'file',
  bridge: 'bridge',
  inbox: 'inbox',
  readMarks: 'read-mark',
  savedViews: 'saved-view',
  actions: 'action',
  events: 'event',
  presence: 'presence',
  execution: 'session',
  entityKinds: 'kind',
  handoffs: 'handoff',
  interactionProfiles: 'interaction-profile',
  teamMembers: 'teammate',
  voice: 'voice',
  artifacts: 'artifact',
  // Required even though all four `credentials.*` rows are `cmd: null`: the
  // noun groups them in `tm8 help`, so they are DISCOVERABLE rather than
  // hidden. Someone asking "can tm8 manage my vendor logins?" gets an answer.
  credentials: 'credential',
};

function nounFor(operation: OperationName): string {
  const family = operation.split('.')[0] as string;
  const noun = NOUN_BY_FAMILY[family];
  if (noun === undefined) throw new Error(`operation ${operation} has no noun disposition`);
  return noun;
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * Tokens the operation name itself yields — identical to the conformance
 * generator's algorithm, so every tag the manifest promised is present.
 */
function catalogTags(operation: OperationName): string[] {
  return [
    ...new Set(
      operation
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[.\s]+/)
        .map((w) => w.toLowerCase()),
    ),
  ];
}

function exposureFor(operation: OperationName): Exposure {
  const op = getOperation(operation);
  if (op.status === 'reserved') return 'reserved';
  if (operation === 'execution.prompt') return 'internal';
  if (operation === 'messages.post') return 'composite';
  return 'public';
}

/**
 * The digest every help shard carries — `sha256(JSON.stringify(OPERATIONS))`.
 *
 * PINNED RATHER THAN COMPUTED, and the reason is reach, not performance. This
 * module is the largest body of agent-facing prose in the repo (107 rows of
 * summaries, syntax, notes and examples), and the prompt catalog screen shows
 * it to operators. `node:crypto` was the ONE import in the whole `discovery/`
 * tree that a browser bundle cannot resolve, so computing the digest here made
 * every row unreachable from the UI to save a constant.
 *
 * It cannot drift: the digest is a pure function of static contract data, and
 * `test/discovery-operations.test.ts` recomputes it with `node:crypto` and
 * fails on any mismatch. Change the contract and that test tells you the new
 * value to paste here.
 */
export const CATALOG_DIGEST =
  'sha256:e5d6daf264df74f231e5a963375506e93c51e1f712477309cdfcb53be57b7992';

export const GRAMMAR_VERSION = '2';

interface BaseRow extends Omit<OperationDiscovery, 'availability' | 'availabilityReason' | 'availabilitySource'> {
  status: 'v1' | 'reserved';
}

function build(operation: OperationName): BaseRow {
  const row = ROWS[operation];
  const op = getOperation(operation);
  const noun = nounFor(operation);
  const verb = row.cmd === null ? kebab(operation.split('.').slice(-1)[0] as string) : (row.cmd[row.cmd.length - 1] as string);
  const notes = [...(row.notes ?? [])];
  if (row.input === 'unbound' && !notes.includes(UNBOUND_NOTE)) notes.push(UNBOUND_NOTE);

  return {
    operation,
    noun,
    verb,
    exposure: exposureFor(operation),
    summary: row.sum,
    intentTags: [
      ...new Set([...catalogTags(operation), noun, verb, ...(row.cmd ?? []), ...(row.tags ?? [])]),
    ],
    inputSchemaRef: row.input === 'none' ? null : `tm8://schema/${operation}/input`,
    outputSchemaRef: `tm8://schema/${operation}/output`,
    sideEffect: row.side ?? (op.kind === 'command' ? 'durable' : 'none'),
    authzTarget: row.authz,
    idempotency: op.kind === 'command' ? 'required' : 'none',
    versioning: row.ver ?? 'none',
    helpRef: `tm8://help/operation/${operation}`,
    command: row.cmd,
    syntax: row.cmd === null ? null : (row.syn as string),
    inputSchemaBound: row.input === 'bound',
    notes,
    reason: row.reason ?? null,
    publicComposite: row.composite ?? null,
    examples: row.examples ?? [],
    status: op.status,
  };
}

const BASE: readonly BaseRow[] = OPERATIONS.map((op) => build(op.name));
const BY_NAME = new Map<OperationName, BaseRow>(BASE.map((r) => [r.operation, r]));

function withAvailability(row: BaseRow, from?: AvailabilityLedger): OperationDiscovery {
  const { status, ...rest } = row;
  return { ...rest, ...resolveAvailability(row.operation, status, from) };
}

/**
 * Every row, in catalog order, with availability resolved against the ledger.
 *
 * Memoized against the DEFAULT ledger's revision only. An explicitly passed
 * ledger is always re-resolved, because a cache keyed on the wrong ledger is
 * how a projection starts answering for a node the caller is no longer talking
 * to — and a stale availability claim is worse than recomputing 107 rows.
 */
let cached: { rev: number; rows: readonly OperationDiscovery[] } | undefined;

export function discovery(from?: AvailabilityLedger): readonly OperationDiscovery[] {
  if (from !== undefined) return BASE.map((r) => withAvailability(r, from));
  const rev = ledger.revision();
  if (cached === undefined || cached.rev !== rev) {
    cached = { rev, rows: BASE.map((r) => withAvailability(r)) };
  }
  return cached.rows;
}

/**
 * The default projection. A getter-backed array so a caller reading
 * `DISCOVERY` after an observation sees the updated availability rather than a
 * frozen snapshot taken at import time.
 */
export const DISCOVERY: readonly OperationDiscovery[] = new Proxy([] as OperationDiscovery[], {
  get(_target, prop, receiver) {
    return Reflect.get(discovery(), prop, receiver) as unknown;
  },
  has: (_t, prop) => Reflect.has(discovery(), prop),
  ownKeys: () => Reflect.ownKeys(discovery()),
  getOwnPropertyDescriptor: (_t, prop) =>
    Reflect.getOwnPropertyDescriptor(discovery(), prop),
}) as readonly OperationDiscovery[];

/** Exact-operation lookup. TOTAL over all 107 rows, internal and reserved included. */
export function discoveryFor(operation: OperationName, from?: AvailabilityLedger): OperationDiscovery {
  const row = BY_NAME.get(operation);
  /* c8 ignore next */
  if (row === undefined) throw new Error(`no CLI disposition for operation ${operation}`);
  return withAvailability(row, from);
}

/** `--operation <name>` from an untrusted string. */
export function lookupOperation(raw: string, from?: AvailabilityLedger): OperationDiscovery | undefined {
  return isOperationName(raw) ? discoveryFor(raw, from) : undefined;
}

// ── the command index ──────────────────────────────────────────────────────

export interface CommandDiscovery {
  /** `message send` — the space-joined path, as a caller types it. */
  command: string;
  path: readonly string[];
  noun: string;
  verb: string;
  /** Every operation this one command projects. `file upload` maps two. */
  operations: readonly OperationName[];
  exposure: Exposure;
  summary: string;
  syntax: string;
  sideEffect: SideEffect;
  idempotency: Idempotency;
  versioning: Versioning;
  notes: readonly string[];
  examples: readonly string[];
  helpRef: string;
  availability: Availability;
  availabilityReason: AvailabilityReason;
  /**
   * The source of the WEAKEST stage's verdict — carried with the availability
   * and reason it belongs to, never left behind.
   *
   * It exists because the three fields are ONE verdict read from one row. When
   * only the first two were rolled up, a command whose weakest stage was
   * `observed` could report that stage's availability and reason beside the
   * HEAD stage's source, producing `(unavailable, not_implemented_on_node,
   * contract)` — a triple `resolveAvailability` cannot produce for any single
   * operation, and one that reads as a PERMANENT, NODE-INDEPENDENT contract
   * verdict when the truth is node-local and cleared by re-pointing.
   */
  availabilitySource: AvailabilitySource;
}

const COMMAND_ORDER: string[] = [];
const COMMAND_OPS = new Map<string, OperationName[]>();
for (const row of BASE) {
  if (row.command === null) continue;
  const key = row.command.join(' ');
  const existing = COMMAND_OPS.get(key);
  if (existing) existing.push(row.operation);
  else {
    COMMAND_OPS.set(key, [row.operation]);
    COMMAND_ORDER.push(key);
  }
}

const COMMAND_ALIASES = new Map<string, {
  path: readonly string[];
  syntax: string;
  summary: string;
  notes: readonly string[];
  examples: readonly string[];
}>([
  ['message reply', {
    path: ['message', 'reply'],
    syntax: 'tm8 message reply <message-id> [<body>|-] [--body <text-source>] [--mention <actor-id>...] [--attach <file-entity-id>...] [--wait stored|settled] [--mutation-id <message-batch-id>]',
    summary: 'Reply through a delivered message’s immutable source route',
    notes: [
      'the Server derives both anchor and parent from the delivered message id; no ambient last-source state is used',
      'requires the session-bound agent credential for the work session that received that message',
    ],
    examples: ["tm8 message reply <message-id> '<body>' --mutation-id <uuid>"],
  }],
  // `worktree list|status` are SUGAR over operations that already exist, which
  // is what keeps the catalog closed while the grammar grows. They are aliases
  // for exactly that reason: an alias declares a second spelling of an existing
  // operation, and a new catalog row would have been a second way to ask a
  // question `collections.query` already answers.
  ['worktree list', {
    path: ['worktree', 'list'],
    syntax: 'tm8 worktree list [--space <space-id>] [--status active|merged|abandoned|deleted] [--limit <count>] [--cursor <cursor>]',
    summary: 'Isolated Git checkouts in this Space, with branch, status, and the base commit',
    notes: [
      'sugar over collections.query with kinds:[worktree] — it adds no catalog operation',
      '--status narrows the returned page CLIENT-SIDE (CollectionQuery names no worktree status filter), so a page can come back emptier than --limit',
      'the checkout path is not in the collection projection; read it with `tm8 worktree status <id>`',
    ],
    examples: ['tm8 worktree list --space <space-id> --status active'],
  }],
  ['worktree status', {
    path: ['worktree', 'status'],
    syntax: 'tm8 worktree status <worktree-id> [--space <space-id>]',
    summary: 'One worktree in full — status, branch, resolved base commit, and its path on disk',
    notes: [
      'sugar over entities.get; the path lives in the hydrated detail row, which entities.context only excerpts',
      'the base COMMIT is shown beside the ref because refs move and the ref alone is not what the session got',
    ],
    examples: ['tm8 worktree status <worktree-id>'],
  }],
  // The Tier 2 mutating git verbs are ALIASES for the same reason `worktree
  // list|status` are: every graph touch is an operation that already exists
  // (entities.get + edges.list resolve, messages.post writes the receipt,
  // attentionRequests.create raises a conflict), and the git mutation itself
  // is local argv-only execution, which the catalog does not model. A
  // `worktrees.checkpoint` row would have opened the catalog for a command
  // whose graph writes are all existing doors.
  ['session checkpoint', {
    path: ['session', 'checkpoint'],
    syntax: 'tm8 session checkpoint <session-id|worktree-id> [--message <text>] [--mutation-id <id>]',
    summary: "Commit the session worktree's entire WIP to its branch and return the checkpoint ref",
    notes: [
      'a clean tree is a success that creates nothing — the ref is HEAD itself',
      'writes a durable receipt on the session anchor via messages.post; git runs argv-only on this host at the graph-recorded path',
    ],
    examples: ['tm8 session checkpoint <session-id>'],
  }],
  ['session rollback', {
    path: ['session', 'rollback'],
    syntax: 'tm8 session rollback <session-id|worktree-id> --to <checkpoint-ref> [--force] [--mutation-id <id>]',
    summary: 'Restore the session worktree to a checkpoint; untracked files refuse without --force',
    notes: [
      'tracked WIP is what a rollback discards; rolled-over commits stay reflog-reachable, so a rollback is reversible',
      'untracked files may exist in NO commit — deleting them is the one unrecoverable act, hence the --force gate',
    ],
    examples: ['tm8 session rollback <session-id> --to <oid>'],
  }],
  ['worktree stage', {
    path: ['worktree', 'stage'],
    syntax: 'tm8 worktree stage <session-id|worktree-id> [<pathspec>...]',
    summary: 'List changed files (no pathspecs), or stage the named pathspecs ("." for all)',
    notes: [
      'with no pathspecs it lists and stages NOTHING — the read-first half of the commit rail',
      'pathspecs ride behind a literal `--`; options, absolute paths and ".." traversal are refused locally',
    ],
    examples: ['tm8 worktree stage <session-id>', 'tm8 worktree stage <session-id> src/a.ts'],
  }],
  ['worktree commit', {
    path: ['worktree', 'commit'],
    syntax: 'tm8 worktree commit <session-id|worktree-id> --message <text> [--mutation-id <id>]',
    summary: 'Commit exactly what is staged in the session worktree, with a durable receipt',
    notes: ['an empty index is a refusal, never an empty commit'],
    examples: ["tm8 worktree commit <session-id> --message 'feat: …'"],
  }],
  ['worktree merge', {
    path: ['worktree', 'merge'],
    syntax: 'tm8 worktree merge <session-id|worktree-id> --from <ref> [--task <task-id>] [--mutation-id <id>]',
    summary: 'Merge a ref into the session branch; a conflict aborts cleanly and is surfaced durably',
    notes: [
      'on conflict: abort + verify clean, then a message listing conflicted paths on the owning task anchor (fallback session, then worktree) AND attentionRequests.create — never silent, never mid-merge',
      'merging the session branch INTO base is refused by design: base is checked out in the user’s tree or nowhere',
    ],
    examples: ['tm8 worktree merge <session-id> --from main'],
  }],
]);
COMMAND_OPS.set('message reply', ['messages.post']);
const messageSendIndex = COMMAND_ORDER.indexOf('message send');
COMMAND_ORDER.splice(messageSendIndex < 0 ? COMMAND_ORDER.length : messageSendIndex + 1, 0, 'message reply');
COMMAND_OPS.set('worktree list', ['collections.query']);
COMMAND_OPS.set('worktree status', ['entities.get']);
COMMAND_ORDER.push('worktree list', 'worktree status');
// Tier 2 git verbs: availability = the weakest of the operations each one
// actually invokes on the wire (resolution reads + the durable writes).
COMMAND_OPS.set('session checkpoint', ['entities.get', 'edges.list', 'messages.post']);
COMMAND_OPS.set('session rollback', ['entities.get', 'edges.list', 'messages.post']);
COMMAND_OPS.set('worktree stage', ['entities.get', 'edges.list']);
COMMAND_OPS.set('worktree commit', ['entities.get', 'edges.list', 'messages.post']);
COMMAND_OPS.set('worktree merge', ['entities.get', 'edges.list', 'messages.post', 'attentionRequests.create']);
COMMAND_ORDER.push('session checkpoint', 'session rollback', 'worktree stage', 'worktree commit', 'worktree merge');

/**
 * A command is as available as its LEAST available stage. `file upload` that
 * can initialize but not complete is not an available command, and saying it is
 * would be the optimistic answer this whole field exists to refuse.
 */
function weakest(
  rows: readonly OperationDiscovery[],
): Pick<CommandDiscovery, 'availability' | 'availabilityReason' | 'availabilitySource'> {
  const rank: Record<Availability, number> = { unavailable: 0, unknown: 1, available: 2 };
  let worst = rows[0] as OperationDiscovery;
  for (const r of rows) if (rank[r.availability] < rank[worst.availability]) worst = r;
  // ALL THREE FROM `worst`, never two from here and one from elsewhere.
  return {
    availability: worst.availability,
    availabilityReason: worst.availabilityReason,
    availabilitySource: worst.availabilitySource,
  };
}

function commandFrom(key: string, from?: AvailabilityLedger): CommandDiscovery {
  const operations = COMMAND_OPS.get(key) as OperationName[];
  const rows = operations.map((o) => discoveryFor(o, from));
  const head = rows[0] as OperationDiscovery;
  const alias = COMMAND_ALIASES.get(key);
  const path = alias?.path ?? head.command as readonly string[];
  return {
    command: key,
    path,
    noun: path[0] as string,
    verb: path[path.length - 1] as string,
    operations,
    exposure: head.exposure,
    summary: alias?.summary ?? head.summary,
    syntax: alias?.syntax ?? head.syntax as string,
    sideEffect: head.sideEffect,
    idempotency: head.idempotency,
    versioning: head.versioning,
    notes: alias?.notes ?? [...new Set(rows.flatMap((r) => r.notes))],
    examples: alias?.examples ?? head.examples,
    helpRef: `tm8://help/${path.join('/')}`,
    ...weakest(rows),
  };
}

export function commands(from?: AvailabilityLedger): readonly CommandDiscovery[] {
  return COMMAND_ORDER.map((key) => commandFrom(key, from));
}

export function commandDiscovery(
  path: readonly string[],
  from?: AvailabilityLedger,
): CommandDiscovery | undefined {
  const key = path.join(' ');
  return COMMAND_OPS.has(key) ? commandFrom(key, from) : undefined;
}

/** Every registered command path — the closed set the router and completion share. */
export const COMMAND_PATHS: readonly (readonly string[])[] = COMMAND_ORDER.map((k) => k.split(' '));

export function isCommandPath(path: readonly string[]): boolean {
  return COMMAND_OPS.has(path.join(' '));
}

// ── the noun index ─────────────────────────────────────────────────────────

/**
 * One-line noun summaries. Root help is capped at 8 KiB and must still name
 * EVERY public noun, so these are deliberately short.
 */
const NOUN_SUMMARY: Record<string, string> = {
  identity: 'Who this process is calling as',
  auth: 'Local accounts: sign up, log in, log out, and inspect the current session',
  server: 'Named routes to other tm8 Servers',
  space: 'Spaces — the authorization and event boundary, and their members, invites, axes, and menus',
  entity: 'Every entity kind: read, create, update, move, query, and relate',
  attention: 'Scored requests for human attention across every entity kind',
  task: 'Task lifecycle: transition, complete, and link pull requests or commits',
  tracking: 'Refresh external pull-request and commit tracking state',
  edge: 'Typed relationships between entities, and the edge-type registry',
  'edge-type': 'The registered edge types and their endpoint rules',
  collection: 'Structured entity queries across a Space (invoked as `entity query`)',
  message: 'Durable messages — the only public communication action for text',
  'read-mark': 'Per-anchor read cursors (invoked as `message mark-read`)',
  graph: 'Graph traversal outward from a focus entity',
  placement: 'Intent-level placements between two entities',
  undo: 'Redeem an undo token a previous mutation returned',
  search: 'Full-text search — reserved, and honestly unavailable',
  project: 'ProjectResources, their Space links, and artifact attribution',
  file: 'Blob upload and download',
  bridge: 'Reserved Phase-2 cross-node blob path — no public command',
  inbox: 'Notifications and their read state',
  'saved-view': 'Reusable saved queries',
  action: 'What THIS actor may actually do on a target right now',
  event: 'Durable Space events, by poll or live stream',
  presence: 'Who is present on an entity',
  session: 'Work sessions: inspect live PTYs, spawn, attach, terminate',
  kind: 'The entity-kind registry, core and custom',
  handoff: 'Project a bounded entity snapshot into a work session',
  'interaction-profile': 'Interaction Profile lifecycle and defaults',
  teammate: 'Teammate-scoped configuration',
  voice: 'Mint LiveKit room-join grants for voice channels',
  artifact: 'Versioned, viewable static-web bundles: publish, revisions, preview, export',
};

/** Family nouns ∪ command nouns, sorted. Both resolve through `tm8 help <noun>`. */
export const NOUNS: readonly string[] = [
  ...new Set([...BASE.map((r) => r.noun), ...BASE.flatMap((r) => (r.command ? [r.command[0] as string] : []))]),
].sort();

export function isNoun(noun: string): boolean {
  return NOUNS.includes(noun);
}

export function nounSummary(noun: string): string {
  return NOUN_SUMMARY[noun] ?? `Operations in the ${noun} family`;
}

/** The commands a noun owns, whether it is the family noun or the command noun. */
export function commandsForNoun(noun: string, from?: AvailabilityLedger): readonly CommandDiscovery[] {
  const wanted = new Set(
    BASE.filter((r) => r.noun === noun || r.command?.[0] === noun)
      .filter((r) => r.command !== null)
      .map((r) => (r.command as readonly string[]).join(' ')),
  );
  for (const [key, alias] of COMMAND_ALIASES) {
    if (alias.path[0] === noun) wanted.add(key);
  }
  return COMMAND_ORDER.filter((k) => wanted.has(k)).map((k) => commandFrom(k, from));
}

/** Rows in a noun that have NO command — reserved and internal facts, still named. */
export function commandlessForNoun(noun: string, from?: AvailabilityLedger): readonly OperationDiscovery[] {
  return BASE.filter((r) => r.noun === noun && r.command === null).map((r) =>
    discoveryFor(r.operation, from),
  );
}

/** Nouns a caller can type at the top level, in root-help order. */
export const PUBLIC_NOUNS: readonly string[] = NOUNS.filter(
  (n) => commandsForNoun(n).length > 0 || commandlessForNoun(n).length > 0,
);
