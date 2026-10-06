/**
 * Workspace runtime types — the single source of names (Spec B §2–§4).
 *
 * Since Spec D the pure core lives in `@tm8/contract/workspace`, shared with
 * the node's server-side apply; this module re-exports it so the UI keeps one
 * import path.
 */
export * from '@tm8/contract/workspace';
