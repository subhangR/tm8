/**
 * The translator, against configs shaped like the ones members actually have.
 *
 * The load-bearing assertion in every case is the same one: a literal token
 * that was in the source config is NOT in any definition the translator
 * produces. A definition is graph content, and the graph never holds a secret.
 */
import { describe, expect, it } from 'vitest';
import {
  detectMcpImportFormat,
  disambiguateMcpNames,
  mcpImportKey,
  McpImportError,
  literalCredentialIn,
  literalCredentialInPath,
  parseCodexMcpServers,
  planMcpImport,
  selectMcpImports,
  translateMcpConfig,
  translateMcpConfigText,
  type McpImportCandidate,
} from '../src/mcp-import.js';
import { McpServerDefinitionSchema, type McpServerDefinition } from '../src/mcp.js';

const NOTION_TOKEN = 'ntn_fixture_4Hs9kLq';
const FIGMA_KEY = 'figd_fixture_7Zq';
const SLACK_BOT_TOKEN = 'xoxb-fixture-99';

/** A `~/.claude.json`, trimmed to the keys that matter and keeping the noise that does not. */
const CLAUDE_JSON = JSON.stringify({
  numStartups: 41,
  theme: 'dark',
  mcpServers: {
    slack: { type: 'http', url: 'https://mcp.slack.com/mcp' },
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { Authorization: `Bearer ${NOTION_TOKEN}` } },
    'figma-dev-mode-mcp-server': { type: 'sse', url: 'http://127.0.0.1:3845/sse' },
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/app'], env: {} },
    'acme.reporting': {
      type: 'http',
      url: 'https://api.acme.test/mcp',
      headers: { 'X-Api-Key': FIGMA_KEY, 'X-Tenant': 'acme' },
    },
  },
  projects: {
    '/srv/app': {
      allowedTools: [],
      mcpServers: {
        github: {
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
        },
      },
    },
    '/srv/other': { allowedTools: [] },
  },
});

/** A `~/.codex/config.toml`, with the unrelated tables a real one carries. */
const CODEX_TOML = `# codex configuration
model = "gpt-5-codex"
approval_policy = "on-request"

[model_providers.fixture]
name = "Fixture"
base_url = "https://api.fixture.test/v1"

[[skills.config]]
path = "/srv/app/.codex/skills/deploy"
enabled = false

[mcp_servers.notion]
command = "npx"
args = ["-y", "@notionhq/notion-mcp-server"]
env = { OPENAPI_MCP_HEADERS = "{\\"Authorization\\":\\"Bearer ${NOTION_TOKEN}\\"}" }
startup_timeout_sec = 20

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_API_KEY"

[mcp_servers."acme-reporting"]
url = "https://api.acme.test/mcp"
http_headers = { "X-Api-Key" = "${FIGMA_KEY}" }

[mcp_servers.disabled-one]
command = "/usr/local/bin/legacy-mcp"
enabled = false

[history]
persistence = "save-all"
`;

function candidate(candidates: readonly McpImportCandidate[], sourceName: string): McpImportCandidate {
  const found = candidates.find(c => c.sourceName === sourceName);
  if (!found) throw new Error(`no candidate for ${sourceName}: ${candidates.map(c => c.sourceName).join(', ')}`);
  return found;
}

