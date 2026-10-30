/**
 * Translate a harness's NATIVE MCP configuration into tm8 connector
 * definitions — the one place that knows Claude Code's `~/.claude.json`, a
 * project `.mcp.json` and Codex's `~/.codex/config.toml`.
 *
 * WHY A TRANSLATOR AND NOT A PASSTHROUGH. A spawned agent never sees a vendor
 * URL or token (ADR 0297): Claude launches pass `--strict-mcp-config` and
 * Codex launches get a copied home with `[mcp_servers]` stripped, so a
 * member's native config is ignored by design and must not start being
 * honoured. Reuse therefore means READING that config once, on the member's
 * own machine, and registering tm8 connectors that describe the same servers —
 * metadata only. A literal header or env value found in the source is carried
 * back to the CALLER in `McpImportCandidate.secret` and is never part of the
 * definition, because a definition is graph content and a graph never holds a
 * secret. The caller's only legitimate destination for that value is
 * `mcp.credentials.create`, which seals it as the importing member's own
 * private credential.
 *
 * Shared by `tm8 mcp import` (packages/cli/src/commands/mcp-import.ts) and the
 * UI's Import configuration box (packages/tm8-ui/src/mcp/adapter.ts) so that
 * "which configs does tm8 understand" has exactly one answer.
 */
import { McpServerDefinitionSchema, type McpServerDefinition } from './mcp.js';

export type McpImportFormat = 'claude' | 'codex' | 'mcp-json';
export const MCP_IMPORT_FORMATS: readonly McpImportFormat[] = ['claude', 'codex', 'mcp-json'];

/** A literal credential the source config carried. In memory only — see the module header. */
export interface McpImportSecret {
  /** Where the value belongs at call time: an HTTP header, or a stdio env var. */
  slot: 'header' | 'env';
  key: string;
  value: string;
}

export interface McpImportCandidate {
  definition: McpServerDefinition;
  /** The server's name in the source config, before tm8 name rules were applied. */
  sourceName: string;
  /** Where in the source it was found — `mcpServers.slack`, `projects["/srv/app"].mcpServers.figma`, `mcp_servers.notion`. */
  sourcePointer: string;
  format: McpImportFormat;
  /** Set when the source held a literal credential value. Never present in `definition`. */
  secret?: McpImportSecret;
  /** The directory provider this server's host matched, when it did. */
  oauthProvider?: string;
  /** stdio connectors run code on the tm8 host: the caller must trust them explicitly. */
  requiresStdioTrust: boolean;
  /** Everything the translation changed or dropped, in the member's words. */
  notes: string[];
}

/** A server in the source that tm8 cannot represent. Named rather than silently skipped. */
export interface McpImportProblem {
  sourceName: string;
  sourcePointer: string;
  reason: string;
}

export interface McpImportResult {
  candidates: McpImportCandidate[];
  problems: McpImportProblem[];
}

/**
 * `mcp.servers.local`: a candidate read from the tm8 HOST's own config. The
 * literal credential is stripped on the server, so only the fact that one was
 * there crosses the wire.
 */
export interface McpLocalImportCandidate extends Omit<McpImportCandidate, 'secret'> {
  droppedSecret: boolean;
}

/** One config file on the tm8 host: `~/.claude.json` or `~/.codex/config.toml`. */
export interface McpLocalConfigSource {
  format: 'claude' | 'codex';
  /** Where it was looked for, `~`-relative when it is under the home directory. */
  path: string;
  found: boolean;
  candidates: McpLocalImportCandidate[];
  problems: McpImportProblem[];
  /** The whole file could not be read or parsed. Authored text, never file content. */
  error?: string;
}

export interface McpLocalConfigsResult {
  sources: McpLocalConfigSource[];
}

export interface McpImportOptions {
  /** Mark translated stdio connectors as trusted code. Default false: they translate but stay untrusted. */
  trustStdio?: boolean;
  /** Shown in `provenance`, e.g. `~/.claude.json`. Never a secret-bearing value. */
  sourceLabel?: string;
}

export class McpImportError extends Error {}

/**
 * Hosts tm8 knows speak OAuth. A match turns the server into an `oauth2`
 * definition so the member connects it IN tm8 (one sealed per-member token)
 * rather than pasting a provider token tm8 would then have to hold.
 *
 * Suffix matching is deliberate — `mcp.notion.com` and a regional
 * `eu.mcp.notion.com` are the same provider — and the suffix always starts at
 * a label boundary, so `notion.com.evil.test` does not match.
 */
const OAUTH_DIRECTORY: ReadonlyArray<{ provider: string; hosts: readonly string[] }> = [
  { provider: 'Slack', hosts: ['slack.com'] },
  { provider: 'Notion', hosts: ['notion.com', 'notion.so'] },
  { provider: 'Figma', hosts: ['figma.com'] },
  { provider: 'Linear', hosts: ['linear.app'] },
  { provider: 'GitHub', hosts: ['githubcopilot.com', 'github.com'] },
  { provider: 'Atlassian', hosts: ['atlassian.com'] },
  { provider: 'Sentry', hosts: ['sentry.dev', 'sentry.io'] },
  { provider: 'Asana', hosts: ['asana.com'] },
  { provider: 'Stripe', hosts: ['stripe.com'] },
  { provider: 'Intercom', hosts: ['intercom.com'] },
];

