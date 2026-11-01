/**
 * The connector catalog is DATA, and these are the invariants that make it safe
 * to serve: every entry parses, every definition is inert, and the one id the
 * server joins on cannot drift from the entry that owns it.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_CATALOG, McpCatalogEntrySchema, McpCatalogListResultSchema, mcpCatalogEntry,
  McpServerDefinitionSchema, McpRequestedServerDefinitionSchema, mcpGateOpen, mcpServerKey, googleFirstPartyService,
} from '../src/index.js';

describe('the launch catalog', () => {
  it('parses whole, with unique ids and logo slugs', () => {
    expect(McpCatalogListResultSchema.parse({ items: MCP_CATALOG }).items).toHaveLength(MCP_CATALOG.length);
    const ids = MCP_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of MCP_CATALOG) {
      // A slug, never a URL: the UI maps it to a bundled icon, so a catalog
      // load adds no provider egress to a settings page.
      expect(entry.logo, entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(entry.logo, entry.id).not.toContain('/');
    }
  });

  it('includes the launch providers and an extensible catalog beyond them', () => {
    for (const id of ['github', 'figma', 'slack', 'notion', 'atlassian', 'linear']) {
      expect(mcpCatalogEntry(id)?.definition?.catalogId).toBe(id);
    }
    expect(mcpCatalogEntry('github')?.setup).toBe('registration');
    expect(mcpCatalogEntry('figma')?.setup).toBe('approval');
  });

  it('serves the three Google cards as first-party, at the host\'s own identity URL', () => {
    const google = MCP_CATALOG.filter((entry) => entry.id.startsWith('google.'));
    expect(google).toHaveLength(3);
    for (const entry of google) {
      expect(entry.kind).toBe('first_party');
      // tm8's in-process Google host serves these (#1323), so they are connectable.
      expect(entry.available).toBe(true);
      // The URL is GOOGLE_FIRST_PARTY's resource, the identity the host and the
      // SQL catalog (349) share; the scopes are the host's minimum, nothing more.
      const service = googleFirstPartyService(entry.id)!;
      expect(entry.definition).toMatchObject({ url: service.resource, firstParty: true, catalogId: entry.id });
      expect(entry.definition?.auth).toEqual({ type: 'oauth2', scopes: [...service.scopes] });
      expect(entry.requirement).toMatch(/TM8_GOOGLE_OAUTH_CLIENT_ID/);
    }
    // Sending email ships closed.
    expect(mcpCatalogEntry('google.gmail')?.definition?.gates).toEqual({ gmailSend: false });
  });

  it('keeps every remote definition inert, catalog-tagged and gate-closed', () => {
    for (const entry of MCP_CATALOG) {
      if (!entry.definition) continue;
      const definition = McpServerDefinitionSchema.parse(entry.definition);
      // Unapproved: choosing a catalog entry only PREFILLS the form, and an
      // admin still has to approve before anything resolves or is fetched.
      expect(definition.approved, entry.id).toBe(false);
      // The join the server and the Discover tab both use.
      expect(definition.catalogId, entry.id).toBe(entry.id);
      expect(definition.transport, entry.id).toBe('http');
      expect(new URL(definition.url!).protocol, entry.id).toBe('https:');
      // No literal secret ever rides a definition; only the NAME of a server
      // environment variable may, and only for a preregistered client.
      expect(JSON.stringify(definition)).not.toMatch(/secret"\s*:\s*"(?!TM8_MCP_CLIENT_SECRET_)/i);
      for (const gate of Object.keys(entry.gates ?? {})) {
        expect(mcpGateOpen(definition, gate), `${entry.id}:${gate}`).toBe(false);
      }
    }
  });

  it('refuses an entry whose definition contradicts it', () => {
    const notion = MCP_CATALOG.find((entry) => entry.id === 'notion')!;
    const broken = (over: Record<string, unknown>) =>
      McpCatalogEntrySchema.safeParse({ ...notion, ...over });
    // A definition tagged with another entry's id would orphan every connector
    // added from this card.
    expect(broken({ definition: { ...notion.definition!, catalogId: 'slack' } }).success).toBe(false);
    expect(broken({ definition: { ...notion.definition!, approved: true } }).success).toBe(false);
    // `available` without a definition is the one combination that cannot work:
    // there is nothing to add.
    expect(broken({ definition: undefined }).success).toBe(false);
    expect(broken({ kind: 'first_party' }).success).toBe(false);
    // A gate whose definition does not ship it closed would be on by default,
    // because `mcpGateOpen` reads an absent gate as open.
    expect(broken({ gates: { gmailSend: { label: 'Allow sending email', tools: ['send_message'] } } }).success).toBe(false);
  });

  it('carries a preregistered client secret variable on the ENTRY, never in the definition', () => {
    const slack = MCP_CATALOG.find((entry) => entry.id === 'slack')!;
    expect(slack.setup).toBe('registration');
    // Which is what keeps the prefill a VALID definition: the schema refuses a
    // secret variable with no client id, and the admin supplies the id.
    expect(McpServerDefinitionSchema.safeParse(slack.definition).success).toBe(true);
    for (const entry of MCP_CATALOG) {
      const auth = entry.definition?.auth;
      if (auth?.type === 'oauth2') expect(auth.clientSecretEnv, entry.id).toBeUndefined();
    }
  });

  it('gives every entry a server key the model can read', () => {
    for (const entry of MCP_CATALOG) {
      if (!entry.definition) continue;
      expect(mcpServerKey(entry.definition), entry.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('requests provider scopes needed for repository writes and conversation creation', () => {
    const github = mcpCatalogEntry('github')?.definition?.auth;
    const slack = mcpCatalogEntry('slack')?.definition?.auth;
    expect(github?.type).toBe('oauth2');
    expect(slack?.type).toBe('oauth2');
    if (github?.type !== 'oauth2' || slack?.type !== 'oauth2') throw new Error('OAuth provider missing');
    expect(github.scopes).toEqual(expect.arrayContaining(['repo', 'project', 'gist']));
    expect(slack.scopes).toEqual(expect.arrayContaining(['channels:write', 'groups:write', 'im:write', 'mpim:write']));
  });
});

describe('what a member may request', () => {
  const base = {
    name: 'internaldocs', transport: 'http' as const, url: 'https://docs.example.test/mcp',
    envKeys: [], headerKeys: [], auth: { type: 'oauth2' as const }, approved: false,
  };
  const ok = (over: Record<string, unknown> = {}) =>
    McpRequestedServerDefinitionSchema.safeParse({ ...base, ...over }).success;

  it('admits an inert https connector', () => {
    expect(ok()).toBe(true);
    // No `catalogId` and no `provenance` here any more: both are identity
    // claims a custom request may not make (B23), asserted below.
    expect(ok({ enabled: false })).toBe(true);
  });

  it('refuses everything only an administrator may set', () => {
    expect(ok({ approved: true })).toBe(false);
    expect(ok({ url: 'http://docs.example.test/mcp' })).toBe(false);
    expect(ok({ transport: 'stdio', command: '/bin/echo', url: undefined })).toBe(false);
    // A member must not name a server environment secret for an admin to
    // approve by eye; an admin sets it after approval.
    expect(ok({ auth: { type: 'oauth2', clientId: 'abc', clientSecretEnv: 'TM8_MCP_CLIENT_SECRET_SLACK' } })).toBe(false);
    for (const flag of ['stdioTrusted', 'allowPrivateNetwork', 'defaultOn', 'allowExternalClients', 'firstParty']) {
      expect(ok({ [flag]: true }), flag).toBe(false);
      expect(ok({ [flag]: false }), `${flag} (false is still a decision)`).toBe(false);
    }
    expect(ok({ gates: { send: false } })).toBe(false);
  });

  it('refuses a custom request that claims a catalog identity', () => {
    // B23. All three are claims about WHO a connector is rather than how it is
    // configured: the provider's face in Discover, the tool prefix the model
    // reads, and the line an administrator reads before approving. A catalog
    // request names its entry on the REQUEST and the server supplies the
    // definition, so a member never pairs a provider's name with their own URL.
    expect(ok({ catalogId: 'notion' })).toBe(false);
    expect(ok({ serverKey: 'notion' })).toBe(false);
    expect(ok({ provenance: 'Notion remote MCP server (official).' })).toBe(false);
  });

  it('answers a malformed URL with a validation failure, never a thrown TypeError', () => {
    // The refinement used to call `new URL(value.url!)` after `.url()` had
    // already failed, so a bad URL escaped as a TypeError — a 500 about input
    // that was the caller's to fix (lead review, finding 4).
    for (const url of ['not-a-url', '', 'https://user:pass@docs.example.test/mcp']) {
      expect(() => McpRequestedServerDefinitionSchema.safeParse({ ...base, url })).not.toThrow();
      expect(McpRequestedServerDefinitionSchema.safeParse({ ...base, url }).success, url).toBe(false);
    }
    // An http-transport definition with NO url at all reaches the same
    // refinement, and must not construct a URL from undefined.
    const { url: _dropped, ...noUrl } = base;
    expect(() => McpRequestedServerDefinitionSchema.safeParse(noUrl)).not.toThrow();
    expect(McpRequestedServerDefinitionSchema.safeParse(noUrl).success).toBe(false);
  });
});
