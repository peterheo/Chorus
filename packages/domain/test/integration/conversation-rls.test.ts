import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, type Fixture } from '../helpers/fixture.ts';

const rid = (prefix: string, n = 12) => `${prefix}${randomBytes(n).toString('hex').slice(0, n)}`;

/**
 * CC10 (definer shadow only; the global RLS meta-test in `rls.test.ts` already covers the new tables'
 * ENABLE+FORCE, grants and the definer's search_path/EXECUTE hardening).
 */
describe('chorus_conversation_seat: hostile pg_temp shadowing (real PostgreSQL, GRANT TEMPORARY)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture({ poolMax: 8 });
  });
  afterAll(async () => {
    await f.close();
  });

  const db = () => f.db.url.split('/').pop() ?? '';

  it('ignores forged temp sessions, rooms, memberships and seats, and answers only a live session member', async () => {
    const ws = await f.workspace(`convo-seat-${rid('', 6)}`);
    const member = await f.actor(ws, 'seat-member');
    const outsider = await f.actor(ws, 'seat-outsider', { inRoom: false });
    const session = await f.session(member);
    const seat = { member: rid('i_'), external: `rom_${rid('Real', 8)}` };
    await f.owner(`UPDATE rooms SET provider = 'sharednet', external_room_id = $2 WHERE id = $1`, [
      ws.roomId,
      seat.external,
    ]);
    await f.owner(
      `INSERT INTO sharednet_seats (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'abcdef01')`,
      [ws.id, ws.roomId, seat.member, `p_${rid('')}`, Buffer.alloc(20), Buffer.alloc(12)],
    );

    await f.owner(`GRANT TEMPORARY ON DATABASE ${db()} TO chorus_app`);
    try {
      const asActor = async (actorId: string, sessionId: string, forge: boolean) => {
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
            [ws.id, actorId],
          );
          if (forge) {
            await client.query(
              `CREATE TEMP TABLE sessions (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, room_id uuid, name text, discoverable boolean, join_policy text, listed_principals text[], policy_agent_ids text[], state text, created_by uuid)`,
            );
            await client.query(
              `CREATE TEMP TABLE session_members (workspace_id uuid, session_id uuid, actor_id uuid, roles text[], joined_at timestamptz DEFAULT now(), removed_at timestamptz, version int DEFAULT 1)`,
            );
            await client.query(
              `CREATE TEMP TABLE rooms (id uuid DEFAULT gen_random_uuid(), workspace_id uuid, name text, created_at timestamptz DEFAULT now(), provider text, external_room_id text, activation_state text)`,
            );
            await client.query(
              `CREATE TEMP TABLE room_members (workspace_id uuid, room_id uuid, actor_id uuid, first_verified_at timestamptz DEFAULT now(), last_verified_at timestamptz DEFAULT now(), removed_at timestamptz, agent_tag text)`,
            );
            await client.query(
              `CREATE TEMP TABLE sharednet_seats (workspace_id uuid, room_id uuid, member_id text, principal_id text, token_ciphertext bytea, token_nonce bytea, key_id text, created_at timestamptz DEFAULT now())`,
            );
            await client.query(
              `INSERT INTO pg_temp.sessions (id, workspace_id, room_id) VALUES ($1, $2, $3)`,
              [sessionId, ws.id, ws.roomId],
            );
            await client.query(
              `INSERT INTO pg_temp.session_members (workspace_id, session_id, actor_id, roles) VALUES ($1, $2, $3, ARRAY['participant'])`,
              [ws.id, sessionId, actorId],
            );
            await client.query(
              `INSERT INTO pg_temp.room_members (workspace_id, room_id, actor_id) VALUES ($1, $2, $3)`,
              [ws.id, ws.roomId, actorId],
            );
            await client.query(
              `INSERT INTO pg_temp.rooms (id, workspace_id, provider, external_room_id, activation_state) VALUES ($1, $2, 'sharednet', $3, 'active')`,
              [ws.roomId, ws.id, `rom_${rid('Forged', 6)}`],
            );
            await client.query(
              `INSERT INTO pg_temp.sharednet_seats (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id) VALUES ($1, $2, 'i_ForgedSeat1', 'p_ForgedSeat1', '\\x00', '\\x00', 'deadbeef')`,
              [ws.id, ws.roomId],
            );
          }
          return (
            await client.query<{ member_id: string; external_room_id: string }>(
              'SELECT * FROM chorus_conversation_seat($1)',
              [sessionId],
            )
          ).rows;
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release(true);
        }
      };

      // A live member gets the REAL seat, whether or not the temp tables are forged.
      expect((await asActor(member.id, session.id, false)).map((r) => r.member_id)).toEqual([
        seat.member,
      ]);
      expect((await asActor(member.id, session.id, true)).map((r) => r.member_id)).toEqual([
        seat.member,
      ]);
      // An outsider gets nothing, even with a forged membership and a forged session row in pg_temp.
      expect(await asActor(outsider.id, session.id, false)).toEqual([]);
      expect(await asActor(outsider.id, session.id, true)).toEqual([]);
      // A forged session id that doesn't correspond to any real session, still forged in pg_temp.
      expect(await asActor(outsider.id, randomUUID(), true)).toEqual([]);
    } finally {
      await f.owner(`REVOKE TEMPORARY ON DATABASE ${db()} FROM chorus_app`);
    }
  });
});

