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
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  CredentialPolicySource,
  CredentialsSpaceCreateInput,
  CredentialsSpacePolicyView,
  CredentialsSpaceUsageView,
  SpaceCredentialProviderName,
  SpaceCredentialView,
} from '@tm8/contract';
import { SectionAbsent, SectionFrame } from '../settings-space';
import type { SpaceCredentialsPort, SpaceCredentialsViewer, SpaceLoginProvider, SpaceLoginTarget } from './space-port';
import {
  SHARED_SERVER_WARNING,
  SOURCE_WORD,
  SPACE_CREDENTIAL_PROVIDERS,
  SPACE_PROVIDER_NAME,
  SPACE_SECRET_NOUN,
  afterDeleteNotice,
  allowedSourcesOf,
  canClaim,
  canManage,
  canMyDefault,
  canRevoke,
  canSeeUsage,
  canSetVisibility,
  creatorLabel,
  ownerLabel,
  visibilityWord,
  failureOf,
  formatWhen,
  groupByProvider,
  labelTakenReason,
  nodeAllowedOf,
  noDefaultNotice,
  pasteShapeOf,
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
          Keys in this space. Every member can launch with a public one; a private one is its
          owner&apos;s alone. A launch picks yours first, then the space&apos;s default, then the
          node&apos;s, unless a policy below says otherwise. An owned credential is changed by its
          owner; any other by its creator or a space admin.
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
  // The view carries no "my default": it is known here from the set/clear answer.
  const [myDefault, setMyDefaultId] = useState<string | null>(null);

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
  async function startLogin(target: SpaceLoginTarget, opts: { asPrivate?: boolean } = {}): Promise<SpaceLoginStartFailure | null> {
    if (!isLoginProvider(provider)) return null;
    setLoginBusy(true);
    setLoginFailure(null);
    try {
      const started = await port.startLogin(provider, target);
      // "Add to this space as private" for a login (doc 13 §7): a FRESH
      // sign-in — no login file is ever copied. The pending row is claimed
      // and made private BEFORE the terminal is shown, so nobody else can
      // launch on it or open its terminal once it is signed in. The server
      // login PTY already runs from login.start, so EVERY throw from here
      // to setLogin lands in the one catch below, which deletes the pending
      // row (terminating that PTY) instead of leaving it live until the TTL
      // sweep.
      const pendingId = started.spaceCredential?.id ?? null;
      let label = target.label ?? '';
      try {
        label = started.spaceCredential?.label ?? target.label ?? allRows.find((r) => r.id === target.credentialId)?.label ?? '';
        if (opts.asPrivate) {
          if (!pendingId) throw new Error('the server did not name the pending credential');
          await port.claim(pendingId);
          await port.setVisibility(pendingId, 'private');
        }
      } catch (err) {
        if (!opts.asPrivate) throw err;
        const why = failureOf(err);
        let removed = false;
        if (pendingId) {
          try {
            await port.remove(pendingId);
            removed = true;
          } catch {
            // The pending row stays; the text below says to delete it.
          }
        }
        setLoginFailure({
          kind: 'failure',
          failure: {
            kind: why.kind,
            text: removed
              ? `The login for “${label}” was not opened: it could not be made private. ${why.text} Nothing was signed in, and the pending “${label}” was deleted.`
              : `The login for “${label}” was not opened: it could not be made private. ${why.text} Nothing was signed in; delete the pending “${label}” to free its label.`,
          },
        });
        await onChanged();
        return { kind: 'failure', failure: why };
      }
      setLogin({
        provider,
        workSessionId: started.workSessionId,
        expiresAt: started.expiresAt,
        command: started.command,
        credentialId: started.spaceCredential?.id ?? target.credentialId ?? null,
        seen: false,
        lede: opts.asPrivate
          ? `Logging in for your new private credential “${label}”. Only you can launch with it or open its terminals. Follow the terminal prompts, then press “I’ve finished signing in”.`
          : target.credentialId
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
            <CredentialRow key={row.id} row={row} allRows={allRows} viewer={viewer} port={port} onChanged={onChanged} login={loginControls}
              myDefault={myDefault === row.id} onMyDefault={setMyDefaultId} />
          ))}
        </ul>
      )}
      <AddByKey provider={provider} rows={allRows} viewer={viewer} port={port} onChanged={onChanged} login={loginControls} />
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
  myDefault,
  onMyDefault,
}: {
  row: SpaceCredentialView;
  allRows: SpaceCredentialView[];
  viewer: SpaceCredentialsViewer | null;
  port: SpaceCredentialsPort;
  onChanged(message?: string): Promise<void>;
  login: LoginControls | null;
  /** This row is the viewer's own default for its provider, as last set here. */
  myDefault: boolean;
  onMyDefault(credentialId: string | null): void;
}) {
  const manage = canManage(row, viewer);
  const revoke = canRevoke(row, viewer);
  const owner = canSetVisibility(row, viewer);
  const claimable = canClaim(row, viewer);
  const mine = canMyDefault(row, viewer);
  const usageAllowed = canSeeUsage(row, viewer);
  const [mode, setMode] = useState<'idle' | 'rename' | 'rekey' | 'confirm-delete' | 'confirm-private'>('idle');
  const [usage, setUsage] = useState<CredentialsSpaceUsageView | null>(null);
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
  const pasted = row.shape !== 'login';
  const statusWord = row.status === 'stale' ? 'failed its last check' : row.status === 'pending' ? 'login not finished' : 'active';
  const visibility = visibilityWord(row);
  const ownedBy = ownerLabel(row, viewer);

  async function toggleUsage() {
    if (usage) { setUsage(null); return; }
    setBusy('plain');
    setFailure(null);
    try {
      setUsage(await port.usage(row.id));
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={`set-spc__row set-spc__row--${row.status}`} data-testid={`space-cred-row-${row.id}`}>
      <div className="set-spc__row-head">
        <span className="set-spc__label">{row.label}</span>
        {row.isDefault ? <span className="set-spc__badge set-spc__badge--default">default</span> : null}
        {myDefault ? <span className="set-spc__badge set-spc__badge--default" data-testid={`space-cred-my-default-${row.id}`}>my default</span> : null}
        {visibility ? (
          <span className={`set-spc__badge set-spc__badge--${visibility}`} data-testid={`space-cred-visibility-${row.id}`}>{visibility}</span>
        ) : null}
        <span className={`set-spc__badge set-spc__badge--${row.status}`}>{statusWord}</span>
      </div>
      <div className="set-spc__meta">
        <span>{row.shape === 'login' ? 'login' : row.shape === 'token' ? 'token' : 'API key'}</span>
        {row.keyHint ? <span data-testid={`space-cred-hint-${row.id}`}>ends …{row.keyHint}</span> : null}
        {row.displayLogin ? <span>as {row.displayLogin}</span> : null}
        {ownedBy ? <span data-testid={`space-cred-owner-${row.id}`}>owned by {ownedBy}</span> : null}
        <span>added by {creatorLabel(row, viewer)}</span>
        <span>last used {formatWhen(row.lastUsedAt)}</span>
      </div>

      {owner || claimable || mine || usageAllowed ? (
        <div className="cred-card__actions set-spc__actions" data-testid={`space-cred-owner-actions-${row.id}`}>
          {claimable ? (
            <button type="button" className="cred-action" aria-label={`Claim as mine ${row.label}`} disabled={busy !== null}
              onClick={() => void run('plain', async () => { await port.claim(row.id); return `“${row.label}” is now yours. It stays public until you make it private.`; })}>
              Claim as mine
            </button>
          ) : null}
          {owner && row.visibility === 'private' ? (
            <button type="button" className="cred-action" aria-label={`Make public ${row.label}`} disabled={busy !== null}
              onClick={() => void run('plain', async () => { await port.setVisibility(row.id, 'public'); return `“${row.label}” is public: every member can launch with it.`; })}>
              Make public
            </button>
          ) : null}
          {owner && row.visibility !== 'private' ? (
            <button type="button" className="cred-action" aria-label={`Make private ${row.label}`} disabled={busy !== null}
              onClick={() => { setFailure(null); setMode(mode === 'confirm-private' ? 'idle' : 'confirm-private'); }}>
              Make private
            </button>
          ) : null}
          {owner && row.visibility === 'public' ? (
            <button type="button" className="cred-action" aria-pressed={row.mayBeSpaceDefault === true}
              aria-label={`${row.mayBeSpaceDefault ? 'Withdraw space-default consent' : 'Allow as space default'} ${row.label}`} disabled={busy !== null}
              onClick={() => void run('plain', async () => {
                const next = row.mayBeSpaceDefault !== true;
                await port.spaceDefaultConsent(row.id, next);
                return next
                  ? `“${row.label}” may now be made the space default.`
                  : `“${row.label}” may no longer be the space default${row.isDefault ? ', so the space has no default for it now' : ''}.`;
              })}>
              {row.mayBeSpaceDefault ? 'Withdraw space-default consent' : 'Allow as space default'}
            </button>
          ) : null}
          {mine && !myDefault ? (
            <button type="button" className="cred-action" aria-label={`Make my default ${row.label}`} disabled={busy !== null}
              onClick={() => void run('plain', async () => {
                const result = await port.setMyDefault(row.id);
                onMyDefault(result.credentialId);
                return `Your ${SPACE_PROVIDER_NAME[row.provider]} launches in this space now use “${row.label}” first.`;
              })}>
              Make my default
            </button>
          ) : null}
          {myDefault ? (
            <button type="button" className="cred-action" aria-label={`Clear my default ${row.label}`} disabled={busy !== null}
              onClick={() => void run('plain', async () => {
                const result = await port.clearMyDefault(row.provider);
                onMyDefault(result.credentialId);
                return `You have no ${SPACE_PROVIDER_NAME[row.provider]} default of your own in this space now.`;
              })}>
              Clear my default
            </button>
          ) : null}
          {usageAllowed ? (
            <button type="button" className="cred-action" aria-expanded={usage !== null} aria-label={`Usage ${row.label}`} disabled={busy !== null}
              onClick={() => void toggleUsage()}>
              {usage ? 'Hide usage' : 'Usage'}
            </button>
          ) : null}
        </div>
      ) : null}

      {owner && mode === 'confirm-private' ? (
        <div className="set-spc__confirm" data-testid={`space-cred-private-confirm-${row.id}`}>
          {viewer?.sharedServer ? (
            <p className="set-spc__warn" data-testid="space-cred-shared-warning">{SHARED_SERVER_WARNING}</p>
          ) : null}
          <p className="set-spc__muted">Sessions other members launched with it end now, and it stops being any default.</p>
          <div className="cred-card__actions">
            <button type="button" className="cred-action cred-action--primary" aria-label={`Confirm make private ${row.label}`} disabled={busy !== null}
              onClick={() => void run('plain', async () => {
                const result = await port.setVisibility(row.id, 'private');
                const ended = result.terminatedAgentSessionIds.length;
                return `“${row.label}” is private.${ended ? ` ${ended} session${ended === 1 ? '' : 's'} another member launched with it ended.` : ''}`;
              })}>
              Make private
            </button>
            <button type="button" className="cred-action" aria-label={`Keep public ${row.label}`} onClick={() => setMode('idle')}>Keep public</button>
          </div>
        </div>
      ) : null}

      {usage ? <UsageList usage={usage} viewer={viewer} /> : null}

      {manage || revoke ? (
        <div className="cred-card__actions set-spc__actions">
          {manage && !row.isDefault && row.status === 'active' ? (
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
          {manage && !pasted && login ? (
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
              <button type="button" className="cred-action set-spc__danger" aria-label={`Confirm delete ${row.label}`} disabled={busy !== null}
                onClick={() => void run('plain', async () => {
                  const result = await port.remove(row.id);
                  return afterDeleteNotice(row, result.terminatedAgentSessionIds.length + result.terminatedLoginSessionIds.length);
                })}>
                Delete, and end sessions using it
              </button>
              <button type="button" className="cred-action" aria-label={`Keep ${row.label}`} onClick={() => setMode('idle')}>Keep</button>
            </>
          ) : (
            <button type="button" className="cred-action set-spc__danger" aria-label={`Delete ${row.label}`} disabled={busy !== null}
              onClick={() => { setFailure(null); setMode('confirm-delete'); }}>
              Delete
            </button>
          )}
        </div>
      ) : (
        <p className="set-spc__muted" data-testid={`space-cred-readonly-${row.id}`}>
          {row.ownerAccountId
            ? row.visibility === 'private'
              ? 'Private to another member. Only its owner can launch with it or change it.'
              : 'You can launch with it. Only its owner can change it.'
            : 'You can launch with it. Only its creator or a space admin can change it.'}
        </p>
      )}
      {!manage && revoke ? (
        <p className="set-spc__muted" data-testid={`space-cred-admin-only-${row.id}`}>
          Another member owns it: as a space admin you can delete it, not change it.
        </p>
      ) : null}

      {revoke && mode === 'confirm-delete' ? (
        <p className="set-spc__warn">
          Deleting ends every live session using this credential.
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

/** Who a pasted key is for (doc 13 §3a, E1). `legacy` sends neither field. */
type AddAudience = 'legacy' | 'private' | 'public' | 'space';

function audienceFields(audience: AddAudience, mayBeSpaceDefault: boolean): Pick<CredentialsSpaceCreateInput, 'visibility' | 'spaceOwned' | 'mayBeSpaceDefault'> {
  if (audience === 'private') return { visibility: 'private' };
  if (audience === 'public') return mayBeSpaceDefault ? { visibility: 'public', mayBeSpaceDefault: true } : { visibility: 'public' };
  if (audience === 'space') return { spaceOwned: true };
  return {};
}

function AddByKey({
  provider,
  rows,
  viewer,
  port,
  onChanged,
  login,
}: {
  provider: SpaceCredentialProviderName;
  rows: SpaceCredentialView[];
  viewer: SpaceCredentialsViewer | null;
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
  const [audience, setAudience] = useState<AddAudience>('legacy');
  const [mayBeDefault, setMayBeDefault] = useState(false);
  /** "Add to this space as private": a fresh sign-in (Claude/Codex) or my own token re-sealed (GitHub). */
  const [privateOpen, setPrivateOpen] = useState(false);
  const [privateLabel, setPrivateLabel] = useState('');
  const privateTaken = labelTakenReason(provider, privateLabel, rows);

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
      const created = await port.create({
        provider, shape: pasteShapeOf(provider), label: cleanLabel, secret: cleanSecret, ...audienceFields(audience, mayBeDefault),
      });
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

  async function submitPrivate(event: FormEvent) {
    event.preventDefault();
    const cleanLabel = privateLabel.trim();
    if (!cleanLabel || privateTaken) return;
    setFailure(null);
    if (login) {
      // A login is never copied: a fresh sign-in, claimed and made private first.
      if (login.busy) return;
      const refused = await login.start({ label: cleanLabel }, { asPrivate: true });
      if (refused === null) {
        setPrivateOpen(false);
        setPrivateLabel('');
      } else if (refused.kind === 'label_taken') {
        setFailure({ kind: 'invalid', text: refused.text });
      }
      return;
    }
    if (provider !== 'github') return;
    setBusy('probe');
    try {
      // The server re-seals MY server-level token; no secret passes through here.
      const created = await port.addMine('github', cleanLabel);
      setPrivateOpen(false);
      setPrivateLabel('');
      await onChanged(`Added your GitHub token to this space as “${created.label}”, private to you.`);
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(null);
    }
  }

  const canAddPrivate = viewer?.accountId != null && (login !== null || provider === 'github');

  return (
    <div className="set-spc__add">
      <div className="cred-card__actions">
        <button type="button" className="cred-action cred-action--primary" aria-label={`Add ${name} ${noun}`}
          aria-expanded={open} onClick={() => { setOpen(!open); setLoginOpen(false); setPrivateOpen(false); setFailure(null); }}>
          + Add {noun}
        </button>
        {login ? (
          <button type="button" className="cred-action" aria-label={`Add ${name} by login`} aria-expanded={loginOpen}
            onClick={() => { setLoginOpen(!loginOpen); setOpen(false); setPrivateOpen(false); }}>
            + Add by login
          </button>
        ) : null}
        {canAddPrivate ? (
          <button type="button" className="cred-action" aria-label={`Add ${name} to this space as private`} aria-expanded={privateOpen}
            onClick={() => { setPrivateOpen(!privateOpen); setOpen(false); setLoginOpen(false); setFailure(null); }}>
            + Add to this space as private
          </button>
        ) : null}
      </div>
      {privateOpen ? (
        <form className="set-spc__form" data-testid={`space-cred-private-form-${provider}`} onSubmit={(e) => void submitPrivate(e)}>
          <input className="set-spc__input" aria-label={`Label for your private ${name} credential`} placeholder="Label, e.g. Mine"
            value={privateLabel} maxLength={80} onChange={(e) => setPrivateLabel(e.target.value)} />
          <button type="submit" className="cred-action cred-action--primary" aria-label={`Add private ${name}`}
            disabled={busy !== null || (login?.busy ?? false) || !privateLabel.trim() || privateTaken !== null}>
            {login ? 'Open login terminal' : 'Add my token'}
          </button>
          {privateTaken ? <span className="set-spc__why">{privateTaken}</span> : null}
          <span className="set-spc__why">
            {login
              ? 'A fresh sign-in, yours alone: your existing login is never copied.'
              : 'Uses the GitHub token on your account, re-sealed for this space. Nothing is pasted, and no other space gets it.'}
          </span>
          {viewer?.sharedServer ? (
            <p className="set-spc__warn" data-testid="space-cred-shared-warning">{SHARED_SERVER_WARNING}</p>
          ) : null}
        </form>
      ) : null}
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
          <select className="set-spc__input" aria-label={`Who can use the new ${name} ${noun}`} value={audience}
            onChange={(e) => setAudience(e.target.value as AddAudience)}>
            <option value="legacy">The space, until I claim it</option>
            <option value="private">Only me (private)</option>
            <option value="public">Every member, owned by me</option>
            <option value="space">The space, for good</option>
          </select>
          {audience === 'public' ? (
            <label className="set-spc__why">
              <input type="checkbox" aria-label={`May be the space default ${name}`} checked={mayBeDefault}
                onChange={(e) => setMayBeDefault(e.target.checked)} />
              {' '}May be the space default
            </label>
          ) : null}
          {taken ? <span className="set-spc__why" data-testid="space-cred-label-taken">{taken}</span> : null}
          {secretProblem ? <span className="set-spc__why">{secretProblem}</span> : null}
          {audience === 'private' && viewer?.sharedServer ? (
            <p className="set-spc__warn" data-testid="space-cred-shared-warning">{SHARED_SERVER_WARNING}</p>
          ) : null}
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
  start(target: SpaceLoginTarget, opts?: { asPrivate?: boolean }): Promise<SpaceLoginStartFailure | null>;
}

/** The launches on one credential (`credentials.space.usage`): who, when, and how it was picked. */
function UsageList({ usage, viewer }: { usage: CredentialsSpaceUsageView; viewer: SpaceCredentialsViewer | null }) {
  if (usage.sessions.length === 0) {
    return <p className="set-spc__muted" data-testid={`space-cred-usage-${usage.credentialId}`}>No launches on it yet.</p>;
  }
  const PICK: Record<string, string> = { pinned: 'pinned', my_default: "the launcher's own default", space_default: 'space default' };
  return (
    <ul className="set-spc__usage" data-testid={`space-cred-usage-${usage.credentialId}`}>
      {usage.sessions.map((s) => (
        <li key={s.workSessionId}>
          {s.launcherAccountId && s.launcherAccountId === viewer?.accountId ? 'you' : s.launcherAccountId ? 'another member' : 'unknown'}
          {' · '}{s.source ? PICK[s.source] ?? s.source : 'picked before this was recorded'}
          {' · '}{s.status}
          {' · '}{formatWhen(s.recordedAt)}
        </li>
      ))}
    </ul>
  );
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
