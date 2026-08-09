/**
 * The agent bootstrap manifest, version 2 (harness §5.1).
 *
 * This is the ONLY file a booting agent reads, and it is the one artifact in
 * the harness that outlives the session: it is written to disk, recorded on the
 * work-session row, and included in backups. That is why its rules are as much
 * about what it MUST NOT hold as what it holds.
 *
 * WHAT IT IS. A bounded PROJECTION. The Server keeps the full auditable launch
 * request, permission calculation and resolved Interaction Profile snapshot;
 * this carries the pin's identity and hash, the safe control fields the harness
 * needs to start, and three discovery roots. Nine top-level keys, 4,096 UTF-8
 * bytes, and no prose.
 *
 * WHAT IT MUST NOT HOLD, and why each one is a real failure and not a style
 * preference:
 *  - a bearer token or any environment VALUE — it would outlive every rotation
 *    in a backup (§18.3, S6). Only the env var NAME is serialized;
 *  - task descriptions, message bodies, memory, skill bodies or transcripts —
 *    those are authored, therefore untrusted, and untrusted content does not
 *    belong in the one file the harness treats as authoritative;
 *  - an operation inventory or command schemas — §9 anti-bloat rule 1. The
 *    81-row catalog is discoverable; putting it here is how 4 KiB becomes 40;
 *  - mutable permission assertions ("you may edit anything") — a permission is
 *    a server decision at the moment of the call, never a fact baked into a
 *    file at launch;
 *  - all project associations — associations are fetched when a transition
 *    needs them, and they never change cwd (B4).
 *
 * The composer FAILS CLOSED on every one of these. A launch that refuses is
 * attributable; a manifest that quietly carries a token is not.
 */
import { assertWithinBudget, utf8Bytes } from '@tm8/prompt';

export const MANIFEST_VERSION = '2';
export const GRAMMAR_VERSION = '2';

/** The env var whose VALUE never appears in any artifact (§5.3, S6). */
export const BEARER_ENV = 'TM8_AGENT_TOKEN';

/**
 * The retired literal. Kept as a named constant so tests can assert its
 * absence without spelling it inline, and so a search for it lands here and
 * finds the reason rather than an unexplained string.
 */
export const RETIRED_BEARER_ENV = 'TM8_AUTH_TOKEN';

/** The nine §5.1 top-level keys, in the order they are serialized. */
export const BOOTSTRAP_MANIFEST_KEYS = [
  'manifestVersion',
  'server',
  'credential',
  'identity',
  'session',
  'interactionProfile',
  'assignment',
  'routing',
  'discovery',
] as const;

/**
 * The three discovery roots as ARGV ARRAYS with `{entityId}` placeholders.
 *
 * Argv, not a shell string: this form is consumed by a process that execs it,
 * where an array removes every quoting and word-splitting question. §14.1's
 * prompt-facing `<discovery>` element deliberately spells the SAME three roots
 * as space-joined strings with an `ENTITY_ID` placeholder, because that form is
 * read by a model which will type it. Both are frozen; neither is a slip.
 */
export const DISCOVERY_ARGV = {
  root: ['tm8', 'help', '--format', 'json'],
  actions: ['tm8', 'action', 'list', '--for', '{entityId}', '--format', 'json'],
  context: ['tm8', 'entity', 'context', '{entityId}', '--format', 'json'],
} as const;

// -- closed vocabularies ------------------------------------------------------

export const IDENTITY_MODES = ['human-directed', 'worker', 'coordinator', 'background', 'dispatcher'] as const;
export const WORKDIR_MODES = ['project', 'worktree', 'scratch'] as const;
export const RUNTIME_MODES = ['native-interactive-pty'] as const;
export const TRUST_LEVELS = ['trusted', 'untrusted'] as const;
export const PROFILE_SOURCES = [
  'spawn_override',
  'teammate_default',
  'space_default',
  'core_default',
] as const;
/** Phase 1 admits exactly one capture mode (R3). */
export const PROVIDER_CAPTURE_MODES = ['explicit-only'] as const;

export type IdentityMode = (typeof IDENTITY_MODES)[number];
export type WorkdirMode = (typeof WORKDIR_MODES)[number];
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export type ProfileSource = (typeof PROFILE_SOURCES)[number];
export type ProviderCaptureMode = (typeof PROVIDER_CAPTURE_MODES)[number];

// -- shapes -------------------------------------------------------------------

export interface BootstrapServer {
  id: string;
  baseUrl: string;
  catalogDigest: string;
  grammarVersion: string;
  capabilityEpoch: string;
}

export interface BootstrapIdentity {
  actorId: string;
  teamMemberId: string;
  displayName: string;
  mode: IdentityMode;
}

