import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveToken } from '../../src/auth.ts';
import { startStack, type Stack, SEAT_MEMBER } from '../helpers/stack.ts';

describe('automated in-room enrollment (real PostgreSQL, fake SharedNet)', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(async () => {
    await s.stop();
  });

  const body = (response: Response) => response.json() as Promise<Record<string, unknown>>;

  it('enroll.e2e.fake_sharednet: start -> in-room proof -> complete issues a token that resolves', async () => {
    const agent = s.agent('alpha');
    const started = await s.startEnrollment(agent);
    expect(started.message).toBe(`chorus-verify ${started.nonce}`);
    expect(started.nonce).toMatch(/^cvn_[A-Za-z0-9_-]{22}$/);
    expect(started.secret).toMatch(/^cvs_[A-Za-z0-9_-]{43}$/);

    // Before the proof is posted the enrollment is pending (202 + Retry-After).
    const pending = await s.complete(started.enrollmentId, started.secret);
    expect(pending.status).toBe(202);
    expect(pending.headers.get('retry-after')).toBe('3');
    expect(await body(pending)).toEqual({ status: 'pending', retry_after_seconds: 3 });

    s.post(agent, started.message);
    const enrolled = await (async () => {
      for (let i = 0; i < 200; i++) {
        const response = await s.complete(started.enrollmentId, started.secret);
        if (response.status === 200) return body(response);
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('never issued');
    })();

    expect(enrolled).toMatchObject({
      status: 'issued',
      token_type: 'Bearer',
      workspace_id: s.workspaceId,
      room: { id: s.roomId, sharednet_room_id: 'rom_TestRoom01' },
      mcp_url: 'http://127.0.0.1:0/mcp',
    });
    expect(enrolled['token']).toMatch(/^cht_[A-Za-z0-9_-]{43}$/);
    // 120 minutes from now, give or take the test's own runtime.
    const ttlMs = new Date(enrolled['token_expires_at'] as string).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(119 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(120 * 60_000);

    // Only the token's hash is stored; the actor is a fresh agent bound to a SharedNet-labelled instance.
    const [row] = await s.owner<{ token_sha256: string; label: string; kind: string }>(
      `SELECT t.token_sha256, i.label, a.kind FROM api_tokens t
         JOIN agent_instances i ON i.id = t.instance_id JOIN actors a ON a.id = t.actor_id
        WHERE t.actor_id = $1`,
      [enrolled['actor_id']],
    );
    expect(row?.token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_sha256).not.toContain(enrolled['token'] as string);
    expect(row).toMatchObject({ kind: 'agent', label: `sharednet:${agent.memberId}` });

    // The token resolves to the new actor, its instance and the room; enrollment gave NO session access.
    const auth = await resolveToken(s.pool, enrolled['token'] as string);
    expect(auth).toMatchObject({
      actorId: enrolled['actor_id'],
      instanceId: enrolled['instance_id'],
      roomId: s.roomId,
      workspaceId: s.workspaceId,
      kind: 'agent',
    });
    expect(enrolled['sessions_hint']).toContain('chorus.list_sessions');
    expect(
      await s.owner('SELECT 1 FROM room_members WHERE actor_id = $1 AND removed_at IS NULL', [
        enrolled['actor_id'],
      ]),
    ).toHaveLength(1);
    expect(
      await s.owner('SELECT 1 FROM session_members WHERE actor_id = $1', [enrolled['actor_id']]),
    ).toHaveLength(0);
  });

  it('enroll.bystander_replay: a bystander re-posting the nonce verifies nothing; the claimed seat does', async () => {
    const claimed = s.agent('claimed');
    const bystander = s.agent('bystander');
    const started = await s.startEnrollment(claimed);

    s.post(bystander, started.message);
    s.post(bystander, `  ${started.message}  `);
    const seq = s.fake.rooms.get('rom_TestRoom01')?.messages.at(-1)?.sequence ?? 0;
    await s.waitForCursor(seq);
    expect((await s.complete(started.enrollmentId, started.secret)).status).toBe(202);
    const [state] = await s.owner<{ state: string }>(
      'SELECT state FROM enrollments WHERE id = $1',
      [started.enrollmentId],
    );
    expect(state?.state).toBe('pending');

    s.post(claimed, started.message);
    await s.waitFor('verified', async () => {
      const rows = await s.owner<{ state: string }>('SELECT state FROM enrollments WHERE id = $1', [
        started.enrollmentId,
      ]);
      return rows[0]?.state === 'verified';
    });
    const [proof] = await s.owner<{ proof_member_id: string; proof_principal_id: string }>(
      'SELECT proof_member_id, proof_principal_id FROM enrollments WHERE id = $1',
      [started.enrollmentId],
    );
    expect(proof).toEqual({
      proof_member_id: claimed.memberId,
      proof_principal_id: claimed.principalId,
    });
    expect((await s.complete(started.enrollmentId, started.secret)).status).toBe(200);
  });

  it('enroll.proof_rules: old, expired, wrong-room and Chorus-own-seat proofs are never accepted', async () => {
    // A proof at or before start_sequence never counts (the watcher never even sees an older sequence).
    const early = s.agent('early');
    const startedEarly = await s.startEnrollment(early);
    await s.owner('UPDATE enrollments SET start_sequence = 1000000 WHERE id = $1', [
      startedEarly.enrollmentId,
    ]);
    s.post(early, startedEarly.message);
    await s.waitForCursor(s.fake.rooms.get('rom_TestRoom01')?.messages.at(-1)?.sequence ?? 0);
    expect((await s.complete(startedEarly.enrollmentId, startedEarly.secret)).status).toBe(202);

    // An expired enrollment cannot verify or complete.
    const late = s.agent('late');
    const startedLate = await s.startEnrollment(late);
    await s.owner(
      `UPDATE enrollments SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [startedLate.enrollmentId],
    );
    s.post(late, startedLate.message);
    await s.waitForCursor(s.fake.rooms.get('rom_TestRoom01')?.messages.at(-1)?.sequence ?? 0);
    // The watcher must not verify an expired enrollment (the sweeper is slowed down in this stack).
    const [lateRow] = await s.owner<{ verified_at: Date | null; proof_message_id: string | null }>(
      'SELECT verified_at, proof_message_id FROM enrollments WHERE id = $1',
      [startedLate.enrollmentId],
    );
    expect(lateRow).toEqual({ verified_at: null, proof_message_id: null });
    const lateResponse = await s.complete(startedLate.enrollmentId, startedLate.secret);
    expect(lateResponse.status).toBe(404);
    expect(await body(lateResponse)).toMatchObject({ error: 'enrollment_invalid', status: 404 });

    // Chorus's own seat is ignored even if someone claims its member id.
    const claimsSeat = s.agent('claimsseat');
    const startedSeat = await (async () => {
      const response = await fetch(`${s.baseUrl}/v1/enroll/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sharednet_room_id: 'rom_TestRoom01',
          member_id: SEAT_MEMBER,
          display_name: claimsSeat.name,
        }),
      });
      return (await response.json()) as Record<string, string>;
    })();
    s.fake.post('rom_TestRoom01', {
      memberId: SEAT_MEMBER,
      principalId: 'p_ChorusSeat01',
      content: startedSeat['post_this_message'] ?? '',
    });
    await s.waitForCursor(s.fake.rooms.get('rom_TestRoom01')?.messages.at(-1)?.sequence ?? 0);
    expect(
      (await s.complete(startedSeat['enrollment_id'] ?? '', startedSeat['secret'] ?? '')).status,
    ).toBe(202);

    // A proof for a different room is refused by the definer function itself.
    const other = await s.owner<{ id: string }>(
      `INSERT INTO rooms (workspace_id, name, provider, external_room_id, activation_state)
       VALUES ($1, 'other', 'sharednet', 'rom_OtherRoom01', 'active') RETURNING id`,
      [s.workspaceId],
    );
    const fresh = s.agent('fresh');
    const startedFresh = await s.startEnrollment(fresh);
    const verified = await s.pool.query<{ ok: boolean }>(
      'SELECT chorus_enroll_verify($1, $2, $3, $4, $5, $6, $7, NULL) AS ok',
      [
        s.workspaceId,
        other[0]?.id,
        startedFresh.nonce,
        'msg_x',
        99999,
        fresh.principalId,
        fresh.memberId,
      ],
    );
    expect(verified.rows[0]?.ok).toBe(false);

    // A malformed or extra-text message is not a challenge.
    s.post(fresh, `please ${startedFresh.message}`);
    s.post(fresh, `${startedFresh.message} extra`);
    await s.waitForCursor(s.fake.rooms.get('rom_TestRoom01')?.messages.at(-1)?.sequence ?? 0);
    expect((await s.complete(startedFresh.enrollmentId, startedFresh.secret)).status).toBe(202);
  });

  it('enroll.complete.single_issue: identical 404 for every invalid case; 10 concurrent completes issue once', async () => {
    const agent = s.agent('single');
    const started = await s.startEnrollment(agent);
    s.post(agent, started.message);
    await s.waitFor('verified', async () => {
      const rows = await s.owner<{ state: string }>('SELECT state FROM enrollments WHERE id = $1', [
        started.enrollmentId,
      ]);
      return rows[0]?.state === 'verified';
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => s.complete(started.enrollmentId, started.secret)),
    );
    const bodies = await Promise.all(
      responses.map(async (r) => ({ status: r.status, body: await body(r) })),
    );
    expect(bodies.filter((b) => b.status === 200)).toHaveLength(1);
    const losers = bodies.filter((b) => b.status !== 200);
    expect(losers).toHaveLength(9);
    for (const loser of losers)
      expect(loser).toMatchObject({ status: 404, body: { error: 'enrollment_invalid' } });
    expect(
      await s.owner(
        `SELECT 1 FROM api_tokens WHERE actor_id = (SELECT issued_actor_id FROM enrollments WHERE id = $1)`,
        [started.enrollmentId],
      ),
    ).toHaveLength(1);

    // Consumed, wrong secret, unknown id and a malformed secret all look the same (except the malformed one, which is a 400).
    const consumed = await s.complete(started.enrollmentId, started.secret);
    const wrong = await s.complete(started.enrollmentId, `cvs_${'A'.repeat(43)}`);
    const unknown = await s.complete('00000000-0000-4000-8000-000000000000', started.secret);
    const shape = async (r: Response) => {
      const b = await body(r);
      return { status: r.status, error: b['error'], message: b['message'] };
    };
    const expected = await shape(consumed);
    expect(expected).toMatchObject({ status: 404, error: 'enrollment_invalid' });
    expect(await shape(wrong)).toEqual(expected);
    expect(await shape(unknown)).toEqual(expected);
    expect((await s.complete(started.enrollmentId, 'nope')).status).toBe(400);
  });

  it('enroll.membership: one actor and one room membership per principal; a new instance and token each time', async () => {
    const agent = s.agent('member');
    const first = await s.enroll(agent);
    const second = await s.enroll(agent);
    expect(second.actorId).toBe(first.actorId);
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(second.token).not.toBe(first.token);
    const other = await s.enroll(s.agent('member-other'));
    expect(other.actorId).not.toBe(first.actorId);
    expect(
      await s.owner('SELECT 1 FROM room_members WHERE actor_id = $1', [first.actorId]),
    ).toHaveLength(1);
    expect(
      await s.owner('SELECT 1 FROM external_identities WHERE actor_id = $1', [first.actorId]),
    ).toHaveLength(1);
    // Old tokens stay valid until they expire or are revoked.
    for (const t of [first.token, second.token])
      expect(await resolveToken(s.pool, t)).toMatchObject({ actorId: first.actorId });
    // A member removed from the room is not re-admitted by enrolling again.
    await s.owner('UPDATE room_members SET removed_at = now() WHERE actor_id = $1', [
      first.actorId,
    ]);
    expect(await resolveToken(s.pool, first.token)).toBeUndefined();
    const started = await s.startEnrollment(agent);
    s.post(agent, started.message);
    await s.waitFor('verified', async () => {
      const rows = await s.owner<{ state: string }>('SELECT state FROM enrollments WHERE id = $1', [
        started.enrollmentId,
      ]);
      return rows[0]?.state === 'verified';
    });
    expect((await s.complete(started.enrollmentId, started.secret)).status).toBe(404);
  });

  it('enroll.agent_tag: the SharedNet agent tag of the proof is recorded on the room membership', async () => {
    const agent = s.agent('tagged');
    const started = await s.startEnrollment(agent);
    s.fake.post('rom_TestRoom01', {
      memberId: agent.memberId,
      principalId: agent.principalId,
      content: started.message,
      agentId: 'a_TaggedAgent1',
    });
    let actorId = '';
    for (let i = 0; i < 200 && actorId === ''; i++) {
      const response = await s.complete(started.enrollmentId, started.secret);
      if (response.status === 200)
        actorId = ((await response.json()) as { actor_id: string }).actor_id;
      else await new Promise((r) => setTimeout(r, 20));
    }
    const [row] = await s.owner<{ agent_tag: string | null }>(
      'SELECT agent_tag FROM room_members WHERE actor_id = $1',
      [actorId],
    );
    expect(row?.agent_tag).toBe('a_TaggedAgent1');
  });

  it('enroll.expiry_sweep: old pending and verified enrollments become expired and stop working', async () => {
    const stale = await s.startEnrollment(s.agent('stale'));
    const verified = await s.startEnrollment(s.agent('staleverified'));
    s.post(s.agent('staleverified'), verified.message);
    await s.owner(
      `UPDATE enrollments SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
        WHERE id = ANY($1::uuid[])`,
      [[stale.enrollmentId, verified.enrollmentId]],
    );
    const { rows } = await s.pool.query<{ swept: number }>(
      'SELECT chorus_expire_enrollments() AS swept',
    );
    expect(rows[0]?.swept).toBeGreaterThanOrEqual(2);
    for (const e of [stale, verified]) {
      const [row] = await s.owner<{ state: string }>(
        'SELECT state FROM enrollments WHERE id = $1',
        [e.enrollmentId],
      );
      expect(row?.state).toBe('expired');
      expect((await s.complete(e.enrollmentId, e.secret)).status).toBe(404);
    }
  });

  it('enroll.start: validation, and one indistinguishable error for unavailable rooms', async () => {
    const post = (payload: unknown) =>
      fetch(`${s.baseUrl}/v1/enroll/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    for (const bad of [
      {},
      { sharednet_room_id: 'rom_TestRoom01', member_id: 'not-a-member', display_name: 'x' },
      { sharednet_room_id: 'nope', member_id: 'i_abcdef123', display_name: 'x' },
      { sharednet_room_id: 'rom_TestRoom01', member_id: 'i_abcdef123', display_name: '   ' },
      {
        sharednet_room_id: 'rom_TestRoom01',
        member_id: 'i_abcdef123',
        display_name: 'x'.repeat(101),
      },
      {
        sharednet_room_id: 'rom_TestRoom01',
        member_id: 'i_abcdef123',
        display_name: 'x',
        extra: 1,
      },
      // Control and bidirectional formatting characters could spoof how the name renders to others.
      ...[
        'alice\nbob',
        'alice\tbob',
        'alice\u0000',
        'evil\u202Egnp.exe',
        'a\u2066b\u2069',
        'a\u200Fb',
      ].map((display_name) => ({
        sharednet_room_id: 'rom_TestRoom01',
        member_id: 'i_abcdef123',
        display_name,
      })),
    ]) {
      const response = await post(bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await body(response)).toMatchObject({ error: 'invalid_request' });
    }
    // Unknown room, unbound room shape, and an inactive room all answer the same way.
    await s.owner(
      `INSERT INTO rooms (workspace_id, name, provider, external_room_id, activation_state) VALUES ($1, 'inactive', 'sharednet', 'rom_Inactive01', 'inactive')`,
      [s.workspaceId],
    );
    const answers = await Promise.all(
      ['rom_Unknown0001', 'rom_Inactive01'].map(async (room) => {
        const response = await post({
          sharednet_room_id: room,
          member_id: 'i_abcdef123',
          display_name: 'x',
        });
        const b = await body(response);
        return { status: response.status, error: b['error'], message: b['message'] };
      }),
    );
    expect(answers[0]).toEqual({
      status: 404,
      error: 'room_not_available',
      message: 'This room is not available for enrollment.',
    });
    expect(answers[1]).toEqual(answers[0]);
    // Oversized bodies are rejected.
    const huge = await fetch(`${s.baseUrl}/v1/enroll/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'x'.repeat(5000) }),
    });
    expect(huge.status).toBe(413);
  });
});
