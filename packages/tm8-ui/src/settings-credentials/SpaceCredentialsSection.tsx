/**
 * Settings → Space credentials (SC-5). The credentials this SPACE owns, which
 * every member may launch with (D3), grouped by provider.
 *
 * WHO SEES WHICH CONTROL:
 * - Any member adds a key (D1).
 * - Rename, replace key, set default and delete are drawn only for the
 *   credential's creator and space admins (D11). Everyone else is told why.
 * - The source policy (D5) is drawn for everyone, and is switchable only by a
 *   space admin.
 * The server enforces every one of these again; a refusal it answers anyway is
 * shown as a refusal (#681 D), never as a vendor verdict and never behind a
 * probe spinner.
 *
 * SECRETS (I5): a key is typed into a password field, sent once, and the field
 * is emptied on success — and on failure too, so a rejected key does not sit
 * in the page waiting to be re-sent. Nothing here renders a secret; the list
 * carries at most `keyHint`, the last four characters.
 *
 * ADD BY LOGIN (SC-4, Claude and Codex only): any member names a label and a
 * login terminal opens (the member Connect terminal); the label is held by a
 * pending row until the login finishes or expires (A7). "Log in again" is the
 * creator's or an admin's re-login onto a login credential. The result is read
 * from the credential row the probed finish returns (I6).
 *
 * CLOSING AN EXPIRED LOGIN (N1) is "Log in again": starting onto that
 * credential, which the server turns into kill-then-stamp-failed before it
 * opens the new terminal. It is never a finish-as-success and never a delete.
 * Abandoning a pending login is Delete, which stays on the row.
 *
 * SHARES (SC-8, 210): a member's own credential shared into the space reads
 * "Shared by <name>". Only its sharer renames it, logs in again or stops
 * sharing it; a space admin may only remove it; nobody makes it the default
 * or replaces its token (a shared token IS the sharer's personal one).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  CredentialPolicySource,
  CredentialsSpacePolicyView,
  SpaceCredentialProviderName,
  SpaceCredentialView,
} from '@tm8/contract';
import { SectionAbsent, SectionFrame } from '../settings-space';
import type { SpaceCredentialsPort, SpaceCredentialsViewer, SpaceLoginProvider, SpaceLoginTarget } from './space-port';
import {
  SOURCE_WORD,
  SPACE_CREDENTIAL_PROVIDERS,
  SPACE_PROVIDER_NAME,
  SPACE_SECRET_NOUN,
  afterDeleteNotice,
  allowedSourcesOf,
  canManage,
  canRemove,
  creatorLabel,
  isShare,
  failureOf,
  formatWhen,
  groupByProvider,
  labelTakenReason,
  nodeAllowedOf,
  noDefaultNotice,
  pasteShapeOf,
  sharedByLabel,
  toggleSource,
  spaceLoginOutcome,
  spaceLoginStartFailureOf,
  validateSecret,
  type SpaceCredentialFailure,
  type SpaceLoginStartFailure,
} from './space-credentials-model';
import { LoginTerminalPanel, type PendingLogin } from './CredentialsProviderBlock';
import './credentials.css';
import './space-credentials.css';

export interface SpaceCredentialsSectionProps {
  port: SpaceCredentialsPort;
  heading?: string;
  /** Same-origin route prefix for the node that hosts a login terminal. */
  serverBaseUrl?: string;
}

function isLoginProvider(provider: SpaceCredentialProviderName): provider is SpaceLoginProvider {
  return provider === 'anthropic' || provider === 'openai';
}

