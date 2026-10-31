import { describe, expect, it } from 'vitest';
import { McpServerDefinitionSchema, McpSelectionsSchema, McpOAuthCallbackInputSchema, McpCredentialViewSchema, McpReadinessReasonSchema,
  McpToolSchema, McpTestResultSchema, MCP_RESERVED_SERVER_KEYS, assignMcpServerKeys, mcpServerKey } from '../src/mcp.js';
import { EntityStateSchema, ServerOnlyCredentialProviderNameSchema, SpaceCredentialProviderNameSchema } from '../src/schemas.js';
const definition = { name: 'fixture', transport: 'http', url: 'https://example.test/mcp', envKeys: [], headerKeys: [], auth: { type: 'none' }, approved: false };
describe('MCP metadata boundary', () => {
  it('admits a public definition and state', () => {
    expect(McpServerDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(EntityStateSchema.safeParse({kind:'mcp_server',definition}).success).toBe(true);
  });
  it('rejects literal secrets, reserved names and malformed transport combinations', () => {
    for (const patch of [{env:{TOKEN:'secret'}},{headers:{Authorization:'secret'}},{name:'tm8'},{command:'bash'},{url:'https://user:pass@example.test/'},{url:'https://example.test/?token=secret'},{auth:{type:'none',secret:'value'}}]) {
      expect(McpServerDefinitionSchema.safeParse({...definition,...patch}).success).toBe(false);
    }
  });
  it('requires declared API key destinations', () => {
    expect(McpServerDefinitionSchema.safeParse({...definition,auth:{type:'api_key',headerName:'Authorization'}}).success).toBe(false);
    expect(McpServerDefinitionSchema.safeParse({...definition,headerKeys:['Authorization'],auth:{type:'api_key',headerName:'Authorization'}}).success).toBe(true);
  });
  it('keeps mcp outside launching-provider selection', () => {
    expect(ServerOnlyCredentialProviderNameSchema.safeParse('mcp').success).toBe(true);
    expect(SpaceCredentialProviderNameSchema.safeParse('mcp').success).toBe(false);
  });
  it('preserves explicit empty selection and refuses duplicate servers', () => {
    expect(McpSelectionsSchema.parse([])).toEqual([]);
    const selection={serverId:'00000000-0000-4000-8000-000000000001'};
    expect(McpSelectionsSchema.safeParse([selection,selection]).success).toBe(false);
  });
  it('round-trips definition-change readiness as a public status', () => {
    expect(McpReadinessReasonSchema.parse('credential_definition_changed')).toBe('credential_definition_changed');
    const id = '00000000-0000-4000-8000-000000000001';
    expect(McpCredentialViewSchema.parse({ id, serverId:id, label:'x', authType:'api_key', visibility:'private', ownerId:id, sharedMemberIds:[], usable:false, manageable:true, revoked:false, reason:'credential_definition_changed' }).reason).toBe('credential_definition_changed');
  });
});

it('validates OAuth denial and issuer-bound success callbacks', () => {
  expect(McpOAuthCallbackInputSchema.safeParse({state:'state',code:'code',issuer:'https://issuer.test/tenant'}).success).toBe(true);
  expect(McpOAuthCallbackInputSchema.safeParse({state:'state',error:'access_denied'}).success).toBe(true);
  expect(McpOAuthCallbackInputSchema.safeParse({state:'state'}).success).toBe(false);
  expect(McpOAuthCallbackInputSchema.safeParse({state:'state',code:'code',error:'access_denied'}).success).toBe(false);
});

describe('readable connector server keys (§4.2, G8)', () => {
  const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const keys = (selections: { serverId: string; serverKey?: string }[]) =>
    [...assignMcpServerKeys(selections)].map(([, key]) => key);

  it('derives the effective key the way the database does', () => {
    expect(mcpServerKey({ name: 'Gmail' })).toBe('gmail');
    expect(mcpServerKey({ name: 'Linear-Team' })).toBe('linear_team');
    expect(mcpServerKey({ name: 'Gmail', serverKey: 'work_mail' })).toBe('work_mail');
    // A name may begin with a digit only after normalisation drops a letter;
    // the `c` guard keeps the key a legal tool prefix either way.
    expect(mcpServerKey({ name: 'a1-2' })).toBe('a1_2');
  });

  it('names bridge entries by server key, so the model reads mcp__gmail__…', () => {
    expect(keys([{ serverId: id(1), serverKey: 'gmail' }, { serverId: id(2), serverKey: 'figma' }]))
      .toEqual(['gmail', 'figma']);
  });

  it('keeps the opaque name for a selection no resolver named', () => {
    expect(keys([{ serverId: id(1) }])).toEqual(['connector_00000000000040008000000000000001']);
  });

  it('resolves a collision by ascending serverId, not by selection order', () => {
    const a = { serverId: id(1), serverKey: 'gmail' }, b = { serverId: id(2), serverKey: 'gmail' };
    const forwards = assignMcpServerKeys([a, b]), backwards = assignMcpServerKeys([b, a]);
    expect(forwards.get(id(1))).toBe('gmail');
    expect(forwards.get(id(2))).toBe('gmail_2');
    expect([...backwards.entries()].sort()).toEqual([...forwards.entries()].sort());
  });

  it('never hands a loser a name another connector asked for', () => {
    const assigned = assignMcpServerKeys([
      { serverId: id(1), serverKey: 'gmail' },
      { serverId: id(2), serverKey: 'gmail_2' },
      { serverId: id(3), serverKey: 'gmail' },
    ]);
    expect(assigned.get(id(2))).toBe('gmail_2');
    expect(assigned.get(id(3))).toBe('gmail_3');
    expect(new Set(assigned.values()).size).toBe(3);
  });

  it('refuses to name a bridge entry tm8, which is the launcher’s own entry', () => {
    // A row written before migration 344 can still carry this effective key.
    expect(keys([{ serverId: id(1), serverKey: 'tm8' }]))
      .toEqual(['connector_00000000000040008000000000000001']);
    expect(MCP_RESERVED_SERVER_KEYS.has('tm8')).toBe(true);
  });

  it('truncates an over-long key to 32, and still separates two that differ past the cut', () => {
    // `name` admits 80 characters and normalises to a key of any length; the
    // prefix a tool name carries is `mcp__<key>__`, so the key is cut to 32.
    // Two names that differ only past the cut are distinct in the database and
    // must stay distinct here, which is the collision rule's job.
    const stem = 'a'.repeat(40);
    const assigned = keys([{ serverId: id(1), serverKey: `${stem}b` }, { serverId: id(2), serverKey: `${stem}c` }]);
    expect(assigned[0]).toBe('a'.repeat(32));
    expect(assigned[1]).toBe(`${'a'.repeat(29)}_2`);
    for (const key of assigned) {
      expect(key.length).toBeLessThanOrEqual(32);
      // `mcp__<key>__<tool>` must leave room for the provider's tool name
      // inside the clients' ~64-character limit.
      expect(`mcp__${key}__`.length).toBe(key.length + 7);
    }
  });

  it('never leaves a truncated key, or a collision stem, ending in an underscore', () => {
    // `__` is the field separator, so a cut that lands just after one must not
    // leave it there: `<stem>_` + `_2` would read as server `<stem>` with a
    // tool prefix of its own, and a bare trailing `_` fails the shape rule and
    // would cost the connector its readable name.
    //
    // The cut for a name is at 32 and the cut for a collision stem at 29, so
    // each case needs a key whose underscore sits exactly there.
    const atCut = `${'a'.repeat(31)}_bb`;
    expect(keys([{ serverId: id(1), serverKey: atCut }])).toEqual(['a'.repeat(31)]);

    const atStemCut = `${'b'.repeat(28)}_cccc`;
    const colliding = keys([{ serverId: id(1), serverKey: atStemCut }, { serverId: id(2), serverKey: atStemCut }]);
    // 33 characters, so the winner is itself cut to 32 first.
    expect(colliding).toEqual([`${'b'.repeat(28)}_ccc`, `${'b'.repeat(28)}_2`]);
    for (const key of colliding) {
      expect(key).not.toContain('__');
      expect(key.endsWith('_')).toBe(false);
    }
  });

  it('refuses a key that would forge a tool prefix, in Zod and at naming time', () => {
    // Claude Code splits `mcp__<server>__<tool>` on `__`, so `tm8__evil`
    // presents `mcp__tm8__evil__send`: tm8's own server with a tool called
    // `evil__send`, and `mcp__tm8__*` then denies every real tm8 tool.
    for (const serverKey of ['tm8__evil', 'gmail__x', 'tm8_', 'a_', '_a', 'Gmail', 'gm ail', '2fast', 'tm8',
      'a'.repeat(33)]) {
      expect(McpServerDefinitionSchema.safeParse({ ...definition, serverKey }).success).toBe(false);
    }
    for (const serverKey of ['gmail', 'linear_team', 'gmail_2', 'a', 'a'.repeat(32)]) {
      expect(McpServerDefinitionSchema.safeParse({ ...definition, serverKey }).success).toBe(true);
    }
    // A key STORED before all three rules agreed must not reach a launcher
    // either: it fails the naming test and takes the opaque name.
    expect(keys([{ serverId: id(1), serverKey: 'tm8__evil' }]))
      .toEqual(['connector_00000000000040008000000000000001']);
  });

  it('rejects a malformed key rather than passing it into argv', () => {
    for (const serverKey of ['has spaces', '2fast', 'bad__key', '_lead']) {
      expect(keys([{ serverId: id(1), serverKey }]))
        .toEqual(['connector_00000000000040008000000000000001']);
    }
  });
});

describe('a connector tool as a real MCP server lists it', () => {
  // Context7's tools/list, abridged: the 2025-06-18 `title` and `annotations`
  // fields made the strict schema refuse the whole connection test.
  const context7Tool = {
    name: 'resolve-library-id', title: 'Resolve Context7 Library ID', description: 'Resolves a package name.',
    inputSchema: { type: 'object', properties: { libraryName: { type: 'string' } }, required: ['libraryName'] },
    annotations: { readOnlyHint: true }, _meta: { vendor: 'x' },
  };
  it('accepts the spec-added fields and strips keys tm8 does not know', () => {
    const parsed = McpToolSchema.parse(context7Tool);
    expect(parsed).toMatchObject({ name: 'resolve-library-id', title: 'Resolve Context7 Library ID', annotations: { readOnlyHint: true } });
    expect('_meta' in parsed).toBe(false);
    expect(McpTestResultSchema.safeParse({ ready: true, reason: 'ready', tools: [context7Tool], checkedAt: new Date().toISOString() }).success).toBe(true);
  });
});
