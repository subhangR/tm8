/**
 * The Slack runtime's supervision plan (main.ts): off by default, one env var
 * on a laptop, its own label and token file, sealed state under the data dir,
 * and a clear problem instead of a crash loop when it cannot start.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SLACK_RUNTIME_LABEL, slackRuntimePlan } from '../../src/bridges/runtime/slack-runtime.js';

const host = (present: string[] = ['/repo/integrations/slack-bridge/src/runtime-main.ts', '/repo/integrations/slack-bridge/node_modules']) => ({
  repoRoot: '/repo',
  dataDir: '/data',
  execPath: '/usr/bin/node',
  exists: (p: string) => present.includes(p),
});

describe('slackRuntimePlan', () => {
  it('runs nothing unless asked', () => {
    expect(slackRuntimePlan({}, host())).toBeNull();
    expect(slackRuntimePlan({ TM8_SLACK_RUNTIME: '0' }, host())).toBeNull();
    expect(slackRuntimePlan({ TM8_SLACK_RUNTIME: '' }, host())).toBeNull();
  });

  it('TM8_SLACK_RUNTIME=1 runs the checkout runtime with its own label, token file and state dir', () => {
    const plan = slackRuntimePlan({ TM8_SLACK_RUNTIME: '1' }, host());
    expect(plan).toEqual({
      label: 'slack-runtime',
      tokenFile: '/data/bridges/slack-runtime.token',
      stateDir: '/data/bridges/slack-runtime',
      command: {
        file: '/usr/bin/node',
        args: ['--import', 'tsx', 'src/runtime-main.ts'],
        cwd: '/repo/integrations/slack-bridge',
        env: { TM8_SLACK_STATE_DIR: '/data/bridges/slack-runtime' },
      },
    });
    // Never the WhatsApp label: one live token per label (398), so sharing it would revoke the other runtime.
    expect(SLACK_RUNTIME_LABEL).not.toBe('whatsapp-runtime');
  });

  it('honours the overrides and passes the runtime-only variables through', () => {
    const plan = slackRuntimePlan({
      TM8_SLACK_RUNTIME: 'true',
      TM8_SLACK_STATE_DIR: '/vol/slack',
      TM8_SLACK_RUNTIME_TOKEN_FILE: '/run/slack.token',
      TM8_SLACK_RUNTIME_CWD: '/opt/slack-bridge',
      TM8_SLACK_API_URL: 'http://127.0.0.1:9999/api/',
      TM8_SLACK_RUNTIME_ID: 'slack-test',
      TM8_SLACK_PROXY_URL: 'http://proxy:3128',
    }, host(['/opt/slack-bridge/src/runtime-main.ts', '/opt/slack-bridge/node_modules']));
    expect(plan?.tokenFile).toBe('/run/slack.token');
    expect(plan?.stateDir).toBe('/vol/slack');
    expect(plan?.command?.cwd).toBe('/opt/slack-bridge');
    expect(plan?.command?.env).toEqual({
      TM8_SLACK_STATE_DIR: '/vol/slack',
      TM8_SLACK_API_URL: 'http://127.0.0.1:9999/api/',
      TM8_SLACK_RUNTIME_ID: 'slack-test',
      TM8_SLACK_PROXY_URL: 'http://proxy:3128',
    });
  });

  it('a token file alone mints for a runtime the deployment runs', () => {
    const plan = slackRuntimePlan({ TM8_SLACK_RUNTIME_TOKEN_FILE: '/secrets/slack.token' }, host([]));
    expect(plan).toMatchObject({ label: 'slack-runtime', tokenFile: '/secrets/slack.token' });
    expect(plan?.command).toBeUndefined();
    expect(plan?.problem).toBeUndefined();
  });

  it('a custom command wins and needs no checkout', () => {
    const plan = slackRuntimePlan({ TM8_SLACK_RUNTIME_COMMAND: '["docker","start","-a","slack-runtime"]' }, host([]));
    expect(plan?.command).toMatchObject({ file: 'docker', args: ['start', '-a', 'slack-runtime'] });
    expect(slackRuntimePlan({ TM8_SLACK_RUNTIME_COMMAND: 'node runtime.js' }, host())?.problem).toMatch(/JSON array/);
  });

  it('names the fix instead of crash-looping when the runtime or its deps are missing', () => {
    expect(slackRuntimePlan({ TM8_SLACK_RUNTIME: '1' }, host([]))?.problem).toMatch(/no Slack runtime at/);
    const noDeps = slackRuntimePlan({ TM8_SLACK_RUNTIME: '1' }, host(['/repo/integrations/slack-bridge/src/runtime-main.ts']));
    expect(noDeps?.problem).toContain(`(cd ${join('/repo', 'integrations', 'slack-bridge')} && npm ci)`);
    expect(noDeps?.command).toBeUndefined();
  });
});
