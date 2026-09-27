import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@aicoo/sharedos';
import { keepFailureDetails } from '../../src/mcp-errors.ts';

const signal = new AbortController().signal;
const invocation = { callId: 'c1', tool: 'chorus.x', arguments: {} };

const wrap = (result: ToolResult) =>
  keepFailureDetails({
    catalog: () => Promise.reject(new Error('unused')),
    invoke: () => Promise.resolve(result),
  });

/** What `@aicoo/sharedos-mcp` produces for a failure: the fields it keeps, and no details. */
const rendered = (status: string, code: string, message: string, retryable?: boolean) => ({
  jsonrpc: '2.0',
  id: 7,
  result: {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status,
          code,
          message,
          ...(retryable === undefined ? {} : { retryable }),
        }),
      },
    ],
    isError: true,
    _meta: { 'sharedos/status': status, 'sharedos/code': code },
  },
});

describe('MCP failure details (the package drops error.details)', () => {
  it('puts details into the text body and structuredContent.error, leaving the existing fields alone', async () => {
    const details = { state: 'PAYMENT_REQUIRED', amount: 3, memo: 'chorus:v1:create_tasks:x' };
    const failed: ToolResult = {
      status: 'failed',
      callId: 'c1',
      tool: 'chorus.x',
      completedAt: 'now',
      error: { code: 'payment_required', message: 'Pay first.', retryable: false, details },
    };
    const { invoker, enrich } = wrap(failed);
    await invoker.invoke(invocation, signal);
    const out = enrich(rendered('failed', 'payment_required', 'Pay first.', false)) as unknown as {
      result: {
        content: { text: string }[];
        isError: boolean;
        _meta: Record<string, string>;
        structuredContent: { status: string; error: Record<string, unknown> };
      };
    };
    expect(JSON.parse(out.result.content[0]?.text ?? '{}')).toEqual({
      status: 'failed',
      code: 'payment_required',
      message: 'Pay first.',
      retryable: false,
      details,
    });
    expect(out.result.isError).toBe(true);
    expect(out.result._meta).toEqual({
      'sharedos/status': 'failed',
      'sharedos/code': 'payment_required',
    });
    expect(out.result.structuredContent).toEqual({
      status: 'failed',
      error: { code: 'payment_required', message: 'Pay first.', retryable: false, details },
    });
  });

  it('a denial without details gets a structured error with no details member', async () => {
    const denied: ToolResult = {
      status: 'denied',
      callId: 'c1',
      tool: 'chorus.x',
      completedAt: 'now',
      error: { code: 'no_matching_grant', message: 'No.', retryable: false },
    };
    const { invoker, enrich } = wrap(denied);
    await invoker.invoke(invocation, signal);
    const out = enrich(rendered('denied', 'no_matching_grant', 'No.', false)) as unknown as {
      result: {
        content: { text: string }[];
        structuredContent: { error: Record<string, unknown> };
      };
    };
    expect(out.result.structuredContent.error).toEqual({
      code: 'no_matching_grant',
      message: 'No.',
      retryable: false,
    });
    expect(JSON.parse(out.result.content[0]?.text ?? '{}')).not.toHaveProperty('details');
  });

  it('a denial never forwards details, even if some were attached', async () => {
    const denied: ToolResult = {
      status: 'denied',
      callId: 'c1',
      tool: 'chorus.x',
      completedAt: 'now',
      error: {
        code: 'no_matching_grant',
        message: 'No.',
        details: { session_id: 's', secret: 'x' },
      },
    };
    const { invoker, enrich } = wrap(denied);
    await invoker.invoke(invocation, signal);
    const out = enrich(rendered('denied', 'no_matching_grant', 'No.')) as unknown as {
      result: {
        content: { text: string }[];
        structuredContent: { error: Record<string, unknown> };
      };
    };
    expect(out.result.structuredContent.error).not.toHaveProperty('details');
    expect(JSON.parse(out.result.content[0]?.text ?? '{}')).not.toHaveProperty('details');
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('leaves successes, notifications and unrelated responses untouched', async () => {
    const succeeded: ToolResult = {
      status: 'succeeded',
      callId: 'c1',
      tool: 'chorus.x',
      completedAt: 'now',
      output: { ok: true },
    };
    const { invoker, enrich } = wrap(succeeded);
    await invoker.invoke(invocation, signal);
    const success = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false },
    };
    expect(enrich(success)).toBe(success);
    const nothing: unknown = undefined;
    expect(enrich(nothing)).toBeUndefined();
    const listed = { jsonrpc: '2.0', id: 2, result: { tools: [] } };
    expect(enrich(listed)).toBe(listed);
  });

  it('never throws on a body it cannot parse: the original response is returned', async () => {
    const failed: ToolResult = {
      status: 'failed',
      callId: 'c1',
      tool: 'chorus.x',
      completedAt: 'now',
      error: { code: 'internal_error', message: 'x', details: { n: 1 } },
    };
    const { invoker, enrich } = wrap(failed);
    await invoker.invoke(invocation, signal);
    const odd = {
      jsonrpc: '2.0',
      id: 3,
      result: { isError: true, content: [{ type: 'text', text: 'not json' }] },
    };
    expect(enrich(odd)).toBe(odd);
  });
});
