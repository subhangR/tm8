import { rememberMcpOAuth } from './oauth-callback';
import { McpUiError } from './errors';
import { CollabError, detectMcpImportFormat, literalCredentialIn, literalCredentialInPath, McpImportError, McpServerDefinitionSchema, mcpCatalogEntry, selectMcpImports, translateMcpConfigText, type ChatMcpSelectionsResult, type McpCatalogEntry, type McpCatalogListResult, type McpCredentialView, type McpResolveResult, type McpServerDefinition, type McpServerListResult, type McpServerView, type McpSessionProvenance, type McpTestResult, type Cursor } from '@tm8/contract';
import type { HttpClient } from '../data/real/http';
import type { Seam } from '../data/seam';
import type { McpAddOutcome, McpDefinition, McpPort, McpServer } from './port';

export function definitionFor(input: McpDefinition, previous?: McpServerDefinition): McpServerDefinition {
  const priorAuth = previous?.auth;
  const oauth = priorAuth?.type === 'oauth2' ? priorAuth : undefined;
  const issuer = input.issuer ?? oauth?.issuer;
  const authorizationUrl = input.authorizationUrl ?? oauth?.authorizationUrl;
  const tokenUrl = input.tokenUrl ?? oauth?.tokenUrl;
  const clientId = input.clientId ?? oauth?.clientId;
  const clientSecretEnv = input.clientSecretEnv ?? oauth?.clientSecretEnv;
  const slot = input.secretSlot ?? (priorAuth?.type === 'api_key' ? priorAuth.headerName ?? priorAuth.envKey : undefined) ?? (input.transport === 'http' ? 'Authorization' : 'API_KEY');
  // THE FORM IS NOT THE WHOLE DEFINITION. `catalogId`, `serverKey`,
  // `firstParty`, `defaultOn`, `allowExternalClients` and `gates` have no input
  // here, so rebuilding from the form alone DROPS them: a connector edited
  // after being added from Discover would lose the `catalogId` that Discover's
  // "Added" join reads (§5.1) and the space-wide `defaultOn` an admin set.
  // Carried through from `previous` instead; `port.patch` is the exact path for
  // changing one of them.
  const carried = previous
    ? {
      ...(previous.catalogId ? { catalogId: previous.catalogId } : {}),
      ...(previous.serverKey ? { serverKey: previous.serverKey } : {}),
      ...(previous.firstParty !== undefined ? { firstParty: previous.firstParty } : {}),
      ...(previous.defaultOn !== undefined ? { defaultOn: previous.defaultOn } : {}),
      ...(previous.allowExternalClients !== undefined ? { allowExternalClients: previous.allowExternalClients } : {}),
      ...(previous.gates ? { gates: previous.gates } : {}),
    }
    : {};
  const definition = {
    ...carried,
    name: input.title, provenance: input.description || undefined, transport: input.transport,
    ...(input.transport === 'http' ? { url: input.url } : { command: input.command, args: input.args ?? [], stdioTrusted: input.trustedCode ?? previous?.stdioTrusted ?? false }),
    approved: input.approved ?? previous?.approved ?? false,
    allowPrivateNetwork: input.allowPrivateNetwork ?? previous?.allowPrivateNetwork ?? false,
    enabled: 'enabled' in input ? input.enabled : previous?.enabled ?? true,
    envKeys: input.auth === 'api_key' && input.transport === 'stdio' ? [slot] : [],
    headerKeys: input.auth === 'api_key' && input.transport === 'http' ? [slot] : [],
    auth: input.auth === 'none' ? { type: 'none' } : input.auth === 'api_key'
      ? { type: 'api_key', ...(input.transport === 'http' ? { headerName: slot, prefix: input.prefix ?? (priorAuth?.type === 'api_key' ? priorAuth.prefix : undefined) ?? 'Bearer' } : { envKey: slot }) }
      : { type: 'oauth2', ...(issuer ? { issuer } : {}), ...(authorizationUrl ? { authorizationUrl } : {}), ...(tokenUrl ? { tokenUrl } : {}), ...(clientId ? { clientId } : {}), ...(clientSecretEnv ? { clientSecretEnv } : {}), scopes: input.scopes ?? oauth?.scopes ?? [] },
  };
  return McpServerDefinitionSchema.parse(definition);
}
export function viewOf(server: McpServerView, accounts: McpCredentialView[]): McpServer {
  const d = server.definition;
  return { id: server.id, version: server.version, title: d.name, description: d.provenance ?? '', source: d,
    transport: d.transport, url: d.url, command: d.command, args: d.args, auth: d.auth.type === 'oauth2' ? 'oauth' : d.auth.type,
    approved: d.approved, enabled: d.enabled !== false, canApprove: server.allowed.approve,
    canManage: server.allowed.manage, canAttach: server.allowed.attach, health: server.health,
    // ownerId is null on a Space-owned connection (G2): it has no member owner,
    // so "Another member" would be a plain lie. The full Shared/Personal column
    // is §10.1/§10.3 and belongs to the Connectors page work.
    accounts: accounts.map(a => ({ id: a.id, label: a.label, ...(a.ownerId ? { ownerId: a.ownerId } : {}), ownerLabel: "ownerLabel" in a && typeof a.ownerLabel === "string" ? a.ownerLabel : a.ownerId === null ? "Shared with Space" : a.manageable ? "You" : "Another member", canUse: a.usable, canManage: a.manageable,
      status: a.revoked ? 'revoked' : a.usable && a.reason === 'ready' ? 'connected' : a.reason,
      sharing: a.visibility === 'selected' ? 'members' : a.visibility, memberIds: a.sharedMemberIds,
      // §10.1's Access column, drawer and status copy. All five come straight
      // from `list_mcp_credentials` (341) — no secret, and nothing derived here.
      ...(a.scope ? { scope: a.scope } : {}), statusReason: a.statusReason ?? null,
      accountLabel: a.accountLabel ?? null, grantedScopes: a.grantedScopes ?? [],
      lastUsedAt: a.lastUsedAt ?? null, lastRefreshAt: a.lastRefreshAt ?? null, authType: a.authType,
      // S10/S12: server-computed, passed through. `null` for a connector no
      // first-party host serves, which is NOT the same as zero.
      unavailableToolCount: a.unavailableToolCount ?? null })),
  };
}
/**
 * Accept a member's REAL harness configuration — `~/.claude.json`, a project
 * `.mcp.json`, `~/.codex/config.toml` — and keep only metadata.
 *
 * This used to refuse any config carrying `type`, `headers` or `env`, which is
 * every config anyone actually has: the box only accepted a hand-written tm8
 * shape. The shared translator (`@tm8/contract`) now reads the real formats
 * and turns a literal header or env token into a DECLARED SLOT. The value it
 * extracts is deliberately dropped here rather than sent anywhere: the member
 * adds their own credential per connector, so no token is ever carried into
 * the Space by an import.
 *
 * `existing` is the Space's current connectors, so this takes the same
 * decisions `tm8 mcp import` does through the same `selectMcpImports`: a
 * duplicate endpoint, an untrusted local command and an over-limit row are
 * SKIPPED AND REPORTED, never a reason to refuse the rest of the config, and a
 * name the Space already uses is renamed rather than left to fail the whole
 * transactional import.
 */
