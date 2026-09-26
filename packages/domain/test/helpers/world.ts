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
import type { Fixture, Workspace } from './fixture.ts';

export const uniqueKey = (prefix = 'k') => `${prefix}-${randomBytes(6).toString('hex')}`;

/** An actor with a grant, and its agent instance (one per token, D2.1). */
export interface Agent {
  actorId: Uuid;
  instanceId: Uuid;
  ctx: (key?: string) => CommandContext;
}

export interface World {
  f: Fixture;
  ws: Workspace;
  roomId: Uuid;
  manager: Agent;
  executor: Agent;
  executor2: Agent;
  reviewer: Agent;
  reviewer2: Agent;
  agent: (role: string | null, roomId?: Uuid) => Promise<Agent>;
}

export async function makeWorld(f: Fixture, ws: Workspace): Promise<World> {
  const roomId = await f.addRoom(ws, uniqueKey('room'));
  const agent = async (role: string | null, room: Uuid = roomId): Promise<Agent> => {
    const actorId = await f.addActor(ws, role === null ? undefined : { roomId: room, role });
    const instanceId = await f.addInstance(ws, actorId);
    return { actorId, instanceId, ctx: (key = uniqueKey()) => f.ctx(ws, actorId, key, instanceId) };
  };
  const [manager, executor, executor2, reviewer, reviewer2] = await Promise.all([
    agent('manager'),
    agent('executor'),
    agent('executor'),
    agent('reviewer'),
    agent('reviewer'),
  ]);
  return { f, ws, roomId, manager, executor, executor2, reviewer, reviewer2, agent };
}

export const CRITERIA = ['Compiles', 'Has tests'];
export const MAPPING = [
  { criterion: 0, note: 'built ok' },
  { criterion: 1, note: 'tests added' },
];

export async function newTask(
  w: World,
  opts: { reviewRequired?: boolean; shareable?: boolean; criteria?: string[] } = {},
): Promise<TaskSummary> {
  const { task } = await createTask(w.manager.ctx(), {
    room_id: w.roomId,
    title: `task ${uniqueKey('t')}`,
    body: 'do the thing',
    acceptance_criteria: opts.criteria ?? CRITERIA,
    review_required: opts.reviewRequired ?? true,
    shareable: opts.shareable ?? false,
  });
  return task;
}

/** Claim as `agent` (default executor). Returns the response and the current version. */
export async function claimAs(w: World, taskId: Uuid, version: number, agent: Agent = w.executor) {
  return claim(agent.ctx(), { task_id: taskId, expected_version: version });
}

export async function submitAs(
  w: World,
  taskId: Uuid,
  version: number,
  fence: number,
  content = 'the result',
  agent: Agent = w.executor,
) {
  return submitResult(agent.ctx(), {
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
  reviewer: Agent = w.reviewer,
  caller: Agent = w.executor,
) {
  return requestReview(caller.ctx(), {
    task_id: taskId,
    expected_version: version,
    revision,
    reviewer_actor_id: reviewer.actorId,
  });
}

export async function verdictAs(
  review: ReviewSummary,
  digest: string,
  verdict: 'approved' | 'changes_requested',
  reviewer: Agent,
  notes?: string,
) {
  return reviewVerdict(reviewer.ctx(), {
    review_id: review.id,
    expected_version: review.version,
    verdict,
    content_sha256: digest,
    ...(notes === undefined ? {} : { notes }),
  });
}
