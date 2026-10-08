/** Commands between the browser's inline title and its already-open detail form. */
const handlers = new Map<string, () => void>();
export function onDraftSubmit(tabId: string, submit: () => void): () => void {
  handlers.set(tabId, submit);
  return () => { if (handlers.get(tabId) === submit) handlers.delete(tabId); };
}
export function requestDraftSubmit(tabId: string): boolean {
  const submit = handlers.get(tabId);
  submit?.();
  return Boolean(submit);
}
