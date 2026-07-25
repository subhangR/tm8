/**
 * Docs screen barrel (L5). Atlas mounts `docsViews` on `ShellLayout.views`;
 * the screen itself is pure composition over L1/L2/L4.
 */
import './docs.css';
import type { ViewRegistry } from '../../shell';
import { DocsScreen } from './DocsScreen';

export { DocsScreen } from './DocsScreen';
export { VersionHistory, type VersionHistoryProps } from './VersionHistory';
export { useDocs, useDocVersions, defaultDocId, type DocVersionRow } from './useDocs';

/** ViewRegistry fragment — `{ docs }`. */
export const docsViews: ViewRegistry = { docs: DocsScreen };
