import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChorusError,
  createTask,
  dismissSuggestion,
  isChorusError,
  linkSuggestion,
  listSuggestions,
  recordScan,
  rulesV1,
  type Suggestion,
  type Uuid,
} from '../../src/index.ts';
import { createFixture, type Actor, type Fixture, type SessionSeed } from '../helpers/fixture.ts';

/** Builds one SourceMessage; a fresh id/sequence each time unless overridden. */
let seq = 0;
const message = (
  content: string,
  over: Partial<Parameters<typeof rulesV1.extract>[0][number]> = {},
) => {
  seq += 1;
  return {
    message_id: `msg_${String(seq).padStart(4, '0')}`,
    sequence: seq,
    sender_member_id: 'i_Alice00001',
    sender_principal_id: 'p_Alice00001',
    sender_name: 'alice',
    content,
    reply_to_message_id: null,
    ...over,
  };
};

describe('conversation suggestions (CC-1b domain; real PostgreSQL as chorus_app)', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture({ poolMax: 16 });
  });
  afterAll(async () => {
    await f.close();
  });

  async function world(
    label: string,
  ): Promise<{ ws: Actor['ws']; owner: Actor; session: SessionSeed }> {
    const ws = await f.workspace(`${label}-${randomUUID().slice(0, 8)}`);
    const owner = await f.actor(ws, `${label}-owner`);
    const session = await f.session(owner);
    return { ws, owner, session };
  }

  const scan = (
    actor: Actor,
    session: SessionSeed,
    args: { from?: number; to?: number; key?: string; msgs?: ReturnType<typeof message>[] },
  ) => {
    const msgs = args.msgs ?? [message('Can someone check why the deploy fails?')];
    return recordScan(actor.ctx(args.key), {
      session_id: session.id,
      from_sequence: args.from ?? 1,
      to_sequence: args.to ?? 200,
      cutoff_sequence: args.to ?? 200,
      messages: msgs,
      extracted: rulesV1.extract(msgs),
    });
  };

  it('CC2 conversation.rescan_stable: a rescan of the same window updates last_scan_id and never duplicates; a dismissed suggestion stays dismissed', async () => {
    const { owner, session } = await world('cc2');
    const msgs = [
      message('Can someone check why the deploy fails?'),
      message("I'll investigate it now."),
    ];
    const first = await scan(owner, session, { msgs });
    expect(first.suggestions.every((s) => s.is_new)).toBe(true);
    expect(first.suggestions).toHaveLength(2);

    const second = await scan(owner, session, { msgs });
    expect(second.suggestions.every((s) => !s.is_new)).toBe(true);
    expect(new Set(second.suggestions.map((s) => s.suggestion_id))).toEqual(
      new Set(first.suggestions.map((s) => s.suggestion_id)),
    );
    expect(second.suggestions.every((s) => s.last_scan_id === second.scan.id)).toBe(true);
    expect(
      await f.count(
        `SELECT count(*) AS n FROM conversation_suggestions WHERE workspace_id = $1 AND session_id = $2`,
        [session.ws.id, session.id],
      ),
    ).toBe(2);

    // Dismiss one, then rescan: it stays dismissed, only last_scan_id/updated_at move.
    const target = first.suggestions[0];
    if (target === undefined) throw new Error('expected a suggestion');
    await dismissSuggestion(owner.ctx(), {
      session_id: session.id,
      suggestion_id: target.suggestion_id,
    });
    const third = await scan(owner, session, { msgs });
    const dismissed = third.suggestions.find((s) => s.suggestion_id === target.suggestion_id);
    expect(dismissed?.state).toBe('dismissed');
    expect(dismissed?.last_scan_id).toBe(third.scan.id);
  });

  it('CC2b conversation.rescan_concurrent: two concurrent scans of the same window never collide, and exactly one reports is_new', async () => {
    const { owner, session } = await world('cc2b');
    const msgs = [message('Can someone check why the deploy fails?')];
    const [a, b] = await Promise.all([
      scan(owner, session, { msgs }),
      scan(owner, session, { msgs }),
    ]);
    expect(a.suggestions).toHaveLength(1);
    expect(b.suggestions).toHaveLength(1);
    expect(a.suggestions[0]?.suggestion_id).toBe(b.suggestions[0]?.suggestion_id);
    // Exactly one of the two concurrent scans inserted the row; the other found it already there.
    const flags = [a.suggestions[0]?.is_new, b.suggestions[0]?.is_new];
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(
      await f.count(
        `SELECT count(*) AS n FROM conversation_suggestions WHERE workspace_id = $1 AND session_id = $2`,
        [session.ws.id, session.id],
      ),
    ).toBe(1);
  });

  it('CC3 conversation.no_silent_authority: scanning and linking sets nothing but the explicit link, and nothing extra is journaled', async () => {
    const { owner, session } = await world('cc3');
    const created = await createTask(owner.ctx(), {
      session_id: session.id,
      board_id: session.boardId,
      title: 'Investigate the deploy failure',
      acceptance_criteria: ['it is fixed'],
    });
    const commandsBefore = await f.count(
      `SELECT count(*) AS n FROM commands WHERE workspace_id = $1`,
      [session.ws.id],
    );
    const eventsBefore = await f.count(
      `SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1 AND session_id = $2`,
      [session.ws.id, session.id],
    );

    const scanned = await scan(owner, session, {});
    const suggestion = scanned.suggestions[0];
    if (suggestion === undefined) throw new Error('expected a suggestion');
    // A scan changes nothing about the canonical state: it is a read-shaped side effect only.
    const untouched = await f.owner<{ owner_actor_id: string | null; state: string }>(
      `SELECT owner_actor_id, state FROM work_items WHERE id = $1`,
      [created.task.id],
    );
    expect(untouched[0]).toEqual({ owner_actor_id: null, state: 'ready' });

    const linked = await linkSuggestion(owner.ctx(), {
      session_id: session.id,
      suggestion_id: suggestion.suggestion_id,
      item_id: created.task.id as Uuid,
    });
    expect(linked.item.version).toBe(2); // the ONLY version bump: create_task=1, link=2
    const after = await f.owner<{ owner_actor_id: string | null; state: string; version: number }>(
      `SELECT owner_actor_id, state, version FROM work_items WHERE id = $1`,
      [created.task.id],
    );
    expect(after[0]).toEqual({ owner_actor_id: null, state: 'ready', version: 2 });
    expect(
      await f.count(
        `SELECT count(*) AS n FROM work_items WHERE kind = 'review' AND session_id = $1`,
        [session.id],
      ),
    ).toBe(0);

    // Exactly the explicit calls became commands: create_task, scan, link.
    expect(
      await f.count(`SELECT count(*) AS n FROM commands WHERE workspace_id = $1`, [session.ws.id]),
    ).toBe(commandsBefore + 2); // scan + link (create_task's command was already counted above)
    expect(
      await f.count(
        `SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1 AND session_id = $2`,
        [session.ws.id, session.id],
      ),
    ).toBe(eventsBefore + 1); // exactly one: task.source_linked
    const linkEvent = await f.owner<{ event_type: string; payload: { suggestion_id: string } }>(
      `SELECT event_type, payload FROM domain_events WHERE workspace_id = $1 AND session_id = $2
        AND aggregate_id = $3 AND aggregate_version = 2`,
      [session.ws.id, session.id, created.task.id],
    );
    expect(linkEvent[0]).toMatchObject({
      event_type: 'task.source_linked',
      payload: { suggestion_id: suggestion.suggestion_id },
    });
    const messageLink = await f.owner(
      `SELECT 1 FROM message_links WHERE workspace_id = $1 AND session_id = $2 AND item_id = $3`,
      [session.ws.id, session.id, created.task.id],
    );
    expect(messageLink).toHaveLength(1);
  });

  it('CC4 conversation.decided_conflict: a second decision is refused, and 10 concurrent links yield exactly one success', async () => {
    const { owner, session } = await world('cc4');
    const scanned = await scan(owner, session, {});
    const suggestion = scanned.suggestions[0];
    if (suggestion === undefined) throw new Error('expected a suggestion');
    const created = await createTask(owner.ctx(), {
      session_id: session.id,
      board_id: session.boardId,
      title: 'Fix it',
      acceptance_criteria: ['done'],
    });
    await linkSuggestion(owner.ctx(), {
      session_id: session.id,
      suggestion_id: suggestion.suggestion_id,
      item_id: created.task.id as Uuid,
    });

    const second = await linkSuggestion(owner.ctx(), {
      session_id: session.id,
      suggestion_id: suggestion.suggestion_id,
      item_id: created.task.id as Uuid,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isChorusError(second, 'invalid_transition')).toBe(true);
    expect((second as ChorusError).details).toMatchObject({
      reason: 'suggestion_decided',
      state: 'linked',
      linked_item_id: created.task.id as Uuid,
    });
    const dismissAfterLink = await dismissSuggestion(owner.ctx(), {
      session_id: session.id,
      suggestion_id: suggestion.suggestion_id,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isChorusError(dismissAfterLink, 'invalid_transition')).toBe(true);
    expect((dismissAfterLink as ChorusError).details).toMatchObject({
      reason: 'suggestion_decided',
    });

    // Ten concurrent attempts on a FRESH open suggestion: exactly one succeeds.
    const race = await scan(owner, session, { msgs: [message("I'll take this one.")] });
    const contested = race.suggestions.find((s) => s.is_new);
    if (contested === undefined) throw new Error('expected a new suggestion');
    // Ten DIFFERENT target items, so only the suggestion's own row lock (not an incidental item-version
    // lock on a shared item) can be what serializes "exactly one wins".
    const contestedTasks = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        createTask(owner.ctx(), {
          session_id: session.id,
          board_id: session.boardId,
          title: `Contested ${String(i)}`,
          acceptance_criteria: ['done'],
        }),
      ),
    );
    const results = await Promise.all(
      contestedTasks.map((task) =>
        linkSuggestion(owner.ctx(), {
          session_id: session.id,
          suggestion_id: contested.suggestion_id,
          item_id: task.task.id as Uuid,
        }).then(
          (value) => ({ ok: value }) as const,
          (error: unknown) => ({ error }) as const,
        ),
      ),
    );
    const succeeded = results.filter((r) => 'ok' in r);
    const failed = results.filter((r) => 'error' in r);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const r of failed) {
      if ('error' in r) expect(isChorusError(r.error, 'invalid_transition')).toBe(true);
    }
  });

  it('CC5 conversation.isolation: a suggestion in session A is invisible from session B, and RLS shows chorus_app zero cross-session rows', async () => {
    const wsA = await world('cc5a');
    const wsB = await f.actor(wsA.ws, 'cc5b-outsider'); // same workspace, a DIFFERENT session (never joined A)
    const sessionB = await f.session(wsB);

    const scanned = await scan(wsA.owner, wsA.session, {});
    const suggestion = scanned.suggestions[0];
    if (suggestion === undefined) throw new Error('expected a suggestion');
    const itemInB = await createTask(wsB.ctx(), {
      session_id: sessionB.id,
      board_id: sessionB.boardId,
      title: 'In B',
      acceptance_criteria: ['done'],
    });

    // B cannot see, link or dismiss A's suggestion.
    await expect(
      listSuggestions(f.readCtx(wsB), { session_id: wsA.session.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      linkSuggestion(wsB.ctx(), {
        session_id: wsA.session.id,
        suggestion_id: suggestion.suggestion_id,
        item_id: itemInB.task.id as Uuid,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      dismissSuggestion(wsB.ctx(), {
        session_id: wsA.session.id,
        suggestion_id: suggestion.suggestion_id,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // A cannot link its own (visible) suggestion to an item that lives in B's session.
    await expect(
      linkSuggestion(wsA.owner.ctx(), {
        session_id: wsA.session.id,
        suggestion_id: suggestion.suggestion_id,
        item_id: itemInB.task.id as Uuid,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // RLS as chorus_app: querying with B's context, A's session is invisible outright.
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('chorus.workspace_id', $1, true), set_config('chorus.actor_id', $2, true)`,
        [wsA.ws.id, wsB.id],
      );
      const rows = await client.query(
        `SELECT * FROM conversation_suggestions WHERE session_id = $1`,
        [wsA.session.id],
      );
      expect(rows.rowCount).toBe(0);
      const scans = await client.query(`SELECT * FROM conversation_scans WHERE session_id = $1`, [
        wsA.session.id,
      ]);
      expect(scans.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // Control: A sees its own suggestion just fine.
    const own = await listSuggestions(f.readCtx(wsA.owner), { session_id: wsA.session.id });
    expect(own.suggestions.map((s: Suggestion) => s.suggestion_id)).toContain(
      suggestion.suggestion_id,
    );
  });

  it('CC9 conversation.idempotent_scan: the same key replays; the same key with a different window conflicts', async () => {
    const { owner, session } = await world('cc9');
    const key = `scan-${randomUUID()}`;
    const msgs = [message('Can someone check why the deploy fails?')];
    const first = await scan(owner, session, { key, msgs });
    const before = await f.count(
      `SELECT count(*) AS n FROM conversation_scans WHERE workspace_id = $1 AND session_id = $2`,
      [session.ws.id, session.id],
    );

    // Same key, same window, DIFFERENT fetched content: the stored response replays untouched.
    const replay = await scan(owner, session, {
      key,
      msgs: [...msgs, message("I'll investigate the deploy failure.")],
    });
    expect(replay).toEqual(first);
    expect(
      await f.count(
        `SELECT count(*) AS n FROM conversation_scans WHERE workspace_id = $1 AND session_id = $2`,
        [session.ws.id, session.id],
      ),
    ).toBe(before);

    // Same key, a DIFFERENT window: idempotency_conflict.
    const conflict = await scan(owner, session, { key, to: 199, msgs }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isChorusError(conflict, 'idempotency_conflict')).toBe(true);
  });
});
