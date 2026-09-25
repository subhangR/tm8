import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import type { CommandResult, CreatableEntityKind, EntityId, SpaceId } from '@tm8/contract';
import { EMPTY_HEADER_DRAFT, headerDraftHasText, headerInputOf, type HeaderDraft } from '../domain';
import { HeaderFields } from '../panels/detail/HeaderSection';
import { classifyFailure, createdIdOf, newEntityInput, type AuthoringCommands, type RefusedFailure } from './commands';
import { RefusalCard } from './RefusalCard';

/**
 * CREATE WITH A HEADER (I9a) — the companion to the immediate ＋, never a
 * replacement for it.
 *
 * The generic create stays what the oracle drew: one press, an Untitled row,
 * the panel open with its title focused. A kind that declares `createHeader`
 * ALSO gets this quieter door beside it, which asks the two questions a launch
 * reads — "When should an agent open this?" / "What does it hold?" — and sends
 * them as `header` on the SAME `entities.create` call, so the entity and its
 * header land in one transaction. Both fields are optional, and like every
 * header surface the length is guidance, never a lock (lenient ruling, msg
 * 01a0d6f1): a refusal from the node is shown in its words.
 */
export function HeaderCreateControl({
  kind,
  kindLabel,
  placeholderTitle,
  spaceId,
  commands,
  onCreated,
}: {
  kind: CreatableEntityKind;
  /** The registry's `label`, never a literal. */
  kindLabel: string;
  placeholderTitle: string;
  spaceId: SpaceId;
  commands: AuthoringCommands;
  onCreated?: (id: EntityId, result: CommandResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState<HeaderDraft>(EMPTY_HEADER_DRAFT);
  const [phase, setPhase] = useState<{ phase: 'idle' } | { phase: 'creating' } | { phase: 'refused'; failure: RefusedFailure }>({ phase: 'idle' });
  const firstField = useRef<HTMLInputElement | null>(null);
  const creating = phase.phase === 'creating';

  useEffect(() => {
    if (open) firstField.current?.focus();
  }, [open]);

  const close = () => {
    if (creating) return;
    setOpen(false);
    setPhase({ phase: 'idle' });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (creating) return;
    setPhase({ phase: 'creating' });
    try {
      const input = newEntityInput(spaceId, kind, title.trim() || placeholderTitle);
      const result = await commands.createEntity(
        headerDraftHasText(draft) ? { ...input, header: headerInputOf(draft) } : input,
      );
      const id = createdIdOf(result);
      if (id === null) {
        setPhase({
          phase: 'refused',
          failure: {
            kind: 'refused',
            cause: 'created, but the node did not return the new id',
            detail: 'The command succeeded and carried neither an entity nor a patch to read it from.',
            aftermath: `The ${kindLabel.toLowerCase()} MAY exist — reload the list before trying again.`,
            code: 'no_id',
            retryable: false,
          },
        });
        return;
      }
      setTitle('');
      setDraft(EMPTY_HEADER_DRAFT);
      setPhase({ phase: 'idle' });
      setOpen(false);
      onCreated?.(id, result);
    } catch (error) {
      const failure = classifyFailure(error, 'create');
      setPhase({
        phase: 'refused',
        failure: failure.kind === 'refused'
          ? failure
          : { kind: 'refused', cause: failure.cause, detail: failure.detail, aftermath: 'Nothing was created.', code: 'version_conflict', retryable: false },
      });
    }
  };

  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <>
      <button
        type="button"
        className="au-create-header"
        onClick={() => setOpen(true)}
        data-testid="header-create-open"
        title={`New ${kindLabel.toLowerCase()}, with the header agents read before opening it`}
      >
        with header…
      </button>
      {open ? (
        <div className="au-dialog__backdrop" role="presentation" onMouseDown={close}>
          <form
            className="au-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`New ${kindLabel.toLowerCase()} with a header`}
            data-testid="header-create-dialog"
            onSubmit={(event) => void submit(event)}
            onMouseDown={stop}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                close();
              }
            }}
          >
            <h2 className="au-dialog__title">{`New ${kindLabel.toLowerCase()}`}</h2>
            <label className="au-dialog__field">
              <span className="au-dialog__label">
                Title<em className="au-dialog__optional"> · optional</em>
              </span>
              <input
                ref={firstField}
                className="au-dialog__input"
                value={title}
                placeholder={placeholderTitle}
                disabled={creating}
                onChange={(event) => setTitle(event.target.value)}
                data-testid="header-create-title"
              />
            </label>
            <HeaderFields draft={draft} onChange={setDraft} disabled={creating} />
            {phase.phase === 'refused' ? (
              <RefusalCard
                word={phase.failure.cause}
                detail={phase.failure.detail}
                aftermath={phase.failure.aftermath}
                moves={[
                  ...(phase.failure.retryable ? [{ label: 'retry', onSelect: () => void submit() }] : []),
                  { label: 'back to the form', onSelect: () => setPhase({ phase: 'idle' }) },
                ]}
              />
            ) : null}
            <div className="au-dialog__actions">
              <button type="button" onClick={close} disabled={creating}>Cancel</button>
              <button type="submit" className="au-dialog__primary" aria-busy={creating} disabled={creating}>
                {creating ? 'Creating…' : `Create ${kindLabel.toLowerCase()}`}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
