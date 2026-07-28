import { randomUUID } from 'node:crypto';

import type { W3PublicServer } from './public-harness.js';

export interface G01DatabaseOutcome {
  space: {
    id: string;
    exists: boolean;
    name: string | null;
    description: string | null;
    settingsRevision: number | null;
  };
  memberCount: number;
  channelCount: number;
  manualTaskAxisCount: number;
  inviteCount: number;
  mutations: Array<{ clientMutationId: string; operation: string }>;
}

/**
 * A bounded evaluator oracle for the G01 agentic task. The agent sees only
 * canonical outcome facts; SQL, table layout, and implementation state stay
 * inside the W3 harness.
 */
export async function observeG01DatabaseOutcome(
  harness: W3PublicServer,
  spaceId: string,
  clientMutationIds: readonly string[],
): Promise<G01DatabaseOutcome> {
  const rows = await harness.rows<{
    id: string | null;
    name: string | null;
    description: string | null;
    settings_revision: number | null;
    member_count: number;
    channel_count: number;
    manual_axis_count: number;
    invite_count: number;
  }>(
    `select
       space_row.id::text,
       space_row.name,
       space_row.description,
       space_row.settings_revision,
       (select count(*)::integer from public.members where space_id = $1) member_count,
       (select count(*)::integer from public.channels where space_id = $1) channel_count,
       (select count(*)::integer from public.task_axes
         where space_id = $1 and kind = 'manual') manual_axis_count,
       (select count(*)::integer from public.space_invites where space_id = $1) invite_count
     from public.spaces space_row where space_row.id = $1`,
    [spaceId],
  );
  const row = rows[0];
  const mutations = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation
         from public.command_ledger
        where client_mutation_id = any($1::text[])
        order by client_mutation_id`,
      [clientMutationIds],
    );
  return {
    space: {
      id: spaceId,
      exists: row !== undefined,
      name: row?.name ?? null,
      description: row?.description ?? null,
      settingsRevision: row?.settings_revision ?? null,
    },
    memberCount: row?.member_count ?? 0,
    channelCount: row?.channel_count ?? 0,
    manualTaskAxisCount: row?.manual_axis_count ?? 0,
    inviteCount: row?.invite_count ?? 0,
    mutations: mutations.map((mutation) => ({
      clientMutationId: mutation.client_mutation_id,
      operation: mutation.operation,
    })),
  };
}

export interface G03DatabaseOutcome {
  edges: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: string;
    props: Record<string, unknown>;
  }>;
  mutations: Array<{ clientMutationId: string; operation: string }>;
}

/** Bounded G03 edge/ledger outcome without exposing database layout. */
export async function observeG03DatabaseOutcome(
  harness: W3PublicServer,
  endpointIds: readonly string[],
  clientMutationIds: readonly string[],
): Promise<G03DatabaseOutcome> {
  const edges = endpointIds.length === 0
    ? []
    : await harness.rows<{
      id: string;
      src_id: string;
      dst_id: string;
      type: string;
      props: Record<string, unknown>;
    }>(
      `select id::text, src_id::text, dst_id::text, type, props
         from public.edges
        where src_id = any($1::uuid[]) or dst_id = any($1::uuid[])
        order by type, id`,
      [endpointIds],
    );
  const mutations = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation
         from public.command_ledger
        where client_mutation_id = any($1::text[])
        order by client_mutation_id`,
      [clientMutationIds],
    );
  return {
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.src_id,
      targetId: edge.dst_id,
      type: edge.type,
      props: edge.props,
    })),
    mutations: mutations.map((mutation) => ({
      clientMutationId: mutation.client_mutation_id,
      operation: mutation.operation,
    })),
  };
}

export interface G05DatabaseOutcome {
  taskCount: number;
  liveEdgeIds: string[];
  undo: {
    token: string;
    exists: boolean;
    redemptionClientMutationId: string | null;
  };
  mutations: Array<{ clientMutationId: string; operation: string }>;
}

