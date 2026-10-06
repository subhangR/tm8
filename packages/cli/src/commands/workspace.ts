/**
 * `tm8 workspace …` — drive YOUR OWN live Workspace window (Spec C, doc
 * 01a1111d-589e).
 *
 *   workspace.instances.list  GET  /v2/spaces/:spaceId/workspace/instances
 *   workspace.inspect         GET  /v2/spaces/:spaceId/workspace/inspect
 *   workspace.command         POST /v2/spaces/:spaceId/workspace/commands
 *
 * Every mutating verb is sugar over the ONE `workspace.command` row: it builds
 * the same `{command, args}` the window's own UI dispatches, the node forwards
 * it to the window, and the window's Result is printed as it came back.
 *
 * WHOSE WINDOW. The node answers for the caller's identity only. An agent
 * token carries its owner's identity, so an agent reaches the windows of the
 * human it works for and nobody else's. With no `--instance`, the node picks
 * the only live window, or the only focused one; otherwise it refuses with the
 * candidates (`ambiguous_target`).
 *
 * IDEMPOTENCY. Each run sends a fresh `--request-id` unless one is given. The
 * same id with the same arguments returns the recorded result and never runs
 * twice; the same id with different arguments is refused
 * (`request_id_reused`). After a timeout (`no_reply`, exit 7), retry with the
 * SAME `--request-id`.
 *
 * EXIT CODES. 0 applied / no_op. 16 requires_user_choice: the window is showing
 * the human a choice (unsaved changes, add a kind to the scope) and only the
 * human can answer it. 4 rejected for permission, 2 rejected for invalid
 * arguments, 6 any other rejection or a revision conflict.
 */
import { randomUUID } from 'node:crypto';

import { WORKSPACE_DIALOG_IDS } from '@tm8/contract';

import { requireSpace } from '../context.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import {
  CliError,
  EXIT_CONFLICT,
  EXIT_FORBIDDEN,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_USER_CHOICE,
  type ExitCode,
} from '../exit.js';
import { refuseMutationId } from '../mutation.js';
import type { CommandContext, CommandModule } from '../run.js';

interface RemoteResult {
  requestId?: string;
  instanceId?: string;
  status?: string;
  revision?: number;
  tabId?: string;
  outcome?: string;
  reason?: string;
  pendingInteractionId?: string;
  choices?: string[];
  inspection?: Record<string, unknown>;
  dialogId?: string;
  dialogState?: string;
}

const SCOPE_MODES: Record<string, 'mixed' | 'byType'> = { mixed: 'mixed', 'by-type': 'byType', bytype: 'byType' };

function usage(message: string, hint: string): never {
  throw new CliError(message, EXIT_USAGE, { hint });
}

function arg(cmd: CommandContext, index: number, name: string, hint: string): string {
  const value = cmd.args[index];
  if (value === undefined || value === '') usage(`${cmd.path.join(' ')} requires <${name}>`, hint);
  return value;
}

function integerOption(cmd: CommandContext, name: string): number | undefined {
  const raw = cmd.options.value(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) usage(`--${name} expects a non-negative integer, got ${JSON.stringify(raw)}`, `--${name} <n>`);
  return Number(raw);
}

/** The status → exit code mapping, documented in the noun help. */
export function exitForResult(result: RemoteResult): ExitCode {
  switch (result.status) {
    case 'applied':
    case 'no_op':
      return EXIT_OK;
    case 'requires_user_choice':
      return EXIT_USER_CHOICE;
    case 'rejected':
      if (result.reason === 'permission_denied') return EXIT_FORBIDDEN;
      if (result.reason === 'invalid_arguments' || result.reason === 'unsupported_kind' || result.reason === 'unsupported_dialog') {
        return EXIT_USAGE;
      }
      return EXIT_CONFLICT;
    default:
      return EXIT_CONFLICT;
  }
}

function renderResult(data: unknown): string {
  const r = data as RemoteResult;
  const lines = [`${r.status ?? '?'}${r.reason ? ` (${r.reason})` : ''}  revision ${r.revision ?? '?'}`];
  if (r.tabId) lines.push(`tab: ${r.tabId}${r.outcome ? ` (${r.outcome})` : ''}`);
  if (r.dialogId) lines.push(`dialog: ${r.dialogId}${r.dialogState ? ` ${r.dialogState}` : ''}`);
  if (r.pendingInteractionId) {
    lines.push(`waiting for the human: interaction ${r.pendingInteractionId} [${(r.choices ?? []).join(', ')}]`);
  }
  if (r.inspection) lines.push(renderInspection(r.inspection));
  lines.push(`instance: ${r.instanceId ?? '?'}  request: ${r.requestId ?? '?'}`);
  return lines.join('\n');
}

