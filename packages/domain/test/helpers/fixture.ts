import pg from 'pg';
import { createMigratedEphemeralDatabase, type EphemeralDatabase } from '@chorus/database/testing';
import {
  requireAction,
  type CommandContext,
  type CommandSpec,
  type SessionAction,
  type Uuid,
} from '../../src/index.ts';

/** A workspace with one active room: the tenant and transport boundary. */
export interface Workspace {
  id: Uuid;
  roomId: Uuid;
}

export interface Actor {
  id: Uuid;
  instanceId: Uuid;
  ws: Workspace;
  /** Command context as this actor (its own instance), with an idempotency key. */
  ctx: (key?: string) => CommandContext;
}

export interface SessionSeed {
  id: Uuid;
  boardId: Uuid;
  roomId: Uuid;
  ws: Workspace;
}

export interface Fixture {
  db: EphemeralDatabase;
  pool: pg.Pool;
  /** Owner-side seeding and assertions (bypasses RLS). */
  owner: <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
  count: (sql: string, params?: unknown[]) => Promise<number>;
  workspace: (name: string) => Promise<Workspace>;
  /** An agent actor with an instance and (by default) live membership of the workspace's room. */
  actor: (ws: Workspace, label?: string, options?: { inRoom?: boolean }) => Promise<Actor>;
  /** A session created the way `create_session` would: creator = participant+manager+administrator, plus board 1. */
  session: (
    creator: Actor,
    options?: {
      name?: string;
      discoverable?: boolean;
      joinPolicy?: string;
      listed?: string[];
      managerReview?: boolean;
      reviewRequired?: boolean;
    },
  ) => Promise<SessionSeed>;
  /** Adds (or re-adds) a live session member with the given roles. */
  join: (session: SessionSeed, actor: Actor, roles?: string[]) => Promise<void>;
  addRoom: (ws: Workspace, name: string) => Promise<Workspace>;
  /** Read context (RLS applies) for an actor. */
  readCtx: (actor: Actor) => { pool: pg.Pool; workspaceId: Uuid; actorId: Uuid };
  ctxFor: (
    ws: Workspace,
    actorId: Uuid,
    key: string | undefined,
    instanceId?: Uuid | null,
  ) => CommandContext;
  close: () => Promise<void>;
}

let counter = 0;
const unique = (prefix: string) => `${prefix}${String(++counter)}`;

export async function createFixture(options: { poolMax?: number } = {}): Promise<Fixture> {
  const db = await createMigratedEphemeralDatabase();
  // The pool connects as the non-owner runtime role, so RLS applies to every command under test.
  const pool = new pg.Pool({ connectionString: db.appUrl, max: options.poolMax ?? 8 });
  // Dropping the database (WITH FORCE) can terminate idle pooled connections that are still closing;
  // that is expected at teardown and must not surface as an unhandled 'error' event.
  pool.on('error', () => undefined);

  const one = async <T extends string>(sql: string, params: unknown[]): Promise<T> => {
    const [row] = await db.query<{ id: T }>(sql, params);
    if (row === undefined) throw new Error('expected a row');
    return row.id;
  };
  const ctxFor: Fixture['ctxFor'] = (ws, actorId, key, instanceId = null) => ({
    pool,
    workspaceId: ws.id,
    actorId,
    instanceId,
    roomId: ws.roomId,
    idempotencyKey: key,
  });

  const fixture: Fixture = {
    db,
    pool,
    owner: (sql, params = []) => db.query(sql, params),
    count: async (sql, params = []) => {
      const [row] = await db.query<{ n: string }>(sql, params);
      return Number(row?.n ?? 0);
    },
    ctxFor,
    readCtx: (actor) => ({ pool, workspaceId: actor.ws.id, actorId: actor.id }),
    workspace: async (name) => {
      const id = await one<Uuid>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [name]);
      const roomId = await one<Uuid>(
        `INSERT INTO rooms (workspace_id, name, activation_state) VALUES ($1, $2, 'active') RETURNING id`,
        [id, `${name}-room`],
      );
      return { id, roomId };
    },
    addRoom: async (ws, name) => ({
      id: ws.id,
      roomId: await one<Uuid>(
        `INSERT INTO rooms (workspace_id, name, activation_state) VALUES ($1, $2, 'active') RETURNING id`,
        [ws.id, name],
      ),
    }),
    actor: async (ws, label = unique('agent'), options = {}) => {
      const id = await one<Uuid>(
        `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'agent', $2) RETURNING id`,
        [ws.id, label],
      );
      const instanceId = await one<Uuid>(
        `INSERT INTO agent_instances (workspace_id, actor_id, label) VALUES ($1, $2, 'test-instance') RETURNING id`,
        [ws.id, id],
      );
      if (options.inRoom !== false) {
        await db.query(
          'INSERT INTO room_members (workspace_id, room_id, actor_id) VALUES ($1, $2, $3)',
          [ws.id, ws.roomId, id],
        );
      }
      return { id, instanceId, ws, ctx: (key = unique('key')) => ctxFor(ws, id, key, instanceId) };
    },
    session: async (creator, options = {}) => {
      const ws = creator.ws;
      const id = await one<Uuid>(
        `INSERT INTO sessions (workspace_id, room_id, name, discoverable, join_policy, listed_principals,
                               manager_review_allowed, default_review_required, created_by, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2) RETURNING id`,
        [
          ws.id,
          ws.roomId,
          options.name ?? unique('session'),
          options.discoverable ?? true,
          options.joinPolicy ?? 'open',
          options.listed ?? [],
          options.managerReview ?? false,
          options.reviewRequired ?? true,
          creator.id,
        ],
      );
      await db.query(
        `INSERT INTO session_members (workspace_id, session_id, actor_id, roles)
         VALUES ($1, $2, $3, ARRAY['participant', 'manager', 'administrator'])`,
        [ws.id, id, creator.id],
      );
      const boardId = await one<Uuid>(
        'INSERT INTO projects (workspace_id, session_id, name) VALUES ($1, $2, $3) RETURNING id',
        [ws.id, id, 'Board 1'],
      );
      return { id, boardId, roomId: ws.roomId, ws };
    },
    join: async (session, actor, roles = ['participant']) => {
      await db.query(
        `INSERT INTO session_members (workspace_id, session_id, actor_id, roles)
         VALUES ($1, $2, $3, $4::text[])
         ON CONFLICT (workspace_id, session_id, actor_id)
         DO UPDATE SET roles = EXCLUDED.roles, removed_at = NULL`,
        [session.ws.id, session.id, actor.id, roles],
      );
    },
    close: async () => {
      await pool.end();
      await db.drop();
    },
  };
  return fixture;
}

