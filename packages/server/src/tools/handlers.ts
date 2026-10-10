import {
  CollabError, decodeCursor, encodeCursor,
  ToolCreateInputSchema, ToolUpdateInputSchema, ToolConfigSetInputSchema, ToolConfigUnsetInputSchema,
  ToolSecretBindInputSchema, ToolSecretUnbindInputSchema, ToolRunInputSchema,
} from '@tm8/contract';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { claimsFor, commandEnvelope, requireUuidParam, limitOf } from '../facade/context.js';
import { requireHumanSession } from '../facade/handlers/w2/credentials.js';
import { loadActors, actorOf } from '../facade/entity-read.js';
import { loadTool, loadToolRun, RUN_SELECT, toolRunView, type ToolRunRow } from './views.js';
import type { ToolRuntime } from './runtime.js';

export function registerToolHandlers(registry: HandlerRegistry, deps: FacadeDeps, runtime?: ToolRuntime): void {
  registry.registerAll({
    'tools.create': async ctx => {
      const input = ToolCreateInputSchema.parse({ ...ctx.body as object, spaceId: requireUuidParam(ctx, 'spaceId') });
      return deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), async q => {
        const result = await q.rpc<{ entity: { id: string } }>('create_tool_entity',
          [input.spaceId, JSON.stringify(input.definition), input.actorId ?? null, input.clientMutationId]);
        return loadTool(q, result.entity.id);
      });
    },
    'tools.update': async ctx => {
      const input = ToolUpdateInputSchema.parse({ ...ctx.body as object, toolId: requireUuidParam(ctx, 'toolId') });
      return deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), async q => {
        await q.rpc('update_tool_entity', [input.toolId, input.expectedVersion, JSON.stringify(input.definition), input.actorId ?? null, input.clientMutationId]);
        return loadTool(q, input.toolId);
      });
    },
    'tools.get': async ctx => deps.db.tx(claimsFor(await deps.owner(), ctx), q => loadTool(q, requireUuidParam(ctx, 'toolId'))),
    'tools.list': async ctx => {
      const spaceId = requireUuidParam(ctx, 'spaceId'), limit = limitOf(ctx.query.get('limit'));
      const words = ctx.query.get('words') ?? '', cursor = ctx.query.get('cursor');
      const keys = cursor ? decodeCursor(cursor).k : [spaceId, words, null];
      if (keys.length !== 3 || keys[0] !== spaceId || keys[1] !== words || (keys[2] !== null && typeof keys[2] !== 'string')) throw new CollabError('invalid_cursor', 'Invalid tool cursor');
      return deps.db.tx(claimsFor(await deps.owner(), ctx), async q => {
        const rows = await q.query<{ id: string }>(`select e.id from public.entities e join public.tools t on t.entity_id=e.id
          where e.space_id=$1 and e.deleted_at is null and internal.entity_readable(e.id)
          and ($2::uuid is null or e.id>$2::uuid)
          and ($3='' or strpos(lower((t.definition->>'name')||' '||(t.definition->>'description')),lower($3))>0)
          order by e.id limit $4`, [spaceId, keys[2], words, limit + 1]);
        const page = rows.slice(0, limit);
        return { items: await Promise.all(page.map(row => loadTool(q, row.id))),
          nextCursor: rows.length > limit ? encodeCursor([spaceId, words, page.at(-1)!.id]) : null };
      });
    },
    'tools.help': async ctx => {
      const view = await deps.db.tx(claimsFor(await deps.owner(), ctx), q => loadTool(q, requireUuidParam(ctx, 'toolId')));
      return { toolId: view.id, version: view.version, sourceSha256: view.sourceSha256, name: view.definition.name,
        description: view.definition.description, help: view.definition.help, runtime: view.definition.runtime,
        tm8Access: view.definition.tm8Access, timeoutSeconds: view.definition.timeoutSeconds,
        inputs: view.definition.inputs.map(input => ({ ...input,
          flag: input.flag ?? input.name.replaceAll('_', '-'), env: input.env ?? input.name.toUpperCase(),
          configured: input.type === 'secret' ? view.secretBindings.some(binding => binding.inputName === input.name) : Object.hasOwn(view.config, input.name),
          ...(input.type !== 'secret' && Object.hasOwn(view.config, input.name) ? { configuredValue: view.config[input.name] } : {}) })) };
    },
    'tools.config.set': async ctx => {
      const input = ToolConfigSetInputSchema.parse({ ...ctx.body as object, toolId: requireUuidParam(ctx, 'toolId') });
      return deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), async q => {
        await q.rpc('set_tool_config', [input.toolId, input.expectedVersion, input.inputName, JSON.stringify(input.value), false, input.actorId ?? null, input.clientMutationId]);
        return loadTool(q, input.toolId);
      });
    },
    'tools.config.unset': async ctx => {
      const input = ToolConfigUnsetInputSchema.parse({ ...ctx.body as object, toolId: requireUuidParam(ctx, 'toolId') });
      return deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), async q => {
        await q.rpc('set_tool_config', [input.toolId, input.expectedVersion, input.inputName, null, true, input.actorId ?? null, input.clientMutationId]);
        return loadTool(q, input.toolId);
      });
    },
    'tools.secrets.bind': requireHumanSession(async ctx => {
      const input = ToolSecretBindInputSchema.parse({ ...ctx.body as object, toolId: requireUuidParam(ctx, 'toolId') });
      const claims = claimsFor(await deps.owner(), ctx, commandEnvelope(ctx));
      const value = input.value;
      if (value !== undefined) {
        if (!runtime) throw new CollabError('not_implemented', 'Tool secret storage is unavailable on this node');
        await runtime.createSecret(claims, { ...input, value });
      } else {
        await deps.db.rpc(claims, 'bind_tool_secret', [input.toolId, input.expectedVersion, input.inputName, input.credentialId!, false, input.actorId ?? null, input.clientMutationId]);
      }
      const view = await deps.db.tx(claims, q => loadTool(q, input.toolId));
      return { inputName: input.inputName, keyHint: view.secretBindings.find(binding => binding.inputName === input.inputName)?.keyHint ?? null };
    }),
    'tools.secrets.unbind': requireHumanSession(async ctx => {
      const input = ToolSecretUnbindInputSchema.parse({ ...ctx.body as object, toolId: requireUuidParam(ctx, 'toolId') });
      return deps.db.tx(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), async q => {
        await q.rpc('bind_tool_secret', [input.toolId, input.expectedVersion, input.inputName, null, true, input.actorId ?? null, input.clientMutationId]);
        return loadTool(q, input.toolId);
      });
    }),
    'tools.run': async ctx => {
      const input = ToolRunInputSchema.parse({ ...ctx.body as object, toolId: requireUuidParam(ctx, 'toolId') });
      if (!runtime) throw new CollabError('not_implemented', 'Tool execution is unavailable on this node');
      return runtime.run(claimsFor(await deps.owner(), ctx, commandEnvelope(ctx)), ctx.identity, input);
    },
    'tools.runs.list': async ctx => {
      const toolId = requireUuidParam(ctx, 'toolId'), limit = limitOf(ctx.query.get('limit')), cursor = ctx.query.get('cursor');
      const keys = cursor ? decodeCursor(cursor).k : [toolId, null];
      if (keys.length !== 2 || keys[0] !== toolId || (keys[1] !== null && typeof keys[1] !== 'string')) throw new CollabError('invalid_cursor', 'Invalid tool run cursor');
      return deps.db.tx(claimsFor(await deps.owner(), ctx), async q => {
        await loadTool(q, toolId);
        const rows = await q.query<ToolRunRow>(`${RUN_SELECT} and w.tool_id=$1 and ($2::uuid is null or e.id>$2::uuid) order by e.id limit $3`, [toolId, keys[1], limit + 1]);
        const page = rows.slice(0, limit);
        const actors = await loadActors(q, page.map(row => row.created_by));
        return { items: page.map(row => ({ ...toolRunView(row), invoker: actorOf(actors, row.created_by) })), nextCursor: rows.length > limit ? encodeCursor([toolId, page.at(-1)!.id]) : null };
      });
    },
    'tools.runs.get': async ctx => deps.db.tx(claimsFor(await deps.owner(), ctx), q => loadToolRun(q, requireUuidParam(ctx, 'sessionId'))),
  });
}
