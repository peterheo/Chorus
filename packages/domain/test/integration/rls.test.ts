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
  'purchases',
  'payment_verification_failures',
  'conversation_scans',
  'conversation_suggestions',
  'conversation_engine_state',
  'conversation_objects',
  'conversation_transitions',
  'conversation_posts',
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
  'chorus_activate_room',
  'chorus_arena_payee',
  'chorus_conversation_seat',
  'chorus_coordination_apply',
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
  'chorus_room_lookup',
  'chorus_session_member_ids',
  'chorus_session_bump',
  'chorus_session_create_board',
  'chorus_session_live_members',
  'chorus_session_lock',
  'chorus_session_remove_member',
  'chorus_session_removal_begin',
  'chorus_session_roles',
  'chorus_session_set_policy',
  'chorus_session_set_roles',
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
    const purchaseId = await first(
      `INSERT INTO purchases (workspace_id, room_id, session_id, board_id, actor_id, requester_member_id, service,
                              request_id, fingerprint, amount, payee_member_id, payee_principal_id, memo, state)
       VALUES ($1, $2, $3, $4, $5, 'i_BuyerSeat01', 'create_tasks', 'rls-seed', $6, 1, 'i_PayeeSeat01', 'p_PayeeSeat01',
               'chorus:v1:create_tasks:seed', 'quoted') RETURNING id`,
      [w.ws.id, w.ws.roomId, w.session.id, w.session.boardId, w.manager.id, sha256('rls-seed')],
    );
    await f.owner(
      `INSERT INTO payment_verification_failures (workspace_id, actor_id, purchase_id, txn_id, reason, observed)
       VALUES ($1, $2, $3, 'txn_RlsSeed01', 'memo', '{}'::jsonb)`,
      [w.ws.id, w.manager.id, purchaseId],
    );
    await f.owner(
      `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, instance_id, room_id) VALUES ($1, $2, $3, $4, $5)`,
      [w.ws.id, w.executor.id, sha256(`${w.ws.id}-token`), w.executor.instanceId, w.ws.roomId],
    );
    const scanId = await first(
      `INSERT INTO conversation_scans
         (workspace_id, session_id, room_id, from_sequence, to_sequence, cutoff_sequence, messages_examined,
          extractor, requested_by)
       VALUES ($1, $2, $3, 1, 5, 5, 1, 'rules-v1', $4) RETURNING id`,
      [w.ws.id, w.session.id, w.ws.roomId, w.manager.id],
    );
    await f.owner(
      `INSERT INTO conversation_suggestions
         (workspace_id, session_id, kind, fingerprint, excerpt, confidence, source_message_id, source_sequence,
          source_member_id, source_principal_id, source_name, source_content_snapshot, source_content_sha256,
          replied_by_other, suggested_next_action, first_scan_id, last_scan_id)
       VALUES ($1, $2, 'question', $3, 'Who owns this?', 'high', 'msg_RlsSeed01', 1, 'i_RlsSeed01',
               'p_RlsSeed01', 'seed', 'Who owns this?', $4, false, 'Answer it.', $5, $5)`,
      [w.ws.id, w.session.id, sha256(`${w.session.id}-rls-seed`), sha256('Who owns this?'), scanId],
    );
    await f.owner(
      `INSERT INTO conversation_engine_state (workspace_id, session_id, cursor) VALUES ($1, $2, 1)`,
      [w.ws.id, w.session.id],
    );
    await f.owner(
      `INSERT INTO conversation_objects (workspace_id, session_id, ref, kind, status, body, created_seq, touched_seq)
       VALUES ($1, $2, 'Q1', 'question', 'open', '{"ref":"Q1"}'::jsonb, 1, 1)`,
      [w.ws.id, w.session.id],
    );
    await f.owner(
      `INSERT INTO conversation_transitions (workspace_id, session_id, ref, from_status, to_status, cause, reason)
       VALUES ($1, $2, 'Q1', NULL, 'open', 'message', 'seed')`,
      [w.ws.id, w.session.id],
    );
    await f.owner(
      `INSERT INTO conversation_posts (workspace_id, session_id, signal_key, message_id) VALUES ($1, $2, $3, 'msg_RlsSeed02')`,
      [w.ws.id, w.session.id, sha256(`${w.session.id}-post`)],
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

  const sessionMemberIdsAs = async (actorId: string, sessionId: string, actorIds: string[]) => {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
        [wa.ws.id, actorId],
      );
      const { rows } = await client.query<{ actor_id: string; member_id: string | null }>(
        'SELECT actor_id, member_id FROM chorus_session_member_ids($1, $2::uuid[])',
        [sessionId, actorIds],
      );
      await client.query('ROLLBACK');
      return rows;
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

    it('returns historical member IDs only for session actors and only to a live session member', async () => {
      await f.owner(
        "UPDATE agent_instances SET sharednet_member_id = 'i_ReceiptUnique01' WHERE id = $1",
        [wa.executor.instanceId],
      );
      await f.owner(
        "UPDATE agent_instances SET sharednet_member_id = 'i_ReceiptAmbig01' WHERE id = $1",
        [wa.executor2.instanceId],
      );
      await f.owner(
        "INSERT INTO agent_instances (workspace_id, actor_id, label, sharednet_member_id) VALUES ($1, $2, 'receipt ambiguous', 'i_ReceiptAmbig02')",
        [wa.ws.id, wa.executor2.id],
      );

      const rows = await sessionMemberIdsAs(wa.manager.id, wa.session.id, [
        wa.executor.id,
        wa.executor2.id,
        wa.outsider.id,
      ]);
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ actor_id: wa.executor.id, member_id: 'i_ReceiptUnique01' });
      expect(rows).toContainEqual({ actor_id: wa.executor2.id, member_id: null });
      await expect(
        sessionMemberIdsAs(wa.outsider.id, wa.session.id, [wa.executor.id]),
      ).resolves.toEqual([]);
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
      agent_instances: `CREATE TEMP TABLE agent_instances (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, actor_id uuid, label text, sharednet_member_id text, created_at timestamptz DEFAULT now())`,
      sharednet_seats: `CREATE TEMP TABLE sharednet_seats (workspace_id uuid, room_id uuid, member_id text, principal_id text, token_ciphertext bytea, token_nonce bytea, key_id text, created_at timestamptz DEFAULT now())`,
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

      it('chorus_session_member_ids ignores pg_temp sessions, members, and instances', async () => {
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
            [wa.ws.id, wa.manager.id],
          );
          await client.query(
            `CREATE TEMP TABLE sessions (id uuid, workspace_id uuid, room_id uuid, state text)`,
          );
          await client.query(LOOKALIKE['session_members'] ?? '');
          await client.query(LOOKALIKE['agent_instances'] ?? '');
          await client.query(
            `INSERT INTO pg_temp.sessions (id, workspace_id, room_id, state) VALUES ($1, $2, $3, 'active')`,
            [wa.session.id, wa.ws.id, wa.ws.roomId],
          );
          await client.query(
            `INSERT INTO pg_temp.session_members (workspace_id, session_id, actor_id, roles) VALUES ($1, $2, $3, ARRAY['participant'])`,
            [wa.ws.id, wa.session.id, wa.outsider.id],
          );
          await client.query(
            `INSERT INTO pg_temp.agent_instances (workspace_id, actor_id, label, sharednet_member_id) VALUES ($1, $2, 'forged', 'i_ForgedMember01')`,
            [wa.ws.id, wa.outsider.id],
          );
          const result = await client.query(
            'SELECT actor_id, member_id FROM chorus_session_member_ids($1, $2::uuid[])',
            [wa.session.id, [wa.outsider.id]],
          );
          expect(result.rows).toEqual([]);
          await client.query('ROLLBACK');
        } finally {
          client.release(true);
        }
      });

      it('the session definers ignore forged temp sessions, members and rooms, and refuse a non-administrator', async () => {
        const target = wa.executor2;
        const client = await f.pool.connect();
        const asActor = async (actorId: string) => {
          await client.query('ROLLBACK').catch(() => undefined);
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
            [wa.ws.id, actorId],
          );
          for (const ddl of [
            `CREATE TEMP TABLE sessions (id uuid, workspace_id uuid, room_id uuid, name text, discoverable boolean, join_policy text, listed_principals text[], policy_agent_ids text[], default_claim_policy text, manager_review_allowed boolean, default_review_required boolean, state text, version int DEFAULT 1, created_by uuid)`,
            LOOKALIKE['session_members'] ?? '',
            LOOKALIKE['room_members'] ?? '',
            `CREATE TEMP TABLE rooms (id uuid, workspace_id uuid, name text, activation_state text)`,
            `CREATE TEMP TABLE projects (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, session_id uuid, name text)`,
          ])
            await client.query(ddl);
          // The forgery: the actor is an administrator and manager of the session, in a live room.
          await client.query(
            `INSERT INTO pg_temp.rooms (id, workspace_id, name, activation_state) VALUES ($1, $2, 'r', 'active')`,
            [wa.ws.roomId, wa.ws.id],
          );
          await client.query(
            `INSERT INTO pg_temp.room_members (workspace_id, room_id, actor_id) VALUES ($1, $2, $3)`,
            [wa.ws.id, wa.ws.roomId, actorId],
          );
          await client.query(
            `INSERT INTO pg_temp.sessions (id, workspace_id, room_id, name, state) VALUES ($1, $2, $3, 'forged', 'active')`,
            [wa.session.id, wa.ws.id, wa.ws.roomId],
          );
          await client.query(
            `INSERT INTO pg_temp.session_members (workspace_id, session_id, actor_id, roles) VALUES ($1, $2, $3, ARRAY['participant','manager','administrator'])`,
            [wa.ws.id, wa.session.id, actorId],
          );
        };
        const denied = async (sql: string, params: unknown[], code = '42501') => {
          await client.query('SAVEPOINT probe');
          await expect(client.query(sql, params), sql).rejects.toMatchObject({ code });
          await client.query('ROLLBACK TO SAVEPOINT probe');
        };
        try {
          // A non-member forging membership in temp tables learns and changes nothing.
          await asActor(wa.outsider.id);
          const sid = wa.session.id;
          expect(
            (await client.query('SELECT chorus_session_roles($1) AS r', [sid])).rows[0],
          ).toEqual({ r: null });
          expect(
            (await client.query('SELECT * FROM chorus_session_lock($1, $2)', [sid, 'update'])).rows,
          ).toEqual([]);
          expect(
            (await client.query('SELECT * FROM chorus_session_live_members($1)', [sid])).rows,
          ).toEqual([]);
          await denied('SELECT chorus_session_set_policy($1, $2::jsonb)', [sid, '{"name":"x"}']);
          await denied("SELECT * FROM chorus_session_set_roles($1, $2, ARRAY['participant'])", [
            sid,
            target.id,
          ]);
          await denied('SELECT chorus_session_removal_begin($1, $2)', [sid, target.id]);
          await denied('SELECT chorus_session_remove_member($1, $2)', [sid, target.id]);
          await denied('SELECT * FROM chorus_session_create_board($1, $2)', [sid, 'b']);

          // A plain participant forging administrator/manager roles in temp tables is still a participant.
          await asActor(wa.executor.id);
          expect(
            (await client.query('SELECT chorus_session_roles($1) AS r', [sid])).rows[0],
          ).toEqual({ r: ['participant'] });
          await denied('SELECT chorus_session_set_policy($1, $2::jsonb)', [sid, '{"name":"x"}']);
          await denied(
            "SELECT * FROM chorus_session_set_roles($1, $2, ARRAY['participant','administrator'])",
            [sid, wa.executor.id],
          );
          await denied('SELECT chorus_session_removal_begin($1, $2)', [sid, target.id]); // not an administrator
          await denied('SELECT chorus_session_remove_member($1, $2)', [sid, target.id]);
          await denied('SELECT * FROM chorus_session_create_board($1, $2)', [sid, 'b']); // not a manager
          // The version bump is internal: not executable by the runtime role at all.
          await denied('SELECT chorus_session_bump($1)', [sid]);
          // A member may still leave (self-only): the begin step is allowed for themself.
          await client.query('SAVEPOINT self');
          expect(
            (
              await client.query('SELECT chorus_session_removal_begin($1, $2) AS v', [
                sid,
                wa.executor.id,
              ])
            ).rows,
          ).toHaveLength(1);
          await client.query('ROLLBACK TO SAVEPOINT self');
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release(true);
        }
        // Nothing real changed, and no temp table leaked a write into the real ones.
        const [row] = await f.owner<{ roles: string[] }>(
          'SELECT roles FROM session_members WHERE session_id = $1 AND actor_id = $2',
          [wa.session.id, wa.executor.id],
        );
        expect(row?.roles).toEqual(['participant']);
        expect(
          await f.count('SELECT count(*) AS n FROM projects WHERE session_id = $1 AND name = $2', [
            wa.session.id,
            'b',
          ]),
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
        const proofMember = rid('i_');
        const real = await f.owner<{ id: string }>(
          `INSERT INTO enrollments (workspace_id, room_id, claimed_member_id, display_name, nonce, secret_sha256, state, created_at, expires_at, start_sequence, verified_at, proof_principal_id, proof_member_id)
           VALUES ($1, $2, $3, 'legit', $4, $5, 'verified', now(), now() + interval '10 minutes', 0, now(), $6, $3) RETURNING id`,
          [
            wa.ws.id,
            wa.ws.roomId,
            proofMember,
            `cvn_${sha256(secret).slice(0, 22)}`,
            sha256(secret),
            rid('p_'),
          ],
        );
        const client = await f.pool.connect();
        let actorId: string | undefined;
        try {
          for (const table of [
            'enrollments',
            'actors',
            'room_members',
            'api_tokens',
            'agent_instances',
          ])
            await client.query(LOOKALIKE[table] ?? '');
          const { rows } = await client.query<{ status: string; actor_id: string }>(
            'SELECT * FROM chorus_enroll_complete($1, $2, $3)',
            [real[0]?.id, sha256(secret), sha256('shadow-real-token')],
          );
          expect(rows).toEqual([expect.objectContaining({ status: 'issued' })]);
          actorId = rows[0]?.actor_id;
          for (const table of ['actors', 'room_members', 'api_tokens', 'agent_instances']) {
            const temp = await client.query(`SELECT (SELECT count(*) FROM pg_temp.${table}) AS n`);
            expect(Number((temp.rows[0] as { n: string }).n), `pg_temp.${table}`).toBe(0);
          }
        } finally {
          client.release(true);
        }
        // The proven SharedNet seat is recorded on the REAL instance (0007), which is what a payment must match.
        expect(
          await f.count(
            `SELECT count(*) AS n FROM agent_instances WHERE actor_id = $1 AND sharednet_member_id = $2`,
            [actorId, proofMember],
          ),
        ).toBe(1);
        expect(await f.count('SELECT count(*) AS n FROM actors WHERE id = $1', [actorId])).toBe(1);
        expect(
          await f.count('SELECT count(*) AS n FROM room_members WHERE actor_id = $1', [actorId]),
        ).toBe(1);
      });

      it('chorus_arena_payee ignores forged temp seats, rooms and memberships, and answers only live room members', async () => {
        const w = await f.workspace(`arena-payee-${rid('', 6)}`);
        const member = await f.actor(w, 'payee-member');
        const outsider = await f.actor(w, 'payee-outsider', { inRoom: false });
        const seat = { member: rid('i_'), principal: rid('p_') };
        await f.owner(
          `INSERT INTO sharednet_seats (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'abcdef01')`,
          [w.id, w.roomId, seat.member, seat.principal, Buffer.alloc(20), Buffer.alloc(12)],
        );
        const asActor = async (actorId: string, forge: boolean) => {
          const client = await f.pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(
              `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
              [w.id, actorId],
            );
            if (forge) {
              await client.query(LOOKALIKE['rooms'] ?? '');
              await client.query(LOOKALIKE['room_members'] ?? '');
              await client.query(LOOKALIKE['sharednet_seats'] ?? '');
              await client.query(
                `INSERT INTO pg_temp.room_members (workspace_id, room_id, actor_id) VALUES ($1, $2, $3)`,
                [w.id, w.roomId, actorId],
              );
              await client.query(
                `INSERT INTO pg_temp.rooms (id, workspace_id, name, provider, external_room_id, activation_state) VALUES ($1, $2, 'x', 'sharednet', 'rom_Forged00001', 'active')`,
                [w.roomId, w.id],
              );
              await client.query(
                `INSERT INTO pg_temp.sharednet_seats (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id) VALUES ($1, $2, 'i_ForgedSeat01', 'p_ForgedSeat01', '\\x00', '\\x00', 'deadbeef')`,
                [w.id, w.roomId],
              );
            }
            return (
              await client.query<{ member_id: string }>('SELECT * FROM chorus_arena_payee($1)', [
                w.roomId,
              ])
            ).rows;
          } finally {
            await client.query('ROLLBACK').catch(() => undefined);
            client.release(true);
          }
        };
        // A live member gets the REAL seat, however the temp tables are forged.
        expect((await asActor(member.id, false)).map((r) => r.member_id)).toEqual([seat.member]);
        expect((await asActor(member.id, true)).map((r) => r.member_id)).toEqual([seat.member]);
        // A non-member gets nothing, even with a forged membership in pg_temp.
        expect(await asActor(outsider.id, false)).toEqual([]);
        expect(await asActor(outsider.id, true)).toEqual([]);
        // A room that is not active yields no payee, even to a live member.
        await f.owner(`UPDATE rooms SET activation_state = 'suspended' WHERE id = $1`, [w.roomId]);
        expect(await asActor(member.id, false)).toEqual([]);
        await f.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [w.roomId]);
        expect((await asActor(member.id, false)).map((r) => r.member_id)).toEqual([seat.member]);
        // Removing the member closes it too.
        await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [
          member.id,
        ]);
        expect(await asActor(member.id, false)).toEqual([]);
      });

      it('chorus_room_lookup and chorus_activate_room ignore forged temp workspaces, rooms, seats and cursors', async () => {
        const external = `rom_${rid('Shadow', 8)}`;
        const forgedExternal = `rom_${rid('Forged', 8)}`;
        const client = await f.pool.connect();
        try {
          for (const table of ['rooms']) await client.query(LOOKALIKE[table] ?? '');
          await client.query(
            `CREATE TEMP TABLE workspaces (id uuid DEFAULT gen_random_uuid(), name text, created_at timestamptz DEFAULT now())`,
          );
          await client.query(
            `CREATE TEMP TABLE sharednet_seats (workspace_id uuid, room_id uuid, member_id text, principal_id text, token_ciphertext bytea, token_nonce bytea, key_id text, created_at timestamptz DEFAULT now())`,
          );
          await client.query(
            `CREATE TEMP TABLE sharednet_cursors (workspace_id uuid, room_id uuid, last_sequence bigint, consumer_epoch bigint DEFAULT 0, updated_at timestamptz DEFAULT now(), last_error text, last_ok_at timestamptz)`,
          );
          // A forged, suspended binding of the room we are about to activate, and a forged active one of another.
          await client.query(
            `INSERT INTO pg_temp.rooms (workspace_id, name, provider, external_room_id, activation_state) VALUES (gen_random_uuid(), 'x', 'sharednet', $1, 'suspended'), (gen_random_uuid(), 'y', 'sharednet', $2, 'active')`,
            [external, forgedExternal],
          );
          expect(
            (await client.query('SELECT * FROM chorus_room_lookup($1)', [forgedExternal])).rows,
          ).toEqual([]);
          const { rows } = await client.query(
            'SELECT * FROM chorus_activate_room($1, $2, $3, $4, $5, $6, $7)',
            [
              external,
              'i_ShadowSeat01',
              'p_ShadowSeat01',
              Buffer.alloc(20),
              Buffer.alloc(12),
              'abcdef01',
              5,
            ],
          );
          expect(rows).toEqual([expect.objectContaining({ created: true })]);
          for (const table of ['workspaces', 'sharednet_seats', 'sharednet_cursors']) {
            const temp = await client.query(`SELECT (SELECT count(*) FROM pg_temp.${table}) AS n`);
            expect(Number((temp.rows[0] as { n: string }).n), `pg_temp.${table}`).toBe(0);
          }
        } finally {
          client.release(true);
        }
        expect(
          await f.count(
            `SELECT count(*) AS n FROM rooms WHERE external_room_id = $1 AND activation_state = 'active'`,
            [external],
          ),
        ).toBe(1);
        expect(
          await f.count(
            `SELECT count(*) AS n FROM sharednet_cursors c JOIN rooms r ON r.id = c.room_id WHERE r.external_room_id = $1 AND c.last_sequence = 5`,
            [external],
          ),
        ).toBe(1);
      });
    });
  });
});