describe('Claude configuration', () => {
  const result = translateMcpConfigText('claude', CLAUDE_JSON, { sourceLabel: '~/.claude.json', trustStdio: true });

  it('translates the global and per-project blocks together', () => {
    expect(result.problems).toEqual([]);
    expect(result.candidates.map(c => c.sourceName).sort()).toEqual(
      ['acme.reporting', 'figma-dev-mode-mcp-server', 'filesystem', 'github', 'notion', 'slack'],
    );
    expect(candidate(result.candidates, 'github').sourcePointer).toBe('projects["/srv/app"].mcpServers.github');
    for (const c of result.candidates) expect(McpServerDefinitionSchema.safeParse(c.definition).success).toBe(true);
  });

  it('keeps every literal token out of every definition', () => {
    const serialized = JSON.stringify(result.candidates.map(c => c.definition));
    for (const secret of [NOTION_TOKEN, FIGMA_KEY, SLACK_BOT_TOKEN]) expect(serialized).not.toContain(secret);
  });

  it('turns a bearer header into a declared slot and hands the value back out of band', () => {
    const notion = candidate(result.candidates, 'notion');
    expect(notion.definition).toMatchObject({
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
      headerKeys: ['Authorization'],
      auth: { type: 'api_key', headerName: 'Authorization', prefix: 'Bearer' },
      approved: false,
    });
    // The prefix is stripped: the credential is the token, and tm8 re-adds `Bearer `.
    expect(notion.secret).toEqual({ slot: 'header', key: 'Authorization', value: NOTION_TOKEN });
    expect(notion.oauthProvider).toBe('Notion');
    expect(notion.notes.join(' ')).toContain('Notion also speaks OAuth');
  });

  it('maps a known OAuth host with no credential of its own to an OAuth connector', () => {
    const slack = candidate(result.candidates, 'slack');
    expect(slack.definition.auth).toEqual({ type: 'oauth2', scopes: [] });
    expect(slack.definition.headerKeys).toEqual([]);
    expect(slack.secret).toBeUndefined();
    expect(slack.oauthProvider).toBe('Slack');
    expect(slack.notes.join(' ')).toContain('connect it in tm8');
  });

  it('registers sse at the same URL and flags a private address', () => {
    const figma = candidate(result.candidates, 'figma-dev-mode-mcp-server');
    expect(figma.definition).toMatchObject({ transport: 'http', url: 'http://127.0.0.1:3845/sse', allowPrivateNetwork: true });
    expect(figma.notes.join(' ')).toContain('sse is registered as HTTP');
    expect(figma.notes.join(' ')).toContain('dials this from its own host');
  });

  it('declares one credential header and says which others it dropped', () => {
    const acme = candidate(result.candidates, 'acme.reporting');
    expect(acme.definition.name).toBe('acme-reporting');
    expect(acme.definition.headerKeys).toEqual(['X-Api-Key']);
    expect(acme.definition.auth).toEqual({ type: 'api_key', headerName: 'X-Api-Key', prefix: 'none' });
    expect(acme.secret).toEqual({ slot: 'header', key: 'X-Api-Key', value: FIGMA_KEY });
    expect(acme.notes.join(' ')).toContain('dropped `X-Tenant`');
  });

  it('carries a stdio command verbatim and marks it as code that needs trust', () => {
    const filesystem = candidate(result.candidates, 'filesystem');
    expect(filesystem.definition).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/app'],
      stdioTrusted: true,
      auth: { type: 'none' },
    });
    expect(filesystem.requiresStdioTrust).toBe(true);
    expect(candidate(
      translateMcpConfigText('claude', CLAUDE_JSON).candidates, 'filesystem',
    ).definition.stdioTrusted).toBe(false);
  });

  it('declares a shell-expansion env slot without inventing a value for it', () => {
    const github = candidate(result.candidates, 'github');
    expect(github.definition.envKeys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(github.definition.auth).toEqual({ type: 'api_key', envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN' });
    expect(github.secret).toBeUndefined();
    expect(github.notes.join(' ')).toContain('does not expand your shell');
  });

  it('reads a project .mcp.json through the same entry point', () => {
    const result = translateMcpConfigText('mcp-json', JSON.stringify({
      mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
    }), { sourceLabel: '.mcp.json' });
    expect(result.candidates[0]?.definition.provenance).toBe('imported from .mcp.json (mcpServers.linear)');
    expect(result.candidates[0]?.definition.auth).toEqual({ type: 'oauth2', scopes: [] });
  });
});

describe('Codex configuration', () => {
  const result = translateMcpConfigText('codex', CODEX_TOML, { sourceLabel: '~/.codex/config.toml', trustStdio: true });

  it('reads only the mcp_servers tables out of a full config.toml', () => {
    expect(result.problems).toEqual([]);
    expect(result.candidates.map(c => c.sourceName)).toEqual(['notion', 'linear', 'acme-reporting', 'disabled-one']);
  });

  it('keeps every literal token out of every definition', () => {
    const serialized = JSON.stringify(result.candidates.map(c => c.definition));
    for (const secret of [NOTION_TOKEN, FIGMA_KEY]) expect(serialized).not.toContain(secret);
  });

  it('declares the stdio env slot that carried the token', () => {
    const notion = candidate(result.candidates, 'notion');
    expect(notion.definition).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      envKeys: ['OPENAPI_MCP_HEADERS'],
      auth: { type: 'api_key', envKey: 'OPENAPI_MCP_HEADERS' },
    });
    expect(notion.secret?.value).toContain(NOTION_TOKEN);
  });

  it('turns bearer_token_env_var into a declared header with no value', () => {
    const linear = candidate(result.candidates, 'linear');
    expect(linear.definition).toMatchObject({
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headerKeys: ['Authorization'],
      auth: { type: 'api_key', headerName: 'Authorization', prefix: 'Bearer' },
    });
    expect(linear.secret).toBeUndefined();
    expect(linear.notes.join(' ')).toContain('$LINEAR_API_KEY');
  });

  it('carries http_headers and the source’s disabled state', () => {
    expect(candidate(result.candidates, 'acme-reporting').secret).toEqual({ slot: 'header', key: 'X-Api-Key', value: FIGMA_KEY });
    const disabled = candidate(result.candidates, 'disabled-one');
    expect(disabled.definition.enabled).toBe(false);
    expect(disabled.notes.join(' ')).toContain('registered disabled');
  });
});

