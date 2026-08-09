// The credential boundary of a spawn, measured at every artifact a launch
// produces: the composed manifest, the two prompts, the argv, the manifest
// FILE on disk and the graph row. This is the regression net for the
// utho-prod 2026-08-09 incident, where a real `sk-ant-oat…` OAuth token pasted
// into a task DESCRIPTION travelled into the manifest and killed every launch
// of that task on the S15 DB guard — with an error pointing nowhere near the
// cause.
//
// Two properties, both load-bearing:
//   1. NO credential-shaped token survives into any launch artifact.
//   2. The context around it DOES survive — a redaction that destroyed the
//      task text would fix the leak by breaking the feature.
//
// All tokens below are synthetic bytes shaped like real prefixes.

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composePrompt } from '@tm8/prompt';
import {
  buildAgentCommand,
  composeManifest,
  withAgentPrompt,
} from '../src/spawn/manifest.js';
import { REDACTION_MARKER } from '../src/spawn/secret-redaction.js';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type {
  GraphAuth,
  LoadSpawnContextInput,
  SpawnContext,
  SpawnRequest,
} from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const FAKE_TOKEN = `sk-ant-oat01-${'A'.repeat(80)}`;
const FAKE_GH = `github_pat_${'e'.repeat(60)}`;
const BENIGN_SLUG = 'fix/task-acceptance-criteria-cleanup';

const POISONED_DESCRIPTION =
  `Fix claude credential connection. The old key was ${FAKE_TOKEN} — rotate it, ` +
  `then land the change on ${BENIGN_SLUG}.`;

function poisonedContext(): SpawnContext {
  return {
    spaceId: 'space-1',
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    teamMember: {
      id: 'tm-1',
      name: 'Draco',
      role: 'PTY engineer',
      identity: `terminal seam; never echo ${FAKE_GH} anywhere`,
      memories: [`the gh token used to be ${FAKE_GH}`],
      model: 'opus',
      agentTool: null,
      mode: 'worker',
      permissionMode: null,
      avatar: null,
      capabilities: {},
      commandPermissions: {},
    },
    tasks: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        version: 1,
        title: 'Fix claude credential connection.',
        description: POISONED_DESCRIPTION,
        priority: 'high',
        workStatus: 'open',
        acceptanceCriteria: [],
      },
    ],
  };
}

const request: SpawnRequest = {
  spaceId: 'space-1',
  teamMemberId: 'tm-1',
  promptExtra: `also, the slack hook was xoxb-${'1'.repeat(12)}-abcdef`,
};

const CLAUDE_LAUNCH = {
  mode: 'worker',
  model: 'opus',
  agentTool: 'claude-code',
  permissionMode: 'acceptEdits',
} as const;

const CODEX_LAUNCH = {
  mode: 'worker',
  model: 'gpt-5.6-sol',
  agentTool: 'codex',
  permissionMode: 'acceptEdits',
  accessMode: 'acceptEdits',
  reasoningEffort: null,
} as const;

/** Every artifact must satisfy both halves of the property. */
function expectScrubbedButUsable(text: string): void {
  expect(text).not.toContain('sk-ant-oat01-');
  expect(text).not.toContain(FAKE_GH);
  expect(text).not.toContain('xoxb-');
  expect(text).toContain(REDACTION_MARKER);
}

describe('the spawn credential boundary — composed artifacts, both dialects', () => {
  for (const [name, launch] of [
    ['claude', CLAUDE_LAUNCH],
    ['codex', CODEX_LAUNCH],
  ] as const) {
    it(`${name}: manifest, prompts and argv carry no token, and the task text survives`, () => {
      const manifest = composeManifest({
        sessionId: `sess-${name}`,
        request,
        context: poisonedContext(),
        launch,
        workdir: { mode: 'project', path: '/tmp/tm8-fixture' },
        command: buildAgentCommand(launch, {}),
        baseUrl: 'http://127.0.0.1:4610',
      });

      // The manifest as a WHOLE — the same bytes writeManifestFile persists
      // and recordManifest hands to the graph row the S15 guard watches.
      const rendered = JSON.stringify(manifest);
      expectScrubbedButUsable(rendered);
      // The context is still usable: title untouched, prose and the benign
      // hyphenated slug (the 073 false-positive class) intact around the hole.
      expect(rendered).toContain('Fix claude credential connection.');
      expect(rendered).toContain(BENIGN_SLUG);
      expect(rendered).toContain('rotate it');

      // The prompts composed FROM the manifest…
      const envelope = composePrompt(manifest, {
        sessionId: `sess-${name}`,
        baseUrl: 'http://127.0.0.1:4610',
      });
      expectScrubbedButUsable(`${envelope.system}\n${envelope.task}`);

      // …and the final argv, which is visible to `ps` on the whole machine.
      const command = withAgentPrompt(
        buildAgentCommand(launch, {}),
        { system: envelope.system, task: envelope.task },
        launch,
        {},
      );
      expectScrubbedButUsable(command);
    });
  }
});

/** FakeGraph whose task description carries the pasted token. */
class PoisonedGraph extends FakeGraph {
  override async loadSpawnContext(
    auth: GraphAuth,
    input: LoadSpawnContextInput,
  ): Promise<SpawnContext> {
    const ctx = await super.loadSpawnContext(auth, input);
    return {
      ...ctx,
      tasks: ctx.tasks.map((t) => ({ ...t, description: POISONED_DESCRIPTION })),
    };
  }
}

describe('the spawn credential boundary — through SpawnService to disk and graph', () => {
  let dataDir: string;
  let projectDir: string;
  let pty: PtyHostService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-secret-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-secret-proj-'));
    pty = new PtyHostService();
  });

  afterEach(async () => {
    pty.shutdownAll();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('a real spawn writes a manifest file and a graph row with the token already gone', async () => {
    const graph = new PoisonedGraph({ workingDir: projectDir });
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4614',
      dataDir,
      nodeId: 'test-node',
      env: { ...process.env, TM8_AGENT_CMD: 'echo-agent' },
    });

    const result = await service.spawn(
      { identityId: 'identity-1', actorId: 'actor-1' },
      {
        spaceId: '11111111-1111-4111-8111-111111111111',
        teamMemberId: '22222222-2222-4222-8222-222222222222',
        taskIds: ['33333333-3333-4333-8333-333333333333'],
        projectId: '44444444-4444-4444-8444-444444444444',
      },
    );

    // The FILE the agent reads.
    expectScrubbedButUsable(await readFile(result.manifestPath, 'utf8'));

    // The graph row — manifest, env var names and BOTH launch prompts, exactly
    // what `record_session_manifest` persists and the S15 guard inspects.
    const recorded = graph.manifests[0]!;
    expectScrubbedButUsable(JSON.stringify(recorded));
    expect(JSON.stringify(recorded.manifest)).toContain(BENIGN_SLUG);
  });
});
