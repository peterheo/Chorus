import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { SharedOSKernel } from '@aicoo/sharedos';
import { McpToolServer, kernelToolBridge } from '@aicoo/sharedos-mcp';
import { extractBearer, resolveToken, type AuthContext } from './auth.ts';
import { sendError } from './http.ts';
import { MCP_INSTRUCTIONS } from './instructions.ts';
import { keepFailureDetails } from './mcp-errors.ts';
import type { RateLimiter } from './rate-limit.ts';
import { buildAccessContext } from './sharedos/access-context.ts';
import { runInRequestScope, type ChorusRequestScope } from './sharedos/request-scope.ts';

export interface McpDeps {
  readonly pool: pg.Pool;
  readonly kernel: SharedOSKernel;
  readonly version: string;
  readonly perToken: RateLimiter;
  /** Records the caller (and the tool, for `tools/call`) for the access-log line. */
  readonly note: (request: FastifyRequest, fields: { actorId?: string; tool?: string }) => void;
}

const NEVER = '9999-12-31T23:59:59.000Z';
const authOf = new WeakMap<FastifyRequest, AuthContext>();

const unauthenticated = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
  sendError(request, reply, 401, 'unauthenticated', 'A valid Chorus bearer token is required.', {
    'www-authenticate': 'Bearer realm="chorus"',
  });

/**
 * `POST /mcp`: JSON-only MCP over HTTP (rev 3 section 4). Authentication and the per-token rate limit run in
 * `onRequest`, so an unauthenticated request is refused before any body parsing or MCP work.
 */
export function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  app.post(
    '/mcp',
    {
      onRequest: async (request, reply) => {
        const token = extractBearer(request.headers.authorization);
        const auth = token === undefined ? undefined : await resolveToken(deps.pool, token);
        if (auth === undefined) return unauthenticated(request, reply);
        authOf.set(request, auth);
        deps.note(request, { actorId: auth.actorId });
        const decision = deps.perToken.hit(auth.tokenKey);
        if (!decision.ok) {
          return sendError(request, reply, 429, 'rate_limited', 'Too many requests.', {
            'retry-after': String(decision.retryAfterSeconds),
          });
        }
        return undefined;
      },
    },
    async (request, reply) => {
      const auth = authOf.get(request);
      if (auth === undefined) return unauthenticated(request, reply);
      const body: unknown = request.body;
      if (Array.isArray(body)) {
        return sendError(
          request,
          reply,
          400,
          'invalid_request',
          'JSON-RPC batches are not supported.',
        );
      }
      if (body === null || typeof body !== 'object') {
        return sendError(
          request,
          reply,
          400,
          'invalid_request',
          'The body must be a JSON-RPC object.',
        );
      }
      const params = (body as { params?: { name?: unknown } }).params;
      if (
        (body as { method?: unknown }).method === 'tools/call' &&
        typeof params?.name === 'string'
      ) {
        deps.note(request, { tool: params.name });
      }

      const scope: ChorusRequestScope = {
        workspaceId: auth.workspaceId,
        actorId: auth.actorId,
        instanceId: auth.instanceId,
        roomId: auth.roomId,
        tokenExpiresAt: auth.tokenExpiresAt?.toISOString() ?? NEVER,
      };
      const abort = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) abort.abort();
      };
      reply.raw.once('close', onClose);
      try {
        const details = keepFailureDetails(
          kernelToolBridge({
            kernel: deps.kernel,
            context: buildAccessContext(scope, request.id, new Date()),
            executionId: request.id,
          }),
        );
        const handled = await runInRequestScope(scope, () => {
          const server = new McpToolServer({
            invoker: details.invoker,
            serverInfo: { name: 'chorus', version: deps.version },
            instructions: MCP_INSTRUCTIONS,
          });
          return server.handle(body, abort.signal);
        });
        const response = details.enrich(handled);
        if (response === undefined) return await reply.code(202).send();
        return await reply.code(200).type('application/json; charset=utf-8').send(response);
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  const notAllowed = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    sendError(request, reply, 405, 'invalid_request', 'Use POST.', { allow: 'POST' });
  app.get('/mcp', (request, reply) => notAllowed(request, reply));
  app.delete('/mcp', (request, reply) => notAllowed(request, reply));
}
