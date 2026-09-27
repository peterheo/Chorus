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
  setCoordinationMode,
} from '@chorus/domain';
import { B, I, S, SA, type ChorusToolSpec } from './define.ts';

const session = (a: Record<string, unknown>): string[] => ['sessions', a['session_id'] as string];

const POLICY = {
  name: S,
  discoverable: B,
  join_policy: S,
  listed_principals: SA,
  policy_agent_ids: SA,
  default_claim_policy: S,
  manager_review_allowed: B,
  default_review_required: B,
  // CC-2 (spec §9/§10): 'off' | 'observe' | 'assist'. Off by default; the domain enforces the enum.
  coordination_mode: S,
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
      "Changes a session policy (name, discoverability, join and claim policy, review settings, coordination mode) at the session version you expect. Requires the administrator role. coordination_mode is 'off' (default), 'observe' (Chorus reads every new room message into the inferred coordination state) or 'assist' (also posts a few rate-limited coordination notes built only from room content). When paid services are enabled, only 'off' is accepted here; turn a mode on with chorus.set_coordination_mode.",
    action: 'administer',
    write: true,
    props: { session_id: S, expected_version: I, ...POLICY },
    required: ['session_id', 'expected_version'],
    path: session,
    run: ({ command, input, deps }) => {
      // With billing on, turning coordination on is a purchase: it goes through the paid tool, never here.
      const mode = input['coordination_mode'];
      if (deps.billing === 'enabled' && (mode === 'observe' || mode === 'assist')) {
        throw new ChorusError(
          'invalid_request',
          `coordination_mode '${mode}' is a paid service: use chorus.set_coordination_mode to turn it on. This tool accepts only 'off'.`,
          {
            details: {
              field: 'coordination_mode',
              reason: 'paid_mode',
              use_tool: 'chorus.set_coordination_mode',
            },
          },
        );
      }
      return setSessionPolicy(command, input);
    },
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
    run: ({ command, input }) => setCoordinationMode(command, input),
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
