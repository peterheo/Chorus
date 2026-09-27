import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorCode } from '@chorus/domain';

/** Error envelope for every non-2xx HTTP response: `{error, status, message, request_id}`. */
export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ErrorCode | 'not_found',
  message: string,
  headers: Record<string, string> = {},
): FastifyReply {
  for (const [name, value] of Object.entries(headers)) void reply.header(name, value);
  return reply
    .code(status)
    .type('application/json; charset=utf-8')
    .send({ error: code, status, message, request_id: request.id });
}
