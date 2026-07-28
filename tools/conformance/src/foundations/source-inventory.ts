import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  OPERATIONS,
  isOperationName,
  type OperationBinding,
  type OperationName,
} from '@tm8/contract';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const SERVER_FILES = {
  router: join(repositoryRoot, 'packages/server/src/http/router.ts'),
  facade: join(repositoryRoot, 'packages/server/src/facade/index.ts'),
  execution: join(repositoryRoot, 'packages/server/src/facade/execution-handlers.ts'),
  events: join(repositoryRoot, 'packages/server/src/events/handlers.ts'),
  inputSchemas: join(repositoryRoot, 'packages/server/src/facade/input-schemas.ts'),
} as const;

export interface HandlerSourceInventory {
  readonly facade: readonly OperationName[];
  readonly execution: readonly OperationName[];
  readonly events: readonly OperationName[];
  readonly all: readonly OperationName[];
}

export interface InputSchemaSourceInventory {
  readonly bound: readonly { operation: OperationName; schema: string }[];
  readonly unboundCommands: readonly OperationName[];
}

function sourceFile(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isIdentifier(name)) return name.text;
  return undefined;
}

function operationName(value: string, context: string): OperationName {
  if (!isOperationName(value)) {
    throw new Error(`${context} references unknown catalog operation ${value}`);
  }
  return value;
}

function registeredOperationsInNode(
  path: string,
  node: ts.Node,
  registryName: string,
): OperationName[] {
  const names: OperationName[] = [];

  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && ts.isIdentifier(current.expression.expression)
      && current.expression.expression.text === registryName
    ) {
      const callName = current.expression.name.text;
      const first = current.arguments[0];
      if (callName === 'register') {
        if (!first || !ts.isStringLiteral(first)) {
          throw new Error(`${path}: registry.register must use a literal catalog operation name`);
        }
        names.push(operationName(first.text, path));
      }
      if (callName === 'registerAll') {
        if (!first || !ts.isObjectLiteralExpression(first)) {
          throw new Error(`${path}: registry.registerAll must use an auditable object literal`);
        }
        for (const property of first.properties) {
          if (!ts.isPropertyAssignment(property)) {
            throw new Error(`${path}: registry.registerAll contains a non-property entry`);
          }
          const name = propertyName(property.name);
          if (!name) throw new Error(`${path}: registry.registerAll contains a computed property`);
          names.push(operationName(name, path));
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

async function registeredOperations(path: string): Promise<OperationName[]> {
  const source = sourceFile(path, await readFile(path, 'utf8'));
  return registeredOperationsInNode(path, source, 'registry');
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true;
}

function exportedRegistrationFunction(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === name
    && hasExportModifier(statement));
  if (!declaration?.body) {
    throw new Error(`${source.fileName}: missing exported registration function ${name}`);
  }
  return declaration;
}

function registryParameterName(declaration: ts.FunctionDeclaration): string {
  const parameter = declaration.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    throw new Error(`${declaration.getSourceFile().fileName}: registration seam must name its registry parameter`);
  }
  return parameter.name.text;
}

interface LocalRegistrationImport {
  readonly importedName: string;
  readonly localName: string;
  readonly path: string;
}

function localRegistrationImports(source: ts.SourceFile): Map<string, LocalRegistrationImport> {
  const imports = new Map<string, LocalRegistrationImport>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.startsWith('.')
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)
    ) continue;

    for (const specifier of statement.importClause.namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (!importedName.startsWith('register')) continue;
      const localName = specifier.name.text;
      if (imports.has(localName)) {
        throw new Error(`${source.fileName}: duplicate local registration import ${localName}`);
      }
      const modulePath = resolve(
        dirname(source.fileName),
        statement.moduleSpecifier.text.replace(/\.js$/, '.ts'),
      );
      if (!modulePath.startsWith(`${repositoryRoot}/`)) {
        throw new Error(`${source.fileName}: registration seam ${localName} resolves outside the repository`);
      }
      imports.set(localName, { importedName, localName, path: modulePath });
    }
  }
  return imports;
}

