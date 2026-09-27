import { createHash } from 'node:crypto';
import { runCommand, type CommandContext } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import { assertTaskTransition } from '../transitions.ts';
import {
  invalid,
  optionalBoolean,
  requireArray,
  requireEnum,
  requireInteger,
  requireNonBlank,
  requireObject,
  requireString,
  requireTitle,
  requireUuid,
} from '../validation.ts';
import { requireAction } from '../authz.ts';
import {
  evaluateCompletionGates,
  iso,
  loadLatestRevision,
  loadTaskDetails,
  lockLease,
  lockedItem,
  requireInstance,
  requireSession,
} from './support.ts';

const CONTENT_TYPES = ['text/plain', 'text/markdown', 'application/json'] as const;

export type TaskSummary = {
  id: string;
  session_id: string;
  board_id: string;
  priority: number;
  room_id: string;
  title: string;
  state: string;
  version: number;
  owner_actor_id: string | null;
  review_required: boolean;
  shareable: boolean;
  criteria_count: number;
  created_at: string;
  updated_at: string;
};

export type LeaseResponse = {
  task_id: string;
  version: number;
  state: string;
  fence: number;
  expires_at: string;
};

// --------------------------------------------------------------------------------------------------
// create_task
// --------------------------------------------------------------------------------------------------

export async function createTask(
  ctx: CommandContext,
  input: unknown,
): Promise<{ task: TaskSummary }> {
  const raw = requireObject(input, [
    'session_id',
    'board_id',
    'title',
    'body',
    'acceptance_criteria',
    'priority',
    'review_required',
    'shareable',
  ]);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const boardId = requireUuid(raw['board_id'], 'board_id');
  const title = requireTitle(raw['title']);
  const body = requireString(raw['body'] ?? '', 'body', { maxBytes: 16384 });
  const criteria = requireArray(raw['acceptance_criteria'], 'acceptance_criteria', 1, 20).map(
    (c, i) => requireNonBlank(c, `acceptance_criteria[${String(i)}]`, 500),
  );
  const priority =
    raw['priority'] === undefined ? 2 : requireInteger(raw['priority'], 'priority', 0, 4);
  const requestedReview =
    raw['review_required'] === undefined
      ? undefined
      : optionalBoolean(raw['review_required'], 'review_required', true);
  const shareable = optionalBoolean(raw['shareable'], 'shareable', false);

  return runCommand(ctx, {
    type: 'task.create',
    session: { id: sessionId },
    input: {
      session_id: sessionId,
      board_id: boardId,
      title,
      body,
      acceptance_criteria: criteria,
      priority,
      review_required: requestedReview ?? null,
      shareable,
    },
    authorize: (tx) => {
      requireAction(tx, 'create_item');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const session = requireSession(tx);
      const reviewRequired = requestedReview ?? session.defaultReviewRequired;
      const board = await tx.db.query(
        'SELECT 1 FROM projects WHERE workspace_id = $1 AND id = $2 AND session_id = $3',
        [tx.workspaceId, boardId, sessionId],
      );
      if (board.rowCount === 0) throw new ChorusError('not_found', 'Not found.');

      const { rows } = await tx.db.query<{ id: Uuid; created_at: Date; updated_at: Date }>(
        `INSERT INTO work_items
           (workspace_id, session_id, board_id, kind, home_room_id, title, body, state, priority,
            creator_actor_id)
         VALUES ($1, $2, $3, 'task', $4, $5, $6, 'ready', $7, $8)
         RETURNING id, created_at, updated_at`,
        [tx.workspaceId, sessionId, boardId, session.roomId, title, body, priority, tx.actorId],
      );
      const row = rows[0];
      if (row === undefined)
        throw new ChorusError('internal_error', 'Task insert returned no row.');
      await tx.db.query(
        `INSERT INTO task_details
           (workspace_id, session_id, item_id, acceptance_criteria, criteria_revision, review_required,
            shareable, claim_policy)
         VALUES ($1, $2, $3, $4::jsonb, 1, $5, $6, $7)`,
        [
          tx.workspaceId,
          sessionId,
          row.id,
          JSON.stringify(criteria),
          reviewRequired,
          shareable,
          session.defaultClaimPolicy,
        ],
      );
      await tx.db.query(
        `INSERT INTO task_criteria_revisions
           (workspace_id, session_id, task_id, criteria_revision, acceptance_criteria, created_by)
         VALUES ($1, $2, $3, 1, $4::jsonb, $5)`,
        [tx.workspaceId, sessionId, row.id, JSON.stringify(criteria), tx.actorId],
      );
      await tx.db.query(
        `INSERT INTO task_leases (workspace_id, session_id, task_id, fence) VALUES ($1, $2, $3, 0)`,
        [tx.workspaceId, sessionId, row.id],
      );
      return {
        result: {
          task: {
            id: row.id,
            session_id: sessionId,
            board_id: boardId,
            room_id: session.roomId,
            title,
            state: 'ready',
            version: 1,
            owner_actor_id: null,
            review_required: reviewRequired,
            shareable,
            criteria_count: criteria.length,
            priority,
            created_at: iso(row.created_at) ?? '',
            updated_at: iso(row.updated_at) ?? '',
          },
        },
        events: [
          {
            roomId: session.roomId,
            aggregateId: row.id,
            aggregateVersion: 1,
            eventType: 'task.created',
            payload: {
              title,
              criteria_count: criteria.length,
              review_required: reviewRequired,
              shareable,
              board_id: boardId,
            },
          },
        ],
      };
    },
  });
}