export interface BootstrapSession {
  id: string;
  spaceId: string;
  /** Server-computed. Never derived from a repo name or a model-supplied path. */
  cwd: string;
  workdirMode: WorkdirMode;
  runtimeMode: RuntimeMode;
  /** A project resource id, or `null` — which §5.1 permits only for scratch. */
  launchProjectId: string | null;
  trust: TrustLevel;
  /** Present only when a server-authoritative relationship exists. */
  coordinatorSessionId?: string;
}

export interface BootstrapInteractionProfile {
  entityId: string;
  version: number;
  source: ProfileSource;
  pinRevision: number;
  resolvedHash: string;
  providerCaptureMode: ProviderCaptureMode;
  pinRef: string;
}

export interface BootstrapAssignment {
  primaryTaskId?: string;
  taskIds?: string[];
}

export interface BootstrapRouting {
  inboxOwnerId: string;
  eventAfterSeq: number;
}

export interface BootstrapDiscovery {
  root: string[];
  actions: string[];
  context: string[];
}

export interface BootstrapManifestV2 {
  manifestVersion: string;
  server: BootstrapServer;
  /** Exactly one field. There is no value field to accidentally populate. */
  credential: { bearerEnv: string };
  identity: BootstrapIdentity;
  session: BootstrapSession;
  interactionProfile: BootstrapInteractionProfile;
  assignment: BootstrapAssignment;
  routing: BootstrapRouting;
  discovery: BootstrapDiscovery;
}

/** What a caller supplies. `credential`, `discovery` and versions are derived. */
export interface BootstrapManifestInput {
  server: Omit<BootstrapServer, 'grammarVersion'>;
  identity: BootstrapIdentity;
  session: Omit<BootstrapSession, 'coordinatorSessionId'> & {
    coordinatorSessionId?: string | null;
  };
  interactionProfile: BootstrapInteractionProfile;
  assignment: { primaryTaskId?: string | null; taskIds?: readonly string[] };
  routing: BootstrapRouting;
}

const INPUT_KEYS: readonly string[] = [
  'server',
  'identity',
  'session',
  'interactionProfile',
  'assignment',
  'routing',
];

export class InvalidBootstrapManifestError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`bootstrap manifest: ${field} ${detail}`);
    this.name = 'InvalidBootstrapManifestError';
    this.field = field;
  }
}

// -- validation ---------------------------------------------------------------

function reject(field: string, detail: string): never {
  throw new InvalidBootstrapManifestError(field, detail);
}

function str(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') reject(field, 'must be a non-empty string');
  return value as string;
}

function int(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) reject(field, 'must be an integer');
  return value as number;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    reject(field, `must be one of ${allowed.join(' | ')}`);
  }
  return value as T;
}

