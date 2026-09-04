import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import type { AddServerInput } from './server-registry';

export interface AddServerDialogProps {
  open: boolean;
  onDismiss(): void;
  onAdd(input: AddServerInput): Promise<unknown>;
}

export function AddServerDialog({ open, onDismiss, onAdd }: AddServerDialogProps) {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:4730');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onDismiss();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open, onDismiss, submitting]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name.trim().toLowerCase())) {
      setError('Name must start with a letter and use lowercase letters, numbers, or hyphens.');
      return;
    }
    let normalizedUrl: string;
    try {
      const parsed = new URL(baseUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
      if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error();
      normalizedUrl = parsed.origin;
    } catch {
      setError('Enter an http(s) Server origin with no path or credentials.');
      return;
    }
    setSubmitting(true);
    try {
      await onAdd({ name: name.trim().toLowerCase(), baseUrl: normalizedUrl, username: username.trim() || undefined });
      onDismiss();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const stop = (event: MouseEvent) => event.stopPropagation();
  return (
    <div className="server-dialog__backdrop" role="presentation" onMouseDown={() => !submitting && onDismiss()}>
      <form className="server-dialog" role="dialog" aria-modal="true" aria-labelledby="add-server-title" onSubmit={submit} onMouseDown={stop}>
        <h2 id="add-server-title">Add server</h2>
        <p>Connect another tm8 node. Its spaces and menu appear in this rail as a group.</p>

        <label className="server-dialog__field">
          <span>SERVER URL</span>
          <input autoFocus value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://tm8.example.com" />
        </label>
        <label className="server-dialog__field">
          <span>NAME</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="my-node" />
        </label>
        <label className="server-dialog__field">
          <span>USERNAME · OPTIONAL</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="operator" />
        </label>

        <div className="server-dialog__auth-note">Authentication is not sent yet. Username is saved as connection metadata.</div>
        {error ? <div className="server-dialog__error" role="alert">{error}</div> : null}

        <div className="server-dialog__actions">
          <button type="button" onClick={onDismiss} disabled={submitting}>Cancel</button>
          <button type="submit" className="server-dialog__primary" disabled={submitting}>
            {submitting ? 'Adding…' : 'Add server'}
          </button>
        </div>
      </form>
    </div>
  );
}
