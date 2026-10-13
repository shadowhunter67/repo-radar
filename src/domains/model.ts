import { z } from 'zod';

/**
 * External domain intelligence (schema 0.7): which hostnames the analyzed repository's own files refer to, and in what
 * context (install, build, CI, container, release, runtime, ...). Static text analysis only:
 *  - no DNS lookup, no request to any observed host, ever;
 *  - a hostname in a file says the file REFERS to it, not that anything connects there at run time;
 *  - the context of a reference decides how much it matters: a download host in an install script is a different
 *    observation from the same host in a README;
 *  - documentation placeholders, loopback and private addresses are classified and filtered, not reported as external.
 */
export const DOMAIN_CATEGORIES = [
  'generic_external',
  'registry',
  'github',
  'telemetry',
  'ip_literal',
  'localhost',
  'private_address',
  'documentation_example',
  'unknown',
] as const;
export type DomainCategory = (typeof DOMAIN_CATEGORIES)[number];

/** Categories that are filtered out of "external" (kept only as counts). */
export const NON_EXTERNAL: ReadonlySet<DomainCategory> = new Set([
  'localhost',
  'private_address',
  'documentation_example',
]);

/**
 * Where a reference sits. `active` contexts are code paths that can run; `passive` ones are text a human reads.
 * Strongest first.
 */
export const DOMAIN_CONTEXTS = [
  'install',
  'build',
  'release',
  'ci',
  'container',
  'runtime',
  'unknown',
  'metadata',
  'test',
  'docs',
  'comment',
] as const;
export type DomainContext = (typeof DOMAIN_CONTEXTS)[number];
export const ACTIVE_CONTEXTS: ReadonlySet<DomainContext> = new Set([
  'install',
  'build',
  'release',
  'ci',
  'container',
  'runtime',
]);
export const contextRank = (c: DomainContext): number => DOMAIN_CONTEXTS.indexOf(c);

export const AMBIGUITY = ['none', 'punycode', 'unicode', 'mixed_script'] as const;

export const DomainObservationSchema = z.object({
  context: z.enum(DOMAIN_CONTEXTS),
  file: z.string().max(300),
  line: z.number().int().min(0),
  /** How sure the extractor is that this is a real reference in that context (NOT that the host is malicious). */
  confidence: z.number().min(0).max(1),
  /** Written as `host/path` without a scheme (for example after `curl`). */
  bare: z.boolean(),
});
export type DomainObservation = z.infer<typeof DomainObservationSchema>;

export const ExternalDomainSchema = z.object({
  /** Normalized ASCII hostname (IDN in punycode, lowercase, no trailing dot) or the IP literal. */
  hostname: z.string().max(253),
  /** The host as it was written, when different (Unicode form); sanitized for display. */
  display: z.string().max(253),
  ports: z.array(z.number().int().min(1).max(65535)).max(5),
  schemes: z.array(z.string().max(10)).max(6),
  category: z.enum(DOMAIN_CATEGORIES),
  /** Informational: the name is punycode, Unicode, or mixes scripts. Never a phishing verdict. */
  ambiguity: z.enum(AMBIGUITY),
  /** Strongest context among the references (install > build > ... > comment). */
  strongest_context: z.enum(DOMAIN_CONTEXTS),
  contexts: z.array(z.enum(DOMAIN_CONTEXTS)).max(11),
  /** Highest confidence among the references that sit in the strongest context. */
  confidence: z.number().min(0).max(1),
  observations: z.array(DomainObservationSchema).max(6),
  observations_total: z.number().int().min(0),
  /** A URL with `user:password@` was seen; the credentials are dropped and never stored. */
  credentials_in_url: z.boolean(),
  /** Short factual notes (for example `cloud_metadata_endpoint`). */
  notes: z.array(z.string().max(60)).max(3),
});
export type ExternalDomain = z.infer<typeof ExternalDomainSchema>;

export const ExternalDomainsSchema = z.object({
  version: z.literal('1'),
  status: z.enum(['analyzed', 'not_scanned', 'disabled']),
  /** External domains only (localhost, private and documentation hosts are counted in `filtered`). */
  domains: z.array(ExternalDomainSchema).max(300),
  domains_total: z.number().int().min(0),
  /** Hostnames dropped from `domains`, by category. */
  filtered: z.record(z.string(), z.number().int().min(0)),
  files_scanned: z.number().int().min(0),
  /** References whose host could not be parsed (template variables, malformed). Counted, not guessed. */
  unparsed: z.number().int().min(0),
  limits_hit: z.array(z.string().max(200)).max(10),
  not_available: z.array(z.string().max(200)).max(6),
});
export type ExternalDomains = z.infer<typeof ExternalDomainsSchema>;

export const EMPTY_EXTERNAL_DOMAINS: ExternalDomains = {
  version: '1',
  status: 'disabled',
  domains: [],
  domains_total: 0,
  filtered: {},
  files_scanned: 0,
  unparsed: 0,
  limits_hit: [],
  not_available: [],
};
