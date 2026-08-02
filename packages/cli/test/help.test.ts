/**
 * The seven help surfaces — the UNION of grammar §4.16 and harness §7.2-§7.4 —
 * their byte caps, and the honesty rules that are gate items.
 *
 * Conformance coverage asserted here: D2 (exact lookup works for every catalog
 * operation and returns one digest), D3 (every public/composite operation is
 * reachable from a noun shard and every operation has intent tags), D4 (root
 * help stays under 8 KiB and carries no operation-row array or full schemas),
 * D5 (intent search returns at most five matches and never invents an
 * operation), D7 (reserved/internal help explains exposure and owner without an
 * executable public syntax).
 */
import { describe, expect, it } from 'vitest';
import { OPERATIONS, type OperationName } from '@tm8/contract';
import {
  CAPS,
  byteLength,
  commandHelp,
  nounHelp,
  operationHelp,
  rootHelp,
  searchHelp,
} from '../src/discovery/help.js';
import { CATALOG_DIGEST, PUBLIC_NOUNS, commands, discoveryFor } from '../src/discovery/operations.js';
import { completionScript } from '../src/discovery/completion.js';
import { createOutput } from '../src/output.js';
import { help } from '../src/commands/help.js';
import { parseInvocation } from '../src/args.js';

const json = (dto: unknown): string => JSON.stringify(dto);

describe('root help — tm8.help.v1, 8 KiB HARD (conformance D4)', () => {
  const root = rootHelp();

  it('is the right schema and carries the computed catalog digest', () => {
    expect(root.schemaVersion).toBe('tm8.help.v1');
    expect(root.grammarVersion).toBe('2');
    expect(root.catalogDigest).toBe(CATALOG_DIGEST);
  });

  it('stays inside 8192 BYTES — measured in bytes, never tokens', () => {
    expect(CAPS.root).toBe(8192);
    expect(byteLength(root)).toBeLessThanOrEqual(CAPS.root);
  });

  it('names EVERY public noun with a one-line summary, inside the cap', () => {
    expect(root.nouns.map((n) => n.name).sort()).toEqual([...PUBLIC_NOUNS].sort());
    for (const n of root.nouns) {
      expect(n.summary.length, n.name).toBeGreaterThan(5);
      expect(n.helpRef, n.name).toBe(`tm8://help/${n.name}`);
    }
    expect(root.truncated).toBeUndefined();
  });

  it('contains NO operation-row array and NO schemas — it points, it does not inline', () => {
    expect(root).not.toHaveProperty('operations');
    const text = json(root);
    expect(text).not.toContain('inputSchemaRef');
    expect(text).not.toContain('"properties"');
    // Anti-bloat rule 3: no examples in root help.
    expect(root).not.toHaveProperty('examples');
    // A whole operation name in root help would be an operation row leaking in.
    expect(text).not.toContain('entities.patch');
  });

  it('teaches the four discovery methods plus completion', () => {
    expect(root.discovery.noun).toContain('tm8 help <noun>');
    expect(root.discovery.command).toContain('tm8 help <noun> <verb>');
    expect(root.discovery.intent).toContain('--query');
    expect(root.discovery.operation).toContain('--operation');
    expect(root.discovery.completion).toContain('tm8 completion');
  });

  it('names the UNIT on every dimensioned global option', () => {
    const timeout = root.globalOptions.find((o) => o.option.startsWith('--timeout'));
    expect(timeout?.option).toBe('--timeout <seconds>');
    // An unlabelled duration is how 30 seconds silently becomes 30 milliseconds.
    expect(json(root)).not.toMatch(/--timeout <n>/);
  });
});

