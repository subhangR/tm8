// Opt-in installed-binary conformance probe: local HTTP/SSE only, no provider inference.
// Run after tsc -b packages/execution: node packages/execution/harness/codex-http-history-probe.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from '../dist/runtime/CodexAppServerAdapter.js';
const root = await mkdtemp(join(tmpdir(), 'tm8-codex-http-conformance-'));
const requests = [];
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url !== '/v1/responses') {
    response.writeHead(404);
    response.end();
    return;
  }
  const data = JSON.parse(body);
  requests.push(data);
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const number = requests.length,
    id = `response-${number}`;
  const item = {
    type: 'message',
    id: `message-${number}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: `mock answer ${number}`, annotations: [] }],
  };
  const event = (value) =>
    response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({
    type: 'response.created',
    response: { id, object: 'response', status: 'in_progress', output: [] },
  });
  event({
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  event({
    type: 'response.output_text.delta',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: `mock answer ${number}`,
  });
  event({ type: 'response.output_item.done', output_index: 0, item });
  event({
    type: 'response.completed',
    response: {
      id,
      object: 'response',
      status: 'completed',
      output: [item],
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let session;
try {
  const config = {
    schemaVersion: 1,
    revision: 1,
    target: {
      harness: 'codex',
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
      reasoningEffort: 'medium',
      serviceTier: null,
    },
    instructionHash: 'probe',
    toolPolicyHash: 'probe',
    mcpBindingRevision: 'probe',
    cwdIdentity: 'probe',
    credentialBindingId: 'none',
    credentialRevision: null,
    launchFingerprint: null,
  };
  const launch = {
    kind: 'ephemeral-launch',
    launchId: 'probe',
    storageScopeId: 'probe',
    nativeStorageScopeId: 'probe',
    nativeStorageGeneration: 1,
    owner: { chatId: 'probe', generation: 1, ownerLeaseId: 'probe', claimFence: 'probe' },
    modelCredentialLeaseId: 'none',
    runtimeGrantId: 'none',
    capabilityPlanId: 'probe',
    materialize: async () => ({
      harness: 'codex',
      command: 'codex',
      argvPrefix: [],
      cwd: root,
      modelConfigDir: root,
      env: { TM8_PROBE_KEY: 'local-fixture-key' },
      instructionText: 'Local conformance probe. Only answer text; no tools.',
      providerConfig: {
        model_providers: {
          groq: {
            name: 'Groq',
            base_url: baseUrl,
            env_key: 'TM8_PROBE_KEY',
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false,
          },
        },
      },
      mcpConfigPath: join(root, 'unused.json'),
      mcpServers: [],
      nativeTools: [],
      allowedTools: [],
    }),
    release: async () => {},
  };
  session = await new CodexAppServerAdapter({
    nodeId: 'probe-node',
    rpcTimeoutMs: 5000,
    closeGraceMs: 1000,
  }).open({
    fence: { chatId: 'probe', bindingId: 'probe', generation: 1, leaseEpoch: 1, configRevision: 1 },
    config,
    mode: { kind: 'create' },
    launch,
  });
  const terminals = [];
  const events = [];
  const reader = (async () => {
    for await (const event of session.observations) {
      events.push(event);
      if (event.payload.kind === 'terminal') terminals.push(event.payload);
    }
  })();
  for (let n = 1; n <= 2; n++) {
    const receipt = await session.submit({
      attempt: { turnId: `turn-${n}`, attemptId: `attempt-${n}`, configRevision: 1 },
      clientSubmissionId: `submission-${n}`,
      text: `probe user ${n}`,
      attachmentRefs: [],
      config,
    });
    assert.equal(receipt.delivery, 'sent');
    const deadline = Date.now() + 10000;
    while (terminals.length < n && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      terminals[n - 1]?.outcome,
      'completed',
      JSON.stringify(events.map((e) => e.payload)),
    );
  }
  assert.equal(requests.length, 2);
  assert(requests.every((r) => !Object.hasOwn(r, 'previous_response_id')));
  const second = JSON.stringify(requests[1].input);
  for (const content of ['probe user 1', 'mock answer 1', 'probe user 2'])
    assert(second.includes(content), `Second request lacks ${content}`);
  await session.close('shutdown');
  await reader;
  console.log(
    JSON.stringify({
      protocol: session.opened.capabilities.protocolRevision,
      requests: 2,
      previousResponseId: false,
      secondRequestContainsCompletePriorTurn: true,
      providerInference: false,
    }),
  );
} finally {
  await session?.close('shutdown');
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
