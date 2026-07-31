/**
 * `tm8 session liveness|spawn|terminate|attach` — the work-session lifecycle
 * (§4.13), projecting `execution.liveness`, `execution.spawn`,
 * `execution.terminate`, and `execution.streams.attach`.
 *
 * THE INTERNAL `execution.prompt` ROW IS NOT HERE, AND THAT IS THE POINT.
 * `execution.prompt` is INTERNAL. Only the audited Server-side delivery
 * principal may invoke it, it names `messages.post` as its public composite,
 * and no flag, alias, or debug path enables a caller-facing form. So this file
 * registers nothing for it and renders no invocation syntax for it: a command
 * line printed for an operation no caller may invoke is a promise the system
 * cannot keep, and an agent that reads one will spend its next turn trying to
 * use it. To reach a live session, store a durable message addressed to it —
 * persistence first, delivery second. `run.ts` already answers `session prompt`
 * with that pointer, which is why the failure is a signpost rather than
 * "unknown command".
 *
 * THREE RULES THIS FILE EXISTS TO KEEP:
 *
 *  - CLOSED SETS ARE CHECKED LOCALLY, OPEN QUESTIONS ARE NOT. `--workdir` and
 *    `--mode` name closed enumerations, so a typo is caught here with the set
 *    spelled out (exit 2, nothing sent). Whether a Project is trusted, whether
 *    this caller may spawn, and project trust are Server decisions. Worktree is
 *    not in the public contract until the node can create and clean one safely,
 *    so the CLI neither advertises nor sends it.
 *  - TERMINATE IS DESTRUCTIVE. `--yes` is required (§7.5). `--force` changes
 *    HOW the process is stopped, never WHO may stop it, so it is an ordinary
 *    optional flag and adds no confirmation of its own.
 *  - INTERACTIVE BYTES ARE NOT DTO OUTPUT. `session attach` returns a
 *    `StreamAttachGrant`; the terminal bytes arrive later over the socket the
 *    grant names. `--format json` therefore IMPLIES `--grant-only`, and the
 *    implication is structural rather than advisory — under a structured format
 *    the socket is never opened at all, because opening one and then refusing
 *    to print it would be a side effect nobody asked for.
 *
 * THE GRANT URL IS NOT A HARDCODED PATH. Every request in this package binds
 * through `bindPath(<operationName>, params)` and there is no URL literal here.
 * The WebSocket the streaming branch dials is the one the SERVER handed back in
 * `grant.url` — transport only the Server knows, resolved against the same base
 * URL the grant came from. A literal `/v2/ws` written here would be exactly the
 * drift the closed catalog exists to prevent.
 */
import { readTextSource } from '../args.js';
import { requireSpace } from '../context.js';
import { InterruptedError } from '../errors.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

/** §4.13's closed workdir set. Kept as a tuple so the diagnostic renders it. */
const WORKDIRS = ['project', 'scratch'] as const;
type WorkdirMode = (typeof WORKDIRS)[number];

/** §4.13's closed session-mode set. */
const SESSION_MODES = ['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator'] as const;
type SessionMode = (typeof SESSION_MODES)[number];

/** §4.13's closed attach-mode set. `view` observes; `drive` owns the terminal. */
const ATTACH_MODES = ['view', 'drive'] as const;
type AttachMode = (typeof ATTACH_MODES)[number];

/**
 * A closed-set option. The diagnostic names the WHOLE set rather than just
 * rejecting the value: a caller who wrote `--mode watch` has a wrong model of
 * the vocabulary, and telling them only that `watch` is wrong leaves them
 * guessing a second time.
 */
