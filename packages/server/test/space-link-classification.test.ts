/**
 * #884 (security re-review R-1, W9 v4): every catalog op that could start a
 * session or process, mint a side-channel grant or read a session body is
 * CLASSIFIED for spaceLinks.invoke. It is either refused at home by
 * SPACE_LINK_REFUSED / spaceLinkRefusal, or listed in PASSES below with why
 * it starts nothing. A new op in a watched namespace, or with a watched word in
 * its name, fails this test until someone decides which it is.
 *
 * W7b (lane L4) DELIBERATELY reverses #884's "no link spawn" for three ops.
 * The owner decided it in form response 01a0fbb4 (decisions D1, D4 and D8:
 * "if link is there spawn for now", no budget): `execution.spawn`,
 * `execution.resume` and `execution.dispatch` are SPACE_LINK_SPAWN_OPS. They
 * are classified here as passing BY SWITCH: refused while the caller's row has
 * allow_spawn off (or unread), passing only while it is on. Explicit credential
 * fields stay refused whatever the switch. `chat.start`, `chat.setModel`,
 * `execution.prompt` and `execution.terminal.start` stay refused.
 */
import { OPERATIONS, SPACE_LINK_OWN_SPAWN_OPS, SPACE_LINK_REFUSED, SPACE_LINK_SPAWN_OPS, spaceLinkRefusal } from '@tm8/contract';

import { withoutMintedTokens } from '../src/facade/handlers/w2/space-link-invoke.js';
import { describe, expect, it } from 'vitest';

const WATCHED_NAMESPACE = /^(execution|containers|chat|launch|voice|auth|serverConnections|credentials|node\.credentials|spaceLinks|files|artifacts|projects\.folderUploads|forms|agent|agents|sessions)\./;
const WATCHED_WORD = /(spawn|start|resume|dispatch|terminal|attach|grant|token|upload|expose|endpoint|preview|redeliver|run|exec|prompt|fork|wake|relay|session|submit|journal|transcript)/i;

/** Watched ops the executor admits, each with why it starts, grants and reads nothing of that class. */
const PASSES: Record<string, string> = {
  'execution.terminate': 'stops a session; starts nothing',
  'execution.complete': 'settles a session outcome (Spec D1); starts nothing — closeProcess only terminates',
  'execution.sessions.share': 'changes sharing on B\'s own entity; mints no bearer',
  'execution.launch': 'reads the launch posture; no body, no token',
  'execution.liveness': 'reads liveness flags',
  'execution.dispatchers': 'reads the dispatcher list (ids, titles, liveness); starts nothing, no body, no token',
  'containers.stop': 'stops',
  'containers.pause': 'stops',
  'containers.destroy': 'stops',
  'containers.update': 'edits a stopped definition; starts nothing',
  'containers.policy.set': 'policy edit; starts nothing',
  'containers.snapshot': 'snapshots; starts nothing',
  'containers.unexpose': 'withdraws a URL',
  'containers.files.put': 'writes a file through the provider API; no process',
  'containers.files.get': 'reads a file through the provider API; no process',
  'containers.logs': 'reads logs',
  'containers.proxy': 'proxied request to an already running container, authorised per op here',
  'containers.providers.list': 'reads the provider list',
  'containers.stream': 'a stream op: refused by the executor (stream_op) before this list',
  'launch.suggest': 'credential USE of the advisor key as the member; starts no session',
  'launch.defaults': 'reads launch defaults',
  'files.uploadComplete': 'finishes an upload whose grant was refused at init',
  'files.uploadAbort': 'aborts an upload',
  'files.download': 'returns bytes in the response; no capability',
  'projects.folderUploads.complete': 'finishes an upload whose grant was refused at init',
  'projects.folderUploads.abort': 'aborts an upload',
  'artifacts.create': 'stores bytes as an entity; no process, no capability URL',
  'artifacts.publish': 'stores bytes as an entity; no process, no capability URL',
  'artifacts.revisions.list': 'read',
  'artifacts.export': 'returns bytes in the response; no capability',
  'artifacts.restore': 'entity revision restore',
  'skills.preview': 'renders text in the response; starts nothing',
  'interactionProfiles.preview': 'renders text in the response; starts nothing',
  'projects.files.attach': 'links an existing file entity; no upload grant',
  'messages.attachments.add': 'links an existing file entity to a message; no upload grant',
  'messages.attachments.remove': 'unlinks',
  'spaceLinks.list': 'read of the member\'s own links, no token',
  'spaceLinks.audit': 'read of audit rows, no token',
  'spaceLinks.inbound.list': 'read of the links into B, B admin only in SQL (278); no token',
  'spaceLinks.inbound.audit': 'read of audit rows scoped to B, B admin only in SQL (278); no token',
  'forms.create': 'refused by INPUT when its delivery can resume or spawn (formDeliveryCanStart)',
  'forms.update': 'refused by INPUT when it sets a delivery that can resume or spawn',
  'forms.responses.save': 'a draft; delivers nothing',
  'forms.responses.discard': 'drops a draft',
  'forms.responses.get': 'read',
  'forms.responses.list': 'read',
  'forms.responses.mine': 'read',
  'forms.pendingForSessions': 'read',
  'forms.transition': 'lifecycle; opening a form delivers nothing',
  'forms.questions.add': 'edit',
  'forms.questions.move': 'edit',
  'forms.questions.remove': 'edit',
  'forms.questions.update': 'edit',
};

