import { useEffect, useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { IconBtn } from '../kit';
import { DisabledIconControl } from '../panels/honesty/DisabledWithReason';
import { readActiveServerId } from '../servers/server-key';
import { activeServerLabel, listTransferServers, type TransferServer } from './transfer-client';
import { TRANSFERABLE_KINDS } from './engine';
import { TransferDialog } from './TransferDialog';

/**
 * THE PANEL'S TRANSFER AFFORDANCE — user ruling 2026-08-18: it lives in the
 * entity detail panel (not the tile), and ONLY when a remote server is
 * actually connected. With no named connection the control renders NOTHING —
 * this is the one deliberate exception to disabled-with-reason, because on a
 * single-server node "transfer to another server" is not a deferred feature,
 * it is a concept that does not apply. The moment `tm8 server add` registers
 * a connection, the button exists (the directory read is cached briefly and
 * re-read per panel mount).
 *
 * A kind outside the transferable set DOES take the disabled-with-reason
 * treatment: servers are connected, the feature applies, this entity just
 * cannot ride it yet.
 */
export function TransferControl({ detail }: { detail: EntityDetail }) {
  const [servers, setServers] = useState<TransferServer[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    listTransferServers()
      .then((list) => {
        if (live) setServers(list);
      })
      .catch(() => {
        // No registry answer (offline node, jsdom, blocked fetch) reads as
        // "no connections": the control stays absent rather than broken.
        if (live) setServers([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const hasRemote = servers?.some((server) => !server.local) ?? false;
  if (!hasRemote) return null;

  if (!TRANSFERABLE_KINDS.has(detail.kind)) {
    return (
      <DisabledIconControl
        label="Transfer to another server"
        glyph="⇄"
        reason={{
          cause: 'This kind can’t be transferred yet',
          remedy: 'tasks, docs and channels travel between servers today',
        }}
      />
    );
  }

  return (
    <>
      <IconBtn label="Transfer to another server" onClick={() => setOpen(true)}>
        ⇄
      </IconBtn>
      {open ? (
        <TransferDialog
          subject={detail}
          sourceServerId={readActiveServerId()}
          sourceLabel={activeServerLabel()}
          servers={servers ?? []}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
