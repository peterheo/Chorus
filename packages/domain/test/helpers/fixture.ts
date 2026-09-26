import pg from 'pg';
import { createMigratedEphemeralDatabase, type EphemeralDatabase } from '@chorus/database/testing';
import {
  requireRoomRole,
  type CommandContext,
  type CommandSpec,
  type Uuid,
} from '../../src/index.ts';

export interface Workspace {
  id: Uuid;
  roomId: Uuid;
  /** Agent with a live executor grant in `roomId`. */
  executorId: Uuid;
  /** A second executor, for idempotency-scope checks. */
  executor2Id: Uuid;
  /** Agent with only a reviewer grant. */
  reviewerId: Uuid;
  /** Actor in the workspace with no grant at all. */
  outsiderId: Uuid;
}

export interface Fixture {
  db: EphemeralDatabase;
  pool: pg.Pool;
  a: Workspace;
  b: Workspace;
  ctx: (
    workspace: Workspace,
    actorId: Uuid,
    key: string | undefined,
    instanceId?: Uuid | null,
  ) => CommandContext;
  count: (sql: string, params?: unknown[]) => Promise<number>;
  /** Owner-side seeding: a new agent in the workspace, optionally granted a role in a room. */
  addActor: (workspace: Workspace, grant?: { roomId: Uuid; role: string }) => Promise<Uuid>;
  addRoom: (workspace: Workspace, name: string) => Promise<Uuid>;
  /** Owner-side seeding: an agent instance for an actor (the per-token identity a claim uses). */
  addInstance: (workspace: Workspace, actorId: Uuid) => Promise<Uuid>;
  close: () => Promise<void>;
}

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

  async function seed(name: string): Promise<Workspace> {
    const id = await one<Uuid>('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [name]);
    const roomId = await one<Uuid>(
      'INSERT INTO rooms (workspace_id, name) VALUES ($1, $2) RETURNING id',
      [id, `${name}-room`],
    );
    const actor = (label: string) =>
      one<Uuid>(
        `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'agent', $2) RETURNING id`,
        [id, label],
      );
    const [executorId, executor2Id, reviewerId, outsiderId] = await Promise.all([
      actor('executor'),
      actor('executor2'),
      actor('reviewer'),
      actor('outsider'),
    ]);
    const grant = (actorId: Uuid, role: string) =>
      db.query(
        'INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, $4)',
        [id, actorId, roomId, role],
      );
    await grant(executorId, 'executor');
    await grant(executor2Id, 'executor');
    await grant(reviewerId, 'reviewer');
    return { id, roomId, executorId, executor2Id, reviewerId, outsiderId };
  }

  const a = await seed('a');
  const b = await seed('b');

  return {
    db,
    pool,
    a,
    b,
    ctx: (workspace, actorId, key, instanceId = null) => ({
      pool,
      workspaceId: workspace.id,
      actorId,
      instanceId,
      idempotencyKey: key,
    }),
    addActor: async (workspace, grant) => {
      const actorId = await one<Uuid>(
        `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'agent', 'added') RETURNING id`,
        [workspace.id],
      );
      if (grant !== undefined) {
        await db.query(
          'INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, $4)',
          [workspace.id, actorId, grant.roomId, grant.role],
        );
      }
      return actorId;
    },
    addInstance: (workspace, actorId) =>
      one<Uuid>(
        `INSERT INTO agent_instances (workspace_id, actor_id, label) VALUES ($1, $2, 'test-instance') RETURNING id`,
        [workspace.id, actorId],
      ),
    addRoom: (workspace, name) =>
      one<Uuid>('INSERT INTO rooms (workspace_id, name) VALUES ($1, $2) RETURNING id', [
        workspace.id,
        name,
      ]),
    count: async (sql, params = []) => {
      const [row] = await db.query<{ n: string }>(sql, params);
      return Number(row?.n ?? 0);
    },
    close: async () => {
      await pool.end();
      await db.drop();
    },
  };
}

export type Created = {
  item_id: string;
  version: number;
};

/** Test command: creates a backlog task in a room. Requires an executor or manager grant. */
export function createItemCommand(args: {
  roomId: Uuid;
  title: string;
  gated?: boolean;
  onHandle?: () => void | Promise<void>;
  emitEvents?: boolean;
  /** Journal the created item's event under a different room than the item's own (must be rejected). */
  eventRoomId?: Uuid;
}): CommandSpec<Created> {
  return {
    type: 'test.create_item',
    input: { room_id: args.roomId, title: args.title },
    gated: args.gated ?? false,
    authorize: async (tx) => {
      await requireRoomRole(tx.db, {
        workspaceId: tx.workspaceId,
        actorId: tx.actorId,
        roomId: args.roomId,
        allowed: ['executor', 'manager'],
      });
    },
    handle: async (tx) => {
      await args.onHandle?.();
      const { rows } = await tx.db.query<{ id: Uuid }>(
        `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
         VALUES ($1, 'task', $2, $3, 'backlog', $4) RETURNING id`,
        [tx.workspaceId, args.roomId, args.title, tx.actorId],
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
                  roomId: args.eventRoomId ?? args.roomId,
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
  itemId: Uuid;
  expectedVersion: number | undefined;
  title: string;
  onHandle?: () => void | Promise<void>;
  skipEvent?: boolean;
}): CommandSpec<Created> {
  return {
    type: 'test.retitle',
    input: { title: args.title },
    targets: [{ id: args.itemId, expectedVersion: args.expectedVersion }],
    authorize: async (tx) => {
      const item = tx.items.get(args.itemId);
      if (item === undefined) throw new Error('target was not locked');
      await requireRoomRole(tx.db, {
        workspaceId: tx.workspaceId,
        actorId: tx.actorId,
        roomId: item.homeRoomId,
        allowed: ['executor', 'manager'],
      });
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
        events:
          args.skipEvent === true
            ? [
                {
                  roomId: item.homeRoomId,
                  aggregateId: args.itemId,
                  aggregateVersion: version + 100,
                  eventType: 'task.retitled',
                },
              ]
            : [
                {
                  roomId: item.homeRoomId,
                  aggregateId: args.itemId,
                  aggregateVersion: version,
                  eventType: 'task.retitled',
                  payload: { title: args.title },
                },
              ],
      };
    },
  };
}

/** A command whose handler wrongly returns null, as untyped or `any` code could. */
export function nullResultCommand(args: {
  roomId: Uuid;
  onHandle: () => void;
}): CommandSpec<Created> {
  const base = createItemCommand({ roomId: args.roomId, title: 'null-result' });
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
