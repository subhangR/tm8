/**
 * THE MOUNTED CONNECTORS SECTION.
 *
 * The screen itself is `ConnectorsTable.tsx` now (§10.1/§10.3/D1). This file
 * keeps the `McpSettings` name because `views/GateApp.tsx` is the one place
 * that mounts it and the section contract puts that file outside this lane —
 * so the page was rebuilt without an edit to the shell.
 *
 * What used to live here, for anyone looking for it: a stack of per-connector
 * `<article>` cards (`DefinitionForm`, `AccountCard`, the directory browser).
 * `DefinitionForm` is `ConnectorForm.tsx`, `AccountCard`'s controls are the
 * drawer's `ConnectionControls`, and the directory is the Discover tab, reading
 * `mcp.catalog.list` instead of the deleted `ui/mcp/directory.ts`.
 */
export { ConnectorsSection as McpSettings, ConnectorsTable } from './ConnectorsTable';
