// Persistence (spec §33, §35, §69, §70), hackathon profile: SQLite via
// Node's built-in node:sqlite. After every processed message, one transaction
// writes: the room's core state (objects, counters, interventions), only the
// *new* room messages and transitions (append-only tables, so cost does not
// grow with room length), and last_processed_seq. A crash mid-message
// re-processes that message from the previous commit. Messages and
// interventions are also kept as an audit log.

import { DatabaseSync } from "node:sqlite";

export interface StoredRoom {
  lastProcessedSeq: number;
  /** full RoomSnapshot: core state with messages and transitions reassembled */
  state: unknown;
  /** how many messages/transitions are already in the append-only tables */
  persisted: { messages: number; transitions: number };
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
  /** room state without messages and transitions (RoomState.toCore()) */
  core: unknown;
  /** messages/transitions appended since the last commit, and the index of the first */
  appendMessages: unknown[];
  messagesFrom: number;
  appendTransitions: unknown[];
  transitionsFrom: number;
  /** §65: blank stored message text and delete audit rows older than this */
  pruneBefore?: string;
  message?: MessageRow;
  interventions: InterventionRow[];
  receipts?: ReceiptRow[];
}

export interface Store {
  load(roomId: string): StoredRoom | null;
  commit(roomId: string, commit: CommitPayload): void;
  logLlmCall?(roomId: string, call: LlmCallRow): void;
  close(): void;
}

/** No persistence: replay and tests. Same semantics as SqliteStore. */
export class MemoryStore implements Store {
  private rooms = new Map<string, { seq: number; core: unknown; messages: unknown[]; transitions: unknown[] }>();
  load(roomId: string): StoredRoom | null {
    const r = this.rooms.get(roomId);
    if (!r) return null;
    const state = structuredClone({ ...(r.core as object), messages: r.messages, transitions: r.transitions });
    return { lastProcessedSeq: r.seq, state, persisted: { messages: r.messages.length, transitions: r.transitions.length } };
  }
  commit(roomId: string, c: CommitPayload): void {
    const r = this.rooms.get(roomId) ?? { seq: 0, core: {}, messages: [], transitions: [] };
    r.seq = c.seq;
    r.core = structuredClone(c.core);
    c.appendMessages.forEach((m, i) => (r.messages[c.messagesFrom + i] = structuredClone(m)));
    c.appendTransitions.forEach((t, i) => (r.transitions[c.transitionsFrom + i] = structuredClone(t)));
    if (c.pruneBefore) {
      for (const m of r.messages as Array<{ timestamp: string; text: string }>) if (m.timestamp < c.pruneBefore) m.text = "";
    }
    this.rooms.set(roomId, r);
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
      -- Append-only room logs, one JSON row per entry (idx = position).
      CREATE TABLE IF NOT EXISTS state_messages (
        room_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (room_id, idx)
      );
      CREATE TABLE IF NOT EXISTS state_transitions (
        room_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (room_id, idx)
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
    if (!row) return null;
    const core = JSON.parse(row.state_json) as Record<string, unknown>;
    if (Array.isArray(core.messages)) {
      // A full snapshot written before the append-only tables existed. Report
      // nothing persisted, so the next commit writes every entry and migrates it.
      return { lastProcessedSeq: row.last_processed_seq, state: core, persisted: { messages: 0, transitions: 0 } };
    }
    const rows = (table: string) =>
      (this.stmt(`SELECT json FROM ${table} WHERE room_id = ? ORDER BY idx`).all(roomId) as Array<{ json: string }>).map((r) =>
        JSON.parse(r.json),
      );
    const messages = rows("state_messages");
    const transitions = rows("state_transitions");
    return {
      lastProcessedSeq: row.last_processed_seq,
      state: { ...core, messages, transitions },
      persisted: { messages: messages.length, transitions: transitions.length },
    };
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
        .run(roomId, c.seq, JSON.stringify(c.core), now);
      const append = (table: string, from: number, items: unknown[]) => {
        const ins = this.stmt(
          `INSERT INTO ${table} (room_id, idx, json) VALUES (?, ?, ?) ON CONFLICT (room_id, idx) DO UPDATE SET json = excluded.json`,
        );
        items.forEach((item, i) => ins.run(roomId, from + i, JSON.stringify(item)));
      };
      append("state_messages", c.messagesFrom, c.appendMessages);
      append("state_transitions", c.transitionsFrom, c.appendTransitions);
      if (c.pruneBefore) {
        this.stmt(
          `UPDATE state_messages SET json = json_set(json, '$.text', '')
           WHERE room_id = ? AND json_extract(json, '$.timestamp') < ? AND json_extract(json, '$.text') != ''`,
        ).run(roomId, c.pruneBefore);
        this.stmt("DELETE FROM messages WHERE room_id = ? AND created_at < ?").run(roomId, c.pruneBefore);
        this.stmt("DELETE FROM llm_calls WHERE room_id = ? AND created_at < ?").run(roomId, c.pruneBefore);
      }
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

  close(): void {
    this.db.close();
  }
}