function renderInspection(raw: Record<string, unknown>): string {
  const tabs = (raw['orderedTabIds'] as Array<Record<string, unknown>> | undefined) ?? [];
  const visible = new Set((raw['visibleTabIds'] as string[] | undefined) ?? []);
  const presentation = raw['presentation'] as { surface?: string; tabId?: string } | undefined;
  const scope = raw['scope'] as { mode?: string; selectedTypeIds?: string[] } | undefined;
  const lines = [
    `scope: ${scope?.mode === 'byType' ? `by type (${(scope.selectedTypeIds ?? []).join(', ')})` : 'mixed'}`,
    `active: ${presentation?.surface === 'tab' ? presentation.tabId : 'start'}`,
    `tabs (${tabs.length}, ${visible.size} visible):`,
  ];
  for (const tab of tabs) {
    const id = String(tab['id']);
    const marks = `${presentation?.tabId === id ? '*' : ' '}${visible.has(id) ? ' ' : 'h'}`;
    const what = tab['type'] === 'entity' ? `${String(tab['kind'])} ${String(tab['entityId'])}`
      : tab['type'] === 'draft' ? `draft ${String(tab['kind'])}${tab['dirty'] ? ' (dirty)' : ''}`
      : String(tab['type']);
    lines.push(`  ${marks} ${id}  ${what}`);
  }
  const pending = raw['pending'] as { reason?: string; id?: string } | undefined;
  if (pending) lines.push(`pending: ${pending.reason} (${pending.id})`);
  return lines.join('\n');
}

/** Send one Workspace command through the node and print the window's Result. */
async function send(cmd: CommandContext, command: string, args?: unknown): Promise<ExitCode> {
  refuseMutationId(cmd.path.join(' '), cmd.options.value('mutation-id'));
  const spaceId = requireSpace(cmd.ctx);
  const instanceId = cmd.options.value('instance');
  const expectedRevision = integerOption(cmd, 'expect-revision');
  const waitMs = integerOption(cmd, 'wait-ms');
  const requestId = cmd.options.value('request-id') ?? randomUUID();

  const result = await observedInvoke<RemoteResult>(clientFor(cmd.ctx), 'workspace.command', {
    params: { spaceId },
    body: {
      requestId,
      command,
      ...(args === undefined ? {} : { args }),
      ...(instanceId ? { instanceId } : {}),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(waitMs === undefined ? {} : { timeoutMs: waitMs }),
    },
  });
  cmd.out.data(result, renderResult);
  return exitForResult(result);
}

async function instances(cmd: CommandContext): Promise<ExitCode> {
  const spaceId = requireSpace(cmd.ctx);
  const list = await observedInvoke<{ items: Array<Record<string, unknown>> }>(clientFor(cmd.ctx), 'workspace.instances.list', {
    params: { spaceId },
  });
  cmd.out.data(list, (data) => {
    const items = (data as typeof list).items;
    if (items.length === 0) return 'no live Workspace window (open the app in a browser, signed in as you)';
    return items
      .map((i) => `${String(i['instanceId'])}  ${i['focused'] ? 'focused' : '       '}  ${i['visible'] ? 'visible' : 'hidden '}  view=${String(i['view'])}${i['mounted'] ? '' : ' (workspace not open)'}  rev=${String(i['revision'])}  seen ${String(i['lastSeen'])}`)
      .join('\n');
  });
  return EXIT_OK;
}

async function inspect(cmd: CommandContext): Promise<ExitCode> {
  const spaceId = requireSpace(cmd.ctx);
  const instanceId = cmd.options.value('instance');
  const result = await observedInvoke<RemoteResult>(clientFor(cmd.ctx), 'workspace.inspect', {
    params: { spaceId },
    ...(instanceId ? { query: { instanceId } } : {}),
  });
  cmd.out.data(result, renderResult);
  return exitForResult(result);
}

const OPEN_HINT = 'tm8 workspace tabs open <kind> <entity-id> [--no-activate]';

