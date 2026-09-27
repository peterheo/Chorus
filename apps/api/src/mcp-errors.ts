import type { ToolResult } from '@aicoo/sharedos';
import type { McpToolInvoker } from '@aicoo/sharedos-mcp';

/**
 * `@aicoo/sharedos-mcp` renders a failed or denied tool result as `{status, code, message, retryable}` and
 * drops `error.details`: the payment quote of `payment_required`, `current_version` on a conflict, and so on
 * would never reach an agent. This wraps the invoker so the FAILURE of the one `tools/call` in a request can be
 * put back: `details` joins the text body, and `structuredContent.error` carries the whole error. Everything
 * the package already sends (text fields, `isError`, `_meta`) is unchanged.
 */
export interface FailureDetails {
  readonly invoker: McpToolInvoker;
  /** Adds the failure details to the JSON-RPC response of this request (a no-op for anything else). */
  readonly enrich: <T>(response: T) => T;
}

type ToolFailure = Extract<ToolResult, { status: 'failed' | 'denied' }>;

export function keepFailureDetails(inner: McpToolInvoker): FailureDetails {
  let failure: ToolFailure | undefined;
  const invoker: McpToolInvoker = {
    catalog: (signal) => inner.catalog(signal),
    invoke: async (invocation, signal) => {
      const result = await inner.invoke(invocation, signal);
      if (result.status !== 'succeeded') failure = result;
      return result;
    },
  };
  const enrich = <T>(response: T): T => {
    const result = (response as { result?: Record<string, unknown> } | undefined)?.result;
    if (failure === undefined || result === undefined || result['isError'] !== true)
      return response;
    const { error, status } = failure;
    const content = result['content'];
    const first = Array.isArray(content)
      ? (content[0] as { type?: string; text?: string })
      : undefined;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
    } catch {
      return response;
    }
    if (error.details !== undefined) body['details'] = error.details;
    const enriched = {
      ...result,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: {
        status,
        error: {
          code: error.code,
          message: error.message,
          ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
    return { ...response, result: enriched };
  };
  return { invoker, enrich };
}
