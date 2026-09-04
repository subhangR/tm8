/**
 * The CLI help catalog — every operation `tm8 help` can describe.
 *
 * This is the largest body of agent-facing prose in the repo: 117 operations,
 * each with a summary, a syntax line, notes, examples and the machine facts an
 * agent needs before it mutates anything (side effect, authz target,
 * idempotency, versioning, schema refs). It used to be readable only by running
 * the binary, because one `node:crypto` import made the module unbundleable.
 *
 * The detail pane renders each row the way `tm8 help` presents it rather than
 * as a form, because that is the shape the reader will meet in a terminal —
 * the point of this screen is to show what an agent actually reads.
 */
import { useMemo, useState } from 'react';
import {
  CATALOG_DIGEST,
  DISCOVERY,
  GRAMMAR_VERSION,
  NOUNS,
  UNBOUND_MARKER,
  type OperationDiscovery,
} from '@tm8/cli/discovery';
import { Eyebrow, Pill } from '../kit';

const ALL = 'all' as const;

/** Exposure → the status ramp. Word always travels with the colour. */
const EXPOSURE_TONE: Record<string, 'run' | 'wait' | 'info' | 'idle'> = {
  public: 'run',
  composite: 'info',
  internal: 'wait',
  reserved: 'idle',
};

const EXPOSURE_MEANING: Record<string, string> = {
  public: 'A normal command an agent may call.',
  composite: 'Fans out to several operations behind one verb.',
  internal: 'Reachable, but not part of the advertised surface.',
  reserved: 'Named in the contract and deliberately not implemented.',
};

/** `tm8 task complete` — how a reader would actually type it. */
function commandOf(row: OperationDiscovery): string {
  return row.command && row.command.length > 0 ? `tm8 ${row.command.join(' ')}` : '';
}

function matches(row: OperationDiscovery, needle: string): boolean {
  if (needle === '') return true;
  const q = needle.toLowerCase();
  return (
    row.operation.toLowerCase().includes(q) ||
    row.summary.toLowerCase().includes(q) ||
    (row.syntax ?? '').toLowerCase().includes(q) ||
    // The command path is searched too: eight rows are filed under a noun that
    // is NOT the first word you type (`tm8 task complete` is an `entity`
    // operation), so searching the operation name alone would not find them.
    commandOf(row).toLowerCase().includes(q) ||
    row.intentTags.some((t) => t.toLowerCase().includes(q)) ||
    (row.notes ?? []).some((n) => n.toLowerCase().includes(q))
  );
}

/**
 * Render one row as the terminal would present it. Kept as plain text on
 * purpose: this is the artifact under inspection, not a UI of our own.
 */
function renderHelp(row: OperationDiscovery): string {
  const out: string[] = [];
  out.push(row.syntax && row.syntax !== UNBOUND_MARKER ? row.syntax : `(no CLI binding — ${row.operation})`);
  out.push('');
  out.push(`  ${row.summary}`);
  out.push('');

  const fact = (k: string, v: string) => out.push(`  ${k.padEnd(15)}${v}`);
  fact('operation', row.operation);
  fact('noun · verb', `${row.noun} · ${row.verb}`);
  fact('exposure', row.exposure);
  fact('side effect', row.sideEffect);
  fact('authorizes on', row.authzTarget);
  fact('idempotency', row.idempotency);
  fact('versioning', row.versioning);
  // Reserved operations carry no bound schema — say so rather than print "null".
  fact('input schema', row.inputSchemaRef ?? '(unbound)');
  fact('output schema', row.outputSchemaRef ?? '(unbound)');
  fact('help ref', row.helpRef);

  if (row.reason) {
    out.push('');
    out.push('  reason');
    out.push(`    ${row.reason}`);
  }
  if (row.notes && row.notes.length > 0) {
    out.push('');
    out.push('  notes');
    for (const n of row.notes) out.push(`    · ${n}`);
  }
  if (row.examples && row.examples.length > 0) {
    out.push('');
    out.push('  examples');
    for (const e of row.examples) out.push(`    ${e}`);
  }
  if (row.intentTags.length > 0) {
    out.push('');
    out.push(`  intent tags   ${row.intentTags.join(', ')}`);
  }
  return out.join('\n');
}

