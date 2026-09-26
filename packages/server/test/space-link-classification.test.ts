/**
 * #884 (security re-review R-1, W9 v4): every catalog op that could start a
 * session or process, mint a side-channel grant or read a session body is
 * CLASSIFIED for spaceLinks.invoke. It is either refused at home by
 * SPACE_LINK_REFUSED / spaceLinkRefusal, or listed in PASSES below with why
 * it starts nothing. A new op in a watched namespace, or with a watched word in
 * its name, fails this test until someone decides which it is.
 */
import { OPERATIONS, SPACE_LINK_REFUSED, spaceLinkRefusal } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

const WATCHED_NAMESPACE = /^(execution|containers|chat|launch|voice|auth|serverConnections|credentials|node\.credentials|spaceLinks|files|artifacts|projects\.folderUploads|forms|agent|agents|sessions)\./;
const WATCHED_WORD = /(spawn|start|resume|dispatch|terminal|attach|grant|token|upload|expose|endpoint|preview|redeliver|run|exec|prompt|fork|wake|relay|session|submit|journal|transcript)/i;

/** Watched ops the executor admits, each with why it starts, grants and reads nothing of that class. */
const PASSES: Record<string, string> = {
  'execution.terminate': 'stops a session; starts nothing',
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

  it('every watched op is refused at home or listed in PASSES with a reason', () => {
    const unclassified = watched
      .filter((o) => refusedByName(o.name, o.kind as 'read' | 'command' | 'stream') === null && o.kind !== 'stream')
      .map((o) => o.name)
      .filter((name) => !(name in PASSES));
    expect(unclassified).toEqual([]);
  });

  it('PASSES holds no op that is refused anyway, and no op missing from the catalog', () => {
    const byName = new Map<string, (typeof OPERATIONS)[number]>(OPERATIONS.map((o) => [o.name, o]));
    const stale = Object.keys(PASSES).filter((name) => !byName.has(name));
    expect(stale).toEqual([]);
    const refused = Object.keys(PASSES).filter((name) => !BY_INPUT.has(name) && refusedByName(name, byName.get(name)!.kind as 'read' | 'command') !== null);
    expect(refused).toEqual([]);
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
