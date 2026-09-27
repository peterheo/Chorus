import { withReadTx, type ReadContext } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import { requireUuid } from '../validation.ts';
import type { SuggestionKind } from './extract.ts';

/**
 * `conversationDigest` (CC-1 rev1.1 section 4; frozen for S1-5's `room_pulse` amendment, A-S1.5-1). Read-only,
 * one entry per live session (or the one named), mirroring `roomPulse`'s own session-filter shape so both can
 * sit side by side in one tool response.
 */

export interface ConversationDigestSource {
  readonly message_id: string;
  readonly sequence: number;
  readonly sender_name: string;
}

export interface ConversationDigestTopSuggestion {
  readonly suggestion_id: Uuid;
  readonly kind: SuggestionKind;
  readonly excerpt: string;
  readonly confidence: 'high' | 'medium';
  readonly source: ConversationDigestSource;
}

export interface ConversationDigestLastScan {
  readonly scan_id: Uuid;
  readonly from_sequence: number;
  readonly to_sequence: number;
  readonly cutoff_sequence: number;
  readonly created_at: string;
}

export interface ConversationDigestEntry {
  readonly session_id: Uuid;
  readonly open_questions: number;
  readonly open_commitments: number;
  readonly last_scan: ConversationDigestLastScan | null;
  /** Up to 5 open suggestions, newest first. */
  readonly top: readonly ConversationDigestTopSuggestion[];
}

const MAX_TOP = 5;

function invalidSessionId(error: unknown): never {
  if (error instanceof ChorusError && error.code === 'invalid_request') {
    throw new ChorusError('invalid_request', error.message, { details: { field: 'session_id' } });
  }
  throw error;
}

export async function conversationDigest(
  read: ReadContext,
  input: { readonly session_id?: Uuid },
): Promise<readonly ConversationDigestEntry[]> {
  let sessionFilter: Uuid | undefined;
  if (input.session_id !== undefined) {
    try {
      sessionFilter = requireUuid(input.session_id, 'session_id');
    } catch (error) {
      invalidSessionId(error);
    }
  }

  return withReadTx(read, async (db) => {
    const { rows: sessions } = await db.query<{ id: Uuid }>(
      `SELECT s.id FROM sessions s
        WHERE s.workspace_id = $1
          AND s.id IN (SELECT chorus_my_sessions())
          AND ($2::uuid IS NULL OR s.id = $2)
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT 50`,
      [read.workspaceId, sessionFilter ?? null],
    );
    if (sessionFilter !== undefined && sessions.length === 0) {
      throw new ChorusError('not_found', 'Not found.');
    }
    if (sessions.length === 0) return [];

    const sessionIds = sessions.map((session) => session.id);
    const { rows: counts } = await db.query<{
      session_id: Uuid;
      open_questions: string;
      open_commitments: string;
    }>(
      `SELECT s.id AS session_id,
          (SELECT count(*) FROM conversation_suggestions c
            WHERE c.workspace_id = $1 AND c.session_id = s.id AND c.state = 'open'
              AND c.kind = 'question') AS open_questions,
          (SELECT count(*) FROM conversation_suggestions c
            WHERE c.workspace_id = $1 AND c.session_id = s.id AND c.state = 'open'
              AND c.kind = 'commitment') AS open_commitments
         FROM unnest($2::uuid[]) s(id)`,
      [read.workspaceId, sessionIds],
    );
    const { rows: scans } = await db.query<{
      session_id: Uuid;
      id: Uuid;
      from_sequence: string;
      to_sequence: string;
      cutoff_sequence: string;
      created_at: Date;
    }>(
      `SELECT DISTINCT ON (session_id) session_id, id, from_sequence, to_sequence, cutoff_sequence, created_at
         FROM conversation_scans
        WHERE workspace_id = $1 AND session_id = ANY($2::uuid[])
        ORDER BY session_id, created_at DESC, id DESC`,
      [read.workspaceId, sessionIds],
    );
    const { rows: top } = await db.query<{
      session_id: Uuid;
      id: Uuid;
      kind: SuggestionKind;
      excerpt: string;
      confidence: 'high' | 'medium';
      source_message_id: string;
      source_sequence: string;
      source_name: string;
    }>(
      `SELECT session_id, id, kind, excerpt, confidence, source_message_id, source_sequence, source_name
         FROM (
           SELECT c.*,
                  row_number() OVER (PARTITION BY c.session_id ORDER BY c.source_sequence DESC, c.id DESC) AS rn
             FROM conversation_suggestions c
            WHERE c.workspace_id = $1 AND c.session_id = ANY($2::uuid[]) AND c.state = 'open'
         ) ranked
        WHERE rn <= $3
        ORDER BY session_id, source_sequence DESC, id DESC`,
      [read.workspaceId, sessionIds, MAX_TOP],
    );

    const countsBySession = new Map(counts.map((row) => [row.session_id, row]));
    const scanBySession = new Map(scans.map((row) => [row.session_id, row]));
    const topBySession = new Map<Uuid, ConversationDigestTopSuggestion[]>();
    for (const row of top) {
      const list = topBySession.get(row.session_id) ?? [];
      list.push({
        suggestion_id: row.id,
        kind: row.kind,
        excerpt: row.excerpt,
        confidence: row.confidence,
        source: {
          message_id: row.source_message_id,
          sequence: Number(row.source_sequence),
          sender_name: row.source_name,
        },
      });
      topBySession.set(row.session_id, list);
    }

    return sessionIds.map((sessionId): ConversationDigestEntry => {
      const count = countsBySession.get(sessionId);
      const scan = scanBySession.get(sessionId);
      return {
        session_id: sessionId,
        open_questions: Number(count?.open_questions ?? 0),
        open_commitments: Number(count?.open_commitments ?? 0),
        last_scan:
          scan === undefined
            ? null
            : {
                scan_id: scan.id,
                from_sequence: Number(scan.from_sequence),
                to_sequence: Number(scan.to_sequence),
                cutoff_sequence: Number(scan.cutoff_sequence),
                created_at: scan.created_at.toISOString(),
              },
        top: topBySession.get(sessionId) ?? [],
      };
    });
  });
}
