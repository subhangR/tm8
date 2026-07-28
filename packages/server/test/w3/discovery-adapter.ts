import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { OPERATIONS } from '@tm8/contract';

const ADAPTER_VERSION = 'tm8.w3.discovery.v1';
const NOUN_PAGE_SIZE = 12;
const MANIFEST_PATH = resolve(
  import.meta.dirname,
  '../../../../tools/conformance/generated/w1-conformance-manifest.json',
);

interface HelpOperation {
  operation: string;
  noun: string;
  exposure: 'public' | 'reserved';
  helpRef: string;
  intentTags: string[];
  inputSchemaRef: string | null;
  resultSchemaRef: string | null;
  actionDiscoverable: boolean;
  reason: string | null;
  publicComposite: unknown;
}

interface RouteEntry {
  operation: string;
  method: string;
  path: string;
  status: string;
}

interface GeneratedManifest {
  schemaVersion: string;
  catalogDigest: string;
  catalog: {
    total: number;
    v1: number;
    reserved: number;
    http: number;
    ws: number;
    registerableV1Http: number;
  };
  routes: { http: RouteEntry[]; ws: RouteEntry[] };
  help: { operations: HelpOperation[] };
}

export type DiscoveryRequest =
  | { kind: 'root' }
  | { kind: 'noun'; noun: string; cursor?: string }
  | { kind: 'operation'; operation: string };

export interface DiscoveryResponse {
  adapterVersion: typeof ADAPTER_VERSION;
  catalogDigest: string;
  result: unknown;
}

function expectedCatalogDigest(): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(OPERATIONS)).digest('hex')}`;
}

async function validatedManifest(): Promise<GeneratedManifest> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as GeneratedManifest;
  const expected = expectedCatalogDigest();
  if (manifest.catalogDigest !== expected) {
    throw new Error(`generated discovery catalog digest drift: expected ${expected}, got ${manifest.catalogDigest}`);
  }
  if (manifest.help.operations.length !== OPERATIONS.length) {
    throw new Error(
      `generated discovery operation count drift: expected ${OPERATIONS.length}, got ${manifest.help.operations.length}`,
    );
  }
  const routeNames = new Set([...manifest.routes.http, ...manifest.routes.ws].map((route) => route.operation));
  const helpNames = new Set(manifest.help.operations.map((operation) => operation.operation));
  if (routeNames.size !== OPERATIONS.length || helpNames.size !== OPERATIONS.length) {
    throw new Error('generated discovery routes/help are not one-to-one with the current catalog');
  }
  for (const operation of OPERATIONS) {
    if (!routeNames.has(operation.name) || !helpNames.has(operation.name)) {
      throw new Error(`generated discovery omitted catalog operation ${operation.name}`);
    }
  }
  return manifest;
}

function nounCursor(noun: string, offset: number): string {
  return Buffer.from(JSON.stringify({ noun, offset }), 'utf8').toString('base64url');
}

function nounOffset(noun: string, cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      noun?: unknown;
      offset?: unknown;
    };
    if (decoded.noun !== noun || !Number.isInteger(decoded.offset) || Number(decoded.offset) < 0) {
      throw new Error('mismatch');
    }
    return Number(decoded.offset);
  } catch {
    throw new Error('invalid noun discovery cursor');
  }
}

/**
 * W3-only evaluator discovery. It exposes generated metadata, not repository
 * source, implementation state, database internals, or a production route.
 */
export async function queryW3Discovery(request: DiscoveryRequest): Promise<DiscoveryResponse> {
  const manifest = await validatedManifest();
  const response = (result: unknown): DiscoveryResponse => ({
    adapterVersion: ADAPTER_VERSION,
    catalogDigest: manifest.catalogDigest,
    result,
  });

  if (request.kind === 'root') {
    const counts = new Map<string, number>();
    for (const operation of manifest.help.operations) {
      counts.set(operation.noun, (counts.get(operation.noun) ?? 0) + 1);
    }
    return response({
      schemaVersion: manifest.schemaVersion,
      catalog: manifest.catalog,
      nouns: [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([noun, operationCount]) => ({ noun, operationCount })),
      lookup: {
        noun: 'noun <exact-noun> [cursor]',
        operation: 'operation <exact-operation-name>',
      },
    });
  }

  if (request.kind === 'noun') {
    const matches = manifest.help.operations
      .filter((operation) => operation.noun === request.noun)
      .sort((left, right) => left.operation.localeCompare(right.operation));
    if (matches.length === 0) throw new Error(`unknown discovery noun: ${request.noun}`);
    const offset = nounOffset(request.noun, request.cursor);
    if (offset > matches.length) throw new Error('invalid noun discovery cursor');
    const page = matches.slice(offset, offset + NOUN_PAGE_SIZE);
    const nextOffset = offset + page.length;
    return response({
      noun: request.noun,
      items: page.map((operation) => ({
        operation: operation.operation,
        exposure: operation.exposure,
        helpRef: operation.helpRef,
        intentTags: operation.intentTags,
      })),
      nextCursor: nextOffset < matches.length ? nounCursor(request.noun, nextOffset) : null,
    });
  }

  const help = manifest.help.operations.find((operation) => operation.operation === request.operation);
  if (!help) throw new Error(`unknown discovery operation: ${request.operation}`);
  const route = [...manifest.routes.http, ...manifest.routes.ws]
    .find((entry) => entry.operation === request.operation);
  if (!route) throw new Error(`generated discovery route missing for ${request.operation}`);
  return response({
    operation: help.operation,
    noun: help.noun,
    exposure: help.exposure,
    helpRef: help.helpRef,
    intentTags: help.intentTags,
    inputSchemaRef: help.inputSchemaRef,
    resultSchemaRef: help.resultSchemaRef,
    actionDiscoverable: help.actionDiscoverable,
    reason: help.reason,
    publicComposite: help.publicComposite,
    transport: {
      method: route.method,
      path: route.path,
      catalogStatus: route.status,
    },
  });
}

function requestFromArgv(argv: string[]): DiscoveryRequest {
  const [kind, value, cursor, ...extra] = argv;
  if (extra.length > 0) throw new Error('too many discovery arguments');
  if (kind === 'root' && value === undefined) return { kind: 'root' };
  if (kind === 'noun' && value) return { kind: 'noun', noun: value, ...(cursor ? { cursor } : {}) };
  if (kind === 'operation' && value && cursor === undefined) return { kind: 'operation', operation: value };
  throw new Error('usage: discovery-adapter.ts root | noun <exact-noun> [cursor] | operation <exact-name>');
}

// `import.meta.main` is a runtime extension and is absent from the standard
// `ImportMeta` type. Narrow it locally; this is a type-only assertion with no
// runtime effect on the emitted guard.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  try {
    const result = await queryW3Discovery(requestFromArgv(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
