type ImageRenameOptions = { startIndex?: number; renameAll?: boolean };

const GENERIC_CLIPBOARD_NAMES = new Set([
  '', 'image.png', 'image.jpg', 'image.jpeg', 'image.gif', 'image.webp',
  'pasted_image.png', 'pasted_image.jpg', 'pasted_image.jpeg', 'pasted_image.gif',
  'pasted_image.webp',
]);

function isGenericClipboardName(name: string): boolean {
  return GENERIC_CLIPBOARD_NAMES.has(name.toLowerCase()) ||
    /^pasted[-_]image(?:[-_]\d+)?\.(png|jpe?g|gif|webp)$/i.test(name);
}

function extForMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1] || 'png';
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'svg+xml') return 'svg';
  return subtype;
}

function withImageSequenceName(file: File, index: number): File {
  const name = `image${index}.${extForMime(file.type)}`;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

function applyImageSequenceNames(files: File[], options: ImageRenameOptions): File[] {
  let nextIndex = options.startIndex ?? 1;
  return files.map((file) => {
    if (!options.renameAll && !isGenericClipboardName(file.name)) return file;
    const renamed = withImageSequenceName(file, nextIndex);
    nextIndex += 1;
    return renamed;
  });
}

export function extractImageFiles(data: DataTransfer | null, options: ImageRenameOptions = {}): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const push = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  if (data.items) {
    for (let index = 0; index < data.items.length; index += 1) {
      const item = data.items[index];
      if (item?.kind === 'file') push(item.getAsFile());
    }
  }
  if (data.files) {
    for (let index = 0; index < data.files.length; index += 1) push(data.files[index] ?? null);
  }
  return applyImageSequenceNames(out, options);
}

export function dataTransferHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types || []).includes('Files'));
}
