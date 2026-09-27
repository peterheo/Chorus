import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claim,
  boardSummary,
  completeTask,
  createTask,
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

describe('session reads (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let w: World;
  let sid: string;

  beforeAll(async () => {
    f = await createFixture();
    w = await makeWorld(f, await f.workspace('reads'));
    sid = w.session.id;
  });
  afterAll(async () => {
    await f.close();
  });

  const read = (a: Parameters<Fixture['readCtx']>[0]) => f.readCtx(a);

  it('reads.visibility: session members read; the lease holder is shown only to the owner; non-members get not_found', async () => {
    const task = await newTask(w);
    const claimed = await claimAs(w, task.id as Uuid, task.version);
    const asOwner = await getTask(read(w.executor), { session_id: sid, task_id: task.id });
    expect(asOwner.lease).toMatchObject({
      fence: 1,
      live: true,
      holder_instance_id: w.executor.instanceId,
    });
    const asReviewer = await getTask(read(w.reviewer), { session_id: sid, task_id: task.id });
    expect(asReviewer.lease).toMatchObject({ fence: 1, live: true, holder_instance_id: null });
    expect(asReviewer).toMatchObject({
      acceptance_criteria: ['Compiles', 'Has tests'],
      reviews: [],
      latest_revision: null,
      criteria_revision: 1,
      work_cycle: 1,
      blocked: null,
      claim_policy: 'open',
    });

    const submitted = await submitAs(
      w,
      task.id as Uuid,
      claimed.version,
      claimed.fence,
      'evidence body',
    );
    const result = await getResult(read(w.reviewer), {
      session_id: sid,
      task_id: task.id,
      revision: 1,
    });
    expect(result).toMatchObject({
      content: 'evidence body',
      content_sha256: submitted.content_sha256,
      byte_length: 13,
      content_type: 'text/plain',
    });
    expect(result.criteria_mapping).toHaveLength(2);

    expect(await code(getTask(read(w.outsider), { session_id: sid, task_id: task.id }))).toBe(
      'not_found',
    );
    expect(
      await code(getResult(read(w.outsider), { session_id: sid, task_id: task.id, revision: 1 })),
    ).toBe('not_found');
    expect(
      await code(getResult(read(w.reviewer), { session_id: sid, task_id: task.id, revision: 9 })),
    ).toBe('not_found');
    expect(
      await code(
        getTask(read(w.reviewer), {
          session_id: sid,
          task_id: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe('not_found');
    const other = await makeWorld(f, await f.workspace('reads-other'));
    expect(
      await code(getTask(read(other.executor), { session_id: other.session.id, task_id: task.id })),
    ).toBe('not_found');
    // A task asked for through a different session of the same member is not found.
    const second = await f.session(w.manager);
    await f.join(second, w.reviewer);
    expect(await code(getTask(read(w.reviewer), { session_id: second.id, task_id: task.id }))).toBe(
      'not_found',
    );

    const r = await requestReviewAs(w, task.id as Uuid, submitted.version, 1);
    await verdictAs(w, r.review, submitted.content_sha256, 'approved', w.reviewer);
    const view = await getTask(read(w.executor2), { session_id: sid, task_id: task.id });
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
    expect(view.state).toBe('done');
    expect(await code(getTask(read(w.executor), { session_id: sid, task_id: r.review.id }))).toBe(
      'not_found',
    );
  });

  it('reads.list_work.cursor: stable, no duplicates or gaps across pages under concurrent inserts', async () => {
    const world = await makeWorld(f, await f.workspace('reads-list'));
    const m = world.manager;
    const create = async (i: number) =>
      (
        await createTask(m.ctx(), {
          session_id: world.session.id,
          board_id: world.session.boardId,
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
      const page = await listWork(read(m), {
        session_id: world.session.id,
        limit: 7,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.items.length).toBeLessThanOrEqual(7);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.next_cursor ?? undefined;
      pages++;
      if (pages === 2) await create(100);
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
    expect([...seen].sort().reverse()).toEqual(seen);

    const [first] = (await listWork(read(m), { session_id: world.session.id, limit: 1 })).items;
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        'blocked',
        'board_id',
        'created_at',
        'criteria_count',
        'id',
        'owner_actor_id',
        'priority',
        'review_required',
        'room_id',
        'session_id',
        'shareable',
        'state',
        'title',
        'updated_at',
        'version',
      ].sort(),
    );
    for (const bad of [
      { cursor: '!!!' },
      { cursor: Buffer.from('not-a-uuid').toString('base64url') },
      { limit: 51 },
      { limit: 0 },
      { states: ['bogus'] },
      { surprise: 1 },
    ]) {
      expect(
        await code(listWork(read(m), { session_id: world.session.id, ...bad })),
        JSON.stringify(bad),
      ).toBe('invalid_request');
    }
    expect(await code(listWork(read(m), {}))).toBe('invalid_request');
    expect(await code(listWork(read(world.outsider), { session_id: world.session.id }))).toBe(
      'not_found',
    );
  });

  it('reads.list_work.filters: by board, state, owner and blocked', async () => {
    const world = await makeWorld(f, await f.workspace('reads-filters'));
    const board2 = await f.owner<{ id: string }>(
      `INSERT INTO projects (workspace_id, session_id, name) VALUES ($1, $2, 'Second') RETURNING id`,
      [world.ws.id, world.session.id],
    );
    const a = await newTask(world);
    const b = (
      await createTask(world.manager.ctx(), {
        session_id: world.session.id,
        board_id: board2[0]?.id,
        title: 'b',
        acceptance_criteria: ['c'],
      })
    ).task;
    await claim(world.executor.ctx(), {
      session_id: world.session.id,
      task_id: a.id,
      expected_version: a.version,
    });
    await f.owner(`UPDATE work_items SET blocked_reason = 'x', blocked_at = now() WHERE id = $1`, [
      b.id,
    ]);
    const ids = async (extra: Record<string, unknown>) =>
      (await listWork(read(world.executor), { session_id: world.session.id, ...extra })).items.map(
        (t) => t.id,
      );
    expect(await ids({ owner: 'me' })).toEqual([a.id]);
    expect(await ids({ states: ['ready'] })).toEqual([b.id]);
    expect(await ids({ board_id: board2[0]?.id })).toEqual([b.id]);
    expect(await ids({ blocked: true })).toEqual([b.id]);
    expect(await ids({ blocked: false })).toEqual([a.id]);
    expect((await ids({})).sort()).toEqual([a.id, b.id].sort());
  });

  it('reads.board_summary: scopes by session and board and counts blocked tasks', async () => {
    const world = await makeWorld(f, await f.workspace('reads-summary'));
    const board2 = await f.owner<{ id: string }>(
      "INSERT INTO projects (workspace_id, session_id, name) VALUES ($1, $2, 'Second') RETURNING id",
      [world.ws.id, world.session.id],
    );
    const first = await newTask(world);
    const second = (
      await createTask(world.manager.ctx(), {
        session_id: world.session.id,
        board_id: board2[0]?.id,
        title: 'blocked task',
        acceptance_criteria: ['c'],
      })
    ).task;
    await f.owner(
      "UPDATE work_items SET blocked_reason = 'waiting', blocked_at = now() WHERE id = $1",
      [second.id],
    );

    for (let index = 0; index < 6; index++) {
      const done = await newTask(world, { reviewRequired: false });
      const lease = await claimAs(world, done.id as Uuid, done.version);
      const submitted = await submitAs(world, done.id as Uuid, lease.version, lease.fence);
      await completeTask(world.manager.ctx(), {
        session_id: world.session.id,
        task_id: done.id,
        expected_version: submitted.version,
      });
    }

    const summary = await boardSummary(read(world.executor), { session_id: world.session.id });
    expect(summary.boards).toHaveLength(2);
    expect(summary.boards.find((b) => b.board_id === first.board_id)).toMatchObject({
      counts: { ready: 1, in_progress: 0, review: 0, done: 6, blocked: 0 },
    });
    const recentDone = summary.boards.find((b) => b.board_id === first.board_id)?.recent_done ?? [];
    expect(recentDone).toHaveLength(5);
    expect(recentDone.every((task) => task.completed_at.length > 0)).toBe(true);
    expect(summary.boards.find((b) => b.board_id === board2[0]?.id)).toMatchObject({
      counts: { ready: 1, blocked: 1 },
    });
    await expect(
      boardSummary(read(world.executor), {
        session_id: world.session.id,
        board_id: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      (
        await boardSummary(read(world.executor), {
          session_id: world.session.id,
          board_id: first.board_id,
        })
      ).boards,
    ).toHaveLength(1);
  });

  it('reads.list_my_reviews: only my reviews, cancelled ones excluded, by session', async () => {
    const t = await taskInReview(w);
    const r = await requestReviewAs(w, t.taskId, t.version, 1, w.reviewer2);
    const pending = await listMyReviews(read(w.reviewer2), {});
    expect(pending.items).toEqual([
      expect.objectContaining({
        id: r.review.id,
        session_id: sid,
        task_id: t.taskId,
        revision: 1,
        state: 'requested',
        stale: false,
      }),
    ]);
    expect((await listMyReviews(read(w.reviewer), {})).items.map((i) => i.id)).not.toContain(
      r.review.id,
    );
    expect((await listMyReviews(read(w.reviewer2), { session_id: sid })).items).toHaveLength(1);
    expect(
      (await listMyReviews(read(w.reviewer2), { session_id: w.session.boardId })).items,
    ).toEqual([]);
    await verdictAs(w, r.review, t.digest, 'changes_requested', w.reviewer2);
    expect((await listMyReviews(read(w.reviewer2), {})).items).toEqual([]);
    expect(
      (
        await listMyReviews(read(w.reviewer2), { states: ['approved', 'changes_requested'] })
      ).items.map((i) => i.id),
    ).toContain(r.review.id);
    expect(
      await code(listMyReviews(read(w.reviewer2), { states: ['requested', 'requested'] })),
    ).toBe('invalid_request');
  });
});
