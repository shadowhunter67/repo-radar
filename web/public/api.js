const timeoutMs = 15000;
export class ApiError extends Error {
  constructor(code, message, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
async function request(path, options = {}) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(path, { ...options, signal: c.signal });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = {
        error: { code: 'INTERNAL_ERROR', message: 'The server returned an invalid response.' },
      };
    }
    if (!r.ok)
      throw new ApiError(
        data.error?.code ?? 'INTERNAL_ERROR',
        data.error?.message ?? 'The request failed.',
        r.headers.get('retry-after'),
      );
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw new ApiError('NETWORK_FAILURE', 'The request timed out.');
    throw new ApiError('NETWORK_FAILURE', 'The network request failed.');
  } finally {
    clearTimeout(timer);
  }
}
export function submit(repository, ref) {
  const body = { repository, ...(ref ? { ref } : {}) };
  return request('/api/v1/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
export function poll(id) {
  return request(`/api/v1/jobs/${encodeURIComponent(id)}`);
}
export const reportUrl = (id) => `/api/v1/jobs/${encodeURIComponent(id)}/report`;
/* global AbortController, setTimeout, clearTimeout, fetch */
