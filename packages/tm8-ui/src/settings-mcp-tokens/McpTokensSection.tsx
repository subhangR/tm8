/**
 * Settings → MCP tokens (plan §10.7, decision D9).
 *
 * A token minted here acts as YOU, from outside tm8: Claude Desktop, Cursor or
 * another MCP client presents it on this node's `/mcp` endpoint and reaches
 * the connectors you have connected. It is refused on every other transport.
 *
 * THE SECRET IS SHOWN ONCE AND IS NEVER PERSISTED BY THIS SURFACE (surface
 * security item e). There is no reveal operation to pair with `create`, so
 * `created` below — one piece of React state, holding the single response that
 * carried the plaintext — IS the token's whole lifetime in this browser. It is
 * never written to `localStorage`, `sessionStorage`, a URL, a form value, a
 * log, or any state that outlives the panel; dismissing the panel drops it,
 * and the list that replaces it has no field that could carry it back.
 *
 * WHAT A MEMBER MUST BE TOLD, drawn above everything else: a token acts as
 * them (so it is as strong as their own session), and an external client sees
 * a connector only where a Space admin turned on "Available to external MCP
 * clients" — without that, a token that authenticates perfectly still lists no
 * tools, and the member would otherwise read that as a broken token.
 *
 * Every write here is human-only on the server, at the facade and again in
 * SQL. A refusal — a duplicate label, a Space you are not in, the 20-token
 * cap, a space-pinned session asked for "all my spaces" — is rendered as the
 * refusal the server gave, never swallowed and never restated as a guess.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { McpTokenCreateResult, McpTokenView } from '@tm8/contract';
import { useNow } from '../kit/time';
import { relTime } from '@tm8/client-core/time';
import { SectionAbsent, SectionFrame } from '../settings-space';
import { clientSnippets, type McpClientSnippet } from './snippets';
import { expiryLabel, spacesLabel, tokenState, tokenWarnings } from './rows';
import type { McpTokenSpace, McpTokensPort } from './port';
import './mcp-tokens.css';

export interface McpTokensSectionProps {
  port: McpTokensPort;
  heading?: string;
}

/** §10.7: 30 / 90 / 365 / custom, no "never" (B63.1). The default is 90. */
const EXPIRY_PRESETS = [30, 90, 365] as const;
/** The server's own ceiling (`create_mcp_token`), restated so the form refuses first. */
const MAX_EXPIRY_DAYS = 365;
/** `McpTokenCreateInputSchema`'s cap on a named list. */
const MAX_SPACES = 32;

function failureOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  return code === 'forbidden' ? `Refused: ${message}` : message;
}

