import { extractImageFiles } from './clipboardImages.js';

export interface ClipboardDispatchHandlers {
  onText(text: string): void;
  onImages(files: File[]): void;
}

export interface ClipboardDispatchResult {
  kind: 'images' | 'text' | 'none';
  handled: boolean;
  imageCount: number;
}

export function dispatchClipboardData(
  data: DataTransfer | null,
  handlers: ClipboardDispatchHandlers,
  options: { imageStartIndex?: number } = {},
): ClipboardDispatchResult {
  if (!data) return { kind: 'none', handled: false, imageCount: 0 };
  const images = extractImageFiles(data, {
    startIndex: options.imageStartIndex ?? 1,
    renameAll: true,
  });
  if (images.length > 0) {
    handlers.onImages(images);
    return { kind: 'images', handled: true, imageCount: images.length };
  }
  const text = data.getData?.('text/plain') ?? '';
  if (text) {
    handlers.onText(text);
    return { kind: 'text', handled: true, imageCount: 0 };
  }
  return { kind: 'none', handled: false, imageCount: 0 };
}
