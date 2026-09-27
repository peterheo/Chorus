import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { sendError } from './http.ts';
import type { RateLimiter } from './rate-limit.ts';
import { sealSecret } from './secrets.ts';
import {
  SharedNetAuthError,
  SharedNetContractError,
  SharedNetHttpError,
  type SharedNetClient,
} from './sharednet/client.ts';

export interface ActivateDeps {
  readonly pool: pg.Pool;
  readonly client: SharedNetClient;
  readonly secretsKey: Buffer;
  readonly publicBaseUrl: string;
  readonly limiter: RateLimiter;
}

const ROOM_ID = /^rom_[A-Za-z0-9]{6,64}$/;
const INVITE = /^rit_[A-Za-z0-9_-]{20,128}$/;
const BODY_LIMIT = 8 * 1024;

/**
 * `POST /v1/rooms/activate` (rev 3 section 6.1, rev 4 section 6). Any holder of a valid SharedNet invite may
 * bind that room: an invite holder can join it anyway. Chorus joins once, resolves its seat identity, and
 * stores the workspace, room, sealed seat and cursor atomically. No session is created. The invite and the
 * member token are never stored in the clear, logged or echoed, and upstream bodies are never relayed.
 */
export function registerActivateRoutes(app: FastifyInstance, deps: ActivateDeps): void {
  app.post('/v1/rooms/activate', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const body = request.body;
    const roomId = isPlain(body) ? body['sharednet_room_id'] : undefined;
    const invite = isPlain(body) ? body['sharednet_invite_token'] : undefined;
    if (
      !isPlain(body) ||
      Object.keys(body).some((k) => k !== 'sharednet_room_id' && k !== 'sharednet_invite_token') ||
      typeof roomId !== 'string' ||
      !ROOM_ID.test(roomId) ||
      typeof invite !== 'string' ||
      !INVITE.test(invite)
    ) {
      return sendError(
        request,
        reply,
        400,
        'invalid_request',
        'Body must be {sharednet_room_id, sharednet_invite_token} with valid values.',
      );
    }
    const decision = deps.limiter.hit('global');
    if (!decision.ok) {
      return sendError(request, reply, 429, 'rate_limited', 'Too many activation attempts.', {
        'retry-after': String(decision.retryAfterSeconds),
      });
    }

    const next = `${deps.publicBaseUrl}/v1/enroll/start`;
    const reply200 = (chorusRoomId: string) =>
      reply.code(200).type('application/json; charset=utf-8').send({
        status: 'already_active',
        sharednet_room_id: roomId,
        chorus_room_id: chorusRoomId,
        next,
      });
    const activationFailed = () =>
      sendError(request, reply, 422, 'activation_failed', 'The room could not be activated.');

    // Already bound? Answer without using the invite again.
    const bound = await deps.pool.query<{ room_id: string; activation_state: string }>(
      'SELECT room_id, activation_state FROM chorus_room_lookup($1)',
      [roomId],
    );
    const existing = bound.rows[0];
    if (existing !== undefined) {
      return existing.activation_state === 'active'
        ? reply200(existing.room_id)
        : activationFailed();
    }

    let memberToken: string;
    let lastSequence: number;
    let memberId: string;
    let principalId: string;
    try {
      const joined = await deps.client.join(roomId, invite);
      const seat = await deps.client.currentInstance(joined.memberToken);
      memberToken = joined.memberToken;
      lastSequence = joined.lastSequence;
      memberId = seat.memberId;
      principalId = seat.principalId;
    } catch (error) {
      if (error instanceof SharedNetAuthError) return activationFailed();
      if (error instanceof SharedNetContractError) {
        request.log.warn(
          { request_id: request.id },
          'sharednet contract violation during activation',
        );
        return sendError(request, reply, 404, 'room_not_available', 'The room is not available.');
      }
      if (error instanceof SharedNetHttpError || isNetworkError(error)) {
        return sendError(
          request,
          reply,
          503,
          'temporarily_unavailable',
          'SharedNet is temporarily unavailable.',
        );
      }
      throw error;
    }

    const sealed = sealSecret(deps.secretsKey, memberToken);
    try {
      const { rows } = await deps.pool.query<{ room_id: string; created: boolean }>(
        'SELECT room_id, created FROM chorus_activate_room($1, $2, $3, $4, $5, $6, $7)',
        [
          roomId,
          memberId,
          principalId,
          sealed.ciphertext,
          sealed.nonce,
          sealed.keyId,
          lastSequence,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('chorus_activate_room returned no row');
      if (!row.created) return await reply200(row.room_id);
      return await reply.code(201).type('application/json; charset=utf-8').send({
        status: 'active',
        sharednet_room_id: roomId,
        chorus_room_id: row.room_id,
        next,
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'CH001') return activationFailed();
      throw error;
    }
  });
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** fetch failures (connection refused, DNS, timeout) surface as TypeError / AbortError / TimeoutError. */
const isNetworkError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
