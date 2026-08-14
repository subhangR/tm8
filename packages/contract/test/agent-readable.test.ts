/**
 * The agent-readable file set (`src/agent-readable.ts`).
 *
 * The property under test is the BOUNDARY: what a model ingests is accepted,
 * what no model reads raw is refused, and a declared MIME type always beats a
 * filename. The exact membership of the set is product ruling R2; these tests
 * pin its edges so a later "just add zip" happens on purpose, in this file,
 * rather than by a loosened regex nobody meant.
 */
import { describe, expect, it } from 'vitest';
import { isAgentReadableFile, isAgentReadableMime } from '../src/index.js';

describe('isAgentReadableMime', () => {
  it('accepts the wildcard families a model ingests natively', () => {
    expect(isAgentReadableMime('image/png')).toBe(true);
    expect(isAgentReadableMime('image/webp')).toBe(true);
    expect(isAgentReadableMime('video/mp4')).toBe(true);
    expect(isAgentReadableMime('audio/mpeg')).toBe(true);
    expect(isAgentReadableMime('text/plain')).toBe(true);
    expect(isAgentReadableMime('text/markdown')).toBe(true);
    expect(isAgentReadableMime('text/csv')).toBe(true);
  });

  it('accepts documents: pdf, office, opendocument, rtf', () => {
    expect(isAgentReadableMime('application/pdf')).toBe(true);
    expect(isAgentReadableMime('application/msword')).toBe(true);
    expect(isAgentReadableMime(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )).toBe(true);
    expect(isAgentReadableMime(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )).toBe(true);
    expect(isAgentReadableMime('application/vnd.oasis.opendocument.text')).toBe(true);
    expect(isAgentReadableMime('application/rtf')).toBe(true);
  });

  it('accepts structured-text suffix conventions wherever they appear', () => {
    expect(isAgentReadableMime('application/json')).toBe(true);
    expect(isAgentReadableMime('application/ld+json')).toBe(true);
    expect(isAgentReadableMime('image/svg+xml')).toBe(true);
    expect(isAgentReadableMime('application/x-yaml')).toBe(true);
  });

  it('is case-insensitive and ignores parameters', () => {
    expect(isAgentReadableMime('Image/PNG')).toBe(true);
    expect(isAgentReadableMime('text/plain; charset=utf-8')).toBe(true);
  });

  it('refuses archives, executables and unknown binaries', () => {
    expect(isAgentReadableMime('application/zip')).toBe(false);
    expect(isAgentReadableMime('application/x-tar')).toBe(false);
    expect(isAgentReadableMime('application/gzip')).toBe(false);
    expect(isAgentReadableMime('application/octet-stream')).toBe(false);
    expect(isAgentReadableMime('application/x-msdownload')).toBe(false);
    expect(isAgentReadableMime('')).toBe(false);
  });
});

describe('isAgentReadableFile', () => {
  it('believes a declared MIME over any filename', () => {
    expect(isAgentReadableFile({ name: 'notes.txt.zip', type: 'application/zip' })).toBe(false);
    expect(isAgentReadableFile({ name: 'weird.bin', type: 'application/pdf' })).toBe(true);
  });

  it('falls back to a known text extension only when the MIME is absent', () => {
    expect(isAgentReadableFile({ name: 'README.md', type: '' })).toBe(true);
    expect(isAgentReadableFile({ name: 'main.ts', type: '' })).toBe(true);
    expect(isAgentReadableFile({ name: 'config.yaml', type: '  ' })).toBe(true);
  });

  it('refuses a bare unknown or missing extension rather than guessing', () => {
    expect(isAgentReadableFile({ name: 'payload.exe', type: '' })).toBe(false);
    expect(isAgentReadableFile({ name: 'archive.zip', type: '' })).toBe(false);
    expect(isAgentReadableFile({ name: 'no-extension', type: '' })).toBe(false);
    expect(isAgentReadableFile({ name: '.env-like-but-hidden.', type: '' })).toBe(false);
    // A dotfile's whole name is not an extension.
    expect(isAgentReadableFile({ name: '.gitignore', type: '' })).toBe(false);
  });
});
