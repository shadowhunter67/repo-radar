import { z } from 'zod';

/**
 * Capabilities describe what code CAN do. A capability is never evidence of malicious intent:
 * installers, browsers and security tools legitimately do all of these.
 */
export const CAPABILITIES = [
  'PROCESS_EXEC',
  'BINARY_EXECUTION',
  'BACKGROUND_PROCESS',
  'NETWORK_CLIENT',
  'NETWORK_SERVER',
  'REMOTE_DOWNLOAD',
  'FILESYSTEM_WRITE',
  'FILESYSTEM_DELETE',
  'ENVIRONMENT_READ',
  'CREDENTIAL_ACCESS',
  'BROWSER_DATA_ACCESS',
  'DYNAMIC_CODE_LOAD',
  'PRIVILEGE_CHANGE',
  'PERSISTENCE',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PERSISTENCE_KINDS = [
  'systemd_service',
  'cron_job',
  'launchd_service',
  'windows_service',
  'registry_run_key',
  'scheduled_task',
  'startup_folder',
  'shell_profile_modification',
  'login_item',
  'browser_extension_install',
  'ssh_authorized_keys_write',
  'container_restart_policy',
  'daemon_creation',
  'detached_process',
] as const;
export type PersistenceKind = (typeof PERSISTENCE_KINDS)[number];

/** DIRECT: pattern observed in code. INFERRED: derived from several observations. POSSIBLE: weak pattern. */
export type DetectionMode = 'DIRECT' | 'INFERRED' | 'POSSIBLE';
export type ExecContext = 'install' | 'build' | 'runtime';
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

export const CAPABILITY_RISK: Record<Capability, RiskLevel> = {
  PROCESS_EXEC: 'medium',
  BINARY_EXECUTION: 'medium',
  BACKGROUND_PROCESS: 'medium',
  NETWORK_CLIENT: 'low',
  NETWORK_SERVER: 'low',
  REMOTE_DOWNLOAD: 'medium',
  FILESYSTEM_WRITE: 'low',
  FILESYSTEM_DELETE: 'medium',
  ENVIRONMENT_READ: 'low',
  CREDENTIAL_ACCESS: 'high',
  BROWSER_DATA_ACCESS: 'high',
  DYNAMIC_CODE_LOAD: 'medium',
  PRIVILEGE_CHANGE: 'high',
  PERSISTENCE: 'high',
};

export const RISK_ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;

export type FileRole = 'script' | 'ref' | 'build' | 'source' | 'workflow' | 'manifest' | 'config';

/** A file whose text was fetched for static scanning. */
export interface ScannedFile {
  path: string;
  content: string;
  size: number;
  role: FileRole;
}

export const DetectionSchema = z.object({
  id: z.string(),
  detector: z.string(),
  capability: z.enum(CAPABILITIES),
  mode: z.enum(['DIRECT', 'INFERRED', 'POSSIBLE']),
  confidence: z.number().min(0).max(1),
  file: z.string(),
  line: z.number(),
  contexts: z.array(z.enum(['install', 'build', 'runtime'])),
  persistence_kind: z.enum(PERSISTENCE_KINDS).optional(),
});
export type Detection = z.infer<typeof DetectionSchema>;

export const ChainSchema = z.object({
  id: z.string(),
  kind: z.enum(['pipe-to-shell', 'download-chmod-exec', 'download-eval', 'download-extract-exec']),
  mode: z.enum(['DIRECT', 'INFERRED', 'POSSIBLE']),
  confidence: z.number().min(0).max(1),
  file: z.string(),
  lines: z.array(z.number()),
  steps: z.array(z.string()),
  contexts: z.array(z.enum(['install', 'build', 'runtime'])),
});
export type Chain = z.infer<typeof ChainSchema>;

export const SecretCandidateSchema = z.object({
  id: z.string(),
  type: z.string(),
  mode: z.enum(['DIRECT', 'POSSIBLE']),
  confidence: z.number().min(0).max(1),
  file: z.string(),
  /** 0 when the finding comes from the file name alone. */
  line: z.number(),
  /** Never the secret itself: at most a 4-character prefix followed by asterisks. */
  redacted: z.string(),
  in_test_or_example: z.boolean(),
});
export type SecretCandidate = z.infer<typeof SecretCandidateSchema>;