// --------------------------------------------------------------------------------------------------
// claim
// --------------------------------------------------------------------------------------------------

export async function claim(ctx: CommandContext, input: unknown): Promise<LeaseResponse> {
  const raw = requireObject(input, ['session_id', 'task_id', 'expected_version']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);

  return runCommand(ctx, {
    type: 'task.claim',
    session: { id: sessionId },
    input: { task_id: taskId },
    gated: true,
    targets: [{ id: taskId, expectedVersion, kind: 'task' }],
    authorize: (tx) => {
      requireAction(tx, 'claim');
      requireInstance(tx);
      return Promise.resolve();
    },
    handle: async (tx) => {
      const task = lockedItem(tx, taskId);
      const instanceId = requireInstance(tx);

      // Lifecycle (precedence 7): source state, then a pending review on the latest revision.
      assertTaskTransition('claim', task.state);
      if (task.blockedAt !== null) {
        throw new ChorusError('invalid_transition', 'A blocked task cannot be claimed.', {
          details: { reason: 'blocked', state: task.state },
        });
      }
      if (task.state === 'review') {
        const latest = await loadLatestRevision(tx.db, tx.workspaceId, taskId);
        if (latest?.reviewState === 'requested') {
          throw new ChorusError(
            'invalid_transition',
            'The latest revision has a review pending; wait for its verdict before reclaiming.',
            {
              details: { reason: 'review_pending', state: task.state, review_id: latest.reviewId },
            },
          );
        }
      }
      // Ownership (8), then the lease (9).
      if (task.ownerActorId !== null && task.ownerActorId !== tx.actorId) {
        throw new ChorusError('owner_conflict', 'The task is owned by another actor.');
      }
      const lease = await lockLease(tx.db, tx.workspaceId, taskId);
      if (lease.live) {
        throw new ChorusError('lease_conflict', 'The task has a live lease.', {
          details: { expires_at: iso(lease.expiresAt) },
        });
      }

      const { rows } = await tx.db.query<{ fence: string; expires_at: Date }>(
        `UPDATE task_leases
            SET fence = fence + 1, instance_id = $3,
                expires_at = now() + make_interval(secs => $4::double precision)
          WHERE workspace_id = $1 AND task_id = $2
          RETURNING fence, expires_at`,
        [tx.workspaceId, taskId, instanceId, tx.leaseDurationSeconds],
      );
      const leased = rows[0];
      if (leased === undefined) throw new ChorusError('internal_error', 'Lease update failed.');
      await tx.db.query(
        `UPDATE work_items SET owner_actor_id = COALESCE(owner_actor_id, $3), state = 'in_progress'
          WHERE workspace_id = $1 AND id = $2`,
        [tx.workspaceId, taskId, tx.actorId],
      );
      const version = await tx.bumpVersion(taskId);
      const fence = Number(leased.fence);
      const expiresAt = iso(leased.expires_at) ?? '';
      return {
        result: { task_id: taskId, version, state: 'in_progress', fence, expires_at: expiresAt },
        events: [
          {
            roomId: task.homeRoomId,
            aggregateId: taskId,
            aggregateVersion: version,
            eventType: 'task.claimed',
            payload: {
              fence,
              expires_at: expiresAt,
              owner_actor_id: task.ownerActorId ?? tx.actorId,
              reacquired: task.state !== 'ready',
            },
          },
        ],
      };
    },
  });
}

// --------------------------------------------------------------------------------------------------
// renew_lease
// --------------------------------------------------------------------------------------------------