describe('noun shards — 12 KiB HARD (conformance D3)', () => {
  it('every public noun has a shard, and every shard fits', () => {
    expect(CAPS.noun).toBe(12288);
    let checked = 0;
    for (const noun of PUBLIC_NOUNS) {
      const shard = nounHelp(noun);
      expect(shard, noun).toBeDefined();
      expect(shard?.schemaVersion, noun).toBe('tm8.help.noun.v1');
      expect(shard?.catalogDigest, noun).toBe(CATALOG_DIGEST);
      expect(byteLength(shard), noun).toBeLessThanOrEqual(CAPS.noun);
      checked++;
    }
    expect(checked).toBe(PUBLIC_NOUNS.length);
    expect(checked).toBeGreaterThanOrEqual(26);
  });

  it('D3: every public and composite operation is reachable from some noun shard', () => {
    const reachable = new Set<string>();
    for (const noun of PUBLIC_NOUNS) {
      const shard = nounHelp(noun);
      for (const c of shard?.commands ?? []) for (const op of c.operations) reachable.add(op);
      for (const o of shard?.operationsWithoutCommand ?? []) reachable.add(o.operation);
    }
    const wanted = OPERATIONS.filter((o) => {
      const e = discoveryFor(o.name).exposure;
      return e === 'public' || e === 'composite';
    }).map((o) => o.name);
    expect(wanted).toHaveLength(122); // 121 -> 125 (2026-08-02): auth.* Identity v2 Stage 1 (4 ops, all public, all with commands).
    for (const op of wanted) expect(reachable.has(op), `${op} is unreachable from any noun shard`).toBe(true);
  });

  it('D3: every one of the 125 operations has intent tags', () => {
    let swept = 0;
    for (const op of OPERATIONS) {
      expect(discoveryFor(op.name).intentTags.length, op.name).toBeGreaterThan(0);
      swept++;
    }
    expect(swept).toBe(125);
  });

  it('a family noun whose command lives elsewhere still resolves', () => {
    expect(nounHelp('collection')?.commands.map((c) => c.command)).toContain('entity query');
    expect(nounHelp('read-mark')?.commands.map((c) => c.command)).toContain('message mark-read');
  });

  it('the `bridge` shard names its command-less operation instead of being empty', () => {
    const shard = nounHelp('bridge');
    expect(shard?.commands).toEqual([]);
    expect(shard?.operationsWithoutCommand.map((o) => o.operation)).toEqual(['bridge.fetchBlob']);
  });

  it('an unknown noun is undefined, not an invented shard', () => {
    expect(nounHelp('nonsense')).toBeUndefined();
  });
});

describe('command shards — tm8.help.command.v1, 16 KiB HARD', () => {
  it('every registered command has a shard that fits, with at most two examples', () => {
    expect(CAPS.command).toBe(16384);
    let checked = 0;
    for (const c of commands()) {
      const shard = commandHelp(c.path);
      expect(shard, c.command).toBeDefined();
      expect(shard?.schemaVersion, c.command).toBe('tm8.help.command.v1');
      expect(byteLength(shard), c.command).toBeLessThanOrEqual(CAPS.command);
      expect(shard?.examples.length, c.command).toBeLessThanOrEqual(2);
      expect(shard?.syntax, c.command).toContain('tm8 ');
      checked++;
    }
    expect(checked).toBe(commands().length);
    expect(checked).toBeGreaterThan(90);
  });

  it('examples use placeholders, never anything that looks like real workspace data', () => {
    for (const c of commands()) {
      for (const ex of commandHelp(c.path)?.examples ?? []) {
        expect(ex, ex).toMatch(/<[a-z-]+>/);
        // No concrete ids: a placeholder is `<entity-id>`, never `ent_7f3a`.
        expect(ex, ex).not.toMatch(/\b(ent|tsk|msg|ws|spc)_[a-z0-9]{3,}/i);
      }
    }
  });

  it('`message send` renders the §7.3 contract fields', () => {
    const shard = commandHelp(['message', 'send']);
    expect(shard?.command).toBe('message send');
    expect(shard?.operations).toEqual(['messages.post']);
    expect(shard?.exposure).toBe('composite');
    expect(shard?.sideEffect).toBe('durable');
    expect(shard?.idempotency).toBe('required');
    expect(shard?.inputSchemaRef).toBe('tm8://schema/messages.post/input');
    expect(shard?.outputSchemaRef).toBe('tm8://schema/messages.post/output');
    expect(shard?.trustNotes.join(' ')).toMatch(/untrusted/i);
    expect(shard?.errorRefs.length).toBeGreaterThan(0);
  });

  it('a mutation id is NEVER described as secret, private, or a capability', () => {
    // It is a published correlation id (messageBatchId, handoffId) by contract.
    // Text implying secrecy would teach a security property tm8 does not have.
    for (const c of commands()) {
      const text = json(commandHelp(c.path));
      if (!text.includes('mutation-id') && !text.includes('mutation id')) continue;
      expect(text, c.command).not.toMatch(/secret|confidential|do not share|keep .{0,12}private/i);
    }
  });

  it('an unknown command path is undefined, never a fabricated shard', () => {
    expect(commandHelp(['entity', 'yeet'])).toBeUndefined();
    expect(commandHelp(['session', 'prompt'])).toBeUndefined();
  });
});

