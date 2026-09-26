import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hashRequest,
  isChorusError,
  runCommand,
  type ChorusError,
  type ErrorCode,
  type Uuid,
} from '../../src/index.ts';
import {
  createFixture,
  createItemCommand,
  nullResultCommand,
  retitleCommand,
  type Actor,
  type Fixture,
  type SessionSeed,
  type Workspace,
} from '../helpers/fixture.ts';

async function failure(promise: Promise<unknown>): Promise<ChorusError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the command to reject');
    },
    (e: unknown) => e,
  );
  if (!isChorusError(error)) throw error as Error;
  return error;
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<ChorusError> {
  const error = await failure(promise);
  expect(error.code, `expected ${code}, got ${error.code}`).toBe(code);
  return error;
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('runCommand (real PostgreSQL, as chorus_app)', () => {
  let f: Fixture;
  let ws: Workspace;
  let manager: Actor;
  let member: Actor;
  let member2: Actor;
  let outsider: Actor;
  let session: SessionSeed;

  beforeAll(async () => {
    // 24 connections so the 20-way same-key test really contends.
    f = await createFixture({ poolMax: 22 });
    ws = await f.workspace('cmd');
    manager = await f.actor(ws, 'manager');
    session = await f.session(manager);
    member = await f.actor(ws, 'member');
    member2 = await f.actor(ws, 'member2');
    outsider = await f.actor(ws, 'outsider'); // in the room, not in the session
    await f.join(session, member);
    await f.join(session, member2);
  });
  afterAll(async () => {
    await f.close();
  });

  const items = (title?: string) =>
    f.count(
      `SELECT count(*) AS n FROM work_items WHERE workspace_id = $1 AND ($2::text IS NULL OR title = $2)`,
      [ws.id, title ?? null],
    );

  describe('idempotency', () => {
    it('replays the stored response without running the handler again', async () => {
      let handled = 0;
      const ctx = member.ctx('replay-1');
      const spec = () =>
        createItemCommand({ session, title: 'replay', onHandle: () => void (handled += 1) });
      const first = await runCommand(ctx, spec());
      const second = await runCommand(ctx, spec());
      expect(second).toEqual(first);
      expect(handled).toBe(1);
      expect(await items('replay')).toBe(1);
      expect(
        await f.count(`SELECT count(*) AS n FROM commands WHERE idempotency_key = 'replay-1'`),
      ).toBe(1);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM domain_events e JOIN commands c ON c.id = e.command_id WHERE c.idempotency_key = 'replay-1'`,
        ),
      ).toBe(1);
    });

    it('rejects the same key with a different request as idempotency_conflict', async () => {
      const ctx = member.ctx('conflict-1');
      await runCommand(ctx, createItemCommand({ session, title: 'original' }));
      const error = await expectCode(
        runCommand(ctx, createItemCommand({ session, title: 'different' })),
        'idempotency_conflict',
      );
      expect(error.status).toBe(409);
      expect(await items('different')).toBe(0);
    });

    it('scopes keys to the acting actor', async () => {
      const spec = () => createItemCommand({ session, title: 'scoped' });
      const one = await runCommand(member.ctx('shared-key'), spec());
      const two = await runCommand(member2.ctx('shared-key'), spec());
      expect(one.item_id).not.toBe(two.item_id);
    });

    it('sessions.idempotency.scope: the same key is valid in two sessions; conflicting reuse within one is not', async () => {
      const other = await f.session(manager);
      await f.join(other, member);
      const a = await runCommand(
        member.ctx('scope-key'),
        createItemCommand({ session, title: 'in-a' }),
      );
      const b = await runCommand(
        member.ctx('scope-key'),
        createItemCommand({ session: other, title: 'in-b' }),
      );
      expect(a.item_id).not.toBe(b.item_id);
      // Within a session the same key + a different request conflicts...
      await expectCode(
        runCommand(member.ctx('scope-key'), createItemCommand({ session, title: 'in-a-changed' })),
        'idempotency_conflict',
      );
      // ...and the same key + the same request replays.
      expect(
        await runCommand(
          member.ctx('scope-key'),
          createItemCommand({ session: other, title: 'in-b' }),
        ),
      ).toEqual(b);
      expect(
        await f.count(`SELECT count(*) AS n FROM commands WHERE idempotency_key = 'scope-key'`),
      ).toBe(2);
    });

    it('runs the handler once for 20 concurrent calls with the same key', async () => {
      let handled = 0;
      const ctx = member.ctx('concurrent-1');
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          runCommand(
            ctx,
            createItemCommand({
              session,
              title: 'concurrent',
              onHandle: () => void (handled += 1),
            }),
          ),
        ),
      );
      expect(handled).toBe(1);
      expect(new Set(results.map((r) => r.item_id)).size).toBe(1);
      expect(await items('concurrent')).toBe(1);
      expect(
        await f.count(`SELECT count(*) AS n FROM commands WHERE idempotency_key = 'concurrent-1'`),
      ).toBe(1);
    });

    it('leaves no command record after a failure, so the same key can be retried', async () => {
      const ctx = member.ctx('retry-after-failure');
      await expectCode(
        runCommand(ctx, createItemCommand({ session, title: 'failing', action: 'complete' })),
        'action_forbidden',
      );
      expect(
        await f.count(
          `SELECT count(*) AS n FROM commands WHERE idempotency_key = 'retry-after-failure'`,
        ),
      ).toBe(0);
      const ok = await runCommand(ctx, createItemCommand({ session, title: 'after-failure' }));
      expect(ok.version).toBe(1);
    });

    it('requires a well-formed key', async () => {
      const spec = createItemCommand({ session, title: 'nokey' });
      const missing = await expectCode(
        runCommand(f.ctxFor(ws, member.id, undefined, member.instanceId), spec),
        'precondition_required',
      );
      expect(missing.status).toBe(428);
      await expectCode(
        runCommand({ ...member.ctx('x'), idempotencyKey: '' }, spec),
        'precondition_required',
      );
      await expectCode(runCommand(member.ctx('has space'), spec), 'invalid_request');
      expect(await items('nokey')).toBe(0);
    });
  });

  describe('versions', () => {
    it('applies a change at the expected version and bumps it with a matching event', async () => {
      const created = await runCommand(
        member.ctx('v-create'),
        createItemCommand({ session, title: 'versioned' }),
      );
      const id = created.item_id as Uuid;
      const updated = await runCommand(
        member.ctx('v-update-1'),
        retitleCommand({ session, itemId: id, expectedVersion: 1, title: 'versioned-2' }),
      );
      expect(updated.version).toBe(2);
      const events = await f.owner<{
        aggregate_version: number;
        event_type: string;
        session_id: string;
      }>(
        'SELECT aggregate_version, event_type, session_id FROM domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version',
        [id],
      );
      expect(events.map((e) => [e.event_type, e.aggregate_version])).toEqual([
        ['task.created', 1],
        ['task.retitled', 2],
      ]);
      expect(events.every((e) => e.session_id === session.id)).toBe(true);
    });

    it('returns version_conflict with the current version for a stale expectation', async () => {
      const created = await runCommand(
        member.ctx('vc-create'),
        createItemCommand({ session, title: 'stale' }),
      );
      const id = created.item_id as Uuid;
      await runCommand(
        member.ctx('vc-1'),
        retitleCommand({ session, itemId: id, expectedVersion: 1, title: 'stale-2' }),
      );
      const error = await expectCode(
        runCommand(
          member.ctx('vc-2'),
          retitleCommand({ session, itemId: id, expectedVersion: 1, title: 'stale-3' }),
        ),
        'version_conflict',
      );
      expect(error.status).toBe(409);
      expect(error.details).toMatchObject({ current_version: 2 });
    });

    it('returns precondition_required when the expected version is missing', async () => {
      const created = await runCommand(
        member.ctx('pr-create'),
        createItemCommand({ session, title: 'unversioned' }),
      );
      const error = await expectCode(
        runCommand(
          member.ctx('pr-1'),
          retitleCommand({
            session,
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
        member.ctx('race-create'),
        createItemCommand({ session, title: 'race' }),
      );
      const id = created.item_id as Uuid;
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runCommand(
            member.ctx(`race-${String(i)}`),
            retitleCommand({ session, itemId: id, expectedVersion: 1, title: `race-${String(i)}` }),
          ).then(
            () => 'won' as const,
            (error: unknown) => (isChorusError(error, 'version_conflict') ? 'lost' : error),
          ),
        ),
      );
      expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'lost')).toHaveLength(9);
    });
  });

  describe('session membership is the visibility and authorization boundary', () => {
    it('returns not_found for a room member who is not in the session, and 404 (not 403) even with a valid action', async () => {
      const error = await expectCode(
        runCommand(outsider.ctx('authz-1'), createItemCommand({ session, title: 'nope' })),
        'not_found',
      );
      expect(error.status).toBe(404);
      expect(await items('nope')).toBe(0);
    });

    it("returns not_found for another workspace's session and for a session that does not exist", async () => {
      const ws2 = await f.workspace('cmd-other');
      const other = await f.actor(ws2, 'other-manager');
      const foreign = await f.session(other);
      await expectCode(
        runCommand(member.ctx('authz-2'), createItemCommand({ session: foreign, title: 'cross' })),
        'not_found',
      );
      await expectCode(
        runCommand(
          member.ctx('authz-3'),
          createItemCommand({
            session: { ...session, id: '00000000-0000-4000-8000-000000000000' as Uuid },
            title: 'ghost',
          }),
        ),
        'not_found',
      );
    });

    it('returns not_found for an item that lives in a different session, even if the actor belongs to both', async () => {
      const a = await f.session(manager);
      const b = await f.session(manager);
      await f.join(a, member);
      await f.join(b, member);
      const created = await runCommand(
        member.ctx('xs-create'),
        createItemCommand({ session: a, title: 'in a' }),
      );
      // Addressing A's item through session B is a session mismatch.
      await expectCode(
        runCommand(
          member.ctx('xs-1'),
          retitleCommand({
            session: b,
            itemId: created.item_id as Uuid,
            expectedVersion: 1,
            title: 'x',
          }),
        ),
        'not_found',
      );
    });

    it('returns action_forbidden (403) when the actor is a member but its roles lack the action', async () => {
      const error = await expectCode(
        runCommand(
          member.ctx('forbidden-1'),
          createItemCommand({ session, title: 'x', action: 'complete' }),
        ),
        'action_forbidden',
      );
      expect(error.status).toBe(403);
      expect(error.details).toMatchObject({ reason: 'role', action: 'complete' });
      // A manager holds it.
      await runCommand(
        manager.ctx('forbidden-2'),
        createItemCommand({ session, title: 'by manager', action: 'complete' }),
      );
    });

    it('takes effect immediately when a member is removed, and again on re-admission', async () => {
      const temp = await f.actor(ws, 'temp');
      await f.join(session, temp);
      const ok = (key: string) =>
        runCommand(temp.ctx(key), createItemCommand({ session, title: 'revocable' }));
      await ok('revoke-1');
      await f.owner(
        'UPDATE session_members SET removed_at = now() WHERE session_id = $1 AND actor_id = $2',
        [session.id, temp.id],
      );
      await expectCode(ok('revoke-2'), 'not_found');
      await f.join(session, temp);
      await ok('revoke-3');
    });

    it('rejects an actor that does not exist in the workspace as unauthenticated', async () => {
      const ws2 = await f.workspace('cmd-unknown');
      const stranger = await f.actor(ws2, 'stranger');
      await expectCode(
        runCommand(
          { ...stranger.ctx('unknown-actor'), workspaceId: ws.id },
          createItemCommand({ session, title: 'x' }),
        ),
        'unauthenticated',
      );
    });
  });

  describe('idempotent replay re-authorizes against the CURRENT session membership and roles', () => {
    it('does not return the stored response once membership is gone, and does not re-run the handler', async () => {
      const actor = await f.actor(ws, 'replayer');
      await f.join(session, actor);
      let handled = 0;
      const ctx = actor.ctx('replay-authz-create');
      const spec = () =>
        createItemCommand({ session, title: 'protected', onHandle: () => void (handled += 1) });
      const first = await runCommand(ctx, spec());
      await f.owner(
        'UPDATE session_members SET removed_at = now() WHERE session_id = $1 AND actor_id = $2',
        [session.id, actor.id],
      );

      const error = await expectCode(runCommand(ctx, spec()), 'not_found');
      expect(JSON.stringify(error)).not.toContain(first.item_id);
      expect(handled).toBe(1);
      // Restoring access restores the original answer; nothing was re-executed meanwhile.
      await f.join(session, actor);
      expect(await runCommand(ctx, spec())).toEqual(first);
      expect(handled).toBe(1);
    });

    it('applies the same check to commands that target an existing item', async () => {
      const actor = await f.actor(ws, 'replayer2');
      await f.join(session, actor);
      const created = await runCommand(
        member.ctx('replay-target-create'),
        createItemCommand({ session, title: 'target' }),
      );
      const id = created.item_id as Uuid;
      const ctx = actor.ctx('replay-target-1');
      const spec = () =>
        retitleCommand({ session, itemId: id, expectedVersion: 1, title: 'target-2' });
      const first = await runCommand(ctx, spec());
      await runCommand(
        member.ctx('replay-target-2'),
        retitleCommand({ session, itemId: id, expectedVersion: 2, title: 'target-3' }),
      );
      expect(await runCommand(ctx, spec())).toEqual(first);
      await f.owner(
        'UPDATE session_members SET removed_at = now() WHERE session_id = $1 AND actor_id = $2',
        [session.id, actor.id],
      );
      await expectCode(runCommand(ctx, spec()), 'not_found');
    });

    it('returns action_forbidden on replay when the actor stayed a member but lost the role', async () => {
      const actor = await f.actor(ws, 'replayer3');
      await f.join(session, actor, ['participant', 'manager']);
      const ctx = actor.ctx('replay-forbidden');
      const spec = () => createItemCommand({ session, title: 'role-loss', action: 'complete' });
      await runCommand(ctx, spec());
      await f.join(session, actor, ['participant']);
      await expectCode(runCommand(ctx, spec()), 'action_forbidden');
    });
  });

  describe('journal', () => {
    it('writes a commands row and at least one domain event for every successful command', async () => {
      const keys = ['journal-1', 'journal-2', 'journal-3'];
      const created = await runCommand(
        member.ctx(keys[0] ?? ''),
        createItemCommand({ session, title: 'journal-a' }),
      );
      await runCommand(
        member.ctx(keys[1] ?? ''),
        retitleCommand({
          session,
          itemId: created.item_id as Uuid,
          expectedVersion: 1,
          title: 'journal-b',
        }),
      );
      await runCommand(
        member2.ctx(keys[2] ?? ''),
        createItemCommand({ session, title: 'journal-c' }),
      );
      const rows = await f.owner<{
        idempotency_key: string;
        status: string;
        events: string;
        session_id: string;
      }>(
        `SELECT c.idempotency_key, c.status, count(e.id) AS events, c.session_id
           FROM commands c LEFT JOIN domain_events e ON e.command_id = c.id
          WHERE c.idempotency_key = ANY($1::text[]) GROUP BY c.id, c.idempotency_key, c.status, c.session_id`,
        [keys],
      );
      expect(rows.map((r) => r.idempotency_key).sort()).toEqual(keys);
      expect(
        rows.every(
          (r) => r.status === 'succeeded' && Number(r.events) >= 1 && r.session_id === session.id,
        ),
      ).toBe(true);
    });

    it("refuses to journal an event under a room other than its aggregate's room", async () => {
      const other = await f.addRoom(ws, 'journal-other-room');
      const before = await items();
      await expectCode(
        runCommand(
          member.ctx('event-room-mismatch'),
          createItemCommand({ session, title: 'leaky', eventRoomId: other.roomId }),
        ),
        'internal_error',
      );
      expect(await items()).toBe(before);
      expect(
        await f.count(
          `SELECT count(*) AS n FROM commands WHERE idempotency_key = 'event-room-mismatch'`,
        ),
      ).toBe(0);
    });

    it('rejects a handler result of null and persists nothing', async () => {
      let handled = 0;
      await expectCode(
        runCommand(
          member.ctx('null-result'),
          nullResultCommand({ session, onHandle: () => void (handled += 1) }),
        ),
        'internal_error',
      );
      expect(handled).toBe(1);
      expect(await items('null-result')).toBe(0);
      expect(
        await f.count(`SELECT count(*) AS n FROM commands WHERE idempotency_key = 'null-result'`),
      ).toBe(0);
    });

    it('never runs the handler again when a command row exists that is not a succeeded replay', async () => {
      let handled = 0;
      const spec = () =>
        createItemCommand({ session, title: 'stuck', onHandle: () => void (handled += 1) });
      await f.owner(
        `INSERT INTO commands (workspace_id, actor_id, idempotency_key, request_hash, command_type, status, scope_key)
         VALUES ($1, $2, 'stuck-row', $3, 'test.create_item', 'in_progress', $4)`,
        [ws.id, member.id, hashRequest(spec()), session.id],
      );
      await expectCode(runCommand(member.ctx('stuck-row'), spec()), 'internal_error');
      expect(handled).toBe(0);
      expect(await items('stuck')).toBe(0);
    });

    it('rolls back everything when the handler emits no event, or a version bump has no matching event', async () => {
      const before = await items();
      await expectCode(
        runCommand(
          member.ctx('no-event'),
          createItemCommand({ session, title: 'silent', emitEvents: false }),
        ),
        'internal_error',
      );
      expect(await items()).toBe(before);
      const created = await runCommand(
        member.ctx('bump-create'),
        createItemCommand({ session, title: 'bump' }),
      );
      await expectCode(
        runCommand(
          member.ctx('bump-1'),
          retitleCommand({
            session,
            itemId: created.item_id as Uuid,
            expectedVersion: 1,
            title: 'bumped',
            skipEvent: true,
          }),
        ),
        'internal_error',
      );
      const [row] = await f.owner<{ version: number; title: string }>(
        'SELECT version, title FROM work_items WHERE id = $1',
        [created.item_id],
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
        member.ctx('gate-1'),
        createItemCommand({
          session,
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
        member.ctx('gate-2'),
        createItemCommand({
          session,
          title: 'gate-2',
          gated: true,
          onHandle: () => void order.push('second-in-handler'),
        }),
      );
      await waitFor(
        async () =>
          (await f.count(
            `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
          )) === 1,
        'the second gated command to wait on the graph lock',
      );
      await runCommand(member2.ctx('ungated'), createItemCommand({ session, title: 'ungated' }));
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
        await f.pool.query(
          `DO $$ BEGIN RAISE EXCEPTION 'simulated contention' USING ERRCODE = '40001'; END $$`,
        );
      }
    };

    it('retries a serialization failure up to three times with the same key', async () => {
      const attempts = { n: 0 };
      const result = await runCommand(
        member.ctx('retry-ok'),
        createItemCommand({ session, title: 'retried', onHandle: contention(attempts, 3) }),
      );
      expect(attempts.n).toBe(4);
      expect(result.version).toBe(1);
      expect(await items('retried')).toBe(1);
    });

    it('gives up as temporarily_unavailable after the retry budget and leaves nothing behind', async () => {
      const attempts = { n: 0 };
      const error = await expectCode(
        runCommand(
          member.ctx('retry-exhausted'),
          createItemCommand({ session, title: 'exhausted', onHandle: contention(attempts, 99) }),
        ),
        'temporarily_unavailable',
      );
      expect(error.status).toBe(503);
      expect(attempts.n).toBe(4);
      expect(await items('exhausted')).toBe(0);
    });

    it('does not retry other database errors', async () => {
      const attempts = { n: 0 };
      const error = await failure2(
        runCommand(
          member.ctx('no-retry'),
          createItemCommand({
            session,
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

async function failure2(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the command to reject');
    },
    (e: unknown) => e,
  );
}
