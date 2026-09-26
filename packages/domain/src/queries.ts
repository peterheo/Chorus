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

export type ListWorkResponse = { items: TaskSummary[]; next_cursor: string | null };

export async function listWork(ctx: ReadContext, input: unknown): Promise<ListWorkResponse> {
  const raw = requireObject(input, ['room_id', 'states', 'owner', 'limit', 'cursor']);
  const roomId = raw['room_id'] === undefined ? null : requireUuid(raw['room_id'], 'room_id');
  const states =
    raw['states'] === undefined
      ? null
      : requireArray(raw['states'], 'states', 1, TASK_STATES.length).map((s) =>
          requireEnum<TaskState>(s, 'states', TASK_STATES),
        );
  const owner =
    raw['owner'] === undefined ? 'any' : requireEnum(raw['owner'], 'owner', ['me', 'any']);
  const limit = limitOrDefault(raw['limit']);
  const cursor = decodeCursor(raw['cursor']) ?? null;

  return withReadTx(ctx, async (db) => {
    const { rows } = await db.query<{
      id: Uuid;
      home_room_id: Uuid;
      title: string;
      state: string;
      version: number;
      owner_actor_id: Uuid | null;
      review_required: boolean;
      shareable: boolean;
      criteria_count: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT w.id, w.home_room_id, w.title, w.state, w.version, w.owner_actor_id,
              d.review_required, d.shareable, jsonb_array_length(d.acceptance_criteria) AS criteria_count,
              w.created_at, w.updated_at
         FROM work_items w
         JOIN task_details d ON d.workspace_id = w.workspace_id AND d.item_id = w.id
        WHERE w.workspace_id = $1 AND w.kind = 'task'
          AND ($2::uuid IS NULL OR w.home_room_id = $2)
          AND ($3::text[] IS NULL OR w.state = ANY($3))
          AND ($4::uuid IS NULL OR w.owner_actor_id = $4)
          AND ($5::uuid IS NULL OR w.id < $5)
        ORDER BY w.id DESC
        LIMIT $6`,
      [ctx.workspaceId, roomId, states, owner === 'me' ? ctx.actorId : null, cursor, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        room_id: r.home_room_id,
        title: r.title,
        state: r.state,
        version: r.version,
        owner_actor_id: r.owner_actor_id,
        review_required: r.review_required,
        shareable: r.shareable,
        criteria_count: r.criteria_count,
        created_at: iso(r.created_at) ?? '',
        updated_at: iso(r.updated_at) ?? '',
      })),
      next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]?.id ?? '') : null,
    };
  });
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
  const raw = requireObject(input, ['task_id']);
  const taskId = requireUuid(raw['task_id'], 'task_id');

  return withReadTx(ctx, async (db) => {
    const { rows } = await db.query<{
      id: Uuid;
      home_room_id: Uuid;
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
      `SELECT w.id, w.home_room_id, w.title, w.body, w.state, w.version, w.creator_actor_id,
              w.owner_actor_id, d.acceptance_criteria, d.review_required, d.shareable,
              w.created_at, w.updated_at
         FROM work_items w
         JOIN task_details d ON d.workspace_id = w.workspace_id AND d.item_id = w.id
        WHERE w.workspace_id = $1 AND w.id = $2 AND w.kind = 'task'`,
      [ctx.workspaceId, taskId],
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
  const raw = requireObject(input, ['task_id', 'revision']);
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const revision = requireInteger(raw['revision'], 'revision', 1);

  return withReadTx(ctx, async (db) => {
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
         FROM task_result_revisions WHERE workspace_id = $1 AND task_id = $2 AND revision = $3`,
      [ctx.workspaceId, taskId, revision],
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
  const raw = requireObject(input, ['states', 'limit', 'cursor']);
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
      `SELECT w.id, w.version, d.subject_task_id AS task_id, w.home_room_id AS room_id,
              t.title AS task_title, d.result_revision AS revision, d.content_sha256, w.state,
              d.result_revision < COALESCE(
                (SELECT max(r.revision) FROM task_result_revisions r
                  WHERE r.workspace_id = d.workspace_id AND r.task_id = d.subject_task_id), 0) AS stale,
              w.created_at
         FROM work_items w
         JOIN review_details d ON d.workspace_id = w.workspace_id AND d.review_item_id = w.id
         JOIN work_items t ON t.workspace_id = d.workspace_id AND t.id = d.subject_task_id
        WHERE w.workspace_id = $1 AND w.kind = 'review' AND w.owner_actor_id = $2
          AND w.state = ANY($3::text[])
          AND ($4::uuid IS NULL OR w.id < $4)
        ORDER BY w.id DESC
        LIMIT $5`,
      [ctx.workspaceId, ctx.actorId, states, cursor, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
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
