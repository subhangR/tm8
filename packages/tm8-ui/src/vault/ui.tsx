import { useCallback, useEffect, useRef, useState } from 'react';
import type { VaultStatus } from '@tm8/contract';
import type { VaultPort } from './port';
import { vaultErrorMessage } from './errors';

export interface SurfaceProps {
  port: VaultPort;
  status: VaultStatus;
  readOnly: boolean;
  onStatusChange(): void;
}

/** Failed loads erase their old value. A rejected response never renders partially. */
export function useVaultResource<T>(load: () => Promise<T>) {
  const [version, setVersion] = useState(0);
  const [resource, setResource] = useState<{ value: T | null; error: string | null; loading: boolean }>({
    value: null, error: null, loading: true,
  });
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let live = true;
    setResource({ value: null, error: null, loading: true });
    void load().then(
      (value) => { if (live) setResource({ value, error: null, loading: false }); },
      (error: unknown) => { if (live) setResource({ value: null, error: vaultErrorMessage(error), loading: false }); },
    );
    return () => { live = false; };
  }, [load, version]);
  return { ...resource, reload };
}

/** The result is never cached here, especially recovery-code results. */
export function useVaultCommand() {
  const live = useRef(true);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await action();
      if (live.current) done?.(result);
    } catch (failure) {
      if (live.current) setError(vaultErrorMessage(failure));
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }
  return { busy, error, notice, setNotice, run };
}

export function ErrorNotice({ message }: { message: string | null }) {
  return message ? <p className="vault-error" role="alert">{message}</p> : null;
}

export function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  return <>{loading ? <p role="status">Reading vault metadata…</p> : null}<ErrorNotice message={error} /></>;
}

export function CommandNotice({ command }: { command: ReturnType<typeof useVaultCommand> }) {
  return <><ErrorNotice message={command.error} />
    {command.notice ? <p role="status">{command.notice}</p> : null}</>;
}

export function TestSecretsNotice({ status }: { status: VaultStatus }) {
  return status.reviewGate === 'open' || status.testSecretsOnly
    ? <p className="vault-warning" role="note"><strong>Test secrets only.</strong> Independent security review is pending.</p>
    : null;
}

export function Metadata({ entries }: { entries: [string, React.ReactNode][] }) {
  return <dl className="vault-metadata">{entries.map(([label, value]) =>
    <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>;
}

export const dateLabel = (value: string): string => new Date(value).toLocaleString();
export const actorLabel = (actor: { name: string | null; kind: string }) => actor.name ?? actor.kind;

export function useVaultNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  return now;
}

export function hasOwnerSession(status: VaultStatus, now = Date.now()) {
  return status.viewer.vaultSession !== null && Date.parse(status.viewer.vaultSession.expiresAt) > now;
}

export function PageControls({ cursor, next, onCursor }: {
  cursor?: string; next: string | null; onCursor(value?: string): void;
}) {
  return <div className="vault-actions">
    {cursor ? <button type="button" onClick={() => onCursor()}>Back to first page</button> : null}
    {next ? <button type="button" onClick={() => onCursor(next)}>Next page</button> : null}
  </div>;
}
