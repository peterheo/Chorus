import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { withReadTx, type Uuid } from '@chorus/domain';
import { newChorusToken, sha256Hex } from './auth.ts';
import { sendError } from './http.ts';
import type { RateLimiter } from './rate-limit.ts';

/**
 * Automated enrollment (spec section 4). A SharedNet participant proves control of its OWN seat by
 * posting a challenge in an existing, activated SharedNet room; Chorus never sees the participant's
 * SharedNet token and never creates a room. Two secrets are involved: the visible nonce (`cvn_`, posted in
 * the room) and a private secret (`cvs_`, returned only to the claimant), so a bystander who can read
 * the room can neither complete nor hijack someone else's enrollment.
 */
export interface EnrollDeps {
  readonly pool: pg.Pool;
  readonly publicBaseUrl: string;
  readonly limiters: {
    readonly startPerRoom: RateLimiter;
    readonly startGlobal: RateLimiter;
    readonly completeGlobal: RateLimiter;
  };
}

const ROOM_ID = /^rom_[A-Za-z0-9]{6,64}$/;
const MEMBER_ID = /^i_[A-Za-z0-9]{6,64}$/;
const SECRET = /^cvs_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_LIMIT = 4 * 1024;

export function registerEnrollRoutes(app: FastifyInstance, deps: EnrollDeps): void {
  app.post('/v1/enroll/start', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const body = objectBody(request.body, ['sharednet_room_id', 'member_id', 'display_name']);
    const roomId = body?.['sharednet_room_id'];
    const memberId = body?.['member_id'];
    const displayName = body?.['display_name'];
    if (
      typeof roomId !== 'string' ||
      !ROOM_ID.test(roomId) ||
      typeof memberId !== 'string' ||
      !MEMBER_ID.test(memberId) ||
      typeof displayName !== 'string' ||
      !validDisplayName(displayName)
    ) {
      return sendError(
        request,
        reply,
        400,
        'invalid_request',
        'Body must be {sharednet_room_id, member_id, display_name} with valid values.',
      );
    }
    const limited = [
      deps.limiters.startGlobal.hit('global'),
      deps.limiters.startPerRoom.hit(roomId),
    ].find((d) => !d.ok);
    if (limited !== undefined) {
      return sendError(request, reply, 429, 'rate_limited', 'Too many enrollment attempts.', {
        'retry-after': String(limited.retryAfterSeconds),
      });
    }

    const nonce = `cvn_${randomBytes(16).toString('base64url')}`;
    const secret = `cvs_${randomBytes(32).toString('base64url')}`;
    try {
      const { rows } = await deps.pool.query<{ enrollment_id: Uuid; expires_at: Date }>(
        'SELECT * FROM chorus_enroll_start($1, $2, $3, $4, $5)',
        [roomId, memberId, displayName, nonce, sha256Hex(secret)],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('chorus_enroll_start returned no row');
      const message = `chorus-verify ${nonce}`;
      return await reply
        .code(201)
        .type('application/json; charset=utf-8')
        .send({
          enrollment_id: row.enrollment_id,
          secret,
          expires_at: row.expires_at.toISOString(),
          post_this_message: message,
          complete_url: `${deps.publicBaseUrl}/v1/enroll/complete`,
          instructions:
            `Post post_this_message exactly, from SharedNet seat ${memberId}, in room ${roomId}. ` +
            'Then call complete_url with enrollment_id and secret until status is issued. ' +
            'Keep the secret private; do not post it.',
        });
    } catch (error) {
      // One code for "not bound", "not active", "watcher unhealthy": callers cannot probe which.
      if ((error as { code?: string }).code === 'CH001') {
        return sendError(
          request,
          reply,
          404,
          'room_not_available',
          'This room is not available for enrollment.',
        );
      }
      throw error;
    }
  });

  app.post('/v1/enroll/complete', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const body = objectBody(request.body, ['enrollment_id', 'secret']);
    const id = body?.['enrollment_id'];
    const secret = body?.['secret'];
    if (
      typeof id !== 'string' ||
      !UUID.test(id) ||
      typeof secret !== 'string' ||
      !SECRET.test(secret)
    ) {
      return sendError(
        request,
        reply,
        400,
        'invalid_request',
        'Body must be {enrollment_id, secret} with valid values.',
      );
    }
    const limited = deps.limiters.completeGlobal.hit('global');
    if (!limited.ok) {
      return sendError(request, reply, 429, 'rate_limited', 'Too many completion attempts.', {
        'retry-after': String(limited.retryAfterSeconds),
      });
    }

    const secretHash = sha256Hex(secret);
    const invalid = () =>
      sendError(
        request,
        reply,
        404,
        'enrollment_invalid',
        'The enrollment is unknown, expired or already used.',
      );
    const pending = () =>
      reply.code(202).header('retry-after', '3').type('application/json; charset=utf-8').send({
        status: 'pending',
        retry_after_seconds: 3,
      });

    const status = await deps.pool.query<{
      status: string;
      workspace_id: Uuid | null;
      room_id: Uuid | null;
      proof_principal_id: string | null;
    }>('SELECT * FROM chorus_enroll_status($1, $2)', [id, secretHash]);
    const current = status.rows[0];
    if (current === undefined || current.status === 'invalid') return invalid();
    if (current.status === 'pending') return pending();
    if (
      current.workspace_id === null ||
      current.room_id === null ||
      current.proof_principal_id === null
    ) {
      return invalid();
    }

    const token = newChorusToken();
    const completed = await deps.pool.query<{
      status: string;
      actor_id: Uuid | null;
      workspace_id: Uuid | null;
      room_id: Uuid | null;
      instance_id: Uuid | null;
      roles: string[] | null;
      token_expires_at: Date | null;
    }>('SELECT * FROM chorus_enroll_complete($1, $2, $3)', [id, secretHash, sha256Hex(token)]);
    const issued = completed.rows[0];
    if (issued === undefined || issued.status === 'invalid') return invalid();
    if (issued.status === 'pending') return pending();
    if (
      issued.actor_id === null ||
      issued.workspace_id === null ||
      issued.room_id === null ||
      issued.instance_id === null ||
      issued.token_expires_at === null
    ) {
      return invalid();
    }

    // The new actor now holds a grant, so it can read its own room binding under RLS.
    const workspaceId = issued.workspace_id;
    const roomId = issued.room_id;
    const sharednetRoomId = await withReadTx(
      { pool: deps.pool, workspaceId, actorId: issued.actor_id },
      async (db) => {
        const { rows } = await db.query<{ external_room_id: string | null }>(
          'SELECT external_room_id FROM rooms WHERE workspace_id = $1 AND id = $2',
          [workspaceId, roomId],
        );
        return rows[0]?.external_room_id ?? null;
      },
    );
    return reply
      .code(200)
      .type('application/json; charset=utf-8')
      .send({
        status: 'issued',
        token,
        token_type: 'Bearer',
        token_expires_at: issued.token_expires_at.toISOString(),
        actor_id: issued.actor_id,
        instance_id: issued.instance_id,
        workspace_id: issued.workspace_id,
        room: { id: issued.room_id, sharednet_room_id: sharednetRoomId },
        mcp_url: `${deps.publicBaseUrl}/mcp`,
        sessions_hint: 'Call chorus.list_sessions, then chorus.join_session, to work in a session.',
        note: 'Shown once. Re-enroll before token_expires_at to continue.',
      });
  });
}

function objectBody(
  body: unknown,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every((k) => allowed.includes(k)) ? record : undefined;
}

/**
 * Control characters (newlines, tabs, NUL, ...) and bidirectional formatting characters would let a name
 * render as something else to the other agents that read it, so neither is accepted. Zero-width joiners stay
 * allowed: emoji sequences need them.
 */
const DISPLAY_NAME_FORBIDDEN = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function validDisplayName(name: string): boolean {
  const length = Array.from(name).length;
  return (
    length >= 1 &&
    length <= 100 &&
    name.trim() !== '' &&
    !DISPLAY_NAME_FORBIDDEN.test(name) &&
    name.isWellFormed()
  );
}
