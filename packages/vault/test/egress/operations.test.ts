import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createEgressExecutor, CONNECTORS, findConnector, vettedConnector, type ConnectorRegistry, type EgressExecutorOptions,
  type PinnedHttpsRequest, type PinnedHttpsResponse } from '../../src/egress/index.js';
import { catalogProblems, matchOperation, type ConnectorOperation } from '../../src/egress/operations.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { SecretMaterial } from '../../src/secret-material.js';
import { EgressRefusal, type ApiRequestBody, type ApiRequestSpec, type BrokerPolicy, type EgressRefusalCode, type HttpMethod } from '../../src/types.js';
import { zodNodes } from '../support/zod-walk.js';

// Independent review F02: a connector policy used to mean "the vendor's hosts minus a path deny
// list", so the owner's prefix decided everything else and any body went through. These tests
// pin the replacement: vetted operations with exact paths, query rules, strict body schemas and
// a header allowlist, and a refusal of multiplexer and method-override surfaces in both modes.
// Every value here is synthetic.

const fixtureKey = ['safe', 'fixture', 'value-1234567890'].join('-');
const ALL_METHODS: HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface Sent { method: string; url: string; headers: Record<string, string>; body: string | undefined }

function harness(options: EgressExecutorOptions = {}) {
  const sent: Sent[] = [];
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
  const transport = vi.fn(async (request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> => {
    sent.push({ method: request.method, url: request.url.href, headers: { ...request.headers }, body: request.body?.toString('utf8') });
    const stream = Readable.from([Buffer.from('{}')]);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: stream, close: vi.fn(() => { stream.destroy(); }) };
  });
  return { sent, resolve, transport, executor: createEgressExecutor({ resolve, transport, ...options }) };
}

/** A connector policy as the broker stores it, with every method and the owner's prefixes. */
function connectorPolicy(id: string, pathPrefixes: string[] = ['/']): BrokerPolicy {
  const connector = CONNECTORS[id]!;
  return { keyId: 'item', version: 1, mode: 'connector', connector: id, hosts: connector.hosts, methods: ALL_METHODS, pathPrefixes,
    maxRequestBytes: 65536, maxResponseBytes: 4096, injection: connector.injection };
}

const generic: BrokerPolicy = { keyId: 'item', version: 1, mode: 'generic', connector: null, hosts: ['api.example.com'], methods: ALL_METHODS,
  pathPrefixes: ['/'], maxRequestBytes: 65536, maxResponseBytes: 4096, injection: { kind: 'bearer' } };

const json = (value: unknown): ApiRequestBody => ({ kind: 'json', value });
const text = (value: string, contentType?: string): ApiRequestBody => contentType === undefined ? { kind: 'text', value } : { kind: 'text', value, contentType };
const form = (value: string, contentType = 'application/x-www-form-urlencoded'): ApiRequestBody => text(value, contentType);
const multipart = (disposition: string, value = 'x') => `--b\r\nContent-Disposition: form-data; ${disposition}\r\n\r\n${value}\r\n--b--\r\n`;

async function execute(policy: BrokerPolicy, request: ApiRequestSpec, options?: EgressExecutorOptions) {
  const h = harness(options);
  const key = SecretMaterial.fromUtf8(JSON.stringify({ key: fixtureKey }));
  try {
    const result = await h.executor.execute({ operationId: 'operation', policy, key, request, canaries: buildCanarySet([]) }).then(
      (outcome) => ({ status: outcome.status }),
      (error: unknown) => ({ refused: error instanceof EgressRefusal && error.message === `egress refused: ${error.code}` ? error.code : `unexpected ${String(error)}` }));
    return { ...h, result };
  } finally { key.dispose(); }
}

async function expectRefused(policy: BrokerPolicy, request: ApiRequestSpec, code: EgressRefusalCode, options?: EgressExecutorOptions) {
  const { result, resolve, transport } = await execute(policy, request, options);
  expect(result).toEqual({ refused: code });
  expect(resolve).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
}

