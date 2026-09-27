import { useCallback, useEffect, useState } from 'react';
import { isRefusedActionRow, type ActionRows, type EntityDetail } from '@tm8/contract';
import type { ManagedFact, ManagedPanelSpec, ManagedRead, ManagedVerb } from '../../domain';
import { getKind } from '../../domain';
import { Eyebrow } from '../../kit';
import type { ManagedPort, ManagedRecord, ManagedTarget } from '../../managed/port';
import { LoginTerminalPanel, type PendingLogin } from '../../settings-credentials/CredentialsProviderBlock';
import { DisabledAction, NOT_WIRED_REASON, toReason, type UnavailableReason } from '../honesty/DisabledWithReason';
import { SettingsHomeLink } from '../SettingsHomeLink';

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
}: {
  detail: EntityDetail;
  spec: ManagedPanelSpec;
  port?: ManagedPort;
  serverBaseUrl?: string;
}) {
  const target: ManagedTarget = { id: detail.id, spaceId: detail.spaceId };
  const [rows, setRows] = useState<ActionRows | null>(null);
  const [record, setRecord] = useState<ManagedRecord | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
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
      const results: Record<string, unknown> = {};
      for (const read of spec.reads ?? []) {
        if (stateOf(nextRows, port, read.operation, '').live) {
          results[read.operation] = await port.run(read.operation, { id: detail.id, spaceId: detail.spaceId }).catch(() => null);
        }
      }
      setReads(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  if (!loaded) return <p className="pn-muted" data-testid="managed-loading">Loading…</p>;

  const ownerValue = spec.owner ? valueAt(record, spec.owner.key) : undefined;
  const ownerWord = spec.owner
    ? ownerValue == null ? spec.owner.none : ownerValue === me ? spec.owner.mine : spec.owner.other
    : null;
  const home = getKind(detail.kind).settingsHome;
  const provider = spec.loginTerminal ? valueAt(record, spec.loginTerminal.providerKey) : undefined;

  return (
    <div className="pn-managed" data-testid="managed-block">
      {(spec.notices ?? []).map((text) => (
        <p key={text} className="pn-notice" role="note" data-testid="managed-notice">{text}</p>
      ))}

      {record ? (
        <dl className="pn-fields" data-testid="managed-facts">
          {ownerWord ? (
            <div className="pn-field"><dt>Owner</dt><dd data-testid="managed-owner">{ownerWord}</dd></div>
          ) : null}
          {spec.facts.map((fact) => {
            const text = words(fact, valueAt(record, fact.key));
            return text == null ? null : (
              <div key={fact.key} className="pn-field" data-testid={`managed-fact-${fact.key}`}>
                <dt>{fact.label}</dt><dd>{text}</dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="pn-muted" data-testid="managed-unreadable">
          {port ? 'Its details are not visible to you.' : NOT_WIRED_REASON.cause}
        </p>
      )}

      <div className="pn-managed__verbs" data-testid="managed-verbs">
        {spec.verbs.map((verb) => {
          const state = stateOf(rows, port, verb.operation, verb.reason);
          if (!state.live) {
            return (
              <DisabledAction key={verb.operation} reason={state.reason} label={verb.label}>
                <span data-testid={`managed-verb-${verb.operation}`}>{verb.label}</span>
              </DisabledAction>
            );
          }
          if (verb.settingsHome) {
            return home ? <SettingsHomeLink key={verb.operation} home={{ ...home, label: verb.label }} /> : null;
          }
          if (verb.flip) {
            const current = valueAt(record, verb.flip.key);
            const index = current === verb.flip.values[0] ? 1 : 0;
            const label = verb.flip.labels?.[index] ?? verb.label;
            return (
              <button key={verb.operation} type="button" disabled={busy} data-testid={`managed-verb-${verb.operation}`}
                onClick={() => void run(verb, verb.flip!.values[index])}>
                {label}
              </button>
            );
          }
          if (verb.input && editing === verb.operation) {
            return (
              <form key={verb.operation} data-testid={`managed-form-${verb.operation}`}
                onSubmit={(e) => { e.preventDefault(); void run(verb, String(new FormData(e.currentTarget).get('value') ?? '').trim()); }}>
                <label>{verb.input.label}
                  <input name="value" required defaultValue={String(valueAt(record, verb.input.key) ?? '')} />
                </label>
                <button type="submit" disabled={busy}>Save</button>
                <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            );
          }
          if (verb.confirm && confirming === verb.operation) {
            return (
              <span key={verb.operation} className="pn-managed__confirm" data-testid={`managed-confirm-${verb.operation}`}>
                {verb.confirm}{' '}
                <button type="button" disabled={busy} onClick={() => void run(verb)}>Yes, {verb.label.toLowerCase()}</button>
                <button type="button" onClick={() => setConfirming(null)}>Keep it</button>
              </span>
            );
          }
          return (
            <button key={verb.operation} type="button" disabled={busy} data-testid={`managed-verb-${verb.operation}`}
              onClick={() => {
                if (verb.input) setEditing(verb.operation);
                else if (verb.confirm) setConfirming(verb.operation);
                else void run(verb);
              }}>
              {verb.label}
            </button>
          );
        })}
      </div>

      {spec.loginTerminal && typeof provider === 'string'
        && spec.loginTerminal.when.values.includes(String(valueAt(record, spec.loginTerminal.when.key))) ? (
        <LoginSlot
          spec={spec.loginTerminal}
          state={stateOf(rows, port, spec.loginTerminal.operation, spec.loginTerminal.reason)}
          busy={busy}
          login={login}
          serverBaseUrl={serverBaseUrl}
          onStart={() => void startLogin(provider)}
          onFinish={(open) => void finishLogin(open)}
        />
      ) : null}

      {(spec.reads ?? []).map((read) => {
        const row = rows?.rows.find((r) => r[0] === read.operation);
        if (!row) return null;
        if (isRefusedActionRow(row)) {
          return (
            <section key={read.operation} className="pn-section" data-testid={`managed-read-${read.operation}`}>
              <Eyebrow faint>{read.label}</Eyebrow>
              <DisabledAction reason={HUMAN_ONLY_REASON} label={read.label}><span>{read.label}</span></DisabledAction>
            </section>
          );
        }
        return <ReadList key={read.operation} read={read} result={reads[read.operation]} />;
      })}

      {error ? <p role="alert" className="pn-error">{error}</p> : null}
    </div>
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
      <div data-testid="managed-login-terminal">
        <LoginTerminalPanel login={login} serverBaseUrl={serverBaseUrl} busy={busy} onFinish={() => onFinish(login)} />
      </div>
    );
  }
  return (
    <button type="button" disabled={busy} data-testid={`managed-verb-${spec.operation}`} onClick={onStart}>
      {spec.label}
    </button>
  );
}

function ReadList({ read, result }: { read: ManagedRead; result: unknown }) {
  const list = read.rowsAt ? valueAt(result as ManagedRecord, read.rowsAt) : result;
  const items = Array.isArray(list) ? (list as ManagedRecord[]) : [];
  return (
    <section className="pn-section" data-testid={`managed-read-${read.operation}`}>
      <Eyebrow faint>{`${read.label} · ${items.length}`}</Eyebrow>
      {items.length === 0 ? (
        <p className="pn-muted">{read.empty}</p>
      ) : (
        <table className="pn-managed__table">
          <thead><tr>{read.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>{read.columns.map((c) => <td key={c.key}>{words(c, valueAt(item, c.key)) ?? '—'}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
