import { createHash } from 'node:crypto';
import { requireAction, type Queryable } from '../authz.ts';
import {
  runCommand,
  withReadTx,
  type CommandContext,
  type DomainEventDraft,
  type ReadContext,
} from '../command.ts';
import { requireSession } from '../commands/support.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import type { ExtractedSuggestion, SourceMessage, SuggestionKind } from './extract.ts';
import {
  applyScanToCoordination,
  syncObjectFromSuggestion,
  type CoordinationApplied,
  type CoordinationEngine,
} from '../coordination/store.ts';

/**
 * CC-1b domain: scans and suggestions (CC-1 rev1.1 section 4). Every mutation goes through `runCommand`; the
 * session actions reused are `link_message` (scan, link, dismiss) and `read` (the list below), so `authz.ts`
 * is never touched. A suggestion is evidence, never authority: only `linkSuggestion` changes canonical state
 * (one work item, one version bump, one `message_links` row), and only when the caller explicitly asks.
 */

const SNAPSHOT_MAX_BYTES = 32 * 1024;

/** Truncates to at most `maxBytes` of UTF-8, backing off to the nearest earlier code-point boundary. */
function truncateUtf8(content: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= maxBytes) return content;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > 0; end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      continue;
    }
  }
  return '';
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export type SuggestionSource = {
  readonly message_id: string;
  readonly sequence: number;
  readonly sender_member_id: string;
  readonly sender_principal_id: string;
  readonly sender_name: string;
};

/** What suggestions.ts hands back; the tool layer builds `inferred`, `suggested_task` and `recommended_request_id`
 * from this (they are deterministic from `kind`/`excerpt`/`suggestion_id` and need no domain round trip). */
export type Suggestion = {
  readonly suggestion_id: Uuid;
  readonly kind: SuggestionKind;
  readonly state: 'open' | 'linked' | 'dismissed';
  readonly excerpt: string;
  readonly confidence: 'high' | 'medium';
  readonly source: SuggestionSource;
  readonly replied_by_other: boolean;
  readonly suggested_next_action: string;
  readonly linked_item_id: Uuid | null;
  readonly first_scan_id: Uuid;
  readonly last_scan_id: Uuid;
  readonly created_at: string;
  readonly updated_at: string;
};

