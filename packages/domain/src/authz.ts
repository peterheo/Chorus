import type pg from 'pg';
import { ChorusError } from './errors.ts';
import type { SessionRole } from './command.ts';

/** Anything with a parameterized `query`: a pooled client inside a transaction. */
export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * The session action matrix (WP3 rev 4 section 2.1 / SharedOS grant mapping section 7). Roles are
 * session-scoped and combinable; `participant` is implied for every member. This table says what a ROLE
 * may do; item-relative identities (owner, assigned reviewer, separation, intervention) are enforced
 * separately by the domain because they come from state, not roles.
 */
export type SessionAction =
  | 'read'
  | 'create_item'
  | 'comment'
  | 'propose'
  | 'claim'
  | 'request_assignment'
  | 'renew_lease'
  | 'release'
  | 'block'
  | 'submit_result'
  | 'request_review'
  | 'review'
  | 'leave'
  | 'link_message'
  | 'share_evidence'
  | 'assign'
  | 'decide_claim'
  | 'intervene'
  | 'edit'
  | 'revise_criteria'
  | 'complete'
  | 'cancel'
  | 'reopen'
  | 'resolve_proposal'
  | 'create_board'
  | 'administer';

/** Room-level actions of a verified room member (SharedOS grant mapping); they need no session membership. */
export type RoomAction = 'read_sessions' | 'create_session' | 'join_session';

export const ROOM_ACTIONS: readonly RoomAction[] = [
  'read_sessions',
  'create_session',
  'join_session',
];

export const ROLE_ACTIONS: Readonly<Record<SessionRole, readonly SessionAction[]>> = {
  participant: [
    'read',
    'create_item',
    'comment',
    'propose',
    'claim',
    'request_assignment',
    'renew_lease',
    'release',
    'block',
    'submit_result',
    'request_review',
    'review',
    'leave',
    'link_message',
    'share_evidence',
  ],
  manager: [
    'assign',
    'decide_claim',
    'intervene',
    'edit',
    'revise_criteria',
    'complete',
    'cancel',
    'reopen',
    'resolve_proposal',
    'create_board',
  ],
  administrator: ['administer'],
};

export function actionsOf(roles: readonly SessionRole[]): Set<SessionAction> {
  return new Set(roles.flatMap((role) => ROLE_ACTIONS[role]));
}

export function hasAction(roles: readonly SessionRole[], action: SessionAction): boolean {
  return actionsOf(roles).has(action);
}

/** Role-level check: 403 when none of the caller's session roles carries `action`. */
export function requireAction(
  tx: { readonly roles: readonly SessionRole[] },
  action: SessionAction,
): void {
  if (!hasAction(tx.roles, action)) {
    throw new ChorusError('action_forbidden', 'Your session roles do not permit this action.', {
      details: { reason: 'role', action },
    });
  }
}