export function SpaceCredentialsSection({ port, heading = 'Space credentials', serverBaseUrl }: SpaceCredentialsSectionProps) {
  const [viewer, setViewer] = useState<SpaceCredentialsViewer | null>(null);
  const [rows, setRows] = useState<SpaceCredentialView[] | null>(null);
  const [policy, setPolicy] = useState<CredentialsSpacePolicyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [nextRows, nextPolicy] = await Promise.all([port.list(), port.policy()]);
    setRows(nextRows);
    setPolicy(nextPolicy);
  }, [port]);

  useEffect(() => {
    let live = true;
    // The viewer read may fail on its own; the list still draws, with no
    // management controls (a null viewer manages nothing).
    void port.viewer().then((v) => { if (live) setViewer(v); }, () => {});
    void Promise.all([port.list(), port.policy()]).then(
      ([nextRows, nextPolicy]) => {
        if (!live) return;
        setRows(nextRows);
        setPolicy(nextPolicy);
        setLoadError(null);
      },
      (err: unknown) => { if (live) setLoadError(failureOf(err).text); },
    );
    return () => { live = false; };
  }, [port]);

  if (loadError) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Space credentials could not be read." why={loadError} testId="space-cred-load-error" />
      </SectionFrame>
    );
  }

  const groups = groupByProvider(rows ?? []);

  return (
    <SectionFrame title={heading}>
      <div className="set-spc" data-testid="space-credentials">
        <p className="set-spc__lede">
          Keys this space owns. Every member can launch with them; a launch picks yours first, then the
          space&apos;s default, then the node&apos;s, unless a policy below says otherwise. Only a
          credential&apos;s creator and space admins can change or delete it.
        </p>
        {notice ? (
          <div className="cred-notice set-spc__notice" role="status" data-testid="space-cred-notice">
            <span className="cred-notice__head">{notice}</span>
          </div>
        ) : null}
        {rows === null ? <p className="set-spc__muted">Reading…</p> : null}
        {rows !== null
          ? SPACE_CREDENTIAL_PROVIDERS.map((provider) => (
              <ProviderGroup
                key={provider}
                provider={provider}
                rows={groups[provider]}
                allRows={rows}
                viewer={viewer}
                policy={policy}
                port={port}
                serverBaseUrl={serverBaseUrl}
                onChanged={async (message) => {
                  setNotice(message ?? null);
                  await reload().catch((err: unknown) => setLoadError(failureOf(err).text));
                }}
                onPolicy={(next) => setPolicy(next)}
              />
            ))
          : null}
      </div>
    </SectionFrame>
  );
}

