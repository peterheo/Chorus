import type { Queryable } from './authz.ts';
import { withReadTx, type ReadContext } from './command.ts';
import { ChorusError } from './errors.ts';
import type { Uuid } from './ids.ts';
import { loadReviewSummaries, iso, type ReviewSummary } from './commands/support.ts';
import type { TaskSummary } from './commands/tasks.ts';
import { REVIEW_STATES, TASK_STATES, type ReviewState, type TaskState } from './transitions.ts';
import {
  decodeCursor,
  encodeCursor,
  invalid,
  limitOrDefault,
  optionalBoolean,
  requireArray,
  requireEnum,
  requireInteger,
  requireObject,
  requireUuid,
} from './validation.ts';

/**
 * Reads (RC-WP2 spec section 9). Every read runs in `withReadTx`, so row-level security decides what
 * is visible; an invisible or missing row is simply `not_found`. Pure SELECTs.
 */

/** Session membership is the visibility rule: a non-member gets `not_found` from every session read. */
async function assertMember(db: Queryable, ctx: ReadContext, sessionId: string): Promise<string[]> {
  const { rows } = await db.query<{ roles: string[] }>(
    `SELECT roles FROM session_members
      WHERE workspace_id = $1 AND session_id = $2 AND actor_id = $3 AND removed_at IS NULL`,
    [ctx.workspaceId, sessionId, ctx.actorId],
  );
  const roles = rows[0]?.roles;
  if (roles === undefined) throw new ChorusError('not_found', 'Not found.');
  return roles;
}

export type ListWorkResponse = {
  items: (TaskSummary & { blocked: boolean })[];
  next_cursor: string | null;
};

export async function listWork(ctx: ReadContext, input: unknown): Promise<ListWorkResponse> {
  const raw = requireObject(input, [
    'session_id',
    'board_id',
    'states',
    'owner',
    'blocked',
    'limit',
    'cursor',
  ]);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const boardId = raw['board_id'] === undefined ? null : requireUuid(raw['board_id'], 'board_id');
  const states =
    raw['states'] === undefined
      ? null
      : requireArray(raw['states'], 'states', 1, TASK_STATES.length).map((s) =>
          requireEnum<TaskState>(s, 'states', TASK_STATES),
        );
  const owner =
    raw['owner'] === undefined ? 'any' : requireEnum(raw['owner'], 'owner', ['me', 'any']);
  const blocked =
    raw['blocked'] === undefined ? null : optionalBoolean(raw['blocked'], 'blocked', false);
  const limit = limitOrDefault(raw['limit']);
  const cursor = decodeCursor(raw['cursor']) ?? null;

  return withReadTx(ctx, async (db) => {
    await assertMember(db, ctx, sessionId);
    const { rows } = await db.query<TaskRow>(
      `SELECT w.id, w.session_id, w.board_id, w.home_room_id, w.title, w.state, w.version,
              w.owner_actor_id, w.priority, (w.blocked_at IS NOT NULL) AS blocked,
              d.review_required, d.shareable, jsonb_array_length(d.acceptance_criteria) AS criteria_count,
              w.created_at, w.updated_at
         FROM work_items w
         JOIN task_details d ON d.workspace_id = w.workspace_id AND d.item_id = w.id
        WHERE w.workspace_id = $1 AND w.session_id = $2 AND w.kind = 'task'
          AND ($3::uuid IS NULL OR w.board_id = $3)
          AND ($4::text[] IS NULL OR w.state = ANY($4))
          AND ($5::uuid IS NULL OR w.owner_actor_id = $5)
          AND ($6::boolean IS NULL OR (w.blocked_at IS NOT NULL) = $6)
          AND ($7::uuid IS NULL OR w.id < $7)
        ORDER BY w.id DESC
        LIMIT $8`,
      [
        ctx.workspaceId,
        sessionId,
        boardId,
        states,
        owner === 'me' ? ctx.actorId : null,
        blocked,
        cursor,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map(toTaskSummary),
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]?.id ?? '') : null,
    };
  });
}

