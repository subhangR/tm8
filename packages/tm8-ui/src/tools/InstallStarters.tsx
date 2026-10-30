import { useState } from 'react';
import { TOOL_STARTERS, toolStarterDefinition } from '@tm8/contract';
import type { ToolPort } from './port';

export type StarterInstall =
  | { name: string; status: 'skipped' }
  | { name: string; status: 'created'; toolId: string; headerNotStored?: string }
  | { name: string; status: 'failed'; message: string };

const errorText = (failure: unknown) => failure instanceof Error ? failure.message : 'The request could not be completed.';

/**
 * Create every starter tool the space does not hold yet (by name, read from
 * `tools.list` first), one at a time, then send its selection header. One
 * refusal does not stop the rest, and a header the node did not store is a
 * note on a created tool, never a failure.
 */
export async function installStarters(port: ToolPort, spaceId: string, onProgress?: (results: StarterInstall[]) => void): Promise<StarterInstall[]> {
  const present = new Set((await port.list(spaceId)).map(tool => tool.definition.name));
  const results: StarterInstall[] = [];
  for (const starter of TOOL_STARTERS) {
    if (present.has(starter.name)) {
      results.push({ name: starter.name, status: 'skipped' });
    } else {
      try {
        const tool = await port.create(spaceId, toolStarterDefinition(starter));
        let headerNotStored: string | undefined;
        try {
          const outcome = await port.setHeader(tool.id, { whenToUse: starter.whenToUse, summary: starter.summary });
          if (!outcome.stored) headerNotStored = outcome.reason;
        } catch (failure) {
          headerNotStored = errorText(failure);
        }
        results.push({ name: starter.name, status: 'created', toolId: tool.id, ...(headerNotStored ? { headerNotStored } : {}) });
      } catch (failure) {
        results.push({ name: starter.name, status: 'failed', message: errorText(failure) });
      }
    }
    onProgress?.([...results]);
  }
  return results;
}

/**
 * The install in one sentence, for a host that unmounts the report: the empty
 * Tools list reloads into the new tools, so a refusal or a header the node did
 * not store would otherwise vanish with it.
 */
export function installSummary(results: readonly StarterInstall[]): string {
  const created = results.filter(result => result.status === 'created');
  const parts = [created.length ? `Installed ${created.length} of ${results.length} starter tools.`
    : results.every(result => result.status === 'skipped') ? 'Every starter tool is already in this space.' : 'No starter tool was installed.'];
  for (const result of results) if (result.status === 'failed') parts.push(`${result.name} was not created: ${result.message}`);
  const notStored = [...new Set(created.flatMap(result => result.headerNotStored ? [result.headerNotStored] : []))];
  if (notStored.length) parts.push(`Selection headers were not stored: ${notStored.join('; ')}`);
  return parts.join(' ');
}

function resultLine(result: StarterInstall): string {
  switch (result.status) {
    case 'skipped': return `${result.name}: already in this space, skipped`;
    case 'created': return result.headerNotStored ? `${result.name}: created; selection header not stored: ${result.headerNotStored}` : `${result.name}: created`;
    case 'failed': return `${result.name}: not created: ${result.message}`;
  }
}

/** "Install starter tools": the Tools list's one-press way to get the examples/tools set. */
export function InstallStarters({ spaceId, port, onInstalled }: { spaceId: string; port: ToolPort | undefined; onInstalled?: (results: StarterInstall[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<StarterInstall[] | null>(null);
  const [error, setError] = useState('');
  const install = async () => {
    if (!port || busy) return;
    setBusy(true); setError(''); setResults(null);
    try {
      const done = await installStarters(port, spaceId, setResults);
      setResults(done); onInstalled?.(done);
    } catch (failure) {
      setError(`Nothing was installed: ${errorText(failure)}`);
    } finally {
      setBusy(false);
    }
  };
  const created = results?.filter(result => result.status === 'created').length ?? 0;
  return <div className="tool-install" data-testid="tool-install-starters">
    <button type="button" className="pn-btn" disabled={!port || busy} aria-busy={busy || undefined}
      title={port ? `Creates the starter tools this space does not have yet: ${TOOL_STARTERS.map(starter => starter.name).join(', ')}` : 'Tools are unavailable on this connection.'}
      onClick={() => void install()}>{busy ? 'Installing…' : 'Install starter tools'}</button>
    {error && <p role="alert" className="tool-install__error">{error}</p>}
    {results && <div role="status" className="tool-install__report">
      {!busy && <p>{created ? `Installed ${created} of ${TOOL_STARTERS.length} starter tools.` : results.every(result => result.status === 'skipped') ? 'Every starter tool is already in this space.' : 'No starter tool was installed.'}</p>}
      <ul aria-label="Starter tools">{results.map(result => <li key={result.name} data-status={result.status}>{resultLine(result)}</li>)}</ul>
    </div>}
  </div>;
}