function ProviderGroup({
  provider,
  rows,
  allRows,
  viewer,
  policy,
  port,
  serverBaseUrl,
  onChanged,
  onPolicy,
}: {
  provider: SpaceCredentialProviderName;
  rows: SpaceCredentialView[];
  allRows: SpaceCredentialView[];
  viewer: SpaceCredentialsViewer | null;
  policy: CredentialsSpacePolicyView | null;
  port: SpaceCredentialsPort;
  serverBaseUrl?: string;
  onChanged(message?: string): Promise<void>;
  onPolicy(next: CredentialsSpacePolicyView): void;
}) {
  const name = SPACE_PROVIDER_NAME[provider];
  const missingDefault = noDefaultNotice(provider, rows);
  const [login, setLogin] = useState<OpenSpaceLogin | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginFailure, setLoginFailure] = useState<SpaceLoginStartFailure | null>(null);

  // A login whose credential has left the list (deleted here, or by anyone)
  // has no row left to finish onto: close its panel instead of holding the
  // group's controls busy until a reload. `seen` waits for the reload that
  // first shows a NEW label's pending row, so that gap does not count as gone.
  useEffect(() => {
    if (!login?.credentialId) return;
    const present = allRows.some((r) => r.id === login.credentialId && r.status !== 'revoked');
    if (present && !login.seen) setLogin({ ...login, seen: true });
    else if (!present && login.seen) setLogin(null);
  }, [allRows, login]);

  /** Resolves to the refusal, or null once the terminal is open. */
  async function startLogin(target: SpaceLoginTarget): Promise<SpaceLoginStartFailure | null> {
    if (!isLoginProvider(provider)) return null;
    setLoginBusy(true);
    setLoginFailure(null);
    try {
      const started = await port.startLogin(provider, target);
      const label = started.spaceCredential?.label ?? target.label ?? allRows.find((r) => r.id === target.credentialId)?.label ?? '';
      setLogin({
        provider,
        workSessionId: started.workSessionId,
        expiresAt: started.expiresAt,
        command: started.command,
        credentialId: started.spaceCredential?.id ?? target.credentialId ?? null,
        seen: false,
        lede: target.credentialId
          ? `Logging in again onto the space credential “${label}”. Follow the terminal prompts, then press “I’ve finished signing in”. Until it completes, “${label}” keeps the login it had.`
          : `Logging in for the new space credential “${label}”. It belongs to the space, not your account. Follow the terminal prompts, then press “I’ve finished signing in”.`,
      });
      // A new label is now a pending row holding that label (A7): show it.
      if (!target.credentialId) await onChanged();
      return null;
    } catch (err) {
      const failure = spaceLoginStartFailureOf(err, provider, allRows);
      // A taken label is the add form's field error: the form draws it there.
      if (failure.kind !== 'label_taken') setLoginFailure(failure);
      if ((err as { code?: unknown })?.code === 'not_found') await onChanged();
      return failure;
    } finally {
      setLoginBusy(false);
    }
  }

  async function finishLogin(open: PendingLogin) {
    setLoginBusy(true);
    try {
      const result = await port.finishLogin(open.workSessionId);
      setLogin(null);
      await onChanged(spaceLoginOutcome(result));
    } catch (err) {
      // not_found: the server holds no login session for it any more (a
      // restart, another node): nothing is left to finish, so close the panel.
      if ((err as { code?: unknown })?.code === 'not_found') {
        setLogin(null);
        setLoginFailure({ kind: 'failure', failure: { kind: 'failed', text: 'That login is no longer open on the server, so there is nothing to finish. Log in again to start a fresh one.' } });
      } else {
        setLoginFailure({ kind: 'failure', failure: failureOf(err) });
      }
    } finally {
      setLoginBusy(false);
    }
  }

  const loginControls = isLoginProvider(provider)
    ? { busy: loginBusy || login !== null, start: startLogin }
    : null;
  return (
    <section className="set-spc__group" data-testid={`space-cred-group-${provider}`} aria-label={name}>
      <h4 className="set-spc__group-title">{name}</h4>
      {missingDefault ? (
        <p className="set-spc__warn" data-testid={`space-cred-no-default-${provider}`}>{missingDefault}</p>
      ) : null}
      {rows.length === 0 ? (
        <p className="set-spc__muted" data-testid={`space-cred-empty-${provider}`}>
          No {name} credential in this space yet.
        </p>
      ) : (
        <ul className="set-spc__list">
          {rows.map((row) => (
            <CredentialRow key={row.id} row={row} allRows={allRows} viewer={viewer} port={port} onChanged={onChanged} login={loginControls} />
          ))}
        </ul>
      )}
      <AddByKey provider={provider} rows={allRows} port={port} onChanged={onChanged} login={loginControls} />
      {loginFailure ? (
        <LoginStartFailure failure={loginFailure} provider={provider} allRows={allRows} viewer={viewer} login={loginControls} />
      ) : null}
      {login ? (
        <LoginTerminalPanel
          login={login}
          lede={login.lede}
          serverBaseUrl={serverBaseUrl}
          busy={loginBusy}
          onFinish={() => void finishLogin(login)}
        />
      ) : null}
      <PolicyRow provider={provider} policy={policy} viewer={viewer} port={port} onPolicy={onPolicy} />
    </section>
  );
}

