import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ChorusError, isUuid, withReadTx, type ReadContext } from '@chorus/domain';
import { sendError } from './http.ts';
import type { RateLimiter } from './rate-limit.ts';

export type ReceiptEnvelope = {
  receipt: Record<string, unknown>;
  jcs_sha256: string;
  signature: string;
  key_id: string;
  alg: 'Ed25519';
};

/** RFC 8785 serialization for JSON values (object keys sort by UTF-16 code units). */
export function canonicalJcs(value: unknown): string {
  if (typeof value === 'string') return quoteJcsString(value);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS does not allow non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJcs).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${quoteJcsString(key)}:${canonicalJcs((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  throw new TypeError('Value is not JSON serializable.');
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function quoteJcsString(value: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new TypeError('JCS requires valid Unicode.');
  }
  return JSON.stringify(value);
}

/** Envelopes longer than this (base64url characters) are refused by the link check; real ones are ~3 KB. */
const MAX_LINK_ENVELOPE = 8192;

/**
 * A public link that verifies the envelope and shows its receipt: the envelope travels in the URL, so a
 * stranger can check a finished task without an account and without Chorus storing anything to share it.
 */
export function receiptVerifyUrl(publicBaseUrl: string, envelope: ReceiptEnvelope): string {
  const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  return `${publicBaseUrl}/v1/receipts/verify?envelope=${encoded}`;
}

export function signReceipt(
  receipt: Record<string, unknown>,
  privateKey: KeyObject,
  keyId: string,
): ReceiptEnvelope {
  const canonical = canonicalJcs(receipt);
  return {
    receipt,
    jcs_sha256: sha256(canonical),
    signature: sign(null, Buffer.from(canonical), privateKey).toString('base64url'),
    key_id: keyId,
    alg: 'Ed25519',
  };
}

export function verifyReceiptEnvelope(
  value: unknown,
  publicKey: KeyObject,
  keyId: string,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (
    typeof envelope.receipt !== 'object' ||
    envelope.receipt === null ||
    Array.isArray(envelope.receipt) ||
    envelope.alg !== 'Ed25519' ||
    envelope.key_id !== keyId ||
    typeof envelope.jcs_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(envelope.jcs_sha256) ||
    typeof envelope.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
  )
    return false;
  try {
    const canonical = canonicalJcs(envelope.receipt);
    return (
      sha256(canonical) === envelope.jcs_sha256 &&
      verify(null, Buffer.from(canonical), publicKey, Buffer.from(envelope.signature, 'base64url'))
    );
  } catch {
    return false;
  }
}

export async function getReceipt(
  ctx: ReadContext,
  sessionId: string,
  taskId: string,
  serverCommit: string,
  issuer: string,
  privateKey: KeyObject | null,
  keyId: string | null,
): Promise<ReceiptEnvelope & { verify_url: string }> {
  if (privateKey === null || keyId === null) {
    throw new ChorusError('temporarily_unavailable', 'Receipts are disabled.', {
      details: { cause: 'receipts_disabled' },
    });
  }
  if (!isUuid(sessionId) || !isUuid(taskId)) {
    throw new ChorusError('invalid_request', 'session_id and task_id must be UUIDs.');
  }
  return withReadTx(ctx, async (db) => {
    const roles = await db.query<{ roles: string[] | null }>(
      'SELECT chorus_session_roles($1) AS roles',
      [sessionId],
    );
    if (roles.rows[0]?.roles == null) throw new ChorusError('not_found', 'Not found.');
    const { rows } = await db.query<{
      id: string;
      title: string;
      state: string;
      room_id: string;
      criteria: string[];
      review_required: boolean;
      completed_at: Date | null;
      revision: number | null;
      content_sha256: string | null;
      submitted_by: string | null;
      review_id: string | null;
      verdict: string | null;
      reviewer_actor_id: string | null;
      decided_at: Date | null;
    }>(
      `SELECT w.id, w.title, w.state, r.external_room_id AS room_id, d.acceptance_criteria AS criteria,
              d.review_required, completed.completed_at,
              result.revision, result.content_sha256, result.submitted_by,
              review.id AS review_id, review.verdict, review.reviewer_actor_id, review.verdict_at AS decided_at
         FROM work_items w
         JOIN rooms r ON r.workspace_id = w.workspace_id AND r.id = w.home_room_id
         JOIN task_details d ON d.workspace_id = w.workspace_id AND d.item_id = w.id
         LEFT JOIN LATERAL (
           SELECT max(occurred_at) AS completed_at FROM domain_events
            WHERE workspace_id = w.workspace_id AND aggregate_id = w.id AND event_type = 'task.completed'
         ) completed ON true
         LEFT JOIN LATERAL (
           SELECT revision, content_sha256, submitted_by FROM task_result_revisions
            WHERE workspace_id = w.workspace_id AND task_id = w.id ORDER BY revision DESC LIMIT 1
         ) result ON true
         LEFT JOIN LATERAL (
           SELECT rd.review_item_id AS id, rd.verdict, item.owner_actor_id AS reviewer_actor_id, rd.verdict_at
             FROM review_details rd JOIN work_items item
               ON item.workspace_id = rd.workspace_id AND item.id = rd.review_item_id
            WHERE rd.workspace_id = w.workspace_id AND rd.subject_task_id = w.id
              AND rd.result_revision = result.revision AND rd.cancelled_at IS NULL
            ORDER BY rd.verdict_at DESC NULLS LAST LIMIT 1
         ) review ON true
        WHERE w.workspace_id = $1 AND w.session_id = $2 AND w.id = $3 AND w.kind = 'task'`,
      [ctx.workspaceId, sessionId, taskId],
    );
    const row = rows[0];
    if (row === undefined) throw new ChorusError('not_found', 'Not found.');
    if (row.state !== 'done' || row.completed_at === null) {
      throw new ChorusError('invalid_transition', 'Task is not complete.', {
        details: { reason: 'not_done' },
      });
    }
    if (row.revision === null || row.content_sha256 === null || row.submitted_by === null) {
      throw new ChorusError('internal_error', 'Completed task is missing its result.');
    }
    const subjectActorIds = [row.submitted_by];
    if (row.reviewer_actor_id !== null) subjectActorIds.push(row.reviewer_actor_id);
    const subjectMembers = await db.query<{ actor_id: string; member_id: string | null }>(
      'SELECT actor_id, member_id FROM chorus_session_member_ids($1, $2::uuid[])',
      [sessionId, subjectActorIds],
    );
    const memberIds = new Map(
      subjectMembers.rows.map((member) => [member.actor_id, member.member_id]),
    );
    const review =
      row.review_required &&
      row.review_id !== null &&
      row.verdict === 'approved' &&
      row.reviewer_actor_id !== null &&
      row.decided_at !== null
        ? {
            id: row.review_id,
            verdict: 'approved',
            reviewer: {
              actor_id: row.reviewer_actor_id,
              member_id: memberIds.get(row.reviewer_actor_id) ?? null,
            },
            decided_at: row.decided_at.toISOString(),
          }
        : null;
    const receipt: Record<string, unknown> = {
      v: 1,
      type: 'chorus.task_completion',
      issuer,
      issued_at: new Date().toISOString(),
      server_commit: serverCommit,
      sharednet_room_id: row.room_id,
      session_id: sessionId,
      task: { id: row.id, title: row.title, criteria_sha256: sha256(canonicalJcs(row.criteria)) },
      result: {
        revision: row.revision,
        content_sha256: row.content_sha256,
        submitted_by: {
          actor_id: row.submitted_by,
          member_id: memberIds.get(row.submitted_by) ?? null,
        },
      },
      review,
      completed_at: row.completed_at.toISOString(),
    };
    const envelope = signReceipt(receipt, privateKey, keyId);
    return { ...envelope, verify_url: receiptVerifyUrl(issuer, envelope) };
  });
}

export function registerReceiptRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; privateKey: KeyObject | null; keyId: string | null; limiter: RateLimiter },
): void {
  app.get('/v1/keys/:key_id', async (request, reply) => {
    const requested = (request.params as { key_id: string }).key_id;
    if (deps.privateKey === null || deps.keyId === null || requested !== deps.keyId) {
      return sendError(request, reply, 404, 'not_found', 'No such signing key.');
    }
    const publicKey = createPublicKey(deps.privateKey);
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const raw = der.subarray(der.length - 32).toString('base64url');
    return reply.code(200).send({
      key_id: deps.keyId,
      alg: 'Ed25519',
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      public_key_raw_b64: raw,
    });
  });

  type Check =
    | { valid: true; key_id: string }
    | { valid: false; key_id: string | null; reason: 'unknown_key' | 'invalid_signature' };
  const check = (envelope: unknown): Check => {
    const keyId =
      typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)
        ? (envelope as { key_id?: unknown }).key_id
        : undefined;
    if (typeof keyId !== 'string' || deps.privateKey === null || keyId !== deps.keyId) {
      return {
        valid: false,
        key_id: typeof keyId === 'string' ? keyId : null,
        reason: 'unknown_key',
      };
    }
    return verifyReceiptEnvelope(envelope, createPublicKey(deps.privateKey), deps.keyId)
      ? { valid: true, key_id: keyId }
      : { valid: false, key_id: keyId, reason: 'invalid_signature' };
  };

  app.post('/v1/receipts/verify', async (request, reply) => {
    const decision = deps.limiter.hit('global');
    if (!decision.ok)
      return sendError(request, reply, 429, 'rate_limited', 'Too many requests.', {
        'retry-after': String(decision.retryAfterSeconds),
      });
    return reply.code(200).send(check(request.body));
  });

  // The shareable form of the same check (`verify_url` from chorus.get_receipt). The receipt is echoed back
  // only when its signature verifies, so the link never shows unsigned text as if Chorus had issued it.
  app.get('/v1/receipts/verify', async (request, reply) => {
    const decision = deps.limiter.hit('global');
    if (!decision.ok)
      return sendError(request, reply, 429, 'rate_limited', 'Too many requests.', {
        'retry-after': String(decision.retryAfterSeconds),
      });
    const encoded = (request.query as { envelope?: unknown }).envelope;
    let envelope: unknown;
    try {
      if (
        typeof encoded !== 'string' ||
        encoded.length > MAX_LINK_ENVELOPE ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)
      )
        throw new TypeError('bad envelope');
      envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return sendError(
        request,
        reply,
        400,
        'invalid_request',
        'envelope must be a base64url-encoded receipt envelope.',
      );
    }
    const result = check(envelope);
    if (!result.valid) return reply.code(200).send(result);
    const { receipt, key_id: keyId } = envelope as ReceiptEnvelope;
    return reply.code(200).send({ ...result, key_url: `/v1/keys/${keyId}`, receipt, envelope });
  });
}
