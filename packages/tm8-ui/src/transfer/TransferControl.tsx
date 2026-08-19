import { useEffect, useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { IconBtn } from '../kit';
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
 * A KIND OUTSIDE THE TRANSFERABLE SET RENDERS NOTHING TOO — user ruling
 * 2026-08-19, reversing this control's original second arm.
 *
 * It used to draw a dimmed ⇄ with "this kind can't be transferred yet", on the
 * reading that servers are connected, so the feature applies and this entity is
 * merely waiting its turn. That reading does not survive contact with the panel
 * it sits on. `TRANSFERABLE_KINDS` is not a rollout order — it is what the
 * engine can carry, and a work_session is not on it because a session is a
 * PROCESS ON A NODE: its terminal, its pty and its worktree are the machine it
 * is running on. There is no later release in which it travels, so "yet" was
 * the affordance making a promise the design does not intend to keep.
 *
 * That puts it in the same class as the no-connection case above rather than in
 * disabled-with-reason: not a deferred feature, a concept that does not apply.
 * And it was doing measurable harm — a permanently unpressable control sitting
 * in `.pn-panelbar__end`, the fixed-width side of the one bar in the app that
 * had run out of room, pushing the panel's own tabs off their edge to say a
 * thing that will never change.
 *
 * THE HONESTY RULE IS NOT BEING TRADED AWAY, because both halves of it are
 * still paid where they are true: a transferable kind with no remote gets
 * nothing (concept absent), a transferable kind WITH a remote gets the live
 * button, and any future kind that genuinely is "not yet" belongs behind a
 * reason on the DIALOG, where there is room for one.
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
  if (!TRANSFERABLE_KINDS.has(detail.kind)) return null;

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
