/**
 * PromptsScreen — every system prompt tm8 sends an agent, categorised.
 *
 * WHERE THE DATA COMES FROM. `@tm8/prompt/catalog` is not a description of the
 * prompts; it is built FROM them — each entry's text is either the exported
 * constant itself or the output of the same composer the spawn path calls. So
 * this screen cannot show you a prompt that differs from the one an agent gets,
 * and a `packages/prompt` test fails if anyone makes it try.
 *
 * WHY STATUS IS ON EVERY ROW. Around a third of the catalog is built, tested
 * and unreachable — the whole v2 harness path, including its kernel and all ten
 * trusted-control blocks, has no production caller. Showing those beside the
 * live v1 frame with no distinction would tell the reader something false, so
 * status is a column, not a footnote, and the unwired ones say why.
 *
 * Three panes, per the shell's own convention: categories, entries, detail.
 * Every track has a floor (L4) — this app has been broken three times by
 * zero-minimum grid tracks.
 */
import { useMemo, useState } from 'react';
import {
  PROMPT_CATEGORIES,
  PROMPT_ENTRIES,
  promptCatalogStats,
  promptEntryBytes,
  type PromptCategoryId,
  type PromptEntry,
  type PromptStatus,
} from '@tm8/prompt/catalog';
import { DISCOVERY, NOUNS } from '@tm8/cli/discovery';
import { Eyebrow, Pill } from '../kit';
import { CliHelpBody } from './CliHelpBody';

/** Status → the established ramp. Colour is never the only carrier. */
const STATUS_TONE: Record<PromptStatus, 'run' | 'wait' | 'info'> = {
  live: 'run',
  unwired: 'wait',
  reference: 'info',
};

const STATUS_WORD: Record<PromptStatus, string> = {
  live: 'live',
  unwired: 'not wired',
  reference: 'stored elsewhere',
};

const STATUS_MEANING: Record<PromptStatus, string> = {
  live: 'Composed and injected on the current spawn path.',
  unwired: 'Implemented and tested, but nothing calls it — it reaches no agent today.',
  reference: 'Real prompt text that lives outside this package; the entry points at it.',
};

const ALL = 'all' as const;
type Filter = PromptCategoryId | typeof ALL;

function matches(entry: PromptEntry, needle: string): boolean {
  if (needle === '') return true;
  const q = needle.toLowerCase();
  return (
    entry.title.toLowerCase().includes(q) ||
    entry.summary.toLowerCase().includes(q) ||
    entry.source.toLowerCase().includes(q) ||
    entry.text.toLowerCase().includes(q)
  );
}

function bytesLabel(entry: PromptEntry): string {
  const n = promptEntryBytes(entry);
  return n === 0 ? '—' : `${n.toLocaleString()} B`;
}

export interface PromptsScreenProps {
  /** Rendered into the header when the host wants a way out (overlay hosts do). */
  onClose?: (() => void) | undefined;
}

/**
 * Two bodies, one chrome. Prompts and CLI help are different shapes — prompt
 * text by category vs. operations by noun — but they answer the same question
 * ("what does tm8 say to an agent?") and share a search box, so they are modes
 * of one screen rather than two screens with duplicated headers.
 */
type Mode = 'prompts' | 'cli';

