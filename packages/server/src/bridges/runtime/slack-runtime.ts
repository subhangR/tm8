/**
 * How this node runs the Slack connector runtime (integrations/slack-bridge),
 * read from the environment. A second `BridgeRuntimeSupervisor` beside the
 * WhatsApp one (main.ts), with its own label and token file, so minting one
 * never revokes the other's token (398: one live token per label).
 *
 * One variable turns it on for a laptop: `TM8_SLACK_RUNTIME=1` runs
 * `node --import tsx src/runtime-main.ts` from the checkout's
 * integrations/slack-bridge, with its token file and sealed state under the
 * node's data dir. A deployment that runs the runtime itself (a container)
 * sets `TM8_SLACK_RUNTIME_TOKEN_FILE` alone, or names its own argv in
 * `TM8_SLACK_RUNTIME_COMMAND`.
 *
 * The state dir holds the sealed Slack tokens (D38). It lives under the data
 * dir, not the checkout, so a rebuild, a `deploy/prod` rotation or a fresh
 * pull does not wipe it; losing it means pasting the tokens again.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const SLACK_RUNTIME_LABEL = 'slack-runtime';

/**
 * Read by the runtime itself, not the server: set on the node, they reach the
 * supervised runtime. TM8_SLACK_API_URL is the Web API base (the fake-Slack
 * seam); TM8_SLACK_RUNTIME_ID names the runtime (default slack-<hostname>);
 * TM8_SLACK_PROXY_URL is the proxy for all Slack traffic. HTTPS_PROXY and
 * NO_PROXY reach it as part of the inherited environment.
 */
const PASSED_THROUGH = ['TM8_SLACK_API_URL', 'TM8_SLACK_RUNTIME_ID', 'TM8_SLACK_PROXY_URL'] as const;

export interface SlackRuntimePlan {
  readonly label: string;
  readonly tokenFile: string;
  /** Where the runtime seals the tokens; passed as TM8_SLACK_STATE_DIR. */
  readonly stateDir: string;
  /** Absent: the deployment runs the runtime; the node only keeps the token file fresh. */
  readonly command?: { file: string; args: readonly string[]; cwd?: string; env: NodeJS.ProcessEnv };
  /** Set when the runtime cannot start as configured; the node logs it and does not launch. */
  readonly problem?: string;
}

export interface SlackRuntimeHost {
  readonly repoRoot: string;
  readonly dataDir: string;
  /** The node binary that runs the server (process.execPath). */
  readonly execPath: string;
  readonly exists?: (path: string) => boolean;
  /** For a leading ~ in a path setting; the process's home when absent. */
  readonly home?: string;
}

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test(v?.trim() ?? '');

/** Answers null when the node runs no Slack runtime (the default). */
export function slackRuntimePlan(env: NodeJS.ProcessEnv, host: SlackRuntimeHost): SlackRuntimePlan | null {
  const enabled = truthy(env.TM8_SLACK_RUNTIME);
  const commandJson = env.TM8_SLACK_RUNTIME_COMMAND?.trim();
  const tokenFileEnv = env.TM8_SLACK_RUNTIME_TOKEN_FILE?.trim();
  if (!enabled && !commandJson && !tokenFileEnv) return null;

  // A path setting: a leading ~ is the home dir, anything else must be absolute. A relative
  // one would resolve under the server's cwd, which for a deploy/prod build is a directory
  // the next deploy rotates away, sealed tokens and all.
  const home = host.home ?? homedir();
  const bad: string[] = [];
  const pathSetting = (name: string, fallback: string): string => {
    const raw = env[name]?.trim();
    if (!raw) return resolve(fallback);
    const p = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
    if (!isAbsolute(p)) bad.push(`${name} must be an absolute path or start with ~/, got ${JSON.stringify(raw)}`);
    return resolve(p);
  };
  // A directory of its own: a container mounts the directory (never the file, which each
  // mint replaces by rename) and sees nothing else of bridges/.
  const tokenFile = pathSetting('TM8_SLACK_RUNTIME_TOKEN_FILE', join(host.dataDir, 'bridges', 'slack-runtime-secrets', 'runtime.token'));
  const stateDir = pathSetting('TM8_SLACK_STATE_DIR', join(host.dataDir, 'bridges', 'slack-runtime'));
  const cwdEnv = env.TM8_SLACK_RUNTIME_CWD?.trim() ? pathSetting('TM8_SLACK_RUNTIME_CWD', '') : undefined;
  const childEnv: NodeJS.ProcessEnv = { TM8_SLACK_STATE_DIR: stateDir };
  for (const name of PASSED_THROUGH) if (env[name]?.trim()) childEnv[name] = env[name]!.trim();
  const base = { label: SLACK_RUNTIME_LABEL, tokenFile, stateDir };
  if (bad.length > 0) return { ...base, problem: bad.join('; ') };

  if (commandJson) {
    let argv: unknown;
    try { argv = JSON.parse(commandJson); } catch { argv = null; }
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      return { ...base, problem: 'TM8_SLACK_RUNTIME_COMMAND must be a JSON array of strings, e.g. ["node","--import","tsx","src/runtime-main.ts"]' };
    }
    const [file, ...args] = argv as string[];
    return { ...base, command: { file: file!, args, ...(cwdEnv ? { cwd: cwdEnv } : {}), env: childEnv } };
  }
  if (!enabled) return base;

  const cwd = cwdEnv ?? resolve(join(host.repoRoot, 'integrations', 'slack-bridge'));
  const exists = host.exists ?? existsSync;
  if (!exists(join(cwd, 'src', 'runtime-main.ts'))) {
    return { ...base, problem: `no Slack runtime at ${join(cwd, 'src', 'runtime-main.ts')}; set TM8_SLACK_RUNTIME_CWD to the integrations/slack-bridge checkout` };
  }
  if (!exists(join(cwd, 'node_modules'))) {
    return { ...base, problem: `the Slack runtime's dependencies are not installed; run: (cd ${cwd} && npm ci), then restart tm8` };
  }
  return { ...base, command: { file: host.execPath, args: ['--import', 'tsx', 'src/runtime-main.ts'], cwd, env: childEnv } };
}
