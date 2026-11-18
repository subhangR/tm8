import type { BridgeConnectionView } from '@tm8/contract';
import { missingScopeLines } from './slack';

/**
 * WHAT THE SLACK APP WAS NOT GRANTED (design §4), wherever a Slack connection
 * is shown.
 *
 * Its own component because the warning has to appear on every surface that
 * offers a Slack connection, not just the one that created it: the token
 * dialog shows it once, but a workspace installed with too few scopes is a
 * standing condition, and the person who hits it is usually the next person to
 * use the connection — in Accounts & secrets, or in the add-bridge wizard,
 * where it showed nowhere at all (#1509 review 4).
 *
 * Nothing for a non-Slack connection, and nothing for one whose runtime has
 * not reported an account yet: an empty state is not a warning.
 */
export function SlackScopeNote({
  connection,
  className = 'brg-warn',
  testId,
}: {
  connection: Pick<BridgeConnectionView, 'provider' | 'account'>;
  className?: string;
  testId?: string;
}) {
  if (connection.provider !== 'slack') return null;
  const missing = missingScopeLines(connection.account);
  if (missing.length === 0) return null;
  return (
    <p className={className} role="status" {...(testId ? { 'data-testid': testId } : {})}>
      Missing {missing.length} scope{missing.length === 1 ? '' : 's'} the bridge uses: {missing.join('; ')}. Add them in
      the Slack app&apos;s OAuth &amp; Permissions, reinstall it, then paste the new bot token.
    </p>
  );
}
