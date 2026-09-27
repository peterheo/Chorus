import { withReadTx, type ReadContext } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import { requireUuid } from '../validation.ts';

export type PulseActionKind =
  | 'blocked_task'
  | 'review_assigned'
  | 'stale_lease'
  | 'ready_task'
  | 'claim_request'
  | 'open_question';

export interface PulseAction {
  readonly kind: PulseActionKind;
  readonly item_id: Uuid;
  readonly title: string;
  readonly reason: string;
}

export interface PulseCounts {
  readonly ready_unowned: number;
  readonly in_progress: number;
  readonly blocked: number;
  readonly stale_leases: number;
  readonly pending_reviews: number;
  readonly stale_reviews: number;
  readonly open_questions: number;
  readonly open_proposals: number;
  readonly pending_claim_requests: number;
  readonly linked_messages: number;
}

export interface SessionPulse {
  readonly session_id: Uuid;
  readonly name: string;
  readonly counts: PulseCounts;
  readonly next_actions: readonly PulseAction[];
}

export interface RoomPulse {
  readonly sessions: readonly SessionPulse[];
  readonly generated_at: string;
  readonly coverage: 'chorus_state_only';
}

interface SessionRow {
  id: Uuid;
  name: string;
  roles: string[];
}

interface CountRow extends Record<string, unknown> {
  session_id: Uuid;
  ready_unowned: string;
  in_progress: string;
  blocked: string;
  stale_leases: string;
  pending_reviews: string;
  stale_reviews: string;
  open_questions: string;
  open_proposals: string;
  pending_claim_requests: string;
  linked_messages: string;
}

interface ActionRow {
  session_id: Uuid;
  kind: PulseActionKind;
  item_id: Uuid;
  title: string;
  reason: string;
}

function invalidSessionId(error: unknown): never {
  if (error instanceof ChorusError && error.code === 'invalid_request') {
    throw new ChorusError('invalid_request', error.message, { details: { field: 'session_id' } });
  }
  throw error;
}