function CredentialRow({
  row,
  allRows,
  viewer,
  port,
  onChanged,
  login,
}: {
  row: SpaceCredentialView;
  allRows: SpaceCredentialView[];
  viewer: SpaceCredentialsViewer | null;
  port: SpaceCredentialsPort;
  onChanged(message?: string): Promise<void>;
  login: LoginControls | null;
}) {
  const manage = canManage(row, viewer);
  const share = isShare(row);
  const removable = canRemove(row, viewer);
  const [mode, setMode] = useState<'idle' | 'rename' | 'rekey' | 'confirm-delete'>('idle');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<null | 'probe' | 'plain'>(null);
  const [failure, setFailure] = useState<SpaceCredentialFailure | null>(null);

  async function run(kind: 'probe' | 'plain', act: () => Promise<string | undefined>) {
    setBusy(kind);
    setFailure(null);
    try {
      const message = await act();
      setDraft('');
      setMode('idle');
      await onChanged(message);
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      // A secret draft is emptied on EVERY outcome (I5); a label draft is kept
      // on failure so the member can correct it.
      if (kind === 'probe') setDraft('');
      setBusy(null);
    }
  }

  const renameClash = mode === 'rename' ? labelTakenReason(row.provider, draft, allRows, row.id) : null;
  const secretProblem = mode === 'rekey' ? validateSecret(draft) : null;
  // A shared token is the sharer's personal one: it is replaced there, not here.
  const pasted = row.shape !== 'login' && !share;
  const removeWord = share ? (manage ? 'Stop sharing' : 'Remove') : 'Delete';
  const statusWord = row.status === 'stale' ? 'failed its last check' : row.status === 'pending' ? 'login not finished' : 'active';

  return (
    <li className={`set-spc__row set-spc__row--${row.status}`} data-testid={`space-cred-row-${row.id}`}>
      <div className="set-spc__row-head">
        <span className="set-spc__label">{row.label}</span>
        {row.isDefault ? <span className="set-spc__badge set-spc__badge--default">default</span> : null}
        {share ? (
          <span className="set-spc__badge set-spc__badge--shared" data-testid={`space-cred-shared-by-${row.id}`}>
            Shared by {sharedByLabel(row, viewer)}
          </span>
        ) : null}
        <span className={`set-spc__badge set-spc__badge--${row.status}`}>{statusWord}</span>
      </div>
      <div className="set-spc__meta">
        <span>{row.shape === 'login' ? 'login' : row.shape === 'token' ? 'token' : 'API key'}</span>
        {row.keyHint ? <span data-testid={`space-cred-hint-${row.id}`}>ends …{row.keyHint}</span> : null}
        {row.displayLogin ? <span>as {row.displayLogin}</span> : null}
        {share ? null : <span>added by {creatorLabel(row, viewer)}</span>}
        <span>last used {formatWhen(row.lastUsedAt)}</span>
      </div>

      {removable ? (
        <div className="cred-card__actions set-spc__actions">
          {manage && !share && !row.isDefault && row.status === 'active' ? (
            <button
              type="button"
              className="cred-action"
              aria-label={`Set default ${row.label}`}
              disabled={busy !== null}
              onClick={() => void run('plain', async () => { await port.setDefault(row.id); return `“${row.label}” is now the ${SPACE_PROVIDER_NAME[row.provider]} default.`; })}
            >
              Make default
            </button>
          ) : null}
          {manage ? (
            <button type="button" className="cred-action" aria-label={`Rename ${row.label}`} disabled={busy !== null}
              onClick={() => { setDraft(row.label); setFailure(null); setMode(mode === 'rename' ? 'idle' : 'rename'); }}>
              Rename
            </button>
          ) : null}
          {manage && row.shape === 'login' && login ? (
            <button type="button" className="cred-action" aria-label={`Log in again ${row.label}`}
              disabled={busy !== null || login.busy}
              onClick={() => void login.start({ credentialId: row.id })}>
              Log in again
            </button>
          ) : null}
          {manage && pasted ? (
            <button type="button" className="cred-action" aria-label={`Replace ${SPACE_SECRET_NOUN[row.provider]} ${row.label}`} disabled={busy !== null}
              onClick={() => { setDraft(''); setFailure(null); setMode(mode === 'rekey' ? 'idle' : 'rekey'); }}>
              Replace {SPACE_SECRET_NOUN[row.provider]}
            </button>
          ) : null}
          {mode === 'confirm-delete' ? (
            <>
              <button type="button" className="cred-action set-spc__danger" aria-label={`Confirm ${removeWord.toLowerCase()} ${row.label}`} disabled={busy !== null}
                onClick={() => void run('plain', async () => {
                  const result = await port.remove(row.id);
                  return afterDeleteNotice(row, result.terminatedAgentSessionIds.length + result.terminatedLoginSessionIds.length);
                })}>
                {removeWord}, and end sessions using it
              </button>
              <button type="button" className="cred-action" aria-label={`Keep ${row.label}`} onClick={() => setMode('idle')}>Keep</button>
            </>
          ) : (
            <button type="button" className="cred-action set-spc__danger" aria-label={`${removeWord} ${row.label}`} disabled={busy !== null}
              onClick={() => { setFailure(null); setMode('confirm-delete'); }}>
              {removeWord}
            </button>
          )}
        </div>
      ) : (
        <p className="set-spc__muted" data-testid={`space-cred-readonly-${row.id}`}>
          {share
            ? `You can launch with it by naming it; it is never the default. It runs on ${sharedByLabel(row, viewer)}’s account, and only they can change it.`
            : 'You can launch with it. Only its creator or a space admin can change it.'}
        </p>
      )}
      {removable && !manage ? (
        <p className="set-spc__muted" data-testid={`space-cred-admin-share-${row.id}`}>
          Shared by {sharedByLabel(row, viewer)}. As a space admin you can remove it; only they can change it.
        </p>
      ) : null}

      {removable && mode === 'confirm-delete' ? (
        <p className="set-spc__warn">
          {share ? 'Removing this share' : 'Deleting'} ends every live session using this credential.
          {row.isDefault ? ' It is the default, and no other credential becomes the default in its place.' : ''}
        </p>
      ) : null}

      {manage && mode === 'rename' ? (
        <form className="set-spc__form" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const label = draft.trim();
          if (!label || renameClash || label === row.label) return;
          void run('plain', async () => { await port.rename(row.id, label); return undefined; });
        }}>
          <input className="set-spc__input" aria-label={`New label for ${row.label}`} value={draft} maxLength={80}
            onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="cred-action cred-action--primary" aria-label={`Save label ${row.label}`}
            disabled={busy !== null || !draft.trim() || renameClash !== null}>Save</button>
          {renameClash ? <span className="set-spc__why" data-testid="space-cred-label-taken">{renameClash}</span> : null}
        </form>
      ) : null}

      {manage && mode === 'rekey' ? (
        <form className="set-spc__form" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const secret = draft.trim();
          if (!secret || validateSecret(secret)) return;
          void run('probe', async () => { await port.rekey(row.id, secret); return `Replaced the ${SPACE_SECRET_NOUN[row.provider]} on “${row.label}”. New launches use it; running sessions keep the old one until they restart.`; });
        }}>
          <input className="set-spc__input" type="password" autoComplete="off" spellCheck={false}
            aria-label={`New ${SPACE_SECRET_NOUN[row.provider]} for ${row.label}`} value={draft}
            onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="cred-action cred-action--primary" aria-label={`Save ${SPACE_SECRET_NOUN[row.provider]} ${row.label}`}
            disabled={busy !== null || !draft.trim() || secretProblem !== null}>Save</button>
          {secretProblem ? <span className="set-spc__why">{secretProblem}</span> : null}
        </form>
      ) : null}

      <BusyAndFailure busy={busy} failure={failure} provider={row.provider} />
    </li>
  );
}

