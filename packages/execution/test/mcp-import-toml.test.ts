/**
 * Cross-check the contract package's focused Codex TOML reader against a real
 * TOML parser.
 *
 * `parseCodexMcpServers` exists because `tm8 mcp import --from codex` and the
 * UI's import box share one translator, and the UI is a browser bundle that
 * cannot carry `@iarna/toml`. A hand-written reader is only trustworthy if
 * something keeps it honest, and this package already depends on both halves:
 * the contract, and the `@iarna/toml` that `src/spawn/mcp-home.ts` uses to
 * strip `[mcp_servers]` out of a copied Codex home. So the comparison lives
 * here rather than in either package alone.
 *
 * Only the `mcp_servers` subtree is compared: that is all the reader claims to
 * return, and the rest of a config.toml carries date-times the two represent
 * differently on purpose.
 */
import { expect, it } from 'vitest';
import { parse } from '@iarna/toml';
import { parseCodexMcpServers } from '@tm8/contract';

const FIXTURES: Array<[name: string, toml: string]> = [
  ['a stdio server with an env table', `
model = "gpt-5-codex"

[mcp_servers.notion]
command = "npx"
args = ["-y", "@notionhq/notion-mcp-server"]
env = { OPENAPI_MCP_HEADERS = "{\\"Authorization\\":\\"Bearer ntn_fixture\\"}" }
startup_timeout_sec = 20
`],
  ['a remote server with headers and a quoted table name', `
[mcp_servers."acme-reporting"]
url = "https://api.acme.test/mcp"
bearer_token_env_var = "ACME_TOKEN"
http_headers = { "X-Api-Key" = "fixture-key", "X-Tenant" = "acme" }
env_http_headers = { "X-Trace" = "TRACE_ID" }
`],
  ['sub-tables, dotted keys and an array of tables elsewhere', `
[[skills.config]]
path = "/srv/app/.codex/skills/deploy"
enabled = false

[[skills.config]]
path = "/srv/app/.codex/skills/review"

[mcp_servers.local]
command = "/usr/local/bin/legacy-mcp"
enabled = false
tool_timeout_sec = 12.5

[mcp_servers.local.env]
HOME_DIR = '/srv/app'
NESTED.KEY = "v"

[history]
persistence = "save-all"
`],
  ['every string form, comments and a multi-line array', `
[mcp_servers.strings]   # a trailing comment
basic = "a\\tb"
literal = 'c:\\\\windows\\\\path'
multi = """
first
second\\
  joined"""
multi_literal = '''
raw
lines'''
args = [
  "-y",          # why
  'literal-arg',
]
flag = true
negative = -3
exponent = 1e3
`],
  ['no connectors at all', `
model = "gpt-5-codex"

[tui]
notifications = true
`],
];

it.each(FIXTURES)('reads %s exactly as @iarna/toml does', (_name, toml) => {
  const reference = (parse(toml) as { mcp_servers?: unknown }).mcp_servers ?? {};
  expect(parseCodexMcpServers(toml)).toEqual(reference);
});

it('agrees with @iarna/toml that a table header inside a string is not a table', () => {
  const toml = [
    'notice = """',
    '[mcp_servers.injected]',
    'command = "rm"',
    '"""',
    '[mcp_servers.real]',
    'command = "npx"',
  ].join('\n');
  const reference = (parse(toml) as { mcp_servers: Record<string, unknown> }).mcp_servers;
  expect(Object.keys(reference)).toEqual(['real']);
  expect(parseCodexMcpServers(toml)).toEqual(reference);
});