/** Read-only summary of live sessions and the caller's highest-priority work. */
export async function roomPulse(
  ctx: ReadContext,
  input: { readonly session_id?: Uuid },
): Promise<RoomPulse> {
  let sessionFilter: Uuid | undefined;
  if (input.session_id !== undefined) {
    try {
      sessionFilter = requireUuid(input.session_id, 'session_id');
    } catch (error) {
      invalidSessionId(error);
    }
  }

  return withReadTx(ctx, async (db) => {
    const generated = await db.query<{ generated_at: Date | string }>(
      'SELECT now() AS generated_at',
    );
    const { rows: sessions } = await db.query<SessionRow>(
      `SELECT s.id, s.name, chorus_session_roles(s.id) AS roles
         FROM sessions s
        WHERE s.workspace_id = $1
          AND s.id IN (SELECT chorus_my_sessions())
          AND ($2::uuid IS NULL OR s.id = $2)
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT 50`,
      [ctx.workspaceId, sessionFilter ?? null],
    );
    if (sessionFilter !== undefined && sessions.length === 0) {
      throw new ChorusError('not_found', 'Not found.');
    }
    if (sessions.length === 0) {
      const value = generated.rows[0]?.generated_at;
      return {
        sessions: [],
        generated_at:
          value instanceof Date ? value.toISOString() : new Date(value ?? 0).toISOString(),
        coverage: 'chorus_state_only',
      };
    }

    const sessionIds = sessions.map((session) => session.id);
    const { rows: counts } = await db.query<CountRow>(
      `SELECT s.id AS session_id,
          (SELECT count(*) FROM work_items w
            WHERE w.workspace_id = $1 AND w.session_id = s.id AND w.kind = 'task'
              AND w.state = 'ready' AND w.owner_actor_id IS NULL) AS ready_unowned,
          (SELECT count(*) FROM work_items w
            WHERE w.workspace_id = $1 AND w.session_id = s.id AND w.kind = 'task'
              AND w.state = 'in_progress') AS in_progress,
          (SELECT count(*) FROM work_items w
            WHERE w.workspace_id = $1 AND w.session_id = s.id AND w.kind = 'task'
              AND w.blocked_reason IS NOT NULL AND w.state NOT IN ('done', 'cancelled')) AS blocked,
          (SELECT count(*) FROM work_items w JOIN task_leases l
              ON l.workspace_id = w.workspace_id AND l.task_id = w.id
            WHERE w.workspace_id = $1 AND w.session_id = s.id AND w.kind = 'task'
              AND w.state = 'in_progress' AND w.owner_actor_id IS NOT NULL
              AND NOT COALESCE(l.instance_id IS NOT NULL AND l.expires_at > now(), false)) AS stale_leases,
          (SELECT count(*) FROM work_items r JOIN review_details d
              ON d.workspace_id = r.workspace_id AND d.review_item_id = r.id
              LEFT JOIN LATERAL (SELECT max(revision) AS revision FROM task_result_revisions x
                WHERE x.workspace_id = d.workspace_id AND x.task_id = d.subject_task_id) latest ON true
            WHERE r.workspace_id = $1 AND r.session_id = s.id AND r.kind = 'review'
              AND r.state = 'requested' AND d.cancelled_at IS NULL
              AND d.result_revision = latest.revision) AS pending_reviews,
          (SELECT count(*) FROM work_items r JOIN review_details d
              ON d.workspace_id = r.workspace_id AND d.review_item_id = r.id
              LEFT JOIN LATERAL (SELECT max(revision) AS revision FROM task_result_revisions x
                WHERE x.workspace_id = d.workspace_id AND x.task_id = d.subject_task_id) latest ON true
            WHERE r.workspace_id = $1 AND r.session_id = s.id AND r.kind = 'review'
              AND r.state = 'requested' AND d.cancelled_at IS NULL
              AND d.result_revision < latest.revision) AS stale_reviews,
          (SELECT count(*) FROM work_items w
            WHERE w.workspace_id = $1 AND w.session_id = s.id AND w.kind = 'question' AND w.state = 'open') AS open_questions,
          (SELECT count(*) FROM work_items w
            WHERE w.workspace_id = $1 AND w.session_id = s.id AND w.kind = 'proposal' AND w.state = 'open') AS open_proposals,
          (SELECT count(*) FROM claim_requests c
            WHERE c.workspace_id = $1 AND c.session_id = s.id AND c.state = 'pending') AS pending_claim_requests,
          (SELECT count(*) FROM message_links m
            WHERE m.workspace_id = $1 AND m.session_id = s.id) AS linked_messages
         FROM unnest($2::uuid[]) s(id)`,
      [ctx.workspaceId, sessionIds],
    );
    const { rows: actions } = await db.query<ActionRow>(
      `WITH candidates AS (
        SELECT w.session_id, 'blocked_task'::text AS kind, w.id AS item_id, w.title,
               'You own this task and it is blocked.'::text AS reason, 1 AS rule_order,
               w.blocked_at AS sort_time, 0 AS sort_priority
          FROM work_items w
         WHERE w.workspace_id = $1 AND w.session_id = ANY($2::uuid[]) AND w.kind = 'task'
           AND w.owner_actor_id = $3 AND w.blocked_reason IS NOT NULL
           AND w.state NOT IN ('done', 'cancelled')
        UNION ALL
        SELECT r.session_id, 'review_assigned', r.id, r.title,
               'A review of the latest result is assigned to you.', 2, r.created_at, 0
          FROM work_items r JOIN review_details d
            ON d.workspace_id = r.workspace_id AND d.review_item_id = r.id
          JOIN LATERAL (SELECT max(revision) AS revision FROM task_result_revisions x
            WHERE x.workspace_id = d.workspace_id AND x.task_id = d.subject_task_id) latest ON true
         WHERE r.workspace_id = $1 AND r.session_id = ANY($2::uuid[]) AND r.kind = 'review'
           AND r.owner_actor_id = $3 AND r.state = 'requested' AND d.cancelled_at IS NULL
           AND d.result_revision = latest.revision
        UNION ALL
        SELECT w.session_id, 'stale_lease', w.id, w.title,
               'Your lease expired; claim again to continue.', 3, l.expires_at, 0
          FROM work_items w JOIN task_leases l
            ON l.workspace_id = w.workspace_id AND l.task_id = w.id
         WHERE w.workspace_id = $1 AND w.session_id = ANY($2::uuid[]) AND w.kind = 'task'
           AND w.owner_actor_id = $3 AND w.state = 'in_progress'
           AND NOT COALESCE(l.instance_id IS NOT NULL AND l.expires_at > now(), false)
        UNION ALL
        SELECT w.session_id, 'ready_task', w.id, w.title, 'Ready and unowned.', 4,
               w.created_at, w.priority::integer
          FROM work_items w
         WHERE w.workspace_id = $1 AND w.session_id = ANY($2::uuid[]) AND w.kind = 'task'
           AND w.state = 'ready' AND w.owner_actor_id IS NULL AND w.blocked_reason IS NULL
        UNION ALL
        SELECT c.session_id, 'claim_request', t.id, t.title,
               'A claim request awaits a manager decision.', 5, c.created_at, 0
          FROM claim_requests c JOIN work_items t
            ON t.workspace_id = c.workspace_id AND t.id = c.task_id
         WHERE c.workspace_id = $1 AND c.session_id = ANY($2::uuid[]) AND c.state = 'pending'
           AND c.session_id = ANY($4::uuid[])
        UNION ALL
        SELECT w.session_id, 'open_question', w.id, w.title,
               'Open for more than 24 hours.', 6, w.created_at, 0
          FROM work_items w
         WHERE w.workspace_id = $1 AND w.session_id = ANY($2::uuid[])
           AND w.kind = 'question' AND w.state = 'open' AND w.created_at < now() - interval '24 hours'
      ), deduplicated AS (
        SELECT candidates.*,
               row_number() OVER (PARTITION BY session_id, item_id ORDER BY rule_order) AS item_rank
          FROM candidates
      ), prioritized AS (
        SELECT deduplicated.*,
               row_number() OVER (PARTITION BY session_id
                 ORDER BY rule_order, sort_priority, sort_time ASC NULLS FIRST, item_id) AS action_rank
          FROM deduplicated WHERE item_rank = 1
      )
      SELECT session_id, kind, item_id, title, reason
        FROM prioritized WHERE action_rank <= 10
       ORDER BY session_id, action_rank`,
      [
        ctx.workspaceId,
        sessionIds,
        ctx.actorId,
        sessions
          .filter((session) => session.roles.includes('manager'))
          .map((session) => session.id),
      ],
    );

    const countsBySession = new Map(counts.map((row) => [row.session_id, row]));
    const actionsBySession = new Map<Uuid, PulseAction[]>();
    for (const action of actions) {
      const list = actionsBySession.get(action.session_id) ?? [];
      list.push({
        kind: action.kind,
        item_id: action.item_id,
        title: action.title,
        reason: action.reason,
      });
      actionsBySession.set(action.session_id, list);
    }
    const output = sessions.map((session): SessionPulse => {
      const row = countsBySession.get(session.id);
      const number = (value: string | undefined) => Number(value ?? 0);
      return {
        session_id: session.id,
        name: session.name,
        counts: {
          ready_unowned: number(row?.ready_unowned),
          in_progress: number(row?.in_progress),
          blocked: number(row?.blocked),
          stale_leases: number(row?.stale_leases),
          pending_reviews: number(row?.pending_reviews),
          stale_reviews: number(row?.stale_reviews),
          open_questions: number(row?.open_questions),
          open_proposals: number(row?.open_proposals),
          pending_claim_requests: number(row?.pending_claim_requests),
          linked_messages: number(row?.linked_messages),
        },
        next_actions: actionsBySession.get(session.id) ?? [],
      };
    });
    const value = generated.rows[0]?.generated_at;
    return {
      sessions: output,
      generated_at:
        value instanceof Date ? value.toISOString() : new Date(value ?? 0).toISOString(),
      coverage: 'chorus_state_only',
    };
  });
}
