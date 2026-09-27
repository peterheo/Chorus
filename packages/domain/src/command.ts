import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Queryable } from './authz.ts';
import { resolveLeaseDurationSeconds } from './config.ts';
import { ChorusError } from './errors.ts';
import { sortedUniqueUuids, type Uuid } from './ids.ts';

/**
 * The only way to mutate canonical state (standards §3.1). Implements the design §9.1 transaction:
 *
 *   begin → transaction-local context → lock idempotency record → graph lock (if gated) →
 *   lock target rows in sorted UUID order → authorize against current grants → check expected
 *   versions → handler writes rows and bumps versions → append domain events → store response → commit
 *
 * A replay of a committed command re-runs `authorize` against CURRENT grants before returning the stored
 * response, so a revoked grant cannot retrieve an old protected result through the replay path.
 * A failed command rolls back completely, including its idempotency record, so a retry with the same
 * key re-executes. No network calls may happen inside `authorize` or `handle`.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

export interface CommandContext {
  readonly pool: pg.Pool;
  readonly workspaceId: Uuid;
  readonly actorId: Uuid;
  /** The agent instance bound to the caller's API token; null for human/service actors. Set by the caller layer. */
  readonly instanceId: Uuid | null;
  /** The room this caller's token is scoped to (room-level commands act on it). Set by the caller layer. */
  readonly roomId?: Uuid;
  /** Lease length for claim/renew, in seconds. Default {@link DEFAULT_LEASE_DURATION_SECONDS}. */
  readonly leaseDurationSeconds?: number;
  /** `Idempotency-Key` (REST) or the explicit MCP argument. Required on every mutation. */
  readonly idempotencyKey: string | undefined;
}

export type WorkItemKind = 'task' | 'review' | 'question' | 'finding' | 'proposal';
export type SessionRole = 'participant' | 'manager' | 'administrator';

export interface LockedWorkItem {
  readonly id: Uuid;
  readonly kind: WorkItemKind;
  readonly state: string;
  readonly version: number;
  readonly homeRoomId: Uuid;
  readonly sessionId: Uuid;
  readonly boardId: Uuid;
  readonly creatorActorId: Uuid;
  readonly ownerActorId: Uuid | null;
  readonly blockedAt: Date | null;
  readonly workCycle: number;
}

/** The session a command runs in, as read (and optionally locked) inside the transaction. */
export interface SessionFacts {
  readonly id: Uuid;
  readonly roomId: Uuid;
  readonly version: number;
  readonly joinPolicy: string;
  readonly defaultClaimPolicy: string;
  readonly managerReviewAllowed: boolean;
  readonly defaultReviewRequired: boolean;
  readonly state: string;
}

/** An existing work item the command mutates, with the version the caller last saw. */
export interface CommandTarget {
  readonly id: Uuid;
  /** Required unless `lockOnly`. */
  readonly expectedVersion?: number | undefined;
  /** Locked in the same sorted pass but exempt from the version check (it may still be bumped by the handler). */
  readonly lockOnly?: boolean;
  /** When set, a target of another kind is indistinguishable from a missing one: `not_found`. */
  readonly kind?: WorkItemKind;
}

export interface DomainEventDraft {
  readonly roomId: Uuid;
  readonly aggregateId: Uuid;
  readonly aggregateVersion: number;
  /** `work_item` (default) or `session`; the aggregate must exist, in `roomId`, inside the transaction. */
  readonly aggregateType?: 'work_item' | 'session';
  readonly eventType: string;
  /** The versioned delta only; never credentials or unbounded content. */
  readonly payload?: { readonly [key: string]: JsonValue | undefined };
}

export interface CommandTx {
  /** The transaction's connection. Parameterized SQL only. */
  readonly db: Queryable;
  readonly workspaceId: Uuid;
  readonly actorId: Uuid;
  readonly commandId: Uuid;
  /** The caller's agent instance (from the API token), or null. */
  readonly instanceId: Uuid | null;
  /** The caller's token room, when set. */
  readonly roomId: Uuid | undefined;
  /** Resolved lease length in seconds; the single source for claim and renew. */
  readonly leaseDurationSeconds: number;
  /** The command's session (session-scoped commands only). */
  readonly session: SessionFacts | undefined;
  /** The caller's live roles in `session` (empty for room-level commands). */
  readonly roles: readonly SessionRole[];
  /** Rows locked FOR UPDATE for `targets`, keyed by id. */
  readonly items: ReadonlyMap<Uuid, LockedWorkItem>;
  /** Increments a locked item's version and returns the new one; the handler must emit a matching event. */
  bumpVersion: (itemId: Uuid) => Promise<number>;
  /**
   * Registers the session version a session-administration definer just produced (the definers bump it
   * internally; chorus_app cannot bump it directly). The handler must emit a matching event.
   */
  recordSessionVersion: (version: number) => number;
}

