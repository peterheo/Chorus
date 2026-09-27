import { withReadTx, type ReadContext } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';

/**
 * The service seat the fetch layer needs to read a session's bound room (CC-1 rev1.1 section 2.2, frozen
 * interface). The token stays sealed here; the caller decrypts it in memory with `openSecret`, exactly like
 * `createLedgerFor` in `apps/api/src/arena/payments.ts`.
 */
export interface ConversationSeat {
  readonly externalRoomId: string;
  readonly memberId: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyId: string;
}

interface SeatRow {
  external_room_id: string;
  member_id: string;
  token_ciphertext: Buffer;
  token_nonce: Buffer;
  key_id: string;
}

/**
 * Loads the seat of the session's bound room, but only for a live member of that session (chorus_my_sessions(),
 * which already implies a live, active-room membership). No row is indistinguishable from an invisible
 * session: both are `not_found`, so the caller learns nothing about a session it cannot see.
 */
export async function loadConversationSeat(
  read: ReadContext,
  sessionId: Uuid,
): Promise<ConversationSeat> {
  const seat = await withReadTx(read, async (db) => {
    const { rows } = await db.query<SeatRow>('SELECT * FROM chorus_conversation_seat($1)', [
      sessionId,
    ]);
    return rows[0];
  });
  if (seat === undefined) throw new ChorusError('not_found', 'Not found.');
  return {
    externalRoomId: seat.external_room_id,
    memberId: seat.member_id,
    ciphertext: seat.token_ciphertext,
    nonce: seat.token_nonce,
    keyId: seat.key_id,
  };
}