function AddByKey({
  provider,
  rows,
  port,
  onChanged,
  login,
}: {
  provider: SpaceCredentialProviderName;
  rows: SpaceCredentialView[];
  port: SpaceCredentialsPort;
  onChanged(message?: string): Promise<void>;
  login: LoginControls | null;
}) {
  const noun = SPACE_SECRET_NOUN[provider];
  const name = SPACE_PROVIDER_NAME[provider];
  const [open, setOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginLabel, setLoginLabel] = useState('');
  /** The server's A7 refusal for the label as submitted; cleared on edit. */
  const [serverTaken, setServerTaken] = useState<string | null>(null);
  const loginTaken = labelTakenReason(provider, loginLabel, rows);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<null | 'probe'>(null);
  const [failure, setFailure] = useState<SpaceCredentialFailure | null>(null);

  const taken = labelTakenReason(provider, label, rows);
  const secretProblem = validateSecret(secret.trim());

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanLabel = label.trim();
    const cleanSecret = secret.trim();
    if (!cleanLabel || !cleanSecret || taken || secretProblem) return;
    setBusy('probe');
    setFailure(null);
    try {
      const created = await port.create({ provider, shape: pasteShapeOf(provider), label: cleanLabel, secret: cleanSecret });
      setLabel('');
      setOpen(false);
      await onChanged(
        created.isDefault
          ? `Added “${created.label}”. It is the ${name} default.`
          : `Added “${created.label}”.`,
      );
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      // Emptied on EVERY outcome: the key went out once and is not kept (I5).
      setSecret('');
      setBusy(null);
    }
  }

  return (
    <div className="set-spc__add">
      <div className="cred-card__actions">
        <button type="button" className="cred-action cred-action--primary" aria-label={`Add ${name} ${noun}`}
          aria-expanded={open} onClick={() => { setOpen(!open); setLoginOpen(false); setFailure(null); }}>
          + Add {noun}
        </button>
        {login ? (
          <button type="button" className="cred-action" aria-label={`Add ${name} by login`} aria-expanded={loginOpen}
            onClick={() => { setLoginOpen(!loginOpen); setOpen(false); }}>
            + Add by login
          </button>
        ) : null}
      </div>
      {login && loginOpen ? (
        <form className="set-spc__form" data-testid={`space-cred-login-form-${provider}`} onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const label = loginLabel.trim();
          if (!label || loginTaken || login.busy) return;
          setServerTaken(null);
          // The form closes only once the terminal is open: a refused label
          // stays typed, with the reason at the field.
          void login.start({ label }).then((refused) => {
            if (refused === null) {
              setLoginOpen(false);
              setLoginLabel('');
            } else if (refused.kind === 'label_taken') {
              setServerTaken(refused.text);
            }
          });
        }}>
          <input className="set-spc__input" aria-label={`Label for the new ${name} login`} placeholder="Label, e.g. Max plan"
            value={loginLabel} maxLength={80} onChange={(e) => { setLoginLabel(e.target.value); setServerTaken(null); }} />
          <button type="submit" className="cred-action cred-action--primary" aria-label={`Open ${name} login terminal`}
            disabled={login.busy || !loginLabel.trim() || loginTaken !== null || serverTaken !== null}>
            Open login terminal
          </button>
          {serverTaken ? (
            <span className="set-spc__why" role="alert" data-testid="space-login-label-taken">{serverTaken}</span>
          ) : null}
          <span className="set-spc__why">
            {serverTaken ? null : loginTaken ?? 'A login needs its label first: the label is held for this login until it finishes or expires.'}
          </span>
        </form>
      ) : null}
      {open ? (
        <form className="set-spc__form set-spc__form--add" onSubmit={(e) => void submit(e)} data-testid={`space-cred-add-${provider}`}>
          <input className="set-spc__input" aria-label={`Label for the new ${name} ${noun}`} placeholder="Label, e.g. Team budget"
            value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          <input className="set-spc__input" type="password" autoComplete="off" spellCheck={false}
            aria-label={`${name} ${noun}`} placeholder={`Paste the ${noun}`}
            value={secret} onChange={(e) => setSecret(e.target.value)} />
          <button type="submit" className="cred-action cred-action--primary" aria-label={`Save new ${name} ${noun}`}
            disabled={busy !== null || !label.trim() || !secret.trim() || taken !== null || secretProblem !== null}>
            Save
          </button>
          {taken ? <span className="set-spc__why" data-testid="space-cred-label-taken">{taken}</span> : null}
          {secretProblem ? <span className="set-spc__why">{secretProblem}</span> : null}
        </form>
      ) : null}
      <BusyAndFailure busy={busy} failure={failure} provider={provider} />
    </div>
  );
}

