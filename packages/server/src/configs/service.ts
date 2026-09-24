/**
 * `spaces.configs` — resolves the registry into what the Configs page shows.
 *
 * REDACTION HAPPENS HERE, before anything is serialized: a `secret` env knob
 * becomes `{ kind: 'secret', present }` and its value is never read into the
 * answer. Node env is resolved only for a node admin on a human session; every
 * other caller gets `node: { visible: false }` and no env value at all.
 */
import { CollabError } from '@tm8/contract';
import type {
  ConfigKnobView,
  ConfigSubjectView,
  ConfigValue,
  SpaceConfigsView,
} from '@tm8/contract';
import { asHarnessSurface, asPermissionMode, asReadHints, memberLaunchPreferences } from '@tm8/execution';

import type { DbClaims, Querier } from '../db/types.js';
import { definedAt } from './locate.js';
import {
  CLI_ENV,
  CODE_CONSTANTS,
  NODE_ENV,
  PROFILE_KNOBS,
  TEAMMATE_KNOBS,
  type EnvKnob,
} from './registry.js';

const HUMAN_AUTH_KINDS: readonly string[] = ['browser', 'cli'];

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

export function nodeKnobs(env: NodeJS.ProcessEnv): ConfigKnobView[] {
  return NODE_ENV.map((knob) => {
    const { value, set } = envValue(knob, env);
    return {
      name: knob.name,
      group: knob.group,
      summary: knob.summary,
      value,
      source: set ? 'env' : 'default',
      default: knob.default,
      definedAt: definedAt(knob.definedIn, knob.name),
      change: 'env',
    };
  });
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
  const prefs = memberLaunchPreferences(row.capabilities);
  const persona: Record<string, unknown> = {
    // Every key the spawn path's parser returns, so a new launch key needs only
    // its registry row (which the registry test demands).
    ...Object.fromEntries(Object.entries(prefs).map(([key, value]) => [`capabilities.launch.${key}`, value])),
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
  ) {}

  canSeeNode(caller: ConfigsCaller): boolean {
    return caller.claims.nodeAdmin === true
      && caller.authKind !== undefined
      && HUMAN_AUTH_KINDS.includes(caller.authKind);
  }

  async read(caller: ConfigsCaller, spaceId: string): Promise<SpaceConfigsView> {
    const nodeVisible = this.canSeeNode(caller);
    const { teammates, profiles } = await this.db.tx(caller.claims, async (q) => {
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
      return { teammates, profiles };
    });
    return {
      spaceId,
      node: nodeVisible
        ? { visible: true, knobs: nodeKnobs(this.env) }
        : { visible: false, reason: NODE_CONFIG_HIDDEN },
      cli: cliKnobs(),
      code: codeKnobs(),
      teammates: teammates.map((row) => teammateSubject(row, nodeVisible ? this.env : null)),
      profiles: profiles.map(profileSubject),
    };
  }
}
