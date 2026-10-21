/**
 * The connector catalog is DATA, and these are the invariants that make it safe
 * to serve: every entry parses, every definition is inert, and the one id the
 * server joins on cannot drift from the entry that owns it.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_CATALOG, McpCatalogEntrySchema, McpCatalogListResultSchema, mcpCatalogEntry,
  McpServerDefinitionSchema, McpRequestedServerDefinitionSchema, mcpGateOpen, mcpServerKey,
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

  it('ships §8.2 and nothing it cannot connect', () => {
    // linear/github/atlassian are ABSENT on purpose (B15): the plan marks each
    // provider's dynamic client registration unverified, and a card whose
    // Connect always fails is worse than no card.
    expect(MCP_CATALOG.map((entry) => entry.id)).toEqual([
      'google.gmail', 'google.calendar', 'google.drive', 'notion', 'slack', 'figma',
    ]);
    for (const id of ['linear', 'github', 'atlassian']) expect(mcpCatalogEntry(id)).toBeUndefined();
    expect(mcpCatalogEntry('notion')?.title).toBe('Notion');
  });

  it('serves the three Google cards as first-party and not yet available', () => {
    const google = MCP_CATALOG.filter((entry) => entry.id.startsWith('google.'));
    expect(google).toHaveLength(3);
    for (const entry of google) {
      expect(entry.kind).toBe('first_party');
      // Announced, not connectable: tm8 hosts these itself and that host plus
      // its Google OAuth path land with t-google-first-party, which flips this.
      expect(entry.available).toBe(false);
      // AND THEREFORE NO DEFINITION. An entry with no provider endpoint must
      // not carry an invented URL that an admin could approve and the proxy
      // could then fetch.
      expect(entry.definition).toBeUndefined();
      expect(entry.requirement).toMatch(/Coming soon/);
    }
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
    expect(slack.clientSecretEnv).toBe('TM8_MCP_CLIENT_SECRET_SLACK');
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
    expect(ok({ catalogId: 'notion' })).toBe(true);
    expect(ok({ provenance: 'our internal docs server' })).toBe(true);
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
});
