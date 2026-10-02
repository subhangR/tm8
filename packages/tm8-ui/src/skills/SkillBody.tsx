import { useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { Eyebrow } from '../kit/Eyebrow';
import { Markdown } from '../kit/Markdown';
import { Timestamp } from '../kit/Timestamp';
import { SkillEquipment } from './SkillEquipment';
import { ScopePills } from './ScopePills';
import { scopeView } from './scope';
import type { SkillPort } from './port';
import './skills.css';

/** The frontmatter is drawn as its own table below, so the reader shows the body only. */
const withoutFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');

/**
 * SKILL — reader-first: what the skill is for and where it lives, then the
 * SKILL.md itself, then who uses it, then every technical fact the scanner
 * recorded (always visible, by user ruling on task 01a0faff).
 */
export function SkillBody({ detail, port, onOpenEntity }: { detail: EntityDetail; port?: SkillPort; onOpenEntity?: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  if (detail.state.kind !== 'skill' || detail.content.kind !== 'skill') return null;
  const state = detail.state;
  const content = detail.content;
  const body = withoutFrontmatter(typeof content.content === 'string' ? content.content : '');
  const readError = typeof content.readError === 'string' ? content.readError : '';
  const writable = !['system', 'admin', 'plugin', 'synced', 'session'].includes(state.level);
  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form); setBusy(true); setError('');
    try { await port!.edit(detail.id, { expectedVersion: detail.version, contentHash: state.contentHash, name: String(data.get('name')), description: String(data.get('description')), body: String(data.get('body')) }); setEditing(false); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const copyPath = () => {
    void navigator.clipboard?.writeText(state.sourcePath!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const frontmatter = Object.entries(state.frontmatter ?? {});
  const loader = state.loaderMetadata ?? {};
  return <div className="pn-body sk-body" data-testid="skill-body">
    <header className="sk-head">
      {state.description && <p className="sk-head__desc">{state.description}</p>}
      <div className="sk-head__meta">
        <ScopePills scope={scopeView(state)} />
        <span className="sk-head__spacer" />
        {port && writable && !editing && <button type="button" className="pn-btn" onClick={() => setEditing(true)}>Edit skill</button>}
      </div>
      {state.sourcePath && <div className="sk-path">
        <code className="sk-path__text" title={state.sourcePath}>{state.sourcePath}</code>
        <button type="button" className="sk-path__copy" onClick={copyPath} aria-label="Copy path">{copied ? 'Copied' : 'Copy'}</button>
      </div>}
    </header>

    {state.missing && <p role="status" className="sk-notice sk-notice--block">Missing file: the skill is no longer at {state.sourcePath ?? 'its recorded path'}.</p>}
    {state.changedOnDisk && <p role="status" className="sk-notice sk-notice--wait">Changed on disk — reload or scan before editing.</p>}
    {readError && <p role="alert" className="sk-notice sk-notice--block">Cannot read skill: {readError}</p>}

    {editing
      ? <form className="sk-form" onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}>
        <label className="sk-field"><span className="sk-field__label">Name</span><input className="sk-input" name="name" defaultValue={detail.title} required /></label>
        <label className="sk-field"><span className="sk-field__label">Description</span><textarea className="sk-input" name="description" rows={2} defaultValue={state.description} /></label>
        <label className="sk-field"><span className="sk-field__label">Body</span><textarea className="sk-input sk-input--body" name="body" rows={18} defaultValue={body} /></label>
        <div className="sk-form__actions">
          <button type="button" className="pn-btn" onClick={() => { setEditing(false); setError(''); }} disabled={busy}>Cancel</button>
          <button className="pn-btn pn-btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save skill'}</button>
        </div>
      </form>
      : <article className="sk-doc">
        {body.trim() ? <Markdown source={body} className="pn-prose" onOpenEntity={onOpenEntity} /> : <p className="pn-section__empty">This skill has no instructions yet.</p>}
      </article>}
    {error && <p role="alert" className="sk-error">{error}</p>}

    <SkillEquipment detail={detail} port={port} onOpenEntity={onOpenEntity} />

    <section className="sk-details" aria-label="Skill details">
      <Eyebrow faint>DETAILS</Eyebrow>
      <div className="sk-stats">
        {(['scripts', 'references', 'assets'] as const).map(key => <div key={key} className="sk-stat">
          <span className="sk-stat__value">{state.bundle?.[key] ?? 0}</span>
          <span className="sk-stat__label">{key[0].toUpperCase() + key.slice(1)}</span>
        </div>)}
      </div>
      <dl className="sk-kv">
        <div><dt>Version</dt><dd>{detail.version}</dd></div>
        <div><dt>Modified</dt><dd>{state.fileMtime ? <Timestamp at={state.fileMtime} /> : 'No file timestamp'}</dd></div>
        {state.bodyBytes != null && <div><dt>Size</dt><dd>{state.bodyBytes.toLocaleString()} bytes</dd></div>}
        {state.lastSeenAt && <div><dt>Last scanned</dt><dd><Timestamp at={state.lastSeenAt} /></dd></div>}
        {state.contentHash && <div><dt>Content hash</dt><dd><code title={state.contentHash}>{state.contentHash}</code></dd></div>}
      </dl>
      <Eyebrow faint>FRONTMATTER</Eyebrow>
      {frontmatter.length
        ? <dl className="sk-kv">{frontmatter.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : <code>{JSON.stringify(value)}</code>}</dd></div>)}</dl>
        : <p className="pn-section__empty">No frontmatter.</p>}
      <Eyebrow faint>LOADER METADATA</Eyebrow>
      {Object.keys(loader).length
        ? <pre className="sk-pre">{JSON.stringify(loader, null, 2)}</pre>
        : <p className="pn-section__empty">None recorded.</p>}
    </section>
  </div>;
}
