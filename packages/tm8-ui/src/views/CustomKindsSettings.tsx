import { useEffect, useState } from 'react';
import type { EntityKindDef } from '@tm8/contract';
import { CustomKindsScreen, type GovernancePort, type LoadState } from '../settings-governance';

/** Load only when this section opens, after the page has resolved access. */
export function CustomKindsSettings({ port, spaceName, canCreate }: {
  port: GovernancePort;
  spaceName: string;
  canCreate: boolean;
}) {
  const [kinds, setKinds] = useState<LoadState<readonly EntityKindDef[]>>({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    setKinds({ phase: 'loading' });
    void port.entityKinds().then(
      value => { if (live) setKinds({ phase: 'ready', value }); },
      error => { if (live) setKinds({ phase: 'failed', message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { live = false; };
  }, [port]);
  return <CustomKindsScreen spaceLabel={spaceName} kinds={kinds} onCreate={canCreate ? port.createKind : undefined} />;
}
