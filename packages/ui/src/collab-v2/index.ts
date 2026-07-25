/**
 * collab-v2 barrel (initial W0 scaffold — ATLAS owns this file after handover).
 * Downstream layers import from here: contract types, the facade seam, the
 * mock implementation, the four stores, and the kit primitives.
 */
export * from './types';
export * from './facade';
export * from './mock';
export * from './stores';
export * from './kit';
export * from './shell';
export * from './registry';
export * from './entity';
export * from './gallery';
export * from './interactions';
export { CollabV2App } from './CollabV2App';
