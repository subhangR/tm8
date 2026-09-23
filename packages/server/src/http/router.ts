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
 * - The table is built from `MOUNTED_OPERATIONS`, not `OPERATIONS`. An ALIAS
 *   row re-declares an existing binding so a family's socket is discoverable
 *   under its own name (`containers.stream` is `events.subscribe`'s
 *   `WS /v2/ws`); it adds no route, and compiling it would make two entries
 *   share one method+path — the exact silent shadowing the ordering rule above
 *   exists to prevent.
 * - A TRAILING `*` is a wildcard that binds the rest of the path, slashes
 *   included, to the `rest` param. It is the least specific thing in the table
 *   and sorts LAST.
 */
import { MOUNTED_OPERATIONS, type OperationBinding, type OperationName } from '@tm8/contract';

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

/**
 * The param name a trailing `*` binds the remainder of the path to.
 *
 * `containers.proxy` is `GET /v2/containers/:containerId/ports/:port/*` — a
 * reverse proxy needs everything after the port, INCLUDING slashes
 * (`assets/app.js`), which `([^/]+)` cannot carry. That is why the grammar
 * needs a wildcard rather than another `:param`.
 */
export const WILDCARD_PARAM = 'rest';

export function compileRoute(op: OperationBinding): CompiledRoute {
  const paramNames: string[] = [];
  let literalSegments = 0;
  let wildcard = false;

  const segments = op.path.split('/');
  const pattern = segments
    .map((segment, index) => {
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
      if (segment === '*') {
        // ONLY AS THE LAST SEGMENT. A `*` in the middle has no meaning a
        // matcher can honour, and the reason this is a throw rather than a
        // silent literal is that a silent literal is exactly how the defect it
        // guards against got in: `escapeLiteral` escapes `*`, so a wildcard
        // path used to compile to a route matching a literal asterisk — a
        // route that matched nothing a browser would ever send, with no error
        // anywhere. A grammar the router cannot express must fail loudly at
        // compile time, the way a malformed `:param` already does.
        if (index !== segments.length - 1) {
          throw new Error(`catalog path ${op.path} has a wildcard segment that is not last`);
        }
        wildcard = true;
        paramNames.push(WILDCARD_PARAM);
        // `(.*)` and not `(.+)`: `/ports/8080/` with an empty remainder is the
        // proxy's index request and must match.
        return '(.*)';
      }
      literalSegments += 1;
      return escapeLiteral(segment);
    })
    .join('/');

  return {
    op,
    regex: new RegExp(`^${pattern}$`),
    paramNames,
    // A WILDCARD ROUTE SORTS LAST, and that is a deliberate inversion of what
    // the old accounting did. `literalSegments += 1` counted the `*` as a
    // literal, so the least specific route in the table scored as though it
    // were among the most and sorted EARLY — ahead of routes that actually
    // match. A `*` matches everything below its prefix, so it must be the last
    // candidate considered, never the first.
    specificity: wildcard ? -1 : literalSegments,
  };
}

export class Router {
  private readonly routes: readonly CompiledRoute[];

  constructor(operations: readonly OperationBinding[] = MOUNTED_OPERATIONS) {
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