describe('refusals and problems', () => {
  const translate = (servers: Record<string, unknown>) => translateMcpConfig('claude', { mcpServers: servers });

  it('names a server it cannot represent instead of dropping it silently', () => {
    expect(translate({ q: { type: 'http', url: 'https://api.test/mcp?token=abc' } }).problems[0]?.reason)
      .toContain('query string');
    expect(translate({ c: { type: 'http', url: 'https://u:p@api.test/mcp' } }).problems[0]?.reason)
      .toContain('embeds credentials');
    expect(translate({ w: { type: 'websocket', url: 'wss://api.test/mcp' } }).problems[0]?.reason)
      .toContain('unsupported type');
    expect(translate({ e: { description: 'nothing useful' } }).problems[0]?.reason)
      .toContain('neither a url nor a command');
    expect(translate({ s: 'not-a-table' }).problems[0]?.reason).toBe('not a server table');
  });

  it('refuses a document with no server table at all', () => {
    expect(() => translateMcpConfig('claude', { numStartups: 3 })).toThrow(McpImportError);
    expect(() => translateMcpConfigText('claude', 'not json')).toThrow(McpImportError);
    expect(() => translateMcpConfig('codex', { model: 'x' })).toThrow(McpImportError);
  });

  it('folds harness names into legal connector names and keeps them unique', () => {
    const result = translate({
      '@acme/server': { type: 'http', url: 'https://a.test/mcp' },
      '-acme-server': { type: 'http', url: 'https://b.test/mcp' },
      tm8: { type: 'http', url: 'https://c.test/mcp' },
      '123': { type: 'http', url: 'https://d.test/mcp' },
    });
    // Integer-like keys sort first in a JS object, which is why `123` leads.
    expect(result.candidates.map(c => c.definition.name)).toEqual(['mcp-123', 'acme-server', 'acme-server-2', 'tm8-connector']);
    for (const c of result.candidates) expect(McpServerDefinitionSchema.safeParse(c.definition).success).toBe(true);
  });

  it('drops a header or env name tm8 cannot declare', () => {
    const result = translate({ x: { type: 'http', url: 'https://a.test/mcp', headers: { 'X_Api_Key': 'v' } } });
    expect(result.candidates[0]?.definition.headerKeys).toEqual([]);
    expect(result.candidates[0]?.definition.auth).toEqual({ type: 'none' });
    expect(result.candidates[0]?.notes.join(' ')).toContain('not a legal header name');
  });

  it('matches a provider host only on a label boundary', () => {
    const result = translate({ evil: { type: 'http', url: 'https://notion.com.attacker.test/mcp' } });
    expect(result.candidates[0]?.oauthProvider).toBeUndefined();
    expect(result.candidates[0]?.definition.auth).toEqual({ type: 'none' });
  });
});