function providerFor(hostname: string): string | undefined {
  const host = hostname.toLowerCase();
  for (const entry of OAUTH_DIRECTORY) {
    for (const candidate of entry.hosts) {
      if (host === candidate || host.endsWith(`.${candidate}`)) return entry.provider;
    }
  }
  return undefined;
}

/** `${SLACK_TOKEN}`, `$SLACK_TOKEN` — an expansion, so there is no value to carry. */
const PLACEHOLDER = /^\$\{[^}]{1,128}\}$|^\$[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names that denote a credential. Used only to CHOOSE which slot to declare, never to decide what is sensitive. */
const CREDENTIALISH = /token|secret|key|password|passwd|credential|auth|cookie|session|bearer|pat\b/i;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Provider token shapes. A definition's `command`, `args` and `url` are
 * ordinary graph content that every Space member can read, so an argv or a URL
 * path carrying one of these is REFUSED rather than registered — unlike a
 * header or env value, there is no slot to move it into and no way to describe
 * it without storing it.
 *
 * Real configs do this constantly: `['-y', '@x/server', '--api-key', 'sk-…']`,
 * `'--token=ghp_…'`, docker `['-e', 'SLACK_BOT_TOKEN=xoxb-…']`.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{12,}$/,                 // OpenAI and look-alikes
  /^sk-ant-[A-Za-z0-9_-]{12,}$/,             // Anthropic
  /^(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}$/,// Stripe
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,            // GitHub classic
  /^github_pat_[A-Za-z0-9_]{20,}$/,          // GitHub fine-grained
  /^glpat-[A-Za-z0-9_-]{16,}$/,              // GitLab
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/,         // Slack bot/user/app
  /^xapp-[A-Za-z0-9-]{10,}$/,
  /^ntn_[A-Za-z0-9]{16,}$/,                  // Notion
  /^secret_[A-Za-z0-9]{16,}$/,               // Notion internal integration (legacy)
  /^figd_[A-Za-z0-9_-]{16,}$/,               // Figma
  /^lin_api_[A-Za-z0-9]{16,}$/,              // Linear
  /^AIza[A-Za-z0-9_-]{20,}$/,                // Google
  /^ya29\.[A-Za-z0-9_-]{16,}$/,
  /^npm_[A-Za-z0-9]{20,}$/,
  /^hf_[A-Za-z0-9]{16,}$/,
  /^dop_v1_[A-Za-z0-9]{32,}$/,               // DigitalOcean
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // a JWT
];

/**
 * The shape of a secret nobody labelled: long, mixed-case, with a digit, and
 * made only of token characters. A path, a package specifier, a URL and a flag
 * all carry `/`, `@`, `:` or a space and are excluded by the character class;
 * an all-caps env NAME (`GITHUB_PERSONAL_ACCESS_TOKEN`) has no lower case and
 * no digit, and a UUID has no upper case, so neither trips it.
 *
 * It is deliberately a REFUSAL and not a rewrite: a false positive costs the
 * member one edit and a clear message, while a miss puts a live token in the
 * graph.
 */
const HIGH_ENTROPY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9_\-+=.~]{28,}$/;

function isKnownTokenShape(value: string): boolean {
  return TOKEN_SHAPES.some(shape => shape.test(value));
}

function isFlag(part: string): boolean {
  return /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/.test(part);
}

/**
 * Where a literal credential sits in an argv, described WITHOUT its value, or
 * undefined when there is none. Checks the three shapes real configs use — a
 * credential-named flag followed by a value, `--flag=value` and `KEY=value` —
 * and then any bare argument that is shaped like a token.
 */
export function literalCredentialIn(parts: readonly string[]): string | undefined {
  for (const [index, part] of parts.entries()) {
    const equals = part.indexOf('=');
    if (equals > 0) {
      const key = part.slice(0, equals);
      const value = part.slice(equals + 1);
      const literal = value !== '' && !PLACEHOLDER.test(value);
      if (CREDENTIALISH.test(key) && literal) return `\`${key}=…\` holds a literal value`;
      if (literal && (isKnownTokenShape(value) || HIGH_ENTROPY.test(value))) return `\`${key}=…\` holds something shaped like a provider token`;
      continue;
    }
    if (isFlag(part)) {
      if (!CREDENTIALISH.test(part)) continue;
      const next = parts[index + 1];
      if (next !== undefined && next !== '' && !isFlag(next) && !PLACEHOLDER.test(next)) return `\`${part}\` is followed by a literal value`;
      continue;
    }
    if (isKnownTokenShape(part) || HIGH_ENTROPY.test(part)) return 'one argument is shaped like a provider token';
  }
  return undefined;
}

/** The same scan over a URL path: some servers put the key in a path segment. */
export function literalCredentialInPath(pathname: string): string | undefined {
  for (const segment of pathname.split('/')) {
    if (!segment) continue;
    const decoded = (() => { try { return decodeURIComponent(segment); } catch { return segment; } })();
    if (isKnownTokenShape(decoded) || HIGH_ENTROPY.test(decoded)) return 'a path segment is shaped like a provider token';
  }
  return undefined;
}

function isLoopbackOrPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  return false;
}

/**
 * tm8 connector names are `[a-zA-Z][a-zA-Z0-9_-]*`, at most 80, and `tm8` is
 * reserved. Harness names are freer (`github.copilot`, `@scope/server`), so
 * they are folded rather than rejected — a connector the member recognises by
 * name is the whole point of importing.
 */