export async function renewLease(ctx: CommandContext, input: unknown): Promise<LeaseResponse> {
  const raw = requireObject(input, ['session_id', 'task_id', 'expected_version', 'fence']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);
  const fence = requireInteger(raw['fence'], 'fence', 1);

  return runCommand(ctx, {
    type: 'task.renew_lease',
    session: { id: sessionId },
    input: { task_id: taskId, fence },
    targets: [{ id: taskId, expectedVersion, kind: 'task' }],
    authorize: (tx) => {
      requireAction(tx, 'renew_lease');
      requireInstance(tx);
      return Promise.resolve();
    },
    handle: async (tx) => {
      const task = lockedItem(tx, taskId);
      assertTaskTransition('renew_lease', task.state);
      const lease = await lockLease(tx.db, tx.workspaceId, taskId);
      if (!lease.live || lease.instanceId !== tx.instanceId || lease.fence !== fence) {
        throw new ChorusError(
          'lease_lost',
          'The lease is expired, held by another instance, or fenced out.',
        );
      }
      const { rows } = await tx.db.query<{ expires_at: Date }>(
        `UPDATE task_leases SET expires_at = now() + make_interval(secs => $3::double precision)
          WHERE workspace_id = $1 AND task_id = $2 RETURNING expires_at`,
        [tx.workspaceId, taskId, tx.leaseDurationSeconds],
      );
      const expiresAt = iso(rows[0]?.expires_at ?? null) ?? '';
      const version = await tx.bumpVersion(taskId);
      return {
        result: { task_id: taskId, version, state: task.state, fence, expires_at: expiresAt },
        events: [
          {
            roomId: task.homeRoomId,
            aggregateId: taskId,
            aggregateVersion: version,
            eventType: 'task.lease_renewed',
            payload: { fence, expires_at: expiresAt },
          },
        ],
      };
    },
  });
}

// --------------------------------------------------------------------------------------------------
// submit_result
// --------------------------------------------------------------------------------------------------

export type SubmitResponse = {
  task_id: string;
  version: number;
  state: string;
  revision: number;
  content_sha256: string;
  byte_length: number;
};

type MappingEntry = {
  criterion: number;
  note: string;
};

type SupportingRef = {
  url: string;
  label: string;
};

export async function submitResult(ctx: CommandContext, input: unknown): Promise<SubmitResponse> {
  const raw = requireObject(input, [
    'session_id',
    'task_id',
    'expected_version',
    'fence',
    'content',
    'content_type',
    'criteria_mapping',
    'supporting_refs',
  ]);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);
  const fence = requireInteger(raw['fence'], 'fence', 1);
  const content = requireString(raw['content'], 'content', { minBytes: 1, maxBytes: 262144 });
  const contentType = requireEnum(raw['content_type'], 'content_type', CONTENT_TYPES);
  if (contentType === 'application/json') {
    try {
      JSON.parse(content);
    } catch {
      throw invalid('content', 'content must be valid JSON when content_type is application/json.');
    }
  }
  const mapping: MappingEntry[] = requireArray(
    raw['criteria_mapping'],
    'criteria_mapping',
    0,
    1000,
  ).map((entry, i) => {
    const field = `criteria_mapping[${String(i)}]`;
    const e = requireObject(entry, ['criterion', 'note']);
    return {
      criterion: requireInteger(e['criterion'], `${field}.criterion`, Number.MIN_SAFE_INTEGER),
      note: requireString(e['note'], `${field}.note`, { minCodePoints: 1, maxCodePoints: 2000 }),
    };
  });
  const refs: SupportingRef[] = requireArray(
    raw['supporting_refs'] ?? [],
    'supporting_refs',
    0,
    10,
  ).map((entry, i) => {
    const field = `supporting_refs[${String(i)}]`;
    const e = requireObject(entry, ['url', 'label']);
    const url = requireString(e['url'], `${field}.url`, { minCodePoints: 1, maxCodePoints: 2048 });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid(`${field}.url`, `${field}.url must be an absolute URL.`);
    }
    if (parsed.protocol !== 'https:') throw invalid(`${field}.url`, `${field}.url must use https.`);
    return {
      url,
      label: requireString(e['label'], `${field}.label`, { minCodePoints: 1, maxCodePoints: 200 }),
    };
  });

  // The digest and length are computed here from the exact bytes that will be stored; the database
  // CHECK constraints re-verify both.
  const bytes = Buffer.from(content, 'utf8');
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');
  const byteLength = bytes.length;

  return runCommand(ctx, {
    type: 'task.submit_result',
    session: { id: sessionId },
    input: {
      task_id: taskId,
      fence,
      content_sha256: contentSha256,
      content_type: contentType,
      criteria_mapping: mapping,
      supporting_refs: refs,
    },
    targets: [{ id: taskId, expectedVersion, kind: 'task' }],
    authorize: (tx) => {
      requireAction(tx, 'submit_result');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const task = lockedItem(tx, taskId);
      assertTaskTransition('submit_result', task.state);
      if (task.blockedAt !== null) {
        throw new ChorusError('invalid_transition', 'A blocked task cannot accept a result.', {
          details: { reason: 'blocked', state: task.state },
        });
      }
      if (task.ownerActorId !== tx.actorId) {
        throw new ChorusError('owner_conflict', 'Only the task owner can submit a result.');
      }
      const lease = await lockLease(tx.db, tx.workspaceId, taskId);
      if (!lease.live || lease.instanceId !== tx.instanceId || lease.fence !== fence) {
        throw new ChorusError(
          'lease_lost',
          'The lease is expired, held by another instance, or fenced out.',
        );
      }
      // Mapping coverage (precedence 10): exactly one entry per criterion index 0..n-1.
      const details = await loadTaskDetails(tx.db, tx.workspaceId, taskId);
      const n = details.criteria.length;
      const covered = new Set(mapping.map((m) => m.criterion));
      const complete =
        mapping.length === n && covered.size === n && [...covered].every((c) => c >= 0 && c < n);
      if (!complete) {
        throw new ChorusError(
          'evidence_required',
          'criteria_mapping must contain exactly one entry for each acceptance criterion.',
          { details: { criteria_count: n } },
        );
      }

      const next = await tx.db.query<{ revision: number }>(
        `SELECT COALESCE(max(revision), 0) + 1 AS revision
           FROM task_result_revisions WHERE workspace_id = $1 AND task_id = $2`,
        [tx.workspaceId, taskId],
      );
      const revision = next.rows[0]?.revision ?? 1;
      await tx.db.query(
        `INSERT INTO task_result_revisions
           (workspace_id, session_id, task_id, revision, content, content_type, content_sha256,
            byte_length, submitted_by, fence, supporting_refs, criteria_mapping, criteria_revision,
            work_cycle)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)`,
        [
          tx.workspaceId,
          sessionId,
          taskId,
          revision,
          content,
          contentType,
          contentSha256,
          byteLength,
          tx.actorId,
          fence,
          JSON.stringify(refs),
          JSON.stringify(mapping),
          details.criteriaRevision,
          task.workCycle,
        ],
      );
      // Submitting releases the lease (the fence is kept) and moves the task to review.
      await tx.db.query(
        `UPDATE task_leases SET instance_id = NULL, expires_at = now()
          WHERE workspace_id = $1 AND task_id = $2`,
        [tx.workspaceId, taskId],
      );
      await tx.db.query(
        `UPDATE work_items SET state = 'review' WHERE workspace_id = $1 AND id = $2`,
        [tx.workspaceId, taskId],
      );
      const version = await tx.bumpVersion(taskId);
      return {
        result: {
          task_id: taskId,
          version,
          state: 'review',
          revision,
          content_sha256: contentSha256,
          byte_length: byteLength,
        },
        events: [
          {
            roomId: task.homeRoomId,
            aggregateId: taskId,
            aggregateVersion: version,
            eventType: 'task.result_submitted',
            payload: {
              revision,
              content_sha256: contentSha256,
              content_type: contentType,
              byte_length: byteLength,
              fence,
              supporting_ref_count: refs.length,
            },
          },
        ],
      };
    },
  });
}

