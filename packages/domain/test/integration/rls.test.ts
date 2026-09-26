import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand, withReadTx, type Uuid } from '../../src/index.ts';
import {
  createFixture,
  createItemCommand,
  type Fixture,
  type Workspace,
} from '../helpers/fixture.ts';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Tables the runtime role may read; each carries workspace_id (workspaces: id). */
const READABLE = [
  'workspaces',
  'actors',
  'agent_instances',
  'rooms',
  'room_grants',
  'projects',
  'work_items',
  'task_details',
  'task_leases',
  'task_result_revisions',
  'review_details',
  'commands',
  'domain_events',
] as const;
/** Tables with no privileges for the runtime role at all. */
const NO_ACCESS = ['api_tokens', 'invites'] as const;

describe('row-level security, as the runtime role chorus_app (real PostgreSQL)', () => {
  let f: Fixture;
  let secondRoomA: Uuid; // a room in workspace A that A's executor has NO grant in
  let taskInSecondRoom: Uuid;
  let taskInRoomA: Uuid;

  const workspaceColumn = (table: string) => (table === 'workspaces' ? 'id' : 'workspace_id');
  const owner = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    f.db.query<T>(sql, params);
  const first = async (sql: string, params: unknown[] = []): Promise<string> => {
    const [row] = await owner<{ id: string }>(sql, params);
    if (row === undefined) throw new Error('expected a row');
    return row.id;
  };

  async function seedEverything(ws: Workspace, label: string): Promise<Uuid> {
    const seedInstance = await first(
      `INSERT INTO agent_instances (workspace_id, actor_id, label) VALUES ($1, $2, $3) RETURNING id`,
      [ws.id, ws.executorId, `${label}-instance`],
    );
    await owner(`INSERT INTO projects (workspace_id, room_id, name) VALUES ($1, $2, $3)`, [
      ws.id,
      ws.roomId,
      `${label}-project`,
    ]);
    const task = (await first(
      `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, 'task', $2, $3, 'review', $4) RETURNING id`,
      [ws.id, ws.roomId, `${label}-task`, ws.executorId],
    )) as Uuid;
    await owner(
      `INSERT INTO task_details (workspace_id, item_id, acceptance_criteria) VALUES ($1, $2, '["ok"]')`,
      [ws.id, task],
    );
    await owner(`INSERT INTO task_leases (workspace_id, task_id, fence) VALUES ($1, $2, 1)`, [
      ws.id,
      task,
    ]);
    const content = `${label} result`;
    await owner(
      `INSERT INTO task_result_revisions (workspace_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
       VALUES ($1, $2, 1, $3, $4, $5, $6, 1)`,
      [ws.id, task, content, sha256(content), Buffer.byteLength(content), ws.executorId],
    );
    const review = await first(
      `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, 'review', $2, $3, 'requested', $4) RETURNING id`,
      [ws.id, ws.roomId, `${label}-review`, ws.reviewerId],
    );
    await owner(
      `INSERT INTO review_details (workspace_id, review_item_id, subject_task_id, result_revision, content_sha256, criteria)
       VALUES ($1, $2, $3, 1, $4, '[]')`,
      [ws.id, review, task, sha256(content)],
    );
    await owner(
      `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id) VALUES ($1, $2, $3, $4)`,
      [ws.id, ws.executorId, sha256(`${label}-token`), seedInstance],
    );
    await owner(
      `INSERT INTO invites (workspace_id, room_id, role, code_sha256, expires_at)
       VALUES ($1, $2, 'executor', $3, now() + interval '1 hour')`,
      [ws.id, ws.roomId, sha256(`${label}-invite`)],
    );
    // A real command gives us commands + domain_events rows.
    await runCommand(
      f.ctx(ws, ws.executorId, `${label}-seed-command`),
      createItemCommand({ roomId: ws.roomId, title: `${label}-created` }),
    );
    return task;
  }

  beforeAll(async () => {
    f = await createFixture();
    taskInRoomA = await seedEverything(f.a, 'a');
    await seedEverything(f.b, 'b');
    secondRoomA = await f.addRoom(f.a, 'a-second-room');
    taskInSecondRoom = (await first(
      `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, 'task', $2, 'in-second-room', 'ready', $3) RETURNING id`,
      [f.a.id, secondRoomA, f.a.executorId],
    )) as Uuid;
  });
  afterAll(async () => {
    await f.close();
  });

  const as = (ws: Workspace, actorId: Uuid) => ({ pool: f.pool, workspaceId: ws.id, actorId });
  const countAs = (ws: Workspace, actorId: Uuid, table: string, where = 'true') =>
    withReadTx(as(ws, actorId), async (db) => {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
      );
      return Number(rows[0]?.n);
    });

  describe('the runtime role itself', () => {
    it('is chorus_app: not a superuser, no BYPASSRLS, and owns nothing', async () => {
      const { rows } = await f.pool.query<{ current_user: string }>('SELECT current_user');
      expect(rows[0]?.current_user).toBe('chorus_app');
      const [role] = await owner<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'chorus_app'`);
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
      const [owned] = await owner<{ n: string }>(
        `SELECT count(*) AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
          WHERE r.rolname = 'chorus_app'`,
      );
      expect(Number(owned?.n)).toBe(0);
    });

    it('has RLS enabled AND forced on every table except schema_migrations', async () => {
      const tables = await owner<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'`,
      );
      expect(tables.map((t) => t.relname).sort()).toEqual([...READABLE, ...NO_ACCESS].sort());
      for (const t of tables) {
        expect(t, `${t.relname} must enable and force RLS`).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
      }
    });

    it('lets only the three intended SECURITY DEFINER functions bypass RLS, with a pinned search_path', async () => {
      const fns = await owner<{
        proname: string;
        proconfig: string[] | null;
        proacl: string | null;
      }>(
        `SELECT p.proname, p.proconfig, p.proacl::text AS proacl
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
      );
      expect(fns.map((x) => x.proname)).toEqual([
        'chorus_redeem_invite',
        'chorus_resolve_token',
        'chorus_visible_rooms',
      ]);
      for (const fn of fns) {
        // pg_temp must come LAST; when omitted Postgres searches it first and temp tables can shadow.
        expect(fn.proconfig, fn.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(fn.proacl ?? '', `${fn.proname} must not be executable by PUBLIC`).not.toMatch(
          /(^|[{,])=X/,
        );
      }
    });
  });

  describe('workspace isolation', () => {
    it('shows workspace B nothing of workspace A in any tenant table (and A its own rows)', async () => {
      for (const table of READABLE) {
        const column = workspaceColumn(table);
        const ownRows = await countAs(f.b, f.b.executorId, table, `${column} = '${f.b.id}'`);
        expect(ownRows, `${table}: control, B should see its own rows`).toBeGreaterThan(0);
        const foreign = await countAs(f.b, f.b.executorId, table, `${column} = '${f.a.id}'`);
        expect(foreign, `${table}: B must see none of A`).toBe(0);
        const backAgain = await countAs(f.a, f.a.executorId, table, `${column} = '${f.a.id}'`);
        expect(backAgain, `${table}: control, A should see its own rows`).toBeGreaterThan(0);
      }
    });

    it('has no privileges on api_tokens or invites for the runtime role', async () => {
      for (const table of NO_ACCESS) {
        await expect(countAs(f.a, f.a.executorId, table)).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('fails closed: with no context set, nothing is visible', async () => {
      for (const table of READABLE) {
        const { rows } = await f.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect(Number(rows[0]?.n), table).toBe(0);
      }
    });

    it('does not leak context to the next user of a pooled connection', async () => {
      await runCommand(
        f.ctx(f.a, f.a.executorId, 'context-leak'),
        createItemCommand({ roomId: f.a.roomId, title: 'leak-check' }),
      );
      const clients = await Promise.all(Array.from({ length: 5 }, () => f.pool.connect()));
      try {
        for (const client of clients) {
          const { rows } = await client.query<{ ws: string | null }>(
            `SELECT NULLIF(current_setting('chorus.workspace_id', true), '') AS ws`,
          );
          expect(rows[0]?.ws).toBeNull();
        }
      } finally {
        for (const client of clients) client.release();
      }
    });

    it('rejects writes into another workspace via WITH CHECK', async () => {
      await expect(
        withReadTx(as(f.a, f.a.executorId), () => Promise.resolve()).then(() =>
          runInWriteTx(f, f.a, f.a.executorId, (db) =>
            db.query(
              `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
               VALUES ($1, 'task', $2, 'smuggled', 'ready', $3)`,
              [f.b.id, f.b.roomId, f.b.executorId],
            ),
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await f.count(`SELECT count(*) AS n FROM work_items WHERE title = 'smuggled'`)).toBe(
        0,
      );
    });
  });

  describe('room isolation within a workspace', () => {
    it('hides rooms, grants, items and their children when the actor has no grant on the room', async () => {
      // A's executor has no grant in secondRoomA: it must not even see that the room exists.
      expect(await countAs(f.a, f.a.executorId, 'rooms', `id = '${secondRoomA}'`)).toBe(0);
      expect(await countAs(f.a, f.a.executorId, 'work_items', `id = '${taskInSecondRoom}'`)).toBe(
        0,
      );
      expect(
        await countAs(f.a, f.a.executorId, 'work_items', `home_room_id = '${secondRoomA}'`),
      ).toBe(0);
      // ... while its own room's items are visible, and the owner confirms the hidden row exists.
      expect(await countAs(f.a, f.a.executorId, 'work_items', `id = '${taskInRoomA}'`)).toBe(1);
      expect(
        await f.count(`SELECT count(*) AS n FROM work_items WHERE id = $1`, [taskInSecondRoom]),
      ).toBe(1);
    });

    it('gives an actor with no grants at all an empty view of the workspace', async () => {
      for (const table of [
        'rooms',
        'work_items',
        'task_details',
        'task_result_revisions',
        'domain_events',
      ]) {
        expect(await countAs(f.a, f.a.outsiderId, table), table).toBe(0);
      }
    });

    it('answers a command targeting a hidden item with not_found', async () => {
      const { retitleCommand } = await import('../helpers/fixture.ts');
      const error: unknown = await runCommand(
        f.ctx(f.a, f.a.executorId, 'hidden-item'),
        retitleCommand({ itemId: taskInSecondRoom, expectedVersion: 1, title: 'x' }),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'not_found', status: 404 });
    });

    it('sees an item as soon as a grant on its room exists, and loses it on revocation', async () => {
      const actor = await f.addActor(f.a);
      expect(await countAs(f.a, actor, 'work_items', `id = '${taskInSecondRoom}'`)).toBe(0);
      await owner(
        `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'reviewer')`,
        [f.a.id, actor, secondRoomA],
      );
      expect(await countAs(f.a, actor, 'work_items', `id = '${taskInSecondRoom}'`)).toBe(1);
      await owner(
        'UPDATE room_grants SET revoked_at = now() WHERE workspace_id = $1 AND actor_id = $2',
        [f.a.id, actor],
      );
      expect(await countAs(f.a, actor, 'work_items', `id = '${taskInSecondRoom}'`)).toBe(0);
    });

    it('rejects an INSERT or an UPDATE that targets a room the actor has no grant in', async () => {
      await expect(
        runInWriteTx(f, f.a, f.a.executorId, (db) =>
          db.query(
            `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
             VALUES ($1, 'task', $2, 'wrong-room', 'ready', $3)`,
            [f.a.id, secondRoomA, f.a.executorId],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        runInWriteTx(f, f.a, f.a.executorId, (db) =>
          db.query(`UPDATE work_items SET home_room_id = $2 WHERE id = $1`, [
            taskInRoomA,
            secondRoomA,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await f.count(`SELECT count(*) AS n FROM work_items WHERE title = 'wrong-room'`)).toBe(
        0,
      );
    });

    it('cannot grant itself access: the runtime role cannot write room_grants', async () => {
      await expect(
        runInWriteTx(f, f.a, f.a.executorId, (db) =>
          db.query(
            `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'manager')`,
            [f.a.id, f.a.executorId, secondRoomA],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('pg_temp shadowing of SECURITY DEFINER functions', () => {
    const db = () => f.db.url.split('/').pop() ?? '';

    /** Attacker-style lookalikes: explicit columns, because LIKE would need SELECT the role lacks. */
    const LOOKALIKE: Record<string, string> = {
      invites: `CREATE TEMP TABLE invites (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, room_id uuid, role text,
        code_sha256 text, created_at timestamptz DEFAULT now(), expires_at timestamptz, used_at timestamptz, used_by_actor_id uuid)`,
      actors: `CREATE TEMP TABLE actors (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, kind text, display_name text,
        created_at timestamptz DEFAULT now())`,
      room_grants: `CREATE TEMP TABLE room_grants (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, actor_id uuid, room_id uuid,
        role text, granted_at timestamptz DEFAULT now(), revoked_at timestamptz)`,
      agent_instances: `CREATE TEMP TABLE agent_instances (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, actor_id uuid,
        label text, created_at timestamptz DEFAULT now())`,
      api_tokens: `CREATE TEMP TABLE api_tokens (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, actor_id uuid,
        token_sha256 text, instance_id uuid, created_at timestamptz DEFAULT now(), expires_at timestamptz, revoked_at timestamptz)`,
    };

    it('gives the runtime role no TEMP privilege by default', async () => {
      await expect(f.pool.query('CREATE TEMP TABLE invites (x int)')).rejects.toMatchObject({
        code: '42501',
      });
    });

    describe('even if TEMP were granted, forged temp tables are ignored', () => {
      beforeAll(async () => {
        await owner(`GRANT TEMPORARY ON DATABASE ${db()} TO chorus_app`);
      });
      afterAll(async () => {
        await owner(`REVOKE TEMPORARY ON DATABASE ${db()} FROM chorus_app`);
      });

      it('chorus_redeem_invite ignores a forged temp invites table', async () => {
        const client = await f.pool.connect();
        try {
          await client.query(LOOKALIKE['invites'] ?? '');
          await client.query(
            `INSERT INTO pg_temp.invites (workspace_id, room_id, role, code_sha256, expires_at)
             VALUES ($1, $2, 'manager', $3, now() + interval '1 hour')`,
            [f.a.id, f.a.roomId, sha256('forged-code')],
          );
          const { rows } = await client.query('SELECT * FROM chorus_redeem_invite($1, $2, $3)', [
            sha256('forged-code'),
            sha256('forged-token'),
            'attacker',
          ]);
          expect(rows).toEqual([]);
        } finally {
          client.release(true);
        }
        expect(
          await f.count(`SELECT count(*) AS n FROM actors WHERE display_name = 'attacker'`),
        ).toBe(0);
        expect(
          await f.count(`SELECT count(*) AS n FROM api_tokens WHERE token_sha256 = $1`, [
            sha256('forged-token'),
          ]),
        ).toBe(0);
      });

      it('a real redemption writes to the real tables even when temp lookalikes exist', async () => {
        await owner(
          `INSERT INTO invites (workspace_id, room_id, role, code_sha256, expires_at)
           VALUES ($1, $2, 'executor', $3, now() + interval '1 hour')`,
          [f.a.id, f.a.roomId, sha256('real-code')],
        );
        const client = await f.pool.connect();
        let redeemedActor: string | undefined;
        try {
          for (const table of ['actors', 'agent_instances', 'room_grants', 'api_tokens']) {
            await client.query(LOOKALIKE[table] ?? '');
          }
          const { rows } = await client.query<{ actor_id: string }>(
            'SELECT * FROM chorus_redeem_invite($1, $2, $3)',
            [sha256('real-code'), sha256('real-token'), 'legit'],
          );
          expect(rows).toHaveLength(1);
          redeemedActor = rows[0]?.actor_id;
          // Nothing was written to ANY of the forged temp tables, including agent_instances.
          for (const table of ['actors', 'agent_instances', 'room_grants', 'api_tokens']) {
            const temp = await client.query(`SELECT (SELECT count(*) FROM pg_temp.${table}) AS n`);
            expect(Number((temp.rows[0] as { n: string }).n), `pg_temp.${table}`).toBe(0);
          }
        } finally {
          client.release(true);
        }
        expect(await f.count(`SELECT count(*) AS n FROM actors WHERE display_name = 'legit'`)).toBe(
          1,
        );
        // The real instance exists and is the one bound to the new token.
        expect(
          await f.count(`SELECT count(*) AS n FROM agent_instances WHERE actor_id = $1`, [
            redeemedActor,
          ]),
        ).toBe(1);
        expect(
          await f.count(
            `SELECT count(*) AS n FROM api_tokens t JOIN agent_instances i ON i.id = t.instance_id
              WHERE t.token_sha256 = $1 AND i.actor_id = $2`,
            [sha256('real-token'), redeemedActor],
          ),
        ).toBe(1);
      });

      it('chorus_resolve_token ignores forged temp actors and api_tokens (real kind and instance win)', async () => {
        const [real] = await owner<{ instance_id: string }>(
          `SELECT instance_id FROM api_tokens WHERE token_sha256 = $1`,
          [sha256('a-token')],
        );
        const client = await f.pool.connect();
        try {
          await client.query(LOOKALIKE['actors'] ?? '');
          await client.query(LOOKALIKE['api_tokens'] ?? '');
          // A forged 'human' actor row for the real actor, and a forged token pointing elsewhere.
          await client.query(
            `INSERT INTO pg_temp.actors (id, workspace_id, kind, display_name) VALUES ($1, $2, 'human', 'forged')`,
            [f.a.executorId, f.a.id],
          );
          await client.query(
            `INSERT INTO pg_temp.api_tokens (workspace_id, actor_id, token_sha256, instance_id) VALUES ($1, $2, $3, gen_random_uuid())`,
            [f.a.id, f.a.outsiderId, sha256('a-token')],
          );
          const { rows } = await client.query('SELECT * FROM chorus_resolve_token($1)', [
            sha256('a-token'),
          ]);
          expect(rows).toEqual([
            {
              actor_id: f.a.executorId,
              workspace_id: f.a.id,
              actor_kind: 'agent',
              instance_id: real?.instance_id,
            },
          ]);
        } finally {
          client.release(true);
        }
      });

      it('chorus_visible_rooms and chorus_resolve_token ignore forged temp tables', async () => {
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
            [f.a.id, f.a.outsiderId],
          );
          await client.query(LOOKALIKE['room_grants'] ?? '');
          await client.query(
            `INSERT INTO pg_temp.room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'manager')`,
            [f.a.id, f.a.outsiderId, secondRoomA],
          );
          const rooms = await client.query('SELECT * FROM chorus_visible_rooms()');
          expect(rooms.rows).toEqual([]);

          await client.query(LOOKALIKE['api_tokens'] ?? '');
          await client.query(
            `INSERT INTO pg_temp.api_tokens (workspace_id, actor_id, token_sha256) VALUES ($1, $2, $3)`,
            [f.a.id, f.a.outsiderId, sha256('forged-live-token')],
          );
          const resolved = await client.query('SELECT * FROM chorus_resolve_token($1)', [
            sha256('forged-live-token'),
          ]);
          expect(resolved.rows).toEqual([]);
          await client.query('ROLLBACK');
        } finally {
          client.release(true);
        }
      });
    });
  });

  describe('rls.definer.hardening_v2 (migration 0004)', () => {
    it("cannot create an agent token without an instance, or with another actor's instance", async () => {
      await expect(
        owner(`INSERT INTO api_tokens (workspace_id, actor_id, token_sha256) VALUES ($1, $2, $3)`, [
          f.a.id,
          f.a.executor2Id,
          sha256('no-instance-token'),
        ]),
      ).rejects.toMatchObject({ code: '23000' });
      const foreign = await first(
        `INSERT INTO agent_instances (workspace_id, actor_id, label) VALUES ($1, $2, 'foreign') RETURNING id`,
        [f.a.id, f.a.executorId],
      );
      await expect(
        owner(
          `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id) VALUES ($1, $2, $3, $4)`,
          [f.a.id, f.a.executor2Id, sha256('wrong-owner-token'), foreign],
        ),
      ).rejects.toMatchObject({ code: '23000' });
      // One instance serves one token.
      await expect(
        owner(
          `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id) VALUES ($1, $2, $3, $4)`,
          [f.a.id, f.a.executorId, sha256('second-token-same-instance'), foreign],
        ),
      ).resolves.toBeDefined();
      await expect(
        owner(
          `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id) VALUES ($1, $2, $3, $4)`,
          [f.a.id, f.a.executorId, sha256('third-token-same-instance'), foreign],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      // Human and service actors may have instance-less tokens.
      await owner(
        `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256) VALUES ($1, $2, $3)`,
        [
          f.a.id,
          f.a.reviewerId === f.a.executorId ? f.a.executorId : await humanActor(),
          sha256('human-token'),
        ],
      );
    });

    async function humanActor(): Promise<Uuid> {
      return (await first(
        `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'human', 'h') RETURNING id`,
        [f.a.id],
      )) as Uuid;
    }

    it('redeeming an invite creates exactly one instance bound to the new token', async () => {
      await owner(
        `INSERT INTO invites (workspace_id, room_id, role, code_sha256, expires_at)
         VALUES ($1, $2, 'executor', $3, now() + interval '1 hour')`,
        [f.a.id, f.a.roomId, sha256('v2-code')],
      );
      const { rows } = await f.pool.query<{ actor_id: string }>(
        'SELECT * FROM chorus_redeem_invite($1, $2, $3)',
        [sha256('v2-code'), sha256('v2-token'), 'v2 agent'],
      );
      const actorId = rows[0]?.actor_id;
      expect(actorId).toBeDefined();
      expect(
        await f.count(`SELECT count(*) AS n FROM agent_instances WHERE actor_id = $1`, [actorId]),
      ).toBe(1);
      const [token] = await owner<{ instance_id: string; label: string }>(
        `SELECT t.instance_id, i.label FROM api_tokens t JOIN agent_instances i ON i.id = t.instance_id
          WHERE t.token_sha256 = $1`,
        [sha256('v2-token')],
      );
      expect(token?.label).toBe('v2 agent');
    });

    it('lets an actor see only its own agent_instances', async () => {
      const other = await f.addActor(f.a, { roomId: f.a.roomId, role: 'executor' });
      const mine = await f.addInstance(f.a, other);
      expect(await countAs(f.a, other, 'agent_instances', `id = '${mine}'`)).toBe(1);
      // executor2 shares the room but cannot see it.
      expect(await countAs(f.a, f.a.executor2Id, 'agent_instances', `id = '${mine}'`)).toBe(0);
    });
  });

  describe('immutability.after_0004', () => {
    it('still rejects UPDATE and DELETE of a result revision after the ALTERs, as owner and as chorus_app', async () => {
      const { createTask, claim, submitResult } = await import('../../src/index.ts');
      const manager = await f.addActor(f.a, { roomId: f.a.roomId, role: 'manager' });
      const executor = await f.addActor(f.a, { roomId: f.a.roomId, role: 'executor' });
      const instance = await f.addInstance(f.a, executor);
      const { task } = await createTask(f.ctx(f.a, manager, 'imm-create'), {
        room_id: f.a.roomId,
        title: 'immutable',
        acceptance_criteria: ['c'],
      });
      const c = await claim(f.ctx(f.a, executor, 'imm-claim', instance), {
        task_id: task.id,
        expected_version: 1,
      });
      await submitResult(f.ctx(f.a, executor, 'imm-submit', instance), {
        task_id: task.id,
        expected_version: c.version,
        fence: c.fence,
        content: 'bytes',
        content_type: 'text/plain',
        criteria_mapping: [{ criterion: 0, note: 'done' }],
      });
      for (const sql of [
        `UPDATE task_result_revisions SET criteria_mapping = '[]' WHERE task_id = $1`,
        `UPDATE task_result_revisions SET byte_length = 0 WHERE task_id = $1`,
        `DELETE FROM task_result_revisions WHERE task_id = $1`,
      ]) {
        await expect(owner(sql, [task.id])).rejects.toMatchObject({ code: '23000' });
        await expect(f.pool.query(sql, [task.id])).rejects.toMatchObject({ code: '42501' });
      }
    });
  });

  describe('append-only guarantees at the privilege level', () => {
    it.each([
      'UPDATE task_result_revisions SET content_type = $1',
      'DELETE FROM task_result_revisions WHERE content_type <> $1',
      'UPDATE domain_events SET event_type = $1',
      'DELETE FROM domain_events WHERE event_type <> $1',
      'DELETE FROM commands WHERE command_type <> $1',
    ])('denies %s', async (sql) => {
      await expect(
        runInWriteTx(f, f.a, f.a.executorId, (db) => db.query(sql, ['x'])),
      ).rejects.toMatchObject({
        code: '42501',
      });
    });

    it('denies TRUNCATE on the immutable tables', async () => {
      for (const table of ['task_result_revisions', 'domain_events', 'commands']) {
        await expect(f.pool.query(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: '42501' });
      }
    });
  });

  describe('token resolution (SECURITY DEFINER)', () => {
    const resolve = async (token: string) =>
      (await f.pool.query('SELECT * FROM chorus_resolve_token($1)', [sha256(token)])).rows as {
        actor_id: string;
        workspace_id: string;
        actor_kind: string;
        instance_id: string | null;
      }[];

    it('resolves a live token to its actor, workspace, actor kind and bound instance only', async () => {
      const rows = await resolve('a-token');
      const [instance] = await owner<{ id: string }>(
        `SELECT instance_id AS id FROM api_tokens WHERE token_sha256 = $1`,
        [sha256('a-token')],
      );
      expect(rows).toEqual([
        {
          actor_id: f.a.executorId,
          workspace_id: f.a.id,
          actor_kind: 'agent',
          instance_id: instance?.id,
        },
      ]);
    });

    it('returns nothing for revoked, expired and unknown tokens', async () => {
      const instanceFor = (label: string) =>
        first(
          `INSERT INTO agent_instances (workspace_id, actor_id, label) VALUES ($1, $2, $3) RETURNING id`,
          [f.a.id, f.a.executorId, label],
        );
      await owner(
        `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id, revoked_at) VALUES ($1, $2, $3, $4, now())`,
        [f.a.id, f.a.executorId, sha256('revoked-token'), await instanceFor('revoked')],
      );
      await owner(
        `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id, expires_at) VALUES ($1, $2, $3, $4, now() - interval '1 second')`,
        [f.a.id, f.a.executorId, sha256('expired-token'), await instanceFor('expired')],
      );
      expect(await resolve('revoked-token')).toEqual([]);
      expect(await resolve('expired-token')).toEqual([]);
      expect(await resolve('never-issued')).toEqual([]);
      // Revoking a previously live token takes effect immediately.
      await owner('UPDATE api_tokens SET revoked_at = now() WHERE token_sha256 = $1', [
        sha256('b-token'),
      ]);
      expect(await resolve('b-token')).toEqual([]);
    });
  });

  describe('invite redemption (SECURITY DEFINER)', () => {
    const redeem = async (code: string, token: string, name = 'new agent') =>
      (
        await f.pool.query<{ workspace_id: Uuid; actor_id: Uuid; room_id: Uuid; role: string }>(
          'SELECT * FROM chorus_redeem_invite($1, $2, $3)',
          [sha256(code), sha256(token), name],
        )
      ).rows;

    it('lets exactly one of 10 concurrent redemptions of a single-use invite succeed', async () => {
      await owner(
        `INSERT INTO invites (workspace_id, room_id, role, code_sha256, expires_at)
         VALUES ($1, $2, 'executor', $3, now() + interval '1 hour')`,
        [f.a.id, f.a.roomId, sha256('race-code')],
      );
      const before = await f.count(`SELECT count(*) AS n FROM actors WHERE workspace_id = $1`, [
        f.a.id,
      ]);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          redeem('race-code', `race-token-${String(i)}`, `racer-${String(i)}`),
        ),
      );
      const winners = results.filter((rows) => rows.length === 1);
      expect(winners).toHaveLength(1);
      expect(results.filter((rows) => rows.length === 0)).toHaveLength(9);

      const [won] = winners.flat();
      expect(won).toMatchObject({ workspace_id: f.a.id, room_id: f.a.roomId, role: 'executor' });
      // Exactly one new actor, one grant and one token came out of it; the invite records who used it.
      expect(
        await f.count(`SELECT count(*) AS n FROM actors WHERE workspace_id = $1`, [f.a.id]),
      ).toBe(before + 1);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM room_grants WHERE actor_id = $1 AND role = 'executor'`,
          [won?.actor_id],
        ),
      ).toBe(1);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM invites WHERE code_sha256 = $1 AND used_by_actor_id = $2`,
          [sha256('race-code'), won?.actor_id],
        ),
      ).toBe(1);
      const [actor] = await owner<{ kind: string }>('SELECT kind FROM actors WHERE id = $1', [
        won?.actor_id,
      ]);
      expect(actor?.kind).toBe('agent');
    });

    it('cannot redeem twice, or redeem an expired or unknown code', async () => {
      await owner(
        `INSERT INTO invites (workspace_id, room_id, role, code_sha256, expires_at)
         VALUES ($1, $2, 'reviewer', $3, now() + interval '1 hour'), ($1, $2, 'executor', $4, now() - interval '1 second')`,
        [f.a.id, f.a.roomId, sha256('once-code'), sha256('expired-code')],
      );
      expect(await redeem('once-code', 'once-token-1')).toHaveLength(1);
      expect(await redeem('once-code', 'once-token-2')).toEqual([]);
      expect(await redeem('expired-code', 'expired-token')).toEqual([]);
      expect(await redeem('unknown-code', 'unknown-token')).toEqual([]);
      expect(
        await f.count(`SELECT count(*) AS n FROM api_tokens WHERE token_sha256 = $1`, [
          sha256('once-token-2'),
        ]),
      ).toBe(0);
    });

    it('produces an identity that resolves, is scoped to the invited room, and can do real work there', async () => {
      await owner(
        `INSERT INTO invites (workspace_id, room_id, role, code_sha256, expires_at)
         VALUES ($1, $2, 'executor', $3, now() + interval '1 hour')`,
        [f.a.id, f.a.roomId, sha256('e2e-code')],
      );
      const [redeemed] = await redeem('e2e-code', 'e2e-token', 'external agent');
      if (redeemed === undefined) throw new Error('redemption failed');

      const resolved = (
        await f.pool.query('SELECT * FROM chorus_resolve_token($1)', [sha256('e2e-token')])
      ).rows;
      expect(resolved).toMatchObject([
        {
          actor_id: redeemed.actor_id,
          workspace_id: redeemed.workspace_id,
          actor_kind: 'agent',
        },
      ]);
      expect((resolved[0] as { instance_id: string | null }).instance_id).not.toBeNull();

      const ctx = f.ctx(f.a, redeemed.actor_id, 'e2e-create');
      const created = await runCommand(
        ctx,
        createItemCommand({ roomId: f.a.roomId, title: 'by invited agent' }),
      );
      expect(created.version).toBe(1);
      // Its scope is the invited room only.
      const { retitleCommand } = await import('../helpers/fixture.ts');
      await expect(
        runCommand(
          f.ctx(f.a, redeemed.actor_id, 'e2e-other-room'),
          retitleCommand({ itemId: taskInSecondRoom, expectedVersion: 1, title: 'x' }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });
});

/** Runs a write inside a transaction with the RLS context set, as a command would (rolled back after). */
async function runInWriteTx<T>(
  f: Fixture,
  ws: Workspace,
  actorId: Uuid,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
      [ws.id, actorId],
    );
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