function connectorName(sourceName: string, taken: Set<string>): string {
  let name = sourceName.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 80);
  if (!/^[a-zA-Z]/.test(name)) name = `mcp-${name}`.slice(0, 80);
  name = name.replace(/-+$/, '') || 'mcp-server';
  if (name.toLowerCase() === 'tm8') name = 'tm8-connector';
  let unique = name;
  for (let n = 2; taken.has(unique.toLowerCase()); n += 1) {
    const suffix = `-${n}`;
    unique = `${name.slice(0, 80 - suffix.length)}${suffix}`;
  }
  taken.add(unique.toLowerCase());
  return unique;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw);
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** One server, in the shape both config dialects reduce to before a definition is built. */
interface NormalizedEntry {
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  /** Header or env name → literal value, placeholder, or '' when only the NAME is declared. */
  secrets: Record<string, string>;
  /** Names the source declares without a value (Codex `bearer_token_env_var`, `env_http_headers`). */
  declaredOnly: string[];
  /** Header/env names carrying values that are not credentials — reported, never imported. */
  passthrough: string[];
  enabled: boolean;
  notes: string[];
}

function normalizeClaudeEntry(raw: Record<string, unknown>, notes: string[]): NormalizedEntry | string {
  const declaredType = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  const url = typeof raw.url === 'string' ? raw.url.trim() : undefined;
  const command = typeof raw.command === 'string' ? raw.command.trim() : undefined;
  const type = declaredType ?? (url ? 'http' : command ? 'stdio' : undefined);
  if (type === undefined) return 'neither a url nor a command';
  if (type === 'sse') {
    // Best effort, per the reuse design: tm8 has no sse transport, so the same
    // endpoint is registered as HTTP. Many sse endpoints answer streamable
    // HTTP at the same URL; the ones that do not fail the connector test
    // rather than silently half-working.
    notes.push('sse is registered as HTTP at the same URL — run `tm8 mcp server test` before relying on it');
  } else if (type !== 'http' && type !== 'stdio' && type !== 'http-stream' && type !== 'streamable-http') {
    return `unsupported type \`${type}\``;
  }
  const transport = type === 'stdio' ? 'stdio' : 'http';
  if (transport === 'http' && !url) return 'http transport without a url';
  if (transport === 'stdio' && !command) return 'stdio transport without a command';
  const slots = stringRecord(transport === 'http' ? raw.headers : raw.env) ?? {};
  return {
    transport,
    ...(transport === 'http' ? { url } : { command, args: stringList(raw.args) ?? [] }),
    secrets: slots,
    declaredOnly: [],
    passthrough: [],
    enabled: raw.disabled !== true && raw.enabled !== false,
    notes,
  };
}

function normalizeCodexEntry(raw: Record<string, unknown>, notes: string[]): NormalizedEntry | string {
  const url = typeof raw.url === 'string' ? raw.url.trim() : undefined;
  const command = typeof raw.command === 'string' ? raw.command.trim() : undefined;
  if (!url && !command) return 'neither a url nor a command';
  if (url && command) return 'both a url and a command';
  const declaredOnly: string[] = [];
  const secrets: Record<string, string> = {};
  if (url) {
    Object.assign(secrets, stringRecord(raw.http_headers) ?? {});
    // `env_http_headers` maps a header to the NAME of an env var Codex reads at
    // call time; `bearer_token_env_var` is the same idea for Authorization.
    // Neither holds a value, so both become declared slots with no secret.
    for (const header of Object.keys(stringRecord(raw.env_http_headers) ?? {})) {
      if (!(header in secrets)) { secrets[header] = ''; declaredOnly.push(header); }
    }
    if (typeof raw.bearer_token_env_var === 'string' && !('Authorization' in secrets)) {
      secrets.Authorization = '';
      declaredOnly.push('Authorization');
      notes.push(`Codex read this token from $${raw.bearer_token_env_var}; in tm8 it comes from your own connector credential`);
    }
  } else {
    Object.assign(secrets, stringRecord(raw.env) ?? {});
  }
  return {
    transport: url ? 'http' : 'stdio',
    ...(url ? { url } : { command, args: stringList(raw.args) ?? [] }),
    secrets,
    declaredOnly,
    passthrough: [],
    enabled: raw.enabled !== false,
    notes,
  };
}

/**
 * Choose the ONE slot tm8 can declare. The definition schema allows a single
 * secret slot per connector, so a config with several header or env values
 * gets its credential slot declared and the rest reported as dropped — a
 * connector that quietly carries three fewer headers than the member wrote is
 * worse than one that says so.
 */
function chooseSlot(entry: NormalizedEntry, valid: (name: string) => boolean): string | undefined {
  const names = Object.keys(entry.secrets).filter(valid);
  const authorization = names.find(name => name.toLowerCase() === 'authorization');
  if (authorization) return authorization;
  const credentialish = names.filter(name => CREDENTIALISH.test(name));
  if (credentialish.length) return credentialish[0];
  // A single declared slot is taken at face value even when its name says
  // nothing: `env = { NOTION_API = "..." }` is still the server's credential.
  return names.length === 1 ? names[0] : undefined;
}

