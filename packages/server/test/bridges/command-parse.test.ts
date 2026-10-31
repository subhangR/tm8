/**
 * Bridges B1b-4 (BRIDGES-V2-DESIGN §4.2, §4.8 "Tests"): the parser, table-driven
 * over the design's examples. Strict about meaning, tolerant about form.
 */
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MARK, isBridgeCommandText, isConfirmText, parseBridgeCommand, parseDuration, parseWorkItems, parseWorkerRef, suggestVerb,
} from '../../src/bridges/commands/parse.js';

describe('what is a command (§4.2)', () => {
  const cases: Array<[string, string | null]> = [
    ['/work fix login', 'work'],
    ['!work fix login', 'work'],
    ['/WORK fix login', 'work'],
    ['   /help   ', 'help'],
    ['/help?', 'help'],
    ['/whoami please', 'whoami'],
    ['/workers.', 'workers'],
    ['/w', 'workers'],
    ['/jobs', 'workers'],
    ['/cancel keen-otter', 'stop'],
    ['/s keen-otter', 'status'],
    ['/?', 'help'],
    ['/commands', 'help'],
    ['/tasks open', 'tasks'],
    ['/docs artifacts', 'docs'],
    ['/link TM8-4F7K', 'link'],
    ['/mute 1h', 'mute'],
    ['/who', 'who'],
    ['/bridge', 'bridge'],
    ['/start #2', 'start'],
    ['/retry keen-otter', 'retry'],
    ['/result keen-otter', 'result'],
    ['/tell keen-otter the logs are in #ops', 'tell'],
    ['\n\n/task write the notes', 'task'],
    // Not commands: a slash mid-sentence, a path, a URL, nothing.
    ['can you /stop it', null],
    ['/home/user/file.txt', null],
    ['https://example.com/work', null],
    ['', null],
    ['   ', null],
    ['/', null],
    // A bridge notice is never parsed as a command (§4.8 loop guard).
    [`/stop keen-otter${BRIDGE_MARK}`, null],
  ];
  it.each(cases)('%j -> %s', (text, verb) => {
    const parsed = parseBridgeCommand(text);
    if (verb === null) {
      expect(parsed.kind).toBe('none');
      expect(isBridgeCommandText(text)).toBe(false);
    } else {
      expect(parsed).toMatchObject({ kind: 'command', verb });
      expect(isBridgeCommandText(text)).toBe(true);
    }
  });

  it('strips trailing punctuation and polite tails from the arguments', () => {
    expect(parseBridgeCommand('/stop keen-otter please!')).toMatchObject({ verb: 'stop', args: 'keen-otter' });
    expect(parseBridgeCommand('/status keen otter? thanks')).toMatchObject({ verb: 'status', args: 'keen otter' });
  });
});

describe('unknown and planned words are answered, never routed (§4.2)', () => {
  it('/stp keen-otter gets a did-you-mean with the arguments kept', () => {
    expect(parseBridgeCommand('/stp keen-otter')).toEqual({ kind: 'unknown', word: 'stp', suggestion: 'stop', args: 'keen-otter' });
  });
  it.each([['wrok', 'work'], ['wrokers', 'workers'], ['stauts', 'status'], ['hlep', 'help'], ['tsak', 'task'], ['jbos', 'jobs']])(
    '/%s -> did you mean /%s', (word, suggestion) => {
      const expected = suggestion === 'jobs' ? 'workers' : suggestion;
      expect(suggestVerb(word)).toBe(expected);
      expect(parseBridgeCommand(`/${word}`)).toMatchObject({ kind: 'unknown', suggestion: expected });
    });
  it('a word far from every verb gets no suggestion, still a command', () => {
    expect(parseBridgeCommand('/xyzzy')).toMatchObject({ kind: 'unknown', suggestion: null });
    expect(isBridgeCommandText('/xyzzy')).toBe(true);
  });
  it.each(['remind', 'loops', 'forget', 'queue'])(
    '/%s is a later verb: planned, not a did-you-mean', word => {
      expect(parseBridgeCommand(`/${word} something`)).toMatchObject({ kind: 'planned', verb: word });
    });
});

describe('/remember (Bridges R, D29)', () => {
  it('is a verb now, its text the rest of the line and the lines under it', () => {
    expect(parseBridgeCommand('/remember deploy windows are Tue/Thu\n14:00-16:00 IST')).toMatchObject({
      kind: 'command', verb: 'remember', body: ['14:00-16:00 IST'],
    });
  });
});