export function PromptsScreen(props: PromptsScreenProps) {
  const [mode, setMode] = useState<Mode>('prompts');
  const [filter, setFilter] = useState<Filter>(ALL);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(PROMPT_ENTRIES[0]?.id ?? '');

  const stats = useMemo(() => promptCatalogStats(), []);

  // Search reaches across every category — a needle in an unselected category
  // that returned nothing would read as "tm8 has no such prompt", which is the
  // one wrong answer this screen must not give.
  const searching = query.trim() !== '';
  const visible = useMemo(() => {
    const q = query.trim();
    return PROMPT_ENTRIES.filter(
      (e) => (searching || filter === ALL || e.categoryId === filter) && matches(e, q),
    );
  }, [filter, query, searching]);

  const selected =
    visible.find((e) => e.id === selectedId) ?? visible[0] ?? undefined;

  const countFor = (id: Filter): number =>
    id === ALL
      ? PROMPT_ENTRIES.length
      : PROMPT_ENTRIES.filter((e) => e.categoryId === id).length;

  return (
    <section className="pr-root" data-testid="prompts-screen" aria-label="System prompts">
      <header className="pr-head">
        <div className="pr-head__titles">
          <h1 className="pr-head__title">
            {mode === 'prompts' ? 'Prompts' : 'CLI help'}
          </h1>
          <p className="pr-head__sub">
            {mode === 'prompts' ? (
              <>
                Every prompt tm8 sends an agent, read from the composers themselves.{' '}
                <strong>{stats.total}</strong> entries · <strong>{stats.live}</strong> live ·{' '}
                <strong>{stats.unwired}</strong> not wired · <strong>{stats.reference}</strong>{' '}
                stored elsewhere
              </>
            ) : (
              <>
                Every operation <code>tm8 help</code> can describe — the surface an agent
                discovers instead of memorising. <strong>{DISCOVERY.length}</strong> operations
                across <strong>{NOUNS.length}</strong> nouns
              </>
            )}
          </p>
        </div>

        <div className="pr-modes" role="tablist" aria-label="Catalog">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'prompts'}
            className={`pr-mode ${mode === 'prompts' ? 'pr-mode--on' : ''}`}
            onClick={() => {
              setMode('prompts');
              setQuery('');
            }}
          >
            Prompts <span className="pr-mode__n">{stats.total}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'cli'}
            className={`pr-mode ${mode === 'cli' ? 'pr-mode--on' : ''}`}
            onClick={() => {
              setMode('cli');
              setQuery('');
            }}
          >
            CLI help <span className="pr-mode__n">{DISCOVERY.length}</span>
          </button>
        </div>
        <input
          className="pr-search"
          type="search"
          value={query}
          placeholder={mode === 'prompts' ? 'Search all prompts…' : 'Search all operations…'}
          aria-label={mode === 'prompts' ? 'Search prompts' : 'Search operations'}
          onChange={(e) => setQuery(e.target.value)}
        />
        {props.onClose ? (
          <button
            type="button"
            className="pr-close"
            onClick={props.onClose}
            aria-label="Close prompts"
            title="Close · Esc"
          >
            ✕
          </button>
        ) : null}
      </header>

      {mode === 'cli' ? <CliHelpBody query={query} /> : (
      <div className="pr-body">
        <nav className="pr-cats" aria-label="Prompt categories">
          <button
            type="button"
            className={`pr-cat ${filter === ALL && !searching ? 'pr-cat--on' : ''}`}
            aria-current={filter === ALL && !searching}
            onClick={() => {
              setFilter(ALL);
              setQuery('');
            }}
          >
            <span className="pr-cat__name">All prompts</span>
            <span className="pr-cat__n">{countFor(ALL)}</span>
          </button>
          {PROMPT_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`pr-cat ${filter === cat.id && !searching ? 'pr-cat--on' : ''}`}
              aria-current={filter === cat.id && !searching}
              title={cat.blurb}
              onClick={() => {
                setFilter(cat.id);
                setQuery('');
              }}
            >
              <span className="pr-cat__name">{cat.title}</span>
              <span className="pr-cat__n">{countFor(cat.id)}</span>
            </button>
          ))}

          <div className="pr-legend">
            <Eyebrow faint>What status means</Eyebrow>
            {(['live', 'unwired', 'reference'] as PromptStatus[]).map((s) => (
              <p key={s} className="pr-legend__row">
                <Pill tone={STATUS_TONE[s]}>{STATUS_WORD[s]}</Pill>
                <span className="pr-legend__text">{STATUS_MEANING[s]}</span>
              </p>
            ))}
          </div>
        </nav>

        <ul className="pr-list" aria-label="Prompts">
          {searching ? (
            <li className="pr-list__note">
              {visible.length} match{visible.length === 1 ? '' : 'es'} across all categories
            </li>
          ) : null}
          {visible.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`pr-item ${selected?.id === entry.id ? 'pr-item--on' : ''}`}
                aria-current={selected?.id === entry.id}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="pr-item__top">
                  <span className="pr-item__title">{entry.title}</span>
                  <Pill tone={STATUS_TONE[entry.status]}>{STATUS_WORD[entry.status]}</Pill>
                </span>
                <span className="pr-item__sum">{entry.summary}</span>
              </button>
            </li>
          ))}
          {visible.length === 0 ? (
            <li className="pr-list__empty">
              No prompt matches “{query.trim()}”. The catalog covers what tm8 itself composes —
              task and message bodies are authored content and live on their own entities.
            </li>
          ) : null}
        </ul>

        {selected ? <PromptDetail entry={selected} /> : null}
      </div>
      )}
    </section>
  );
}

function PromptDetail({ entry }: { entry: PromptEntry }) {
  const [copied, setCopied] = useState(false);
  const category = PROMPT_CATEGORIES.find((c) => c.id === entry.categoryId);

  async function copy() {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard is permission-gated and blocked outright in some embeddings.
      // The text is on screen and selectable either way, so a failed copy is
      // not worth an error state — it just does not claim success.
      setCopied(false);
    }
  }

  return (
    <article className="pr-detail" aria-label={entry.title} data-entry={entry.id}>
      <header className="pr-detail__head">
        <Eyebrow faint>{category?.title ?? entry.categoryId}</Eyebrow>
        <h2 className="pr-detail__title">{entry.title}</h2>
        <p className="pr-detail__sum">{entry.summary}</p>
      </header>

      <dl className="pr-facts">
        <div className="pr-fact">
          <dt>Status</dt>
          <dd>
            <Pill tone={STATUS_TONE[entry.status]}>{STATUS_WORD[entry.status]}</Pill>
          </dd>
        </div>
        <div className="pr-fact">
          <dt>Injected</dt>
          <dd>{entry.injectedWhen}</dd>
        </div>
        <div className="pr-fact">
          <dt>Defined in</dt>
          <dd className="pr-fact__mono">{entry.source}</dd>
        </div>
        <div className="pr-fact">
          <dt>Size</dt>
          <dd className="pr-fact__mono">
            {bytesLabel(entry)}
            {entry.budget ? ` · ceiling: ${entry.budget}` : ''}
          </dd>
        </div>
      </dl>

      {entry.statusNote ? (
        <p className="pr-note" data-testid="prompt-status-note">
          {entry.statusNote}
        </p>
      ) : null}

      {entry.rendering === 'pointer' ? (
        <p className="pr-empty">
          This prompt has no fixed text to show — it is authored content or lives outside the
          prompt package. The definition site above is where the real bytes are.
        </p>
      ) : (
        <>
          <div className="pr-textbar">
            <Eyebrow faint>
              {entry.rendering === 'composed'
                ? 'Composed live · {braces} are runtime facts'
                : 'Verbatim — the exact bytes shipped'}
            </Eyebrow>
            <button type="button" className="pr-copy" onClick={copy}>
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          <pre className="pr-text" data-testid="prompt-text">
            {entry.text}
          </pre>
        </>
      )}
    </article>
  );
}
