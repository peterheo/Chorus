import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedEphemeralDatabase, type EphemeralDatabase } from '../../src/testing.ts';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

interface Tenant {
  workspaceId: string;
  actorId: string;
  otherActorId: string;
  roomId: string;
}

// The schema is exercised as the database owner: these tests assert table constraints and triggers,
// which hold regardless of role. The command layer's tenant checks are tested in packages/domain.
describe('core schema constraints (real PostgreSQL)', () => {
  let db: EphemeralDatabase;
  let a: Tenant;
  let b: Tenant;

  const one = async (sql: string, params: unknown[] = []) => {
    const [row] = await db.query<{ id: string }>(sql, params);
    if (row === undefined) throw new Error('expected a row');
    return row.id;
  };

  async function seedTenant(name: string): Promise<Tenant> {
    const workspaceId = await one('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [name]);
    const actorId = await one(
      `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'agent', 'a') RETURNING id`,
      [workspaceId],
    );
    const otherActorId = await one(
      `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'human', 'b') RETURNING id`,
      [workspaceId],
    );
    const roomId = await one(
      'INSERT INTO rooms (workspace_id, name) VALUES ($1, $2) RETURNING id',
      [workspaceId, 'room'],
    );
    return { workspaceId, actorId, otherActorId, roomId };
  }

  const newItem = (t: Tenant, kind: 'task' | 'review' = 'task', state = 'ready') =>
    one(
      `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, $2, $3, 't', $4, $5) RETURNING id`,
      [t.workspaceId, kind, t.roomId, state, t.actorId],
    );

  const newRevision = async (t: Tenant, taskId: string, content: string, revision = 1) => {
    await db.query(
      `INSERT INTO task_result_revisions
         (workspace_id, task_id, revision, content, content_sha256, submitted_by, fence)
       VALUES ($1, $2, $3, $4, $5, $6, 1)`,
      [t.workspaceId, taskId, revision, content, sha256(content), t.actorId],
    );
  };

  beforeAll(async () => {
    db = await createMigratedEphemeralDatabase();
    a = await seedTenant('a');
    b = await seedTenant('b');
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('tenant isolation via composite foreign keys', () => {
    it('rejects a room grant that pairs an actor and a room from different workspaces', async () => {
      await expect(
        db.query(
          `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'executor')`,
          [a.workspaceId, a.actorId, b.roomId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('rejects a work item whose room or creator belongs to another workspace', async () => {
      await expect(
        db.query(
          `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
           VALUES ($1, 'task', $2, 't', 'ready', $3)`,
          [a.workspaceId, b.roomId, a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        db.query(
          `INSERT INTO work_items (workspace_id, kind, home_room_id, title, state, creator_actor_id)
           VALUES ($1, 'task', $2, 't', 'ready', $3)`,
          [a.workspaceId, a.roomId, b.actorId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('allows at most one live grant per actor, room and role, but a revoked one may be re-granted', async () => {
      const grant = `INSERT INTO room_grants (workspace_id, actor_id, room_id, role) VALUES ($1, $2, $3, 'reviewer')`;
      const args = [a.workspaceId, a.otherActorId, a.roomId];
      await db.query(grant, args);
      await expect(db.query(grant, args)).rejects.toMatchObject({ code: '23505' });
      await db.query(
        `UPDATE room_grants SET revoked_at = now() WHERE workspace_id = $1 AND actor_id = $2`,
        [a.workspaceId, a.otherActorId],
      );
      await db.query(grant, args);
    });
  });

  describe('work items and details', () => {
    it('restricts state values per kind', async () => {
      await expect(newItem(a, 'task', 'approved')).rejects.toMatchObject({ code: '23514' });
      await expect(newItem(a, 'review', 'in_progress')).rejects.toMatchObject({ code: '23514' });
      await newItem(a, 'review', 'requested');
    });

    it('requires a non-empty acceptance criteria array', async () => {
      const id = await newItem(a);
      const insert = (criteria: string) =>
        db.query(
          `INSERT INTO task_details (workspace_id, item_id, acceptance_criteria) VALUES ($1, $2, $3::jsonb)`,
          [a.workspaceId, id, criteria],
        );
      await expect(insert('[]')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('{"a":1}')).rejects.toMatchObject({ code: '23514' });
      await insert('["it works"]');
    });

    it('cannot attach task details to a review item', async () => {
      const review = await newItem(a, 'review', 'requested');
      await expect(
        db.query(
          `INSERT INTO task_details (workspace_id, item_id, acceptance_criteria) VALUES ($1, $2, '["x"]')`,
          [a.workspaceId, review],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('task leases', () => {
    it('never lets the fence decrease and never deletes a lease', async () => {
      const id = await newItem(a);
      await db.query('INSERT INTO task_leases (workspace_id, task_id, fence) VALUES ($1, $2, 3)', [
        a.workspaceId,
        id,
      ]);
      await db.query('UPDATE task_leases SET fence = 4 WHERE task_id = $1', [id]);
      await expect(
        db.query('UPDATE task_leases SET fence = 2 WHERE task_id = $1', [id]),
      ).rejects.toMatchObject({ code: '23000' });
      await expect(
        db.query('DELETE FROM task_leases WHERE task_id = $1', [id]),
      ).rejects.toMatchObject({ code: '23000' });
      const rows = await db.query<{ fence: string }>(
        'SELECT fence FROM task_leases WHERE task_id = $1',
        [id],
      );
      expect(rows[0]?.fence).toBe('4');
    });
  });

  describe('result revisions', () => {
    it('stores the exact bytes and rejects a digest that does not match them', async () => {
      const id = await newItem(a);
      await newRevision(a, id, 'héllo — snapshot');
      await expect(
        db.query(
          `INSERT INTO task_result_revisions
             (workspace_id, task_id, revision, content, content_sha256, submitted_by, fence)
           VALUES ($1, $2, 2, 'real bytes', $3, $4, 1)`,
          [a.workspaceId, id, sha256('other bytes'), a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('raises on UPDATE, DELETE and TRUNCATE', async () => {
      const id = await newItem(a);
      await newRevision(a, id, 'immutable');
      await expect(
        db.query(`UPDATE task_result_revisions SET content_type = 'x' WHERE task_id = $1`, [id]),
      ).rejects.toMatchObject({ code: '23000' });
      await expect(
        db.query('DELETE FROM task_result_revisions WHERE task_id = $1', [id]),
      ).rejects.toMatchObject({ code: '23000' });
      // CASCADE gets past the foreign-key guard so the TRUNCATE trigger itself is what stops it.
      await expect(db.query('TRUNCATE task_result_revisions CASCADE')).rejects.toMatchObject({
        code: '23000',
      });
    });

    it('keeps revision numbers unique per task', async () => {
      const id = await newItem(a);
      await newRevision(a, id, 'one');
      await expect(newRevision(a, id, 'two', 1)).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('reviews bind to a revision and its digest', () => {
    it('accepts a matching (task, revision, digest) and rejects a mismatched digest', async () => {
      const task = await newItem(a);
      await newRevision(a, task, 'result bytes');
      const review = await newItem(a, 'review', 'requested');
      const insert = (digest: string, revision = 1) =>
        db.query(
          `INSERT INTO review_details
             (workspace_id, review_item_id, subject_task_id, result_revision, content_sha256, criteria)
           VALUES ($1, $2, $3, $4, $5, '["c"]')`,
          [a.workspaceId, review, task, revision, digest],
        );
      await expect(insert(sha256('stale bytes'))).rejects.toMatchObject({ code: '23503' });
      await expect(insert(sha256('result bytes'), 2)).rejects.toMatchObject({ code: '23503' });
      await insert(sha256('result bytes'));
    });

    it('requires verdict and verdict_at together', async () => {
      const task = await newItem(a);
      await newRevision(a, task, 'v');
      const review = await newItem(a, 'review', 'requested');
      await expect(
        db.query(
          `INSERT INTO review_details
             (workspace_id, review_item_id, subject_task_id, result_revision, content_sha256, criteria, verdict)
           VALUES ($1, $2, $3, 1, $4, '[]', 'approved')`,
          [a.workspaceId, review, task, sha256('v')],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('cannot reference a revision of a task in another workspace', async () => {
      const task = await newItem(a);
      await newRevision(a, task, 'tenant a bytes');
      const review = await newItem(b, 'review', 'requested');
      await expect(
        db.query(
          `INSERT INTO review_details
             (workspace_id, review_item_id, subject_task_id, result_revision, content_sha256, criteria)
           VALUES ($1, $2, $3, 1, $4, '[]')`,
          [b.workspaceId, review, task, sha256('tenant a bytes')],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('idempotency records and the event journal', () => {
    it('keeps (workspace, actor, key) unique and ties response to status', async () => {
      const insert = (status: string, response: string | null) =>
        db.query(
          `INSERT INTO commands (workspace_id, actor_id, idempotency_key, request_hash, command_type, status, response)
           VALUES ($1, $2, 'k1', $3, 'test', $4, $5::jsonb)`,
          [a.workspaceId, a.actorId, sha256('x'), status, response],
        );
      await expect(insert('succeeded', null)).rejects.toMatchObject({ code: '23514' });
      await insert('succeeded', '{"ok":true}');
      await expect(insert('succeeded', '{"ok":true}')).rejects.toMatchObject({ code: '23505' });
    });

    it('makes domain events append-only', async () => {
      const commandId = await one(
        `INSERT INTO commands (workspace_id, actor_id, idempotency_key, request_hash, command_type, status, response)
         VALUES ($1, $2, 'k-events', $3, 'test', 'succeeded', '{}') RETURNING id`,
        [a.workspaceId, a.actorId, sha256('y')],
      );
      const eventId = await one(
        `INSERT INTO domain_events (workspace_id, room_id, aggregate_id, aggregate_version, event_type, actor_id, command_id)
         VALUES ($1, $2, gen_random_uuid(), 1, 'test.happened', $3, $4) RETURNING id`,
        [a.workspaceId, a.roomId, a.actorId, commandId],
      );
      await expect(
        db.query(`UPDATE domain_events SET event_type = 'x' WHERE id = $1`, [eventId]),
      ).rejects.toMatchObject({ code: '23000' });
      await expect(
        db.query('DELETE FROM domain_events WHERE id = $1', [eventId]),
      ).rejects.toMatchObject({ code: '23000' });
    });
  });

  describe('credentials and invites', () => {
    it('stores only a well-formed sha256 for tokens and invite codes', async () => {
      await expect(
        db.query(
          `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256) VALUES ($1, $2, 'plaintext-token')`,
          [a.workspaceId, a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await db.query(
        `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256) VALUES ($1, $2, $3)`,
        [a.workspaceId, a.actorId, sha256('secret')],
      );
    });

    it('marks an invite used only together with the actor it created', async () => {
      await expect(
        db.query(
          `INSERT INTO invites (workspace_id, room_id, role, code_sha256, expires_at, used_at)
           VALUES ($1, $2, 'executor', $3, now() + interval '1 hour', now())`,
          [a.workspaceId, a.roomId, sha256('code')],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
