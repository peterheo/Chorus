import { requireAction } from '../authz.ts';
import {
  runCommand,
  type CommandContext,
  type CommandTx,
  type DomainEventDraft,
  type SessionRole,
} from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import {
  invalid,
  optionalBoolean,
  requireArray,
  requireEnum,
  requireInteger,
  requireNonBlank,
  requireObject,
  requireString,
  requireUuid,
} from '../validation.ts';
import { iso, requireSession } from './support.ts';

/**
 * Sessions (WP3 rev 4 section 4): the authorization boundary inside a room. P1 supports the `open` and
 * `listed` join policies and the `open` claim policy; the other policies are refused loudly with
 * `not_supported_yet` rather than silently behaving like `open`.
 */
const JOIN_POLICIES_P1 = ['open', 'listed'] as const;
const PRINCIPAL = /^p_[A-Za-z0-9]{6,64}$/;

function unsupported(field: string, value: string): ChorusError {
  return new ChorusError('invalid_request', `${field} "${value}" is not supported yet.`, {
    details: { field, reason: 'not_supported_yet' },
  });
}

function principals(value: unknown, field: string): string[] {
  const list = requireArray(value, field, 0, 200).map((p, i) => {
    const text = requireString(p, `${field}[${String(i)}]`, {
      minCodePoints: 1,
      maxCodePoints: 70,
    });
    if (!PRINCIPAL.test(text))
      throw invalid(`${field}[${String(i)}]`, `${field} entries must be SharedNet principal ids.`);
    return text;
  });
  return [...new Set(list)];
}

function joinPolicy(value: unknown): 'open' | 'listed' {
  const policy = requireEnum(value, 'join_policy', [
    'open',
    'listed',
    'policy_matched',
    'session_credential',
  ]);
  if (!(JOIN_POLICIES_P1 as readonly string[]).includes(policy))
    throw unsupported('join_policy', policy);
  return policy as 'open' | 'listed';
}

function claimPolicy(value: unknown): 'open' {
  const policy = requireEnum(value, 'default_claim_policy', [
    'open',
    'manager_assigned',
    'approval_required',
  ]);
  if (policy !== 'open') throw unsupported('default_claim_policy', policy);
  return 'open';
}

// --------------------------------------------------------------------------------------------------
// create_session (room-level)
// --------------------------------------------------------------------------------------------------

export type SessionCreated = {
  session: {
    id: string;
    room_id: string;
    name: string;
    version: number;
    join_policy: string;
    discoverable: boolean;
  };
  board: { id: string; name: string; session_id: string };
  membership: { actor_id: string; roles: string[] };
};

