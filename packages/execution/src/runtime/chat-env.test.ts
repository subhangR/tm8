// The chat child's environment is an ALLOW-LIST, and this is the test that
// keeps it one.
//
// Measured on the production node 2026-08-21, which is why this file exists
// rather than a comment: the server process carries `TM8_DATABASE_URL`, and
// `select rolsuper from pg_roles where rolname = current_user` over that URL
// answers TRUE. It is a superuser connection string, so every RLS policy on
// the node is advisory to whoever holds it.
//
// `ClaudeHeadlessAdapter` built its child env as `{ ...process.env, ... }`,
// which handed that string to the chat runtime. It cost nothing for as long as
// chat had no way to read an environment variable — on this node chat ran with
// four tools and no filesystem, because the git-root inference it depended on
// failed for every thread ever started. Giving chat `Bash` is what turns `env`
// into a superuser credential, so the fix ships with that capability.
import { describe, expect, it } from 'vitest';
import { CHAT_ENV_KEYS, composeChatEnv } from './chat-env.js';

/** The real shape: every key name observed on the deployed node, values faked. */
const PRODUCTION_LIKE_ENV: NodeJS.ProcessEnv = {
  HOME: '/home/tm8',
  USER: 'tm8',
  LOGNAME: 'tm8',
  SHELL: '/bin/bash',
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  INVOCATION_ID: 'systemd-invocation',
  JOURNAL_STREAM: '8:12345',
  SYSTEMD_EXEC_PID: '684399',
  MEMORY_PRESSURE_WATCH: '/sys/fs/cgroup/x',
  MEMORY_PRESSURE_WRITE: 'c29tZQ==',
  TM8_DATABASE_URL: 'postgresql://tm8:hunter2@127.0.0.1:5442/tm8',
  TM8_DELIVERY_DATABASE_URL: 'postgresql://tm8:hunter2@127.0.0.1:5442/tm8_delivery',
  TM8_DATA_DIR: '/home/tm8/prod-data',
  TM8_PROJECT_DIR: '/home/tm8/prod-workspace',
  TM8_UI_DIR: '/opt/tm8/prod/packages/tm8-ui/dist',
  TM8_PORT: '17777',
  TM8_ENV: 'prod',
  TM8_SESSION_CAP: '30',
  TM8_ALLOWED_ORIGINS: 'https://tm8.sh',
  TM8_PUBLIC_ORIGIN: 'https://tm8.sh',
  TM8_DB_POOL_MAX: '32',
  TM8_PG_PORT: '5442',
  // Not set on this node today. Present here precisely BECAUSE they are not:
  // an allow-list has to stay correct on the day someone sets one.
  GH_TOKEN: 'ghp_should_never_reach_the_child',
  GITHUB_TOKEN: 'ghp_should_never_reach_the_child',
  ANTHROPIC_API_KEY: 'sk-ant-should-never-reach-the-child',
};

describe('composeChatEnv', () => {
  it('emits the WHOLE key set and nothing else', () => {
    // Asserted as an exact set, not as a series of absences. `expect(env
    // .TM8_DATABASE_URL).toBeUndefined()` keeps passing on the day a NEW secret
    // is added to the server's environment, which is the regression that would
    // actually ship. Same rule, and same reason, as SHELL_ENV_KEYS next door.
    const env = composeChatEnv(PRODUCTION_LIKE_ENV);
    expect(Object.keys(env).sort()).toEqual([...CHAT_ENV_KEYS]
      .filter((key) => key in PRODUCTION_LIKE_ENV)
      .sort());
  });

  it('withholds the database URLs — the finding this file was written for', () => {
    const env = composeChatEnv(PRODUCTION_LIKE_ENV);
    expect(env['TM8_DATABASE_URL']).toBeUndefined();
    expect(env['TM8_DELIVERY_DATABASE_URL']).toBeUndefined();
    // Nothing may reach the child as a serialised copy either.
    expect(JSON.stringify(env)).not.toContain('hunter2');
    expect(JSON.stringify(env)).not.toContain('postgresql://');
  });

  it('withholds every TM8_* name, not merely the credential-shaped ones', () => {
    // The chat child needs NONE of them: the per-thread MCP config carries
    // TM8_BASE_URL, the runtime token, the mode, the Space and the project root
    // in the MCP server's own env block. A TM8_* key in the ambient environment
    // is therefore always either a secret or a redundancy.
    const env = composeChatEnv(PRODUCTION_LIKE_ENV);
    expect(Object.keys(env).filter((key) => key.startsWith('TM8_'))).toEqual([]);
  });

  it('withholds vendor credentials even though this node sets none today', () => {
    const env = composeChatEnv(PRODUCTION_LIKE_ENV);
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('keeps HOME, because the runtime authenticates from it', () => {
    // The honest limit, pinned so nobody reads this allow-list as a sandbox:
    // HOME is the server's own, so ~/.claude, ~/.git-credentials,
    // ~/.config/gh/hosts.yml and ~/.ssh all remain reachable to a chat Bash.
    // Withholding tm8's own secrets is what this function does; isolating the
    // child is not, and cannot be while it authenticates from that home.
    const env = composeChatEnv(PRODUCTION_LIKE_ENV);
    expect(env['HOME']).toBe('/home/tm8');
    expect(env['PATH']).toBe('/usr/bin:/bin');
  });

  it('falls back to a service PATH rather than emitting none', () => {
    // Absent PATH is the one unsurvivable omission: the child could not find
    // git, node, or anything Bash is asked to run.
    expect(composeChatEnv({ HOME: '/home/tm8' })['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('omits an empty value rather than passing it through', () => {
    // An empty HOME is worse than no HOME: it resolves relative paths somewhere
    // real instead of failing.
    expect('HOME' in composeChatEnv({ HOME: '', PATH: '/usr/bin' })).toBe(false);
  });
});