export type Created = { item_id: string; version: number };

/**
 * Test command for the runCommand tests: creates a task-shaped item in a session, requiring `action`
 * (default create_item). Not a production command; it exercises locks, versions, journaling and replay.
 */
export function createItemCommand(args: {
  session: SessionSeed;
  title: string;
  action?: SessionAction;
  gated?: boolean;
  onHandle?: () => void | Promise<void>;
  emitEvents?: boolean;
  /** Journal the event under a different room than the item's own (must be rejected). */
  eventRoomId?: Uuid;
}): CommandSpec<Created> {
  return {
    type: 'test.create_item',
    session: { id: args.session.id },
    input: { session_id: args.session.id, title: args.title },
    gated: args.gated ?? false,
    authorize: (tx) => {
      requireAction(tx, args.action ?? 'create_item');
      return Promise.resolve();
    },
    handle: async (tx) => {
      await args.onHandle?.();
      const { rows } = await tx.db.query<{ id: Uuid }>(
        `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
         VALUES ($1, $2, $3, 'task', $4, $5, 'ready', $6) RETURNING id`,
        [
          tx.workspaceId,
          args.session.id,
          args.session.boardId,
          args.session.roomId,
          args.title,
          tx.actorId,
        ],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('insert returned no row');
      return {
        result: { item_id: id, version: 1 },
        events:
          args.emitEvents === false
            ? []
            : [
                {
                  roomId: args.eventRoomId ?? args.session.roomId,
                  aggregateId: id,
                  aggregateVersion: 1,
                  eventType: 'task.created',
                  payload: { title: args.title },
                },
              ],
      };
    },
  };
}

/** Test command: retitles an existing item, guarded by its expected version. */
export function retitleCommand(args: {
  session: SessionSeed;
  itemId: Uuid;
  expectedVersion: number | undefined;
  title: string;
  onHandle?: () => void | Promise<void>;
  skipEvent?: boolean;
}): CommandSpec<Created> {
  return {
    type: 'test.retitle',
    session: { id: args.session.id },
    input: { title: args.title },
    targets: [{ id: args.itemId, expectedVersion: args.expectedVersion }],
    authorize: (tx) => {
      requireAction(tx, 'create_item');
      return Promise.resolve();
    },
    handle: async (tx) => {
      await args.onHandle?.();
      const item = tx.items.get(args.itemId);
      if (item === undefined) throw new Error('target was not locked');
      await tx.db.query('UPDATE work_items SET title = $3 WHERE workspace_id = $1 AND id = $2', [
        tx.workspaceId,
        args.itemId,
        args.title,
      ]);
      const version = await tx.bumpVersion(args.itemId);
      return {
        result: { item_id: args.itemId, version },
        events: [
          {
            roomId: item.homeRoomId,
            aggregateId: args.itemId,
            aggregateVersion: args.skipEvent === true ? version + 100 : version,
            eventType: 'task.retitled',
            payload: args.skipEvent === true ? {} : { title: args.title },
          },
        ],
      };
    },
  };
}

/** A command whose handler wrongly returns null, as untyped code could. */
export function nullResultCommand(args: {
  session: SessionSeed;
  onHandle: () => void;
}): CommandSpec<Created> {
  const base = createItemCommand({ session: args.session, title: 'null-result' });
  return {
    ...base,
    type: 'test.null_result',
    handle: async (tx) => {
      args.onHandle();
      const done = await base.handle(tx);
      return { ...done, result: null as unknown as Created };
    },
  };
}