function buildCandidate(
  entry: NormalizedEntry,
  sourceName: string,
  sourcePointer: string,
  format: McpImportFormat,
  options: McpImportOptions,
  taken: Set<string>,
): McpImportCandidate | McpImportProblem {
  const notes = entry.notes;
  const problem = (reason: string): McpImportProblem => ({ sourceName, sourcePointer, reason });
  const valid = entry.transport === 'http' ? (n: string) => HEADER_NAME.test(n) : (n: string) => ENV_NAME.test(n);
  for (const name of Object.keys(entry.secrets)) {
    if (!valid(name)) notes.push(`dropped \`${name}\`: not a legal ${entry.transport === 'http' ? 'header' : 'environment variable'} name`);
  }

  let provider: string | undefined;
  let allowPrivateNetwork = false;
  if (entry.transport === 'http') {
    let parsed: URL;
    try { parsed = new URL(entry.url as string); } catch { return problem(`\`${entry.url}\` is not a URL`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return problem(`unsupported scheme \`${parsed.protocol}\``);
    if (parsed.username || parsed.password) return problem('the URL embeds credentials — move them to a header and re-import');
    if (parsed.search) return problem('the URL carries a query string, which tm8 refuses in case it holds a token — move it to a header and re-import');
    if (parsed.hash) return problem('the URL carries a fragment');
    const inPath = literalCredentialInPath(parsed.pathname);
    if (inPath) return problem(`the URL carries a literal credential (${inPath}): move it to a header and re-import`);
    provider = providerFor(parsed.hostname);
    if (isLoopbackOrPrivate(parsed.hostname)) {
      allowPrivateNetwork = true;
      // The proxy dials from the tm8 server host, not the member's laptop, so a
      // desktop app bound to 127.0.0.1 is reachable only if the server runs there.
      notes.push('private address: the tm8 server dials this from its own host, not from your machine');
    }
  }

  if (entry.transport === 'stdio') {
    // A header or env value has a slot to move into; an argv does not, so this
    // is a refusal rather than a note. See `literalCredentialIn`.
    const inArgs = literalCredentialIn([entry.command as string, ...(entry.args ?? [])]);
    if (inArgs) return problem(`args carry a literal credential (${inArgs}): move it to env and re-import`);
  }

  const slot = chooseSlot(entry, valid);
  for (const name of Object.keys(entry.secrets)) {
    if (name === slot || !valid(name)) continue;
    notes.push(`dropped \`${name}\`: a tm8 connector declares one credential slot`);
  }

  const rawValue = slot === undefined ? '' : (entry.secrets[slot] ?? '');
  const declaredOnly = slot !== undefined && entry.declaredOnly.includes(slot);
  const literal = !declaredOnly && rawValue !== '' && !PLACEHOLDER.test(rawValue);
  if (slot !== undefined && !declaredOnly && rawValue !== '' && !literal) {
    notes.push(`\`${slot}\` was \`${rawValue}\` — tm8 does not expand your shell, so supply the value as a connector credential`);
  }

  // A known provider with no credential of its own becomes an OAuth connector;
  // one that already carries a token keeps working as an API key, and is told
  // that OAuth exists. Silently converting a working token connector into an
  // OAuth one would break an import the member expected to just work.
  const useOauth = entry.transport === 'http' && provider !== undefined && slot === undefined;
  if (provider !== undefined && !useOauth) {
    notes.push(`${provider} also speaks OAuth: delete the credential slot and re-register to connect it in tm8 instead`);
  }
  if (useOauth) notes.push(`${provider} connector: connect it in tm8 (\`tm8 mcp oauth begin <server-id>\`) — tm8 holds no token from this config`);

  // `Authorization` with no value of its own (Codex's `bearer_token_env_var`,
  // an `${EXPANSION}`) is a bearer slot: that is what the harness was sending.
  const prefix = literal
    ? (/^Bearer\s/i.test(rawValue) ? 'Bearer' : 'none')
    : (slot !== undefined && slot.toLowerCase() === 'authorization' ? 'Bearer' : 'none');
  const secretValue = literal ? (prefix === 'Bearer' ? rawValue.replace(/^Bearer\s+/i, '') : rawValue) : undefined;
  const auth = useOauth
    ? { type: 'oauth2' as const, scopes: [] }
    : slot === undefined
      ? { type: 'none' as const }
      : entry.transport === 'http'
        ? { type: 'api_key' as const, headerName: slot, prefix: prefix === 'Bearer' ? ('Bearer' as const) : ('none' as const) }
        : { type: 'api_key' as const, envKey: slot };

  const provenanceSource = options.sourceLabel ?? format;
  const draft = {
    name: connectorName(sourceName, taken),
    transport: entry.transport,
    ...(entry.transport === 'http'
      ? { url: entry.url }
      : { command: entry.command, args: entry.args ?? [], stdioTrusted: options.trustStdio === true }),
    envKeys: entry.transport === 'stdio' && slot !== undefined && !useOauth ? [slot] : [],
    headerKeys: entry.transport === 'http' && slot !== undefined && !useOauth ? [slot] : [],
    auth,
    provenance: `imported from ${provenanceSource} (${sourcePointer})`,
    approved: false,
    enabled: entry.enabled,
    allowPrivateNetwork,
  };
  const parsed = McpServerDefinitionSchema.safeParse(draft);
  if (!parsed.success) return problem(parsed.error.issues.map(issue => issue.message).join('; '));
  if (!entry.enabled) notes.push('disabled in the source config — registered disabled');
  return {
    definition: parsed.data,
    sourceName,
    sourcePointer,
    format,
    ...(secretValue !== undefined && slot !== undefined
      ? { secret: { slot: entry.transport === 'http' ? ('header' as const) : ('env' as const), key: slot, value: secretValue } }
      : {}),
    ...(provider !== undefined ? { oauthProvider: provider } : {}),
    requiresStdioTrust: entry.transport === 'stdio',
    notes,
  };
}

function serversTable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The `{ pointer, servers }` sections a config of this format contributes. */
function sectionsOf(format: McpImportFormat, config: unknown): Array<{ pointer: string; servers: Record<string, unknown> }> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new McpImportError('Expected an MCP configuration object.');
  }
  const root = config as Record<string, unknown>;
  const sections: Array<{ pointer: string; servers: Record<string, unknown> }> = [];
  if (format === 'codex') {
    const table = serversTable(root.mcp_servers);
    if (table) sections.push({ pointer: 'mcp_servers', servers: table });
    return sections;
  }
  const top = serversTable(root.mcpServers);
  if (top) sections.push({ pointer: 'mcpServers', servers: top });
  if (format === 'claude') {
    // `~/.claude.json` keeps a per-project block as well as the global one, and
    // the project ones are usually where a member's real connectors live.
    const projects = root.projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [path, project] of Object.entries(projects as Record<string, unknown>)) {
        const servers = project && typeof project === 'object' && !Array.isArray(project)
          ? serversTable((project as Record<string, unknown>).mcpServers)
          : undefined;
        if (servers) sections.push({ pointer: `projects[${JSON.stringify(path)}].mcpServers`, servers });
      }
    }
  }
  return sections;
}