/** A command result must be a non-null JSON value: a stored `null` would be indistinguishable from "no response". */
export type CommandResult = Exclude<JsonValue, null>;

export interface CommandSpec<TResult extends CommandResult> {
  /** Dotted command name, e.g. `task.create`. Part of the request hash. */
  readonly type: string;
  /** The caller's input, canonicalized into the request hash. Must be JSON-serializable. */
  readonly input: JsonValue;
  /** Takes the workspace graph lock first: claim, complete, dependencies, blockers. */
  readonly gated?: boolean;
  /**
   * Session-scoped command: the caller must be a live member (else `not_found`), targets must belong to
   * the session, idempotency is scoped to it, and `lock` takes the session row FOR UPDATE (before the
   * targets). `expectedVersion` is checked against the session's version.
   */
  readonly session?: {
    readonly id: Uuid;
    readonly lock?: boolean;
    readonly expectedVersion?: number;
  };
  readonly targets?: readonly CommandTarget[];
  /** Runs after the rows are locked and before any version check. Throw `not_found`/`action_forbidden`. */
  readonly authorize: (tx: CommandTx) => Promise<void>;
  /**
   * Runs after the events are journaled and before the response is stored. For changes that end the
   * caller's own visibility (leaving a session): journaling must still happen while they can see it.
   */
  readonly finalize?: (tx: CommandTx) => Promise<void>;
  /**
   * Replay-only authorization, when a fresh call's `authorize` cannot apply to a replay (e.g. join). It also
   * receives the stored response, so a command whose result names a session can re-check membership of it.
   * Default: `authorize`.
   */
  readonly replayAuthorize?: (tx: CommandTx, stored: TResult) => Promise<void>;
  readonly handle: (tx: CommandTx) => Promise<{
    readonly result: TResult;
    readonly events: readonly DomainEventDraft[];
    /** True when the command legitimately changed nothing (an idempotent no-op): zero events are then allowed. */
    readonly noop?: boolean;
  }>;
}

const MAX_RETRIES = 3;
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

export async function runCommand<TResult extends CommandResult>(
  ctx: CommandContext,
  spec: CommandSpec<TResult>,
): Promise<TResult> {
  const key = ctx.idempotencyKey;
  if (key === undefined || key === '') {
    throw new ChorusError('precondition_required', 'An idempotency key is required.', {
      details: { missing: 'idempotency_key' },
    });
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ChorusError(
      'invalid_request',
      'The idempotency key must be 1-200 printable ASCII characters.',
    );
  }

  const requestHash = hashRequest(spec);
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(ctx, key, requestHash, spec);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      if (attempt >= MAX_RETRIES) {
        throw new ChorusError(
          'temporarily_unavailable',
          'The command could not complete because of contention. Retry with the same idempotency key.',
          { cause: error },
        );
      }
      await delay(retryDelayMs(attempt));
    }
  }
}

async function runOnce<TResult extends CommandResult>(
  ctx: CommandContext,
  key: string,
  requestHash: string,
  spec: CommandSpec<TResult>,
): Promise<TResult> {
  const client = await ctx.pool.connect();
  let result: TResult;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    result = await executeInTransaction(client, ctx, key, requestHash, spec);
    await client.query('COMMIT');
  } catch (error) {
    // If the connection is gone, ROLLBACK fails too; the original error is the one worth reporting,
    // and the dead connection is discarded rather than returned to the pool.
    let broken = false;
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    client.release(broken ? true : undefined);
    throw error;
  }
  client.release();
  return result;
}

interface CommandRow {
  id: Uuid;
  request_hash: string;
  status: 'in_progress' | 'succeeded';
  response: JsonValue | null;
}

