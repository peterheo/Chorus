import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createMigratedEphemeralDatabase, type EphemeralDatabase } from '@chorus/database/testing';
import { buildApp, type AppLimits } from '../../src/app.ts';
import { sealSecret } from '../../src/secrets.ts';
import { SharedNetClient } from '../../src/sharednet/client.ts';
import { RoomWatcher } from '../../src/watcher.ts';
import type { LedgerClient } from '@chorus/sharednet-ledger';
import { FakeSharedNet } from './fake-sharednet.ts';

export const SHAREDNET_ROOM = 'rom_TestRoom01';
export const SEAT_MEMBER = 'i_ChorusSeat01';
export const SEAT_PRINCIPAL = 'p_ChorusSeat01';
export const ACTIVATION_INVITE = 'rit_TestInvite0123456789abcdef';

export interface Agent {
  memberId: string;
  principalId: string;
  name: string;
}

export interface Enrolled {
  token: string;
  actorId: string;
  instanceId: string;
  workspaceId: string;
  roomId: string;
  expiresAt: string;
  raw: Record<string, unknown>;
}

export interface Stack {
  db: EphemeralDatabase;
  pool: pg.Pool;
  fake: FakeSharedNet;
  app: FastifyInstance;
  baseUrl: string;
  workspaceId: string;
  roomId: string;
  seatToken: string;
  secretsKey: Buffer;
  logs: string[];
  watcher: RoomWatcher;
  newWatcher: () => RoomWatcher;
  agent: (label: string) => Agent;
  post: (agent: Agent, content: string) => void;
  enroll: (agent: Agent) => Promise<Enrolled>;
  startEnrollment: (agent: Agent) => Promise<{
    enrollmentId: string;
    secret: string;
    message: string;
    expiresAt: string;
    nonce: string;
  }>;
  complete: (enrollmentId: string, secret: string) => Promise<Response>;
  waitForCursor: (sequence: number) => Promise<void>;
  waitFor: (what: string, condition: () => Promise<boolean>) => Promise<void>;
  owner: <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
  stop: () => Promise<void>;
}

let counter = 0;

