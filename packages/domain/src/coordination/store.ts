import type { Queryable } from '../authz.ts';
import { canonicalJson } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import type { SourceMessage } from '../conversation/extract.ts';
import {
  EMPTY_STATE,
  type ApplyMessages,
  type ApplyResult,
  type CoordObject,
  type CoordState,
  type Member,
  type RefPrefix,
  type Transition,
} from './types.ts';

/**
 * CC-2c persistence for the pure coordination engine (spec §9). The engine itself is injected (spec D6), so this
 * layer never interprets messages: it loads a session's state, hands it to the engine with the new messages, and
 * writes back exactly what changed. Every statement runs as chorus_app under the session RLS of 0009.
 */

/** The engine plus the seats it must ignore, as the tool layer wires it. */
export interface CoordinationEngine {
  readonly apply: ApplyMessages;
  readonly excludeMemberIds: readonly string[];
  /** The room's known members (`ApplyContext.roster`). */
  readonly roster?: readonly Member[];
}

/** What a scan reports about the engine run (spec §9: counts only). */
export type CoordinationApplied = {
  readonly applied_messages: number;
  readonly skipped_before_cursor: number;
  readonly new_objects: number;
  readonly transitions: number;
};

interface StateRow {
  cursor: string | number;
  next_refs: Record<RefPrefix, number>;
}

async function readObjects(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
): Promise<CoordObject[]> {
  const { rows } = await db.query<{ body: CoordObject }>(
    `SELECT body FROM conversation_objects
      WHERE workspace_id = $1 AND session_id = $2
      ORDER BY created_seq, ref`,
    [workspaceId, sessionId],
  );
  return rows.map((row) => row.body);
}