async function expectSent(policy: BrokerPolicy, request: ApiRequestSpec, options?: EgressExecutorOptions): Promise<Sent> {
  const { result, sent } = await execute(policy, request, options);
  expect(result).toEqual({ status: 200 });
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

// The review reached GitHub's GraphQL endpoint through the github connector. A policy whose
// owner prefix covered /graphql forwarded any document, so a mutation went past the path deny
// list. Before this fix each request below was sent upstream. Now each is refused before DNS.
describe('F02 reviewer probe: free-form GraphQL through a connector is refused', () => {
  const mutation = 'mutation { addDeployKey(input: { repositoryId: "R_fixture", title: "probe", key: "fixture-public-key", readOnly: false }) { deployKey { id } } }';
  const requests: [string, ApiRequestSpec][] = [
    ['a JSON mutation', { method: 'POST', url: 'https://api.github.com/graphql', body: json({ query: mutation }) }],
    ['a JSON query with variables', { method: 'POST', url: 'https://api.github.com/graphql',
      body: json({ query: 'query($login: String!) { organization(login: $login) { id } }', variables: { login: 'fixture' } }) }],
    ['a GET query string', { method: 'GET', url: `https://api.github.com/graphql?query=${encodeURIComponent('{ viewer { login } }')}` }],
    ['an application/graphql body', { method: 'POST', url: 'https://api.github.com/graphql', body: text(mutation, 'application/graphql') }],
    ['a batched array', { method: 'POST', url: 'https://api.github.com/graphql', body: json([{ query: '{ viewer { login } }' }, { query: mutation }]) }],
  ];
  for (const prefix of ['/graphql', '/']) {
    it.each(requests)(`refuses %s under the owner prefix ${prefix}`, (_label, request) =>
      expectRefused(connectorPolicy('github', [prefix]), request, 'multiplexer_refused'));
  }
});

describe('vetted connector operations', () => {
  const allowed: [string, string, ApiRequestSpec][] = [
    ['github', 'the authenticated user', { method: 'GET', url: 'https://api.github.com/user' }],
    ['github', 'a repository with the documented headers', { method: 'GET', url: 'https://api.github.com/repos/octo-fixture/hello-world',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } }],
    // A parameter segment is data. An organization named graphql is not GitHub's GraphQL endpoint.
    ['github', 'a repository owned by an org named graphql', { method: 'GET', url: 'https://api.github.com/repos/graphql/graphql-js' }],
    ['github', 'a nested file', { method: 'GET', url: 'https://api.github.com/repos/octo-fixture/hello-world/contents/docs/guide/README.md?ref=main' }],
    ['github', 'filtered issues', { method: 'GET', url: 'https://api.github.com/repos/octo-fixture/hello-world/issues?state=open&per_page=50&labels=bug,docs' }],
    ['github', 'a new issue', { method: 'POST', url: 'https://api.github.com/repos/octo-fixture/hello-world/issues',
      body: json({ title: 'Fixture issue', body: 'Steps to reproduce', labels: ['bug'] }) }],
    ['github', 'an issue comment', { method: 'POST', url: 'https://api.github.com/repos/octo-fixture/hello-world/issues/7/comments', body: json({ body: 'Looks good' }) }],
    ['github', 'an issue search', { method: 'GET', url: `https://api.github.com/search/issues?q=${encodeURIComponent('repo:octo-fixture/hello-world is:open')}&per_page=10` }],
    ['openai', 'the model list', { method: 'GET', url: 'https://api.openai.com/v1/models' }],
    ['openai', 'embeddings', { method: 'POST', url: 'https://api.openai.com/v1/embeddings', body: json({ model: 'text-embedding-fixture', input: ['one', 'two'] }) }],
    ['openai', 'a chat completion with a function tool', { method: 'POST', url: 'https://api.openai.com/v1/chat/completions', body: json({
      model: 'gpt-fixture', messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }], store: false }) }],
    ['openai', 'an unstored response', { method: 'POST', url: 'https://api.openai.com/v1/responses', body: json({ model: 'gpt-fixture', input: 'Hello', store: false }) }],
    ['anthropic', 'a message with a custom tool', { method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: { 'anthropic-version': '2023-06-01' },
      body: json({ model: 'claude-fixture', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }],
        tools: [{ name: 'lookup', description: 'Look up a record', input_schema: { type: 'object' } }] }) }],
    ['anthropic', 'a token count', { method: 'POST', url: 'https://api.anthropic.com/v1/messages/count_tokens', headers: { 'anthropic-version': '2023-06-01' },
      body: json({ model: 'claude-fixture', messages: [{ role: 'user', content: 'Hello' }] }) }],
    ['anthropic', 'the model list', { method: 'GET', url: 'https://api.anthropic.com/v1/models?limit=20' }],
    ['stripe', 'customers by email', { method: 'GET', url: 'https://api.stripe.com/v1/customers?limit=10&email=fixture%40example.com' }],
    ['stripe', 'a new customer', { method: 'POST', url: 'https://api.stripe.com/v1/customers', headers: { 'idempotency-key': 'fixture-key-1' },
      body: form('name=Fixture+Customer&email=fixture%40example.com&metadata%5Bref%5D=a1', 'application/x-www-form-urlencoded; charset=utf-8') }],
    ['stripe', 'a price', { method: 'GET', url: 'https://api.stripe.com/v1/prices/price_Fixture123' }],
    ['slack', 'a message', { method: 'POST', url: 'https://slack.com/api/chat.postMessage', body: json({ channel: 'C0FIXTURE01', text: 'Hello' }) }],
    ['slack', 'channel history', { method: 'GET', url: 'https://slack.com/api/conversations.history?channel=C0FIXTURE01&limit=20' }],
    ['slack', 'a user', { method: 'GET', url: 'https://slack.com/api/users.info?user=U0FIXTURE01' }],
  ];
  it.each(allowed)('%s sends %s', async (id, _label, request) => {
    const sent = await expectSent(connectorPolicy(id), request);
    expect(sent.method).toBe(request.method);
    // The operation, not the agent, decides the content type.
    const expected = request.body === undefined ? undefined : request.body.kind === 'json' ? 'application/json' : 'application/x-www-form-urlencoded';
    expect(sent.headers['content-type']).toBe(expected);
    if (request.body?.kind === 'json') expect(JSON.parse(sent.body!)).toEqual(request.body.value);
  });

  it('sends the query and the form rebuilt from the checked pairs, not the agent text', async () => {
    const issues = await expectSent(connectorPolicy('github'), { method: 'GET',
      url: 'https://api.github.com/repos/octo-fixture/hello-world/issues?state=open&labels=bug,docs' });
    expect(issues.url).toBe('https://api.github.com/repos/octo-fixture/hello-world/issues?state=open&labels=bug%2Cdocs');
    const customer = await expectSent(connectorPolicy('stripe'), { method: 'POST', url: 'https://api.stripe.com/v1/customers',
      body: form('name=Fixture Customer&email=fixture@example.com&metadata[ref]=a1') });
    expect(customer.body).toBe('name=Fixture+Customer&email=fixture%40example.com&metadata%5Bref%5D=a1');
  });

  it('holds the rebuilt form to the request size limit', async () => {
    // `@` is one byte from the agent and three once rebuilt: the agent's 25 bytes fit a 25-byte limit, the 27 rebuilt do not.
    const request: ApiRequestSpec = { method: 'POST', url: 'https://api.stripe.com/v1/customers', body: form('email=fixture@example.com') };
    await expectSent({ ...connectorPolicy('stripe'), maxRequestBytes: 27 }, request);
    await expectRefused({ ...connectorPolicy('stripe'), maxRequestBytes: 25 }, request, 'body_too_large');
  });

  // `%33%C3` is one escape run that is not valid UTF-8, so the canary matcher reads the agent's text
  // raw and misses the decoy. The rebuilt form decodes `%33` to `3` and only `%C3` to U+FFFD, the
  // way an upstream would, so the decoy is plain in what would be sent and the second check finds it.
  it.each([['plainly', 'fixture-canary-ABCdef0123'], ['behind an escape run that is not UTF-8', 'fixture-canary-ABCdef012%33%C3']])(
    'still refuses a canary written %s in a connector form the broker rebuilds', async (_label, value) => {
      const canary = ['fixture', 'canary', 'ABCdef0123'].join('-');
      const h = harness();
      const key = SecretMaterial.fromUtf8(JSON.stringify({ key: fixtureKey }));
      try {
        await expect(h.executor.execute({ operationId: 'operation', policy: connectorPolicy('stripe'), key, canaries: buildCanarySet([canary]),
          request: { method: 'POST', url: 'https://api.stripe.com/v1/customers', body: form(`description=${value}`) } }))
          .rejects.toMatchObject({ code: 'canary_in_request' });
      } finally { key.dispose(); }
      expect(h.transport).not.toHaveBeenCalled();
    });

  // Some servers split pairs on `;` as well as `&`, so a `;` makes the pairs ambiguous. Refused, not re-encoded.
  it('refuses a semicolon in a connector query or form', async () => {
    await expectRefused(connectorPolicy('github'), { method: 'GET', url: 'https://api.github.com/search/issues?q=repo:octo-fixture/hello-world;per_page=100' },
      'request_schema_refused');
    await expectRefused(connectorPolicy('stripe'), { method: 'POST', url: 'https://api.stripe.com/v1/customers', body: form('name=Fixture;email=fixture@example.com') },
      'request_schema_refused');
  });

  it('every built-in connector covers its default prefixes with at least one operation', () => {
    for (const connector of Object.values(CONNECTORS)) {
      for (const prefix of connector.defaultPathPrefixes) {
        expect(connector.operations!.some((operation) => operation.path === prefix || operation.path.startsWith(`${prefix}/`)), `${connector.id} ${prefix}`).toBe(true);
      }
    }
  });
});

