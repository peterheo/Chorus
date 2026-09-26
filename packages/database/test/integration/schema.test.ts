import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedEphemeralDatabase, type EphemeralDatabase } from '../../src/testing.ts';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

interface Tenant {
  workspaceId: string;
  actorId: string;
  humanId: string;
  roomId: string;
  sessionId: string;
  boardId: string;
}

// The schema is exercised as the database owner: these tests assert table constraints and triggers,
// which hold regardless of role. Row-level security and the command layer are tested in packages/domain.
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
    const humanId = await one(
      `INSERT INTO actors (workspace_id, kind, display_name) VALUES ($1, 'human', 'h') RETURNING id`,
      [workspaceId],
    );
    const roomId = await one(
      `INSERT INTO rooms (workspace_id, name) VALUES ($1, 'room') RETURNING id`,
      [workspaceId],
    );
    const sessionId = await one(
      `INSERT INTO sessions (workspace_id, room_id, name, created_by) VALUES ($1, $2, 's', $3) RETURNING id`,
      [workspaceId, roomId, actorId],
    );
    const boardId = await one(
      'INSERT INTO projects (workspace_id, session_id, name) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId, sessionId, 'board'],
    );
    return { workspaceId, actorId, humanId, roomId, sessionId, boardId };
  }

  const newItem = (
    t: Tenant,
    kind: 'task' | 'review' | 'question' | 'finding' | 'proposal' = 'task',
    state = 'ready',
  ) =>
    one(
      `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
       VALUES ($1, $2, $3, $4, $5, 't', $6, $7) RETURNING id`,
      [t.workspaceId, t.sessionId, t.boardId, kind, t.roomId, state, t.actorId],
    );

  const newRevision = (
    t: Tenant,
    taskId: string,
    content: string,
    revision = 1,
    session = t.sessionId,
  ) =>
    db.query(
      `INSERT INTO task_result_revisions
         (workspace_id, session_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [
        t.workspaceId,
        session,
        taskId,
        revision,
        content,
        sha256(content),
        Buffer.byteLength(content),
        t.actorId,
      ],
    );

  beforeAll(async () => {
    db = await createMigratedEphemeralDatabase();
    a = await seedTenant('a');
    b = await seedTenant('b');
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('tenant isolation via composite foreign keys', () => {
    it('rejects membership pairing an actor and a session from different workspaces', async () => {
      await expect(
        db.query(
          `INSERT INTO session_members (workspace_id, session_id, actor_id, roles) VALUES ($1, $2, $3, ARRAY['participant'])`,
          [a.workspaceId, b.sessionId, a.humanId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        db.query(`INSERT INTO room_members (workspace_id, room_id, actor_id) VALUES ($1, $2, $3)`, [
          a.workspaceId,
          b.roomId,
          a.actorId,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('rejects a work item whose session, board, room or creator belongs to another workspace', async () => {
      const insert = (session: string, board: string, room: string, creator: string) =>
        db.query(
          `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
           VALUES ($1, $2, $3, 'task', $4, 't', 'ready', $5)`,
          [a.workspaceId, session, board, room, creator],
        );
      await expect(insert(b.sessionId, a.boardId, a.roomId, a.actorId)).rejects.toMatchObject({
        code: '23503',
      });
      await expect(insert(a.sessionId, b.boardId, a.roomId, a.actorId)).rejects.toMatchObject({
        code: '23503',
      });
      await expect(insert(a.sessionId, a.boardId, b.roomId, a.actorId)).rejects.toMatchObject({
        code: '23503',
      });
      await expect(insert(a.sessionId, a.boardId, a.roomId, b.actorId)).rejects.toMatchObject({
        code: '23503',
      });
    });

    it('keeps a board, its items and its children in ONE session', async () => {
      const second = await one(
        `INSERT INTO sessions (workspace_id, room_id, name, created_by) VALUES ($1, $2, 's2', $3) RETURNING id`,
        [a.workspaceId, a.roomId, a.actorId],
      );
      // A session's item cannot sit on another session's board.
      await expect(
        db.query(
          `INSERT INTO work_items (workspace_id, session_id, board_id, kind, home_room_id, title, state, creator_actor_id)
           VALUES ($1, $2, $3, 'task', $4, 't', 'ready', $5)`,
          [a.workspaceId, second, a.boardId, a.roomId, a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      // A child row cannot claim a different session than its item.
      const task = await newItem(a);
      await expect(newRevision(a, task, 'x', 1, second)).rejects.toMatchObject({ code: '23503' });
      await expect(
        db.query(
          `INSERT INTO comments (workspace_id, session_id, item_id, author_actor_id, body) VALUES ($1, $2, $3, $4, 'hi')`,
          [a.workspaceId, second, task, a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('requires participant in every membership role set and only known roles', async () => {
      const m = (roles: string) =>
        db.query(
          `INSERT INTO session_members (workspace_id, session_id, actor_id, roles) VALUES ($1, $2, $3, $4::text[])`,
          [a.workspaceId, a.sessionId, a.humanId, roles],
        );
      await expect(m('{manager}')).rejects.toMatchObject({ code: '23514' });
      await expect(m('{participant,superuser}')).rejects.toMatchObject({ code: '23514' });
      await m('{participant,manager,administrator}');
    });
  });

  describe('room binding', () => {
    it('ties provider and external_room_id together and binds a SharedNet room once', async () => {
      await expect(
        db.query(`INSERT INTO rooms (workspace_id, name, provider) VALUES ($1, 'x', 'sharednet')`, [
          a.workspaceId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `INSERT INTO rooms (workspace_id, name, external_room_id) VALUES ($1, 'x', 'rom_abcdef123')`,
          [a.workspaceId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `INSERT INTO rooms (workspace_id, name, provider, external_room_id) VALUES ($1, 'x', 'sharednet', 'bad')`,
          [a.workspaceId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const bind = (ws: string) =>
        db.query(
          `INSERT INTO rooms (workspace_id, name, provider, external_room_id, activation_state) VALUES ($1, 'x', 'sharednet', 'rom_Unique0001', 'active')`,
          [ws],
        );
      await bind(a.workspaceId);
      await expect(bind(b.workspaceId)).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('work items and details', () => {
    it('restricts state values per kind', async () => {
      await expect(newItem(a, 'task', 'approved')).rejects.toMatchObject({ code: '23514' });
      await expect(newItem(a, 'task', 'backlog')).rejects.toMatchObject({ code: '23514' });
      await expect(newItem(a, 'review', 'in_progress')).rejects.toMatchObject({ code: '23514' });
      await expect(newItem(a, 'question', 'done')).rejects.toMatchObject({ code: '23514' });
      for (const [kind, state] of [
        ['review', 'requested'],
        ['review', 'cancelled'],
        ['question', 'open'],
        ['finding', 'recorded'],
        ['proposal', 'open'],
        ['task', 'cancelled'],
      ] as const) {
        await newItem(a, kind, state);
      }
    });

    it('requires a non-empty acceptance criteria array, in details and in revisions', async () => {
      const id = await newItem(a);
      const insert = (criteria: string) =>
        db.query(
          `INSERT INTO task_details (workspace_id, session_id, item_id, acceptance_criteria) VALUES ($1, $2, $3, $4::jsonb)`,
          [a.workspaceId, a.sessionId, id, criteria],
        );
      await expect(insert('[]')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('{"a":1}')).rejects.toMatchObject({ code: '23514' });
      await insert('["it works"]');
      await expect(
        db.query(
          `INSERT INTO task_criteria_revisions (workspace_id, session_id, task_id, criteria_revision, acceptance_criteria, created_by) VALUES ($1, $2, $3, 1, '[]', $4)`,
          [a.workspaceId, a.sessionId, id, a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('cannot attach task details to a review item', async () => {
      const review = await newItem(a, 'review', 'requested');
      await expect(
        db.query(
          `INSERT INTO task_details (workspace_id, session_id, item_id, acceptance_criteria) VALUES ($1, $2, $3, '["x"]')`,
          [a.workspaceId, a.sessionId, review],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('keeps criteria revisions, comments and message links immutable', async () => {
      const task = await newItem(a);
      await db.query(
        `INSERT INTO task_criteria_revisions (workspace_id, session_id, task_id, criteria_revision, acceptance_criteria, created_by) VALUES ($1, $2, $3, 1, '["c"]', $4)`,
        [a.workspaceId, a.sessionId, task, a.actorId],
      );
      await db.query(
        `INSERT INTO comments (workspace_id, session_id, item_id, author_actor_id, body) VALUES ($1, $2, $3, $4, 'hello')`,
        [a.workspaceId, a.sessionId, task, a.actorId],
      );
      await db.query(
        `INSERT INTO message_links (workspace_id, session_id, item_id, sharednet_message_id, sharednet_sequence, sender_principal_id, sender_member_id, content_snapshot, content_sha256, linked_by)
         VALUES ($1, $2, $3, 'msg_1', 4, 'p_abcdef1', 'i_abcdef1', 'text', $4, $5)`,
        [a.workspaceId, a.sessionId, task, sha256('text'), a.actorId],
      );
      for (const table of ['task_criteria_revisions', 'comments', 'message_links']) {
        await expect(
          db.query(
            `UPDATE ${table} SET created_by = created_by`.replace(
              'created_by = created_by',
              table === 'comments'
                ? "body = 'x'"
                : table === 'message_links'
                  ? "content_snapshot = 'x'"
                  : 'criteria_revision = 1',
            ),
          ),
          table,
        ).rejects.toMatchObject({ code: '23000' });
        await expect(db.query(`DELETE FROM ${table}`), table).rejects.toMatchObject({
          code: '23000',
        });
      }
      // The same message can be linked to an item only once per session.
      await expect(
        db.query(
          `INSERT INTO message_links (workspace_id, session_id, item_id, sharednet_message_id, sharednet_sequence, sender_principal_id, sender_member_id, content_snapshot, content_sha256, linked_by)
           VALUES ($1, $2, $3, 'msg_1', 4, 'p_abcdef1', 'i_abcdef1', 'text', $4, $5)`,
          [a.workspaceId, a.sessionId, task, sha256('text'), a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('task leases', () => {
    it('never lets the fence decrease and never deletes a lease', async () => {
      const id = await newItem(a);
      await db.query(
        'INSERT INTO task_leases (workspace_id, session_id, task_id, fence) VALUES ($1, $2, $3, 3)',
        [a.workspaceId, a.sessionId, id],
      );
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
          `INSERT INTO task_result_revisions (workspace_id, session_id, task_id, revision, content, content_sha256, byte_length, submitted_by, fence)
           VALUES ($1, $2, $3, 2, 'real bytes', $4, 10, $5, 1)`,
          [a.workspaceId, a.sessionId, id, sha256('other bytes'), a.actorId],
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
    const insertReview = (t: Tenant, review: string, task: string, digest: string, revision = 1) =>
      db.query(
        `INSERT INTO review_details (workspace_id, session_id, review_item_id, subject_task_id, result_revision, content_sha256, criteria)
         VALUES ($1, $2, $3, $4, $5, $6, '["c"]')`,
        [t.workspaceId, t.sessionId, review, task, revision, digest],
      );

    it('accepts a matching (task, revision, digest) and rejects a mismatched digest', async () => {
      const task = await newItem(a);
      await newRevision(a, task, 'result bytes');
      const review = await newItem(a, 'review', 'requested');
      await expect(insertReview(a, review, task, sha256('stale bytes'))).rejects.toMatchObject({
        code: '23503',
      });
      await expect(insertReview(a, review, task, sha256('result bytes'), 2)).rejects.toMatchObject({
        code: '23503',
      });
      await insertReview(a, review, task, sha256('result bytes'));
    });

    it('allows one NON-cancelled review per revision', async () => {
      const task = await newItem(a);
      await newRevision(a, task, 'r1');
      const first = await newItem(a, 'review', 'requested');
      const second = await newItem(a, 'review', 'requested');
      await insertReview(a, first, task, sha256('r1'));
      await expect(insertReview(a, second, task, sha256('r1'))).rejects.toMatchObject({
        code: '23505',
      });
      // Cancelling the first frees the slot; cancelled_at and its reason go together.
      await expect(
        db.query(`UPDATE review_details SET cancelled_at = now() WHERE review_item_id = $1`, [
          first,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await db.query(
        `UPDATE review_details SET cancelled_at = now(), cancel_reason = 'reviewer_removed' WHERE review_item_id = $1`,
        [first],
      );
      await insertReview(a, second, task, sha256('r1'));
    });

    it('requires verdict and verdict_at together', async () => {
      const task = await newItem(a);
      await newRevision(a, task, 'v');
      const review = await newItem(a, 'review', 'requested');
      await expect(
        db.query(
          `INSERT INTO review_details (workspace_id, session_id, review_item_id, subject_task_id, result_revision, content_sha256, criteria, verdict)
           VALUES ($1, $2, $3, $4, 1, $5, '[]', 'approved')`,
          [a.workspaceId, a.sessionId, review, task, sha256('v')],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('cannot reference a revision of a task in another workspace', async () => {
      const task = await newItem(a);
      await newRevision(a, task, 'tenant a bytes');
      const review = await newItem(b, 'review', 'requested');
      await expect(insertReview(b, review, task, sha256('tenant a bytes'))).rejects.toMatchObject({
        code: '23503',
      });
    });
  });

  describe('claim requests', () => {
    it('allows one pending request per (task, requester)', async () => {
      const task = await newItem(a);
      const request = () =>
        db.query(
          `INSERT INTO claim_requests (workspace_id, session_id, task_id, requester_actor_id) VALUES ($1, $2, $3, $4)`,
          [a.workspaceId, a.sessionId, task, a.humanId],
        );
      await request();
      await expect(request()).rejects.toMatchObject({ code: '23505' });
      await db.query(`UPDATE claim_requests SET state = 'rejected' WHERE task_id = $1`, [task]);
      await request();
    });
  });

  describe('idempotency records and the event journal', () => {
    it('keeps (workspace, actor, scope, key) unique and ties response to status', async () => {
      const insert = (status: string, response: string | null, scope = 'room') =>
        db.query(
          `INSERT INTO commands (workspace_id, actor_id, idempotency_key, request_hash, command_type, status, response, scope_key)
           VALUES ($1, $2, 'k1', $3, 'test', $4, $5::jsonb, $6)`,
          [a.workspaceId, a.actorId, sha256('x'), status, response, scope],
        );
      await expect(insert('succeeded', null)).rejects.toMatchObject({ code: '23514' });
      await insert('succeeded', '{"ok":true}');
      await expect(insert('succeeded', '{"ok":true}')).rejects.toMatchObject({ code: '23505' });
      // The same key in another scope (a session) is a different record.
      await insert('succeeded', '{"ok":true}', a.sessionId);
    });

    it('makes domain events append-only', async () => {
      const commandId = await one(
        `INSERT INTO commands (workspace_id, actor_id, idempotency_key, request_hash, command_type, status, response, scope_key)
         VALUES ($1, $2, 'k-events', $3, 'test', 'succeeded', '{}', 'room') RETURNING id`,
        [a.workspaceId, a.actorId, sha256('y')],
      );
      const eventId = await one(
        `INSERT INTO domain_events (workspace_id, room_id, session_id, aggregate_id, aggregate_version, event_type, actor_id, command_id)
         VALUES ($1, $2, $3, gen_random_uuid(), 1, 'test.happened', $4, $5) RETURNING id`,
        [a.workspaceId, a.roomId, a.sessionId, a.actorId, commandId],
      );
      await expect(
        db.query(`UPDATE domain_events SET event_type = 'x' WHERE id = $1`, [eventId]),
      ).rejects.toMatchObject({ code: '23000' });
      await expect(db.query('TRUNCATE domain_events')).rejects.toMatchObject({ code: '23000' });
      await expect(
        db.query('DELETE FROM domain_events WHERE id = $1', [eventId]),
      ).rejects.toMatchObject({ code: '23000' });
    });
  });

  describe('credentials', () => {
    it('stores only a well-formed sha256 for tokens', async () => {
      await expect(
        db.query(
          `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, room_id) VALUES ($1, $2, 'plaintext-token', $3)`,
          [a.workspaceId, a.humanId, a.roomId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await db.query(
        `INSERT INTO api_tokens (workspace_id, actor_id, token_sha256, room_id) VALUES ($1, $2, $3, $4)`,
        [a.workspaceId, a.humanId, sha256('secret'), a.roomId],
      );
    });

    it('scopes a join credential to its session and stores only a hash', async () => {
      await expect(
        db.query(
          `INSERT INTO session_join_credentials (workspace_id, session_id, secret_sha256, created_by, expires_at, max_uses) VALUES ($1, $2, 'plain', $3, now() + interval '1 hour', 3)`,
          [a.workspaceId, a.sessionId, a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `INSERT INTO session_join_credentials (workspace_id, session_id, secret_sha256, created_by, expires_at, max_uses) VALUES ($1, $2, $3, $4, now() + interval '1 hour', 0)`,
          [a.workspaceId, a.sessionId, sha256('c'), a.actorId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await db.query(
        `INSERT INTO session_join_credentials (workspace_id, session_id, secret_sha256, created_by, expires_at, max_uses) VALUES ($1, $2, $3, $4, now() + interval '1 hour', 3)`,
        [a.workspaceId, a.sessionId, sha256('c'), a.actorId],
      );
    });
  });
});
