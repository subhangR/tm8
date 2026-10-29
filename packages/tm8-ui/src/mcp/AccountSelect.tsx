/**
 * THE ACCOUNT CHOICE FOR ONE PICK — drawn by the full list's rows
 * (`ConnectorToggleList`) and the launch chips (`ConnectorChips`) alike, so the
 * two cannot disagree about what is pinned.
 *
 * Contract: given an ON row of a connector that needs an account, it draws a
 * select whose value ALWAYS names one of its own options, and calls
 * `onPin(credentialId)` on a change — `''` unpins.
 *  - `''` is "Choose for me": no pin, and the server's own-then-shared order
 *    picks (`resolvedAccount`). Worded "Choose an account" when that order has
 *    nothing to pick, so it never promises a choice the server cannot make.
 *  - Each account the viewer may use, by its label.
 *  - A DEAD pin (revoked, expired, removed) as a disabled option, selected. A
 *    controlled select whose value names no option shows the first one while
 *    the selection still holds the dead pin; and one already showing
 *    "Choose for me" cannot fire a change to it. Drawing the dead pin keeps the
 *    control truthful and leaves every real choice one change away.
 *
 * `wantsAccountChoice` is the shared half of "when is it drawn": a dead pin is
 * always shown its remedy. Each surface adds its own rule on top.
 */
import type { ConnectorRow } from './row-model';
import { resolvedAccount } from './row-model';

export function wantsAccountChoice(row: ConnectorRow): boolean {
  return row.on && row.server.auth !== 'none' && (row.deadPin || row.accounts.length > 0);
}

export function AccountSelect({ row, disabled, testId, className, onPin }: {
  row: ConnectorRow; disabled: boolean; testId: string; className?: string; onPin(credentialId: string): void;
}) {
  const { server } = row;
  const dead = row.deadPin ? server.accounts.find(a => a.id === row.credentialId) : undefined;
  return (
    <select
      className={className}
      aria-label={`Account for ${server.title}`}
      value={row.credentialId ?? ''}
      disabled={disabled}
      data-testid={testId}
      onChange={event => onPin(event.target.value)}
    >
      <option value="">{resolvedAccount(server) ? 'Choose for me' : 'Choose an account'}</option>
      {row.deadPin ? (
        <option value={row.credentialId} disabled>
          {dead ? `${dead.label} (needs reconnect)` : 'Removed account'}
        </option>
      ) : null}
      {row.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
    </select>
  );
}
