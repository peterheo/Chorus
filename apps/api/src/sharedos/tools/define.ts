import type { AccessContext, JsonObject, ToolCall, ToolHandler, ToolResult } from '@aicoo/sharedos';
import type pg from 'pg';
import {
  ChorusError,
  isChorusError,
  type CommandContext,
  type ReadContext,
  type SessionAction,
  type RoomAction,
  type Uuid,
} from '@chorus/domain';
import type { ArenaDeps } from '../../arena/payments.ts';
import type { RateLimiter } from '../../rate-limit.ts';
import type { KeyObject } from 'node:crypto';
import { requireRequestScope, type ChorusRequestScope } from '../request-scope.ts';

export interface ToolDeps {
  readonly pool: pg.Pool;
  readonly leaseDurationSeconds: number;
  readonly gitCommit: string;
  /** Paid Arena tools need the ledger; absent in tests that never call them. */
  readonly arena?: ArenaDeps;
  /** Per-actor limits for the tools that name one (`rateLimit`). */
  readonly limits?: {
    readonly paid: RateLimiter;
    readonly pulse: RateLimiter;
    readonly conversation?: RateLimiter;
  };
  /** `enabled`: the free create_session / create_task are not registered (only their paid equivalents). */
  readonly billing?: 'enabled' | 'disabled';
  readonly sharednet?: { readonly baseUrl: string; readonly secretsKey: Buffer };
  readonly receipts?: {
    readonly privateKey: KeyObject | null;
    readonly keyId: string | null;
    readonly gitCommit: string;
    readonly publicBaseUrl: string;
  };
  readonly logger: { error: (obj: Record<string, unknown>, msg: string) => void };
}

type Args = Record<string, unknown>;
type PropType = 'string' | 'integer' | 'boolean' | 'array' | 'object';
/** An array's items: either bare strings, or objects with their own published (but not enforced) schema. */
type PropItems =
  | { readonly type: 'string' }
  | { readonly type: 'object' }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, Prop>>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
    };
export interface Prop {
  readonly type: PropType;
  readonly items?: PropItems;
  // Published for the caller's benefit only; valueMatches() below checks types, never these bounds. The
  // domain re-validates everything, so a schema that under- or over-states a bound is a docs bug, not a hole.
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export const S: Prop = { type: 'string' };
export const I: Prop = { type: 'integer' };
export const B: Prop = { type: 'boolean' };
export const SA: Prop = { type: 'array', items: { type: 'string' } };
export const OA: Prop = { type: 'array', items: { type: 'object' } };

/** An array of objects, each with its own published shape: exactly `properties`/`required`, nothing else. */
export function objectArray(
  properties: Readonly<Record<string, Prop>>,
  required: readonly string[],
): Prop {
  return {
    type: 'array',
    items: { type: 'object', properties, required, additionalProperties: false },
  };
}

/** What a handler's `run` receives: the domain contexts for the authenticated caller, and the tool's arguments. */
export interface ToolRun {
  /** The arguments minus `idempotency_key`, ready to hand to the domain function. */
  readonly input: Args;
  readonly read: ReadContext & { readonly roomId: Uuid };
  readonly command: CommandContext;
  /** The authenticated caller's request scope (identity, room, token expiry). */
  readonly scope: ChorusRequestScope;
  readonly deps: ToolDeps;
}

export interface ChorusToolSpec {
  readonly name: string;
  readonly description: string;
  readonly action: SessionAction | RoomAction;
  readonly write: boolean;
  readonly props: Readonly<Record<string, Prop>>;
  readonly required: readonly string[];
  /**
   * `key` (default): a write tool takes an `idempotency_key`. `request_id`: the tool's own `request_id` is its
   * idempotency (paid tools), so no `idempotency_key` is injected and the command context carries none.
   */
  readonly idempotency?: 'key' | 'request_id';
  /** Which per-actor limiter this tool counts against. */
  readonly rateLimit?: 'paid' | 'pulse' | 'conversation';
  /** The resource path under the `chorus` namespace, from the parsed arguments only. */
  readonly path: (args: Args) => string[];
  readonly run: (run: ToolRun) => Promise<unknown>;
}

const valueMatches = (value: unknown, prop: Prop): boolean => {
  switch (prop.type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return (
        Array.isArray(value) &&
        value.every((v) =>
          prop.items?.type === 'object'
            ? typeof v === 'object' && v !== null && !Array.isArray(v)
            : typeof v === 'string',
        )
      );
  }
};

/** Round-trips through JSON so dates and undefined become plain JSON values. */
const jsonObject = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value === undefined ? {} : value)) as JsonObject;

