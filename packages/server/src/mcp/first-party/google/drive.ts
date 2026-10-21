import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { GoogleApiError, segment, tool, type GoogleTool } from './api.js';

/**
 * Google Drive on `drive.file` (§8.2): tm8 sees only the files it created or
 * that the person opened with it, never the whole Drive. Search therefore
 * finds those files only, which the tool descriptions say.
 */

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,parents';
const CONTENT_CHARS = 200_000;
const GOOGLE_DOC = 'application/vnd.google-apps.document';

interface DriveFile { id: string; name?: string; mimeType?: string; modifiedTime?: string; size?: string; webViewLink?: string; parents?: string[] }

function file(value: DriveFile) {
  return { id: value.id, name: value.name, mimeType: value.mimeType, modifiedTime: value.modifiedTime, size: value.size, webViewLink: value.webViewLink, parents: value.parents };
}

/** A Drive query string literal. Backslash first, then the quote, per Drive's query grammar. */
export function driveLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function clip(text: string): string {
  return text.length > CONTENT_CHARS ? `${text.slice(0, CONTENT_CHARS)}\n[truncated]` : text;
}

const FileId = z.string().min(1).max(200).describe('Drive file id.');
/** What `export_doc` may ask Google to render. Text formats only: the result goes back to the model as text. */
const ExportType = z.enum(['text/plain', 'text/markdown', 'text/html', 'text/csv', 'application/json']);

export const DRIVE_TOOLS: readonly GoogleTool[] = [
  tool({
    name: 'search_files',
    description: 'Search the Drive files tm8 can see (files created with tm8 or opened with it) by name or content.',
    input: z.object({
      query: z.string().max(500).optional().describe('Words to find in the file name or content. Omit to list recent files.'),
      nameOnly: z.boolean().optional().describe('Match the name only, not the content.'),
      mimeType: z.string().min(1).max(200).optional().describe('Only files of this MIME type.'),
      pageSize: z.number().int().min(1).max(100).optional().describe('At most this many files (default 25).'),
      pageToken: z.string().max(500).optional(),
    }).strict(),
    async run(api, input) {
      const terms = ['trashed = false'];
      if (input.query) terms.push(`${input.nameOnly ? 'name' : 'fullText'} contains ${driveLiteral(input.query)}`);
      if (input.mimeType) terms.push(`mimeType = ${driveLiteral(input.mimeType)}`);
      const listed = await api.json<{ files?: DriveFile[]; nextPageToken?: string }>('GET', api.endpoints.drive, '/files', {
        query: { q: terms.join(' and '), pageSize: input.pageSize ?? 25, pageToken: input.pageToken, orderBy: input.query ? undefined : 'modifiedTime desc', fields: `nextPageToken,files(${FILE_FIELDS})` },
      });
      return { files: (listed.files ?? []).map(file), ...(listed.nextPageToken ? { nextPageToken: listed.nextPageToken } : {}) };
    },
  }),
  tool({
    name: 'get_file',
    description: 'Read a file\'s metadata and, for a text file, its content. Use export_doc for Google Docs, Sheets and Slides.',
    input: z.object({ fileId: FileId, includeContent: z.boolean().optional().describe('Also return the content of a text file (default true).') }).strict(),
    async run(api, input) {
      const meta = await api.json<DriveFile>('GET', api.endpoints.drive, `/files/${segment(input.fileId)}`, { query: { fields: FILE_FIELDS } });
      const textual = /^text\/|^application\/(json|xml|javascript)/.test(meta.mimeType ?? '');
      if (input.includeContent === false || !textual) return { ...file(meta), ...(textual ? {} : { content: null, note: 'Not a text file; use export_doc for Google Docs.' }) };
      const content = await api.text(api.endpoints.drive, `/files/${segment(input.fileId)}`, { alt: 'media' });
      return { ...file(meta), content: clip(content.body) };
    },
  }),
  tool({
    name: 'export_doc',
    description: 'Export a Google Doc, Sheet or Slides file as text (plain text, Markdown, HTML or CSV).',
    input: z.object({ fileId: FileId, mimeType: ExportType.optional().describe('Format to export to (default text/plain).') }).strict(),
    async run(api, input) {
      const mimeType = input.mimeType ?? 'text/plain';
      const exported = await api.text(api.endpoints.drive, `/files/${segment(input.fileId)}/export`, { mimeType });
      return { fileId: input.fileId, mimeType, content: clip(exported.body) };
    },
  }),
  tool({
    name: 'create_file',
    description: 'Create a text file in Drive, optionally converted to a Google Doc. The new file is one tm8 can read later.',
    input: z.object({
      name: z.string().min(1).max(255).describe('File name.'),
      content: z.string().max(1_000_000).describe('Text content.'),
      mimeType: z.enum(['text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json']).optional().describe('Type of the content (default text/plain).'),
      parentId: z.string().min(1).max(200).optional().describe('Folder id to create it in.'),
      convertToGoogleDoc: z.boolean().optional().describe('Store it as a Google Doc instead of a plain file.'),
    }).strict(),
    async run(api, input) {
      const mimeType = input.mimeType ?? 'text/plain';
      const metadata = { name: input.name, ...(input.convertToGoogleDoc ? { mimeType: GOOGLE_DOC } : {}), ...(input.parentId ? { parents: [input.parentId] } : {}) };
      const boundary = `tm8-${randomBytes(12).toString('hex')}`;
      if (input.content.includes(`--${boundary}`)) throw new GoogleApiError(400, 'content collides with the upload boundary; retry');
      const body = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        `--${boundary}`, `Content-Type: ${mimeType}; charset=UTF-8`, '', input.content,
        `--${boundary}--`, '',
      ].join('\r\n');
      const created = await api.raw('POST', api.endpoints.driveUpload, '/files', { uploadType: 'multipart', fields: FILE_FIELDS }, `multipart/related; boundary=${boundary}`, body);
      return file(created as unknown as DriveFile);
    },
  }),
];