describe('a literal credential in an argv or a URL path', () => {
  const stdio = (args: string[]) => translateMcpConfig('claude', { mcpServers: { x: { command: 'npx', args } } });
  const http = (url: string) => translateMcpConfig('claude', { mcpServers: { x: { type: 'http', url } } });

  /** Every shape a real config has been seen to carry. Each one must REFUSE the connector. */
  const REFUSED: Array<[label: string, args: string[]]> = [
    ['a credential flag followed by a value', ['-y', '@acme/server', '--api-key', 'sk-fixture-abcdefghijklmnop']],
    ['a credential flag in = form', ['--token=ghp_fixtureFIXTURE0123456789abcd']],
    ['a fine-grained GitHub pat', ['--token=github_pat_11ABCDEFG0fixtureFIXTURE123456']],
    ['a docker env assignment', ['run', '-i', '--rm', '-e', 'SLACK_BOT_TOKEN=xoxb-9999-8888-fixtureFIXTURE', 'acme/mcp']],
    ['a bare Slack token', ['--flag', 'xoxp-1111-2222-fixtureFIXTUREfixture']],
    ['a bare Notion token', ['serve', 'ntn_FIXTUREfixture0123456789abcd']],
    ['a legacy Notion integration secret', ['serve', 'secret_FIXTUREfixture0123456789abcd']],
    ['a bare Figma token', ['serve', 'figd_FIXTUREfixture-0123456789abcd']],
    ['a long high-entropy argument nobody labelled', ['serve', 'Zk9Qw3Lm7Xp2Rt8Vb4Nc6Hy1Jd5Fg0As']],
    ['a credential flag whose name only hints at it', ['--auth', 'fixture-value']],
  ];
  it.each(REFUSED)('refuses %s', (_label, args) => {
    const result = stdio(args);
    expect(result.candidates).toEqual([]);
    expect(result.problems[0]?.reason).toContain('args carry a literal credential');
    expect(JSON.stringify(result)).not.toContain('sk-fixture');
  });

  it('leaves the shapes a normal config uses alone', () => {
    for (const args of [
      ['-y', '@modelcontextprotocol/server-filesystem', '/srv/app'],
      ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
      ['--api-key', '${ACME_KEY}'],
      ['--token=$ACME_TOKEN'],
      ['--port', '3845', '--verbose'],
      ['serve', '--config', '/etc/acme/mcp.json'],
      ['--token'],
      ['--token', '--verbose'],
    ]) {
      const result = stdio(args);
      expect(result.problems, args.join(' ')).toEqual([]);
      expect(result.candidates[0]?.definition.args).toEqual(args);
    }
  });

  it('refuses a token in the URL path and keeps an ordinary path', () => {
    expect(http('https://api.acme.test/mcp/sk-fixture-abcdefghijklmnopqrstu').problems[0]?.reason)
      .toContain('the URL carries a literal credential');
    expect(http('https://api.acme.test/Zk9Qw3Lm7Xp2Rt8Vb4Nc6Hy1Jd5Fg0As/mcp').problems[0]?.reason)
      .toContain('path segment is shaped like a provider token');
    expect(http('https://api.acme.test/v1/mcp/stream').problems).toEqual([]);
    // A uuid tenant segment is lower case with no upper case, so it is not a token shape.
    expect(http('https://api.acme.test/t/4f1c9b2e-7a3d-4c58-9f21-0ab8d6e5c7f3/mcp').problems).toEqual([]);
  });

  it('describes where the credential is without ever repeating it', () => {
    expect(literalCredentialIn(['--api-key', 'sk-fixture-abcdefghijklmnop'])).toBe('`--api-key` is followed by a literal value');
    expect(literalCredentialIn(['TOKEN=abc'])).toBe('`TOKEN=…` holds a literal value');
    expect(literalCredentialIn(['ghp_fixtureFIXTURE0123456789abcd'])).toBe('one argument is shaped like a provider token');
    expect(literalCredentialIn(['--api-key', 'sk-fixture-abcdefghijklmnop'])).not.toContain('sk-fixture');
    expect(literalCredentialInPath('/mcp/stream')).toBeUndefined();
  });
});