/** Builds one SharedOS ToolHandler from a declarative spec; every tool shares this mapping and error translation. */
export function defineChorusTool(spec: ChorusToolSpec, deps: ToolDeps): ToolHandler {
  const keyed = spec.write && spec.idempotency !== 'request_id';
  const props: Record<string, Prop> = keyed
    ? { ...spec.props, idempotency_key: S }
    : { ...spec.props };
  const required = keyed ? [...spec.required, 'idempotency_key'] : [...spec.required];

  const parseArguments = (raw: unknown): Args => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('arguments must be an object');
    }
    const args = raw as Args;
    for (const [key, value] of Object.entries(args)) {
      const prop = props[key];
      if (prop === undefined) throw new TypeError(`unknown argument ${key}`);
      if (!valueMatches(value, prop)) throw new TypeError(`argument ${key} has the wrong type`);
    }
    for (const key of required) {
      if (!(key in args)) throw new TypeError(`missing required argument ${key}`);
    }
    return args;
  };

  const failed = (
    call: ToolCall,
    code: string,
    message: string,
    extra: { retryable?: boolean; details?: unknown } = {},
  ): ToolResult => ({
    status: 'failed',
    callId: call.id,
    tool: call.tool,
    completedAt: new Date().toISOString(),
    error: {
      code,
      message,
      ...(extra.retryable === true ? { retryable: true } : {}),
      ...(extra.details === undefined ? {} : { details: jsonObject(extra.details) }),
    },
  });

  return {
    definition: {
      name: spec.name,
      description: spec.description,
      namespace: 'chorus',
      source: 'host',
      readWrite: spec.write ? 'write' : 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(props).map(([k, p]) => [k, { ...p }]),
        ) as JsonObject,
        required,
      },
      requiredCapability: { resource: { namespace: 'chorus', path: [] }, action: spec.action },
    },
    parseArguments,
    resolveRequirement: (_context: AccessContext, call: ToolCall) => ({
      resource: { namespace: 'chorus', path: spec.path(parseArguments(call.arguments)) },
      action: spec.action,
    }),
    invoke: async (context: AccessContext, call: ToolCall): Promise<ToolResult> => {
      try {
        const scope = requireRequestScope();
        // Fail closed if the request scope and the authorized context ever disagree.
        if (
          context.actor.kind !== 'agent' ||
          scope.actorId !== context.actor.agentId ||
          scope.workspaceId !== context.namespaceId ||
          context.owner.kind !== 'group' ||
          context.owner.conversationId !== scope.roomId
        ) {
          return failed(call, 'internal_error', 'The request scope does not match the caller.');
        }
        const limiter = spec.rateLimit === undefined ? undefined : deps.limits?.[spec.rateLimit];
        if (spec.rateLimit === 'conversation' && limiter === undefined) {
          throw new ChorusError('internal_error', 'The conversation rate limit is not configured.');
        }
        if (limiter !== undefined) {
          const decision = limiter.hit(scope.actorId);
          if (!decision.ok) {
            throw new ChorusError('rate_limited', 'Too many requests; retry later.', {
              details: { retry_after_seconds: decision.retryAfterSeconds },
            });
          }
        }
        const { idempotency_key: key, ...input } = parseArguments(call.arguments);
        const base = { pool: deps.pool, workspaceId: scope.workspaceId, actorId: scope.actorId };
        const output = await spec.run({
          input,
          scope,
          deps,
          read: { ...base, roomId: scope.roomId },
          command: {
            ...base,
            instanceId: scope.instanceId,
            roomId: scope.roomId,
            leaseDurationSeconds: deps.leaseDurationSeconds,
            idempotencyKey: typeof key === 'string' ? key : undefined,
          },
        });
        return {
          status: 'succeeded',
          callId: call.id,
          tool: call.tool,
          completedAt: new Date().toISOString(),
          output: { ...jsonObject(output), audit_trace_id: context.traceId },
        };
      } catch (error) {
        if (isChorusError(error)) {
          return failed(call, error.code, error.message, {
            retryable: error.retryable,
            details: error.details,
          });
        }
        deps.logger.error(
          { traceId: context.traceId, tool: call.tool, name: (error as Error).name },
          'tool failed unexpectedly',
        );
        return failed(call, 'internal_error', 'The request could not be completed.');
      }
    },
  };
}
