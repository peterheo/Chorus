import { createHash } from 'node:crypto';
import { canonicalJson, type JsonValue } from '../command.ts';
import type { Uuid } from '../ids.ts';

export type ArenaService = 'create_action_board' | 'create_tasks' | 'set_coordination_mode';

export interface FingerprintParts {
  readonly service: ArenaService;
  readonly workspaceId: Uuid;
  readonly roomId: Uuid;
  readonly sessionId: Uuid | null;
  readonly boardId: Uuid | null;
  readonly actorId: Uuid;
  readonly requesterMemberId: string;
  /** The service input WITHOUT `request_id` and `payment_txn_id`. */
  readonly input: JsonValue;
}

/**
 * What a purchase is FOR: the service, who asked, where, and exactly what. Two calls with the same
 * request_id but a different fingerprint are a `request_conflict`; the payment memo binds to the purchase
 * row that stores this.
 */
export function purchaseFingerprint(parts: FingerprintParts): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        service: parts.service,
        workspace_id: parts.workspaceId,
        room_id: parts.roomId,
        session_id: parts.sessionId,
        board_id: parts.boardId,
        actor_id: parts.actorId,
        requester_member_id: parts.requesterMemberId,
        input: parts.input,
      }),
      'utf8',
    )
    .digest('hex');
}

/** The canonical payment memo (exact match, no substring): `chorus:v1:<service>:<purchase_id>`. */
export const purchaseMemo = (service: ArenaService, purchaseId: string): string =>
  `chorus:v1:${service}:${purchaseId}`;
