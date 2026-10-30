import { bridgeProviderLabel } from '../bridge-marks';
import type { BridgeView } from '@tm8/contract';
import { Pill } from '../../kit';
import { shortDate } from '../../kit/time';
import type { BridgesPort } from '../api';
import { CONNECTION_TONE, CONNECTION_WORD } from '../format';
import { pendingReason } from '../reasons';

/**
 * HEALTH (§4.4, v2 §1.4): the connection state, last inbound and outbound,
 * queued and failed counts, and the runtime's last words — all as
 * `internal.bridge_view` derived them; nothing is computed here. *Send test*
 * is the wizard's step 4 kept forever, live once `bridges.test` is served.
 */
export function HealthTab({ view, port }: { view: BridgeView; port: Pick<BridgesPort, 'serves'> }) {
  const h = view.health;
  const testReason = pendingReason(port, 'bridges.test', 'The test round trip');
  return (
    <div className="brg-health" data-testid="bridge-health">
      <dl className="brg-facts">
        <div>
          <dt>{bridgeProviderLabel(view.provider)} account</dt>
          <dd><Pill tone={CONNECTION_TONE[h.connection]} dot="solid">{CONNECTION_WORD[h.connection]}</Pill></dd>
        </div>
        <div><dt>Last message in</dt><dd>{h.lastInboundAt ? shortDate(h.lastInboundAt) : 'never'}</dd></div>
        <div><dt>Last message out</dt><dd>{h.lastOutboundAt ? shortDate(h.lastOutboundAt) : 'never'}</dd></div>
        <div><dt>Waiting to send</dt><dd>{h.queued}</dd></div>
        <div><dt>Failed in 24 h</dt><dd className={h.failed24h > 0 ? 'brg-bad' : undefined}>{h.failed24h}</dd></div>
        {view.pausedAt ? <div><dt>Paused since</dt><dd>{shortDate(view.pausedAt)}</dd></div> : null}
        {view.endedAt ? <div><dt>Removed</dt><dd>{shortDate(view.endedAt)}</dd></div> : null}
      </dl>
      <div className="brg-health__words">
        <span className="set-eyebrow">The runtime's last words</span>
        <p>{h.detail ?? 'Nothing to report.'}</p>
      </div>
      <div className="brg-health__test">
        <button type="button" className="pn-btn" disabled title={testReason}>Send test</button>
        <span className="brg-hint">{testReason}</span>
      </div>
    </div>
  );
}
