import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { withReadTx } from '@chorus/domain';
import { extractBearer, resolveToken } from './auth.ts';
import { sendError } from './http.ts';

const TRACE = /^[A-Za-z0-9_-]{8,128}$/;
export const AUDIT_MAX_EVENTS = 200;

/**
 * `GET /v1/audit?trace=<id>` (rev 3 section 4, A4.1-5): the SharedOS audit events of one trace, restricted to
 * the caller's workspace (row-level security) and to events whose actor is the caller or that concern a
 * session the caller is a live member of (`chorus_my_sessions()`).
 */
export function registerAuditRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.get('/v1/audit', async (request, reply) => {
    const token = extractBearer(request.headers.authorization);
    const auth = token === undefined ? undefined : await resolveToken(deps.pool, token);
    if (auth === undefined) {
      return sendError(
        request,
        reply,
        401,
        'unauthenticated',
        'A valid Chorus bearer token is required.',
        {
          'www-authenticate': 'Bearer realm="chorus"',
        },
      );
    }
    const trace = (request.query as Record<string, unknown>)['trace'];
    if (typeof trace !== 'string' || !TRACE.test(trace)) {
      return sendError(
        request,
        reply,
        400,
        'invalid_request',
        'Query parameter trace is required.',
      );
    }
    const events = await withReadTx(
      { pool: deps.pool, workspaceId: auth.workspaceId, actorId: auth.actorId },
      async (db) => {
        const { rows } = await db.query<{ event: unknown }>(
          `SELECT event FROM sharedos_audit_events
            WHERE workspace_id = $1 AND event ->> 'traceId' = $2
              AND (   event -> 'actor' ->> 'agentId' = $3
                   OR (event -> 'resource' -> 'path' ->> 0 = 'sessions'
                       AND event -> 'resource' -> 'path' ->> 1 IN (SELECT s::text FROM chorus_my_sessions() s)))
            ORDER BY recorded_at, id
            LIMIT ${String(AUDIT_MAX_EVENTS)}`,
          [auth.workspaceId, trace, auth.actorId],
        );
        return rows.map((r) => r.event);
      },
    );
    return reply
      .code(200)
      .type('application/json; charset=utf-8')
      .send({ trace_id: trace, events });
  });
}