export function McpTokensSection({ port, heading = 'MCP tokens' }: McpTokensSectionProps) {
  const [tokens, setTokens] = useState<McpTokenView[] | null>(null);
  const [spaces, setSpaces] = useState<McpTokenSpace[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  /* The one response that carried a plaintext token. Dropped on dismiss. */
  const [created, setCreated] = useState<McpTokenCreateResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useNow();

  const reload = useCallback(
    () => port.list().then(
      (next) => { setTokens(next); setLoadError(null); },
      (err: unknown) => setLoadError(failureOf(err)),
    ),
    [port],
  );

  useEffect(() => {
    let live = true;
    void port.list().then(
      (next) => { if (live) { setTokens(next); setLoadError(null); } },
      (err: unknown) => { if (live) setLoadError(failureOf(err)); },
    );
    // The picker is a convenience: a failed read still leaves "All my spaces".
    void port.spaces().then((next) => { if (live) setSpaces(next); }, () => {});
    return () => { live = false; };
  }, [port]);

  const names = useMemo(() => new Map(spaces.map((space) => [space.id, space.name])), [spaces]);

  if (loadError) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Your MCP tokens could not be read." why={loadError} testId="mcp-tokens-load-error" />
      </SectionFrame>
    );
  }

  return (
    <SectionFrame
      title={heading}
      action={
        <button type="button" className="set-chip" data-testid="mcp-token-new"
          disabled={formOpen || created !== null}
          onClick={() => { setFormOpen(true); setNotice(null); }}>
          ＋ New token
        </button>
      }
    >
      <div className="set-mcpt" data-testid="mcp-tokens">
        <p className="set-prose">
          Use these to connect Claude Desktop, Cursor or another MCP client to tm8.
        </p>
        <div className="set-mcpt__warning" role="note" data-testid="mcp-tokens-warning">
          <p>Tokens act as you. Anyone holding one reaches what you reach, until it expires or you revoke it.</p>
          <p>
            An external client sees a connector only where a Space admin turned on
            {' '}<strong>Available to external MCP clients</strong>. Until an admin enables that, a working token
            lists no tools from that Space.
          </p>
        </div>
        {notice ? (
          <p className="set-mcpt__notice" role="status" data-testid="mcp-tokens-notice">{notice}</p>
        ) : null}
        {created ? (
          <ShowOncePanel
            created={created}
            onDismiss={() => { setCreated(null); setNotice(null); void reload(); }}
          />
        ) : null}
        {formOpen && !created ? (
          <CreateTokenForm
            port={port}
            spaces={spaces}
            onCancel={() => setFormOpen(false)}
            onCreated={(result) => { setFormOpen(false); setCreated(result); }}
          />
        ) : null}
        {tokens === null ? <p className="set-mcpt__muted">Reading…</p> : null}
        {tokens !== null && tokens.length === 0 && !created ? (
          <p className="set-mcpt__muted" data-testid="mcp-tokens-empty">
            No tokens yet. Create one to use tm8 from Claude Desktop or Cursor.
          </p>
        ) : null}
        {tokens !== null && tokens.length > 0 ? (
          <ul className="set-mcpt__list">
            {tokens.map((token) => (
              <TokenRow key={token.id} token={token} names={names} now={now} port={port}
                onChanged={(message) => { setNotice(message); void reload(); }} />
            ))}
          </ul>
        ) : null}
      </div>
    </SectionFrame>
  );
}

/**
 * THE NEW-TOKEN FORM (§10.7's modal, drawn inline above the list).
 *
 * A top-level component, not a closure inside the section: a component
 * redeclared per parent render is a NEW type to React, so every tick of the
 * section's clock would unmount this form and wipe a half-typed label.
 */
