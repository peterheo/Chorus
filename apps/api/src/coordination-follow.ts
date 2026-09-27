import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  applyScanToCoordination,
  loadCoordState,
  type ApplyMessages,
  type CoordState,
  type Evaluate,
  type Member,
  type SignalKind,
  type SourceMessage,
  type Uuid,
} from '@chorus/domain';
import { roomRosters, type RoomRosters } from './room-roster.ts';
import {
  senderDisplayName,
  type SharedNetClient,
  type SharedNetMessage,
} from './sharednet/client.ts';

/**
 * CC-2d (spec §10): follow + assist posting. After the watcher has handled a page of room messages, every
 * session of that room in `observe` or `assist` mode gets the new messages through the scan's own persistence
 * path (lock, apply, persist, cursor rules). In `assist`, the high-value signals of the resulting state are
 * posted to the room from Chorus's service seat, at most once each and rate-limited per room.
 *
 * Isolation: each session is one transaction; a failure there is logged and skipped (it rolls back, so that
 * session's cursor does not move) and never reaches enrollment, other sessions or other rooms. No network I/O
 * happens inside a transaction: the post is sent between them, and its key is recorded only after it succeeds.
 *
 * Leak rule (D4): a post is built ONLY from the engine's signal text (itself derived from room messages) and
 * the room sequences of the signal's objects. Nothing session-private (session name or id, task id or title)
 * is ever read here.
 */
export interface CoordinationDeps {
  readonly apply: ApplyMessages;
  readonly evaluate: Evaluate;
}

export interface FollowRoom {
  readonly workspace_id: string;
  readonly room_id: string;
  readonly external_room_id: string;
  /** The room's Chorus service seat: its messages are never applied and never counted. */
  readonly member_id: string;
}

interface FollowerOptions {
  readonly pool: pg.Pool;
  readonly client: SharedNetClient;
  readonly engine: CoordinationDeps;
  readonly logger: { warn: (obj: Record<string, unknown>, msg: string) => void };
  readonly now: () => number;
  /** Where the room's known members come from (`ApplyContext.roster`). Default: the process-wide rosters. */
  readonly rosters?: RoomRosters;
}

/** The only kinds ever posted, in posting priority order (spec §10). */
export const POSTABLE_KINDS: readonly SignalKind[] = [
  'conflict',
  'decision_contradicted',
  'duplicate_commitments',
  'dependency_resolved',
  'dependency_deadlock',
];
export const POST_LIMIT = { perWindow: 3, windowMs: 5 * 60_000, minGap: 8, maxLines: 4 } as const;

interface Target {
  session_id: Uuid;
  coordination_mode: 'observe' | 'assist';
  acting_actor_id: string;
}

/** One signal that is due in one session. */
interface Due {
  readonly target: Target;
  readonly kind: SignalKind;
  readonly key: string;
  readonly line: string;
  /** Room-level identity (kind + source sequences), the same in every session that sees the signal. */
  readonly fingerprint: string;
  readonly latest: { readonly message_id: string; readonly sequence: number } | undefined;
}

interface RoomPosts {
  times: number[];
  sinceLast: number;
  /** Fingerprints this process has posted in the room, with the message that carried them (bounded). */
  readonly posted: Map<string, string>;
}

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** sha256(session_id, kind, sorted refs): the stored key (64 hex, the 0009 column format). */
export function signalKey(sessionId: string, kind: SignalKind, refs: readonly string[]): string {
  return hex(`${sessionId}\n${kind}\n${[...refs].sort().join(',')}`);
}

