import { describe, expect, it, vi } from 'vitest';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import type { SpawnService } from '@tm8/execution';
import type { Db } from '../../src/db/types.js';
import { createBridgeWorkerPort } from '../../src/facade/execution-handlers.js';
import { parseBridgeCommand, parseNewSession } from '../../src/bridges/commands/parse.js';
import { resolveNewSessionLaunch } from '../../src/bridges/commands/new-session-launch.js';

const parse = (text: string) => {
  const command = parseBridgeCommand(text);
  if (command.kind !== 'command') throw new Error('expected command');
  return parseNewSession(command.args, command.body);
};

describe('/new option grammar', () => {
  it.each([
    ['/new', null, {}],
    ['/new session', 'session', {}],
    ['/new chat', 'chat', {}],
    ['/new effort:medium', null, { effort: 'medium' }],
    ['/new session provider:openai', 'session', { provider: 'openai' }],
    ['/new session model:gpt-6.1-sol', 'session', { model: 'gpt-6.1-sol' }],
    ['/new session teammate:"WhatsApp Bridge Engineer"', 'session', { teammate: 'WhatsApp Bridge Engineer' }],
    ["/new session teammate:'Bridge Engineer' effort:xhigh", 'session', { teammate: 'Bridge Engineer', effort: 'xhigh' }],
    ['/NEW SESSION EFFORT:high MODEL:gpt-6.1-sol PROVIDER:openai TEAMMATE:"Bridge Engineer"', 'session',
      { effort: 'high', model: 'gpt-6.1-sol', provider: 'openai', teammate: 'Bridge Engineer' }],
    ['/new teammate:"Engineer \\"Core\\"" model:openai/gpt-oss-120b', null, { teammate: 'Engineer "Core"', model: 'openai/gpt-oss-120b' }],
    ['/new teammate:"Please!"', null, { teammate: 'Please!' }],
  ])('parses %s', (text, target, options) => {
    expect(parse(text as string)).toEqual({ ok: true, target, options });
  });

  it.each([
    '/new session teammate:"Unclosed', '/new session teammate:""', '/new session model:',
    '/new session teammate:Bridge Engineer', '/new session teammate:"A"junk', '/new session teammate:A"B',
    '/new session effort:high EFFORT:low', '/new model:gpt-6.1-sol model:gpt-6-astra',
    '/new session provider:openai provider:anthropic', '/new session teammate:A teammate:B',
    '/new session mystery:value', '/new session model=gpt-6.1-sol', '/new everything',
    '/new session\nmodel:gpt-6.1-sol', '/new session effort:high\nrun something',
    '/new chat model:gpt-6.1-sol', '/new session teammate:"bad\\q"', '/new session effort:high please',
  ])('refuses all of %s', text => { expect(parse(text)).toMatchObject({ ok: false, error: expect.any(String) }); });

  it('does not strip invalid punctuation from a model or effort', () => {
    expect(parse('/new model:made-up.')).toMatchObject({ options: { model: 'made-up.' } });
    expect(parse('/new effort:high!')).toMatchObject({ options: { effort: 'high!' } });
  });
});

const claude = { model: 'claude-opus-5', agentTool: 'claude-code' };
describe('/new authoritative launch selection', () => {
  it('keeps teammate defaults, including the execution fallback, with unpinned effort', () => {
    expect(resolveNewSessionLaunch({}, claude)).toEqual({ ...claude, provider: 'anthropic', effort: null });
    expect(resolveNewSessionLaunch({ effort: 'high' }, { model: null, agentTool: null })).toEqual({
      model: 'sonnet', agentTool: 'claude-code', provider: 'anthropic', effort: 'high',
    });
  });

  it.each(LAUNCH_MODEL_CATALOG)('infers $provider/$agentTool for model-only $model', row => {
    const result = resolveNewSessionLaunch({ model: row.model }, claude);
    expect(result).toEqual({ model: row.model, agentTool: row.agentTool, provider: row.provider, effort: null });
    for (const effort of row.efforts) expect(resolveNewSessionLaunch({ model: row.model, effort }, claude).effort).toBe(effort);
  });

  it('provider-only keeps a matching default, else uses that vendor’s first catalog offering', () => {
    const sol = { model: 'gpt-6.1-sol', agentTool: 'codex' };
    expect(resolveNewSessionLaunch({ provider: 'openai' }, sol).model).toBe(sol.model);
    for (const provider of [...new Set(LAUNCH_MODEL_CATALOG.map(row => row.provider))]) {
      expect(resolveNewSessionLaunch({ provider }, { model: null, agentTool: null }).model)
        .toBe(provider === 'anthropic' ? 'sonnet' : LAUNCH_MODEL_CATALOG.find(row => row.provider === provider)!.model);
    }
  });

  it.each([
    { provider: 'whatsapp' }, { provider: 'codex' }, { model: 'made-up' },
    { model: 'gpt-6.1-sol', provider: 'anthropic' }, { model: 'gpt-6.1-sol', effort: 'ultra' },
    { model: 'claude-opus-5', effort: 'xhigh' }, { model: 'kimi-k3', effort: 'high' },
    { model: 'openai/gpt-oss-120b', effort: 'max' }, { effort: 'maximum' },
  ])('refuses unsupported or incompatible choices %j', options => {
    expect(() => resolveNewSessionLaunch(options, claude)).toThrow();
  });

  it('does not guess effort support for a custom teammate default', () => {
    expect(() => resolveNewSessionLaunch({ effort: 'high' }, { model: 'custom-model', agentTool: 'codex' })).toThrow(/no supported tunable effort/);
  });
});

describe('the real bridge worker port', () => {
  it('passes model, inferred tool, full effort vocabulary, member claims, mutation id and provenance to spawn', async () => {
    const spawn = vi.fn().mockResolvedValue({ sessionId: 'new-session' });
    const port = createBridgeWorkerPort({ db: {} as Db, spawnService: { spawn } as unknown as SpawnService });
    const claims = { identityId: 'linked-member', nodeAdmin: false };
    for (const effort of ['medium', 'xhigh', 'ultra'] as const) {
      const launch = resolveNewSessionLaunch({ model: 'gpt-6-astra', effort }, claude);
      const origins = [{ bridgeId: 'bridge', messageId: 'message', providerMessageId: 'external', sender: { memberId: 'member' }, command: '/new' }];
      await expect(port.spawnWorker(claims, {
        spaceId: 'space', teamMemberId: 'selected-teammate', taskId: null, projectId: null,
        model: launch.model, agentTool: launch.agentTool, effort: launch.effort, title: 'WhatsApp session',
        clientMutationId: 'bridge:bridge:external:spawn:new', origins,
      })).resolves.toEqual({ sessionId: 'new-session' });
      expect(spawn).toHaveBeenLastCalledWith(claims, expect.objectContaining({
        teamMemberId: 'selected-teammate', parentSessionId: null, taskIds: [], model: 'gpt-6-astra',
        agentTool: 'codex', reasoningEffort: effort, clientMutationId: 'bridge:bridge:external:spawn:new',
      }), { bridgeOrigins: origins });
    }
  });
});