function mountedRegistrationImports(
  source: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
  registryName: string,
  imports: ReadonlyMap<string, LocalRegistrationImport>,
): LocalRegistrationImport[] {
  const mounted: LocalRegistrationImport[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const registrationImport = imports.get(node.expression.text);
      if (registrationImport) {
        const first = node.arguments[0];
        if (!first || !ts.isIdentifier(first) || first.text !== registryName) {
          throw new Error(
            `${source.fileName}: mounted registration seam ${registrationImport.localName} must receive ${registryName} first`,
          );
        }
        mounted.push(registrationImport);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body!);
  return mounted;
}

async function facadeRegisteredOperations(): Promise<OperationName[]> {
  const path = SERVER_FILES.facade;
  const source = sourceFile(path, await readFile(path, 'utf8'));
  const declaration = exportedRegistrationFunction(source, 'registerFacadeHandlers');
  const registryName = registryParameterName(declaration);
  const direct = registeredOperationsInNode(path, declaration.body!, registryName);
  const imports = localRegistrationImports(source);
  const mounted = mountedRegistrationImports(source, declaration, registryName, imports);
  const seamOperations = await Promise.all(mounted.map(async (registrationImport) => {
    const seamSource = sourceFile(
      registrationImport.path,
      await readFile(registrationImport.path, 'utf8'),
    );
    const seam = exportedRegistrationFunction(seamSource, registrationImport.importedName);
    const names = registeredOperationsInNode(
      registrationImport.path,
      seam.body!,
      registryParameterName(seam),
    );
    if (names.length === 0) {
      throw new Error(
        `${registrationImport.path}: mounted registration seam ${registrationImport.importedName} has no literal registrations`,
      );
    }
    return names;
  }));
  const facade = [...direct, ...seamOperations.flat()];
  ensureUnique(facade, 'facade handler registry');
  return facade;
}

function ensureUnique(names: readonly OperationName[], context: string): void {
  const seen = new Set<OperationName>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`${context} contains duplicate operation ${name}`);
    seen.add(name);
  }
}

export async function readHandlerSourceInventory(): Promise<HandlerSourceInventory> {
  const [facade, execution, events] = await Promise.all([
    facadeRegisteredOperations(),
    registeredOperations(SERVER_FILES.execution),
    registeredOperations(SERVER_FILES.events),
  ]);
  const all = [...facade, ...execution, ...events];
  ensureUnique(all, 'semantic handler registry');
  return { facade, execution, events, all: [...all].sort() };
}

function findVariable(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  throw new Error(`${source.fileName}: missing exported variable ${name}`);
}

export async function readInputSchemaSourceInventory(): Promise<InputSchemaSourceInventory> {
  const path = SERVER_FILES.inputSchemas;
  const source = sourceFile(path, await readFile(path, 'utf8'));
  const bindingsNode = findVariable(source, 'INPUT_SCHEMAS');
  if (!ts.isObjectLiteralExpression(bindingsNode)) {
    throw new Error(`${path}: INPUT_SCHEMAS must be an object literal`);
  }
  const bound = bindingsNode.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${path}: INPUT_SCHEMAS contains a non-property entry`);
    }
    const name = propertyName(property.name);
    if (!name) throw new Error(`${path}: INPUT_SCHEMAS contains a computed property`);
    if (!ts.isIdentifier(property.initializer)) {
      throw new Error(`${path}: ${name} must bind a named @tm8/contract schema`);
    }
    return {
      operation: operationName(name, path),
      schema: property.initializer.text,
    };
  });
  ensureUnique(bound.map(({ operation }) => operation), 'INPUT_SCHEMAS');

  const unboundNode = findVariable(source, 'UNBOUND_COMMAND_OPERATIONS');
  if (!ts.isArrayLiteralExpression(unboundNode)) {
    throw new Error(`${path}: UNBOUND_COMMAND_OPERATIONS must be an array literal`);
  }
  const unboundCommands = unboundNode.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error(`${path}: UNBOUND_COMMAND_OPERATIONS must contain literal operation names`);
    }
    return operationName(element.text, path);
  });
  ensureUnique(unboundCommands, 'UNBOUND_COMMAND_OPERATIONS');
  return { bound, unboundCommands };
}

/**
 * The HTTP router is intentionally generated from OPERATIONS. This verifies
 * that the actual Router source still has that seam before deriving routes;
 * if its constructor or WS exclusion changes, generation fails closed.
 */
export async function readRouterSourceInventory(): Promise<{
  http: readonly OperationBinding[];
  ws: readonly OperationBinding[];
}> {
  const path = SERVER_FILES.router;
  const text = await readFile(path, 'utf8');
  const hasCatalogDefault = /constructor\s*\(\s*operations:[\s\S]*?=\s*OPERATIONS\s*\)/m.test(text);
  const excludesWs = /\.filter\(\(op\)\s*=>\s*op\.method\s*!==\s*'WS'\)/m.test(text);
  if (!hasCatalogDefault || !excludesWs) {
    throw new Error(`${path}: Router no longer proves catalog-derived HTTP routing with explicit WS exclusion`);
  }
  return {
    http: OPERATIONS.filter((operation) => operation.method !== 'WS'),
    ws: OPERATIONS.filter((operation) => operation.method === 'WS'),
  };
}