// The surfaces the review named. Each row is refused before DNS, whatever the owner's prefix.
type Surface = [id: string, surface: string, method: HttpMethod, path: string, body: ApiRequestBody | undefined, code: EgressRefusalCode, headers?: Record<string, string>];
const surfaces: Surface[] = [
  // GitHub: credentials
  ['github', 'credential: add an SSH key', 'POST', '/user/keys', json({ title: 'x', key: 'fixture-public-key' }), 'token_management_denied'],
  ['github', 'credential: add a deploy key', 'POST', '/repos/a/b/keys', json({ title: 'x', key: 'fixture-public-key', read_only: false }), 'token_management_denied'],
  ['github', 'credential: mint an installation token', 'POST', '/app/installations/1/access_tokens', undefined, 'token_management_denied'],
  ['github', 'credential: create an authorization', 'POST', '/authorizations', json({ scopes: ['repo'] }), 'token_management_denied'],
  ['github', 'credential: a runner registration token', 'POST', '/repos/a/b/actions/runners/registration-token', undefined, 'operation_not_allowed'],
  ['github', 'credential: the Actions secrets key', 'GET', '/repos/a/b/actions/secrets/public-key', undefined, 'token_management_denied'],
  // GitHub: grants
  ['github', 'grant: add a collaborator', 'PUT', '/repos/a/b/collaborators/someone', json({ permission: 'admin' }), 'token_management_denied'],
  ['github', 'grant: give a team admin', 'PUT', '/orgs/o/teams/t/repos/o/r', json({ permission: 'admin' }), 'operation_not_allowed'],
  ['github', 'grant: invite to the org', 'POST', '/orgs/o/invitations', json({ email: 'someone@example.com' }), 'token_management_denied'],
  ['github', 'grant: make a repository public', 'PATCH', '/repos/a/b', json({ private: false }), 'operation_not_allowed'],
  ['github', 'grant: transfer a repository', 'POST', '/repos/a/b/transfer', json({ new_owner: 'elsewhere' }), 'operation_not_allowed'],
  ['github', 'grant: remove branch protection', 'DELETE', '/repos/a/b/branches/main/protection', undefined, 'operation_not_allowed'],
  // GitHub: webhooks
  ['github', 'webhook: a repository hook', 'POST', '/repos/a/b/hooks', json({ config: { url: 'https://collector.example' } }), 'token_management_denied'],
  ['github', 'webhook: an org hook', 'POST', '/orgs/o/hooks', json({ name: 'web', config: { url: 'https://collector.example' } }), 'token_management_denied'],
  // Any GraphQL document is refused, so the mutation names here are only illustrative.
  ['github', 'webhook: through GraphQL', 'POST', '/graphql', json({ query: 'mutation { createWebhook(input: { url: "https://collector.example" }) { clientMutationId } }' }), 'multiplexer_refused'],
  // GitHub: persistence
  ['github', 'persistence: write a workflow file', 'PUT', '/repos/a/b/contents/.github/workflows/x.yml', json({ message: 'x', content: 'eA==' }), 'operation_not_allowed'],
  ['github', 'persistence: create a ref', 'POST', '/repos/a/b/git/refs', json({ ref: 'refs/heads/x', sha: 'a'.repeat(40) }), 'operation_not_allowed'],
  ['github', 'persistence: dispatch a workflow', 'POST', '/repos/a/b/actions/workflows/ci.yml/dispatches', json({ ref: 'main' }), 'operation_not_allowed'],
  ['github', 'persistence: create a repository', 'POST', '/user/repos', json({ name: 'x' }), 'operation_not_allowed'],
  ['github', 'persistence: set an Actions variable', 'POST', '/repos/a/b/actions/variables', json({ name: 'X', value: 'y' }), 'operation_not_allowed'],
  ['github', 'persistence: merge a pull request', 'PUT', '/repos/a/b/pulls/1/merge', undefined, 'operation_not_allowed'],
  ['github', 'persistence: commit through GraphQL', 'POST', '/graphql', json({ query: 'mutation { createCommitOnBranch(input: {}) { commit { oid } } }' }), 'multiplexer_refused'],
  ['github', 'persistence: GraphQL in an issue body field', 'POST', '/repos/a/b/issues', json({ query: 'mutation { createCommitOnBranch(input: {}) { commit { oid } } }' }), 'multiplexer_refused'],
  // GitHub: request shape
  ['github', 'schema: an unknown issue field', 'POST', '/repos/a/b/issues', json({ title: 'x', state_reason: 'x' }), 'request_schema_refused'],
  ['github', 'schema: an empty comment', 'POST', '/repos/a/b/issues/1/comments', json({ body: '' }), 'request_schema_refused'],
  ['github', 'schema: a repeated query parameter', 'GET', '/repos/a/b/issues?state=open&state=closed', undefined, 'request_schema_refused'],
  ['github', 'schema: an unknown query parameter', 'GET', '/repos/a/b/issues?filter=all', undefined, 'request_schema_refused'],
  ['github', 'schema: a raw query separator', 'GET', '/repos/a/b/issues?state=open;labels=x', undefined, 'request_schema_refused'],
  ['github', 'schema: a search without q', 'GET', '/search/issues?per_page=5', undefined, 'request_schema_refused'],
  ['github', 'schema: a body on a read', 'GET', '/repos/a/b', json({}), 'request_schema_refused'],
  ['github', 'schema: a form body for a JSON operation', 'POST', '/repos/a/b/issues', form('title=x'), 'request_schema_refused'],
  ['github', 'schema: a literal segment in the wrong case', 'GET', '/Repos/a/b', undefined, 'operation_not_allowed'],
  ['github', 'schema: a trailing slash', 'GET', '/repos/a/b/', undefined, 'operation_not_allowed'],
  ['github', 'schema: HEAD is not an operation', 'HEAD', '/user', undefined, 'operation_not_allowed'],
  ['github', 'header: one the template does not accept', 'GET', '/user', undefined, 'header_refused', { 'x-github-request-id': 'x' }],
  ['github', 'header: an accept outside the allowlist', 'GET', '/user', undefined, 'header_refused', { accept: 'text/html' }],
  ['github', 'header: an agent content type', 'POST', '/repos/a/b/issues', json({ title: 'x' }), 'header_refused', { 'content-type': 'text/plain' }],
  // OpenAI
  ['openai', 'credential: admin API keys', 'GET', '/v1/organization/admin_api_keys', undefined, 'token_management_denied'],
  ['openai', 'credential: a realtime client secret', 'POST', '/v1/realtime/client_secrets', json({}), 'token_management_denied'],
  ['openai', 'credential: a project service account', 'POST', '/v1/organization/projects/p/service_accounts', json({ name: 'x' }), 'token_management_denied'],
  ['openai', 'grant: an org invite', 'POST', '/v1/organization/invites', json({ email: 'someone@example.com', role: 'owner' }), 'token_management_denied'],
  ['openai', 'webhook: an endpoint', 'POST', '/v1/webhooks', json({ url: 'https://collector.example' }), 'token_management_denied'],
  ['openai', 'persistence: a file upload', 'POST', '/v1/files', text(multipart('name="purpose"'), 'multipart/form-data; boundary=b'), 'operation_not_allowed'],
  ['openai', 'persistence: a vector store', 'POST', '/v1/vector_stores', json({ name: 'x' }), 'operation_not_allowed'],
  ['openai', 'persistence: an assistant', 'POST', '/v1/assistants', json({ model: 'gpt-fixture' }), 'operation_not_allowed'],
  ['openai', 'persistence: a fine-tuning job', 'POST', '/v1/fine_tuning/jobs', json({ model: 'gpt-fixture', training_file: 'file-x' }), 'operation_not_allowed'],
  ['openai', 'persistence: a conversation', 'POST', '/v1/conversations', json({}), 'operation_not_allowed'],
  ['openai', 'persistence: the stored completion list', 'GET', '/v1/chat/completions', undefined, 'operation_not_allowed'],
  ['openai', 'multiplexer: a batch job', 'POST', '/v1/batches', json({ input_file_id: 'file-x', endpoint: '/v1/chat/completions', completion_window: '24h' }), 'multiplexer_refused'],
  ['openai', 'multiplexer: an array of requests', 'POST', '/v1/chat/completions', json([{ method: 'POST', url: '/v1/embeddings' }]), 'multiplexer_refused'],
  ['openai', 'persistence: a stored response', 'POST', '/v1/responses', json({ model: 'gpt-fixture', input: 'x', store: true }), 'request_schema_refused'],
  ['openai', 'persistence: a response that stores by default', 'POST', '/v1/responses', json({ model: 'gpt-fixture', input: 'x' }), 'request_schema_refused'],
  ['openai', 'persistence: a background response', 'POST', '/v1/responses', json({ model: 'gpt-fixture', input: 'x', store: false, background: true }), 'request_schema_refused'],
  ['openai', 'persistence: a chained response', 'POST', '/v1/responses', json({ model: 'gpt-fixture', input: 'x', store: false, previous_response_id: 'resp_x' }), 'request_schema_refused'],
  ['openai', 'persistence: a stored chat completion', 'POST', '/v1/chat/completions', json({ model: 'gpt-fixture', messages: [{ role: 'user', content: 'x' }], store: true }), 'request_schema_refused'],
  ['openai', 'persistence: chat metadata', 'POST', '/v1/chat/completions', json({ model: 'gpt-fixture', messages: [{ role: 'user', content: 'x' }], metadata: { a: 'b' } }), 'request_schema_refused'],
  ['openai', 'grant: an MCP tool to another server', 'POST', '/v1/responses', json({ model: 'gpt-fixture', input: 'x', store: false,
    tools: [{ type: 'mcp', server_label: 'x', server_url: 'https://collector.example', require_approval: 'never' }] }), 'request_schema_refused'],
  ['openai', 'grant: a hosted web tool', 'POST', '/v1/responses', json({ model: 'gpt-fixture', input: 'x', store: false, tools: [{ type: 'web_search' }] }), 'request_schema_refused'],
  ['openai', 'schema: a stream', 'POST', '/v1/chat/completions', json({ model: 'gpt-fixture', messages: [{ role: 'user', content: 'x' }], stream: true }), 'request_schema_refused'],
  ['openai', 'header: an organization override', 'GET', '/v1/models', undefined, 'header_refused', { 'openai-organization': 'org-fixture' }],
  ['openai', 'header: a project override', 'GET', '/v1/models', undefined, 'header_refused', { 'openai-project': 'proj_fixture' }],
  // Anthropic
  ['anthropic', 'credential: API keys', 'GET', '/v1/organizations/api_keys', undefined, 'token_management_denied'],
  ['anthropic', 'grant: an org invite', 'POST', '/v1/organizations/invites', json({ email: 'someone@example.com', role: 'admin' }), 'token_management_denied'],
  ['anthropic', 'webhook: an endpoint', 'POST', '/v1/webhooks', json({ url: 'https://collector.example' }), 'token_management_denied'],
  ['anthropic', 'persistence: a file upload', 'POST', '/v1/files', text(multipart('name="file"; filename="x.txt"'), 'multipart/form-data; boundary=b'), 'operation_not_allowed'],
  ['anthropic', 'persistence: a skill', 'POST', '/v1/skills', json({}), 'operation_not_allowed'],
  ['anthropic', 'multiplexer: a message batch', 'POST', '/v1/messages/batches', json({ requests: [{ custom_id: 'a', params: { model: 'claude-fixture', max_tokens: 1, messages: [] } }] }), 'multiplexer_refused'],
  ['anthropic', 'grant: an MCP server', 'POST', '/v1/messages', json({ model: 'claude-fixture', max_tokens: 8, messages: [{ role: 'user', content: 'x' }],
    mcp_servers: [{ type: 'url', url: 'https://collector.example/mcp', name: 'x' }] }), 'request_schema_refused'],
  ['anthropic', 'persistence: a container', 'POST', '/v1/messages', json({ model: 'claude-fixture', max_tokens: 8, messages: [{ role: 'user', content: 'x' }], container: 'container_x' }), 'request_schema_refused'],
  ['anthropic', 'grant: a server fetch tool', 'POST', '/v1/messages', json({ model: 'claude-fixture', max_tokens: 8, messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 }] }), 'request_schema_refused'],
  ['anthropic', 'grant: a code execution tool', 'POST', '/v1/messages', json({ model: 'claude-fixture', max_tokens: 8, messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] }), 'request_schema_refused'],
  ['anthropic', 'schema: a stream', 'POST', '/v1/messages', json({ model: 'claude-fixture', max_tokens: 8, messages: [{ role: 'user', content: 'x' }], stream: true }), 'request_schema_refused'],
  ['anthropic', 'header: a beta that unlocks other APIs', 'POST', '/v1/messages', json({ model: 'claude-fixture', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
    'header_refused', { 'anthropic-beta': 'files-api-2025-04-14' }],
  // Stripe
  ['stripe', 'credential: a token', 'POST', '/v1/tokens', form('card%5Bnumber%5D=x'), 'token_management_denied'],
  ['stripe', 'credential: an ephemeral key', 'POST', '/v1/ephemeral_keys', form('customer=cus_Fixture1'), 'token_management_denied'],
  // A PaymentIntent read returns its client_secret, which lets a client confirm the payment.
  ['stripe', 'credential: a PaymentIntent client secret', 'GET', '/v1/payment_intents/pi_Fixture1', undefined, 'operation_not_allowed'],
  ['stripe', 'credential: a billing portal session', 'POST', '/v1/billing_portal/sessions', form('customer=cus_Fixture1'), 'token_management_denied'],
  ['stripe', 'credential: a checkout session', 'POST', '/v1/checkout/sessions', form('mode=payment'), 'token_management_denied'],
  ['stripe', 'grant: a connected account', 'POST', '/v1/accounts', form('type=express'), 'operation_not_allowed'],
  ['stripe', 'grant: an account link', 'POST', '/v1/account_links', form('account=acct_Fixture1'), 'token_management_denied'],
  ['stripe', 'webhook: an endpoint', 'POST', '/v1/webhook_endpoints', form('url=https%3A%2F%2Fcollector.example'), 'token_management_denied'],
  ['stripe', 'persistence: update a customer', 'POST', '/v1/customers/cus_Fixture1', form('email=x%40example.com'), 'operation_not_allowed'],
  ['stripe', 'persistence: attach a source', 'POST', '/v1/customers/cus_Fixture1/sources', form('source=tok_x'), 'operation_not_allowed'],
  ['stripe', 'persistence: attach a payment method', 'POST', '/v1/payment_methods/pm_Fixture1/attach', form('customer=cus_Fixture1'), 'operation_not_allowed'],
  ['stripe', 'persistence: a subscription', 'POST', '/v1/subscriptions', form('customer=cus_Fixture1'), 'operation_not_allowed'],
  ['stripe', 'money: a payout', 'POST', '/v1/payouts', form('amount=100&currency=usd'), 'operation_not_allowed'],
  ['stripe', 'money: a transfer', 'POST', '/v1/transfers', form('amount=100&currency=usd&destination=acct_Fixture1'), 'operation_not_allowed'],
  ['stripe', 'persistence: delete a customer', 'DELETE', '/v1/customers/cus_Fixture1', undefined, 'operation_not_allowed'],
  ['stripe', 'schema: a JSON body', 'POST', '/v1/customers', json({ name: 'x' }), 'request_schema_refused'],
  ['stripe', 'schema: an expansion', 'POST', '/v1/customers', form('name=x&expand%5B%5D=sources'), 'request_schema_refused'],
  ['stripe', 'schema: a default payment method', 'POST', '/v1/customers', form('invoice_settings%5Bdefault_payment_method%5D=pm_Fixture1'), 'request_schema_refused'],
  ['stripe', 'schema: an expansion in the query', 'GET', '/v1/customers?expand%5B%5D=data.sources', undefined, 'request_schema_refused'],
  ['stripe', 'schema: a raw separator in the form', 'POST', '/v1/customers', form('name=x;email=y'), 'request_schema_refused'],
  ['stripe', 'schema: a repeated field', 'POST', '/v1/customers', form('name=a&name=b'), 'request_schema_refused'],
  ['stripe', 'schema: a text body without a form type', 'POST', '/v1/customers', text('name=x', 'text/plain'), 'request_schema_refused'],
  ['stripe', 'header: act as a connected account', 'GET', '/v1/customers', undefined, 'header_refused', { 'stripe-account': 'acct_Fixture1' }],
  // Slack
  ['slack', 'credential: an OAuth exchange', 'POST', '/api/oauth.v2.access', form('code=x'), 'token_management_denied'],
  ['slack', 'credential: a token check', 'GET', '/api/auth.test', undefined, 'token_management_denied'],
  ['slack', 'credential: an external token', 'POST', '/api/apps.auth.external.get', json({}), 'token_management_denied'],
  ['slack', 'credential: an RTM socket URL', 'POST', '/api/rtm.connect', undefined, 'token_management_denied'],
  ['slack', 'grant: invite to a channel', 'POST', '/api/conversations.invite', json({ channel: 'C0FIXTURE01', users: 'U0FIXTURE01' }), 'operation_not_allowed'],
  ['slack', 'grant: invite a user', 'POST', '/api/admin.users.invite', json({}), 'token_management_denied'],
  ['slack', 'grant: make an admin', 'POST', '/api/users.admin.setAdmin', form('user=U0FIXTURE01'), 'token_management_denied'],
  ['slack', 'webhook: a manifest update', 'POST', '/api/apps.manifest.update', json({}), 'token_management_denied'],
  ['slack', 'persistence: a reminder', 'POST', '/api/reminders.add', json({ text: 'x', time: 'in 1 minute' }), 'operation_not_allowed'],
  ['slack', 'persistence: a scheduled message', 'POST', '/api/chat.scheduleMessage', json({ channel: 'C0FIXTURE01', text: 'x', post_at: 1 }), 'operation_not_allowed'],
  ['slack', 'persistence: a file upload URL', 'POST', '/api/files.getUploadURLExternal', form('filename=x&length=1'), 'operation_not_allowed'],
  ['slack', 'persistence: a profile change', 'POST', '/api/users.profile.set', json({ profile: { status_text: 'x' } }), 'operation_not_allowed'],
  ['slack', 'persistence: a pin', 'POST', '/api/pins.add', json({ channel: 'C0FIXTURE01', timestamp: '1700000000.000100' }), 'operation_not_allowed'],
  ['slack', 'schema: a custom sender name', 'POST', '/api/chat.postMessage', json({ channel: 'C0FIXTURE01', text: 'x', username: 'Admin' }), 'request_schema_refused'],
  ['slack', 'schema: a custom icon', 'POST', '/api/chat.postMessage', json({ channel: 'C0FIXTURE01', text: 'x', icon_url: 'https://collector.example/x.png' }), 'request_schema_refused'],
  ['slack', 'schema: post as the user', 'POST', '/api/chat.postMessage', json({ channel: 'C0FIXTURE01', text: 'x', as_user: true }), 'request_schema_refused'],
  ['slack', 'schema: app metadata', 'POST', '/api/chat.postMessage', json({ channel: 'C0FIXTURE01', text: 'x', metadata: { event_type: 'x', event_payload: {} } }), 'request_schema_refused'],
  ['slack', 'schema: a channel name, not an id', 'POST', '/api/chat.postMessage', json({ channel: '#general', text: 'x' }), 'request_schema_refused'],
  ['slack', 'schema: a message with no content', 'POST', '/api/chat.postMessage', json({ channel: 'C0FIXTURE01' }), 'request_schema_refused'],
  ['slack', 'schema: a token in the query', 'GET', '/api/conversations.info?channel=C0FIXTURE01&token=x', undefined, 'request_schema_refused'],
  ['slack', 'schema: a history without a channel', 'GET', '/api/conversations.history', undefined, 'request_schema_refused'],
  ['slack', 'multiplexer: a batch in a form', 'POST', '/api/chat.postMessage',
    form(`batch=${encodeURIComponent(JSON.stringify([{ method: 'POST', relative_url: 'api/admin.users.invite' }]))}`), 'multiplexer_refused'],
];

describe('credential, grant, webhook and persistence surfaces of the built-in connectors (F02)', () => {
  it.each(surfaces)('%s refuses %s', (id, _surface, method, path, body, code, headers) =>
    expectRefused(connectorPolicy(id), { method, url: `https://${CONNECTORS[id]!.hosts[0]}${path}`, ...(body ? { body } : {}), ...(headers ? { headers } : {}) }, code));

  it('Slack incoming webhooks are another host', () => expectRefused(connectorPolicy('slack'),
    { method: 'POST', url: 'https://hooks.slack.com/services/fixture', body: json({ text: 'x' }) }, 'host_not_allowed'));
});

describe('multiplexer and method-override surfaces in generic mode', () => {
  const graphql = '{ viewer { login } }';
  const refused: [string, ApiRequestSpec][] = [
    ['a /graphql path', { method: 'POST', url: 'https://api.example.com/graphql', body: json({ text: 'x' }) }],
    ['a nested graphql segment', { method: 'GET', url: 'https://api.example.com/v1/x/GraphQL' }],
    ['a graphql.json segment', { method: 'POST', url: 'https://api.example.com/admin/api/2024-01/graphql.json', body: json({}) }],
    ['an OData $batch', { method: 'POST', url: 'https://api.example.com/v1/$batch', body: json({}) }],
    ['a batch endpoint', { method: 'POST', url: 'https://api.example.com/batch', body: json({}) }],
    ['an Elasticsearch _bulk', { method: 'POST', url: 'https://api.example.com/v1/x/_bulk', body: json({}) }],
    ['a JSON-RPC endpoint', { method: 'POST', url: 'https://api.example.com/api/jsonrpc', body: json({}) }],
    ['an XML-RPC endpoint', { method: 'POST', url: 'https://api.example.com/xmlrpc.php', body: text('x') }],
    ['a batch job endpoint', { method: 'POST', url: 'https://api.example.com/v1/batches', body: json({}) }],
    ['a GraphQL query string', { method: 'GET', url: `https://api.example.com/v1/x?query=${encodeURIComponent(graphql)}` }],
    ['a GraphQL operation name in the query', { method: 'GET', url: 'https://api.example.com/v1/x?operationName=Viewer' }],
    ['a GraphQL body at an ordinary path', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ query: graphql }) }],
    ['a named GraphQL mutation', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ query: '# comment\nmutation Add($id: ID!) @live { add(id: $id) { id } }', variables: { id: 1 } }) }],
    ['a GraphQL document in a mutation field', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ mutation: graphql }) }],
    ['an operation name', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ operationName: 'Viewer', variables: {} }) }],
    ['an Apollo persisted query', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ extensions: { persistedQuery: { version: 1, sha256Hash: '0'.repeat(64) } } }) }],
    ['a Relay document id', { method: 'POST', url: 'https://api.example.com/v1/x', body: form('doc_id=1234&variables=%7B%7D') }],
    ['a GraphQL form', { method: 'POST', url: 'https://api.example.com/v1/x', body: form(`query=${encodeURIComponent(graphql)}`) }],
    ['a GraphQL form without a content type', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(`query=${encodeURIComponent(graphql)}`) }],
    ['a GraphQL document as text/plain', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('mutation { add { id } }', 'text/plain') }],
    ['GraphQL JSON as text/plain', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(JSON.stringify({ query: graphql }), 'text/plain') }],
    ['an application/graphql type', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('x', 'application/graphql') }],
    ['an application/graphql-response+json type', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('{}', 'application/graphql-response+json') }],
    ['a JSON-RPC 2.0 call', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ jsonrpc: '2.0', method: 'eth_call', params: [], id: 1 }) }],
    ['a JSON-RPC 1.0 call', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ method: 'tools/call', params: {}, id: 1 }) }],
    ['a JSON-RPC type', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('{}', 'application/json-rpc') }],
    ['a GraphQL batch array', { method: 'POST', url: 'https://api.example.com/v1/x', body: json([{ query: graphql }, { query: graphql }]) }],
    ['a Graph API JSON batch', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ requests: [{ id: '1', method: 'GET', url: '/me' }] }) }],
    ['a Salesforce composite request', { method: 'POST', url: 'https://api.example.com/v1/x',
      body: json({ compositeRequest: [{ method: 'POST', url: '/services/data/v60.0/sobjects/Account', referenceId: 'a' }] }) }],
    ['a single forwarded request', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ method: 'DELETE', url: 'https://api.example.com/v1/y' }) }],
    ['a form batch', { method: 'POST', url: 'https://api.example.com/v1/x',
      body: form(`batch=${encodeURIComponent(JSON.stringify([{ method: 'GET', relative_url: 'me' }]))}`) }],
    ['a multipart/mixed batch', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('--b\r\n\r\nGET /v1/y HTTP/1.1\r\n--b--', 'multipart/mixed; boundary=b') }],
    ['an application/http part', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('GET /v1/y HTTP/1.1', 'application/http') }],
    ['a GraphQL multipart upload', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name="operations"', JSON.stringify({ query: 'x' })), 'multipart/form-data; boundary=b') }],
    ['a GraphQL multipart field named in RFC 2231 form', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart("name*=utf-8''operations"), 'multipart/form-data; boundary=b') }],
    ['a GraphQL multipart field in a multipart/related body', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name="operations"'), 'multipart/related; boundary=b') }],
    ['a Relay document id in JSON', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ id: 'fixture-doc', variables: {} }) }],
    ['an XML-RPC call', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('<?xml version="1.0"?>\n<methodCall><methodName>x</methodName></methodCall>', 'text/xml') }],
    ['a SOAP envelope', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body/></soap:Envelope>', 'application/xml') }],
    ['a SOAP type', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('<x/>', 'application/soap+xml') }],
  ];
  it.each(refused)('refuses %s', (_label, request) => expectRefused(generic, request, 'multiplexer_refused'));

  const ordinary: [string, ApiRequestSpec][] = [
    ['a search string', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ query: 'shoes', limit: 5 }) }],
    ['a structured query object', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ query: { match: { title: 'fixture' } } }) }],
    ['JSON text in a query field', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ query: '{"term": 1}' }) }],
    ['an empty object in a query field', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ query: '{}' }) }],
    ['a JSON Patch document', { method: 'PATCH', url: 'https://api.example.com/v1/x', body: json([{ op: 'replace', path: '/title', value: 'x' }]) }],
    ['a payment method field', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ method: 'card', amount: 100 }) }],
    ['a document id without variables', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ documentId: 'doc-1', title: 'x' }) }],
    ['a list of records', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ records: [{ fields: { name: 'x' } }] }) }],
    ['a search form', { method: 'POST', url: 'https://api.example.com/v1/x', body: form('query=shoes&page=2') }],
    ['a search query string', { method: 'GET', url: 'https://api.example.com/v1/x?query=shoes&q=%7Bbrace' }],
    ['prose', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('Please query the {status} field', 'text/plain') }],
    ['an XML document', { method: 'POST', url: 'https://api.example.com/v1/x', body: text('<?xml version="1.0"?><note><to>x</to></note>', 'application/xml') }],
    ['a multipart file', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name="file"; filename="operations"'), 'multipart/form-data; boundary=b') }],
    ['a bulk-sounding but ordinary segment', { method: 'GET', url: 'https://api.example.com/v1/bulky/rpcs' }],
    ['a template with variables', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ template_id: 'tpl-1', variables: { name: 'x' } }) }],
  ];
  it.each(ordinary)('still sends %s', (_label, request) => expectSent(generic, request).then(() => undefined));

  const overrides: [string, ApiRequestSpec][] = [
    ['a Salesforce _HttpMethod query', { method: 'POST', url: 'https://api.example.com/v1/x?_HttpMethod=DELETE' }],
    ['an override header name in the query', { method: 'POST', url: 'https://api.example.com/v1/x?X-HTTP-Method-Override=DELETE' }],
    ['an x-method-override query', { method: 'POST', url: 'https://api.example.com/v1/x?x-method-override=PUT' }],
    ['a __method form field', { method: 'POST', url: 'https://api.example.com/v1/x', body: form('__method=DELETE') }],
    ['an X-HTTP-Method JSON field', { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ 'X-HTTP-Method': 'DELETE' }) }],
    ['a multipart _HttpMethod part', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name="_HttpMethod"', 'DELETE'), 'multipart/form-data; boundary=b') }],
    // Each encoding below is one that a real multipart parser decodes to `_method`.
    ['a single-quoted _method part (PHP)', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart("name='_method'", 'DELETE'), 'multipart/form-data; boundary=b') }],
    ['a backslash-escaped _method part', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name="\\_method"', 'DELETE'), 'multipart/form-data; boundary=b') }],
    ['an RFC 2231 _method part', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart("name*=utf-8''%5Fmethod", 'DELETE'), 'multipart/form-data; boundary=b') }],
    ['an RFC 2231 continued _method part', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name*0="_me"; name*1="thod"', 'DELETE'), 'multipart/form-data; boundary=b') }],
    ['an RFC 2047 encoded _method part', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name="=?utf-8?B?X21ldGhvZA==?="', 'DELETE'), 'multipart/form-data; boundary=b') }],
    ['a _method part in a multipart/related body (Rack)', { method: 'POST', url: 'https://api.example.com/v1/x', body: text(multipart('name="_method"', 'DELETE'), 'multipart/related; boundary=b') }],
  ];
  it.each(overrides)('refuses %s', (_label, request) => expectRefused({ ...generic, methods: ['GET', 'POST'] }, request, 'method_not_allowed'));
});