/** A complete in-process Chorus: real PostgreSQL, the HTTP/MCP app on an ephemeral port, a fake SharedNet, and the watcher. */
export async function startStack(
  options: {
    limits?: Partial<AppLimits>;
    watch?: boolean;
    activateViaApi?: boolean;
    gitCommit?: string;
    /** CHORUS_BILLING for the app under test (default: disabled). */
    billing?: 'enabled' | 'disabled';
    /** The ledger the paid tools verify against (default: none configured, so verification would fail). */
    ledger?: LedgerClient;
  } = {},
): Promise<Stack> {
  const db = await createMigratedEphemeralDatabase();
  const pool = new pg.Pool({ connectionString: db.appUrl, max: 10 });
  pool.on('error', () => undefined);
  const secretsKey = randomBytes(32);
  const seatToken = `sni_seat_${randomBytes(12).toString('hex')}`;

  const fake = new FakeSharedNet();
  await fake.start();
  fake.addRoom(SHAREDNET_ROOM, seatToken);
  fake.identities.set(seatToken, {
    token: seatToken,
    memberId: SEAT_MEMBER,
    principalId: SEAT_PRINCIPAL,
  });
  if (options.activateViaApi === true) {
    fake.addInvite(SHAREDNET_ROOM, ACTIVATION_INVITE, {
      token: seatToken,
      memberId: SEAT_MEMBER,
      principalId: SEAT_PRINCIPAL,
    });
  }

  // Owner-side activation (unless the test activates through the API): workspace, bound room, seat, cursor.
  let workspaceId = '';
  let roomId = '';
  if (options.activateViaApi !== true) {
    const [ws] = await db.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('stack') RETURNING id`,
    );
    workspaceId = ws?.id ?? '';
    const [room] = await db.query<{ id: string }>(
      `INSERT INTO rooms (workspace_id, name, provider, external_room_id, activation_state)
       VALUES ($1, 'demo', 'sharednet', $2, 'active') RETURNING id`,
      [workspaceId, SHAREDNET_ROOM],
    );
    roomId = room?.id ?? '';
    const sealed = sealSecret(secretsKey, seatToken);
    await db.query(
      `INSERT INTO sharednet_seats (workspace_id, room_id, member_id, principal_id, token_ciphertext, token_nonce, key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        workspaceId,
        roomId,
        SEAT_MEMBER,
        SEAT_PRINCIPAL,
        sealed.ciphertext,
        sealed.nonce,
        sealed.keyId,
      ],
    );
    await db.query(
      `INSERT INTO sharednet_cursors (workspace_id, room_id, last_sequence, last_ok_at) VALUES ($1, $2, 0, now())`,
      [workspaceId, roomId],
    );
  }

  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString('utf8'));
      cb();
    },
  });
  const app = await buildApp({
    config: {
      publicBaseUrl: 'http://127.0.0.1:0',
      leaseDurationSeconds: 900,
      gitCommit: options.gitCommit ?? 'abc1234',
      billing: options.billing ?? 'disabled',
      sharednetBaseUrl: fake.url,
    },
    ...(options.ledger === undefined
      ? {}
      : { arena: { ledgerFor: () => options.ledger as LedgerClient } }),
    pool,
    logStream,
    sharednet: {
      client: new SharedNetClient({ baseUrl: fake.url, timeoutMs: 5000 }),
      secretsKey,
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;

  const newWatcher = () =>
    new RoomWatcher({
      pool,
      secretsKey,
      client: new SharedNetClient({ baseUrl: fake.url, timeoutMs: 5000 }),
      rescanMs: 100,
      // Long on purpose: tests that backdate an enrollment must see the verify check, not the sweeper, refuse it.
      expireMs: 30_000,
      minPollIntervalMs: 10,
      maxBackoffMs: 200,
    });
  if (options.activateViaApi === true) {
    const activated = await fetch(`${baseUrl}/v1/rooms/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sharednet_room_id: SHAREDNET_ROOM,
        sharednet_invite_token: ACTIVATION_INVITE,
      }),
    });
    if (activated.status !== 201) throw new Error(`activate -> ${String(activated.status)}`);
    const [bound] = await db.query<{ id: string; workspace_id: string }>(
      `SELECT id, workspace_id FROM rooms WHERE external_room_id = $1`,
      [SHAREDNET_ROOM],
    );
    roomId = bound?.id ?? '';
    workspaceId = bound?.workspace_id ?? '';
  }
  let watcher = newWatcher();
  if (options.watch !== false) await watcher.start();

  const owner = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    db.query<T>(sql, params);
  const waitFor = async (what: string, condition: () => Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const stack: Stack = {
    db,
    pool,
    fake,
    app,
    baseUrl,
    workspaceId,
    roomId,
    seatToken,
    secretsKey,
    logs,
    get watcher() {
      return watcher;
    },
    newWatcher: () => {
      watcher = newWatcher();
      return watcher;
    },
    agent: (label) => {
      const n = ++counter;
      const suffix = `${label.replace(/[^A-Za-z0-9]/g, '')}${String(n).padStart(4, '0')}`.slice(
        0,
        40,
      );
      return { memberId: `i_${suffix}m`, principalId: `p_${suffix}p`, name: label };
    },
    post: (agent, content) => {
      fake.post(SHAREDNET_ROOM, {
        memberId: agent.memberId,
        principalId: agent.principalId,
        content,
      });
    },
    startEnrollment: async (agent) => {
      const response = await fetch(`${baseUrl}/v1/enroll/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sharednet_room_id: SHAREDNET_ROOM,
          member_id: agent.memberId,
          display_name: agent.name,
        }),
      });
      if (response.status !== 201)
        throw new Error(`enroll/start -> ${String(response.status)} ${await response.text()}`);
      const body = (await response.json()) as Record<string, string>;
      return {
        enrollmentId: body['enrollment_id'] ?? '',
        secret: body['secret'] ?? '',
        message: body['post_this_message'] ?? '',
        expiresAt: body['expires_at'] ?? '',
        nonce: (body['post_this_message'] ?? '').replace('chorus-verify ', ''),
      };
    },
    complete: (enrollmentId, secret) =>
      fetch(`${baseUrl}/v1/enroll/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollment_id: enrollmentId, secret }),
      }),
    enroll: async (agent) => {
      const started = await stack.startEnrollment(agent);
      stack.post(agent, started.message);
      for (let i = 0; i < 250; i++) {
        const response = await stack.complete(started.enrollmentId, started.secret);
        if (response.status === 200) {
          const body = (await response.json()) as Record<string, unknown>;
          return {
            token: body['token'] as string,
            actorId: body['actor_id'] as string,
            instanceId: body['instance_id'] as string,
            workspaceId: body['workspace_id'] as string,
            roomId: (body['room'] as { id: string }).id,
            expiresAt: body['token_expires_at'] as string,
            raw: body,
          };
        }
        if (response.status !== 202)
          throw new Error(`enroll/complete -> ${String(response.status)} ${await response.text()}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('enrollment never completed');
    },
    waitForCursor: (sequence) =>
      waitFor(`cursor >= ${String(sequence)}`, async () => {
        const rows = await owner<{ last_sequence: string }>(
          'SELECT last_sequence FROM sharednet_cursors WHERE room_id = $1',
          [roomId],
        );
        return Number(rows[0]?.last_sequence ?? 0) >= sequence;
      }),
    waitFor,
    owner,
    stop: async () => {
      await watcher.stop();
      await app.close();
      await pool.end();
      await fake.stop();
      await db.drop();
    },
  };
  return stack;
}
