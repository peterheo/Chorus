import type { AccessContext, JsonObject, ToolCall, ToolHandler, ToolResult } from '@aicoo/sharedos';
import type pg from 'pg';
import {
  isChorusError,
  type CommandContext,
  type ReadContext,
  type SessionAction,
  type RoomAction,
  type Uuid,
} from '@chorus/domain';
import { requireRequestScope, type ChorusRequestScope } from '../request-scope.ts';

export interface ToolDeps {
  readonly pool: pg.Pool;
  readonly leaseDurationSeconds: number;
  readonly gitCommit: string;
  readonly logger: { error: (obj: Record<string, unknown>, msg: string) => void };
}

type Args = Record<string, unknown>;
type PropType = 'string' | 'integer' | 'boolean' | 'array' | 'object';
export interface Prop {
  readonly type: PropType;
  readonly items?: { readonly type: 'string' | 'object' };
}

export const S: Prop = { type: 'string' };
export const I: Prop = { type: 'integer' };
export const B: Prop = { type: 'boolean' };
export const SA: Prop = { type: 'array', items: { type: 'string' } };
export const OA: Prop = { type: 'array', items: { type: 'object' } };

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
  const props: Record<string, Prop> = spec.write
    ? { ...spec.props, idempotency_key: S }
    : { ...spec.props };
  const required = spec.write ? [...spec.required, 'idempotency_key'] : [...spec.required];

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
        properties: Object.fromEntries(Object.entries(props).map(([k, p]) => [k, { ...p }])),
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