/**
 * Translate one already-parsed config. `config` is the whole document: the
 * `~/.claude.json` object, the `.mcp.json` object, or the parsed
 * `config.toml` table (see `parseCodexMcpServers` for reading the text).
 */
export function translateMcpConfig(format: McpImportFormat, config: unknown, options: McpImportOptions = {}): McpImportResult {
  const sections = sectionsOf(format, config);
  if (!sections.length) {
    throw new McpImportError(format === 'codex'
      ? 'No [mcp_servers.*] tables in this Codex configuration.'
      : 'No mcpServers in this configuration.');
  }
  const candidates: McpImportCandidate[] = [];
  const problems: McpImportProblem[] = [];
  const taken = new Set<string>();
  for (const section of sections) {
    for (const [sourceName, raw] of Object.entries(section.servers)) {
      const sourcePointer = `${section.pointer}.${sourceName}`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        problems.push({ sourceName, sourcePointer, reason: 'not a server table' });
        continue;
      }
      const notes: string[] = [];
      const entry = format === 'codex'
        ? normalizeCodexEntry(raw as Record<string, unknown>, notes)
        : normalizeClaudeEntry(raw as Record<string, unknown>, notes);
      if (typeof entry === 'string') { problems.push({ sourceName, sourcePointer, reason: entry }); continue; }
      const built = buildCandidate(entry, sourceName, sourcePointer, format, options, taken);
      if ('definition' in built) candidates.push(built); else problems.push(built);
    }
  }
  return { candidates, problems };
}

/**
 * Which dialect a pasted or read config is, from the text alone.
 *
 * JSON answers `claude` rather than `mcp-json` on purpose: the Claude reading
 * is a superset (it also walks `projects[*].mcpServers`), and a `.mcp.json`
 * has no `projects` block for it to find. Anything else is treated as Codex
 * TOML, whose reader refuses what it cannot parse.
 */
export function detectMcpImportFormat(text: string): McpImportFormat {
  return text.trimStart().startsWith('{') ? 'claude' : 'codex';
}

/** Parse the text of a config file in `format` and translate it in one step. */
export function translateMcpConfigText(format: McpImportFormat, text: string, options: McpImportOptions = {}): McpImportResult {
  if (format === 'codex') return translateMcpConfig(format, { mcp_servers: parseCodexMcpServers(text) }, options);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new McpImportError('Enter valid JSON before importing.'); }
  return translateMcpConfig(format, parsed, options);
}

/**
 * The identity two configs agree on: the endpoint for HTTP, the argv for
 * stdio. Dedupe is by what a connector TALKS TO, not by its name, because the
 * same Slack server is `slack` in one member's config and `slack-mcp` in
 * another's.
 */
export function mcpImportKey(definition: McpServerDefinition): string {
  if (definition.transport === 'http') {
    const url = new URL(definition.url as string);
    const path = url.pathname.replace(/\/+$/, '');
    return `http ${url.protocol}//${url.host.toLowerCase()}${path}`;
  }
  return `stdio ${JSON.stringify([definition.command, ...(definition.args ?? [])])}`;
}

export interface McpImportPlanRow<Existing> {
  candidate: McpImportCandidate;
  /** The space server this candidate already duplicates, when one exists. */
  duplicateOf?: Existing;
  /** Set when an EARLIER candidate in the same import already covers this endpoint. */
  duplicateOfCandidate?: McpImportCandidate;
}

