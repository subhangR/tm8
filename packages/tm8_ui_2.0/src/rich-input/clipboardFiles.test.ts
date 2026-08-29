// @vitest-environment jsdom
/**
 * The file extractor (`clipboardFiles.ts`) — the re-homed terminal extractor,
 * widened per R2. The properties under test: the accept boundary is the
 * contract's agent-readable set, a refused file is RETURNED rather than
 * silently dropped, dedupe survives, and image renaming behaves exactly as it
 * did when this was `terminal/clipboardImages.ts` — while documents keep the
 * one fact the user recognizes them by, their name.
 */
import { describe, expect, it } from 'vitest';
import { extractImageFiles, extractReadableFiles } from './clipboardFiles';

function file(name: string, type: string): File {
  return new File(['x'], name, { type });
}

/** The function reads only `.items`/`.files`; a stub is the honest input. */
function transferWith(files: File[]): DataTransfer {
  return {
    items: files.map((f) => ({ getAsFile: () => f })),
    files,
    types: ['Files'],
  } as unknown as DataTransfer;
}

describe('extractReadableFiles', () => {
  it('accepts the agent-readable set: images, pdf, text, office', () => {
    const { accepted, refused } = extractReadableFiles(transferWith([
      file('shot.png', 'image/png'),
      file('report.pdf', 'application/pdf'),
      file('notes.md', 'text/markdown'),
      file('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ]));
    expect(accepted).toHaveLength(4);
    expect(refused).toHaveLength(0);
  });

  it('returns a refused file rather than silently dropping it', () => {
    const { accepted, refused } = extractReadableFiles(transferWith([
      file('report.pdf', 'application/pdf'),
      file('bundle.zip', 'application/zip'),
    ]));
    expect(accepted.map((f) => f.name)).toEqual(['report.pdf']);
    expect(refused.map((f) => f.name)).toEqual(['bundle.zip']);
  });

  it('dedupes by name:size:type across items and files', () => {
    const twice = file('a.pdf', 'application/pdf');
    const { accepted } = extractReadableFiles(transferWith([twice, twice]));
    expect(accepted).toHaveLength(1);
  });

  it('renames generically-named images to sequence names, as the terminal always did', () => {
    const { accepted } = extractReadableFiles(transferWith([
      file('image.png', 'image/png'),
      file('screenshot-tuesday.png', 'image/png'),
    ]));
    expect(accepted.map((f) => f.name)).toEqual(['image1.png', 'screenshot-tuesday.png']);
  });

  it('renameAll renames every image — but never a document', () => {
    const { accepted } = extractReadableFiles(
      transferWith([
        file('screenshot-tuesday.png', 'image/png'),
        file('report.pdf', 'application/pdf'),
      ]),
      { renameAll: true },
    );
    expect(accepted.map((f) => f.name)).toEqual(['image1.png', 'report.pdf']);
  });

  it('a custom accept narrows the set', () => {
    const { accepted, refused } = extractReadableFiles(
      transferWith([file('a.pdf', 'application/pdf'), file('b.png', 'image/png')]),
      { accept: (f) => f.type.startsWith('image/') },
    );
    expect(accepted.map((f) => f.name)).toEqual(['b.png']);
    expect(refused.map((f) => f.name)).toEqual(['a.pdf']);
  });

  it('null data is an empty extraction, not a throw', () => {
    expect(extractReadableFiles(null)).toEqual({ accepted: [], refused: [] });
  });
});

describe('extractImageFiles — the terminal shim', () => {
  it('keeps the image-only view: documents are simply absent', () => {
    const images = extractImageFiles(transferWith([
      file('image.png', 'image/png'),
      file('report.pdf', 'application/pdf'),
    ]), { startIndex: 1, renameAll: true });
    expect(images.map((f) => f.name)).toEqual(['image1.png']);
  });
});