function CreateTokenForm({
  port, spaces: rows, onCancel, onCreated,
}: {
  port: McpTokensPort;
  spaces: McpTokenSpace[];
  onCancel(): void;
  onCreated(result: McpTokenCreateResult): void;
}) {
  const [reach, setReach] = useState<'all' | 'some'>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [preset, setPreset] = useState<'30' | '90' | '365' | 'custom'>('90');
  const [customDays, setCustomDays] = useState('180');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = preset === 'custom' ? Number(customDays) : Number(preset);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= MAX_EXPIRY_DAYS;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!label.trim()) { setError('A token needs a label, so you can tell your tokens apart.'); return; }
    if (reach === 'some' && chosen.length === 0) {
      setError('Choose at least one Space, or pick “All my spaces”.');
      return;
    }
    if (!daysValid) { setError(`Expiry is a whole number of days between 1 and ${MAX_EXPIRY_DAYS}.`); return; }
    setBusy(true);
    try {
      onCreated(await port.create({
        label: label.trim(),
        // REQUIRED and nullable: null is the radio the member chose, never a
        // field this form forgot to send.
        spaceIds: reach === 'all' ? null : chosen,
        expiresInDays: days,
      }));
    } catch (err) {
      setError(failureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="set-mcpt__form" data-testid="mcp-token-form" onSubmit={(e) => { void submit(e); }}>
      <span className="set-eyebrow">New token</span>
      <label className="set-mcpt__label">
        Label
        <input name="label" value={label} maxLength={80} autoComplete="off" required
          placeholder="Laptop – Claude Desktop"
          onChange={(e) => setLabel(e.target.value)} />
      </label>
      <fieldset className="set-mcpt__fieldset">
        <legend>Spaces</legend>
        <label className="set-mcpt__radio">
          <input type="radio" name="reach" value="all" checked={reach === 'all'}
            onChange={() => setReach('all')} />
          All my spaces, including ones I join later
        </label>
        <label className="set-mcpt__radio">
          <input type="radio" name="reach" value="some" checked={reach === 'some'}
            onChange={() => setReach('some')} />
          Only these
        </label>
        {reach === 'some' ? (
          <div className="set-mcpt__spaces" data-testid="mcp-token-spaces">
            {rows.length === 0 ? (
              <p className="set-mcpt__muted">Your spaces could not be read. Pick “All my spaces”, or try again.</p>
            ) : rows.map((space) => (
              <label className="set-mcpt__check" key={space.id}>
                <input type="checkbox" checked={chosen.includes(space.id)}
                  disabled={!chosen.includes(space.id) && chosen.length >= MAX_SPACES}
                  onChange={(e) => setChosen((prev) => (
                    e.target.checked ? [...prev, space.id] : prev.filter((id) => id !== space.id)
                  ))} />
                {space.name}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <fieldset className="set-mcpt__fieldset">
        <legend>Expires</legend>
        {EXPIRY_PRESETS.map((value) => (
          <label className="set-mcpt__radio" key={value}>
            <input type="radio" name="expiry" value={value} checked={preset === String(value)}
              onChange={() => setPreset(String(value) as '30' | '90' | '365')} />
            {value} days
          </label>
        ))}
        <label className="set-mcpt__radio">
          <input type="radio" name="expiry" value="custom" checked={preset === 'custom'}
            onChange={() => setPreset('custom')} />
          Custom
        </label>
        {preset === 'custom' ? (
          <label className="set-mcpt__label">
            Days (1–{MAX_EXPIRY_DAYS})
            <input type="number" name="customDays" min={1} max={MAX_EXPIRY_DAYS} value={customDays}
              onChange={(e) => setCustomDays(e.target.value)} />
          </label>
        ) : null}
        <p className="set-mcpt__muted">A token always expires: {MAX_EXPIRY_DAYS} days is the longest this node mints.</p>
      </fieldset>
      {error ? <p className="set-mcpt__fail" role="alert" data-testid="mcp-token-create-error">{error}</p> : null}
      <div className="set-mcpt__actions">
        <button type="submit" className="set-chip" disabled={busy} data-testid="mcp-token-create">
          {busy ? 'Creating…' : 'Create token'}
        </button>
        <button type="button" className="set-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * THE SHOW-ONCE PANEL. Everything derived from the secret is derived HERE, in
 * the render that has it, and nothing is hoisted into a parent or a store: the
 * dismiss drops the one reference and the derived snippets go with it.
 */
function ShowOncePanel({ created, onDismiss }: { created: McpTokenCreateResult; onDismiss(): void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const snippets = useMemo(() => clientSnippets(created.endpoint, created.secret), [created]);

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
      setCopied(null);
    }
  }

  return (
    <div className="set-mcpt__once" data-testid="mcp-token-created">
      <span className="set-eyebrow">Token created</span>
      <p className="set-mcpt__once-head">
        <strong>{created.token.label}</strong> is shown once. Copy it now — tm8 keeps only its hash, and there is
        no way to show it again.
      </p>
      <div className="set-mcpt__secret-row">
        <code className="set-mcpt__secret" data-testid="mcp-token-secret">{created.secret}</code>
        <button type="button" className="set-chip" data-testid="mcp-token-copy"
          onClick={() => { void copy('token', created.secret); }}>Copy</button>
      </div>
      <p className="set-note">Endpoint: {created.endpoint}</p>
      {copied ? <p className="set-mcpt__notice" role="status">Copied the {copied} to your clipboard.</p> : null}
      {copyFailed ? (
        <p className="set-mcpt__fail" role="alert">
          This browser refused clipboard access. Select the token above and copy it by hand.
        </p>
      ) : null}
      {snippets.map((snippet) => (
        <SnippetBlock key={snippet.id} snippet={snippet} onCopy={copy} />
      ))}
      <p className="set-mcpt__once-foot">You won’t see this token again.</p>
      <button type="button" className="set-chip" data-testid="mcp-token-dismiss" onClick={onDismiss}>
        I’ve copied it
      </button>
    </div>
  );
}

function SnippetBlock({
  snippet, onCopy,
}: {
  snippet: McpClientSnippet;
  onCopy(what: string, text: string): Promise<void>;
}) {
  return (
    <div className="set-mcpt__snippet" data-testid={`mcp-token-snippet-${snippet.id}`}>
      <div className="set-mcpt__snippet-head">
        <span className="set-mcpt__snippet-client">{snippet.client}</span>
        <span className="set-note">{snippet.where}</span>
        <button type="button" className="set-ghost" aria-label={`Copy the ${snippet.client} snippet`}
          onClick={() => { void onCopy(`${snippet.client} snippet`, snippet.text); }}>Copy</button>
      </div>
      {snippet.note ? <p className="set-mcpt__muted">{snippet.note}</p> : null}
      <pre className="set-mcpt__code"><code>{snippet.text}</code></pre>
    </div>
  );
}

function TokenRow({
  token, names, now, port, onChanged,
}: {
  token: McpTokenView;
  names: ReadonlyMap<string, string>;
  now: number;
  port: McpTokensPort;
  onChanged(message: string): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const state = tokenState(token, now);
  const warnings = tokenWarnings(token, now);

  async function revoke() {
    setBusy(true);
    setFailure(null);
    try {
      await port.revoke(token.id);
      setConfirming(false);
      onChanged(`Revoked ${token.label}. Clients using it stop working immediately.`);
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="set-mcpt__row" data-state={state} data-testid={`mcp-token-${token.id}`}>
      <div className="set-mcpt__row-head">
        <span className="set-mcpt__name">{token.label}</span>
        {/* §10.7 draws these as table columns. Written as one labelled line
            instead: measured at 1508x882, bare cells ran together — an expired
            token read as "Expired Jul 23", two columns the eye joined into one
            wrong fact. The words carry what a column header would have. */}
        <span className="set-mcpt__cell" data-testid={`mcp-token-spaces-${token.id}`}>
          {spacesLabel(token, names)}
        </span>
        <span className="set-mcpt__sep" aria-hidden="true">·</span>
        <span className="set-mcpt__cell" data-testid={`mcp-token-expiry-${token.id}`}>
          {expiryLabel(token, now)}
        </span>
        <span className="set-mcpt__sep" aria-hidden="true">·</span>
        <span className="set-mcpt__cell">
          {token.lastUsedAt
            ? `last used ${relTime(token.lastUsedAt, now)}${token.lastUsedIp ? ` (${token.lastUsedIp})` : ''}`
            : 'never used'}
        </span>
        {state === 'revoked' ? (
          <span className="set-mcpt__revoked" data-testid={`mcp-token-revoked-${token.id}`}>Revoked</span>
        ) : (
          <button type="button" className="set-ghost" aria-label={`Revoke ${token.label}`} disabled={busy}
            onClick={() => setConfirming(true)}>Revoke</button>
        )}
      </div>
      {state === 'revoked' ? (
        <p className="set-mcpt__muted">This row drops off the list a day after it was revoked.</p>
      ) : null}
      {warnings.map((warning) => (
        <p key={warning.text} className={`set-mcpt__warn set-mcpt__warn--${warning.tone}`}>{warning.text}</p>
      ))}
      {confirming ? (
        <div className="set-mcpt__confirm" data-testid={`mcp-token-confirm-${token.id}`}>
          <p>Clients using {token.label} will stop working immediately. This cannot be undone.</p>
          <div className="set-mcpt__actions">
            <button type="button" className="set-chip" disabled={busy} data-testid={`mcp-token-revoke-${token.id}`}
              onClick={() => { void revoke(); }}>{busy ? 'Revoking…' : 'Revoke token'}</button>
            <button type="button" className="set-ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}
      {failure ? <p className="set-mcpt__fail" role="alert">{failure}</p> : null}
    </li>
  );
}
