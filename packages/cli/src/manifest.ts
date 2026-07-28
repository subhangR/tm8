/**
 * The session manifest — the ONLY thing a booting agent reads from disk.
 *
 * SpawnService (Draco's lane) composes this IN-PROCESS from graph reads and
 * writes it to `TM8_MANIFEST_PATH`; the CLI keeps manifest *reading* only
 * (04-EXECUTION-TRANSPLANT §1.2 — the old subprocess-reads-~/.maestro/data
 * pipeline is deliberately dead). So this file is a consumer's declaration of
 * exactly which fields it needs, and nothing more.
 *
 * Reading rules, on purpose:
 *  - EVERY field except `sessionId` is optional. A manifest that is missing a
 *    task list still boots an agent that knows who it is; refusing to boot
 *    would leave the operator with a terminal that printed a stack trace.
 *  - Unknown fields are IGNORED, never rejected. The composer is allowed to
 *    grow ahead of the reader.
 *  - Nothing here is a zod schema: the contract is frozen and the manifest is
 *    NOT part of it (it is an internal server↔agent file), so it must not
 *    accrete a parallel schema surface in @tm8/contract.
 */
import { readFileSync } from 'node:fs';
import { CliError, EXIT_USAGE } from './exit.js';

// The four-mode model is defined ONCE, in the shared composer package — the
// prompt is the only thing that varies by mode, so it owns the vocabulary.
// Re-exported here so this module stays the CLI's manifest surface.
export { AGENT_MODES, type AgentMode } from '@tm8/prompt';
import { AGENT_MODES, type AgentMode } from '@tm8/prompt';
import { parseBootstrapManifest, type BootstrapManifestV2 } from './harness/bootstrap-manifest.js';

/** The persona this process is running as — a `team_member` entity (T-L7). */
export interface ManifestAgent {
  teamMemberId?: string;
  name?: string;
  avatar?: string;
  role?: string;
  /** Free-text persona prompt authored on the team_member entity. */
  identity?: string;
  /** Persistent per-persona memory entries, rendered verbatim. */
  memory?: string[];
}

/** A task the session is `working_on`. Titles/descriptions, not entity blobs. */
export interface ManifestTask {
  id: string;
  title?: string;
  description?: string;
  priority?: string;
  workStatus?: string;
  /**
   * The agent's definition of done. Composed into the manifest from the graph
   * but previously dropped by this reader, so an agent could not tell when its
   * task was actually finished. Kept as `unknown[]` because the graph column is
   * free-form jsonb; the composer renders only the string entries.
   */
  acceptanceCriteria?: unknown[];
}

/** The linked project resource whose workingDir the PTY cd'd into (AM-2 §1). */
export interface ManifestProject {
  id?: string;
  name?: string;
  workingDir?: string;
}

/** Present when a coordinator spawned this session — the return path. */
export interface ManifestCoordinator {
  sessionId?: string;
  displayName?: string;
}

/** The spawn-time directive, embedded so delivery cannot be lost. */
export interface ManifestDirective {
  subject?: string;
  message?: string;
  fromSessionId?: string;
}

/** A skill rendered into the prompt from the graph via `equips` edges (R19). */
export interface ManifestSkill {
  name?: string;
  body?: string;
}

export interface Tm8Manifest {
  manifestVersion?: string;
  /**
   * The §5.1 bootstrap projection, present only for `manifestVersion: "2"`.
   *
   * Kept ALONGSIDE the v1 view rather than replacing it: the prompt composer
   * reads the v1 fields, so projecting a v2 manifest onto them means nothing
   * downstream has to branch on version, while `bootstrap` carries the facts
   * (actor, trust, profile pin, capability epoch) that v1 never had.
   */
  bootstrap?: BootstrapManifestV2;
  /** Where `readManifest` read a v2 manifest from — the kernel names it. */
  bootstrapPath?: string;
  /** work_session entity id. Falls back to TM8_SESSION_ID when absent. */
  sessionId?: string;
  /** Pinned space — every graph command the agent runs is scoped to it. */
  spaceId?: string;
  mode?: AgentMode;
  agent?: ManifestAgent;
  project?: ManifestProject | null;
  tasks?: ManifestTask[];
  coordinator?: ManifestCoordinator | null;
  directive?: ManifestDirective | null;
  skills?: ManifestSkill[];
  /** `ExecutionSpawnInput.promptExtra`, passed through verbatim. */
  promptExtra?: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return out.length > 0 ? out : undefined;
}

function mode(v: unknown): AgentMode | undefined {
  return typeof v === 'string' && (AGENT_MODES as readonly string[]).includes(v)
    ? (v as AgentMode)
    : undefined;
}

function defined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * Coerce arbitrary JSON into the manifest view. Never throws on shape — a
 * malformed sub-object degrades to `undefined` rather than killing the boot.
 */
/**
 * Project a v2 bootstrap manifest onto the v1 view.
 *
 * The two mode vocabularies are NOT the same list and must not be conflated:
 * the manifest's `identity.mode` is `human-directed | worker | coordinator |
 * background` (who the session is for), while `AgentMode` is
 * `worker | coordinator | coordinated-*` (whether something is waiting on a
 * report). The bridge is the coordinator relationship: a worker WITH a
 * server-authoritative `coordinatorSessionId` is a coordinated worker.
 * `human-directed` and `background` map to worker because neither delegates.
 */