/** Bounded G05 collection/graph/undo outcome without exposing storage. */
export async function observeG05DatabaseOutcome(
  harness: W3PublicServer,
  spaceId: string,
  edgeIds: readonly string[],
  undoToken: string,
  clientMutationIds: readonly string[],
): Promise<G05DatabaseOutcome> {
  const countRows = await harness.rows<{ count: number }>(
    `select count(*)::integer count from public.entities
      where space_id = $1 and kind = 'task' and deleted_at is null`,
    [spaceId],
  );
  const liveEdges = edgeIds.length === 0
    ? []
    : await harness.rows<{ id: string }>(
      `select id::text from public.edges where id = any($1::uuid[]) order by id`,
      [edgeIds],
    );
  const tokenRows = await harness.rows<{ redemption_client_mutation_id: string | null }>(
    `select redemption_client_mutation_id from public.undo_tokens where token = $1`,
    [undoToken],
  );
  const mutations = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation from public.command_ledger
        where client_mutation_id = any($1::text[]) order by client_mutation_id`,
      [clientMutationIds],
    );
  return {
    taskCount: countRows[0]?.count ?? 0,
    liveEdgeIds: liveEdges.map((edge) => edge.id),
    undo: {
      token: undoToken,
      exists: tokenRows.length === 1,
      redemptionClientMutationId: tokenRows[0]?.redemption_client_mutation_id ?? null,
    },
    mutations: mutations.map((mutation) => ({
      clientMutationId: mutation.client_mutation_id,
      operation: mutation.operation,
    })),
  };
}

export interface G06DatabaseOutcome {
  project: {
    id: string;
    exists: boolean;
    name: string | null;
    repoUrl: string | null;
    activeLinkCount: number;
  };
  projections: Array<{
    spaceId: string;
    projectionId: string;
    live: boolean;
    name: string;
    repoUrl: string | null;
  }>;
  mutations: Array<{ clientMutationId: string; operation: string }>;
}

/** Bounded G06 resource/projection/ledger outcome without exposing storage. */
export async function observeG06DatabaseOutcome(
  harness: W3PublicServer,
  projectId: string,
  clientMutationIds: readonly string[],
): Promise<G06DatabaseOutcome> {
  const projects = await harness.rows<{
    id: string;
    name: string;
    repo_url: string | null;
    active_link_count: number;
  }>(
    `select id::text, name, repo_url, active_link_count::integer
       from public.projects where id = $1`,
    [projectId],
  );
  const projections = await harness.rows<{
    space_id: string;
    projection_id: string;
    live: boolean;
    name: string;
    repo_url: string | null;
  }>(
    `select link.space_id::text, link.project_entity_id::text projection_id,
            entity.deleted_at is null live, detail.name, detail.repo_url
       from public.project_links link
       join public.entities entity on entity.id = link.project_entity_id
       join public.project_projection_details detail on detail.entity_id = entity.id
      where link.project_id = $1 order by link.space_id`,
    [projectId],
  );
  const mutations = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation from public.command_ledger
        where client_mutation_id = any($1::text[]) order by client_mutation_id`,
      [clientMutationIds],
    );
  const project = projects[0];
  return {
    project: {
      id: projectId,
      exists: project !== undefined,
      name: project?.name ?? null,
      repoUrl: project?.repo_url ?? null,
      activeLinkCount: project?.active_link_count ?? 0,
    },
    projections: projections.map((projection) => ({
      spaceId: projection.space_id,
      projectionId: projection.projection_id,
      live: projection.live,
      name: projection.name,
      repoUrl: projection.repo_url,
    })),
    mutations: mutations.map((mutation) => ({
      clientMutationId: mutation.client_mutation_id,
      operation: mutation.operation,
    })),
  };
}

export interface G07DatabaseOutcome {
  uploads: Array<{
    uploadId: string;
    status: string;
    staged: boolean;
    fileEntityId: string | null;
  }>;
  file: {
    id: string;
    exists: boolean;
    name: string | null;
    mime: string | null;
    sizeBytes: number | null;
    checksumSha256: string | null;
  };
  attachmentTargetIds: string[];
  mutations: Array<{ clientMutationId: string; operation: string }>;
}

