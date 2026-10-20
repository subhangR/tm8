/**
 * `tm8 mcp import` — register the MCP servers a member has ALREADY configured
 * in Claude Code or Codex as tm8 connectors.
 *
 * WHY THIS RUNS IN THE CLI AND NOWHERE ELSE. The config lives on the member's
 * own machine: `~/.claude.json`, a project `.mcp.json`, `~/.codex/config.toml`.
 * The tm8 server cannot see it and must never try — it does not read member
 * home directories. So the read happens here, in the member's own process,
 * under their own identity, and only two things go over the wire: connector
 * DEFINITIONS (metadata, no values) and — with `--with-credentials`, one call
 * per connector — the literal token, sealed as that member's OWN private
 * credential. Nothing is shared with the Space. Nothing is printed.
 *
 * The translation itself is `@tm8/contract`'s `translateMcpConfigText`, shared
 * with the UI's import box so "which configs does tm8 understand" has one
 * answer. This file owns the local file reading, the diff against what the
 * Space already has, and the writes.
 */
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  MCP_IMPORT_FORMATS,
  MCP_IMPORT_LIMIT,
  McpImportError,
  selectMcpImports,
  translateMcpConfigText,
  type McpImportCandidate,
  type McpImportDecision,
  type McpImportFormat,
  type McpServerDefinition,
  type McpServerListResult,
  type McpServerView,
} from '@tm8/contract';
import { assertKnownOptions } from './entity.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