export async function createSession(ctx: CommandContext, input: unknown): Promise<SessionCreated> {
  const raw = requireObject(input, [
    'room_id',
    'name',
    'board_name',
    'discoverable',
    'join_policy',
    'listed_principals',
    'policy_agent_ids',
    'default_claim_policy',
    'manager_review_allowed',
    'default_review_required',
  ]);
  const roomId = raw['room_id'] === undefined ? ctx.roomId : requireUuid(raw['room_id'], 'room_id');
  if (roomId === undefined) throw invalid('room_id', 'room_id is required.');
  const name = requireNonBlank(raw['name'], 'name', 200);
  const boardName = requireNonBlank(raw['board_name'], 'board_name', 200);
  const discoverable = optionalBoolean(raw['discoverable'], 'discoverable', true);
  const policy = raw['join_policy'] === undefined ? 'open' : joinPolicy(raw['join_policy']);
  const listed =
    raw['listed_principals'] === undefined
      ? []
      : principals(raw['listed_principals'], 'listed_principals');
  const agentIds =
    raw['policy_agent_ids'] === undefined
      ? []
      : requireArray(raw['policy_agent_ids'], 'policy_agent_ids', 0, 50).map((a, i) =>
          requireNonBlank(a, `policy_agent_ids[${String(i)}]`, 100),
        );
  const claim =
    raw['default_claim_policy'] === undefined ? 'open' : claimPolicy(raw['default_claim_policy']);
  const managerReview = optionalBoolean(
    raw['manager_review_allowed'],
    'manager_review_allowed',
    false,
  );
  const reviewRequired = optionalBoolean(
    raw['default_review_required'],
    'default_review_required',
    true,
  );

  return runCommand(ctx, {
    type: 'session.create',
    input: {
      room_id: roomId,
      name,
      board_name: boardName,
      discoverable,
      join_policy: policy,
      listed_principals: listed,
      policy_agent_ids: agentIds,
      default_claim_policy: claim,
      manager_review_allowed: managerReview,
      default_review_required: reviewRequired,
    },
    authorize: async (tx) => {
      // Any verified live member of the (active) room may create a session in it.
      const member = await tx.db.query(
        `SELECT 1 FROM room_members m JOIN rooms r ON r.workspace_id = m.workspace_id AND r.id = m.room_id
          WHERE m.workspace_id = $1 AND m.room_id = $2 AND m.actor_id = $3 AND m.removed_at IS NULL
            AND r.activation_state = 'active'`,
        [tx.workspaceId, roomId, tx.actorId],
      );
      if (member.rowCount === 0) throw new ChorusError('not_found', 'Not found.');
    },
    handle: async (tx) => {
      const { rows } = await tx.db.query<{ session_id: Uuid; board_id: Uuid }>(
        'SELECT * FROM chorus_create_session($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          roomId,
          name,
          boardName,
          discoverable,
          policy,
          listed,
          agentIds,
          claim,
          managerReview,
          reviewRequired,
        ],
      );
      const created = rows[0];
      if (created === undefined)
        throw new ChorusError('internal_error', 'Session creation returned no row.');
      // The first board is part of the creation: it is the session's second versioned change.
      await tx.db.query('UPDATE sessions SET version = 2 WHERE workspace_id = $1 AND id = $2', [
        tx.workspaceId,
        created.session_id,
      ]);
      return {
        result: {
          session: {
            id: created.session_id,
            room_id: roomId,
            name,
            version: 2,
            join_policy: policy,
            discoverable,
          },
          board: { id: created.board_id, name: boardName, session_id: created.session_id },
          membership: { actor_id: tx.actorId, roles: ['participant', 'manager', 'administrator'] },
        },
        events: [
          {
            roomId,
            aggregateId: created.session_id,
            aggregateType: 'session',
            aggregateVersion: 1,
            eventType: 'session.created',
            payload: { join_policy: policy, discoverable, created_by: tx.actorId },
          },
          {
            roomId,
            aggregateId: created.session_id,
            aggregateType: 'session',
            aggregateVersion: 2,
            eventType: 'board.created',
            payload: { board_id: created.board_id },
          },
        ],
      };
    },
  });
}

// --------------------------------------------------------------------------------------------------
// join_session (room-level)
// --------------------------------------------------------------------------------------------------

export type SessionJoined = { session_id: string; roles: string[]; joined: boolean };

