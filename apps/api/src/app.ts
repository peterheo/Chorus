import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.ts';
import { registerActivateRoutes } from './activate.ts';
import { createLedgerFor, type ArenaDeps } from './arena/payments.ts';
import { registerAuditRoutes } from './audit-read.ts';
import { registerEnrollRoutes } from './enroll.ts';
import { sendError } from './http.ts';
import { registerMcpRoutes } from './mcp.ts';
import { RateLimiter } from './rate-limit.ts';
import type { SharedNetClient } from './sharednet/client.ts';
import { createChorusKernel } from './sharedos/kernel.ts';
import { registerStaticPages } from './static.ts';

export interface AppLimits {
  readonly enrollStartPerRoomPerMinute: number;
  readonly enrollStartGlobalPerMinute: number;
  readonly enrollCompleteGlobalPerMinute: number;
  readonly mcpPerTokenPerMinute: number;
  readonly activateGlobalPerMinute: number;
  readonly paidPerActorPerMinute: number;
  readonly pulsePerActorPerMinute: number;
}

const DEFAULT_LIMITS: AppLimits = {
  enrollStartPerRoomPerMinute: 20,
  enrollStartGlobalPerMinute: 60,
  enrollCompleteGlobalPerMinute: 120,
  mcpPerTokenPerMinute: 120,
  activateGlobalPerMinute: 10,
  paidPerActorPerMinute: 30,
  pulsePerActorPerMinute: 10,
};

export interface AppOptions {
  readonly config: Pick<Config, 'publicBaseUrl' | 'leaseDurationSeconds' | 'gitCommit'> &
    Partial<Pick<Config, 'billing' | 'sharednetBaseUrl'>>;
  readonly pool: pg.Pool;
  /** For `POST /v1/rooms/activate`: the SharedNet client and the key that seals the seat token. */
  readonly sharednet: { readonly client: SharedNetClient; readonly secretsKey: Buffer };
  /** Test seam: the ledger the paid tools verify against (default: the payee seat's SharedNet ledger). */
  readonly arena?: { readonly ledgerFor?: ArenaDeps['ledgerFor'] };
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

/** How long shutdown waits for buffered audit events to be written. */
const AUDIT_FLUSH_TIMEOUT_MS = 5000;

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

  const note = (request: FastifyRequest, fields: RequestNotes): void => {
    notes.set(request, { ...notes.get(request), ...fields });
  };

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

  // ---------------------------------------------------------------------------------------------
  // SharedOS host: the kernel with every chorus.* tool, served as JSON-only MCP on POST /mcp, plus the
  // audit read and the entry pages.
  // ---------------------------------------------------------------------------------------------
  const billing = config.billing ?? 'disabled';
  const sharednetBaseUrl = config.sharednetBaseUrl ?? 'https://www.sharednet.ai';
  const arena: ArenaDeps = {
    pool,
    sharednetBaseUrl,
    ledgerFor:
      options.arena?.ledgerFor ??
      createLedgerFor(pool, options.sharednet.secretsKey, sharednetBaseUrl),
  };
  const { kernel, audit } = createChorusKernel({
    pool,
    leaseDurationSeconds: config.leaseDurationSeconds,
    gitCommit: config.gitCommit,
    billing,
    arena,
    limits: {
      paid: new RateLimiter({ limit: limits.paidPerActorPerMinute, windowMs: 60_000 }),
      pulse: new RateLimiter({ limit: limits.pulsePerActorPerMinute, windowMs: 60_000 }),
    },
    logger: {
      error: (obj, msg) => {
        app.log.error(obj, msg);
      },
    },
  });
  registerMcpRoutes(app, {
    pool,
    kernel,
    version: options.version ?? '0.0.0',
    billing,
    perToken: new RateLimiter({ limit: limits.mcpPerTokenPerMinute, windowMs: 60_000 }),
    note,
  });
  registerActivateRoutes(app, {
    pool,
    client: options.sharednet.client,
    secretsKey: options.sharednet.secretsKey,
    publicBaseUrl: config.publicBaseUrl,
    limiter: new RateLimiter({ limit: limits.activateGlobalPerMinute, windowMs: 60_000 }),
  });
  registerAuditRoutes(app, { pool });
  registerStaticPages(app, {
    publicBaseUrl: config.publicBaseUrl,
    billingEnabled: billing === 'enabled',
  });
  // Shutdown: the HTTP server has already stopped accepting and drained (Fastify close); write what is buffered.
  app.addHook('onClose', async () => {
    await Promise.race([
      audit.flush().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_TIMEOUT_MS).unref()),
    ]);
  });

  app.get('/healthz', async (_request, reply) => {
    try {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('health check timed out'));
        }, 2000).unref();
      });
      await Promise.race([pool.query('SELECT 1'), timeout]);
      const { rows } = await pool.query<{ activation_state: string; watcher_ok: boolean }>(
        'SELECT activation_state, watcher_ok FROM chorus_room_health()',
      );
      const active = rows.filter((r) => r.activation_state === 'active');
      // Counts only: a public health check never names a room.
      return await reply.code(200).send({
        status: 'ok',
        commit: config.gitCommit,
        db: 'ok',
        audit_write_failures: audit.failures(),
        rooms_active: active.length,
        watcher_ok_rooms: active.filter((r) => r.watcher_ok).length,
      });
    } catch {
      return reply.code(503).send({
        status: 'degraded',
        commit: config.gitCommit,
        db: 'down',
        audit_write_failures: audit.failures(),
        rooms_active: 0,
        watcher_ok_rooms: 0,
      });
    }
  });

  return app;
}