describe('planning against what the space already has', () => {
  const existing = (definition: Partial<McpServerDefinition>): { id: string; definition: McpServerDefinition } => ({
    id: 'existing',
    definition: McpServerDefinitionSchema.parse({
      name: 'already', transport: 'http', url: 'https://mcp.linear.app/mcp',
      envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true, ...definition,
    }),
  });

  it('dedupes by endpoint and argv, not by name', () => {
    const { candidates } = translateMcpConfig('claude', {
      mcpServers: {
        'linear-renamed': { type: 'http', url: 'https://MCP.Linear.app/mcp/' },
        fresh: { type: 'http', url: 'https://api.fresh.test/mcp' },
      },
    });
    const rows = planMcpImport(candidates, [existing({})]);
    expect(rows[0]?.duplicateOf?.id).toBe('existing');
    expect(rows[1]?.duplicateOf).toBeUndefined();
  });

  it('spots the same endpoint twice within one import', () => {
    const { candidates } = translateMcpConfig('claude', {
      mcpServers: { a: { type: 'http', url: 'https://api.test/mcp' } },
      projects: { '/srv': { mcpServers: { b: { type: 'http', url: 'https://api.test/mcp' } } } },
    });
    const rows = planMcpImport(candidates, []);
    expect(rows[0]?.duplicateOfCandidate).toBeUndefined();
    expect(rows[1]?.duplicateOfCandidate?.sourceName).toBe('a');
  });

  it('renames a candidate whose name the Space already uses', () => {
    const { candidates } = translateMcpConfig('claude', {
      mcpServers: {
        slack: { type: 'http', url: 'https://api.one.test/mcp' },
        fresh: { type: 'http', url: 'https://api.two.test/mcp' },
      },
    });
    const renamed = disambiguateMcpNames(candidates, ['Slack', 'slack-2']);
    expect(renamed.map(c => c.definition.name)).toEqual(['slack-3', 'fresh']);
    expect(renamed[0]?.notes.join(' ')).toContain('already has a connector called `slack`');
    expect(renamed[1]).toBe(candidates[1]);
  });

  it('keys stdio connectors on the whole argv', () => {
    const key = (args: string[]) => mcpImportKey(McpServerDefinitionSchema.parse({
      name: 'x', transport: 'stdio', command: 'npx', args, envKeys: [], headerKeys: [],
      auth: { type: 'none' }, approved: false, stdioTrusted: true,
    }));
    expect(key(['-y', 'a'])).toBe(key(['-y', 'a']));
    expect(key(['-y', 'a'])).not.toBe(key(['-y', 'b']));
  });
});

