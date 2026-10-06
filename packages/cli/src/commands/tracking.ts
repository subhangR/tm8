/**
 * `tm8 tracking refresh` — re-poll external tracking state for linked pull
 * requests and commits (§4.14).
 *
 * 202 IS A SUCCESS. This row answers `202 Accepted`: the refresh is accepted
 * for asynchronous work rather than completed inline. `Tm8Client` accepts any
 * 2xx precisely so a status-code allowlist cannot turn an accepted refresh
 * into a reported failure — the mistake a naive client makes here and at
 * `entities.create`'s 201.
 *
 * THERE IS A KNOWN LIVE DEFECT BEHIND THIS COMMAND AND IT IS NOT WORKED
 * AROUND. A multi-Space fan-out currently answers `403 forbidden`, because the
 * first iteration's actor binding poisons the second iteration's actor
 * resolution. The fix is open with the wave that owns that code. This command
 * binds the operation correctly and lets the 403 be visible: a client-side
 * retry, a per-Space fan-out invented here, or a softened message would each
 * hide a live server defect from the gate that has to see it — and would leave
 * the CLI carrying a workaround nobody remembers to remove once the fix lands.
 */
import { EXIT_OK, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import { assertKnownOptions, requireArg, withActor } from './entity.js';
import type { CommandContext, CommandModule } from '../run.js';

/**
 * The DTO is a refresh acknowledgement, not an entity. Rendered defensively:
 * the human view names what the Server said it accepted and nothing more —
 * inventing a completion claim for an accepted-but-unfinished refresh would be
 * exactly the wrong thing to tell a caller who is about to read the result.
 */
function renderRefresh(dto: unknown): string {
  if (dto === undefined || dto === null) return 'refresh accepted';
  if (typeof dto !== 'object') return String(dto);
  const entries = Object.entries(dto as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return entries.length > 0 ? entries.join('\n') : 'refresh accepted';
}

async function trackingRefresh(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['mutation-id']);
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  // Zero ids means "everything this actor tracks"; the field is omitted rather
  // than sent empty, because `entityIds: []` is a different request.
  if (cmd.args.length > 0) body.entityIds = [...cmd.args];

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'tracking.refresh', {
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderRefresh);
  return EXIT_OK;
}

/**
 * `tm8 pr merge <pull-request-entity-id>` — the forge write door. The server
 * owns every guard (open + mergeable + CI not red per OBSERVED facts, the
 * acting member's stored GitHub credential, `expectedHeadSha` pinned to the
 * observed head unless --head overrides); this command binds the operation
 * and renders the refusal or the merge sha, nothing more.
 */
function renderMerge(dto: unknown): string {
  const r = dto as { repo?: unknown; number?: unknown; mergeSha?: unknown } | null;
  if (r && typeof r.repo === 'string' && typeof r.number === 'number' && typeof r.mergeSha === 'string') {
    return `merged ${r.repo}#${String(r.number)} — merge commit ${r.mergeSha}`;
  }
  return 'merge accepted';
}

async function prMerge(cmd: CommandContext): Promise<ExitCode> {
  assertKnownOptions(cmd, ['head', 'title', 'mutation-id']);
  const id = requireArg(cmd, 0, '<pull-request-entity-id>');
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const head = cmd.options.value('head');
  if (head !== undefined) body.headSha = head;
  const title = cmd.options.value('title');
  if (title !== undefined) body.commitTitle = title;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'tracking.pr.merge', {
    params: { id },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderMerge);
  return EXIT_OK;
}

export const TRACKING_COMMANDS: CommandModule[] = [
  { path: ['tracking', 'refresh'], run: trackingRefresh },
  { path: ['pr', 'merge'], run: prMerge },
];