describe('a connector template without vetted operations is enforced as generic mode', () => {
  const registry: ConnectorRegistry = { fixture: { id: 'fixture', hosts: ['api.example.com'], injection: { kind: 'bearer' }, defaultPathPrefixes: ['/'], deny: [] } };
  const policy: BrokerPolicy = { ...generic, mode: 'connector', connector: 'fixture' };

  it('applies the generic deny segments and the multiplexer refusal, and nothing narrower', async () => {
    await expectRefused(policy, { method: 'GET', url: 'https://api.example.com/v1/tokens' }, 'token_management_denied', { connectors: registry });
    await expectRefused(policy, { method: 'POST', url: 'https://api.example.com/graphql', body: json({ query: '{ a }' }) }, 'multiplexer_refused', { connectors: registry });
    await expectRefused(policy, { method: 'POST', url: 'https://api.example.com/v1/x', body: json({ query: 'mutation { a }' }) }, 'multiplexer_refused', { connectors: registry });
    await expectSent(policy, { method: 'PUT', url: 'https://api.example.com/v1/x', headers: { 'x-trace': 'fixture' }, body: json({ any: 'shape' }) }, { connectors: registry });
  });

  it('an empty operation list allows nothing', () => expectRefused(policy, { method: 'GET', url: 'https://api.example.com/v1/x' }, 'operation_not_allowed',
    { connectors: { fixture: { ...registry.fixture!, operations: [] } } }));

  it('the broker stores a connector policy only for a template with vetted operations', () => {
    expect(vettedConnector(registry, 'fixture')).toBeUndefined();
    expect(vettedConnector({ fixture: { ...registry.fixture!, operations: [] } }, 'fixture')).toBeUndefined();
    expect(vettedConnector(CONNECTORS, 'github')).toBe(CONNECTORS.github);
    expect(vettedConnector(CONNECTORS, null)).toBeUndefined();
  });

  // `constructor` passes the contract's connector pattern, and a plain lookup found
  // Object.prototype.constructor and then threw a TypeError instead of refusing.
  it('an inherited property is not a connector', async () => {
    expect(findConnector(CONNECTORS, 'constructor')).toBeUndefined();
    expect(vettedConnector(CONNECTORS, 'constructor')).toBeUndefined();
    await expectRefused({ ...generic, mode: 'connector', connector: 'constructor' }, { method: 'GET', url: 'https://api.example.com/v1/x' }, 'host_not_allowed');
  });
});