interface TaskRow {
  id: Uuid;
  session_id: Uuid;
  board_id: Uuid;
  home_room_id: Uuid;
  title: string;
  state: string;
  version: number;
  owner_actor_id: Uuid | null;
  priority: number;
  blocked: boolean;
  review_required: boolean;
  shareable: boolean;
  criteria_count: number;
  created_at: Date;
  updated_at: Date;
}

function toTaskSummary(r: TaskRow): TaskSummary & { blocked: boolean } {
  return {
    id: r.id,
    session_id: r.session_id,
    board_id: r.board_id,
    room_id: r.home_room_id,
    title: r.title,
    state: r.state,
    version: r.version,
    owner_actor_id: r.owner_actor_id,
    priority: r.priority,
    blocked: r.blocked,
    review_required: r.review_required,
    shareable: r.shareable,
    criteria_count: r.criteria_count,
    created_at: iso(r.created_at) ?? '',
    updated_at: iso(r.updated_at) ?? '',
  };
}

export type RevisionMeta = {
  revision: number;
  content_sha256: string;
  content_type: string;
  byte_length: number;
  submitted_by: string;
  fence: number;
  created_at: string;
};

export type TaskDetail = {
  id: string;
  session_id: string;
  board_id: string;
  priority: number;
  blocked: { reason: string; at: string } | null;
  work_cycle: number;
  criteria_revision: number;
  claim_policy: string;
  room_id: string;
  title: string;
  body: string;
  state: string;
  version: number;
  creator_actor_id: string;
  owner_actor_id: string | null;
  acceptance_criteria: string[];
  review_required: boolean;
  shareable: boolean;
  lease: {
    fence: number;
    live: boolean;
    expires_at: string | null;
    holder_instance_id: string | null;
  };
  latest_revision: number | null;
  revisions: RevisionMeta[];
  reviews: ReviewSummary[];
  created_at: string;
  updated_at: string;
};