/** A 64-hex digest as a UUIDv4-shaped string: its first 16 bytes, with the version and variant bits set. */
export function keyUuid(key: string): string {
  const h = key.slice(0, 32).split('');
  h[12] = '4';
  h[16] = ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const toSource = (m: SharedNetMessage): SourceMessage => ({
  message_id: m.id,
  sequence: m.sequence,
  sender_member_id: m.senderMemberId,
  sender_principal_id: m.senderPrincipalId,
  sender_name: senderDisplayName(m.senderName, m.senderMemberId),
  content: m.content,
  reply_to_message_id: m.replyToMessageId ?? null,
});

export class CoordinationFollower {
  private readonly rooms = new Map<string, RoomPosts>();
  private readonly options: FollowerOptions;

  constructor(options: FollowerOptions) {
    this.options = options;
  }

  /** One follow step for a page of room messages. Never throws. */
  async step(
    room: FollowRoom,
    token: string,
    page: readonly SharedNetMessage[],
    signal?: AbortSignal,
  ): Promise<void> {
    const { pool, logger } = this.options;
    // Every sender on the page joins the room roster (in memory, before any transaction); the roster the
    // engine gets never includes the Chorus seat.
    const rosters = this.options.rosters ?? roomRosters;
    rosters.note(
      room.external_room_id,
      page
        .filter((m) => (m.type ?? 'message') === 'message')
        .map((m) => ({
          member_id: m.senderMemberId,
          name: senderDisplayName(m.senderName, m.senderMemberId),
        })),
    );
    const roster = rosters.get(room.external_room_id, [room.member_id]);
    const fresh = page.filter(
      (m) => m.senderMemberId !== room.member_id && (m.type ?? 'message') === 'message',
    );
    const posts = this.rooms.get(room.room_id) ?? {
      times: [],
      sinceLast: Number.POSITIVE_INFINITY,
      posted: new Map<string, string>(),
    };
    this.rooms.set(room.room_id, posts);
    posts.sinceLast += fresh.length;
    if (fresh.length === 0) return;
    let targets: Target[];
    try {
      targets = (
        await pool.query<Target>('SELECT * FROM chorus_coordination_apply($1, $2)', [
          room.workspace_id,
          room.room_id,
        ])
      ).rows;
    } catch (error) {
      logger.warn({ room_id: room.room_id, error: (error as Error).name }, 'follow lookup failed');
      return;
    }
    const due: Due[] = [];
    for (const target of targets) {
      try {
        due.push(...(await this.followSession(room, target, fresh, roster)));
      } catch (error) {
        logger.warn(
          { room_id: room.room_id, session_id: target.session_id, error: (error as Error).name },
          'coordination follow failed; session skipped',
        );
      }
    }
    if (due.length > 0) await this.post(room, token, due, posts, signal);
  }

  /** Runs `work` in one transaction under the session's RLS context (spec D2): its own member's view. */
  private async inSession<T>(
    room: FollowRoom,
    target: Target,
    work: (db: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.options.pool.connect();
    let broken = false;
    try {
      await db.query('BEGIN');
      await db.query(
        `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
        [room.workspace_id, target.acting_actor_id],
      );
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      // A connection that cannot even roll back is destroyed, never handed back to the pool.
      broken = !(await db.query('ROLLBACK').then(
        () => true,
        () => false,
      ));
      throw error;
    } finally {
      db.release(broken);
    }
  }

  private followSession(
    room: FollowRoom,
    target: Target,
    fresh: readonly SharedNetMessage[],
    roster: readonly Member[],
  ): Promise<Due[]> {
    const { engine } = this.options;
    const sessionId = target.session_id;
    const ws = room.workspace_id as Uuid;
    return this.inSession(room, target, async (db) => {
      // Re-read under RLS inside the transaction: a mode switched off since the lookup stops here.
      const mode = (
        await db.query<{ coordination_mode: string }>(
          'SELECT coordination_mode FROM sessions WHERE workspace_id = $1 AND id = $2',
          [room.workspace_id, sessionId],
        )
      ).rows[0]?.coordination_mode;
      if (mode !== 'observe' && mode !== 'assist') return [];
      const messages = fresh.map(toSource);
      const window = { from: messages[0]?.sequence ?? 0, to: messages.at(-1)?.sequence ?? 0 };
      await applyScanToCoordination(db, ws, sessionId, null, window, messages, {
        apply: engine.apply,
        excludeMemberIds: [room.member_id],
        roster,
      });
      if (mode !== 'assist') return [];
      const state = await loadCoordState(db, ws, sessionId);
      const due = this.dueSignals(target, state);
      if (due.length === 0) return [];
      const recorded = await db.query<{ signal_key: string }>(
        `SELECT signal_key FROM conversation_posts
          WHERE workspace_id = $1 AND session_id = $2 AND signal_key = ANY ($3::text[])`,
        [room.workspace_id, sessionId, due.map((d) => d.key)],
      );
      const done = new Set(recorded.rows.map((r) => r.signal_key));
      return due.filter((d) => !done.has(d.key));
    });
  }

  private dueSignals(target: Target, state: CoordState): Due[] {
    const byRef = new Map(state.objects.map((o) => [o.ref, o]));
    const due: Due[] = [];
    for (const signal of this.options.engine.evaluate(state)) {
      if (!POSTABLE_KINDS.includes(signal.kind)) continue;
      const sources = signal.refs
        .flatMap((ref) => byRef.get(ref)?.sources ?? [])
        .sort((a, b) => a.sequence - b.sequence);
      if (sources.length === 0) continue; // nothing in the room to point at
      const sequences = [...new Set(sources.map((s) => s.sequence))];
      const action = signal.suggested_next_action.replace(/\s+/g, ' ').trim();
      due.push({
        target,
        kind: signal.kind,
        key: signalKey(target.session_id, signal.kind, signal.refs),
        line: `[chorus] ${action} (refs: ${sequences.join(', ')})`,
        fingerprint: `${signal.kind}|${sequences.join(',')}`,
        latest: sources.at(-1),
      });
    }
    return due;
  }

  /**
   * One post per step and room at most: once per ROOM per signal (the same fingerprint from several sessions
   * is one line, and every session records its own key), rate-limited, merged up to 4 lines.
   */
  private async post(
    room: FollowRoom,
    token: string,
    due: readonly Due[],
    posts: RoomPosts,
    signal?: AbortSignal,
  ): Promise<void> {
    const { client, logger, now } = this.options;
    // Already carried by an earlier post of this process (another session saw it first): record, don't send.
    const record = new Map<string, Due[]>();
    const groups = new Map<string, Due[]>();
    for (const d of due) {
      const previous = posts.posted.get(d.fingerprint);
      if (previous === undefined)
        groups.set(d.fingerprint, [...(groups.get(d.fingerprint) ?? []), d]);
      else record.set(previous, [...(record.get(previous) ?? []), d]);
    }
    const rank = (g: Due[]) => POSTABLE_KINDS.indexOf(g[0]?.kind ?? 'conflict');
    const at = now();
    posts.times = posts.times.filter((t) => at - t < POST_LIMIT.windowMs);
    const eligible = [...groups.values()]
      .filter((g) => posts.sinceLast >= POST_LIMIT.minGap || g[0]?.kind === 'conflict')
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, POST_LIMIT.maxLines);
    if (eligible.length > 0 && posts.times.length < POST_LIMIT.perWindow) {
      const chosen = eligible.flat();
      const lines = eligible.map((g) => g[0]?.line ?? '');
      const latest = chosen
        .map((d) => d.latest)
        .reduce((a, b) =>
          b !== undefined && (a === undefined || b.sequence > a.sequence) ? b : a,
        );
      const keys = [...new Set(chosen.map((d) => d.key))].sort();
      const idempotencyKey = keyUuid(keys.length === 1 ? (keys[0] ?? '') : hex(keys.join('\n')));
      try {
        const messageId = await client.postMessage(
          room.external_room_id,
          token,
          { content: lines.join('\n'), replyToMessageId: latest?.message_id ?? null },
          idempotencyKey,
          signal,
        );
        posts.times.push(at);
        posts.sinceLast = 0;
        for (const g of eligible) posts.posted.set(g[0]?.fingerprint ?? '', messageId);
        if (posts.posted.size > 1000) posts.posted.delete(posts.posted.keys().next().value ?? '');
        record.set(messageId, [...(record.get(messageId) ?? []), ...chosen]);
      } catch (error) {
        // Nothing recorded: the same signals are due again on the next step.
        logger.warn(
          { room_id: room.room_id, error: (error as Error).name },
          'coordination post failed',
        );
      }
    }
    for (const [messageId, entries] of record) await this.recordPosted(room, messageId, entries);
  }

  /** Records each session's posted keys, each in its own session context (after the send, never before). */
  private async recordPosted(room: FollowRoom, messageId: string, entries: readonly Due[]) {
    const bySession = new Map<string, { target: Target; keys: string[] }>();
    for (const d of entries) {
      const entry = bySession.get(d.target.session_id) ?? { target: d.target, keys: [] };
      entry.keys.push(d.key);
      bySession.set(d.target.session_id, entry);
    }
    for (const { target, keys } of bySession.values()) {
      await this.inSession(room, target, (db) =>
        db.query(
          `INSERT INTO conversation_posts (workspace_id, session_id, signal_key, message_id)
           SELECT $1, $2, k, $4 FROM unnest($3::text[]) AS k
           ON CONFLICT DO NOTHING`,
          [room.workspace_id, target.session_id, keys, messageId],
        ),
      ).catch((error: unknown) => {
        this.options.logger.warn(
          { room_id: room.room_id, session_id: target.session_id, error: (error as Error).name },
          'coordination post not recorded',
        );
      });
    }
  }
}