function projectBootstrap(bootstrap: BootstrapManifestV2): Tm8Manifest {
  const { identity, session, assignment } = bootstrap;
  const coordinated = session.coordinatorSessionId !== undefined;
  const agentMode: AgentMode =
    identity.mode === 'coordinator'
      ? coordinated
        ? 'coordinated-coordinator'
        : 'coordinator'
      : coordinated
        ? 'coordinated-worker'
        : 'worker';

  const taskIds = assignment.taskIds ?? (assignment.primaryTaskId ? [assignment.primaryTaskId] : []);

  return defined<Tm8Manifest>({
    manifestVersion: bootstrap.manifestVersion,
    bootstrap,
    sessionId: session.id,
    spaceId: session.spaceId,
    mode: agentMode,
    agent: defined<ManifestAgent>({
      teamMemberId: identity.teamMemberId,
      name: identity.displayName,
    }),
    // No project NAME: §5.1 forbids repo-name-derived identifiers, and the
    // manifest carries the resource id and the server-computed cwd only.
    project: defined<ManifestProject>({
      id: session.launchProjectId ?? undefined,
      workingDir: session.cwd,
    }),
    tasks: taskIds.length > 0 ? taskIds.map((id) => ({ id })) : undefined,
    coordinator: coordinated
      ? { sessionId: session.coordinatorSessionId as string }
      : undefined,
  });
}

export function parseManifest(raw: unknown): Tm8Manifest {
  // A v2 bootstrap manifest is a different document, not a superset — it
  // carries no persona, memory, skills or task bodies by design (§5.1).
  const bootstrap = parseBootstrapManifest(raw);
  if (bootstrap) return projectBootstrap(bootstrap);

  if (!isRecord(raw)) return {};

  const agentRaw = isRecord(raw.agent) ? raw.agent : undefined;
  const projectRaw = isRecord(raw.project) ? raw.project : undefined;
  const coordRaw = isRecord(raw.coordinator) ? raw.coordinator : undefined;
  const directiveRaw = isRecord(raw.directive) ? raw.directive : undefined;

  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.filter(isRecord).flatMap((t): ManifestTask[] => {
        const id = str(t.id);
        return id === undefined
          ? []
          : [
              defined<ManifestTask>({
                id,
                title: str(t.title),
                description: str(t.description),
                priority: str(t.priority),
                workStatus: str(t.workStatus),
                // Kept RAW (`unknown[]`) rather than coerced to strings here:
                // the graph column is free-form jsonb, and narrowing at the
                // reader would silently discard structured criteria that a
                // later renderer could format. The composer filters to strings.
                acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
                  ? t.acceptanceCriteria
                  : undefined,
              }),
            ];
      })
    : undefined;

  const skills = Array.isArray(raw.skills)
    ? raw.skills.filter(isRecord).map((s) => defined<ManifestSkill>({ name: str(s.name), body: str(s.body) }))
    : undefined;

  return defined<Tm8Manifest>({
    manifestVersion: str(raw.manifestVersion),
    sessionId: str(raw.sessionId),
    spaceId: str(raw.spaceId),
    mode: mode(raw.mode),
    agent: agentRaw
      ? defined<ManifestAgent>({
          teamMemberId: str(agentRaw.teamMemberId),
          name: str(agentRaw.name),
          avatar: str(agentRaw.avatar),
          role: str(agentRaw.role),
          identity: str(agentRaw.identity),
          memory: strArray(agentRaw.memory),
        })
      : undefined,
    project: projectRaw
      ? defined<ManifestProject>({
          id: str(projectRaw.id),
          name: str(projectRaw.name),
          workingDir: str(projectRaw.workingDir),
        })
      : undefined,
    tasks: tasks && tasks.length > 0 ? tasks : undefined,
    coordinator: coordRaw
      ? defined<ManifestCoordinator>({
          sessionId: str(coordRaw.sessionId),
          displayName: str(coordRaw.displayName),
        })
      : undefined,
    directive: directiveRaw
      ? defined<ManifestDirective>({
          subject: str(directiveRaw.subject),
          message: str(directiveRaw.message),
          fromSessionId: str(directiveRaw.fromSessionId),
        })
      : undefined,
    skills: skills && skills.length > 0 ? skills : undefined,
    promptExtra: str(raw.promptExtra),
  });
}

/**
 * Read + parse the manifest at `path`. Unreadable or non-JSON is a USAGE
 * failure with the path in the message — the operator needs to see WHICH file
 * the agent could not open, because the composer wrote it moments earlier.
 */
export function readManifest(path: string): Tm8Manifest {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError(
      `cannot read manifest at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CliError(
      `manifest at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
  const manifest = parseManifest(json);
  // The kernel names the manifest it was composed with (§5.2's closing line),
  // and only the reader knows the path — `parseManifest` is given the parsed
  // JSON, not the file. Recording it here keeps that fact from being guessed
  // downstream from an environment variable that may point somewhere else.
  return manifest.bootstrap ? { ...manifest, bootstrapPath: path } : manifest;
}
