/**
 * TOOLKIT — the narrative around the commands, and the commands themselves,
 * read live from the catalog.
 *
 * Each scene is a paragraph, a typed terminal playing its demonstration, and
 * the command cards it named. After the scenes comes THE LEDGER: every
 * command the kind's vocabulary reaches, own verbs first, the generic entity
 * family after, and the operations that deliberately have no CLI form —
 * listed rather than hidden, because an absent row implies the operation does
 * not exist. The footer prints the catalog digest so a reader can match this
 * page to a binary.
 */
import { useState } from 'react';
import { invocationOf, HELP_CATALOG_DIGEST, type CommandDiscovery } from '../catalog';
import type { HelpPage } from '../resolve';
import { Reveal, Stagger } from '../motion/Reveal';
import { TypedTerminal } from '../motion/TypedTerminal';

function CommandCard({ row }: { row: CommandDiscovery }) {
  const [open, setOpen] = useState(false);
  const more = row.notes.length > 0 || row.examples.length > 0;
  return (
    <article className="eh-cmd" data-testid="toolkit-command" data-command={row.command}>
      <div className="eh-cmd__head">
        <code className="eh-cmd__path">tm8 {row.command}</code>
        <span className="eh-cmd__effect" title={`side effect: ${row.sideEffect}`}>
          {row.sideEffect}
        </span>
      </div>
      <p className="eh-cmd__summary">{row.summary}</p>
      <pre className="eh-cmd__syntax">{invocationOf(row)}</pre>
      {more ? (
        <button
          type="button"
          className="eh-cmd__more"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Less' : `Notes${row.examples.length > 0 ? ' & examples' : ''}`}
        </button>
      ) : null}
      {open ? (
        <div className="eh-cmd__detail">
          {row.notes.length > 0 ? (
            <ul className="eh-cmd__notes">
              {row.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          {row.examples.length > 0 ? (
            <pre className="eh-cmd__examples">{row.examples.map((example) => `tm8 ${example.replace(/^tm8 /, '')}`).join('\n')}</pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function ToolkitTab({ page }: { page: HelpPage }) {
  const { toolkit } = page;
  const sceneRows = new Set(toolkit.scenes.flatMap((scene) => scene.commands.map((row) => row.command)));
  const ledgerOwn = toolkit.catalog.own.filter((row) => !sceneRows.has(row.command));
  const ledgerGeneric = toolkit.catalog.generic.filter((row) => !sceneRows.has(row.command));

  return (
    <div className="eh-toolkit" data-testid="entity-help-toolkit">
      <Reveal className="eh-prose" delay={80}>
        {toolkit.intro}
      </Reveal>

      {toolkit.scenes.map((scene, index) => (
        <Reveal key={scene.title} as="section" className="eh-scene" delay={220 + index * 160} data-testid="toolkit-scene">
          <span className="eh-eyebrow">Scene {String(index + 1).padStart(2, '0')}</span>
          <h3 className="eh-scene__title">{scene.title}</h3>
          <div className="eh-prose">{scene.narrative}</div>
          {scene.demo.length > 0 ? <TypedTerminal lines={scene.demo} title={scene.title} delay={400 + index * 160} /> : null}
          {scene.commands.length > 0 ? (
            <Stagger className="eh-cmds" step={60} start={120}>
              {scene.commands.map((row) => (
                <CommandCard key={row.command} row={row} />
              ))}
            </Stagger>
          ) : null}
          {scene.unresolved.length > 0 ? (
            <p className="eh-unresolved" role="note">
              Not in this build’s catalog: {scene.unresolved.map((path) => `tm8 ${path}`).join(', ')}.
            </p>
          ) : null}
        </Reveal>
      ))}

      {ledgerOwn.length + ledgerGeneric.length + toolkit.catalog.commandless.length > 0 ? (
        <Reveal as="section" className="eh-ledger" delay={220 + toolkit.scenes.length * 160} data-testid="toolkit-ledger">
          <span className="eh-eyebrow">The ledger</span>
          <h3 className="eh-scene__title">Everything else the catalog answers to</h3>
          {ledgerOwn.length > 0 ? (
            <Stagger className="eh-cmds" step={40} start={100}>
              {ledgerOwn.map((row) => (
                <CommandCard key={row.command} row={row} />
              ))}
            </Stagger>
          ) : null}
          {ledgerGeneric.length > 0 ? (
            <>
              <h4 className="eh-ledger__sub">Every entity, including this one</h4>
              <Stagger className="eh-cmds eh-cmds--compact" step={30} start={140}>
                {ledgerGeneric.map((row) => (
                  <CommandCard key={row.command} row={row} />
                ))}
              </Stagger>
            </>
          ) : null}
          {toolkit.catalog.commandless.length > 0 ? (
            <>
              <h4 className="eh-ledger__sub">Catalogued with no CLI command</h4>
              <ul className="eh-commandless">
                {toolkit.catalog.commandless.map((op) => (
                  <li key={op.operation}>
                    <code>{op.operation}</code> — {op.exposure}
                    {op.reason ? `: ${op.reason}` : ''}
                    {op.publicComposite ? (
                      <>
                        {' '}
                        · use <code>{op.publicComposite}</code>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Reveal>
      ) : null}

      <p className="eh-digest">
        catalog <code>{HELP_CATALOG_DIGEST}</code> · read live from <code>@tm8/cli/discovery</code>
      </p>
    </div>
  );
}