export async function joinSession(ctx: CommandContext, input: unknown): Promise<SessionJoined> {
  const raw = requireObject(input, ['session_id', 'join_credential']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  if (raw['join_credential'] !== undefined)
    throw unsupported('join_credential', 'session_credential');

  return runCommand(ctx, {
    type: 'session.join',
    input: { session_id: sessionId },
    authorize: () => Promise.resolve(),
    // A replay is honoured only while the caller is STILL a live member.
    replayAuthorize: async (tx) => {
      const member = await tx.db.query(
        `SELECT 1 FROM session_members
          WHERE workspace_id = $1 AND session_id = $2 AND actor_id = $3 AND removed_at IS NULL`,
        [tx.workspaceId, sessionId, tx.actorId],
      );
      if (member.rowCount === 0) throw new ChorusError('not_found', 'Not found.');
    },
    handle: async (tx) => {
      const { rows } = await tx.db.query<{
        session_id: Uuid;
        roles: string[];
        newly_joined: boolean;
      }>('SELECT * FROM chorus_join_session($1, NULL)', [sessionId]);
      const joined = rows[0];
      // Not eligible, nonexistent and not visible are one answer.
      if (joined === undefined) throw new ChorusError('not_found', 'Not found.');
      const result = { session_id: sessionId, roles: joined.roles, joined: joined.newly_joined };
      if (!joined.newly_joined) return { result, events: [], noop: true };
      const bumped = await tx.db.query<{ version: number; room_id: Uuid }>(
        `UPDATE sessions SET version = version + 1 WHERE workspace_id = $1 AND id = $2
         RETURNING version, room_id`,
        [tx.workspaceId, sessionId],
      );
      const row = bumped.rows[0];
      if (row === undefined) throw new ChorusError('internal_error', 'Session disappeared.');
      return {
        result,
        events: [
          {
            roomId: row.room_id,
            aggregateId: sessionId,
            aggregateType: 'session',
            aggregateVersion: row.version,
            eventType: 'session.member_joined',
            payload: { actor_id: tx.actorId },
          },
        ],
      };
    },
  });
}

// --------------------------------------------------------------------------------------------------
// Session administration
// --------------------------------------------------------------------------------------------------

export async function createBoard(
  ctx: CommandContext,
  input: unknown,
): Promise<{ board: { id: string; name: string; session_id: string }; session_version: number }> {
  const raw = requireObject(input, ['session_id', 'name']);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const name = requireNonBlank(raw['name'], 'name', 200);
  return runCommand(ctx, {
    type: 'board.create',
    session: { id: sessionId, lock: true },
    input: { name },
    authorize: (tx) => {
      requireAction(tx, 'create_board');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const session = requireSession(tx);
      const { rows } = await tx.db.query<{ id: Uuid }>(
        'INSERT INTO projects (workspace_id, session_id, name) VALUES ($1, $2, $3) RETURNING id',
        [tx.workspaceId, sessionId, name],
      );
      const id = rows[0]?.id;
      if (id === undefined)
        throw new ChorusError('internal_error', 'Board insert returned no row.');
      const version = await tx.bumpSessionVersion();
      return {
        result: { board: { id, name, session_id: sessionId }, session_version: version },
        events: [
          {
            roomId: session.roomId,
            aggregateId: sessionId,
            aggregateType: 'session',
            aggregateVersion: version,
            eventType: 'board.created',
            payload: { board_id: id },
          },
        ],
      };
    },
  });
}

export type PolicyChanged = { session_id: string; version: number; changed: string[] };

export async function setSessionPolicy(
  ctx: CommandContext,
  input: unknown,
): Promise<PolicyChanged> {
  const raw = requireObject(input, [
    'session_id',
    'expected_version',
    'name',
    'discoverable',
    'join_policy',
    'listed_principals',
    'policy_agent_ids',
    'default_claim_policy',
    'manager_review_allowed',
    'default_review_required',
  ]);
  const sessionId = requireUuid(raw['session_id'], 'session_id');
  const expectedVersion = requireInteger(raw['expected_version'], 'expected_version', 1);
  const changes: Record<string, unknown> = {};
  if (raw['name'] !== undefined) changes['name'] = requireNonBlank(raw['name'], 'name', 200);
  if (raw['discoverable'] !== undefined)
    changes['discoverable'] = optionalBoolean(raw['discoverable'], 'discoverable', true);
  if (raw['join_policy'] !== undefined) changes['join_policy'] = joinPolicy(raw['join_policy']);
  if (raw['listed_principals'] !== undefined)
    changes['listed_principals'] = principals(raw['listed_principals'], 'listed_principals');
  if (raw['policy_agent_ids'] !== undefined) {
    changes['policy_agent_ids'] = requireArray(
      raw['policy_agent_ids'],
      'policy_agent_ids',
      0,
      50,
    ).map((a, i) => requireNonBlank(a, `policy_agent_ids[${String(i)}]`, 100));
  }
  if (raw['default_claim_policy'] !== undefined)
    changes['default_claim_policy'] = claimPolicy(raw['default_claim_policy']);
  if (raw['manager_review_allowed'] !== undefined)
    changes['manager_review_allowed'] = optionalBoolean(
      raw['manager_review_allowed'],
      'manager_review_allowed',
      false,
    );
  if (raw['default_review_required'] !== undefined)
    changes['default_review_required'] = optionalBoolean(
      raw['default_review_required'],
      'default_review_required',
      true,
    );
  const fields = Object.keys(changes);
  if (fields.length === 0) throw invalid('input', 'At least one policy field is required.');

  return runCommand(ctx, {
    type: 'session.set_policy',
    session: { id: sessionId, lock: true, expectedVersion },
    input: changes as never,
    authorize: (tx) => {
      requireAction(tx, 'administer');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const session = requireSession(tx);
      const column: Record<string, string> = {
        name: 'name',
        discoverable: 'discoverable',
        join_policy: 'join_policy',
        listed_principals: 'listed_principals',
        policy_agent_ids: 'policy_agent_ids',
        default_claim_policy: 'default_claim_policy',
        manager_review_allowed: 'manager_review_allowed',
        default_review_required: 'default_review_required',
      };
      const sets = fields.map((f, i) => `${column[f] ?? ''} = $${String(i + 3)}`);
      await tx.db.query(
        `UPDATE sessions SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2`,
        [tx.workspaceId, sessionId, ...fields.map((f) => changes[f])],
      );
      const version = await tx.bumpSessionVersion();
      return {
        result: { session_id: sessionId, version, changed: fields },
        events: [
          {
            roomId: session.roomId,
            aggregateId: sessionId,
            aggregateType: 'session',
            aggregateVersion: version,
            eventType: 'session.policy_changed',
            payload: { changed: fields },
          },
        ],
      };
    },
  });
}

async function liveAdministrators(tx: CommandTx): Promise<number> {
  const { rows } = await tx.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM session_members
      WHERE workspace_id = $1 AND session_id = $2 AND removed_at IS NULL AND 'administrator' = ANY (roles)`,
    [tx.workspaceId, requireSession(tx).id],
  );
  return Number(rows[0]?.n ?? 0);
}

function lastAdministrator(): ChorusError {
  return new ChorusError(
    'invalid_transition',
    'The last administrator cannot give up administration.',
    {
      details: { reason: 'last_administrator' },
    },
  );
}

async function memberRow(tx: CommandTx, actorId: Uuid): Promise<{ roles: SessionRole[] }> {
  const { rows } = await tx.db.query<{ roles: SessionRole[] }>(
    `SELECT roles FROM session_members
      WHERE workspace_id = $1 AND session_id = $2 AND actor_id = $3 AND removed_at IS NULL FOR UPDATE`,
    [tx.workspaceId, requireSession(tx).id, actorId],
  );
  const row = rows[0];
  if (row === undefined) throw new ChorusError('not_found', 'Not found.');
  return row;
}

export type RoleChanged = {
  session_id: string;
  actor_id: string;
  roles: string[];
  version: number;
};

function roleCommand(kind: 'grant' | 'revoke') {
  return async (ctx: CommandContext, input: unknown): Promise<RoleChanged> => {
    const raw = requireObject(input, ['session_id', 'actor_id', 'role']);
    const sessionId = requireUuid(raw['session_id'], 'session_id');
    const actorId = requireUuid(raw['actor_id'], 'actor_id');
    const role = requireEnum(raw['role'], 'role', ['manager', 'administrator']);
    return runCommand(ctx, {
      type: `session.${kind}_role`,
      session: { id: sessionId, lock: true },
      input: { actor_id: actorId, role },
      authorize: (tx) => {
        requireAction(tx, 'administer');
        return Promise.resolve();
      },
      handle: async (tx) => {
        const session = requireSession(tx);
        const member = await memberRow(tx, actorId);
        const has = member.roles.includes(role);
        if (kind === 'grant' ? has : !has) {
          return {
            result: {
              session_id: sessionId,
              actor_id: actorId,
              roles: member.roles,
              version: session.version,
            },
            events: [],
            noop: true,
          };
        }
        if (kind === 'revoke' && role === 'administrator' && (await liveAdministrators(tx)) <= 1) {
          throw lastAdministrator();
        }
        const roles =
          kind === 'grant' ? [...member.roles, role] : member.roles.filter((r) => r !== role);
        await tx.db.query(
          `UPDATE session_members SET roles = $4::text[], version = version + 1
            WHERE workspace_id = $1 AND session_id = $2 AND actor_id = $3`,
          [tx.workspaceId, sessionId, actorId, roles],
        );
        const version = await tx.bumpSessionVersion();
        return {
          result: { session_id: sessionId, actor_id: actorId, roles, version },
          events: [
            {
              roomId: session.roomId,
              aggregateId: sessionId,
              aggregateType: 'session',
              aggregateVersion: version,
              eventType: `session.role_${kind === 'grant' ? 'granted' : 'revoked'}`,
              payload: { actor_id: actorId, role },
            },
          ],
        };
      },
    });
  };
}
export const grantRole = roleCommand('grant');
export const revokeRole = roleCommand('revoke');

/**
 * A member leaves or is removed. In the SAME transaction: their requested reviews are cancelled, the
 * lease holder is cleared on tasks they own (the owner is kept; a manager may reassign), and their
 * pending claim requests are withdrawn. Every changed aggregate gets its own version bump and event.
 */
async function removalEffects(tx: CommandTx, actorId: Uuid): Promise<DomainEventDraft[]> {
  const session = requireSession(tx);
  const events: DomainEventDraft[] = [];
  const reviews = await tx.db.query<{ id: Uuid }>(
    `SELECT w.id FROM work_items w
       JOIN review_details d ON d.workspace_id = w.workspace_id AND d.review_item_id = w.id
      WHERE w.workspace_id = $1 AND w.session_id = $2 AND w.kind = 'review' AND w.state = 'requested'
        AND w.owner_actor_id = $3 AND d.cancelled_at IS NULL
      ORDER BY w.id FOR UPDATE OF w`,
    [tx.workspaceId, session.id, actorId],
  );
  for (const { id } of reviews.rows) {
    await tx.db.query(
      `UPDATE work_items SET state = 'cancelled' WHERE workspace_id = $1 AND id = $2`,
      [tx.workspaceId, id],
    );
    await tx.db.query(
      `UPDATE review_details SET cancelled_at = now(), cancel_reason = 'reviewer_removed'
        WHERE workspace_id = $1 AND review_item_id = $2`,
      [tx.workspaceId, id],
    );
    const bumped = await tx.db.query<{ version: number }>(
      'UPDATE work_items SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING version',
      [tx.workspaceId, id],
    );
    events.push({
      roomId: session.roomId,
      aggregateId: id,
      aggregateVersion: bumped.rows[0]?.version ?? 0,
      eventType: 'review.cancelled',
      payload: { reason: 'reviewer_removed' },
    });
  }
  const tasks = await tx.db.query<{ id: Uuid }>(
    `SELECT w.id FROM work_items w
       JOIN task_leases l ON l.workspace_id = w.workspace_id AND l.task_id = w.id
      WHERE w.workspace_id = $1 AND w.session_id = $2 AND w.kind = 'task' AND w.owner_actor_id = $3
        AND l.instance_id IS NOT NULL
      ORDER BY w.id FOR UPDATE OF w`,
    [tx.workspaceId, session.id, actorId],
  );
  for (const { id } of tasks.rows) {
    await tx.db.query(
      'UPDATE task_leases SET instance_id = NULL, expires_at = now() WHERE workspace_id = $1 AND task_id = $2',
      [tx.workspaceId, id],
    );
    const bumped = await tx.db.query<{ version: number }>(
      'UPDATE work_items SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING version',
      [tx.workspaceId, id],
    );
    events.push({
      roomId: session.roomId,
      aggregateId: id,
      aggregateVersion: bumped.rows[0]?.version ?? 0,
      eventType: 'task.lease_cleared',
      payload: { reason: 'owner_removed' },
    });
  }
  await tx.db.query(
    `UPDATE claim_requests SET state = 'withdrawn', decided_at = now(), reason = 'requester_removed'
      WHERE workspace_id = $1 AND session_id = $2 AND requester_actor_id = $3 AND state = 'pending'`,
    [tx.workspaceId, session.id, actorId],
  );
  return events;
}

export type MemberRemoved = { session_id: string; actor_id: string; version: number };

function removalCommand(kind: 'remove' | 'leave') {
  return async (ctx: CommandContext, input: unknown): Promise<MemberRemoved> => {
    const raw = requireObject(
      input,
      kind === 'remove' ? ['session_id', 'actor_id'] : ['session_id'],
    );
    const sessionId = requireUuid(raw['session_id'], 'session_id');
    const target = kind === 'remove' ? requireUuid(raw['actor_id'], 'actor_id') : ctx.actorId;
    return runCommand(ctx, {
      type: `session.${kind}_member`,
      session: { id: sessionId, lock: true },
      input: { actor_id: target },
      authorize: (tx) => {
        requireAction(tx, kind === 'remove' ? 'administer' : 'leave');
        return Promise.resolve();
      },
      // The member row is closed LAST (after events are journaled): a member leaving their own session
      // must still be able to journal it, and a removed member's own statements would no longer see it.
      finalize: async (tx) => {
        await tx.db.query(
          `UPDATE session_members SET removed_at = now(), version = version + 1
            WHERE workspace_id = $1 AND session_id = $2 AND actor_id = $3`,
          [tx.workspaceId, sessionId, target],
        );
      },
      handle: async (tx) => {
        const session = requireSession(tx);
        const member = await memberRow(tx, target);
        if (member.roles.includes('administrator') && (await liveAdministrators(tx)) <= 1) {
          throw lastAdministrator();
        }
        const effects = await removalEffects(tx, target);
        const version = await tx.bumpSessionVersion();
        return {
          result: { session_id: sessionId, actor_id: target, version },
          events: [
            {
              roomId: session.roomId,
              aggregateId: sessionId,
              aggregateType: 'session',
              aggregateVersion: version,
              eventType: kind === 'remove' ? 'session.member_removed' : 'session.member_left',
              payload: { actor_id: target, cancelled_or_cleared: effects.length },
            },
            ...effects,
          ],
        };
      },
    });
  };
}
export const removeMember = removalCommand('remove');
export const leaveSession = removalCommand('leave');

export const sessionIso = iso;
