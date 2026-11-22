import type { ZodTypeAny } from 'zod';

// Review addendum 2, C4: helpers for the bounded zod parse tests (src/bounded-parse.ts).

/** One node of a zod 3 schema and where it sits, e.g. `messages[].content`. */
export interface ZodNode { path: string; typeName: string; schema: ZodTypeAny }

/**
 * Every node of a zod 3 schema, depth first. Wrappers (optional, nullable, effects, union options) keep
 * their child's path; an array element adds `[]`, a record key `<key>` and a record value `<value>`.
 * A schema shared by two paths is listed at both.
 */
export function zodNodes(root: ZodTypeAny): ZodNode[] {
  const nodes: ZodNode[] = [];
  const visit = (schema: ZodTypeAny | undefined, path: string, ancestors: ReadonlySet<ZodTypeAny>): void => {
    if (!schema || ancestors.has(schema)) return;
    const inside = new Set(ancestors).add(schema);
    // zod 3 keeps each node's parts on `_def`; the shape differs per type name.
    const def = schema._def as Record<string, any>;
    const typeName = String(def.typeName);
    nodes.push({ path, typeName, schema });
    const at = (key: string) => (path ? `${path}.${key}` : key);
    switch (typeName) {
      case 'ZodObject':
        for (const [key, value] of Object.entries(def.shape() as Record<string, ZodTypeAny>)) visit(value, at(key), inside);
        if (def.catchall?._def?.typeName !== 'ZodNever') visit(def.catchall, at('*'), inside);
        break;
      case 'ZodArray': visit(def.type, `${path}[]`, inside); break;
      case 'ZodSet': visit(def.valueType, `${path}[]`, inside); break;
      case 'ZodRecord': case 'ZodMap': visit(def.keyType, `${path}<key>`, inside); visit(def.valueType, `${path}<value>`, inside); break;
      case 'ZodOptional': case 'ZodNullable': case 'ZodDefault': case 'ZodCatch': case 'ZodReadonly': visit(def.innerType, path, inside); break;
      case 'ZodBranded': case 'ZodPromise': visit(def.type, path, inside); break;
      case 'ZodEffects': visit(def.schema, path, inside); break;
      case 'ZodPipeline': visit(def.in, path, inside); visit(def.out, path, inside); break;
      case 'ZodLazy': visit(def.getter(), path, inside); break;
      case 'ZodUnion': case 'ZodDiscriminatedUnion': for (const option of def.options as ZodTypeAny[]) visit(option, path, inside); break;
      case 'ZodIntersection': visit(def.left, path, inside); visit(def.right, path, inside); break;
      case 'ZodTuple': (def.items as ZodTypeAny[]).forEach((item, index) => visit(item, `${path}[${index}]`, inside)); visit(def.rest, `${path}[]`, inside); break;
      default: break;
    }
  };
  visit(root, '', new Set());
  return nodes;
}

/**
 * `count` empty objects that record which of them anything read, so a test can see how far a zod
 * parse went. zod reads at least one property of every object it checks.
 */
export function trackedObjects(count: number): { items: object[]; touched: Set<number> } {
  const touched = new Set<number>();
  const items = Array.from({ length: count }, (_, index) => new Proxy({}, {
    get(target, key, receiver) { touched.add(index); return Reflect.get(target, key, receiver) as unknown; },
  }));
  return { items, touched };
}
