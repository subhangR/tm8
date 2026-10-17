/**
 * STAGED ATTACHMENTS AS CHIPS — the chat placement's visible half (R4).
 *
 * A view for hosts without their own upload-list markup. Every state the
 * upload machine can hold is drawn with its own control, and none is silent:
 * uploading can be cancelled, failed says why and offers the retry, uploaded
 * is a quiet chip whose × removes it until the message is sent. The refusal line (a pasted file
 * the agent-readable filter declined) and the caret-mode error ride here too
 * so a surface that adopts the hook cannot accidentally swallow either.
 */
import type { RichInputAttachments } from './useRichInput';

export function AttachmentChips({
  attachments,
  testId,
}: {
  attachments: RichInputAttachments | null;
  testId?: string;
}) {
  if (!attachments) return null;
  const { staged, refusal, error } = attachments;
  if (staged.length === 0 && !refusal && !error) return null;

  return (
    <div className="ri-attachments" data-testid={testId ?? 'ri-attachments'}>
      {refusal ? (
        <p className="ri-attachments__refusal" role="alert">
          <span>{refusal}</span>
          <button type="button" onClick={attachments.clearRefusal} aria-label="Dismiss">
            ✕
          </button>
        </p>
      ) : null}
      {error ? (
        <p className="ri-attachments__refusal" role="alert">{error}</p>
      ) : null}
      {staged.length ? (
        <ul className="ri-attachments__list" aria-label="Attachments" aria-live="polite">
          {staged.map((item) => (
            <li key={item.id} className="ri-attachment" data-phase={item.phase} title={item.file.name}>
              <span className="ri-attachment__name">{item.file.name}</span>
              {item.phase === 'uploading' ? <span role="status" className="ri-attachment__state">uploading…</span> : null}
              {/* Ready is the chip's resting look; the word is for screen readers. */}
              {item.phase === 'uploaded' ? <span className="ri-attachment__sr">uploaded</span> : null}
              {item.phase === 'failed' ? (
                <span role="alert" className="ri-attachment__error">{item.reason}</span>
              ) : null}
              {item.phase === 'failed' ? (
                <button
                  type="button"
                  className="ri-attachment__retry"
                  onClick={() => attachments.retry(item.id)}
                  aria-label={`Try ${item.file.name} again`}
                >
                  retry
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => attachments.remove(item.id)}
                aria-label={`Remove ${item.file.name}`}
                title={item.phase === 'uploading' ? 'Cancel upload' : 'Remove'}
              >
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
