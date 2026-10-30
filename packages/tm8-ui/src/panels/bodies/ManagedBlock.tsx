import { useCallback, useEffect, useState } from 'react';
import { isRefusedActionRow, type ActionRows, type CredentialProviderName, type EntityDetail } from '@tm8/contract';
import type { ManagedFact, ManagedHeader, ManagedPanelSpec, ManagedRead, ManagedStep, ManagedVerb } from '../../domain';
import { KindIcon, getKind } from '../../domain';
import { Eyebrow, Pill, Timestamp } from '../../kit';
import type { ManagedPort, ManagedRecord, ManagedTarget } from '../../managed/port';
import { LoginTerminalPanel, type PendingLogin } from '../../settings-credentials/CredentialsProviderBlock';
import { CREDENTIAL_PROVIDER_PRESENTATIONS, presentationOf } from '../../settings-credentials/provider-presentation';
import { DisabledAction, NOT_WIRED_REASON, toReason, type UnavailableReason } from '../honesty/DisabledWithReason';
import { SettingsHomeLink } from '../SettingsHomeLink';
import './managed-block.css';

/**
 * THE MANAGED BLOCK (task 01a0e24d) — one record, its facts, and its per-item
 * verbs, for any kind whose registry row declares `panel.managed`.
 *
 * NOTHING HERE DECIDES WHAT IS ALLOWED. The registry names which operations
 * the panel offers and in what order; `actions.list` decides whether each is
 * live, as the server's doors would:
 *   · listed                   → a live control;
 *   · listed with `refused`    → "only a person can do this", because the
 *                                caller is not a person and the door is
 *                                human-only;
 *   · not listed               → the registry's sentence for why not.
 * A read (`reads`) is not drawn at all while unlisted, so a tightened door
 * makes it disappear from discovery and from here in the same step.
 *
 * NOTHING HERE WIDENS A READ. Facts come from the port's `read`, a masked seam
 * read the server already filters (a private credential's hint and login are
 * its owner's alone). A null fact renders no row. The panel never asks for, or
 * shows, a secret.
 *
 * No kind literal appears in this file (§15.2): the spec and the port are
 * keyed by seam noun and operation name.
 */

/** A refused row: the operation exists for this entity, but only a person may run it. */
export const HUMAN_ONLY_REASON: UnavailableReason = {
  cause: 'Only a person can do this',
  remedy: 'ask your human to do it',
};

type VerbState = { live: true } | { live: false; reason: UnavailableReason };