function closed<T extends string>(
  flag: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined) return undefined;
  const found = allowed.find((a) => a === raw);
  if (found === undefined) {
    throw new CliError(
      `--${flag} expects ${allowed.join('|')}, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return found;
}

/**
 * The `<work-session-id>` every per-session command takes. Named in the
 * diagnostic exactly as §4.13 spells it, so the message and the syntax the
 * caller just read use one vocabulary.
 */
function requireSessionId(command: string, raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`tm8 ${command} requires a <work-session-id>`, EXIT_USAGE, {
      hint: 'a work session is an entity; its id is what `tm8 session spawn` printed',
    });
  }
  return raw;
}

/** §7.5: a destructive operation is never inferred from context. */
function requireConfirmation(command: string, cmd: CommandContext): void {
  if (!cmd.options.bool('yes')) {
    throw new CliError(`tm8 ${command} is destructive and requires --yes`, EXIT_USAGE);
  }
}

async function sessionLiveness(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('session liveness', cmd.options.value('mutation-id'));
  const spaceId = requireSpace(cmd.ctx);
  const snapshot = await observedInvoke<ExecutionLivenessDto>(
    clientFor(cmd.ctx),
    'execution.liveness',
    { params: { spaceId } },
  );
  cmd.out.data(snapshot, renderLiveness);
  return EXIT_OK;
}

interface ExecutionLivenessDto {
  liveEntityIds?: unknown;
  nodeBootId?: unknown;
  checkedAt?: unknown;
  capacity?: { used?: unknown; total?: unknown };
}

async function sessionSpawn(cmd: CommandContext): Promise<ExitCode> {
  const spaceId = requireSpace(cmd.ctx);
  const teamMemberId = cmd.options.value('teammate');
  if (teamMemberId === undefined) {
    throw new CliError('tm8 session spawn requires --teammate <team-member-id>', EXIT_USAGE, {
      hint: 'a session runs a Teammate persona; authorization resolves through its owner',
    });
  }

  const workdir = closed<WorkdirMode>('workdir', cmd.options.value('workdir'), WORKDIRS);
  const mode = closed<SessionMode>('mode', cmd.options.value('mode'), SESSION_MODES);
  const taskIds = cmd.options.values('task');
  const projectId = cmd.options.value('launch-project');
  const profileId = cmd.options.value('interaction-profile');
  const model = cmd.options.value('model');
  const agentTool = cmd.options.value('agent-tool');
  const title = cmd.options.value('title');
  const contextSource = cmd.options.value('context');

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
    spaceId,
    teamMemberId,
  };
  // A spawned agent already carries its own work_session id in process
  // context. Forwarding it makes the server-created session a real child of
  // the spawner; an ordinary human shell has no session id and stays a root.
  if (cmd.ctx.sessionId) body.parentSessionId = cmd.ctx.sessionId;
  if (taskIds.length > 0) body.taskIds = taskIds;
  if (projectId !== undefined) body.projectId = projectId;
  // `SpawnWorkdir` is a discriminated union, not a bare string.
  if (workdir !== undefined) body.workdir = { mode: workdir };
  if (cmd.options.bool('confirm-untrusted')) body.confirmUntrusted = true;
  // A human-principal question the SERVER owns: supplying this as an agent or
  // through `--as` is refused there, not pre-judged here.
  if (profileId !== undefined) body.interactionProfileId = profileId;
  if (mode !== undefined) body.mode = mode;
  if (model !== undefined) body.model = model;
  if (agentTool !== undefined) body.agentTool = agentTool;
  if (title !== undefined) body.title = title;
  // `--context` is LAUNCH-MANIFEST context, not a runtime prompt. It is
  // appended to the composed manifest at spawn and never delivered to a
  // running session — that path is a message.
  if (contextSource !== undefined) body.promptExtra = await readTextSource(contextSource);
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'execution.spawn', { body });
  cmd.out.data(data, renderSpawned);
  return EXIT_OK;
}

/**
 * `tm8 session resume <work-session-id>` — bring an exited session back with
 * its agent's conversation restored. Everything about WHAT gets resumed
 * (persona, project, model, the provider-native session id) is Server-owned
 * graph truth; the CLI sends nothing but the target and the mutation id, so
 * there is nothing here for a caller to get wrong.
 */
async function sessionResume(cmd: CommandContext): Promise<ExitCode> {
  const id = requireSessionId('session resume', cmd.args[0]);

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'execution.resume', {
    params: { id },
    body,
  });
  cmd.out.data(data, renderSpawned);
  return EXIT_OK;
}

async function sessionTerminate(cmd: CommandContext): Promise<ExitCode> {
  const id = requireSessionId('session terminate', cmd.args[0]);
  requireConfirmation('session terminate', cmd);

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  // Sent only when asked: `ExecutionTerminateInput` is strict and a `false`
  // here would be a caller asserting something they did not ask for.
  if (cmd.options.bool('force')) body.force = true;
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'execution.terminate', {
    params: { id },
    body,
  });
  cmd.out.data(data, renderTerminated);
  return EXIT_OK;
}

async function sessionAttach(cmd: CommandContext): Promise<ExitCode> {
  const id = requireSessionId('session attach', cmd.args[0]);
  const mode = closed<AttachMode>('mode', cmd.options.value('mode'), ATTACH_MODES);
  if (mode === undefined) {
    throw new CliError('tm8 session attach requires --mode view|drive', EXIT_USAGE, {
      hint: '`view` observes the terminal; `drive` takes interactive ownership of it',
    });
  }

  const body: Record<string, unknown> = {
    mode,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const grant = await observedInvoke<StreamAttachGrantDto>(
    clientFor(cmd.ctx),
    'execution.streams.attach',
    { params: { id }, body },
  );

  // Structured output IMPLIES grant-only. Decided before the socket exists, so
  // a `--format json` attach never opens one.
  if (cmd.options.bool('grant-only') || cmd.out.format !== 'human') {
    cmd.out.data(grant, renderGrant);
    return EXIT_OK;
  }
  return await streamTerminal(cmd, grant);
}

/** The subset of `StreamAttachGrant` this command reads. */
interface StreamAttachGrantDto {
  workSessionId?: unknown;
  url?: unknown;
  mode?: unknown;
  token?: unknown;
  expiresAt?: unknown;
}

/**
 * Follow the grant onto the live terminal socket.
 *
 * The wire protocol is the Server's, not this file's: TEXT frames are control
 * (`size`, `attached`, `exit`) and BINARY frames are raw PTY bytes. Control
 * frames go to STDERR as notes and bytes go to STDOUT, because stdout carries
 * the requested data and nothing else — a "reattached, 4 KiB replayed" line
 * spliced into a terminal capture is corruption, not commentary.
 *
 * `drive` forwards stdin to the socket. `view` does not: a view attach that
 * quietly typed into someone else's terminal would be the worst possible
 * surprise, and Phase 1 grants drive only to the spawning owner anyway.
 *
 * INTERRUPTION. §7.6 says an interrupted command exits 130, and this is the
 * command an operator actually interrupts — it runs until the session ends or
 * they stop watching. The process-level SIGINT handler in `index.ts` owns that
 * exit; nothing here races it. What this function owns is the socket: a close
 * that was not a clean `exit` frame is reported rather than silently rendered
 * as success.
 */
async function streamTerminal(cmd: CommandContext, grant: StreamAttachGrantDto): Promise<ExitCode> {
  const url = grantSocketUrl(cmd, grant);
  const Ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (Ctor === undefined) {
    throw new CliError(
      'this Node build has no WebSocket; use --grant-only and attach with a client that does',
      EXIT_USAGE,
    );
  }

  const socket = new Ctor(url);
  socket.binaryType = 'arraybuffer';
  const drive = grant.mode === 'drive';

  return await new Promise<ExitCode>((resolve, reject) => {
    const forward = (chunk: Buffer): void => {
      if (socket.readyState === 1) socket.send(chunk);
    };

    const done = (settle: () => void): void => {
      if (drive) process.stdin.off('data', forward);
      settle();
    };

    socket.addEventListener('open', () => {
      cmd.out.note(`attached to ${String(grant.workSessionId ?? '')} in ${String(grant.mode ?? '')} mode`);
      if (drive) {
        process.stdin.on('data', forward);
        process.stdin.resume();
      }
    });

    socket.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        // Control frames are the Server's own JSON. Rendered as a note, never
        // parsed into a CLI-private shape and never printed to stdout.
        cmd.out.note(`tm8: session: ${ev.data}`);
        return;
      }
      cmd.out.bytes(new Uint8Array(ev.data as ArrayBuffer));
    });

    socket.addEventListener('error', () => {
      // The DOM event carries no cause; the close frame that follows does, so
      // nothing is invented here.
      cmd.out.warn(`tm8: terminal stream to ${url} failed`);
    });

    socket.addEventListener('close', (ev: CloseEvent) => {
      done(() => {
        // 1000/1001 are a peer that finished. Anything else ended the stream
        // for a reason the caller has to be able to see.
        if (ev.code === 1000 || ev.code === 1001) resolve(EXIT_OK);
        else reject(new InterruptedError(`terminal stream closed with ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`));
      });
    });
  });
}

/**
 * Resolve the socket the grant names.
 *
 * `grant.url` is server-relative in Phase 1 (`/v2/ws?sessionId=…`) and may be
 * absolute later; both are the SERVER's answer and both resolve the same way.
 * The scheme is switched to `ws`/`wss` to match the transport the grant
 * declares — an `http://` WebSocket URL is not a different opinion about the
 * endpoint, it is simply not dialable.
 */
function grantSocketUrl(cmd: CommandContext, grant: StreamAttachGrantDto): string {
  const raw = grant.url;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CliError('the attach grant carried no stream url', EXIT_USAGE, {
      hint: 'use --grant-only to see exactly what the Server answered',
    });
  }
  const resolved = new URL(raw, cmd.ctx.baseUrl.value);
  if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
  else if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
  return resolved.href;
}

// ── human renderings — the SAME DTO `--format json` emits ───────────────────

interface CommandResultish {
  entity?: { id?: unknown; kind?: unknown; status?: unknown } | undefined;
}

/**
 * The new work session's id is the ONLY thing a follow-up `session attach` or
 * `session terminate` needs, so it is never dropped from the human view.
 */
function renderSpawned(dto: unknown): string {
  const entity = (dto as CommandResultish)?.entity;
  if (entity?.id === undefined) return JSON.stringify(dto);
  const status = entity.status === undefined ? '' : ` ${String(entity.status)}`;
  return `${String(entity.id)}${status}`.trim();
}

function renderTerminated(dto: unknown): string {
  const entity = (dto as CommandResultish)?.entity;
  if (entity?.id === undefined) return JSON.stringify(dto);
  return `${String(entity.id)} ${String(entity.status ?? 'terminated')}`;
}

function renderGrant(dto: StreamAttachGrantDto): string {
  const parts = [String(dto.workSessionId ?? ''), String(dto.mode ?? ''), String(dto.url ?? '')];
  const expires = dto.expiresAt === undefined ? '' : `  expires ${String(dto.expiresAt)}`;
  return `${parts.filter(Boolean).join('  ')}${expires}`;
}

function renderLiveness(dto: ExecutionLivenessDto): string {
  const ids = Array.isArray(dto.liveEntityIds) ? dto.liveEntityIds.map(String) : [];
  const lines = [ids.length === 0 ? 'live sessions: none' : `live sessions (${ids.length}):`];
  for (const id of ids) lines.push(`  ${id}`);
  if (typeof dto.nodeBootId === 'string') lines.push(`nodeBootId: ${dto.nodeBootId}`);
  if (typeof dto.checkedAt === 'string') lines.push(`checkedAt: ${dto.checkedAt}`);
  if (typeof dto.capacity?.used === 'number' && typeof dto.capacity.total === 'number') {
    lines.push(`capacity: ${String(dto.capacity.used)}/${String(dto.capacity.total)} in use`);
  }
  return lines.join('\n');
}

/**
 * The registry contribution. Five caller-facing rows, deliberately —
 * `execution.prompt` has no entry here and must never gain one.
 */
export const SESSION_COMMANDS: CommandModule[] = [
  { path: ['session', 'liveness'], run: sessionLiveness },
  { path: ['session', 'spawn'], run: sessionSpawn },
  { path: ['session', 'resume'], run: sessionResume },
  { path: ['session', 'terminate'], run: sessionTerminate },
  { path: ['session', 'attach'], run: sessionAttach },
];