describe('/work items (§4.3)', () => {
  it('one item per following line, bullets and numbering dropped', () => {
    const parsed = parseBridgeCommand('/work\nfix the login timeout on mobile\n- add retries to the upload client\n3. write release notes for 1.4.3');
    expect(parsed.kind).toBe('command');
    if (parsed.kind !== 'command') return;
    const items = parseWorkItems(parsed.args, parsed.body);
    expect(items).toEqual({
      ok: true, options: {},
      items: [
        { text: 'fix the login timeout on mobile', options: {} },
        { text: 'add retries to the upload client', options: {} },
        { text: 'write release notes for 1.4.3', options: {} },
      ],
    });
  });
  it('on one line, items split on ;', () => {
    const items = parseWorkItems('fix login timeout; add upload retries; release notes', []);
    expect(items.ok && items.items.map(i => i.text)).toEqual(['fix login timeout', 'add upload retries', 'release notes']);
  });
  it('command-line options apply to every item, line options win', () => {
    const items = parseWorkItems('teammate:infra effort:high', ['fix login', 'notes effort:low project:docs']);
    expect(items).toMatchObject({
      ok: true,
      items: [
        { text: 'fix login', options: { teammate: 'infra', effort: 'high' } },
        { text: 'notes', options: { teammate: 'infra', effort: 'low', project: 'docs' } },
      ],
    });
  });
  it('unknown options on the command line are answered, not ignored; on an item line they stay text', () => {
    expect(parseWorkItems('prio:high', ['fix login'])).toEqual({ ok: false, reason: 'unknown_option', detail: 'prio' });
    expect(parseWorkItems('', ['re:login is broken'])).toMatchObject({ ok: true, items: [{ text: 're:login is broken' }] });
    expect(parseWorkItems('see https://x.y/z', [])).toMatchObject({ ok: true, items: [{ text: 'see https://x.y/z' }] });
  });
  it('a bad effort and x<n> races are refused with a reason', () => {
    expect(parseWorkItems('fix login effort:huge', [])).toEqual({ ok: false, reason: 'bad_effort', detail: 'huge' });
    expect(parseWorkItems('fix login x3', [])).toEqual({ ok: false, reason: 'race_not_available', detail: 'x3' });
  });
  it('nothing to do is refused', () => {
    expect(parseWorkItems('', [])).toEqual({ ok: false, reason: 'empty' });
    expect(parseWorkItems(' ; ; ', [])).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('worker references (§4.2)', () => {
  it.each([
    ['keen-otter', { kind: 'handle', handle: 'keen-otter', prefix: 'keen-otter' }],
    ['@keen-otter', { kind: 'handle', handle: 'keen-otter', prefix: '@keen-otter' }],
    ['keen otter', { kind: 'handle', handle: 'keen-otter', prefix: 'keen otter' }],
    ['#2', { kind: 'index', index: 2 }],
    ['2', { kind: 'index', index: 2 }],
    ['all', { kind: 'all' }],
    ['MINE', { kind: 'mine' }],
    ['login fix', { kind: 'handle', handle: 'login-fix', prefix: 'login fix' }],
  ] as const)('%j', (text, ref) => {
    expect(parseWorkerRef(text)).toEqual(ref);
  });
  it('an empty reference is none', () => expect(parseWorkerRef('  ')).toBeNull());
});

describe('durations (/mute)', () => {
  it.each([['30m', 1_800_000], ['1h', 3_600_000], ['1h30m', 5_400_000], ['2 days', 172_800_000], ['2d', 172_800_000], ['8d', null], ['soon', null], ['0m', null]] as const)(
    '%j -> %s', (text, ms) => expect(parseDuration(text)).toBe(ms));
});

describe('confirm bodies (§4.6)', () => {
  it.each(['YES', 'yes', 'y', 'Ok', 'okay!', 'yes please'])('%j confirms', text => expect(isConfirmText(text)).toBe(true));
  it.each(['yes but not now', 'no', 'yesterday', '/yes'])('%j does not', text => expect(isConfirmText(text)).toBe(false));
});

describe('426: /split and /invite people', () => {
  it('reads mentions, +numbers, everyone and names separated by commas or "and"', async () => {
    const { parsePeople, parseSplit, parseBridgeCommand } = await import('../../src/bridges/commands/parse.js');
    expect(parsePeople('@919800000002 +91 98000 00003, Maya and rahul k')).toEqual([
      { kind: 'mention', digits: '919800000002' },
      { kind: 'phone', digits: '919800000003' },
      { kind: 'name', text: 'Maya' },
      { kind: 'name', text: 'rahul k' },
    ]);
    expect(parsePeople('everyone please')).toEqual([{ kind: 'everyone' }]);
    expect(parseSplit('"Release crew" with Maya', [])).toEqual({ name: 'Release crew', people: [{ kind: 'name', text: 'Maya' }] });
    expect(parseSplit('Ops', ['@919800000002', 'Maya'])).toEqual({ name: 'Ops', people: [
      { kind: 'mention', digits: '919800000002' }, { kind: 'name', text: 'Maya' }] });
    expect(parseBridgeCommand('/group Ops with Maya')).toMatchObject({ kind: 'command', verb: 'split' });
    expect(parseBridgeCommand('/add +919800000003')).toMatchObject({ kind: 'command', verb: 'invite' });
  });
});