interface LoginControls {
  /** A start is in flight, or a login terminal is already open in this group. */
  busy: boolean;
  /** Resolves to the refusal, or null once the terminal is open. */
  start(target: SpaceLoginTarget): Promise<SpaceLoginStartFailure | null>;
}

/** An open space login terminal, and the credential it logs in onto. */
type OpenSpaceLogin = PendingLogin & { lede: string; credentialId: string | null; seen: boolean };

/**
 * A refused start. `login_open` past its expiry offers "Log in again" onto the
 * credential it names, to its creator or an admin only (N1): that start is the
 * close. Before expiry, nothing here can close another member's terminal.
 */
function LoginStartFailure({ failure, provider, allRows, viewer, login }: {
  failure: SpaceLoginStartFailure;
  provider: SpaceCredentialProviderName;
  allRows: SpaceCredentialView[];
  viewer: SpaceCredentialsViewer | null;
  login: LoginControls | null;
}) {
  // A taken label is drawn at the add form's label field, not here.
  if (failure.kind === 'label_taken') return null;
  if (failure.kind === 'failure') {
    return (
      <p className={`set-spc__fail set-spc__fail--${failure.failure.kind}`} role="alert" data-testid={`space-cred-failure-${failure.failure.kind}`}>
        {failure.failure.text}
      </p>
    );
  }
  const { notice } = failure;
  const held = notice.credentialId ? allRows.find((r) => r.id === notice.credentialId) ?? null : null;
  // An unknown row is not refused here: the server answers for it (D11).
  const mayClose = held === null || canManage(held, viewer);
  return (
    <div className="set-spc__fail" role="alert" data-testid={`space-login-open-${provider}`}>
      <span>{notice.text}</span>
      {notice.expired && notice.credentialId && login ? (
        mayClose ? (
          <button type="button" className="cred-action cred-action--primary" disabled={login.busy}
            aria-label={`Close the expired login and log in again${held ? ` ${held.label}` : ''}`}
            data-testid="space-login-reclaim"
            onClick={() => void login.start({ credentialId: notice.credentialId! })}>
            Log in again
          </button>
        ) : (
          <span className="set-spc__why"> Only its creator or a space admin can close it.</span>
        )
      ) : null}
    </div>
  );
}

