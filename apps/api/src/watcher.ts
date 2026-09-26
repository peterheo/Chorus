import type pg from 'pg';
import { openSecret } from './secrets.ts';
import {
  SharedNetAuthError,
  SharedNetClient,
  SharedNetContractError,
  type SharedNetMessage,
} from './sharednet/client.ts';

/**
 * The SharedNet room watcher (spec section 5). For every ACTIVE bound room it long-polls the room
 * with Chorus's own service seat, and turns exactly one kind of message into an effect: a challenge
 * `chorus-verify cvn_<22>` posted by the claimed member. Everything else is ignored and never stored.
 *
 * Identity comes only from the server-assigned sender fields. The cursor is persisted and monotonic,
 * so a restart resumes where it stopped and duplicate delivery is harmless (verification is a
 * no-op for non-pending enrollments). Auth failures and contract violations take the room out of
 * service (fail closed); transient errors back off and retry.
 */
export const PROOF_MESSAGE = /^chorus-verify (cvn_[A-Za-z0-9_-]{22})$/;

export interface WatcherLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface WatcherOptions {
  readonly pool: pg.Pool;
  readonly secretsKey: Buffer;
  readonly client: SharedNetClient;
  readonly logger?: WatcherLogger;
  /** How often to look for newly activated rooms. Default 60 s. */
  readonly rescanMs?: number;
  /** How often to expire old enrollments. Default 60 s. */
  readonly expireMs?: number;
  /** Floor between polls, so a server that answers instantly cannot spin the loop. Default 200 ms. */
  readonly minPollIntervalMs?: number;
  /** Backoff ceiling. Default 30 s. */
  readonly maxBackoffMs?: number;
}

interface WatchedRoom {
  workspace_id: string;
  room_id: string;
  external_room_id: string;
  member_id: string;
  token_ciphertext: Buffer;
  token_nonce: Buffer;
  key_id: string;
  last_sequence: string;
}

const noopLogger: WatcherLogger = { info: () => undefined, warn: () => undefined };

export class RoomWatcher {
  private readonly options: Required<Omit<WatcherOptions, 'logger'>> & { logger: WatcherLogger };
  private readonly running = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(options: WatcherOptions) {
    this.options = {
      rescanMs: 60_000,
      expireMs: 60_000,
      minPollIntervalMs: 200,
      maxBackoffMs: 30_000,
      logger: noopLogger,
      ...options,
    };
  }

  /** Starts the loops. Safe to call once; returns after the first scan has spawned its loops. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.abort = new AbortController();
    await this.scan();
    this.timers.push(
      setInterval(() => void this.scan().catch(() => undefined), this.options.rescanMs),
      setInterval(() => void this.expire().catch(() => undefined), this.options.expireMs),
    );
    for (const timer of this.timers) timer.unref();
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.abort.abort();
    await Promise.allSettled([...this.running.values()]);
    this.running.clear();
  }

  private async expire(): Promise<void> {
    await this.options.pool.query('SELECT chorus_expire_enrollments()');
  }

  /** Spawns a loop for every active room that does not have one yet. */
  async scan(): Promise<void> {
    const { rows } = await this.options.pool.query<WatchedRoom>(
      'SELECT * FROM chorus_watcher_rooms()',
    );
    for (const room of rows) {
      const key = `${room.workspace_id}/${room.room_id}`;
      if (this.running.has(key)) continue;
      const loop = this.watchRoom(room).finally(() => this.running.delete(key));
      this.running.set(key, loop);
    }
  }

  private async watchRoom(room: WatchedRoom): Promise<void> {
    const { pool, client, secretsKey, logger, minPollIntervalMs, maxBackoffMs } = this.options;
    const signal = this.abort.signal;
    const log = { room_id: room.room_id, sharednet_room_id: room.external_room_id };
    let token: string;
    try {
      token = openSecret(secretsKey, {
        ciphertext: room.token_ciphertext,
        nonce: room.token_nonce,
        keyId: room.key_id,
      });
    } catch (error) {
      logger.warn(
        { ...log, error: (error as Error).name },
        'seat token cannot be decrypted; degrading room',
      );
      await this.degrade(room, 'seat token cannot be decrypted');
      return;
    }

    let after = Number(room.last_sequence);
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const page = await client.wait(room.external_room_id, token, after, signal);
        for (const message of page.messages) await this.handleMessage(room, message);
        const highest = page.messages.at(-1)?.sequence ?? after;
        await pool.query('SELECT chorus_watcher_advance($1, $2, $3, true, NULL)', [
          room.workspace_id,
          room.room_id,
          highest,
        ]);
        after = highest;
        failures = 0;
        if (!page.hasMore) {
          const elapsed = Date.now() - started;
          if (elapsed < minPollIntervalMs) await sleep(minPollIntervalMs - elapsed, signal);
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        if (error instanceof SharedNetAuthError || error instanceof SharedNetContractError) {
          logger.warn({ ...log, error: error.name }, 'taking room out of service (fail closed)');
          await this.degrade(room, `${error.name}: ${error.message}`);
          return;
        }
        failures++;
        const delay = Math.min(maxBackoffMs, 1000 * 2 ** Math.min(failures - 1, 10));
        const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
        logger.warn(
          { ...log, error: (error as Error).name, retry_in_ms: jittered },
          'watcher error',
        );
        await pool
          .query('SELECT chorus_watcher_advance($1, $2, $3, false, $4)', [
            room.workspace_id,
            room.room_id,
            after,
            (error as Error).name,
          ])
          .catch(() => undefined);
        await sleep(jittered, signal);
      }
    }
  }

  private async handleMessage(room: WatchedRoom, message: SharedNetMessage): Promise<void> {
    // Chorus's own posts and everything that is not a well-formed challenge are ignored outright.
    if (message.senderMemberId === room.member_id) return;
    const match = PROOF_MESSAGE.exec(message.content.trim());
    const nonce = match?.[1];
    if (nonce === undefined) return;
    await this.options.pool.query('SELECT chorus_enroll_verify($1, $2, $3, $4, $5, $6, $7)', [
      room.workspace_id,
      room.room_id,
      nonce,
      message.id,
      message.sequence,
      message.senderPrincipalId,
      message.senderMemberId,
    ]);
  }

  private async degrade(room: WatchedRoom, reason: string): Promise<void> {
    await this.options.pool
      .query('SELECT chorus_watcher_degrade($1, $2, $3)', [room.workspace_id, room.room_id, reason])
      .catch(() => undefined);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
