import type { Queryable, RoomRole } from '../authz.ts';
import { requireRoomRole } from '../authz.ts';
import type { CommandTx } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';

export const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** Role check in the actor's current grants for a room: not_found if invisible, action_forbidden if not permitted. */
export function requireRole(tx: CommandTx, roomId: Uuid, allowed: readonly RoomRole[]) {
  return requireRoomRole(tx.db, {
    workspaceId: tx.workspaceId,
    actorId: tx.actorId,
    roomId,
    allowed,
  });
}

export function requireInstance(tx: CommandTx): Uuid {
  if (tx.instanceId === null) {
    throw new ChorusError('action_forbidden', 'This action requires an agent instance.', {
      details: { reason: 'instance_required' },
    });
  }
  return tx.instanceId;
}

export interface LeaseRow {
  readonly fence: number;
  readonly instanceId: Uuid | null;
  readonly expiresAt: Date | null;
  /** Live lease: held by an instance and unexpired, judged by database time. */
  readonly live: boolean;
}

/** Locks the task's single lease row. Always taken after the task row (spec section 5). */
export async function lockLease(db: Queryable, workspaceId: Uuid, taskId: Uuid): Promise<LeaseRow> {
  const { rows } = await db.query<{
    fence: string;
    instance_id: Uuid | null;
    expires_at: Date | null;
    live: boolean;
  }>(
    `SELECT fence, instance_id, expires_at,
            COALESCE(instance_id IS NOT NULL AND expires_at > now(), false) AS live
       FROM task_leases WHERE workspace_id = $1 AND task_id = $2 FOR UPDATE`,
    [workspaceId, taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new ChorusError('internal_error', 'Task has no lease row.');
  return {
    fence: Number(row.fence),
    instanceId: row.instance_id,
    expiresAt: row.expires_at,
    live: row.live,
  };
}

export interface TaskDetails {
  readonly criteria: readonly string[];
  readonly reviewRequired: boolean;
  readonly shareable: boolean;
}

export async function loadTaskDetails(
  db: Queryable,
  workspaceId: Uuid,
  taskId: Uuid,
): Promise<TaskDetails> {
  const { rows } = await db.query<{
    acceptance_criteria: string[];
    review_required: boolean;
    shareable: boolean;
  }>(
    `SELECT acceptance_criteria, review_required, shareable
       FROM task_details WHERE workspace_id = $1 AND item_id = $2`,
    [workspaceId, taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new ChorusError('internal_error', 'Task has no details row.');
  return {
    criteria: row.acceptance_criteria,
    reviewRequired: row.review_required,
    shareable: row.shareable,
  };
}

export interface LatestRevision {
  readonly revision: number;
  readonly contentSha256: string;
  readonly submittedBy: Uuid;
  readonly reviewId: Uuid | null;
  readonly reviewState: string | null;
}

/** The task's newest result revision and the (single) review of it, if any. */
export async function loadLatestRevision(
  db: Queryable,
  workspaceId: Uuid,
  taskId: Uuid,
): Promise<LatestRevision | null> {
  const { rows } = await db.query<{
    revision: number;
    content_sha256: string;
    submitted_by: Uuid;
    review_id: Uuid | null;
    review_state: string | null;
  }>(
    `SELECT r.revision, r.content_sha256, r.submitted_by,
            w.id AS review_id, w.state AS review_state
       FROM task_result_revisions r
       LEFT JOIN review_details d
         ON d.workspace_id = r.workspace_id AND d.subject_task_id = r.task_id
        AND d.result_revision = r.revision
       LEFT JOIN work_items w ON w.workspace_id = d.workspace_id AND w.id = d.review_item_id
      WHERE r.workspace_id = $1 AND r.task_id = $2
      ORDER BY r.revision DESC LIMIT 1`,
    [workspaceId, taskId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    revision: row.revision,
    contentSha256: row.content_sha256,
    submittedBy: row.submitted_by,
    reviewId: row.review_id,
    reviewState: row.review_state,
  };
}

export type ReviewSummary = {
  id: string;
  version: number;
  revision: number;
  reviewer_actor_id: string | null;
  state: string;
  verdict: string | null;
  verdict_at: string | null;
  stale: boolean;
};

export async function loadReviewSummaries(
  db: Queryable,
  workspaceId: Uuid,
  reviewIds: readonly Uuid[],
): Promise<ReviewSummary[]> {
  const { rows } = await db.query<{
    id: Uuid;
    version: number;
    revision: number;
    reviewer_actor_id: Uuid | null;
    state: string;
    verdict: string | null;
    verdict_at: Date | null;
    stale: boolean;
  }>(
    `SELECT w.id, w.version, d.result_revision AS revision, w.owner_actor_id AS reviewer_actor_id,
            w.state, d.verdict, d.verdict_at,
            d.result_revision < COALESCE(
              (SELECT max(r.revision) FROM task_result_revisions r
                WHERE r.workspace_id = d.workspace_id AND r.task_id = d.subject_task_id), 0) AS stale
       FROM work_items w
       JOIN review_details d ON d.workspace_id = w.workspace_id AND d.review_item_id = w.id
      WHERE w.workspace_id = $1 AND w.id = ANY($2::uuid[])
      ORDER BY d.result_revision, w.id`,
    [workspaceId, [...reviewIds]],
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    revision: r.revision,
    reviewer_actor_id: r.reviewer_actor_id,
    state: r.state,
    verdict: r.verdict,
    verdict_at: iso(r.verdict_at),
    stale: r.stale,
  }));
}