function defaultPath(format: McpImportFormat): string {
  const home = process.env.HOME || homedir();
  if (format === 'codex') return join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml');
  if (format === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  return resolve(process.cwd(), '.mcp.json');
}

/** `~/x` is expanded here because a member types it and no shell did it for them. */
function expand(path: string): string {
  if (path === '~') return process.env.HOME || homedir();
  if (path.startsWith('~/')) return join(process.env.HOME || homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

interface PlanRow {
  sourceName: string;
  sourcePointer: string;
  name: string;
  transport: 'http' | 'stdio';
  /** The URL or the command — never a header, never an env value. */
  endpoint: string;
  action: McpImportDecision;
  reason?: string;
  /** Whether the SOURCE carried a literal credential. Never the value itself. */
  hasSecret: boolean;
  oauthProvider?: string;
  notes: string[];
}

function endpointOf(definition: McpServerDefinition): string {
  return definition.transport === 'http'
    ? (definition.url as string)
    : [definition.command, ...(definition.args ?? [])].join(' ');
}

async function existingServers(cmd: CommandContext, spaceId: string): Promise<McpServerView[]> {
  const items: McpServerView[] = [];
  let cursor: string | undefined;
  do {
    const page = await observedInvoke<McpServerListResult>(clientFor(cmd.ctx), 'mcp.servers.list', {
      params: { spaceId },
      query: { limit: '100', ...(cursor ? { cursor } : {}) },
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

function render(result: ImportResult): string {
  const lines: string[] = [`${result.format} ${result.path}`];
  const mark: Record<McpImportDecision, string> = { register: '+', duplicate: '=', needs_trust: '!', over_limit: '!' };
  for (const row of result.plan) {
    const suffix = row.action === 'register' ? '' : ` — ${row.reason ?? row.action}`;
    lines.push(`  ${mark[row.action]} ${row.name} (${row.transport} ${row.endpoint})${suffix}`);
    for (const note of row.notes) lines.push(`      ${note}`);
  }
  for (const problem of result.problems) lines.push(`  ✗ ${problem.sourceName} — ${problem.reason}`);
  if (result.dryRun) {
    const count = result.plan.filter(row => row.action === 'register').length;
    lines.push(`  dry run: ${count} connector${count === 1 ? '' : 's'} would be registered`);
  } else {
    for (const item of result.registered) lines.push(`  registered ${item.name} ${item.serverId}`);
    for (const item of result.credentials) lines.push(`  stored your private credential for ${item.name}`);
  }
  for (const hint of result.hints) lines.push(`  ${hint}`);
  return lines.join('\n');
}

interface ImportResult {
  spaceId: string;
  format: McpImportFormat;
  path: string;
  dryRun: boolean;
  plan: PlanRow[];
  problems: Array<{ sourceName: string; sourcePointer: string; reason: string }>;
  registered: Array<{ serverId: string; name: string }>;
  credentials: Array<{ serverId: string; name: string }>;
  hints: string[];
}

export const MCP_IMPORT_COMMAND: CommandModule = {
  path: ['mcp', 'import'],
  async run(cmd: CommandContext): Promise<ExitCode> {
    assertKnownOptions(cmd, ['from', 'path', 'dry-run', 'trust-stdio', 'with-credentials', 'mutation-id']);
    const spaceId = requireSpace(cmd.ctx);
    const from = cmd.options.require('from');
    if (!MCP_IMPORT_FORMATS.includes(from as McpImportFormat)) {
      throw new CliError(`--from must be one of ${MCP_IMPORT_FORMATS.join('|')}`, EXIT_USAGE);
    }
    const format = from as McpImportFormat;
    const trustStdio = cmd.options.bool('trust-stdio');
    const withCredentials = cmd.options.bool('with-credentials');
    const dryRun = cmd.options.bool('dry-run');
    const given = cmd.options.value('path');
    const path = given === undefined ? defaultPath(format) : expand(given);

    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new CliError(
        code === 'ENOENT' ? `no ${format} configuration at ${path}` : `could not read ${path}: ${code ?? 'unknown error'}`,
        EXIT_USAGE,
        { hint: 'pass --path <file> to point at the configuration you want imported' },
      );
    }

    let translated;
    try {
      // `sourceLabel` lands in each definition's provenance, which every Space
      // member can read: it is the PATH, nothing read out of the file, and the
      // home prefix is collapsed so an absolute home directory is not graph
      // content.
      const home = process.env.HOME || homedir();
      const label = home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
      translated = translateMcpConfigText(format, text, { trustStdio, sourceLabel: label });
    } catch (error) {
      if (error instanceof McpImportError) throw new CliError(error.message, EXIT_USAGE);
      throw error;
    }

    const existing = await existingServers(cmd, spaceId);
    // One shared decision step (contract `selectMcpImports`): dedupe, the stdio
    // trust gate, the per-import ceiling and the renames, in the same order the
    // UI's import box applies them.
    const decisions = selectMcpImports(translated.candidates, existing, { trustStdio, limit: MCP_IMPORT_LIMIT });
    const plan: PlanRow[] = decisions.map(({ candidate, decision, reason }) => ({
      sourceName: candidate.sourceName,
      sourcePointer: candidate.sourcePointer,
      name: candidate.definition.name,
      transport: candidate.definition.transport,
      endpoint: endpointOf(candidate.definition),
      action: decision,
      ...(reason ? { reason } : {}),
      hasSecret: candidate.secret !== undefined,
      ...(candidate.oauthProvider ? { oauthProvider: candidate.oauthProvider } : {}),
      notes: candidate.notes,
    }));
    const register: McpImportCandidate[] = decisions.filter(row => row.decision === 'register').map(row => row.candidate);
    if (decisions.some(row => row.decision === 'needs_trust')) {
      plan.forEach(row => { if (row.action === 'needs_trust') row.reason = 'runs a local command: re-run with --trust-stdio to register it'; });
    }

    const hints: string[] = [];
    if (register.length) hints.push('imported connectors start unapproved: an administrator approves them before any session can attach one');
    const oauth = register.filter(candidate => candidate.definition.auth.type === 'oauth2');
    if (oauth.length) {
      hints.push(`connect in tm8 (tm8 mcp oauth begin <server-id> --input @label.json): ${oauth.map(c => c.definition.name).join(', ')}`);
    }
    const secrets = register.filter(candidate => candidate.secret !== undefined);
    if (secrets.length && !withCredentials) {
      hints.push(`${secrets.length} connector${secrets.length === 1 ? '' : 's'} carried a token in this file: re-run with --with-credentials to store it as YOUR private credential, or add it yourself with tm8 mcp credential create`);
    }

    const result: ImportResult = { spaceId, format, path, dryRun, plan, problems: translated.problems, registered: [], credentials: [], hints };
    if (dryRun || !register.length) {
      if (!register.length && !dryRun) hints.push('nothing new to register');
      cmd.out.data(result, render);
      return EXIT_OK;
    }

    const mutationId = resolveMutationId(cmd.options.value('mutation-id'));
    const imported = await observedInvoke<{ items: McpServerView[] }>(clientFor(cmd.ctx), 'mcp.servers.import', {
      params: { spaceId },
      body: {
        clientMutationId: mutationId,
        spaceId,
        definitions: register.map(candidate => candidate.definition),
        ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}),
      },
    });
    const byName = new Map(imported.items.map(item => [item.definition.name, item.id]));
    result.registered = register.flatMap(candidate => {
      const serverId = byName.get(candidate.definition.name);
      return serverId ? [{ serverId, name: candidate.definition.name }] : [];
    });

    if (withCredentials) {
      for (const candidate of secrets) {
        const serverId = byName.get(candidate.definition.name);
        if (!serverId || !candidate.secret) continue;
        // One credential per connector, visibility PRIVATE (the default the
        // credential store applies): the importing member's own token, never
        // the Space's. The value only ever travels in this request body.
        await observedInvoke(clientFor(cmd.ctx), 'mcp.credentials.create', {
          params: { serverId },
          body: {
            clientMutationId: resolveMutationId(undefined),
            serverId,
            label: `imported from ${format}`,
            secret: candidate.secret.value,
            ...(cmd.ctx.actor ? { actorId: cmd.ctx.actor.value } : {}),
          },
        });
        result.credentials.push({ serverId, name: candidate.definition.name });
      }
    }
    cmd.out.data(result, render);
    return EXIT_OK;
  },
};
