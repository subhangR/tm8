/**
 * `spaces.configs` — resolves the registry into what the Configs page shows.
 *
 * REDACTION HAPPENS HERE, before anything is serialized: a `secret` env knob
 * becomes `{ kind: 'secret', present }` and its value is never read into the
 * answer. Node env is resolved only for a node admin on a human session; every
 * other caller gets `node: { visible: false }` and no env value at all.
 */
import { CollabError, isHumanAuthKind } from '@tm8/contract';
import type {
  ConfigKnobView,
  ConfigSubjectView,
  ConfigValue,
  NodeConfigWarning,
  NodeSettingSetResult,
  NodeSettingState,
  SpaceConfigsView,
} from '@tm8/contract';
import { asHarnessSurface, asPermissionMode, asReadHints, memberLaunchPreferences } from '@tm8/execution';

import type { DbClaims, Querier } from '../db/types.js';
import { definedAt } from './locate.js';
import {
  AUTO_OWNER_LOCKOUT,
  nodeSettingDef,
  nodeSettingsBoot,
  parseNodeSetting,
  type NodeSettingsBoot,
} from './node-settings.js';
import {
  CLI_ENV,
  CODE_CONSTANTS,
  NODE_ENV,
  PROFILE_KNOBS,
  TEAMMATE_KNOBS,
  type EnvKnob,
} from './registry.js';

export const NODE_CONFIG_HIDDEN =
  'Node settings come from the server\'s environment and are shown to node admins only.';

export interface ConfigsCaller {
  claims: DbClaims;
  authKind: string | undefined;
}

export interface ConfigsDb {
  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T>;
}

/** A dotted knob name is located by its last segment (`feedPolicy.pageSize` → `pageSize`). */
export function locatorName(name: string): string {
  return name.split('.').pop()!;
}

/** Text for any registry value — strings as-is, everything else as JSON. */
export function valueText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One env knob, redacted. The value of a secret never leaves this function. */
export function envValue(knob: EnvKnob, env: NodeJS.ProcessEnv): { value: ConfigValue; set: boolean } {
  const raw = env[knob.name]?.trim();
  const set = raw !== undefined && raw !== '';
  if (knob.secret) return { value: { kind: 'secret', present: set }, set };
  return { value: set ? { kind: 'value', text: raw } : { kind: 'unset' }, set };
}

/** Provider keys: shown here, changed through Node credentials (never stored as a setting). */
export const NODE_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'TM8_GITHUB_TOKEN',
]);

/** Stored node settings, by name (`public.node_settings_list()`). */
export type StoredNodeSettings = Readonly<Record<string, { value: string }>>;

/**
 * One curated setting's state. Precedence env > stored > default; every
 * setting applies on restart, so it is pending until this process booted with
 * the stored value.
 */
export function nodeSettingState(
  name: string,
  stored: StoredNodeSettings,
  boot: NodeSettingsBoot,
): NodeSettingState | undefined {
  const def = nodeSettingDef(name);
  if (!def) return undefined;
  const value = stored[name]?.value ?? null;
  const pinnedByEnv = boot.pinnedByEnv.has(name);
  return {
    stored: value,
    pinnedByEnv,
    applies: 'restart',
    restartPending: !pinnedByEnv && value !== (boot.applied.get(name) ?? null),
    input: def.input,
  };
}

export function nodeKnobs(
  env: NodeJS.ProcessEnv,
  stored: StoredNodeSettings = {},
  boot: NodeSettingsBoot = nodeSettingsBoot(env),
): ConfigKnobView[] {
  return NODE_ENV.map((knob) => {
    const { value, set } = envValue(knob, env);
    const setting = nodeSettingState(knob.name, stored, boot);
    return {
      name: knob.name,
      group: knob.group,
      summary: knob.summary,
      value,
      // `db`: the boot overlay wrote this value from the stored setting.
      source: boot.applied.has(knob.name) ? 'db' : set ? 'env' : 'default',
      default: knob.default,
      definedAt: definedAt(knob.definedIn, knob.name),
      change: 'env',
      ...(setting ? { setting } : {}),
      ...(NODE_CREDENTIAL_KEYS.has(knob.name) ? { managedIn: 'node_credentials' as const } : {}),
    };
  });
}