/** Match candidates against what the space already has, and against each other. */
export function planMcpImport<Existing extends { definition: McpServerDefinition }>(
  candidates: readonly McpImportCandidate[],
  existing: readonly Existing[],
): Array<McpImportPlanRow<Existing>> {
  const byKey = new Map<string, Existing>();
  for (const server of existing) {
    try { byKey.set(mcpImportKey(server.definition), server); } catch { /* a stored definition tm8 can no longer parse cannot be matched */ }
  }
  const seen = new Map<string, McpImportCandidate>();
  return candidates.map(candidate => {
    const key = mcpImportKey(candidate.definition);
    const duplicateOf = byKey.get(key);
    const duplicateOfCandidate = seen.get(key);
    if (!seen.has(key)) seen.set(key, candidate);
    return {
      candidate,
      ...(duplicateOf ? { duplicateOf } : {}),
      ...(duplicateOfCandidate ? { duplicateOfCandidate } : {}),
    };
  });
}

/**
 * Rename a candidate whose connector name the Space already uses.
 *
 * Connector names are unique per Space ignoring case, and `mcp.servers.import`
 * is one transaction: without this, a single name clash — `slack` imported
 * into a Space that already has a `slack` pointing somewhere else — refuses
 * the whole batch. Call it with the names of the servers the Space has, on the
 * candidates that are actually going to be registered (a candidate already
 * matched as a duplicate must not consume a name).
 */
export function disambiguateMcpNames(
  candidates: readonly McpImportCandidate[],
  existingNames: readonly string[],
): McpImportCandidate[] {
  const taken = new Set(existingNames.map(name => name.toLowerCase()));
  return candidates.map(candidate => {
    const name = candidate.definition.name;
    if (!taken.has(name.toLowerCase())) {
      taken.add(name.toLowerCase());
      return candidate;
    }
    let renamed = name;
    for (let n = 2; taken.has(renamed.toLowerCase()); n += 1) {
      const suffix = `-${n}`;
      renamed = `${name.slice(0, 80 - suffix.length)}${suffix}`;
    }
    taken.add(renamed.toLowerCase());
    return {
      ...candidate,
      definition: McpServerDefinitionSchema.parse({ ...candidate.definition, name: renamed }),
      notes: [...candidate.notes, `renamed to \`${renamed}\`: this Space already has a connector called \`${name}\``],
    };
  });
}

/** The server-import operation's own ceiling (`McpServerImportInputSchema`). */
export const MCP_IMPORT_LIMIT = 32;

export type McpImportDecision = 'register' | 'duplicate' | 'needs_trust' | 'over_limit';

export interface McpImportDecisionRow {
  /** For `register`, the candidate AFTER any rename; otherwise the candidate as translated. */
  candidate: McpImportCandidate;
  decision: McpImportDecision;
  /** Why it is not being registered, in the member's words. Absent for `register`. */
  reason?: string;
}

/**
 * Decide what an import actually registers — ONE implementation, because the
 * CLI and the UI's import box must not drift. It applies, in order: dedupe
 * against the Space and against earlier candidates in the same config, the
 * stdio trust gate, the per-import ceiling, and then renames whatever survives
 * around names the Space already uses.
 *
 * Nothing here REFUSES an import: a duplicate, an untrusted local command and
 * an over-limit row are all reported and skipped, so one unusable entry in a
 * member's config never costs them the rest of it. Only the translator refuses,
 * and only for a config it cannot represent without storing a secret.
 */
export function selectMcpImports(
  candidates: readonly McpImportCandidate[],
  existing: readonly { id: string; definition: McpServerDefinition }[],
  options: { trustStdio: boolean; limit?: number },
): McpImportDecisionRow[] {
  const limit = options.limit ?? MCP_IMPORT_LIMIT;
  const rows: McpImportDecisionRow[] = [];
  /** Index in `rows` of each registerable candidate, so a rename lands back in place. */
  const registerRow: number[] = [];
  const register: McpImportCandidate[] = [];
  for (const row of planMcpImport(candidates, existing)) {
    const { candidate } = row;
    if (row.duplicateOf) {
      rows.push({ candidate, decision: 'duplicate', reason: `already registered as ${row.duplicateOf.definition.name} (${row.duplicateOf.id})` });
      continue;
    }
    if (row.duplicateOfCandidate) {
      rows.push({ candidate, decision: 'duplicate', reason: `same endpoint as ${row.duplicateOfCandidate.sourceName} earlier in this configuration` });
      continue;
    }
    if (candidate.requiresStdioTrust && !options.trustStdio) {
      rows.push({ candidate, decision: 'needs_trust', reason: 'runs a local command: it is registered only with explicit code trust' });
      continue;
    }
    if (register.length >= limit) {
      rows.push({ candidate, decision: 'over_limit', reason: `more than ${limit} new connectors in one import` });
      continue;
    }
    registerRow.push(rows.length);
    register.push(candidate);
    rows.push({ candidate, decision: 'register' });
  }
  disambiguateMcpNames(register, existing.map(server => server.definition.name)).forEach((renamed, index) => {
    (rows[registerRow[index] as number] as McpImportDecisionRow).candidate = renamed;
  });
  return rows;
}

// ── reading Codex's config.toml ─────────────────────────────────────────────

