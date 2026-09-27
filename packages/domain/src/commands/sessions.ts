import { requireAction } from '../authz.ts';
import {
  runCommand,
  withReadTx,
  type CommandContext,
  type ReadContext,
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

export type CreateSessionParams = {
  roomId: Uuid;
  name: string;
  boardName: string;
  discoverable: boolean;
  policy: 'open' | 'listed';
  listed: string[];
  agentIds: string[];
  claim: 'open';
  managerReview: boolean;
  reviewRequired: boolean;
};

/** Validates the input of `create_session` (shape and P1 limits only; no I/O). */
export function parseCreateSession(
  scope: { readonly roomId?: Uuid | undefined },
  input: unknown,
): CreateSessionParams {
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
  const roomId =
    raw['room_id'] === undefined ? scope.roomId : requireUuid(raw['room_id'], 'room_id');
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
  return {
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
  };
}

/**
 * The write half of `create_session`, callable inside another command's transaction (the paid
 * `create_action_board` delivery): creates the session and its first board through the definer and returns the
 * result and the events to journal. The public command journals exactly these.
 */
export async function createSessionInTx(
  tx: CommandTx,
  params: CreateSessionParams,
): Promise<{ result: SessionCreated; events: DomainEventDraft[] }> {
  const {
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
  } = params;
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
  // The definer creates the session at version 1 and its first board as the second versioned change.
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
}

export async function createSession(ctx: CommandContext, input: unknown): Promise<SessionCreated> {
  const params = parseCreateSession(ctx, input);
  const {
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
  } = params;

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
    // A replay returns the stored body, which names the session, so it also requires the caller's CURRENT
    // live membership in that session (a creator who was later removed gets not_found and no body).
    replayAuthorize: async (tx, stored) => {
      const roles = await tx.db.query<{ roles: string[] | null }>(
        'SELECT chorus_session_roles($1) AS roles',
        [stored.session.id],
      );
      if (roles.rows[0]?.roles === null || roles.rows[0]?.roles === undefined)
        throw new ChorusError('not_found', 'Not found.');
    },
    handle: (tx) => createSessionInTx(tx, params),
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
      const roles = await tx.db.query<{ roles: string[] | null }>(
        'SELECT chorus_session_roles($1) AS roles',
        [sessionId],
      );
      if (roles.rows[0]?.roles === null || roles.rows[0]?.roles === undefined)
        throw new ChorusError('not_found', 'Not found.');
    },
    handle: async (tx) => {
      const { rows } = await tx.db.query<{
        session_id: Uuid;
        roles: string[];
        newly_joined: boolean;
        session_version: number;
        room_id: Uuid;
      }>('SELECT * FROM chorus_join_session($1, NULL)', [sessionId]);
      const joined = rows[0];
      // Not eligible, nonexistent and not visible are one answer.
      if (joined === undefined) throw new ChorusError('not_found', 'Not found.');
      const result = { session_id: sessionId, roles: joined.roles, joined: joined.newly_joined };
      if (!joined.newly_joined) return { result, events: [], noop: true };
      return {
        result,
        events: [
          {
            roomId: joined.room_id,
            aggregateId: sessionId,
            aggregateType: 'session',
            aggregateVersion: joined.session_version,
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
      // The definer re-verifies the manager role, inserts the board and bumps the session version.
      const { rows } = await tx.db.query<{ board_id: Uuid; session_version: number }>(
        'SELECT * FROM chorus_session_create_board($1, $2)',
        [sessionId, name],
      );
      const created = rows[0];
      if (created === undefined)
        throw new ChorusError('internal_error', 'Board insert returned no row.');
      const id = created.board_id;
      const version = tx.recordSessionVersion(created.session_version);
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
  return changeSessionPolicy(ctx, input, 'session.set_policy');
}

export async function setCoordinationMode(
  ctx: CommandContext,
  input: unknown,
): Promise<PolicyChanged> {
  const raw = requireObject(input, ['session_id', 'expected_version', 'mode']);
  const mode = requireEnum(raw['mode'], 'mode', ['off', 'observe', 'assist']);
  return changeSessionPolicy(
    ctx,
    {
      session_id: raw['session_id'],
      expected_version: raw['expected_version'],
      coordination_mode: mode,
    },
    'session.set_coordination_mode',
  );
}

async function changeSessionPolicy(
  ctx: CommandContext,
  input: unknown,
  commandType: 'session.set_policy' | 'session.set_coordination_mode',
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
    'coordination_mode',
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
  // CC-2d: the coordination engine's mode for this session (0009); the column CHECK enforces the same set.
  if (raw['coordination_mode'] !== undefined)
    changes['coordination_mode'] = requireEnum(raw['coordination_mode'], 'coordination_mode', [
      'off',
      'observe',
      'assist',
    ]);
  const fields = Object.keys(changes);
  if (fields.length === 0) throw invalid('input', 'At least one policy field is required.');

  return runCommand(ctx, {
    type: commandType,
    session: { id: sessionId, lock: true, expectedVersion },
    input: changes as never,
    authorize: (tx) => {
      requireAction(tx, 'administer');
      return Promise.resolve();
    },
    handle: (tx) => applyPolicyChangesInTx(tx, sessionId, changes),
  });
}

/**
 * The body of a policy change, inside a command whose session is locked and whose caller administers it:
 * the definer update (which bumps the version), the monotonic engine-cursor jump when the mode turns on
 * (spec §10, GREATEST so it never moves back), and the `session.policy_changed` event.
 */
async function applyPolicyChangesInTx(
  tx: CommandTx,
  sessionId: Uuid,
  changes: Readonly<Record<string, unknown>>,
): Promise<{ result: PolicyChanged; events: DomainEventDraft[] }> {
  const fields = Object.keys(changes);
  const session = requireSession(tx);
  // The administrator role is re-verified inside the definer, which also bumps the session version.
  const changed = await tx.db.query<{ version: number }>(
    'SELECT chorus_session_set_policy($1, $2::jsonb) AS version',
    [sessionId, JSON.stringify(changes)],
  );
  if (changes['coordination_mode'] === 'observe' || changes['coordination_mode'] === 'assist') {
    // Project only the checkpoint: the watcher function also exposes sealed seat credentials.
    const checkpoint = await tx.db.query<{ last_sequence: string | null }>(
      `SELECT watcher.last_sequence
         FROM public.sessions s
         LEFT JOIN public.chorus_watcher_rooms() watcher
           ON watcher.workspace_id = s.workspace_id AND watcher.room_id = s.room_id
        WHERE s.workspace_id = $1 AND s.id = $2`,
      [tx.workspaceId, sessionId],
    );
    const coordinationCursor = Number(checkpoint.rows[0]?.last_sequence ?? 0);
    if (!Number.isSafeInteger(coordinationCursor) || coordinationCursor < 0) {
      throw new ChorusError('internal_error', 'The room cursor is invalid.');
    }
    await tx.db.query(
      `INSERT INTO conversation_engine_state (workspace_id, session_id, cursor)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, session_id) DO UPDATE
         SET cursor = GREATEST(conversation_engine_state.cursor, EXCLUDED.cursor), updated_at = now()`,
      [tx.workspaceId, sessionId, coordinationCursor],
    );
  }
  const version = tx.recordSessionVersion(changed.rows[0]?.version ?? 0);
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
}

export type CoordinationMode = 'off' | 'observe' | 'assist';

/** Validates `chorus.set_coordination_mode` input without touching the database. */
export function parseCoordinationModeChange(input: unknown): {
  readonly sessionId: Uuid;
  readonly expectedVersion: number;
  readonly mode: CoordinationMode;
} {
  const raw = requireObject(input, ['session_id', 'expected_version', 'mode']);
  return {
    sessionId: requireUuid(raw['session_id'], 'session_id'),
    expectedVersion: requireInteger(raw['expected_version'], 'expected_version', 1),
    mode: requireEnum(raw['mode'], 'mode', ['off', 'observe', 'assist']),
  };
}

/**
 * A session's current coordination mode and version, for pricing a mode change. Only its administrator may
 * ask: a non-member gets `not_found`, and a member who does not administer it `action_forbidden`, before
 * anything is quoted.
 */
export async function coordinationModeOf(
  read: ReadContext,
  sessionId: Uuid,
): Promise<{ readonly mode: CoordinationMode; readonly version: number }> {
  return withReadTx(read, async (db) => {
    const { rows } = await db.query<{
      roles: string[] | null;
      mode: CoordinationMode | null;
      version: number | null;
    }>(
      `SELECT chorus_session_roles($2) AS roles, s.coordination_mode AS mode, s.version
         FROM (SELECT 1) one
         LEFT JOIN sessions s ON s.workspace_id = $1 AND s.id = $2`,
      [read.workspaceId, sessionId],
    );
    const row = rows[0];
    if (
      row?.roles === null ||
      row?.roles === undefined ||
      row.mode === null ||
      row.version === null
    )
      throw new ChorusError('not_found', 'Not found.');
    requireAction({ roles: row.roles as SessionRole[] }, 'administer');
    return { mode: row.mode, version: row.version };
  });
}

/**
 * Sets the coordination mode inside an existing command transaction whose session is locked at the caller's
 * expected version (a paid delivery). `guard` sees the mode as it is NOW, under the lock, and may refuse.
 */
export async function setCoordinationModeInTx(
  tx: CommandTx,
  args: {
    readonly sessionId: Uuid;
    readonly mode: CoordinationMode;
    readonly guard: (current: CoordinationMode) => void;
  },
): Promise<{ result: PolicyChanged; events: DomainEventDraft[] }> {
  requireAction(tx, 'administer');
  const { rows } = await tx.db.query<{ mode: CoordinationMode }>(
    'SELECT coordination_mode AS mode FROM sessions WHERE workspace_id = $1 AND id = $2',
    [tx.workspaceId, args.sessionId],
  );
  const current = rows[0]?.mode;
  if (current === undefined) throw new ChorusError('not_found', 'Not found.');
  args.guard(current);
  return applyPolicyChangesInTx(tx, args.sessionId, { coordination_mode: args.mode });
}

/** Live administrators, by the one definition of "live" (session member + room member + active room). */
async function liveAdministrators(tx: CommandTx): Promise<Uuid[]> {
  const { rows } = await tx.db.query<{ actor_id: Uuid }>(
    `SELECT actor_id FROM chorus_session_live_members($1) WHERE 'administrator' = ANY (roles)`,
    [requireSession(tx).id],
  );
  return rows.map((r) => r.actor_id);
}

/** The database refuses to leave a session without a live administrator (CH005); surface it as the domain error. */
async function lastAdministratorGuard<T>(query: Promise<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    if ((error as { code?: string }).code === 'CH005') throw lastAdministrator();
    throw error;
  }
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

/**
 * The target's membership. `live` requires the full live-member definition (grant/revoke targets); the
 * loose form finds any open session membership so an administrator can still remove someone who has
 * already left the room.
 */
async function memberRow(
  tx: CommandTx,
  actorId: Uuid,
  live: boolean,
): Promise<{ roles: SessionRole[] }> {
  const { rows } = await tx.db.query<{ roles: SessionRole[] }>(
    live
      ? 'SELECT roles FROM chorus_session_live_members($1) WHERE actor_id = $2'
      : `SELECT roles FROM session_members
          WHERE workspace_id = $3 AND session_id = $1 AND actor_id = $2 AND removed_at IS NULL`,
    live ? [requireSession(tx).id, actorId] : [requireSession(tx).id, actorId, tx.workspaceId],
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
        const member = await memberRow(tx, actorId, true);
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
        if (
          kind === 'revoke' &&
          role === 'administrator' &&
          (await liveAdministrators(tx)).length <= 1
        ) {
          throw lastAdministrator();
        }
        const roles =
          kind === 'grant' ? [...member.roles, role] : member.roles.filter((r) => r !== role);
        const changed = await lastAdministratorGuard(
          tx.db.query<{ session_version: number }>(
            'SELECT session_version FROM chorus_session_set_roles($1, $2, $3::text[])',
            [sessionId, actorId, roles],
          ),
        );
        const session_version = changed.rows[0]?.session_version;
        if (session_version === undefined) throw new ChorusError('not_found', 'Not found.');
        const version = tx.recordSessionVersion(session_version);
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
        await lastAdministratorGuard(
          tx.db.query('SELECT chorus_session_remove_member($1, $2)', [sessionId, target]),
        );
      },
      handle: async (tx) => {
        const session = requireSession(tx);
        const member = await memberRow(tx, target, false);
        if (member.roles.includes('administrator')) {
          const admins = await liveAdministrators(tx);
          // Only a LIVE administrator counts toward, and can be, the last one.
          if (admins.includes(target) && admins.length <= 1) throw lastAdministrator();
        }
        const effects = await removalEffects(tx, target);
        // Verifies the caller (an administrator, or the member themself) and bumps the session version;
        // the membership row itself is closed last, in `finalize`.
        const begun = await tx.db.query<{ version: number }>(
          'SELECT chorus_session_removal_begin($1, $2) AS version',
          [sessionId, target],
        );
        const version = tx.recordSessionVersion(begun.rows[0]?.version ?? 0);
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