/** Bounded G07 upload/file/attachment outcome without exposing paths or schema. */
export async function observeG07DatabaseOutcome(
  harness: W3PublicServer,
  uploadIds: readonly string[],
  fileEntityId: string,
  clientMutationIds: readonly string[],
): Promise<G07DatabaseOutcome> {
  const uploads = uploadIds.length === 0
    ? []
    : await harness.rows<{
      id: string;
      status: string;
      staged: boolean;
      file_entity_id: string | null;
    }>(
      `select id::text, status, staged_at is not null staged, file_entity_id::text
         from public.file_upload_slots where id = any($1::uuid[]) order by id`,
      [uploadIds],
    );
  const files = await harness.rows<{
    id: string;
    name: string;
    mime_type: string;
    size_bytes: number;
    checksum_sha256: string;
  }>(
    `select entity_id::text id, name, mime_type, size_bytes::integer, checksum_sha256
       from public.files where entity_id = $1`,
    [fileEntityId],
  );
  const attachments = await harness.rows<{ target_id: string }>(
    `select dst_id::text target_id from public.edges
      where src_id = $1 and type = 'attached_to' order by dst_id`,
    [fileEntityId],
  );
  const mutations = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation from public.command_ledger
        where client_mutation_id = any($1::text[]) order by client_mutation_id`,
      [clientMutationIds],
    );
  const file = files[0];
  return {
    uploads: uploads.map((upload) => ({
      uploadId: upload.id,
      status: upload.status,
      staged: upload.staged,
      fileEntityId: upload.file_entity_id,
    })),
    file: {
      id: fileEntityId,
      exists: file !== undefined,
      name: file?.name ?? null,
      mime: file?.mime_type ?? null,
      sizeBytes: file?.size_bytes ?? null,
      checksumSha256: file?.checksum_sha256 ?? null,
    },
    attachmentTargetIds: attachments.map((attachment) => attachment.target_id),
    mutations: mutations.map((mutation) => ({
      clientMutationId: mutation.client_mutation_id,
      operation: mutation.operation,
    })),
  };
}

export interface G08NotificationFixture {
  memberNotificationId: string;
  teammateNotificationId: string;
}

/**
 * Evaluator-only prerequisite fixture because notification producers belong
 * to later groups. The agent receives IDs, never storage details.
 */
export async function seedG08NotificationFixture(
  harness: W3PublicServer,
  input: {
    spaceId: string;
    memberId: string;
    teammateId: string;
    targetId: string;
  },
): Promise<G08NotificationFixture> {
  const memberNotificationId = randomUUID();
  const teammateNotificationId = randomUUID();
  await harness.database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.notifications(
         id, space_id, recipient_member_id, recipient_team_member_id,
         target_entity_id, actor_id, kind, payload, created_at)
       values
         ($1, $3, $4, null, $6, $4, 'mention', '{"message":"agentic member"}', now()),
         ($2, $3, $4, $5, $6, $4, 'assignment', '{"message":"agentic teammate"}', now()-interval '1 second')`,
      [memberNotificationId, teammateNotificationId, input.spaceId, input.memberId, input.teammateId, input.targetId],
    );
  });
  return { memberNotificationId, teammateNotificationId };
}

export interface G08DatabaseOutcome {
  notifications: Array<{
    id: string;
    recipientMemberId: string;
    recipientTeammateId: string | null;
    read: boolean;
  }>;
  readMark: { exists: boolean; lastReadAt: string | null };
  mutations: Array<{ clientMutationId: string; operation: string }>;
}