/**
 * A FOCUSED TOML reader, not a TOML library.
 *
 * `tm8 mcp import --from codex` reads `~/.codex/config.toml` in the CLI, and
 * the UI accepts the same text pasted into its import box — so the translator
 * needs a TOML reader that runs in a browser bundle whose only runtime
 * dependency is zod. (`@iarna/toml`, which the server and execution packages
 * use, is a Node dependency those two already carry; the contract package
 * carries none.) This reads the subset a config file actually uses — tables,
 * arrays of tables, dotted and quoted keys, all four string forms, numbers,
 * booleans, arrays and inline tables — and REFUSES what it does not
 * understand instead of guessing, because a mis-read connector table is a
 * connector the member never configured.
 *
 * `packages/execution/test/mcp-import-toml.test.ts` cross-checks it against
 * `@iarna/toml` on the same fixtures.
 */
export function parseCodexMcpServers(text: string): Record<string, unknown> {
  const table = readToml(text).mcp_servers;
  if (table === undefined) return {};
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new McpImportError('config.toml: `mcp_servers` is not a table');
  return table as Record<string, unknown>;
}

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
interface Cursor { text: string; i: number }

function fail(message: string): never {
  throw new McpImportError(`config.toml: ${message}`);
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t';

/** Spaces and comments, never a newline: a newline ends a key/value line. */
function skipSpace(c: Cursor): void {
  for (;;) {
    if (isSpace(c.text[c.i])) { c.i += 1; continue; }
    if (c.text[c.i] === '#') { while (c.i < c.text.length && c.text[c.i] !== '\n') c.i += 1; continue; }
    return;
  }
}

function skipBlank(c: Cursor): void {
  for (;;) {
    skipSpace(c);
    if (c.text[c.i] === '\n' || c.text[c.i] === '\r') { c.i += 1; continue; }
    return;
  }
}

function readEscape(c: Cursor, multiline: boolean): string {
  c.i += 1;
  const ch = c.text[c.i];
  if (ch === undefined) fail('string ends in a backslash');
  if (multiline && (isSpace(ch) || ch === '\n' || ch === '\r')) {
    let j = c.i;
    while (isSpace(c.text[j]) || c.text[j] === '\r') j += 1;
    if (c.text[j] !== '\n') fail('invalid line-ending backslash');
    c.i = j + 1;
    while (isSpace(c.text[c.i]) || c.text[c.i] === '\n' || c.text[c.i] === '\r') c.i += 1;
    return '';
  }
  c.i += 1;
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case '"': return '"';
    case '\\': return '\\';
    case 'u': case 'U': {
      const width = ch === 'u' ? 4 : 8;
      const hex = c.text.slice(c.i, c.i + width);
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) fail('invalid unicode escape');
      c.i += width;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    default: return fail(`unsupported escape \\${ch}`);
  }
}

function readBasicString(c: Cursor): string {
  if (c.text.startsWith('"""', c.i)) {
    c.i += 3;
    if (c.text[c.i] === '\n') c.i += 1;
    else if (c.text.startsWith('\r\n', c.i)) c.i += 2;
    let out = '';
    for (;;) {
      if (c.i >= c.text.length) fail('unterminated multi-line string');
      if (c.text.startsWith('"""', c.i)) {
        c.i += 3;
        // Up to two further quotes belong to the CONTENT, which (being at its
        // end) is the same as appending them to what has been read.
        while (c.text[c.i] === '"') { out += '"'; c.i += 1; }
        return out;
      }
      if (c.text[c.i] === '\\') { out += readEscape(c, true); continue; }
      out += c.text[c.i];
      c.i += 1;
    }
  }
  c.i += 1;
  let out = '';
  for (;;) {
    const ch = c.text[c.i];
    if (ch === undefined || ch === '\n') fail('unterminated string');
    if (ch === '"') { c.i += 1; return out; }
    if (ch === '\\') { out += readEscape(c, false); continue; }
    out += ch;
    c.i += 1;
  }
}

function readLiteralString(c: Cursor): string {
  if (c.text.startsWith("'''", c.i)) {
    c.i += 3;
    if (c.text[c.i] === '\n') c.i += 1;
    else if (c.text.startsWith('\r\n', c.i)) c.i += 2;
    const end = c.text.indexOf("'''", c.i);
    if (end < 0) fail('unterminated multi-line literal string');
    let out = c.text.slice(c.i, end);
    c.i = end + 3;
    while (c.text[c.i] === "'") { out += "'"; c.i += 1; }
    return out;
  }
  c.i += 1;
  const end = c.text.indexOf("'", c.i);
  const newline = c.text.indexOf('\n', c.i);
  if (end < 0 || (newline >= 0 && newline < end)) fail('unterminated literal string');
  const out = c.text.slice(c.i, end);
  c.i = end + 1;
  return out;
}

function readKeyPart(c: Cursor): string {
  const ch = c.text[c.i];
  if (ch === '"') return readBasicString(c);
  if (ch === "'") return readLiteralString(c);
  let out = '';
  while (c.i < c.text.length && BARE_KEY.test(c.text[c.i] as string)) { out += c.text[c.i]; c.i += 1; }
  if (!out) fail(`expected a key at offset ${c.i}`);
  return out;
}

function readKeyPath(c: Cursor): string[] {
  const path = [readKeyPart(c)];
  for (;;) {
    skipSpace(c);
    if (c.text[c.i] !== '.') return path;
    c.i += 1;
    skipSpace(c);
    path.push(readKeyPart(c));
  }
}

