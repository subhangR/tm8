/**
 * ENTITY HELP HARNESS — a gate-free mount of the list header beside a
 * region-B box, so a real browser can answer what jsdom cannot: does the
 * projection room DRAW, in both themes; does the type system land; do the
 * reveals, the typed terminal and the constellation actually move — and
 * stop moving under reduced motion.
 *
 * Usage: /e2e/entity-help-harness.html
 *          ?theme=dark            the graphite ground
 *          ?kind=<kind>           open that kind's page on load
 *          ?tab=story|toolkit|constellation
 *          ?motion=reduced        the still picture
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { homeRootKinds } from '../src/domain';
import { EntityHelpOverlay } from '../src/entity-help/EntityHelpOverlay';
import { entityHelpStore } from '../src/entity-help/entityHelpStore';
import { isHelpTab } from '../src/entity-help/types';
import { ListRootHeader, type ListRootOption } from '../src/panels/ListRootHeader';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : undefined;
const reduced = params.get('motion') === 'reduced';
const options: ListRootOption[] = homeRootKinds().map((k) => ({ kind: k.kind, label: k.labelPlural, single: k.label }));

function Harness() {
  const [root, setRoot] = useState(params.get('kind') ?? 'task');
  const [ready, setReady] = useState(false);
  const cell = options.find((o) => o.kind === root) ?? options[0]!;

  useEffect(() => {
    const kind = params.get('kind');
    const tab = params.get('tab');
    if (kind) entityHelpStore.getState().open(kind, isHelpTab(tab) ? tab : undefined);
    const timer = window.setTimeout(() => setReady(true), reduced ? 200 : 2600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="cv2-root"
      data-theme={theme}
      data-harness-ready={ready || undefined}
      style={{ display: 'grid', gridTemplateColumns: '300px 1fr', height: '100vh', background: 'var(--pn-paper)' }}
    >
      <aside style={{ borderRight: '1px solid var(--pn-line)', display: 'flex', flexDirection: 'column' }}>
        <ListRootHeader
          rootsLabel="Home roots"
          cell={cell}
          cellActive
          onSelectCell={setRoot}
          options={options}
          currentKind={root}
          onPickKind={setRoot}
        />
        <div style={{ padding: 12, color: 'var(--pn-ink-3)', fontSize: 12 }}>
          <p>The list column stays usable while help is open.</p>
          <ul style={{ paddingLeft: 16 }}>
            {options.slice(0, 8).map((o) => (
              <li key={o.kind} style={{ padding: '4px 0' }}>
                {o.label}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section style={{ position: 'relative', minHeight: 0 }} aria-label="Region B">
        <div style={{ padding: 24, color: 'var(--pn-ink-3)' }}>Region B — the entity detail panel sits here.</div>
        <EntityHelpOverlay reducedMotion={reduced || undefined} />
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
