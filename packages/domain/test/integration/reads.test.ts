import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getResult,
  getTask,
  isChorusError,
  listMyReviews,
  listWork,
  type Uuid,
} from '../../src/index.ts';
import { createFixture, type Fixture } from '../helpers/fixture.ts';
import {
  claimAs,
  makeWorld,
  newTask,
  requestReviewAs,
  submitAs,
  taskInReview,
  verdictAs,
  type World,
} from '../helpers/world.ts';

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => 'no error',
    (e: unknown) => e,
  );
  return isChorusError(error) ? error.code : String(error);
}

describe('RC-WP2 reads (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let w: World;

  beforeAll(async () => {
    f = await createFixture();
    w = await makeWorld(f, f.a);
  });
  afterAll(async () => {
    await f.close();
  });

  const read = (agent: { actorId: Uuid }) => ({
    pool: f.pool,
    workspaceId: w.ws.id,
    actorId: agent.actorId,
  });

  it('reads.visibility', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);

    // The owner sees the holding instance; everyone else sees null.
    const asOwner = await getTask(read(w.executor), { task_id: task.id });
    expect(asOwner.lease).toMatchObject({
      fence: 1,
      live: true,
      holder_instance_id: w.executor.instanceId,
    });
    const asReviewer = await getTask(read(w.reviewer), { task_id: task.id });
    expect(asReviewer.lease).toMatchObject({ fence: 1, live: true, holder_instance_id: null });
    expect(asReviewer.acceptance_criteria).toEqual(['Compiles', 'Has tests']);
    expect(asReviewer.reviews).toEqual([]);
    expect(asReviewer.latest_revision).toBeNull();

    const submitted = await submitAs(
      w,
      task.id as Uuid,
      claimed.version,
      claimed.fence,
      'evidence body',
    );
    // A room reviewer can read the result content and digest; refs are labeled unverified.
    const result = await getResult(read(w.reviewer), { task_id: task.id, revision: 1 });
    expect(result).toMatchObject({
      content: 'evidence body',
      content_sha256: submitted.content_sha256,
      byte_length: 13,
      content_type: 'text/plain',
    });
    expect(result.criteria_mapping).toHaveLength(2);

    // A non-member sees nothing: not_found for the task, its result, and a missing revision alike.
    const outsider = await w.agent(null);
    expect(await code(getTask(read(outsider), { task_id: task.id }))).toBe('not_found');
    expect(await code(getResult(read(outsider), { task_id: task.id, revision: 1 }))).toBe(
      'not_found',
    );
    expect(await code(getResult(read(w.reviewer), { task_id: task.id, revision: 9 }))).toBe(
      'not_found',
    );
    // A review id is not a task, and another workspace's task is invisible.
    expect(
      await code(getTask(read(w.reviewer), { task_id: '00000000-0000-4000-8000-000000000000' })),
    ).toBe('not_found');
    const other = await makeWorld(f, f.b);
    expect(await code(getTask(read(other.executor), { task_id: task.id }))).toBe('not_found');

    // Reviews and revisions appear in the task view, with the stale flag derived.
    const r = await requestReviewAs(w, task.id as Uuid, submitted.version, 1);
    await verdictAs(r.review, submitted.content_sha256, 'approved', w.reviewer);
    const view = await getTask(read(w.executor2), { task_id: task.id });
    expect(view.revisions).toEqual([
      expect.objectContaining({ revision: 1, content_sha256: submitted.content_sha256 }),
    ]);
    expect(view.reviews).toEqual([
      expect.objectContaining({
        id: r.review.id,
        revision: 1,
        state: 'approved',
        verdict: 'approved',
        stale: false,
      }),
    ]);
    expect(await code(getTask(read(w.executor), { task_id: r.review.id }))).toBe('not_found');
  });

  it('reads.list_work.cursor', async () => {
    const room = await f.addRoom(w.ws, 'list-room');
    const manager = await w.agent('manager', room);
    const create = async (i: number) =>
      (
        await (
          await import('../../src/index.ts')
        ).createTask(manager.ctx(), {
          room_id: room,
          title: `listed ${String(i)}`,
          acceptance_criteria: ['c'],
        })
      ).task.id;
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await create(i));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listWork(read(manager), {
        room_id: room,
        limit: 7,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.items.length).toBeLessThanOrEqual(7);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.next_cursor ?? undefined;
      pages++;
      // Rows created while paging never duplicate or displace what was already listed.
      if (pages === 2) await create(100 + pages);
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);

    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
    // Newest first, strictly descending ids.
    expect([...seen].sort().reverse()).toEqual(seen);
    // No dependency or runnable fields.
    const [first] = (await listWork(read(manager), { room_id: room, limit: 1 })).items;
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        'created_at',
        'criteria_count',
        'id',
        'owner_actor_id',
        'review_required',
        'room_id',
        'shareable',
        'state',
        'title',
        'updated_at',
        'version',
      ].sort(),
    );

    expect(await code(listWork(read(manager), { cursor: '!!!' }))).toBe('invalid_request');
    expect(
      await code(
        listWork(read(manager), { cursor: Buffer.from('not-a-uuid').toString('base64url') }),
      ),
    ).toBe('invalid_request');
    expect(await code(listWork(read(manager), { limit: 51 }))).toBe('invalid_request');
    expect(await code(listWork(read(manager), { limit: 0 }))).toBe('invalid_request');
    expect(await code(listWork(read(manager), { states: ['bogus'] }))).toBe('invalid_request');
    expect(await code(listWork(read(manager), { surprise: 1 }))).toBe('invalid_request');
  });

  it('reads.list_work.filters', async () => {
    const room = await f.addRoom(w.ws, 'filter-room');
    const manager = await w.agent('manager', room);
    const executor = await w.agent('executor', room);
    const { createTask, claim } = await import('../../src/index.ts');
    const a = (
      await createTask(manager.ctx(), { room_id: room, title: 'a', acceptance_criteria: ['c'] })
    ).task;
    const b = (
      await createTask(manager.ctx(), { room_id: room, title: 'b', acceptance_criteria: ['c'] })
    ).task;
    await claim(executor.ctx(), { task_id: a.id, expected_version: a.version });

    const mine = await listWork(read(executor), { owner: 'me' });
    expect(mine.items.map((t) => t.id)).toEqual([a.id]);
    const ready = await listWork(read(executor), { room_id: room, states: ['ready'] });
    expect(ready.items.map((t) => t.id)).toEqual([b.id]);
    const both = await listWork(read(executor), { room_id: room });
    expect(both.items.map((t) => t.id)).toEqual([b.id, a.id]);
    // A room the caller cannot see yields nothing rather than an error that would reveal it.
    const stranger = await w.agent(null);
    expect((await listWork(read(stranger), { room_id: room })).items).toEqual([]);
  });

  it('reads.list_my_reviews', async () => {
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1, w.reviewer2);
    const pending = await listMyReviews(read(w.reviewer2), {});
    expect(pending.items).toEqual([
      expect.objectContaining({
        id: r.review.id,
        task_id: t.taskId,
        revision: 1,
        state: 'requested',
        stale: false,
      }),
    ]);
    // Reviews of other reviewers are not listed.
    expect((await listMyReviews(read(w.reviewer), {})).items.map((i) => i.id)).not.toContain(
      r.review.id,
    );
    await verdictAs(r.review, t.digest, 'changes_requested', w.reviewer2);
    expect((await listMyReviews(read(w.reviewer2), {})).items).toEqual([]);
    const done = await listMyReviews(read(w.reviewer2), {
      states: ['approved', 'changes_requested'],
    });
    expect(done.items.map((i) => i.id)).toContain(r.review.id);
    expect(
      await code(listMyReviews(read(w.reviewer2), { states: ['requested', 'requested'] })),
    ).toBe('invalid_request');
  });
});