function readArray(c: Cursor): TomlValue[] {
  c.i += 1;
  const out: TomlValue[] = [];
  for (;;) {
    skipBlank(c);
    if (c.text[c.i] === ']') { c.i += 1; return out; }
    if (c.i >= c.text.length) fail('unterminated array');
    out.push(readValue(c));
    skipBlank(c);
    if (c.text[c.i] === ',') { c.i += 1; continue; }
    skipBlank(c);
    if (c.text[c.i] === ']') { c.i += 1; return out; }
    fail('expected `,` or `]` in an array');
  }
}

function readInlineTable(c: Cursor): Record<string, TomlValue> {
  c.i += 1;
  const out: Record<string, TomlValue> = {};
  for (;;) {
    // TOML 1.0 forbids a newline inside an inline table; accepting one cannot
    // mis-read a valid file, and real config files contain them.
    skipBlank(c);
    if (c.text[c.i] === '}') { c.i += 1; return out; }
    if (c.i >= c.text.length) fail('unterminated inline table');
    const path = readKeyPath(c);
    skipSpace(c);
    if (c.text[c.i] !== '=') fail('expected `=` in an inline table');
    c.i += 1;
    assign(out, path, readValue(c));
    skipBlank(c);
    if (c.text[c.i] === ',') { c.i += 1; continue; }
    skipBlank(c);
    if (c.text[c.i] === '}') { c.i += 1; return out; }
    fail('expected `,` or `}` in an inline table');
  }
}

function readValue(c: Cursor): TomlValue {
  skipSpace(c);
  const ch = c.text[c.i];
  if (ch === undefined) fail('expected a value');
  if (ch === '"') return readBasicString(c);
  if (ch === "'") return readLiteralString(c);
  if (ch === '[') return readArray(c);
  if (ch === '{') return readInlineTable(c);
  let raw = '';
  while (c.i < c.text.length && !',]}#\n\r'.includes(c.text[c.i] as string)) { raw += c.text[c.i]; c.i += 1; }
  raw = raw.trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const digits = raw.replace(/_/g, '');
  if (/^[+-]?(0|[1-9][0-9]*)$/.test(digits)) return Number(digits);
  if (/^[+-]?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(digits)) return Number(digits);
  if (/^0[xob][0-9a-fA-F]+$/.test(digits)) return Number(digits);
  // A date-time is kept as its text: nothing under `mcp_servers` is a date,
  // and inventing a Date here would be a value this reader cannot compare.
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.+Z-]+)?$/.test(raw)) return raw;
  return fail(`unsupported value \`${raw.slice(0, 40)}\``);
}

function assign(root: Record<string, TomlValue>, path: readonly string[], value: TomlValue): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (next === undefined) {
      const created: Record<string, TomlValue> = {};
      node[key] = created;
      node = created;
    } else if (next && typeof next === 'object' && !Array.isArray(next)) {
      node = next as Record<string, TomlValue>;
    } else {
      fail(`\`${path.join('.')}\` redefines a value`);
    }
  }
  node[path[path.length - 1] as string] = value;
}

function openTable(root: Record<string, TomlValue>, path: readonly string[]): Record<string, TomlValue> {
  let node = root;
  for (const key of path) {
    let next: TomlValue | undefined = node[key];
    if (Array.isArray(next)) next = next[next.length - 1];
    if (next === undefined) {
      const created: Record<string, TomlValue> = {};
      node[key] = created;
      node = created;
    } else if (next && typeof next === 'object' && !Array.isArray(next)) {
      node = next as Record<string, TomlValue>;
    } else {
      fail(`\`${path.join('.')}\` is not a table`);
    }
  }
  return node;
}

function pushArrayTable(root: Record<string, TomlValue>, path: readonly string[]): Record<string, TomlValue> {
  const parent = openTable(root, path.slice(0, -1));
  const key = path[path.length - 1] as string;
  const existing = parent[key];
  if (existing !== undefined && !Array.isArray(existing)) fail(`\`${path.join('.')}\` is not an array of tables`);
  const list = (existing as TomlValue[] | undefined) ?? [];
  if (existing === undefined) parent[key] = list;
  const created: Record<string, TomlValue> = {};
  list.push(created);
  return created;
}

function readToml(text: string): Record<string, TomlValue> {
  const c: Cursor = { text: text.replace(/^﻿/, ''), i: 0 };
  const root: Record<string, TomlValue> = {};
  let table = root;
  for (;;) {
    skipBlank(c);
    if (c.i >= c.text.length) return root;
    if (c.text[c.i] === '[') {
      const arrayOfTables = c.text.startsWith('[[', c.i);
      c.i += arrayOfTables ? 2 : 1;
      skipSpace(c);
      const path = readKeyPath(c);
      skipSpace(c);
      const close = arrayOfTables ? ']]' : ']';
      if (!c.text.startsWith(close, c.i)) fail(`unterminated \`[${path.join('.')}\` header`);
      c.i += close.length;
      table = arrayOfTables ? pushArrayTable(root, path) : openTable(root, path);
      continue;
    }
    const path = readKeyPath(c);
    skipSpace(c);
    if (c.text[c.i] !== '=') fail(`expected \`=\` after \`${path.join('.')}\``);
    c.i += 1;
    assign(table, path, readValue(c));
  }
}
