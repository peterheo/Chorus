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
  loadLatestRevision,
  loadReviewSummaries,
  loadTaskDetails,
  requireRole,
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
    'task_id',
    'expected_version',
    'revision',
    'reviewer_actor_id',
  ]);
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);
  const revision = requireInteger(raw['revision'], 'revision', 1);
  const reviewerId = requireUuid(raw['reviewer_actor_id'], 'reviewer_actor_id');

  return runCommand(ctx, {
    type: 'review.request',
    input: { task_id: taskId, revision, reviewer_actor_id: reviewerId },
    targets: [{ id: taskId, expectedVersion, kind: 'task' }],
    authorize: async (tx) => {
      const task = lockedItem(tx, taskId);
      const roles = await requireRole(tx, task.homeRoomId, ['executor', 'manager']);
      if (task.ownerActorId !== tx.actorId && !roles.includes('manager')) {
        throw new ChorusError(
          'action_forbidden',
          'Only the owner or a manager can request a review.',
          {
            details: { reason: 'not_owner' },
          },
        );
      }
      // Q3 default: the submitter check precedes reviewer eligibility.
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
      const grant = await tx.db.query(
        `SELECT 1 FROM room_grants
          WHERE workspace_id = $1 AND actor_id = $2 AND room_id = $3
            AND role = 'reviewer' AND revoked_at IS NULL`,
        [tx.workspaceId, reviewerId, task.homeRoomId],
      );
      if (grant.rowCount === 0) {
        throw new ChorusError(
          'invalid_request',
          'The reviewer does not hold the reviewer role in this room.',
          {
            details: { field: 'reviewer_actor_id', reason: 'reviewer_not_eligible' },
          },
        );
      }
    },
    handle: async (tx) => {
      const task = lockedItem(tx, taskId);
      assertTaskTransition('request_review', task.state);
      const latest = await loadLatestRevision(tx.db, tx.workspaceId, taskId);
      if (latest === null) {
        throw new ChorusError('internal_error', 'A task in review has no result revision.');
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
           (workspace_id, kind, home_room_id, title, state, creator_actor_id, owner_actor_id)
         VALUES ($1, 'review', $2, $3, 'requested', $4, $5)
         RETURNING id`,
        [tx.workspaceId, task.homeRoomId, title, tx.actorId, reviewerId],
      );
      const reviewId = inserted.rows[0]?.id;
      if (reviewId === undefined) {
        throw new ChorusError('internal_error', 'Review insert returned no row.');
      }
      await tx.db.query(
        `INSERT INTO review_details
           (workspace_id, review_item_id, subject_task_id, result_revision, content_sha256, criteria)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          tx.workspaceId,
          reviewId,
          taskId,
          revision,
          latest.contentSha256,
          JSON.stringify(details.criteria),
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

/** Q5 default: `Review: <task title> (revision N)`, cut to 200 code points; the work_items title is NOT NULL. */
async function reviewTitle(tx: CommandTx, taskId: Uuid, revision: number): Promise<string> {
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

export type VerdictResponse = { review: ReviewSummary };

export async function reviewVerdict(ctx: CommandContext, input: unknown): Promise<VerdictResponse> {
  const raw = requireObject(input, [
    'review_id',
    'expected_version',
    'verdict',
    'content_sha256',
    'notes',
  ]);
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
        WHERE d.workspace_id = $1 AND d.review_item_id = $2 AND w.kind = 'review'`,
      [ctx.workspaceId, reviewId],
    );
    return rows[0]?.subject_task_id;
  });
  if (subject === undefined) throw new ChorusError('not_found', 'Not found.');
  const taskId = subject;

  return runCommand(ctx, {
    type: 'review.verdict',
    input: { review_id: reviewId, verdict, content_sha256: digest, notes },
    targets: [
      { id: reviewId, expectedVersion, kind: 'review' },
      // Locked with the review so verdicts serialize with completion, but never version-bumped here.
      { id: taskId, lockOnly: true, kind: 'task' },
    ],
    authorize: async (tx) => {
      const review = lockedItem(tx, reviewId);
      await requireRole(tx, review.homeRoomId, ['reviewer']);
      if (review.ownerActorId !== tx.actorId) {
        throw new ChorusError(
          'action_forbidden',
          'Only the assigned reviewer can record a verdict.',
          {
            details: { reason: 'not_assigned_reviewer' },
          },
        );
      }
    },
    handle: async (tx) => {
      const review = lockedItem(tx, reviewId);
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
      // Review gates (precedence 11): stale first, then the digest.
      const latest = await loadLatestRevision(tx.db, tx.workspaceId, taskId);
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
        `UPDATE review_details SET verdict = $3, verdict_at = now(), verdict_notes = $4
          WHERE workspace_id = $1 AND review_item_id = $2`,
        [tx.workspaceId, reviewId, verdict, notes === '' ? null : notes],
      );
      const version = await tx.bumpVersion(reviewId);
      const [summary] = await loadReviewSummaries(tx.db, tx.workspaceId, [reviewId]);
      if (summary === undefined) throw new ChorusError('internal_error', 'Review not readable.');
      return {
        result: { review: summary },
        events: [
          {
            roomId: review.homeRoomId,
            aggregateId: reviewId,
            aggregateVersion: version,
            eventType: 'review.verdict_recorded',
            payload: { task_id: taskId, revision: stored.result_revision, verdict },
          },
        ],
      };
    },
  });
}

function lockedItem(tx: CommandTx, id: Uuid) {
  const item = tx.items.get(id);
  if (item === undefined) throw new ChorusError('internal_error', 'Target was not locked.');
  return item;
}
