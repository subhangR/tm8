/**
 * RE-HOMED — the extractor lives in `rich-input/clipboardFiles.ts` now.
 *
 * It was written here first, then the chat composer imported it across lanes,
 * which is how a terminal utility became load-bearing for every paste surface.
 * The shared home widens paste to the agent-readable set (ruling R2); this
 * shim keeps the terminal's image-only view of it because the server-side
 * clipboard store (`server/src/files/clipboard-store.ts`) accepts only images
 * today. When that allowlist widens to the contract predicate, the terminal
 * imports `extractReadableFiles` directly and this file is deleted.
 */
export { extractImageFiles, dataTransferHasFiles } from '../rich-input/clipboardFiles';
