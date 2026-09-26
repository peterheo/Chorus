import { describe, expect, it } from 'vitest';
import { isChorusError } from '../../src/errors.ts';
import {
  TASK_SOURCE_STATES,
  TASK_STATES,
  TASK_TARGET_STATE,
  assertReviewAcceptsVerdict,
  assertTaskTransition,
  type TaskCommand,
} from '../../src/transitions.ts';

const COMMANDS: TaskCommand[] = [
  'claim',
  'renew_lease',
  'submit_result',
  'request_review',
  'complete',
];

describe('lifecycle.transitions.matrix (unit)', () => {
  it('allows exactly the spec section 7 source states', () => {
    expect(TASK_SOURCE_STATES).toEqual({
      claim: ['ready', 'in_progress', 'review'],
      renew_lease: ['in_progress'],
      submit_result: ['in_progress'],
      request_review: ['review'],
      complete: ['review'],
    });
    expect(TASK_TARGET_STATE).toEqual({
      claim: 'in_progress',
      renew_lease: 'in_progress',
      submit_result: 'review',
      request_review: 'review',
      complete: 'done',
    });
  });

  for (const command of COMMANDS) {
    for (const state of TASK_STATES) {
      const allowed = TASK_SOURCE_STATES[command].includes(state);
      it(`${command} from ${state} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        if (allowed) {
          expect(() => {
            assertTaskTransition(command, state);
          }).not.toThrow();
          return;
        }
        try {
          assertTaskTransition(command, state);
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(isChorusError(error, 'invalid_transition')).toBe(true);
          const details = (error as { details: Record<string, unknown> }).details;
          expect(details['reason']).toBe(
            command === 'claim' && state === 'done' ? 'terminal' : 'invalid_state',
          );
          expect(details['state']).toBe(state);
        }
      });
    }
  }

  it('rejects unknown states', () => {
    expect(() => {
      assertTaskTransition('claim', 'archived');
    }).toThrow(/cannot claim/);
  });

  it('accepts a verdict only while requested; both verdicts are final', () => {
    expect(() => {
      assertReviewAcceptsVerdict('requested');
    }).not.toThrow();
    for (const state of ['approved', 'changes_requested', 'cancelled', 'in_review']) {
      try {
        assertReviewAcceptsVerdict(state);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(isChorusError(error, 'invalid_transition')).toBe(true);
        expect((error as { details: Record<string, unknown> }).details['reason']).toBe(
          'verdict_final',
        );
      }
    }
  });
});