// --------------------------------------------------------------------------------------------------
// complete
// --------------------------------------------------------------------------------------------------

export type CompleteResponse = { task_id: string; version: number; state: string };

export async function completeTask(ctx: CommandContext, input: unknown): Promise<CompleteResponse> {
  const raw = requireObject(input, ['session_id', 'task_id', 'expected_version']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const taskId = requireUuid(raw['task_id'], 'task_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);

  // The manager's gated command. (Tasks that need a review complete automatically when the review is
  // approved; this covers review_required=false tasks and re-running the gates after a blocker clears.)
  return runCommand(ctx, {
    type: 'task.complete',
    session: { id: sessionId },
    input: { task_id: taskId },
    gated: true,
    targets: [{ id: taskId, expectedVersion, kind: 'task' }],
    authorize: (tx) => {
      requireAction(tx, 'complete');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const task = lockedItem(tx, taskId);
      assertTaskTransition('complete', task.state);
      const verdict = await evaluateCompletionGates(tx, task);
      if (!verdict.ok) throw verdict.error;
      await tx.db.query(
        `UPDATE work_items SET state = 'done' WHERE workspace_id = $1 AND id = $2`,
        [tx.workspaceId, taskId],
      );
      await tx.db.query(
        `UPDATE task_leases SET instance_id = NULL WHERE workspace_id = $1 AND task_id = $2`,
        [tx.workspaceId, taskId],
      );
      const version = await tx.bumpVersion(taskId);
      return {
        result: { task_id: taskId, version, state: 'done' },
        events: [
          {
            roomId: task.homeRoomId,
            aggregateId: taskId,
            aggregateVersion: version,
            eventType: 'task.completed',
            payload: {
              revision: verdict.revision,
              review_id: verdict.reviewId,
              trigger: 'manager_complete',
            },
          },
        ],
      };
    },
  });
}
