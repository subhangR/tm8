/**
 * `tm8 task report {progress,complete,blocked} <taskId> "<text>"`
 *
 * The mapping is the one 04-EXECUTION-TRANSPLANT §1.3 fixes:
 *
 *   progress  → a message anchored to the task        (`messages.post`)
 *   complete  → that message, then `entities.commands.complete`
 *   blocked   → that message, then `entities.commands.work` status=blocked
 *
 * The message goes FIRST in every case, deliberately. If the state command
 * then fails — a version conflict, a handler that is still 501 — the human
 * reading the task thread still has the agent's summary. The reverse order
 * loses the one artifact a person actually wants.
 */
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { Tm8Client } from '../client.js';
import { readEnv } from '../env.js';
import { CliError, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { readManifest, type Tm8Manifest } from '../manifest.js';
import { emit } from '../output.js';

type Kind = 'progress' | 'complete' | 'blocked';

const KINDS: readonly Kind[] = ['progress', 'complete', 'blocked'];

/** Minimal view of the `EntityDetail` fields this command needs. */
interface VersionedEntity {
  id?: string;
  version?: number;
}

export async function taskReport(args: ParsedArgs): Promise<number> {
  // positionals: ['task', 'report', <kind>, <taskId>, <text>]
  const kindRaw = args.positionals[2];
  const taskId = args.positionals[3];
  const text = args.positionals[4];

  if (kindRaw === undefined || !(KINDS as readonly string[]).includes(kindRaw)) {
    throw new CliError(
      `usage: tm8 task report {progress|complete|blocked} <taskId> "<message>"`,
      EXIT_USAGE,
    );
  }
  const kind = kindRaw as Kind;
  if (!taskId) throw new CliError(`tm8 task report ${kind}: missing <taskId>`, EXIT_USAGE);
  if (!text) throw new CliError(`tm8 task report ${kind}: missing the message argument`, EXIT_USAGE);

  const env = readEnv();
  const manifest = loadManifestQuietly(env.manifestPath);
  const client = new Tm8Client({ baseUrl: env.baseUrl, token: env.agentToken });
  const json = flagBool(args, 'json');

  const message = await client.invoke<unknown>('messages.post', {
    body: { anchorId: taskId, body: renderBody(kind, text) },
  });

  if (kind === 'progress') {
    emit(json, { ok: true, kind, taskId, message }, `progress reported on ${taskId}`);
    return EXIT_OK;
  }

  if (kind === 'blocked') {
    const result = await client.invoke<unknown>('entities.commands.work', {
      params: { id: taskId },
      body: { status: 'blocked', note: text },
    });
    emit(json, { ok: true, kind, taskId, message, result }, `${taskId} marked blocked`);
    return EXIT_OK;
  }

  // complete — the closed `/commands/complete` binding, which is optimistic-
  // concurrency guarded, so we need the task's current version.
  const expectedVersion = await resolveVersion(client, taskId, flagString(args, 'expected-version'));
  const completerIds = resolveCompleters(args, manifest);
  const result = await client.invoke<unknown>('entities.commands.complete', {
    params: { id: taskId },
    body: { expectedVersion, completerIds },
  });
  emit(json, { ok: true, kind, taskId, expectedVersion, completerIds, message, result },
    `${taskId} completed (version ${expectedVersion})`);
  return EXIT_OK;
}

function renderBody(kind: Kind, text: string): string {
  if (kind === 'complete') return `**Complete** — ${text}`;
  if (kind === 'blocked') return `**Blocked** — ${text}`;
  return text;
}

async function resolveVersion(
  client: Tm8Client,
  taskId: string,
  override: string | undefined,
): Promise<number> {
  if (override !== undefined) {
    const n = Number.parseInt(override, 10);
    if (!Number.isInteger(n) || n < 0) {
      throw new CliError(`--expected-version must be a non-negative integer, got ${override}`, EXIT_USAGE);
    }
    return n;
  }
  const entity = await client.invoke<VersionedEntity>('entities.get', { params: { id: taskId } });
  if (typeof entity?.version !== 'number') {
    throw new CliError(
      `cannot complete ${taskId}: the server did not return a version — pass --expected-version <n>`,
      EXIT_USAGE,
    );
  }
  return entity.version;
}

/**
 * Who gets credit. The manifest's `team_member` id is the agent's own persona,
 * which is the right default: the session doing the work is the completer.
 */
function resolveCompleters(args: ParsedArgs, manifest: Tm8Manifest): string[] {
  const override = flagString(args, 'as');
  if (override) return override.split(',').map((s) => s.trim()).filter(Boolean);
  const own = manifest.agent?.teamMemberId;
  return own ? [own] : [];
}

function loadManifestQuietly(path: string | undefined): Tm8Manifest {
  if (!path) return {};
  try {
    return readManifest(path);
  } catch {
    return {};
  }
}