const PROVIDER_KEY: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  github: 'GH_TOKEN',
};

/**
 * Setup risks worth a banner, from the EFFECTIVE env (after the boot overlay)
 * and the node-credential policy as launches read it (`read_node_credential_policy`,
 * where an absent provider is already resolved for the node mode).
 */
export function nodeWarnings(
  env: NodeJS.ProcessEnv,
  nodePolicy: Readonly<Record<string, boolean>> | null,
): NodeConfigWarning[] {
  const set = (name: string) => (env[name]?.trim() ?? '') !== '';
  const warnings: NodeConfigWarning[] = [];
  const mode = env.TM8_NODE_MODE?.trim().toLowerCase() || 'single';
  const published = ['TM8_PUBLIC_ORIGIN', 'TM8_ALLOWED_HOSTNAMES', 'TM8_ALLOWED_ORIGINS'].filter(set);
  if (mode === 'single' && published.length > 0) {
    warnings.push({
      id: 'single_mode_published',
      text: `This node runs in single mode, where a request from loopback is the owner, but it is published beyond loopback (${published.join(', ')}). A shared node should run TM8_NODE_MODE=multi.`,
      settings: ['TM8_NODE_MODE', ...published],
    });
  }
  if (env.TM8_PUBLIC_ORIGIN?.trim().toLowerCase().startsWith('https:') && !set('TM8_PREVIEW_PUBLIC_ORIGIN')) {
    warnings.push({
      id: 'preview_same_origin',
      text: 'Artifact previews are served from the same origin as the app (TM8_PUBLIC_ORIGIN). Set TM8_PREVIEW_PUBLIC_ORIGIN to a separate origin so a preview cannot act as the signed-in user.',
      settings: ['TM8_PREVIEW_PUBLIC_ORIGIN'],
    });
  }
  if (!set('TM8_PROJECT_ROOTS')) {
    warnings.push({
      id: 'project_roots_unset',
      text: 'TM8_PROJECT_ROOTS is unset, so node admins browse the whole filesystem (/) when linking a project.',
      settings: ['TM8_PROJECT_ROOTS'],
    });
  }
  if (nodePolicy) {
    const allowed = Object.keys(PROVIDER_KEY).filter((provider) => nodePolicy[provider] !== false);
    if (allowed.length > 0) {
      warnings.push({
        id: 'node_credential_fallback',
        text: `Members who have not connected their own key run agents on this node's own login for: ${allowed.map((p) => `${p}${nodePolicy[p] === undefined ? ' (default)' : ''}`).join(', ')}. Change it in Node credentials.`,
        settings: allowed.map((p) => PROVIDER_KEY[p]!),
      });
    }
  }
  return warnings;
}

export function cliKnobs(): ConfigKnobView[] {
  return CLI_ENV.map((knob) => ({
    name: knob.name,
    group: knob.group,
    summary: knob.summary,
    value: knob.secret
      ? { kind: 'unobservable', reason: 'a secret read by the tm8 CLI in your own shell' }
      : { kind: 'unobservable', reason: 'read by the tm8 CLI in your own shell, not by the server' },
    source: 'env',
    default: knob.default,
    definedAt: definedAt(knob.definedIn, knob.name),
    change: 'env',
  }));
}

export function codeKnobs(): ConfigKnobView[] {
  return CODE_CONSTANTS.map((c) => ({
    name: c.name,
    group: c.group,
    summary: c.summary,
    value: { kind: 'value', text: valueText(c.read()) },
    source: 'code',
    default: null,
    definedAt: definedAt(c.definedIn, c.name),
    change: 'code',
  }));
}

export interface TeammateRow {
  entity_id: string;
  name: string;
  agent_tool: string | null;
  model: string | null;
  permission_mode: string | null;
  capabilities: Record<string, unknown> | null;
}

/**
 * One teammate's launch knobs. The node env named on a knob outranks the
 * persona — the precedence `resolveLaunchConfig` applies — but only a caller
 * allowed to see node config learns the env value; everyone else sees the
 * persona value and its source.
 */