/** Read-only state for tools; an unscanned session is the empty state. */
export async function loadCoordState(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
): Promise<CoordState> {
  const { rows } = await db.query<StateRow>(
    'SELECT cursor, next_refs FROM conversation_engine_state WHERE workspace_id = $1 AND session_id = $2',
    [workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined) return EMPTY_STATE;
  return {
    cursor: Number(row.cursor),
    next: row.next_refs,
    objects: await readObjects(db, workspaceId, sessionId),
  };
}

/**
 * Locks the session's engine state for the rest of the transaction (creating it on first use) and returns it.
 * Concurrent scans of one session serialize here, so the cursor stays monotonic (spec D7).
 */
export async function lockCoordState(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
): Promise<CoordState> {
  await db.query(
    `INSERT INTO conversation_engine_state (workspace_id, session_id) VALUES ($1, $2)
     ON CONFLICT (workspace_id, session_id) DO NOTHING`,
    [workspaceId, sessionId],
  );
  const { rows } = await db.query<StateRow>(
    `SELECT cursor, next_refs FROM conversation_engine_state
      WHERE workspace_id = $1 AND session_id = $2 FOR UPDATE`,
    [workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined)
    throw new ChorusError('internal_error', 'The coordination state was not stored.');
  return {
    cursor: Number(row.cursor),
    next: row.next_refs,
    objects: await readObjects(db, workspaceId, sessionId),
  };
}

/** Writes an engine result: new and changed objects, the transitions (append-only), and the cursor. */
export async function persistCoordResult(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
  before: CoordState,
  result: ApplyResult,
  actorId: Uuid | null,
): Promise<{ readonly newObjects: number }> {
  // Compared canonically: bodies read back from jsonb have their keys reordered, and an engine may rebuild an
  // unchanged object as a fresh literal. Both sides are the CoordObject body only (no DB-only columns).
  const previous = new Map(before.objects.map((object) => [object.ref, canonicalJson(object)]));
  let newObjects = 0;
  for (const object of result.state.objects) {
    const body = JSON.stringify(object);
    const old = previous.get(object.ref);
    if (old === canonicalJson(object)) continue;
    if (old === undefined) {
      newObjects += 1;
      await db.query(
        `INSERT INTO conversation_objects
           (workspace_id, session_id, ref, kind, status, body, linked_item_id, created_seq, touched_seq)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          workspaceId,
          sessionId,
          object.ref,
          object.kind,
          object.status,
          body,
          object.linked_item_id ?? null,
          object.created_seq,
          object.touched_seq,
        ],
      );
    } else {
      await db.query(
        `UPDATE conversation_objects
            SET status = $4, body = $5::jsonb, linked_item_id = $6, touched_seq = $7, updated_at = now()
          WHERE workspace_id = $1 AND session_id = $2 AND ref = $3`,
        [
          workspaceId,
          sessionId,
          object.ref,
          object.status,
          body,
          object.linked_item_id ?? null,
          object.touched_seq,
        ],
      );
    }
  }
  await insertTransitions(db, workspaceId, sessionId, result.transitions, actorId);
  await db.query(
    `UPDATE conversation_engine_state SET cursor = $3, next_refs = $4::jsonb, updated_at = now()
      WHERE workspace_id = $1 AND session_id = $2`,
    [workspaceId, sessionId, result.state.cursor, JSON.stringify(result.state.next)],
  );
  return { newObjects };
}

export async function insertTransitions(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
  transitions: readonly Transition[],
  actorId: Uuid | null,
): Promise<void> {
  for (const t of transitions) {
    await db.query(
      `INSERT INTO conversation_transitions
         (workspace_id, session_id, ref, from_status, to_status, cause, message_id, reason, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        workspaceId,
        sessionId,
        t.ref,
        t.from,
        t.to,
        t.cause,
        t.message_id ?? null,
        t.reason.slice(0, 500),
        actorId,
      ],
    );
  }
}

/**
 * The scan-time engine run (spec §9, inside the scan transaction): lock, apply the in-window messages above the
 * cursor, persist, and point the CC-1 suggestions of this scan at their objects (spec D9).
 */
export async function applyScanToCoordination(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
  /** The scanner; `null` for the room watcher's follow (spec §10), which acts for no one. */
  actorId: Uuid | null,
  window: { readonly from: number; readonly to: number },
  messages: readonly SourceMessage[],
  engine: CoordinationEngine,
): Promise<CoordinationApplied> {
  const before = await lockCoordState(db, workspaceId, sessionId);
  const inWindow = messages.filter((m) => m.sequence >= window.from && m.sequence <= window.to);
  const fresh = inWindow
    .filter((m) => m.sequence > before.cursor)
    .sort((a, b) => a.sequence - b.sequence);
  const result = engine.apply(before, fresh, {
    excludeMemberIds: engine.excludeMemberIds,
    ...(engine.roster === undefined ? {} : { roster: engine.roster }),
  });
  const { newObjects } = await persistCoordResult(
    db,
    workspaceId,
    sessionId,
    before,
    result,
    actorId,
  );
  await linkSuggestionsToObjects(db, workspaceId, sessionId, result.state.objects);
  return {
    applied_messages: fresh.length,
    skipped_before_cursor: inWindow.length - fresh.length,
    new_objects: newObjects,
    transitions: result.transitions.length,
  };
}

/** Sets `object_ref` on CC-1 suggestions that share a kind and a source message with an object (spec D9). */
async function linkSuggestionsToObjects(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
  objects: readonly CoordObject[],
): Promise<void> {
  for (const object of objects) {
    if (object.kind !== 'question' && object.kind !== 'commitment') continue;
    const first = object.sources[0];
    if (first === undefined) continue;
    await db.query(
      `UPDATE conversation_suggestions SET object_ref = $5
        WHERE workspace_id = $1 AND session_id = $2 AND kind = $3 AND source_message_id = $4
          AND object_ref IS DISTINCT FROM $5`,
      [workspaceId, sessionId, object.kind, first.message_id, object.ref],
    );
  }
}

/**
 * CC-1 link/dismiss → CC-2 object (spec D9). Linking records the task on the object (its status is unchanged);
 * dismissing moves it to `dismissed`. Both append a `command` transition. A suggestion with no object (a scan
 * that ran without the engine) is a no-op.
 */
export async function syncObjectFromSuggestion(
  db: Queryable,
  workspaceId: Uuid,
  sessionId: Uuid,
  suggestionId: Uuid,
  actorId: Uuid,
  change: { readonly linkedItemId?: Uuid; readonly dismiss?: true },
): Promise<void> {
  const { rows } = await db.query<{ ref: string; status: string }>(
    `SELECT o.ref, o.status FROM conversation_suggestions s
       JOIN conversation_objects o
         ON o.workspace_id = s.workspace_id AND o.session_id = s.session_id AND o.ref = s.object_ref
      WHERE s.workspace_id = $1 AND s.session_id = $2 AND s.id = $3
      FOR UPDATE OF o`,
    [workspaceId, sessionId, suggestionId],
  );
  const object = rows[0];
  if (object === undefined) return;
  if (change.linkedItemId !== undefined) {
    await db.query(
      `UPDATE conversation_objects
          SET linked_item_id = $4::uuid, body = jsonb_set(body, '{linked_item_id}', to_jsonb($4::uuid)),
              updated_at = now()
        WHERE workspace_id = $1 AND session_id = $2 AND ref = $3`,
      [workspaceId, sessionId, object.ref, change.linkedItemId],
    );
    await insertTransitions(
      db,
      workspaceId,
      sessionId,
      [
        {
          ref: object.ref,
          from: object.status,
          to: object.status,
          cause: 'command',
          reason: `linked to task ${change.linkedItemId}`,
        },
      ],
      actorId,
    );
  }
  if (change.dismiss === true && object.status !== 'dismissed') {
    await db.query(
      `UPDATE conversation_objects
          SET status = 'dismissed', body = jsonb_set(body, '{status}', '"dismissed"'), updated_at = now()
        WHERE workspace_id = $1 AND session_id = $2 AND ref = $3`,
      [workspaceId, sessionId, object.ref],
    );
    await insertTransitions(
      db,
      workspaceId,
      sessionId,
      [
        {
          ref: object.ref,
          from: object.status,
          to: 'dismissed',
          cause: 'command',
          reason: 'suggestion dismissed',
        },
      ],
      actorId,
    );
  }
}
