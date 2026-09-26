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
const NO_ACCESS = [
  'api_tokens',
  'sharednet_seats',
  'sharednet_cursors',
  'external_identities',
  'enrollments',
] as const;

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

  const randomId = (prefix: string, n: number) =>
    `${prefix}${sha256(String(Math.random()) + prefix).slice(0, n)}`;

  /** Owner-side: a VERIFIED enrollment (as the watcher would leave it) for the given principal. */
  async function seedVerifiedEnrollment(
    ws: Workspace,
    opts: { principal?: string; member?: string; secret?: string; roomId?: Uuid } = {},
  ) {
    const secret = opts.secret ?? randomId('cvs_', 30);
    const principal = opts.principal ?? randomId('p_', 12);
    const member = opts.member ?? randomId('i_', 12);
    const nonce = `cvn_${sha256(secret).slice(0, 22)}`;
    const id = await first(
      `INSERT INTO enrollments
         (workspace_id, room_id, claimed_member_id, display_name, nonce, secret_sha256, state,
          created_at, expires_at, start_sequence, verified_at, proof_message_id, proof_sequence,
          proof_principal_id, proof_member_id)
       VALUES ($1, $2, $3, 'enrolled agent', $4, $5, 'verified', now(), now() + interval '10 minutes', 0,
               now(), 'msg_test', 5, $6, $3) RETURNING id`,
      [ws.id, opts.roomId ?? ws.roomId, member, nonce, sha256(secret), principal],
    );
    return { id, secret, principal, member, nonce };
  }

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
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND c.relname NOT IN ('schema_migrations', 'admin_audit_log')`,
      );
      expect(tables.map((t) => t.relname).sort()).toEqual([...READABLE, ...NO_ACCESS].sort());
      for (const t of tables) {
        expect(t, `${t.relname} must enable and force RLS`).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
      }
    });

    it('exempts exactly schema_migrations and admin_audit_log, and chorus_app has no privilege on the latter', async () => {
      const all = await owner<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1`,
      );
      expect(all.map((t) => t.relname)).toEqual(['admin_audit_log', 'schema_migrations']);
      await expect(f.pool.query('SELECT 1 FROM admin_audit_log')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        f.pool.query(`INSERT INTO admin_audit_log (operator, command) VALUES ('x', 'y')`),
      ).rejects.toMatchObject({ code: '42501' });
      // The audit log is append-only even for the owner.
      await owner(`INSERT INTO admin_audit_log (operator, command) VALUES ('op', 'test')`);
      await expect(owner(`UPDATE admin_audit_log SET command = 'x'`)).rejects.toMatchObject({
        code: '23000',
      });
      await expect(owner('DELETE FROM admin_audit_log')).rejects.toMatchObject({ code: '23000' });
    });

    it('lets only the intended SECURITY DEFINER functions bypass RLS, with a pinned search_path', async () => {
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
        'chorus_enroll_complete',
        'chorus_enroll_start',
        'chorus_enroll_status',
        'chorus_enroll_verify',
        'chorus_expire_enrollments',
        'chorus_resolve_token',
        'chorus_room_health',
        'chorus_visible_rooms',
        'chorus_watcher_advance',
        'chorus_watcher_degrade',
        'chorus_watcher_rooms',
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
      rooms: `CREATE TEMP TABLE rooms (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, name text,
        created_at timestamptz DEFAULT now(), provider text, external_room_id text, activation_state text)`,
      sharednet_cursors: `CREATE TEMP TABLE sharednet_cursors (workspace_id uuid, room_id uuid, last_sequence bigint,
        updated_at timestamptz DEFAULT now(), last_error text, last_ok_at timestamptz)`,
      enrollments: `CREATE TEMP TABLE enrollments (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, room_id uuid,
        claimed_member_id text, display_name text, nonce text, secret_sha256 text, state text,
        created_at timestamptz DEFAULT now(), expires_at timestamptz, start_sequence bigint, verified_at timestamptz,
        proof_message_id text, proof_sequence bigint, proof_principal_id text, proof_member_id text,
        consumed_at timestamptz, issued_actor_id uuid, issued_token_id uuid)`,
      external_identities: `CREATE TEMP TABLE external_identities (workspace_id uuid, actor_id uuid, provider text,
        principal_id text, first_seen_at timestamptz DEFAULT now())`,
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

      it('chorus_enroll_start ignores a forged temp rooms/cursor pair', async () => {
        const client = await f.pool.connect();
        try {
          await client.query(LOOKALIKE['rooms'] ?? '');
          await client.query(LOOKALIKE['sharednet_cursors'] ?? '');
          const forgedRoom = await client.query<{ id: string }>(
            `INSERT INTO pg_temp.rooms (workspace_id, name, provider, external_room_id, activation_state)
             VALUES ($1, 'forged', 'sharednet', 'rom_forgedroom1', 'active') RETURNING id`,
            [f.a.id],
          );
          await client.query(
            `INSERT INTO pg_temp.sharednet_cursors (workspace_id, room_id, last_sequence, last_ok_at)
             VALUES ($1, $2, 0, now())`,
            [f.a.id, forgedRoom.rows[0]?.id],
          );
          await expect(
            client.query('SELECT * FROM chorus_enroll_start($1, $2, $3, $4, $5)', [
              'rom_forgedroom1',
              'i_forgedmember1',
              'attacker',
              `cvn_${'a'.repeat(22)}`,
              sha256('forged-secret'),
            ]),
          ).rejects.toMatchObject({ code: 'CH001' });
        } finally {
          client.release(true);
        }
        expect(
          await f.count(`SELECT count(*) AS n FROM enrollments WHERE display_name = 'attacker'`),
        ).toBe(0);
      });

      it('chorus_enroll_complete ignores a forged temp enrollments table', async () => {
        const client = await f.pool.connect();
        const tokenHash = sha256('forged-enrollment-token');
        try {
          await client.query(LOOKALIKE['enrollments'] ?? '');
          await client.query(
            `INSERT INTO pg_temp.enrollments
               (workspace_id, room_id, claimed_member_id, display_name, nonce, secret_sha256, state, expires_at,
                start_sequence, verified_at, proof_principal_id, proof_member_id)
             VALUES ($1, $2, 'i_forgedmember1', 'forged', $3, $4, 'verified', now() + interval '10 minutes', 0,
                     now(), 'p_forgedprincipal1', 'i_forgedmember1')`,
            [f.a.id, f.a.roomId, `cvn_${'b'.repeat(22)}`, sha256('forged-secret2')],
          );
          const forged = await client.query<{ id: string }>('SELECT id FROM pg_temp.enrollments');
          const { rows } = await client.query<{ status: string }>(
            'SELECT * FROM chorus_enroll_complete($1, $2, $3, $4)',
            [forged.rows[0]?.id, sha256('forged-secret2'), tokenHash, ['executor']],
          );
          expect(rows).toEqual([expect.objectContaining({ status: 'invalid' })]);
        } finally {
          client.release(true);
        }
        expect(
          await f.count(`SELECT count(*) AS n FROM api_tokens WHERE token_sha256 = $1`, [
            tokenHash,
          ]),
        ).toBe(0);
        expect(
          await f.count(`SELECT count(*) AS n FROM actors WHERE display_name = 'forged'`),
        ).toBe(0);
      });

      it('a real enrollment completes into the real tables even when temp lookalikes exist', async () => {
        const enrollment = await seedVerifiedEnrollment(f.a);
        const tokenHash = sha256('shadow-real-token');
        const client = await f.pool.connect();
        let actorId: string | undefined;
        try {
          for (const table of [
            'actors',
            'agent_instances',
            'room_grants',
            'api_tokens',
            'external_identities',
          ]) {
            await client.query(LOOKALIKE[table] ?? '');
          }
          const { rows } = await client.query<{ status: string; actor_id: string }>(
            'SELECT * FROM chorus_enroll_complete($1, $2, $3, $4)',
            [enrollment.id, sha256(enrollment.secret), tokenHash, ['executor']],
          );
          expect(rows).toEqual([expect.objectContaining({ status: 'issued' })]);
          actorId = rows[0]?.actor_id;
          for (const table of [
            'actors',
            'agent_instances',
            'room_grants',
            'api_tokens',
            'external_identities',
          ]) {
            const temp = await client.query(`SELECT (SELECT count(*) FROM pg_temp.${table}) AS n`);
            expect(Number((temp.rows[0] as { n: string }).n), `pg_temp.${table}`).toBe(0);
          }
        } finally {
          client.release(true);
        }
        expect(await f.count(`SELECT count(*) AS n FROM actors WHERE id = $1`, [actorId])).toBe(1);
        expect(
          await f.count(`SELECT count(*) AS n FROM agent_instances WHERE actor_id = $1`, [actorId]),
        ).toBe(1);
        expect(
          await f.count(
            `SELECT count(*) AS n FROM api_tokens t JOIN agent_instances i ON i.id = t.instance_id
              WHERE t.token_sha256 = $1 AND i.actor_id = $2`,
            [tokenHash, actorId],
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
              token_expires_at: null,
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

    it('completing an enrollment creates exactly one instance bound to the new token', async () => {
      const enrollment = await seedVerifiedEnrollment(f.a);
      const { rows } = await f.pool.query<{ actor_id: string }>(
        'SELECT * FROM chorus_enroll_complete($1, $2, $3, $4)',
        [enrollment.id, sha256(enrollment.secret), sha256('v2-token'), ['executor']],
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
      expect(token?.label).toBe(`sharednet:${enrollment.member}`);
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
        token_expires_at: Date | null;
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
          token_expires_at: null,
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

  describe('enrollment completion (SECURITY DEFINER)', () => {
    const complete = async (
      id: string,
      secret: string,
      token: string,
      roles: string[] = ['executor'],
    ) =>
      (
        await f.pool.query<{
          status: string;
          actor_id: Uuid | null;
          workspace_id: Uuid | null;
          room_id: Uuid | null;
          instance_id: Uuid | null;
          roles: string[] | null;
        }>('SELECT * FROM chorus_enroll_complete($1, $2, $3, $4)', [
          id,
          sha256(secret),
          sha256(token),
          roles,
        ])
      ).rows;

    it('lets exactly one of 10 concurrent completions of a verified enrollment issue a token', async () => {
      const e = await seedVerifiedEnrollment(f.a);
      const before = await f.count(`SELECT count(*) AS n FROM actors WHERE workspace_id = $1`, [
        f.a.id,
      ]);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => complete(e.id, e.secret, `race-token-${String(i)}`)),
      );
      const issued = results.flat().filter((r) => r.status === 'issued');
      expect(issued).toHaveLength(1);
      expect(results.flat().filter((r) => r.status === 'invalid')).toHaveLength(9);
      const [won] = issued;
      expect(won).toMatchObject({ workspace_id: f.a.id, room_id: f.a.roomId, roles: ['executor'] });
      expect(
        await f.count(`SELECT count(*) AS n FROM actors WHERE workspace_id = $1`, [f.a.id]),
      ).toBe(before + 1);
      expect(
        await f.count(`SELECT count(*) AS n FROM agent_instances WHERE actor_id = $1`, [
          won?.actor_id,
        ]),
      ).toBe(1);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM room_grants WHERE actor_id = $1 AND revoked_at IS NULL`,
          [won?.actor_id],
        ),
      ).toBe(1);
      const [row] = await owner<{ state: string; issued_actor_id: string }>(
        'SELECT state, issued_actor_id FROM enrollments WHERE id = $1',
        [e.id],
      );
      expect(row).toEqual({ state: 'consumed', issued_actor_id: won?.actor_id });
    });

    it('answers unknown, wrong-secret, consumed and expired enrollments identically', async () => {
      const e = await seedVerifiedEnrollment(f.a);
      expect(await complete(e.id, e.secret, 'once-token-1')).toHaveLength(1);
      const consumed = await complete(e.id, e.secret, 'enr-once-token-2');
      const wrongSecret = await complete(
        (await seedVerifiedEnrollment(f.a)).id,
        'not-the-secret',
        'enr-wrong-token',
      );
      const unknown = await complete(
        '00000000-0000-4000-8000-000000000000',
        e.secret,
        'enr-unknown-token',
      );
      const expired = await seedVerifiedEnrollment(f.a);
      await owner(`UPDATE enrollments SET state = 'expired' WHERE id = $1`, [expired.id]);
      const stale = await complete(expired.id, expired.secret, 'enr-expired-token');
      for (const result of [consumed, wrongSecret, unknown, stale]) {
        expect(result).toEqual([
          {
            status: 'invalid',
            actor_id: null,
            workspace_id: null,
            room_id: null,
            instance_id: null,
            roles: null,
            token_expires_at: null,
          },
        ]);
      }
      expect(
        await f.count(`SELECT count(*) AS n FROM api_tokens WHERE token_sha256 = ANY($1::text[])`, [
          ['enr-once-token-2', 'enr-wrong-token', 'enr-unknown-token', 'enr-expired-token'].map(
            sha256,
          ),
        ]),
      ).toBe(0);
    });

    it('reports pending until verified, and refuses roles beyond executor', async () => {
      const e = await seedVerifiedEnrollment(f.a);
      await owner(`UPDATE enrollments SET state = 'pending', verified_at = NULL WHERE id = $1`, [
        e.id,
      ]);
      expect(await complete(e.id, e.secret, 'pending-token')).toEqual([
        expect.objectContaining({ status: 'pending' }),
      ]);
      const status = await f.pool.query('SELECT * FROM chorus_enroll_status($1, $2)', [
        e.id,
        sha256(e.secret),
      ]);
      expect(status.rows).toEqual([expect.objectContaining({ status: 'pending' })]);
      await owner(`UPDATE enrollments SET state = 'verified', verified_at = now() WHERE id = $1`, [
        e.id,
      ]);
      for (const roles of [['manager'], ['reviewer'], ['executor', 'manager'], []]) {
        await expect(complete(e.id, e.secret, 'bad-roles-token', roles)).rejects.toMatchObject({
          code: '22023',
        });
      }
      expect(await complete(e.id, e.secret, 'good-roles-token')).toEqual([
        expect.objectContaining({ status: 'issued' }),
      ]);
    });

    it('reuses the actor for a principal, never duplicates grants, and never revokes', async () => {
      const principal = randomId('p_', 12);
      const e1 = await seedVerifiedEnrollment(f.a, { principal });
      const [first] = await complete(e1.id, e1.secret, 'reuse-token-1');
      const e2 = await seedVerifiedEnrollment(f.a, { principal });
      const [second] = await complete(e2.id, e2.secret, 'reuse-token-2');
      expect(second?.actor_id).toBe(first?.actor_id);
      // A new instance and token per enrollment; old ones stay valid; grants are not duplicated.
      expect(second?.instance_id).not.toBe(first?.instance_id);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM room_grants WHERE actor_id = $1 AND revoked_at IS NULL`,
          [first?.actor_id],
        ),
      ).toBe(1);
      expect(
        await f.count(`SELECT count(*) AS n FROM external_identities WHERE principal_id = $1`, [
          principal,
        ]),
      ).toBe(1);
      for (const token of ['reuse-token-1', 'reuse-token-2']) {
        const rows = (await f.pool.query('SELECT 1 FROM chorus_resolve_token($1)', [sha256(token)]))
          .rows;
        expect(rows, token).toHaveLength(1);
      }
      // Two DIFFERENT principals get two different actors, even when racing.
      const [ea, eb] = await Promise.all([
        seedVerifiedEnrollment(f.a),
        seedVerifiedEnrollment(f.a),
      ]);
      const [ra, rb] = await Promise.all([
        complete(ea.id, ea.secret, 'pa-token'),
        complete(eb.id, eb.secret, 'pb-token'),
      ]);
      expect(ra[0]?.actor_id).not.toBe(rb[0]?.actor_id);
      // Same principal enrolling concurrently still yields a single actor.
      const same = randomId('p_', 12);
      const [s1, s2] = await Promise.all([
        seedVerifiedEnrollment(f.a, { principal: same }),
        seedVerifiedEnrollment(f.a, { principal: same }),
      ]);
      const [c1, c2] = await Promise.all([
        complete(s1.id, s1.secret, 'same-1'),
        complete(s2.id, s2.secret, 'same-2'),
      ]);
      expect(c1[0]?.actor_id).toBe(c2[0]?.actor_id);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM actors a JOIN external_identities i ON i.actor_id = a.id WHERE i.principal_id = $1`,
          [same],
        ),
      ).toBe(1);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM room_grants WHERE actor_id = $1 AND revoked_at IS NULL`,
          [c1[0]?.actor_id],
        ),
      ).toBe(1);
    });

    it('issues nothing for a suspended room, and locks out its existing tokens', async () => {
      const room = await f.addRoom(f.a, 'suspendable');
      const e = await seedVerifiedEnrollment(f.a, { roomId: room });
      await owner(`UPDATE rooms SET activation_state = 'suspended' WHERE id = $1`, [room]);
      expect(await complete(e.id, e.secret, 'suspended-token')).toEqual([
        expect.objectContaining({ status: 'invalid' }),
      ]);
      await owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [room]);
      const [issued] = await complete(e.id, e.secret, 'resuming-token');
      expect(issued?.status).toBe('issued');
      const resolve = async () =>
        (
          await f.pool.query<Record<string, unknown>>('SELECT * FROM chorus_resolve_token($1)', [
            sha256('resuming-token'),
          ])
        ).rows;
      expect(await resolve()).toHaveLength(1);
      await owner(`UPDATE rooms SET activation_state = 'suspended' WHERE id = $1`, [room]);
      expect(await resolve()).toEqual([]);
      await owner(`UPDATE rooms SET activation_state = 'degraded' WHERE id = $1`, [room]);
      expect(await resolve()).toEqual([]);
    });

    it('produces an identity that resolves and can do real work in its room, and only there', async () => {
      const e = await seedVerifiedEnrollment(f.a);
      const [issued] = await complete(e.id, e.secret, 'e2e-token', ['executor']);
      if (issued?.actor_id == null) throw new Error('enrollment did not issue');
      const resolved = (
        await f.pool.query('SELECT * FROM chorus_resolve_token($1)', [sha256('e2e-token')])
      ).rows;
      expect(resolved).toMatchObject([
        { actor_id: issued.actor_id, workspace_id: f.a.id, actor_kind: 'agent' },
      ]);
      expect((resolved[0] as { instance_id: string | null }).instance_id).toBe(issued.instance_id);

      const created = await runCommand(
        f.ctx(f.a, issued.actor_id, 'e2e-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'by enrolled agent' }),
      );
      expect(created.version).toBe(1);
      const { retitleCommand } = await import('../helpers/fixture.ts');
      await expect(
        runCommand(
          f.ctx(f.a, issued.actor_id, 'e2e-other-room'),
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
