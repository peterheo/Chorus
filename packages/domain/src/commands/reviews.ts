import { requireAction } from '../authz.ts';
import { runCommand, withReadTx, type CommandContext, type CommandTx } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import { assertReviewAcceptsVerdict, assertTaskTransition } from '../transitions.ts';
import {
  codePoints,
  requireEnum,
  requireInteger,
  requireObject,
  requireSha256,
  requireString,
  requireUuid,
} from '../validation.ts';
import {
  evaluateCompletionGates,
  loadLatestRevision,
  loadReviewSummaries,
  loadTaskDetails,
  lockedItem,
  requireSession,
  type ReviewSummary,
} from './support.ts';

const VERDICTS = ['approved', 'changes_requested'] as const;

// --------------------------------------------------------------------------------------------------
// request_review
// --------------------------------------------------------------------------------------------------

export type RequestReviewResponse = {
  task_id: string;
  task_version: number;
  review: ReviewSummary;
};

export async function requestReview(
  ctx: CommandContext,
  input: unknown,
): Promise<RequestReviewResponse> {
  const raw = requireObject(input, [
    'session_id',
    'task_id',
    'expected_version',
    'revision',
    'reviewer_actor_id',
  ]);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);
  const revision = requireInteger(raw['revision'], 'revision', 1);
  const reviewerId = requireUuid(raw['reviewer_actor_id'], 'reviewer_actor_id');

  return runCommand(ctx, {
    type: 'review.request',
    session: { id: sessionId },
    input: { task_id: taskId, revision, reviewer_actor_id: reviewerId },
    targets: [{ id: taskId, expectedVersion, kind: 'task' }],
    // A replay re-authorizes only the caller; the reviewer separation below is a fresh-call check.
    replayAuthorize: (tx) => {
      assertMayRequestReview(tx, taskId);
      return Promise.resolve();
    },
    authorize: async (tx) => {
      // The owner (or a manager) asks for the review, and the identity rules (precedence 6) run here, before
      // the version and lifecycle checks: the reviewer is never the submitter or the owner.
      assertMayRequestReview(tx, taskId);
      const task = lockedItem(tx, taskId);
      const latest = await loadLatestRevision(tx.db, tx.workspaceId, taskId);
      if (latest !== null && latest.submittedBy === reviewerId) {
        throw new ChorusError(
          'action_forbidden',
          'A reviewer cannot review their own submission.',
          {
            details: { reason: 'reviewer_is_submitter' },
          },
        );
      }
      if (task.ownerActorId === reviewerId) {
        throw new ChorusError('action_forbidden', "A task's owner cannot review it.", {
          details: { reason: 'reviewer_is_owner' },
        });
      }
    },
    handle: async (tx) => {
      const task = lockedItem(tx, taskId);
      const session = requireSession(tx);
      assertTaskTransition('request_review', task.state);
      const latest = await loadLatestRevision(tx.db, tx.workspaceId, taskId);
      if (latest === null) {
        throw new ChorusError('internal_error', 'A task in review has no result revision.');
      }
      // The reviewer must be a LIVE member of this session (the same definition as chorus_my_sessions());
      // a manager reviews only if the session allows it. The submitter/owner separation ran in authorize.
      const reviewer = await tx.db.query<{ roles: string[] }>(
        'SELECT roles FROM chorus_session_live_members($1) WHERE actor_id = $2',
        [sessionId, reviewerId],
      );
      const reviewerRoles = reviewer.rows[0]?.roles;
      if (reviewerRoles === undefined) {
        throw new ChorusError('invalid_request', 'The reviewer is not a member of this session.', {
          details: { field: 'reviewer_actor_id', reason: 'reviewer_not_eligible' },
        });
      }
      if (reviewerRoles.includes('manager') && !session.managerReviewAllowed) {
        throw new ChorusError(
          'invalid_request',
          'This session does not allow managers to review.',
          { details: { field: 'reviewer_actor_id', reason: 'reviewer_not_eligible' } },
        );
      }
      // Review gates (precedence 11): stale, then duplicate.
      if (revision !== latest.revision) {
        throw new ChorusError('review_stale', 'Only the latest result revision can be reviewed.', {
          details: { latest_revision: latest.revision },
        });
      }
      if (latest.reviewId !== null) {
        throw new ChorusError('review_exists', 'This revision already has a review.', {
          details: { review_id: latest.reviewId },
        });
      }

      const details = await loadTaskDetails(tx.db, tx.workspaceId, taskId);
      const title = await reviewTitle(tx, taskId, revision);
      const inserted = await tx.db.query<{ id: Uuid }>(
        `INSERT INTO work_items
           (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id,
            owner_actor_id)
         VALUES ($1, $2, $3, 'review', $4, $5, 'requested', $6, $7)
         RETURNING id`,
        [tx.workspaceId, sessionId, task.boardId, task.homeRoomId, title, tx.actorId, reviewerId],
      );
      const reviewId = inserted.rows[0]?.id;
      if (reviewId === undefined) {
        throw new ChorusError('internal_error', 'Review insert returned no row.');
      }
      // The review snapshots the criteria the revision was written under.
      const criteria = await tx.db.query<{ acceptance_criteria: string[] }>(
        `SELECT acceptance_criteria FROM task_criteria_revisions
          WHERE workspace_id = $1 AND task_id = $2 AND criteria_revision = $3`,
        [tx.workspaceId, taskId, latest.criteriaRevision],
      );
      await tx.db.query(
        `INSERT INTO review_details
           (workspace_id, session_id, review_item_id, subject_task_id, result_revision, content_sha256,
            criteria)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          tx.workspaceId,
          sessionId,
          reviewId,
          taskId,
          revision,
          latest.contentSha256,
          JSON.stringify(criteria.rows[0]?.acceptance_criteria ?? details.criteria),
        ],
      );
      const taskVersion = await tx.bumpVersion(taskId);
      const [review] = await loadReviewSummaries(tx.db, tx.workspaceId, [reviewId]);
      if (review === undefined) throw new ChorusError('internal_error', 'Review not readable.');
      return {
        result: { task_id: taskId, task_version: taskVersion, review },
        events: [
          {
            roomId: task.homeRoomId,
            aggregateId: taskId,
            aggregateVersion: taskVersion,
            eventType: 'task.review_requested',
            payload: { review_id: reviewId, revision, reviewer_actor_id: reviewerId },
          },
          {
            roomId: task.homeRoomId,
            aggregateId: reviewId,
            aggregateVersion: 1,
            eventType: 'review.requested',
            payload: {
              task_id: taskId,
              revision,
              content_sha256: latest.contentSha256,
              reviewer_actor_id: reviewerId,
            },
          },
        ],
      };
    },
  });
}

function assertMayRequestReview(tx: CommandTx, taskId: Uuid): void {
  requireAction(tx, 'request_review');
  const task = lockedItem(tx, taskId);
  if (task.ownerActorId !== tx.actorId && !tx.roles.includes('manager')) {
    throw new ChorusError('action_forbidden', 'Only the owner or a manager can request a review.', {
      details: { reason: 'not_owner' },
    });
  }
}

/** `Review: <task title> (revision N)`, cut to 200 code points; the work_items title is NOT NULL. */
async function reviewTitle(
  tx: Parameters<Parameters<typeof runCommand>[1]['handle']>[0],
  taskId: Uuid,
  revision: number,
): Promise<string> {
  const { rows } = await tx.db.query<{ title: string }>(
    'SELECT title FROM work_items WHERE workspace_id = $1 AND id = $2',
    [tx.workspaceId, taskId],
  );
  const suffix = ` (revision ${String(revision)})`;
  const prefix = 'Review: ';
  const budget = 200 - codePoints(prefix) - codePoints(suffix);
  const taskTitle = Array.from(rows[0]?.title ?? '')
    .slice(0, budget)
    .join('');
  return `${prefix}${taskTitle}${suffix}`;
}

// --------------------------------------------------------------------------------------------------
// review_verdict
// --------------------------------------------------------------------------------------------------

export type VerdictResponse = {
  review: ReviewSummary;
  /** The task after the verdict: `done` when the approval completed it automatically. */
  task: { id: string; version: number; state: string };
};

export async function reviewVerdict(ctx: CommandContext, input: unknown): Promise<VerdictResponse> {
  const raw = requireObject(input, [
    'session_id',
    'review_id',
    'expected_version',
    'verdict',
    'content_sha256',
    'notes',
  ]);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const reviewId = requireUuid(raw['review_id'], 'review_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);
  const verdict = requireEnum(raw['verdict'], 'verdict', VERDICTS);
  const digest = requireSha256(raw['content_sha256'], 'content_sha256');
  const notes = requireString(raw['notes'] ?? '', 'notes', { maxCodePoints: 4000 });

  // Find the subject task under the caller's own visibility (RLS): an invisible review is not_found.
  // The handler re-reads it under lock and asserts it is unchanged.
  const subject = await withReadTx(ctx, async (db) => {
    const { rows } = await db.query<{ subject_task_id: Uuid }>(
      `SELECT d.subject_task_id FROM review_details d
         JOIN work_items w ON w.workspace_id = d.workspace_id AND w.id = d.review_item_id
        WHERE d.workspace_id = $1 AND d.session_id = $2 AND d.review_item_id = $3 AND w.kind = 'review'`,
      [ctx.workspaceId, sessionId, reviewId],
    );
    return rows[0]?.subject_task_id;
  });
  if (subject === undefined) throw new ChorusError('not_found', 'Not found.');
  const taskId = subject;

  return runCommand(ctx, {
    type: 'review.verdict',
    session: { id: sessionId },
    input: { review_id: reviewId, verdict, content_sha256: digest, notes },
    targets: [
      { id: reviewId, expectedVersion, kind: 'review' },
      // Locked with the review so verdicts serialize with completion. An approval may complete the task,
      // in which case the handler bumps its version; otherwise the task is untouched.
      { id: taskId, lockOnly: true, kind: 'task' },
    ],
    authorize: async (tx) => {
      requireAction(tx, 'review');
      const review = lockedItem(tx, reviewId);
      const task = lockedItem(tx, taskId);
      const session = requireSession(tx);
      // The assigned reviewer, or (only if the session allows it) a manager.
      const assigned = review.ownerActorId === tx.actorId;
      const eligibleManager = tx.roles.includes('manager') && session.managerReviewAllowed;
      if (!assigned && !eligibleManager) {
        throw new ChorusError(
          'action_forbidden',
          'Only the assigned reviewer can record a verdict.',
          {
            details: { reason: 'not_assigned_reviewer' },
          },
        );
      }
      // Eligibility is judged against the CURRENT roles and flags, at verdict time: a reviewer who was
      // assigned as a participant and has since become a manager needs `manager_review_allowed` too.
      if (tx.roles.includes('manager') && !session.managerReviewAllowed) {
        throw new ChorusError(
          'action_forbidden',
          'This session does not allow managers to review.',
          {
            details: { reason: 'reviewer_not_eligible' },
          },
        );
      }
      // Separation (precedence 6, before version and lifecycle): never the submitter or the owner.
      const latest = await loadLatestRevision(tx.db, tx.workspaceId, taskId);
      if (latest !== null && latest.submittedBy === tx.actorId) {
        throw new ChorusError('action_forbidden', 'The submitter cannot review their own result.', {
          details: { reason: 'reviewer_is_submitter' },
        });
      }
      if (task.ownerActorId === tx.actorId) {
        throw new ChorusError('action_forbidden', "A task's owner cannot review it.", {
          details: { reason: 'reviewer_is_owner' },
        });
      }
    },
    handle: async (tx) => {
      const review = lockedItem(tx, reviewId);
      const task = lockedItem(tx, taskId);
      const details = await tx.db.query<{
        subject_task_id: Uuid;
        result_revision: number;
        content_sha256: string;
      }>(
        `SELECT subject_task_id, result_revision, content_sha256 FROM review_details
          WHERE workspace_id = $1 AND review_item_id = $2`,
        [tx.workspaceId, reviewId],
      );
      const stored = details.rows[0];
      if (stored?.subject_task_id !== taskId) {
        throw new ChorusError(
          'internal_error',
          'The review subject changed while the command ran.',
        );
      }

      assertReviewAcceptsVerdict(review.state);
      const latest = await loadLatestRevision(tx.db, tx.workspaceId, taskId);
      // Review gates (precedence 11): stale first, then the digest.
      if (latest === null || stored.result_revision < latest.revision) {
        throw new ChorusError('review_stale', 'The reviewed revision has been superseded.', {
          details: {
            reviewed_revision: stored.result_revision,
            latest_revision: latest?.revision ?? null,
          },
        });
      }
      if (stored.content_sha256 !== digest) {
        throw new ChorusError(
          'subject_digest_mismatch',
          'The digest does not match the reviewed revision.',
        );
      }

      await tx.db.query(`UPDATE work_items SET state = $3 WHERE workspace_id = $1 AND id = $2`, [
        tx.workspaceId,
        reviewId,
        verdict,
      ]);
      await tx.db.query(
        `UPDATE review_details SET verdict = $3, verdict_at = now(), verdict_notes = $4,
                verdict_reviewer_roles = $5::text[], verdict_manager_review_allowed = $6
          WHERE workspace_id = $1 AND review_item_id = $2`,
        [
          tx.workspaceId,
          reviewId,
          verdict,
          notes === '' ? null : notes,
          tx.roles,
          requireSession(tx).managerReviewAllowed,
        ],
      );
      const version = await tx.bumpVersion(reviewId);
      const [summary] = await loadReviewSummaries(tx.db, tx.workspaceId, [reviewId]);
      if (summary === undefined) throw new ChorusError('internal_error', 'Review not readable.');

      const events: import('../command.ts').DomainEventDraft[] = [
        {
          roomId: review.homeRoomId,
          aggregateId: reviewId,
          aggregateVersion: version,
          eventType: 'review.verdict_recorded',
          payload: { task_id: taskId, revision: stored.result_revision, verdict },
        },
      ];

      // Automatic completion: an approval of the latest revision completes the task in this transaction
      // when every gate passes. If a gate fails the approval still stands and the task stays in review.
      let taskVersion = task.version;
      let taskState = task.state;
      if (verdict === 'approved') {
        const gates = await evaluateCompletionGates(tx, { ...task });
        // The gate check reads the review row we just updated (approved) through the same transaction.
        if (gates.ok) {
          await tx.db.query(
            `UPDATE work_items SET state = 'done' WHERE workspace_id = $1 AND id = $2`,
            [tx.workspaceId, taskId],
          );
          await tx.db.query(
            `UPDATE task_leases SET instance_id = NULL WHERE workspace_id = $1 AND task_id = $2`,
            [tx.workspaceId, taskId],
          );
          taskVersion = await tx.bumpVersion(taskId);
          taskState = 'done';
          events.push({
            roomId: task.homeRoomId,
            aggregateId: taskId,
            aggregateVersion: taskVersion,
            eventType: 'task.completed',
            payload: {
              revision: gates.revision,
              review_id: gates.reviewId,
              trigger: 'review_approved',
            },
          });
        }
      }
      return {
        result: { review: summary, task: { id: taskId, version: taskVersion, state: taskState } },
        events,
      };
    },
  });
}
