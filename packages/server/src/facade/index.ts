/**
 * The facade block: the handler registry, the operation→input-schema table,
 * and the one function the composition root calls to mount everything.
 *
 * Derived truth (EntityDetail assembly, capabilities, badges, PullState,
 * titles/excerpts/tombstones) is computed server-side and lives in
 * ./entity-read.ts — the contract's rule is that the client never derives, it
 * renders (L3).
 *
 * WHAT IS MOUNTED, AND WHAT DELIBERATELY IS NOT. `registerFacadeHandlers`
 * registers exactly the operations that are BUILT. Everything else keeps
 * answering an honest `501 not_implemented` (DEV-13) — the registry's whole
 * design point. So the list below is not a to-do written as code: it is the
 * truthful answer to "what does this node actually do?", and `/health` reports
 * its size.
 */
export { HandlerRegistry } from './registry.js';
export { INPUT_SCHEMAS, UNBOUND_COMMAND_OPERATIONS } from './input-schemas.js';
export type { FacadeDeps } from './deps.js';

/**
 * The single EntitySummary assembler. Exported as a plain function, free of any
 * handler or registry coupling, so the event stream projects entities through
 * the SAME code the REST reads use. Two assemblers would let a WorkspaceEvent
 * and an `entities.get` disagree about one entity — for some kinds and not
 * others, which is the kind of divergence that ships unnoticed.
 */
export {
  assembleSummaries,
  loadEntitySummariesByIds,
  toEntitySummary,
  capabilitiesOf,
  contentOf,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  type EntityRow,
} from './entity-read.js';

export { queryCollection } from './handlers/collections.js';
export { buildDetail } from './handlers/entities.js';
export { loadActivity } from './handlers/activity.js';

import { HandlerRegistry } from './registry.js';
import type { Db } from '../db/types.js';
import type { ServerConfig } from '../http/config.js';
import { createLoopbackOwnerResolver } from '../identity/loopback.js';
import type { FacadeDeps } from './deps.js';

import { identityGet } from './handlers/identity.js';
import { spacesCreate, spacesGet, spacesHome, spacesList } from './handlers/spaces.js';
import { projectsCreate, projectsGet, projectsLink, projectsList } from './handlers/projects.js';
import { entitiesChildren, entitiesCreate, entitiesGet, entitiesPatch } from './handlers/entities.js';
import { collectionsQuery } from './handlers/collections.js';
import { messagesList, messagesPost } from './handlers/messages.js';
import { commandsComplete, commandsWork, entitiesActivity } from './handlers/commands.js';

/**
 * Mount the built operations onto the registry.
 *
 * Called once, by `main.ts`, with a `Db` the composition root owns. Nothing in
 * this block constructs a pool or resolves configuration for itself — a second
 * pool created deeper in the tree is a pool nobody closes.
 */
export function registerFacadeHandlers(
  registry: HandlerRegistry,
  deps: { db: Db; config: ServerConfig },
): void {
  const facade: FacadeDeps = {
    db: deps.db,
    config: deps.config,
    owner: createLoopbackOwnerResolver(deps.db),
  };

  registry.registerAll({
    // identity — proves claims + identity end to end
    'identity.get': identityGet(facade),

    // spaces — the loop's entry point; create mints the caller's member row
    'spaces.list': spacesList(facade),
    'spaces.create': spacesCreate(facade),
    'spaces.get': spacesGet(facade),
    'spaces.home': spacesHome(facade),

    // projects — execution.spawn needs a real projectId
    'projects.list': projectsList(facade),
    'projects.create': projectsCreate(facade),
    'projects.get': projectsGet(facade),
    'projects.link': projectsLink(facade),

    // entities — task and doc only (AM-5); other kinds answer an honest 501
    'entities.get': entitiesGet(facade),
    'entities.create': entitiesCreate(facade),
    'entities.patch': entitiesPatch(facade),
    'entities.children': entitiesChildren(facade),
    'entities.activity': entitiesActivity(facade),

    // collections — the query executor behind every list
    'collections.query': collectionsQuery(facade),

    // messages — the task thread the user watches
    'messages.list': messagesList(facade),
    'messages.post': messagesPost(facade),

    // the closed command namespace
    'entities.commands.work': commandsWork(facade),
    'entities.commands.complete': commandsComplete(facade),
  });
}
