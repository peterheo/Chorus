import type pg from 'pg';
import { ChorusError } from './errors.ts';
import type { Uuid } from './ids.ts';

export type RoomRole = 'executor' | 'reviewer' | 'manager';

/** Anything with a parameterized `query`: a pooled client inside a transaction. */
export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Authorizes against the CURRENT live grants, read inside the command transaction. Returns the
 * actor's live roles in the room.
 *
 * - No live grant of any role: the room is not visible, so `not_found` (also for another workspace's
 *   room or one that does not exist). Callers must not distinguish these cases.
 * - Visible but none of `allowed`: `action_forbidden`.
 */
export async function requireRoomRole(
  db: Queryable,
  args: {
    workspaceId: Uuid;
    actorId: Uuid;
    roomId: Uuid;
    allowed: readonly RoomRole[];
  },
): Promise<RoomRole[]> {
  const { rows } = await db.query<{ role: RoomRole }>(
    `SELECT role FROM room_grants
      WHERE workspace_id = $1 AND actor_id = $2 AND room_id = $3 AND revoked_at IS NULL`,
    [args.workspaceId, args.actorId, args.roomId],
  );
  const roles = rows.map((r) => r.role);
  if (roles.length === 0) throw new ChorusError('not_found', 'Not found.');
  if (!roles.some((role) => args.allowed.includes(role))) {
    throw new ChorusError('action_forbidden', 'This action is not permitted in this room.', {
      details: { required_any_of: [...args.allowed] },
    });
  }
  return roles;
}
