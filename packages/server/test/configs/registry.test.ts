/**
 * The config registry's three promises: every `definedAt` points at the line
 * that defines the knob, every `env.TM8_*` read in a package source is listed,
 * and no secret value ever reaches the serialized answer.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { memberLaunchPreferences } from '@tm8/execution';
import { InteractionProfileDraftSchema } from '@tm8/contract';
import { BYTE_BUDGETS } from '@tm8/prompt';

import {
  CLI_ENV,
  CODE_CONSTANTS,
  NODE_ENV,
  NOT_CONFIG_ENV,
  NOT_POLICY_CONSTANTS,
  NOT_PROFILE_KNOBS,
  POLICY_FILES,
  PROFILE_KNOBS,
  TEAMMATE_KNOBS,
} from '../../src/configs/registry.js';
import { codeKnobs } from '../../src/configs/service.js';
import { ConfigsService, NODE_CONFIG_HIDDEN, type ConfigsDb } from '../../src/configs/service.js';
import type { DbClaims } from '../../src/db/types.js';

const REPO = resolve(__dirname, '../../../..');
const SPACE = '00000000-0000-4000-8000-000000000001';

function lineAt(definedAt: string): string {
  const [file, line] = definedAt.split(':');
  const lines = readFileSync(join(REPO, file!), 'utf8').split('\n');
  return lines[Number(line) - 1] ?? '';
}

/** The token the defining line must contain. */
function anchorOf(name: string): string {
  if (name.startsWith('capabilities.launch.')) return 'memberLaunchPreferences';
  return name.split('.').pop()!;
}