async function executeInTransaction<TResult extends CommandResult>(
  client: pg.PoolClient,
  ctx: CommandContext,
  key: string,
  requestHash: string,
  spec: CommandSpec<TResult>,
): Promise<TResult> {
  const { workspaceId, actorId } = ctx;
  const scopeKey = spec.session === undefined ? 'room' : spec.session.id;

  await setTransactionContext(client, workspaceId, actorId);

  const actor = await client.query('SELECT 1 FROM actors WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    actorId,
  ]);
  if (actor.rowCount === 0) {
    throw new ChorusError('unauthenticated', 'The acting identity is not recognized.');
  }

  // Insert-or-lock the idempotency record (scoped to workspace + actor + session-or-room + key). ON
  // CONFLICT waits for a concurrent same-key transaction to finish, so a duplicate either replays its
  // committed response or takes over after a rollback.
  const inserted = await client.query<{ id: Uuid }>(
    `INSERT INTO commands
       (workspace_id, actor_id, idempotency_key, request_hash, command_type, status, session_id, scope_key)
     VALUES ($1, $2, $3, $4, $5, 'in_progress', NULL, $6)
     ON CONFLICT (workspace_id, actor_id, scope_key, idempotency_key) DO NOTHING
     RETURNING id`,
    [workspaceId, actorId, key, requestHash, spec.type, scopeKey],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId === undefined) {
    const existing = await client.query<CommandRow>(
      `SELECT id, request_hash, status, response FROM commands
        WHERE workspace_id = $1 AND actor_id = $2 AND scope_key = $3 AND idempotency_key = $4 FOR UPDATE`,
      [workspaceId, actorId, scopeKey, key],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      throw new ChorusError('internal_error', 'Idempotency record vanished during lookup.');
    }
    if (row.request_hash !== requestHash) {
      throw new ChorusError(
        'idempotency_conflict',
        'This idempotency key was already used with a different request.',
      );
    }
    if (row.status !== 'succeeded' || row.response === null) {
      // A committed command row is always succeeded with a response. Anything else is corruption or a
      // bug; never fall through and run the handler a second time.
      throw new ChorusError('internal_error', 'Idempotency record is not in a replayable state.');
    }
    {
      // Repeat-safe, but not authority-free: re-authorize against the CURRENT session membership and
      // roles, and fail exactly as a fresh call would, without returning the stored body.
      const replaySession = await loadSession(client, spec.session, 'none');
      const replayItems = await loadTargets(
        client,
        workspaceId,
        spec.targets ?? [],
        false,
        spec.session?.id,
      );
      const replayTx: CommandTx = {
        db: client,
        workspaceId,
        actorId,
        commandId: row.id,
        instanceId: ctx.instanceId,
        roomId: ctx.roomId,
        leaseDurationSeconds: resolveLeaseDurationSeconds(ctx.leaseDurationSeconds),
        session: replaySession?.session,
        roles: replaySession?.roles ?? [],
        items: replayItems,
        bumpVersion: () => {
          throw new ChorusError('internal_error', 'authorize must not change versions.');
        },
        recordSessionVersion: () => {
          throw new ChorusError('internal_error', 'authorize must not change versions.');
        },
      };
      if (spec.replayAuthorize !== undefined) {
        await spec.replayAuthorize(replayTx, row.response as TResult);
      } else {
        await spec.authorize(replayTx);
      }
      return row.response as TResult;
    }
  }

  // Every path that left `insertedId` undefined has already replayed or thrown.
  const commandId: Uuid = insertedId;
  if (spec.gated === true) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `chorus:graph:${workspaceId}`,
    ]);
  }

  // Lock order: graph lock -> session row -> target items in sorted UUID order.
  const sessionInfo = await loadSession(
    client,
    spec.session,
    spec.session?.lock === true ? 'update' : 'share',
  );
  if (spec.session !== undefined) {
    // Recorded only after the caller proved membership, so an unknown session is a plain not_found.
    await client.query('UPDATE commands SET session_id = $2 WHERE id = $1', [
      commandId,
      spec.session.id,
    ]);
  }
  const items = await loadTargets(client, workspaceId, spec.targets ?? [], true, spec.session?.id);
  const bumped = new Map<Uuid, number>();
  const bumpedSessions = new Map<Uuid, number>();
  const tx: CommandTx = {
    db: client,
    workspaceId,
    actorId,
    commandId,
    instanceId: ctx.instanceId,
    roomId: ctx.roomId,
    leaseDurationSeconds: resolveLeaseDurationSeconds(ctx.leaseDurationSeconds),
    session: sessionInfo?.session,
    roles: sessionInfo?.roles ?? [],
    items,
    bumpVersion: async (itemId) => {
      if (!items.has(itemId)) {
        throw new ChorusError(
          'internal_error',
          'bumpVersion called on an item that is not a locked target.',
        );
      }
      const updated = await client.query<{ version: number }>(
        `UPDATE work_items SET version = version + 1, updated_at = now()
          WHERE workspace_id = $1 AND id = $2 RETURNING version`,
        [workspaceId, itemId],
      );
      const version = updated.rows[0]?.version;
      if (version === undefined)
        throw new ChorusError('internal_error', 'Locked item disappeared.');
      bumped.set(itemId, version);
      return version;
    },
    recordSessionVersion: (version) => {
      if (sessionInfo === undefined || spec.session?.lock !== true) {
        throw new ChorusError('internal_error', 'recordSessionVersion requires a locked session.');
      }
      bumpedSessions.set(sessionInfo.session.id, version);
      return version;
    },
  };

  await spec.authorize(tx);
  if (
    spec.session?.expectedVersion !== undefined &&
    sessionInfo !== undefined &&
    spec.session.expectedVersion !== sessionInfo.session.version
  ) {
    throw new ChorusError('version_conflict', 'The session changed after the supplied version.', {
      details: { session_id: sessionInfo.session.id, current_version: sessionInfo.session.version },
    });
  }
  checkExpectedVersions(spec.targets ?? [], items);

  const { result, events, noop } = await spec.handle(tx);
  if ((result as unknown) === null || (result as unknown) === undefined) {
    throw new ChorusError('internal_error', 'A command result must be a non-null JSON value.');
  }
  if (noop === true && events.length === 0) {
    if (bumped.size > 0 || bumpedSessions.size > 0) {
      throw new ChorusError('internal_error', 'A no-op command must not change versions.');
    }
  } else {
    assertJournaled(events, bumped, bumpedSessions);
    await appendEvents(client, tx, events);
  }
  await spec.finalize?.(tx);

  const stored = await client.query<{ response: TResult }>(
    `UPDATE commands SET status = 'succeeded', response = $2::jsonb, completed_at = now()
      WHERE id = $1 RETURNING response`,
    [commandId, JSON.stringify(result)],
  );
  const response = stored.rows[0]?.response;
  if (response === undefined)
    throw new ChorusError('internal_error', 'Command response was not stored.');
  return response;
}