function object(field: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

/**
 * Compose and validate. Throws `InvalidBootstrapManifestError` on anything the
 * manifest is forbidden to carry, including an input key that is not one of
 * the six — which is how `tasks`, `memory`, `skills` and `promptExtra` are
 * refused rather than silently dropped. Silently dropping would let a caller
 * believe it had passed something through.
 */
export function composeBootstrapManifest(input: BootstrapManifestInput): BootstrapManifestV2 {
  const raw = object('input', input);
  for (const key of Object.keys(raw)) {
    if (!INPUT_KEYS.includes(key)) {
      reject(key, 'is not a bootstrap manifest field — the manifest carries identifiers only');
    }
  }

  const server = object('server', raw.server);
  const identity = object('identity', raw.identity);
  const session = object('session', raw.session);
  const profile = object('interactionProfile', raw.interactionProfile);
  const assignment = object('assignment', raw.assignment);
  const routing = object('routing', raw.routing);

  const workdirMode = oneOf('session.workdirMode', session.workdirMode, WORKDIR_MODES);
  const launchProjectId =
    session.launchProjectId === null ? null : str('session.launchProjectId', session.launchProjectId);
  if (launchProjectId === null && workdirMode !== 'scratch') {
    reject('session.launchProjectId', 'may be null only when workdirMode is scratch');
  }

  const coordinatorSessionId =
    session.coordinatorSessionId === null || session.coordinatorSessionId === undefined
      ? undefined
      : str('session.coordinatorSessionId', session.coordinatorSessionId);

  const primaryTaskId =
    assignment.primaryTaskId === null || assignment.primaryTaskId === undefined
      ? undefined
      : str('assignment.primaryTaskId', assignment.primaryTaskId);

  const taskIdsRaw = assignment.taskIds;
  if (taskIdsRaw !== undefined && !Array.isArray(taskIdsRaw)) {
    reject('assignment.taskIds', 'must be an array of ids');
  }
  const taskIds = (taskIdsRaw ?? []).map((id, i) => str(`assignment.taskIds[${i}]`, id));

  return {
    manifestVersion: MANIFEST_VERSION,
    server: {
      id: str('server.id', server.id),
      baseUrl: str('server.baseUrl', server.baseUrl),
      catalogDigest: str('server.catalogDigest', server.catalogDigest),
      grammarVersion: GRAMMAR_VERSION,
      capabilityEpoch: str('server.capabilityEpoch', server.capabilityEpoch),
    },
    // The NAME, never the value. There is no code path that can add one.
    credential: { bearerEnv: BEARER_ENV },
    identity: {
      actorId: str('identity.actorId', identity.actorId),
      teamMemberId: str('identity.teamMemberId', identity.teamMemberId),
      displayName: str('identity.displayName', identity.displayName),
      mode: oneOf('identity.mode', identity.mode, IDENTITY_MODES),
    },
    session: {
      id: str('session.id', session.id),
      spaceId: str('session.spaceId', session.spaceId),
      cwd: str('session.cwd', session.cwd),
      workdirMode,
      runtimeMode: oneOf('session.runtimeMode', session.runtimeMode, RUNTIME_MODES),
      launchProjectId,
      trust: oneOf('session.trust', session.trust, TRUST_LEVELS),
      // Omitted, not null: §5.1 prefers an absent optional to a null one, and a
      // null coordinator reads as "there is definitively no coordinator" when
      // the truth is "no server-authoritative relationship exists".
      ...(coordinatorSessionId === undefined ? {} : { coordinatorSessionId }),
    },
    interactionProfile: {
      entityId: str('interactionProfile.entityId', profile.entityId),
      version: int('interactionProfile.version', profile.version),
      source: oneOf('interactionProfile.source', profile.source, PROFILE_SOURCES),
      pinRevision: int('interactionProfile.pinRevision', profile.pinRevision),
      resolvedHash: str('interactionProfile.resolvedHash', profile.resolvedHash),
      // R3: any other value fails validation. A caller that prefers the visible
      // core-profile fallback resolves the core profile and composes again —
      // this composer never silently downgrades a pin.
      providerCaptureMode: oneOf(
        'interactionProfile.providerCaptureMode',
        profile.providerCaptureMode,
        PROVIDER_CAPTURE_MODES,
      ),
      pinRef: str('interactionProfile.pinRef', profile.pinRef),
    },
    assignment: {
      ...(primaryTaskId === undefined ? {} : { primaryTaskId }),
      ...(taskIds.length === 0 ? {} : { taskIds }),
    },
    routing: {
      inboxOwnerId: str('routing.inboxOwnerId', routing.inboxOwnerId),
      eventAfterSeq: int('routing.eventAfterSeq', routing.eventAfterSeq),
    },
    discovery: {
      root: [...DISCOVERY_ARGV.root],
      actions: [...DISCOVERY_ARGV.actions],
      context: [...DISCOVERY_ARGV.context],
    },
  };
}

/**
 * Serialize compactly and enforce the 4 KiB hard cap.
 *
 * Compact because the budget is on BYTES and pretty-printing spends a fifth of
 * them on indentation; nothing reads this file by eye that cannot pipe it
 * through `jq`.
 */
export function serializeBootstrapManifest(manifest: BootstrapManifestV2): string {
  return assertWithinBudget('manifest', JSON.stringify(manifest));
}

/** Bytes of the serialized form, for logging a budget without re-serializing. */
export function bootstrapManifestBytes(manifest: BootstrapManifestV2): number {
  return utf8Bytes(JSON.stringify(manifest));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a v2 manifest, or return `null` when the input is not one.
 *
 * `null` rather than a throw: a v1 manifest is a legitimate thing to find on
 * disk during the transition, and the caller's next move is to read it the old
 * way — not to fail the boot.
 */
export function parseBootstrapManifest(raw: unknown): BootstrapManifestV2 | null {
  if (!isRecord(raw) || raw.manifestVersion !== MANIFEST_VERSION) return null;
  if (!isRecord(raw.server) || !isRecord(raw.identity) || !isRecord(raw.session)) return null;
  const session = raw.session;
  const assignment = isRecord(raw.assignment) ? raw.assignment : {};
  try {
    return composeBootstrapManifest({
      server: raw.server as unknown as Omit<BootstrapServer, 'grammarVersion'>,
      identity: raw.identity as unknown as BootstrapIdentity,
      session: session as unknown as BootstrapManifestInput['session'],
      interactionProfile: raw.interactionProfile as unknown as BootstrapInteractionProfile,
      assignment: assignment as unknown as BootstrapManifestInput['assignment'],
      routing: raw.routing as unknown as BootstrapRouting,
    });
  } catch {
    // A file claiming version 2 that does not validate is not a v2 manifest.
    return null;
  }
}
