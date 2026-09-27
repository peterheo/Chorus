import { randomBytes } from 'node:crypto';
import pg from 'pg';
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
    // The proof is verified (committed in handleMessage) BEFORE the cursor advance runs as its own statement,
    // so wait for the cursor rather than reading it once right after `verified`.
    await s.waitForCursor(head());
    expect(await cursor()).toBe(head());

    // The database refuses a regression outright.
    const [epochRow] = await s.owner<{ consumer_epoch: string }>(
      'SELECT consumer_epoch FROM sharednet_cursors WHERE room_id = $1',
      [s.roomId],
    );
    await expect(
      s.pool.query('SELECT chorus_watcher_advance($1, $2, $3, $4, true, NULL)', [
        s.workspaceId,
        s.roomId,
        persisted - 1,
        Number(epochRow?.consumer_epoch),
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
    await expect(s.enroll(agent)).resolves.toMatchObject({ workspaceId: s.workspaceId });
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
    expect(await health.json()).toMatchObject({ rooms_active: 1, watcher_ok_rooms: 0 });
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

  it('watcher.stop_race: a scan in flight when stop() is called spawns nothing and never touches an ended pool', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const logged: string[] = [];
    const wpool = new pg.Pool({ connectionString: s.db.appUrl, max: 5 });
    wpool.on('error', () => undefined);
    const watcher = new RoomWatcher({
      pool: wpool,
      secretsKey: s.secretsKey,
      client: new SharedNetClient({ baseUrl: s.fake.url, timeoutMs: 5000 }),
      rescanMs: 60_000,
      expireMs: 60_000,
      minPollIntervalMs: 10,
      logger: { info: (_o, msg) => logged.push(msg), warn: (_o, msg) => logged.push(msg) },
    });
    try {
      // Start with no active room so the first scan spawns nothing, then make the room active: the next
      // scan WOULD spawn a loop for it.
      await s.owner(`UPDATE rooms SET activation_state = 'degraded' WHERE id = $1`, [s.roomId]);
      await watcher.start();
      await s.owner(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [s.roomId]);

      const scan = watcher.scan(); // deliberately not awaited: its query is in flight
      await watcher.stop();
      await wpool.end();
      await scan;
      await new Promise((r) => setTimeout(r, 100)); // flush any late rejection
      expect(rejections).toEqual([]);
      expect(watcher.consuming).toEqual([]);
      expect(logged).not.toContain('consuming room');
    } finally {
      process.off('unhandledRejection', onRejection);
      if (!wpool.ended) await wpool.end();
    }
  });

  it('watcher.consumer_lease: two processes, one consumer; failover when the lease connection dies; stale epochs are fenced out', async () => {
    const poolB = new pg.Pool({ connectionString: s.db.appUrl, max: 5 });
    poolB.on('error', () => undefined);
    const mk = (pool: pg.Pool) =>
      new RoomWatcher({
        pool,
        secretsKey: s.secretsKey,
        client: new SharedNetClient({ baseUrl: s.fake.url, timeoutMs: 5000 }),
        rescanMs: 100,
        expireMs: 30_000,
        minPollIntervalMs: 10,
      });
    const a = mk(s.pool);
    const b = mk(poolB);
    const epoch = async () =>
      Number(
        (
          await s.owner<{ e: string }>(
            'SELECT consumer_epoch AS e FROM sharednet_cursors WHERE room_id = $1',
            [s.roomId],
          )
        )[0]?.e,
      );
    const lockHolders = async () =>
      s.owner<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
    try {
      await a.start();
      await b.start();
      await s.waitFor('one consumer', () =>
        Promise.resolve(a.consuming.length + b.consuming.length >= 1),
      );
      // Give the losing process several scans to (not) take over: still exactly one consumer and one lock.
      await new Promise((r) => setTimeout(r, 500));
      expect(a.consuming.length + b.consuming.length).toBe(1);
      expect(await lockHolders()).toHaveLength(1);
      const firstEpoch = await epoch();
      expect(firstEpoch).toBe(1);

      // Only the consumer processes: a proof posted now is verified exactly once, by whoever holds the lease.
      const agent = s.agent('leased');
      const started = await s.startEnrollment(agent);
      s.post(agent, started.message);
      await s.waitFor(
        'verified',
        async () => (await enrollmentState(started.enrollmentId)) === 'verified',
      );

      // Kill the lease-holding connection: the other process (or the same one, after a rescan) takes over
      // with a NEW epoch, and the old epoch can no longer move the cursor.
      const [holder] = await lockHolders();
      await s.owner('SELECT pg_terminate_backend($1)', [holder?.pid]);
      await s.waitFor('failover to a new epoch', async () => (await epoch()) > firstEpoch);
      await s.waitFor('one consumer again', () =>
        Promise.resolve(a.consuming.length + b.consuming.length === 1),
      );
      await expect(
        s.pool.query('SELECT chorus_watcher_advance($1, $2, $3, $4, true, NULL)', [
          s.workspaceId,
          s.roomId,
          head() + 100,
          firstEpoch,
        ]),
      ).rejects.toMatchObject({ code: 'CH003' });

      // Still working after failover, and never two consumers.
      const again = s.agent('after-failover');
      const restarted = await s.startEnrollment(again);
      s.post(again, restarted.message);
      await s.waitFor(
        'verified after failover',
        async () => (await enrollmentState(restarted.enrollmentId)) === 'verified',
      );
      expect(a.consuming.length + b.consuming.length).toBe(1);

      // Releasing the lease (stopping the holder) lets the other process consume.
      const holderIsA = a.consuming.length === 1;
      await (holderIsA ? a : b).stop();
      const survivor = holderIsA ? b : a;
      await s.waitFor('the other process takes over', () =>
        Promise.resolve(survivor.consuming.length === 1),
      );
    } finally {
      await a.stop();
      await b.stop();
      await poolB.end();
    }
  });
});