/**
 * Locks the session row and only then reads the caller's roles (both inside `chorus_session_lock`), so a
 * command that waited for the lock authorizes against the roles that are current once it proceeds. A
 * caller that is not a live member of a live room membership gets `not_found`: session membership is the
 * visibility rule, and a discoverable session is still invisible to non-members for every command except
 * join. Modes: `update` for session administration, `share` for ordinary session-scoped commands, and
 * `none` for a replay's read-only re-authorization.
 */
async function loadSession(
  client: pg.PoolClient,
  target: CommandSpec<CommandResult>['session'],
  mode: 'none' | 'share' | 'update',
): Promise<{ session: SessionFacts; roles: SessionRole[] } | undefined> {
  if (target === undefined) return undefined;
  const { rows } = await client.query<{
    id: Uuid;
    room_id: Uuid;
    version: number;
    join_policy: string;
    default_claim_policy: string;
    manager_review_allowed: boolean;
    default_review_required: boolean;
    state: string;
    roles: SessionRole[];
  }>('SELECT * FROM chorus_session_lock($1, $2)', [target.id, mode]);
  const row = rows[0];
  if (row === undefined) throw new ChorusError('not_found', 'Not found.');
  return {
    roles: row.roles,
    session: {
      id: row.id,
      roomId: row.room_id,
      version: row.version,
      joinPolicy: row.join_policy,
      defaultClaimPolicy: row.default_claim_policy,
      managerReviewAllowed: row.manager_review_allowed,
      defaultReviewRequired: row.default_review_required,
      state: row.state,
    },
  };
}