describe('exact operation lookup — TOTAL over all 125 (conformance D2)', () => {
  it('succeeds for every catalog operation and returns ONE digest', () => {
    const digests = new Set<string>();
    const seen = new Set<string>();
    for (const op of OPERATIONS) {
      const shard = operationHelp(op.name);
      expect(shard, op.name).toBeDefined();
      expect(shard?.operations, op.name).toEqual([op.name]);
      expect(byteLength(shard), op.name).toBeLessThanOrEqual(CAPS.command);
      digests.add(shard?.catalogDigest as string);
      seen.add(op.name);
    }
    expect(seen.size).toBe(125);
    expect([...digests]).toEqual([CATALOG_DIGEST]);
  });

  it('D7: execution.prompt reports internal/use_message_send and NO invocation syntax', () => {
    const shard = operationHelp('execution.prompt');
    expect(shard?.exposure).toBe('internal');
    expect(shard?.reason).toBe('use_message_send');
    expect(shard?.publicComposite).toBe('messages.post');
    expect(shard?.command).toBeNull();
    expect(shard?.syntax).toBeNull();
    expect(shard?.examples).toEqual([]);
    const text = json(shard);
    expect(text).not.toContain('session prompt');
    expect(text).not.toMatch(/tm8 session/);
    // No bearer-selectable principal may be rendered.
    expect(text).not.toMatch(/--as |bearer|token/i);
  });

  it('D7: bridge.fetchBlob is discoverable, explains itself, and offers no syntax', () => {
    const shard = operationHelp('bridge.fetchBlob');
    expect(shard?.exposure).toBe('reserved');
    expect(shard?.command).toBeNull();
    expect(shard?.syntax).toBeNull();
    expect(shard?.availability).toBe('unavailable');
    expect(shard?.availabilityReason).toBe('reserved');
    expect(json(shard)).toMatch(/file download/);
  });

  it('ASYMMETRY: search.query DOES render a syntax, and says it is unavailable', () => {
    const shard = operationHelp('search.query');
    expect(shard?.command).toBe('search query');
    expect(shard?.syntax).toContain('tm8 search query');
    expect(shard?.availability).toBe('unavailable');
    expect(shard?.availabilityReason).toBe('reserved');
  });

  it('an unknown operation name is undefined, never a guessed row', () => {
    expect(operationHelp('entities.yeet' as OperationName)).toBeUndefined();
  });
});