interface SuggestionRow {
  id: Uuid;
  kind: SuggestionKind;
  state: 'open' | 'linked' | 'dismissed';
  excerpt: string;
  confidence: 'high' | 'medium';
  source_message_id: string;
  source_sequence: string | number;
  source_member_id: string;
  source_principal_id: string;
  source_name: string;
  replied_by_other: boolean;
  suggested_next_action: string;
  linked_item_id: Uuid | null;
  first_scan_id: Uuid;
  last_scan_id: Uuid;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, kind, state, excerpt, confidence, source_message_id, source_sequence, source_member_id,
  source_principal_id, source_name, replied_by_other, suggested_next_action, linked_item_id, first_scan_id,
  last_scan_id, created_at, updated_at`;

const toSuggestion = (row: SuggestionRow): Suggestion => ({
  suggestion_id: row.id,
  kind: row.kind,
  state: row.state,
  excerpt: row.excerpt,
  confidence: row.confidence,
  source: {
    message_id: row.source_message_id,
    sequence: Number(row.source_sequence),
    sender_member_id: row.source_member_id,
    sender_principal_id: row.source_principal_id,
    sender_name: row.source_name,
  },
  replied_by_other: row.replied_by_other,
  suggested_next_action: row.suggested_next_action,
  linked_item_id: row.linked_item_id,
  first_scan_id: row.first_scan_id,
  last_scan_id: row.last_scan_id,
  created_at: row.created_at.toISOString(),
  updated_at: row.updated_at.toISOString(),
});

const notFound = (): ChorusError => new ChorusError('not_found', 'Not found.');
const decided = (state: string, linkedItemId: Uuid | null): ChorusError =>
  new ChorusError('invalid_transition', 'This suggestion was already decided.', {
    details: { reason: 'suggestion_decided', state, linked_item_id: linkedItemId },
  });

// ---------------------------------------------------------------------------------------------------
// recordScan
// ---------------------------------------------------------------------------------------------------

export interface RecordScanArgs {
  readonly session_id: Uuid;
  readonly from_sequence: number;
  readonly to_sequence: number;
  readonly cutoff_sequence: number;
  /** The fetched window, to snapshot sources by `message_id`. Never persisted verbatim beyond the 32 KiB cap. */
  readonly messages: readonly SourceMessage[];
  readonly extracted: readonly ExtractedSuggestion[];
  /** CC-2: the coordination engine to run on this scan's in-window messages (spec §9); omitted = CC-1 only. */
  readonly coordination?: CoordinationEngine;
}

export type ScanRecorded = {
  readonly scan: {
    readonly id: Uuid;
    readonly from_sequence: number;
    readonly to_sequence: number;
    readonly cutoff_sequence: number;
    readonly messages_examined: number;
    readonly extractor: 'rules-v1';
  };
  readonly suggestions: readonly (Suggestion & { readonly is_new: boolean })[];
  /** CC-2 (spec §9): what the coordination engine did with this scan, when the tool wired one in. */
  readonly coordination?: CoordinationApplied;
};

/**
 * Records a scan and upserts its suggestions (CC-1 rev1.1 section 4; ordering per the split plan section 2.3).
 * One transaction, `noop: true`: the scan row is the record, and a suggestion's fingerprint identity means a
 * rescan never duplicates it. An existing suggestion has ONLY `last_scan_id`, `replied_by_other` and
 * `updated_at` touched — its `state` (and everything a decision set) never changes on a rescan.
 *
 * The idempotency key is the caller's own; the request hash covers only `{session_id, from_sequence,
 * to_sequence}` (not the fetched messages), so a replay with the same key returns the stored response even if
 * the room moved on (CC9).
 */
export async function recordScan(ctx: CommandContext, args: RecordScanArgs): Promise<ScanRecorded> {
  const bySourceId = new Map(args.messages.map((message) => [message.message_id, message]));

  return runCommand<ScanRecorded>(ctx, {
    type: 'conversation.scan',
    session: { id: args.session_id },
    input: {
      session_id: args.session_id,
      from_sequence: args.from_sequence,
      to_sequence: args.to_sequence,
    },
    authorize: (tx) => {
      requireAction(tx, 'link_message');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const session = requireSession(tx);
      const scan = await tx.db.query<{ id: Uuid; created_at: Date }>(
        `INSERT INTO conversation_scans
           (workspace_id, session_id, room_id, from_sequence, to_sequence, cutoff_sequence,
            messages_examined, extractor, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'rules-v1', $8)
         RETURNING id, created_at`,
        [
          tx.workspaceId,
          args.session_id,
          session.roomId,
          args.from_sequence,
          args.to_sequence,
          args.cutoff_sequence,
          args.messages.length,
          tx.actorId,
        ],
      );
      const scanRow = scan.rows[0];
      if (scanRow === undefined)
        throw new ChorusError('internal_error', 'The scan was not stored.');
      const scanId = scanRow.id;

      const suggestions: (Suggestion & { is_new: boolean })[] = [];
      for (const found of args.extracted) {
        const fingerprint = sha256Hex(`${args.session_id}|${found.fingerprint_input}`);
        const source = bySourceId.get(found.source.message_id);
        if (source === undefined) {
          throw new ChorusError(
            'internal_error',
            'A suggestion names a message outside the scan input.',
          );
        }
        const snapshot = truncateUtf8(source.content, SNAPSHOT_MAX_BYTES);
        const snapshotSha256 = sha256Hex(snapshot);

        // One statement: a two-step UPDATE-then-INSERT lets two concurrent scans of the same window both
        // miss the UPDATE and race the INSERT, so the loser hits the unique index as a raw 23505. The
        // DO UPDATE list is exactly last_scan_id/replied_by_other/updated_at: an existing suggestion's
        // identity and decision are never touched by a rescan. `xmax = 0` is true only for a tuple this
        // statement inserted (never true after an UPDATE), which is how `is_new` is told apart safely.
        const upserted = await tx.db.query<SuggestionRow & { is_new: boolean }>(
          `INSERT INTO conversation_suggestions
             (workspace_id, session_id, kind, fingerprint, excerpt, confidence, source_message_id,
              source_sequence, source_member_id, source_principal_id, source_name,
              source_content_snapshot, source_content_sha256, replied_by_other, suggested_next_action,
              first_scan_id, last_scan_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
           ON CONFLICT (workspace_id, session_id, fingerprint) DO UPDATE
             SET last_scan_id = EXCLUDED.last_scan_id, replied_by_other = EXCLUDED.replied_by_other,
                 updated_at = now()
           RETURNING ${COLUMNS}, (xmax = 0) AS is_new`,
          [
            tx.workspaceId,
            args.session_id,
            found.kind,
            fingerprint,
            found.excerpt,
            found.confidence,
            found.source.message_id,
            found.source.sequence,
            found.source.sender_member_id,
            found.source.sender_principal_id,
            found.source.sender_name,
            snapshot,
            snapshotSha256,
            found.replied_by_other,
            found.suggested_next_action,
            scanId,
          ],
        );
        const row = upserted.rows[0];
        if (row === undefined)
          throw new ChorusError('internal_error', 'The suggestion was not stored.');
        suggestions.push({ ...toSuggestion(row), is_new: row.is_new });
      }

      const coordination =
        args.coordination === undefined
          ? undefined
          : await applyScanToCoordination(
              tx.db,
              tx.workspaceId,
              args.session_id,
              tx.actorId,
              { from: args.from_sequence, to: args.to_sequence },
              args.messages,
              args.coordination,
            );

      return {
        result: {
          scan: {
            id: scanId,
            from_sequence: args.from_sequence,
            to_sequence: args.to_sequence,
            cutoff_sequence: args.cutoff_sequence,
            messages_examined: args.messages.length,
            extractor: 'rules-v1',
          },
          suggestions,
          ...(coordination === undefined ? {} : { coordination }),
        },
        events: [],
        noop: true,
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// listSuggestions (read-only)
// ---------------------------------------------------------------------------------------------------

export interface ListSuggestionsArgs {
  readonly session_id: Uuid;
  readonly states?: readonly ('open' | 'linked' | 'dismissed')[];
  readonly kinds?: readonly SuggestionKind[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListSuggestionsResult {
  readonly suggestions: readonly Suggestion[];
  readonly next_cursor: string | null;
}

interface Cursor {
  readonly sequence: number;
  readonly id: Uuid;
}

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      'sequence' in decoded &&
      'id' in decoded &&
      typeof (decoded as { sequence: unknown }).sequence === 'number' &&
      typeof (decoded as { id: unknown }).id === 'string'
    ) {
      return decoded as Cursor;
    }
  } catch {
    // fall through
  }
  throw new ChorusError('invalid_request', 'cursor is invalid.', { details: { field: 'cursor' } });
}

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

/** Lists the caller's own live session's suggestions; a non-member (or a missing session) gets `not_found`. */
export async function listSuggestions(
  read: ReadContext,
  args: ListSuggestionsArgs,
): Promise<ListSuggestionsResult> {
  const states = args.states ?? ['open'];
  const limit = Math.min(args.limit ?? 50, 50);
  const after = decodeCursor(args.cursor);

  return withReadTx(read, async (db) => {
    const roles = await db.query<{ roles: string[] | null }>(
      'SELECT chorus_session_roles($1) AS roles',
      [args.session_id],
    );
    if (roles.rows[0]?.roles === null || roles.rows[0]?.roles === undefined) {
      throw new ChorusError('not_found', 'Not found.');
    }
    const { rows } = await db.query<SuggestionRow>(
      `SELECT ${COLUMNS} FROM conversation_suggestions
        WHERE workspace_id = $1 AND session_id = $2
          AND state = ANY($3::text[])
          AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
          AND ($5::bigint IS NULL OR (source_sequence, id) < ($5::bigint, $6::uuid))
        ORDER BY source_sequence DESC, id DESC
        LIMIT $7`,
      [
        read.workspaceId,
        args.session_id,
        states,
        args.kinds ?? null,
        after?.sequence ?? null,
        after?.id ?? null,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page.at(-1) : undefined;
    return {
      suggestions: page.map(toSuggestion),
      next_cursor:
        next === undefined
          ? null
          : encodeCursor({ sequence: Number(next.source_sequence), id: next.id }),
    };
  });
}

/** Locks a suggestion FOR UPDATE and requires it to still be `open`; shared by link and dismiss. */
async function lockOpenSuggestion(
  tx: { db: Queryable; workspaceId: Uuid },
  sessionId: Uuid,
  suggestionId: Uuid,
): Promise<SuggestionRow> {
  const locked = await tx.db.query<SuggestionRow>(
    `SELECT ${COLUMNS} FROM conversation_suggestions
      WHERE workspace_id = $1 AND session_id = $2 AND id = $3 FOR UPDATE`,
    [tx.workspaceId, sessionId, suggestionId],
  );
  const row = locked.rows[0];
  if (row === undefined) throw notFound();
  if (row.state !== 'open') throw decided(row.state, row.linked_item_id);
  return row;
}

// ---------------------------------------------------------------------------------------------------
// linkSuggestion
// ---------------------------------------------------------------------------------------------------

export interface LinkSuggestionArgs {
  readonly session_id: Uuid;
  readonly suggestion_id: Uuid;
  readonly item_id: Uuid;
}

export type LinkSuggestionResult = {
  readonly suggestion: Suggestion;
  readonly item: { readonly id: Uuid; readonly version: number };
};

/**
 * Links a suggestion to an existing item in the same session (CC-1 rev1.1 section 4). Not `open` →
 * `invalid_transition` (`suggestion_decided`); an item outside the session, or missing, → `not_found` (the
 * item is a locked target, so the visibility rule is the same one every other command uses). On success: the
 * suggestion becomes `linked`, the source snapshot is copied into `message_links` (so the item keeps
 * provenance through claim/result/review), and the item's version bumps with a `task.source_linked` event.
 */
export async function linkSuggestion(
  ctx: CommandContext,
  args: LinkSuggestionArgs,
): Promise<LinkSuggestionResult> {
  return runCommand<LinkSuggestionResult>(ctx, {
    type: 'conversation.link',
    session: { id: args.session_id },
    input: { suggestion_id: args.suggestion_id, item_id: args.item_id },
    targets: [{ id: args.item_id, lockOnly: true }],
    authorize: (tx) => {
      requireAction(tx, 'link_message');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const item = tx.items.get(args.item_id);
      if (item === undefined) throw notFound();
      const row = await lockOpenSuggestion(tx, args.session_id, args.suggestion_id);

      const version = await tx.bumpVersion(args.item_id);
      await tx.db.query(
        `INSERT INTO message_links
           (workspace_id, session_id, item_id, sharednet_message_id, sharednet_sequence, sender_principal_id,
            sender_member_id, content_snapshot, content_sha256, linked_by)
         SELECT $1, $2, $3, source_message_id, source_sequence, source_principal_id, source_member_id,
                source_content_snapshot, source_content_sha256, $4
           FROM conversation_suggestions WHERE workspace_id = $1 AND id = $5
         ON CONFLICT DO NOTHING`,
        [tx.workspaceId, args.session_id, args.item_id, tx.actorId, args.suggestion_id],
      );
      const linked = await tx.db.query<SuggestionRow>(
        `UPDATE conversation_suggestions
            SET state = 'linked', linked_item_id = $4, decided_by = $5, decided_at = now(), updated_at = now()
          WHERE workspace_id = $1 AND session_id = $2 AND id = $3
          RETURNING ${COLUMNS}`,
        [tx.workspaceId, args.session_id, args.suggestion_id, args.item_id, tx.actorId],
      );
      const updatedRow = linked.rows[0];
      if (updatedRow === undefined)
        throw new ChorusError('internal_error', 'The link was not stored.');
      await syncObjectFromSuggestion(
        tx.db,
        tx.workspaceId,
        args.session_id,
        args.suggestion_id,
        tx.actorId,
        {
          linkedItemId: args.item_id,
        },
      );

      const event: DomainEventDraft = {
        roomId: item.homeRoomId,
        aggregateId: args.item_id,
        aggregateVersion: version,
        eventType: 'task.source_linked',
        payload: { suggestion_id: args.suggestion_id, message_id: row.source_message_id },
      };
      return {
        result: { suggestion: toSuggestion(updatedRow), item: { id: args.item_id, version } },
        events: [event],
      };
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// dismissSuggestion
// ---------------------------------------------------------------------------------------------------

export interface DismissSuggestionArgs {
  readonly session_id: Uuid;
  readonly suggestion_id: Uuid;
  readonly reason?: string | undefined;
}

export type DismissSuggestionResult = {
  readonly suggestion: Suggestion;
};

/** Dismisses an open suggestion; not `open` → `invalid_transition` (`suggestion_decided`), same as linking. */
export async function dismissSuggestion(
  ctx: CommandContext,
  args: DismissSuggestionArgs,
): Promise<DismissSuggestionResult> {
  return runCommand<DismissSuggestionResult>(ctx, {
    type: 'conversation.dismiss',
    session: { id: args.session_id },
    input: { suggestion_id: args.suggestion_id, reason: args.reason ?? null },
    authorize: (tx) => {
      requireAction(tx, 'link_message');
      return Promise.resolve();
    },
    handle: async (tx) => {
      await lockOpenSuggestion(tx, args.session_id, args.suggestion_id);

      const dismissed = await tx.db.query<SuggestionRow>(
        `UPDATE conversation_suggestions
            SET state = 'dismissed', decided_by = $4, decided_at = now(), dismiss_reason = $5,
                updated_at = now()
          WHERE workspace_id = $1 AND session_id = $2 AND id = $3
          RETURNING ${COLUMNS}`,
        [tx.workspaceId, args.session_id, args.suggestion_id, tx.actorId, args.reason ?? null],
      );
      const updatedRow = dismissed.rows[0];
      if (updatedRow === undefined)
        throw new ChorusError('internal_error', 'The dismissal was not stored.');
      await syncObjectFromSuggestion(
        tx.db,
        tx.workspaceId,
        args.session_id,
        args.suggestion_id,
        tx.actorId,
        {
          dismiss: true,
        },
      );
      return { result: { suggestion: toSuggestion(updatedRow) }, events: [], noop: true };
    },
  });
}