/** Loads the target rows, locking them FOR UPDATE in sorted UUID order when `lock` is true. */
async function loadTargets(
  client: pg.PoolClient,
  workspaceId: Uuid,
  targets: readonly CommandTarget[],
  lock: boolean,
  sessionId: Uuid | undefined,
): Promise<Map<Uuid, LockedWorkItem>> {
  const ids = sortedUniqueUuids(targets.map((t) => t.id));
  const items = new Map<Uuid, LockedWorkItem>();
  if (ids.length === 0) return items;

  const { rows } = await client.query<{
    id: Uuid;
    kind: WorkItemKind;
    state: string;
    version: number;
    home_room_id: Uuid;
    session_id: Uuid;
    board_id: Uuid;
    creator_actor_id: Uuid;
    owner_actor_id: Uuid | null;
    blocked_at: Date | null;
    work_cycle: number;
  }>(
    `SELECT id, kind, state, version, home_room_id, session_id, board_id, creator_actor_id,
            owner_actor_id, blocked_at, work_cycle
       FROM work_items
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id${lock ? '\n      FOR UPDATE' : ''}`,
    [workspaceId, ids],
  );
  for (const r of rows) {
    items.set(r.id, {
      id: r.id,
      kind: r.kind,
      state: r.state,
      version: r.version,
      homeRoomId: r.home_room_id,
      sessionId: r.session_id,
      boardId: r.board_id,
      creatorActorId: r.creator_actor_id,
      ownerActorId: r.owner_actor_id,
      blockedAt: r.blocked_at,
      workCycle: r.work_cycle,
    });
  }
  // Missing ids are indistinguishable from other workspaces' ids (and RLS-hidden rows): not found.
  if (items.size !== ids.length) throw new ChorusError('not_found', 'Not found.');
  // So is an item of the wrong kind, or one that lives in a different session than the command's.
  for (const target of targets) {
    const item = items.get(target.id);
    if (target.kind !== undefined && item?.kind !== target.kind) {
      throw new ChorusError('not_found', 'Not found.');
    }
    if (sessionId !== undefined && item?.sessionId !== sessionId) {
      throw new ChorusError('not_found', 'Not found.');
    }
  }
  return items;
}

function checkExpectedVersions(
  targets: readonly CommandTarget[],
  items: ReadonlyMap<Uuid, LockedWorkItem>,
): void {
  for (const target of targets) {
    if (target.lockOnly === true) continue;
    const current = items.get(target.id)?.version;
    if (current === undefined) continue; // lockTargets already guaranteed presence
    if (target.expectedVersion === undefined) {
      throw new ChorusError('precondition_required', 'The expected version is required.', {
        details: { item_id: target.id, current_version: current },
      });
    }
    if (target.expectedVersion !== current) {
      throw new ChorusError('version_conflict', 'The item changed after the supplied version.', {
        details: { item_id: target.id, current_version: current },
      });
    }
  }
}

function assertJournaled(
  events: readonly DomainEventDraft[],
  bumped: ReadonlyMap<Uuid, number>,
  bumpedSessions: ReadonlyMap<Uuid, number>,
): void {
  if (events.length === 0) {
    throw new ChorusError('internal_error', 'A command must append at least one domain event.');
  }
  const check = (id: Uuid, version: number, type: 'work_item' | 'session') => {
    const journaled = events.some(
      (e) =>
        e.aggregateId === id &&
        e.aggregateVersion === version &&
        (e.aggregateType ?? 'work_item') === type,
    );
    if (!journaled) {
      throw new ChorusError('internal_error', 'A version bump has no matching domain event.', {
        details: { aggregate_id: id, aggregate_version: version },
      });
    }
  };
  for (const [itemId, version] of bumped) check(itemId, version, 'work_item');
  for (const [sessionId, version] of bumpedSessions) check(sessionId, version, 'session');
}

/**
 * An event's room (and session) must be its aggregate's own, checked here inside the transaction rather
 * than trusted from the handler: otherwise an actor acting in two rooms or sessions could journal an
 * event of one under the other and expose it to the wrong members. Returns the session for each event.
 */
