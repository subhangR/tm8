/**
 * `tm8.actions.v2` helpers — the derivations the factored shape relies on.
 *
 * `PaletteAction.id`, `.label` and `.helpRef` are functions of the operation
 * and the target, so v2 does not send them. These are THE definitions: the
 * Server builds v1 objects with them and clients rebuild v1 objects from v2
 * rows with them, so the two shapes cannot drift apart.
 */
import type {
  ActionDiscoveryResult,
  ActionRow,
  ActionRows,
  EntityId,
  PaletteAction,
} from './contract.js';
import type { OperationName } from './catalog.js';

export function actionId(operation: OperationName, targetId: EntityId | undefined): string {
  return `action:${operation}:${targetId ?? 'global'}`;
}

export function actionLabel(operation: OperationName): string {
  return operation.replaceAll('.', ' ');
}

export function actionHelpRef(operation: OperationName): string {
  return `tm8://help/operation/${operation}`;
}

/** One v2 row back to the exact v1 `PaletteAction`, key order included. */
export function expandActionRow(
  row: ActionRow,
  header: Pick<ActionRows, 'target' | 'capabilityEpoch'>,
): PaletteAction {
  const [operation, kind, authzTarget, exposure] = row;
  const target = header.target;
  return {
    id: actionId(operation, target?.id),
    label: actionLabel(operation),
    kind,
    operation,
    ...(target ? { targetEntityId: target.id, targetVersion: target.version } : {}),
    capabilityEpoch: header.capabilityEpoch,
    authzTarget,
    exposure,
    helpRef: actionHelpRef(operation),
  };
}

/**
 * A v2 answer back to the v1 `ActionDiscoveryResult` it factors. Lossless:
 * `JSON.stringify(expandActionRows(v2))` equals the v1 body for the same rows.
 * `total` and a page's `nextCursor` have no v1 counterpart and are dropped.
 */
export function expandActionRows(compact: ActionRows): ActionDiscoveryResult {
  const target = compact.target;
  return {
    actorId: compact.actorId,
    ...(target ? { targetEntityId: target.id, targetVersion: target.version } : {}),
    capabilityEpoch: compact.capabilityEpoch,
    actions: compact.rows.map((row) => expandActionRow(row, compact)),
  };
}

export function isActionRows(value: unknown): value is ActionRows {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { schema?: unknown }).schema === 'tm8.actions.v2';
}
