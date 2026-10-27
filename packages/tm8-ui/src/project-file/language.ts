/**
 * WHICH LANGUAGE A FILE IS, for highlighting only.
 *
 * The name's extension wins, then the declared mime type, then plain text.
 * The viewer is read-only, so a wrong guess costs colours, never bytes.
 */

export type EditorLanguage =
  | 'typescript' | 'javascript' | 'json' | 'markdown' | 'css' | 'html'
  | 'python' | 'yaml' | 'sql' | 'shell' | 'go' | 'rust' | 'xml' | 'plain';

export const LANGUAGE_LABELS: Record<EditorLanguage, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', markdown: 'Markdown',
  css: 'CSS', html: 'HTML', python: 'Python', yaml: 'YAML', sql: 'SQL', shell: 'Shell',
  go: 'Go', rust: 'Rust', xml: 'XML', plain: 'Plain text',
};

const BY_EXTENSION: Record<string, EditorLanguage> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'css',
  html: 'html', htm: 'html',
  py: 'python',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  go: 'go',
  rs: 'rust',
  xml: 'xml',
  txt: 'plain', log: 'plain',
};

const BY_MIME: Record<string, EditorLanguage> = {
  'application/typescript': 'typescript', 'text/typescript': 'typescript',
  'application/javascript': 'javascript', 'text/javascript': 'javascript',
  'application/json': 'json',
  'text/markdown': 'markdown',
  'text/css': 'css',
  'text/html': 'html',
  'text/x-python': 'python',
  'application/yaml': 'yaml', 'application/x-yaml': 'yaml', 'text/yaml': 'yaml',
  'application/sql': 'sql',
  'application/x-sh': 'shell', 'text/x-shellscript': 'shell',
  'application/xml': 'xml', 'text/xml': 'xml',
};

/** The extension of a file name, lower-cased, or null (dotfiles have none). */
export function extensionOf(name: string): string | null {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

export function isKnownCodeExtension(name: string): boolean {
  const ext = extensionOf(name);
  return ext !== null && ext in BY_EXTENSION;
}

export function languageFor(name: string, mime: string | null): EditorLanguage {
  const ext = extensionOf(name);
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  const type = mime?.split(';')[0]!.trim().toLowerCase();
  if (type && BY_MIME[type]) return BY_MIME[type];
  return 'plain';
}
