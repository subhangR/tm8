import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const forbidden = [
  'lockRetentionPolicy', 'temporaryHold', 'eventBasedHold', 'defaultEventBasedHold',
  'objectRetention', 'enableObjectRetention', 'retentionExpirationTime', 'setIamPolicy',
];
const src = fileURLToPath(new URL('../../src/', import.meta.url));

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function onlyReadMethods(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  const types = ts.isUnionTypeNode(type) ? type.types : [type];
  return types.length > 0 && types.every((part) => ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal) &&
    ['GET', 'POST'].includes(part.literal.text));
}

/** Follow a wrapper's method argument back to its constrained function parameter. */
function safeMethod(node: ts.Expression | ts.Identifier, file: ts.SourceFile): boolean {
  if (ts.isStringLiteralLike(node)) return node.text === 'GET' || node.text === 'POST';
  let identifier: string;
  let member: string | undefined;
  if (ts.isIdentifier(node)) identifier = node.text;
  else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    identifier = node.expression.text;
    member = node.name.text;
  } else return false;
  for (let parent: ts.Node | undefined = node.parent; parent && parent !== file; parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    const parameter = parent.parameters.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === identifier);
    if (!parameter) continue;
    if (!member) return onlyReadMethods(parameter.type);
    if (!parameter.type || !ts.isTypeLiteralNode(parameter.type)) return false;
    const property = parameter.type.members.find((candidate) => ts.isPropertySignature(candidate) && candidate.name.getText(file) === member);
    return property !== undefined && ts.isPropertySignature(property) && onlyReadMethods(property.type);
  }
  return false;
}

/** Exactly two tokens are allowed, both in GCS health: the GET selector and its parsed property. */
function healthReadOffsets(file: ts.SourceFile, path: string): Set<number> {
  const offsets = new Set<number>();
  if (path !== 'gcp/gcs.ts') return offsets;
  const klass = file.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'GcsCheckpointSink');
  if (!klass || !ts.isClassDeclaration(klass)) return offsets;
  const health = klass.members.find((member) => ts.isMethodDeclaration(member) && member.name.getText(file) === 'health');
  if (!health || !ts.isMethodDeclaration(health) || !health.body) return offsets;
  const expectedUrl = '`/storage/v1/b/${encodeURIComponent(this.#bucket)}?fields=retentionPolicy`';
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'this.#call') calls.push(node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'retentionPolicy' &&
        node.expression.getText(file) === 'jsonObject(response.bytes)' && ts.isVariableDeclaration(node.parent) &&
        node.parent.name.getText(file) === 'policy' && node.parent.initializer === node) {
      offsets.add(node.name.getStart(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(health.body);
  // Extra network calls inside health invalidate even the original allowlist.
  if (calls.length !== 1) return new Set();
  const call = calls[0]!;
  const url = call.arguments[0];
  const method = call.arguments[1];
  if (call.arguments.length !== 2 || !url || url.getText(file) !== expectedUrl || !method ||
      !ts.isStringLiteral(method) || method.text !== 'GET') return new Set();
  offsets.add(url.getStart(file) + expectedUrl.indexOf('retentionPolicy'));
  return offsets;
}

function violations(path: string, text: string): string[] {
  const result: string[] = [];
  for (const token of forbidden) if (text.includes(token)) result.push(`${path}: forbidden ${token}`);
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const allowed = healthReadOffsets(file, path);
  for (const match of text.matchAll(/retentionPolicy/g)) {
    if (!allowed.has(match.index)) result.push(`${path}: retention policy outside health read`);
  }
  const inGcp = path.startsWith('gcp/');
  const visit = (node: ts.Node): void => {
    if (inGcp && ts.isPropertyAssignment(node) && node.name.getText(file).replace(/['"]/g, '') === 'method' &&
        !safeMethod(node.initializer, file)) result.push(`${path}: HTTP method outside GET/POST`);
    if (inGcp && ts.isShorthandPropertyAssignment(node) && node.name.text === 'method' &&
        !safeMethod(node.name, file)) result.push(`${path}: HTTP method outside GET/POST`);
    if (inGcp && ts.isStringLiteralLike(node) && !ts.isLiteralTypeNode(node.parent) &&
        /^(?:PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT|PROPFIND|PURGE)$/i.test(node.text)) {
      result.push(`${path}: HTTP method outside GET/POST`);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const endpoint = node.getText(file);
      if (/\/(?:keyRings|cryptoKeys|cryptoKeyVersions)(?=\?|['"`\s]|$)/.test(endpoint) ||
          /\/storage\/v1\/b(?=\?|['"`\s]|$)/.test(endpoint)) result.push(`${path}: resource create endpoint`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (/\bcreate(?:KeyRing|CryptoKeyVersion|CryptoKey|Bucket)\b/.test(callee) ||
          /\b(?:keyRings|cryptoKeys|cryptoKeyVersions|buckets)\.(?:create|insert)\b/.test(callee)) {
        result.push(`${path}: resource create call`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

describe('static GCP no-retention-write guard', () => {
  it('scans every file in vault src and allows only the one health GET and parsed read', () => {
    const paths = files(src);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((path) => relative(src, path) === 'gcp/gcs.ts')).toBe(true);
    expect(paths.flatMap((path) => violations(relative(src, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')))).toEqual([]);
  });

  it.each(forbidden)('trips on planted forbidden fixture %s anywhere under src', (token) => {
    expect(violations('broker/planted.ts', `const planted = '${token}';`)).not.toEqual([]);
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'PURGE', 'patch'])('trips on a planted HTTP %s fixture', (method) => {
    expect(violations('gcp/planted.ts', `fetch(url, { method: '${method}' });`)).not.toEqual([]);
  });

  it.each([
    "fetch(url, { method: userInput });", "const method = 'PATCH'; fetch(url, { method });",
    "fetch(url, { 'method': 'DELETE' });", "const body = { retentionPolicy: { isLocked: true } };",
    "const body = { ['retentionPolicy']: { isLocked: false } };",
    "fetch('/storage/v1/b?project=test', { method: 'POST' });",
    "fetch('/v1/projects/p/locations/l/keyRings?keyRingId=r', { method: 'POST' });",
    "fetch('/v1/projects/p/locations/l/keyRings/r/cryptoKeys', { method: 'POST' });",
    "fetch('/v1/projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions', { method: 'POST' });",
    'client.createKeyRing(input);', 'client.createCryptoKey(input);', 'client.createCryptoKeyVersion(input);',
    'client.createBucket(input);', 'client.buckets.insert(input);',
  ])('trips on planted write/provisioning fixture %#', (fixture) => {
    expect(violations('gcp/planted.ts', fixture)).not.toEqual([]);
  });

  it('trips when a health read is changed into a POST or gains another network call', () => {
    const source = readFileSync(join(src, 'gcp/gcs.ts'), 'utf8');
    expect(violations('gcp/gcs.ts', source.replace("?fields=retentionPolicy`, 'GET'", "?fields=retentionPolicy`, 'POST'"))).not.toEqual([]);
    expect(violations('gcp/gcs.ts', source.replace('const policy =', "await this.#call('/extra', 'POST'); const policy ="))).not.toEqual([]);
  });

  it('does not allow health-like retention text in a different file or method', () => {
    const source = readFileSync(join(src, 'gcp/gcs.ts'), 'utf8');
    expect(violations('gcp/planted.ts', source)).not.toEqual([]);
    expect(violations('gcp/gcs.ts', source.replace('async health()', 'async planted()'))).not.toEqual([]);
  });
});
