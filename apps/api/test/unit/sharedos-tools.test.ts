import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ERROR_STATUS, ChorusError, type ErrorCode, type Uuid } from '@chorus/domain';
import { buildAccessContext } from '../../src/sharedos/access-context.ts';
import { runInRequestScope, type ChorusRequestScope } from '../../src/sharedos/request-scope.ts';
import { defineChorusTool, S } from '../../src/sharedos/tools/define.ts';
import { chorusTools } from '../../src/sharedos/tools/index.ts';

const deps = {
  pool: {} as pg.Pool,
  leaseDurationSeconds: 900,
  logger: { error: () => undefined },
};

const scope: ChorusRequestScope = {
  workspaceId: '0195f0aa-0000-7000-8000-000000000001' as Uuid,
  actorId: '0195f0aa-0000-7000-8000-000000000002' as Uuid,
  instanceId: null,
  roomId: '0195f0aa-0000-7000-8000-000000000003' as Uuid,
  tokenExpiresAt: '2030-01-01T00:00:00.000Z',
};

describe('chorus tool definitions', () => {
  const tools = chorusTools(deps);

  it('K11 tools.snapshot: exactly the 23 shipped tools, with stable definitions', () => {
    const definitions = tools.map((t) => t.definition).sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(definitions).toHaveLength(23);
    expect(definitions).toMatchSnapshot();
  });

  it('every tool is namespaced, has a static capability and a strict object input schema', () => {
    for (const { definition: d } of tools) {
      expect(d.name).toMatch(/^chorus\.[a-z_]+$/);
      expect(d.namespace).toBe('chorus');
      expect(d.requiredCapability.resource).toEqual({ namespace: 'chorus', path: [] });
      expect(d.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(d.description.length).toBeGreaterThan(20);
      // Mutations, and only mutations, carry an idempotency key.
      const required = (d.inputSchema as { required: string[] }).required;
      expect(required.includes('idempotency_key')).toBe(d.readWrite === 'write');
    }
  });

  it('K8 sharedos.arguments: missing, wrongly typed and unknown arguments are rejected by the parser', () => {
    const claim = tools.find((t) => t.definition.name === 'chorus.claim');
    const good = { session_id: 's', task_id: 't', expected_version: 1, idempotency_key: 'k' };
    expect(() => claim?.parseArguments(good)).not.toThrow();
    expect(() => claim?.parseArguments({ ...good, session_id: undefined } as never)).toThrow();
    const { task_id: _dropped, ...missing } = good;
    expect(() => claim?.parseArguments(missing)).toThrow();
    expect(() => claim?.parseArguments({ ...good, expected_version: '1' })).toThrow();
    expect(() => claim?.parseArguments({ ...good, expected_version: 1.5 })).toThrow();
    expect(() => claim?.parseArguments({ ...good, extra: 1 })).toThrow();
    expect(() => claim?.parseArguments([] as never)).toThrow();
  });

  it('resolves the resource path from the arguments alone', () => {
    const at = (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((t) => t.definition.name === name);
      const context = buildAccessContext(scope, 'trace-1', new Date());
      const call = {
        id: 'c',
        tool: name,
        arguments: args,
        traceId: 'trace-1',
        requestedAt: context.now,
      };
      return tool?.resolveRequirement?.(context, call as never);
    };
    expect(at('chorus.list_sessions', {})?.resource.path).toEqual(['room']);
    expect(at('chorus.get_session', { session_id: 'S' })?.resource.path).toEqual(['sessions', 'S']);
    expect(
      at('chorus.claim', {
        session_id: 'S',
        task_id: 'T',
        expected_version: 1,
        idempotency_key: 'k',
      })?.resource.path,
    ).toEqual(['sessions', 'S', 'tasks', 'T']);
    expect(
      at('chorus.review', {
        session_id: 'S',
        review_id: 'R',
        expected_version: 1,
        verdict: 'approved',
        content_sha256: 'x',
        idempotency_key: 'k',
      })?.resource.path,
    ).toEqual(['sessions', 'S', 'reviews', 'R']);
    // No resource ever carries an owner.
    expect(at('chorus.list_sessions', {})?.resource.owner).toBeUndefined();
  });

  it('K7 sharedos.errors.mapping: every Chorus error code becomes a failed result with that exact code', async () => {
    for (const code of Object.keys(ERROR_STATUS) as ErrorCode[]) {
      const tool = defineChorusTool(
        {
          name: 'chorus.probe',
          description: 'probe tool for the error mapping test',
          action: 'read',
          write: false,
          props: { x: S },
          required: [],
          path: () => ['room'],
          run: () => Promise.reject(new ChorusError(code, `probe ${code}`, { details: { n: 1 } })),
        },
        deps,
      );
      const context = buildAccessContext(scope, 'trace-1', new Date());
      const result = await runInRequestScope(scope, () =>
        tool.invoke(
          context,
          {
            id: 'c',
            tool: 'chorus.probe',
            arguments: {},
            traceId: 'trace-1',
            requestedAt: context.now,
          },
          new AbortController().signal,
        ),
      );
      expect(result).toMatchObject({ status: 'failed', error: { code, details: { n: 1 } } });
      if (result.status === 'failed') {
        expect(result.error.retryable === true).toBe(code === 'temporarily_unavailable');
      }
    }
  });

  it('a non-Chorus exception becomes a generic internal_error that leaks nothing', async () => {
    const tool = defineChorusTool(
      {
        name: 'chorus.probe',
        description: 'probe tool for the internal error test',
        action: 'read',
        write: false,
        props: {},
        required: [],
        path: () => ['room'],
        run: () => Promise.reject(new Error('connection string postgres://secret@host')),
      },
      deps,
    );
    const context = buildAccessContext(scope, 'trace-1', new Date());
    const result = await runInRequestScope(scope, () =>
      tool.invoke(
        context,
        {
          id: 'c',
          tool: 'chorus.probe',
          arguments: {},
          traceId: 'trace-1',
          requestedAt: context.now,
        },
        new AbortController().signal,
      ),
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'internal_error' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