export function teammateSubject(
  row: TeammateRow,
  env: NodeJS.ProcessEnv | null,
): ConfigSubjectView {
  // Reading configuration must remain possible for legacy rows that the launch
  // validator refuses. Never expose the raw MCP values: only names survive.
  const raw = row.capabilities?.launch;
  const launch = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const prefs = memberLaunchPreferences({ ...row.capabilities, launch: { ...launch, mcpServers: undefined } });
  const legacyMcpNames = launch.mcpServers && typeof launch.mcpServers === 'object' && !Array.isArray(launch.mcpServers)
    ? Object.fromEntries(Object.keys(launch.mcpServers).map((name) => [name, {}])) : null;
  const persona: Record<string, unknown> = {
    // Every key the spawn path's parser returns, so a new launch key needs only
    // its registry row (which the registry test demands).
    ...Object.fromEntries(Object.entries(prefs).map(([key, value]) => [`capabilities.launch.${key}`, value])),
    'capabilities.launch.mcpServers': legacyMcpNames,
    agent_tool: row.agent_tool,
    model: row.model,
    permission_mode: row.permission_mode,
  };
  const envOverride: Record<string, (raw: string | undefined) => unknown> = {
    TM8_HARNESS_SURFACE: (raw) => asHarnessSurface(raw),
    TM8_READ_HINTS: (raw) => asReadHints(raw),
    // The spawn path's own parser: an invalid value is discarded there, so it
    // must not be reported here as the active one.
    TM8_PERMISSION_MODE: (raw) => asPermissionMode(raw?.trim()),
  };
  return {
    id: row.entity_id,
    name: row.name,
    knobs: TEAMMATE_KNOBS.map((knob) => {
      const fromEnv = env && knob.envName ? envOverride[knob.envName]?.(env[knob.envName]) ?? null : null;
      const stored = persona[knob.name] ?? null;
      const fromPersona = stored !== null && knob.display ? knob.display(stored) : stored;
      const [value, source]: [ConfigValue, ConfigKnobView['source']] =
        fromEnv !== null
          ? [{ kind: 'value', text: valueText(fromEnv) }, 'env']
          : fromPersona !== null
            ? [{ kind: 'value', text: valueText(fromPersona) }, 'persona']
            : [knob.default === null ? { kind: 'unset' } : { kind: 'value', text: knob.default }, 'default'];
      return {
        name: knob.name,
        group: 'Teammate launch',
        summary: knob.envName ? `${knob.summary} ${knob.envName} outranks it.` : knob.summary,
        value,
        source,
        default: knob.default,
        definedAt: definedAt(knob.definedIn, locatorName(knob.name), knob.anchor),
        change: source === 'env' ? 'env' : knob.change,
      };
    }),
  };
}

