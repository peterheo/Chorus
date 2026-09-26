import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomWatcher } from '../../src/watcher.ts';
import { SharedNetClient } from '../../src/sharednet/client.ts';
import { SHAREDNET_ROOM, startStack, type Stack } from '../helpers/stack.ts';

describe('room watcher (real PostgreSQL, fake SharedNet)', () => {
  let s: Stack;
  beforeEach(async () => {
    s = await startStack({ watch: false });
  });
  afterEach(async () => {
    await s.stop();
  });

  const head = () => s.fake.rooms.get(SHAREDNET_ROOM)?.messages.at(-1)?.sequence ?? 0;
  const roomState = async () =>
    (
      await s.owner<{ activation_state: string }>(
        'SELECT activation_state FROM rooms WHERE id = $1',
        [s.roomId],
      )
    )[0]?.activation_state;
  const cursor = async () =>
    Number(
      (
        await s.owner<{ last_sequence: string }>(
          'SELECT last_sequence FROM sharednet_cursors WHERE room_id = $1',
          [s.roomId],
        )
      )[0]?.last_sequence,
    );
  const enrollmentState = async (id: string) =>
    (await s.owner<{ state: string }>('SELECT state FROM enrollments WHERE id = $1', [id]))[0]
      ?.state;

  it('watcher.recovery: resumes from the persisted cursor after a restart and never rewinds it', async () => {
    const first = s.newWatcher();
    await first.start();
    const chatter = s.agent('chatter');
    s.post(chatter, 'hello everyone');
    s.post(chatter, 'another message');
    await s.waitForCursor(head());
    await first.stop();
    const persisted = await cursor();
    expect(persisted).toBe(head());

    // While the watcher is down a proof is posted; a NEW watcher must pick it up from the saved cursor.
    const agent = s.agent('recover');
    const started = await s.startEnrollment(agent);
    s.post(agent, started.message);
    const second = s.newWatcher();
    const pollsBefore = s.fake.polls(SHAREDNET_ROOM).length;
    await second.start();
    await s.waitFor(
      'verified after restart',
      async () => (await enrollmentState(started.enrollmentId)) === 'verified',
    );
    expect(s.fake.polls(SHAREDNET_ROOM)[pollsBefore]).toBe(persisted);
    expect(await cursor()).toBe(head());

    // The database refuses a regression outright.
    await expect(
      s.pool.query('SELECT chorus_watcher_advance($1, $2, $3, true, NULL)', [
        s.workspaceId,
        s.roomId,
        persisted - 1,
      ]),
    ).rejects.toMatchObject({ code: 'CH002' });
    expect(await cursor()).toBe(head());
  });

  it('watcher.recovery: duplicate delivery is harmless and the first valid proof wins', async () => {
    await s.watcher.start();
    const agent = s.agent('dup');
    const started = await s.startEnrollment(agent);
    s.post(agent, started.message);
    s.post(agent, started.message);
    await s.waitForCursor(head());
    const [row] = await s.owner<{ proof_sequence: string; state: string }>(
      'SELECT proof_sequence, state FROM enrollments WHERE id = $1',
      [started.enrollmentId],
    );
    expect(row?.state).toBe('verified');
    // The earlier message is the proof of record.
    const first = s.fake.rooms.get(SHAREDNET_ROOM)?.messages.at(-2)?.sequence;
    expect(Number(row?.proof_sequence)).toBe(first);
    // Restarting from scratch (cursor reset by an operator) reprocesses the same messages without effect.
    await s.watcher.stop();
    await s.owner('UPDATE sharednet_cursors SET last_sequence = 0 WHERE room_id = $1', [s.roomId]);
    await s.newWatcher().start();
    await s.waitForCursor(head());
    const [after] = await s.owner<{ proof_sequence: string }>(
      'SELECT proof_sequence FROM enrollments WHERE id = $1',
      [started.enrollmentId],
    );
    expect(Number(after?.proof_sequence)).toBe(first);
  });

  it('watcher.recovery: a 401 from SharedNet degrades the room and enrollment closes; reactivation resumes', async () => {
    await s.watcher.start();
    s.fake.failWith = 401;
    await s.waitFor('degraded', async () => (await roomState()) === 'degraded');
    const response = await fetch(`${s.baseUrl}/v1/enroll/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sharednet_room_id: SHAREDNET_ROOM,
        member_id: 'i_abcdef1234',
        display_name: 'x',
      }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'room_not_available' });
    expect((await s.pool.query('SELECT * FROM chorus_watcher_rooms()')).rows).toHaveLength(0);
    const [err] = await s.owner<{ last_error: string }>(
      'SELECT last_error FROM sharednet_cursors WHERE room_id = $1',
      [s.roomId],
    );
    expect(err?.last_error).toContain('SharedNetAuthError');

    // Only the operator path reactivates; the running watcher then picks the room up again on its next scan.
    s.fake.failWith = undefined;
    await s.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [s.roomId]);
    const agent = s.agent('after401');
    await s.waitFor('enrolls again', async () => {
      try {
        await s.enroll(agent);
        return true;
      } catch {
        return false;
      }
    });
  });

  it('watcher.recovery: a message missing required fields degrades the room and processes nothing', async () => {
    await s.watcher.start();
    const agent = s.agent('contract');
    const started = await s.startEnrollment(agent);
    s.fake.breakContract = true;
    s.post(agent, started.message);
    await s.waitFor('degraded', async () => (await roomState()) === 'degraded');
    expect(await enrollmentState(started.enrollmentId)).toBe('pending');
    expect(await cursor()).toBeLessThan(head());
  });

  it('watcher.recovery: transient errors back off and recover without degrading', async () => {
    await s.watcher.start();
    s.fake.failWith = 500;
    await s.waitFor('last_error recorded', async () => {
      const [row] = await s.owner<{ last_error: string | null }>(
        'SELECT last_error FROM sharednet_cursors WHERE room_id = $1',
        [s.roomId],
      );
      return row?.last_error === 'SharedNetHttpError';
    });
    expect(await roomState()).toBe('active');
    s.fake.failWith = undefined;
    await s.waitFor('recovered', async () => {
      const [row] = await s.owner<{ last_error: string | null }>(
        'SELECT last_error FROM sharednet_cursors WHERE room_id = $1',
        [s.roomId],
      );
      return row?.last_error === null;
    });
    const agent = s.agent('afterbackoff');
    await expect(s.enroll(agent)).resolves.toMatchObject({ roles: ['executor'] });
  });

  it('watcher.recovery: enrollment is refused while the watcher is unhealthy (stale last_ok_at)', async () => {
    await s.owner(
      `UPDATE sharednet_cursors SET last_ok_at = now() - interval '3 minutes' WHERE room_id = $1`,
      [s.roomId],
    );
    const response = await fetch(`${s.baseUrl}/v1/enroll/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sharednet_room_id: SHAREDNET_ROOM,
        member_id: 'i_abcdef1234',
        display_name: 'x',
      }),
    });
    expect(response.status).toBe(404);
    const health = await fetch(`${s.baseUrl}/healthz`);
    const body = (await health.json()) as { rooms: { watcher_ok: boolean }[] };
    expect(body.rooms).toEqual([
      expect.objectContaining({
        sharednet_room_id: SHAREDNET_ROOM,
        activation_state: 'active',
        watcher_ok: false,
      }),
    ]);
  });

  it('watcher.recovery: an undecryptable seat token degrades the room instead of crashing', async () => {
    const wrongKey = new RoomWatcher({
      pool: s.pool,
      secretsKey: randomBytes(32),
      client: new SharedNetClient({ baseUrl: s.fake.url }),
      rescanMs: 100,
      expireMs: 200,
    });
    await wrongKey.start();
    await s.waitFor('degraded', async () => (await roomState()) === 'degraded');
    await wrongKey.stop();
  });

  it('watcher.recovery: ordinary room messages are never stored anywhere', async () => {
    await s.watcher.start();
    const chatter = s.agent('chatter2');
    const needle = `needle-${randomBytes(6).toString('hex')}`;
    s.post(chatter, `the secret plan is ${needle}`);
    s.post(chatter, `please chorus-verify cvn_${'a'.repeat(22)} ${needle}`);
    await s.waitForCursor(head());
    const tables = await s.owner<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    for (const { tablename } of tables) {
      const hits = await s.owner<{ n: string }>(
        `SELECT count(*) AS n FROM "${tablename}" t WHERE t::text LIKE $1`,
        [`%${needle}%`],
      );
      expect(Number(hits[0]?.n), tablename).toBe(0);
    }
    expect(s.logs.join('')).not.toContain(needle);
  });
});
