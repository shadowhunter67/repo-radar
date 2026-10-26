import { z } from 'zod';
const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
export const WebConfigSchema = z.object({
  token: z.string().optional(),
  port: integer(8787, 1, 65535),
  host: z.string().default('127.0.0.1'),
  jobTtlSeconds: integer(1800, 60, 86400),
  maxConcurrency: integer(2, 1, 8),
  maxQueue: integer(20, 0, 200),
  rateLimitPerMinute: integer(6, 1, 120),
  rateLimitHourly: integer(40, 1, 1000),
  analysisTimeoutSeconds: integer(300, 30, 1800),
  maxReportBytes: integer(25 * 1024 * 1024, 1, 100 * 1024 * 1024),
  trustProxy: z.coerce.boolean().default(false),
  requestBodyLimit: integer(4096, 1, 4096),
  nodeEnv: z.string().default('development'),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;
export function loadWebConfig(env: NodeJS.ProcessEnv = globalThis['process']['env']): WebConfig {
  const production = env.NODE_ENV === 'production';
  if (production && !env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required in production');
  const c = WebConfigSchema.parse({
    token: env.GITHUB_TOKEN,
    port: env.PORT,
    host: env.HOST,
    jobTtlSeconds: env.JOB_TTL_SECONDS,
    maxConcurrency: env.MAX_CONCURRENCY,
    maxQueue: env.MAX_QUEUE,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    rateLimitHourly: env.RATE_LIMIT_HOURLY,
    analysisTimeoutSeconds: env.ANALYSIS_TIMEOUT_SECONDS,
    maxReportBytes: env.MAX_REPORT_BYTES,
    trustProxy: env.TRUST_PROXY,
    requestBodyLimit: env.REQUEST_BODY_LIMIT,
    nodeEnv: env.NODE_ENV,
  });
  if (!production && !c.token) return c;
  return c;
}