export function CliHelpBody({ query }: { query: string }) {
  const [noun, setNoun] = useState<string>(ALL);
  const [selected, setSelected] = useState<string>(DISCOVERY[0]?.operation ?? '');

  const searching = query.trim() !== '';
  const rows = useMemo(() => {
    const q = query.trim();
    return DISCOVERY.filter(
      (r) => (searching || noun === ALL || r.noun === noun) && matches(r, q),
    );
  }, [noun, query, searching]);

  const row = rows.find((r) => r.operation === selected) ?? rows[0];

  const countFor = (n: string) =>
    n === ALL ? DISCOVERY.length : DISCOVERY.filter((r) => r.noun === n).length;

  return (
    <div className="pr-body">
      <nav className="pr-cats" aria-label="CLI nouns">
        <button
          type="button"
          className={`pr-cat ${noun === ALL && !searching ? 'pr-cat--on' : ''}`}
          aria-current={noun === ALL && !searching}
          onClick={() => setNoun(ALL)}
        >
          <span className="pr-cat__name">All operations</span>
          <span className="pr-cat__n">{countFor(ALL)}</span>
        </button>
        {NOUNS.map((n) => (
          <button
            key={n}
            type="button"
            className={`pr-cat ${noun === n && !searching ? 'pr-cat--on' : ''}`}
            aria-current={noun === n && !searching}
            onClick={() => setNoun(n)}
          >
            <span className="pr-cat__name">{n}</span>
            <span className="pr-cat__n">{countFor(n)}</span>
          </button>
        ))}

        <div className="pr-legend">
          <Eyebrow faint>What exposure means</Eyebrow>
          {Object.keys(EXPOSURE_TONE).map((e) => (
            <p key={e} className="pr-legend__row">
              <Pill tone={EXPOSURE_TONE[e]}>{e}</Pill>
              <span className="pr-legend__text">{EXPOSURE_MEANING[e]}</span>
            </p>
          ))}
          <p className="pr-legend__text pr-legend__foot">
            catalog {CATALOG_DIGEST.slice(0, 18)}… · grammar v{GRAMMAR_VERSION}
          </p>
        </div>
      </nav>

      <ul className="pr-list" aria-label="Operations">
        {searching ? (
          <li className="pr-list__note">
            {rows.length} match{rows.length === 1 ? '' : 'es'} across all nouns
          </li>
        ) : null}
        {rows.map((r) => (
          <li key={r.operation}>
            <button
              type="button"
              className={`pr-item ${row?.operation === r.operation ? 'pr-item--on' : ''}`}
              aria-current={row?.operation === r.operation}
              onClick={() => setSelected(r.operation)}
            >
              <span className="pr-item__top">
                <span className="pr-item__title pr-item__title--mono">
                  {commandOf(r) || r.operation}
                </span>
                <Pill tone={EXPOSURE_TONE[r.exposure] ?? 'idle'}>{r.exposure}</Pill>
              </span>
              <span className="pr-item__sum">{r.summary}</span>
              <span className="pr-item__op">{r.operation}</span>
            </button>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="pr-list__empty">
            {searching ? (
              <>No operation matches “{query.trim()}”.</>
            ) : (
              <ElsewhereNote noun={noun} />
            )}
          </li>
        ) : null}
      </ul>

      {row ? <CliHelpDetail row={row} /> : null}
    </div>
  );
}

/**
 * A noun can be real in the grammar and still own no operations, because the
 * catalog files a row under the noun it MUTATES rather than the word you type:
 * `tm8 task complete` is `entities.commands.complete`, filed under `entity`.
 * An empty list would read as "tm8 has no task commands", which is false — so
 * this says where they actually live.
 */
function ElsewhereNote({ noun }: { noun: string }) {
  const elsewhere = DISCOVERY.filter((r) => r.command?.[0] === noun);
  if (elsewhere.length === 0) {
    return <>No operation is filed under “{noun}”.</>;
  }
  return (
    <>
      No operation is filed under “{noun}”, but {elsewhere.length} command
      {elsewhere.length === 1 ? '' : 's'} start{elsewhere.length === 1 ? 's' : ''} with it — the
      catalog files each row under the noun it mutates:
      <br />
      {elsewhere.map((r) => (
        <span key={r.operation} className="pr-elsewhere">
          <code>tm8 {r.command!.join(' ')}</code> → {r.operation} (under “{r.noun}”)
        </span>
      ))}
    </>
  );
}

function CliHelpDetail({ row }: { row: OperationDiscovery }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => renderHelp(row), [row]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  const unbound = !row.syntax || row.syntax === UNBOUND_MARKER;

  return (
    <article className="pr-detail" aria-label={row.operation} data-entry={row.operation}>
      <header className="pr-detail__head">
        <Eyebrow faint>{row.noun}</Eyebrow>
        <h2 className="pr-detail__title pr-detail__title--mono">{row.operation}</h2>
        <p className="pr-detail__sum">{row.summary}</p>
      </header>

      {unbound ? (
        <p className="pr-note">
          This operation has no CLI binding — it exists in the contract but no verb reaches it,
          so an agent cannot call it from a terminal.
        </p>
      ) : null}

      <div className="pr-textbar">
        <Eyebrow faint>as `tm8 help` presents it</Eyebrow>
        <button type="button" className="pr-copy" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="pr-text" data-testid="cli-help-text">
        {text}
      </pre>
    </article>
  );
}