/** Bounded G08 notification/read-mark/ledger outcome without exposing storage. */
export async function observeG08DatabaseOutcome(
  harness: W3PublicServer,
  notificationIds: readonly string[],
  memberId: string,
  anchorId: string,
  clientMutationIds: readonly string[],
): Promise<G08DatabaseOutcome> {
  const notifications = notificationIds.length === 0
    ? []
    : await harness.rows<{
      id: string;
      recipient_member_id: string;
      recipient_team_member_id: string | null;
      read: boolean;
    }>(
      `select id::text, recipient_member_id::text, recipient_team_member_id::text,
              read_at is not null read
         from public.notifications where id = any($1::uuid[]) order by id`,
      [notificationIds],
    );
  const readMarks = await harness.rows<{ last_read_at: string }>(
    `select last_read_at::text from public.read_marks
      where member_id = $1 and anchor_id = $2`,
    [memberId, anchorId],
  );
  const mutations = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation from public.command_ledger
        where client_mutation_id = any($1::text[]) order by client_mutation_id`,
      [clientMutationIds],
    );
  return {
    notifications: notifications.map((notification) => ({
      id: notification.id,
      recipientMemberId: notification.recipient_member_id,
      recipientTeammateId: notification.recipient_team_member_id,
      read: notification.read,
    })),
    readMark: {
      exists: readMarks.length === 1,
      lastReadAt: readMarks[0]?.last_read_at ?? null,
    },
    mutations: mutations.map((mutation) => ({
      clientMutationId: mutation.client_mutation_id,
      operation: mutation.operation,
    })),
  };
}

export interface G15DatabaseOutcome {
  ledgerEntriesForClientMutationIds: Array<{ clientMutationId: string; operation: string }>;
  totalCommandLedgerRows: number;
  totalEntityRows: number;
  totalEdgeRows: number;
}

/**
 * Bounded G15 honesty oracle. A `501 not_implemented` must leave no trace, so
 * the agent receives only the canonical facts needed to prove that: whether the
 * ledger reserved any of the client mutation IDs it sent, plus the ledger,
 * entity, and edge row totals for a before/after comparison. No table layout
 * and no row contents cross the boundary.
 */
export async function observeG15DatabaseOutcome(
  harness: W3PublicServer,
  clientMutationIds: readonly string[],
): Promise<G15DatabaseOutcome> {
  const ledgerEntries = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation from public.command_ledger
        where client_mutation_id = any($1::text[]) order by client_mutation_id`,
      [clientMutationIds],
    );
  const totals = await harness.rows<{
    ledger_rows: number;
    entity_rows: number;
    edge_rows: number;
  }>(
    `select
       (select count(*)::integer from public.command_ledger) ledger_rows,
       (select count(*)::integer from public.entities) entity_rows,
       (select count(*)::integer from public.edges) edge_rows`,
  );
  const row = totals[0];
  return {
    ledgerEntriesForClientMutationIds: ledgerEntries.map((entry) => ({
      clientMutationId: entry.client_mutation_id,
      operation: entry.operation,
    })),
    totalCommandLedgerRows: row?.ledger_rows ?? 0,
    totalEntityRows: row?.entity_rows ?? 0,
    totalEdgeRows: row?.edge_rows ?? 0,
  };
}

export interface G09DatabaseOutcome {
  entity: {
    id: string;
    exists: boolean;
    version: number | null;
  };
  views: Array<{
    id: string;
    exists: boolean;
    name: string | null;
    shareMode: string | null;
    query: Record<string, unknown> | null;
    graphLayout: Record<string, unknown> | null;
  }>;
  mutations: Array<{ clientMutationId: string; operation: string }>;
}

/** Bounded G09 view/entity/ledger outcome without exposing storage layout. */
export async function observeG09DatabaseOutcome(
  harness: W3PublicServer,
  entityId: string,
  viewIds: readonly string[],
  clientMutationIds: readonly string[],
): Promise<G09DatabaseOutcome> {
  const entities = await harness.rows<{ id: string; version: number }>(
    `select id::text, version::integer from public.entities where id = $1`,
    [entityId],
  );
  const savedViews = viewIds.length === 0
    ? []
    : await harness.rows<{
      id: string;
      name: string;
      share_mode: string;
      query: Record<string, unknown>;
      graph_layout: Record<string, unknown> | null;
    }>(
      `select id::text, name, share_mode, query, graph_layout
         from public.saved_views where id = any($1::uuid[]) order by id`,
      [viewIds],
    );
  const savedViewById = new Map(savedViews.map((view) => [view.id, view]));
  const mutations = clientMutationIds.length === 0
    ? []
    : await harness.rows<{ client_mutation_id: string; operation: string }>(
      `select client_mutation_id, operation from public.command_ledger
        where client_mutation_id = any($1::text[]) order by client_mutation_id`,
      [clientMutationIds],
    );
  const entity = entities[0];
  return {
    entity: {
      id: entityId,
      exists: entity !== undefined,
      version: entity?.version ?? null,
    },
    views: viewIds.map((id) => {
      const view = savedViewById.get(id);
      return {
        id,
        exists: view !== undefined,
        name: view?.name ?? null,
        shareMode: view?.share_mode ?? null,
        query: view?.query ?? null,
        graphLayout: view?.graph_layout ?? null,
      };
    }),
    mutations: mutations.map((mutation) => ({
      clientMutationId: mutation.client_mutation_id,
      operation: mutation.operation,
    })),
  };
}