export function importPlan(
  text: string,
  trustedCode: boolean,
  existing: readonly { id: string; definition: McpServerDefinition }[] = [],
): { definitions: McpServerDefinition[]; summary: string } {
  let translated;
  try {
    translated = translateMcpConfigText(detectMcpImportFormat(text), text, { trustStdio: trustedCode });
  } catch (error) {
    throw new McpUiError(error instanceof McpImportError ? error.message : 'Enter a valid MCP configuration before importing.');
  }
  const decisions = selectMcpImports(translated.candidates, existing, { trustStdio: trustedCode });
  const register = decisions.filter(row => row.decision === 'register').map(row => row.candidate);
  const skipped = [
    ...decisions.filter(row => row.decision !== 'register').map(row => `${row.candidate.sourceName} (${row.reason ?? row.decision})`),
    ...translated.problems.map(problem => `${problem.sourceName} (${problem.reason})`),
  ];
  if (!register.length) {
    throw new McpUiError(skipped.length
      ? `No connectors were registered. Skipped ${skipped.join('; ')}.`
      : 'No connectors tm8 can register in this configuration.');
  }
  const definitions = register.map(candidate => McpServerDefinitionSchema.parse(candidate.definition));
  const needCredential = register.filter(candidate => candidate.definition.auth.type === 'api_key');
  const oauth = register.filter(candidate => candidate.definition.auth.type === 'oauth2');
  const summary = [
    `Imported ${definitions.length} connector${definitions.length === 1 ? '' : 's'}; an administrator approves them before any session can use one.`,
    needCredential.length ? `No token was taken from the configuration — add your own key to: ${needCredential.map(c => c.definition.name).join(', ')}.` : '',
    oauth.length ? `Connect in tm8: ${oauth.map(c => c.definition.name).join(', ')}.` : '',
    skipped.length ? `Skipped ${skipped.join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  return { definitions, summary };
}
export function importDefinitions(
  text: string,
  trustedCode: boolean,
  existing: readonly { id: string; definition: McpServerDefinition }[] = [],
): McpServerDefinition[] {
  return importPlan(text, trustedCode, existing).definitions;
}
/**
 * The existing-connector id out of `mcp.servers.create`'s conflict (B22/B25).
 * `refuseIfOpenCatalogRequest` puts it in `details.serverId`; anything else is
 * someone else's conflict and is rethrown by the caller.
 */
function conflictServerId(error: unknown): string | null {
  if (!(error instanceof CollabError) || error.code !== 'conflict') return null;
  const id = (error.details as Record<string, unknown> | undefined)?.serverId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * One row of the §10.1 "Import from .mcp.json" preview (D1/D3).
 *
 * WHY A PREVIEW AND NOT `importDefinitions`. That function answers "is this
 * whole file importable" and throws on the first problem — correct for the CLI
 * shape it serves, useless for a person pasting a real `.mcp.json`, where one
 * stdio entry with an `env` block would reject the other six servers with one
 * sentence and no indication of which line was at fault. This parses each entry
 * INDEPENDENTLY so the invalid ones become red rows and the rest stay
 * importable.
 *
 * SECRETS ARE DROPPED, NOT IMPORTED (D3). A real `.mcp.json` carries `env` and
 * `headers` with live values. They are stripped here, the row says so, and the
 * person connects an account afterwards — which is the whole reason tm8 cannot
 * just load the file.
 */
export interface McpImportRow {
  key: string; name: string;
  transport: 'http' | 'stdio' | 'unknown';
  target: string;
  definition?: McpServerDefinition;
  /** Why this row cannot be imported. Mutually exclusive with `definition`. */
  error?: string;
  /** The entry carried literal secret values, which were left behind. */
  droppedSecrets: boolean;
}

/** What `McpServerDefinitionSchema` can actually hold. Anything else is dropped or refused. */
const IMPORT_KEEP = ['url', 'command', 'args', 'transport', 'auth', 'envKeys', 'headerKeys', 'provenance'];
/** Fields a real `.mcp.json` uses for live secret VALUES. Dropped, and the row says so. */
const IMPORT_SECRETS = ['env', 'headers', 'apiKey', 'api_key', 'token', 'secret', 'password', 'authorization'];

export function previewMcpConfig(json: string): McpImportRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new McpUiError('Enter valid JSON before importing.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new McpUiError('Expected an MCP configuration object.');
  const rows = (parsed as Record<string, unknown>).mcpServers;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new McpUiError('Expected an mcpServers object.');
  return Object.entries(rows as Record<string, unknown>).map(([name, raw]): McpImportRow => {
    const base = { key: name, name };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...base, transport: 'unknown', target: '', droppedSecrets: false, error: 'Not a server object.' };
    }
    const entry = raw as Record<string, unknown>;
    const droppedSecrets = Object.keys(entry).some(key => IMPORT_SECRETS.includes(key));
    const transport = entry.transport === 'stdio' || entry.transport === 'http' ? entry.transport : entry.url ? 'http' : entry.command ? 'stdio' : 'unknown';
    const target = String(entry.url ?? entry.command ?? '');
    if (transport === 'unknown') return { ...base, transport, target, droppedSecrets, error: 'No url and no command.' };
    // `args` and the URL are KEPT, so a token written into either would ride
    // into the Space definition. The same scan `tm8 mcp import` refuses on.
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
    const literal = literalCredentialIn(args) ?? (typeof entry.url === 'string' ? (() => {
      try { return literalCredentialInPath(new URL(entry.url as string).pathname); } catch { return undefined; }
    })() : undefined);
    // The row names where it points without echoing the token: the URL's
    // origin, or the command alone.
    const safeTarget = typeof entry.url === 'string' ? (() => { try { return new URL(entry.url as string).origin; } catch { return ''; } })() : String(entry.command ?? '');
    if (literal) return { ...base, transport, target: safeTarget, droppedSecrets, error: `Remove the credential first: ${literal}.` };
    const kept = Object.fromEntries(Object.entries(entry).filter(([key]) => IMPORT_KEEP.includes(key)));
    try {
      const definition = McpServerDefinitionSchema.parse({ ...kept, name, transport,
        // An imported connector arrives with NO auth: the file's own auth
        // block names a secret this import deliberately did not take, so
        // claiming `api_key` here would describe a slot with nothing in it.
        auth: { type: 'none' }, envKeys: [], headerKeys: [],
        approved: false, enabled: true, ...(transport === 'stdio' ? { stdioTrusted: false } : {}) });
      return { ...base, transport, target, droppedSecrets, definition };
    } catch (failure) {
      // The contract refinement's own first message, which names the field:
      // "http requires url and forbids command…". It is AUTHORED contract text,
      // never upstream data, so it is safe to show (the `errors.ts` rule).
      //
      // Read structurally rather than with `instanceof z.ZodError`: `zod` is
      // not a dependency of this package, and the contract's build is the only
      // thing that pins its version — importing it here to name one error class
      // would add a second copy to the bundle.
      const issues = (failure as { issues?: unknown }).issues;
      const first = Array.isArray(issues) ? (issues[0] as { message?: unknown } | undefined)?.message : undefined;
      return { ...base, transport, target, droppedSecrets, error: typeof first === 'string' ? first : 'This server could not be read.' };
    }
  });
}

/**
 * A member's requested connector (B13).
 *
 * `definitionFor` always FILLS the trust and reach flags, because an admin's
 * form always has a value for them — `allowPrivateNetwork: false`, and
 * `stdioTrusted` on a local command. The request schema refuses each of those
 * KEYS, not just a dangerous value, so a request built the ordinary way is
 * rejected with "only an administrator sets allowPrivateNetwork" even though
 * the member asked for nothing. They are dropped here instead of being
 * defaulted.
 *
 * `provenance` goes too: it is a CLAIM ABOUT IDENTITY (the line an admin reads
 * before approving), so a member's words ride in the request's `note` instead.
 */
function requestedDefinition(input: McpDefinition): McpServerDefinition {
  const { allowPrivateNetwork: _a, stdioTrusted: _s, defaultOn: _d, allowExternalClients: _e,
    firstParty: _f, gates: _g, catalogId: _c, serverKey: _k, provenance: _p, ...rest } = definitionFor(input);
  return rest as McpServerDefinition;
}

export function createMcpPort(http: HttpClient, seam: Pick<Seam, 'query' | 'connections' | 'commands'>, spaceId: string): McpPort {
  async function attachments(targetId: string) {
    const edges: { id: string; serverId: string }[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await seam.connections(targetId, { limit: 100, cursor });
      edges.push(...page.items.filter(edge => edge.type === 'equips' && edge.source.id === targetId).map(edge => ({ id: edge.id, serverId: edge.target.id })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return edges;
  }
  /** Every connector the Space has, paged. Shared by the catalog read and the import diff. */
  async function allServers(targetId?: string, teamMemberId?: string) {
    const items: McpServerView[] = [];
    let cursor: string | undefined;
    let allowed = { register: false, attach: false };
    do {
      const page = await http.call<McpServerListResult>('mcp.servers.list', { params: { spaceId }, query: { targetId: targetId ?? teamMemberId, limit: 100, cursor } });
      items.push(...page.items); allowed = page.allowed; cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return Object.assign(items, { allowed });
  }
  const command = () => ({ clientMutationId: `mcp-${crypto.randomUUID()}` });
  /** B22/B25's ADOPT: approve the row that already exists, at the version it is at now. */
  async function approveById(serverId: string) {
    const current = await http.call<McpServerView>('mcp.servers.get', { params: { serverId } });
    await http.call('mcp.servers.update', { params: { serverId }, body: { ...command(), serverId, expectedVersion: current.version, definition: { ...current.definition, approved: true } } });
  }
  return {
    async catalog(targetId, teamMemberId) {
      // Two round trips, not four: the connector list, the defaults and the
      // target's attachments are independent reads and go out together; only
      // the accounts wait, because they are asked per connector. Every launch
      // card opens on this read, so its depth is the card's.
      const [items, resolved, attached] = await Promise.all([
        allServers(targetId, teamMemberId),
        http.call<McpResolveResult>('mcp.resolve', { params: { spaceId }, body: { spaceId, ...(targetId ? { targetIds: [targetId] } : {}), ...(teamMemberId ? { teamMemberId } : {}) } }),
        targetId ? attachments(targetId) : Promise.resolve([]),
      ]);
      const servers = await Promise.all(items.map(async server => {
        const accounts = server.definition.auth.type === 'none' ? [] : await http.call<McpCredentialView[]>('mcp.credentials.list', { params: { serverId: server.id } });
        return viewOf(server, accounts);
      }));
      return { servers, attachedServerIds: attached.map(e => e.serverId), defaults: resolved.selections.map(s => ({ serverId: s.server.id, ...(s.credentialId ? { credentialId: s.credentialId } : {}) })), canRegister: items.allowed.register, canAttach: items.allowed.attach };
    },
    async catalogEntries() {
      // Asked WITH the Space, so each entry carries `added` (B16) and Discover
      // can draw Added / Requested / Approve without paging servers.list.
      const result = await http.call<McpCatalogListResult>('mcp.catalog.list', { query: { spaceId } });
      return result.items;
    },
    async addFromCatalog(catalogId): Promise<McpAddOutcome> {
      const entry = mcpCatalogEntry(catalogId);
      if (!entry?.definition) throw new McpUiError('This connector is not available yet.');
      try {
        const created = await http.call<McpServerView>('mcp.servers.create', { params: { spaceId }, body: { ...command(), spaceId, definition: { ...entry.definition, approved: true } } });
        return { serverId: created.id, adopted: false };
      } catch (error) {
        // B22/B25: the Space already holds an OPEN member request for this
        // entry. Approving THAT row is the whole point — a second connector
        // would leave the requester's row orphaned and the Space with two.
        const existing = conflictServerId(error);
        if (!existing) throw error;
        await approveById(existing);
        return { serverId: existing, adopted: true };
      }
    },
    async request(input, note) {
      await http.call('mcp.servers.request', { params: { spaceId }, body: { ...command(),
        ...('catalogId' in input ? { catalogId: input.catalogId } : { definition: requestedDefinition(input.definition) }),
        ...(note ? { note } : {}) } });
    },
    async patch(server, patch) {
      if (!server.source) throw new McpUiError('This connector could not be read. Reload and try again.');
      await http.call('mcp.servers.update', { params: { serverId: server.id }, body: { ...command(), serverId: server.id, expectedVersion: server.version, definition: McpServerDefinitionSchema.parse({ ...server.source, ...patch }) } });
    },
    async register(input) { await http.call('mcp.servers.create', { params: { spaceId }, body: { ...command(), spaceId, definition: definitionFor(input) } }); },
    async update(server, input) { await http.call('mcp.servers.update', { params: { serverId: server.id }, body: { ...command(), serverId: server.id, expectedVersion: server.version, definition: definitionFor(input, server.source) } }); },
    async remove(server) { await http.call('mcp.servers.delete', { params: { serverId: server.id }, body: { ...command(), serverId: server.id, expectedVersion: server.version } }); },
    async importConfig(json, trustedCode) {
      // The Space's connectors are READ FIRST: dedupe and the rename need them,
      // and importing a name the Space already uses would otherwise refuse the
      // whole transactional batch.
      const { definitions, summary } = importPlan(json, trustedCode, await allServers());
      await http.call('mcp.servers.import', { params: { spaceId }, body: { ...command(), spaceId, definitions } });
      return summary;
    },
    async importMany(definitions) { await http.call('mcp.servers.import', { params: { spaceId }, body: { ...command(), spaceId, definitions } }); },
    async attach(targetId, serverId) { await seam.commands.createEdge({ ...command(), srcId: targetId, dstId: serverId, type: 'equips', props: {} }); },
    async detach(targetId, serverId) {
      const edges = await attachments(targetId);
      for (const edge of edges) if (edge.serverId === serverId) await seam.commands.deleteEdge(edge.id, command());
    },
    async test(selection) {
      const result = await http.call<McpTestResult>('mcp.servers.test', { params: { serverId: selection.serverId }, body: { ...command(), ...selection } });
      // The partial-grant list comes straight from the first-party host (#1323)
      // and is passed through untouched: S10 keeps scope coverage on the server.
      return { ok: result.ready, message: result.reason, tools: result.tools, ...(result.unavailableTools?.length ? { unavailableTools: result.unavailableTools } : {}) };
    },
    async createKey(serverId, label, secret, scope) { await http.call('mcp.credentials.create', { params: { serverId }, body: { ...command(), serverId, label, secret, ...(scope ? { scope } : {}) } }); },
    async rotateKey(_serverId, credentialId, secret) { await http.call('mcp.credentials.rotate', { params: { credentialId }, body: { ...command(), credentialId, secret } }); },
    /**
     * Transport only. Every §10.2 refusal is WORDED by `errors.ts`
     * (`connectFailure`), which the Connect flow calls — this used to match two
     * exact server strings here, and both had already changed shape by the time
     * anyone looked (#1296 appends the cause to each message).
     */
    async startOAuth(serverId, label, scope, returnTo) {
      const result = await http.call<{authorizationUrl:string; expiresAt?:string}>('mcp.oauth.begin', { params: { serverId }, body: { ...command(), serverId, label, ...(scope ? { scope } : {}), ...(returnTo ? { returnTo } : {}) } });
      // A HINT for the callback page: which node this connect was begun
      // against (S4). The authority is the server's pending row, so a browser
      // that refuses session storage loses a nicety, not the connect.
      try { rememberMcpOAuth(result.authorizationUrl, spaceId); } catch { /* The hint is optional by design. */ }
      return result;
    },
    async share(_serverId, credentialId, sharing, memberIds) { await http.call('mcp.credentials.share', { params: { credentialId }, body: { ...command(), credentialId, visibility: sharing === 'members' ? 'selected' : sharing, memberIds } }); },
    async revoke(_serverId, credentialId) { await http.call('mcp.credentials.revoke', { params: { credentialId }, body: { ...command(), credentialId } }); },
    /*
     * §10.4's two chat doors. The chat is named in the PATH on both, like every
     * other `chat.*` operation, and the body carries only what changes.
     *
     * The three-value meaning is passed through UNTOUCHED in both directions:
     * `null` out of the read means "no stored row, the Space's defaults apply",
     * and `null` into the write deletes the row. Collapsing either into `[]`
     * here — the obvious-looking tidy-up — would silently turn "back to
     * defaults" into "every connector off", which is the one mistake in this
     * area a user cannot see until an agent is missing a tool.
     */
    async chatSelections(chatId) {
      const result = await http.call<ChatMcpSelectionsResult>('chat.getMcpSelections', { params: { id: chatId } });
      return result.mcpSelections ?? null;
    },
    async setChatSelections(chatId, value) {
      const result = await http.call<ChatMcpSelectionsResult>('chat.setMcpSelections', {
        params: { id: chatId },
        body: { ...command(), mcpSelections: value },
      });
      return result.mcpSelections ?? null;
    },
    /** §10.6. A pass-through: the server owns §6 and the view only renders it. */
    async sessionProvenance(sessionId) {
      return http.call<McpSessionProvenance>('mcp.sessions.provenance', { params: { sessionId } });
    },
    async members() {
      const members: { id: string; label: string }[] = [];
      let cursor: Cursor | undefined;
      do { const result = await seam.query({ spaceId, kinds: ['member'], limit: 100, cursor }); members.push(...result.page.items.filter(m => m.state?.kind !== 'member' || !m.state.memberStatus).map(m => ({ id: m.id, label: m.title }))); cursor = result.page.nextCursor ?? undefined; } while (cursor);
      return members;
    },
  };
}
