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
  processingState: "applied" | "skipped" | "command" | "own" | "extraction_failed";
}

export interface InterventionRow {
  key: string;
  type: string;
  text: string;
  solicited: boolean;
  outputMessageId: string | null;
  postedAt: string;
}

export interface ReceiptRow {
  operation: string;
  body: Record<string, unknown>;
  sha256: string;
  signature: string;
  key_id: string;
  messageId?: string;
}

/** One LLM request, raw response included (spec §48: "store raw LLM response separately"). */
export interface LlmCallRow {
  purpose: string;
  model: string;
  rawResponse: string;
  parsedOk: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  at: string;
}

export interface CommitPayload {
  seq: number;
  state: unknown;
  message?: MessageRow;
  interventions: InterventionRow[];
  receipts?: ReceiptRow[];
}

export interface Store {
  load(roomId: string): StoredRoom | null;
  commit(roomId: string, commit: CommitPayload): void;
  logLlmCall?(roomId: string, call: LlmCallRow): void;
  /** §65: delete audit rows older than the cutoff */
  prune?(roomId: string, cutoffIso: string): void;
  close(): void;
}

/** No persistence: replay and tests. */
export class MemoryStore implements Store {
  private rooms = new Map<string, StoredRoom>();
  load(roomId: string): StoredRoom | null {
    const r = this.rooms.get(roomId);
    return r ? structuredClone(r) : null;
  }
  commit(roomId: string, c: CommitPayload): void {
    this.rooms.set(roomId, { lastProcessedSeq: c.seq, state: structuredClone(c.state) });
  }
  close(): void {}
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  /** Prepared statements are compiled once and reused. */
  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

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
      CREATE TABLE IF NOT EXISTS receipts (
        room_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        operation TEXT NOT NULL,
        body_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        key_id TEXT NOT NULL,
        message_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (room_id, sha256)
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        raw_response TEXT NOT NULL,
        parsed_ok INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
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
    const row = this
      .stmt("SELECT last_processed_seq, state_json FROM rooms WHERE room_id = ?")
      .get(roomId) as { last_processed_seq: number; state_json: string } | undefined;
    return row ? { lastProcessedSeq: row.last_processed_seq, state: JSON.parse(row.state_json) } : null;
  }

  commit(roomId: string, c: CommitPayload): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this
        .stmt(
          `INSERT INTO rooms (room_id, last_processed_seq, state_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (room_id) DO UPDATE SET last_processed_seq = excluded.last_processed_seq,
             state_json = excluded.state_json, updated_at = excluded.updated_at`,
        )
        .run(roomId, c.seq, JSON.stringify(c.state), now);
      if (c.message) {
        const m = c.message;
        this
          .stmt(
            `INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (room_id, external_message_id) DO UPDATE SET processing_state = excluded.processing_state`,
          )
          .run(roomId, m.externalId, m.seq, m.authorId, m.text, m.timestamp, m.isFromChorus ? 1 : 0, m.processingState);
      }
      for (const i of c.interventions) {
        this
          .stmt(
            `INSERT INTO interventions VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (room_id, idempotency_key) DO UPDATE SET output_message_id = excluded.output_message_id`,
          )
          .run(roomId, i.key, i.type, i.text, i.solicited ? 1 : 0, i.outputMessageId, i.postedAt);
      }
      for (const r of c.receipts ?? []) {
        this
          .stmt(
            `INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (room_id, sha256) DO UPDATE SET message_id = excluded.message_id`,
          )
          .run(roomId, r.sha256, r.operation, JSON.stringify(r.body), r.signature, r.key_id, r.messageId ?? null, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  logLlmCall(roomId: string, call: LlmCallRow): void {
    this
      .stmt(
        `INSERT INTO llm_calls (room_id, purpose, model, raw_response, parsed_ok, input_tokens, output_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(roomId, call.purpose, call.model, call.rawResponse, call.parsedOk ? 1 : 0, call.inputTokens, call.outputTokens, call.latencyMs, call.at);
  }

  prune(roomId: string, cutoffIso: string): void {
    this.stmt("DELETE FROM messages WHERE room_id = ? AND created_at < ?").run(roomId, cutoffIso);
    this.stmt("DELETE FROM llm_calls WHERE room_id = ? AND created_at < ?").run(roomId, cutoffIso);
  }

  close(): void {
    this.db.close();
  }
}