/** Start ops that pass only with the row's allow_spawn on (W7b, owner form response 01a0fbb4). */
const BY_SWITCH: Record<string, string> = {
  'execution.spawn': 'starts a session in B: only with allow_spawn on; B\'s default credential only (W7b)',
  'execution.resume': 'resumes a session in B: only with allow_spawn on; re-minted under the link (W7b)',
  'execution.dispatch': 'may spawn B\'s dispatcher: only with allow_spawn on (W7b)',
};

/** PASSES entries refused or admitted by their INPUT; the name alone decides nothing. */
const BY_INPUT = new Set(['forms.create', 'forms.update']);

const refusedByName = (op: string, kind: 'read' | 'command' | 'stream'): string | null =>
  spaceLinkRefusal(op, kind, {}, true);

describe('spaceLinks.invoke classification — every start, grant and session-body op is decided', () => {
  const watched = OPERATIONS.filter((o) => WATCHED_NAMESPACE.test(o.name) || WATCHED_WORD.test(o.name));

  it('the walk sees the ops it must (guards against an empty or renamed catalog)', () => {
    const names = watched.map((o) => o.name);
    for (const op of ['execution.spawn', 'execution.terminal.start', 'execution.journal', 'containers.start', 'forms.responses.submit']) {
      expect(names).toContain(op);
    }
  });

  it('every watched op is refused at home or listed in PASSES or BY_SWITCH with a reason', () => {
    const unclassified = watched
      .filter((o) => refusedByName(o.name, o.kind as 'read' | 'command' | 'stream') === null && o.kind !== 'stream')
      .map((o) => o.name)
      .filter((name) => !(name in PASSES) && !(name in BY_SWITCH));
    expect(unclassified).toEqual([]);
  });

  it('BY_SWITCH is exactly SPACE_LINK_SPAWN_OPS: refused with allow_spawn off or unknown, passing only when on', () => {
    expect(Object.keys(BY_SWITCH).sort()).toEqual([...SPACE_LINK_SPAWN_OPS].sort());
    for (const op of SPACE_LINK_SPAWN_OPS) {
      expect(spaceLinkRefusal(op, 'command', {}, false)).toBe('spawn_switch_off');
      expect(spaceLinkRefusal(op, 'command', {}, true)).toBeNull();
      // Before the row is read the switch is unknown: not refused by it, and
      // the invoke handler re-checks with the row's value (fail closed).
      expect(spaceLinkRefusal(op, 'command', {}, undefined)).toBeNull();
    }
  });

  it('a spawn op naming a credential source is refused whatever the switch (F9, K11)', () => {
    for (const input of [{ credentialSources: { anthropic: 'space' } }, { credentialSource: 'member' }, { spaceCredentialIds: { anthropic: 'x' } }]) {
      for (const allow of [true, false, undefined]) {
        expect(spaceLinkRefusal('execution.spawn', 'command', input, allow)).toBe('spawn_explicit_credentials');
      }
    }
  });

  it('the other session starts stay refused at home (process_start), switch on', () => {
    for (const op of ['chat.start', 'chat.setModel', 'execution.prompt', 'execution.terminal.start', 'forms.responses.submit']) {
      expect(spaceLinkRefusal(op, 'command', {}, true)).toBe('process_start');
    }
  });

  it('entities.refs.add is refused through a link (L3: no transitive link use); list and remove pass', () => {
    expect(spaceLinkRefusal('entities.refs.add', 'command', {}, true)).toBe('link_management');
    expect(spaceLinkRefusal('entities.refs.list', 'read', {}, true)).toBeNull();
    expect(spaceLinkRefusal('entities.refs.remove', 'command', {}, true)).toBeNull();
  });

  it('299 — a session body is refused unless B confirmed the caller\'s own link spawn; nothing else is opened by that flag', () => {
    expect(Object.keys(SPACE_LINK_OWN_SPAWN_OPS).sort()).toEqual(['execution.journal', 'execution.transcript']);
    for (const op of Object.keys(SPACE_LINK_OWN_SPAWN_OPS)) {
      const kind = OPERATIONS.find((o) => o.name === op)!.kind as 'read';
      expect(spaceLinkRefusal(op, kind, {}, true)).toBe('session_body');
      expect(spaceLinkRefusal(op, kind, {}, true, false)).toBe('session_body');
      expect(spaceLinkRefusal(op, kind, {}, true, true)).toBeNull();
      // The param names the session B checks: the catalog path carries it.
      expect(OPERATIONS.find((o) => o.name === op)!.path).toContain(`:${SPACE_LINK_OWN_SPAWN_OPS[op]}`);
    }
    // ownSpawn opens no other refused op, a prefix one included.
    for (const op of ['execution.prompt', 'execution.terminal.start', 'execution.streams.attach', 'credentials.status', 'execution.gitStatus']) {
      expect(spaceLinkRefusal(op, 'command', {}, true, true)).toBe(spaceLinkRefusal(op, 'command', {}, true));
    }
  });

  it('299 — a session body crossing a link carries no minted token; other text and shapes are kept', () => {
    const token = ['tm8s', 'abc123_def-456'].join('_');
    const page = { sessionId: 'x', turns: [{ text: `run ${token} now` }, { text: `"${['tm8g', 'q'].join('_')}"` }], n: 3 };
    expect(withoutMintedTokens(page)).toEqual({
      sessionId: 'x', turns: [{ text: 'run tm8s_<redacted> now' }, { text: '"tm8g_<redacted>"' }], n: 3,
    });
    const clean = { a: 'tm8 says hi', b: [1, null] };
    expect(withoutMintedTokens(clean)).toBe(clean);
    expect(withoutMintedTokens(undefined)).toBeUndefined();
  });

  it('PASSES holds no op that is refused anyway, and no op missing from the catalog', () => {
    const byName = new Map<string, (typeof OPERATIONS)[number]>(OPERATIONS.map((o) => [o.name, o]));
    const stale = Object.keys(PASSES).filter((name) => !byName.has(name));
    expect(stale).toEqual([]);
    const refused = Object.keys(PASSES).filter((name) => !BY_INPUT.has(name) && refusedByName(name, byName.get(name)!.kind as 'read' | 'command') !== null);
    expect(refused).toEqual([]);
    expect(Object.keys(BY_SWITCH).filter((name) => name in PASSES)).toEqual([]);
  });

  it('every exact refused entry names a real catalog op (a typo would refuse nothing)', () => {
    const names = new Set<string>(OPERATIONS.map((o) => o.name));
    const missing = SPACE_LINK_REFUSED.filter((e) => e.exact === true && !names.has(e.prefix)).map((e) => e.prefix);
    expect(missing).toEqual([]);
  });

  it('every prefix refused entry catches at least one catalog op', () => {
    const empty = SPACE_LINK_REFUSED.filter((e) => e.exact !== true && !OPERATIONS.some((o) => o.name.startsWith(e.prefix)))
      .map((e) => e.prefix);
    expect(empty).toEqual([]);
  });
});
