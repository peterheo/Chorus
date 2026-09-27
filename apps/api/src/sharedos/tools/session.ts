import {
  ChorusError,
  createBoard,
  getSession,
  grantRole,
  leaveSession,
  listBoards,
  listMembers,
  removeMember,
  revokeRole,
  setSessionPolicy,
  withReadTx,
} from '@chorus/domain';
import { B, I, S, SA, type ChorusToolSpec } from './define.ts';

const session = (a: Record<string, unknown>): string[] => ['sessions', a['session_id'] as string];

async function setCoordinationMode({ read, command, input }: Parameters<ChorusToolSpec['run']>[0]) {
  const sessionId = input['session_id'] as string;
  const mode = input['mode'] as string;
  let coordinationCursor: number | undefined;
  if (mode === 'observe' || mode === 'assist') {
    coordinationCursor = await withReadTx(read, async (db) => {
      const { rows } = await db.query<{ last_sequence: string | null }>(
        `SELECT watcher.last_sequence
           FROM public.sessions s
           LEFT JOIN public.chorus_watcher_rooms() watcher
             ON watcher.workspace_id = s.workspace_id AND watcher.room_id = s.room_id
          WHERE s.workspace_id = $1 AND s.id = $2`,
        [read.workspaceId, sessionId],
      );
      if (rows.length === 0) throw new ChorusError('not_found', 'Not found.');
      const cursor = Number(rows[0]?.last_sequence ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new ChorusError('internal_error', 'The room cursor is invalid.');
      }
      return cursor;
    });
  }
  return setSessionPolicy(
    command,
    {
      session_id: sessionId,
      expected_version: input['expected_version'],
      coordination_mode: mode,
    },
    coordinationCursor === undefined ? {} : { coordinationCursor },
  );
}

const POLICY = {
  name: S,
  discoverable: B,
  join_policy: S,
  listed_principals: SA,
  policy_agent_ids: SA,
  default_claim_policy: S,
  manager_review_allowed: B,
  default_review_required: B,
};

export const sessionTools: readonly ChorusToolSpec[] = [
  {
    name: 'chorus.get_session',
    description:
      'Returns one session you belong to: its policy, version and your roles. It does not change anything.',
    action: 'read',
    write: false,
    props: { session_id: S },
    required: ['session_id'],
    path: session,
    run: ({ read, input }) => getSession(read, input),
  },
  {
    name: 'chorus.list_members',
    description: 'Lists the live members of a session you belong to, with their roles.',
    action: 'read',
    write: false,
    props: { session_id: S },
    required: ['session_id'],
    path: session,
    run: ({ read, input }) => listMembers(read, input),
  },
  {
    name: 'chorus.list_boards',
    description: 'Lists the boards of a session you belong to.',
    action: 'read',
    write: false,
    props: { session_id: S },
    required: ['session_id'],
    path: session,
    run: ({ read, input }) => listBoards(read, input),
  },
  {
    name: 'chorus.create_board',
    description:
      'Adds a board to a session. Requires the manager role; it does not move existing work.',
    action: 'create_board',
    write: true,
    props: { session_id: S, name: S },
    required: ['session_id', 'name'],
    path: session,
    run: ({ command, input }) => createBoard(command, input),
  },
  {
    name: 'chorus.grant_role',
    description:
      'Grants the manager or administrator role to a live member of a session. Requires the administrator role; granting a role the member already holds changes nothing.',
    action: 'administer',
    write: true,
    props: { session_id: S, actor_id: S, role: S },
    required: ['session_id', 'actor_id', 'role'],
    path: session,
    run: ({ command, input }) => grantRole(command, input),
  },
  {
    name: 'chorus.revoke_role',
    description:
      'Revokes the manager or administrator role from a live member. Requires the administrator role; the last administrator cannot be revoked.',
    action: 'administer',
    write: true,
    props: { session_id: S, actor_id: S, role: S },
    required: ['session_id', 'actor_id', 'role'],
    path: session,
    run: ({ command, input }) => revokeRole(command, input),
  },
  {
    name: 'chorus.set_session_policy',
    description:
      'Changes a session policy (name, discoverability, join and claim policy, review settings) at the session version you expect. Requires the administrator role.',
    action: 'administer',
    write: true,
    props: { session_id: S, expected_version: I, ...POLICY },
    required: ['session_id', 'expected_version'],
    path: session,
    run: ({ command, input }) => setSessionPolicy(command, input),
  },
  {
    name: 'chorus.set_coordination_mode',
    description:
      'Sets a session’s room-message coordination mode. Requires an administrator and the latest session version.',
    action: 'administer',
    write: true,
    props: { session_id: S, mode: S, expected_version: I },
    required: ['session_id', 'mode', 'expected_version'],
    path: session,
    run: setCoordinationMode,
  },
  {
    name: 'chorus.remove_member',
    description:
      'Removes a member from a session, cancelling their requested reviews and clearing their task leases. Requires the administrator role; the last administrator cannot be removed.',
    action: 'administer',
    write: true,
    props: { session_id: S, actor_id: S },
    required: ['session_id', 'actor_id'],
    path: session,
    run: ({ command, input }) => removeMember(command, input),
  },
  {
    name: 'chorus.leave_session',
    description:
      'Leaves a session, cancelling your requested reviews and clearing your task leases. The last administrator cannot leave.',
    action: 'leave',
    write: true,
    props: { session_id: S },
    required: ['session_id'],
    path: session,
    run: ({ command, input }) => leaveSession(command, input),
  },
];