/**
 * Object schemas that accept keys they do not name, anywhere in a schema: not strict, or with a catchall.
 * Records are data (tool schemas, metadata, content): their keys are free, but an object inside one must
 * still be strict. The walk is the full one in support/zod-walk.ts, which also goes into record values,
 * discriminated unions, intersections, tuples, lazy, default and pipeline schemas (builder-side review,
 * NOT CHECKED item; the walk here used to stop at objects, optionals, arrays, unions and effects).
 */
function looseObjects(schema: z.ZodTypeAny): string[] {
  return zodNodes(schema).filter(({ typeName, schema: node }) => typeName === 'ZodObject'
    && ((node._def as { unknownKeys?: string }).unknownKeys !== 'strict'
      || (node._def as { catchall?: z.ZodTypeAny }).catchall?._def?.typeName !== 'ZodNever')).map(({ path }) => path || '$');
}

/** The zod types a JSON body schema may use: containers `zodNodes` walks into, and leaves that hold no schema. Any
 * other type fails the sweep until someone checks it cannot hide an object (a promise or a function could). */
const WALKED_ZOD_TYPES: ReadonlySet<string> = new Set(['ZodObject', 'ZodArray', 'ZodSet', 'ZodRecord', 'ZodMap', 'ZodOptional',
  'ZodNullable', 'ZodDefault', 'ZodCatch', 'ZodReadonly', 'ZodBranded', 'ZodEffects', 'ZodPipeline', 'ZodLazy', 'ZodUnion',
  'ZodDiscriminatedUnion', 'ZodIntersection', 'ZodTuple', 'ZodString', 'ZodNumber', 'ZodBigInt', 'ZodBoolean', 'ZodDate',
  'ZodLiteral', 'ZodEnum', 'ZodNativeEnum', 'ZodNull', 'ZodUndefined', 'ZodUnknown', 'ZodAny', 'ZodNever']);