function pathValue(draft: unknown, path: string): unknown {
  let at: unknown = draft;
  for (const key of path.split('.')) {
    if (typeof at !== 'object' || at === null || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

export interface ProfileRow {
  entity_id: string;
  status: string;
  version: number;
  draft_json: Record<string, unknown>;
}

export function profileSubject(row: ProfileRow): ConfigSubjectView {
  const name = typeof row.draft_json.name === 'string' ? row.draft_json.name : row.entity_id;
  return {
    id: row.entity_id,
    name: `${name} (${row.status}, v${row.version})`,
    knobs: PROFILE_KNOBS.map((knob) => {
      const raw = pathValue(row.draft_json, knob.name);
      const set = raw !== undefined && raw !== null;
      return {
        name: knob.name,
        group: 'Interaction profile',
        summary: knob.summary,
        value: set ? { kind: 'value', text: valueText(raw) } : { kind: 'unset' },
        source: set && valueText(raw) !== knob.default ? 'profile' : 'default',
        default: knob.default,
        definedAt: definedAt(knob.definedIn, locatorName(knob.name), knob.anchor),
        change: knob.change,
      };
    }),
  };
}

export class ConfigsService {
  constructor(
    private readonly db: ConfigsDb,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly boot: () => NodeSettingsBoot = () => nodeSettingsBoot(env),
  ) {}

  /**
   * `node.settings.set` — store or clear one curated setting. The caller must
   * be a node admin on a human session (the RPC re-checks both). A value that
   * turns off the loopback auto-owner is refused from the auto-owner arm
   * itself, and the RPC refuses it unless the caller's account has a password:
   * the admin making the change must be able to sign in after the restart.
   */
  async setNodeSetting(
    caller: ConfigsCaller & { viaAutoOwner: boolean },
    name: string,
    raw: string | null,
  ): Promise<NodeSettingSetResult> {
    if (!this.canSeeNode(caller)) {
      throw new CollabError('forbidden', 'node settings are changed by a node admin on a human session');
    }
    const { def, value } = parseNodeSetting(name, raw);
    if (value !== null && def.disablesAutoOwner?.(value) && caller.viaAutoOwner) {
      throw new CollabError('forbidden', AUTO_OWNER_LOCKOUT, { details: { reason: 'auto_owner_lockout' } });
    }
    const stored = await this.db.tx(caller.claims, async (q) => {
      try {
        await q.query('select public.set_node_setting($1, $2)', [name, value]);
      } catch (error) {
        // The db layer maps 42501 to `forbidden`; a raw driver error keeps the SQLSTATE.
        const refused = error instanceof CollabError
          ? error.code === 'forbidden'
          : (error as { code?: string }).code === '42501';
        if (refused && value !== null && def.disablesAutoOwner?.(value)) {
          throw new CollabError('forbidden', AUTO_OWNER_LOCKOUT, { details: { reason: 'auto_owner_lockout' } });
        }
        throw error;
      }
      return storedSettings(q);
    });
    const state = nodeSettingState(name, stored, this.boot())!;
    return { name, stored: state.stored, pinnedByEnv: state.pinnedByEnv, restartPending: state.restartPending };
  }

  canSeeNode(caller: ConfigsCaller): boolean {
    return caller.claims.nodeAdmin === true
      && isHumanAuthKind(caller.authKind);
  }

  async read(caller: ConfigsCaller, spaceId: string): Promise<SpaceConfigsView> {
    const nodeVisible = this.canSeeNode(caller);
    const { teammates, profiles, stored, nodePolicy } = await this.db.tx(caller.claims, async (q) => {
      const space = await q.query<{ id: string }>('select id from public.spaces where id = $1', [spaceId]);
      if (!space[0]) throw new CollabError('not_found', `space ${spaceId} not found`);
      const teammates = await q.query<TeammateRow>(
        `select tm.entity_id, tm.name, tm.agent_tool, tm.model, tm.permission_mode, tm.capabilities
           from public.team_members tm
           join public.entities e on e.id = tm.entity_id
          where e.space_id = $1 and e.deleted_at is null
          order by tm.name, tm.entity_id`,
        [spaceId],
      );
      const profiles = await q.query<ProfileRow>(
        `select p.entity_id, p.status, v.version, v.draft_json
           from public.interaction_profiles p
           join public.entities e on e.id = p.entity_id
           join public.interaction_profile_versions v
             on v.profile_id = p.entity_id
            and v.version = coalesce(p.active_version, p.current_draft_version)
          where e.space_id = $1 and e.deleted_at is null and p.status <> 'retired'
          order by p.created_at, p.entity_id`,
        [spaceId],
      );
      // Node admin and human only, like the env it sits beside.
      const stored = nodeVisible ? await storedSettings(q) : {};
      const nodePolicy = nodeVisible
        ? (await q.query<{ policy: Record<string, boolean> | null }>(
            'select public.read_node_credential_policy() as policy',
          ))[0]?.policy ?? {}
        : null;
      return { teammates, profiles, stored, nodePolicy };
    });
    return {
      spaceId,
      node: nodeVisible
        ? { visible: true, knobs: nodeKnobs(this.env, stored, this.boot()), warnings: nodeWarnings(this.env, nodePolicy) }
        : { visible: false, reason: NODE_CONFIG_HIDDEN },
      cli: cliKnobs(),
      code: codeKnobs(),
      teammates: teammates.map((row) => teammateSubject(row, nodeVisible ? this.env : null)),
      profiles: profiles.map(profileSubject),
    };
  }
}

async function storedSettings(q: Querier): Promise<StoredNodeSettings> {
  const rows = await q.query<{ settings: StoredNodeSettings | null }>(
    'select public.node_settings_list() as settings',
  );
  return rows[0]?.settings ?? {};
}
