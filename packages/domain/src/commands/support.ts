import type { Queryable } from '../authz.ts';
import type { CommandTx, LockedWorkItem } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';

export const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export function requireInstance(tx: CommandTx): Uuid {
  if (tx.instanceId === null) {
    throw new ChorusError('action_forbidden', 'This action requires an agent instance.', {
      details: { reason: 'instance_required' },
    });
  }
  return tx.instanceId;
}

export function requireSession(tx: CommandTx) {
  if (tx.session === undefined) {
    throw new ChorusError('internal_error', 'A session-scoped command ran without a session.');
  }
  return tx.session;
}

export function lockedItem(tx: CommandTx, id: Uuid): LockedWorkItem {
  const item = tx.items.get(id);
  if (item === undefined) throw new ChorusError('internal_error', 'Target was not locked.');
  return item;
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
  readonly criteriaRevision: number;
  readonly reviewRequired: boolean;
  readonly shareable: boolean;
  readonly claimPolicy: string;
}

export async function loadTaskDetails(
  db: Queryable,
  workspaceId: Uuid,
  taskId: Uuid,
): Promise<TaskDetails> {
  const { rows } = await db.query<{
    acceptance_criteria: string[];
    criteria_revision: number;
    review_required: boolean;
    shareable: boolean;
    claim_policy: string;
  }>(
    `SELECT acceptance_criteria, criteria_revision, review_required, shareable, claim_policy
       FROM task_details WHERE workspace_id = $1 AND item_id = $2`,
    [workspaceId, taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new ChorusError('internal_error', 'Task has no details row.');
  return {
    criteria: row.acceptance_criteria,
    criteriaRevision: row.criteria_revision,
    reviewRequired: row.review_required,
    shareable: row.shareable,
    claimPolicy: row.claim_policy,
  };
}

export interface LatestRevision {
  readonly revision: number;
  readonly contentSha256: string;
  readonly submittedBy: Uuid;
  readonly criteriaRevision: number;
  readonly workCycle: number;
  /** The single NON-cancelled review of this revision, if any. */
  readonly reviewId: Uuid | null;
  readonly reviewState: string | null;
  readonly reviewerId: Uuid | null;
}

/** The task's newest result revision and the (single) live review of it, if any. */
export async function loadLatestRevision(
  db: Queryable,
  workspaceId: Uuid,
  taskId: Uuid,
): Promise<LatestRevision | null> {
  const { rows } = await db.query<{
    revision: number;
    content_sha256: string;
    submitted_by: Uuid;
    criteria_revision: number;
    work_cycle: number;
    review_id: Uuid | null;
    review_state: string | null;
    reviewer_id: Uuid | null;
  }>(
    `SELECT r.revision, r.content_sha256, r.submitted_by, r.criteria_revision, r.work_cycle,
            w.id AS review_id, w.state AS review_state, w.owner_actor_id AS reviewer_id
       FROM task_result_revisions r
       LEFT JOIN review_details d
         ON d.workspace_id = r.workspace_id AND d.subject_task_id = r.task_id
        AND d.result_revision = r.revision AND d.cancelled_at IS NULL
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
    criteriaRevision: row.criteria_revision,
    workCycle: row.work_cycle,
    reviewId: row.review_id,
    reviewState: row.review_state,
    reviewerId: row.reviewer_id,
  };
}

export type CompletionVerdict =
  | { readonly ok: true; readonly revision: number; readonly reviewId: string | null }
  | { readonly ok: false; readonly error: ChorusError };

/**
 * The completion gates (WP3 rev 4 section 5.7), shared by the manager's `complete` and by automatic
 * completion on approval: state `review`, not blocked, the latest revision is under the CURRENT criteria
 * revision and work cycle, and (if a review is required) that revision's live review is approved.
 */
export async function evaluateCompletionGates(
  tx: CommandTx,
  task: LockedWorkItem,
): Promise<CompletionVerdict> {
  const fail = (error: ChorusError): CompletionVerdict => ({ ok: false, error });
  if (task.state !== 'review') {
    return fail(
      new ChorusError('invalid_transition', `A task in state "${task.state}" cannot complete.`, {
        details: {
          reason: task.state === 'done' ? 'terminal' : 'invalid_state',
          state: task.state,
        },
      }),
    );
  }
  if (task.blockedAt !== null) {
    return fail(
      new ChorusError('invalid_transition', 'A blocked task cannot complete.', {
        details: { reason: 'blocked', state: task.state },
      }),
    );
  }
  const details = await loadTaskDetails(tx.db, tx.workspaceId, task.id);
  const latest = await loadLatestRevision(tx.db, tx.workspaceId, task.id);
  if (latest === null) {
    return fail(new ChorusError('internal_error', 'A task in review has no result revision.'));
  }
  if (latest.criteriaRevision !== details.criteriaRevision || latest.workCycle !== task.workCycle) {
    return fail(
      new ChorusError(
        'invalid_transition',
        'The latest result predates the current criteria or work cycle.',
        {
          details: { reason: 'stale_revision', state: task.state, revision: latest.revision },
        },
      ),
    );
  }
  if (details.reviewRequired && latest.reviewState !== 'approved') {
    return fail(
      new ChorusError(
        'review_required',
        'The latest result revision needs an approved review before the task can be completed.',
        {
          details: {
            revision: latest.revision,
            review_state: latest.reviewState,
            review_id: latest.reviewId,
          },
        },
      ),
    );
  }
  if (details.reviewRequired && latest.reviewId !== null) {
    // The approval must have come from an ELIGIBLE reviewer AT VERDICT TIME. Both the roles held then and
    // the session's manager_review_allowed flag then were recorded on the review, and only those are
    // evaluated here: a later role change or policy flip can neither launder nor void an approval.
    const recorded = await tx.db.query<{
      verdict_reviewer_roles: string[] | null;
      verdict_manager_review_allowed: boolean | null;
    }>(
      `SELECT verdict_reviewer_roles, verdict_manager_review_allowed
         FROM review_details WHERE workspace_id = $1 AND review_item_id = $2`,
      [tx.workspaceId, latest.reviewId],
    );
    const roles = recorded.rows[0]?.verdict_reviewer_roles ?? null;
    const allowed = recorded.rows[0]?.verdict_manager_review_allowed ?? null;
    if (roles?.includes('manager') === true && allowed !== true) {
      return fail(
        new ChorusError(
          'review_required',
          'The approval came from a manager when this session did not allow manager reviews.',
          {
            details: {
              revision: latest.revision,
              review_id: latest.reviewId,
              reason: 'reviewer_not_eligible',
            },
          },
        ),
      );
    }
  }
  return {
    ok: true,
    revision: latest.revision,
    reviewId: details.reviewRequired ? latest.reviewId : null,
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