describe('connector catalogs', () => {
  it.each(Object.keys(CONNECTORS))('%s has a sound, non-empty operation list', (id) => {
    const connector = CONNECTORS[id]!;
    expect(connector.operations!.length).toBeGreaterThan(0);
    expect(catalogProblems(connector.operations!, connector.headers)).toEqual([]);
    // No accepted header carries a credential, an override, a routing claim or a header the broker sets.
    for (const name of Object.keys(connector.headers ?? {})) {
      expect(['authorization', 'cookie', 'host', 'content-type', 'content-length', 'user-agent', 'accept-encoding', 'x-api-key',
        'x-http-method-override', 'openai-organization', 'openai-project', 'anthropic-beta', 'stripe-account', 'stripe-context']).not.toContain(name);
    }
    // The broker sends the agent's value, so a schema that strips an unknown key would send a key it never checked.
    for (const operation of connector.operations!) {
      if (operation.body?.kind !== 'json') continue;
      const schema = operation.body.schema as z.ZodTypeAny;
      expect(looseObjects(schema), operation.id).toEqual([]);
      expect(zodNodes(schema).map(({ typeName }) => typeName).filter((typeName) => !WALKED_ZOD_TYPES.has(typeName)), operation.id).toEqual([]);
    }
  });

  it('the strictness sweep finds a loose object wherever a schema nests it', () => {
    const strict = z.object({ k: z.string() }).strict();
    const loose = z.object({ k: z.string() });
    const hidden: [string, z.ZodTypeAny][] = [
      ['top level', loose], ['a passthrough object', strict.passthrough()], ['a catchall', strict.catchall(z.string())],
      ['an object field', z.object({ inner: loose }).strict()], ['an optional', z.object({ inner: loose.optional() }).strict()],
      ['an array', z.array(loose)], ['a union', z.union([strict, loose])], ['a record value', z.record(loose)],
      ['a map value', z.map(z.string(), loose)], ['a discriminated union',
        z.discriminatedUnion('k', [z.object({ k: z.literal('a') }).strict(), z.object({ k: z.literal('b') })])],
      ['an intersection', z.intersection(strict, loose)], ['a tuple', z.tuple([strict, loose])], ['a tuple rest', z.tuple([strict]).rest(loose)],
      ['a lazy schema', z.lazy(() => loose)], ['a default', loose.default({ k: 'x' })], ['a refinement', loose.refine(() => true)],
      ['a pipeline', z.string().pipe(z.unknown()).pipe(loose)],
    ];
    for (const [name, schema] of hidden) expect(looseObjects(schema), name).not.toEqual([]);
    for (const schema of [strict, z.record(strict), z.array(strict), z.record(z.unknown()), z.lazy(() => strict)]) expect(looseObjects(schema)).toEqual([]);
  });

  it('names each broken rule', () => {
    const broken: ConnectorOperation[] = [
      { id: 'a', method: 'GET', path: '/x/{id}', params: { id: /[0-9]+/ }, body: null },
      { id: 'b', method: 'GET', path: '/y/{id}', params: { id: /^[0-9]+$/g }, body: null },
      { id: 'c', method: 'GET', path: '/z/{rest+}/tail', params: { rest: /^.+$/ }, body: null },
      { id: 'd', method: 'GET', path: '/w/{id}', body: null },
      { id: 'e', method: 'GET', path: '/v', body: { kind: 'json', schema: z.object({}).strict() } },
      { id: 'f', method: 'POST', path: '/graphql', body: null },
      { id: 'a', method: 'GET', path: '/x/{id}', params: { id: /^[0-9]+$/ }, body: null },
      { id: 'g', method: 'GET', path: '/u//v', body: null },
      { id: 'h', method: 'GET', path: '/t', query: { q: /^a$/ }, requiredQuery: ['r'], body: null },
      { id: 'i', method: 'POST', path: '/s', body: { kind: 'form', fields: { name: /^x/ }, patterns: [[/^m\[.+\]$/, /x$/]] } },
      { id: 'j', method: 'GET', path: '/r/{id}', params: { id: /^[a-z]+$/m }, body: null },
    ];
    const problems = catalogProblems(broken, { Accept: /^a$/, 'x-ok': /b/ });
    expect(new Set(problems)).toEqual(new Set(['header Accept: name is not lowercase', 'header x-ok: rule is not anchored',
      'a param id: rule is not anchored', 'b param id: rule keeps state', 'c: {rest+} is not last', 'd: no rule for {id}',
      'e: GET with a body', 'f: multiplexer path', 'a: duplicate id', 'a: duplicate route', 'g: empty path segment', 'h: required r is not allowed',
      'i field name: rule is not anchored', 'i field pattern value: rule is not anchored', 'j param id: rule is multiline']));
  });

  it('matches exact paths, one segment per parameter, and a final multi-segment parameter', () => {
    const operations: ConnectorOperation[] = [
      { id: 'one', method: 'GET', path: '/a/{x}', params: { x: /^[a-z]+$/ }, body: null },
      { id: 'rest', method: 'GET', path: '/b/{rest+}', params: { rest: /^[a-z.]+$/ }, body: null },
    ];
    expect(matchOperation(operations, 'GET', '/a/abc')?.id).toBe('one');
    expect(matchOperation(operations, 'POST', '/a/abc')).toBeNull();
    expect(matchOperation(operations, 'GET', '/A/abc')).toBeNull();
    expect(matchOperation(operations, 'GET', '/a/abc/def')).toBeNull();
    expect(matchOperation(operations, 'GET', '/a/')).toBeNull();
    expect(matchOperation(operations, 'GET', '/a/ABC')).toBeNull();
    expect(matchOperation(operations, 'GET', '/b/x/y.z')?.id).toBe('rest');
    expect(matchOperation(operations, 'GET', '/b')).toBeNull();
    expect(matchOperation(operations, 'GET', '/b/x//y')).toBeNull();
    expect(matchOperation(operations, 'GET', '/b/x/Y')).toBeNull();
  });

  it('treats every rule as a whole-value match, whatever its own anchors and flags say', () => {
    const operations: ConnectorOperation[] = [
      { id: 'loose', method: 'GET', path: '/n/{id}', params: { id: /[0-9]+/ }, body: null },
      { id: 'multiline', method: 'GET', path: '/m/{id}', params: { id: /^[a-z]+$/m }, body: null },
      { id: 'stateful', method: 'GET', path: '/s/{id}', params: { id: /^[a-z]+$/g }, body: null },
    ];
    expect(matchOperation(operations, 'GET', '/n/123')?.id).toBe('loose');
    expect(matchOperation(operations, 'GET', '/n/abc123')).toBeNull();
    expect(matchOperation(operations, 'GET', '/m/abc\nDEF')).toBeNull();
    // A `g` rule tested directly keeps lastIndex and fails every second call; matching never does.
    expect(matchOperation(operations, 'GET', '/s/abc')?.id).toBe('stateful');
    expect(matchOperation(operations, 'GET', '/s/abc')?.id).toBe('stateful');
  });
});
