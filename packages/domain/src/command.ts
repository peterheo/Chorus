import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Queryable } from './authz.ts';
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
  /** `Idempotency-Key` (REST) or the explicit MCP argument. Required on every mutation. */
  readonly idempotencyKey: string | undefined;
}

export type WorkItemKind = 'task' | 'review';

export interface LockedWorkItem {
  readonly id: Uuid;
  readonly kind: WorkItemKind;
  readonly state: string;
  readonly version: number;
  readonly homeRoomId: Uuid;
  readonly creatorActorId: Uuid;
  readonly ownerActorId: Uuid | null;
}

/** An existing work item the command mutates, with the version the caller last saw. */
export interface CommandTarget {
  readonly id: Uuid;
  readonly expectedVersion?: number | undefined;
}

export interface DomainEventDraft {
  readonly roomId: Uuid;
  readonly aggregateId: Uuid;
  readonly aggregateVersion: number;
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
  /** Rows locked FOR UPDATE for `targets`, keyed by id. */
  readonly items: ReadonlyMap<Uuid, LockedWorkItem>;
  /** Increments a locked item's version and returns the new one; the handler must emit a matching event. */
  bumpVersion: (itemId: Uuid) => Promise<number>;
}

export interface CommandSpec<TResult extends JsonValue> {
  /** Dotted command name, e.g. `task.create`. Part of the request hash. */
  readonly type: string;
  /** The caller's input, canonicalized into the request hash. Must be JSON-serializable. */
  readonly input: JsonValue;
  /** Takes the workspace graph lock first: claim, complete, dependencies, blockers. */
  readonly gated?: boolean;
  readonly targets?: readonly CommandTarget[];
  /** Runs after the rows are locked and before any version check. Throw `not_found`/`action_forbidden`. */
  readonly authorize: (tx: CommandTx) => Promise<void>;
  readonly handle: (
    tx: CommandTx,
  ) => Promise<{ readonly result: TResult; readonly events: readonly DomainEventDraft[] }>;
}

const MAX_RETRIES = 3;
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

export async function runCommand<TResult extends JsonValue>(
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

async function runOnce<TResult extends JsonValue>(
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

async function executeInTransaction<TResult extends JsonValue>(
  client: pg.PoolClient,
  ctx: CommandContext,
  key: string,
  requestHash: string,
  spec: CommandSpec<TResult>,
): Promise<TResult> {
  const { workspaceId, actorId } = ctx;

  await setTransactionContext(client, workspaceId, actorId);

  const actor = await client.query('SELECT 1 FROM actors WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    actorId,
  ]);
  if (actor.rowCount === 0) {
    throw new ChorusError('unauthenticated', 'The acting identity is not recognized.');
  }

  // Insert-or-lock the idempotency record. ON CONFLICT waits for a concurrent same-key transaction
  // to finish, so a duplicate either replays its committed response or takes over after a rollback.
  const inserted = await client.query<{ id: Uuid }>(
    `INSERT INTO commands (workspace_id, actor_id, idempotency_key, request_hash, command_type, status)
     VALUES ($1, $2, $3, $4, $5, 'in_progress')
     ON CONFLICT (workspace_id, actor_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [workspaceId, actorId, key, requestHash, spec.type],
  );
  let commandId = inserted.rows[0]?.id;
  if (commandId === undefined) {
    const existing = await client.query<CommandRow>(
      `SELECT id, request_hash, status, response FROM commands
        WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3 FOR UPDATE`,
      [workspaceId, actorId, key],
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
    if (row.status === 'succeeded' && row.response !== null) {
      // Repeat-safe, but not authority-free: re-authorize now, and fail exactly as a fresh call would.
      const replayItems = await loadTargets(client, workspaceId, spec.targets ?? [], false);
      await spec.authorize({
        db: client,
        workspaceId,
        actorId,
        commandId: row.id,
        items: replayItems,
        bumpVersion: () => {
          throw new ChorusError('internal_error', 'authorize must not change versions.');
        },
      });
      return row.response as TResult;
    }
    commandId = row.id; // Own uncommitted row: cannot occur for another session's in-flight command.
  }

  if (spec.gated === true) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `chorus:graph:${workspaceId}`,
    ]);
  }

  const items = await loadTargets(client, workspaceId, spec.targets ?? [], true);
  const bumped = new Map<Uuid, number>();
  const tx: CommandTx = {
    db: client,
    workspaceId,
    actorId,
    commandId,
    items,
    bumpVersion: async (itemId) => {
      const locked = items.get(itemId);
      if (locked === undefined) {
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
  };

  await spec.authorize(tx);
  checkExpectedVersions(spec.targets ?? [], items);

  const { result, events } = await spec.handle(tx);
  assertJournaled(events, bumped);
  await appendEvents(client, tx, events);

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

/** Loads the target rows, locking them FOR UPDATE in sorted UUID order when `lock` is true. */
async function loadTargets(
  client: pg.PoolClient,
  workspaceId: Uuid,
  targets: readonly CommandTarget[],
  lock: boolean,
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
    creator_actor_id: Uuid;
    owner_actor_id: Uuid | null;
  }>(
    `SELECT id, kind, state, version, home_room_id, creator_actor_id, owner_actor_id
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
      creatorActorId: r.creator_actor_id,
      ownerActorId: r.owner_actor_id,
    });
  }
  // Missing ids are indistinguishable from other workspaces' ids (and RLS-hidden rows): not found.
  if (items.size !== ids.length) throw new ChorusError('not_found', 'Not found.');
  return items;
}

function checkExpectedVersions(
  targets: readonly CommandTarget[],
  items: ReadonlyMap<Uuid, LockedWorkItem>,
): void {
  for (const target of targets) {
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
): void {
  if (events.length === 0) {
    throw new ChorusError('internal_error', 'A command must append at least one domain event.');
  }
  for (const [itemId, version] of bumped) {
    const journaled = events.some(
      (e) => e.aggregateId === itemId && e.aggregateVersion === version,
    );
    if (!journaled) {
      throw new ChorusError('internal_error', 'A version bump has no matching domain event.', {
        details: { aggregate_id: itemId, aggregate_version: version },
      });
    }
  }
}

async function appendEvents(
  client: pg.PoolClient,
  tx: CommandTx,
  events: readonly DomainEventDraft[],
): Promise<void> {
  for (const event of events) {
    await client.query(
      `INSERT INTO domain_events
         (workspace_id, room_id, aggregate_id, aggregate_version, event_type, actor_id, command_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        tx.workspaceId,
        event.roomId,
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
}): string {
  const targets = [...(spec.targets ?? [])]
    .map((t) => ({ id: t.id, expected_version: t.expectedVersion ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256')
    .update(canonicalJson({ type: spec.type, targets, input: spec.input }), 'utf8')
    .digest('hex');
}
