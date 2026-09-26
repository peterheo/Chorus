import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture, type Workspace } from '../helpers/fixture.ts';
import { makeWorld, newTask, requestReviewAs, taskInReview, type World } from '../helpers/world.ts';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const rid = (prefix: string, n = 12) => `${prefix}${randomBytes(n).toString('hex').slice(0, n)}`;

/** Tables the runtime role may read; each carries workspace_id (workspaces: id). */
const READABLE = [
  'workspaces',
  'actors',
  'agent_instances',
  'rooms',
  'room_members',
  'sessions',
  'session_members',
  'projects',
  'work_items',
  'task_details',
  'task_criteria_revisions',
  'task_leases',
  'task_result_revisions',
  'review_details',
  'claim_requests',
  'comments',
  'proposal_details',
  'message_links',
  'commands',
  'domain_events',
  'sharedos_audit_events',
] as const;
/** Tables with no privileges for the runtime role at all. */
const NO_ACCESS = [
  'api_tokens',
  'session_join_credentials',
  'sharednet_seats',
  'sharednet_cursors',
  'external_identities',
  'enrollments',
] as const;

const DEFINERS = [
  'chorus_create_session',
  'chorus_enroll_complete',
  'chorus_enroll_start',
  'chorus_enroll_status',
  'chorus_enroll_verify',
  'chorus_expire_enrollments',
  'chorus_join_session',
  'chorus_my_sessions',
  'chorus_resolve_token',
  'chorus_room_health',
  'chorus_set_room_state',
  'chorus_watcher_advance',
  'chorus_watcher_claim_epoch',
  'chorus_watcher_rooms',
];

