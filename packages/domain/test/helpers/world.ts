import { randomBytes } from 'node:crypto';
import {
  claim,
  createTask,
  requestReview,
  reviewVerdict,
  submitResult,
  type CommandContext,
  type ReviewSummary,
  type TaskSummary,
  type Uuid,
} from '../../src/index.ts';
import type { Actor, Fixture, SessionSeed, Workspace } from './fixture.ts';

export const uniqueKey = (prefix = 'k') => `${prefix}-${randomBytes(6).toString('hex')}`;

/** A session with its cast: manager (+admin), participants, and an actor who is in the room but not the session. */
export interface World {
  f: Fixture;
  ws: Workspace;
  session: SessionSeed;
  /** participant + manager + administrator: the session creator. */
  manager: Actor;
  executor: Actor;
  executor2: Actor;
  reviewer: Actor;
  reviewer2: Actor;
  /** Verified room member, not a member of the session. */
  outsider: Actor;
  /** A new participant of the session. */
  participant: (label?: string) => Promise<Actor>;
}

export async function makeWorld(
  f: Fixture,
  ws: Workspace,
  options: { managerReview?: boolean } = {},
): Promise<World> {
  const manager = await f.actor(ws, 'manager');
  const session = await f.session(manager, { managerReview: options.managerReview ?? false });
  const participant = async (label?: string): Promise<Actor> => {
    const a = await f.actor(ws, label);
    await f.join(session, a);
    return a;
  };
  const [executor, executor2, reviewer, reviewer2] = await Promise.all([
    participant('executor'),
    participant('executor2'),
    participant('reviewer'),
    participant('reviewer2'),
  ]);
  const outsider = await f.actor(ws, 'outsider');
  return {
    f,
    ws,
    session,
    manager,
    executor,
    executor2,
    reviewer,
    reviewer2,
    outsider,
    participant,
  };
}

export const CRITERIA = ['Compiles', 'Has tests'];
export const MAPPING = [
  { criterion: 0, note: 'built ok' },
  { criterion: 1, note: 'tests added' },
];

export async function newTask(
  w: World,
  opts: { reviewRequired?: boolean; shareable?: boolean; criteria?: string[]; by?: Actor } = {},
): Promise<TaskSummary> {
  const { task } = await createTask((opts.by ?? w.manager).ctx(), {
    session_id: w.session.id,
    board_id: w.session.boardId,
    title: `task ${uniqueKey('t')}`,
    body: 'do the thing',
    acceptance_criteria: opts.criteria ?? CRITERIA,
    ...(opts.reviewRequired === undefined ? {} : { review_required: opts.reviewRequired }),
    shareable: opts.shareable ?? false,
  });
  return task;
}

export async function claimAs(w: World, taskId: Uuid, version: number, agent: Actor = w.executor) {
  return claim(agent.ctx(), {
    session_id: w.session.id,
    task_id: taskId,
    expected_version: version,
  });
}

export async function submitAs(
  w: World,
  taskId: Uuid,
  version: number,
  fence: number,
  content = 'the result',
  agent: Actor = w.executor,
) {
  return submitResult(agent.ctx(), {
    session_id: w.session.id,
    task_id: taskId,
    expected_version: version,
    fence,
    content,
    content_type: 'text/plain',
    criteria_mapping: MAPPING,
  });
}

/** create -> claim -> submit: a task in `review` with one revision. */
export async function taskInReview(w: World, opts: { reviewRequired?: boolean } = {}) {
  const task = await newTask(w, opts);
  const claimed = await claimAs(w, task.id as Uuid, task.version);
  const submitted = await submitAs(w, task.id as Uuid, claimed.version, claimed.fence);
  return {
    taskId: task.id as Uuid,
    version: submitted.version,
    digest: submitted.content_sha256,
    revision: 1,
  };
}

export async function requestReviewAs(
  w: World,
  taskId: Uuid,
  version: number,
  revision: number,
  reviewer: Actor = w.reviewer,
  caller: Actor = w.executor,
) {
  return requestReview(caller.ctx(), {
    session_id: w.session.id,
    task_id: taskId,
    expected_version: version,
    revision,
    reviewer_actor_id: reviewer.id,
  });
}

export async function verdictAs(
  w: World,
  review: ReviewSummary,
  digest: string,
  verdict: 'approved' | 'changes_requested',
  reviewer: Actor,
  notes?: string,
) {
  return reviewVerdict(reviewer.ctx(), {
    session_id: w.session.id,
    review_id: review.id,
    expected_version: review.version,
    verdict,
    content_sha256: digest,
    ...(notes === undefined ? {} : { notes }),
  });
}

export type { CommandContext };
