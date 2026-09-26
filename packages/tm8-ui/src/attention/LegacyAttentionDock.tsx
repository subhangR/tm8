/**
 * The pre-v2 dock, shown ONLY where no attention module is mounted.
 *
 * With an `AttentionProvider` above it the block on top of the detail
 * (`AttentionBlock`) is the one surface, and history is the Activity tab (R9);
 * the old dock would restate the block below it. Without a provider (hosts and
 * tests that predate v2) nothing changes. S7 deletes the dock and this gate.
 */
import type { ReactNode } from 'react';
import { useAttentionOptional } from './index';

export function LegacyAttentionDock({ children }: { children?: ReactNode }) {
  return useAttentionOptional() ? null : <>{children}</>;
}
