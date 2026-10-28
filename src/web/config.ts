import { z } from 'zod';
const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
export const WebConfigSchema = z.object({
  token: z.string().optional(),
  port: integer(8787, 0, 65535),
  host: z.string().default('127.0.0.1'),
  jobTtlSeconds: integer(1800, 60, 86400),
  maxConcurrency: integer(2, 1, 8),
  maxQueue: integer(20, 0, 200),
  rateLimitPerMinute: integer(6, 1, 120),
  rateLimitHourly: integer(40, 1, 1000),
  analysisTimeoutSeconds: integer(300, 30, 1800),
  maxReportBytes: integer(25 * 1024 * 1024, 1, 100 * 1024 * 1024),
  // `z.coerce.boolean()` would turn the string "false" into true and silently enable proxy trust (spoofable rate limits)
  trustProxy: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.trim().toLowerCase()) : v),
      z.boolean(),
    )
    .default(false),
  requestBodyLimit: integer(4096, 1, 4096),
  nodeEnv: z.string().default('development'),
  workerMaxOldSpaceMb: integer(512, 64, 4096),
  maxStoredJobs: integer(200, 1, 10000),
  /** Exact-SHA report cache lifetime; 0 disables the cache. */
  cacheTtlSeconds: integer(600, 0, 3600),
  /** GitHub requests that must stay available after admitting a job (shared-token reserve). */
  quotaReserve: integer(300, 0, 5000),
  /** Assumed requests per analysis until real ones are observed. */
  estimatedRequestsPerJob: integer(60, 1, 5000),
  shutdownGraceSeconds: integer(20, 0, 300),
  /** Public https origin of this instance (used for self links only). */
  publicBaseUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https?:\/\/[^/?#]+\/?$/.test(u),
      'must be an origin without path, query or fragment',
    )
    .optional(),
  /** Commit the running image was built from (shown in /ready and the page footer). */
  buildCommit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;
export function loadWebConfig(env: NodeJS.ProcessEnv = globalThis['process']['env']): WebConfig {
  const production = env.NODE_ENV === 'production';
  if (production && !env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required in production');
  // On Render (RENDER=true) the free instance has 512 MB and a fraction of a CPU: unless a value is set explicitly, start
  // conservative (one worker, a short queue, a small worker heap) so a busy moment ends in QUEUE_FULL rather than an
  // out-of-memory restart. Nothing else about the server is Render-specific.
  const onRender = env.RENDER === 'true';
  const dflt = (value: string | undefined, onRenderValue: string): string | undefined =>
    value !== undefined && value !== '' ? value : onRender ? onRenderValue : undefined;
  // Platform build metadata is used when the explicit variable is absent; an unusable value is ignored, never fatal.
  const platformCommit = /^[0-9a-f]{7,40}$/.test(env.RENDER_GIT_COMMIT ?? '')
    ? env.RENDER_GIT_COMMIT
    : undefined;
  const platformUrl = /^https?:\/\/[^/?#]+\/?$/.test(env.RENDER_EXTERNAL_URL ?? '')
    ? env.RENDER_EXTERNAL_URL
    : undefined;
  const c = WebConfigSchema.parse({
    token: env.GITHUB_TOKEN,
    port: env.PORT,
    host: env.HOST,
    jobTtlSeconds: env.JOB_TTL_SECONDS,
    maxConcurrency: dflt(env.MAX_CONCURRENCY, '1'),
    maxQueue: dflt(env.MAX_QUEUE, '4'),
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    rateLimitHourly: env.RATE_LIMIT_HOURLY,
    analysisTimeoutSeconds: env.ANALYSIS_TIMEOUT_SECONDS,
    maxReportBytes: dflt(env.MAX_REPORT_BYTES, '8388608'),
    trustProxy: env.TRUST_PROXY,
    requestBodyLimit: env.REQUEST_BODY_LIMIT,
    nodeEnv: env.NODE_ENV,
    workerMaxOldSpaceMb: dflt(env.WORKER_MAX_OLD_SPACE_MB, '192'),
    maxStoredJobs: dflt(env.MAX_STORED_JOBS, '40'),
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,
    quotaReserve: env.QUOTA_RESERVE,
    estimatedRequestsPerJob: env.ESTIMATED_REQUESTS_PER_JOB,
    shutdownGraceSeconds: env.SHUTDOWN_GRACE_SECONDS,
    publicBaseUrl: env.PUBLIC_BASE_URL || platformUrl,
    buildCommit: env.BUILD_COMMIT || platformCommit,
  });
  if (production && c.publicBaseUrl && !c.publicBaseUrl.startsWith('https://'))
    throw new Error('PUBLIC_BASE_URL must use https in production');
  return c;
}