export async function getTask(ctx: ReadContext, input: unknown): Promise<TaskDetail> {
  const raw = requireObject(input, ['session_id', 'task_id']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const taskId = requireUuid(raw['task_id'], 'task_id');

  return withReadTx(ctx, async (db) => {
    await assertMember(db, ctx, sessionId);
    const { rows } = await db.query<{
      id: Uuid;
      home_room_id: Uuid;
      session_id: Uuid;
      board_id: Uuid;
      priority: number;
      blocked_reason: string | null;
      blocked_at: Date | null;
      work_cycle: number;
      criteria_revision: number;
      claim_policy: string;
      title: string;
      body: string;
      state: string;
      version: number;
      creator_actor_id: Uuid;
      owner_actor_id: Uuid | null;
      acceptance_criteria: string[];
      review_required: boolean;
      shareable: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT w.id, w.home_room_id, w.session_id, w.board_id, w.priority, w.blocked_reason,
              w.blocked_at, w.work_cycle, d.criteria_revision, d.claim_policy, w.title, w.body,
              w.state, w.version, w.creator_actor_id, w.owner_actor_id, d.acceptance_criteria,
              d.review_required, d.shareable, w.created_at, w.updated_at
         FROM work_items w
         JOIN task_details d ON d.workspace_id = w.workspace_id AND d.item_id = w.id
        WHERE w.workspace_id = $1 AND w.session_id = $2 AND w.id = $3 AND w.kind = 'task'`,
      [ctx.workspaceId, sessionId, taskId],
    );
    const task = rows[0];
    if (task === undefined) throw new ChorusError('not_found', 'Not found.');

    const leaseRows = await db.query<{
      fence: string;
      instance_id: Uuid | null;
      expires_at: Date | null;
      live: boolean;
    }>(
      `SELECT fence, instance_id, expires_at,
              COALESCE(instance_id IS NOT NULL AND expires_at > now(), false) AS live
         FROM task_leases WHERE workspace_id = $1 AND task_id = $2`,
      [ctx.workspaceId, taskId],
    );
    const lease = leaseRows.rows[0];

    const revisions = await db.query<{
      revision: number;
      content_sha256: string;
      content_type: string;
      byte_length: number;
      submitted_by: Uuid;
      fence: string;
      created_at: Date;
    }>(
      `SELECT revision, content_sha256, content_type, byte_length, submitted_by, fence, created_at
         FROM task_result_revisions WHERE workspace_id = $1 AND task_id = $2
        ORDER BY revision ASC LIMIT 100`,
      [ctx.workspaceId, taskId],
    );
    const reviewIds = await db.query<{ review_item_id: Uuid }>(
      `SELECT review_item_id FROM review_details WHERE workspace_id = $1 AND subject_task_id = $2`,
      [ctx.workspaceId, taskId],
    );
    const reviews = await loadReviewSummaries(
      db,
      ctx.workspaceId,
      reviewIds.rows.map((r) => r.review_item_id),
    );
    const latest = await db.query<{ latest: number | null }>(
      `SELECT max(revision) AS latest FROM task_result_revisions WHERE workspace_id = $1 AND task_id = $2`,
      [ctx.workspaceId, taskId],
    );
    const isOwner = task.owner_actor_id === ctx.actorId;

    return {
      id: task.id,
      session_id: task.session_id,
      board_id: task.board_id,
      priority: task.priority,
      blocked:
        task.blocked_at === null
          ? null
          : { reason: task.blocked_reason ?? '', at: iso(task.blocked_at) ?? '' },
      work_cycle: task.work_cycle,
      criteria_revision: task.criteria_revision,
      claim_policy: task.claim_policy,
      room_id: task.home_room_id,
      title: task.title,
      body: task.body,
      state: task.state,
      version: task.version,
      creator_actor_id: task.creator_actor_id,
      owner_actor_id: task.owner_actor_id,
      acceptance_criteria: task.acceptance_criteria,
      review_required: task.review_required,
      shareable: task.shareable,
      lease: {
        fence: Number(lease?.fence ?? 0),
        live: lease?.live ?? false,
        expires_at: iso(lease?.expires_at ?? null),
        // Only the owner may see which instance holds the lease.
        holder_instance_id: isOwner ? (lease?.instance_id ?? null) : null,
      },
      latest_revision: latest.rows[0]?.latest ?? null,
      revisions: revisions.rows.map((r) => ({
        revision: r.revision,
        content_sha256: r.content_sha256,
        content_type: r.content_type,
        byte_length: r.byte_length,
        submitted_by: r.submitted_by,
        fence: Number(r.fence),
        created_at: iso(r.created_at) ?? '',
      })),
      reviews,
      created_at: iso(task.created_at) ?? '',
      updated_at: iso(task.updated_at) ?? '',
    };
  });
}

export type ResultDetail = {
  task_id: string;
  revision: number;
  content_type: string;
  content: string;
  content_sha256: string;
  byte_length: number;
  criteria_mapping: { criterion: number; note: string }[];
  supporting_refs: { url: string; label: string; verified: false }[];
  submitted_by: string;
  fence: number;
  created_at: string;
};

export async function getResult(ctx: ReadContext, input: unknown): Promise<ResultDetail> {
  const raw = requireObject(input, ['session_id', 'task_id', 'revision']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const revision = requireInteger(raw['revision'], 'revision', 1);

  return withReadTx(ctx, async (db) => {
    await assertMember(db, ctx, sessionId);
    const { rows } = await db.query<{
      revision: number;
      content_type: string;
      content: string;
      content_sha256: string;
      byte_length: number;
      criteria_mapping: { criterion: number; note: string }[];
      supporting_refs: { url: string; label: string }[];
      submitted_by: Uuid;
      fence: string;
      created_at: Date;
    }>(
      `SELECT revision, content_type, content, content_sha256, byte_length, criteria_mapping,
              supporting_refs, submitted_by, fence, created_at
         FROM task_result_revisions
        WHERE workspace_id = $1 AND session_id = $2 AND task_id = $3 AND revision = $4`,
      [ctx.workspaceId, sessionId, taskId, revision],
    );
    const row = rows[0];
    if (row === undefined) throw new ChorusError('not_found', 'Not found.');
    return {
      task_id: taskId,
      revision: row.revision,
      content_type: row.content_type,
      content: row.content,
      content_sha256: row.content_sha256,
      byte_length: row.byte_length,
      criteria_mapping: row.criteria_mapping,
      // Supporting references are caller-supplied metadata; the server never fetches or verifies them.
      supporting_refs: row.supporting_refs.map((r) => ({
        url: r.url,
        label: r.label,
        verified: false as const,
      })),
      submitted_by: row.submitted_by,
      fence: Number(row.fence),
      created_at: iso(row.created_at) ?? '',
    };
  });
}

export type MyReview = {
  session_id: string;
  id: string;
  version: number;
  task_id: string;
  room_id: string;
  task_title: string;
  revision: number;
  content_sha256: string;
  state: string;
  stale: boolean;
  created_at: string;
};

export async function listMyReviews(
  ctx: ReadContext,
  input: unknown,
): Promise<{ items: MyReview[]; next_cursor: string | null }> {
  const raw = requireObject(input, ['session_id', 'states', 'limit', 'cursor']);
  const sessionFilter =
    raw['session_id'] === undefined ? null : requireUuid(raw['session_id'], 'session_id');
  const states: ReviewState[] =
    raw['states'] === undefined
      ? ['requested']
      : requireArray(raw['states'], 'states', 1, REVIEW_STATES.length).map((s) =>
          requireEnum<ReviewState>(s, 'states', REVIEW_STATES),
        );
  const limit = limitOrDefault(raw['limit']);
  const cursor = decodeCursor(raw['cursor']) ?? null;
  if (new Set(states).size !== states.length) throw invalid('states', 'states must not repeat.');

  return withReadTx(ctx, async (db) => {
    const { rows } = await db.query<{
      session_id: Uuid;
      id: Uuid;
      version: number;
      task_id: Uuid;
      room_id: Uuid;
      task_title: string;
      revision: number;
      content_sha256: string;
      state: string;
      stale: boolean;
      created_at: Date;
    }>(
      `SELECT w.session_id, w.id, w.version, d.subject_task_id AS task_id, w.home_room_id AS room_id,
              t.title AS task_title, d.result_revision AS revision, d.content_sha256, w.state,
              d.result_revision < COALESCE(
                (SELECT max(r.revision) FROM task_result_revisions r
                  WHERE r.workspace_id = d.workspace_id AND r.task_id = d.subject_task_id), 0) AS stale,
              w.created_at
         FROM work_items w
         JOIN review_details d ON d.workspace_id = w.workspace_id AND d.review_item_id = w.id
         JOIN work_items t ON t.workspace_id = d.workspace_id AND t.id = d.subject_task_id
        WHERE w.workspace_id = $1 AND w.kind = 'review' AND w.owner_actor_id = $2
          AND w.state = ANY($3::text[]) AND d.cancelled_at IS NULL
          AND ($4::uuid IS NULL OR w.id < $4)
          AND ($5::uuid IS NULL OR w.session_id = $5)
        ORDER BY w.id DESC
        LIMIT $6`,
      [ctx.workspaceId, ctx.actorId, states, cursor, sessionFilter, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        session_id: r.session_id,
        id: r.id,
        version: r.version,
        task_id: r.task_id,
        room_id: r.room_id,
        task_title: r.task_title,
        revision: r.revision,
        content_sha256: r.content_sha256,
        state: r.state,
        stale: r.stale,
        created_at: iso(r.created_at) ?? '',
      })),
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]?.id ?? '') : null,
    };
  });
}

// --------------------------------------------------------------------------------------------------
// Session reads
// --------------------------------------------------------------------------------------------------

export type SessionListing = {
  id: string;
  name: string;
  join_policy: string;
  discoverable: boolean;
  member: boolean;
  roles: string[];
};

/**
 * Sessions in the caller's room: the discoverable ones plus every session the caller belongs to.
 * A non-discoverable session the caller is not in is never returned or counted (row-level security).
 */
export async function listSessions(
  ctx: ReadContext & { readonly roomId: Uuid },
  input: unknown,
): Promise<{ items: SessionListing[] }> {
  requireObject(input, []);
  return withReadTx(ctx, async (db) => {
    const { rows } = await db.query<{
      id: Uuid;
      name: string;
      join_policy: string;
      discoverable: boolean;
      roles: string[] | null;
    }>(
      `SELECT s.id, s.name, s.join_policy, s.discoverable, m.roles
         FROM sessions s
         LEFT JOIN session_members m
           ON m.workspace_id = s.workspace_id AND m.session_id = s.id AND m.actor_id = $3
          AND m.removed_at IS NULL
        WHERE s.workspace_id = $1 AND s.room_id = $2 AND s.state = 'active'
        ORDER BY s.id DESC`,
      [ctx.workspaceId, ctx.roomId, ctx.actorId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        join_policy: r.join_policy,
        discoverable: r.discoverable,
        member: r.roles !== null,
        roles: r.roles ?? [],
      })),
    };
  });
}

export type SessionDetail = {
  id: string;
  room_id: string;
  name: string;
  state: string;
  version: number;
  join_policy: string;
  discoverable: boolean;
  default_claim_policy: string;
  manager_review_allowed: boolean;
  default_review_required: boolean;
  /** Only administrators see the principal list. */
  listed_principals: string[] | null;
  my_roles: string[];
};

export async function getSession(ctx: ReadContext, input: unknown): Promise<SessionDetail> {
  const raw = requireObject(input, ['session_id']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  return withReadTx(ctx, async (db) => {
    const roles = await assertMember(db, ctx, sessionId);
    const { rows } = await db.query<{
      id: Uuid;
      room_id: Uuid;
      name: string;
      state: string;
      version: number;
      join_policy: string;
      discoverable: boolean;
      default_claim_policy: string;
      manager_review_allowed: boolean;
      default_review_required: boolean;
      listed_principals: string[];
    }>(
      `SELECT id, room_id, name, state, version, join_policy, discoverable, default_claim_policy,
              manager_review_allowed, default_review_required, listed_principals
         FROM sessions WHERE workspace_id = $1 AND id = $2`,
      [ctx.workspaceId, sessionId],
    );
    const s = rows[0];
    if (s === undefined) throw new ChorusError('not_found', 'Not found.');
    return {
      id: s.id,
      room_id: s.room_id,
      name: s.name,
      state: s.state,
      version: s.version,
      join_policy: s.join_policy,
      discoverable: s.discoverable,
      default_claim_policy: s.default_claim_policy,
      manager_review_allowed: s.manager_review_allowed,
      default_review_required: s.default_review_required,
      listed_principals: roles.includes('administrator') ? s.listed_principals : null,
      my_roles: roles,
    };
  });
}

export type MemberListing = {
  actor_id: string;
  display_name: string;
  roles: string[];
  joined_at: string;
};

export async function listMembers(
  ctx: ReadContext,
  input: unknown,
): Promise<{ items: MemberListing[] }> {
  const raw = requireObject(input, ['session_id']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  return withReadTx(ctx, async (db) => {
    await assertMember(db, ctx, sessionId);
    const { rows } = await db.query<{
      actor_id: Uuid;
      display_name: string;
      roles: string[];
      joined_at: Date;
    }>(
      `SELECT m.actor_id, a.display_name, m.roles, m.joined_at
         FROM session_members m JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
        WHERE m.workspace_id = $1 AND m.session_id = $2 AND m.removed_at IS NULL
        ORDER BY m.joined_at, m.actor_id`,
      [ctx.workspaceId, sessionId],
    );
    return {
      items: rows.map((r) => ({
        actor_id: r.actor_id,
        display_name: r.display_name,
        roles: r.roles,
        joined_at: iso(r.joined_at) ?? '',
      })),
    };
  });
}

export async function listBoards(
  ctx: ReadContext,
  input: unknown,
): Promise<{ items: { id: string; name: string; session_id: string; created_at: string }[] }> {
  const raw = requireObject(input, ['session_id']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  return withReadTx(ctx, async (db) => {
    await assertMember(db, ctx, sessionId);
    const { rows } = await db.query<{ id: Uuid; name: string; created_at: Date }>(
      `SELECT id, name, created_at FROM projects
        WHERE workspace_id = $1 AND session_id = $2 ORDER BY id`,
      [ctx.workspaceId, sessionId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        session_id: sessionId,
        created_at: iso(r.created_at) ?? '',
      })),
    };
  });
}
