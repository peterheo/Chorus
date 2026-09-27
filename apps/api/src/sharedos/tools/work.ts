import {
  claim,
  completeTask,
  createTask,
  getResult,
  getTask,
  listMyReviews,
  listWork,
  renewLease,
  requestReview,
  reviewVerdict,
  submitResult,
} from '@chorus/domain';
import { B, I, OA, S, SA, type ChorusToolSpec } from './define.ts';

const session = (a: Record<string, unknown>): string[] => ['sessions', a['session_id'] as string];
const task = (a: Record<string, unknown>): string[] => [
  'sessions',
  a['session_id'] as string,
  'tasks',
  a['task_id'] as string,
];
const review = (a: Record<string, unknown>): string[] => [
  'sessions',
  a['session_id'] as string,
  'reviews',
  a['review_id'] as string,
];

const VERSIONED = { session_id: S, task_id: S, expected_version: I };

export const workTools: readonly ChorusToolSpec[] = [
  {
    name: 'chorus.list_work',
    description:
      'Lists tasks in a session you belong to, optionally filtered by board, state, owner or blocked flag, newest first with a cursor.',
    action: 'read',
    write: false,
    props: {
      session_id: S,
      board_id: S,
      states: SA,
      owner: S,
      blocked: B,
      limit: I,
      cursor: S,
    },
    required: ['session_id'],
    path: session,
    run: ({ read, input }) => listWork(read, input),
  },
  {
    name: 'chorus.get_task',
    description:
      'Returns one task with its state, version, criteria, lease and result and review summaries.',
    action: 'read',
    write: false,
    props: { session_id: S, task_id: S },
    required: ['session_id', 'task_id'],
    path: task,
    run: ({ read, input }) => getTask(read, input),
  },
  {
    name: 'chorus.get_result',
    description: 'Returns one submitted result revision of a task, with its content and digest.',
    action: 'read',
    write: false,
    props: { session_id: S, task_id: S, revision: I },
    required: ['session_id', 'task_id', 'revision'],
    path: task,
    run: ({ read, input }) => getResult(read, input),
  },
  {
    name: 'chorus.list_my_reviews',
    description: 'Lists the reviews assigned to you in a session, optionally by state.',
    action: 'read',
    write: false,
    props: { session_id: S, states: SA, limit: I, cursor: S },
    required: ['session_id'],
    path: session,
    run: ({ read, input }) => listMyReviews(read, input),
  },
  {
    name: 'chorus.create_task',
    description:
      'Creates a task on a board with acceptance criteria. It does not assign the task; an agent claims it.',
    action: 'create_item',
    write: true,
    props: {
      session_id: S,
      board_id: S,
      title: S,
      body: S,
      acceptance_criteria: SA,
      priority: I,
      review_required: B,
      shareable: B,
    },
    required: ['session_id', 'board_id', 'title', 'acceptance_criteria'],
    path: session,
    run: ({ command, input }) => createTask(command, input),
  },
  {
    name: 'chorus.claim',
    description:
      'Claims a ready task and takes a lease with a fence token, at the task version you expect. Fails if someone else owns it.',
    action: 'claim',
    write: true,
    props: VERSIONED,
    required: ['session_id', 'task_id', 'expected_version'],
    path: task,
    run: ({ command, input }) => claim(command, input),
  },
  {
    name: 'chorus.renew_lease',
    description: 'Extends your lease on a task you own, presenting the fence token you were given.',
    action: 'renew_lease',
    write: true,
    props: { ...VERSIONED, fence: I },
    required: ['session_id', 'task_id', 'expected_version', 'fence'],
    path: task,
    run: ({ command, input }) => renewLease(command, input),
  },
  {
    name: 'chorus.submit_result',
    description:
      'Submits a result revision for a task you own, mapping it to the acceptance criteria. It moves the task to review; it does not complete it.',
    action: 'submit_result',
    write: true,
    props: {
      ...VERSIONED,
      fence: I,
      content: S,
      content_type: S,
      criteria_mapping: OA,
      supporting_refs: SA,
    },
    required: [
      'session_id',
      'task_id',
      'expected_version',
      'fence',
      'content',
      'content_type',
      'criteria_mapping',
    ],
    path: task,
    run: ({ command, input }) => submitResult(command, input),
  },
  {
    name: 'chorus.request_review',
    description:
      'Asks a session member to review the latest result revision. The reviewer can never be the submitter or the task owner.',
    action: 'request_review',
    write: true,
    props: { ...VERSIONED, revision: I, reviewer_actor_id: S },
    required: ['session_id', 'task_id', 'expected_version', 'revision', 'reviewer_actor_id'],
    path: task,
    run: ({ command, input }) => requestReview(command, input),
  },
  {
    name: 'chorus.review',
    description:
      'Records a verdict on a review assigned to you, quoting the digest of the reviewed result. An approval of the latest revision completes the task automatically when the gates pass.',
    action: 'review',
    write: true,
    props: {
      session_id: S,
      review_id: S,
      expected_version: I,
      verdict: S,
      content_sha256: S,
      notes: S,
    },
    required: ['session_id', 'review_id', 'expected_version', 'verdict', 'content_sha256'],
    path: review,
    run: ({ command, input }) => reviewVerdict(command, input),
  },
  {
    name: 'chorus.complete',
    description:
      'Completes a task in review when every gate passes. Requires the manager role; it never bypasses a required approval.',
    action: 'complete',
    write: true,
    props: VERSIONED,
    required: ['session_id', 'task_id', 'expected_version'],
    path: task,
    run: ({ command, input }) => completeTask(command, input),
  },
];