/**
 * The probe line and the failure line. A refusal is answered before any
 * probe, so once one arrives the spinner is gone and the text says "Refused",
 * never "the vendor said no" (#681 D).
 */
function BusyAndFailure({ busy, failure, provider }: {
  busy: null | 'probe' | 'plain';
  failure: SpaceCredentialFailure | null;
  provider: SpaceCredentialProviderName;
}) {
  return (
    <>
      {busy === 'probe' ? (
        <p className="set-spc__muted" role="status" data-testid="space-cred-probe">
          Checking with {provider === 'github' ? 'GitHub' : SPACE_PROVIDER_NAME[provider]}…
        </p>
      ) : null}
      {failure ? (
        <p className={`set-spc__fail set-spc__fail--${failure.kind}`} role="alert" data-testid={`space-cred-failure-${failure.kind}`}>
          {failure.text}
        </p>
      ) : null}
    </>
  );
}

function PolicyRow({
  provider,
  policy,
  viewer,
  port,
  onPolicy,
}: {
  provider: SpaceCredentialProviderName;
  policy: CredentialsSpacePolicyView | null;
  viewer: SpaceCredentialsViewer | null;
  port: SpaceCredentialsPort;
  onPolicy(next: CredentialsSpacePolicyView): void;
}) {
  const [failure, setFailure] = useState<SpaceCredentialFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = allowedSourcesOf(policy, provider);
  const nodeOk = nodeAllowedOf(policy, provider);
  const admin = viewer?.isSpaceAdmin === true;
  const name = SPACE_PROVIDER_NAME[provider];

  async function flip(source: CredentialPolicySource) {
    if (!policy) return;
    const next = toggleSource(allowed, source);
    setBusy(true);
    setFailure(null);
    try {
      const result = await port.setPolicy(provider, next);
      onPolicy({
        ...policy,
        providers: [
          ...policy.providers.filter((p) => p.provider !== provider),
          { provider, allowedSources: result.allowedSources },
        ],
      });
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="set-spc__policy" data-testid={`space-cred-policy-${provider}`}>
      <span className="set-spc__policy-title">Launches may use</span>
      {(['member', 'space', 'node'] as const).map((source) => {
        const on = allowed.includes(source);
        const last = on && allowed.length === 1;
        const reason = !admin
          ? 'Only a space admin changes this policy.'
          : last
            ? 'At least one source must stay allowed.'
            : null;
        return (
          <label key={source} className="set-spc__toggle">
            <input
              type="checkbox"
              checked={on}
              aria-label={`${name} allows ${SOURCE_WORD[source]}`}
              aria-disabled={reason ? 'true' : undefined}
              disabled={busy}
              title={reason ?? undefined}
              onChange={() => { if (!reason) void flip(source); }}
            />
            {SOURCE_WORD[source]}
          </label>
        );
      })}
      {!nodeOk ? (
        <span className="set-spc__why" data-testid={`space-cred-node-forbidden-${provider}`}>
          The node admin has turned node fallback off for {name}, whatever this says.
        </span>
      ) : null}
      {!admin ? <span className="set-spc__why">Only a space admin changes this policy.</span> : null}
      {failure ? (
        <p className={`set-spc__fail set-spc__fail--${failure.kind}`} role="alert" data-testid={`space-cred-failure-${failure.kind}`}>
          {failure.text}
        </p>
      ) : null}
    </div>
  );
}
