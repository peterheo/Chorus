import type pg from 'pg';
import { openSecret } from './secrets.ts';
import {
  SharedNetAuthError,
  SharedNetClient,
  SharedNetContractError,
  type SharedNetMessage,
} from './sharednet/client.ts';

/**
 * The SharedNet room watcher (WP3 rev 3 section 6.3, rev 4 section 6). For every ACTIVE bound room it
 * long-polls the room with Chorus's own service seat and turns exactly one kind of message into an
 * effect: a challenge `chorus-verify cvn_<22>` posted by the claimed member. Everything else is ignored
 * and never stored.
 *
 * Identity comes only from the server-assigned sender fields. The cursor is persisted and monotonic, so a
 * restart resumes where it stopped and duplicate delivery is harmless (verification is a no-op for
 * non-pending enrollments). Auth failures and contract violations take the room out of service (fail
 * closed); transient errors back off and retry.
 *
 * ONE consumer per room: a loop runs only while its process holds `pg_try_advisory_lock` for the room on
 * a dedicated connection, and every cursor advance carries the epoch claimed on acquiring it, so an
 * ex-holder that lost the lock can never move the cursor. A second process simply does not consume that
 * room until the lock frees (failover).
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
  /** How often to look for newly activated rooms (and to retry rooms another process holds). Default 60 s. */
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
const LOCK_SQL = `SELECT pg_try_advisory_lock(hashtextextended('chorus:room-consumer:' || $1::text, 0)) AS got`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtextextended('chorus:room-consumer:' || $1::text, 0))`;

export class RoomWatcher {
  private readonly options: Required<Omit<WatcherOptions, 'logger'>> & { logger: WatcherLogger };
  private readonly running = new Map<string, Promise<void>>();
  /** Rooms whose consumer lease this instance holds RIGHT NOW (lock taken and epoch claimed, connection alive). */
  private readonly held = new Set<string>();
  /** Scans and expiries in flight; `stop()` waits for them so none can act on a closed pool. */
  private readonly inflight = new Set<Promise<unknown>>();
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

  /** Rooms this instance currently consumes (holds the consumer lease for). */
  get consuming(): readonly string[] {
    return [...this.held];
  }

  /** Starts the loops. Safe to call once; returns after the first scan has spawned its loops. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.abort = new AbortController();
    await this.scan();
    this.timers.push(
      setInterval(() => {
        if (this.started) void this.scan().catch(() => undefined);
      }, this.options.rescanMs),
      setInterval(() => {
        if (this.started) void this.expire().catch(() => undefined);
      }, this.options.expireMs),
    );
    for (const timer of this.timers) timer.unref();
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.abort.abort();
    // A scan or expiry in flight finishes first (it will not spawn anything: the watcher is stopped), so the
    // loops awaited next are the complete set and the pool is idle when this returns.
    await Promise.allSettled([...this.inflight]);
    await Promise.allSettled([...this.running.values()]);
    this.running.clear();
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const forget = () => this.inflight.delete(work);
    work.then(forget, forget);
    return work;
  }

  private expire(): Promise<void> {
    return this.track(
      this.options.pool.query('SELECT chorus_expire_enrollments()').then(() => undefined),
    );
  }

  /** Spawns a loop for every active room that does not have one yet. */
  scan(): Promise<void> {
    return this.track(this.scanRooms());
  }

  private async scanRooms(): Promise<void> {
    const { rows } = await this.options.pool.query<WatchedRoom>(
      'SELECT * FROM chorus_watcher_rooms()',
    );
    // Stopped while the query was in flight: spawn nothing (the pool may be about to close).
    if (this.abort.signal.aborted || !this.started) return;
    for (const room of rows) {
      const key = `${room.workspace_id}/${room.room_id}`;
      if (this.running.has(key)) continue;
      const loop = this.consumeRoom(room).finally(() => this.running.delete(key));
      this.running.set(key, loop);
    }
  }

  /** Takes the consumer lease for the room (or returns quietly if another process holds it) and runs the loop. */
  private async consumeRoom(room: WatchedRoom): Promise<void> {
    const { pool, logger } = this.options;
    const key = `${room.workspace_id}/${room.room_id}`;
    // This room's own abort: the watcher's stop() and the loss of the lease connection both end its long-poll.
    const roomAbort = new AbortController();
    const onStop = (): void => {
      roomAbort.abort();
    };
    if (this.abort.signal.aborted) onStop();
    else this.abort.signal.addEventListener('abort', onStop, { once: true });
    const lock = await pool.connect();
    const lockState = { broken: false };
    lock.on('error', () => {
      lockState.broken = true;
      this.held.delete(key);
      roomAbort.abort();
    });
    let gotLock = false;
    try {
      const got = await lock.query<{ got: boolean }>(LOCK_SQL, [room.room_id]);
      gotLock = got.rows[0]?.got === true;
      if (!gotLock) return; // another process consumes this room; retried on the next scan
      const epoch = Number(
        (
          await pool.query<{ e: string }>('SELECT chorus_watcher_claim_epoch($1, $2) AS e', [
            room.workspace_id,
            room.room_id,
          ])
        ).rows[0]?.e,
      );
      // Only now is the lease held; a lease connection that died meanwhile means it is not.
      if (lockState.broken || roomAbort.signal.aborted) return;
      this.held.add(key);
      logger.info({ room_id: room.room_id, epoch }, 'consuming room');
      await this.watchRoom(
        room,
        epoch,
        async () => {
          // The lease is only as good as its connection: if it died, another process may hold the lock now.
          if (lockState.broken) return false;
          try {
            await lock.query('SELECT 1');
            return true;
          } catch {
            this.held.delete(key);
            return false;
          }
        },
        roomAbort.signal,
      );
    } finally {
      this.held.delete(key); // synchronously, before any await: exit for any reason ends the lease
      this.abort.signal.removeEventListener('abort', onStop);
      if (gotLock && !lockState.broken) {
        await lock.query(UNLOCK_SQL, [room.room_id]).catch(() => undefined);
      }
      lock.release(lockState.broken ? true : undefined);
    }
  }

  private async watchRoom(
    room: WatchedRoom,
    epoch: number,
    leaseHeld: () => Promise<boolean>,
    signal: AbortSignal = this.abort.signal,
  ): Promise<void> {
    const { pool, client, secretsKey, logger, minPollIntervalMs, maxBackoffMs } = this.options;
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

    // Resume from the persisted cursor as it is NOW (a previous holder may have advanced it).
    const current = await pool.query<{ last_sequence: string }>(
      'SELECT last_sequence FROM chorus_watcher_rooms() WHERE room_id = $1',
      [room.room_id],
    );
    let after = Number(current.rows[0]?.last_sequence ?? room.last_sequence);
    let failures = 0;
    // Read through a function: `aborted` changes during the awaits below, which narrowing cannot see.
    const stopped = (): boolean => signal.aborted;
    while (!stopped()) {
      if (!(await leaseHeld())) {
        logger.warn(log, 'consumer lease lost; stopping this loop');
        return;
      }
      const started = Date.now();
      try {
        const page = await client.wait(room.external_room_id, token, after, signal);
        // The long-poll can outlive the lease: never handle (or advance past) a page without it.
        if (!(await leaseHeld())) {
          logger.warn(log, 'consumer lease lost; stopping this loop');
          return;
        }
        for (const message of page.messages) await this.handleMessage(room, message);
        const highest = page.messages.at(-1)?.sequence ?? after;
        await pool.query('SELECT chorus_watcher_advance($1, $2, $3, $4, true, NULL)', [
          room.workspace_id,
          room.room_id,
          highest,
          epoch,
        ]);
        after = highest;
        failures = 0;
        if (!page.hasMore) {
          const elapsed = Date.now() - started;
          if (elapsed < minPollIntervalMs) await sleep(minPollIntervalMs - elapsed, signal);
        }
      } catch (error) {
        if (stopped()) return; // stop(), or the lease connection died: not a watcher error
        if ((error as { code?: string }).code === 'CH003') {
          logger.warn(log, 'stale consumer epoch; another process took over this room');
          return;
        }
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
          .query('SELECT chorus_watcher_advance($1, $2, $3, $4, false, $5)', [
            room.workspace_id,
            room.room_id,
            after,
            epoch,
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
    await this.options.pool.query('SELECT chorus_enroll_verify($1, $2, $3, $4, $5, $6, $7, $8)', [
      room.workspace_id,
      room.room_id,
      nonce,
      message.id,
      message.sequence,
      message.senderPrincipalId,
      message.senderMemberId,
      message.senderAgentId,
    ]);
  }

  private async degrade(room: WatchedRoom, reason: string): Promise<void> {
    await this.options.pool
      .query('SELECT chorus_set_room_state($1, $2, $3, $4)', [
        room.workspace_id,
        room.room_id,
        'degraded',
        reason,
      ])
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
