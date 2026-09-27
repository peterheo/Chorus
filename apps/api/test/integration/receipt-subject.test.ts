import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeTask, type Uuid } from '@chorus/domain';
import { getReceipt } from '../../src/receipts.ts';
import { createFixture, type Fixture } from '../../../../packages/domain/test/helpers/fixture.ts';
import {
  claimAs,
  makeWorld,
  newTask,
  requestReviewAs,
  submitAs,
  taskInReview,
  verdictAs,
  type World,
} from '../../../../packages/domain/test/helpers/world.ts';

describe('receipt subject binding', () => {
  let fixture: Fixture;
  let world: World;
  const pair = generateKeyPairSync('ed25519');
  const keyId = createHash('sha256')
    .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);
  const key = { privateKey: pair.privateKey, keyId };

  beforeAll(async () => {
    fixture = await createFixture();
    world = await makeWorld(fixture, await fixture.workspace('receipt-subject'));
    await fixture.owner(
      "UPDATE rooms SET provider = 'sharednet', external_room_id = 'rom_ReceiptTest01' WHERE id = $1",
      [world.session.roomId],
    );
  });
  afterAll(async () => fixture.close());

  it('returns not_done, rejects disabled receipts, and nulls ambiguous member IDs', async () => {
    const unfinished = await newTask(world, { reviewRequired: false });
    const ctx = fixture.readCtx(world.executor);
    await expect(
      getReceipt(
        ctx,
        world.session.id,
        unfinished.id,
        'abc1234',
        'https://chorus.example',
        key.privateKey,
        key.keyId,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition', details: { reason: 'not_done' } });
    await expect(
      getReceipt(
        ctx,
        world.session.id,
        unfinished.id,
        'abc1234',
        'https://chorus.example',
        null,
        null,
      ),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      details: { cause: 'receipts_disabled' },
    });

    const claimed = await claimAs(world, unfinished.id as Uuid, unfinished.version);
    const submitted = await submitAs(world, unfinished.id as Uuid, claimed.version, claimed.fence);
    await completeTask(world.manager.ctx(), {
      session_id: world.session.id,
      task_id: unfinished.id,
      expected_version: submitted.version,
    });
    await fixture.owner(
      "UPDATE agent_instances SET sharednet_member_id = 'i_Member001' WHERE id = $1",
      [world.executor.instanceId],
    );
    await fixture.owner(
      "INSERT INTO agent_instances (workspace_id, actor_id, label, sharednet_member_id) VALUES ($1, $2, 'second instance', 'i_Member002')",
      [world.ws.id, world.executor.id],
    );
    const envelope = await getReceipt(
      ctx,
      world.session.id,
      unfinished.id,
      'abc1234',
      'https://chorus.example',
      key.privateKey,
      key.keyId,
    );
    expect(envelope.receipt).toMatchObject({
      v: 1,
      type: 'chorus.task_completion',
      issuer: 'https://chorus.example',
      sharednet_room_id: 'rom_ReceiptTest01',
      task: { id: unfinished.id },
      result: { submitted_by: { actor_id: world.executor.id, member_id: null } },
      review: null,
    });
  });

  it('returns the complete approved review block with unique submitter and reviewer member IDs', async () => {
    const reviewedWorld = await makeWorld(fixture, await fixture.workspace('receipt-reviewed'));
    await fixture.owner(
      "UPDATE rooms SET provider = 'sharednet', external_room_id = 'rom_ReviewTest01' WHERE id = $1",
      [reviewedWorld.session.roomId],
    );
    const flow = await taskInReview(reviewedWorld);
    const requested = await requestReviewAs(
      reviewedWorld,
      flow.taskId,
      flow.version,
      flow.revision,
      reviewedWorld.reviewer,
    );
    await verdictAs(
      reviewedWorld,
      requested.review,
      flow.digest,
      'approved',
      reviewedWorld.reviewer,
    );
    await fixture.owner(
      "UPDATE agent_instances SET sharednet_member_id = 'i_Submitter0001' WHERE id = $1",
      [reviewedWorld.executor.instanceId],
    );
    await fixture.owner(
      "UPDATE agent_instances SET sharednet_member_id = 'i_Reviewer0001' WHERE id = $1",
      [reviewedWorld.reviewer.instanceId],
    );

    const envelope = await getReceipt(
      fixture.readCtx(reviewedWorld.manager),
      reviewedWorld.session.id,
      flow.taskId,
      'abc1234',
      'https://chorus.example',
      key.privateKey,
      key.keyId,
    );
    expect(envelope.receipt).toMatchObject({
      result: {
        revision: 1,
        content_sha256: flow.digest,
        submitted_by: {
          actor_id: reviewedWorld.executor.id,
          member_id: 'i_Submitter0001',
        },
      },
      review: {
        id: requested.review.id,
        verdict: 'approved',
        reviewer: {
          actor_id: reviewedWorld.reviewer.id,
          member_id: 'i_Reviewer0001',
        },
      },
    });
    const review = envelope.receipt['review'] as Record<string, unknown>;
    expect(typeof review['decided_at']).toBe('string');

    await expect(
      getReceipt(
        fixture.readCtx(reviewedWorld.outsider),
        reviewedWorld.session.id,
        flow.taskId,
        'abc1234',
        'https://chorus.example',
        key.privateKey,
        key.keyId,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const otherWorld = await makeWorld(fixture, await fixture.workspace('receipt-other-session'));
    await expect(
      getReceipt(
        fixture.readCtx(otherWorld.executor),
        otherWorld.session.id,
        flow.taskId,
        'abc1234',
        'https://chorus.example',
        key.privateKey,
        key.keyId,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
