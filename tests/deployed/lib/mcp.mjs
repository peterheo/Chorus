import { fetchRetry, requireStatus } from './http.mjs';

export async function connectMcp(baseUrl, token, onErrorCode) {
  let nextId = 1;
  const endpoint = `${baseUrl}/mcp`;
  const post = async (payload, expected = [200]) => {
    const response = await fetchRetry(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    requireStatus(response, expected);
    const text = await response.text();
    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error('invalid_json_rpc_body');
      }
    }
    return { response, body };
  };
  const rpc = async (method, params) => {
    const id = nextId++;
    const { body } = await post({ jsonrpc: '2.0', id, method, params });
    if (body?.id !== id || body?.jsonrpc !== '2.0' || body?.error !== undefined) {
      const error = new Error('invalid_json_rpc_response');
      error.errorCode = body?.error?.code;
      throw error;
    }
    return body.result;
  };

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'chorus-deployed-e2e', version: '1.0.0' },
  });
  const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, [202]);
  if (notification.body !== null) throw new Error('notification_body_not_empty');

  return {
    listTools: () => rpc('tools/list', {}),
    call: async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      let data = result?.structuredContent;
      if (data === undefined || (result?.isError === true && data?.error === undefined)) {
        const text = result?.content?.find((item) => item.type === 'text')?.text;
        if (typeof text === 'string') {
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error('invalid_tool_result_json');
          }
        }
      }
      const errorCode = result?.structuredContent?.error?.code ?? data?.error?.code ?? data?.code;
      if (result?.isError === true && typeof onErrorCode === 'function') {
        onErrorCode({
          tool: name,
          code: errorCode,
          source:
            result?.structuredContent?.error?.code !== undefined
              ? 'structuredContent.error.code'
              : data?.error?.code !== undefined
                ? 'content.error.code'
                : data?.code !== undefined
                  ? 'content.code'
                  : 'missing',
        });
      }
      return {
        isError: result?.isError === true,
        data: data ?? {},
        errorCode,
      };
    },
  };
}
