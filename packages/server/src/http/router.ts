/**
 * The catalog-driven router.
 *
 * The route table is GENERATED from `@tm8/contract`'s `OPERATIONS` — it is
 * never hand-listed. That is the whole point of T-L12: the HTTP facade is a
 * *projection* of the operation catalog, so an op added to the catalog is
 * automatically routed here, and a route that does not exist in the catalog
 * cannot exist here. If you find yourself typing a path string into this
 * file, the catalog is wrong, not the router.
 *
 * Matching rules:
 * - `:param` segments match exactly one non-empty, non-`/` segment; the
 *   captured value is percent-decoded (the catalog's `bindPath` encodes it).
 * - Routes are ordered by specificity (literal segments beat params) so
 *   `/v2/entities/:id/commands/complete` wins over a hypothetical
 *   `/v2/entities/:id/commands/:name`. Today's catalog has no such overlap;
 *   the ordering exists so adding one later cannot silently shadow.
 * - A path that exists under a different method is NOT a 405. The contract's
 *   closed taxonomy has no `method_not_allowed`, and inventing one would
 *   break DEV-8. It is `not_found`, which is also what the conformance stub
 *   does.
 * - `WS` operations are excluded: `events.subscribe` is served by the upgrade
 *   handler in ../events/, which reads its path from the same catalog entry.
 */
import { OPERATIONS, type OperationBinding, type OperationName } from '@tm8/contract';

export interface CompiledRoute {
  readonly op: OperationBinding;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  /** Count of literal (non-param) segments — higher binds first. */
  readonly specificity: number;
}

export interface RouteMatch {
  readonly op: OperationBinding;
  readonly opName: OperationName;
  readonly params: Readonly<Record<string, string>>;
}

const PARAM_RE = /:([A-Za-z][A-Za-z0-9]*)/g;

function escapeLiteral(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileRoute(op: OperationBinding): CompiledRoute {
  const paramNames: string[] = [];
  let literalSegments = 0;

  const pattern = op.path
    .split('/')
    .map((segment) => {
      if (segment === '') return '';
      PARAM_RE.lastIndex = 0;
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
          throw new Error(`catalog path ${op.path} has a malformed param segment ${segment}`);
        }
        paramNames.push(name);
        return '([^/]+)';
      }
      literalSegments += 1;
      return escapeLiteral(segment);
    })
    .join('/');

  return {
    op,
    regex: new RegExp(`^${pattern}$`),
    paramNames,
    specificity: literalSegments,
  };
}

export class Router {
  private readonly routes: readonly CompiledRoute[];

  constructor(operations: readonly OperationBinding[] = OPERATIONS) {
    this.routes = operations
      .filter((op) => op.method !== 'WS')
      .map(compileRoute)
      // More literal segments first; ties keep catalog order (stable sort).
      .sort((a, b) => b.specificity - a.specificity);
  }

  /** Resolve a method+path to a catalog operation, or `undefined`. */
  match(method: string, pathname: string): RouteMatch | undefined {
    for (const route of this.routes) {
      if (route.op.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;

      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i += 1) {
        const name = route.paramNames[i];
        const value = m[i + 1];
        if (name === undefined || value === undefined) continue;
        params[name] = safeDecode(value);
      }
      return { op: route.op, opName: route.op.name as OperationName, params };
    }
    return undefined;
  }

  /** True when some operation is bound to this path under ANY method. */
  hasPath(pathname: string): boolean {
    return this.routes.some((route) => route.regex.test(pathname));
  }

  /** Introspection for `doctor`/tests — the routes actually mounted. */
  mounted(): readonly CompiledRoute[] {
    return this.routes;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed percent-escape is not worth a 400 here — the raw segment is
    // handed through and will fail validation or lookup downstream.
    return value;
  }
}
