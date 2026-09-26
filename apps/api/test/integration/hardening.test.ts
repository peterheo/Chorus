import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedEphemeralDatabase } from '@chorus/database/testing';
import { buildApp } from '../../src/app.ts';
import { ConfigError } from '../../src/config.ts';
import { assertRuntimeRole } from '../../src/runtime-role.ts';
import { openSecret } from '../../src/secrets.ts';
import { startStack, SHAREDNET_ROOM, type Stack } from '../helpers/stack.ts';

describe('rate limits, startup guards, health and logging', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({
      limits: {
        enrollStartPerRoomPerMinute: 3,
        enrollStartGlobalPerMinute: 50,
        enrollCompleteGlobalPerMinute: 6,
      },
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  it('http.rate_limit: enrollment is limited per room and globally, each with Retry-After', async () => {
    const start = () =>
      fetch(`${s.baseUrl}/v1/enroll/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sharednet_room_id: SHAREDNET_ROOM,
          member_id: 'i_ratelimit001',
          display_name: 'r',
        }),
      });
    const results: number[] = [];
    for (let i = 0; i < 5; i++) results.push((await start()).status);
    expect(results.filter((r) => r === 429).length).toBeGreaterThanOrEqual(2);
    const blocked = await start();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    let completeLimited = 0;
    for (let i = 0; i < 10; i++) {
      const r = await s.complete('00000000-0000-4000-8000-000000000000', `cvs_${'A'.repeat(43)}`);
      if (r.status === 429) completeLimited++;
    }
    expect(completeLimited).toBeGreaterThan(0);
  });

  it('config.startup_guards: the runtime role check refuses an owner or BYPASSRLS connection', async () => {
    const owner = new pg.Pool({ connectionString: s.db.url, max: 1 });
    owner.on('error', () => undefined);
    try {
      await expect(assertRuntimeRole(owner)).rejects.toBeInstanceOf(ConfigError);
      await expect(assertRuntimeRole(owner)).rejects.toThrow(/chorus_app/);
    } finally {
      await owner.end();
    }
    await expect(assertRuntimeRole(s.pool)).resolves.toBeUndefined();
  });

  it('http.healthz: reports commit, database and room watcher state; 503 when the database is down', async () => {
    const health = await fetch(`${s.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      commit: 'abc1234',
      db: 'ok',
      rooms: [{ sharednet_room_id: SHAREDNET_ROOM, activation_state: 'active', watcher_ok: true }],
    });

    // A pool that cannot reach any database.
    const dead = new pg.Pool({
      connectionString: 'postgres://chorus_app:x@127.0.0.1:1/none',
      max: 1,
      connectionTimeoutMillis: 500,
    });
    dead.on('error', () => undefined);
    const app = await buildApp({
      config: {
        publicBaseUrl: 'http://127.0.0.1:0',
        leaseDurationSeconds: 900,
        gitCommit: 'deadbee',
      },
      pool: dead,
      logStream: new Writable({
        write: (_c, _e, cb) => {
          cb();
        },
      }),
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'degraded', commit: 'deadbee', db: 'down' });
    } finally {
      await app.close();
      await dead.end();
    }
  });

  it('secrets.seat_token (integration): the seat token is stored encrypted and only the right key opens it', async () => {
    const [row] = await s.owner<{ token_ciphertext: Buffer; token_nonce: Buffer; key_id: string }>(
      'SELECT token_ciphertext, token_nonce, key_id FROM sharednet_seats WHERE room_id = $1',
      [s.roomId],
    );
    if (row === undefined) throw new Error('no seat row');
    expect(row.token_ciphertext.toString('utf8')).not.toContain(s.seatToken);
    expect(row.token_ciphertext.toString('latin1')).not.toContain(s.seatToken);
    const sealed = { ciphertext: row.token_ciphertext, nonce: row.token_nonce, keyId: row.key_id };
    expect(openSecret(s.secretsKey, sealed)).toBe(s.seatToken);
    expect(() => openSecret(Buffer.alloc(32, 1), sealed)).toThrow();
    // The seat token is not present in any table in plaintext, nor in the captured logs.
    const tables = await s.owner<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    for (const { tablename } of tables) {
      const hits = await s.owner<{ n: string }>(
        `SELECT count(*) AS n FROM "${tablename}" t WHERE t::text LIKE $1`,
        [`%${s.seatToken}%`],
      );
      expect(Number(hits[0]?.n), tablename).toBe(0);
    }
    expect(s.logs.join('')).not.toContain(s.seatToken);
  });

  it('rls.definer.sharednet: chorus_app cannot touch the new tables or forge enrollment state directly', async () => {
    for (const table of [
      'sharednet_seats',
      'sharednet_cursors',
      'external_identities',
      'enrollments',
      'admin_audit_log',
    ]) {
      await expect(s.pool.query(`SELECT 1 FROM ${table}`), table).rejects.toMatchObject({
        code: '42501',
      });
    }
    await expect(
      s.pool.query(`UPDATE rooms SET activation_state = 'active' WHERE id = $1`, [s.roomId]),
    ).rejects.toMatchObject({ code: '42501' });
    const throwaway = await createMigratedEphemeralDatabase();
    try {
      // Re-running every migration on a fresh database still yields exactly the intended definer set.
      const fns = await throwaway.query<{ proname: string }>(
        `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND prosecdef ORDER BY 1`,
      );
      expect(fns.map((f) => f.proname)).toContain('chorus_enroll_complete');
      expect(fns.map((f) => f.proname)).toContain('chorus_join_session');
      expect(fns.map((f) => f.proname)).not.toContain('chorus_redeem_invite');
    } finally {
      await throwaway.drop();
    }
  });
});

describe('logging (default limits)', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(async () => {
    await s.stop();
  });

  it('logging.redaction: logs carry only the allow-listed access fields, never tokens, secrets or content', async () => {
    const started = await s.startEnrollment(s.agent('logger'));
    const secretsSeen = [started.secret, started.nonce];
    const enrolled = await s.enroll(s.agent('logger2'));
    await fetch(`${s.baseUrl}/healthz`);
    await fetch(`${s.baseUrl}/nope`);

    const text = s.logs.join('');
    for (const secret of [...secretsSeen, enrolled.token, s.seatToken, 'Bearer ']) {
      expect(text, secret.slice(0, 12)).not.toContain(secret);
    }
    const lines = text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const access = lines.filter((l) => l['msg'] === 'request');
    expect(access.length).toBeGreaterThan(3);
    for (const line of access) {
      expect(
        Object.keys(line)
          .filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k))
          .sort(),
      ).toEqual(expect.arrayContaining(['duration_ms', 'method', 'path', 'request_id', 'status']));
      const extra = Object.keys(line).filter(
        (k) =>
          ![
            'level',
            'time',
            'pid',
            'hostname',
            'msg',
            'duration_ms',
            'method',
            'path',
            'request_id',
            'status',
            'actor_id',
            'tool',
            'reqId',
          ].includes(k),
      );
      expect(extra).toEqual([]);
    }
  });
});
