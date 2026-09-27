import type { AccessContext, CapabilityGrant, GrantSource } from '@aicoo/sharedos';
import type pg from 'pg';
import {
  ROLE_ACTIONS,
  ROOM_ACTIONS,
  withReadTx,
  type SessionAction,
  type SessionRole,
  type Uuid,
} from '@chorus/domain';
import { CHORUS_PURPOSE, CHORUS_SERVICE } from './access-context.ts';

/** How far behind `now` a grant is issued, so a fresh membership is usable immediately (K5). */
const BACKDATE_MS = 60_000;

interface SessionRow {
  session_id: Uuid;
  roles: SessionRole[];
  version: number;
  joined_at: Date;
}

const actionsOfRoles = (roles: readonly SessionRole[]): SessionAction[] => [
  ...new Set(roles.flatMap((r) => ROLE_ACTIONS[r])),
];

/**
 * Chorus's authority source: room and session membership, read from the database as the caller. Nothing
 * here trusts the request; a context that is not a Chorus-service/agent one gets no grants (fail closed).
 * Errors propagate so the kernel denies as `authority_unavailable`.
 */
export function createChorusGrantSource(pool: pg.Pool): GrantSource {
  return {
    async load(context: AccessContext): Promise<readonly CapabilityGrant[]> {
      if (
        context.authority.kind !== 'service' ||
        context.authority.serviceId !== CHORUS_SERVICE.serviceId ||
        context.actor.kind !== 'agent' ||
        context.owner.kind !== 'group'
      ) {
        return [];
      }
      const workspaceId = context.namespaceId as Uuid;
      const actorId = context.actor.agentId as Uuid;
      const roomId = context.owner.conversationId as Uuid;
      const now = Date.parse(context.now);

      const { room, sessions } = await withReadTx({ pool, workspaceId, actorId }, async (db) => {
        const roomRows = await db.query<{ verified_at: Date }>(
          `SELECT m.first_verified_at AS verified_at
             FROM room_members m JOIN rooms r ON r.workspace_id = m.workspace_id AND r.id = m.room_id
            WHERE m.workspace_id = $1 AND m.room_id = $2 AND m.actor_id = $3
              AND m.removed_at IS NULL AND r.activation_state = 'active'`,
          [workspaceId, roomId, actorId],
        );
        const sessionRows = await db.query<SessionRow>(
          `SELECT m.session_id, m.roles, m.version, m.joined_at
             FROM session_members m JOIN sessions s
               ON s.workspace_id = m.workspace_id AND s.id = m.session_id
            WHERE m.workspace_id = $1 AND m.actor_id = $2 AND s.room_id = $3 AND s.state = 'active'
              AND m.removed_at IS NULL AND m.session_id IN (SELECT chorus_my_sessions())
            ORDER BY m.session_id`,
          [workspaceId, actorId, roomId],
        );
        return { room: roomRows.rows[0], sessions: sessionRows.rows };
      });
      // Not a live member of the active room: no authority at all.
      if (room === undefined) return [];

      const issuedAt = (rowTime: Date): string =>
        new Date(Math.min(rowTime.getTime(), now - BACKDATE_MS)).toISOString();
      const base = {
        namespaceId: context.namespaceId,
        subject: context.actor,
        issuer: CHORUS_SERVICE,
        constraints: { purposes: [CHORUS_PURPOSE] },
      };
      const grants: CapabilityGrant[] = [
        {
          ...base,
          id: `room:${roomId}:${actorId}`,
          capabilities: [
            {
              resource: { namespace: 'chorus', path: ['room'] },
              actions: [...ROOM_ACTIONS],
              scope: 'exact',
            },
          ],
          issuedAt: issuedAt(room.verified_at),
        },
      ];
      for (const s of sessions) {
        grants.push({
          ...base,
          id: `session:${s.session_id}:${actorId}:v${String(s.version)}`,
          capabilities: [
            {
              resource: { namespace: 'chorus', path: ['sessions', s.session_id] },
              actions: actionsOfRoles(s.roles),
              scope: 'descendants',
            },
          ],
          issuedAt: issuedAt(s.joined_at),
        });
      }
      // Discovery: lets the kernel list every tool the caller could use somewhere in this room.
      const maxVersion = sessions.reduce((max, s) => Math.max(max, s.version), 0);
      const everySessionAction = new Set(sessions.flatMap((s) => actionsOfRoles(s.roles)));
      grants.push({
        ...base,
        id: `discover:${roomId}:${actorId}:v${String(maxVersion)}`,
        capabilities: [
          {
            resource: { namespace: 'chorus', path: [] },
            actions: [...new Set<string>([...ROOM_ACTIONS, ...everySessionAction])],
            scope: 'exact',
          },
        ],
        issuedAt: issuedAt(room.verified_at),
      });
      return grants;
    },
  };
}
