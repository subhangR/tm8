/**
 * Version history — the doc's edit trail from `getVersions`, rendered as a
 * plain list of versions with their author chip. Authors are rendered by the
 * entity system (`ChipById`), so this component knows nothing about kinds.
 */
import { ChipById } from '../../entity';
import { Timestamp } from '../../kit';
import type { DocVersionRow } from './useDocs';

export interface VersionHistoryProps {
  rows: DocVersionRow[];
  loading: boolean;
  error: Error | null;
  /** The doc's current version — marked as the one you are reading. */
  current: number;
}

export function VersionHistory({ rows, loading, error, current }: VersionHistoryProps) {
  return (
    <section className="cv2-docs__history" aria-label="Version history">
      <span className="cv2-eyebrow">Version history</span>
      {error && <p className="cv2-empty-line" role="alert">{error.message}</p>}
      {loading && rows.length === 0 && <p className="cv2-empty-line" role="status">loading…</p>}
      {!loading && rows.length === 0 && !error && (
        <p className="cv2-empty-line">No edits recorded yet.</p>
      )}
      <ol className="cv2-docs__versions">
        {rows.map((row) => (
          <li
            key={row.version}
            className="cv2-docs__version"
            data-current={row.version === current || undefined}
          >
            <span className="t-mono cv2-docs__versionno">v{row.version}</span>
            <ChipById entityId={row.changedBy} />
            <Timestamp className="t-mono cv2-docs__versionwhen" at={row.changedAt} />
            {row.version === current && <span className="t-mono cv2-docs__versionnow">reading</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
