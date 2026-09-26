import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isChorusError, runCommand, type ErrorCode, type Uuid } from '../../src/index.ts';
import {
  createFixture,
  createItemCommand,
  retitleCommand,
  type Fixture,
} from '../helpers/fixture.ts';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the command to reject');
    },
    (error: unknown) => error,
  );
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  const error = await rejection(promise);
  expect(isChorusError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
  return error as import('../../src/index.ts').ChorusError;
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('runCommand (real PostgreSQL)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const itemCount = (workspaceId: Uuid, title?: string) =>
    f.count(
      `SELECT count(*) AS n FROM work_items WHERE workspace_id = $1 AND ($2::text IS NULL OR title = $2)`,
      [workspaceId, title ?? null],
    );

  describe('idempotency', () => {
    it('replays the stored response without running the handler again', async () => {
      let handled = 0;
      const ctx = f.ctx(f.a, f.a.executorId, 'replay-1');
      const spec = () =>
        createItemCommand({
          roomId: f.a.roomId,
          title: 'replay',
          onHandle: () => {
            handled++;
          },
        });
      const first = await runCommand(ctx, spec());
      const second = await runCommand(ctx, spec());
      expect(second).toEqual(first);
      expect(handled).toBe(1);
      expect(await itemCount(f.a.id, 'replay')).toBe(1);
      expect(
        await f.count(`SELECT count(*) AS n FROM commands WHERE idempotency_key = 'replay-1'`),
      ).toBe(1);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM domain_events e JOIN commands c ON c.id = e.command_id
            WHERE c.idempotency_key = 'replay-1'`,
        ),
      ).toBe(1);
    });

    it('rejects the same key with a different request as idempotency_conflict', async () => {
      const ctx = f.ctx(f.a, f.a.executorId, 'conflict-1');
      await runCommand(ctx, createItemCommand({ roomId: f.a.roomId, title: 'original' }));
      const error = await expectCode(
        runCommand(ctx, createItemCommand({ roomId: f.a.roomId, title: 'different' })),
        'idempotency_conflict',
      );
      expect(error.status).toBe(409);
      expect(await itemCount(f.a.id, 'different')).toBe(0);
      expect(await itemCount(f.a.id, 'original')).toBe(1);
    });

    it('scopes keys to the acting actor', async () => {
      const spec = () => createItemCommand({ roomId: f.a.roomId, title: 'scoped' });
      const one = await runCommand(f.ctx(f.a, f.a.executorId, 'shared-key'), spec());
      const two = await runCommand(f.ctx(f.a, f.a.executor2Id, 'shared-key'), spec());
      expect(one.item_id).not.toBe(two.item_id);
    });

    it('runs the handler once for 20 concurrent calls with the same key', async () => {
      let handled = 0;
      const ctx = f.ctx(f.a, f.a.executorId, 'concurrent-1');
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          runCommand(
            ctx,
            createItemCommand({
              roomId: f.a.roomId,
              title: 'concurrent',
              onHandle: () => {
                handled++;
              },
            }),
          ),
        ),
      );
      expect(handled).toBe(1);
      expect(new Set(results.map((r) => r.item_id)).size).toBe(1);
      expect(results.every((r) => r.version === 1)).toBe(true);
      expect(await itemCount(f.a.id, 'concurrent')).toBe(1);
      expect(
        await f.count(`SELECT count(*) AS n FROM commands WHERE idempotency_key = 'concurrent-1'`),
      ).toBe(1);
    });

    it('leaves no command record after a failure, so the same key can be retried', async () => {
      const ctx = f.ctx(f.a, f.a.executorId, 'retry-after-failure');
      await expectCode(
        runCommand(ctx, createItemCommand({ roomId: f.b.roomId, title: 'failing' })),
        'not_found',
      );
      expect(
        await f.count(
          `SELECT count(*) AS n FROM commands WHERE idempotency_key = 'retry-after-failure'`,
        ),
      ).toBe(0);
      const ok = await runCommand(
        ctx,
        createItemCommand({ roomId: f.a.roomId, title: 'after-failure' }),
      );
      expect(ok.version).toBe(1);
    });

    it('requires a well-formed key', async () => {
      const spec = createItemCommand({ roomId: f.a.roomId, title: 'nokey' });
      const missing = await expectCode(
        runCommand(f.ctx(f.a, f.a.executorId, undefined), spec),
        'precondition_required',
      );
      expect(missing.status).toBe(428);
      await expectCode(runCommand(f.ctx(f.a, f.a.executorId, ''), spec), 'precondition_required');
      await expectCode(
        runCommand(f.ctx(f.a, f.a.executorId, 'has space'), spec),
        'invalid_request',
      );
      expect(await itemCount(f.a.id, 'nokey')).toBe(0);
    });
  });

  describe('versions', () => {
    it('applies a change at the expected version and bumps it with a matching event', async () => {
      const created = await runCommand(
        f.ctx(f.a, f.a.executorId, 'v-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'versioned' }),
      );
      const id = created.item_id as Uuid;
      const updated = await runCommand(
        f.ctx(f.a, f.a.executorId, 'v-update-1'),
        retitleCommand({ itemId: id, expectedVersion: 1, title: 'versioned-2' }),
      );
      expect(updated.version).toBe(2);
      const events = await f.db.query<{ aggregate_version: number; event_type: string }>(
        'SELECT aggregate_version, event_type FROM domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version',
        [id],
      );
      expect(events.map((e) => [e.event_type, e.aggregate_version])).toEqual([
        ['task.created', 1],
        ['task.retitled', 2],
      ]);
    });

    it('returns version_conflict with the current version for a stale expectation', async () => {
      const created = await runCommand(
        f.ctx(f.a, f.a.executorId, 'vc-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'stale' }),
      );
      const id = created.item_id as Uuid;
      await runCommand(
        f.ctx(f.a, f.a.executorId, 'vc-1'),
        retitleCommand({ itemId: id, expectedVersion: 1, title: 'stale-2' }),
      );
      const error = await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'vc-2'),
          retitleCommand({ itemId: id, expectedVersion: 1, title: 'stale-3' }),
        ),
        'version_conflict',
      );
      expect(error.status).toBe(409);
      expect(error.details).toMatchObject({ current_version: 2 });
    });

    it('returns precondition_required when the expected version is missing', async () => {
      const created = await runCommand(
        f.ctx(f.a, f.a.executorId, 'pr-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'unversioned' }),
      );
      const error = await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'pr-1'),
          retitleCommand({
            itemId: created.item_id as Uuid,
            expectedVersion: undefined,
            title: 'x',
          }),
        ),
        'precondition_required',
      );
      expect(error.status).toBe(428);
      expect(error.details).toMatchObject({ current_version: 1 });
    });

    it('lets exactly one of many concurrent writers at the same version win', async () => {
      const created = await runCommand(
        f.ctx(f.a, f.a.executorId, 'race-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'race' }),
      );
      const id = created.item_id as Uuid;
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runCommand(
            f.ctx(f.a, f.a.executorId, `race-${String(i)}`),
            retitleCommand({ itemId: id, expectedVersion: 1, title: `race-${String(i)}` }),
          ).then(
            () => 'won' as const,
            (error: unknown) => (isChorusError(error, 'version_conflict') ? 'lost' : error),
          ),
        ),
      );
      expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'lost')).toHaveLength(9);
      const [row] = await f.db.query<{ version: number }>(
        'SELECT version FROM work_items WHERE id = $1',
        [id],
      );
      expect(row?.version).toBe(2);
    });
  });

  describe('authorization is checked in the transaction against current grants', () => {
    it('returns not_found for a room the actor has no grant in', async () => {
      const error = await expectCode(
        runCommand(
          f.ctx(f.a, f.a.outsiderId, 'authz-1'),
          createItemCommand({ roomId: f.a.roomId, title: 'nope' }),
        ),
        'not_found',
      );
      expect(error.status).toBe(404);
    });

    it("returns not_found for another workspace's room, same as a room that does not exist", async () => {
      await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'authz-2'),
          createItemCommand({ roomId: f.b.roomId, title: 'cross' }),
        ),
        'not_found',
      );
      await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'authz-3'),
          createItemCommand({
            roomId: '00000000-0000-4000-8000-000000000000' as Uuid,
            title: 'ghost',
          }),
        ),
        'not_found',
      );
      expect(await itemCount(f.a.id, 'cross')).toBe(0);
      expect(await itemCount(f.b.id, 'cross')).toBe(0);
    });

    it('returns not_found, not 403, for an existing item the actor cannot see', async () => {
      const created = await runCommand(
        f.ctx(f.a, f.a.executorId, 'hidden-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'hidden' }),
      );
      await expectCode(
        runCommand(
          f.ctx(f.a, f.a.outsiderId, 'hidden-1'),
          retitleCommand({ itemId: created.item_id as Uuid, expectedVersion: 1, title: 'x' }),
        ),
        'not_found',
      );
    });

    it("returns not_found for another workspace's item id and for an unknown id", async () => {
      const inB = await runCommand(
        f.ctx(f.b, f.b.executorId, 'other-ws-create'),
        createItemCommand({ roomId: f.b.roomId, title: 'in-b' }),
      );
      await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'other-ws-1'),
          retitleCommand({ itemId: inB.item_id as Uuid, expectedVersion: 1, title: 'x' }),
        ),
        'not_found',
      );
      await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'other-ws-2'),
          retitleCommand({
            itemId: '00000000-0000-4000-8000-000000000001' as Uuid,
            expectedVersion: 1,
            title: 'x',
          }),
        ),
        'not_found',
      );
    });

    it('returns action_forbidden when the room is visible but the role is insufficient', async () => {
      const error = await expectCode(
        runCommand(
          f.ctx(f.a, f.a.reviewerId, 'forbidden-1'),
          createItemCommand({ roomId: f.a.roomId, title: 'reviewer-cannot' }),
        ),
        'action_forbidden',
      );
      expect(error.status).toBe(403);
      expect(await itemCount(f.a.id, 'reviewer-cannot')).toBe(0);
    });

    it('takes effect immediately when a grant is revoked', async () => {
      const ok = () =>
        runCommand(
          f.ctx(f.a, f.a.executor2Id, `revoke-${Math.random().toString(36).slice(2)}`),
          createItemCommand({ roomId: f.a.roomId, title: 'revocable' }),
        );
      await ok();
      await f.db.query(
        `UPDATE room_grants SET revoked_at = now() WHERE workspace_id = $1 AND actor_id = $2`,
        [f.a.id, f.a.executor2Id],
      );
      await expectCode(ok(), 'not_found');
      await f.db.query(
        `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'executor')`,
        [f.a.id, f.a.executor2Id, f.a.roomId],
      );
      await ok();
    });

    it('rejects an actor that does not exist in the workspace as unauthenticated', async () => {
      await expectCode(
        runCommand(
          f.ctx(f.a, f.b.executorId, 'unknown-actor'),
          createItemCommand({ roomId: f.a.roomId, title: 'x' }),
        ),
        'unauthenticated',
      );
    });
  });

  describe('idempotent replay re-authorizes against current grants', () => {
    it('does not return the stored response once the grant is revoked, and does not re-run the handler', async () => {
      const actor = await f.addActor(f.a, { roomId: f.a.roomId, role: 'executor' });
      let handled = 0;
      const ctx = f.ctx(f.a, actor, 'replay-authz-create');
      const spec = () =>
        createItemCommand({
          roomId: f.a.roomId,
          title: 'protected',
          onHandle: () => {
            handled++;
          },
        });
      const first = await runCommand(ctx, spec());
      await f.db.query(
        'UPDATE room_grants SET revoked_at = now() WHERE workspace_id = $1 AND actor_id = $2',
        [f.a.id, actor],
      );

      const error = await expectCode(runCommand(ctx, spec()), 'not_found');
      expect(JSON.stringify(error)).not.toContain(first.item_id);
      expect(error.message).not.toContain(first.item_id);
      expect(handled).toBe(1);

      // Restoring access restores the original answer; nothing was re-executed meanwhile.
      await f.db.query(
        `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'executor')`,
        [f.a.id, actor, f.a.roomId],
      );
      expect(await runCommand(ctx, spec())).toEqual(first);
      expect(handled).toBe(1);
    });

    it('applies the same check to commands that target an existing item', async () => {
      const actor = await f.addActor(f.a, { roomId: f.a.roomId, role: 'executor' });
      const created = await runCommand(
        f.ctx(f.a, f.a.executorId, 'replay-target-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'target' }),
      );
      const id = created.item_id as Uuid;
      const ctx = f.ctx(f.a, actor, 'replay-target-1');
      const spec = () => retitleCommand({ itemId: id, expectedVersion: 1, title: 'target-2' });
      const first = await runCommand(ctx, spec());
      // The item has moved on (version 2), yet a permitted replay still returns the original response.
      await runCommand(
        f.ctx(f.a, f.a.executorId, 'replay-target-2'),
        retitleCommand({ itemId: id, expectedVersion: 2, title: 'target-3' }),
      );
      expect(await runCommand(ctx, spec())).toEqual(first);

      await f.db.query(
        'UPDATE room_grants SET revoked_at = now() WHERE workspace_id = $1 AND actor_id = $2',
        [f.a.id, actor],
      );
      await expectCode(runCommand(ctx, spec()), 'not_found');
    });

    it('returns action_forbidden on replay when the actor kept visibility but lost the role', async () => {
      const actor = await f.addActor(f.a, { roomId: f.a.roomId, role: 'executor' });
      const ctx = f.ctx(f.a, actor, 'replay-forbidden');
      const spec = () => createItemCommand({ roomId: f.a.roomId, title: 'role-loss' });
      await runCommand(ctx, spec());
      await f.db.query(
        `UPDATE room_grants SET revoked_at = now() WHERE workspace_id = $1 AND actor_id = $2 AND role = 'executor'`,
        [f.a.id, actor],
      );
      await f.db.query(
        `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'reviewer')`,
        [f.a.id, actor, f.a.roomId],
      );
      await expectCode(runCommand(ctx, spec()), 'action_forbidden');
    });
  });

  describe('journal', () => {
    it('writes a commands row and at least one domain event for every successful command', async () => {
      const rows = await f.db.query<{ status: string; events: string }>(
        `SELECT c.status, count(e.id) AS events
           FROM commands c LEFT JOIN domain_events e ON e.command_id = c.id
          GROUP BY c.id, c.status`,
      );
      expect(rows.length).toBeGreaterThan(5);
      expect(rows.every((r) => r.status === 'succeeded' && Number(r.events) >= 1)).toBe(true);
    });

    it('rolls back everything when the handler emits no event', async () => {
      const before = await itemCount(f.a.id);
      await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'no-event'),
          createItemCommand({ roomId: f.a.roomId, title: 'silent', emitEvents: false }),
        ),
        'internal_error',
      );
      expect(await itemCount(f.a.id)).toBe(before);
      expect(
        await f.count(`SELECT count(*) AS n FROM commands WHERE idempotency_key = 'no-event'`),
      ).toBe(0);
    });

    it('rolls back when a version bump has no matching event', async () => {
      const created = await runCommand(
        f.ctx(f.a, f.a.executorId, 'bump-create'),
        createItemCommand({ roomId: f.a.roomId, title: 'bump' }),
      );
      const id = created.item_id as Uuid;
      await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'bump-1'),
          retitleCommand({ itemId: id, expectedVersion: 1, title: 'bumped', skipEvent: true }),
        ),
        'internal_error',
      );
      const [row] = await f.db.query<{ version: number; title: string }>(
        'SELECT version, title FROM work_items WHERE id = $1',
        [id],
      );
      expect(row).toEqual({ version: 1, title: 'bump' });
    });
  });

  describe('graph lock', () => {
    it('serializes gated commands per workspace but does not block ungated ones', async () => {
      let releaseFirst: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstEntered: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => (firstEntered = resolve));
      const order: string[] = [];

      const first = runCommand(
        f.ctx(f.a, f.a.executorId, 'gate-1'),
        createItemCommand({
          roomId: f.a.roomId,
          title: 'gate-1',
          gated: true,
          onHandle: async () => {
            order.push('first-in-handler');
            firstEntered();
            await gate;
          },
        }),
      );
      await entered;

      const second = runCommand(
        f.ctx(f.a, f.a.executorId, 'gate-2'),
        createItemCommand({
          roomId: f.a.roomId,
          title: 'gate-2',
          gated: true,
          onHandle: () => void order.push('second-in-handler'),
        }),
      );
      await waitFor(
        async () =>
          (await f.count(
            `SELECT count(*) AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
          )) === 1,
        'the second gated command to wait on the graph lock',
      );

      // An ungated command is not held up by the graph lock.
      await runCommand(
        f.ctx(f.a, f.a.executor2Id, 'ungated'),
        createItemCommand({ roomId: f.a.roomId, title: 'ungated' }),
      );
      // A gated command in another workspace takes a different lock.
      await runCommand(
        f.ctx(f.b, f.b.executorId, 'gate-other-ws'),
        createItemCommand({ roomId: f.b.roomId, title: 'gate-b', gated: true }),
      );
      expect(order).toEqual(['first-in-handler']);

      order.push('release');
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(['first-in-handler', 'release', 'second-in-handler']);
    });
  });

  describe('contention retries', () => {
    const contention = (attempts: { n: number }, failFirst: number) => async () => {
      attempts.n++;
      if (attempts.n <= failFirst) {
        // A real PostgreSQL serialization_failure, as raised by contention.
        await f.pool.query(
          `DO $$ BEGIN RAISE EXCEPTION 'simulated contention' USING ERRCODE = '40001'; END $$`,
        );
      }
    };

    it('retries a serialization failure up to three times with the same key', async () => {
      const attempts = { n: 0 };
      const result = await runCommand(
        f.ctx(f.a, f.a.executorId, 'retry-ok'),
        createItemCommand({
          roomId: f.a.roomId,
          title: 'retried',
          onHandle: contention(attempts, 3),
        }),
      );
      expect(attempts.n).toBe(4);
      expect(result.version).toBe(1);
      expect(await itemCount(f.a.id, 'retried')).toBe(1);
    });

    it('gives up as temporarily_unavailable after the retry budget and leaves nothing behind', async () => {
      const attempts = { n: 0 };
      const error = await expectCode(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'retry-exhausted'),
          createItemCommand({
            roomId: f.a.roomId,
            title: 'exhausted',
            onHandle: contention(attempts, 99),
          }),
        ),
        'temporarily_unavailable',
      );
      expect(error.status).toBe(503);
      expect(attempts.n).toBe(4);
      expect(await itemCount(f.a.id, 'exhausted')).toBe(0);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM commands WHERE idempotency_key = 'retry-exhausted'`,
        ),
      ).toBe(0);
    });

    it('does not retry other database errors', async () => {
      const attempts = { n: 0 };
      const error = await rejection(
        runCommand(
          f.ctx(f.a, f.a.executorId, 'no-retry'),
          createItemCommand({
            roomId: f.a.roomId,
            title: 'no-retry',
            onHandle: async () => {
              attempts.n++;
              await f.pool.query('SELECT 1/0');
            },
          }),
        ),
      );
      expect(isChorusError(error)).toBe(false);
      expect(attempts.n).toBe(1);
    });
  });
});
