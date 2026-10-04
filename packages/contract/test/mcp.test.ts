import { describe, expect, it } from 'vitest';
import { McpServerDefinitionSchema, McpSelectionsSchema, McpOAuthCallbackInputSchema, McpCredentialViewSchema, McpReadinessReasonSchema } from '../src/mcp.js';
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
