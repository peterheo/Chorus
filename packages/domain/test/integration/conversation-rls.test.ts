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