describe('one shared decision step for the CLI and the UI', () => {
  const config = {
    mcpServers: {
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      'linear-again': { type: 'http', url: 'https://mcp.linear.app/mcp/' },
      local: { command: 'npx', args: ['-y', '@acme/server'] },
      slack: { type: 'http', url: 'https://mcp.slack.com/mcp' },
    },
  };
  const existing = [{
    id: 'existing-id',
    definition: McpServerDefinitionSchema.parse({
      name: 'Slack', transport: 'http', url: 'https://slack.internal.test/mcp',
      envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: true,
    }),
  }];

  it('skips and reports rather than refusing, and renames around an existing name', () => {
    const { candidates } = translateMcpConfig('claude', config);
    const rows = selectMcpImports(candidates, existing, { trustStdio: false });
    expect(rows.map(row => [row.candidate.sourceName, row.decision])).toEqual([
      ['linear', 'register'],
      ['linear-again', 'duplicate'],
      ['local', 'needs_trust'],
      ['slack', 'register'],
    ]);
    expect(rows[3]?.candidate.definition.name).toBe('slack-2');
    expect(rows[2]?.reason).toContain('explicit code trust');
  });

  it('registers the local command once trust is given', () => {
    const { candidates } = translateMcpConfig('claude', config, { trustStdio: true });
    const rows = selectMcpImports(candidates, [], { trustStdio: true });
    expect(rows.filter(row => row.decision === 'register')).toHaveLength(3);
    expect(rows.find(row => row.candidate.sourceName === 'local')?.candidate.definition.stdioTrusted).toBe(true);
  });

  it('honours the per-import ceiling instead of letting the Server refuse the batch', () => {
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, { type: 'http', url: `https://api.${i}.test/mcp` }]));
    const { candidates } = translateMcpConfig('claude', { mcpServers: many });
    const rows = selectMcpImports(candidates, [], { trustStdio: false, limit: 3 });
    expect(rows.map(row => row.decision)).toEqual(['register', 'register', 'register', 'over_limit', 'over_limit']);
  });
});

describe('the Codex TOML reader', () => {
  it('reads the value forms a config file uses', () => {
    const servers = parseCodexMcpServers([
      '[mcp_servers.full]',
      'command = "npx"',
      'args = [',
      '  "-y",   # trailing comment',
      '  \'literal\',',
      ']',
      'env = { A = "1", B = \'two\' }',
      'startup_timeout_sec = 20',
      'float_thing = 1.5',
      'enabled = true',
      'quoted."dotted.key" = "v"',
      'multi = """',
      'first',
      'second\\',
      '  joined"""',
    ].join('\n'));
    expect(servers).toEqual({
      full: {
        command: 'npx', args: ['-y', 'literal'], env: { A: '1', B: 'two' },
        startup_timeout_sec: 20, float_thing: 1.5, enabled: true,
        quoted: { 'dotted.key': 'v' },
        multi: 'first\nsecondjoined',
      },
    });
  });

  it('never reads a table header out of a string body', () => {
    const servers = parseCodexMcpServers([
      'notice = """',
      '[mcp_servers.injected]',
      'command = "rm"',
      '"""',
      '[mcp_servers.real]',
      'command = "npx"',
    ].join('\n'));
    expect(Object.keys(servers)).toEqual(['real']);
  });

  it('returns nothing for a config with no connectors, and refuses what it cannot parse', () => {
    expect(parseCodexMcpServers('model = "gpt-5-codex"\n')).toEqual({});
    expect(parseCodexMcpServers('')).toEqual({});
    expect(() => parseCodexMcpServers('[mcp_servers.x]\ncommand = "unterminated\n')).toThrow(McpImportError);
    expect(() => parseCodexMcpServers('[mcp_servers.x\ncommand = "a"\n')).toThrow(McpImportError);
    expect(() => parseCodexMcpServers('mcp_servers = 3\n')).toThrow(McpImportError);
    expect(() => parseCodexMcpServers('[mcp_servers.x]\ncommand = <<nope>>\n')).toThrow(McpImportError);
  });

  it('keeps an array of tables and a later sub-table apart', () => {
    expect(parseCodexMcpServers([
      '[[skills.config]]',
      'path = "a"',
      '[[skills.config]]',
      'path = "b"',
      '[mcp_servers.x]',
      'command = "npx"',
      '[mcp_servers.x.env]',
      'TOKEN = "t"',
    ].join('\n'))).toEqual({ x: { command: 'npx', env: { TOKEN: 't' } } });
  });
});

it('detects the dialect from the text', () => {
  expect(detectMcpImportFormat('  {"mcpServers": {}}')).toBe('claude');
  expect(detectMcpImportFormat('[mcp_servers.x]\ncommand = "npx"')).toBe('codex');
});