/** CC-2d: the watcher's one follow definer (0010). The meta-test in `rls.test.ts` covers its search_path and ACL. */
describe('chorus_coordination_apply: follow targets only, hostile pg_temp shadowing (real PostgreSQL)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture({ poolMax: 8 });
  });
  afterAll(async () => {
    await f.close();
  });

  const db = () => f.db.url.split('/').pop() ?? '';
  type Row = { session_id: string; coordination_mode: string; acting_actor_id: string };
  const targets = async (
    ws: string,
    room: string,
    forge?: (c: import('pg').PoolClient) => Promise<void>,
  ) => {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      if (forge !== undefined) await forge(client);
      return (
        await client.query<Row>('SELECT * FROM chorus_coordination_apply($1, $2)', [ws, room])
      ).rows;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release(true);
    }
  };

  it('returns exactly the following sessions of an active SharedNet room, each with a live administrator', async () => {
    const ws = await f.workspace(`follow-${rid('', 6)}`);
    await f.owner(`UPDATE rooms SET provider = 'sharednet', external_room_id = $2 WHERE id = $1`, [
      ws.roomId,
      `rom_${rid('Follow', 8)}`,
    ]);
    const admin = await f.actor(ws, 'follow-admin');
    const mode = (id: string, m: string) =>
      f.owner('UPDATE sessions SET coordination_mode = $2 WHERE id = $1', [id, m]);
    const observe = await f.session(admin, { discoverable: false });
    const assist = await f.session(admin);
    const off = await f.session(admin);
    const archived = await f.session(admin);
    const orphan = await f.session(admin);
    await mode(observe.id, 'observe');
    await mode(assist.id, 'assist');
    await mode(archived.id, 'assist');
    await mode(orphan.id, 'assist');
    await f.owner(`UPDATE sessions SET state = 'archived' WHERE id = $1`, [archived.id]);
    // The orphan's only administrator left the session: no RLS context exists for it, so it is not followed.
    await f.owner('UPDATE session_members SET removed_at = now() WHERE session_id = $1', [
      orphan.id,
    ]);
    // A participant-only member is never the acting context.
    const participant = await f.actor(ws, 'follow-participant');
    await f.join(assist, participant);
    expect(off.id).toBeDefined();

    const rows = await targets(ws.id, ws.roomId);
    expect(rows.map((r) => [r.session_id, r.coordination_mode, r.acting_actor_id]).sort()).toEqual(
      [
        [observe.id, 'observe', admin.id],
        [assist.id, 'assist', admin.id],
      ].sort(),
    );

    // An administrator who has left the ROOM is no context either (chorus_my_sessions()'s own rule).
    await f.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [admin.id]);
    expect(await targets(ws.id, ws.roomId)).toEqual([]);
    await f.owner('UPDATE room_members SET removed_at = NULL WHERE actor_id = $1', [admin.id]);

    // The wrong workspace for the room, an unknown room, or a room out of service: nothing.
    const other = await f.workspace(`follow-other-${rid('', 6)}`);
    expect(await targets(other.id, ws.roomId)).toEqual([]);
    expect(await targets(ws.id, randomUUID())).toEqual([]);
    await f.owner(`UPDATE rooms SET activation_state = 'degraded' WHERE id = $1`, [ws.roomId]);
    expect(await targets(ws.id, ws.roomId)).toEqual([]);
    await f.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [ws.roomId]);

    // Arguments are validated inside.
    await expect(targets(ws.id, null as unknown as string)).rejects.toMatchObject({
      code: '22023',
    });
    await expect(targets(null as unknown as string, ws.roomId)).rejects.toMatchObject({
      code: '22023',
    });

    // Forged temp tables cannot add a session, an administrator or a room.
    await f.owner(`GRANT TEMPORARY ON DATABASE ${db()} TO chorus_app`);
    try {
      const forged = await targets(ws.id, ws.roomId, async (client) => {
        const forgedSession = randomUUID();
        await client.query(
          `CREATE TEMP TABLE sessions (id uuid, workspace_id uuid, room_id uuid, state text, coordination_mode text)`,
        );
        await client.query(
          `CREATE TEMP TABLE session_members (workspace_id uuid, session_id uuid, actor_id uuid, roles text[], joined_at timestamptz DEFAULT now(), removed_at timestamptz)`,
        );
        await client.query(
          `CREATE TEMP TABLE rooms (id uuid, workspace_id uuid, provider text, activation_state text)`,
        );
        await client.query(
          `CREATE TEMP TABLE room_members (workspace_id uuid, room_id uuid, actor_id uuid, removed_at timestamptz)`,
        );
        await client.query(
          `INSERT INTO pg_temp.sessions VALUES ($1, $2, $3, 'active', 'assist'), ($4, $2, $3, 'active', 'assist')`,
          [forgedSession, ws.id, ws.roomId, off.id],
        );
        await client.query(
          `INSERT INTO pg_temp.session_members (workspace_id, session_id, actor_id, roles)
           VALUES ($1, $2, $3, ARRAY['participant', 'administrator']), ($1, $4, $3, ARRAY['participant', 'administrator'])`,
          [ws.id, forgedSession, participant.id, off.id],
        );
        await client.query(`INSERT INTO pg_temp.rooms VALUES ($1, $2, 'sharednet', 'active')`, [
          ws.roomId,
          ws.id,
        ]);
        await client.query(`INSERT INTO pg_temp.room_members VALUES ($1, $2, $3, NULL)`, [
          ws.id,
          ws.roomId,
          participant.id,
        ]);
      });
      expect(forged.map((r) => r.session_id).sort()).toEqual([observe.id, assist.id].sort());
      expect(forged.every((r) => r.acting_actor_id === admin.id)).toBe(true);
    } finally {
      await f.owner(`REVOKE TEMPORARY ON DATABASE ${db()} FROM chorus_app`);
    }
  });
});
