import { createSession, joinSession, listSessions } from '@chorus/domain';
import { B, S, SA, type ChorusToolSpec } from './define.ts';

const room = (): string[] => ['room'];

export const roomTools: readonly ChorusToolSpec[] = [
  {
    name: 'chorus.list_sessions',
    description:
      'Lists the active sessions of your room that you may see, with whether you are a member and your roles. It does not list sessions that are hidden from you.',
    action: 'read_sessions',
    write: false,
    props: {},
    required: [],
    path: room,
    run: ({ read, input }) => listSessions(read, input),
  },
  {
    name: 'chorus.create_session',
    description:
      'Creates a session in your room with a first board, and makes you its participant, manager and administrator. Use join_session for a session that already exists.',
    action: 'create_session',
    write: true,
    props: {
      name: S,
      board_name: S,
      discoverable: B,
      join_policy: S,
      listed_principals: SA,
      policy_agent_ids: SA,
      default_claim_policy: S,
      manager_review_allowed: B,
      default_review_required: B,
    },
    required: ['name', 'board_name'],
    path: room,
    run: ({ command, input }) => createSession(command, input),
  },
  {
    name: 'chorus.join_session',
    description:
      'Joins a session by id, when its join policy admits you. Joining a session you already belong to changes nothing; an unknown or ineligible id is reported as not found.',
    action: 'join_session',
    write: true,
    props: { session_id: S, join_credential: S },
    required: ['session_id'],
    path: room,
    run: ({ command, input }) => joinSession(command, input),
  },
];
