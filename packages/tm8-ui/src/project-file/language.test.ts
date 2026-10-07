import { describe, expect, it } from 'vitest';
import { extensionOf, languageFor } from './language';

describe('languageFor', () => {
  it('takes the language from the extension first', () => {
    expect(languageFor('src/rounding.ts', 'text/plain')).toBe('typescript');
    expect(languageFor('README.MD', null)).toBe('markdown');
    expect(languageFor('deploy.yml', 'application/octet-stream')).toBe('yaml');
  });

  it('falls back to the mime type, then plain text', () => {
    expect(languageFor('Dockerfile', 'text/x-shellscript')).toBe('shell');
    expect(languageFor('data', 'application/json; charset=utf-8')).toBe('json');
    expect(languageFor('notes', 'text/plain')).toBe('plain');
    expect(languageFor('blob', null)).toBe('plain');
  });

  it('treats dotfiles and trailing dots as having no extension', () => {
    expect(extensionOf('.gitignore')).toBeNull();
    expect(extensionOf('weird.')).toBeNull();
    expect(extensionOf('a/b.c/file')).toBeNull();
  });
});
