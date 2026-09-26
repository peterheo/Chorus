import { ChorusError } from './errors.ts';

/**
 * Task lifecycle (RC-WP2 spec section 7, states per WP3 rev 4). Pure, so the whole matrix is unit-testable.
 * `cancelled` exists in the schema but no P1 command produces it (cancel/reopen arrive in P3).
 */
export const TASK_STATES = ['ready', 'in_progress', 'review', 'done', 'cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const REVIEW_STATES = ['requested', 'approved', 'changes_requested', 'cancelled'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export type TaskCommand = 'claim' | 'renew_lease' | 'submit_result' | 'request_review' | 'complete';

/** Source states from which each command is allowed to start. */
export const TASK_SOURCE_STATES: Readonly<Record<TaskCommand, readonly TaskState[]>> = {
  claim: ['ready', 'in_progress', 'review'],
  renew_lease: ['in_progress'],
  submit_result: ['in_progress'],
  request_review: ['review'],
  complete: ['review'],
};

/** The task state each command leaves the task in. */
export const TASK_TARGET_STATE: Readonly<Record<TaskCommand, TaskState>> = {
  claim: 'in_progress',
  renew_lease: 'in_progress',
  submit_result: 'review',
  request_review: 'review',
  complete: 'done',
};

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

/** Throws `422 invalid_transition` unless `command` may start from `state`. */
export function assertTaskTransition(command: TaskCommand, state: string): void {
  if (isTaskState(state) && TASK_SOURCE_STATES[command].includes(state)) return;
  const reason = command === 'claim' && state === 'done' ? 'terminal' : 'invalid_state';
  throw new ChorusError('invalid_transition', `A task in state "${state}" cannot ${command}.`, {
    details: { reason, state, command },
  });
}

/** A review accepts a verdict only while `requested`; both verdicts are final. */
export function assertReviewAcceptsVerdict(state: string): void {
  if (state === 'requested') return;
  throw new ChorusError(
    'invalid_transition',
    `A review in state "${state}" already has a verdict.`,
    {
      details: { reason: 'verdict_final', state },
    },
  );
}