async function resolveEventScopes(
  client: pg.PoolClient,
  tx: CommandTx,
  events: readonly DomainEventDraft[],
): Promise<Map<DomainEventDraft, Uuid>> {
  const itemIds = sortedUniqueUuids(
    events
      .filter((e) => (e.aggregateType ?? 'work_item') === 'work_item')
      .map((e) => e.aggregateId),
  );
  const sessionIds = sortedUniqueUuids(
    events.filter((e) => e.aggregateType === 'session').map((e) => e.aggregateId),
  );
  const items = new Map<Uuid, { room: Uuid; session: Uuid }>();
  if (itemIds.length > 0) {
    const { rows } = await client.query<{ id: Uuid; home_room_id: Uuid; session_id: Uuid }>(
      'SELECT id, home_room_id, session_id FROM work_items WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [tx.workspaceId, itemIds],
    );
    for (const r of rows) items.set(r.id, { room: r.home_room_id, session: r.session_id });
  }
  const sessions = new Map<Uuid, { room: Uuid; session: Uuid }>();
  if (sessionIds.length > 0) {
    const { rows } = await client.query<{ id: Uuid; room_id: Uuid }>(
      'SELECT id, room_id FROM sessions WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [tx.workspaceId, sessionIds],
    );
    for (const r of rows) sessions.set(r.id, { room: r.room_id, session: r.id });
  }
  const scopes = new Map<DomainEventDraft, Uuid>();
  for (const event of events) {
    const known = (event.aggregateType === 'session' ? sessions : items).get(event.aggregateId);
    if (known === undefined || known.room !== event.roomId) {
      throw new ChorusError(
        'internal_error',
        "An event must be journaled in its aggregate's own room.",
        { details: { aggregate_id: event.aggregateId, event_type: event.eventType } },
      );
    }
    scopes.set(event, known.session);
  }
  return scopes;
}

async function appendEvents(
  client: pg.PoolClient,
  tx: CommandTx,
  events: readonly DomainEventDraft[],
): Promise<void> {
  const scopes = await resolveEventScopes(client, tx, events);
  for (const event of events) {
    await client.query(
      `INSERT INTO domain_events
         (workspace_id, room_id, session_id, aggregate_id, aggregate_version, event_type, actor_id,
          command_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        tx.workspaceId,
        event.roomId,
        scopes.get(event),
        event.aggregateId,
        event.aggregateVersion,
        event.eventType,
        tx.actorId,
        tx.commandId,
        JSON.stringify(event.payload ?? {}),
      ],
    );
  }
}

/**
 * Transaction-local identity for the RLS policies. `is_local = true` scopes it to the transaction, so
 * it can never leak to the next user of a pooled connection.
 */
async function setTransactionContext(
  client: pg.PoolClient,
  workspaceId: Uuid,
  actorId: Uuid,
): Promise<void> {
  await client.query(
    `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
    [workspaceId, actorId],
  );
}

export interface ReadContext {
  readonly pool: pg.Pool;
  readonly workspaceId: Uuid;
  readonly actorId: Uuid;
}

/**
 * Runs read-only queries in one consistent snapshot with the actor's RLS context set. Every read path
 * (MCP tools, evidence pages) goes through this so tenant and room isolation apply to reads too.
 */
export async function withReadTx<T>(
  ctx: ReadContext,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await ctx.pool.connect();
  let result: T;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await setTransactionContext(client, ctx.workspaceId, ctx.actorId);
    result = await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    let broken = false;
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    client.release(broken ? true : undefined);
    throw error;
  }
  client.release();
  return result;
}

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

const retryDelayMs = (attempt: number) => 5 * 2 ** attempt + Math.random() * 10;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** JSON with object keys sorted recursively, so equal inputs hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Cannot canonicalize a value of type ${typeof value}.`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Cannot canonicalize a non-finite number.');
  }
  return value;
}

/** Hash of the canonical command type, targets with preconditions, and input (design §11.3). */
export function hashRequest(spec: {
  readonly type: string;
  readonly input: JsonValue;
  readonly targets?: readonly CommandTarget[] | undefined;
  readonly session?: { readonly id: Uuid } | undefined;
}): string {
  const targets = [...(spec.targets ?? [])]
    .map((t) => ({
      id: t.id,
      expected_version: t.expectedVersion ?? null,
      lock_only: t.lockOnly === true,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256')
    .update(
      canonicalJson({
        type: spec.type,
        session: spec.session?.id ?? null,
        targets,
        input: spec.input,
      }),
      'utf8',
    )
    .digest('hex');
}