describe('config registry', () => {
  const all = [
    ...NODE_ENV,
    ...CLI_ENV,
    ...CODE_CONSTANTS,
    ...TEAMMATE_KNOBS,
    ...PROFILE_KNOBS,
  ];

  it.each(all.map((k) => [k.name, k.definedAt]))('%s is defined at %s', (name, definedAt) => {
    expect(lineAt(definedAt)).toContain(anchorOf(name));
  });

  it('names each env knob once', () => {
    const names = [...NODE_ENV, ...CLI_ENV].map((k) => k.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists every env.TM8_* read in the package sources', () => {
    const listed = new Set([...NODE_ENV, ...CLI_ENV].map((k) => k.name).concat(Object.keys(NOT_CONFIG_ENV)));
    const found = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/test/.test(entry)) {
          for (const m of readFileSync(path, 'utf8').matchAll(/env(?:\.|\[['"])(TM8_[A-Z0-9_]+)/g)) {
            if (!found.has(m[1]!)) found.set(m[1]!, path.slice(REPO.length + 1));
          }
        }
      }
    };
    for (const pkg of ['server', 'execution', 'cli', 'prompt', 'jev', 'mcp', 'contract']) {
      walk(join(REPO, 'packages', pkg, 'src'));
    }
    const missing = [...found].filter(([name]) => !listed.has(name)).map(([n, f]) => `${n} (${f})`);
    expect(missing).toEqual([]);
  });

  it('lists every capabilities.launch key the spawn path parses', () => {
    const parsed = Object.keys(memberLaunchPreferences({ launch: {} })).map((k) => `capabilities.launch.${k}`);
    const listed = new Set(TEAMMATE_KNOBS.map((k) => k.name));
    expect(parsed.filter((name) => !listed.has(name))).toEqual([]);
    expect([...listed].filter((n) => n.startsWith('capabilities.launch.') && !parsed.includes(n))).toEqual([]);
  });

  it('lists every exported constant in the policy files', () => {
    const listed = new Set([...CODE_CONSTANTS.map((c) => c.name), ...Object.keys(NOT_POLICY_CONSTANTS)]);
    const missing: string[] = [];
    for (const file of POLICY_FILES) {
      for (const m of readFileSync(join(REPO, file), 'utf8').matchAll(/^export const ([A-Z][A-Z0-9_]+)\b/gm)) {
        if (!listed.has(m[1]!)) missing.push(`${m[1]} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lists every leaf of the interaction-profile draft schema', () => {
    // Walks the contract's own Zod schema, so a field added there (a budget,
    // a floor) fails here until it has a PROFILE_KNOBS row or a stated reason.
    type Def = { typeName?: string; innerType?: unknown; schema?: unknown; shape?: () => Record<string, unknown> };
    const leaves = (schema: unknown, path: string[] = []): string[] => {
      let def = (schema as { _def?: Def })._def;
      while (def && (def.innerType || def.schema)) def = ((def.innerType ?? def.schema) as { _def?: Def })._def;
      if (def?.typeName === 'ZodObject') {
        return Object.entries(def.shape!()).flatMap(([key, child]) => leaves(child, [...path, key]));
      }
      return [path.join('.')];
    };
    const listed = new Set([...PROFILE_KNOBS.map((k) => k.name), ...Object.keys(NOT_PROFILE_KNOBS)]);
    const all = leaves(InteractionProfileDraftSchema);
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((path) => !listed.has(path))).toEqual([]);
    expect([...listed].filter((path) => !all.includes(path))).toEqual([]);
  });

  it('shows every BYTE_BUDGETS key, live', () => {
    const text = codeKnobs().find((k) => k.name === 'BYTE_BUDGETS')!.value;
    for (const key of Object.keys(BYTE_BUDGETS)) expect(JSON.stringify(text)).toContain(key);
  });

  it('reports each code constant from its live value', () => {
    for (const c of CODE_CONSTANTS) expect(c.read()).not.toBeUndefined();
  });
});

function fakeDb(rows: { teammates?: unknown[]; profiles?: unknown[] } = {}): ConfigsDb {
  return {
    tx: async (_claims, fn) =>
      fn({
        query: async (sql: string) => {
          if (sql.includes('from public.spaces')) return [{ id: SPACE }];
          if (sql.includes('from public.team_members')) return rows.teammates ?? [];
          return rows.profiles ?? [];
        },
      } as never),
  };
}

const ADMIN: DbClaims = { identityId: 'i', nodeAdmin: true } as DbClaims;
const MEMBER: DbClaims = { identityId: 'i', nodeAdmin: false } as DbClaims;

describe('spaces.configs redaction', () => {
  const env = {
    TM8_DATABASE_URL: 'postgres://u:hunter2@db/tm8',
    TYPESAFE_API_KEY: 'ts-SECRET-KEY',
    TM8_HARNESS_SURFACE: 'inherit',
    TM8_DB_POOL_MAX: '16',
  };
  const teammate = {
    entity_id: 't1',
    name: 'Ada',
    agent_tool: 'claude-code',
    model: 'opus',
    permission_mode: null,
    capabilities: { launch: { harnessSurface: 'minimal', plugins: ['sales'], mcpServers: { linear: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer mcp-SECRET' } } } } },
  };

  it('shows a node admin env values, secrets as presence only', async () => {
    const view = await new ConfigsService(fakeDb({ teammates: [teammate] }), env)
      .read({ claims: ADMIN, authKind: 'browser' }, SPACE);
    const wire = JSON.stringify(view);
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('ts-SECRET-KEY');
    expect(wire).not.toContain('mcp-SECRET');
    expect(view.teammates[0]!.knobs.find((k) => k.name === 'capabilities.launch.mcpServers')!.value)
      .toEqual({ kind: 'value', text: '["linear"]' });
    if (!view.node.visible) throw new Error('node hidden');
    const byName = new Map(view.node.knobs.map((k) => [k.name, k]));
    expect(byName.get('TM8_DATABASE_URL')!.value).toEqual({ kind: 'secret', present: true });
    expect(byName.get('TM8_LIVEKIT_API_SECRET')!.value).toEqual({ kind: 'secret', present: false });
    expect(byName.get('TM8_DB_POOL_MAX')).toMatchObject({ value: { kind: 'value', text: '16' }, source: 'env' });
    expect(byName.get('TM8_PORT')).toMatchObject({ value: { kind: 'unset' }, source: 'default', default: '4610' });
    // Node env outranks the persona, as the spawn path does.
    const surface = view.teammates[0]!.knobs.find((k) => k.name === 'capabilities.launch.harnessSurface')!;
    expect(surface).toMatchObject({ value: { kind: 'value', text: 'inherit' }, source: 'env' });
  });

  it('hides node env from a plain member and from an agent session', async () => {
    for (const caller of [
      { claims: MEMBER, authKind: 'browser' },
      { claims: ADMIN, authKind: 'agent' },
    ]) {
      const view = await new ConfigsService(fakeDb({ teammates: [teammate] }), env).read(caller, SPACE);
      expect(view.node).toEqual({ visible: false, reason: NODE_CONFIG_HIDDEN });
      const wire = JSON.stringify(view);
      expect(wire).not.toContain('hunter2');
      expect(wire).not.toContain('TM8_DB_POOL_MAX');
      // The persona value, not the env value the caller may not see.
      const surface = view.teammates[0]!.knobs.find((k) => k.name === 'capabilities.launch.harnessSurface')!;
      expect(surface).toMatchObject({ value: { kind: 'value', text: 'minimal' }, source: 'persona' });
      expect(view.code.length).toBe(CODE_CONSTANTS.length);
    }
  });

  it('never reports a CLI env value', async () => {
    const view = await new ConfigsService(fakeDb(), { TM8_BASE_URL: 'http://x' })
      .read({ claims: ADMIN, authKind: 'cli' }, SPACE);
    expect(view.cli.every((k) => k.value.kind === 'unobservable')).toBe(true);
  });

  it('reads profile values by path against the core default', async () => {
    const view = await new ConfigsService(fakeDb({
      profiles: [{
        entity_id: 'p1', status: 'active', version: 3,
        draft_json: { name: 'Lean', promptPolicy: { kernelTemplate: 'tm8.core.v2', kernelMaxBytes: 6144 } },
      }],
    }), {}).read({ claims: MEMBER, authKind: 'browser' }, SPACE);
    const knobs = new Map(view.profiles[0]!.knobs.map((k) => [k.name, k]));
    expect(view.profiles[0]!.name).toBe('Lean (active, v3)');
    expect(knobs.get('promptPolicy.kernelTemplate')).toMatchObject({ value: { kind: 'value', text: 'tm8.core.v2' }, source: 'profile' });
    expect(knobs.get('promptPolicy.kernelMaxBytes')).toMatchObject({ source: 'default' });
    expect(knobs.get('feedPolicy.pageSize')!.value).toEqual({ kind: 'unset' });
  });
});
