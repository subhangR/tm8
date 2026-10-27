/**
 * THE PHONE'S RUN, as the test runner tells it through the terminal.
 *
 * The runner (`pw/live.mjs` in the app's test kit) streams the screen as inline
 * images and the run itself as iTerm user vars (`terminal/screenSignals.ts`):
 *
 * - `tm8run`  {title, device, run, startedAt, planned: [case names]}
 * - `tm8step` {i, name, group, state: run|ok|fail, ms?, error?, file?}
 * - `tm8shot.<i>` the case's last screen, a JPEG (the report's evidence)
 * - `tm8done` {passed, total, failed, ms, finishedAt}
 * - `tm8phone` {status, tone} the step under way
 *
 * This file folds those into one value the phone draws: the live frame, the
 * case list with each case's state, and, once done, everything the report
 * needs. Values are untrusted program output: each is parsed defensively and
 * rendered as text, never as markup.
 */
import { decodeUserVar, type ScreenSignal } from '../../terminal';

export type CaseState = 'planned' | 'run' | 'ok' | 'fail';
export type PhoneCase = {
  name: string;
  group: string;
  state: CaseState;
  ms?: number;
  error?: string;
  file?: string;
  shot?: string;
};
export type PhoneRunState = {
  frame: string | null;
  status: string | null;
  tone: 'run' | 'ok' | 'fail';
  title: string | null;
  device: string | null;
  runName: string | null;
  startedAt: string | null;
  cases: PhoneCase[];
  done: { passed: boolean; total: number; failed: number; ms: number; finishedAt: string } | null;
};

export const EMPTY_RUN: PhoneRunState = {
  frame: null,
  status: null,
  tone: 'run',
  title: null,
  device: null,
  runName: null,
  startedAt: null,
  cases: [],
  done: null,
};

const MAX_CASES = 200;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;

