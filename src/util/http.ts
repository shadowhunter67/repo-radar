import { redactSecrets } from './text.js';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(redactSecrets(message));
    this.name = 'HttpError';
  }
}
export class RateLimitError extends HttpError {
  constructor(
    url: string,
    status: number,
    readonly resetAt?: Date,
  ) {
    super(`rate limited by ${new URL(url).host}`, status, url);
    this.name = 'RateLimitError';
  }
}
export class TooLargeError extends Error {
  constructor(url: string, limit: number) {
    super(`response from ${new URL(url).host} exceeded ${limit} bytes`);
    this.name = 'TooLargeError';
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super('request timed out');
    this.name = 'TimeoutError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetch?: FetchLike;
  /** Hosts requests may go to. Anything else is refused (SSRF / redirect guard). */
  allowedHosts: string[];
  /** Hosts that may receive the Authorization header. */
  authHosts?: string[];
  token?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  retryDelayMs?: number;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: string;
}

export interface RequestInput {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  /** Return the body as latin1 text (one char per byte) so `Buffer.from(body, 'latin1')` recovers the exact bytes. */
  binary?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly fetchFn: FetchLike;
  private readonly allowedHosts: string[];
  private readonly authHosts: string[];
  private readonly token: string | undefined;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly retryDelayMs: number;
  requests = 0;

  constructor(o: HttpClientOptions) {
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
    this.allowedHosts = o.allowedHosts;
    this.authHosts = o.authHosts ?? [];
    this.token = o.token || undefined;
    this.userAgent = o.userAgent ?? 'repo-radar';
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.maxBytes = o.maxBytes ?? 2_000_000;
    this.retryDelayMs = o.retryDelayMs ?? 300;
  }

  get hasToken(): boolean {
    return !!this.token;
  }

  async request(url: string, init: RequestInput = {}, hops = 0): Promise<HttpResult> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !this.allowedHosts.includes(u.host)) {
      throw new HttpError(`refusing request to non-allowlisted host ${u.host}`, 0, url);
    }
    const headers: Record<string, string> = { 'User-Agent': this.userAgent, ...init.headers };
    if (this.token && this.authHosts.includes(u.host)) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const maxBytes = init.maxBytes ?? this.maxBytes;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.requests++;
        const request = this.fetchFn(url, {
          method: init.method ?? 'GET',
          headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new RequestTimeoutError()), this.timeoutMs),
        );
        const res = await Promise.race([request, timeout]);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc || hops >= 2) throw new HttpError('unfollowable redirect', res.status, url);
          const target = new URL(loc, url);
          if (target.protocol !== 'https:' || !this.allowedHosts.includes(target.host)) {
            throw new HttpError(`refusing redirect to ${target.host}`, res.status, url);
          }
          return await this.request(target.toString(), init, hops + 1);
        }
        const remaining = res.headers.get('x-ratelimit-remaining');
        if (
          (res.status === 403 || res.status === 429) &&
          (remaining === '0' || res.status === 429)
        ) {
          const reset = res.headers.get('x-ratelimit-reset');
          throw new RateLimitError(
            url,
            res.status,
            reset ? new Date(Number(reset) * 1000) : undefined,
          );
        }
        if (res.status >= 500 && attempt === 0) {
          await sleep(this.retryDelayMs);
          continue;
        }
        const body = await readCapped(res, maxBytes, url, init.binary === true);
        return { status: res.status, headers: res.headers, body };
      } catch (e) {
        if (e instanceof HttpError || e instanceof TooLargeError) throw e;
        lastErr = e;
        if (attempt === 0) await sleep(this.retryDelayMs);
      }
    }
    const raw = lastErr instanceof Error ? lastErr.message : String(lastErr);
    // Besides pattern-based redaction, scrub the exact token value we hold.
    const msg = this.token ? raw.split(this.token).join('[REDACTED]') : raw;
    throw new HttpError(`network error: ${msg}`, 0, url);
  }
}

async function readCapped(
  res: Response,
  maxBytes: number,
  url: string,
  binary = false,
): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new TooLargeError(url, maxBytes);
  if (!res.body) {
    if (!binary) {
      const text = await res.text();
      if (Buffer.byteLength(text) > maxBytes) throw new TooLargeError(url, maxBytes);
      return text;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new TooLargeError(url, maxBytes);
    return buf.toString('latin1');
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }
  const all = Buffer.concat(chunks);
  return binary ? all.toString('latin1') : new TextDecoder('utf-8').decode(all);
}
