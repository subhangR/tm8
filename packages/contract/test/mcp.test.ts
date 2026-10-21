import { describe, expect, it } from 'vitest';
import { McpServerDefinitionSchema, McpSelectionsSchema, McpOAuthCallbackInputSchema, McpCredentialViewSchema, McpReadinessReasonSchema,
  MCP_RESERVED_SERVER_KEYS, assignMcpServerKeys, mcpServerKey } from '../src/mcp.js';
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

  it('truncates an over-long key to the shape a tool prefix admits, and still separates the two', () => {
    // `name` admits 80 characters; a serverKey admits 64. Two names that differ
    // only past the cut are distinct in the database and must stay distinct here.
    const stem = 'a'.repeat(70);
    const assigned = keys([{ serverId: id(1), serverKey: `${stem}b` }, { serverId: id(2), serverKey: `${stem}c` }]);
    expect(assigned[0]).toBe('a'.repeat(64));
    expect(assigned[1]).toBe(`${'a'.repeat(61)}_2`);
    for (const key of assigned) expect(key.length).toBeLessThanOrEqual(64);
  });

  it('rejects a malformed key rather than passing it into argv', () => {
    expect(keys([{ serverId: id(1), serverKey: 'has spaces' }]))
      .toEqual(['connector_00000000000040008000000000000001']);
    expect(keys([{ serverId: id(1), serverKey: '2fast' }]))
      .toEqual(['connector_00000000000040008000000000000001']);
  });
});