describe('intent search — tm8.help.search.v1, 16 KiB AND at most 5 (conformance D5)', () => {
  it('returns at most five matches and never invents an operation', () => {
    const catalog = new Set(OPERATIONS.map((o) => o.name));
    let queries = 0;
    for (const q of [
      'reply to the coordinator',
      'how do I tell someone something',
      'mark a task done',
      'what am I allowed to do',
      'find my tasks',
      'upload a file',
      'start an agent',
      'zzzz nothing matches this at all',
    ]) {
      const res = searchHelp(q);
      expect(res.schemaVersion).toBe('tm8.help.search.v1');
      expect(res.query).toBe(q);
      expect(res.catalogDigest).toBe(CATALOG_DIGEST);
      expect(res.matches.length, q).toBeLessThanOrEqual(5);
      expect(byteLength(res), q).toBeLessThanOrEqual(CAPS.search);
      for (const m of res.matches) expect(catalog.has(m.operation), `${q} -> ${m.operation}`).toBe(true);
      queries++;
    }
    expect(queries).toBe(8);
  });

  it('is deterministic: the same query twice is the same ranking', () => {
    expect(searchHelp('reply to the coordinator')).toEqual(searchHelp('reply to the coordinator'));
  });

  it('routes communication intents to `message send`, not to a retired verb', () => {
    for (const q of ['reply to the coordinator', 'report progress', 'prompt the session']) {
      const top = searchHelp(q).matches[0];
      expect(top?.operation, q).toBe('messages.post');
      expect(top?.command, q).toBe('message send');
      expect(json(searchHelp(q)), q).not.toMatch(/tm8 (session prompt|report|progress|whoami)/);
    }
  });

  it('every match carries a reason and a helpRef so the answer is followable', () => {
    for (const m of searchHelp('find my tasks').matches) {
      expect(m.reason.length).toBeGreaterThan(5);
      expect(m.helpRef).toMatch(/^tm8:\/\/help\//);
    }
  });

  it('a query that matches nothing returns zero matches, not a hopeful guess', () => {
    expect(searchHelp('qqqxyzzy plugh').matches).toEqual([]);
  });
});

describe('every dimensioned value names its dimension, on EVERY surface', () => {
  /**
   * An unlabelled duration flag is how a 30-SECOND timeout silently becomes a
   * 30-millisecond one in somebody's script: the author reads "30" and believes
   * seconds, the CLI reads "30" and could mean anything. Help text is the only
   * place that ambiguity can be closed, so this sweeps every rendered surface
   * rather than trusting one spot-check.
   */
  const surfaces: { name: string; text: string }[] = [
    { name: 'root', text: json(rootHelp()) },
    ...PUBLIC_NOUNS.map((n) => ({ name: `noun:${n}`, text: json(nounHelp(n)) })),
    ...commands().map((c) => ({ name: `cmd:${c.command}`, text: json(commandHelp(c.path)) })),
    ...OPERATIONS.map((o) => ({ name: `op:${o.name}`, text: json(operationHelp(o.name)) })),
    ...(['bash', 'zsh', 'fish'] as const).map((s) => ({
      name: `completion:${s}`,
      text: completionScript(s),
    })),
  ];

  it('sweeps every surface: no surface names the timeout flag without naming SECONDS', () => {
    expect(surfaces.length).toBeGreaterThan(130);
    // fish spells long options `-l timeout`, so matching only `--timeout` would
    // silently skip the fish surface — the exact way a sweep passes while
    // proving less than it claims.
    const NAMES_TIMEOUT = /(?:--|-l )timeout/;
    let mentioning = 0;
    for (const s of surfaces) {
      expect(s.text, s.name).not.toMatch(/--timeout <n>/);
      if (!NAMES_TIMEOUT.test(s.text)) continue;
      mentioning++;
      // bash's `compgen -W` cannot carry per-option descriptions, so the
      // requirement is per-SURFACE rather than per-occurrence: a surface that
      // names the flag must also name its dimension somewhere a reader sees.
      expect(s.text, `${s.name} names the timeout flag but never its unit`).toMatch(
        /<seconds>|SECONDS/,
      );
    }
    // root help + all three completion scripts.
    expect(mentioning).toBe(4);
  });

  it('`--limit` is rendered as a count, never a bare <n>', () => {
    for (const c of commands()) {
      const syntax = commandHelp(c.path)?.syntax ?? '';
      if (!syntax.includes('--limit')) continue;
      expect(syntax, c.command).toContain('--limit <count>');
    }
  });
});

describe('byte caps are enforced by truncating LOUDLY, never silently', () => {
  it('truncation names the section, the count omitted, and how to fetch the rest', () => {
    // Drive the cap down so the enforcement path is exercised for real rather
    // than only on a shard that happens to fit today.
    const shard = nounHelp('entity', { cap: 900 });
    expect(byteLength(shard)).toBeLessThanOrEqual(900);
    expect(shard?.truncated).toBeDefined();
    expect(shard?.truncated?.section).toBe('commands');
    expect(shard?.truncated?.omitted).toBeGreaterThan(0);
    expect(shard?.truncated?.fetch).toContain('tm8 help');
    expect(shard?.truncated?.cursor).toMatch(/\S/);
  });

  it('a truncated search result says so too', () => {
    const res = searchHelp('message', { cap: 400 });
    expect(byteLength(res)).toBeLessThanOrEqual(400);
    if (res.matches.length < 5) expect(res.truncated).toBeDefined();
  });
});

describe('help router — quoted paths resolve like unquoted ones', () => {
  /** Capture one help() run: the emitted stdout bytes and the exit path. */
  const invoke = (args: string[]): { stdout: string; code: number } => {
    let stdout = '';
    const out = createOutput({
      format: 'json',
      streams: {
        stdout: (chunk: string | Uint8Array) => { stdout += String(chunk); },
        stderr: () => {},
      },
    });
    const code = help(args, parseInvocation(['help', ...args]).options, out);
    return { stdout, code };
  };

  it('`tm8 help "entity get"` (ONE argv element) is byte-identical to the unquoted form', () => {
    const quoted = invoke(['entity get']);
    const unquoted = invoke(['entity', 'get']);
    expect(quoted.code).toBe(0);
    expect(quoted.stdout).toBe(unquoted.stdout);
    expect(quoted.stdout).toContain('tm8.help.command.v1');
  });

  it('a quoted three-token path resolves too, and stray whitespace is harmless', () => {
    const quoted = invoke(['  space   task-axis create ']);
    const unquoted = invoke(['space', 'task-axis', 'create']);
    expect(quoted.stdout).toBe(unquoted.stdout);
  });

  it('a genuinely unknown command still fails with the ORIGINAL args in the message', () => {
    expect(() => invoke(['utterly bogus'])).toThrowError(/utterly bogus/);
  });
});