function json(base64: string): Record<string, unknown> | null {
  const raw = decodeUserVar(base64);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function reduceRun(state: PhoneRunState, signal: ScreenSignal): PhoneRunState {
  if (signal.type === 'frame') return { ...state, frame: signal.src };
  /* The program went back to text (the next phase, or a new run): the frame is stale. */
  if (signal.type === 'clear') return state.frame ? { ...state, frame: null } : state;
  const { name, base64 } = signal;
  const shot = /^tm8shot\.(\d{1,3})$/.exec(name);
  if (shot) {
    const i = Number(shot[1]);
    if (!state.cases[i] || !/^\/9j\//.test(base64)) return state;
    const cases = state.cases.slice();
    cases[i] = { ...cases[i]!, shot: `data:image/jpeg;base64,${base64}` };
    return { ...state, cases };
  }
  const value = json(base64);
  if (!value) return state;
  if (name === 'tm8phone') {
    const tone = value.tone === 'ok' || value.tone === 'fail' ? value.tone : 'run';
    return { ...state, status: text(value.status, 200) ?? null, tone };
  }
  if (name === 'tm8run') {
    const planned = Array.isArray(value.planned) ? value.planned : [];
    return {
      ...EMPTY_RUN,
      frame: state.frame,
      title: text(value.title, 120) ?? null,
      device: text(value.device, 120) ?? null,
      runName: text(value.run, 120) ?? null,
      startedAt: text(value.startedAt, 40) ?? null,
      cases: planned
        .slice(0, MAX_CASES)
        .map((n) => ({ name: text(n, 120) ?? 'Case', group: '', state: 'planned' as const })),
    };
  }
  if (name === 'tm8step') {
    const i = typeof value.i === 'number' && Number.isInteger(value.i) && value.i >= 0 && value.i < MAX_CASES ? value.i : -1;
    if (i < 0) return state;
    const cases = state.cases.slice();
    const was = cases[i];
    const stepName = text(value.name, 120) ?? was?.name ?? 'Case';
    /* The plan is only a guess at the order: a case that arrives under another name takes the slot. */
    const stepState: CaseState = value.state === 'ok' || value.state === 'fail' ? value.state : 'run';
    const ms = typeof value.ms === 'number' && value.ms >= 0 ? value.ms : undefined;
    const error = text(value.error, 900);
    const file = text(value.file, 160);
    cases[i] = {
      name: stepName,
      group: text(value.group, 80) ?? was?.group ?? '',
      state: stepState,
      ...(ms !== undefined ? { ms } : {}),
      ...(error ? { error } : {}),
      ...(file ? { file } : {}),
      ...(was?.shot && was.name === stepName ? { shot: was.shot } : {}),
    };
    for (let k = 0; k < i; k++) if (!cases[k]) cases[k] = { name: 'Case', group: '', state: 'planned' };
    return { ...state, cases };
  }
  if (name === 'tm8done') {
    const num = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : 0);
    /* A planned case still `planned` here never ran (the flow stopped early): the report says NOT RUN. */
    return {
      ...state,
      done: {
        passed: value.passed === true,
        total: num(value.total),
        failed: num(value.failed),
        ms: num(value.ms),
        finishedAt: text(value.finishedAt, 40) ?? new Date().toISOString(),
      },
    };
  }
  return state;
}

/**
 * A failure in plain words. The runner's error is Playwright's; the first line
 * names what was being done, and these are the shapes it takes in practice.
 */
export function explainFailure(error: string | undefined): string {
  if (!error) return 'The case did not finish.';
  const first = error.split('\n')[0] ?? error;
  const target = /(?:getByTestId|locator|getByText|getByRole)\(([^)]{1,120})\)/.exec(error)?.[1]?.replace(/['"]/g, '');
  const on = target ? ` (${target})` : '';
  const ms = /Timeout (\d+)ms/.exec(first)?.[1];
  const secs = ms ? `${Math.round(Number(ms) / 1000)} s` : 'the time allowed';
  if (/\.(tap|click|fill|press|check|hover)\b.*Timeout/i.test(first))
    return `The agent could not ${/fill/.test(first) ? 'type into' : 'tap'} the element${on}: it did not appear, or was covered or disabled, within ${secs}.`;
  if (/toBeVisible|to be visible/i.test(error)) return `Expected something to be on screen${on}, but it was not shown within ${secs}.`;
  if (/toHaveText|toContainText|to have text|to contain text/i.test(error)) {
    const expected = /Expected (?:string|pattern|substring)?:?\s*(.+)/.exec(error)?.[1];
    const received = /Received(?: string)?:?\s*(.+)/.exec(error)?.[1];
    return `The text on screen was not what the case expected${on}.${expected ? ` Expected ${expected.trim()}` : ''}${received ? `, got ${received.trim()}` : ''}.`;
  }
  if (/toHaveCount|to have count/i.test(error)) return `The number of matching items on screen was wrong${on}.`;
  if (/toBeHidden|not\.toBeVisible|to be hidden/i.test(error)) return `Something that should have gone away was still on screen${on}.`;
  if (/toHaveURL|to have URL/i.test(error)) return 'The app did not reach the screen (URL) the case expected.';
  if (/Timeout \d+ms exceeded/i.test(first)) return `A step waited ${secs} and the app never got there${on}.`;
  if (/net::|ERR_|Navigation failed|page\.goto/i.test(first)) return 'The app did not load.';
  if (/expect\(/.test(first) || /Expected/.test(error)) return `A check failed${on}: the app did not show what the case expected.`;
  return first.slice(0, 200);
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The report as one self-contained HTML file: summary, then every case with its outcome, reason and screenshot. */
export function reportHtml(run: PhoneRunState, meta: { app: string | null; asked: string | null }): string {
  const passed = run.cases.filter((c) => c.state === 'ok').length;
  const failed = run.cases.filter((c) => c.state === 'fail').length;
  const rows = run.cases
    .map((c, i) => {
      const verdict = c.state === 'ok' ? 'PASSED' : c.state === 'fail' ? 'FAILED' : 'NOT RUN';
      return `<section class="case ${c.state}"><div class="text"><h2>${i + 1}. ${escapeHtml(c.name)}</h2>
<p class="verdict">${verdict}${c.ms !== undefined ? ` · ${formatMs(c.ms)}` : ''}${c.group ? ` · ${escapeHtml(c.group)}` : ''}</p>
${c.state === 'fail' ? `<p class="why">${escapeHtml(explainFailure(c.error))}</p><pre>${escapeHtml(c.error ?? '')}</pre>` : ''}
${c.file ? `<p class="file">Evidence file on the node: runs/${escapeHtml(run.runName ?? '')}/${escapeHtml(c.file)}</p>` : ''}</div>
${c.shot ? `<img src="${c.shot}" alt="Screen at the end of case ${i + 1}">` : ''}</section>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Test report · ${escapeHtml(run.title ?? 'phone run')}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px auto;max-width:980px;color:rgb(29,29,31);padding:0 16px}
h1{font-size:22px;margin:0 0 4px}.sum{display:flex;gap:16px;margin:16px 0 24px;flex-wrap:wrap}.sum div{padding:10px 16px;border-radius:10px;background:rgb(242,242,244)}
.sum b{display:block;font-size:20px}.case{display:flex;gap:20px;justify-content:space-between;border-top:1px solid #ddd;padding:16px 0}
.case h2{font-size:16px;margin:0 0 4px}.verdict{font-weight:700;margin:0}.ok .verdict{color:rgb(24,121,78)}.fail .verdict{color:rgb(198,40,40)}.planned .verdict{color:#777}
.why{margin:8px 0}pre{white-space:pre-wrap;background:rgb(246,246,248);padding:8px;border-radius:6px;font-size:12px;max-height:160px;overflow:auto}
.file{color:#777;font-size:12px}img{width:220px;border-radius:12px;border:1px solid #ddd;flex:none;align-self:flex-start}</style></head><body>
<h1>Test report${run.title ? ` · ${escapeHtml(run.title)}` : ''}</h1>
<p>${escapeHtml(meta.app ?? 'App')} · ${escapeHtml(run.device ?? '')} · ${escapeHtml(run.startedAt ?? '')}${run.runName ? ` · run ${escapeHtml(run.runName)}` : ''}</p>
${meta.asked ? `<p><b>Asked to test:</b> ${escapeHtml(meta.asked)}</p>` : ''}
<div class="sum"><div><b>${run.done?.passed && failed === 0 ? 'PASSED' : 'FAILED'}</b>verdict</div><div><b>${passed}</b>passed</div><div><b>${failed}</b>failed</div><div><b>${run.cases.length}</b>cases</div><div><b>${formatMs(run.done?.ms)}</b>time</div></div>
${rows}</body></html>`;
}
