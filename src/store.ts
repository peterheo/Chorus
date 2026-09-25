// Persistence (spec §33, §35, §69, §70), hackathon profile: SQLite via
// Node's built-in node:sqlite. After every processed message the full room
// state is snapshotted together with last_processed_seq in one transaction,
// so a crash mid-message re-processes that message from the previous
// snapshot. Messages and interventions are also kept as an audit log.

import { DatabaseSync } from "node:sqlite";

export interface StoredRoom {
  lastProcessedSeq: number;
  state: unknown;
}

export interface MessageRow {
  externalId: string;
  seq: number;
  authorId: string;
  text: string;
  timestamp: string;
  isFromChorus: boolean;
  processingState: "applied" | "skipped" | "command" | "own";
}

export interface InterventionRow {
  key: string;
  type: string;
  text: string;
  solicited: boolean;
  outputMessageId: string | null;
  postedAt: string;
}

export interface Store {
  load(roomId: string): StoredRoom | null;
  commit(roomId: string, commit: { seq: number; state: unknown; message?: MessageRow; interventions: InterventionRow[] }): void;
  close(): void;
}

/** No persistence: replay and tests. */
export class MemoryStore implements Store {
  private rooms = new Map<string, StoredRoom>();
  load(roomId: string): StoredRoom | null {
    const r = this.rooms.get(roomId);
    return r ? structuredClone(r) : null;
  }
  commit(roomId: string, c: { seq: number; state: unknown }): void {
    this.rooms.set(roomId, { lastProcessedSeq: c.seq, state: structuredClone(c.state) });
  }
  close(): void {}
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        last_processed_seq INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        room_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        author_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_from_chorus INTEGER NOT NULL,
        processing_state TEXT NOT NULL,
        PRIMARY KEY (room_id, external_message_id)
      );
      CREATE TABLE IF NOT EXISTS interventions (
        room_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        solicited INTEGER NOT NULL,
        output_message_id TEXT,
        posted_at TEXT NOT NULL,
        PRIMARY KEY (room_id, idempotency_key)
      );
    `);
  }

  load(roomId: string): StoredRoom | null {
    const row = this.db
      .prepare("SELECT last_processed_seq, state_json FROM rooms WHERE room_id = ?")
      .get(roomId) as { last_processed_seq: number; state_json: string } | undefined;
    return row ? { lastProcessedSeq: row.last_processed_seq, state: JSON.parse(row.state_json) } : null;
  }

  commit(
    roomId: string,
    c: { seq: number; state: unknown; message?: MessageRow; interventions: InterventionRow[] },
  ): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO rooms (room_id, last_processed_seq, state_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (room_id) DO UPDATE SET last_processed_seq = excluded.last_processed_seq,
             state_json = excluded.state_json, updated_at = excluded.updated_at`,
        )
        .run(roomId, c.seq, JSON.stringify(c.state), now);
      if (c.message) {
        const m = c.message;
        this.db
          .prepare(
            `INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (room_id, external_message_id) DO UPDATE SET processing_state = excluded.processing_state`,
          )
          .run(roomId, m.externalId, m.seq, m.authorId, m.text, m.timestamp, m.isFromChorus ? 1 : 0, m.processingState);
      }
      for (const i of c.interventions) {
        this.db
          .prepare(
            `INSERT INTO interventions VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (room_id, idempotency_key) DO UPDATE SET output_message_id = excluded.output_message_id`,
          )
          .run(roomId, i.key, i.type, i.text, i.solicited ? 1 : 0, i.outputMessageId, i.postedAt);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