describe('row-level security and definer functions, as the runtime role chorus_app (real PostgreSQL)', () => {
  let f: Fixture;
  let wa: World;
  let wb: World;
  let ws: Workspace;

  const workspaceColumn = (table: string) => (table === 'workspaces' ? 'id' : 'workspace_id');
  const first = async (sql: string, params: unknown[] = []): Promise<string> => {
    const [row] = await f.owner<{ id: string }>(sql, params);
    if (row === undefined) throw new Error('expected a row');
    return row.id;
  };

  /** Populate every readable table for a world (owner-side where no command makes the row). */
  async function seedEverything(w: World): Promise<void> {
    const task = await taskInReview(w);
    await requestReviewAs(w, task.taskId, task.version, 1);
    await f.owner(
      `INSERT INTO comments (workspace_id, session_id, item_id, author_actor_id, body) VALUES ($1, $2, $3, $4, 'c')`,
      [w.ws.id, w.session.id, task.taskId, w.executor.id],
    );
    await f.owner(
      `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id) VALUES ($1, $2, $3, $4)`,
      [w.ws.id, w.session.id, task.taskId, w.reviewer2.id],
    );
    const proposal = await first(
      `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, $2, $3, 'proposal', $4, 'p', 'open', $5) RETURNING id`,
      [w.ws.id, w.session.id, w.session.boardId, w.ws.roomId, w.executor.id],
    );
    await f.owner(
      `INSERT INTO proposal_details (workspace_id, session_id, proposal_item_id, target_item_id, change_kind, payload) VALUES ($1, $2, $3, $4, 'edit', '{}')`,
      [w.ws.id, w.session.id, proposal, task.taskId],
    );
    await f.owner(
      `INSERT INTO message_links (workspace_id, session_id, item_id, sharednet_message_id, sharednet_sequence, sender_principal_id, sender_member_id, content_snapshot, content_sha256, linked_by)
       VALUES ($1, $2, $3, 'msg_1', 3, 'p_abcdef1', 'i_abcdef1', 't', $4, $5)`,
      [w.ws.id, w.session.id, task.taskId, sha256('t'), w.executor.id],
    );
    await f.owner(
      `INSERT INTO sharedos_audit_events (workspace_id, event) VALUES ($1, '{"traceId":"t"}')`,
      [w.ws.id],
    );
    await f.owner(
      `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id, room_id) VALUES ($1, $2, $3, $4, $5)`,
      [w.ws.id, w.executor.id, sha256(`${w.ws.id}-token`), w.executor.instanceId, w.ws.roomId],
    );
  }

  beforeAll(async () => {
    f = await createFixture({ poolMax: 12 });
    ws = await f.workspace('rls-a');
    wa = await makeWorld(f, ws);
    wb = await makeWorld(f, await f.workspace('rls-b'));
    await seedEverything(wa);
    await seedEverything(wb);
  });
  afterAll(async () => {
    await f.close();
  });

  const as = (w: World, actorId: string) => ({ workspaceId: w.ws.id, actorId });
  const countAs = async (
    ctx: { workspaceId: string; actorId: string },
    table: string,
    where = 'true',
  ) => {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
        [ctx.workspaceId, ctx.actorId],
      );
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
      );
      await client.query('ROLLBACK');
      return Number(rows[0]?.n);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  describe('the runtime role itself', () => {
    it('is chorus_app: not a superuser, no BYPASSRLS, and owns nothing', async () => {
      const { rows } = await f.pool.query<{ current_user: string }>('SELECT current_user');
      expect(rows[0]?.current_user).toBe('chorus_app');
      const [role] = await f.owner<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'chorus_app'`);
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
      expect(
        await f.count(
          `SELECT count(*) AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'chorus_app'`,
        ),
      ).toBe(0);
    });

    it('has RLS enabled AND forced on every table except schema_migrations and admin_audit_log', async () => {
      const tables = await f.owner<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT IN ('schema_migrations', 'admin_audit_log')`,
      );
      expect(tables.map((t) => t.relname).sort()).toEqual([...READABLE, ...NO_ACCESS].sort());
      for (const t of tables)
        expect(t, `${t.relname} must enable and force RLS`).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
      const exempt = await f.owner<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1`,
      );
      expect(exempt.map((t) => t.relname)).toEqual(['admin_audit_log', 'schema_migrations']);
      await expect(f.pool.query('SELECT 1 FROM admin_audit_log')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        f.pool.query(`INSERT INTO admin_audit_log (operator, command) VALUES ('x', 'y')`),
      ).rejects.toMatchObject({ code: '42501' });
      await f.owner(`INSERT INTO admin_audit_log (operator, command) VALUES ('op', 'test')`);
      await expect(f.owner(`UPDATE admin_audit_log SET command = 'x'`)).rejects.toMatchObject({
        code: '23000',
      });
      await expect(f.owner('DELETE FROM admin_audit_log')).rejects.toMatchObject({ code: '23000' });
    });

    it('lets only the intended SECURITY DEFINER functions bypass RLS, hardened against pg_temp shadowing', async () => {
      const fns = await f.owner<{
        proname: string;
        proconfig: string[] | null;
        proacl: string | null;
      }>(
        `SELECT p.proname, p.proconfig, p.proacl::text AS proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
      );
      expect(fns.map((x) => x.proname)).toEqual([...DEFINERS].sort());
      for (const fn of fns) {
        expect(fn.proconfig, fn.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(fn.proacl ?? '', `${fn.proname} must not be executable by PUBLIC`).not.toMatch(
          /(^|[{,])=X/,
        );
      }
    });

    it('has no privileges on the definer-only tables', async () => {
      for (const table of NO_ACCESS) {
        await expect(countAs(as(wa, wa.executor.id), table), table).rejects.toMatchObject({
          code: '42501',
        });
      }
    });
  });

  describe('workspace isolation', () => {
    it('shows workspace B nothing of workspace A in any tenant table (and each its own rows)', async () => {
      for (const table of READABLE) {
        const column = workspaceColumn(table);
        const own = await countAs(as(wb, wb.manager.id), table, `${column} = '${wb.ws.id}'`);
        expect(own, `${table}: control, B should see its own rows`).toBeGreaterThan(0);
        expect(
          await countAs(as(wb, wb.manager.id), table, `${column} = '${wa.ws.id}'`),
          `${table}: B must see none of A`,
        ).toBe(0);
        expect(
          await countAs(as(wa, wa.manager.id), table, `${column} = '${wa.ws.id}'`),
          `${table}: control A`,
        ).toBeGreaterThan(0);
      }
    });

    it('fails closed: with no context set, nothing is visible', async () => {
      for (const table of READABLE) {
        const { rows } = await f.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
        expect(Number(rows[0]?.n), table).toBe(0);
      }
    });

    it('does not leak context to the next user of a pooled connection', async () => {
      const t = await newTask(wa);
      expect(t.id).toBeTruthy();
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

    it('rejects writes into another workspace or another session via WITH CHECK', async () => {
      const write = async (w: World, actor: string, session: string, workspace: string) => {
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
            [w.ws.id, actor],
          );
          await client.query(
            `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
             VALUES ($1, $2, $3, 'task', $4, 'smuggled', 'ready', $5)`,
            [workspace, session, w.session.boardId, w.ws.roomId, actor],
          );
          await client.query('ROLLBACK');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };
      await expect(write(wa, wa.executor.id, wb.session.id, wb.ws.id)).rejects.toMatchObject({
        code: '42501',
      });
      const otherSession = await f.session(wa.manager);
      await expect(write(wa, wa.executor.id, otherSession.id, wa.ws.id)).rejects.toMatchObject({
        code: '42501',
      });
      expect(await f.count(`SELECT count(*) AS n FROM work_items WHERE title = 'smuggled'`)).toBe(
        0,
      );
    });

    it('cannot grant itself access: the runtime role cannot insert sessions or session members', async () => {
      await expect(
        f.pool.query(
          `INSERT INTO session_members (workspace_id, session_id, actor_id, roles) VALUES ($1, $2, $3, ARRAY['participant'])`,
          [wa.ws.id, wb.session.id, wa.executor.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        f.pool.query(
          `INSERT INTO sessions (workspace_id, room_id, name, created_by) VALUES ($1, $2, 'x', $3)`,
          [wa.ws.id, wa.ws.roomId, wa.executor.id],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('append-only guarantees at the privilege level', () => {
    it.each([
      'UPDATE task_result_revisions SET content_type = $1',
      'DELETE FROM task_result_revisions WHERE content_type <> $1',
      'UPDATE domain_events SET event_type = $1',
      'DELETE FROM domain_events WHERE event_type <> $1',
      'DELETE FROM commands WHERE command_type <> $1',
      'UPDATE comments SET body = $1',
      "DELETE FROM task_criteria_revisions WHERE created_by IS NOT NULL AND $1 <> ''",
      "UPDATE sharedos_audit_events SET event = '{}' WHERE $1 <> ''",
    ])('denies %s', async (sql) => {
      await expect(f.pool.query(sql, ['x'])).rejects.toMatchObject({ code: '42501' });
    });
    it('denies TRUNCATE on the immutable tables', async () => {
      for (const table of [
        'task_result_revisions',
        'domain_events',
        'commands',
        'comments',
        'message_links',
      ]) {
        await expect(f.pool.query(`TRUNCATE ${table}`)).rejects.toMatchObject({ code: '42501' });
      }
    });
  });

  describe('chorus_my_sessions and room membership', () => {
    it('reflects live session membership, live room membership and an active room', async () => {
      const actor = wa.executor.id;
      const mine = async () => {
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
            [wa.ws.id, actor],
          );
          const { rows } = await client.query<{ id: string }>('SELECT chorus_my_sessions() AS id');
          await client.query('ROLLBACK');
          return rows.map((r) => r.id);
        } finally {
          client.release();
        }
      };
      expect(await mine()).toEqual([wa.session.id]);
      await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [actor]);
      expect(await mine()).toEqual([]);
      await f.owner('UPDATE room_members SET removed_at = NULL WHERE actor_id = $1', [actor]);
      await f.owner(`UPDATE rooms SET activation_state = 'degraded' WHERE id = $1`, [wa.ws.roomId]);
      expect(await mine()).toEqual([]);
      await f.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [wa.ws.roomId]);
      await f.owner(
        'UPDATE session_members SET removed_at = now() WHERE actor_id = $1 AND session_id = $2',
        [actor, wa.session.id],
      );
      expect(await mine()).toEqual([]);
      await f.owner(
        'UPDATE session_members SET removed_at = NULL WHERE actor_id = $1 AND session_id = $2',
        [actor, wa.session.id],
      );
      expect(await mine()).toEqual([wa.session.id]);
    });
  });

  describe('token resolution (SECURITY DEFINER)', () => {
    const resolve = async (token: string) =>
      (
        await f.pool.query<{
          actor_id: string;
          workspace_id: string;
          actor_kind: string;
          instance_id: string | null;
          room_id: string;
          token_expires_at: Date | null;
        }>('SELECT * FROM chorus_resolve_token($1)', [sha256(token)])
      ).rows;
    let issued = 0;
    const issue = async (
      w: World,
      over: { revoked?: boolean; expires?: string; actor?: string } = {},
    ) => {
      const actor = await f.actor(w.ws, `res${String(++issued)}`);
      const token = rid('tok_', 16);
      await f.owner(
        `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id, room_id, revoked_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, ${over.revoked === true ? 'now()' : 'NULL'}, ${over.expires ?? 'NULL'})`,
        [w.ws.id, actor.id, sha256(token), actor.instanceId, w.ws.roomId],
      );
      return { token, actor };
    };

    it('resolves a live token to actor, workspace, kind, instance, expiry and room only', async () => {
      const { token, actor } = await issue(wa, { expires: `now() + interval '1 hour'` });
      const rows = await resolve(token);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: actor.id,
        workspace_id: wa.ws.id,
        actor_kind: 'agent',
        instance_id: actor.instanceId,
        room_id: wa.ws.roomId,
      });
      expect(rows[0]?.token_expires_at).toBeInstanceOf(Date);
    });

    it('returns nothing for revoked, expired, unknown tokens, removed room members and inactive rooms', async () => {
      expect(await resolve((await issue(wa, { revoked: true })).token)).toEqual([]);
      expect(
        await resolve((await issue(wa, { expires: `now() - interval '1 second'` })).token),
      ).toEqual([]);
      expect(await resolve('never-issued')).toEqual([]);
      const { token, actor } = await issue(wa);
      expect(await resolve(token)).toHaveLength(1);
      await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [actor.id]);
      expect(await resolve(token)).toEqual([]);
      await f.owner('UPDATE room_members SET removed_at = NULL WHERE actor_id = $1', [actor.id]);
      for (const state of ['suspended', 'degraded', 'inactive']) {
        await f.owner('UPDATE rooms SET activation_state = $2 WHERE id = $1', [
          wa.ws.roomId,
          state,
        ]);
        expect(await resolve(token), state).toEqual([]);
      }
      await f.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [wa.ws.roomId]);
      expect(await resolve(token)).toHaveLength(1);
    });

    it("cannot create an agent token without an instance, or with another actor's instance", async () => {
      const x = await f.actor(wa.ws, 'tokx');
      const y = await f.actor(wa.ws, 'toky');
      const insert = (actor: string, instance: string | null) =>
        f.owner(
          `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id, room_id) VALUES ($1, $2, $3, $4, $5)`,
          [wa.ws.id, actor, sha256(rid('t')), instance, wa.ws.roomId],
        );
      await expect(insert(x.id, null)).rejects.toMatchObject({ code: '23000' });
      await expect(insert(x.id, y.instanceId)).rejects.toMatchObject({ code: '23000' });
      await insert(x.id, x.instanceId);
      await expect(insert(y.id, x.instanceId)).rejects.toMatchObject({ code: '23000' });
    });
  });

  describe('enrollment definers', () => {
    async function seedVerified(
      w: World,
      opts: { principal?: string; agentTag?: string | null; secret?: string; roomId?: string } = {},
    ) {
      const secret = opts.secret ?? rid('cvs_', 30);
      const principal = opts.principal ?? rid('p_');
      const member = rid('i_');
      const nonce = `cvn_${sha256(secret).slice(0, 22)}`;
      const id = await first(
        `INSERT INTO enrollments (workspace_id, room_id, claimed_member_id, display_name, nonce, secret_sha256, state, created_at, expires_at,
                                  start_sequence, verified_at, proof_message_id, proof_sequence, proof_principal_id, proof_member_id, proof_agent_id)
         VALUES ($1, $2, $3, 'enrolled', $4, $5, 'verified', now(), now() + interval '10 minutes', 0, now(), 'msg', 5, $6, $3, $7) RETURNING id`,
        [
          w.ws.id,
          opts.roomId ?? w.ws.roomId,
          member,
          nonce,
          sha256(secret),
          principal,
          opts.agentTag ?? null,
        ],
      );
      return { id, secret, principal, member };
    }
    const complete = async (id: string, secret: string, token: string) =>
      (
        await f.pool.query<{
          status: string;
          actor_id: string | null;
          workspace_id: string | null;
          room_id: string | null;
          instance_id: string | null;
          token_expires_at: Date | null;
        }>('SELECT * FROM chorus_enroll_complete($1, $2, $3)', [id, sha256(secret), sha256(token)])
      ).rows;

    it('lets exactly one of 10 concurrent completions issue a token, creating one actor, member and instance', async () => {
      const e = await seedVerified(wa, { agentTag: 'tag_alpha' });
      const before = await f.count('SELECT count(*) AS n FROM actors WHERE workspace_id = $1', [
        wa.ws.id,
      ]);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => complete(e.id, e.secret, `race-${String(i)}`)),
      );
      const issued = results.flat().filter((r) => r.status === 'issued');
      expect(issued).toHaveLength(1);
      expect(results.flat().filter((r) => r.status === 'invalid')).toHaveLength(9);
      const won = issued[0];
      expect(won).toMatchObject({ workspace_id: wa.ws.id, room_id: wa.ws.roomId });
      expect(
        await f.count('SELECT count(*) AS n FROM actors WHERE workspace_id = $1', [wa.ws.id]),
      ).toBe(before + 1);
      expect(
        await f.count('SELECT count(*) AS n FROM agent_instances WHERE actor_id = $1', [
          won?.actor_id,
        ]),
      ).toBe(1);
      expect(
        await f.count(
          'SELECT count(*) AS n FROM room_members WHERE actor_id = $1 AND agent_tag = $2 AND removed_at IS NULL',
          [won?.actor_id, 'tag_alpha'],
        ),
      ).toBe(1);
      // Enrollment grants membership of the ROOM only; no session access.
      expect(
        await f.count('SELECT count(*) AS n FROM session_members WHERE actor_id = $1', [
          won?.actor_id,
        ]),
      ).toBe(0);
      const [row] = await f.owner<{ state: string; issued_actor_id: string }>(
        'SELECT state, issued_actor_id FROM enrollments WHERE id = $1',
        [e.id],
      );
      expect(row).toEqual({ state: 'consumed', issued_actor_id: won?.actor_id });
    });

    it('answers unknown, wrong-secret, consumed and expired enrollments identically', async () => {
      const e = await seedVerified(wa);
      expect(await complete(e.id, e.secret, 'enr-once-1')).toHaveLength(1);
      const consumed = await complete(e.id, e.secret, 'enr-once-2');
      const wrongSecret = await complete(
        (await seedVerified(wa)).id,
        'not-the-secret',
        'enr-wrong',
      );
      const unknown = await complete(
        '00000000-0000-4000-8000-000000000000',
        e.secret,
        'enr-unknown',
      );
      const expired = await seedVerified(wa);
      await f.owner(`UPDATE enrollments SET state = 'expired' WHERE id = $1`, [expired.id]);
      const stale = await complete(expired.id, expired.secret, 'enr-expired');
      for (const result of [consumed, wrongSecret, unknown, stale]) {
        expect(result).toEqual([
          {
            status: 'invalid',
            actor_id: null,
            workspace_id: null,
            room_id: null,
            instance_id: null,
            token_expires_at: null,
          },
        ]);
      }
      expect(
        await f.count('SELECT count(*) AS n FROM api_tokens WHERE token_sha256 = ANY($1::text[])', [
          ['enr-once-2', 'enr-wrong', 'enr-unknown', 'enr-expired'].map(sha256) as never,
        ]),
      ).toBe(0);
    });

    it('reports pending until verified, reuses the actor per principal, never duplicates identity, refuses removed members and inactive rooms', async () => {
      const e = await seedVerified(wa);
      await f.owner(`UPDATE enrollments SET state = 'pending', verified_at = NULL WHERE id = $1`, [
        e.id,
      ]);
      expect(await complete(e.id, e.secret, 'pend')).toEqual([
        expect.objectContaining({ status: 'pending' }),
      ]);
      const status = await f.pool.query('SELECT * FROM chorus_enroll_status($1, $2)', [
        e.id,
        sha256(e.secret),
      ]);
      expect(status.rows).toEqual([expect.objectContaining({ status: 'pending' })]);

      const principal = rid('p_');
      const e1 = await seedVerified(wa, { principal });
      const e2 = await seedVerified(wa, { principal });
      const [r1] = await complete(e1.id, e1.secret, 'reuse-1');
      const [r2] = await complete(e2.id, e2.secret, 'reuse-2');
      expect(r2?.actor_id).toBe(r1?.actor_id);
      expect(r2?.instance_id).not.toBe(r1?.instance_id);
      expect(
        await f.count('SELECT count(*) AS n FROM external_identities WHERE principal_id = $1', [
          principal,
        ]),
      ).toBe(1);
      expect(
        await f.count('SELECT count(*) AS n FROM room_members WHERE actor_id = $1', [r1?.actor_id]),
      ).toBe(1);
      // Same principal enrolling concurrently still yields one actor.
      const same = rid('p_');
      const [s1, s2] = await Promise.all([
        seedVerified(wa, { principal: same }),
        seedVerified(wa, { principal: same }),
      ]);
      const [c1, c2] = await Promise.all([
        complete(s1.id, s1.secret, 'same-1'),
        complete(s2.id, s2.secret, 'same-2'),
      ]);
      expect(c1[0]?.actor_id).toBe(c2[0]?.actor_id);
      // A member removed from the room is not silently re-admitted.
      await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [
        r1?.actor_id,
      ]);
      const again = await seedVerified(wa, { principal });
      expect(await complete(again.id, again.secret, 'removed')).toEqual([
        expect.objectContaining({ status: 'invalid' }),
      ]);
      // Suspended rooms issue nothing.
      const room = await f.addRoom(wa.ws, 'suspendable');
      const susp = await seedVerified(wa, { roomId: room.roomId });
      await f.owner(`UPDATE rooms SET activation_state = 'suspended' WHERE id = $1`, [room.roomId]);
      expect(await complete(susp.id, susp.secret, 'susp')).toEqual([
        expect.objectContaining({ status: 'invalid' }),
      ]);
    });
  });

  describe('watcher definers', () => {
    it('claim_epoch increments; advance needs the current epoch; the cursor never regresses; only degrade is allowed', async () => {
      const w = await makeWorld(f, await f.workspace('watcher'));
      await f.owner(
        `UPDATE rooms SET provider = 'sharednet', external_room_id = 'rom_WatcherRoom1', activation_state = 'active' WHERE id = $1`,
        [w.ws.roomId],
      );
      await f.owner(
        `INSERT INTO sharednet_cursors (workspace_id, room_id, last_sequence) VALUES ($1, $2, 0)`,
        [w.ws.id, w.ws.roomId],
      );
      const claimEpoch = async () =>
        Number(
          (
            await f.pool.query<{ e: string }>('SELECT chorus_watcher_claim_epoch($1, $2) AS e', [
              w.ws.id,
              w.ws.roomId,
            ])
          ).rows[0]?.e,
        );
      const advance = (seq: number, epoch: number) =>
        f.pool.query('SELECT chorus_watcher_advance($1, $2, $3, $4, true, NULL)', [
          w.ws.id,
          w.ws.roomId,
          seq,
          epoch,
        ]);
      const e1 = await claimEpoch();
      await advance(5, e1);
      const e2 = await claimEpoch();
      expect(e2).toBe(e1 + 1);
      await expect(advance(9, e1)).rejects.toMatchObject({ code: 'CH003' }); // a slow ex-holder is fenced out
      await expect(advance(3, e2)).rejects.toMatchObject({ code: 'CH002' }); // never regresses
      await advance(9, e2);
      expect(
        await f.count(
          'SELECT count(*) AS n FROM sharednet_cursors WHERE room_id = $1 AND last_sequence = 9 AND consumer_epoch = $2',
          [w.ws.roomId, e2],
        ),
      ).toBe(1);
      await expect(
        f.pool.query(`SELECT chorus_set_room_state($1, $2, 'active', 'x')`, [w.ws.id, w.ws.roomId]),
      ).rejects.toMatchObject({ code: '22023' });
      const degraded = await f.pool.query<{ ok: boolean }>(
        `SELECT chorus_set_room_state($1, $2, 'degraded', 'boom') AS ok`,
        [w.ws.id, w.ws.roomId],
      );
      expect(degraded.rows[0]?.ok).toBe(true);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM rooms WHERE id = $1 AND activation_state = 'degraded'`,
          [w.ws.roomId],
        ),
      ).toBe(1);
    });
  });

  describe('pg_temp shadowing of SECURITY DEFINER functions', () => {
    const LOOKALIKE: Record<string, string> = {
      session_members: `CREATE TEMP TABLE session_members (workspace_id uuid, session_id uuid, actor_id uuid, roles text[], joined_at timestamptz DEFAULT now(), removed_at timestamptz, version int DEFAULT 1)`,
      room_members: `CREATE TEMP TABLE room_members (workspace_id uuid, room_id uuid, actor_id uuid, first_verified_at timestamptz DEFAULT now(), last_verified_at timestamptz DEFAULT now(), removed_at timestamptz, agent_tag text)`,
      rooms: `CREATE TEMP TABLE rooms (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, name text, created_at timestamptz DEFAULT now(), provider text, external_room_id text, activation_state text)`,
      sessions: `CREATE TEMP TABLE sessions (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, room_id uuid, name text, discoverable boolean, join_policy text, listed_principals text[], policy_agent_ids text[], state text, created_by uuid)`,
      api_tokens: `CREATE TEMP TABLE api_tokens (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, actor_id uuid, token_sha256 text, instance_id uuid, room_id uuid, created_at timestamptz DEFAULT now(), expires_at timestamptz, revoked_at timestamptz)`,
      enrollments: `CREATE TEMP TABLE enrollments (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, room_id uuid, claimed_member_id text, display_name text, nonce text, secret_sha256 text, state text, created_at timestamptz DEFAULT now(), expires_at timestamptz, start_sequence bigint, verified_at timestamptz, proof_message_id text, proof_sequence bigint, proof_principal_id text, proof_member_id text, proof_agent_id text, consumed_at timestamptz, issued_actor_id uuid, issued_token_id uuid)`,
      actors: `CREATE TEMP TABLE actors (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, kind text, display_name text, created_at timestamptz DEFAULT now())`,
    };
    const db = () => f.db.url.split('/').pop() ?? '';

    it('gives the runtime role no TEMP privilege by default', async () => {
      await expect(f.pool.query('CREATE TEMP TABLE probe (x int)')).rejects.toMatchObject({
        code: '42501',
      });
    });

    describe('even if TEMP were granted, forged temp tables are ignored', () => {
      beforeAll(async () => {
        await f.owner(`GRANT TEMPORARY ON DATABASE ${db()} TO chorus_app`);
      });
      afterAll(async () => {
        await f.owner(`REVOKE TEMPORARY ON DATABASE ${db()} FROM chorus_app`);
      });

      it('chorus_join_session and chorus_my_sessions ignore forged membership', async () => {
        const outsider = wa.outsider;
        const hidden = await f.session(wa.manager, { discoverable: false, joinPolicy: 'listed' });
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
            [wa.ws.id, outsider.id],
          );
          await client.query(LOOKALIKE['session_members'] ?? '');
          await client.query(LOOKALIKE['sessions'] ?? '');
          await client.query(
            `INSERT INTO pg_temp.session_members (workspace_id, session_id, actor_id, roles) VALUES ($1, $2, $3, ARRAY['participant','manager','administrator'])`,
            [wa.ws.id, hidden.id, outsider.id],
          );
          const mine = await client.query('SELECT chorus_my_sessions() AS id');
          expect(mine.rows.map((r: { id: string }) => r.id)).not.toContain(hidden.id);
          const joined = await client.query('SELECT * FROM chorus_join_session($1, NULL)', [
            hidden.id,
          ]);
          expect(joined.rows).toEqual([]);
          await client.query('ROLLBACK');
        } finally {
          client.release(true);
        }
        expect(
          await f.count(
            'SELECT count(*) AS n FROM session_members WHERE session_id = $1 AND actor_id = $2',
            [hidden.id, outsider.id],
          ),
        ).toBe(0);
      });

      it('chorus_resolve_token ignores forged temp tokens, members, rooms and actors', async () => {
        const actor = await f.actor(wa.ws, 'shadow-target');
        const token = rid('tok_', 16);
        const forged = rid('forged_', 16);
        await f.owner(
          `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id, room_id) VALUES ($1, $2, $3, $4, $5)`,
          [wa.ws.id, actor.id, sha256(token), actor.instanceId, wa.ws.roomId],
        );
        await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [actor.id]);
        const client = await f.pool.connect();
        try {
          for (const table of ['api_tokens', 'room_members', 'rooms', 'actors'])
            await client.query(LOOKALIKE[table] ?? '');
          await client.query(
            `INSERT INTO pg_temp.room_members (workspace_id, room_id, actor_id) VALUES ($1, $2, $3)`,
            [wa.ws.id, wa.ws.roomId, actor.id],
          );
          await client.query(
            `INSERT INTO pg_temp.api_tokens (workspace_id, actor_id, token_sha256, instance_id, room_id) VALUES ($1, $2, $3, $4, $5)`,
            [wa.ws.id, actor.id, sha256(forged), actor.instanceId, wa.ws.roomId],
          );
          await client.query(
            `INSERT INTO pg_temp.actors (id, workspace_id, kind, display_name) VALUES ($1, $2, 'human', 'forged')`,
            [actor.id, wa.ws.id],
          );
          // The real member was removed: the forged temp membership must not resurrect the token.
          expect(
            (await client.query('SELECT * FROM chorus_resolve_token($1)', [sha256(token)])).rows,
          ).toEqual([]);
          expect(
            (await client.query('SELECT * FROM chorus_resolve_token($1)', [sha256(forged)])).rows,
          ).toEqual([]);
        } finally {
          client.release(true);
        }
      });

      it('chorus_enroll_complete ignores forged temp enrollments and writes only to real tables', async () => {
        const secret = rid('cvs_', 30);
        const real = await f.owner<{ id: string }>(
          `INSERT INTO enrollments (workspace_id, room_id, claimed_member_id, display_name, nonce, secret_sha256, state, created_at, expires_at, start_sequence, verified_at, proof_principal_id, proof_member_id)
           VALUES ($1, $2, $3, 'legit', $4, $5, 'verified', now(), now() + interval '10 minutes', 0, now(), $6, $3) RETURNING id`,
          [
            wa.ws.id,
            wa.ws.roomId,
            rid('i_'),
            `cvn_${sha256(secret).slice(0, 22)}`,
            sha256(secret),
            rid('p_'),
          ],
        );
        const client = await f.pool.connect();
        let actorId: string | undefined;
        try {
          for (const table of ['enrollments', 'actors', 'room_members', 'api_tokens'])
            await client.query(LOOKALIKE[table] ?? '');
          const { rows } = await client.query<{ status: string; actor_id: string }>(
            'SELECT * FROM chorus_enroll_complete($1, $2, $3)',
            [real[0]?.id, sha256(secret), sha256('shadow-real-token')],
          );
          expect(rows).toEqual([expect.objectContaining({ status: 'issued' })]);
          actorId = rows[0]?.actor_id;
          for (const table of ['actors', 'room_members', 'api_tokens']) {
            const temp = await client.query(`SELECT (SELECT count(*) FROM pg_temp.${table}) AS n`);
            expect(Number((temp.rows[0] as { n: string }).n), `pg_temp.${table}`).toBe(0);
          }
        } finally {
          client.release(true);
        }
        expect(await f.count('SELECT count(*) AS n FROM actors WHERE id = $1', [actorId])).toBe(1);
        expect(
          await f.count('SELECT count(*) AS n FROM room_members WHERE actor_id = $1', [actorId]),
        ).toBe(1);
      });
    });
  });
});