function valueAt(record: ManagedRecord | null, path: string): unknown {
  let cur: unknown = record;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function words(fact: ManagedFact, value: unknown): string | null {
  if (value == null || value === '') return null;
  const raw = typeof value === 'boolean' ? String(value) : typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;
  if (raw == null) return null;
  return fact.words?.[raw] ?? (typeof value === 'boolean' ? (value ? 'yes' : 'no') : raw);
}

function stateOf(rows: ActionRows | null, port: ManagedPort | undefined, operation: string, unlisted: string): VerbState {
  const row = rows?.rows.find((r) => r[0] === operation);
  if (!row) return { live: false, reason: toReason(unlisted) };
  if (isRefusedActionRow(row)) return { live: false, reason: HUMAN_ONLY_REASON };
  if (!port?.has(operation)) return { live: false, reason: NOT_WIRED_REASON };
  return { live: true };
}

export function ManagedBlock({
  detail,
  spec,
  port,
  serverBaseUrl,
  onOpenEntity,
}: {
  detail: EntityDetail;
  spec: ManagedPanelSpec;
  port?: ManagedPort;
  serverBaseUrl?: string;
  onOpenEntity?: (id: string) => void;
}) {
  const target: ManagedTarget = { id: detail.id, spaceId: detail.spaceId };
  const [rows, setRows] = useState<ActionRows | null>(null);
  const [record, setRecord] = useState<ManagedRecord | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reads, setReads] = useState<Record<string, unknown>>({});
  const [login, setLogin] = useState<PendingLogin | null>(null);

  const load = useCallback(async () => {
    if (!port) { setLoaded(true); return; }
    try {
      const [nextRows, nextRecord, who] = await Promise.all([
        port.actions(detail.id),
        port.read(spec.source, { id: detail.id, spaceId: detail.spaceId }),
        port.me(),
      ]);
      setRows(nextRows);
      setRecord(nextRecord);
      setMe(who.accountId);
      setLoadError(null);
      const results: Record<string, unknown> = {};
      for (const read of spec.reads ?? []) {
        if (stateOf(nextRows, port, read.operation, '').live) {
          results[read.operation] = await port.run(read.operation, { id: detail.id, spaceId: detail.spaceId }).catch(() => null);
        }
      }
      setReads(results);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [port, detail.id, detail.spaceId, spec]);

  useEffect(() => { void load(); }, [load]);

  async function run(verb: ManagedVerb, arg?: string | boolean) {
    if (!port) return;
    setBusy(true); setError(null);
    try {
      await port.run(verb.operation, target, arg);
      setEditing(null); setConfirming(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startLogin(provider: string) {
    if (!port) return;
    setBusy(true); setError(null);
    try {
      const started = await port.startLogin(target, provider);
      setLogin({ provider: started.provider, workSessionId: started.workSessionId, expiresAt: started.expiresAt, command: started.command });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finishLogin(open: PendingLogin) {
    if (!port) return;
    setBusy(true);
    try {
      await port.finishLogin(open.workSessionId);
      setLogin(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <ManagedSkeleton header={spec.header != null} />;

  /* The record the page draws. When the masked read finds nothing and the spec
     allows it, the entity's own envelope stands in: the same allow-list every
     entity read already returns, never a wider read. */
  const envelope = !record && !loadError && spec.envelopeNote ? envelopeOf(detail) : null;
  const shown = record ?? envelope;

  const ownerValue = spec.owner ? valueAt(shown, spec.owner.key) : undefined;
  const ownerWord = spec.owner && shown
    ? ownerValue == null ? spec.owner.none : ownerValue === me ? spec.owner.mine : spec.owner.other
    : null;
  const home = getKind(detail.kind).settingsHome;
  const provider = spec.loginTerminal ? valueAt(record, spec.loginTerminal.providerKey) : undefined;
  const factOf = (key: string | undefined) => (key ? spec.facts.find((f) => f.key === key) : undefined);

  const header = spec.header;
  const inHeader = new Set(header ? [header.title, header.status, ...(header.subtitle ?? [])].filter(Boolean) : []);
  const detailFacts = spec.facts.filter((f) => !inHeader.has(f.key));

  const states = spec.verbs.map((verb) => ({ verb, state: stateOf(rows, port, verb.operation, verb.reason) }));
  const live = states.filter((s) => s.state.live);
  const unavailable = states.filter((s) => !s.state.live);
  const loginOffered = spec.loginTerminal && typeof provider === 'string'
    && spec.loginTerminal.when.values.includes(String(valueAt(record, spec.loginTerminal.when.key)));

  function renderVerb(verb: ManagedVerb) {
    if (verb.settingsHome) {
      return home ? <SettingsHomeLink key={verb.operation} home={{ ...home, label: verb.label }} /> : null;
    }
    if (verb.flip) {
      const current = valueAt(record, verb.flip.key);
      const index = current === verb.flip.values[0] ? 1 : 0;
      const label = verb.flip.labels?.[index] ?? verb.label;
      return (
        <button key={verb.operation} type="button" className="pn-managed__btn" disabled={busy}
          data-testid={`managed-verb-${verb.operation}`} onClick={() => void run(verb, verb.flip!.values[index])}>
          {label}
        </button>
      );
    }
    if (verb.input && editing === verb.operation) {
      return (
        <form key={verb.operation} className="pn-managed__form" data-testid={`managed-form-${verb.operation}`}
          onSubmit={(e) => { e.preventDefault(); void run(verb, String(new FormData(e.currentTarget).get('value') ?? '').trim()); }}>
          <label>{verb.input.label}
            <input name="value" required autoFocus defaultValue={String(valueAt(record, verb.input.key) ?? '')} />
          </label>
          <button type="submit" className="pn-managed__btn pn-managed__btn--primary" disabled={busy}>Save</button>
          <button type="button" className="pn-managed__btn" onClick={() => setEditing(null)}>Cancel</button>
        </form>
      );
    }
    if (verb.confirm && confirming === verb.operation) {
      return (
        <span key={verb.operation} className="pn-managed__confirm" role="group" data-testid={`managed-confirm-${verb.operation}`}>
          <span className="pn-managed__confirm-text">{verb.confirm}</span>{' '}
          <button type="button" className="pn-managed__btn pn-managed__btn--danger" disabled={busy} onClick={() => void run(verb)}>
            Yes, {verb.label.toLowerCase()}
          </button>
          <button type="button" className="pn-managed__btn" onClick={() => setConfirming(null)}>Keep it</button>
        </span>
      );
    }
    return (
      <button key={verb.operation} type="button" disabled={busy}
        className={verb.confirm ? 'pn-managed__btn pn-managed__btn--danger-quiet' : 'pn-managed__btn'}
        data-testid={`managed-verb-${verb.operation}`}
        onClick={() => {
          if (verb.input) setEditing(verb.operation);
          else if (verb.confirm) setConfirming(verb.operation);
          else void run(verb);
        }}>
        {verb.label}
      </button>
    );
  }

  return (
    <div className="pn-managed" data-testid="managed-block">
      {(spec.notices ?? []).map((text) => (
        <p key={text} className="pn-notice pn-managed__notice" role="note" data-testid="managed-notice">{text}</p>
      ))}

      {header && shown ? (
        <ManagedHead detail={detail} header={header} record={shown} factOf={factOf} owner={ownerWord} />
      ) : null}

      {loadError ? (
        <div className="pn-managed__alert" role="alert" data-testid="managed-load-error">
          <span className="pn-managed__alert-text">
            <strong>Couldn’t load its details.</strong> <span className="pn-managed__alert-code">{loadError}</span>
          </span>
          <button type="button" className="pn-managed__btn" onClick={() => { setLoaded(false); void load(); }}>Retry</button>
        </div>
      ) : null}

      {envelope ? (
        <p className="pn-managed__source" role="note" data-testid="managed-envelope">{spec.envelopeNote}</p>
      ) : null}

      {shown ? (
        <section className="pn-managed__section" aria-label="Details">
          {header ? <Eyebrow faint>DETAILS</Eyebrow> : null}
          <dl className="pn-fields pn-managed__facts" data-testid="managed-facts">
            {ownerWord && !header ? (
              <div className="pn-fields__row"><dt className="pn-fields__key">Owner</dt><dd className="pn-fields__value" data-testid="managed-owner">{ownerWord}</dd></div>
            ) : null}
            {detailFacts.map((fact) => {
              const value = valueAt(shown, fact.key);
              const text = words(fact, value);
              return text == null ? null : (
                <div key={fact.key} className="pn-fields__row" data-testid={`managed-fact-${fact.key}`}>
                  <dt className="pn-fields__key">{fact.label}</dt>
                  <dd className="pn-fields__value"><FactValue fact={fact} value={value} text={text} onOpenEntity={onOpenEntity} /></dd>
                </div>
              );
            })}
          </dl>
        </section>
      ) : !loadError ? (
        <p className="pn-managed__empty" data-testid="managed-unreadable">
          {port ? 'Its details are not visible to you.' : NOT_WIRED_REASON.cause}
        </p>
      ) : null}

      {shown && spec.timeline?.length ? <Lifecycle steps={spec.timeline} record={shown} /> : null}

      {/* After a failed load nothing says which verbs are live, so none are drawn. */}
      {!loadError && (spec.verbs.length > 0 || loginOffered) ? (
        <section className="pn-managed__section" aria-label="Actions">
          {header ? <Eyebrow faint>ACTIONS</Eyebrow> : null}
          <div className="pn-managed__verbs" data-testid="managed-verbs">
            {live.map(({ verb }) => renderVerb(verb))}
            {loginOffered ? (
              <LoginSlot
                spec={spec.loginTerminal!}
                state={stateOf(rows, port, spec.loginTerminal!.operation, spec.loginTerminal!.reason)}
                busy={busy}
                login={login}
                serverBaseUrl={serverBaseUrl}
                onStart={() => void startLogin(provider as string)}
                onFinish={(open) => void finishLogin(open)}
              />
            ) : null}
            {live.length === 0 && !loginOffered ? (
              <span className="pn-managed__none">Nothing you can change here.</span>
            ) : null}
          </div>
          {unavailable.length > 0 ? (
            /* NOT HIDDEN, FOLDED: every refusal keeps its sentence one click
               away, and stays in the document for assistive tech and tests. */
            <details className="pn-managed__unavailable" data-testid="managed-unavailable">
              <summary>{unavailable.length === 1 ? '1 action unavailable' : `${unavailable.length} actions unavailable`}</summary>
              <ul>
                {unavailable.map(({ verb, state }) => (
                  <li key={verb.operation}>
                    <DisabledAction reason={(state as { reason: UnavailableReason }).reason} label={verb.label}>
                      <span data-testid={`managed-verb-${verb.operation}`}>{verb.label}</span>
                    </DisabledAction>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {(spec.reads ?? []).map((read) => {
        const row = rows?.rows.find((r) => r[0] === read.operation);
        if (!row) return null;
        if (isRefusedActionRow(row)) {
          return (
            <section key={read.operation} className="pn-section pn-managed__section" data-testid={`managed-read-${read.operation}`}>
              <Eyebrow faint>{read.label}</Eyebrow>
              <DisabledAction reason={HUMAN_ONLY_REASON} label={read.label}><span>{read.label}</span></DisabledAction>
            </section>
          );
        }
        return <ReadList key={read.operation} read={read} result={reads[read.operation]} onOpenEntity={onOpenEntity} />;
      })}

      {error ? <p role="alert" className="pn-error pn-managed__alert" data-testid="managed-error">{error}</p> : null}
    </div>
  );
}

/** The entity's own envelope as a record: `state` plus the facts every read carries. */
function envelopeOf(detail: EntityDetail): ManagedRecord {
  return {
    ...(detail.state as object),
    label: detail.title,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

function ManagedSkeleton({ header }: { header: boolean }) {
  return (
    <div className="pn-managed pn-managed--loading" data-testid="managed-loading" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {header ? (
        <div className="pn-managed__head">
          <span className="pn-managed__mark pn-skel--pulse" aria-hidden />
          <span className="pn-managed__head-text">
            <span className="pn-skel pn-skel--pulse" style={{ width: '46%', height: 13 }} />
            <span className="pn-skel" style={{ width: '30%' }} />
          </span>
        </div>
      ) : null}
      <div className="pn-skel pn-skel--card" />
      <div className="pn-skel pn-skel--card" />
    </div>
  );
}

function ManagedHead({
  detail,
  header,
  record,
  factOf,
  owner,
}: {
  detail: EntityDetail;
  header: ManagedHeader;
  record: ManagedRecord;
  factOf: (key: string | undefined) => ManagedFact | undefined;
  owner: string | null;
}) {
  const titleValue = valueAt(record, header.title);
  const title = typeof titleValue === 'string' && titleValue !== '' ? titleValue : detail.title;
  const markValue = header.mark ? valueAt(record, header.mark) : undefined;
  const Mark = typeof markValue === 'string' && Object.hasOwn(CREDENTIAL_PROVIDER_PRESENTATIONS, markValue)
    ? presentationOf(markValue as CredentialProviderName).icon
    : null;
  const subtitle = (header.subtitle ?? [])
    .map((key) => {
      const fact = factOf(key);
      return fact ? words(fact, valueAt(record, key)) : null;
    })
    .filter((w): w is string => w != null);
  const statusFact = factOf(header.status);
  const statusValue = header.status ? valueAt(record, header.status) : undefined;
  const statusWord = statusFact ? words(statusFact, statusValue) : null;
  const tone = statusFact?.tones?.[String(statusValue)] ?? 'idle';

  return (
    <header className="pn-managed__head" data-testid="managed-head">
      <span className="pn-managed__mark" aria-hidden>
        {Mark ? <Mark width={20} height={20} /> : <KindIcon kind={detail.kind} size={16} />}
      </span>
      <span className="pn-managed__head-text">
        <span className="pn-managed__title" data-testid={`managed-fact-${header.title}`}>{title}</span>
        {subtitle.length > 0 ? <span className="pn-managed__subtitle">{subtitle.join(' · ')}</span> : null}
      </span>
      <span className="pn-managed__head-meta">
        {statusWord ? (
          <span data-testid={`managed-fact-${header.status}`}><Pill tone={tone} dot="solid">{statusWord}</Pill></span>
        ) : null}
        {owner ? (
          <span className="pn-managed__owner">
            <span className="pn-managed__owner-key">Owner</span> <span data-testid="managed-owner">{owner}</span>
          </span>
        ) : null}
      </span>
    </header>
  );
}

function FactValue({
  fact,
  value,
  text,
  onOpenEntity,
}: {
  fact: ManagedFact;
  value: unknown;
  text: string;
  onOpenEntity?: (id: string) => void;
}) {
  const tone = fact.tones?.[String(value)];
  if (tone) return <Pill tone={tone}>{text}</Pill>;
  if (fact.format === 'time') return <Timestamp at={text} />;
  if (fact.format === 'hint') {
    return <span className="pn-managed__hint" aria-label={`ends in ${text}`}><span aria-hidden>••••</span> {text}</span>;
  }
  if (fact.format === 'entity') {
    const short = text.length > 8 ? text.slice(0, 8) : text;
    return onOpenEntity ? (
      <button type="button" className="pn-managed__link" title={text} onClick={() => onOpenEntity(text)}>{short}</button>
    ) : <span className="pn-managed__mono" title={text}>{short}</span>;
  }
  return <>{text}</>;
}

function Lifecycle({ steps, record }: { steps: readonly ManagedStep[]; record: ManagedRecord }) {
  const drawn = steps.filter((step) => {
    if (step.when && !step.when.values.includes(String(valueAt(record, step.when.key)))) return false;
    const at = valueAt(record, step.at);
    return (typeof at === 'string' && at !== '') || step.pending != null;
  });
  if (drawn.length === 0) return null;
  return (
    <section className="pn-managed__section" aria-label="Lifecycle" data-testid="managed-lifecycle">
      <Eyebrow faint>LIFECYCLE</Eyebrow>
      <ol className="pn-managed__timeline">
        {drawn.map((step) => {
          const at = valueAt(record, step.at);
          const done = typeof at === 'string' && at !== '';
          return (
            <li key={`${step.label}-${step.at}`} className={done ? 'pn-managed__step' : 'pn-managed__step pn-managed__step--pending'}
              data-tone={done ? step.tone ?? 'idle' : undefined} data-testid={`managed-step-${step.at}`}>
              <span className="pn-managed__dot" aria-hidden />
              <span className="pn-managed__step-label">{step.label}</span>
              <span className="pn-managed__step-when">
                {done ? <Timestamp at={at} /> : step.pending}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LoginSlot({
  spec,
  state,
  busy,
  login,
  serverBaseUrl,
  onStart,
  onFinish,
}: {
  spec: NonNullable<ManagedPanelSpec['loginTerminal']>;
  state: VerbState;
  busy: boolean;
  login: PendingLogin | null;
  serverBaseUrl?: string;
  onStart: () => void;
  onFinish: (open: PendingLogin) => void;
}) {
  if (!state.live) {
    return (
      <DisabledAction reason={state.reason} label={spec.label}>
        <span data-testid={`managed-verb-${spec.operation}`}>{spec.label}</span>
      </DisabledAction>
    );
  }
  if (login) {
    /* THE TERMINAL IS HOSTED HERE, inline in the panel (ac_8), reusing the
       Settings screen's LoginTerminalPanel so the two can never drift. */
    return (
      <div className="pn-managed__terminal" data-testid="managed-login-terminal">
        <LoginTerminalPanel login={login} serverBaseUrl={serverBaseUrl} busy={busy} onFinish={() => onFinish(login)} />
      </div>
    );
  }
  return (
    <button type="button" className="pn-managed__btn pn-managed__btn--primary" disabled={busy} data-testid={`managed-verb-${spec.operation}`} onClick={onStart}>
      {spec.label}
    </button>
  );
}

function ReadList({
  read,
  result,
  onOpenEntity,
}: {
  read: ManagedRead;
  result: unknown;
  onOpenEntity?: (id: string) => void;
}) {
  const list = read.rowsAt ? valueAt(result as ManagedRecord, read.rowsAt) : result;
  const items = Array.isArray(list) ? (list as ManagedRecord[]) : [];
  return (
    <section className="pn-section pn-managed__section" data-testid={`managed-read-${read.operation}`}>
      <Eyebrow faint>{`${read.label} · ${items.length}`}</Eyebrow>
      {items.length === 0 ? (
        <p className="pn-managed__empty">{read.empty}</p>
      ) : (
        <div className="pn-managed__table-wrap">
          <table className="pn-managed__table">
            <thead><tr>{read.columns.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i}>
                  {read.columns.map((c) => {
                    const value = valueAt(item, c.key);
                    const text = words(c, value);
                    return (
                      <td key={c.key}>
                        {text == null ? <span className="pn-managed__nil">—</span>
                          : <FactValue fact={c} value={value} text={text} onOpenEntity={onOpenEntity} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
