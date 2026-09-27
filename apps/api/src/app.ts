import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.ts';
import { registerEnrollRoutes } from './enroll.ts';
import { sendError } from './http.ts';
import { RateLimiter } from './rate-limit.ts';

export interface AppLimits {
  readonly enrollStartPerRoomPerMinute: number;
  readonly enrollStartGlobalPerMinute: number;
  readonly enrollCompleteGlobalPerMinute: number;
}

const DEFAULT_LIMITS: AppLimits = {
  enrollStartPerRoomPerMinute: 20,
  enrollStartGlobalPerMinute: 60,
  enrollCompleteGlobalPerMinute: 120,
};

export interface AppOptions {
  readonly config: Pick<Config, 'publicBaseUrl' | 'leaseDurationSeconds' | 'gitCommit'>;
  readonly pool: pg.Pool;
  readonly version?: string;
  /** Overridable in tests (an internal constructor option, not environment). */
  readonly limits?: Partial<AppLimits>;
  /** Where structured logs go. Defaults to stdout. */
  readonly logStream?: Writable;
}

/** Header/body fields that must never reach a log line. */
const REDACT = [
  'req.headers.authorization',
  'headers.authorization',
  'body',
  'req.body',
  'secret',
  'token',
  'content',
  'notes',
  'args',
];

interface RequestNotes {
  actorId?: string;
  tool?: string;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { pool, config } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const notes = new WeakMap<FastifyRequest, RequestNotes>();

  const app = Fastify({
    logger: {
      level: 'info',
      redact: { paths: REDACT, censor: '[redacted]' },
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
    },
    // Access lines are written by the onResponse hook below, with an explicit allow-list of fields.
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    requestTimeout: 30_000,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.addHook('onRequest', (request, reply, done) => {
    // On the raw response so it is also present when the MCP transport takes over (hijacked replies).
    reply.raw.setHeader('x-request-id', request.id);
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const note = notes.get(request) ?? {};
    request.log.info(
      {
        request_id: request.id,
        method: request.method,
        path: request.url.split('?')[0],
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
        ...(note.actorId === undefined ? {} : { actor_id: note.actorId }),
        ...(note.tool === undefined ? {} : { tool: note.tool }),
      },
      'request',
    );
    done();
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(request, reply, 404, 'not_found', 'No such route.'),
  );

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413)
      return sendError(request, reply, 413, 'invalid_request', 'The request body is too large.');
    if (status !== undefined && status >= 400 && status < 500) {
      return sendError(
        request,
        reply,
        status,
        'invalid_request',
        'The request could not be parsed.',
      );
    }
    request.log.error({ request_id: request.id, error: (error as Error).name }, 'unhandled error');
    return sendError(
      request,
      reply,
      500,
      'internal_error',
      `Unexpected error. Quote request_id ${request.id} when reporting it.`,
    );
  });

  // ---------------------------------------------------------------------------------------------
  // Enrollment (public, no auth) and health.
  // ---------------------------------------------------------------------------------------------
  registerEnrollRoutes(app, {
    pool,
    publicBaseUrl: config.publicBaseUrl,
    limiters: {
      startPerRoom: new RateLimiter({
        limit: limits.enrollStartPerRoomPerMinute,
        windowMs: 60_000,
      }),
      startGlobal: new RateLimiter({ limit: limits.enrollStartGlobalPerMinute, windowMs: 60_000 }),
      completeGlobal: new RateLimiter({
        limit: limits.enrollCompleteGlobalPerMinute,
        windowMs: 60_000,
      }),
    },
  });

  app.get('/healthz', async (_request, reply) => {
    try {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('health check timed out'));
        }, 2000).unref();
      });
      await Promise.race([pool.query('SELECT 1'), timeout]);
      const { rows } = await pool.query<{
        external_room_id: string;
        activation_state: string;
        watcher_ok: boolean;
      }>('SELECT * FROM chorus_room_health()');
      return await reply.code(200).send({
        status: 'ok',
        commit: config.gitCommit,
        db: 'ok',
        rooms: rows.map((r) => ({
          sharednet_room_id: r.external_room_id,
          activation_state: r.activation_state,
          watcher_ok: r.watcher_ok,
        })),
      });
    } catch {
      return reply
        .code(503)
        .send({ status: 'degraded', commit: config.gitCommit, db: 'down', rooms: [] });
    }
  });

  return app;
}
