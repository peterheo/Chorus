const RETRYABLE = new Set([429, 502, 503]);
const MAX_RETRIES = 3;
const MAX_DELAY_MS = 30_000;

function retryDelay(value) {
  if (value === null) return 1_000;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Math.max(0, Math.min(MAX_DELAY_MS, Number.isFinite(ms) ? ms : 1_000));
}

export async function fetchRetry(url, init = {}) {
  for (let retry = 0; ; retry += 1) {
    const response = await fetch(url, init);
    if (!RETRYABLE.has(response.status) || retry === MAX_RETRIES) return response;
    const delay = retryDelay(response.headers.get('retry-after'));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function requireStatus(response, expected) {
  if (!expected.includes(response.status)) {
    const error = new Error('unexpected_http_status');
    error.httpStatus = response.status;
    throw error;
  }
}