export const WORKSPACE_COMMANDS: CommandModule[] = [
  { path: ['workspace', 'instances'], run: instances },
  { path: ['workspace', 'inspect'], run: inspect },
  {
    path: ['workspace', 'command'],
    run: (cmd) => {
      const name = arg(cmd, 0, 'command', 'tm8 workspace command workspace.tabs.open --args \'{"kind":"task","entityId":"<id>"}\'');
      const raw = cmd.options.value('args');
      let args: unknown;
      if (raw !== undefined) {
        try {
          args = JSON.parse(raw);
        } catch {
          usage('--args must be JSON', '--args \'{"tabId":"<tab-id>"}\'');
        }
      }
      return send(cmd, name, args);
    },
  },
  {
    path: ['workspace', 'tabs', 'open'],
    run: (cmd) => {
      const kind = arg(cmd, 0, 'kind', OPEN_HINT);
      const entityId = arg(cmd, 1, 'entity-id', OPEN_HINT);
      const subview = cmd.options.value('subview');
      return send(cmd, 'workspace.tabs.open', {
        kind,
        entityId,
        ...(cmd.options.bool('no-activate') ? { activate: false } : {}),
        ...(subview ? { subview } : {}),
      });
    },
  },
  {
    path: ['workspace', 'tabs', 'close'],
    run: (cmd) => send(cmd, 'workspace.tabs.close', { tabId: arg(cmd, 0, 'tab-id', 'tm8 workspace tabs close <tab-id>') }),
  },
  {
    path: ['workspace', 'tabs', 'close-visible'],
    run: (cmd) => {
      const except = cmd.options.value('except');
      return send(cmd, 'workspace.tabs.closeVisible', except ? { except } : {});
    },
  },
  {
    path: ['workspace', 'tabs', 'activate'],
    run: (cmd) => send(cmd, 'workspace.tabs.activate', { tabId: arg(cmd, 0, 'tab-id', 'tm8 workspace tabs activate <tab-id>') }),
  },
  {
    path: ['workspace', 'tabs', 'move'],
    run: (cmd) => {
      const tabId = arg(cmd, 0, 'tab-id', 'tm8 workspace tabs move <tab-id> [--before <tab-id>]');
      const before = cmd.options.value('before');
      return send(cmd, 'workspace.tabs.move', { tabId, ...(before ? { beforeTabId: before } : {}) });
    },
  },
  {
    path: ['workspace', 'scope', 'set'],
    run: (cmd) => {
      const hint = 'tm8 workspace scope set mixed | by-type [<kind>...] [--kinds a,b]';
      const mode = SCOPE_MODES[arg(cmd, 0, 'mode', hint).toLowerCase()];
      if (!mode) usage('scope mode must be `mixed` or `by-type`', hint);
      if (mode === 'mixed') return send(cmd, 'workspace.tabScope.set', { mode });
      const kinds = [...cmd.args.slice(1), ...(cmd.options.value('kinds')?.split(',') ?? [])]
        .map((k) => k.trim())
        .filter((k) => k !== '');
      return send(cmd, 'workspace.tabScope.set', { mode, ...(kinds.length ? { selectedTypeIds: kinds } : {}) });
    },
  },
  {
    path: ['workspace', 'drafts', 'open'],
    run: (cmd) => send(cmd, 'workspace.drafts.open', { kind: arg(cmd, 0, 'kind', 'tm8 workspace drafts open <kind>') }),
  },
  {
    path: ['workspace', 'browser', 'set'],
    run: (cmd) => {
      const kind = cmd.options.value('kind');
      const query = cmd.options.value('search');
      return send(cmd, 'workspace.browser.set', { browserId: 'main', ...(kind ? { kind } : {}), ...(query !== undefined ? { query } : {}) });
    },
  },
  {
    path: ['workspace', 'layout', 'set'],
    run: (cmd) => {
      const expandedRaw = cmd.options.value('expanded');
      if (expandedRaw !== undefined && expandedRaw !== 'true' && expandedRaw !== 'false') {
        usage('--expanded expects true or false', '--expanded true');
      }
      const browserWidth = integerOption(cmd, 'browser-width');
      const chatWidth = integerOption(cmd, 'chat-width');
      return send(cmd, 'workspace.layout.set', {
        ...(expandedRaw === undefined ? {} : { expanded: expandedRaw === 'true' }),
        ...(browserWidth === undefined ? {} : { browserWidth }),
        ...(chatWidth === undefined ? {} : { chatWidth }),
      });
    },
  },
  {
    path: ['workspace', 'dialogs', 'open'],
    run: (cmd) => send(cmd, 'workspace.dialogs.open', { dialogId: dialogArg(cmd) }),
  },
  {
    path: ['workspace', 'dialogs', 'close'],
    run: (cmd) => send(cmd, 'workspace.dialogs.close', { dialogId: dialogArg(cmd) }),
  },
  {
    path: ['workspace', 'view', 'set'],
    run: (cmd) => send(cmd, 'workspace.view.set', { view: arg(cmd, 0, 'view', 'tm8 workspace view set tabs') }),
  },
];

function dialogArg(cmd: CommandContext): string {
  const hint = `tm8 workspace dialogs ${cmd.path[2]} <${WORKSPACE_DIALOG_IDS.join('|')}>`;
  const id = arg(cmd, 0, 'dialog-id', hint);
  if (!(WORKSPACE_DIALOG_IDS as readonly string[]).includes(id)) usage(`unknown dialog ${JSON.stringify(id)}`, hint);
  return id;
}
